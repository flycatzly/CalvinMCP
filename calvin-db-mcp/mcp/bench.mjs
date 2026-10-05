/**
 * bench.mjs — import_data 导入基准（V1.6.21 收编自 _dist/bench_na.mjs：可重复、输出 JSON）
 *
 * 测量「万行 CSV 非事务导入」的两段耗时：
 *   duration_ms = 服务端 doImportData 写循环（工具响应里的 duration_ms）
 *   e2e_ms      = 客户端视角整次 tools/call 往返（含 RPC/解析/校验）
 *
 * 可重复性：每轮 DROP+CREATE 公共中间表（默认 bench_na，与 cleanup_bench.mjs 清扫名单一致），
 * 每源先跑一次 SELECT 1 预热连接池（排除建连噪声），N 轮取 median/min/max。
 *
 * 凭据纪律：脚本零明文口令——连接串与 server.mjs 同源（dbmcp.config.json 的 enc 字段经
 * crypt2.decryptAny 解密，仅驻内存），不读 _secrets.json、不落日志。
 *
 * 运行: node bench.mjs   （需本目录 node_modules：mysql2/pg）
 * 可选环境变量:
 *   DBMCP_BENCH_ROWS=10000        数据行数（含表头 1 行）
 *   DBMCP_BENCH_ROUNDS=3          轮数（每轮重置表后完整导入一次）
 *   DBMCP_BENCH_SOURCES=real_mysql,real_pg,real_sqlite
 *   DBMCP_BENCH_ATOMIC=1         基准 atomic: true 全文件单事务路径（默认非事务）
 *   DBMCP_BENCH_TABLE=bench_na    中间表名（裸标识符）
 *   DBMCP_BENCH_IODIR=…           CSV 落盘/导入白名单目录（默认 D:/work/Zcode/DB/_dist/mcp-test）
 *   DBMCP_BENCH_OUT=…             结果 JSON 另存路径（stdout 总是打印一份）
 *   DBMCP_CONFIG=…                服务配置（默认 ./dbmcp.config.json）
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import pg from "pg";
import { decryptAny } from "./crypt2.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};

const CONFIG = process.env.DBMCP_CONFIG || path.join(here, "dbmcp.config.json");
const IODIR = process.env.DBMCP_BENCH_IODIR || "D:/work/Zcode/DB/_dist/mcp-test";
const ROWS = clampInt(process.env.DBMCP_BENCH_ROWS, 100, 1_000_000, 10000);
const ROUNDS = clampInt(process.env.DBMCP_BENCH_ROUNDS, 1, 20, 3);
const TABLE = String(process.env.DBMCP_BENCH_TABLE || "bench_na");
const SOURCES = String(process.env.DBMCP_BENCH_SOURCES || "real_mysql,real_pg,real_sqlite")
  .split(",").map((s) => s.trim()).filter(Boolean);
// v1.6.23: atomic 轮次开关——1 时 import_data 走 atomic: true（全文件单事务路径的基准）
const ATOMIC = /^(1|true|yes)$/i.test(String(process.env.DBMCP_BENCH_ATOMIC || ""));

// 本脚本自拼 DDL/查询，表名必须是裸标识符（与 server.splitIdent 同口径）
if (!/^[_\p{L}][\p{L}\p{N}_$]*$/u.test(TABLE)) {
  console.error(`[bench] 非法表名 ${JSON.stringify(TABLE)}（仅允许字母/数字/_/$）`);
  process.exit(2);
}

/* --------------------------- 源解析（与 server 同源） --------------------------- */
const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
function resolveSource(id) {
  const s = cfg.sources?.[id];
  if (!s) { console.error(`[bench] 配置缺少源 '${id}'`); process.exit(2); }
  const url = s.url || (s.enc ? decryptAny(s.enc) : null);
  return { id, type: s.type || (/^postgres/i.test(String(url || "")) ? "postgres" : /^sqlite:/i.test(String(url || "")) ? "sqlite" : "mysql"), url, file: s.file || null };
}

const DDL = {
  mysql: [`DROP TABLE IF EXISTS \`${TABLE}\``, `CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, name VARCHAR(50), city VARCHAR(20), score DECIMAL(8,1), note VARCHAR(64))`],
  postgres: [`DROP TABLE IF EXISTS "${TABLE}"`, `CREATE TABLE "${TABLE}" (id INT PRIMARY KEY, name VARCHAR(50), city VARCHAR(20), score NUMERIC(8,1), note VARCHAR(64))`],
  sqlite: [`DROP TABLE IF EXISTS "${TABLE}"`, `CREATE TABLE "${TABLE}" (id INTEGER PRIMARY KEY, name TEXT, city TEXT, score NUMERIC(8,1), note TEXT)`],
};

