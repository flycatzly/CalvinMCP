/**
 * sqlite-add.mjs — 向 dbmcp.config.json 添加/更新一个 SQLite 数据源（v1.2.0）
 *
 * SQLite 支持依赖 Node 内置 node:sqlite（Node >= 22.5，无需 npm 安装任何包）；
 * 数据库文件不存在时本工具会创建空库（本地安装数据库 = 建一个 .db 文件）。
 *
 * 用法:
 *   node sqlite-add.mjs <D:/path/to/file.db> [--name 源id] [--description 说明]
 *                       [--allow-writes] [--allow-create-table] [--force]
 *   --allow-writes         允许 execute 写操作（默认关闭）
 *   --allow-create-table   允许 create_table 建表（默认关闭）
 *   --force                同名源已存在时覆盖
 * 测试期可全部打开（最高权限：--allow-writes --allow-create-table）；
 * 安全红线（无 WHERE 的 UPDATE/DELETE、TRUNCATE、恒真 OR 分支）不受开关影响，始终生效。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.DBMCP_CONFIG || path.join(__dirname, "dbmcp.config.json");
const argv = process.argv.slice(2);
const dbp = argv.find((a) => !a.startsWith("--"));
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

if (!dbp) {
  console.error("用法: node sqlite-add.mjs <D:/path/to/file.db> [--name 源id] [--description 说明] [--allow-writes] [--allow-create-table] [--force]");
  process.exit(1);
}
const abs = path.resolve(dbp);

// ① 配置侧校验先于任何落盘（v1.6.1 幂等对齐）：同名冲突拒绝时不该给用户留下新建的空库文件；
//    拒绝文案与 import-dbeaver.mjs --force 口径一致。
let cfg = {};
if (fs.existsSync(cfgPath)) {
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
  catch (e) { console.error("[sqlite-add] 配置解析失败: " + e.message); process.exit(1); }
}
cfg.sources = cfg.sources || {};
if (cfg.maxRows === undefined) cfg.maxRows = 200;
if (cfg.timeoutMs === undefined) cfg.timeoutMs = 30000;
if (cfg.maxAffectedRows === undefined) cfg.maxAffectedRows = 500;

const sid = opt("--name") || "sqlite_" + (path.basename(abs, path.extname(abs)).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "db");
if (cfg.sources[sid] && !flag("--force")) {
  console.error(`[sqlite-add] 源 '${sid}' 已存在: ${cfgPath}`);
  console.error("[sqlite-add] 如需覆盖请加 --force（该源条目将被替换，建议先备份）");
  process.exit(1);
}

// ② 本地安装数据库：文件不存在则创建空库（node:sqlite 打开即建）
if (!fs.existsSync(abs)) fs.mkdirSync(path.dirname(abs), { recursive: true });
let created = false;
// v1.5.1：node:sqlite 打开是懒校验——垃圾文件 open/close 不报错，首次读页才抛 SQLITE_NOTADB，
// 故 PRAGMA 真读一次确认是 SQLite 库；打不开给出明确原因并在写配置前退出（配置不落盘）。
function openCheck(file, create) {
  let db;
  try {
    db = new DatabaseSync(file);
    db.prepare("PRAGMA schema_version").get();
    db.close();
  } catch (e) {
    try { if (db) db.close(); } catch { /* 已关闭 */ }
    if (create) { try { fs.rmSync(file, { force: true }); } catch { /* 清理失败不掩盖主错误 */ } }
    console.error(`[sqlite-add] 无法作为 SQLite 数据库打开: ${file}`);
    console.error(`  原因: ${e.message}（文件可能损坏或不是 SQLite 格式）`);
    console.error("  请换有效 .db 文件；若本意是新建库，删掉该文件后重跑即可。");
    process.exit(1);
  }
}
if (!fs.existsSync(abs)) {
  openCheck(abs, true);
  created = true;
} else {
  openCheck(abs, false);
}

// ③ 写入配置
const url = "sqlite://" + abs.replace(/\\/g, "/");
cfg.sources[sid] = {
  type: "sqlite",
  url,
  allowWrites: flag("--allow-writes"),
  allowCreateTable: flag("--allow-create-table"),
  description: opt("--description") || `本地 SQLite（${created ? "新建" : "已有"}: ${abs}）`,
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// ④ 保护配置（与 import-dbeaver 同策略：.gitignore 缺条目则追加）
try {
  const giPath = path.join(path.dirname(cfgPath), ".gitignore");
  const entry = "dbmcp.config.json";
  if (!fs.existsSync(giPath)) fs.writeFileSync(giPath, entry + "\n");
  else {
    const cur = fs.readFileSync(giPath, "utf8");
    if (!cur.split(/\r?\n/).some((l) => l.trim() === entry)) fs.writeFileSync(giPath, cur.replace(/\s*$/, "") + "\n" + entry + "\n");
  }
} catch { /* ignore */ }

console.log(`[sqlite-add] ✅ ${created ? "已创建本地库" : "已校验本地库"}: ${abs}`);
console.log(`[sqlite-add] 源 '${sid}' 已写入 ${cfgPath}（allowWrites=${cfg.sources[sid].allowWrites}, allowCreateTable=${cfg.sources[sid].allowCreateTable}）`);
console.log("[sqlite-add] 重启 MCP server 后生效；用 list_sources 查看（database 字段即文件路径）。");
