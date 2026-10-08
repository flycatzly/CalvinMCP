/**
 * flaky-r42.mjs — flow-check F7 flaky 确定性取证台（r42）
 *
 * 方法（先取证后修，不猜）：
 *   1. 复跑 flow-check N 次（串行，隔离并行波干扰），逐 check 落 PASS/FAIL 矩阵；
 *   2. 每轮快照 .playwright-artifacts/reports/ 增量目录，把 collect-* 产物
 *      （report.json 的 stopReason/页账 pages[].added）归因到当轮 —— 拿到
 *      「失败时页账长什么样」的现场证据，区分 stale-eval / eval-failed / 态交互；
 *   3. 失败实例合成 Playwright 报告形状喂 summarizeFile 做签名聚类
 *      （偶发=同名 check 部分轮次失败、稳定红=全轮失败，口径与归因工具一致）；
 *   4. summary.md 落复现率 + 聚类 + 产物页账证据，结论只从证据出。
 *
 * 用法：node Temp/flaky-r42.mjs --runs 12 [--tag phaseA] [--concurrent 1]
 *   --sibling mcp/test/nl-agent-e2e.mjs = 每轮 flow-check 与兄弟套件同跑
 *     （还原 verify-all wave4 真实拓扑：CPU 竞争放大面；不用 --concurrent 2 自撞会话名）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const RUNS = Math.max(1, argNum('runs', 12));
const TAG = argStr('tag', 'phaseA');
const CONC = Math.max(1, argNum('concurrent', 1));
const SIBLING = argStr('sibling', ''); // 如 mcp/test/nl-agent-e2e.mjs —— wave4 真实兄弟
const RUN_TIMEOUT_MS = 300_000;

const REPORTS = path.join(ROOT, '.playwright-artifacts', 'reports');
fs.mkdirSync(EVID, { recursive: true });

const listReportDirs = () => {
  try {
    return new Set(fs.readdirSync(REPORTS).filter((d) => d.startsWith('collect-') || d.startsWith('explore-') || d.startsWith('nl-')));
  } catch {
    return new Set();
  }
};

/** 读一个产物目录的 report.json + 页账（现场证据：失败时 stopReason/added 分布）。 */
const readArtifact = (dir) => {
  const rp = path.join(REPORTS, dir, 'report.json');
  try {
    const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    const rows = r.files?.rows && fs.existsSync(r.files.rows) ? JSON.parse(fs.readFileSync(r.files.rows, 'utf8')) : null;
    return {
      dir,
      url: String(r.url || ''),
      verdict: r.verdict,
      stopReason: r.stopReason,
      pagesScanned: r.pagesScanned,
      rowCount: r.rowCount,
      pages: (rows?.pages || []).map((p) => ({ page: p.page, rowCount: p.rowCount, added: p.added, note: p.note || undefined })),
    };
  } catch {
    return { dir, unreadable: true };
  }
};

/** 跑一个套件子进程：返回 {code, text, err} */
const spawnSuite = (relPath, label) => new Promise((resolve) => {
  const chunks = [];
  const errChunks = [];
  const ch = spawn(process.execPath, [path.join(ROOT, relPath)], {
    cwd: ROOT, windowsHide: true,
    env: { ...process.env },
  });
  const killer = setTimeout(() => { try { ch.kill(); } catch { /* 已退 */ } }, RUN_TIMEOUT_MS);
  ch.stdout.on('data', (c) => chunks.push(c));
  ch.stderr.on('data', (c) => errChunks.push(c));
  ch.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, text: `spawn error: ${e.message}` }); });
  ch.on('close', (code) => {
    clearTimeout(killer);
    resolve({ code: code ?? -1, text: Buffer.concat(chunks).toString('utf8'), err: Buffer.concat(errChunks).toString('utf8'), label });
  });
});

