/**
 * flaky-r42c.mjs — Phase C：verify-all mode 3 整链复现台（r42）
 *
 * Phase A（20 轮串行隔离）/ Phase B（10 对 wave4 拓扑）均 0 复现，
 * r39 历史现场是「mode 3 整链」——16 套件先跑的 harness 态 + 波内并发。
 * 本台在该精确环境复跑：逐轮落 verify-all 全输出，解析套件 ✓/✗ 行与其
 * FAIL 明细行（verify-all 只对失败套件打 failedLines，正好是签名），
 * 失败轮 verify-all 自身「只在失败时保留产物」→ 页账现场自动留档。
 *
 * 用法：node Temp/flaky-r42c.mjs --runs 4 --tag verifySerial [--parallel]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EVID = path.join(__dirname, 'flaky-r42-evidence');

const argv = process.argv.slice(2);
const argNum = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const argStr = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const RUNS = Math.max(1, argNum('runs', 4));
const TAG = argStr('tag', 'verifySerial');
const PARALLEL = argv.includes('--parallel');
const RUN_TIMEOUT_MS = 600_000;
fs.mkdirSync(EVID, { recursive: true });

const runOnce = async (idx) => {
  const logFile = path.join(EVID, `run-${TAG}-${String(idx).padStart(2, '0')}.log`);
  const t0 = Date.now();
  const args = [path.join(ROOT, 'mcp', 'test', 'verify-all.mjs'), '--mode', '3'];
  if (PARALLEL) args.push('--parallel');
  const out = await new Promise((resolve) => {
    const chunks = [];
    const errChunks = [];
    const ch = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env: { ...process.env } });
    const killer = setTimeout(() => { try { ch.kill(); } catch { /* 已退 */ } }, RUN_TIMEOUT_MS);
    ch.stdout.on('data', (c) => chunks.push(c));
    ch.stderr.on('data', (c) => errChunks.push(c));
    ch.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, text: `spawn error: ${e.message}` }); });
    ch.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, text: Buffer.concat(chunks).toString('utf8'), err: Buffer.concat(errChunks).toString('utf8') });
    });
  });
  const ms = Date.now() - t0;
  fs.writeFileSync(logFile, `${out.text}\n--- stderr ---\n${out.err || '(none)'}\n`, 'utf8');

  // 解析套件结果行与失败明细：✓/✗/− <name> — <detail>（Ns）
  const suites = [];
  let cur = null;
  for (const line of out.text.split('\n')) {
    const m = /^([✓✗−]) (.+?) — (.*)$/.exec(line);
    if (m) {
      cur = { mark: m[1], name: m[2], detail: m[3], failLines: [] };
      suites.push(cur);
    } else if (cur && /^ {4}\S/.test(line)) {
      cur.failLines.push(line.trim());
    }
  }
  return {
    idx, ms, exit: out.code, logFile,
    flow: suites.filter((s) => s.name.includes('全流程验证')),
    failed: suites.filter((s) => s.mark === '✗'),
    judgment: (out.text.match(/^判据.*$/m) || [])[0] || '',
  };
};

console.log(`[flaky-r42c] tag=${TAG} runs=${RUNS} parallel=${PARALLEL} evidence=${EVID}`);
const runs = [];
for (let i = 1; i <= RUNS; i++) {
  console.log(`[flaky-r42c] run ${i}/${RUNS} ...`);
  runs.push(await runOnce(i));
}

const flowFlaky = runs.filter((r) => r.flow.some((f) => f.mark === '✗'));
const otherFailed = runs.filter((r) => r.failed.some((f) => !f.name.includes('全流程验证')));
const md = [
  `# Phase C verify-all mode3 整链复现 — ${TAG}（${new Date().toISOString()}）`,
  '',
  `- 轮数 ${RUNS}（--parallel=${PARALLEL}）；flow-check 红轮 ${flowFlaky.length}/${RUNS}；其他套件红轮 ${otherFailed.length}/${RUNS}`,
  `- 每轮耗时：${runs.map((r) => `${r.idx}:${(r.ms / 1000).toFixed(0)}s${r.exit === 0 ? '' : `(exit=${r.exit})`}`).join(' ')}`,
  `- 判据行：${[...new Set(runs.map((r) => r.judgment))].join(' | ')}`,
  '',
  '## flow-check 结果',
  '',
  ...runs.map((r) => `- run-${String(r.idx).padStart(2, '0')}: ${r.flow.map((f) => `${f.mark} ${f.detail}`).join('；') || '(未见套件行)'}`),
  '',
  '## 失败明细（签名源）',
  '',
  ...runs.flatMap((r) => {
    const bad = r.failed;
    if (!bad.length) return [];
    return [`### run-${String(r.idx).padStart(2, '0')}`, ...bad.flatMap((f) => [`- ${f.mark} ${f.name} — ${f.detail}`, ...f.failLines.map((l) => `  - ${l}`)])];
  }),
  ...(runs.some((r) => r.failed.length) ? [] : ['- 全部轮次无 ✗ 行（0 复现）']),
  '',
].join('\n');
fs.writeFileSync(path.join(EVID, `summary-${TAG}.md`), md, 'utf8');
fs.writeFileSync(path.join(EVID, `runs-${TAG}.json`), JSON.stringify(runs.map((r) => ({
  idx: r.idx, ms: r.ms, exit: r.exit, judgment: r.judgment,
  flow: r.flow, failed: r.failed,
})), null, 2), 'utf8');
console.log(`[flaky-r42c] done. flow红轮=${flowFlaky.length}/${RUNS} 其他红轮=${otherFailed.length}/${RUNS} → summary-${TAG}.md`);
