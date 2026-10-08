#!/usr/bin/env node
/**
 * needle-r45.mjs — findRefByNeedle「快照未产出」瞬断取证探针 v2（r45 指派点）
 *
 * 与 r42 探针（Temp/flaky-r42d.mjs）的协议保持同形（同 fixture、同调用序、
 * 同 session 命名形态、inf/static 交替、idle/load 两态），补齐 r42 的取证缺口：
 *   1) runCliImpl 包裹注入 findRefByNeedle —— 每次 snapshot 调用的完整返回
 *      （ok/reason/summary/timedOut/artifacts/logFiles）全量记录，零产品改动；
 *   2) 失败即时抢救：把 runCli 的 stdout/stderr 日志**当场拷贝**出留存帽辖区
 *      （r42 死因日志就是被 ~11 会话留存帽清空的）；
 *   3) 迟 stat：失败后 500ms/2000ms 两次复查声称路径（区分「没写」与「写了又被删」）；
 *   4) 重试一次：区分瞬断（重试即好）与持续（重试仍败）；
 *   5) 每迭代 JSONL **追加落盘**（进程中途死也不丢已采样本）。
 *
 * 判定分支（对齐 runCli 证据面 H26 / judgeRunEvidence）：
 *   - wrapper 记录里 snapshot.ok=false + reason=ARTIFACT_MISSING → CLI 端就没写成
 *   - snapshot.ok=true 但 findRefByNeedle 仍报快照未产出 → 写成后消失（外部删除者）
 *   - reason=CLI_REPORTED_ERROR / 超时 → daemon/CLI 侧失败，日志里有真因
 *
 * 用法：node Temp/needle-r45.mjs --iters 60 [--load] [--tag idle]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EVID = path.join(__dirname, 'needle-r45-evidence');
fs.mkdirSync(EVID, { recursive: true });

const argv = process.argv.slice(2);
const argNum = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt; };
const argStr = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const ITERS = Math.max(1, argNum('iters', 60));
const LOAD = argv.includes('--load');
const TAG = argStr('tag', LOAD ? 'load' : 'idle');

const { runCli } = await import(pathToFileURL(path.join(ROOT, 'mcp', 'lib', 'cli.js')).href);
const { findRefByNeedle } = await import(pathToFileURL(path.join(ROOT, 'mcp', 'lib', 'heal.js')).href);
const SNAP_DIR = path.join(ROOT, '.playwright-artifacts', 'snapshots');

const truncate = (v, d = 0) => {
  if (v == null || typeof v !== 'object') return typeof v === 'string' && v.length > 1500 ? `${v.slice(0, 1500)}…[trunc]` : v;
  if (d > 4) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => truncate(x, d + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = truncate(x, d + 1);
  return o;
};

/* ---- fixture：与 r42 探针逐字同形 ---- */
const page = (body) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>probe</title></head><body>${body}</body></html>`;
const staticRows = Array.from({ length: 5 }, (_, i) => `<tr><td>S${i + 1}</td><td>静态${i + 1}</td></tr>`).join('');
const site = http.createServer((req, res) => {
  const [p, q] = String(req.url || '/').split('?');
  const n = Number(new URLSearchParams(q || '').get('page') || '1');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (p === '/static') {
    return res.end(page(`<table><tbody>${staticRows}</tbody></table>
      <form action="/static" method="get"><label for="page">页码</label><input id="page" name="page" value="${n}"><button type="submit">跳转</button></form>`));
  }
  const rows = Array.from({ length: 5 }, (_, i) => `<tr><td>I${n}-${i}</td><td>无限${n}-${i}</td></tr>`).join('');
  return res.end(page(`<table><tbody>${rows}</tbody></table>
    <form action="/inf" method="get"><label for="page">页码</label><input id="page" name="page" value="${n}"><button type="submit">跳转</button></form>`));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const burners = [];
if (LOAD) {
  for (let i = 0; i < 2; i++) {
    burners.push(spawn(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<900000){Math.sqrt(Math.random());}'], { windowsHide: true }));
  }
}

const evalJs = async (session, code, which) => {
  const evFile = path.join(EVID, `eval-${session}-${which}.json`);
  try { fs.rmSync(evFile, { force: true }); } catch { /* 无残留 */ }
  const r = await runCli({ cwd: ROOT, session, subcommand: 'eval', args: [code, '--filename', evFile], timeoutMs: 30_000 });
  let raw = null;
  try { raw = fs.readFileSync(evFile, 'utf8'); } catch {
    try { raw = fs.readFileSync(r.logFiles?.stdout, 'utf8'); } catch { return null; }
  }
  const unwrap = (v, d = 0) => {
    if (d > 3) return null;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } return typeof v === 'string' ? unwrap(v, d + 1) : v; }
    if (v && typeof v === 'object') { for (const k of ['result', 'stdout', 'content', 'data']) { if (v[k] !== undefined) return unwrap(v[k], d + 1); } }
    return v;
  };
  try { return unwrap(JSON.parse(raw)); } catch { return null; }
};

/** 失败即时抢救：日志拷出留存帽辖区 + 声称路径 stat + 目录清单 */
const rescue = (session, tag, snapRes) => {
  const out = { tag, ts: new Date().toISOString() };
  try {
    const files = fs.readdirSync(SNAP_DIR).filter((f) => f.startsWith(`${session}-`));
    out.sessionSnapFiles = files;
  } catch { out.sessionSnapFiles = 'DIR_UNREADABLE'; }
  try { out.snapDirTotal = fs.readdirSync(SNAP_DIR).length; } catch { out.snapDirTotal = -1; }
  const claimed = snapRes?.artifacts?.snapshot;
  out.claimed = claimed || null;
  if (claimed) {
    try { const st = fs.statSync(claimed); out.claimedStat = { exists: true, size: st.size, mtime: st.mtimeMs }; }
    catch { out.claimedStat = { exists: false }; }
  }
  for (const [k, f] of Object.entries({ stdout: snapRes?.logFiles?.stdout, stderr: snapRes?.logFiles?.stderr })) {
    if (!f) continue;
    const dst = path.join(EVID, `rescue-${session}-${tag}-${k}${path.extname(f) || '.log'}`);
    try { fs.copyFileSync(f, dst); out[`rescue_${k}`] = path.basename(dst); }
    catch (e) { out[`rescue_${k}`] = `COPY_FAILED:${e.message}`; }
  }
  return out;
};

const results = [];
const jsonl = path.join(EVID, `runs-${TAG}.jsonl`);
for (let i = 1; i <= ITERS; i++) {
  const session = `probeR45-${i}`;
  const fixture = i % 2 === 1 ? '/inf' : '/static';
  const rec = { i, fixture, session, stale: false, empty: false, navSeen: false };
  const snapCalls = []; // wrapper 记录：本迭代所有 snapshot 调用的完整返回
  const wrap = async (o) => {
    const r = await runCli(o);
    if (o.subcommand === 'snapshot') snapCalls.push(truncate(r));
    return r;
  };
  try {
    const t0 = Date.now();
    const open = await runCli({ cwd: ROOT, session, subcommand: 'open', args: [`${base}${fixture}?page=1`], timeoutMs: 60_000 });
    rec.openMs = Date.now() - t0; rec.openOk = open.ok; rec.openSummary = String(open.summary || '').slice(0, 200);
    if (!open.ok) { rec.err = `open: ${rec.openSummary}`; }

    if (!rec.err) {
      const tableEval = "() => JSON.stringify({href:location.href, n:document.querySelectorAll('tbody tr').length})";
      const tH0 = Date.now();
      const h0 = await evalJs(session, tableEval, 'h0');
      rec.h0Ms = Date.now() - tH0; rec.h0 = h0 ? { href: h0.href, n: h0.n } : null;
      if (h0 == null) rec.h0Failed = true;

      const tNeedle = Date.now();
      const found = await findRefByNeedle({ cwd: ROOT, session, needle: '页码', act: 'fill', runCliImpl: wrap });
      rec.needleMs = Date.now() - tNeedle;
      rec.snapCalls = snapCalls;

      if (!found.ok) {
        rec.needleFail = { why: found.why, detail: found.detail };
        rec.rescue = rescue(session, 'first', snapCalls[snapCalls.length - 1]);
        // 迟 stat ×2：区分「没写」与「写了又消失」
        await new Promise((r) => setTimeout(r, 500));
        const late = {};
        const claimed = snapCalls[snapCalls.length - 1]?.artifacts?.snapshot;
        if (claimed) { try { const st = fs.statSync(claimed); late.t500 = { exists: true, size: st.size }; } catch { late.t500 = { exists: false }; } }
        await new Promise((r) => setTimeout(r, 1500));
        if (claimed) { try { const st = fs.statSync(claimed); late.t2000 = { exists: true, size: st.size }; } catch { late.t2000 = { exists: false }; } }
        rec.lateStat = late;
        // 重试一次：瞬断 vs 持续
        const snapCalls2 = [];
        const wrap2 = async (o) => { const r = await runCli(o); if (o.subcommand === 'snapshot') snapCalls2.push(truncate(r)); return r; };
        const retry = await findRefByNeedle({ cwd: ROOT, session, needle: '页码', act: 'fill', runCliImpl: wrap2 });
        rec.retry = { ok: retry.ok, why: retry.why || null, detail: retry.detail || null, snapCalls: snapCalls2 };
        if (!retry.ok) rec.rescueRetry = rescue(session, 'retry', snapCalls2[snapCalls2.length - 1]);
      } else {
        rec.ref = found.ref;
        await runCli({ cwd: ROOT, session, subcommand: 'fill', args: [found.ref, '2'], timeoutMs: 30_000 });
        const tPress = Date.now();
        await runCli({ cwd: ROOT, session, subcommand: 'press', args: ['Enter'], timeoutMs: 30_000 });
        const h1 = await evalJs(session, tableEval, 'h1');
        rec.firstEvalMs = Date.now() - tPress;
        const s0 = String(rec.h0?.href || ''); const s1 = String(h1?.href || '');
        rec.h1 = h1 ? { href: h1.href, n: h1.n } : null;
        rec.evalFailed = h1 == null;
        rec.stale = !rec.evalFailed && s1 === s0 && /page=1/.test(s0);
        rec.empty = !rec.evalFailed && Number(h1.n) === 0;
        rec.navSeen = /page=2/.test(s1);
      }
    }
  } catch (e) { rec.err = `${rec.err || ''} | exception: ${e.message}`; }
  finally {
    try { await runCli({ cwd: ROOT, session, subcommand: 'close', args: [], timeoutMs: 15_000 }); } catch { /* 尽力 */ }
  }
  results.push(rec);
  fs.appendFileSync(jsonl, `${JSON.stringify(rec)}\n`); // 追加落盘：中途死也不丢样本
  const flag = rec.needleFail ? ` ★NEEDLE_FAIL(${rec.needleFail.why})` : (rec.err ? ' ★ERR' : '');
  console.log(`[${TAG} ${i}/${ITERS}] ${fixture} open=${rec.openOk} needle${rec.needleFail ? `✗${rec.needleFail.why}` : '✓'} stale=${rec.stale} empty=${rec.empty}${flag}`);
}

for (const b of burners) { try { b.kill(); } catch { /* 已退 */ } }
await new Promise((r) => site.close(() => r()));

const fails = results.filter((r) => r.needleFail);
const errs = results.filter((r) => r.err && !r.needleFail);
const staleN = results.filter((r) => r.stale).length;
const emptyN = results.filter((r) => r.empty).length;
const md = [
  `# needle-r45 探针 v2 — ${TAG}（${new Date().toISOString()}）`,
  '',
  `- 迭代 ${ITERS}（inf/static 交替，负载=${LOAD ? '2×CPU 烧瓶' : 'idle'}）`,
  `- **needle 失败（快照未产出等）：${fails.length}/${ITERS}**`,
  `- stale=${staleN} empty=${emptyN} 其他错误=${errs.length}`,
  '',
  ...fails.map((r) => {
    const sc = (r.snapCalls || [])[0] || {};
    return `- #${r.i} ${r.fixture} why=${r.needleFail.why} snapshotCall: ok=${sc.ok} reason=${sc.reason || '无'} timedOut=${!!sc.timedOut} claimed=${sc.artifacts?.snapshot || '无'}`
      + ` | 迟stat=${JSON.stringify(r.lateStat || {})} | 重试=${r.retry ? `${r.retry.ok ? '成功' : r.retry.why}` : '无'}`
      + ` | 抢救=${r.rescue ? Object.entries(r.rescue).filter(([k]) => k.startsWith('rescue_')).map(([, v]) => v).join(',') : '无'}`;
  }),
  ...(fails.length ? [] : ['- 全部迭代 needle 成功（r42 的 2/60 未复现）']),
].join('\n');
fs.writeFileSync(path.join(EVID, `summary-${TAG}.md`), md, 'utf8');
console.log(`\n== ${TAG}：needle 失败 ${fails.length}/${ITERS}，stale=${staleN} empty=${emptyN} 其他错误=${errs.length} → ${path.join(EVID, `summary-${TAG}.md`)}`);
