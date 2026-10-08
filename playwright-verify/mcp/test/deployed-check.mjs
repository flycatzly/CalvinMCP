#!/usr/bin/env node
/**
 * deployed-check.mjs — 验证「部署副本」而不是源码目录
 *
 * 为什么需要单独验部署副本：
 *   源码目录能跑，不代表装到 ~/.agents/skills/ 之后还能跑。
 *   实测踩过两类只有部署后才暴露的问题：
 *     · node_modules 没带过去 → 执行类 / CLI 类工具不可用
 *     · .playwright/cli.config.json 没带过去 → 源码用 msedge、装完找 chrome
 *   所以「装完必须验一遍」不是形式，是必需步骤。
 *
 * 本脚本：
 *   1) 定位部署目录（默认 ~/.agents/skills/playwright-verify-mcp，可用 --dir 指定）
 *   2) 校验目录形状（mcp/lib、skill、node_modules、.playwright、dsh-bundle）
 *   3) 真的 spawn 部署副本的 server.mjs，走完整 tools/list 与一次真实 tools/call
 *   4) 对比源码与部署副本的核心文件是否一致（防止「改了源码忘了重装」）
 *
 * 用法：
 *   node mcp/test/deployed-check.mjs
 *   node mcp/test/deployed-check.mjs --dir "C:\path\to\install"
 *   node mcp/test/deployed-check.mjs --source "<项目根>"    # 显式指定源码目录做对比
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// 排除口径单一源（r40）：目录名/顶层忽略/漂移判定全部派生，不写字面量。
import { EXCLUDE_DIRS as EXCLUDE_DIR_NAMES, IGNORE_TOP as IGNORE_TOP_NAMES, EXPECTED_DEPLOY_EXTRA, diffManifests } from '../lib/exclude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(__dirname, '../..');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DIR = path.resolve(argOf('--dir', path.join(os.homedir(), '.agents', 'skills', 'playwright-verify-mcp')));

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};
const skip = (name, why) => log(`SKIP  ${name}  ${why}`);

log(`部署目录：${DIR}`);
log(`源码目录：${SOURCE}\n`);

/* ---- 0) 先确认「这份部署副本确实是这份源码装出来的」----
 *
 * 为什么必须先做这一步（实测踩到的假失败）：
 *   本脚本默认比对 ~/.agents/skills/playwright-verify-mcp 与「当前所在的源码目录」。
 *   但机器上可以存在**多份**源码副本（例如 <项目> 与 <项目>-clean），
 *   而安装目录只指向其中之一。若从另一份副本里跑本脚本，
 *   它就会拿 A 的安装副本去比 B 的源码，报出一堆"漂移"—— **全是假的**。
 *
 *   这是最坏的一类测试缺陷：它让人去修一个根本不存在的问题，
 *   而这类冤枉会直接毁掉门禁的可信度。所以宁可不比，也不能假报。
 *
 * 判据：用几个「身份文件」判断部署副本的出身。对不上就明确 SKIP 并说明原因。
 */
const IDENTITY_FILES = ['mcp/server.mjs', 'mcp/lib/lint.js', 'skill/playwright-verify/SKILL.md'];

if (!fs.existsSync(DIR)) {
  check('部署目录存在', false, `${DIR} 不存在 —— 请先运行 node skill/playwright-verify/install.mjs`);
  process.exit(1);
}
check('部署目录存在', true);

const sameFile = (a, b) => {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
};
const identityMismatch = IDENTITY_FILES.filter((rel) => {
  const s = path.join(SOURCE, rel);
  const d = path.join(DIR, rel);
  return fs.existsSync(s) && fs.existsSync(d) && !sameFile(s, d);
});
if (identityMismatch.length) {
  // 出身不同 → 只可能是「安装副本来自另一份源码」，不是本源码有问题。
  const skipMsg = `部署副本与本源码出身不同（${identityMismatch.length} 个身份文件不一致：${identityMismatch.join(', ')}）`;
  check('部署副本确由本源码安装（否则比对无意义）', false,
    `${skipMsg}\n      这不是漂移 —— 请对本目录重跑 install.mjs 后再验，或从被安装的那份源码里跑本脚本。`);
  log('\n为避免**假漂移**（把「另一份源码的安装副本」误报成缺陷），一致性比对到此为止。');
  log(`SOURCE=${SOURCE}`);
  log(`DIR=${DIR}`);
  process.exit(1);
}
check('部署副本确由本源码安装（身份文件一致）', true, IDENTITY_FILES.join(', '));

