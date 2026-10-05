#!/usr/bin/env node
/**
 * distribute.mjs — web-rpa-mcp「纯净分发版」+ 发版门禁（H19 横向铺开）
 *
 * 为什么需要它，而不是手工复制：
 *   手工复制一定会把产物带进去 —— runs/ 里的运行现场、logs/ 里的运行日志、
 *   node_modules、.git。这些进了分发版有几个具体坏处：
 *     · 体积暴涨，而且 node_modules 里的原生模块换平台就不兼容；
 *     · 上一轮的**失败现场**会跟着发出去（runs/ 报告可能含内部 URL、账号、页面数据）；
 *     · 全树哈希比对会因为多出来的产物而误报。
 *   所以判定规则写在脚本里，可复现、可审查。
 *
 * 判定规则（纯净包口径：无 node_modules、无任何 . 前缀文件/目录、无运行现场）：
 *   一律排除：任何 . 前缀的目录/文件（开发机基础设施，装机时按需生成）
 *   排除目录：node_modules、.git、logs、runs、test-results、dist、scratch、__pycache__
 *             （logs/ runs/ 是运行时现场目录，装机后由产品自动创建，不随包走）
 *   排除文件：日志文件、临时探查脚本（.probe / dbg / probe 开头）、备份文件
 *
 * 用法：
 *   node distribute.mjs [--out <目标目录>] [--force] [--no-verify] [--no-gate] [--gate-only]
 *
 * 复制后默认逐文件哈希自校验（无排除项泄漏 + 与源码字节一致），
 * 失败以退出码 2 结束 —— 「不验证不写盘」在分发环节同样成立。
 *
 * 自校验通过后自动跑「发版门禁」（加固 H19）：把产物拷成一次性副本、在副本里跑
 * 家族验收（npm ci → selftest → tools → integration）、终态哈希终查（门禁前后产物树
 * 哈希一致 + 纯净复扫）、副本验后整目录删除。
 * 发版 = 跑 distribute，门禁不可能忘。显式跳过：--no-gate（或环境变量
 * PV_SKIP_RELEASE_GATE=1 —— 嵌套防递归）；加固自检用 PV_GATE_SKIP_VERIFY=1：
 * 机械链路全走、只跳过验收命令。验收退出码 0=全绿、3=无失败但有诚实 SKIP（明示不冒充
 * 全绿，判过 —— 与 mysql-validate 无凭据 SKIP 同一口径）、其余=失败。门禁失败退出码 3。
 *
 * --gate-only：不构建 -clean，直接对本包源树跑同款门禁（一次性副本验收 + 终态哈希
 * 终查）—— 供 git-pub/copy-pure.mjs 在镜像前逐包把关。
 *
 * 默认目标：<发布版本>/web-rpa-mcp-clean
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));       // <pkg>
const PROJECT_ROOT = HERE;
const PARENT = path.dirname(PROJECT_ROOT);
const PKG = path.basename(PROJECT_ROOT);

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') flags.out = argv[++i];
  else if (a.startsWith('--')) flags[a.slice(2)] = true;
}
const finish = (code, lines) => {
  console.log(typeof lines === 'string' ? lines : lines.join('\n'));
  process.exit(code);
};

/** 排除的目录名（任意层级） */
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git',
  'logs', 'runs',          // 运行时现场目录（报告/日志/证据），装机后自动创建
  'test-results', 'dist',
  'scratch',
  '__pycache__',   // Python 字节码：运行时再生成，且内嵌编译时路径
]);
/** 排除的文件名模式 */
const EXCLUDE_FILE_RES = [
  /\.log$/i,
  /\.tmp$/i,
  /^\.probe/i,
  /^probe\d*\.mjs$/i,
  /^dbg/i,
  /\.bak-/i,
  /\.pyc$/i,
  // 装机生成物（install.mjs「已存在则跳过」的落盘件）：随包发 = 把运行现场发出去
  /^web-rpa\.config\.json$/i,
  /^mcp-register\.example\.json$/i,
  /^accounts\.json$/i,   // 凭据文件：绝不入库、绝不入包（项目红线）
];

