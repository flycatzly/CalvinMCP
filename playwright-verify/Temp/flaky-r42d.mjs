/**
 * flaky-r42d.mjs — Phase D：press→eval 竞态窗口实测探针（r42）
 *
 * 目的：整套 flake 打不出来（A 0/20、B 0/10）时，把 collect 翻页循环
 * 「press Enter 后无导航同步」的暴露窗口从嫌疑变成实测数字。
 * 探针走与 collect_table **完全相同**的执行路径（runCli fill/press/eval
 * + findRefByNeedle 找控件），对 /inf（无限新行）与 /static（不推进）两个
 * fixture 测：press 后第一个 eval 看到的还是不是旧页。
 *
 * 判定口径（与 F7 失败形态同构）：
 *   stale = press 后首个 eval 的 location 仍停在旧页（F7c4 的 max-pages→no-new-rows 打法）
 *   empty = press 后首个 eval 的表格行数为 0（F7c1 的 no-new-rows→empty 打法）
 * 报 stale/empty 率与首个 eval 的相对延迟，多轮取分布。
 *
 * 用法：node Temp/flaky-r42d.mjs --iters 30 [--load] [--tag idle]
 *   --load = 同时起 2 个 CPU 烧瓶（探负载放大面）
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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
const ITERS = Math.max(1, argNum('iters', 30));
const TAG = argStr('tag', argv.includes('--load') ? 'load' : 'idle');
const LOAD = argv.includes('--load');
fs.mkdirSync(EVID, { recursive: true });

const { runCli } = await import(pathToFileURL(path.join(ROOT, 'mcp', 'lib', 'cli.js')).href);
const { findRefByNeedle } = await import(pathToFileURL(path.join(ROOT, 'mcp', 'lib', 'heal.js')).href);

/* ---- fixture：与 flow-check 同形（/inf 无限新行 / /static 不推进）---- */
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

/* ---- 可选 CPU 烧瓶（负载放大面）---- */
const burners = [];
if (LOAD) {
  for (let i = 0; i < 2; i++) {
    burners.push(spawn(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<600000){Math.sqrt(Math.random());}'], { windowsHide: true }));
  }
}

// eval 不在 MUST_REDIRECT（cli.js:78）—— 与 server.mjs collect 同款口径：
// 调用方自带 --filename 把结果落盘，再从盘上解析（CLI 日志只当兜底）。
// 走过的弯路：第一版拿 artifacts.file —— eval 根本不注入 --filename，
// artifacts.file 恒 undefined → 取不到结果被误判成「表格读空」，30/30 假阳。
const evalJs = async (session, code, which) => {
  const evFile = path.join(EVID, `probe-eval-${session}-${which}.json`);
  try { fs.rmSync(evFile, { force: true }); } catch { /* 无残留 */ }
  const r = await runCli({
    cwd: ROOT, session, subcommand: 'eval', args: [code, '--filename', evFile], timeoutMs: 30_000,
  });
  let raw = null;
  try { raw = fs.readFileSync(evFile, 'utf8'); } catch {
    try { raw = fs.readFileSync(r.logFiles?.stdout, 'utf8'); } catch { return null; }
  }
  // 落盘件解包（collect.parseTableFile 同款纪律：信封/双层编码都认）
  const unwrap = (v, d = 0) => {
    if (d > 3) return null;
    let obj = v;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch { return null; }
      return typeof obj === 'string' ? unwrap(obj, d + 1) : obj;
    }
    if (obj && typeof obj === 'object') {
      for (const k of ['result', 'stdout', 'content', 'data']) {
        if (obj[k] !== undefined) return unwrap(obj[k], d + 1);
      }
    }
    return obj;
  };
  try { return unwrap(JSON.parse(raw)); } catch { return null; }
};

