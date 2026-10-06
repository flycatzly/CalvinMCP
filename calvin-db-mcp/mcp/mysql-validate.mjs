/**
 * mysql-validate.mjs — MySQL 真实库全链路验证套件（对标 sqlite-validate.mjs）
 *
 * v1.6.1 起：column_stats 基础画像 / 直方图 / TopN 高频值在真实 MySQL 上的端到端验证。
 * v1.6.2 起：全工具面钉测——list_tables / describe_table / find_tables_by_column / fk_relationships /
 * query（自动 LIMIT/括号复合/SHOW）/ query_plan / count_rows / distinct_values / sample_data /
 * execute（含红线拒绝零副作用核对）/ create_table（含 CTAS 拒绝）。
 * 链路为「真客户端」形态：spawn server.mjs → stdio JSON-RPC → 工具层 → 只读守卫 → 连接池 → MySQL。
 * 脚手架（建库建表灌数据）与清理（DROP DATABASE）走 pool.mjs 连接层——工具层按设计禁止 DDL。
 *
 * 前置条件（不满足时输出 SKIP 说明并以退出码 3 结束，不算失败）：
 *   - dbmcp.config.json 存在且含 type: "mysql" 的源（口令密文原样使用，不落明文）；
 *   - 运行环境网络可达该 MySQL。
 *
 * 测试对象全部隔离在临时库 dbmcp_probe_hist 中（套件自建自删），不触碰任何既有业务表。
 *
 * 用法: node mysql-validate.mjs   （在 mcp/ 目录下）
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
function check(name, fn) {
  try { fn(); pass++; console.log("PASS " + name); }
  catch (e) { fail++; console.log("FAIL " + name + " - " + (e && e.message ? e.message : e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log("PASS " + name); }
  catch (e) { fail++; console.log("FAIL " + name + " - " + (e && e.message ? e.message : e)); }
}
function num(v) { const n = Number(v); if (!Number.isFinite(n)) throw new Error("not a number: " + JSON.stringify(v)); return n; }

/* ---------------- 前置检查：配置与 mysql 源 ---------------- */
const cfgFile = path.join(here, "dbmcp.config.json");
if (!fs.existsSync(cfgFile)) {
  console.log("SKIP mysql-validate: dbmcp.config.json 不存在（未初始化部署），真实库套件跳过。");
  process.exit(3);
}
const realCfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
const mysqlEntry = Object.entries(realCfg.sources || {}).find(([, s]) => String(s.type || "").toLowerCase() === "mysql" && (s.enc || s.url));
if (!mysqlEntry) {
  console.log("SKIP mysql-validate: 配置中没有 type= mysql 的源，真实库套件跳过。");
  process.exit(3);
}
const [MYSQL_ID] = mysqlEntry;

/* ---------------- 临时配置副本：仅打开写/建表开关（enc 密文原样复制） ---------------- */
const tmpCfgFile = path.join(os.tmpdir(), `dbmcp-mysql-validate-cfg-${process.pid}.json`);
const tmpCfg = { ...realCfg, allowWrites: true, allowCreateTable: true };
fs.writeFileSync(tmpCfgFile, JSON.stringify(tmpCfg), "utf8");

/* ---------------- pool 层脚手架（与 server 同一条连接层路径） ---------------- */
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

const PROBE_DB = "dbmcp_probe_hist";
const PROBE_TABLE = `${PROBE_DB}.hist_probe`;
const IMPORT_TABLE = `${PROBE_DB}.hist_import`;

// export/import 工具的白名单目录（进程临时目录，套件自建自删）
const ioRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-mysql-io-"));
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
  return { child, rpc, errText: () => errText };
}

function parseToolResult(msg) {
  if (msg.error) throw new Error("rpc error: " + JSON.stringify(msg.error));
  const r = msg.result || {};
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) return { isError: true, text };
  try { return { isError: false, data: JSON.parse(text), text }; }
  catch { return { isError: false, data: null, text }; }
}