function shouldSkip(name, isDir) {
  // 发布规范：纯净包不含**任何** . 前缀内容 —— 开发机基础设施，不随包走。
  if (name.startsWith('.')) return true;
  if (isDir) return EXCLUDE_DIRS.has(name);
  return EXCLUDE_FILE_RES.some((re) => re.test(name));
}

const stats = { files: 0, bytes: 0, skippedDirs: [], skippedFiles: 0 };
const skippedDirSet = new Set();

// count=false 供门禁一次性副本用：副本拷贝不进统计，报告里的文件数就是交付树的文件数
function copyTree(src, dst, rel = '', count = true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (shouldSkip(e.name, e.isDirectory())) {
      if (count) {
        if (e.isDirectory()) skippedDirSet.add(r);
        else stats.skippedFiles++;
      }
      continue;
    }
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      copyTree(s, d, r, count);
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
      if (count) {
        stats.files++;
        stats.bytes += fs.statSync(d).size;
      }
    }
    // 符号链接与其它类型直接跳过（分发版不该带软链）
  }
}

/* ---- 发版门禁（加固 H19）：一次性副本验收 + 终态哈希终查 ----
 * 为什么必须自动：交付树不能跑套件 —— 验收会往树里写运行痕迹（runs/ 报告、logs/、
 * 浏览器证据），跑脏交付树；流程靠人记就会忘，忘了就重蹈覆辙；所以门禁长在 distribute 收尾。
 * 机械链路：目标树 → 一次性副本（纯净过滤拷贝）→ 副本里跑验收（退出码 0/3=判过，
 * 3=诚实 SKIP 明示记录）→ 删副本 → 终态哈希终查（门禁前后目标树哈希一致 + 纯净复扫）。
 */
