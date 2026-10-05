/**
 * flow-check.mjs — 全流程验证工具：工具调用全链 + 真实自然语言测试
 *
 * 这套证明的是「两篇文章差异化能力合入后，整条流水线真能串起来跑」：
 *   lint_spec 门禁 → nl_test_goal 自然语言目标真执行（含两层自愈真回环）→
 *   collect_table 翻页采集与两期对比 → explore_page 巡检 → summarize_report 归因。
 * 全部走 handleMessage 的真实工具调用面（不是直接调库），所以参数校验、
 * 守门、错误码、日志脱敏这些「工具面行为」一起被验证。
 *
 * 三个边界钉（负向咬合的对象）：
 *   1) 断言绝不自愈 —— expect_* 失败就是失败，结果里不得出现自愈痕迹；
 *   2) 自愈只挑清单内 ref（LLM 做选择题，不做填空题）；
 *   3) 采集结果只落盘不回灌，日志不落参数值（脱敏哨兵）。
 *
 * 为什么靶站自己起 HTTP：智能体线只放行 http/https，且翻页/断言需要真实导航；
 * 127.0.0.1 回环完全离线可复现。LLM 用回环桩：链路正确性与「规划质量」无关。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

// 本套全部断言都要真实 CLI 执行层（真浏览器）。缺可选依赖时诚实 SKIP（纯净包口径）。
if (!(await import('../lib/runner.js')).resolveCliRunner(ROOT)) {
  log('SKIP（缺可选依赖 @playwright/cli：纯净包口径 —— 可选依赖由被测项目/本机提供）');
  log('本套全部断言都需要真实 CLI 执行层，本次未执行任何断言。');
  process.exit(0);
}

/* ================= 靶站（离线回环） ================= */
const page = (body, title = 'flow') => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

// /order：改版后的下单页 —— 按钮只有 data-testid 与可见名（旧 #submit-btn 已不存在）
const ORDER = page(`
  <h1>下单页</h1>
  <button data-testid="submit-order" onclick="document.getElementById('result').textContent='下单成功'">提交订单</button>
  <div id="result">未下单</div>
`, 'order');

// 档案表：3 页真实数据（form+GET 翻页语义 + 下一页链接），第 4 页起为空
function paged(n) {
  const rows = [];
  if (n <= 3) {
    for (let i = (n - 1) * 5 + 1; i <= n * 5; i++) {
      rows.push(`<tr><td>D${String(i).padStart(3, '0')}</td><td>名称${i}</td><td>标签${i % 3}</td><td>备注${i}</td></tr>`);
    }
  }
  return page(`
    <h1>数据档案</h1>
    <table><thead><tr><th>编号</th><th>名称</th><th>标签</th><th>备注</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    <form action="/paged" method="get">
      <label for="page">页码</label><input id="page" name="page" value="${n}">
      <button type="submit">跳转</button>
      ${n < 3 ? `<a id="next" href="/paged?page=${n + 1}">下一页</a>` : '<span>没有更多了</span>'}
    </form>`, `page${n}`);
}

// /static：翻页不推进（永远同 5 行）→ no-new-rows 判定
const STATIC_ROWS = Array.from({ length: 5 }, (_, i) => `<tr><td>S${i + 1}</td><td>静态${i + 1}</td></tr>`).join('');
function staticPage(n) {
  return page(`<table><tbody>${STATIC_ROWS}</tbody></table>
    <form action="/static" method="get"><label for="page">页码</label><input id="page" name="page" value="${n}"><button type="submit">跳转</button></form>`);
}
// /inf：每页都是新行 → max-pages 判定
function infPage(n) {
  const rows = Array.from({ length: 5 }, (_, i) => `<tr><td>I${n}-${i}</td><td>无限${n}-${i}</td></tr>`).join('');
  return page(`<table><tbody>${rows}</tbody></table>
    <form action="/inf" method="get"><label for="page">页码</label><input id="page" name="page" value="${n}"><button type="submit">跳转</button></form>`);
}

