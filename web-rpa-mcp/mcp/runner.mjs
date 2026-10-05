#!/usr/bin/env node
// web-rpa-mcp — 命令行执行器（供 Windows 任务计划程序与手工一键运行）
// 退出码：0=成功 1=失败 2=被阻断（静态检查/缺参数）3=用法错误
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirs, readConfig, logger, nowIso, readJson, redactPath } from './lib/core.mjs';
import { listFlows, loadFlow, listRuns, flowMarkdown } from './lib/store.mjs';
import { runFlow, preflightFlow } from './lib/player.mjs';
import { statusReport, pruneRuns, pruneAllRuns, pruneLogs } from './lib/ops.mjs';
import { runChain } from './lib/chain.mjs';
import { closeAll } from './lib/browser.mjs';

const L = logger('runner');

function parseArgs(argv) {
  const out = { _: [], flags: {}, params: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.indexOf('--') === 0) out.flags[key] = true;
      else { out.flags[key] = next; i++; }
    } else out._.push(a);
  }
  if (typeof out.flags.params === 'string') {
    for (const pair of out.flags.params.split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) out.params[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  if (typeof out.flags['params-file'] === 'string') {
    const f = path.resolve(out.flags['params-file']);
    if (fs.existsSync(f)) Object.assign(out.params, readJson(f, {}) || {});
    else L.warn('参数文件不存在', { file: f });
  }
  return out;
}

function print(rep) {
  const lines = [];
  lines.push('流程: ' + (rep.name || rep.flowId) + '  (' + rep.flowId + ')');
  lines.push('状态: ' + rep.status + '   耗时: ' + (rep.durationMs / 1000).toFixed(1) + 's   步骤: ' + (rep.steps || []).length);
  if (rep.failedStep) lines.push('失败步骤: 第 ' + rep.failedStep + ' 步');
  if (rep.error) lines.push('错误: ' + rep.error);
  for (const a of rep.assertions || []) lines.push('  ' + (a.pass ? 'PASS' : 'FAIL') + ' [' + a.kind + '] ' + (a.message || '') + ' — ' + a.detail);
  if ((rep.healed || []).length) {
    lines.push('自愈: ' + rep.healed.map((h) => '第' + h.step + '步 ' + h.from + '->' + h.to + '(' + h.confidence + ')').join('; '));
  }
  if (rep.emptyGuard && rep.emptyGuard.suspicious) lines.push('空结果告警: ' + rep.emptyGuard.reason);
  if ((rep.screenshots || []).length) lines.push('截图: ' + rep.screenshots.length + ' 张');
  if ((rep.videos || []).length) lines.push('录像: ' + rep.videos.length + ' 段（' + rep.videos.map((v) => path.basename(v)).join('、') + '）');
  if (rep.timedOut) lines.push('总超时: 是（maxDurationMs=' + rep.maxDurationMs + 'ms，已优雅收尾）');
  if (rep.reportPath) lines.push('报告: ' + rep.reportPath);
  return lines.join('\n');
}

async function main() {
  ensureDirs();
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write([
      'Web RPA 执行器',
      '',
      '用法:',
      '  node runner.mjs list                     列出流程',
      '  node runner.mjs show <flowId>            打印步骤清单',
      '  node runner.mjs run <flowId> [选项]      回放流程',
      '  node runner.mjs preflight <flowId>       非破坏性定位预检',
      '  node runner.mjs chain <id1> <id2> ...    串联执行',
      '  node runner.mjs history <flowId>          执行历史',
      '  node runner.mjs status [--problems]       全流程总览（无人值守先看这个）',
      '  node runner.mjs prune [--apply] [--logs]  清理历史运行记录（默认预演）',
      '  node runner.mjs doctor                   环境自检',
      '',
      '选项:',
      '  --params k=v,k2=v2        变量取值',
      '  --params-file <file.json> 从文件读变量',
      '  --headed                  显示浏览器窗口',
      '  --allow-lint-errors       忽略静态检查阻断项',
      '  --no-learn                不回写自愈定位符',
      '  --evidence always|failure|never',
      '  --trigger <名字>          触发来源（默认 cli）',
      '',
      '退出码: 0 成功 / 1 失败 / 2 阻断 / 3 用法错误',
    ].join('\n') + '\n');
    return 3;
  }

  if (cmd === 'list') {
    const flows = listFlows();
    if (!flows.length) { process.stdout.write('还没有任何流程。\n'); return 0; }
    for (const f of flows) {
      process.stdout.write(f.id + '  ' + f.name + '  steps=' + f.stepCount + ' params=' + f.paramCount + ' asserts=' + f.assertionCount + '  ' + (f.updatedAt || '') + '\n');
    }
    return 0;
  }

  if (cmd === 'doctor') {
    const cfg = readConfig();
    let pwOk = false, pwErr = null;
    try { const { getPlaywright } = await import('./lib/browser.mjs'); await getPlaywright(); pwOk = true; }
    catch (e) { pwErr = String(e && e.message ? e.message : e); }
    const { detectBrowserPlan } = await import('./lib/browser.mjs');
    const plan = detectBrowserPlan(cfg);
    process.stdout.write(JSON.stringify({
      node: process.version, playwright: pwOk ? 'ok' : 'FAILED: ' + pwErr,
      browser: plan, flows: listFlows().length, headless: cfg.browser.headless,
    }, null, 2) + '\n');
    return pwOk && plan.kind !== 'none' && plan.kind !== 'chromium-missing' ? 0 : 1;
  }

  if (cmd === 'show') {
    const flow = loadFlow(args._[0]);
    if (!flow) { process.stderr.write('流程不存在: ' + args._[0] + '\n'); return 3; }
    process.stdout.write(flowMarkdown(flow) + '\n');
    return 0;
  }

  if (cmd === 'history') {
    const runs = listRuns(args._[0], 20);
    process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'status') {
    const r = statusReport({ onlyProblems: !!args.flags.problems });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return r.summary.problematic > 0 ? 1 : 0;
  }

  if (cmd === 'prune') {
    const dryRun = !args.flags.apply;
    const out = {
      dryRun,
      runs: args._[0] ? [pruneRuns(args._[0], { dryRun })] : pruneAllRuns({ dryRun }),
      logs: args.flags.logs ? pruneLogs({ dryRun }) : undefined,
    };
    const removed = out.runs.reduce((s, x) => s + x.removed.length, 0) + (out.logs ? out.logs.removed.length : 0);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.stdout.write((dryRun ? '预演：将清理 ' : '已清理 ') + removed + ' 项（加 --apply 才会真正删除）\n');
    return 0;
  }

  if (cmd === 'preflight') {
    const flow = loadFlow(args._[0]);
    if (!flow) { process.stderr.write('流程不存在: ' + args._[0] + '\n'); return 3; }
    const r = await preflightFlow(flow, { headed: !!args.flags.headed });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return r.error ? 1 : 0;
  }

  if (cmd === 'run') {
    const flow = loadFlow(args._[0]);
    if (!flow) { process.stderr.write('流程不存在: ' + args._[0] + '\n'); return 3; }
    const rep = await runFlow(flow, {
      params: args.params,
      headed: !!args.flags.headed,
      allowLintErrors: !!args.flags['allow-lint-errors'],
      learn: args.flags['no-learn'] ? false : true,
      evidenceOn: args.flags.evidence,
      trigger: typeof args.flags.trigger === 'string' ? args.flags.trigger : 'cli',
    });
    process.stdout.write(print(rep) + '\n');
    return rep.status === 'pass' ? 0 : rep.status === 'blocked' ? 2 : 1;
  }

  if (cmd === 'chain') {
    const ids = args._.slice();
    if (!ids.length) { process.stderr.write('串联需要至少一个流程 id\n'); return 3; }
    const r = await runChain(ids.map((id) => ({ flow: id })), {
      headed: !!args.flags.headed,
      allowLintErrors: !!args.flags['allow-lint-errors'],
      notify: !!args.flags.notify,
      trigger: 'cli:chain',
    });
    process.stdout.write(JSON.stringify({ status: r.status, summary: r.summary, error: r.error, results: r.results, extracted: r.extracted }, null, 2) + '\n');
    return r.status === 'pass' ? 0 : r.status === 'blocked' ? 2 : 1;
  }

  process.stderr.write('未知命令: ' + cmd + '（用 node runner.mjs help 查看用法）\n');
  return 3;
}

main()
  .then(async (code) => { await closeAll(); process.exit(code || 0); })
  .catch(async (e) => {
    // stderr 会经定时包装器（>> logs/schedule-*.log）落盘，stack 同样脱敏后再写
    process.stderr.write('执行器异常: ' + redactPath(String(e && e.stack ? e.stack : e)) + '\n');
    await closeAll();
    process.exit(1);
  });
