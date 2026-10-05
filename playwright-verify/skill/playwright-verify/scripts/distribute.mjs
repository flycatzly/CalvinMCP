#!/usr/bin/env node
/**
 * distribute.mjs — 生成「纯净分发版」到同级目录
 *
 * 为什么需要它，而不是手工复制：
 *   手工复制一定会把产物带进去 —— 快照/截图/trace/日志目录、test-results、
 *   demo/generated-*、node_modules、.git。
 *   这些进了分发版有几个具体坏处：
 *     · 体积暴涨，而且 node_modules 里的原生模块换平台就不兼容；
 *     · 上一轮的**失败现场**会跟着发出去（可能含内部 URL、账号、页面数据）；
 *     · deployed-check 的全树哈希比对会因为多出来的产物而误报。
 *   所以判定规则写在脚本里，可复现、可审查。
 *
 * 判定规则（与 install.mjs 的复制规则保持一致）：
 *   一律排除：任何 . 前缀的目录/文件（.git/.github/.gitignore/.gitattributes/.playwright*
 *             等版本控制与机器基础设施 —— 发布规范：纯净包不带开发机残留）
 *   排除目录：node_modules、.git、.playwright-artifacts、.playwright-cli、
 *             test-results、dist、generated/generated-*
 *   排除文件：日志文件、临时探查脚本（.probe / dbg / probe 开头）、备份文件
 *
 * 用法：
 *   node skill/playwright-verify/scripts/distribute.mjs [--out <目标目录>] [--force] [--no-verify] [--no-gate]
 *
 * 复制后默认逐文件哈希自校验（无排除项泄漏 + 与源码字节一致），
 * 失败以退出码 2 结束 —— 「不验证不写盘」在分发环节同样成立。
 *
 * 自校验通过后自动跑「发版门禁」（加固 H19）：把产物拷成一次性副本、在副本里跑
 * verify-all、终态哈希终查（门禁前后产物树哈希一致 + 纯净复扫）、副本验后整目录删除。
 * 发版 = 跑 distribute，门禁不可能忘。显式跳过：--no-gate（或环境变量
 * PV_SKIP_RELEASE_GATE=1 —— 门禁嵌套的 verify-all 用它防递归）；加固自检用
 * PV_GATE_SKIP_VERIFY=1：机械链路全走、只跳过嵌套 verify-all。门禁失败退出码 3。
 *
 * 默认目标：<项目根的同级>/playwright-verify-mcp-clean
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, finish } from './verify-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));       // <root>/skill/playwright-verify/scripts
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');        // <root>
const PARENT = path.dirname(PROJECT_ROOT);

const { flags } = parseArgs();
const OUT = path.resolve(String(flags.out || path.join(PARENT, `${path.basename(PROJECT_ROOT)}-clean`)));

/** 排除的目录名（任意层级） */
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git',
  '.playwright-artifacts', '.playwright-cli',
  'test-results', 'dist',
  'generated', 'generated-e2e', 'generated-orchestrated', 'generated-booltest', 'generated-argscheck',
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
];

function shouldSkip(name, isDir) {
  // 发布规范：纯净包不含**任何** . 前缀内容。git/github/ignore/attributes、
  // .playwright 通道配置这些都是开发机基础设施 —— 装机时由 install.mjs
  // 按目标机器生成（.playwright/cli.config.json）或按需重建，不随包走。
  if (name.startsWith('.')) return true;
  if (isDir) return EXCLUDE_DIRS.has(name);
  return EXCLUDE_FILE_RES.some((re) => re.test(name));
}

const stats = { files: 0, bytes: 0, skippedDirs: [], skippedFiles: 0 };
const skippedDirSet = new Set();

function copyTree(src, dst, rel = '') {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (shouldSkip(e.name, e.isDirectory())) {
      if (e.isDirectory()) skippedDirSet.add(r);
      else stats.skippedFiles++;
      continue;
    }
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      copyTree(s, d, r);
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
      stats.files++;
      stats.bytes += fs.statSync(d).size;
    }
    // 符号链接与其它类型直接跳过（分发版不该带软链）
  }
}

/* ---- 安全检查：目标目录不能是源目录、也不能在源目录里面 ---- */
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

