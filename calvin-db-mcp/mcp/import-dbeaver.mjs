/**
 * import-dbeaver.mjs — 从 DBeaver 导出项目(.dbp)生成 dbmcp.config.json（首次初始化）
 *
 * 流程: .dbp(ZIP) 解包 → 解析 data-sources.json → 解密 credentials-config.json（DBeaver 26 方案，
 *       解密实现见 crypt.mjs，已混淆）→ 过滤 MySQL/PG → url 加密为 enc 字段 → 写入 dbmcp.config.json
 *
 * 用法:
 *   node import-dbeaver.mjs <DBeaver导出的.dbp文件> [--force] [--allow-writes] [--allow-create-table]
 *   --force               目标配置已存在时强制覆盖（默认拒绝，防止误覆盖现有连接）
 *   --allow-writes        生成的配置允许 execute 写操作（默认关闭，安全红线仍然生效）
 *   --allow-create-table  生成的配置允许 create_table 建表（v1.0.1 起默认关闭，与 allowWrites 口径一致）
 * 输出路径: 环境变量 DBMCP_CONFIG 或本目录 dbmcp.config.json
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decryptDbeaverFile } from "./crypt.mjs";
// v1.5.0: 写入 enc 按是否有 DBMCP_MASTER_KEY 分派（encryptForConfig）——有主密钥写 enc2
//（AES-256-GCM 主密钥绑定），没有则写旧格式（AES-128-CBC 落盘混淆，向后兼容）。
import { encryptForConfig } from "./crypt2.mjs";
import { parseJdbcUrl, envFromFolder, sanitizeId, psSingleQuote, buildSourceUrl } from "./dbeaver-parse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.DBMCP_CONFIG || path.join(__dirname, "dbmcp.config.json");
const argv = process.argv.slice(2);
const dbpPath = argv.find((a) => !a.startsWith("--"));
const force = argv.includes("--force");
const allowWritesFlag = argv.includes("--allow-writes");
const allowCreateTableFlag = argv.includes("--allow-create-table");

if (!dbpPath) {
  console.error("用法: node import-dbeaver.mjs <DBeaver导出的.dbp文件> [--force] [--allow-writes] [--allow-create-table]");
  console.error("说明: .dbp 为 DBeaver「文件 → 导出 → 项目」生成的项目包，内含全部连接与凭据。");
  process.exit(1);
}
if (!fs.existsSync(dbpPath)) {
  console.error("[import] 文件不存在: " + dbpPath);
  process.exit(1);
}
if (fs.existsSync(OUT) && !force) {
  console.error("[import] 目标已存在: " + OUT);
  console.error("[import] 如需覆盖请加 --force（现有连接将被替换，建议先备份）");
  process.exit(1);
}

/* ---------------- ① 解包 .dbp（ZIP 容器） ---------------- */
// v1.0.2: 解包目录内含 DBeaver 凭据文件，必须保证用完即删；
//         旧版用 (TEMP || TMP || ".")，环境变量缺失时会把凭据落到当前目录，且从不清理。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-import-"));
let tmpRemoved = false;
const cleanupTmp = () => {
  if (tmpRemoved) return;
  tmpRemoved = true;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
};
process.on("exit", cleanupTmp);
process.on("SIGINT", () => { cleanupTmp(); process.exit(130); });
process.on("SIGTERM", () => { cleanupTmp(); process.exit(143); });
const extractDir = path.join(tmp, "x");
fs.mkdirSync(extractDir, { recursive: true });
let extracted = false;
try {
  // Windows 10+ 内置 bsdtar 可直接解 zip
  execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", path.resolve(dbpPath), "-C", extractDir], { stdio: "ignore" });
  extracted = true;
} catch { /* 回退 PowerShell */ }
if (!extracted) {
  try {
    const zipCopy = path.join(tmp, "project.zip");
    fs.copyFileSync(dbpPath, zipCopy);
    // 路径经 psSingleQuote 拼接（内部 ' 双写）：临时目录/用户名含 ' 时不再截断单引号注入命令
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Path ${psSingleQuote(zipCopy)} -DestinationPath ${psSingleQuote(extractDir)} -Force`], { stdio: "ignore" });
    extracted = true;
  } catch (e) {
    console.error("[import] 解包失败（tar 与 PowerShell 均不可用）:", e.message);
    process.exit(1);
  }
}
console.log("[import] 解包完成:", extractDir);

/* ---------------- ② 定位 .dbeaver 数据 ---------------- */
function findDbeaverDirs(root) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === "data-sources.json")) hits.push(d);
    for (const e of entries) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
  };
  walk(root, 0);
  return hits;
}
const dbeaverDirs = findDbeaverDirs(extractDir).filter((d) => fs.existsSync(path.join(d, "credentials-config.json")));
if (!dbeaverDirs.length) {
  console.error("[import] 未找到 .dbeaver 数据（data-sources.json + credentials-config.json）");
  process.exit(1);
}
console.log("[import] 发现 DBeaver 项目数据:", dbeaverDirs.length, "处");

/* ---------------- ③ 解析 + 解密 ---------------- */
const conns = [];
const skipped = [];
let projects = 0;
for (const d of dbeaverDirs) {
  const dsRaw = JSON.parse(fs.readFileSync(path.join(d, "data-sources.json"), "utf8"));
  const blob = fs.readFileSync(path.join(d, "credentials-config.json"));
  let creds = {};
  try {
    creds = JSON.parse(decryptDbeaverFile(blob)); // 混淆模块内实现（AES-128-CBC, IV 前置, LOCAL_KEY_CACHE）
  } catch (e) {
    console.error("[import] 凭据解密失败:", e.message, "→ 该项目连接将不含密码");
  }
  projects++;
  for (const [id, c] of Object.entries(dsRaw.connections || {})) {
    const provider = String(c.provider || "");
    const type = provider.includes("mysql") || provider.includes("oceanbase") ? "mysql" : provider.includes("postgres") ? "postgres" : null;
    if (!type) { skipped.push(`${c.name || id} (${provider})`); continue; }
    const conf = c.configuration || {};
    // v1.1.1: JDBC 解析/环境映射/source id 清洗抽到 dbeaver-parse.mjs（纯函数，带 fixture 单测）。
    // v1.0.2 背景：URL 可能内嵌凭据（jdbc:mysql://user:pass@host:port/db），旧版正则遇之内嵌凭据整体失配
    // → host/database 全空、凭据被静默丢弃；命名分组支持可选 user:pass@ 前缀并解码百分号编码。
    const j = parseJdbcUrl(conf.url || "");
    const jHost = j ? j.host : null;
    const jPort = j ? j.port : null;
    const jDb = j ? j.db : null;
    const host = (conf.configurationType === "URL" && j) ? jHost : (conf.host || jHost || "");
    const port = String(jPort || conf.port || (type === "mysql" ? "3306" : "5432"));
    const database = jDb || conf.database || "";
    const cred = (creds[id] && creds[id]["#connection"]) || {};
    const env = envFromFolder(c.folder);   // v1.0.3: 词元匹配（"latest" 不再误判 TEST）
    // 凭据优先取 DBeaver 凭据库；URL 内嵌凭据作为兜底（旧版直接丢弃）
    conns.push({ id, name: c.name || id, type, host, port, database, user: cred.user || (j ? j.user : "") || "", password: cred.password || (j ? j.password : "") || "", folder: c.folder || "", env });
  }
}
console.log(`[import] MySQL/PG 连接: ${conns.length} 个；跳过其他类型: ${skipped.length ? skipped.join(", ") : "无"}\n`);

/* ---------------- ④ 生成 sources（url 全部加密） ---------------- */
const sanitize = sanitizeId;   // v1.1.1: 抽到 dbeaver-parse.mjs（带 fixture 单测）
const used = new Set();
const sources = {};
for (const c of conns) {
  let sid = c.type + "_" + sanitize(c.database || c.name);
  while (used.has(sid)) sid += "_2";
  used.add(sid);
  const url = buildSourceUrl(c);   // v1.5.2: db 名也走 encodeURIComponent（纯函数，带单测）
  sources[sid] = { type: c.type, env: c.env, enc: encryptForConfig(url), description: `${c.name}（环境: ${c.env}；${c.password ? "含凭据" : "无密码"}）` };
}

/* ---------------- ⑤ 连通性预检 ---------------- */
const targets = [...new Map(conns.map((c) => [c.host + ":" + c.port, c])).entries()];
await Promise.all(targets.map(([t, c]) => new Promise((res) => {
  const s = net.connect({ host: c.host, port: Number(c.port), timeout: 2500 });
  const done = (ok) => { try { s.destroy(); } catch {} res([t, ok]); };
  s.on("connect", () => done(true));
  s.on("timeout", () => done(false));
  s.on("error", () => done(false));
}))).then((rs) => {
  console.log("== 连通性预检 ==");
  for (const [t, ok] of rs) console.log(`${ok ? "✓ 可达" : "✗ 不可达(需VPN/白名单)"}  ${t}`);
  console.log("");
});

/* ---------------- ⑥ 写入配置 ---------------- */
const config = {
  $comment: `calvin-db-mcp 配置。由 import-dbeaver.mjs 从 DBeaver 项目包 ${path.basename(dbpPath)} 导入生成（${new Date().toISOString().slice(0, 10)}）。url 以 enc 加密存储：enc2: 前缀 = AES-256-GCM（密钥绑定 DBMCP_MASTER_KEY 环境变量，可轮换）；无前缀 = 旧格式 AES-128-CBC（落盘混淆，非保密边界）。此文件含凭据（加密态），勿入 git。`,
  maxRows: 200,
  timeoutMs: 30000,
  allowWrites: allowWritesFlag,
  // v1.0.1: 与 allowWrites 口径对齐——建表默认关闭，需显式 --allow-create-table 开启
  allowCreateTable: allowCreateTableFlag,
  // v1.0.1: execute 前按同一 WHERE 预检命中行数，超过该值即拒绝（0 = 关闭预检）
  maxAffectedRows: 500,
  sources,
};
fs.writeFileSync(OUT, JSON.stringify(config, null, 2));
// 自动生成 .gitignore 保护生成的凭据配置（若部署目录位于 git 仓库内）
// v1.0.1: 不再覆盖已有 .gitignore（旧版会把 node_modules/ 等既有条目一并抹掉）：
//         文件不存在时创建；已存在且缺少该条目时追加；已包含则不动。
try {
  const giPath = path.join(path.dirname(OUT), ".gitignore");
  const entry = "dbmcp.config.json";
  if (!fs.existsSync(giPath)) {
    fs.writeFileSync(giPath, entry + "\n");
  } else {
    const cur = fs.readFileSync(giPath, "utf8");
    const already = cur.split(/\r?\n/).some((l) => l.trim().replace(/^\//, "").replace(/\/$/, "") === entry);
    if (!already) fs.writeFileSync(giPath, cur.replace(/\s*$/, "") + "\n" + entry + "\n");
  }
} catch { /* 非 git 目录或权限不足时忽略 */ }

console.log(`\n[import] ✅ 已生成 ${OUT}`);
console.log(`[import] 共 ${Object.keys(sources).length} 个源（url 已加密为 enc 字段）。重启 MCP server 后用 list_sources 查看。`);
if (conns.some((c) => !c.password)) console.log("[import] 注意: 部分连接在 DBeaver 中未保存密码，已按空口令导入。");
if (!process.env.DBMCP_MASTER_KEY) {
  console.log("[import] 提示: 未设置 DBMCP_MASTER_KEY——enc 为旧格式（落盘混淆，非保密边界）。");
  console.log("[import]        设置 ≥8 字符主密钥后运行 node crypt-cli.mjs rekey，可逐源升级为 enc2（AES-256-GCM 主密钥绑定）。");
}