/* ---------------- 主流程 ---------------- */
const DB = "hist_probe";
let srv = null;
try {
  /* ① pool 层脚手架：建库建表 + 100 行数据（v=0..99；vn 每 5 个一个 NULL；tag a50/b30/c20） */
  await checkAsync("scaffold: 建库建表 + 灌 100 行隔离数据", async () => {
    // 整库重置：上次中断残留的 FK 边表会让单表 DROP/CREATE 撞外键
    await mgr.runQuery(MYSQL_ID, `DROP DATABASE IF EXISTS ${PROBE_DB}`);
    await mgr.runQuery(MYSQL_ID, `CREATE DATABASE ${PROBE_DB}`);
    await mgr.runQuery(MYSQL_ID, `CREATE TABLE ${PROBE_TABLE} (id INT PRIMARY KEY, v INT NULL, vn INT NULL, tag VARCHAR(8) NOT NULL)`);
    await mgr.runQuery(MYSQL_ID, `CREATE TABLE ${IMPORT_TABLE} (id INT PRIMARY KEY, v INT NULL, tag VARCHAR(8) NOT NULL)`);
    const tuples = [];
    for (let i = 0; i < 100; i++) {
      const vn = i % 5 === 0 ? null : i;
      const tag = i < 50 ? "a" : i < 80 ? "b" : "c";
      tuples.push(i, i, vn, tag);
    }
    const ph = "(" + Array(4).fill("?").join(",") + ")";
    const sql = `INSERT INTO ${PROBE_TABLE} (id, v, vn, tag) VALUES ${Array(100).fill(ph).join(",")}`;
    await mgr.runQuery(MYSQL_ID, sql, tuples);
    const { rows } = await mgr.runQuery(MYSQL_ID, `SELECT COUNT(*) AS n FROM ${PROBE_TABLE}`);
    if (num(rows[0].n) !== 100) throw new Error("row count " + rows[0].n);
    // FK 对（fk_relationships 真实链路用）：hist_child.pid → hist_probe.id（父行灌入后建，FK 即时生效）
    await mgr.runQuery(MYSQL_ID, `CREATE TABLE ${PROBE_DB}.hist_child (id INT PRIMARY KEY, pid INT NULL, note VARCHAR(8) NULL, CONSTRAINT fk_child_probe FOREIGN KEY (pid) REFERENCES ${PROBE_TABLE}(id))`);
    await mgr.runQuery(MYSQL_ID, `INSERT INTO ${PROBE_DB}.hist_child (id, pid, note) VALUES (1, 0, 'x'), (2, 1, 'y'), (3, NULL, 'z')`);
  });

  /* ② stdio 全链路握手 */
  srv = startServer();
  const init = await srv.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mysql-validate", version: "1" } });
  await srv.rpc("notifications/initialized", {}, true);
  check("stdio: initialize 握手（serverInfo=calvin-db-mcp）", () => {
    if (init.result?.serverInfo?.name !== "calvin-db-mcp") throw new Error(JSON.stringify(init).slice(0, 200));
  });
  const tl = await srv.rpc("tools/list", {});
  check("stdio: tools/list 暴露 column_stats + histogram/top_values 参数", () => {
    const cs = (tl.result?.tools || []).find((t) => t.name === "column_stats");
    if (!cs) throw new Error("column_stats missing");
    const p = cs.inputSchema?.properties || {};
    if (!p.histogram?.properties?.buckets || !p.top_values?.properties?.limit) {
      throw new Error("histogram/top_values params missing: " + Object.keys(p).join(","));
    }
  });

  const callStats = async (args) => parseToolResult(await srv.rpc("tools/call", { name: "column_stats", arguments: { source: MYSQL_ID, table: PROBE_TABLE, ...args } }));

  /* ③ 基础画像 */
  await checkAsync("column_stats: v 列画像 row_count=100 distinct=100 min=0 max=99 avg=49.5", async () => {
    const r = await callStats({ column: "v" });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const s = r.data.stats;
    if (num(s.row_count) !== 100 || num(s.non_null) !== 100 || num(s.distinct_values) !== 100) {
      throw new Error(JSON.stringify(s));
    }
    if (num(s.min_value) !== 0 || num(s.max_value) !== 99) throw new Error(JSON.stringify(s));
    if (Math.abs(num(s.avg_value) - 49.5) > 0.001) throw new Error("avg=" + s.avg_value);
  });

  /* ④ 直方图：10 桶 × 10 行（上界值 99 落入末桶 = clamp 契约） */
  await checkAsync("histogram: 10 桶 × 10 行，末桶含上界 99，bucket_upper=99", async () => {
    const r = await callStats({ column: "v", histogram: { buckets: 10 } });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const h = r.data.histogram;
    if (!Array.isArray(h) || h.length !== 10) throw new Error("bucket rows=" + (h && h.length));
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      if (num(h[i].bucket_index) !== i) throw new Error("index seq broken at " + i + ": " + JSON.stringify(h[i]));
      if (num(h[i].row_count) !== 10) throw new Error("bucket " + i + " count=" + h[i].row_count);
      sum += num(h[i].row_count);
    }
    if (sum !== 100) throw new Error("sum=" + sum);
    const last = h[9];
    if (Math.abs(num(last.bucket_upper) - 99) > 0.001) throw new Error("last upper=" + last.bucket_upper);
    if (Math.abs(num(h[0].bucket_lower) - 0) > 0.001) throw new Error("first lower=" + h[0].bucket_lower);
  });
  await checkAsync("histogram: where 过滤 v<50 → 10 桶 × 5 行合计 50", async () => {
    const r = await callStats({ column: "v", where: "v < 50", histogram: { buckets: 10 } });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const h = r.data.histogram;
    if (h.length !== 10) throw new Error("bucket rows=" + h.length);
    const sum = h.reduce((a, b) => a + num(b.row_count), 0);
    if (sum !== 50) throw new Error("sum=" + sum);
  });
  await checkAsync("histogram: buckets=100 被夹到 50 桶（intArg 上限），buckets='abc' 报错", async () => {
    const r1 = await callStats({ column: "v", histogram: { buckets: 100 } });
    if (r1.isError) throw new Error("buckets=100 should clamp: " + r1.text.slice(0, 120));
    if (r1.data.histogram.length !== 50) throw new Error("clamped rows=" + r1.data.histogram.length);
    const r2 = await callStats({ column: "v", histogram: { buckets: "abc" } });
    if (!r2.isError) throw new Error("buckets='abc' should error");
  });

  /* ⑤ TopN 高频值 */
  await checkAsync("top_values: tag Top2 → a:50, b:30（频数降序 + 值升序）", async () => {
    const r = await callStats({ column: "tag", top_values: { limit: 2 } });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const t = r.data.top_values;
    if (t.length !== 2) throw new Error("rows=" + t.length);
    if (t[0].value !== "a" || num(t[0].count) !== 50 || t[1].value !== "b" || num(t[1].count) !== 30) {
      throw new Error(JSON.stringify(t));
    }
  });
  await checkAsync("top_values: where 过滤 id<30 → 仅 a:30", async () => {
    const r = await callStats({ column: "tag", where: "id < 30", top_values: { limit: 5 } });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const t = r.data.top_values;
    if (t.length !== 1 || t[0].value !== "a" || num(t[0].count) !== 30) throw new Error(JSON.stringify(t));
  });

  /* ⑥ NULL 语义：vn 列 20 个 NULL，画像与直方图都要排除 */
  await checkAsync("nulls: vn 画像 non_null=80 distinct=80，直方图合计 80（NULL 排除）", async () => {
    const r = await callStats({ column: "vn", histogram: { buckets: 10 } });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const s = r.data.stats;
    if (num(s.row_count) !== 100 || num(s.non_null) !== 80 || num(s.distinct_values) !== 80) {
      throw new Error(JSON.stringify(s));
    }
    const sum = r.data.histogram.reduce((a, b) => a + num(b.row_count), 0);
    if (sum !== 80) throw new Error("histogram sum=" + sum);
  });

  /* ⑥b v1.6.20: 直方图退化边界锚定（三库实测一致后逐库钉住；文本列空数组是修复后统一契约） */
  await checkAsync("histogram 退化锚定: min=max 单桶 [7,8)×1（hi=lo 宽 1.0 防除零）", async () => {
    const r = await callStats({ column: "v", histogram: { buckets: 10 }, where: "v = 7" });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const h = r.data.histogram;
    if (h.length !== 1 || num(h[0].bucket_index) !== 0 || num(h[0].row_count) !== 1
      || num(h[0].bucket_lower) !== 7 || num(h[0].bucket_upper) !== 8) throw new Error(JSON.stringify(h));
  });
  await checkAsync("histogram 退化锚定: 两值三桶稀疏（0→桶0、99→末桶封顶桶2，桶1 空缺不产行）", async () => {
    const r = await callStats({ column: "v", histogram: { buckets: 3 }, where: "v = 0 OR v = 99" });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const h = r.data.histogram;
    if (h.length !== 2 || num(h[0].bucket_index) !== 0 || num(h[0].row_count) !== 1
      || num(h[0].bucket_lower) !== 0 || num(h[0].bucket_upper) !== 33
      || num(h[1].bucket_index) !== 2 || num(h[1].bucket_upper) !== 99) throw new Error(JSON.stringify(h));
  });
  await checkAsync("histogram 文本列锚定: 非数值列空数组收口（不炸不脏，三库统一）", async () => {
    const r = await callStats({ column: "tag", histogram: { buckets: 4 } });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    if (!Array.isArray(r.data.histogram) || r.data.histogram.length !== 0) throw new Error(JSON.stringify(r.data.histogram));
  });

  /* ⑥c v1.6.21: 全 NULL 列 / 单行列边界锚定（三库探针实测一致后钉住）——全 NULL 域 rng lo/hi=NULL
     → 宽 NULL → 桶号 NULL → 空数组收口（min/max/avg=NULL 不除零不崩）；单行域 hi=lo → 宽 1.0 防除零
     单桶 [v,v+1)。探针表建在 PROBE_DB 内（整库 DROP 自动覆盖清理），空表路径由 ⑥c2（v1.6.22）锚定。 */
  await checkAsync("histogram 边界锚定: 全 NULL 列空数组收口（min/max/avg=NULL 不除零）+ 单行列单桶 [7,8)×1", async () => {
    await mgr.runQuery(MYSQL_ID, `CREATE TABLE ${PROBE_DB}.hgnull (id INT PRIMARY KEY, vg INT NULL, tg VARCHAR(8) NULL)`);
    await mgr.runQuery(MYSQL_ID, `CREATE TABLE ${PROBE_DB}.hgsingle (id INT PRIMARY KEY, v INT NULL)`);
    await mgr.runQuery(MYSQL_ID, `INSERT INTO ${PROBE_DB}.hgnull (id, vg, tg) VALUES (1, NULL, NULL), (2, NULL, NULL), (3, NULL, NULL)`);
    await mgr.runQuery(MYSQL_ID, `INSERT INTO ${PROBE_DB}.hgsingle (id, v) VALUES (1, 7)`);
    const rn = await callStats({ table: `${PROBE_DB}.hgnull`, column: "vg", histogram: { buckets: 4 } });
    const rt = await callStats({ table: `${PROBE_DB}.hgnull`, column: "tg", histogram: { buckets: 4 } });
    const rs = await callStats({ table: `${PROBE_DB}.hgsingle`, column: "v", histogram: { buckets: 4 } });
    if (rn.isError || rt.isError || rs.isError) throw new Error((rn.isError ? rn : rt.isError ? rt : rs).text.slice(0, 200));
    const s = rn.data.stats, sh = rs.data.histogram || [];
    const ok = Array.isArray(rn.data.histogram) && rn.data.histogram.length === 0
      && num(s.row_count) === 3 && num(s.non_null) === 0 && num(s.distinct_values) === 0
      && s.min_value == null && s.max_value == null && s.avg_value == null
      && Array.isArray(rt.data.histogram) && rt.data.histogram.length === 0
      && sh.length === 1 && num(sh[0].bucket_index) === 0 && num(sh[0].row_count) === 1
      && num(sh[0].bucket_lower) === 7 && num(sh[0].bucket_upper) === 8
      && num(rs.data.stats.min_value) === 7 && num(rs.data.stats.max_value) === 7;
    if (!ok) throw new Error(JSON.stringify({ gn: rn.data, gt: rt.data, gs: rs.data }).slice(0, 300));
  });

  /* ⑥c2 v1.6.22: 空表（0 行）histogram/stats 边界锚定（探针 12 项三库实测一致后钉住）——0 行域
     MIN/MAX=NULL → 同全 NULL 列 NULL-rng 路径 → 空数组收口；row_count=0/non_null=0/distinct=0、
     min/max/avg=NULL 不除零，top_values 空数组。建表不插行即空表，探针表建在 PROBE_DB 内
     （整库 DROP 自动覆盖清理）。 */
  await checkAsync("histogram/stats 空表锚定: 0 行表空数组收口（row_count=0、min/max/avg=NULL 不除零）+ top_values 空数组", async () => {
    await mgr.runQuery(MYSQL_ID, `CREATE TABLE ${PROBE_DB}.hgempty (id INT PRIMARY KEY, v INT NULL, s VARCHAR(8) NULL)`);
    const re = await callStats({ table: `${PROBE_DB}.hgempty`, column: "v", histogram: { buckets: 4 }, top_values: { limit: 3 } });
    const rs2 = await callStats({ table: `${PROBE_DB}.hgempty`, column: "s", histogram: { buckets: 4 } });
    if (re.isError || rs2.isError) throw new Error((re.isError ? re : rs2).text.slice(0, 200));
    const s = re.data.stats;
    const ok = Array.isArray(re.data.histogram) && re.data.histogram.length === 0
      && Array.isArray(re.data.top_values) && re.data.top_values.length === 0
      && num(s.row_count) === 0 && num(s.non_null) === 0 && num(s.distinct_values) === 0
      && s.min_value == null && s.max_value == null && s.avg_value == null
      && Array.isArray(rs2.data.histogram) && rs2.data.histogram.length === 0
      && num(rs2.data.stats.row_count) === 0 && num(rs2.data.stats.non_null) === 0;
    if (!ok) throw new Error(JSON.stringify({ ev: re.data, es: rs2.data }).slice(0, 300));
  });

  /* ⑥d 第 25 轮残洞锚定：时间列脏桶——DATETIME/DATE 隐式转数读数字头（'2024-01-01 00:00:05'
     → 20240101000005）曾产出 20240101000000.00000 伪数值桶界，破「非数值列 → 空数组」契约
     （⑥b 只钉文本列、时间列漏网）。修法：mysql 减法前按值形状 REGEXP 门控；数值样文本照旧
     放行 GIGO（「数字样文本」carve-out，与 avg 强转 0 同哲学）。 */
  await checkAsync("histogram 时间列锚定: DATETIME/DATE 空数组收口 + 数字样文本 GIGO 桶保留", async () => {
    await mgr.runQuery(MYSQL_ID, `CREATE TABLE ${PROBE_DB}.hgts (id INT PRIMARY KEY, ts DATETIME NULL, d DATE NULL, numtxt VARCHAR(20) NULL)`);
    await mgr.runQuery(MYSQL_ID, `INSERT INTO ${PROBE_DB}.hgts (id, ts, d, numtxt) VALUES (1, '2024-01-01 00:00:01', '2024-01-01', '10'), (2, '2024-01-01 00:00:09', '2024-01-02', '30'), (3, '2024-01-01 00:00:17', '2024-01-03', '50')`);
    const rts = await callStats({ table: `${PROBE_DB}.hgts`, column: "ts", histogram: { buckets: 3 } });
    const rd = await callStats({ table: `${PROBE_DB}.hgts`, column: "d", histogram: { buckets: 3 } });
    const rn = await callStats({ table: `${PROBE_DB}.hgts`, column: "numtxt", histogram: { buckets: 3 } });
    if (rts.isError || rd.isError || rn.isError) throw new Error((rts.isError ? rts : rd.isError ? rd : rn).text.slice(0, 200));
    if (!Array.isArray(rts.data.histogram) || rts.data.histogram.length !== 0) throw new Error("ts histogram must be empty: " + JSON.stringify(rts.data.histogram));
    if (!Array.isArray(rd.data.histogram) || rd.data.histogram.length !== 0) throw new Error("date histogram must be empty: " + JSON.stringify(rd.data.histogram));
    const hn = rn.data.histogram;
    if (!Array.isArray(hn) || hn.length === 0) throw new Error("numeric-looking text keeps GIGO buckets: " + JSON.stringify(hn));
    const sum = hn.reduce((a, b) => a + num(b.row_count), 0);
    if (sum !== 3) throw new Error("histogram sum=" + sum);
  });

  /* ⑦ 组合：画像 + 直方图 + TopN 一次返回 */
  await checkAsync("combo: 一次调用同时返回 stats + histogram + top_values", async () => {
    const r = await callStats({ column: "v", histogram: { buckets: 4 }, top_values: { limit: 3 } });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    if (!r.data.stats || r.data.histogram?.length !== 4 || r.data.top_values?.length !== 3) {
      throw new Error(JSON.stringify(Object.keys(r.data)));
    }
  });

  /* ⑦b v1.6.19: 文本列画像语义锚定（跨方言 avg 差异逐库钉住——sqlite/MySQL 非数值强转 0、
        PG 类型门控 NULL；同名断言存在于三套件，改任何一库的语义都会在对应真库套件上炸出来） */
  await checkAsync("column_stats 文本列语义锚定: min/max 字典序 a/c + avg 非数值强转 0（mysql）", async () => {
    const r = await callStats({ column: "tag" });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const s = r.data.stats;
    if (num(s.row_count) !== 100 || num(s.non_null) !== 100 || num(s.distinct_values) !== 3) throw new Error(JSON.stringify(s));
    if (s.min_value !== "a" || s.max_value !== "c") throw new Error("min/max=" + s.min_value + "/" + s.max_value);
    // 探针实测：('a','b','c') avg=0；('10','20','x') avg=10——非数值文本按 0 计入分母
    if (Math.abs(num(s.avg_value) - 0) > 0.001) throw new Error("avg=" + s.avg_value);
  });

  /* ⑧ 事务：withTransaction 提交/回滚（v1.5.3 一次性探针的固化——钉单连接，真实 MySQL） */
  await checkAsync("tx: withTransaction 提交 2 行 / PK 冲突整体回滚（真实 MySQL 单连接事务）", async () => {
    await mgr.runQuery(MYSQL_ID, `CREATE TABLE ${PROBE_DB}.tx_probe (id INT PRIMARY KEY, v VARCHAR(8) NOT NULL)`);
    await mgr.withTransaction(MYSQL_ID, async (run) => {
      await run(`INSERT INTO ${PROBE_DB}.tx_probe (id, v) VALUES (?, ?)`, [1, "a"]);
      await run(`INSERT INTO ${PROBE_DB}.tx_probe (id, v) VALUES (?, ?)`, [2, "b"]);
    });
    let rolled = false;
    try {
      await mgr.withTransaction(MYSQL_ID, async (run) => {
        await run(`INSERT INTO ${PROBE_DB}.tx_probe (id, v) VALUES (?, ?)`, [3, "c"]);
        await run(`INSERT INTO ${PROBE_DB}.tx_probe (id, v) VALUES (?, ?)`, [1, "dup"]);   // PK 冲突 → 整体回滚
      });
    } catch { rolled = true; }
    if (!rolled) throw new Error("duplicate insert should throw");
    const { rows } = await mgr.runQuery(MYSQL_ID, `SELECT COUNT(*) AS n FROM ${PROBE_DB}.tx_probe`);
    if (num(rows[0].n) !== 2) throw new Error("rollback failed, count=" + rows[0].n);
  });

  /* ⑨ export/import 全链路（工具层，stdio spawn → 守卫 → 连接池 → MySQL → 落盘/参数化写入） */
  const callQuery = async (sql) => parseToolResult(await srv.rpc("tools/call", { name: "query", arguments: { source: MYSQL_ID, sql, max_rows: 50 } }));
  await checkAsync("export: SELECT 导出 CSV（行数/字节/耗时字段 + 落盘内容核对）", async () => {
    const r = parseToolResult(await srv.rpc("tools/call", {
      name: "export_data",
      arguments: { source: MYSQL_ID, sql: "SELECT id, v, tag FROM " + PROBE_TABLE + " WHERE id < 20 ORDER BY id", filename: "hist_export.csv" },
    }));
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const d = r.data;
    if (num(d.row_count) !== 20 || num(d.bytes) <= 0 || num(d.duration_ms) < 0) throw new Error(JSON.stringify(d));
    const csv = fs.readFileSync(path.join(exportDir, "hist_export.csv"), "utf8").trim().split(/\r?\n/);
    if (csv.length !== 21 || csv[0] !== "id,v,tag" || csv[1] !== "0,0,a") throw new Error("csv content: " + csv.slice(0, 3).join(" | "));
  });
  await checkAsync("export: 同名拒覆盖 → overwrite:true 原子替换（writeFileAtomic 真实链路）", async () => {
    const r1 = parseToolResult(await srv.rpc("tools/call", {
      name: "export_data",
      arguments: { source: MYSQL_ID, sql: "SELECT id, v, tag FROM " + PROBE_TABLE + " WHERE id < 5 ORDER BY id", filename: "hist_export.csv" },
    }));
    if (!r1.isError || !/已存在/.test(r1.text)) throw new Error("must refuse overwrite: " + r1.text.slice(0, 160));
    const r2 = parseToolResult(await srv.rpc("tools/call", {
      name: "export_data",
      arguments: { source: MYSQL_ID, sql: "SELECT id, v, tag FROM " + PROBE_TABLE + " WHERE id < 5 ORDER BY id", filename: "hist_export.csv", overwrite: true },
    }));
    if (r2.isError) throw new Error("overwrite:true must succeed: " + r2.text.slice(0, 160));
    const csv = fs.readFileSync(path.join(exportDir, "hist_export.csv"), "utf8").trim().split(/\r?\n/);
    if (csv.length !== 6) throw new Error("replaced content should have 5 rows, got " + csv.length);
  });
  await checkAsync("export: CSV 行集流式与 JSON 物化再格式化逐字节恒等 + limit 截断边界（v1.6.32）", async () => {
    // 平凡列（id,v 全数字）独立重排 CSV 与流式导出逐字节比对——不借产品侧 csvCell 之手
    const sql = "SELECT id, v FROM " + PROBE_TABLE + " WHERE id < 5 ORDER BY id";
    const rj = parseToolResult(await srv.rpc("tools/call", {
      name: "export_data", arguments: { source: MYSQL_ID, sql, format: "json", filename: "stream_ref.json", overwrite: true },
    }));
    if (rj.isError) throw new Error(rj.text.slice(0, 200));
    const rows = JSON.parse(fs.readFileSync(path.join(exportDir, "stream_ref.json"), "utf8")).rows || [];
    const rc = parseToolResult(await srv.rpc("tools/call", {
      name: "export_data", arguments: { source: MYSQL_ID, sql, format: "csv", filename: "stream_cmp.csv", overwrite: true },
    }));
    if (rc.isError) throw new Error(rc.text.slice(0, 200));
    const d = rc.data;
    if (num(d.row_count) !== 5 || d.truncated !== false) throw new Error("csv meta: " + JSON.stringify(d));
    if (!("formula_cells_neutralized" in d)) throw new Error("csv response must carry formula_cells_neutralized");
    const want = "id,v\r\n" + rows.map((r) => r.id + "," + r.v).join("\r\n") + "\r\n";
    const got = fs.readFileSync(path.join(exportDir, "stream_cmp.csv"), "utf8");
    if (got !== want) {
      throw new Error("stream csv bytes diverge: " + JSON.stringify(got.slice(0, 120)) + " vs " + JSON.stringify(want.slice(0, 120)));
    }
    // 截断边界：数据足量 limit=2 → truncated=true 且只落 2 行（流式第 limit+1 行停消费）
    const rt = parseToolResult(await srv.rpc("tools/call", {
      name: "export_data", arguments: { source: MYSQL_ID, sql: "SELECT id, v FROM " + PROBE_TABLE + " ORDER BY id", limit: 2, format: "csv", filename: "stream_cut.csv", overwrite: true },
    }));
    if (rt.isError) throw new Error(rt.text.slice(0, 200));
    const cut = fs.readFileSync(path.join(exportDir, "stream_cut.csv"), "utf8").trim().split(/\r?\n/);
    if (num(rt.data.row_count) !== 2 || rt.data.truncated !== true || cut.length !== 3) {
      throw new Error("truncation: rows=" + rt.data.row_count + " truncated=" + rt.data.truncated + " lines=" + cut.length);
    }
    // 恰好等量不误报截断
    const rx = parseToolResult(await srv.rpc("tools/call", {
      name: "export_data", arguments: { source: MYSQL_ID, sql: "SELECT id, v FROM " + PROBE_TABLE + " WHERE id < 2 ORDER BY id", limit: 2, format: "csv", filename: "stream_exact.csv", overwrite: true },
    }));
    if (rx.isError || num(rx.data.row_count) !== 2 || rx.data.truncated !== false) {
      throw new Error("exact-limit: " + rx.text.slice(0, 160));
    }
  });
  await checkAsync("import: CSV 导入目标表（参数化 INSERT，rows_imported=5）", async () => {
    // import 白名单目录独立（DBMCP_IMPORT_DIR 设置后不回退 export 目录）——模拟文件投递到导入目录
    fs.copyFileSync(path.join(exportDir, "hist_export.csv"), path.join(importDir, "hist_export.csv"));
    const r = parseToolResult(await srv.rpc("tools/call", {
      name: "import_data",
      arguments: { source: MYSQL_ID, table: IMPORT_TABLE, filename: "hist_export.csv" },
    }));
    if (r.isError) throw new Error(r.text.slice(0, 200));
    if (num(r.data.rows_imported) !== 5) throw new Error(JSON.stringify(r.data));
    const q = await callQuery("SELECT COUNT(*) AS n FROM " + IMPORT_TABLE);
    if (q.isError || num(q.data.rows[0].n) !== 5) throw new Error("count after import: " + q.text.slice(0, 160));
  });
  await checkAsync("import: atomic 冲突整体回滚（行数不变）；非 atomic 保留已写入行", async () => {
    const bad = "id,v,tag\n100,1,a\n101,2,b\n100,3,c\n";
    fs.writeFileSync(path.join(importDir, "bad.csv"), bad);
    const r1 = parseToolResult(await srv.rpc("tools/call", {
      name: "import_data",
      arguments: { source: MYSQL_ID, table: IMPORT_TABLE, filename: "bad.csv", atomic: true },
    }));
    if (!r1.isError || !/原子导入失败|已全部回滚/.test(r1.text)) throw new Error("atomic must roll back: " + r1.text.slice(0, 160));
    let q = await callQuery("SELECT COUNT(*) AS n FROM " + IMPORT_TABLE);
    if (q.isError || num(q.data.rows[0].n) !== 5) throw new Error("atomic rollback leaked rows: " + q.text.slice(0, 160));
    const r2 = parseToolResult(await srv.rpc("tools/call", {
      name: "import_data",
      arguments: { source: MYSQL_ID, table: IMPORT_TABLE, filename: "bad.csv" },
    }));
    if (!r2.isError || !/第 3 行导入失败/.test(r2.text)) throw new Error("non-atomic should pinpoint row 3: " + r2.text.slice(0, 160));
    q = await callQuery("SELECT COUNT(*) AS n FROM " + IMPORT_TABLE);
    if (q.isError || num(q.data.rows[0].n) !== 7) throw new Error("non-atomic should keep 2 good rows (total 7): " + q.text.slice(0, 160));
  });

  /* ⑩ 全工具面钉测（v1.6.2）：元数据发现类 + query/query_plan/count/distinct/sample + execute/create_table
        ——这些工具此前只在 sqlite-validate 与纯函数契约里验证过，真实 MySQL 的信息架构查询
        （information_schema 占位符形态、fkSql 三占位符、EXPLAIN FORMAT=JSON）从未端到端执行过 */
  const call = async (name, args) => parseToolResult(await srv.rpc("tools/call", { name, arguments: { source: MYSQL_ID, ...args } }));

  await checkAsync("list_tables: 探针库 name_like 过滤出 3 张 hist_ 表", async () => {
    const r = await call("list_tables", { schema: PROBE_DB, name_like: "hist_" });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const d = r.data;
    if (num(d.table_count) !== 3) throw new Error("table_count=" + d.table_count + " " + JSON.stringify(d.tables).slice(0, 200));
    const names = d.tables.map((t) => String(t.name ?? "")).sort().join(",");
    if (names !== "hist_child,hist_import,hist_probe") throw new Error("names=" + names);
  });
  await checkAsync("describe_table: hist_probe 列序 id,v,vn,tag + id 主键 + 索引", async () => {
    const r = await call("describe_table", { table: "hist_probe", schema: PROBE_DB });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const d = r.data;
    const names = d.columns.map((c) => c.name).join(",");
    if (names !== "id,v,vn,tag") throw new Error("columns=" + names);
    if (!Array.isArray(d.primary_key) || !d.primary_key.includes("id")) throw new Error("pk=" + JSON.stringify(d.primary_key));
  });
  await checkAsync("find_tables_by_column: 'tag' 命中 2 表；'vn' 仅 hist_probe", async () => {
    const r1 = await call("find_tables_by_column", { column: "tag", schema: PROBE_DB });
    if (r1.isError) throw new Error(r1.text.slice(0, 200));
    const t1 = String(r1.data.tables.join(","));
    if (!/hist_probe/.test(t1) || !/hist_import/.test(t1)) throw new Error("tag tables=" + t1);
    const r2 = await call("find_tables_by_column", { column: "vn", schema: PROBE_DB });
    if (r2.isError) throw new Error(r2.text.slice(0, 200));
    if (r2.data.tables.join(",") !== "hist_probe") throw new Error("vn tables=" + r2.data.tables.join(","));
  });
  await checkAsync("fk_relationships: hist_child.pid -> hist_probe.id（单表与全库两种查法）", async () => {
    const r1 = await call("fk_relationships", { table: "hist_child", schema: PROBE_DB });
    if (r1.isError) throw new Error(r1.text.slice(0, 200));
    const rel1 = r1.data.relationships.join(" | ");
    if (!/hist_child\.pid -> hist_probe\.id/.test(rel1)) throw new Error("rel=" + rel1);
    const r2 = await call("fk_relationships", { schema: PROBE_DB });
    if (r2.isError) throw new Error(r2.text.slice(0, 200));
    if (!/hist_child\.pid -> hist_probe\.id/.test(r2.data.relationships.join(" | "))) {
      throw new Error("schema-wide rel=" + JSON.stringify(r2.data.relationships));
    }
  });

  await checkAsync("count_rows: 全表 100 / where v<50 → 50", async () => {
    const r1 = await call("count_rows", { table: PROBE_TABLE });
    if (r1.isError || num(r1.data.total) !== 100) throw new Error(r1.text.slice(0, 160));
    const r2 = await call("count_rows", { table: PROBE_TABLE, where: "v < 50" });
    if (r2.isError || num(r2.data.total) !== 50) throw new Error(r2.text.slice(0, 160));
  });
  await checkAsync("distinct_values: tag 三值分布 a:50 b:30 c:20 + distinct_total=3", async () => {
    const r = await call("distinct_values", { table: PROBE_TABLE, column: "tag" });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const d = r.data;
    if (num(d.distinct_total) !== 3) throw new Error("distinct_total=" + d.distinct_total);
    const v = d.values;
    if (v.length !== 3 || v[0].value !== "a" || num(v[0].cnt) !== 50 || v[1].value !== "b" || num(v[1].cnt) !== 30 || v[2].value !== "c" || num(v[2].cnt) !== 20) {
      throw new Error(JSON.stringify(v));
    }
  });
  await checkAsync("sample_data: where + order_by DESC 取最新；非法 order_by 报错", async () => {
    const r = await call("sample_data", { table: PROBE_TABLE, where: "id < 3", order_by: "id DESC", limit: 5 });
    if (r.isError) throw new Error(r.text.slice(0, 200));
    const ids = r.data.rows.map((x) => num(x.id)).join(",");
    if (ids !== "2,1,0") throw new Error("ids=" + ids);
    const bad = await call("sample_data", { table: PROBE_TABLE, order_by: "id; DROP TABLE x" });
    if (!bad.isError) throw new Error("bad order_by must error");
  });
  await checkAsync("query: 自动 LIMIT 截断 + 括号复合 UNION 真实执行 + SHOW 放行", async () => {
    const r1 = await callQuery("SELECT id FROM " + PROBE_TABLE + " ORDER BY id");
    if (r1.isError) throw new Error(r1.text.slice(0, 160));
    if (num(r1.data.row_count) !== 50 || r1.data.truncated !== true) {
      throw new Error("limit wrap: row_count=" + r1.data.row_count + " truncated=" + r1.data.truncated);
    }
    // 括号复合（v1.2.1 修复路径：不包外层 LIMIT，执行后截断兜底）
    const r2 = await callQuery("(SELECT id FROM " + PROBE_TABLE + " WHERE id < 3) UNION (SELECT id FROM " + PROBE_TABLE + " WHERE id > 96)");
    if (r2.isError) throw new Error(r2.text.slice(0, 160));
    if (num(r2.data.row_count) !== 6) throw new Error("union rows=" + r2.data.row_count);
    const r3 = await callQuery("SHOW TABLES FROM " + PROBE_DB);
    if (r3.isError) throw new Error(r3.text.slice(0, 160));
    if (num(r3.data.row_count) < 3) throw new Error("show rows=" + r3.data.row_count);
  });
  await checkAsync("query_plan: text/json 双格式计划 + EXPLAIN 写语句拒绝", async () => {
    const r1 = await call("query_plan", { sql: "SELECT id FROM " + PROBE_TABLE + " WHERE id = 1", format: "text" });
    if (r1.isError || !Array.isArray(r1.data.plan) || !r1.data.plan.length) throw new Error(r1.text.slice(0, 200));
    const r2 = await call("query_plan", { sql: "SELECT id FROM " + PROBE_TABLE + " WHERE id = 1", format: "json" });
    if (r2.isError || !r2.data.plan.length) throw new Error(r2.text.slice(0, 200));
    const r3 = await call("query_plan", { sql: "UPDATE " + PROBE_TABLE + " SET v = 0 WHERE id = 1" });
    if (!r3.isError) throw new Error("EXPLAIN UPDATE must be refused");
  });

  await checkAsync("execute: INSERT/UPDATE/DELETE 真实写 + affected_rows 回报", async () => {
    const r1 = await call("execute", { sql: "INSERT INTO " + IMPORT_TABLE + " (id, v, tag) VALUES (200, 1, 'z')" });
    if (r1.isError || num(r1.data.affected_rows) !== 1) throw new Error(r1.text.slice(0, 160));
    const r2 = await call("execute", { sql: "UPDATE " + IMPORT_TABLE + " SET v = 2 WHERE id = 200" });
    if (r2.isError || num(r2.data.affected_rows) !== 1) throw new Error(r2.text.slice(0, 160));
    const r3 = await call("execute", { sql: "DELETE FROM " + IMPORT_TABLE + " WHERE id = 200" });
    if (r3.isError || num(r3.data.affected_rows) !== 1) throw new Error(r3.text.slice(0, 160));
  });
  await checkAsync("execute: 无 WHERE / 恒真 WHERE 红线拒绝（真实库零副作用核对）", async () => {
    const r1 = await call("execute", { sql: "DELETE FROM " + IMPORT_TABLE });
    if (!r1.isError) throw new Error("no-WHERE DELETE must be refused");
    const r2 = await call("execute", { sql: "UPDATE " + IMPORT_TABLE + " SET v = 0 WHERE 1 = 1" });
    if (!r2.isError) throw new Error("WHERE 1=1 must be refused");
    const q = await callQuery("SELECT COUNT(*) AS n FROM " + IMPORT_TABLE);
    if (num(q.data.rows[0].n) !== 7) throw new Error("red-line leaked side effect! count=" + q.data.rows[0].n);
  });
  await checkAsync("create_table: 建表成功 + CTAS 拒绝", async () => {
    const r1 = await call("create_table", { sql: "CREATE TABLE " + PROBE_DB + ".ct_probe (id INT PRIMARY KEY, name VARCHAR(8))" });
    if (r1.isError) throw new Error(r1.text.slice(0, 160));
    const r2 = await call("create_table", { sql: "CREATE TABLE " + PROBE_DB + ".ct_copy AS SELECT * FROM " + IMPORT_TABLE });
    if (!r2.isError) throw new Error("CTAS must be refused");
  });

  /* ⑪ 清理：DROP DATABASE + 验证不可见 */
  await checkAsync("cleanup: DROP 探针库并验证已不存在", async () => {
    await mgr.runQuery(MYSQL_ID, `DROP DATABASE ${PROBE_DB}`);
    let gone = false;
    try { await mgr.runQuery(MYSQL_ID, `SELECT COUNT(*) AS n FROM ${PROBE_TABLE}`); }
    catch { gone = true; }
    if (!gone) throw new Error("probe table still queryable after DROP DATABASE");
  });
} catch (e) {
  fail++;
  console.log("FAIL suite-setup - " + (e && e.message ? e.message : e));
} finally {
  if (srv) { try { srv.child.stdin.end(); } catch { /* ignore */ } setTimeout(() => { try { srv.child.kill(); } catch { /* ignore */ } }, 200).unref?.(); }
  // 兜底清理：套件中途失败也不在真实库里留测试对象
  try {
    if (fail > 0) await mgr.runQuery(MYSQL_ID, `DROP DATABASE IF EXISTS ${PROBE_DB}`);
  } catch { /* 连接本身失败时无从清理 */ }
  try { fs.rmSync(tmpCfgFile, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(ioRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n=== mysql-validate: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""} ===`);
  process.exit(fail > 0 ? 1 : 0);
}
