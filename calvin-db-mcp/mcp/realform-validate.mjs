/**
 * realform-validate.mjs — 真实形态验证（v1.6.11 由开发期真实测试台转正入包）
 *
 * 与 selftest（纯函数/协议钉）互补：本套件走**真实形态**——真实 SQLite 文件库（中文表/列名 +
 * 业务边界数据）+ 真实 stdio 子进程 JSON-RPC 全链路，覆盖发现/读链/导出导入回环/写与红线/注入负例。
 * 动机：V1.6.8 实测证明「自测全绿 ≠ 真实形态可用」（ASCII 校验正则拒中文标识符等 3 个产品 bug
 * 均由真实形态测试抓获），故将该测试台转正为随包回归资产，每次发版门禁必跑。
 *
 * 运行: node realform-validate.mjs（fixture 全自供给：mkdtemp 临时目录自建自删，不触碰部署配置与业务库）
 * 退出码: 0=全绿；1=有失败（保留现场目录并打印 FAILDETAIL）；3=无 node:sqlite 的诚实 SKIP（Node < 22.5）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.log("SKIP realform-validate: 当前 Node 无 node:sqlite（需 Node >= 22.5）");
  process.exit(3);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-realform-"));
const dbFile = path.join(work, "业务库.db"); // 真实中文文件名
const cfgFile = path.join(work, "dbmcp.config.json");
const exportDir = path.join(work, "export");
const importDir = path.join(work, "import");
fs.mkdirSync(exportDir); fs.mkdirSync(importDir);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; failures.push(name + " :: " + String(detail || "").slice(0, 200)); console.log("FAIL " + name + " - " + String(detail || "").slice(0, 160)); }
}

// ---------- 1. 建真实库（node:sqlite） ----------
const db = new DatabaseSync(dbFile);
db.exec(`
  CREATE TABLE 订单表 (
    订单号 TEXT PRIMARY KEY,
    状态 TEXT,
    金额 REAL,
    创建时间 TEXT,
    备注 TEXT
  );
  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY,
    订单号 TEXT REFERENCES 订单表(订单号),
    sku TEXT,
    qty INTEGER,
    price DECIMAL(10,2)
  );
  CREATE TABLE edge_data (
    id INTEGER PRIMARY KEY,
    big INTEGER,
    txt TEXT,
    blob_col BLOB,
    nul TEXT
  );
  CREATE TABLE empty_table (id INTEGER PRIMARY KEY, v TEXT);
  CREATE TABLE 导入副本 (订单号 TEXT PRIMARY KEY, 备注 TEXT);
  CREATE TABLE CRLF回环 (id INTEGER PRIMARY KEY, txt TEXT);
  CREATE VIEW v_订单 AS SELECT 订单号, 状态 FROM 订单表;
`);
const ins = db.prepare("INSERT INTO 订单表 VALUES (?,?,?,?,?)");
ins.run("D001", "SENT", 12.5, "2026-01-01 10:00:00", "含\"引号\"与'单引号'");
ins.run("D002", "DRAFT", 0.3, "2026-01-02 11:30:00", "=1+1");
ins.run("D003", null, 9999999.99, "2026-01-03 08:00:00", "emoji 🚀 与换行\n第二行");
const ins2 = db.prepare("INSERT INTO order_items VALUES (?,?,?,?,?)");
ins2.run(1, "D001", "SKU-1", 2, 6.25);
ins2.run(2, "D002", "SKU-2", 1000000, 0.01);
const ins3 = db.prepare("INSERT INTO edge_data VALUES (?,?,?,?,?)");
ins3.run(1, 9007199254740993n, "long".repeat(500), Buffer.from([0, 1, 2, 255]), null);
ins3.run(2, -1, "CRLF\r\nend", Buffer.alloc(0), "x");
db.close();

// ---------- 2. 配置（中文源 id + 写开关；全部落在临时目录） ----------
fs.writeFileSync(cfgFile, JSON.stringify({
  allowWrites: true,
  allowCreateTable: true,
  maxRows: 200, timeoutMs: 30000, maxAffectedRows: 500,
  exportDir, importDir,
  sources: {
    业务库: { type: "sqlite", file: dbFile, description: "真实业务形态库" },
  },
}), "utf8");

// ---------- 3. 真 stdio 客户端 ----------
const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
  env: { ...process.env, DBMCP_CONFIG: cfgFile, DBMCP_EXPORT_DIR: exportDir, DBMCP_IMPORT_DIR: exportDir },
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch { /* 噪声行静默（协议层另有专测） */ }
  }
});
let nextId = 1;
function rpc(method, params) {
  return new Promise((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); rej(new Error("rpc timeout: " + method)); }, 30000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
  return { text, isError: !!r.result?.isError, raw: r };
}

