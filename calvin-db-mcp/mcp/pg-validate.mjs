/**
 * pg-validate.mjs — PostgreSQL 真实库全链路验证套件（对标 mysql-validate.mjs）
 *
 * v1.6.17 起：真实 PostgreSQL「操作矩阵 × 直连双向核对」——建表 / CSV 导入 / 插入 / 查询 /
 * 计数 / 更新 / 删行 / 红线负例（每条负例后核对零副作用）/ BLOB(bytea) 往返 / 导出核对 /
 * DBA 删表确认，每一步都用独立直连核对数据库真实状态是否与 MCP 工具行为一致。
 * v1.6.18 起：全工具面钉测（对标 mysql-validate）——column_stats 画像/直方图/TopN、
 * list_tables / describe_table / find_tables_by_column / fk_relationships、query（自动 LIMIT/
 * 括号复合 UNION/SHOW）/ query_plan / count_rows / distinct_values / sample_data、
 * execute affected_rows / create_table CTAS 拒绝 / import 原子回滚、withTransaction 提交回滚。
 * PG 方言分支（information_schema $n 占位符、EXPLAIN (FORMAT JSON)、COUNT(*)::bigint 字符串化、
 * ILIKE 子串匹配、括号复合不包外层 LIMIT）此前只在纯函数单测验证过，从未真实端到端执行。
 * 链路为「真客户端」形态：spawn server.mjs → stdio JSON-RPC → 工具层 → 守卫/连接层 → PostgreSQL。
 * 脚手架（建表）与清理（DROP TABLE）走 pool.mjs 连接层——工具层按设计禁止 DDL。
 *
 * 前置条件（不满足时输出 SKIP 说明并以退出码 3 结束，不算失败）：
 *   - dbmcp.config.json 存在且含 type: "postgres" 的源（口令密文原样使用，不落明文）；
 *   - 运行环境网络可达该 PostgreSQL。
 *
 * 测试对象全部为 pg_probe_matrix / pg_probe_import 临时表（套件自建自删），不触碰任何既有业务表。
 *
 * 用法: node pg-validate.mjs   （在 mcp/ 目录下）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPoolManager } from "./pool.mjs";
import { decryptAny } from "./crypt2.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(name, ok, detail = "") {
  const d = String(detail).slice(0, 220);
  if (ok) { pass++; console.log("PASS " + name); }
  else { fail++; failures.push(name + " :: " + d); console.log("FAIL " + name + " - " + d); }
}

/* ---------------- 前置检查：配置与 postgres 源 ---------------- */
const cfgFile = path.join(here, "dbmcp.config.json");
if (!fs.existsSync(cfgFile)) {
  console.log("SKIP pg-validate: dbmcp.config.json 不存在（未初始化部署），真实库套件跳过。");
  process.exit(3);
}
const realCfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
const pgEntry = Object.entries(realCfg.sources || {}).find(([, s]) => String(s.type || "").toLowerCase() === "postgres" && (s.enc || s.url));
if (!pgEntry) {
  console.log("SKIP pg-validate: 配置中没有 type= postgres 的源，真实库套件跳过。");
  process.exit(3);
}
const [PG_ID] = pgEntry;

/* ---------------- 临时配置副本：仅打开写/建表开关（enc 密文原样复制） ---------------- */
const tmpCfgFile = path.join(os.tmpdir(), `dbmcp-pg-validate-cfg-${process.pid}.json`);
const tmpCfg = { ...realCfg, allowWrites: true, allowCreateTable: true };
fs.writeFileSync(tmpCfgFile, JSON.stringify(tmpCfg), "utf8");

/* ---------------- pool 层直连核对（与 server 同一条连接层路径） ---------------- */
const sources = {};
for (const [id, s] of Object.entries(tmpCfg.sources)) {
  const url = s.url || (s.enc ? decryptAny(s.enc) : "");
  const declared = String(s.type || "").toLowerCase();
  const type = declared === "oceanbase" ? "mysql" : (declared || "mysql");
  sources[id] = { ...s, id, type, url };
}
const mgr = createPoolManager({
  cfg: { maxRows: 200, timeoutMs: 30000 },
  getSource: (id) => { const s = sources[id]; if (!s) throw new Error("unknown source " + id); return s; },
  clampInt: (v, min, max, dflt) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; },
  sqliteFilePath: () => "",
  scrub: (t) => t,
});

const T = "pg_probe_matrix";
const IMPORT_TABLE = "pg_probe_import";

// export/import 工具的白名单目录（进程临时目录，套件自建自删）
const ioRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-pg-io-"));
const exportDir = path.join(ioRoot, "exp");
const importDir = path.join(ioRoot, "imp");
fs.mkdirSync(exportDir, { recursive: true });
fs.mkdirSync(importDir, { recursive: true });

/* ---------------- stdio JSON-RPC 小客户端（真链路） ---------------- */
function startServer() {
  const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
    env: { ...process.env, DBMCP_NO_LISTEN: "", DBMCP_CONFIG: tmpCfgFile, DBMCP_EXPORT_DIR: exportDir, DBMCP_IMPORT_DIR: importDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let errText = "";
  child.stderr.on("data", (d) => { errText += d.toString("utf8"); });
  let nextId = 100;
  const rpc = (method, params, isNotification = false) => new Promise((resolve, reject) => {
    const id = isNotification ? undefined : nextId++;
    if (!isNotification) {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("rpc timeout: " + method + " | stderr: " + errText.slice(-300))); }, 60000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    }
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }) + "\n");
    if (isNotification) resolve(null);
  });
  // v1.6.24: 暴露自增 id 的原语——notifications/cancelled 需要按 requestId 瞄准在途请求
  const rpcRaw = (method, params) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("rpc timeout: " + method + " | stderr: " + errText.slice(-300))); }, 60000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return { id, promise };
  };
  return { child, rpc, rpcRaw, errText: () => errText };
}

function parseToolResult(msg) {
  if (msg.error) throw new Error("rpc error: " + JSON.stringify(msg.error));
  const r = msg.result || {};
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) return { isError: true, text, data: null };
  try { return { isError: false, data: JSON.parse(text), text }; }
  catch { return { isError: false, data: null, text }; }
}

const norm = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex");
  return String(v);
};

// 表存在性直连核对：to_regclass 不存在时返回 1 行 NULL（非 0 行）
async function tableExists() {
  const { rows } = await mgr.runQuery(PG_ID, `SELECT to_regclass('public."${T}"') AS t`);
  return rows[0]?.t != null;
}