/* ---- 1) 目录形状 ---- */
const mustExist = [
  ['mcp/server.mjs', 'MCP 入口'],
  ['mcp/lib/lint.js', '核心库'],
  ['mcp/lib/signature.js', '归因核心'],
  ['mcp/test/verify-all.mjs', '回归测试'],
  ['skill/playwright-verify/SKILL.md', 'Skill 入口'],
  ['skill/playwright-verify/references', '知识层'],
  ['skill/playwright-verify/scripts/lint_spec.mjs', '脚本包装'],
  ['skill/playwright-verify/assets', '资产模板'],
  ['mcp/bridge.mjs', '浏览器插件桥（HTTP ⇄ JSON-RPC）'],
  ['extension/manifest.json', '浏览器插件控制台'],
  ['extension/floating.js', '猫耳悬浮球（录制/回放/工具快捷）'],
  ['extension/recorder.js', '录制纯函数核'],
  ['dsh-bundle/cordis.patch.yml', 'DSH bundle'],
];
for (const [rel, label] of mustExist) {
  check(`部署含 ${label}`, fs.existsSync(path.join(DIR, rel)), rel);
}

// 可选依赖与 CLI 配置：缺了不算致命，但要让执行类工具不可用这件事被看见
const optChecks = [
  ['node_modules/@playwright/test', '@playwright/test（run_verify）'],
  ['node_modules/@playwright/cli', '@playwright/cli（cli_* 工具）'],
  ['.playwright/cli.config.json', 'CLI 浏览器通道配置'],
];
for (const [rel, label] of optChecks) {
  const p = path.join(DIR, rel);
  if (fs.existsSync(p)) check(`部署含 ${label}`, true, rel);
  else skip(`部署含 ${label}`, `缺失：${rel}（相关工具不可用，其余不受影响）`);
}

/* ---- 2) 源码 vs 部署副本：全树哈希比对 ---- */
/*
 * 为什么用「全树哈希」而不是维护一张要对比的文件清单：
 *   清单一定会漏。漏掉的后果是「改了源码没重装」静默通过 —— 而这恰恰是最该被抓到的问题。
 *   全树比对还有一个好处：它能同时抓到**缺失**（没复制过去）与**多余**（本该没有的残留）。
 *
 * 忽略项分三类：
 *   · 依赖与版本控制：node_modules / .git
 *   · . 前缀的机器基础设施（.gitattributes/.gitignore/.github/.playwright* 等）：
 *     纯净分发版按发布规范**不含**它们，而安装副本可能装自开发树（带它们）——
 *     两边都纳入比对只会制造假漂移；装机产物 .playwright/cli.config.json 也在这里，
 *     它由下面的语义校验负责（判平台，不判字节）。
 *   · 运行时产物：安装后跑测试会新生成它们，不属于「该复制的东西」，
 *     但也不会掩盖真实漂移（真实漂移在 mcp/ 与 skill/ 里）。
 */
// 排除口径单一源（r40，../lib/exclude.js）：目录名/顶层忽略/运行时豁免全部派生，
// 不写字面量（差集理由见 exclude.js 头注）。
const IGNORE_DIRS = new Set(EXCLUDE_DIR_NAMES);
const IGNORE_TOP = new Set(IGNORE_TOP_NAMES);   // 安装时生成，源码目录没有

function manifest(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // . 前缀一律不参与比对（见上方「忽略项分三类」）：纯净分发版不含它，
      // 装自开发树的安装副本含它 —— 纳入比对=假漂移。
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!rel && IGNORE_TOP.has(e.name)) continue;
        walk(abs, r);
      } else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        out.set(r, { size: buf.length, hash: createHash('sha256').update(buf).digest('hex').slice(0, 16) });
      }
    }
  };
  walk(root, '');
  return out;
}

const srcManifest = manifest(SOURCE);
const dstManifest = manifest(DIR);
// 漂移判定单一源（r40，exclude.js diffManifests）：运行时产物双向豁免——
// 「失败保留产物」或「重装前产物已清」任一形态下 generated/test-results 都不算漂移。
const { missing, extra, unexpectedExtra } = diffManifests(srcManifest.keys(), dstManifest.keys());
// .playwright/cli.config.json 根本进不了清单（. 前缀已忽略）：install.mjs 会
// **按目标平台重新生成它**，字节必然与源码不同 —— 那不是漂移，是正确行为。
// 它由下面的语义校验负责：部署副本的配置必须适配当前平台。
const differing = [...srcManifest.entries()]
  .filter(([k, v]) => dstManifest.has(k) && (dstManifest.get(k).hash !== v.hash || dstManifest.get(k).size !== v.size))
  .map(([k]) => k);
// 部署目录里比源码多的文件：运行时产物豁免（diffManifests），非预期多余报出来 ——
// 那通常意味着源码删了文件而安装目录还留着旧的。

check('部署副本没有丢文件', missing.length === 0,
  missing.length ? `缺失 ${missing.length} 个：${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}` : `源码 ${srcManifest.size} 个文件全部在位`);
check('部署副本内容与源码一致（改了源码没重装会在这里暴露）', differing.length === 0,
  differing.length ? `不同 ${differing.length} 个：${differing.slice(0, 6).join(', ')}${differing.length > 6 ? ' …' : ''}` : `${srcManifest.size} 个文件哈希逐一相同（cli.config.json 走语义校验）`);
