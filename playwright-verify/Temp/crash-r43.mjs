#!/usr/bin/env node
/**
 * crash-r43.mjs — 0xC0000409 串行 fail-fast 取证 campaign（r43 指派点）
 *
 * 用法：node Temp/crash-r43.mjs A|B|C|D [次数]
 *   A = nl-agent-check 单跑 ×N        —— 套件本征基线（串行隔离道）
 *   B = verify-all --mode 1 --parallel ×N —— 轻波拓扑（W4 里 nl-agent-check 实际独跑）
 *   C = verify-all --mode 3 --parallel ×N —— r42 原崩溃条件（W4 三件套真跑：nl-agent-check
 *       + nl-agent-e2e + flow-check 并发，浏览器 CLI/msedge/回环桩同起）
 *   D = W4 三件套靶向 ×N（偶数轮先跑浏览器波暖机，检验「前波残留」假设）
 *
 * 取证纪律：
 *   - 每轮日志立即落盘 Temp/crash-r43-evidence/（不靠留存帽）
 *   - 1Hz 场景采样：freemem / node·msedge·frida-helper 进程数 / node.exe 是否载入
 *     frida-agent.dll（事件日志已实证 frida-helper 常驻且 frida-agent 曾注入 Weixin.exe）
 *   - 崩溃判定双通道：退出码 ∈ 已知原生崩溃码集，或输出含「进程崩溃」行
 *   - 每轮记录并行会话活动（其他 verify-all 进程），污染如实入档
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EV = path.join(ROOT, 'Temp', 'crash-r43-evidence');
fs.mkdirSync(EV, { recursive: true });

// suites.crashLabel 同表（无符号 32 位）：0xC0000409/0xC0000005/0xC00000FD/0x80000003/134/139
const CRASH_CODES = new Set([3221226505, 3221225477, 3221225725, 2147483651, 134, 139]);
const CRASH_LINE = /进程崩溃|异常退出（退出码/;

const phase = (process.argv[2] || '').toUpperCase();
const N = Number(process.argv[3]) || 0;
if (!['A', 'B', 'C', 'D'].includes(phase)) {
  console.error('用法：node Temp/crash-r43.mjs A|B|C|D [次数]');
  process.exit(2);
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ code: -1, out: `${out}\n[spawn error] ${e.message}` }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

/** 一次场景快照：内存/进程面/frida 证据/并行会话活动 */
async function sampleScene(tag) {
  const [ps] = await Promise.all([
    sh('powershell', ['-NoProfile', '-Command',
      `$n=(Get-Process node -ErrorAction SilentlyContinue).Count;`
      + `$e=(Get-Process msedge -ErrorAction SilentlyContinue).Count;`
      + `$f=(Get-Process 'frida-helper*' -ErrorAction SilentlyContinue).Count;`
      + `$va=(Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -match 'verify-all' }).Count;`
      + `$mods = tasklist /m /fi \"IMAGENAME eq node.exe\" 2>$null | Select-String -Pattern 'frida|easyhook|detours' -SimpleMatch:$false;`
      + `Write-Output \"$n $e $f $va $($mods.Count)\"`]),
  ]);
  const parts = (ps.out || '').trim().split(/\s+/).map((x) => Number(x));
  const [nodeN = -1, edgeN = -1, fridaN = -1, vaN = -1, susMods = -1] = parts;
  const fm = os.freemem();
  return { tag, ts: new Date().toISOString(), freememGB: +(fm / 1e9).toFixed(2), nodeN, edgeN, fridaN, verifyAllConcurrent: vaN, suspiciousModuleHits: susMods };
}

/** 1Hz 场景采样器 → JSONL 立即落盘 */
function startSampler(file) {
  let stop = false;
  const lines = [];
  const tick = async () => {
    if (stop) return;
    const s = await sampleScene('tick');
    lines.push(JSON.stringify(s));
    fs.appendFileSync(file, `${JSON.stringify(s)}\n`);
    if (!stop) setTimeout(tick, 1000);
  };
  tick();
  return { stop: () => { stop = true; return lines; } };
}