const site = http.createServer((req, res) => {
  // 不用 URL 的路径属性（H15 禁的反模式：路径段百分号编码会静默指错位置）——
  // fixture 解析请求行用 split + URLSearchParams 就够
  const [p, q] = String(req.url || '/').split('?');
  const params = new URLSearchParams(q || '');
  const pageNo = Number(params.get('page') || '1');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (p === '/order') return res.end(ORDER);
  if (p === '/paged') return res.end(paged(pageNo));
  if (p === '/static') return res.end(staticPage(pageNo));
  if (p === '/inf') return res.end(infPage(pageNo));
  if (p === '/empty') return res.end(page('<table><thead><tr><th>编号</th></tr></thead><tbody></tbody></table>'));
  return res.end(page('<h1>404</h1>'));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

/* ================= stub LLM（真 HTTP 回环） ================= */
const llmSeen = [];
const stubLlm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let content = '{"ref":null}';
    try {
      const b = JSON.parse(body);
      const sys = (b.messages || []).find((m) => m.role === 'system')?.content || '';
      const user = (b.messages || []).find((m) => m.role === 'user')?.content || '';
      llmSeen.push({ hasSystem: !!sys, userHead: user.slice(0, 40) });
      if (sys.includes('定位修复器')) {
        // 自愈挑选：从清单里挑第一个 button（模拟 LLM 的选择题）
        const m = /ref=(e[\w.:-]+) role=button/.exec(user);
        content = JSON.stringify({ ref: m ? m[1] : null });
      } else if (user.includes('旧选择器')) {
        // 目标 B：CSS 全失效 → tier-2 LLM 挑选
        content = JSON.stringify({ steps: [
          { act: 'goto', target: `${base}/order` },
          { act: 'click', target: '#submit-btn' },
          { act: 'expect_text', value: '下单成功' },
        ] });
      } else if (user.includes('退款完成')) {
        content = JSON.stringify({ steps: [
          { act: 'goto', target: `${base}/order` },
          { act: 'click', target: '#submit-btn' },
          { act: 'expect_text', value: '退款完成' },
        ] });
      } else if (user.includes('下单成功')) {
        // 目标 A：语义名仍在，只是定位器形态不对 → tier-1 按名自愈
        content = JSON.stringify({ steps: [
          { act: 'goto', target: `${base}/order` },
          { act: 'click', target: '#提交订单' },
          { act: 'expect_text', value: '下单成功' },
          { act: 'screenshot' },
        ] });
      } else {
        content = JSON.stringify({ steps: [
          { act: 'goto', target: `${base}/order` },
          { act: 'expect_visible', target: '#ghost-btn' },
        ] });
      }
    } catch { /* keep null */ }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { content } }));
  });
});
await new Promise((r) => stubLlm.listen(0, '127.0.0.1', r));

