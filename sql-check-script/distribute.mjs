#!/usr/bin/env node
/**
 * distribute.mjs — sql-check-script「纯净分发版」+ 发版门禁（H19 横向铺开）
 *
 * 为什么需要它，而不是手工复制：
 *   手工复制一定会把产物带进去 —— 日志、临时探查脚本、备份文件、node_modules、.git、
 *   上一轮跑出来的输出现场。这些进了分发版有几个具体坏处：
 *     · 体积暴涨；上一轮的**失败现场**会跟着发出去（可能含内部 URL、SQL、表数据）；
 *     · 全树哈希比对会因为多出来的产物而误报。
 *   所以判定规则写在脚本里，可复现、可审查。
 *
 * 判定规则（纯净包口径：无 node_modules、无任何 . 前缀文件/目录）：
 *   一律排除：任何 . 前缀的目录/文件（开发机基础设施，装机时按需生成）
 *   排除目录：node_modules、.git、test-results、dist、scratch、__pycache__
 *   排除文件：日志文件、临时探查脚本（.probe / dbg / probe 开头）、备份文件
 *   （outputs/ 是输出格式模板与示例 —— 随包交付的参考件，不是运行现场，保留）
 *
 * 用法：
 *   node distribute.mjs [--out <目标目录>] [--force] [--no-verify] [--no-gate] [--gate-only]
 *
 * 复制后默认逐文件哈希自校验（无排除项泄漏 + 与源码字节一致），
 * 失败以退出码 2 结束 —— 「不验证不写盘」在分发环节同样成立。
 *
 * 自校验通过后自动跑「发版门禁」（加固 H19）：把产物拷成一次性副本、把兄弟包
 * calvin-db-mcp 拷进副本同级（run_all 默认找 ../calvin-db-mcp/mcp）、npm ci 装依赖、
 * 在副本里跑 tests/run_all.mjs（selftest + 全链路 E2E）、终态哈希终查（门禁前后
 * 产物树哈希一致 + 纯净复扫）、副本验后整目录删除。
 * 发版 = 跑 distribute，门禁不可能忘。显式跳过：--no-gate（或环境变量
 * PV_SKIP_RELEASE_GATE=1 —— 嵌套防递归）；加固自检用 PV_GATE_SKIP_VERIFY=1：
 * 机械链路全走、只跳过验收命令。验收退出码 0=全绿、3=无失败但有诚实 SKIP（明示不冒充
 * 全绿，判过 —— 与 mysql-validate 无凭据 SKIP 同一口径）、其余=失败。门禁失败退出码 3。
 *
 * --gate-only：不构建 -clean，直接对本包源树跑同款门禁（一次性副本验收 + 终态哈希
 * 终查）—— 供 git-pub/copy-pure.mjs 在镜像前逐包把关。
 *
 * 默认目标：<发布版本>/sql-check-script-clean
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
 * 为什么必须自动：交付树不能跑套件 —— 验收会往树里写运行痕迹（输出现场、临时库），
 * 跑脏交付树；流程靠人记就会忘，忘了就重蹈覆辙；所以门禁长在 distribute 收尾。
 * 机械链路：目标树 → 一次性副本（纯净过滤拷贝）+ 兄弟包 calvin-db-mcp 同级副本 →
 * npm ci → 副本里跑 tests/run_all.mjs（退出码 0/3=判过，3=诚实 SKIP 明示记录）→
 * 删副本 → 终态哈希终查（门禁前后目标树哈希一致 + 纯净复扫）。
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
  const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlchk-gate-'));
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
  const npmCi = (cwd, extraArgs) => {
    const env = { ...process.env, PV_SKIP_RELEASE_GATE: '1' };
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const isWin = process.platform === 'win32';
    const title = `npm ci ${extraArgs.join(' ')}`;
    if (fs.existsSync(npmCli)) {
      step(title, process.execPath, [npmCli, 'ci', ...extraArgs, '--no-audit', '--no-fund'], { cwd, env, timeout: 900_000 }, [0]);
    } else {
      step(title, isWin ? 'npm.cmd' : 'npm', ['ci', ...extraArgs, '--no-audit', '--no-fund'], { cwd, env, shell: isWin, timeout: 900_000 }, [0]);
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
      // 家族验收：兄弟包 calvin-db-mcp 同级副本（run_all 默认找 ../calvin-db-mcp/mcp）→ 装依赖 → 全链路
      const env = { ...process.env, PV_SKIP_RELEASE_GATE: '1' };
      const sibSrc = path.join(PARENT, 'calvin-db-mcp');
      const sibDst = path.join(gateTmp, 'calvin-db-mcp');
      if (!fs.existsSync(sibSrc)) {
        gateLines.push(`  ✗ 缺兄弟包源: ${sibSrc}（run_all 需要 ../calvin-db-mcp/mcp）`);
        gateFailed = true;
      } else {
        copyTree(sibSrc, sibDst, '', false);
        npmCi(path.join(sibDst, 'mcp'), ['--omit=dev']);
        step('run_all（selftest + 全链路 E2E）', process.execPath, [path.join(gateCopy, 'tests', 'run_all.mjs')],
          { cwd: gateCopy, env, timeout: 900_000 }, [0, 3]);
      }
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
  '纯净发布包口径：**无 node_modules、无任何 . 前缀文件/目录**（开发机残留已剔除）。',
  '解压 / 拷贝即可部署；验收目标默认指向同级 ../calvin-db-mcp/mcp（可用 DBMCP_MCP_DIR 覆盖）：',
  `  拷贝 "${OUT}" 与 calvin-db-mcp 到目标机器同级目录`,
  '  node tests/run_all.mjs    # 一键全量验收（selftest + sqlite-validate + mysql-validate门控 + docsync + config-lint + E2E，机器可读汇总行）',
  '（live 段自动门控：配置有 mysql/PG 源即跑；FULLCHAIN_MYSQL=1/FULLCHAIN_PG=1 强开、=0 关；无源干净 SKIP）',
  '',
  ...gateLines,
].join('\n');

// 自校验失败退出 2、门禁失败退出 3 —— 「不验证不写盘」在分发环节同样成立
finish(gateFailed ? 3 : realIssues.length ? 2 : 0, lines);
