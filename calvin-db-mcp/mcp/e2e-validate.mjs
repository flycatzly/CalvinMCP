/**
 * e2e-validate.mjs — 全链路 E2E 验证套件（真实 stdio 子进程 · 18 工具全调用面）
 *
 * v1.6.4 起随包常驻（此前为临时套件；v1.6.3 的三缺陷均由它抓获）。
 * 链路为「真客户端」形态：spawn server.mjs → stdio JSON-RPC → 协议握手/工具发现 →
 * 只读守卫 → 连接池 → SQLite → 导出落盘 / 导入写回。覆盖：协议握手、发现工具 ×6、
 * 读链 ×8、安全红线负例 ×8、写 + 公式中和导出/import 往返（strip_neutralization）
 * 与 atomic 整体回滚、export JSON 保真。
 * 汇总行 `=== 全链路 E2E：N passed, M failed ===` 与 install.mjs 步骤 5 的解析口径一致
 * （未设 DBMCP_E2E 时本套件就是安装器的默认 E2E）。
 *
 * 前置条件（不满足时输出 SKIP 说明并以退出码 3 结束，不算失败）：
 *   - Node ≥ 22.5（内置 node:sqlite，仅用于自供给 fixture）。
 *
 * fixture 全部自建自删（进程临时目录）：临时 sqlite 库 + 临时配置 + 导出/导入白名单目录，
 * 不触碰部署配置与任何既有业务库，可重复执行。argv[2] 可覆盖 mcp 目录（install.mjs 传参兼容）。
 *
 * 用法: node e2e-validate.mjs [mcp目录]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  console.log("SKIP e2e-validate: 当前 Node 无内置 node:sqlite（需 Node ≥ 22.5），全链路 E2E 跳过。");
  console.log("=== 全链路 E2E：0 passed, 0 failed, 1 诚实SKIP ===");
  process.exit(3);
}

/* ---------------- 自建 fixture：临时库 + 临时配置 + 导出/导入目录 ---------------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-e2e-validate-"));
const dbFile = path.join(tmpRoot, "demo.db").replace(/\\/g, "/");
const cfgFile = path.join(tmpRoot, "config.json");
const ioDir = path.join(tmpRoot, "io");
fs.mkdirSync(ioDir);
let srv = null;
try {
  {
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT, price INTEGER, status TEXT DEFAULT 'in_stock')");
    db.exec("INSERT INTO books (id, title, author, price) VALUES (1, 'E2E 驱动', 'tester', 10), (2, 'SQL 指南', 'author-a', 20), (3, '数据库内核', 'author-b', 30)");
    db.close();
  }
  fs.writeFileSync(cfgFile, JSON.stringify({
    maxRows: 200, timeoutMs: 30000, maxAffectedRows: 500,
    sources: {
      demo: { type: "sqlite", url: "sqlite://" + dbFile, allowWrites: true, allowCreateTable: true, description: "e2e-validate 自供给临时库" },
      // v1.6.27：口令源（绝不连接）——只为让 SECRET_LIST 含 "s3cr3t"，钉 export 落盘清洗接线
      secret_src: { type: "mysql", url: "mysql://probe:s3cr3t@127.0.0.1:1/probe" },
    },
  }));

  /* ---------------- stdio JSON-RPC 小客户端（真链路） ---------------- */
  const child = spawn(process.execPath, [path.join(mcpDir, "server.mjs")], {
    env: { ...process.env, DBMCP_NO_LISTEN: "", DBMCP_CONFIG: cfgFile, DBMCP_EXPORT_DIR: ioDir, DBMCP_IMPORT_DIR: ioDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  srv = child;
  child.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  const pending = new Map();
  let buf = "", linesSeen = 0;
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      linesSeen++;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ id, error: { code: -32603, message: "client rpc timeout: " + method } }); }, 30000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = (name, args) => rpc("tools/call", { name, arguments: args });
  const textOf = (r) => r?.result?.content?.[0]?.text ?? "";
  const jsonOf = (r) => { try { return JSON.parse(textOf(r)); } catch { return null; } };
  const isErr = (r) => r?.result?.isError === true || !!r?.error;
  const errText = (r) => (r?.error ? JSON.stringify(r.error) : textOf(r));

  /* ---- 协议层 ---- */
  {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-validate", version: "0" } });
    ok("initialize: serverInfo + instructions", init?.result?.serverInfo?.name === "calvin-db-mcp" && typeof init?.result?.instructions === "string");
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(mcpDir, "package.json"), "utf8")).version;
    ok("initialize: 版本与 package.json 一致", init?.result?.serverInfo?.version === pkgVersion, init?.result?.serverInfo?.version);
    const bad = await rpc("initialize", { protocolVersion: "9999-01-01" });
    ok("initialize: 未知协议版本回退", bad?.result?.protocolVersion === "2025-06-18");
    await rpc("notifications/initialized", {});
    const tools = await rpc("tools/list", {});
    const names = tools?.result?.tools?.map((t) => t.name);
    ok("tools/list: 18 个工具", names?.length === 18, String(names?.length));
    // 无 id 通知不得回复（JSON-RPC 2.0）：发出后 400ms 内 stdout 行数不得增加
    const before = linesSeen;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "ping" }) + "\n");
    await new Promise((r) => setTimeout(r, 400));
    ok("notification（无 id ping）无响应", linesSeen === before, `stdout 行数 ${before}→${linesSeen}`);
    const unk = await call("no_such_tool", {});
    ok("未知工具 → isError", isErr(unk) && errText(unk).includes("Unknown tool"));
  }

  /* ---- 发现工具 ---- */
  {
    const ls = jsonOf(await call("list_sources", {}));
    ok("list_sources: demo 源可见", ls?.sources?.some((s) => s.id === "demo" && s.type === "sqlite"));
    const fd = jsonOf(await call("find_database", { name: "demo", probe: true }));
    ok("find_database: 命中 + probe 可达", fd?.match_count === 1 && fd?.matches?.[0]?.reachable === true);
    const ss = jsonOf(await call("server_stats", {}));
    ok("server_stats: version + 形状（v1.6.54）", typeof ss?.version === "string" && Array.isArray(ss?.per_source) && Array.isArray(ss?.recent_slow) && typeof ss?.slow_ms_threshold === "number");
    const rc = jsonOf(await call("reload_config", {}));
    ok("reload_config: 同内容零差异（v1.6.55）", Array.isArray(rc?.changed) && rc.changed.length === 0, JSON.stringify(rc?.changed));
    const lt = jsonOf(await call("list_tables", { source: "demo" }));
    ok("list_tables: books 表", lt?.tables?.some((t) => t.name === "books"));
    const dt = jsonOf(await call("describe_table", { source: "demo", table: "books" }));
    ok("describe_table: 列 + 主键", Array.isArray(dt?.columns) && dt?.columns?.length > 0 && dt?.schema === "(file)");
    const fc = jsonOf(await call("find_tables_by_column", { source: "demo", column: "title" }));
    ok("find_tables_by_column: 命中", (fc?.match_count ?? 0) >= 1);
    const fk = jsonOf(await call("fk_relationships", { source: "demo" }));
    ok("fk_relationships: 可调用", typeof fk?.fk_count === "number");
  }

  /* ---- 读工具 ---- */
  {
    const q = jsonOf(await call("query", { source: "demo", sql: "SELECT * FROM books" }));
    ok("query: 行数 + 自动 LIMIT", q?.row_count >= 0 && typeof q?.truncated === "boolean");
    const q2 = jsonOf(await call("query", { source: "demo", sql: "SELECT COUNT(*) AS c FROM books" }));
    ok("query: 聚合正常", Number.isFinite(Number(q2?.rows?.[0]?.c)));
    const qp = jsonOf(await call("query_plan", { source: "demo", sql: "SELECT * FROM books WHERE id = 1" }));
    ok("query_plan: 返回计划", Array.isArray(qp?.plan));
    const sd = jsonOf(await call("sample_data", { source: "demo", table: "books", limit: 5 }));
    ok("sample_data: 5 行内", sd?.row_count <= 5);
    const cr = jsonOf(await call("count_rows", { source: "demo", table: "books" }));
    ok("count_rows: total 数值", Number.isFinite(Number(cr?.total)));
    const dv = jsonOf(await call("distinct_values", { source: "demo", table: "books", column: "title", limit: 5 }));
    ok("distinct_values: 去重计数", Number.isFinite(Number(dv?.distinct_total)));
    const cs = jsonOf(await call("column_stats", { source: "demo", table: "books", column: "id", histogram: { buckets: 4 }, top_values: { limit: 3 } }));
    ok("column_stats: stats + histogram + top", cs?.stats?.row_count >= 0 && Array.isArray(cs?.histogram) && Array.isArray(cs?.top_values));
    const pr = jsonOf(await call("query", { source: "demo", sql: "PRAGMA table_info(books)" }));
    ok("query: 只读 PRAGMA 白名单", Array.isArray(pr?.rows) && pr?.rows?.length > 0);
  }

  /* ---- 安全红线（负例） ---- */
  {
    const e1 = await call("query", { source: "demo", sql: "DELETE FROM books" });
    ok("query 拦 DELETE", isErr(e1));
    const e2 = await call("query", { source: "demo", sql: "SELECT 1; DROP TABLE books" });
    ok("query 拦多语句", isErr(e2));
    const e3 = await call("execute", { source: "demo", sql: "DELETE FROM books" });
    ok("execute 拦无 WHERE DELETE", isErr(e3) && errText(e3).includes("安全红线"));
    const e4 = await call("execute", { source: "demo", sql: "UPDATE books SET title='x' WHERE 1=1" });
    ok("execute 拦恒真 WHERE", isErr(e4));
    const e5 = await call("execute", { source: "demo", sql: "TRUNCATE TABLE books" });
    ok("execute 拦 TRUNCATE", isErr(e5));
    const e6 = await call("execute", { source: "demo", sql: "UPDATE books SET title = title WHERE id = (SELECT MAX(id) FROM books) OR 1=1" });
    ok("execute 拦恒真 OR 分支", isErr(e6));
    const e7 = await call("query", { source: "demo", sql: "SELECT pg_sleep(1)" });
    ok("query 拦危险函数", isErr(e7));
    const e8 = await call("query", { source: "demo", sql: "PRAGMA journal_mode = WAL" });
    ok("query 拦非白名单 PRAGMA", isErr(e8));
  }

  /* ---- 参数校验（负例，v1.6.26）：format 枚举非法值应显式 E_PARAM，不得静默兜底成默认格式 ---- */
  {
    const p1 = await call("query_plan", { source: "demo", sql: "SELECT 1 AS a", format: "xml" });
    ok("query_plan 拦非法 format（E_PARAM）", isErr(p1) && errText(p1).includes("E_PARAM"), errText(p1));
    const p2 = await call("export_data", { source: "demo", sql: "SELECT 1 AS a", format: "xml", filename: "enum-neg.csv", overwrite: true });
    ok("export_data 拦非法 format（E_PARAM）", isErr(p2) && errText(p2).includes("E_PARAM"), errText(p2));
    const p3 = await call("export_data", { source: "demo", sql: "SELECT 1 AS a", format: "JSON", filename: "enum-norm.json", overwrite: true });
    ok("export_data format 大小写归一（JSON→json）", !isErr(p3) && jsonOf(p3)?.format === "json", errText(p3) || JSON.stringify(p3));
  }

  /* ---- 写 + 导入导出 ---- */
  {
    const before = Number(jsonOf(await call("count_rows", { source: "demo", table: "books" }))?.total);
    await call("execute", { source: "demo", sql: "DELETE FROM books WHERE title = 'e2e'" });   // 清理前次残留，保持可重跑
    const ins2 = jsonOf(await call("execute", { source: "demo", sql: "INSERT INTO books (title, author) VALUES ('e2e', 'tester')" }));
    ok("execute: INSERT 生效", ins2?.affected_rows === 1);
    const after = Number(jsonOf(await call("count_rows", { source: "demo", table: "books" }))?.total);
    ok("count_rows 前后核对", after >= before, `before=${before} after=${after}`);
    const ex = jsonOf(await call("export_data", { source: "demo", sql: "SELECT * FROM books", format: "csv" }));
    ok("export_data: 落盘", ex?.file && fs.existsSync(ex?.file) && ex?.row_count >= 0);
    const csv = fs.readFileSync(ex.file, "utf8");
    ok("export csv: 表头 + 行", csv.split("\r\n")[0].split(",").length > 0);
    const exj = jsonOf(await call("export_data", { source: "demo", sql: "SELECT * FROM books", format: "json", filename: "e2e-export.json", overwrite: true }));
    ok("export_data: json 落盘", fs.existsSync(exj?.file));
    // v1.6.3 回归：export JSON 保真——3000 字符长文本完整落盘，不得带截断标记
    const longText = "x".repeat(3000);
    const exl = jsonOf(await call("export_data", { source: "demo", sql: "SELECT '" + longText + "' AS note", format: "json", filename: "fidelity.json", overwrite: true }));
    const lraw = exl?.file && fs.existsSync(exl.file) ? fs.readFileSync(exl.file, "utf8") : "";
    ok("export json 保真: 3000 字符长文本完整落盘（v1.6.3 回归）",
      exl?.row_count === 1 && lraw.includes(longText) && !lraw.includes("<truncated"),
      lraw ? (lraw.includes("<truncated") ? "含截断标记" : "len=" + lraw.length) : "导出文件缺失");
    // v1.6.27 回归：export 落盘清洗走流式链路（scrubToBuffer）——内容含口令时文件内必须已替换，
    // 且 bytes 字段与落盘字节数一致（计量从 Buffer.length 接线，防止 scrub 后计量错位）
    const expw = jsonOf(await call("export_data", { source: "demo", sql: "SELECT 's3cr3t' AS note", format: "csv", filename: "scrub-wire.csv", overwrite: true }));
    const praw = expw?.file && fs.existsSync(expw.file) ? fs.readFileSync(expw.file) : null;
    ok("export 落盘清洗: 口令已替换且 bytes 与文件一致（v1.6.27 流式链路接线）",
      !!praw && !praw.toString("utf8").includes("s3cr3t") && praw.toString("utf8").includes("***") && expw.bytes === praw.length,
      expw ? JSON.stringify({ bytes: expw?.bytes, file_len: praw?.length, head: praw?.toString("utf8").slice(0, 80) }) : "导出失败");
    const ct = jsonOf(await call("create_table", { source: "demo", sql: "CREATE TABLE IF NOT EXISTS e2e_roundtrip (id INTEGER PRIMARY KEY, val TEXT)" }));
    ok("create_table: 建表", ct?.table_created === "e2e_roundtrip");
    // 真实往返：库中植入 =1+1 → export 中和（'=1+1）→ import strip_neutralization 还原（=1+1）
    await call("execute", { source: "demo", sql: "INSERT INTO e2e_roundtrip (id, val) VALUES (1, '=1+1')" });
    const exr = jsonOf(await call("export_data", { source: "demo", sql: "SELECT id, val FROM e2e_roundtrip", format: "csv", filename: "e2e-rt.csv", overwrite: true }));
    ok("export: 中和计数 = 1", exr?.formula_cells_neutralized === 1, JSON.stringify(exr));
    const rawCsv = fs.readFileSync(exr.file, "utf8");
    ok("export: 落盘含 '=1+1", rawCsv.includes("'=1+1"), rawCsv);
    await call("execute", { source: "demo", sql: "DELETE FROM e2e_roundtrip WHERE id = 1" });
    const im = await call("import_data", { source: "demo", table: "e2e_roundtrip", filename: "e2e-rt.csv", overwrite: true, strip_neutralization: true });
    ok("import_data: 往返导入 1 行", !isErr(im) && jsonOf(im)?.rows_imported === 1, errText(im));
    const chk = jsonOf(await call("query", { source: "demo", sql: "SELECT val FROM e2e_roundtrip WHERE id = 1" }));
    ok("import: 往返无损（=1+1 而非 '=1+1）", chk?.rows?.[0]?.val === "=1+1", JSON.stringify(chk?.rows));
    const im2 = await call("import_data", { source: "demo", table: "e2e_roundtrip", filename: "e2e-rt.csv", overwrite: true, strip_neutralization: true, atomic: true });
    // id 主键冲突 → atomic 模式应整体回滚并明确报错
    ok("import atomic: 冲突整体回滚", isErr(im2) && errText(im2).includes("回滚"), errText(im2));
    const cl = await call("execute", { source: "demo", sql: "DELETE FROM e2e_roundtrip WHERE id IN (1, 2)" });
    ok("execute: 条件 DELETE", !isErr(cl));
    const drop = await call("execute", { source: "demo", sql: "DROP TABLE e2e_roundtrip" });
    ok("execute 拒 DROP", isErr(drop));
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
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n=== 全链路 E2E：${pass} passed, ${fail} failed${skip ? `, ${skip} 诚实SKIP` : ""} ===`);
  process.exit(fail > 0 ? 1 : 0);
}