function runNodeScript(scriptRel, args, { env = {}, logName } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const logFile = path.join(EV, logName);
    const p = spawn(process.execPath, [path.join(ROOT, scriptRel), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => {
      out += `\n[spawn error] ${e.message}`;
      fs.writeFileSync(logFile, out);
      resolve({ exitCode: -1, ms: Date.now() - started, logFile, out });
    });
    p.on('close', (code) => {
      fs.writeFileSync(logFile, out); // 立即落盘：崩溃现场不等收尾
      resolve({ exitCode: code, ms: Date.now() - started, logFile, out });
    });
  });
}

function crashInfoFromExit(exitCode, out) {
  const u = exitCode >>> 0;
  const codeHit = CRASH_CODES.has(u);
  const lineHit = CRASH_LINE.test(out);
  const crashed = codeHit || (exitCode !== 0 && lineHit && /无 FAIL 行/.test(out));
  const lines = out.split('\n').filter((l) => CRASH_LINE.test(l) || /FATAL ERROR/.test(l));
  return { crashed, exitCode, unsignedExit: u, codeHit, evidenceLines: lines.slice(0, 20) };
}

const runs = [];
const defaults = { A: 20, B: 12, C: 6, D: 6 };
const count = N > 0 ? N : defaults[phase];
const base = phase === 'A' ? 'standalone'
  : phase === 'B' ? 'mode1-parallel'
    : phase === 'C' ? 'mode3-parallel'
      : 'w4-trio';

console.log(`campaign phase ${phase}（${base}）× ${count} — 证据目录 ${EV}`);
const campaignSampler = startSampler(path.join(EV, `scene-${base}.jsonl`));

for (let i = 1; i <= count; i++) {
  const id = `${base}-${String(i).padStart(2, '0')}`;
  const before = await sampleScene(`${id}-before`);
  let r;
  let crash;
  let warm = null;

  if (phase === 'A') {
    r = await runNodeScript('mcp/test/nl-agent-check.mjs', [], { logName: `${id}.log` });
    crash = crashInfoFromExit(r.exitCode, r.out);
  } else if (phase === 'B' || phase === 'C') {
    const mode = phase === 'B' ? '1' : '3';
    r = await runNodeScript('mcp/test/verify-all.mjs', ['--mode', mode, '--parallel'], { logName: `${id}.log` });
    const crashLines = r.out.split('\n').filter((l) => CRASH_LINE.test(l));
    crash = { crashed: crashLines.length > 0, exitCode: r.exitCode, unsignedExit: r.exitCode >>> 0, evidenceLines: crashLines };
  } else {
    // D：W4 三件套靶向并发（镜像 mode 3 波内构成）；偶数轮先暖机（浏览器波残留假设）
    if (i % 2 === 0) {
      console.log(`  [${id}] 暖机：浏览器三件并发（cli-e2e/orchestrate-e2e/args-check）`);
      warm = await Promise.all([
        runNodeScript('mcp/test/cli-e2e.mjs', [], { env: { PWVERIFY_UNDER_HARNESS: '1' }, logName: `${id}-warm-cli.log` }),
        runNodeScript('mcp/test/orchestrate-e2e.mjs', [], { env: { PWVERIFY_UNDER_HARNESS: '1' }, logName: `${id}-warm-orch.log` }),
        runNodeScript('mcp/test/args-check.mjs', [], { env: { PWVERIFY_UNDER_HARNESS: '1' }, logName: `${id}-warm-args.log` }),
      ]);
    }
    console.log(`  [${id}] 三件套并发：nl-agent-check + nl-agent-e2e + flow-check`);
    const trio = await Promise.all([
      runNodeScript('mcp/test/nl-agent-check.mjs', [], { env: { PWVERIFY_UNDER_HARNESS: '1' }, logName: `${id}-nl.log` }),
      runNodeScript('mcp/test/nl-agent-e2e.mjs', [], { env: { PWVERIFY_UNDER_HARNESS: '1' }, logName: `${id}-nle.log` }),
      runNodeScript('mcp/test/flow-check.mjs', [], { env: { PWVERIFY_UNDER_HARNESS: '1' }, logName: `${id}-flow.log` }),
    ]);
    // 收尾 reap（镜像 verify-all：套件在 harness 标记下不自割）
    const { runCli } = await import(path.join(ROOT, 'mcp/lib/cli.js')).catch(() => ({}));
    if (runCli) { try { await runCli({ cwd: ROOT, session: 'crash-r43-reap', subcommand: 'kill-all', args: [], timeoutMs: 30_000 }); } catch { /* 尽力而为 */ } }
    r = { ms: Math.max(...trio.map((x) => x.ms)), out: trio.map((x, idx) => `--- trio[${idx}] exit=${x.exitCode} ---\n${x.out}`).join('\n'), exitCode: trio.some((x) => crashInfoFromExit(x.exitCode, x.out).crashed) ? 1 : 0, logFile: null, trio: trio.map((x, idx) => ({ idx, exitCode: x.exitCode, ms: x.ms, logFile: x.logFile, crash: crashInfoFromExit(x.exitCode, x.out) })) };
    crash = { crashed: r.trio.some((t) => t.crash.crashed), exitCode: r.exitCode, evidenceLines: r.trio.flatMap((t) => t.crash.evidenceLines) };
  }

  const after = await sampleScene(`${id}-after`);
  // 崩溃时抢救性快照：全量 node 模块面（frida 证据）+ 事件日志增量
  let rescue = null;
  if (crash.crashed) {
    console.log(`  [${id}] ★ 崩溃检出 — 抢救现场`);
    const mods = await sh('tasklist', ['/m', '/fi', 'IMAGENAME eq node.exe']);
    fs.writeFileSync(path.join(EV, `${id}-rescue-node-modules.log`), mods.out);
    const ev = await sh('powershell', ['-NoProfile', '-Command',
      "Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue | ForEach-Object { $_.TimeCreated.ToString('s') + ' ' + (($_.Message -split \"`r?`n\")[0..5] -join ' | ') }"]);
    fs.writeFileSync(path.join(EV, `${id}-rescue-eventlog.txt`), ev.out);
    rescue = { modulesLog: `${id}-rescue-node-modules.log`, eventLog: `${id}-rescue-eventlog.txt` };
  }

  const rec = {
    id, phase, base, i,
    ms: r.ms, exitCode: r.exitCode,
    crashed: crash.crashed,
    unsignedExit: crash.unsignedExit ?? (r.exitCode >>> 0),
    evidenceLines: (crash.evidenceLines || []).slice(0, 20),
    before, after,
    logFile: r.logFile ? path.basename(r.logFile) : null,
    trio: r.trio || null,
    warm: warm ? warm.map((w) => ({ exitCode: w.exitCode, ms: w.ms })) : null,
    rescue,
  };
  runs.push(rec);
  fs.writeFileSync(path.join(EV, `runs-${base}.json`), JSON.stringify(runs, null, 2));
  console.log(`  [${id}] exit=${r.exitCode} ${(r.ms / 1000).toFixed(1)}s crashed=${crash.crashed} freemem ${before.freememGB}→${after.freememGB}GB node ${before.nodeN}→${after.nodeN} fridaHelper ${before.fridaN} susMods ${before.suspiciousModuleHits}/${after.suspiciousModuleHits} verifyAllConcurrent ${before.verifyAllConcurrent}/${after.verifyAllConcurrent}`);
}

