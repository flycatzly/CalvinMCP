#!/usr/bin/env node
/**
 * wechat-ai 安装器：环境检查 → 功能自检 → 自动注册到本地 MCP 客户端
 *
 * 用法:
 *   node install.mjs                 # 检查 + 自检 + 自动注册
 *   node install.mjs --no-register   # 只检查与自检，不改任何客户端配置
 *   node install.mjs --name wechat   # 自定义注册名（默认 wechat-ai）
 *   node install.mjs --dry-run       # 只打印将要写入的配置，不落盘
 *
 * 本安装器不会下载任何依赖（零 npm 依赖），不会读取或生成微信密钥。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(here, "mcp");
const SERVER = path.join(MCP, "server.mjs");
const SELFTEST = path.join(MCP, "selftest.mjs");
const nodeBin = process.execPath;
const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const optVal = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const NAME = optVal("--name", "wechat-ai");
const NO_REGISTER = has("--no-register");
const DRY_RUN = has("--dry-run");

let ok = true;
const step = (n, t) => console.log("\n== 步骤 " + n + "：" + t + " ==");

// ---------------------------------------------------------------------------
step(1, "Node.js 版本检查");
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error("  ✗ 需要 Node.js ≥ 22.5（node:sqlite 内置模块），当前 " + process.version);
  process.exit(1);
}
console.log("  ✓ " + process.version + "（内置 node:sqlite）");

step(2, "运行时依赖检查（本服务器零 npm 依赖）");
const missing = [];
try { await import("node:sqlite"); } catch { missing.push("node:sqlite"); }
try { await import("node:zlib"); } catch { missing.push("node:zlib"); }
if (missing.length) {
  console.error("  ✗ 缺少内置模块：" + missing.join(", "));
  ok = false;
} else {
  console.log("  ✓ node:sqlite / node:zlib / node:crypto / node:child_process 均可用，无需 npm install");
}
for (const f of [SERVER, SELFTEST, path.join(MCP, "lib", "store.mjs"), path.join(MCP, "lib", "signals.mjs")]) {
  if (!fs.existsSync(f)) { console.error("  ✗ 缺少文件：" + f); ok = false; }
}
if (ok) console.log("  ✓ 核心文件齐全");

step(3, "工具清单");
let toolCount = 0;
try {
  const r = spawnSync(nodeBin, [SERVER, "--list-tools"], { encoding: "utf8" });
  if (r.status === 0) {
    const j = JSON.parse(r.stdout);
    toolCount = j.count;
    console.log("  ✓ 已注册 " + j.count + " 个 MCP 工具");
  } else {
    console.error("  ✗ 无法列出工具：" + (r.stderr || "").slice(0, 300));
    ok = false;
  }
} catch (e) {
  console.error("  ✗ " + String(e.message ?? e));
  ok = false;
}

step(4, "功能自检（selftest）");
let pass = 0;
let failC = 0;
try {
  const r = spawnSync(nodeBin, [SELFTEST], { encoding: "utf8", env: { ...process.env } });
  const all = (r.stdout || "") + (r.stderr || "");
  const sum = all.match(/=== (\d+) passed, (\d+) failed ===/);
  pass = sum ? Number(sum[1]) : (all.match(/PASS/g) || []).length;
  failC = sum ? Number(sum[2]) : (all.match(/FAIL/g) || []).length;
  if (!sum) {
    console.log("  ⚠ 未找到汇总行，回退到计数");
    console.log(all.split("\n").slice(-25).join("\n"));
  }
  console.log("  PASS=" + pass + " FAIL=" + failC + (r.status === 0 ? "  ✓" : "  ✗ (exit " + r.status + ")"));
  if (r.status !== 0) {
    console.error(all.split("\n").filter((l) => l.includes("✗")).slice(0, 20).join("\n"));
    ok = false;
  }
} catch (e) {
  console.error("  ✗ 自检执行失败：" + String(e.message ?? e));
  ok = false;
}

// ---------------------------------------------------------------------------
step(5, "MCP 客户端注册");
const ENTRY = { command: "node", args: [SERVER] };
const results = [];

function mergeInto(file, dryRun) {
  if (!fs.existsSync(path.dirname(file))) return { s: "skip", msg: "客户端未安装" };
  let obj = {};
  if (fs.existsSync(file)) {
    try { obj = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return { s: "skip", msg: "配置解析失败(" + (e.code ?? "?") + ")" }; }
  }
  if (!obj.mcpServers || typeof obj.mcpServers !== "object") obj.mcpServers = {};
  obj.mcpServers[NAME] = ENTRY;
  if (dryRun) return { s: "dry", msg: "将写入 " + file };
  const backup = file + ".bak-wechat-ai";
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  return { s: "ok", msg: "已写入" + (fs.existsSync(backup) ? "（原文件备份为 " + path.basename(backup) + "）" : "") };
}

if (NO_REGISTER) {
  console.log("  ⊹ 已指定 --no-register，跳过注册");
} else {
  // 1) Claude Code CLI
  let claudeCli = false;
  try { claudeCli = spawnSync("claude", ["--version"], { encoding: "utf8", shell: true }).status === 0; } catch { claudeCli = false; }
  if (claudeCli && !DRY_RUN) {
    spawnSync("claude", ["mcp", "remove", NAME, "-s", "user"], { stdio: "ignore", shell: true });
    const r = spawnSync("claude", ["mcp", "add", NAME, "-s", "user", "--", "node", SERVER], { encoding: "utf8", shell: true });
    results.push(["Claude Code (CLI 用户级)", r.status === 0 ? "ok" : "skip", r.status === 0 ? "claude mcp add 成功" : "CLI 返回失败"]);
  } else if (claudeCli && DRY_RUN) {
    results.push(["Claude Code (CLI 用户级)", "dry", "claude mcp add " + NAME + " -- node " + SERVER]);
  }
  // 2) 各客户端的 JSON 配置
  for (const [label, file] of [
    ["Claude Code (~/.claude.json)", path.join(home, ".claude.json")],
    ["Claude Desktop", path.join(appData, "Claude", "claude_desktop_config.json")],
    ["Cursor", path.join(home, ".cursor", "mcp.json")],
  ]) {
    const r = mergeInto(file, DRY_RUN);
    results.push([label, r.s, r.msg]);
  }
  for (const [n, s, m] of results) console.log("  " + (s === "ok" ? "✓" : s === "dry" ? "→" : "⊹") + " " + n + "：" + m);
}

// 注册示例文件（供手动接入其它客户端）
const example = path.join(here, "mcp-register.example.json");
if (DRY_RUN) {
  console.log("  示例配置（dry-run 不落盘）：将写入 " + example);
} else {
  try {
    fs.writeFileSync(example, JSON.stringify({ mcpServers: { [NAME]: ENTRY } }, null, 2), "utf8");
    console.log("  示例配置：" + example);
  } catch { /* ignore */ }
}

console.log("\n  通用 stdio 配置（任何支持 MCP 的客户端都一样）：");
console.log("    " + JSON.stringify({ mcpServers: { [NAME]: ENTRY } }));

console.log("\n  DeepSeek Harness 说明：DSH 的 MCP 支持由插件提供。若你的 profile 已装 MCP 客户端插件，");
console.log("  把上面的 mcpServers 片段加入该插件配置即可；未装插件时可直接用命令行调用：");
console.log("    node \"" + SERVER + "\"            # 启动 stdio MCP 服务器");
console.log("    node \"" + SERVER + "\" --list-tools  # 查看全部工具");

console.log("\n== 安装结果: " + (ok ? "完成 ✓" : "存在问题（见上）") + " ==");
console.log("INSTALL_STATUS=" + (ok ? "OK" : "FAIL") + " TOOLS=" + toolCount + " PASS=" + pass + " FAIL=" + failC + " REG=" + (NO_REGISTER ? "skipped" : DRY_RUN ? "dry" : "auto"));
process.exit(ok ? 0 : 1);
