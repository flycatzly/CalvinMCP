#!/usr/bin/env node
/**
 * summarize_report.mjs — 失败聚类与归因（脚本方式）
 *
 * 用法：
 *   node scripts/summarize_report.mjs test-results/report.json
 *   node scripts/summarize_report.mjs test-results/report.json --json
 *   node scripts/summarize_report.mjs test-results/report.json --fail-on-failures   # 有失败则退出码 1
 *
 * 默认退出码 0（归因成功即算成功）—— 因为它挂在「失败任务」里做归因，
 * 若自己也因失败而报错，CI 会分不清是「用例失败」还是「归因工具失败」。
 * 需要按失败阻断时用 --fail-on-failures 显式开启。
 */
import fs from 'node:fs';
import path from 'node:path';
import { lib, parseArgs, finish } from './verify-lib.mjs';

const { flags, positional } = parseArgs();
const file = positional[0];
if (!file) finish(2, '用法：node scripts/summarize_report.mjs <report.json> [--json] [--fail-on-failures]');

try {
  const { summarizeFile, formatText } = await lib('signature.js');
  if (!fs.existsSync(file)) {
    finish(2, `报告不存在：${path.resolve(file)}\n`
      + '请确认 playwright.config 里有 json reporter —— 见 references/evidence-and-traces.md 的 CFG004。');
  }
  const report = summarizeFile(path.resolve(file));
  if (report.error) finish(2, report.error);
  if (flags.json) {
    finish(flags['fail-on-failures'] && report.totals.failed > 0 ? 1 : 0, JSON.stringify(report, null, 2));
  }
  const code = flags['fail-on-failures'] && report.totals.failed > 0 ? 1 : 0;
  finish(code, formatText(report));
} catch (e) {
  finish(2, `summarize_report 无法执行：${e.message}`);
}