const treeHash = (dir) => {
  const h = createHash('sha256');
  const walk = (d, rel = '') => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else { h.update(r); h.update(fs.readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
};

function runGate(target, sourceMode = false) {
  const gateLines = [];
  let gateFailed = false;
  const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrrpa-gate-'));
  const gateCopy = path.join(gateTmp, 'pkg');
  const hashBefore = treeHash(target);
  gateLines.push('发版门禁: 一次性副本验收', `  副本: ${gateCopy}`);
  const walkDirty = (d, acc, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.') || e.name === 'node_modules') { acc.push(r); continue; }
      if (e.isDirectory()) walkDirty(path.join(d, e.name), acc, r);
    }
  };
  const step = (title, cmd, args, opts, accept) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, ...opts });
    const ok = accept.includes(r.status);
    const note = ok ? (r.status === 3 ? '诚实 SKIP（exit 3，明示不冒充全绿，判过）' : '通过（exit 0）')
      : (r.status === null ? `失败（超时/无法启动: ${String(r.error && r.error.message)}）` : `失败（exit ${r.status}）`);
    gateLines.push(`  ${title}: ${note}`);
    if (!ok) {
      gateFailed = true;
      const ls = ((r.stdout || '') + (r.stderr || '')).split('\n').filter((l) => l.trim());
      gateLines.push(`    尾部: ${ls.slice(-3).map((l) => l.trim()).join(' ; ')}`);
    }
  };
  // 用 node 直接跑 npm-cli.js，避免 shell 参数拼接（DEP0190）；找不到再退回 npm.cmd
  const npmCi = (cwd) => {
    const env = { ...process.env, PV_SKIP_RELEASE_GATE: '1' };
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const isWin = process.platform === 'win32';
    const title = 'npm ci（playwright 运行时）';
    if (fs.existsSync(npmCli)) {
      step(title, process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], { cwd, env, timeout: 900_000 }, [0]);
    } else {
      step(title, isWin ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd, env, shell: isWin, timeout: 900_000 }, [0]);
    }
  };
  try {
    copyTree(target, gateCopy, '', false);
    // 副本纯净性在验收前钉死（过滤无泄漏）—— 验收会往副本写 node_modules/证据目录，之后再扫没有意义
    const copyDirty = [];
    walkDirty(gateCopy, copyDirty);
    gateLines.push(`  副本纯净复扫（验收前）: ${copyDirty.length ? '违例 ' + copyDirty.slice(0, 4).join('、') : '干净（过滤无泄漏）'}`);
    if (copyDirty.length) gateFailed = true;
    if (process.env.PV_GATE_SKIP_VERIFY) {
      gateLines.push('  验收命令: 跳过（PV_GATE_SKIP_VERIFY —— 机械自检用；真实发版必跑）');
    } else {
      // 家族验收：装依赖 → selftest → 工具面 → 全链路（缺浏览器/缺依赖时按统一诚实 SKIP 口径 exit 3 判过）
      const env = { ...process.env, PV_SKIP_RELEASE_GATE: '1' };
      const mcpDir = path.join(gateCopy, 'mcp');
      npmCi(mcpDir);
      // 套件契约：selftest/tools/integration 都从 mcp/ 起跑（README 调用姿势：
      // node test\integration.mjs —— runner CLI 用例按 process.cwd() 找 mcp/runner.mjs）
      step('selftest 状态机自检', process.execPath, [path.join(mcpDir, 'selftest.mjs')], { cwd: mcpDir, env }, [0, 3]);
      step('tools 工具面 63 用例', process.execPath, [path.join(mcpDir, 'test', 'tools.mjs')], { cwd: mcpDir, env }, [0, 3]);
      step('integration 全链路', process.execPath, [path.join(mcpDir, 'test', 'integration.mjs')], { cwd: mcpDir, env, timeout: 900_000 }, [0, 3]);
    }
  } finally {
    fs.rmSync(gateTmp, { recursive: true, force: true });
  }
  const copyGone = !fs.existsSync(gateCopy);
  gateLines.push(`  副本已删除: ${copyGone}`);
  if (!copyGone) gateFailed = true;
  const hashAfter = treeHash(target);
  const dirty = [];
  walkDirty(target, dirty);
  const hashOk = hashBefore === hashAfter;
  if (!hashOk) gateFailed = true;
  if (sourceMode) {
    // 源树口径（--gate-only）：dot 前缀/node_modules 属排除名单内开发机现场（.work、.git 等），
    // 拷贝时已剔除、不随包 —— 记「已知排除项」不判红；交付纯净由 --force 打包自校验与复扫保证
    gateLines.push(`  终态哈希终查: ${hashOk ? '0 不一致' : `树哈希变了 ${hashBefore} → ${hashAfter}`}；纯净复扫: 源树已知排除项 ${dirty.length} 项（${dirty.slice(0, 4).join('、') || '无'}，拷贝口径已剔除、不随包）`);
  } else {
    const pure = dirty.length === 0;
    gateLines.push(`  终态哈希终查: ${hashOk ? '0 不一致' : `树哈希变了 ${hashBefore} → ${hashAfter}`}；纯净复扫 ${pure ? '干净' : '违例 ' + dirty.slice(0, 4).join('、')}`);
    if (!pure) gateFailed = true;
  }
  gateLines.push(`发版门禁: ${gateFailed ? '失败 ❌（发布包不可交付）' : '通过 ✅'}`);
  return { gateFailed, gateLines };
}

/* ---- --gate-only：只跑门禁（供 copy-pure.mjs 镜像前逐包把关）---- */
if (flags['gate-only']) {
  if (flags['no-gate'] || process.env.PV_SKIP_RELEASE_GATE) {
    finish(0, `发版门禁: 已跳过（${flags['no-gate'] ? '--no-gate 显式跳过' : 'PV_SKIP_RELEASE_GATE 嵌套防递归'}）`);
  }
  const { gateFailed, gateLines } = runGate(PROJECT_ROOT, true);
  finish(gateFailed ? 3 : 0, ['--gate-only: 对源树跑门禁（不构建 -clean）', `  源: ${PROJECT_ROOT}`, '', ...gateLines]);
}