/* ================= 装配：日志哨兵 + LLM 环境（必须在 import server 之前） ================= */
const logFile = path.join(os.tmpdir(), `pv-flow-${Date.now().toString(36)}.log`);
process.env.PVMCP_LOG = logFile;
process.env.PVMCP_LLM = 'ollama';
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${stubLlm.address().port}`;
const { handleMessage } = await import('../server.mjs');

const call = (name, args) => handleMessage({ id: 1, method: 'tools/call', params: { name, arguments: args } });
const CWD = path.join(os.tmpdir(), `pv-flow-cwd-${Date.now().toString(36)}`);
fs.mkdirSync(CWD, { recursive: true });

try {
  /* ---- F1 全链开路：lint_spec 门禁（干净过、脏拦） ---- */
  log('=== F1) lint_spec 门禁（全链起点） ===');
  const specOk = path.join(CWD, 'ok.spec.js');
  fs.writeFileSync(specOk, "import { test, expect } from '@playwright/test';\ntest('t', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.getByTestId('a')).toBeVisible();\n});\n", 'utf8');
  const lint1 = await call('lint_spec', { target: specOk, cwd: CWD });
  check('F1 干净用例过门禁', lint1.result.isError !== true, lint1.result.content?.[0]?.text?.slice(0, 60));

  const specBad = path.join(CWD, 'bad.spec.js');
  fs.writeFileSync(specBad, "import { test } from '@playwright/test';\ntest.only('t', async () => {});\n", 'utf8');
  const lint2 = await call('lint_spec', { target: specBad, cwd: CWD });
  check('F1 test.only 被 ERROR 拦下', lint2.result.isError === true);

  /* ---- F2 自然语言测试 A：tier-1 按名自愈（目标是中文人话） ---- */
  log('=== F2) nl_test_goal 自然语言目标 A（按名自愈） ===');
  const goalA = '【测试】打开下单页，点击"提交订单"按钮，页面应出现"下单成功"';
  const rA = await call('nl_test_goal', { goal: goalA, url: `${base}/order`, cwd: ROOT, session: 'flowA' });
  const repA = rA.result.structuredContent || {};
  check('F2 目标 A 判定 Pass', repA.verdict === 'Pass', `verdict=${repA.verdict}`);
  const healedA = (repA.steps || []).find((s) => s.healed === true);
  check('F2 A 存在自愈步骤（tier-1 按可见名）',
    !!healedA && String(healedA.via || '').startsWith('snapshot-ref'),
    JSON.stringify({ via: healedA?.via, detail: healedA?.detail?.slice(0, 60) }));
  check('F2 A 报告落盘且 healedCount 对账',
    fs.existsSync(repA.reportFile || '') && repA.healedCount === (repA.steps || []).filter((s) => s.healed).length);

  /* ---- F3 自然语言测试 B：tier-2 LLM 挑选自愈（CSS 全失效） ---- */
  log('=== F3) nl_test_goal 自然语言目标 B（LLM 挑选自愈） ===');
  const goalB = '【测试】用旧选择器点击提交订单按钮完成下单，页面应出现"下单成功"';
  const rB = await call('nl_test_goal', { goal: goalB, url: `${base}/order`, cwd: ROOT, session: 'flowB' });
  const repB = rB.result.structuredContent || {};
  check('F3 目标 B 判定 Pass', repB.verdict === 'Pass', `verdict=${repB.verdict}`);
  const healedB = (repB.steps || []).find((s) => s.healed);
  check('F3 B 的自愈走 LLM 挑选层', !!healedB && String(healedB.via || '').includes('llm-pick'),
    JSON.stringify({ via: healedB?.via, detail: healedB?.detail?.slice(0, 60) }));

  /* ---- F4 边界钉①：断言绝不自愈 + Fail 如实 ---- */
  log('=== F4) 边界：断言绝不自愈 ===');
  const goalC = '【测试】验证按钮可见，页面应出现"不可能出现的文案"';
  const rC = await call('nl_test_goal', { goal: goalC, url: `${base}/order`, cwd: ROOT, session: 'flowC' });
  const repC = rC.result.structuredContent || {};
  check('F4 断言不成立 → Fail（isError）', rC.result.isError === true && repC.verdict === 'Fail');
  const expectSteps = (repC.steps || []).filter((s) => String(s.act).startsWith('expect_'));
  check('F4 expect_* 步骤无任何自愈痕迹',
    expectSteps.length > 0 && expectSteps.every((s) => s.healed === undefined && s.healTried === undefined),
    JSON.stringify(expectSteps.map((s) => ({ act: s.act, ok: s.ok, healed: s.healed }))));
  check('F4 报告 healedCount=0（断言失败不被自愈洗白）', repC.healedCount === 0);

  /* ---- F4b 计划缓存：同指纹命中只省规划，执行仍全量真跑（v1.8.8） ---- */
  log('=== F4b) nl_test_goal 计划缓存：命中省规划不省执行 ===');
  {
    const stubCount = () => llmSeen.length;
    // F2 已用 goalA 真规划过一次（已入缓存）；同 goal+url 重放 → 必须命中且 LLM 桩零新增请求
    const before1 = stubCount();
    const rA2 = await call('nl_test_goal', { goal: goalA, url: `${base}/order`, cwd: ROOT, session: 'flowA2' });
    const repA2 = rA2.result.structuredContent || {};
    check('F4b 同指纹重放 → planCache=hit 且 LLM 桩零新增请求（规划真的没重跑）',
      repA2.planCache === 'hit' && stubCount() === before1,
      `planCache=${repA2.planCache} stub ${before1}->${stubCount()}`);
    check('F4b 命中后执行仍全量真跑：verdict Pass、每步有执行耗时、tier-1 自愈照常发生',
      repA2.verdict === 'Pass'
      && (repA2.steps || []).every((s) => typeof s.durationMs === 'number')
      && (repA2.steps || []).some((s) => s.healed === true),
      `verdict=${repA2.verdict} healed=${(repA2.steps || []).filter((s) => s.healed).length}`);
    check('F4b 命中的 planNote 诚实标注（指纹口径 + 不省执行写进文案）',
      String(repA2.planNote || '').includes('缓存命中') && String(repA2.planNote || '').includes('全量真跑'),
      repA2.planNote);

    // goal 变 → 指纹失效 → 现场重规划（桩恰好 +1）
    const before2 = stubCount();
    const rA3 = await call('nl_test_goal', { goal: `${goalA}（口径变体）`, url: `${base}/order`, cwd: ROOT, session: 'flowA3' });
    const repA3 = rA3.result.structuredContent || {};
    check('F4b goal 变 → miss + 现场重规划（LLM 桩恰好 +1）',
      repA3.planCache === 'miss' && stubCount() === before2 + 1 && String(repA3.planNote || '').startsWith('LLM 规划（'),
      `planCache=${repA3.planCache} stub ${before2}->${stubCount()}`);

    // url 变 → 指纹失效（同 goal 换入口不吃缓存）
    const before3 = stubCount();
    const rA4 = await call('nl_test_goal', { goal: goalA, url: `${base}/order?via=fp`, cwd: ROOT, session: 'flowA4' });
    const repA4 = rA4.result.structuredContent || {};
    check('F4b url 变 → miss（同 goal 不同入口不吃缓存）',
      repA4.planCache === 'miss' && stubCount() === before3 + 1,
      `planCache=${repA4.planCache} stub ${before3}->${stubCount()}`);

    // llm=off → skip：不查缓存也不问 LLM（确定性骨架不吃缓存产物）
    const before4 = stubCount();
    const rA5 = await call('nl_test_goal', { goal: goalA, url: `${base}/order`, cwd: ROOT, session: 'flowA5', llm: 'off' });
    const repA5 = rA5.result.structuredContent || {};
    check('F4b llm=off → planCache=skip（桩零新增；来源 fallback）',
      repA5.planCache === 'skip' && stubCount() === before4 && repA5.source === 'fallback',
      `planCache=${repA5.planCache} stub ${before4}->${stubCount()}`);

    // 落盘 JSON 报告带 planCache 字段（CI 可审计）
    const disk = JSON.parse(fs.readFileSync(repA2.reportFile, 'utf8'));
    check('F4b 落盘 JSON 报告带 planCache=hit（CI 可审计）', disk.planCache === 'hit' && disk.source === 'llm');
  }

  /* ---- F5 collect_table：3 页翻页采集（pageInput 页码框形态） ---- */
  log('=== F5) collect_table 翻页采集与两期对比 ===');
  const c1 = await call('collect_table', {
    url: `${base}/paged?page=1`, cwd: ROOT, session: 'flowC1',
    pagination: { mode: 'pageInput', needle: '页码' }, maxPages: 10,
  });
  const repCollect = c1.result.structuredContent || {};
  check('F5 三页采集 15 行且 Pass', repCollect.rowCount === 15 && repCollect.verdict === 'Pass',
    `rows=${repCollect.rowCount} stop=${repCollect.stopReason}`);
  check('F5 空页判定停止（不翻第 4 页）', repCollect.stopReason === 'empty', repCollect.stopReason);
  check('F5 行数据只落盘不回灌（结果文本无行内容）',
    !JSON.stringify(c1.result.content || []).includes('D001') && fs.existsSync(repCollect.files?.rows || ''));

  /* ---- F6 两期对比：以单页为基准跑全量 ---- */
  const cBase = await call('collect_table', {
    url: `${base}/paged?page=1`, cwd: ROOT, session: 'flowC0',
    pagination: { mode: 'none' }, maxPages: 1,
  });
  const baseRows = cBase.result.structuredContent?.files?.rows;
  const c2 = await call('collect_table', {
    url: `${base}/paged?page=1`, cwd: ROOT, session: 'flowC2',
    pagination: { mode: 'pageInput', needle: '页码' }, maxPages: 10,
    diffAgainst: baseRows,
  });
  const repDiff = c2.result.structuredContent || {};
  check('F6 两期对比：新增 10 / 未变 5',
    repDiff.diff?.added === 10 && repDiff.diff?.unchanged === 5 && repDiff.diff?.removed === 0,
    JSON.stringify(repDiff.diff));
  check('F6 diff.md 落盘', fs.existsSync(repDiff.files?.diff || ''));

  /* ---- F7 停止三选一的另外两种：no-new-rows / max-pages ---- */
  const c3 = await call('collect_table', {
    url: `${base}/static?page=1`, cwd: ROOT, session: 'flowC3',
    pagination: { mode: 'pageInput', needle: '页码' }, maxPages: 10,
  });
  check('F7 翻页不推进 → no-new-rows 止损（防死循环）',
    c3.result.structuredContent?.stopReason === 'no-new-rows' && c3.result.structuredContent?.rowCount === 5,
    c3.result.structuredContent?.stopReason);

  const c4 = await call('collect_table', {
    url: `${base}/inf?page=1`, cwd: ROOT, session: 'flowC4',
    pagination: { mode: 'pageInput', needle: '页码' }, maxPages: 3,
  });
  check('F7 新行无穷 → 到 max-pages 上限停', c4.result.structuredContent?.stopReason === 'max-pages');

  /* ---- F7b 断点续采：max-pages 断点 → 带基准续扫到全量（v1.8.2） ---- */
  const cRun1 = await call('collect_table', {
    url: `${base}/paged?page=1`, cwd: ROOT, session: 'flowC8a',
    pagination: { mode: 'pageInput', needle: '页码' }, maxPages: 2,
  });
  const repR1 = cRun1.result.structuredContent || {};
  check('F7b 断点跑：maxPages=2 采 10 行、max-pages 停（基准落盘可续）',
    repR1.rowCount === 10 && repR1.stopReason === 'max-pages' && fs.existsSync(repR1.files?.rows || ''),
    `rows=${repR1.rowCount} stop=${repR1.stopReason}`);
  check('F7b 非续采报告 pagesTotal=pagesScanned（两个口径无歧义）',
    repR1.pagesScanned === 2 && repR1.pagesTotal === 2,
    `scanned=${repR1.pagesScanned} total=${repR1.pagesTotal}`);

  const cRun2 = await call('collect_table', {
    url: `${base}/paged?page=1`, cwd: ROOT, session: 'flowC8b',
    pagination: { mode: 'pageInput', needle: '页码' }, maxPages: 10,
    resumeFrom: repR1.files.rows,
  });
  const repR2 = cRun2.result.structuredContent || {};
  check('F7b 续采补齐全量：15 行 / 本次新增 5 / 从第 3 页续采 / Pass',
    repR2.rowCount === 15 && repR2.addedThisRun === 5 && repR2.startPage === 3 && repR2.verdict === 'Pass',
    JSON.stringify({ rows: repR2.rowCount, added: repR2.addedThisRun, startPage: repR2.startPage, stop: repR2.stopReason }));
  check('F7b 续采报告累计页账：pagesScanned=本轮 2、pagesTotal=含基准 4（pagesScanned 不再被误读成总量）',
    repR2.pagesScanned === 2 && repR2.pagesTotal === 4,
    `scanned=${repR2.pagesScanned} total=${repR2.pagesTotal}`);

  const rows2 = JSON.parse(fs.readFileSync(repR2.files.rows, 'utf8'));
  check('F7b 链式续采可接续：pages 基准页+新页 1..4、resumedFrom 留痕、rowCount 15',
    Array.isArray(rows2.pages) && rows2.pages.map((p) => p.page).join(',') === '1,2,3,4'
    && rows2.resumedFrom === repR1.files.rows && rows2.rowCount === 15,
    JSON.stringify({ pages: rows2.pages?.map((p) => p.page), resumedFrom: !!rows2.resumedFrom }));

  const cStale = await call('collect_table', {
    url: `${base}/static?page=1`, cwd: ROOT, session: 'flowC8c',
    pagination: { mode: 'pageInput', needle: '页码' }, maxPages: 2,
    resumeFrom: repR1.files.rows,
  });
  check('F7b 指纹不符 → COLLECT_STALE（拒绝爬错页污染基准）',
    cStale.result.isError === true && cStale.result.structuredContent?.errorCode === 'COLLECT_STALE',
    cStale.result.structuredContent?.errorCode);

  const cNa = await call('collect_table', {
    url: `${base}/paged?page=1`, cwd: ROOT, session: 'flowC8d',
    pagination: { mode: 'none' }, resumeFrom: repR1.files.rows,
  });
  check('F7b 单页 + resumeFrom → COLLECT_RESUME_NOT_APPLICABLE（没有断点可续）',
    cNa.result.isError === true && cNa.result.structuredContent?.errorCode === 'COLLECT_RESUME_NOT_APPLICABLE',
    cNa.result.structuredContent?.errorCode);

  /* ---- F8 失败语义：空表 / 坏基准 / 生产守门 ---- */
  const c5 = await call('collect_table', { url: `${base}/empty`, cwd: ROOT, session: 'flowC5' });
  check('F8 零行采集 → isError COLLECT_EMPTY',
    c5.result.isError === true && c5.result.structuredContent?.errorCode === 'COLLECT_EMPTY');

  const c6 = await call('collect_table', {
    url: `${base}/paged?page=1`, cwd: ROOT, session: 'flowC6', pagination: { mode: 'none' },
    diffAgainst: path.join(CWD, 'no-such-baseline.json'),
  });
  check('F8 基准不可读 → isError DIFF_NOT_FOUND（但采集结果仍落盘）',
    c6.result.isError === true && c6.result.structuredContent?.errorCode === 'DIFF_NOT_FOUND'
    && fs.existsSync(c6.result.structuredContent?.files?.rows || ''),
    c6.result.structuredContent?.errorCode);

  const c7 = await call('collect_table', { url: 'https://prod.example.com/x', cwd: ROOT, session: 'flowC7' });
  check('F8 生产主机 → TARGET_REFUSED（浏览器都不开）',
    c7.result.isError === true && c7.result.structuredContent?.error === 'TARGET_REFUSED');

  /* ---- F9 巡检与归因收尾（全链末端） ---- */
  log('=== F9) explore_page 与 summarize_report（全链末端） ===');
  const ex = await call('explore_page', { url: `${base}/paged?page=1`, cwd: ROOT, session: 'flowX', checkLinks: false });
  check('F9 巡检干净页 → Pass', ex.result.structuredContent?.verdict === 'Pass');

  const sum = await call('summarize_report', {
    json: { stats: { expected: 3 }, suites: [{ title: 's', specs: [{ tests: [{ results: [{ status: 'failed', error: { message: 'Error: timeout 5000ms exceeded' } }], status: 'expected' }] }] }] },
  });
  check('F9 失败报告归因（超时类）', sum.result.isError !== true && /timeout|超时/i.test(sum.result.content?.[0]?.text || ''), sum.result.content?.[0]?.text?.slice(0, 60));

  /* ---- F10 脱敏哨兵：调用参数值/结果文本/密钥一律不进日志 ---- */
  log('=== F10) 日志脱敏哨兵 ===');
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('F10 观测日志有聚合字段（name=/ms=）', /name=nl_test_goal/.test(logText) && /name=collect_table/.test(logText));
  check('F10 日志无目标文本（参数值不落日志）', !logText.includes('提交订单') && !logText.includes('下单成功'));
  check('F10 日志无行数据与产物路径（结果文本不落日志）', !logText.includes('D001') && !logText.includes('rows-'));
  check('F10 日志无 LLM 地址与密钥形态', !logText.includes('127.0.0.1') && !/sk-[A-Za-z0-9]{6}/.test(logText));

  check('F10 stub LLM 真被调用过（自愈是事件驱动真回环）', llmSeen.length > 0, `calls=${llmSeen.length}`);

  /* ---- F11 计划缓存观测（v1.8.10）：真 stdio 双调用取实测行格式 ---- */
  log('=== F11) 观测日志 cache= 字段（真 stdio 双调用） ===');
  {
    // 真 stdio 传输（不是 handleMessage 直调）：日志行是协议线上的真实产物。
    // 子进程继承 stub LLM 环境（OLLAMA_BASE_URL）—— 同指纹双调用取 miss→hit 真三态；
    // maxSteps=1 只跑 goto（指纹不含 maxSteps，缓存语义不受影响），保持快速。
    const stamp = Date.now().toString(36);
    const stdLog = path.join(os.tmpdir(), `pv-flow-std-${stamp}.log`);
    const stdIn = path.join(os.tmpdir(), `pv-flow-std-${stamp}.ndjson`);
    const stdOut = `${stdIn}.out`;
    const goalArgs = { goal: goalA, url: `${base}/order`, cwd: ROOT, maxSteps: 1 };
    const stdReq = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'flow', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nl_test_goal', arguments: { ...goalArgs, session: 'flowS1' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nl_test_goal', arguments: { ...goalArgs, session: 'flowS2' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nl_test_goal', arguments: { ...goalArgs, session: 'flowS3', llm: 'off' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'explain_rules', arguments: { group: 'all' } } },
      ...['flowS1', 'flowS2', 'flowS3'].map((s, i) => ({
        jsonrpc: '2.0', id: 6 + i, method: 'tools/call',
        params: { name: 'cli_session', arguments: { subcommand: 'close', session: s, cwd: ROOT } },
      })),
    ];
    fs.writeFileSync(stdIn, `${stdReq.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const inFd = fs.openSync(stdIn, 'r');
    const outFd = fs.openSync(stdOut, 'w');
    const errFd = fs.openSync(`${stdIn}.err`, 'w');
    await new Promise((resolve) => {
      const ch = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
        cwd: ROOT, stdio: [inFd, outFd, errFd], windowsHide: true,
        env: { ...process.env, PVMCP_LOG: stdLog },
      });
      ch.on('error', () => resolve(-1));
      ch.on('close', (code) => resolve(code ?? -1));
    });
    fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd);
    const stdResp = fs.readFileSync(stdOut, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const planOf = (id) => stdResp.find((r) => r.id === id)?.result?.structuredContent?.planCache;
    const stdRaw = fs.existsSync(stdLog) ? fs.readFileSync(stdLog, 'utf8') : '';
    const stdLines = stdRaw.split('\n').filter((l) => l.includes('tools/call'));
    const shape = stdLines.map((l) => l.replace(/^\[[^\]]*\]\s*/, '')).join(' | ');
    check('F11 真 stdio 双调用：首调 miss、重放 hit（响应三态与日志行一致）',
      planOf(2) === 'miss' && planOf(3) === 'hit'
      && stdLines.some((l) => /name=nl_test_goal ms=\d+ outcome=\S+ code=\S+ cache=miss$/.test(l))
      && stdLines.some((l) => /name=nl_test_goal ms=\d+ outcome=\S+ code=\S+ cache=hit$/.test(l)),
      shape.slice(0, 160));
    check('F11 llm=off → cache=skip 落行（三态齐、cache= 紧随 code= 行尾）',
      planOf(4) === 'skip'
      && stdLines.filter((l) => / cache=skip$/.test(l)).length === 1
      && stdLines.filter((l) => /\bcache=(hit|miss|skip)$/.test(l)).every((l) => /name=nl_test_goal /.test(l)),
      shape.slice(0, 160));
    check('F11 其余工具不落 cache= 字段（写侧只给 nl_test_goal）',
      stdLines.some((l) => /name=explain_rules ms=\d+ outcome=ok code=-$/.test(l))
      && stdLines.some((l) => /name=cli_session /.test(l))
      && stdLines.some((l) => /name=nl_test_goal .*cache=(hit|miss|skip)$/.test(l))
      && stdLines.every((l) => !/\bcache=/.test(l) || /name=nl_test_goal /.test(l)));
  }
} catch (e) {
  log(`FAIL 全流程异常中断：${e.stack || e.message}`);
  failures++;
} finally {
  for (const s of ['flowA', 'flowB', 'flowC', 'flowC0', 'flowC1', 'flowC2', 'flowC3', 'flowC4', 'flowC5', 'flowC6', 'flowC7', 'flowX']) {
    try { await handleMessage({ id: 9, method: 'tools/call', params: { name: 'cli_session', arguments: { subcommand: 'close', session: s, cwd: ROOT } } }); } catch { /* 尽力收尾 */ }
  }
  site.close();
  stubLlm.close();
}

log('');
log(failures === 0 ? 'flow-check：全部通过' : `flow-check：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
