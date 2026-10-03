#!/usr/bin/env node
/**
 * check_standards.mjs — 团队测试规范校验（脚本方式）
 *
 * 用法：
 *   node scripts/check_standards.mjs                 # 校验 cwd 下的 AGENTS.md / CLAUDE.md
 *   node scripts/check_standards.mjs AGENTS.md
 *   node scripts/check_standards.mjs --template      # 打印可直接粘贴的规范片段
 *   node scripts/check_standards.mjs --json
 *
 * 规范缺失不阻断流水线（它是人的约定，不是代码缺陷），所以退出码恒为 0；
 * 但缺失项会被明确列出 —— 沉默的缺失才是最贵的。
 */
import path from 'node:path';
import { lib, parseArgs, finish } from './verify-lib.mjs';

const { flags, positional } = parseArgs();

try {
  const { checkStandards, formatText, renderStandardsMd } = await lib('standards.js');
  if (flags.template) finish(0, renderStandardsMd());
  const target = positional[0] || process.cwd();
  const report = checkStandards(path.resolve(target));
  if (flags.json) finish(0, JSON.stringify(report, null, 2));
  const text = formatText(report);
  finish(0, flags.strict && report.missing > 0
    ? `${text}\n\n（--strict 已开启：缺失 ${report.missing} 条，退出码 1）`
    : text);
} catch (e) {
  finish(2, `check_standards 无法执行：${e.message}`);
}