check('部署副本没有多余的陈旧文件', unexpectedExtra.length === 0,
  unexpectedExtra.length ? `多余 ${unexpectedExtra.length} 个：${unexpectedExtra.slice(0, 6).join(', ')}` : '仅含预期的运行时产物');

// 语义校验（替代 cli.config.json 的字节比对）：部署副本的通道配置必须适配**当前**机器。
// 字节相同但平台不对（把 win32 的 msedge 配置原样带到 Linux）正是「装完不能跑」的形态，
// 字节比对反而会放过它；所以这里判平台归属，不判字节。
{
  const cfgPath = path.join(DIR, '.playwright', 'cli.config.json');
  let cfg = null;
  try {
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch { cfg = null; }
  if (cfg === null) {
    skip('部署副本 CLI 配置适配当前平台', '缺失或解析失败（cli_* 工具不可用，其余不受影响）');
  } else {
    const plat = typeof cfg._平台 === 'string' ? cfg._平台 : '(手工配置，未声明平台)';
    check('部署副本 CLI 配置适配当前平台',
      typeof cfg._平台 !== 'string' || cfg._平台.startsWith(process.platform),
      `配置声明 ${plat} / 当前 ${process.platform}（不匹配请重跑 install.mjs 或 setup-cli-config.mjs）`);
  }
}
const runtimeExtra = extra.filter((k) => EXPECTED_DEPLOY_EXTRA.some((re) => re.test(k)));
if (runtimeExtra.length) {
  log(`      部署目录另有 ${runtimeExtra.length} 个运行时产物（跑过测试就会有，不算漂移）：${runtimeExtra.slice(0, 4).join(', ')}${runtimeExtra.length > 4 ? ' …' : ''}`);
}

/* ---- 3) 真的启动部署副本的 server，走完整发现与一次调用 ---- */
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-deploy-'));
const inFile = path.join(tmpdir, 'in.ndjson');
const outFile = path.join(tmpdir, 'out.ndjson');
const errFile = path.join(tmpdir, 'err.log');
const SERVER = path.join(DIR, 'mcp', 'server.mjs');

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'deployed-check', version: '1' }, capabilities: {} } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'selfcheck', arguments: { cwd: DIR } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'explain_rules', arguments: { group: 'lint' } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lint_spec', arguments: { target: 'demo/tests/tricky.spec.ts', cwd: DIR, format: 'json' } } },
];
fs.writeFileSync(inFile, `${requests.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

const inFd = fs.openSync(inFile, 'r');
const outFd = fs.openSync(outFile, 'w');
const errFd = fs.openSync(errFile, 'w');
const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [SERVER], {
    cwd: DIR, stdio: [inFd, outFd, errFd], windowsHide: true,
  });
  child.on('error', () => resolve(-1));
  child.on('close', (c) => resolve(c ?? -1));
});
fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd);

const responses = fs.readFileSync(outFile, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const byId = (id) => responses.find((r) => r.id === id);

check('部署副本 server 能启动（退出码 0）', code === 0, `exit=${code}`);
check('握手成功', byId(1)?.result?.serverInfo?.name === 'playwright-verify',
  JSON.stringify(byId(1)?.result?.serverInfo));

const tools = byId(2)?.result?.tools || [];
check('tools/list 返回 16 个工具', tools.length === 16, `${tools.length} 个`);
const EXPECTED = ['check_config', 'lint_spec', 'summarize_report', 'run_verify', 'setup-browser-config',
  'cli_health', 'cli_session', 'cli_batch',
  'explore_page', 'nl_test_goal', 'collect_table',
  'generate_scripts', 'check_standards', 'orchestrate_excel', 'explain_rules', 'selfcheck'];
const missingTools = EXPECTED.filter((t) => !tools.some((x) => x.name === t));
check('16 个工具名齐全', missingTools.length === 0, missingTools.join(','));
check('每个工具都有 description 与 inputSchema',
  tools.every((t) => t.description && t.inputSchema?.type === 'object'));

const sc = byId(3);
check('部署副本 selfcheck 必需项通过', sc?.result?.isError !== true,
  (sc?.result?.content?.[0]?.text || '').split('\n').filter((l) => l.includes('PASS') || l.includes('FAIL')).slice(0, 3).join(' | '));

const er = byId(4);
check('部署副本 explain_rules 可用', (er?.result?.structuredContent?.lint || []).length >= 14,
  `${er?.result?.structuredContent?.lint?.length} 条规则`);

const lint = byId(5);
check('部署副本能扫 tricky.spec.ts（且 0 ERROR / 0 WARN —— 不冤枉人）',
  lint?.result?.structuredContent?.summary?.errorCount === 0
  && lint?.result?.structuredContent?.summary?.warnCount === 0,
  JSON.stringify(lint?.result?.structuredContent?.summary));

if (code !== 0) {
  log('\nstderr：');
  log(fs.readFileSync(errFile, 'utf8').split('\n').slice(0, 15).join('\n'));
}

try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* 忽略 */ }

log('');
log(failures === 0
  ? '部署副本验证全部通过 ✅（工具发现 + 真实调用 + 与源码一致）'
  : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