/** 跑一次 flow-check：返回 {idx, ms, exit, checks:{name:PASS|FAIL}, failLines:[], artifacts:[]} */
const runOnce = async (idx) => {
  const before = listReportDirs();
  const logFile = path.join(EVID, `run-${TAG}-${String(idx).padStart(2, '0')}.log`);
  const t0 = Date.now();
  // Phase B 真实拓扑：与 wave4 兄弟套件同跑（CPU 竞争放大面）
  const siblingPromise = SIBLING
    ? spawnSuite(SIBLING, 'sibling')
    : null;
  const out = await spawnSuite('mcp/test/flow-check.mjs', 'flow-check');
  const sib = siblingPromise ? await siblingPromise : null;
  if (sib) fs.writeFileSync(path.join(EVID, `sibling-${TAG}-${String(idx).padStart(2, '0')}.log`), `${sib.text}\n--- stderr ---\n${sib.err || '(none)'}\n`, 'utf8');
  const ms = Date.now() - t0;
  const text = out.text;
  fs.writeFileSync(logFile, `${text}\n--- stderr ---\n${out.err || '(none)'}\n`, 'utf8');

  const checks = {};
  const failLines = [];
  for (const line of text.split('\n')) {
    const m = /^(PASS|FAIL)\s+(.*)$/.exec(line);
    if (!m) continue;
    const name = m[2].trim();
    checks[name] = m[1];
    if (m[1] === 'FAIL') failLines.push(name);
  }

  // 增量产物归因：本轮新出现的 collect-*/explore-*/nl-* 目录
  const after = listReportDirs();
  const artifacts = [...after].filter((d) => !before.has(d)).map(readArtifact);
  return {
    idx, ms, exit: out.code, checks, failLines, artifacts, logFile,
    skippedEnv: /SKIP（缺可选依赖/.test(text),
    completed: /flow-check：/.test(text),
    siblingExit: sib ? sib.code : undefined,
  };
};

console.log(`[flaky-r42] tag=${TAG} runs=${RUNS} concurrent=${CONC} sibling=${SIBLING || '无'} evidence=${EVID}`);
const runs = [];
for (let batch = 0; batch < RUNS; batch += CONC) {
  const group = [];
  for (let k = 0; k < CONC && batch + k < RUNS; k++) {
    const idx = batch + k + 1;
    console.log(`[flaky-r42] run ${idx}/${RUNS} ...`);
    group.push(runOnce(idx));
  }
  runs.push(...await Promise.all(group));
}

// ---- 矩阵：check 名 → 每轮 PASS/FAIL ----
const allNames = [...new Set(runs.flatMap((r) => Object.keys(r.checks)))];
const matrix = {};
for (const n of allNames) matrix[n] = runs.map((r) => r.checks[n] || '—');

const flakyChecks = allNames.filter((n) => {
  const v = matrix[n].filter((x) => x !== '—');
  return v.includes('FAIL') && v.includes('PASS');
});
const hardFailChecks = allNames.filter((n) => {
  const v = matrix[n].filter((x) => x !== '—');
  return v.length > 0 && v.every((x) => x === 'FAIL');
});

fs.writeFileSync(path.join(EVID, `matrix-${TAG}.json`), JSON.stringify({
  tag: TAG, runs: RUNS, concurrent: CONC,
  runMeta: runs.map((r) => ({ idx: r.idx, ms: r.ms, exit: r.exit, completed: r.completed, skippedEnv: r.skippedEnv, siblingExit: r.siblingExit, failLines: r.failLines })),
  matrix, flakyChecks, hardFailChecks,
}, null, 2), 'utf8');

// ---- 现场证据汇总：每个 run 的 collect 产物页账（重点 /static /inf）----
const artifactDump = runs.map((r) => ({
  idx: r.idx,
  artifacts: r.artifacts.filter((a) => /\/(static|inf|paged)/.test(a.url || '') || a.unreadable),
}));
fs.writeFileSync(path.join(EVID, `artifacts-${TAG}.json`), JSON.stringify(artifactDump, null, 2), 'utf8');

// ---- 合成 Playwright 报告喂 summarizeFile（签名聚类定性）----
// 映射口径：一个 check 名 = 一个 spec；每轮结果 = results 里的一次 attempt
// （失败轮 status:failed 且带 FAIL 行文本；通过轮 status:passed）。
// 全轮失败=确定失败进聚类；部分轮失败=偶发进 flakes —— 与归因工具语义同构。
const failingNames = [...flakyChecks, ...hardFailChecks];
const stats = {
  expected: 0, unexpected: hardFailChecks.length, flaky: flakyChecks.length, skipped: 0,
  duration: runs.reduce((n, r) => n + r.ms, 0),
};
const sigReport = {
  stats,
  suites: failingNames.map((name) => ({
    title: 'flow-check',
    file: 'mcp/test/flow-check.mjs',
    specs: [{
      title: name,
      file: 'mcp/test/flow-check.mjs',
      tests: [{
        status: hardFailChecks.includes(name) ? 'expected' : 'flaky',
        results: runs.map((r) => (r.checks[name] === 'FAIL'
          ? { status: 'failed', duration: r.ms, errors: [{ message: `FAIL ${name}（run-${String(r.idx).padStart(2, '0')}）` }] }
          : { status: 'passed', duration: r.ms })),
      }],
    }],
  })),
};
const sigFile = path.join(EVID, `signature-input-${TAG}.json`);
fs.writeFileSync(sigFile, JSON.stringify(sigReport, null, 2), 'utf8');