async function withConnection(src, fn) {
  if (src.type === "mysql") {
    const pool = mysql.createPool({ uri: src.url, connectionLimit: 1 });
    try { return await fn(pool); } finally { await pool.end(); }
  }
  if (src.type === "postgres") {
    const client = new pg.Client({ connectionString: src.url });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }
  const { DatabaseSync } = await import("node:sqlite");
  const file = src.file || String(src.url || "").replace(/^sqlite:\/\//, "");
  const sq = new DatabaseSync(file);
  try { return await fn(sq); } finally { sq.close(); }
}

async function resetTable(src) {
  await withConnection(src, async (c) => {
    for (const stmt of DDL[src.type]) {
      if (src.type === "sqlite") c.exec(stmt);
      else await c.query(stmt);
    }
  });
}

async function dropTable(src) {
  await withConnection(src, async (c) => {
    const sql = src.type === "mysql" ? `DROP TABLE IF EXISTS \`${TABLE}\`` : `DROP TABLE IF EXISTS "${TABLE}"`;
    if (src.type === "sqlite") c.exec(sql);
    else await c.query(sql);
  });
}

/* ------------------------------- CSV 生成 ------------------------------- */
const cities = ["北京", "上海", "广州", "深圳", "杭州", "成都", "武汉", "西安"];
const parts = ["id,name,city,score,note"];
for (let i = 1; i <= ROWS; i++) parts.push(`${i},用户${i},${cities[i % 8]},${(i % 1000) / 10},备注${i % 97}`);
fs.mkdirSync(IODIR, { recursive: true });
const csvName = `bench_${ROWS}.csv`;
const csvPath = path.join(IODIR, csvName);
fs.writeFileSync(csvPath, parts.join("\r\n"), "utf8");

/* --------------------------- MCP 子进程 RPC --------------------------- */
const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
  env: { ...process.env, DBMCP_CONFIG: CONFIG, DBMCP_EXPORT_DIR: IODIR, DBMCP_IMPORT_DIR: IODIR },
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p(m); }
    } catch { /* 噪声行静默 */ }
  }
});
let nextId = 1;
const rpc = (method, params, ms = 60000) => new Promise((res) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); res({ CLIENT_TIMEOUT: true }); }, ms);
  pending.set(id, (msg) => { clearTimeout(t); res(msg); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const t0 = performance.now();
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r?.result?.content?.[0]?.text ?? "";
  const isErr = r?.result?.isError === true || r?.error != null || r?.CLIENT_TIMEOUT === true;
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 文本 */ }
  return { isErr, text, data, e2e: performance.now() - t0 };
};

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

/* ------------------------------- 主循环 ------------------------------- */
const sources = SOURCES.map(resolveSource);
const stats = Object.fromEntries(sources.map((s) => [s.id, { type: s.type, duration_ms: [], e2e_ms: [], rows_imported: [], ok: true }]));

console.error(`[bench] rows=${ROWS} rounds=${ROUNDS} node=${process.version} table=${TABLE}`);
try {
  for (const src of sources) {
    await resetTable(src);
    const warm = await call("query", { source: src.id, sql: "SELECT 1 AS x" });
    if (warm.isErr) throw new Error(`预热失败 ${src.id}: ${warm.text.slice(0, 160)}`);
  }
  for (let round = 1; round <= ROUNDS; round++) {
    for (const src of sources) {
      await resetTable(src);
      const r = await call("import_data", { source: src.id, table: TABLE, filename: csvName, ...(ATOMIC ? { atomic: true } : {}) });
      const st = stats[src.id];
      const rows = Number(r.data?.rows_imported ?? NaN);
      const ok = !r.isErr && rows === ROWS;
      if (!ok) st.ok = false;
      st.duration_ms.push(Math.round(Number(r.data?.duration_ms ?? NaN)));
      st.e2e_ms.push(Math.round(r.e2e));
      st.rows_imported.push(Number.isFinite(rows) ? rows : 0);
      console.error(`[bench] round ${round}/${ROUNDS} ${src.id}: ${ok ? "ok" : "FAIL"} rows=${rows} db=${st.duration_ms.at(-1)}ms e2e=${st.e2e_ms.at(-1)}ms${ok ? "" : " | " + r.text.slice(0, 160)}`);
    }
  }
} finally {
  for (const src of sources) {
    try { await dropTable(src); } catch (e) { console.error(`[bench] 清理 ${src.id}.${TABLE} 失败: ${e.message}`); }
  }
  try { fs.unlinkSync(csvPath); } catch { /* 可能已被清理 */ }
  child.kill();
}

/* ------------------------------- 汇总输出 ------------------------------- */
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const result = {
  bench: "import_data " + (ATOMIC ? "atomic" : "non-atomic"),
  mode: ATOMIC ? "atomic" : "non-atomic",
  version: JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")).version,
  node: process.version,
  rows: ROWS,
  rounds: ROUNDS,
  table: TABLE,
  results: {},
};
let allOk = true;
for (const [id, st] of Object.entries(stats)) {
  if (!st.ok) allOk = false;
  result.results[id] = {
    type: st.type,
    rows_imported: st.rows_imported,
    duration_ms: { median: median(st.duration_ms), min: Math.min(...st.duration_ms), max: Math.max(...st.duration_ms), all: st.duration_ms },
    e2e_ms: { median: median(st.e2e_ms), min: Math.min(...st.e2e_ms), max: Math.max(...st.e2e_ms), all: st.e2e_ms },
    ok: st.ok,
  };
}
console.log(JSON.stringify(result, null, 2));
if (process.env.DBMCP_BENCH_OUT) {
  fs.writeFileSync(process.env.DBMCP_BENCH_OUT, JSON.stringify(result, null, 2), "utf8");
  console.error(`[bench] JSON 已写入 ${process.env.DBMCP_BENCH_OUT}`);
}
process.exit(allOk ? 0 : 1);
