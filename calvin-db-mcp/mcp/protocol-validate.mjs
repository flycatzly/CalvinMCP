/**
 * protocol-validate.mjs — 协议边界 + 对抗负例验证套件（真实 stdio 子进程）
 *
 * v1.6.4 起随包常驻（此前为临时套件；v1.6.3 的 peekRpcId 修复由它的 ①② 直接催生）。
 * 覆盖 JSON-RPC 2.0 stdio 边界：超长行拒收且回带请求 id（-32600）、坏 JSON 行（-32700）且回带 id、
 * 噪声行静默、并发请求 id 回配、批量数组（-32600 后存活）、id=0 合法、resources/prompts 空实现，
 * v1.6.12 取消语义（notifications/cancelled，静默 TCP fixture 制造真实挂起请求）：运行中取消
 * 不发响应且队列立即解放 / 排队中取消不执行不响应（写安全）/ 未知·迟到·无效取消忽略、请求形状 -32601，
 * 以及 10 条守卫对抗负例（WITH...DELETE / FOR UPDATE / FOR SHARE / LOCK IN SHARE MODE /
 * INTO OUTFILE / OR true / WHERE 2>1 / pg_read_file / set_config / LOAD_FILE）。
 * 汇总行 `=== protocol-validate: N passed, M failed ===` 沿用家族口径（对照 mysql-validate）。
 *
 * 前置条件（不满足时输出 SKIP 说明并以退出码 3 结束，不算失败）：
 *   - Node ≥ 22.5（内置 node:sqlite，仅用于自供给 fixture）。
 *
 * fixture 全部自建自删（进程临时目录）：临时 sqlite 库 + 临时配置，
 * 不触碰部署配置与任何既有业务库，可重复执行。argv[2] 可覆盖 mcp 目录（install.mjs 传参兼容）。
 *
 * 用法: node protocol-validate.mjs [mcp目录]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = process.argv[2] ? path.resolve(process.argv[2]) : here;
let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (detail !== undefined ? " - " + detail : "")); }
};

/* ---------------- 前置检查：node:sqlite（自供给 fixture 用） ---------------- */
let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); }
catch {
  console.log("SKIP protocol-validate: 当前 Node 无内置 node:sqlite（需 Node ≥ 22.5），协议边界验证跳过。");
  console.log("=== protocol-validate: 0 passed, 0 failed, 1 诚实SKIP ===");
  process.exit(3);
}