// ---------- 4. 真实场景矩阵（26 项 + v1.6.13 对抗回归 14 项 + v1.6.16 BLOB 序列化 3 项 = 43 项） ----------
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
check("initialize 握手", init.result?.serverInfo?.version != null, JSON.stringify(init).slice(0, 120));

const ls = await call("list_sources", {});
check("list_sources 列出中文源", ls.text.includes("业务库") && !ls.isError, ls.text.slice(0, 140));

// —— 发现面 ——
const lt = await call("list_tables", { source: "业务库" });
check("list_tables 含中文表/视图/ASCII 表", lt.text.includes("订单表") && lt.text.includes("order_items") && lt.text.includes("v_订单"), lt.text.slice(0, 200));

const dt = await call("describe_table", { source: "业务库", table: "订单表" });
check("describe_table 中文表名", !dt.isError && dt.text.includes("订单号"), dt.text.slice(0, 180));

const ft = await call("find_tables_by_column", { source: "业务库", column: "订单号" });
check("find_tables_by_column 中文列名", !ft.isError && ft.text.includes("订单表"), ft.text.slice(0, 180));

const fk = await call("fk_relationships", { source: "业务库" });
check("fk_relationships 跨表", !fk.isError, fk.text.slice(0, 180));

// —— 读面 ——
const q = await call("query", { source: "业务库", sql: "SELECT 订单号, 状态, 金额 FROM 订单表 ORDER BY 创建时间 DESC" });
check("query 中文列 SELECT", !q.isError && q.text.includes("D001"), q.text.slice(0, 200));

const qp = await call("query_plan", { source: "业务库", sql: "SELECT * FROM 订单表 WHERE 状态 = 'SENT'" });
check("query_plan 中文表", !qp.isError, qp.text.slice(0, 160));

const sd = await call("sample_data", { source: "业务库", table: "订单表", where: "状态 = 'SENT'", order_by: "创建时间 DESC" });
check("sample_data 中文表+where+order_by", !sd.isError && sd.text.includes("D001"), sd.text.slice(0, 200));

const dv = await call("distinct_values", { source: "业务库", table: "订单表", column: "状态" });
check("distinct_values 中文列", !dv.isError, dv.text.slice(0, 200));

const cs = await call("column_stats", { source: "业务库", table: "订单表", column: "金额" });
check("column_stats 中文表", !cs.isError, cs.text.slice(0, 160));

const cr = await call("count_rows", { source: "业务库", table: "订单表", where: "状态 IS NOT NULL" });
check("count_rows 中文表+where", !cr.isError, cr.text.slice(0, 160));

// —— 边界数据 ——
const edge = await call("query", { source: "业务库", sql: "SELECT id, big, txt, nul FROM edge_data" });
check("大整数 9007199254740993 精度", edge.text.includes("9007199254740993"), edge.text.slice(0, 240));
check("NULL 与空串呈现", !edge.isError, edge.text.slice(0, 240));

const emoji = await call("query", { source: "业务库", sql: "SELECT 备注 FROM 订单表 WHERE 订单号='D003'" });
check("emoji/换行文本保真", emoji.text.includes("🚀"), emoji.text.slice(0, 200));

// —— 导出/导入回环（公式中和）——
const ex = await call("export_data", { source: "业务库", sql: "SELECT 订单号, 备注 FROM 订单表", format: "csv", filename: "订单.csv" });
check("export_data 中文列 CSV", !ex.isError, ex.text.slice(0, 200));
const csvPath = path.join(exportDir, "订单.csv");
const csv = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, "utf8") : "";
check("CSV 公式中和（=1+1 加引号前缀）", csv.includes("'=1+1"), (fs.existsSync(csvPath) ? csv.slice(0, 200) : "导出文件未生成: " + ex.text.slice(0, 160)));

const im = await call("import_data", { source: "业务库", table: "导入副本", filename: "订单.csv", strip_neutralization: true, atomic: true });
check("import_data 中文 CSV 回环", !im.isError && /导入|写入|inserted|rows|成功/i.test(im.text), im.text.slice(0, 200));
const rt = await call("query", { source: "业务库", sql: "SELECT 备注 FROM 导入副本 WHERE 订单号='D002'" });
check("回环保真：=1+1 原样还原（strip_neutralization）", rt.text.includes("=1+1") && !rt.text.includes("'=1+1"), rt.text.slice(0, 200));