/* ---- 发版门禁（加固 H19）：收尾自动「一次性副本验收 + 终态哈希终查」----
 * 为什么必须自动：交付树不能跑套件 —— 产品「证据一律落盘」约定会往
 * <cwd>/.playwright-artifacts/ 写证据，在交付树里跑验收必然跑脏它（实测抓过 3 个残留）。
 * 流程靠人记就会忘，忘了就重蹈覆辙；所以门禁长在 distribute 收尾 —— 发版=跑 distribute，不可能忘。
 * 机械链路：OUT → 一次性副本 → 副本里跑 verify-all --mode 2（§15.3 零依赖态判据：副本无 node_modules，
 * 零依赖整链自检 + 状态校验，缺可选依赖诚实 SKIP）→ 删副本 → 终态哈希终查（门禁前后 OUT 树哈希一致 + 纯净复扫）。
 */
const gateLines = [];
let gateFailed = false;
if (realIssues.length) {
  gateLines.push('发版门禁: 未跑（自校验失败，先修复制问题）');
} else if (flags['no-gate'] || process.env.PV_SKIP_RELEASE_GATE) {
  gateLines.push(`发版门禁: 已跳过（${flags['no-gate'] ? '--no-gate 显式跳过' : 'PV_SKIP_RELEASE_GATE 嵌套防递归'}）—— 交付树纯净性请另行保证`);
} else {
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
  const copyOnly = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyOnly(s, d);
      else if (e.isFile()) fs.copyFileSync(s, d);
    }
  };
  const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-gate-'));
  const gateCopy = path.join(gateTmp, 'pkg');
  const hashBefore = treeHash(OUT);
  gateLines.push('发版门禁: 一次性副本验收', `  副本: ${gateCopy}`);
  try {
    copyOnly(OUT, gateCopy);
    if (process.env.PV_GATE_SKIP_VERIFY) {
      gateLines.push('  嵌套 verify-all: 跳过（PV_GATE_SKIP_VERIFY —— 加固 H19 机械自检用；真实发版必跑）');
    } else {
      const r = spawnSync(process.execPath, [path.join(gateCopy, 'mcp', 'test', 'verify-all.mjs'), '--mode', '2'],
        { encoding: 'utf8', timeout: 600_000, cwd: gateCopy, env: { ...process.env, PV_SKIP_RELEASE_GATE: '1' } });
      const text = (r.stdout || '') + (r.stderr || '');
      const ls = text.split('\n').filter((l) => l.trim());
      const fails = ls.filter((l) => l.includes('[FAIL]')).map((l) => l.trim());
      const tail = fails.length ? fails.join(' ; ')
        : (ls.find((l) => l.includes('结果：')) || ls.pop() || '').trim();
      gateLines.push(`  嵌套 verify-all: ${r.status === 0 ? '全绿' : '红'}（exit ${r.status}）—— ${tail}`);
      if (r.status !== 0) gateFailed = true;
    }
  } finally {
    fs.rmSync(gateTmp, { recursive: true, force: true });
  }
  const copyGone = !fs.existsSync(gateCopy);
  gateLines.push(`  副本已删除: ${copyGone}`);
  if (!copyGone) gateFailed = true;
  const hashAfter = treeHash(OUT);
  const dirty = [];
  const walkDirty = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.') || e.name === 'node_modules') { dirty.push(r); continue; }
      if (e.isDirectory()) walkDirty(path.join(d, e.name), r);
    }
  };
  walkDirty(OUT);
  const hashOk = hashBefore === hashAfter;
  const pure = dirty.length === 0;
  gateLines.push(`  终态哈希终查: ${hashOk ? '0 不一致' : `树哈希变了 ${hashBefore} → ${hashAfter}`}；纯净复扫 ${pure ? '干净' : '违例 ' + dirty.slice(0, 4).join('、')}`);
  if (!hashOk || !pure) gateFailed = true;
  gateLines.push(`发版门禁: ${gateFailed ? '失败 ❌（发布包不可交付）' : '通过 ✅'}`);
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
  '纯净发布包口径：**无 node_modules、无任何 . 前缀文件/目录**（开发机残留已剔除）。',
  '零 npm 依赖 —— 解压 / 拷贝即可部署，不需要 npm install、不需要联网、不需要生成任何依赖：',
  `  拷贝 "${OUT}" 到目标机器任意目录`,
  '  node skill/playwright-verify/install.mjs    # 装 Skill + 生成 DSH bundle + 注册客户端',
  '（执行类 / CLI 类工具另需被测项目自己提供 @playwright/test / @playwright/cli ——',
  ' 那是被测项目的依赖、不是本包的；缺失只影响对应工具，详见部署说明.md）',
  '',
  ...gateLines,
].join('\n');

// 自校验失败退出 2、门禁失败退出 3 —— 「不验证不写盘」在分发环节同样成立
finish(gateFailed ? 3 : realIssues.length ? 2 : 0, lines);
