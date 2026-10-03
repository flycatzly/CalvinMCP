#!/usr/bin/env node
/**
 * lint_spec.mjs — 用例静态扫描（脚本方式）
 *
 * 用法：
 *   node scripts/lint_spec.mjs tests/                     # ERROR 为 0 则退出码 0
 *   node scripts/lint_spec.mjs tests/ --json              # 机器可读
 *   node scripts/lint_spec.mjs tests/ --disable PW011     # 关闭某条规则
 *   node scripts/lint_spec.mjs tests/ --as-error PW011    # 把某条 WARN 提升为 ERROR
 *   node scripts/lint_spec.mjs tests/ --core-only         # 只跑核心规则（不出补充规则）
 *
 * 门禁语义：ERROR 必须清零才能合入 —— 所以有 ERROR 时以退出码 1 结束，这样才能挂进 CI。
 */
import { lib, parseArgs, finish } from './verify-lib.mjs';

const { flags, positional } = parseArgs();
const target = positional[0] || 'tests';

try {
  const { lint, formatText } = await lib('lint.js');
  const report = lint(target, {
    ruleConfig: {
      disableRules: flags.disable ? String(flags.disable).split(',') : [],
      severityOverrides: flags['as-error'] ? Object.fromEntries(String(flags['as-error']).split(',').map((id) => [id, 'ERROR'])) : {},
    },
    tiers: flags['core-only'] ? ['core'] : undefined,
  });
  if (flags.json) finish(report.summary.exitCode, JSON.stringify(report, null, 2));
  finish(report.summary.exitCode, formatText(report));
} catch (e) {
  finish(2, `lint_spec 无法执行：${e.message}`);
}
