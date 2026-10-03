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
 *   排除目录：node_modules、.git、.playwright-artifacts、.playwright-cli、
 *             test-results、dist、generated/generated-*
 *   排除文件：日志文件、临时探查脚本（.probe / dbg / probe 开头）、备份文件
 *
 * 用法：
 *   node skill/playwright-verify/scripts/distribute.mjs [--out <目标目录>] [--force] [--no-verify]
 *
 * 复制后默认逐文件哈希自校验（无排除项泄漏 + 与源码字节一致），
 * 失败以退出码 2 结束 —— 「不验证不写盘」在分发环节同样成立。
 *
 * 默认目标：<项目根的同级>/playwright-verify-mcp-clean
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  'generated', 'generated-e2e', 'generated-orchestrated', 'generated-booltest',
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
const lines = [
  '纯净分发版已生成',
  `  源:   ${PROJECT_ROOT}`,
  `  目标: ${OUT}`,
  `  文件: ${stats.files} 个（${mb} MB）`,
  '',
  `  排除的目录（${stats.skippedDirs.length} 类）:`,
  ...stats.skippedDirs.map((d) => `    - ${d}`),
  `  排除的散文件: ${stats.skippedFiles} 个（*.log / 临时探查脚本 / 备份文件）`,
  '',
  verifySkipped ? '  自校验: 跳过（--no-verify）'
    : realIssues.length === 0 ? `  自校验: 通过（${stats.files} 个文件哈希一致，无排除项泄漏）`
      : `  自校验: 失败（${realIssues.length} 项）`,
  ...realIssues.map((s) => `    ✗ ${s}`),
  '',
  '注意：分发版**不含 node_modules**（原生模块换平台不兼容，且体积大）。',
  '拿到后请执行：',
  `  cd "${OUT}"`,
  '  npm ci',
  '  node skill/playwright-verify/install.mjs',
].join('\n');

// 自校验失败就非零退出 —— 「不验证不写盘」在分发环节同样成立
finish(realIssues.length ? 2 : 0, lines);