const results = [];
for (let i = 1; i <= ITERS; i++) {
  const session = `probeR42-${i}`;
  const fixture = i % 2 === 1 ? '/inf' : '/static'; // 两个 fixture 交替
  const rec = { i, fixture, stale: false, empty: false, firstEvalMs: 0, navSeen: false, openOk: false };
  try {
    const t0 = Date.now();
    const open = await runCli({ cwd: ROOT, session, subcommand: 'open', args: [`${base}${fixture}?page=1`], timeoutMs: 60_000 });
    rec.openOk = open.ok;
    if (!open.ok) { rec.err = open.summary; results.push(rec); continue; }

    // 基线：当前页 href 与行数（与 collect 循环同口径的表格 eval）
    const tableEval = "() => JSON.stringify({href:location.href, n:document.querySelectorAll('tbody tr').length})";
    const h0 = await evalJs(session, tableEval, 'h0');

    // 找页码框 → fill 2 → press Enter（与 collect pageInput 分支逐字同序）
    const found = await findRefByNeedle({ cwd: ROOT, session, needle: '页码', act: 'fill' });
    if (!found.ok) { rec.err = `needle: ${found.detail}`; results.push(rec); continue; }
    await runCli({ cwd: ROOT, session, subcommand: 'fill', args: [found.ref, '2'], timeoutMs: 30_000 });
    const tPress = Date.now();
    await runCli({ cwd: ROOT, session, subcommand: 'press', args: ['Enter'], timeoutMs: 30_000 });

    // 竞态窗口：press 后**第一个** eval —— collect 循环下一轮就干这个
    const h1 = await evalJs(session, tableEval, 'h1');
    rec.firstEvalMs = Date.now() - tPress;
    const s0 = String(h0?.href || '');
    const s1 = String(h1?.href || '');
    rec.h0 = s0; rec.h1 = s1; rec.n1 = h1?.n ?? null;
    // 取不到结果 ≠ 读空：null 归 evalFailed，绝不混进 empty（否则 30/30 假阳）
    rec.evalFailed = h1 == null;
    rec.stale = !rec.evalFailed && s1 === s0 && /page=1/.test(s0);  // 还停在旧页
    rec.empty = !rec.evalFailed && Number(h1.n) === 0;              // 表格读空
    rec.navSeen = /page=2/.test(s1);
  } catch (e) {
    rec.err = e.message;
  } finally {
    try { await runCli({ cwd: ROOT, session, subcommand: 'close', args: [], timeoutMs: 15_000 }); } catch { /* 尽力 */ }
  }
  results.push(rec);
  console.log(`[probe] ${i}/${ITERS} ${fixture} stale=${rec.stale} empty=${rec.empty} evalFailed=${!!rec.evalFailed} n1=${rec.n1} firstEvalMs=${rec.firstEvalMs}`);
}

for (const b of burners) { try { b.kill(); } catch { /* 已退 */ } }
await new Promise((r) => site.close(() => r()));

const staleN = results.filter((r) => r.stale).length;
const emptyN = results.filter((r) => r.empty).length;
const evalFailN = results.filter((r) => r.evalFailed).length;
const errs = results.filter((r) => r.err);
const lat = results.filter((r) => !r.err).map((r) => r.firstEvalMs).sort((a, b) => a - b);
const md = [
  `# Phase D 竞态窗口实测 — ${TAG}（${new Date().toISOString()}）`,
  '',
  `- 迭代 ${ITERS}（inf/static 交替，负载=${LOAD ? '2×CPU 烧瓶' : 'idle'}）`,
  `- **stale（press 后首个 eval 仍停旧页）：${staleN}/${ITERS}**`,
  `- **empty（press 后首个 eval 表格读空）：${emptyN}/${ITERS}**`,
  `- evalFailed（结果取不到，不计入 stale/empty）：${evalFailN}/${ITERS}`,
  `- 出错：${errs.length}（${errs.map((r) => `#${r.i}:${r.err}`).join(' ') || '无'}）`,
  `- press→首个 eval 延迟 ms：p50=${lat[Math.floor(lat.length * 0.5)]} p90=${lat[Math.floor(lat.length * 0.9)]} max=${lat[lat.length - 1]}`,
  '',
  '## 明细（stale/empty/evalFailed/err 的迭代全列）',
  '',
  ...results.filter((r) => r.stale || r.empty || r.evalFailed || r.err)
    .map((r) => `- #${r.i} ${r.fixture} stale=${r.stale} empty=${r.empty} evalFailed=${!!r.evalFailed} h0=${r.h0} h1=${r.h1} n1=${r.n1}${r.err ? ` err=${r.err}` : ''}`),
  ...(results.some((r) => r.stale || r.empty || r.evalFailed || r.err) ? [] : ['- 全部迭代首个 eval 已见新页/行非空（窗口实测不可达）']),
  '',
].join('\n');
fs.writeFileSync(path.join(EVID, `summary-probe-${TAG}.md`), md, 'utf8');
fs.writeFileSync(path.join(EVID, `probe-${TAG}.json`), JSON.stringify({ tag: TAG, load: LOAD, results }, null, 2), 'utf8');
console.log(`[probe] done stale=${staleN}/${ITERS} empty=${emptyN}/${ITERS} evalFailed=${evalFailN}/${ITERS} → summary-probe-${TAG}.md`);
