#!/usr/bin/env node
/**
 * storm-r43.mjs — Phase E：合成启动风暴 vs nl-agent-check ×N
 *
 * 假设定性（r43 campaign 的最后一个实验）：w4-trio-03 崩溃的场景采样显示
 * 崩溃发生在兄弟套件的 msedge 进程爆增窗口（edge 43→60+，2 秒内），
 * 本实验隔离「进程爆增本身」是否足以触发 0xC0000409：
 *   - 对照：nl-agent-check 单跑（已知 0/20）
 *   - 实验：nl-agent-check 与「3 × msedge headless 常驻 + node 进程抖动风暴」并发
 * 每轮：起风暴 → 风暴峰值期跑 nl-agent-check → 停风暴 → 记录退出码。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EV = path.join(ROOT, 'Temp', 'crash-r43-evidence');
fs.mkdirSync(EV, { recursive: true });
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const N = Number(process.argv[2]) || 8;
const CRASH_CODES = new Set([3221226505, 3221225477, 3221225725, 2147483651, 134, 139]);

function countProc(name) {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', `(Get-Process ${name} -ErrorAction SilentlyContinue).Count`], { windowsHide: true });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.on('close', () => resolve(Number(o.trim()) || 0));
  });
}

const runs = [];
for (let i = 1; i <= N; i++) {
  const id = `storm-${String(i).padStart(2, '0')}`;
  // 风暴：3 个 headless msedge 常驻（每个 ~30 子进程）+ node 进程抖动
  const edges = [0, 1, 2].map(() => spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' }));
  const churn = [];
  let churnStop = false;
  const churnTick = () => {
    if (churnStop) return;
    for (let k = 0; k < 5; k++) {
      const c = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
      c.on('close', () => {});
      churn.push(c);
    }
    setTimeout(churnTick, 400);
  };
  churnTick();
  await new Promise((r) => setTimeout(r, 2500)); // 等风暴成型
  const edgeAtPeak = await countProc('msedge');
  const nodeAtPeak = await countProc('node');

  const t0 = Date.now();
  const run = await new Promise((resolve) => {
    const logFile = path.join(EV, `${id}-nl.log`);
    const p = spawn(process.execPath, [path.join(ROOT, 'mcp/test/nl-agent-check.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => { fs.writeFileSync(logFile, out); resolve({ code, ms: Date.now() - t0, out }); });
  });

  churnStop = true;
  for (const e of edges) { try { e.kill(); } catch { /* 已退出 */ } }
  await new Promise((r) => setTimeout(r, 800));

  const crashed = CRASH_CODES.has(run.code >>> 0);
  const passN = (run.out.match(/^PASS/gm) || []).length;
  runs.push({ id, exitCode: run.code, ms: run.ms, crashed, passN, edgeAtPeak, nodeAtPeak, passTail: run.out.split('\n').filter((l) => l.startsWith('PASS') || l.startsWith('===')).slice(-4) });
  fs.writeFileSync(path.join(EV, 'runs-storm.json'), JSON.stringify(runs, null, 2));
  console.log(`[${id}] exit=${run.code}（0x${(run.code >>> 0).toString(16).toUpperCase()}） ${(run.ms / 1000).toFixed(1)}s crashed=${crashed} PASS=${passN} 峰值 edge=${edgeAtPeak} node=${nodeAtPeak}`);
}
const c = runs.filter((r) => r.crashed).length;
console.log(`\n== Phase E 合成风暴：${runs.length} 跑，崩溃 ${c} ==`);
fs.writeFileSync(path.join(EV, 'summary-storm.md'), `# Phase E 合成启动风暴 × ${runs.length} — ${new Date().toISOString()}\n\n崩溃 ${c}/${runs.length}\n\n`
  + runs.map((r) => `- ${r.id}: exit=${r.exitCode} ${(r.ms / 1000).toFixed(1)}s crashed=${r.crashed} PASS=${r.passN} peak edge=${r.edgeAtPeak} node=${r.nodeAtPeak}`).join('\n') + '\n');
