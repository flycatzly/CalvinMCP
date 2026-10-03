#!/usr/bin/env node
/**
 * run_verify.mjs — 执行回归（脚本方式）
 *
 * 用法：
 *   node scripts/run_verify.mjs --cwd . --config demo/regression/playwright.config.ts
 *   node scripts/run_verify.mjs --cwd . --grep "下单" --retries 2
 *   node scripts/run_verify.mjs --cwd . --dry-run          # 只做环境自检
 *   node scripts/run_verify.mjs --cwd . --config X --then-summarize   # 跑完直接归因
 *
 * 输出重定向到文件，不进内存日志（长回归的日志本来也不该进内存）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { lib, parseArgs, finish } from './verify-lib.mjs';

const { flags } = parseArgs();
const cwd = path.resolve(String(flags.cwd || process.cwd()));

try {
  const { runPlaywright, playwrightVersion, resolvePlaywrightRunner } = await lib('runner.js');
  if (!fs.existsSync(cwd)) finish(2, `目录不存在：${cwd}`);
  const runner = resolvePlaywrightRunner(cwd);
  const version = await playwrightVersion(cwd);
  if (!runner) {
    finish(2, `${cwd} 下找不到 Playwright。请先执行：\n`
      + '  npm i -D @playwright/test && npx playwright install chromium');
  }

  const args = [];
  if (flags.config) args.push('--config', String(flags.config));
  if (flags.grep) args.push('--grep', String(flags.grep));
  if (flags.project) args.push('--project', String(flags.project));
  if (flags.retries) args.push('--retries', String(flags.retries));
  if (flags.files) args.push(...String(flags.files).split(','));

  if (flags['dry-run'] || flags.dryRun) {
    finish(0, `[干跑] 运行器: ${runner.how}\nPlaywright: ${version || '(未知)'}\n`
      + `将执行: playwright test ${args.join(' ')}`);
  }

  const res = await runPlaywright({
    cwd,
    args,
    timeoutMs: flags.timeout ? Number(flags.timeout) : 600_000,
    logDir: path.join(cwd, '.playwright-artifacts', 'logs'),
  });
  const lines = [
    `执行完成：退出码 ${res.code}（${Math.round((res.durationMs || 0) / 1000)}s）`,
    `运行器: ${runner.how}　Playwright: ${version || '(未知)'}`,
    `日志: ${res.stdoutFile}`,
    '',
    '--- 输出尾部 ---',
    (res.stdout || '').split(/\r?\n/).filter((l) => l.trim()).slice(-30).join('\n'),
  ];

  if (flags['then-summarize']) {
    const reportFile = String(flags['then-summarize']) === 'true'
      ? path.join(cwd, 'test-results', 'report.json')
      : path.resolve(cwd, String(flags['then-summarize']));
    if (fs.existsSync(reportFile)) {
      const { summarizeFile, formatText } = await lib('signature.js');
      lines.push('', '=== 失败归因 ===', formatText(summarizeFile(reportFile)));
    } else {
      lines.push('', `（跳过归因：找不到报告 ${reportFile}；请确认配置里有 json reporter）`);
    }
  }
  finish(res.code, lines.join('\n'));
} catch (e) {
  finish(2, `run_verify 无法执行：${e.message}`);
}