/* ---------------- 自建 fixture：临时库 + 临时配置 ---------------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-protocol-validate-"));
const dbFile = path.join(tmpRoot, "demo.db").replace(/\\/g, "/");
const cfgFile = path.join(tmpRoot, "config.json");
let srv = null;
let silentSrv = null;
const heldSocks = [];
try {
  {
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT, price INTEGER, status TEXT DEFAULT 'in_stock')");
    db.exec("INSERT INTO books (id, title, author, price) VALUES (1, '协议驱动', 'tester', 10), (2, 'SQL 指南', 'author-a', 20), (3, '数据库内核', 'author-b', 30)");
    db.close();
  }
  // v1.6.12 取消场景用「静默 TCP 服务器」：收连接但永不回 MySQL 握手 → 驱动连接挂起
  //（connectTimeout=timeoutMs=30s），制造真实可取消的在途请求；本地自建自删，不依赖外部网络。
  silentSrv = net.createServer((sock) => { heldSocks.push(sock); sock.on("error", () => { /* 客户端提前断开 */ }); });
  await new Promise((res, rej) => { silentSrv.once("error", rej); silentSrv.listen(0, "127.0.0.1", res); });
  const hangPort = silentSrv.address().port;
  fs.writeFileSync(cfgFile, JSON.stringify({
    maxRows: 200, timeoutMs: 30000, maxAffectedRows: 500,
    sources: {
      demo: { type: "sqlite", url: "sqlite://" + dbFile, allowWrites: true, allowCreateTable: true, description: "protocol-validate 自供给临时库" },
      hang: { type: "mysql", url: "mysql://probe:probe@127.0.0.1:" + hangPort + "/probe", description: "静默 TCP：连接永不完成握手（取消场景专用）" },
    },
  }));

  /* ---------------- stdio JSON-RPC 小客户端（真链路） ---------------- */
  const child = spawn(process.execPath, [path.join(mcpDir, "server.mjs")], {
    env: { ...process.env, DBMCP_NO_LISTEN: "", DBMCP_CONFIG: cfgFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  srv = child;
  child.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  const pending = new Map();
  let buf = "", strays = 0;
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p(m); } else { strays++; }
      } catch { /* 噪声行静默 */ }
    }
  });
  const rpc = (method, params, id, timeoutMs = 30000) => new Promise((res) => {
    const timer = setTimeout(() => { pending.delete(id); res({ id, error: { code: -32603, message: "client rpc timeout: " + method } }); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = (id, name, args) => rpc("tools/call", { name, arguments: args }, id);
  // 原始写入（坏 JSON/噪声/批量数组等无法用 rpc() 表达的报文）后等带 id 的响应
  const rawExpect = (id, raw, timeoutMs = 30000) => new Promise((res) => {
    const timer = setTimeout(() => { pending.delete(id); res({ id, error: { code: -32603, message: "client rpc timeout" } }); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
    child.stdin.write(raw);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ① 超长报文：拒收且回带请求 id（v1.6.3 修复——旧版 id:null 会让客户端永久挂起） */
  const big = await call(900, "query", { source: "demo", sql: "SELECT '" + "x".repeat(2_100_000) + "'" });
  ok("超长行 → -32600 且回带 id 900", big?.id === 900 && big?.error?.code === -32600 && /too large/.test(big?.error?.message), JSON.stringify({ id: big?.id, error: big?.error }));

  /* ② 坏 JSON 行：-32700 + 回带 id（v1.6.3 修复） */
  {
    const r = await rawExpect(901, '{"jsonrpc":"2.0","id":901,"method":' + "\n");
    ok("坏 JSON 行 → -32700 且回带 id 901", r?.id === 901 && r?.error?.code === -32700, JSON.stringify(r));
  }

  /* ③ 噪声行静默：发噪声，等待后无主响应计数不得增加 */
  {
    const before = strays;
    child.stdin.write("not json at all\n");
    await sleep(400);
    ok("噪声行静默（无无主响应）", strays === before, `strays=${before}→${strays}`);
  }

  /* ④ 并发两请求：id 各自回配 */
  {
    const [r10, r11] = await Promise.all([call(10, "list_sources", {}), call(11, "count_rows", { source: "demo", table: "books" })]);
    ok("并发请求 id 各自回配", r10?.id === 10 && r11?.id === 11);
  }

  /* ⑤ 批量数组 → -32600（id null，规范口径）且服务存活 */
  {
    child.stdin.write(JSON.stringify([{ jsonrpc: "2.0", id: 20, method: "ping" }]) + "\n");
    await sleep(300);
    const alive = await rpc("ping", {}, 21);
    ok("批量数组 -32600 后服务存活", alive?.result && Object.keys(alive.result).length === 0);
  }

  /* ⑥ id=0 合法 */
  {
    const zero = await rpc("ping", {}, 0);
    ok("id=0 正常回配", zero?.id === 0);
  }

  /* ⑦ resources/prompts 空实现 */
  {
    const rl = await rpc("resources/list", {}, 23);
    const pl = await rpc("prompts/list", {}, 24);
    ok("resources/prompts 空列表", rl?.result?.resources?.length === 0 && pl?.result?.prompts?.length === 0);
  }

  /* ⑧ 对抗负例（守卫红线） */
  const neg = async (id, sql, tool = "query") => (await call(id, tool, { source: "demo", sql }))?.result?.isError === true;
  ok("query 拦 WITH...DELETE", await neg(101, "WITH x AS (SELECT 1) DELETE FROM books"));
  ok("query 拦 FOR UPDATE", await neg(102, "SELECT * FROM books FOR UPDATE"));
  ok("query 拦 FOR SHARE", await neg(103, "SELECT * FROM books FOR SHARE"));
  ok("query 拦 LOCK IN SHARE MODE", await neg(104, "SELECT * FROM books LOCK IN SHARE MODE"));
  ok("query 拦 INTO OUTFILE", await neg(105, "SELECT * FROM books INTO OUTFILE '/tmp/x'"));
  ok("execute 拦 OR true", await neg(106, "UPDATE books SET title=1 WHERE id=1 OR true", "execute"));
  ok("execute 拦 WHERE 2>1", await neg(107, "UPDATE books SET title=1 WHERE 2>1", "execute"));
  ok("query 拦 pg_read_file", await neg(108, "SELECT pg_read_file('/etc/passwd')"));
  ok("query 拦 set_config", await neg(109, "SELECT set_config('a','b',false)"));
  ok("query 拦 LOAD_FILE", await neg(110, "SELECT LOAD_FILE('/etc/passwd')"));

  /* ⑨ v1.6.12 运行中取消：不发响应（MCP 规范 SHOULD）+ 串行队列立即解放 */
  {
    const before = strays;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 950, method: "tools/call", params: { name: "query", arguments: { source: "hang", sql: "SELECT 1" } } }) + "\n");
    await sleep(500); // 等它派发并在 MySQL 握手上挂起（静默 TCP fixture）
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 950, reason: "protocol-validate 取消场景" } }) + "\n");
    await sleep(800);
    ok("运行中取消：被取消请求不发响应", strays === before, `strays=${before}→${strays}`);
    const alive = await rpc("ping", {}, 951, 4000);
    ok("运行中取消：串行队列立即解放（ping 快速回配）", alive?.id === 951 && alive?.result !== undefined, JSON.stringify(alive).slice(0, 120));
  }

  /* ⑩ 排队中取消：未派发的请求不执行不响应（写安全方向——被取消的写不应落库） */
  {
    const before = strays;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 952, method: "tools/call", params: { name: "query", arguments: { source: "hang", sql: "SELECT 1" } } }) + "\n");
    await sleep(400); // 952 占住队列
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 953, method: "tools/call", params: { name: "list_sources", arguments: {} } }) + "\n");
    await sleep(200); // 953 已到达登记、排队中
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 953, reason: "取消排队请求" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 952, reason: "释放队列" } }) + "\n");
    await sleep(800);
    ok("排队中取消：被取消请求不执行不响应（953 是 list_sources，若执行必有响应）", strays === before, `strays=${before}→${strays}`);
    const alive = await rpc("ping", {}, 954, 4000);
    ok("排队中取消：服务存活且队列正常", alive?.id === 954 && alive?.result !== undefined);
  }

  /* ⑪ 未知/迟到/无效取消：规范 SHOULD ignore；请求形状（带 id）走 -32601 */
  {
    const before = strays;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999999, reason: "未知 id" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: { bad: 1 } } }) + "\n");
    await sleep(400);
    ok("未知 id / 无效 params 取消被忽略（无响应无副作用）", strays === before, `strays=${before}→${strays}`);
    const r955 = await rpc("ping", {}, 955, 4000);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 955, reason: "迟到取消" } }) + "\n");
    await sleep(400);
    const r956 = await rpc("ping", {}, 956, 4000);
    ok("迟到取消忽略：已完成请求不受影响，后续请求正常", r955?.id === 955 && r956?.id === 956 && strays === before, `strays=${before}→${strays}`);
    const shaped = await rawExpect(957, '{"jsonrpc":"2.0","id":957,"method":"notifications/cancelled","params":{"requestId":957}}' + "\n", 4000);
    ok("带 id 的 cancelled（请求形状）→ -32601", shaped?.id === 957 && shaped?.error?.code === -32601, JSON.stringify(shaped).slice(0, 120));
  }
} catch (e) {
  fail++;
  console.log("FAIL suite-setup - " + (e && e.message ? e.message : e));
} finally {
  if (srv) {
    try { srv.stdin.end(); } catch { /* ignore */ }
    await new Promise((r) => { const t = setTimeout(r, 2000); srv.on("exit", () => { clearTimeout(t); r(); }); });
    try { srv.kill(); } catch { /* ignore */ }
  }
  for (const s of heldSocks) { try { s.destroy(); } catch { /* ignore */ } }
  if (silentSrv) { try { silentSrv.close(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n=== protocol-validate: ${pass} passed, ${fail} failed${skip ? `, ${skip} 诚实SKIP` : ""} ===`);
  process.exit(fail > 0 ? 1 : 0);
}
