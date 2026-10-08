/**
 * nettree.mjs — 净树生成（r40）：忠实镜像减排除，供 verify-all --mode 1/2 的纯净副本验证
 *
 * 为什么脚本化：r38 实锤手工 robocopy 口径会静默假红 —— 多排 demo 与 package-lock.json
 * → 4 套假红蒸发 290 断言（demo 是测试样例/靶场源，package-lock.json 在部署副本比对面）。
 * 净树的语义是**忠实镜像**：源文件一个都不能少，只去依赖与产物（mcp/lib/exclude.js 单一源）。
 *
 * 用法：node skill/playwright-verify/scripts/nettree.mjs <dest> [--force]
 *   <dest>    目标目录（不存在或空目录；--force 允许覆盖已有目录）
 *
 * 与 distribute 的区别（语义不同，别混用）：
 *   nettree   验证用 —— 保留一切源文件（含 demo/、package-lock.json、.gitignore 等），
 *             只排 DEPENDENCY/ARTIFACT/SANDBOX（目录名口径）+ .git
 *   distribute 发布用 —— 连 . 前缀与散落试验脚本（EXCLUDE_FILE_RES）都排，见其头注
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 排除口径单一源（r40）：不写字面量。
import { EXCLUDE_DIRS as EXCLUDE_DIR_NAMES } from '../../../mcp/lib/exclude.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));       // <root>/skill/playwright-verify/scripts
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');        // <root>

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const destArg = argv.find((a) => !a.startsWith('--'));
if (!destArg) {
  console.error('用法：node skill/playwright-verify/scripts/nettree.mjs <dest> [--force]');
  process.exit(2);
}
const DEST = path.resolve(destArg);

/* 安全检查：目标不能是源目录、也不能在源目录里面（同 distribute 口径） */
if (DEST === PROJECT_ROOT || DEST.startsWith(PROJECT_ROOT + path.sep)) {
  console.error(`拒绝执行：目标目录不能在源目录内或等于源目录。\n  源: ${PROJECT_ROOT}\n  目标: ${DEST}`);
  process.exit(2);
}
if (fs.existsSync(DEST)) {
  if (!force) {
    console.error(`拒绝执行：目标已存在（加 --force 覆盖）：${DEST}`);
    process.exit(2);
  }
  fs.rmSync(DEST, { recursive: true, force: true });
}

const EXCLUDE = new Set(EXCLUDE_DIR_NAMES);
const stats = { files: 0, bytes: 0, skippedDirs: new Set() };

function copyTree(src, dst, rel = '') {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // .git 是版本控制（EXCLUDE_DIRS 含它）；其余 . 前缀**保留** —— 净树是忠实镜像，
      // .gitignore/.github/ 等都是源的一部分（与 distribute 的发布口径刻意不同）。
      if (EXCLUDE.has(e.name)) {
        stats.skippedDirs.add(r);
        continue;
      }
      copyTree(path.join(src, e.name), path.join(dst, e.name), r);
    } else if (e.isFile()) {
      fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
      stats.files++;
      stats.bytes += fs.statSync(path.join(dst, e.name)).size;
    }
  }
}

copyTree(PROJECT_ROOT, DEST);
console.log(`净树已生成：${DEST}`);
console.log(`  ${stats.files} 个文件（${(stats.bytes / 1024 / 1024).toFixed(1)} MB）`);
console.log(`  排除目录 ${stats.skippedDirs.size} 个：${[...stats.skippedDirs].join('、') || '无'}`);
console.log('  语义：忠实镜像减排除（源文件一个都不能少）—— verify-all --mode 1/2 在净树上跑');
