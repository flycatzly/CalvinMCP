// r37 H26 复现台：裸 process.exit(0) 的假 CLI 骗 cli_health 出「最小闭环通过」假绿。
// 桩放在 cwd/node_modules/@playwright/cli/playwright-cli.js —— 本地解析第一优先（runner.js:203），
// 与机器全局/PATH 无关，任何机器上行为一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliHealthCheck, runCli } from '../mcp/lib/cli.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-h26-repro-'));
const stubDir = path.join(cwd, 'node_modules', '@playwright', 'cli');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'playwright-cli.js'), 'process.exit(0);\n');

console.log('== 场景 A：cliHealthCheck + 裸 exit(0) 桩（无任何产物落盘）==');
const health = await cliHealthCheck({ cwd, session: 'h26repro' });
console.log(JSON.stringify({
  ok: health.ok,
  verdict: health.verdict,
  steps: health.steps?.map((s) => ({ step: s.step, ok: s.ok, summary: s.summary })),
}, null, 2));

console.log('\n== 场景 B：runCli snapshot + 同一桩（产物文件根本不存在）==');
const snap = await runCli({ cwd, session: 'h26repro', subcommand: 'snapshot', args: [] });
const claimed = snap.artifacts?.snapshot;
console.log(JSON.stringify({
  ok: snap.ok,
  reason: snap.reason,
  summary: snap.summary,
  claimedPath: claimed,
  claimedExists: claimed ? fs.existsSync(claimed) : null,
}, null, 2));

fs.rmSync(cwd, { recursive: true, force: true });
console.log('\n（若 ok:true / "最小闭环通过" / "快照已落盘" 而 claimedExists:false —— H26 盲区成立）');
