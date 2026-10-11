#!/usr/bin/env node
/**
 * distribute.mjs — 天璇驭页 PagePilot「纯净分发版」构建器（纯净拷贝 + 哈希自校验 + 纯净复扫）
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
 *   node distribute.mjs [--out <目标目录>] [--force] [--no-verify]
 *
 * 复制后默认逐文件哈希自校验（无排除项泄漏 + 与源码字节一致），
 * 失败以退出码 2 结束 —— 「不验证不写盘」在分发环节同样成立。
 *
 * 自校验通过后做「纯净复扫」：排除名单不得出现在产物任何层级。
 *
 * 默认目标：<发布版本>/pagepilot-mcp-clean
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
  'logs', 'runs', 'flows', // 运行时现场目录（流程/报告/日志/证据），装机后由 install.mjs 自动创建
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
  /-probe\.mjs$/i,
  /^_sinfo/i,   // 握手/探针类临时产物
  /^dbg/i,
  /\.bak-/i,
  /\.pyc$/i,
  // 装机生成物（install.mjs「已存在则跳过」的落盘件）：随包发 = 把运行现场发出去
  /^pagepilot\.config\.json$/i,
  /^mcp-register\.example\.json$/i,
  /^accounts\.json$/i,
  /^package-lock\.json$/i, // 纯净版零声明依赖：lock 只会由临时安装产生，属噪音   // 凭据文件：绝不入库、绝不入包（项目红线）
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

/* ---- 纯净复扫：排除名单不得混进产物 ---- */
const dirty = [];
{
  const walkDirty = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (shouldSkip(e.name, true)) { dirty.push(r); continue; }
        walkDirty(path.join(d, e.name), r);
      } else if (shouldSkip(e.name, false)) dirty.push(r);
    }
  };
  walkDirty(OUT);
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
  `  纯净复扫: ${dirty.length === 0 ? '干净（产物树无排除项）' : '违例 ' + dirty.slice(0, 6).join('、')}`,
  '',
  '纯净发布包口径：**无 node_modules、无任何 . 前缀文件/目录、无 runs/logs 运行现场**（开发机残留已剔除）。',
  '解压 / 拷贝即可部署，运行时依赖由 install.mjs 按需装：',
  `  拷贝 "${OUT}" 到目标机器任意目录`,
  '  node install.mjs    # 环境检查 + 按需安装 playwright + doctor 自检 + 输出 MCP 注册 JSON',
  '（执行类 / 浏览器类工具另需本机可用的浏览器 —— 缺失只影响对应工具，doctor 会明示）',
].join('\n');

// 自校验失败或纯净复扫有违例 → 退出 2 —— 「不验证不写盘」在分发环节同样成立
finish(realIssues.length || dirty.length ? 2 : 0, lines);