// —— 写面（真实写 + 红线）——
const ex1 = await call("execute", { source: "业务库", sql: "UPDATE 订单表 SET 备注='realtest' WHERE 订单号='D001'" });
check("execute 中文表 UPDATE", !ex1.isError, ex1.text.slice(0, 160));
const red1 = await call("execute", { source: "业务库", sql: "UPDATE 订单表 SET 状态='X'" });
check("红线：无 WHERE UPDATE 拒绝", red1.isError && red1.text.includes("安全红线"), red1.text.slice(0, 160));
const red2 = await call("query", { source: "业务库", sql: "SELECT 1; DROP TABLE 订单表" });
check("红线：多语句拒绝", red2.isError, red2.text.slice(0, 160));

const ct = await call("create_table", { source: "业务库", sql: "CREATE TABLE 测试表 (id INTEGER PRIMARY KEY, 名称 TEXT)" });
check("create_table 中文表名", !ct.isError, ct.text.slice(0, 160));

// —— 注入面（改后仍须拒绝）——
const inj1 = await call("describe_table", { source: "业务库", table: 'a"; DROP TABLE 订单表; --' });
check("注入表名仍拒绝", inj1.isError, inj1.text.slice(0, 160));
const inj2 = await call("execute", { source: "业务库", sql: "UPDATE 订单表 SET 状态='X' WHERE 1=1 OR 1=1" });
check("红线：恒真 WHERE/OR 分支 UPDATE 仍拒绝", inj2.isError && inj2.text.includes("安全红线"), inj2.text.slice(0, 160));
const inj3 = await call("count_rows", { source: "业务库", table: "订单表", where: "1=1 OR 1=1" });
check("只读侧恒真 WHERE 合法放行（设计语义）", !inj3.isError && inj3.text.includes("3"), inj3.text.slice(0, 160));

// ---------- 5. 真实对抗回归（v1.6.13 测试台抓获缺陷的常驻钉）----------
// —— 复制粘贴不可见字符（ZWSP 等 Unicode Cf 前导，聊天/网页/Excel 复制常态）——
const zwq = await call("query", { source: "业务库", sql: "​SELECT 订单号 FROM 订单表 WHERE 订单号='D001'" });
check("前导 ZWSP 的 SELECT 可执行（复制粘贴形态）", !zwq.isError && zwq.text.includes("D001"), zwq.text.slice(0, 180));
const zwx = await call("execute", { source: "业务库", sql: "​UPDATE 订单表 SET 状态='X'" });
check("红线不因剥除失效：前导 ZWSP 无 WHERE UPDATE 仍拒", zwx.isError && /安全红线/.test(zwx.text), zwx.text.slice(0, 160));

// —— Windows 文件名边界（保留设备名 / 超长截断 / 扩展名大小写 / 尾点归一）——
const rsv = await call("export_data", { source: "业务库", sql: "SELECT 1 AS x", format: "csv", filename: "NUL" });
check("保留设备名 NUL 导出拒绝（防设备命名空间怪文件）", rsv.isError && /保留/.test(rsv.text) && !fs.existsSync(path.join(exportDir, "NUL.csv")), rsv.text.slice(0, 160));
const rsv2 = await call("export_data", { source: "业务库", sql: "SELECT 1 AS x", format: "csv", filename: "COM10" });
check("非保留名 COM10 不误伤", !rsv2.isError && fs.existsSync(path.join(exportDir, "COM10.csv")), rsv2.text.slice(0, 160));
const lng = await call("export_data", { source: "业务库", sql: "SELECT 1 AS x", format: "csv", filename: "a".repeat(118) });
const lngFile = path.basename(JSON.parse(lng.text).file || "");
check("超长文件名截断保扩展名（118 基名 → 116+.csv）", !lng.isError && lngFile === "a".repeat(116) + ".csv", "got=" + lngFile);
const upc = await call("export_data", { source: "业务库", sql: "SELECT 1 AS x", format: "csv", filename: "T.CSV" });
check("大写扩展名不重复追加（T.CSV 非 T.CSV.csv）", !upc.isError && fs.existsSync(path.join(exportDir, "T.CSV")) && !fs.existsSync(path.join(exportDir, "T.CSV.csv")), upc.text.slice(0, 160));
const tdt = await call("export_data", { source: "业务库", sql: "SELECT 1 AS x", format: "csv", filename: "tt.csv." });
check("尾点文件名归一（tt.csv.→tt.csv）", !tdt.isError && fs.existsSync(path.join(exportDir, "tt.csv")), tdt.text.slice(0, 160));
fs.writeFileSync(path.join(exportDir, "d1.csv"), "id,txt\n9,z\n", "utf8");
const tdi = await call("import_data", { source: "业务库", table: "CRLF回环", filename: "d1.csv." });
check("import 尾点寻址归一（d1.csv. 读到 d1.csv）", !tdi.isError, tdi.text.slice(0, 160));