/* ---- 安全检查：目标目录不能是源目录、也不能在源目录里面 ---- */
const OUT = path.resolve(String(flags.out || path.join(PARENT, `${PKG}-clean`)));
if (OUT === PROJECT_ROOT || OUT.startsWith(PROJECT_ROOT + path.sep)) {
  finish(2, `拒绝执行：目标目录不能在源目录内或等于源目录。\n  源: ${PROJECT_ROOT}\n  目标: ${OUT}`);
}
if (fs.existsSync(OUT)) {
  if (!flags.force) {
    finish(2, `目标已存在：${OUT}\n加 --force 覆盖（会先整体删除该目录）。`);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
}

copyTree(PROJECT_ROOT, OUT);
stats.skippedDirs = [...skippedDirSet].sort();

/* ---- 复制后自校验（--verify，兑现「不验证不写盘」的承诺）----
 * 查两件事，都查实证不查感觉：
 *   1) 漏排泄漏：排除目录/文件模式名是否混进了分发版（复制规则写错了会在这里暴露）；
 *   2) 逐文件哈希：OUT 里每个文件与源码字节一致（复制截断/损坏会在这里暴露）。
 * 默认开启；--no-verify 显式跳过（比如只想快点看目录形状）。
 */
const verifySkipped = flags['no-verify'] === true;
const verifyIssues = [];
if (verifySkipped) {
  verifyIssues.push('(已按 --no-verify 跳过自校验)');
} else {
  const hash = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  const walkVerify = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // 泄漏检查：被排除的名字不该出现在 OUT 的任何层级
        if (shouldSkip(e.name, true)) { verifyIssues.push(`排除的目录混进分发版：${r}`); continue; }
        walkVerify(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (shouldSkip(e.name, false)) { verifyIssues.push(`排除的文件混进分发版：${r}`); continue; }
        const src = path.join(PROJECT_ROOT, ...r.split('/'));
        if (!fs.existsSync(src)) { verifyIssues.push(`分发版多出源码没有的文件：${r}`); continue; }
        if (hash(path.join(dir, e.name)) !== hash(src)) verifyIssues.push(`与源码字节不一致：${r}`);
      }
    }
  };
  walkVerify(OUT);
}

const mb = (stats.bytes / 1024 / 1024).toFixed(2);
const realIssues = verifyIssues.filter((s) => !s.startsWith('('));

/* ---- 收尾自动门禁 ---- */
let gateFailed = false;
const gateLines = [];
if (realIssues.length) {
  gateLines.push('发版门禁: 未跑（自校验失败，先修复制问题）');
} else if (flags['no-gate'] || process.env.PV_SKIP_RELEASE_GATE) {
  gateLines.push(`发版门禁: 已跳过（${flags['no-gate'] ? '--no-gate 显式跳过' : 'PV_SKIP_RELEASE_GATE 嵌套防递归'}）—— 交付树纯净性请另行保证`);
} else {
  const g = runGate(OUT);
  gateFailed = g.gateFailed;
  gateLines.push(...g.gateLines);
}

const lines = [
  '纯净分发版已生成',
  `  源:   ${PROJECT_ROOT}`,
  `  目标: ${OUT}`,
  `  文件: ${stats.files} 个（${mb} MB）`,
  '',
  `  排除的目录（${stats.skippedDirs.length} 类）:`,
  ...stats.skippedDirs.map((d) => `    - ${d}`),
  `  排除的散文件: ${stats.skippedFiles} 个（. 前缀 / *.log / 临时探查脚本 / 备份文件）`,
  '',
  verifySkipped ? '  自校验: 跳过（--no-verify）'
    : realIssues.length === 0 ? `  自校验: 通过（${stats.files} 个文件哈希一致，无排除项泄漏）`
      : `  自校验: 失败（${realIssues.length} 项）`,
  ...realIssues.map((s) => `    ✗ ${s}`),
  '',
  '纯净发布包口径：**无 node_modules、无任何 . 前缀文件/目录、无 runs/logs 运行现场**（开发机残留已剔除）。',
  '解压 / 拷贝即可部署，运行时依赖由 install.mjs 自动装：',
  `  拷贝 "${OUT}" 到目标机器任意目录`,
  '  node install.mjs    # 环境检查 + 自动 npm ci（playwright）+ 自检 + 注册本地 MCP 客户端',
  '（执行类 / 浏览器类工具另需本机可用的浏览器 —— 缺失只影响对应工具，按统一诚实 SKIP 口径明示）',
  '',
  ...gateLines,
].join('\n');

// 自校验失败退出 2、门禁失败退出 3 —— 「不验证不写盘」在分发环节同样成立
finish(gateFailed ? 3 : realIssues.length ? 2 : 0, lines);