let clusterInfo = { error: 'no failures — 没有失败实例可聚类' };
if (failingNames.length) {
  try {
    const { summarizeFile } = await import(pathToFileURL(path.join(ROOT, 'mcp', 'lib', 'signature.js')).href);
    clusterInfo = summarizeFile(sigFile);
    fs.writeFileSync(path.join(EVID, `clusters-${TAG}.json`), JSON.stringify(clusterInfo, null, 2), 'utf8');
  } catch (e) {
    clusterInfo = { error: `summarizeFile 失败：${e.message}` };
  }
}

// ---- summary.md ----
const failCounts = {};
for (const n of allNames) failCounts[n] = matrix[n].filter((x) => x === 'FAIL').length;
const interesting = allNames.filter((n) => failCounts[n] > 0);
const md = [
  `# F7 flaky 取证 — ${TAG}（${new Date().toISOString()}）`,
  '',
  `- 轮数 ${RUNS}（并发度 ${CONC}，兄弟套件 ${SIBLING || '无'}）；总失败实例 ${interesting.reduce((n, k) => n + failCounts[k], 0)}`,
  `- 稳定红（全轮失败）：${hardFailChecks.length ? hardFailChecks.join('；') : '无'}`,
  `- 偶发（部分轮失败）：${flakyChecks.length ? flakyChecks.join('；') : '无'}`,
  `- 每轮耗时：${runs.map((r) => `${r.idx}:${(r.ms / 1000).toFixed(1)}s${r.exit === 0 ? '' : `(exit=${r.exit})`}`).join(' ')}`,
  '',
  '## 复现率（失败轮/总轮）',
  '',
  ...interesting.map((n) => `- ${failCounts[n]}/${matrix[n].filter((x) => x !== '—').length} — ${n}`),
  ...(interesting.length ? [] : ['- 0/N — 本轮全部 check 绿（复现率 0）']),
  '',
  '## 签名聚类（summarizeFile）',
  '',
  '```json',
  JSON.stringify(clusterInfo.clusters ? {
    headline: clusterInfo.headline,
    totals: clusterInfo.totals,
    clusters: clusterInfo.clusters.map((c) => ({ signature: c.signature, category: c.categoryLabel, count: c.count, tests: c.tests })),
    flakes: (clusterInfo.flakes || []).map((f) => ({ title: f.title, category: f.categoryLabel, signature: f.signature })),
  } : clusterInfo, null, 2),
  '```',
  '',
  '## 现场证据（失败轮 collect 产物页账）',
  '',
  ...artifactDump.flatMap((d) => {
    const bad = d.artifacts.filter((a) => /\/(static|inf)/.test(a.url || ''));
    if (!bad.length) return [];
    return [
      `### run-${String(d.idx).padStart(2, '0')}`,
      ...bad.map((a) => `- ${a.url} → stop=${a.stopReason} pages=${JSON.stringify(a.pages)}（${a.dir}）`),
    ];
  }),
  '',
  '## 轮次 FAIL 行全文',
  '',
  ...runs.flatMap((r) => (r.failLines.length ? [`- run-${String(r.idx).padStart(2, '0')}:`, ...r.failLines.map((l) => `  - ${l}`)] : [])),
  '',
].join('\n');
fs.writeFileSync(path.join(EVID, `summary-${TAG}.md`), md, 'utf8');

console.log(`[flaky-r42] done. flaky=${flakyChecks.length ? flakyChecks.join(';') : '无'} hard=${hardFailChecks.length ? hardFailChecks.join(';') : '无'}`);
console.log(`[flaky-r42] summary → ${path.join(EVID, `summary-${TAG}.md`)}`);
