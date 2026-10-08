#!/usr/bin/env node
/**
 * realtest-r52.mjs — 探索性实测轮（r10 模式）：collect_table 未覆盖路径真跑
 *
 * 覆盖面盘点结论（盘 suites 源码后）：collect_table 的 pageInput 模式/断点续采/两期
 * 对比已由 flow-check 真跑覆盖；**next 模式（点击「下一页」翻页）与 keyIndex 跨页去重
 * 全链零真跑**（只有纯函数/参数拒绝钉）。本探针补打这四条：
 *   1. next 模式全链：3 页 ×5 行，下一页链接 → rowCount 15 / pagesScanned 3 / 末页诚实停
 *   2. CSV 公式注入真链路：页面单元格 =HYPERLINK(...) → 采集 → CSV 带 ' 前缀（r52 修复面）
 *   3. keyIndex 跨页去重真跑：page2 重复 page1 首行 → 唯一键计数
 *   4. 纯重复中间页边界观察：page2 全是 page1 的行 → 实测 stopReason 与丢数行为（只记录不定性）
 *
 * 真 stdio JSON-RPC 打 server.mjs + 回环靶站；cwd=仓库根（CLI 解析面）。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EVID = path.join(__dirname, 'realtest-r52-evidence');
fs.mkdirSync(EVID, { recursive: true });

/* ---- 靶站：/np 3 页 next 链接；/npdup 带粘行；/nppure 中间页全重复；注入单元格在 /np page1 ---- */
const tbl = (rows) => `<table><thead><tr><th>编号</th><th>名</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</tbody></table>`;
const npRows = (n) => Array.from({ length: 5 }, (_, i) => [`N${n}-${i}`, n === 1 && i === 0 ? '=HYPERLINK("http://evil.example/x","点我")' : `行${n}-${i}`]);
const site = http.createServer((req, res) => {
  const [p, q] = String(req.url || '/').split('?');
  const n = Number(new URLSearchParams(q || '').get('page') || '1');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const nextLink = (base, cur, total) => (cur < total ? `<a id="next" href="${base}?page=${cur + 1}">下一页</a>` : '<span>没有更多了</span>');
  if (p === '/np') return res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>np</title></head><body>${tbl(npRows(n))}${nextLink('/np', n, 3)}</body></html>`);
  if (p === '/npdup') {
    // page2 重复 page1 首行（粘行）+ 2 新行；page3 全新
    const rows = n === 1 ? [['D1', '甲'], ['D2', '乙'], ['D3', '丙']]
      : n === 2 ? [['D1', '甲'], ['D4', '丁'], ['D5', '戊']]
        : [['D6', '己'], ['D7', '庚'], ['D8', '辛']];
    return res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>npdup</title></head><body>${tbl(rows)}${nextLink('/npdup', n, 3)}</body></html>`);
  }
  if (p === '/nppure') {
    // page2 全是 page1 的行（纯重复中间页）；page3 有新行 —— 观察当前 stop 语义
    const rows = n === 3 ? [['P3', '新']] : [['P1', 'a'], ['P2', 'b']];
    return res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>nppure</title></head><body>${tbl(rows)}${nextLink('/nppure', n, 3)}</body></html>`);
  }
  res.statusCode = 404; res.end('nope');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

/* ---- 真 stdio JSON-RPC 客户端 ---- */
const srv = spawn(process.execPath, [path.join(ROOT, 'mcp/server.mjs')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = '';
const pending = new Map();
srv.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); }
    } catch { /* 非 JSON 行（日志噪声）忽略 */ }
  }
});
let seq = 0;
const rpc = (method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const id = ++seq;
  const t = setTimeout(() => { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
  pending.set(id, (j) => { clearTimeout(t); resolve(j); });
  srv.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const call = async (name, args, timeoutMs) => {
  const j = await rpc('tools/call', { name, arguments: args }, timeoutMs);
  const r = (j.result || {});
  let sc = null;
  try { sc = JSON.parse(fs.readFileSync(r.structuredContent?.files?.rows || '', 'utf8')); } catch { /* 非 rows 载荷 */ }
  return { isError: !!r.isError, text: (r.content || []).map((c) => c.text || '').join('\n'), sc, raw: r };
};

await rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'realtest-r52', version: '0' }, capabilities: {} });

const results = [];
const record = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${detail}`); };
const rowsOf = async (scFiles) => {
  try { return JSON.parse(fs.readFileSync(scFiles.rows, 'utf8')); } catch { return null; }
};