// —— CSV 真实形态（引号内 CRLF 保真 / 表头语义）——
const cexp = await call("export_data", { source: "业务库", sql: "SELECT id, txt FROM edge_data WHERE id=2", format: "csv", filename: "crlf.csv", raw_formulas: false });
check("导出含 CRLF 单元格", !cexp.isError, cexp.text.slice(0, 160));
const cim = await call("import_data", { source: "业务库", table: "CRLF回环", filename: "crlf.csv", strip_neutralization: true });
const cval = await call("query", { source: "业务库", sql: "SELECT txt FROM CRLF回环 WHERE id=2" });
check("引号内 CRLF 导出→导入回环保真（不压平成 LF）", !cim.isError && (cval.text.includes("CRLF\\r\\nend") || cval.text.includes("CRLF\r\nend")), cim.text.slice(0, 120) + " | " + cval.text.slice(0, 160));
fs.writeFileSync(path.join(exportDir, "hdr_empty.csv"), "a,b,\n1,2,3\n", "utf8");
const he = await call("import_data", { source: "业务库", table: "CRLF回环", filename: "hdr_empty.csv" });
check("空表头列名给出明确错误（提到表头/列名）", he.isError && /表头|列名/.test(he.text), he.text.slice(0, 180));
fs.writeFileSync(path.join(exportDir, "hdr_dup.csv"), "a,a\n1,2\n", "utf8");
const hd = await call("import_data", { source: "业务库", table: "CRLF回环", filename: "hdr_dup.csv" });
check("重名表头明确拒绝（防 INSERT 重名列静默丢值）", hd.isError && /重复/.test(hd.text), hd.text.slice(0, 180));

// —— 行数截断边界 ——
const lim = JSON.parse((await call("query", { source: "业务库", sql: "SELECT 订单号 FROM 订单表", max_rows: 2 })).text);
check("行数边界：max_rows=2 截断（truncated=true，2 行）", lim.row_count === 2 && lim.truncated === true, JSON.stringify(lim).slice(0, 140));
const lim2 = JSON.parse((await call("query", { source: "业务库", sql: "SELECT 订单号 FROM 订单表", max_rows: 3 })).text);
check("行数边界：max_rows=3 恰满不截断（truncated=false，3 行）", lim2.row_count === 3 && lim2.truncated === false, JSON.stringify(lim2).slice(0, 140));

// —— BLOB 序列化（v1.6.16 对抗台抓获：node:sqlite 返回 Uint8Array 未走 hex 分支，
//    JSON 序列化成 {"0":..} 键值垃圾、CSV 掉 String(v) 成 "0,1,2,255"）——
const bqq = await call("query", { source: "业务库", sql: "SELECT blob_col FROM edge_data WHERE id=1" });
check("BLOB 查询 → <binary 4 bytes: hex> 契约形状（非键值垃圾）", !bqq.isError && bqq.text.includes("<binary 4 bytes: 000102ff>") && !bqq.text.includes('{"0"'), bqq.text.slice(0, 180));
const bje = await call("export_data", { source: "业务库", sql: "SELECT blob_col FROM edge_data WHERE id=1", format: "json", filename: "blob.json" });
const bjrow = (() => { const p = JSON.parse(fs.readFileSync(path.join(exportDir, "blob.json"), "utf8")); return Array.isArray(p) ? p[0] : p.rows[0]; })();
check("导出 JSON BLOB → 全量 hex 000102ff", !bje.isError && bjrow.blob_col === "000102ff", bje.text.slice(0, 120) + " | " + JSON.stringify(bjrow));
const bce = await call("export_data", { source: "业务库", sql: "SELECT blob_col FROM edge_data WHERE id=1", format: "csv", filename: "blob.csv" });
const bcs = fs.readFileSync(path.join(exportDir, "blob.csv"), "utf8");
check("导出 CSV BLOB → 确定性 hex（非 '0,1,2,255' 垃圾）", !bce.isError && bcs.includes("000102ff") && !bcs.includes("0,1,2,255"), bcs.slice(0, 120));

// ---------- 6. 汇总 ----------
child.kill();
console.log(`\n=== realform-validate: ${pass} passed, ${fail} failed ===`);
if (fail) {
  console.log("保留现场: " + work);
  for (const f of failures) console.log("  FAILDETAIL " + f);
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 300)); // 等 server 进程释放 SQLite 句柄再删（Windows EPERM 竞态）
try {
  fs.rmSync(work, { recursive: true, force: true });
} catch {
  // 清理仍失败（句柄未释放/杀软占用）不影响测试结论
  console.log("（清理临时目录失败，可手动删除: " + work + "）");
}
process.exit(0);
