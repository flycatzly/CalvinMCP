#!/usr/bin/env node
/**
 * calvin-db-mcp 技能安装器（自动依赖 → 连接配置初始化 → 自动注册到本地 MCP 客户端）
 * 用法:
 *   node install.mjs                      # 自动装依赖 + 自检（未初始化时给出导入指引，跳过注册）
 *   node install.mjs <DBeaver导出的.dbp>   # 自动装依赖 + 导入连接配置 + 自动注册到本地客户端
 *   可选: --allow-writes         导入的配置允许 execute 写操作（安全红线仍然生效）
 *         --allow-create-table   导入的配置允许 create_table 建表（默认关闭，安全红线仍然生效）
 *         --force                配置已存在时仍用 .dbp 覆盖重导（与 import-dbeaver.mjs 同语义；
 *                                不加时 .dbp 被忽略并给出提示，防误覆盖现有连接）
 *         --dry-run              只打印不落盘：跳过依赖安装 / 配置导入 / 自动注册 / 示例配置写出
 *                                （验收、试跑用；真实装机去掉此参数）
 * 退出码（统一诚实 SKIP 口径，与 mysql-validate 退出码 3 同义）：
 *   0 = 完成且无诚实 SKIP；1 = 存在问题；3 = 无失败但有诚实 SKIP（如 E2E 缺 fixture / 无凭据）
 *   —— 未跑的部分明示出来，不冒充全绿。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(here, "mcp");
const nodeBin = process.execPath;
const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
let ok = true;
// 诚实 SKIP（统一口径）：想跑但环境没给条件（缺 fixture / 无凭据 / 缺依赖）——
// 明示原因、退出码 3，不计成功（假绿）也不计失败（假红）。
let honestSkip = false;
const step = (n, t) => console.log("\n== 步骤 " + n + "：" + t + " ==");
// --dry-run：只打印不落盘（wechat-ai v1.0.1 同款守卫）。旧版无 dry-run 语义 ——
// 未知参数被静默忽略，「试跑」会真写 mcp-register.example.json，已初始化机器上还会写
// ~/.claude.json 等用户全局配置：验收/试跑一律加本参数（副本验收口径见共享发布说明）。
const DRY_RUN = process.argv.includes("--dry-run");

step(1, "Node.js 版本检查");
// 与 package.json 的 engines（>=18.17）以及文档口径保持一致：主次版本都要比
const [nMajor, nMinor] = process.versions.node.split(".").map(Number);
if (nMajor < 18 || (nMajor === 18 && nMinor < 17)) {
  console.error("  ✗ 需要 Node.js ≥ 18.17，当前 " + process.version);
  process.exit(1);
}
console.log("  ✓ " + process.version);
// v1.2.1: SQLite 能力提示（node:sqlite 为 Node 22.5+ 内置；不影响其余功能，非阻断）
const [sqMajor, sqMinor] = process.versions.node.split(".").map(Number);
if (sqMajor > 22 || (sqMajor === 22 && sqMinor >= 5)) console.log("  ✓ SQLite 支持可用（node:sqlite 内置）");
else console.log("  ⚠ 当前 Node 无 node:sqlite（需 ≥ 22.5）——SQLite 源不可用，MySQL/PG 不受影响");
// v1.4.1: 导出/导入目录白名单提示（未设置时 export_data/import_data 不可用，属可选能力）。
// 两个工具的门禁不对称：export 只认 DBMCP_EXPORT_DIR；import 认 DBMCP_IMPORT_DIR 或回退 DBMCP_EXPORT_DIR。
// 提示读的是安装进程环境，MCP 服务的环境以客户端注册配置（如 mcp-register.example.json 的 "env" 块）为准。
if (!process.env.DBMCP_EXPORT_DIR) {
  console.log("  ⊹ 未设置 DBMCP_EXPORT_DIR——export_data 将不可用（在 MCP 客户端注册配置的 \"env\" 块或系统环境变量中设置后重启）");
}
if (!process.env.DBMCP_IMPORT_DIR && !process.env.DBMCP_EXPORT_DIR) {
  console.log("  ⊹ 未设置 DBMCP_IMPORT_DIR——import_data 将不可用（可回退 DBMCP_EXPORT_DIR；两者都缺时不可用）");
}
// v1.5.0: enc2 主密钥提示（可选能力）——设置后新写入/ rekey 升级的 enc 为 AES-256-GCM 主密钥绑定格式。
if (!process.env.DBMCP_MASTER_KEY) {
  console.log("  ⊹ 未设置 DBMCP_MASTER_KEY——enc 为旧格式（落盘混淆）；设置 ≥8 字符主密钥后可用 node crypt-cli.mjs rekey 升级为 enc2（AES-256-GCM，主密钥绑定）");
}

step(2, "运行时依赖（缺失时自动 npm ci --omit=dev）");
if (fs.existsSync(path.join(MCP, "node_modules", "mysql2")) && fs.existsSync(path.join(MCP, "node_modules", "pg"))) {
  console.log("  ✓ 依赖已就绪（mysql2 / pg）");
} else if (DRY_RUN) {
  console.log("  ⊹ dry-run：跳过自动安装（不落盘）——真实装机将执行 npm ci --omit=dev（26 个纯生产包）");
} else {
  // v1.4.1: --registry=<url> 真实透传给 npm（旧版提示"可加镜像参数"却无参数通道）
  const registry = process.argv.find((a) => a.startsWith("--registry="));
  console.log("  … 自动安装依赖（需联网" + (registry ? "" : "；内网可加 --registry=https://registry.npmmirror.com") + "）…");
  const npmArgs = ["ci", "--omit=dev", "--no-audit", "--no-fund"];
  if (registry) npmArgs.push(registry);
  const r = spawnSync("npm", npmArgs, { cwd: MCP, stdio: "inherit", shell: true });
  if (r.status !== 0) { console.error("  ✗ 依赖自动安装失败；可重跑并加 --registry=https://registry.npmmirror.com"); ok = false; }
  else console.log("  ✓ 依赖自动安装完成（26 个纯生产包）");
}

step(3, "连接配置初始化（必须先于注册）");
const cfgPath = process.env.DBMCP_CONFIG || path.join(MCP, "dbmcp.config.json");
const dbp = process.argv.slice(2).find((a) => !a.startsWith("--"));
let configReady = fs.existsSync(cfgPath);
if (configReady) {
  let c;
  try { c = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
  catch { console.error("  ✗ 配置文件损坏（" + cfgPath + "）：请备份后删除该文件，用 .dbp 重新导入"); process.exit(1); }
  console.log("  ✓ 已初始化：" + Object.keys(c.sources || {}).length + " 个源（url 加密存储，无明文）");
  if (dbp && process.argv.includes("--force") && DRY_RUN) {
    console.log("  ⊹ dry-run：跳过覆盖导入（不落盘）——真实装机将执行: node mcp\\import-dbeaver.mjs \"" + dbp + "\" --force");
  } else if (dbp && process.argv.includes("--force")) {
    // v1.6.1 幂等对齐：--force 与 import-dbeaver.mjs 同语义——显式覆盖才重导（默认忽略 .dbp 防误覆盖）
    console.log("  … --force 覆盖导入: " + dbp);
    const impArgs = [path.join(MCP, "import-dbeaver.mjs"), dbp, "--force"];
    if (process.argv.includes("--allow-writes")) impArgs.push("--allow-writes");
    if (process.argv.includes("--allow-create-table")) impArgs.push("--allow-create-table");
    const r = spawnSync(nodeBin, impArgs, { cwd: MCP, stdio: "inherit" });
    if (r.status !== 0) { console.error("  ✗ 覆盖导入失败（见上）。"); ok = false; }
    else {
      try {
        c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        console.log("  ✓ 覆盖导入完成：" + Object.keys(c.sources || {}).length + " 个源");
      } catch { console.error("  ✗ 覆盖导入后配置文件不可解析，请检查 " + cfgPath); ok = false; }
    }
  } else if (dbp) {
    console.log("  ⊹ 检测到传入的 .dbp 参数，但配置已存在——已忽略（如需覆盖重导请加 --force，或执行 node mcp\\import-dbeaver.mjs \"" + dbp + "\" --force）");
  }
} else if (dbp && DRY_RUN) {
  console.log("  ⊹ dry-run：跳过配置导入（不落盘）——真实装机将执行: node mcp\\import-dbeaver.mjs \"" + dbp + "\"");
} else if (dbp) {
  console.log("  … 从 DBeaver 项目导入: " + dbp);
  const impArgs = [path.join(MCP, "import-dbeaver.mjs"), dbp];
  if (process.argv.includes("--allow-writes")) impArgs.push("--allow-writes");
  if (process.argv.includes("--allow-create-table")) impArgs.push("--allow-create-table");
  const r = spawnSync(nodeBin, impArgs, { cwd: MCP, stdio: "inherit" });
  if (r.status !== 0) { console.error("  ✗ 导入失败（见上）。"); ok = false; }
  else {
    configReady = true;
    let c;
    try { c = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
    catch { console.error("  ✗ 导入后配置文件不可解析，请检查 " + cfgPath); ok = false; c = { sources: {} }; }
    console.log("  ✓ 导入完成：" + Object.keys(c.sources || {}).length + " 个源（url 已加密为 enc 字段）");
  }
} else {
  console.log("  ⚠ 尚未初始化：未发现 dbmcp.config.json（默认不预置任何凭据）。");
  console.log("    请把 DBeaver 导出项目文件(.dbp) 路径作为参数重新运行本安装器，例如：");
  console.log('    node install.mjs "C:\\Users\\<you>\\Documents\\保险-20260929.dbp"');
  console.log("    或直接执行: node mcp\\import-dbeaver.mjs <.dbp路径>");
}

step(4, "功能自检（selftest）");
if (configReady) {
  const st = spawnSync(nodeBin, [path.join(MCP, "selftest.mjs")], { cwd: MCP, encoding: "utf8" });
  const outAll = (st.stdout || "") + (st.stderr || "");
  // v1.0.3: 解析 selftest 末尾的机器可读汇总行（旧版用 /PASS/g、/FAIL/g 计数，
  // 测试名或报错文本里出现这两个词就会误报）；无汇总行时回退计数并告警。
  // 第三组（可选）= 诚实 SKIP —— 自 v1.6.3 起带统一口径的套件会输出。
  const sum = outAll.match(/=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/);
  var passCount = sum ? Number(sum[1]) : (outAll.match(/PASS/g) || []).length;
  var failCount = sum ? Number(sum[2]) : (outAll.match(/FAIL/g) || []).length;
  var selfSkip = sum && sum[3] ? Number(sum[3]) : 0;
  if (!sum) console.log("  ⚠ selftest 未输出汇总行（版本过旧？），回退到 PASS/FAIL 计数");
  if (st.status === 3) {
    // 退出码 3 = 无失败但有诚实 SKIP（如 mysql-validate 无凭据）：不算失败，但绝不算全绿
    honestSkip = true;
    console.log("  PASS=" + passCount + " FAIL=" + failCount + " 诚实SKIP=" + selfSkip + "  ⊹ 诚实 SKIP（exit 3）——未跑部分见 selftest 输出，不冒充全绿");
  } else {
    console.log("  PASS=" + passCount + " FAIL=" + failCount + (st.status === 0 ? "  ✓" : "  ✗ (exit " + st.status + ")"));
    if (st.status !== 0) ok = false;
  }
} else {
  console.log("  ⊹ 跳过（未初始化）；初始化后重跑本安装器会执行完整自检");
}

step(5, "全链路 E2E 验收（部署即验证）");
let e2ePass = "-", e2eFail = "-", e2eSkip = "-";
{
  // E2E 位于技能仓库（sql-check-script/tests/fullchain_test.mjs），未随包分发时跳过属正常；
  // 可用 DBMCP_E2E=<fullchain_test.mjs 路径> 显式指定。部署验收只跑确定性核心段：
  // 剥离 FULLCHAIN_* live 门控，避免部署机恰好带这些变量但真实源不可达时误判安装失败。
  const e2ePath = process.env.DBMCP_E2E || path.resolve(here, "..", "sql-check-script", "tests", "fullchain_test.mjs");
  if (!configReady) {
    console.log("  ⊹ 跳过（未初始化）；初始化后重跑本安装器会执行全链路 E2E");
  } else if (!fs.existsSync(e2ePath)) {
    console.log("  ⊹ 跳过：未找到全链路 E2E（技能仓库未随包分发属正常）。可设 DBMCP_E2E=<fullchain_test.mjs 路径>启用部署验收。");
  } else {
    const env = { ...process.env };
    delete env.FULLCHAIN_MYSQL;
    delete env.FULLCHAIN_PG;
    const e2e = spawnSync(nodeBin, [e2ePath, MCP], { cwd: here, encoding: "utf8", env });
    const outAll = (e2e.stdout || "") + (e2e.stderr || "");
    const esum = outAll.match(/=== 全链路 E2E：(\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/);
    if (esum) { e2ePass = esum[1]; e2eFail = esum[2]; e2eSkip = esum[3] || "0"; }
    else console.log("  ⚠ E2E 未输出汇总行（版本过旧？）");
    if (e2e.status === 3) {
      // 退出码 3 = 无失败但有诚实 SKIP（缺 demo fixture / 缺依赖起不来）：部署机没给条件 ≠ 安装失败
      honestSkip = true;
      console.log("  E2E PASS=" + e2ePass + " FAIL=" + e2eFail + " 诚实SKIP=" + e2eSkip + "  ⊹ 诚实 SKIP（exit 3）——原因见 E2E 输出，不冒充全绿");
    } else {
      console.log("  E2E PASS=" + e2ePass + " FAIL=" + e2eFail + (e2e.status === 0 ? "  ✓" : "  ✗ (exit " + e2e.status + ")"));
      if (e2e.status !== 0) ok = false;
    }
  }
}

step(6, "自动注册到本地 MCP 客户端");
const serverPath = path.join(MCP, "server.mjs");
const ENTRY = { command: "node", args: [serverPath] };
function mergeInto(file) {
  let obj = {};
  if (fs.existsSync(file)) {
    try { obj = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return { s: "skip", msg: "配置解析失败(" + e.code + ")" }; }
  } else if (!fs.existsSync(path.dirname(file))) { return { s: "skip", msg: "客户端未安装" }; }
  const backup = file + ".bak-calvin-db-mcp";
  // v1.6.1 幂等对齐：备份只在首次生成——重装不再用「已含本工具条目」的文件覆盖原始备份，
  // 否则回滚时拿到的不是装前状态（.bak 的语义就是 pre-install 原件）。
  let backed = false;
  if (fs.existsSync(file) && !fs.existsSync(backup)) { fs.copyFileSync(file, backup); backed = true; }
  if (!obj.mcpServers || typeof obj.mcpServers !== "object") obj.mcpServers = {};
  obj.mcpServers["db"] = ENTRY;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return { s: "ok", msg: backed ? "已写入（原文件备份为 " + path.basename(backup) + "）" : "已写入（沿用首次备份 " + path.basename(backup) + "）" };
}
function registerAll() {
  const results = [];
  // 1) Claude Code：优先用官方 CLI（用户级），失败则合并 ~/.claude.json
  let claudeCli = false;
  try { const v = spawnSync("claude", ["--version"], { encoding: "utf8", shell: true }); claudeCli = v.status === 0; } catch { claudeCli = false; }
  if (claudeCli) {
    spawnSync("claude", ["mcp", "remove", "db", "-s", "user"], { stdio: "ignore", shell: true });
    // v1.4.1: Windows 下 shell:true 会把 argv 原样拼接给 cmd.exe（Node DEP0190）——路径含空格会被
    // 拆散、含 & | < > ^ % ( ) ! 等元字符会被 cmd 解释执行。对参数做安全预检：不安全则跳过 CLI
    // 注册（下方 JSON 直写已覆盖同样效果），安全则对含空格参数加引号。
    const cmdQuote = (a) => (/[&|<>^()%!"\n\r]/.test(a) ? null : /\s/.test(a) ? '"' + a + '"' : a);
    const argv = ["mcp", "add", "db", "-s", "user", "--", "node", serverPath].map(cmdQuote);
    if (argv.every(Boolean)) {
      const r = spawnSync("claude", argv, { encoding: "utf8", shell: true });
      results.push(["Claude Code (CLI 用户级)", r.status === 0 ? "ok" : "skip", r.status === 0 ? "claude mcp add 成功" : "CLI 返回失败"]);
    } else {
      results.push(["Claude Code (CLI 用户级)", "skip", "安装路径含 cmd 元字符，跳过 CLI 注册（已由 ~/.claude.json 方式覆盖，效果相同）"]);
    }
  }
  const r1 = mergeInto(path.join(home, ".claude.json"));
  results.push(["Claude Code (~/.claude.json)", r1.s === "ok" ? (fs.existsSync(path.join(home, ".claude.json")) ? "ok" : "created") : r1.s, r1.msg]);
  // 2) Claude Desktop
  const r2 = mergeInto(path.join(appData, "Claude", "claude_desktop_config.json"));
  results.push(["Claude Desktop", r2.s, r2.msg]);
  // 3) Cursor
  const r3 = mergeInto(path.join(home, ".cursor", "mcp.json"));
  results.push(["Cursor", r3.s, r3.msg]);
  for (const [n, s2, m2] of results) console.log("  " + (s2 === "ok" || s2 === "created" ? "✓" : "⊹") + " " + n + "：" + m2);
  return results.some(([, s2]) => s2 === "ok" || s2 === "created");
}

if (DRY_RUN) {
  console.log("  ⊹ dry-run：跳过自动注册（不落盘）——真实装机将注册到 Claude Code（CLI / ~/.claude.json）、Claude Desktop、Cursor。");
} else if (!configReady) {
  console.log("  ⊹ 跳过自动注册：需先完成连接配置初始化（见步骤 3 指引），初始化后重跑本安装器即可自动注册。");
} else {
  const anyOk = registerAll();
  console.log("  注册完成。重启 MCP 客户端后生效；如需移除可删除各配置中的 mcpServers.db 条目。");
  if (!anyOk) console.log("  ⚠ 未检测到已知客户端，请将 mcp-register.example.json 内容手工加入你的客户端配置。");
}
const exampleFile = path.join(here, "mcp-register.example.json");
if (DRY_RUN) {
  console.log("  示例配置（dry-run 不落盘）：将写入 " + exampleFile);
} else {
  fs.writeFileSync(exampleFile, JSON.stringify({ mcpServers: { db: ENTRY } }, null, 2));
}

const verdict = ok ? (honestSkip ? "完成（含诚实 SKIP）⊹" : "完成 ✓") : "存在问题（见上）";
console.log("\n== 安装结果: " + verdict + " ==");
console.log("INSTALL_STATUS=" + (ok ? (honestSkip ? "SKIP" : "OK") : "FAIL") + " INIT=" + (configReady ? "yes" : "no") + " REG=" + (DRY_RUN ? "dry" : configReady ? "auto" : "skipped") + " PASS=" + (typeof passCount === "number" ? passCount : "-") + " FAIL=" + (typeof failCount === "number" ? failCount : "-") + " E2E=" + (e2ePass === "-" ? "-" : e2ePass + "/" + e2eFail + "/" + e2eSkip));
if (!configReady) console.log("下一步: 初始化连接配置后重跑本安装器完成自动注册。");
process.exit(ok ? (honestSkip ? 3 : 0) : 1);