/* ---- 用例 1：next 模式全链 ---- */
{
  const r = await call('collect_table', { url: `${base}/np?page=1`, session: 'rt52-next', pagination: { mode: 'next', needle: '下一页' }, maxPages: 10 }, 90000);
  const rep = r.raw.structuredContent || {};
  const rows = await rowsOf(rep.files || {});
  record('next 模式 3 页全链：rowCount 15 / pagesScanned 3 / 末页无下一页诚实停 no-paging-control',
    !r.isError && rows && rows.rowCount === 15 && rep.pagesScanned === 3 && rep.stopReason === 'no-paging-control',
    JSON.stringify({ isError: r.isError, rowCount: rows && rows.rowCount, pagesScanned: rep.pagesScanned, stop: rep.stopReason }));
  if (rows) {
    const csvPath = (rep.files || {}).csv ? path.resolve(rep.files.csv) : null;
    const csv = csvPath && fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8') : '';
    record('CSV 公式注入真链路：页面 =HYPERLINK 单元格 → CSV 带 \' 前缀（r52 修复面端到端）',
      csv.includes('"\'=HYPERLINK(""http://evil.example/x"",""点我"")"'),
      csv ? (csv.includes("'=HYPERLINK") ? '中和在位' : `未中和：${csv.split('\r\n')[1] || ''}`.slice(0, 80)) : '(CSV 未产出)');
  } else {
    record('CSV 公式注入真链路：页面 =HYPERLINK 单元格 → CSV 带 \' 前缀（r52 修复面端到端）', false, '(rows.json 未产出)');
  }
  await call('cli_session', { action: 'close', session: 'rt52-next' }, 30000).catch(() => {});
}

/* ---- 用例 2：keyIndex 跨页去重真跑 ---- */
{
  const r = await call('collect_table', { url: `${base}/npdup?page=1`, session: 'rt52-dup', pagination: { mode: 'next', needle: '下一页' }, maxPages: 10, keyIndex: 0 }, 90000);
  const rep = r.raw.structuredContent || {};
  const rows = await rowsOf(rep.files || {});
  // 期望：D1 唯一化 → 8 行（3+2+3）；page2 三行含一粘行 → added=2（首期钉把期望写成 1 是钉错位：粘行 1 条被去重、新增 2 条）
  // 页账在 rows.json（structuredContent 只带汇总计数与文件指针——钉按真实载荷面取数）
  record('keyIndex 跨页去重真跑：粘行去重 → rowCount 8 / page2 added=2（3 行含 1 粘行不重复计入）',
    !r.isError && rows && rows.rowCount === 8 && Array.isArray(rows.pages) && rows.pages[1] && rows.pages[1].added === 2,
    JSON.stringify({ rowCount: rows && rows.rowCount, pages: (rows && rows.pages || []).map((p) => p.added) }));
  await call('cli_session', { action: 'close', session: 'rt52-dup' }, 30000).catch(() => {});
}

/* ---- 用例 3：纯重复中间页（r53 修复后：不误停，续采到尾页） ---- */
{
  const r = await call('collect_table', { url: `${base}/nppure?page=1`, session: 'rt52-pure', pagination: { mode: 'next', needle: '下一页' }, maxPages: 10, keyIndex: 0 }, 90000);
  const rep = r.raw.structuredContent || {};
  const rows = await rowsOf(rep.files || {});
  // r53 修复后期望：page2 纯重复不误停 → 续采 page3 → rowCount 3 / pagesScanned 3 / 尾页无下一页诚实停
  record('r53 纯重复中间页修复：续采到尾页（rowCount 3/pagesScanned 3/no-paging-control，page3 新行不丢）',
    !r.isError && rows && rows.rowCount === 3 && rep.pagesScanned === 3 && rep.stopReason === 'no-paging-control',
    JSON.stringify({ rowCount: rows && rows.rowCount, pagesScanned: rep.pagesScanned, stop: rep.stopReason, pages: (rows && rows.pages || []).map((p) => [p.page, p.rowCount, p.added]) }));
  await call('cli_session', { action: 'close', session: 'rt52-pure' }, 30000).catch(() => {});
}

/* ---- 收尾：收割浏览器会话 + 关服务器 ---- */
try {
  const { runCli } = await import(pathToFileURL(path.join(ROOT, 'mcp/lib/cli.js')).href);
  await runCli({ cwd: ROOT, session: 'rt52-reap', subcommand: 'kill-all', args: [], timeoutMs: 30_000 });
} catch { /* 尽力而为 */ }
srv.kill();
await new Promise((r) => site.close(r));
fs.writeFileSync(path.join(EVID, 'summary-r52.md'), [
  `# realtest-r52 探索性实测 — ${new Date().toISOString()}`,
  '', ...results.map((x) => `- [${x.ok ? 'PASS' : 'FAIL'}] ${x.id}：${x.detail}`),
].join('\n'));
console.log(`\n== realtest-r52：${results.filter((x) => x.ok).length}/${results.length} 通过 → ${path.join(EVID, 'summary-r52.md')}`);