campaignSampler.stop();
const crashRuns = runs.filter((r) => r.crashed);
console.log(`\n== phase ${phase}（${base}）汇总：${runs.length} 跑，崩溃 ${crashRuns.length} ==`);
for (const c of crashRuns) console.log(`  ★ ${c.id} exit=${c.unsignedExit}（0x${(c.unsignedExit >>> 0).toString(16).toUpperCase()}） ${(c.ms / 1000).toFixed(1)}s freemem ${c.before.freememGB}GB`);
fs.writeFileSync(path.join(EV, `summary-${base}.md`), [
  `# phase ${phase}（${base}）× ${runs.length} — ${new Date().toISOString()}`,
  '',
  `崩溃 ${crashRuns.length}/${runs.length}`,
  '',
  ...runs.map((r) => `- ${r.id}: exit=${r.exitCode} ${(r.ms / 1000).toFixed(1)}s crashed=${r.crashed} freemem ${r.before.freememGB}→${r.after.freememGB}GB node ${r.before.nodeN}→${r.after.nodeN} frida ${r.before.fridaN}→${r.after.fridaN} susMods ${r.before.suspiciousModuleHits}/${r.after.suspiciousModuleHits} va ${r.before.verifyAllConcurrent}/${r.after.verifyAllConcurrent}${r.crashed ? `\n  - ${(r.evidenceLines || []).join('\n  - ')}` : ''}`),
].join('\n'));
process.exit(crashRuns.length ? 0 : 0); // 取证台恒 exit 0：崩溃是数据不是本脚本失败