/* ---------------- 主流程：操作矩阵 × 直连双向核对 ---------------- */
let srv = null;
try {
  srv = startServer();
  await srv.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pg-validate", version: "1" } });
  srv.rpc("notifications/initialized", {}, true).catch(() => {});
  const call = async (tool, args) => parseToolResult(await srv.rpc("tools/call", { name: tool, arguments: args }));

  // ① 预清理（DBA 直连；工具层按设计禁止 DDL）
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${T}`);
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${IMPORT_TABLE}`);
  check("预清理：探针表不存在", !(await tableExists()), "exists=true");

  // ② 建表（MCP）→ 直连验证真实存在
  const ct = await call("create_table", { source: PG_ID, sql: `CREATE TABLE ${T} (id INT PRIMARY KEY, 名称 VARCHAR(50) NOT NULL, 数量 INT NOT NULL, payload BYTEA NULL, note TEXT NULL)` });
  check("create_table 真实建表成功（直连可见）", !ct.isError && (await tableExists()), ct.text.slice(0, 140));

  // ③ describe_table 与真实结构一致
  const dt = await call("describe_table", { source: PG_ID, table: T });
  check("describe_table 反映真实结构（id/名称/数量）", !dt.isError && /id/.test(dt.text) && /名称/.test(dt.text) && /数量/.test(dt.text), dt.text.slice(0, 160));

  // ④ CSV 导入（MCP）→ 直连数行、核对值
  fs.writeFileSync(path.join(importDir, "导入.csv"), "id,名称,数量\n1,甲,10\n2,乙,20\n3,丙,30\n", "utf8");
  const im = await call("import_data", { source: PG_ID, table: T, filename: "导入.csv" });
  const cnt1 = (await mgr.runQuery(PG_ID, `SELECT COUNT(*) AS c FROM ${T}`)).rows[0];
  check("import_data 真实写入 3 行", !im.isError && Number(cnt1.c) === 3, im.text.slice(0, 140) + " | cnt=" + cnt1.c);
  const row2 = (await mgr.runQuery(PG_ID, `SELECT id, 名称, 数量 FROM ${T} WHERE id = 2`)).rows;
  check("导入值真实落库（id=2 数量=20）", row2.length === 1 && Number(row2[0].数量) === 20 && norm(row2[0].名称) === "乙", JSON.stringify(row2));

  // ⑤ 单条 INSERT（MCP）→ 直连验证
  const ins = await call("execute", { source: PG_ID, sql: `INSERT INTO ${T} (id, 名称, 数量) VALUES (4, '丁', 40)` });
  const row4 = (await mgr.runQuery(PG_ID, `SELECT 名称 FROM ${T} WHERE id = 4`)).rows;
  check("execute INSERT 真实落库", !ins.isError && row4.length === 1 && norm(row4[0].名称) === "丁", ins.text.slice(0, 140));

  // ⑥ query 与直连逐值一致
  const qr = await call("query", { source: PG_ID, sql: `SELECT id, 名称, 数量 FROM ${T} ORDER BY id` });
  const directRows = (await mgr.runQuery(PG_ID, `SELECT id, 名称, 数量 FROM ${T} ORDER BY id`)).rows;
  const same = qr.data?.rows && qr.data.rows.length === directRows.length && qr.data.rows.every((r, i) => norm(r.id) === norm(directRows[i].id) && norm(r.名称) === norm(directRows[i].名称) && norm(r.数量) === norm(directRows[i].数量));
  check("query 结果与直连逐值一致（4 行）", !qr.isError && !!same, qr.text.slice(0, 160));

  // ⑦ count_rows 与直连一致
  const cn = await call("count_rows", { source: PG_ID, table: T });
  const directCnt = Number((await mgr.runQuery(PG_ID, `SELECT COUNT(*) AS c FROM ${T}`)).rows[0].c);
  check("count_rows 与直连一致", !cn.isError && Number(cn.data?.total ?? cn.data?.row_count) === directCnt, cn.text.slice(0, 140));

  // ⑧ UPDATE 真实改值
  const up = await call("execute", { source: PG_ID, sql: `UPDATE ${T} SET 数量 = 数量 + 5 WHERE id = 2` });
  const row2b = (await mgr.runQuery(PG_ID, `SELECT 数量 FROM ${T} WHERE id = 2`)).rows;
  check("execute UPDATE 真实改值（20→25）", !up.isError && Number(row2b[0].数量) === 25, up.text.slice(0, 140) + " | " + JSON.stringify(row2b));

  // ⑨ DELETE 真实删行
  const del = await call("execute", { source: PG_ID, sql: `DELETE FROM ${T} WHERE id = 3` });
  const row3 = (await mgr.runQuery(PG_ID, `SELECT id FROM ${T} WHERE id = 3`)).rows;
  const cnt2 = Number((await mgr.runQuery(PG_ID, `SELECT COUNT(*) AS c FROM ${T}`)).rows[0].c);
  check("execute DELETE 真实删行（id=3 消失，剩 3 行）", !del.isError && row3.length === 0 && cnt2 === 3, del.text.slice(0, 140) + " | cnt=" + cnt2);

  // ⑩ 红线负例——每步后直连快照必须零变化、表必须仍在
  const snap = async () => {
    const c = Number((await mgr.runQuery(PG_ID, `SELECT COUNT(*) AS c FROM ${T}`)).rows[0].c);
    const sum = Number((await mgr.runQuery(PG_ID, `SELECT COALESCE(SUM(数量),0) AS s FROM ${T}`)).rows[0].s);
    return `${c}|${sum}`;
  };
  const before = await snap();
  const negatives = [
    ["无 WHERE UPDATE 拒绝且零副作用", `UPDATE ${T} SET 数量 = 0`, /安全红线/],
    ["无 WHERE DELETE 拒绝且零副作用", `DELETE FROM ${T}`, /安全红线/],
    ["恒真 WHERE UPDATE 拒绝且零副作用", `UPDATE ${T} SET 数量 = 0 WHERE 1=1`, /安全红线/],
    ["TRUNCATE 拒绝且零副作用", `TRUNCATE TABLE ${T}`, /安全红线/],
    ["DROP TABLE 拒绝（DDL 不放行）且表仍在", `DROP TABLE ${T}`, /only allows|E_SAFETY/],
    ["多语句 UPDATE;DROP 整体拒绝且库完好", `UPDATE ${T} SET 数量 = 0 WHERE id = 1; DROP TABLE ${T}`, /E_(SAFETY|PARAM|NOT_FOUND|CONFIG|LIMIT|DB|INTERNAL)/],
  ];
  for (const [name, sql, re] of negatives) {
    const r = await call("execute", { source: PG_ID, sql });
    const after = await snap();
    check("红线：" + name, r.isError && re.test(r.text) && after === before && (await tableExists()), r.text.slice(0, 160) + " | snap " + before + "->" + after);
  }

  // ⑪ BLOB(bytea) 真实往返
  const bins = await call("execute", { source: PG_ID, sql: `INSERT INTO ${T} (id, 名称, 数量, payload) VALUES (5, '戊', 50, '\\x000102ff')` });
  const directBlob = (await mgr.runQuery(PG_ID, `SELECT payload FROM ${T} WHERE id = 5`)).rows[0]?.payload;
  const dHex = norm(directBlob);
  check("BLOB(bytea) 真实入库（直连 hex=000102ff）", !bins.isError && dHex === "000102ff", bins.text.slice(0, 120) + " | hex=" + dHex);
  const bq = await call("query", { source: PG_ID, sql: `SELECT payload FROM ${T} WHERE id = 5` });
  check("BLOB query 形状 <binary 4 bytes: 000102ff>（非键值垃圾）", !bq.isError && bq.text.includes("<binary 4 bytes: 000102ff>") && !bq.text.includes('{"0"'), bq.text.slice(0, 160));

  // ⑫ 导出 CSV/JSON 与直连一致
  const ej = await call("export_data", { source: PG_ID, sql: `SELECT id, 名称, 数量 FROM ${T} ORDER BY id`, format: "json", filename: "matrix.json", overwrite: true });
  const ejf = JSON.parse(fs.readFileSync(path.join(exportDir, "matrix.json"), "utf8"));
  const ejRows = ejf.rows || ejf;
  const directAll = (await mgr.runQuery(PG_ID, `SELECT id, 名称, 数量 FROM ${T} ORDER BY id`)).rows;
  check("导出 JSON 与直连逐值一致", !ej.isError && ejRows.length === directAll.length && ejRows.every((r, i) => norm(r.id) === norm(directAll[i].id) && norm(r.数量) === norm(directAll[i].数量)), ej.text.slice(0, 140));
  const eb = await call("export_data", { source: PG_ID, sql: `SELECT payload FROM ${T} WHERE id = 5`, format: "json", filename: "blob.json", overwrite: true });
  const ebj = (JSON.parse(fs.readFileSync(path.join(exportDir, "blob.json"), "utf8")).rows || [])[0];
  check("导出 JSON BLOB→hex 与直连一致（000102ff）", !eb.isError && ebj && ebj.payload === "000102ff", eb.text.slice(0, 120) + " | " + JSON.stringify(ebj));
  const ec = await call("export_data", { source: PG_ID, sql: `SELECT id, 名称 FROM ${T} WHERE id = 4`, format: "csv", filename: "row4.csv", overwrite: true });
  const ecs = fs.readFileSync(path.join(exportDir, "row4.csv"), "utf8");
  check("导出 CSV 内容与直连一致（含 丁）", !ec.isError && ecs.includes("丁") && /4/.test(ecs), ecs.slice(0, 120));

  // ⑫-b v1.6.32 CSV 行集流式（pg 游标消费）：与 JSON 物化再格式化逐字节恒等 + limit 截断边界
  {
    const esl = `SELECT id, 数量 FROM ${T} ORDER BY id`;
    await call("export_data", { source: PG_ID, sql: esl, format: "json", filename: "stream_ref.json", overwrite: true });
    const esRows = JSON.parse(fs.readFileSync(path.join(exportDir, "stream_ref.json"), "utf8")).rows || [];
    const esc = await call("export_data", { source: PG_ID, sql: esl, format: "csv", filename: "stream_cmp.csv", overwrite: true });
    const esWant = "id,数量\r\n" + esRows.map((r) => r.id + "," + r.数量).join("\r\n") + "\r\n";
    const esGot = fs.readFileSync(path.join(exportDir, "stream_cmp.csv"), "utf8");
    check("导出 CSV 行集流式与 JSON 物化再格式化逐字节恒等（v1.6.32）",
      !esc.isError && esRows.length > 0 && esGot === esWant
        && Number(esc.data?.row_count) === esRows.length && esc.data?.truncated === false
        && "formula_cells_neutralized" in (esc.data || {}),
      esc.text.slice(0, 140) + " | bytes " + esGot.length + " vs " + esWant.length);
    const est = await call("export_data", { source: PG_ID, sql: esl, limit: 2, format: "csv", filename: "stream_cut.csv", overwrite: true });
    const estLines = fs.readFileSync(path.join(exportDir, "stream_cut.csv"), "utf8").trim().split(/\r?\n/);
    check("导出 limit 截断边界：limit=2 → truncated=true 且只落 2 行（游标停消费）",
      !est.isError && Number(est.data?.row_count) === 2 && est.data?.truncated === true && estLines.length === 3,
      est.text.slice(0, 140) + " | lines=" + estLines.length);
    const esx = await call("export_data", { source: PG_ID, sql: esl + " LIMIT 2", limit: 2, format: "csv", filename: "stream_exact.csv", overwrite: true });
    check("导出恰好等量不误报截断（流式边界）",
      !esx.isError && Number(esx.data?.row_count) === 2 && esx.data?.truncated === false,
      esx.text.slice(0, 140));
  }

  /* ⑬ 全工具面钉测（v1.6.18，对标 mysql-validate）：画像/发现类/查询类/计划写入建表/事务。
        PG 方言分支此前只在纯函数单测验证——information_schema $n 占位符、EXPLAIN (FORMAT JSON)、
        COUNT(*)::bigint 字符串化、ILIKE 子串匹配、括号复合不包外层 LIMIT，此处全部真实端到端执行。 */
  const HIST = "pg_probe_hist";
  const HIST_IMPORT = "pg_probe_hist_import";
  const HIST_CHILD = "pg_probe_hist_child";
  const TX = "pg_probe_tx";
  const histCnt = async (tbl) => Number((await mgr.runQuery(PG_ID, `SELECT COUNT(*) AS c FROM ${tbl}`)).rows[0].c);

  // 脚手架（pool 直连）：100 行分布数据（v=0..99；vn 每 5 个 NULL；tag a50/b30/c20）+ FK 边表
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${HIST_CHILD}`);
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${HIST_IMPORT}`);
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${HIST}`);
  await mgr.runQuery(PG_ID, `CREATE TABLE ${HIST} (id INT PRIMARY KEY, v INT NULL, vn INT NULL, tag VARCHAR(8) NOT NULL)`);
  await mgr.runQuery(PG_ID, `CREATE TABLE ${HIST_IMPORT} (id INT PRIMARY KEY, v INT NULL, tag VARCHAR(8) NOT NULL)`);
  const tuples = [];
  for (let i = 0; i < 100; i++) tuples.push(i, i, i % 5 === 0 ? null : i, i < 50 ? "a" : i < 80 ? "b" : "c");
  const rowPh = Array.from({ length: 100 }, (_, r) => "(" + Array.from({ length: 4 }, (_, c) => `$${r * 4 + c + 1}`).join(",") + ")").join(",");
  await mgr.runQuery(PG_ID, `INSERT INTO ${HIST} (id, v, vn, tag) VALUES ${rowPh}`, tuples);
  await mgr.runQuery(PG_ID, `CREATE TABLE ${HIST_CHILD} (id INT PRIMARY KEY, pid INT NULL, note VARCHAR(8) NULL, CONSTRAINT fk_child_hist FOREIGN KEY (pid) REFERENCES ${HIST}(id))`);
  await mgr.runQuery(PG_ID, `INSERT INTO ${HIST_CHILD} (id, pid, note) VALUES (1, 0, 'x'), (2, 1, 'y'), (3, NULL, 'z')`);
  check("scaffold: hist 100 行分布数据 + FK 边表（直连核对）", (await histCnt(HIST)) === 100 && (await histCnt(HIST_CHILD)) === 3, "cnt=" + (await histCnt(HIST)));

  const callStats = async (args) => call("column_stats", { source: PG_ID, table: HIST, ...args });
  const callQ = async (sql) => call("query", { source: PG_ID, sql, max_rows: 50 });

  // ⑬-1 column_stats：画像 / 直方图 / TopN（PG int8/numeric 字符串化、LEAST/INTEGER 方言分支）
  const st = await callStats({ column: "v" });
  const s = st.data?.stats || {};
  check("column_stats: v 画像 row_count=100 distinct=100 min=0 max=99 avg=49.5",
    !st.isError && Number(s.row_count) === 100 && Number(s.non_null) === 100 && Number(s.distinct_values) === 100
      && Number(s.min_value) === 0 && Number(s.max_value) === 99 && Math.abs(Number(s.avg_value) - 49.5) < 0.001,
    st.text.slice(0, 180));

  const h1 = await callStats({ column: "v", histogram: { buckets: 10 } });
  const hb = h1.data?.histogram || [];
  const hsum = hb.reduce((a, b) => a + Number(b.row_count), 0);
  check("histogram: 10 桶 × 10 行，首桶下界 0 / 末桶上界 99（clamp 契约）",
    !h1.isError && hb.length === 10 && hsum === 100 && hb.every((b, i) => Number(b.bucket_index) === i && Number(b.row_count) === 10)
      && Math.abs(Number(hb[0]?.bucket_lower) - 0) < 0.001 && Math.abs(Number(hb[9]?.bucket_upper) - 99) < 0.001,
    h1.text.slice(0, 180));

  const h2 = await callStats({ column: "v", where: "v < 50", histogram: { buckets: 10 } });
  const hb2 = h2.data?.histogram || [];
  check("histogram: where v<50 过滤域一致 → 10 桶合计 50",
    !h2.isError && hb2.length === 10 && hb2.reduce((a, b) => a + Number(b.row_count), 0) === 50,
    h2.text.slice(0, 180));

  const h3 = await callStats({ column: "v", histogram: { buckets: 100 } });
  const h4 = await callStats({ column: "v", histogram: { buckets: "abc" } });
  check("histogram: buckets=100 夹到 50 桶（intArg 上限）；buckets='abc' 报 E_PARAM",
    !h3.isError && (h3.data?.histogram || []).length === 50 && h4.isError && /E_PARAM/.test(h4.text),
    (h3.data?.histogram || []).length + " | " + h4.text.slice(0, 120));

  // v1.6.20: 直方图退化边界锚定（三库实测一致后逐库钉住）——文本列修复前是 text-text 42883 硬错误
  const g1 = await callStats({ column: "v", histogram: { buckets: 10 }, where: "v = 7" });
  const gg1 = g1.data?.histogram || [];
  check("histogram 退化锚定: min=max 单桶 [7,8)×1（hi=lo 宽 1.0 防除零）",
    !g1.isError && gg1.length === 1 && Number(gg1[0].bucket_index) === 0 && Number(gg1[0].row_count) === 1
      && Number(gg1[0].bucket_lower) === 7 && Number(gg1[0].bucket_upper) === 8,
    g1.text.slice(0, 160));
  const g2 = await callStats({ column: "v", histogram: { buckets: 3 }, where: "v = 0 OR v = 99" });
  const gg2 = g2.data?.histogram || [];
  check("histogram 退化锚定: 两值三桶稀疏（0→桶0、99→末桶封顶桶2，桶1 空缺不产行）",
    !g2.isError && gg2.length === 2 && Number(gg2[0].bucket_index) === 0 && Number(gg2[0].row_count) === 1
      && Number(gg2[0].bucket_lower) === 0 && Number(gg2[0].bucket_upper) === 33
      && Number(gg2[1].bucket_index) === 2 && Number(gg2[1].bucket_upper) === 99,
    g2.text.slice(0, 160));
  const g3 = await callStats({ column: "tag", histogram: { buckets: 4 } });
  check("histogram 文本列锚定: 非数值列空数组收口（v1.6.20 修 42883 硬错误，三库统一）",
    !g3.isError && Array.isArray(g3.data?.histogram) && g3.data.histogram.length === 0,
    g3.text.slice(0, 160));

  // v1.6.21: 全 NULL 列 / 单行列边界锚定（三库探针实测一致后钉住）——全 NULL 域 rng lo/hi=NULL
  // → 宽 NULL → 桶号 NULL → 空数组收口（min/max/avg=NULL 不除零不崩）；单行域 hi=lo → 宽 1.0 防除零
  // 单桶 [v,v+1)。探针表前后双保险 DROP（finally 兜底清单亦含），空表路径由下方 v1.6.22 钉锚定。
  for (const t of ["pg_probe_hgnull", "pg_probe_hgsingle"]) await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${t}`);
  await mgr.runQuery(PG_ID, "CREATE TABLE pg_probe_hgnull (id INT PRIMARY KEY, vg INT NULL, tg VARCHAR(8) NULL)");
  await mgr.runQuery(PG_ID, "CREATE TABLE pg_probe_hgsingle (id INT PRIMARY KEY, v INT NULL)");
  await mgr.runQuery(PG_ID, "INSERT INTO pg_probe_hgnull (id, vg, tg) VALUES (1, NULL, NULL), (2, NULL, NULL), (3, NULL, NULL)");
  await mgr.runQuery(PG_ID, "INSERT INTO pg_probe_hgsingle (id, v) VALUES (1, 7)");
  const gn = await call("column_stats", { source: PG_ID, table: "pg_probe_hgnull", column: "vg", histogram: { buckets: 4 } });
  const gt = await call("column_stats", { source: PG_ID, table: "pg_probe_hgnull", column: "tg", histogram: { buckets: 4 } });
  const gsg = await call("column_stats", { source: PG_ID, table: "pg_probe_hgsingle", column: "v", histogram: { buckets: 4 } });
  const gns = gn.data?.stats || {};
  const gsh = gsg.data?.histogram || [];
  check("histogram 边界锚定: 全 NULL 列空数组收口（min/max/avg=NULL 不除零）+ 单行列单桶 [7,8)×1",
    !gn.isError && Array.isArray(gn.data?.histogram) && gn.data.histogram.length === 0
      && Number(gns.row_count) === 3 && Number(gns.non_null) === 0 && Number(gns.distinct_values) === 0
      && gns.min_value == null && gns.max_value == null && gns.avg_value == null
      && !gt.isError && Array.isArray(gt.data?.histogram) && gt.data.histogram.length === 0
      && !gsg.isError && gsh.length === 1 && Number(gsh[0].bucket_index) === 0 && Number(gsh[0].row_count) === 1
      && Number(gsh[0].bucket_lower) === 7 && Number(gsh[0].bucket_upper) === 8
      && Number(gsg.data?.stats?.min_value) === 7 && Number(gsg.data?.stats?.max_value) === 7,
    (gn.isError ? gn.text : gt.isError ? gt.text : gsg.text).slice(0, 180));
  for (const t of ["pg_probe_hgnull", "pg_probe_hgsingle"]) await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${t}`);

  // v1.6.22: 空表（0 行）histogram/stats 边界锚定（探针 12 项三库实测一致后钉住）——0 行域
  // MIN/MAX=NULL → 同全 NULL 列 NULL-rng 路径 → 空数组收口；row_count=0/non_null=0/distinct=0、
  // min/max/avg=NULL 不除零，top_values 空数组。建表不插行即空表，前后双保险 DROP + finally 兜底。
  await mgr.runQuery(PG_ID, "DROP TABLE IF EXISTS pg_probe_hgempty");
  await mgr.runQuery(PG_ID, "CREATE TABLE pg_probe_hgempty (id INT PRIMARY KEY, v INT NULL, s VARCHAR(8) NULL)");
  const gev = await call("column_stats", { source: PG_ID, table: "pg_probe_hgempty", column: "v", histogram: { buckets: 4 }, top_values: { limit: 3 } });
  const ges = await call("column_stats", { source: PG_ID, table: "pg_probe_hgempty", column: "s", histogram: { buckets: 4 } });
  const geSt = gev.data?.stats || {};
  check("histogram/stats 空表锚定: 0 行表空数组收口（row_count=0、min/max/avg=NULL 不除零）+ top_values 空数组",
    !gev.isError && Array.isArray(gev.data?.histogram) && gev.data.histogram.length === 0
      && Array.isArray(gev.data?.top_values) && gev.data.top_values.length === 0
      && Number(geSt.row_count) === 0 && Number(geSt.non_null) === 0 && Number(geSt.distinct_values) === 0
      && geSt.min_value == null && geSt.max_value == null && geSt.avg_value == null
      && !ges.isError && Array.isArray(ges.data?.histogram) && ges.data.histogram.length === 0
      && Number(ges.data?.stats?.row_count) === 0 && Number(ges.data?.stats?.non_null) === 0,
    (gev.isError ? gev.text : ges.isError ? ges.text : JSON.stringify({ v: gev.data, s: ges.data })).slice(0, 180));
  await mgr.runQuery(PG_ID, "DROP TABLE IF EXISTS pg_probe_hgempty");

  const t1 = await callStats({ column: "tag", top_values: { limit: 2 } });
  const tv = t1.data?.top_values || [];
  check("top_values: tag Top2 → a:50, b:30（频数降序 + 值升序；文本列 avg=NULL 门控）",
    !t1.isError && tv.length === 2 && tv[0].value === "a" && Number(tv[0].count) === 50
      && tv[1].value === "b" && Number(tv[1].count) === 30
      && t1.data?.stats?.avg_value == null,   // v1.6.18 修复钉：文本列 avg 类型门控为 NULL（旧版 PG 42883 整条失败）
    t1.text.slice(0, 180));

  const t2 = await callStats({ column: "tag", where: "id < 30", top_values: { limit: 5 } });
  const tv2 = t2.data?.top_values || [];
  check("top_values: where id<30 → 仅 a:30", !t2.isError && tv2.length === 1 && tv2[0].value === "a" && Number(tv2[0].count) === 30,
    t2.text.slice(0, 180));

  const nz = await callStats({ column: "vn", histogram: { buckets: 10 } });
  const ns = nz.data?.stats || {};
  const nzSum = (nz.data?.histogram || []).reduce((a, b) => a + Number(b.row_count), 0);
  check("nulls: vn 画像 non_null=80 distinct=80，直方图合计 80（NULL 排除）",
    !nz.isError && Number(ns.row_count) === 100 && Number(ns.non_null) === 80 && Number(ns.distinct_values) === 80 && nzSum === 80,
    nz.text.slice(0, 180));

  const cb = await callStats({ column: "v", histogram: { buckets: 4 }, top_values: { limit: 3 } });
  check("combo: 一次调用同时返回 stats + histogram + top_values",
    !cb.isError && !!cb.data?.stats && (cb.data?.histogram || []).length === 4 && (cb.data?.top_values || []).length === 3,
    cb.text.slice(0, 180));

  // ⑬-1b v1.6.19: 文本列画像语义锚定（跨方言 avg 差异逐库钉住——PG 类型门控 NULL、
  // sqlite/MySQL 非数值强转 0；同名断言存在于三套件，改任何一库的语义都会在对应真库套件上炸出来）
  const ta = await callStats({ column: "tag" });
  const tas = ta.data?.stats || {};
  check("column_stats 文本列语义锚定: min/max 字典序 a/c + avg 类型门控 NULL（pg）",
    !ta.isError && Number(tas.row_count) === 100 && Number(tas.non_null) === 100 && Number(tas.distinct_values) === 3
      && tas.min_value === "a" && tas.max_value === "c" && tas.avg_value == null,
    ta.text.slice(0, 160));

  // ⑬-1c 时间列画像回归钉（真实库抓获）：timestamp/date 没有 →numeric 注册 cast，裸 )::numeric
  // 在计划期报 42846（cannot cast）整条画像失败——CASE 类型门控 + ::text::numeric 后应 avg NULL、
  // min/max 时间串可读、画像不崩（表自建自删，不并入 HIST 脚手架）
  await mgr.runQuery(PG_ID, `CREATE TABLE pg_probe_ts (id INT PRIMARY KEY, ts TIMESTAMP NULL, d DATE NULL)`);
  await mgr.runQuery(PG_ID, `INSERT INTO pg_probe_ts (id, ts, d) VALUES (1, '1970-01-01 00:00:01', '1970-01-01'), (2, '2038-01-19 03:14:07', '2038-01-19'), (3, NULL, NULL)`);
  const tss = await call("column_stats", { source: PG_ID, table: "pg_probe_ts", column: "ts" });
  const tsStat = tss.data?.stats || {};
  check("column_stats 时间列不崩: avg 类型门控 NULL + min/max 可读（pg，42846 回归钉）",
    !tss.isError && tsStat.avg_value == null && /\d{4}-\d{2}-\d{2}/.test(String(tsStat.min_value)) && /\d{4}-\d{2}-\d{2}/.test(String(tsStat.max_value)),
    tss.text.slice(0, 160));
  const tsd = await call("column_stats", { source: PG_ID, table: "pg_probe_ts", column: "d" });
  check("column_stats date 列同样不崩（42846 回归钉）",
    !tsd.isError && (tsd.data?.stats || {}).avg_value == null, tsd.text.slice(0, 160));
  // v1.6.20 直方图同族钉：时间列 histogram 的 numv 减法也走 ::text::numeric（裸 ::numeric 计划期
  // 42846 整条失败）；类型门控后应空数组不崩
  const tsh = await call("column_stats", { source: PG_ID, table: "pg_probe_ts", column: "ts", histogram: { buckets: 4 } });
  check("histogram 时间列锚定: 空数组不崩（::text::numeric 防 42846 计划期，三库统一空数组语义）",
    !tsh.isError && Array.isArray(tsh.data?.histogram) && tsh.data.histogram.length === 0,
    tsh.text.slice(0, 160));
  await mgr.runQuery(PG_ID, `DROP TABLE pg_probe_ts`);

  // ⑬-2 发现类：list_tables / describe_table / find_tables_by_column / fk_relationships（信息架构 PG 分支）
  const lt = await call("list_tables", { source: PG_ID, schema: "public", name_like: "probe_hist" });
  const ltn = (lt.data?.tables || []).map((x) => String(x.name)).sort().join(",");
  check("list_tables: name_like 'probe_hist' 命中 3 张探针表（ILIKE；_ 是单字符通配符故弃用 'hist_'）",
    !lt.isError && Number(lt.data?.table_count) === 3 && ltn === "pg_probe_hist,pg_probe_hist_child,pg_probe_hist_import",
    lt.text.slice(0, 180));

  const dth = await call("describe_table", { source: PG_ID, table: HIST, schema: "public" });
  const dc = dth.data?.columns || [];
  check("describe_table: 列序 id,v,vn,tag + id 主键 + pkey 索引",
    !dth.isError && dc.map((c) => c.name).join(",") === "id,v,vn,tag"
      && Array.isArray(dth.data?.primary_key) && dth.data.primary_key.includes("id")
      && (dth.data?.indexes || []).some((x) => /pkey/i.test(String(x.name))),
    dth.text.slice(0, 180));

  const f1 = await call("find_tables_by_column", { source: PG_ID, column: "tag", schema: "public" });
  const f2 = await call("find_tables_by_column", { source: PG_ID, column: "vn", schema: "public" });
  check("find_tables_by_column: 'tag' 命中 2 表；'vn' 仅 hist（ILIKE 子串）",
    !f1.isError && (f1.data?.tables || []).join(",") === "pg_probe_hist,pg_probe_hist_import"
      && !f2.isError && (f2.data?.tables || []).join(",") === "pg_probe_hist",
    (f1.data?.tables || []).join(",") + " | " + (f2.data?.tables || []).join(","));

  const fk1 = await call("fk_relationships", { source: PG_ID, table: HIST_CHILD, schema: "public" });
  const fk2 = await call("fk_relationships", { source: PG_ID, schema: "public" });
  const fkPat = /pg_probe_hist_child\.pid -> pg_probe_hist\.id/;
  check("fk_relationships: hist_child.pid -> hist.id（单表与全 schema 两种查法）",
    !fk1.isError && fkPat.test((fk1.data?.relationships || []).join(" | "))
      && !fk2.isError && fkPat.test((fk2.data?.relationships || []).join(" | ")),
    (fk1.data?.relationships || []).join(" | ") + " || " + (fk2.data?.relationships || []).join(" | "));

  // ⑬-3 查询类：count_rows / distinct_values / sample_data / query（自动 LIMIT、括号复合、SHOW）
  const c1 = await call("count_rows", { source: PG_ID, table: HIST });
  const c2 = await call("count_rows", { source: PG_ID, table: HIST, where: "v < 50" });
  check("count_rows: 全表 100 / where v<50 → 50（::bigint total）",
    !c1.isError && Number(c1.data?.total) === 100 && !c2.isError && Number(c2.data?.total) === 50,
    c1.text.slice(0, 100) + " | " + c2.text.slice(0, 100));

  const dv = await call("distinct_values", { source: PG_ID, table: HIST, column: "tag" });
  const dvs = dv.data?.values || [];
  check("distinct_values: tag 三值 a:50 b:30 c:20 + distinct_total=3（稳定次序）",
    !dv.isError && Number(dv.data?.distinct_total) === 3 && dvs.length === 3
      && dvs[0].value === "a" && Number(dvs[0].cnt) === 50 && dvs[1].value === "b" && Number(dvs[1].cnt) === 30
      && dvs[2].value === "c" && Number(dvs[2].cnt) === 20,
    dv.text.slice(0, 180));

  const sd = await call("sample_data", { source: PG_ID, table: HIST, where: "id < 3", order_by: "id DESC", limit: 5 });
  const sdIds = (sd.data?.rows || []).map((x) => Number(x.id)).join(",");
  const sdBad = await call("sample_data", { source: PG_ID, table: HIST, order_by: "id; DROP TABLE x" });
  check("sample_data: where + order_by DESC 取最新；非法 order_by 报 E_PARAM",
    !sd.isError && sdIds === "2,1,0" && sdBad.isError && /E_PARAM/.test(sdBad.text),
    sdIds + " | " + sdBad.text.slice(0, 100));

  const q1 = await callQ(`SELECT id FROM ${HIST} ORDER BY id`);
  const q2 = await callQ(`(SELECT id FROM ${HIST} WHERE id < 3) UNION (SELECT id FROM ${HIST} WHERE id > 96)`);
  const q3 = await callQ("SHOW server_version");
  const q3v = q3.data?.rows?.[0] ? Object.values(q3.data.rows[0])[0] : null;
  check("query: 自动 LIMIT 截断（50 行 truncated）+ 括号复合 UNION 6 行 + SHOW server_version 放行",
    !q1.isError && Number(q1.data?.row_count) === 50 && q1.data?.truncated === true
      && !q2.isError && Number(q2.data?.row_count) === 6
      && !q3.isError && Number(q3.data?.row_count) === 1 && /^\d/.test(String(q3v)),
    (q1.data?.row_count) + "/" + q1.data?.truncated + " | " + q2.data?.row_count + " | " + q3v);

  // ⑬-4 计划/写入/建表/导入：query_plan / execute / create_table CTAS / import 原子性
  const qp1 = await call("query_plan", { source: PG_ID, sql: `SELECT id FROM ${HIST} WHERE id = 1`, format: "text" });
  const qp2 = await call("query_plan", { source: PG_ID, sql: `SELECT id FROM ${HIST} WHERE id = 1`, format: "json" });
  const qp3 = await call("query_plan", { source: PG_ID, sql: `UPDATE ${HIST} SET v = 0 WHERE id = 1` });
  check("query_plan: text/json 双格式计划（EXPLAIN / EXPLAIN (FORMAT JSON)）+ EXPLAIN 写语句拒绝",
    !qp1.isError && Array.isArray(qp1.data?.plan) && qp1.data.plan.length > 0
      && !qp2.isError && Array.isArray(qp2.data?.plan) && qp2.data.plan.length > 0
      && qp3.isError && /E_PARAM|only accepts/.test(qp3.text),
    qp1.text.slice(0, 80) + " | " + qp2.text.slice(0, 80) + " | " + qp3.text.slice(0, 100));

  const w1 = await call("execute", { source: PG_ID, sql: `INSERT INTO ${HIST_IMPORT} (id, v, tag) VALUES (200, 1, 'z')` });
  const w2 = await call("execute", { source: PG_ID, sql: `UPDATE ${HIST_IMPORT} SET v = 2 WHERE id = 200` });
  const w3 = await call("execute", { source: PG_ID, sql: `DELETE FROM ${HIST_IMPORT} WHERE id = 200` });
  check("execute: INSERT/UPDATE/DELETE affected_rows=1 逐条回报（pg rowCount）",
    !w1.isError && Number(w1.data?.affected_rows) === 1 && !w2.isError && Number(w2.data?.affected_rows) === 1
      && !w3.isError && Number(w3.data?.affected_rows) === 1,
    [w1, w2, w3].map((x) => x.data?.affected_rows).join(",") + " | " + w3.text.slice(0, 80));

  const ctas = await call("create_table", { source: PG_ID, sql: `CREATE TABLE pg_probe_hist_copy AS SELECT * FROM ${HIST}` });
  const copyGone = (await mgr.runQuery(PG_ID, `SELECT to_regclass('public.pg_probe_hist_copy') AS t`)).rows[0]?.t == null;
  check("create_table: CTAS 拒绝（E_SAFETY）且零建表", ctas.isError && /E_SAFETY/.test(ctas.text) && copyGone,
    ctas.text.slice(0, 140) + " | copyGone=" + copyGone);

  fs.writeFileSync(path.join(importDir, "good.csv"), "id,v,tag\n1,1,a\n2,2,b\n3,3,c\n4,4,a\n5,5,a\n", "utf8");
  const ig = await call("import_data", { source: PG_ID, table: HIST_IMPORT, filename: "good.csv" });
  check("import: 5 行落库（rows_imported=5 + 直连计数）",
    !ig.isError && Number(ig.data?.rows_imported) === 5 && (await histCnt(HIST_IMPORT)) === 5,
    ig.text.slice(0, 140) + " | cnt=" + (await histCnt(HIST_IMPORT)));

  fs.writeFileSync(path.join(importDir, "bad.csv"), "id,v,tag\n100,1,a\n101,2,b\n100,3,c\n", "utf8");
  const ia = await call("import_data", { source: PG_ID, table: HIST_IMPORT, filename: "bad.csv", atomic: true });
  const iaCnt = await histCnt(HIST_IMPORT);
  const ina = await call("import_data", { source: PG_ID, table: HIST_IMPORT, filename: "bad.csv" });
  const inaCnt = await histCnt(HIST_IMPORT);
  check("import: atomic 冲突整体回滚（5 行不变）；非 atomic 定位第 3 行且保留 2 好行（7 行）",
    ia.isError && /原子导入失败|已全部回滚/.test(ia.text) && iaCnt === 5
      && ina.isError && /第 3 行导入失败/.test(ina.text) && inaCnt === 7,
    ia.text.slice(0, 100) + " | " + ina.text.slice(0, 100) + " | cnt " + iaCnt + "->" + inaCnt);

  // v1.6.23: 事务内 COPY 锚定——atomic 路径同样走 COPY FROM STDIN（withTransaction 第二参
  // copyIn 把同一封包钉在事务连接上）：特殊字符逐字节保真 + 失败错误语义（E_DB 文案逐字、整体回滚）。
  await mgr.runQuery(PG_ID, "DROP TABLE IF EXISTS pg_probe_txc");
  await mgr.runQuery(PG_ID, "CREATE TABLE pg_probe_txc (id INT PRIMARY KEY, v TEXT NULL)");
  fs.writeFileSync(path.join(importDir, "txchars.csv"),
    'id,v\n1,"quote""inside"\n2,"back\\slash"\n3,"lf1\nlf2"\n4,"crlf1\r\ncrlf2"\n5,"tab\tinside"\n6,\\N\n7,\n', "utf8");
  const itc = await call("import_data", { source: PG_ID, table: "pg_probe_txc", filename: "txchars.csv", atomic: true });
  const itcRows = (await mgr.runQuery(PG_ID, "SELECT v FROM pg_probe_txc ORDER BY id")).rows.map((r) => r.v);
  const itcExpect = ['quote"inside', "back\\slash", "lf1\nlf2", "crlf1\r\ncrlf2", "tab\tinside", "\\N", ""];
  const itcFidelity = itcRows.length === itcExpect.length && itcExpect.every((v, i) => itcRows[i] === v);
  fs.writeFileSync(path.join(importDir, "txbad2.csv"), "id,v\n100,x\n100,y\n", "utf8");
  const itcf = await call("import_data", { source: PG_ID, table: "pg_probe_txc", filename: "txbad2.csv", atomic: true });
  const itcfCnt = await histCnt("pg_probe_txc");
  check("import atomic: 事务内 COPY 特殊字符逐字节保真（引号/反斜杠/LF/CRLF/制表/字面量\\N/空串）+ 失败整体回滚（E_DB 文案逐字、7 行不变）",
    !itc.isError && Number(itc.data?.rows_imported) === 7 && itcFidelity
      && itcf.isError && /E_DB/.test(itcf.text) && /原子导入失败，已全部回滚（未写入任何行）/.test(itcf.text) && itcfCnt === 7,
    "fidelity=" + itcFidelity + " rows=" + JSON.stringify(itcRows) + " | " + itcf.text.slice(0, 100) + " | cnt=" + itcfCnt);
  await mgr.runQuery(PG_ID, "DROP TABLE IF EXISTS pg_probe_txc");

  // v1.6.24: 取消传导锚定——atomic 长导入中途 notifications/cancelled：被取消请求不回响应
  //（MCP 规范「Not send a response」）+ COPY 传输尽力中断 + 事务回滚 0 行落库 + 连接健康。
  // 取消插队延迟分布（分块/阶段让出的效果）由 _probe_cancel_tmp 探针实测，此处不锚定时延。
  await mgr.runQuery(PG_ID, "DROP TABLE IF EXISTS pg_probe_cancel");
  await mgr.runQuery(PG_ID, "CREATE TABLE pg_probe_cancel (id INT PRIMARY KEY, v TEXT)");
  const wide800 = "x".repeat(800);
  let cCsv = "id,v\n";
  for (let i = 1; i <= 10000; i++) cCsv += `${i},${wide800}\n`;
  fs.writeFileSync(path.join(importDir, "cancel.csv"), cCsv, "utf8");
  const cx = srv.rpcRaw("tools/call", { name: "import_data", arguments: { source: PG_ID, table: "pg_probe_cancel", filename: "cancel.csv", atomic: true } });
  cx.promise.catch(() => {}); // 被取消的请求不回响应 → 不挂未处理拒绝（60s 后 harness 超时兜底）
  await new Promise((r) => setTimeout(r, 120)); // 导入实测 ≥300ms，+120ms 必落在 COPY 传输中段
  await srv.rpc("notifications/cancelled", { requestId: cx.id, reason: "validate-cancel-pin" }, true);
  const cxResp = await Promise.race([cx.promise, new Promise((r) => setTimeout(() => r("NO_RESPONSE"), 2500))]);
  const cxCnt = await histCnt("pg_probe_cancel");
  const cxH = await call("query", { source: PG_ID, sql: "SELECT 1 AS ok", max_rows: 1 });
  check("import 取消传导：atomic 长导入中途 notifications/cancelled → 不回响应（MCP 规范）+ 0 行落库（COPY 中断随整体回滚）+ 连接健康",
    cxResp === "NO_RESPONSE" && cxCnt === 0 && !cxH.isError && Number(cxH.data?.rows?.[0]?.ok) === 1,
    "resp=" + (cxResp === "NO_RESPONSE" ? "NO_RESPONSE" : "GOT_RESPONSE") + " cnt=" + cxCnt + " health=" + !cxH.isError);
  await mgr.runQuery(PG_ID, "DROP TABLE IF EXISTS pg_probe_cancel");

  // ⑬-5 事务：withTransaction 提交 / PK 冲突整体回滚（pool.mjs pg BEGIN/COMMIT/ROLLBACK 单连接）
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${TX}`);
  await mgr.runQuery(PG_ID, `CREATE TABLE ${TX} (id INT PRIMARY KEY, v VARCHAR(8) NOT NULL)`);
  await mgr.withTransaction(PG_ID, async (run) => {
    await run(`INSERT INTO ${TX} (id, v) VALUES ($1, $2)`, [1, "a"]);
    await run(`INSERT INTO ${TX} (id, v) VALUES ($1, $2)`, [2, "b"]);
  });
  let rolled = false;
  try {
    await mgr.withTransaction(PG_ID, async (run) => {
      await run(`INSERT INTO ${TX} (id, v) VALUES ($1, $2)`, [3, "c"]);
      await run(`INSERT INTO ${TX} (id, v) VALUES ($1, $2)`, [1, "dup"]);   // PK 冲突 → 整体回滚
    });
  } catch { rolled = true; }
  const txCnt = await histCnt(TX);
  check("tx: withTransaction 提交 2 行 / PK 冲突整体回滚（PG 单连接事务）", rolled && txCnt === 2, "rolled=" + rolled + " cnt=" + txCnt);

  // ⑭ DBA 直连删表 → MCP 侧确认真实删除
  await mgr.runQuery(PG_ID, `DROP TABLE ${T}`);
  const dtd = await call("describe_table", { source: PG_ID, table: T });
  check("DBA 删表真实执行（MCP describe_table 报 E_NOT_FOUND）", !(await tableExists()) && dtd.isError && /E_NOT_FOUND|not found/i.test(dtd.text), dtd.text.slice(0, 160));

  /* ⑮ 清理 */
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${IMPORT_TABLE}`);
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${HIST_CHILD}`);
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${HIST_IMPORT}`);
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${HIST}`);
  await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${TX}`);
} catch (e) {
  fail++;
  failures.push("FATAL :: " + (e && e.message ? e.message : e));
  console.log("FAIL FATAL - " + (e && e.message ? e.message : e));
} finally {
  if (srv) { try { srv.child.kill(); } catch {} }
  // 兜底清理：套件中途失败也不在真实库里留测试对象
  try {
    for (const t of ["pg_probe_matrix", "pg_probe_import", "pg_probe_hist_child", "pg_probe_hist_import", "pg_probe_hist", "pg_probe_tx", "pg_probe_hist_copy", "pg_probe_hgnull", "pg_probe_hgsingle", "pg_probe_hgempty", "pg_probe_txc", "pg_probe_cancel"]) {
      await mgr.runQuery(PG_ID, `DROP TABLE IF EXISTS ${t}`);
    }
  } catch {}
  try { fs.rmSync(ioRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpCfgFile, { force: true }); } catch {}
}
console.log(`\n=== pg-validate: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""} ===`);
for (const f of failures) console.log("  FAILDETAIL " + f);
process.exit(fail > 0 ? 1 : 0);
