/**
 * nl-agent-e2e.mjs — 智能体线端到端（真浏览器 + 真 HTTP 靶页 + stub LLM 全链路）
 *
 * 这套证明的是「合并后的完整能力」，不是单元正确性（那在 nl-agent-check）：
 *   A) LLM 规划（stub Ollama，真回环）→ goto/fill/click/expect_text/screenshot 真执行 →
 *      判定 Pass，JSON 报告落盘且 evidence 路径真实存在；
 *   B) LLM 关闭时降级确定性骨架仍能判定（source: fallback 如实标注）；
 *   C) 断言不成立 → Fail + isError（绝不「大部分过了」）；
 *   D) explore_page 对带死链/坏图的页面报 Fail 并列出问题，对干净页面报 Pass。
 *
 * 为什么靶页自己起 HTTP 服务而不是 data: URL：
 *   智能体线硬性只放行 http/https（挡住 file://），且死链判定需要真实 HTTP 状态码。
 *   127.0.0.1 回环服务完全离线可复现。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleMessage } from '../server.mjs';
import { installStandaloneReap } from './reap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
// 单跑兜底：任何退出分支（含中途抛错）都收掉本机孤儿 daemon/浏览器。
// 在 verify-all 调度下自动跳过，由统一收尾负责（见 reap.mjs 注释）。
installStandaloneReap(ROOT, { label: 'nl-agent-e2e' });

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

// 本套全部断言（LLM 规划→真执行 / 降级骨架 / Fail 语义 / 巡检）都要真实 CLI 执行层。
// 缺可选依赖时诚实 SKIP（纯净包口径）：可选依赖由被测项目/本机提供，不随纯净发布包分发 ——
// 硬跑只会把「依赖缺失」报成「判定 Fail」，把人引去查用例的歧路。
if (!(await import('../lib/runner.js')).resolveCliRunner(ROOT)) {
  log('SKIP（缺可选依赖 @playwright/cli：纯净包口径 —— 可选依赖由被测项目/本机提供）');
  log('本套全部断言都需要真实 CLI 执行层，本次未执行任何断言。');
  process.exit(0);
}

/* ---- 靶站：一个带交互/死链/坏图的页面 + 一个干净页面 ---- */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function pageHtml({ title, body }) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

const sockets = new Set();
let formHits = 0; // /form 命中计数：第 1 次出 v1，之后出 v2（两期表单靶）
const site = http.createServer((req, res) => {
  // 路由直接切 req.url（不用 URL 对象取路径字段 —— H15 盲钉禁止那种写法）
  const p = (req.url || '/').split('?')[0];
  if (p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml({
      title: 'NL E2E',
      body: `<h1>Welcome E2E</h1>
        <label for="q">Keyword</label><input id="q" aria-label="Keyword">
        <button id="go" onclick="document.getElementById('out').textContent='RESULT-OK'">Search</button>
        <p id="out">EMPTY</p>
        <a href="/ok">good link</a> <a href="/dead">dead link</a>
        <img id="good" src="/ok.png" alt="good"><img id="bad" src="/broken.png" alt="bad">`,
    }));
  } else if (p === '/clean') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml({
      title: 'Clean',
      body: '<h1>Welcome E2E</h1><a href="/ok">good</a><img src="/ok.png" alt="ok">',
    }));
  } else if (p === '/ok') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml({ title: 'OK', body: '<p>ok page</p>' }));
  } else if (p === '/ok.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG_1x1);
  } else if (p === '/form') {
    // 表单两期靶：第 1 次命中出 v1，之后出 v2（删 pass / 加 mobile / email 变必填）
    formHits++;
    const input = (name, type, required) => `<input name="${name}" type="${type}"${required ? ' required' : ''}>`;
    const v = formHits <= 1 ? 1 : 2;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml({
      title: `Form ${v}`,
      body: `<form action="/submit" method="post">${input('user', 'text')}${input('email', 'text', v === 2)}`
        + `${v === 1 ? input('pass', 'password', true) : input('mobile', 'number')}<button type="button">go</button></form>`,
    }));
  } else if (p === '/dead' || p === '/broken.png') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } else {
    res.writeHead(404); res.end('nope');
  }
});
site.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

/* ---- stub Ollama：真 HTTP 回环，回一份完整计划 ---- */
const llmSeen = [];
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    llmSeen.push({ url: req.url, body: JSON.parse(body || '{}') });
    const plan = {
      steps: [
        { act: 'goto', target: `${SITE}/` },
        { act: 'fill', target: '#q', value: 'hello-e2e' },
        { act: 'click', target: '#go' },
        { act: 'expect_text', value: 'RESULT-OK' },
        { act: 'screenshot' },
      ],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: JSON.stringify(plan) } }));
  });
});
llm.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
const LLM_BASE = `http://127.0.0.1:${llm.address().port}`;

// 让 server.mjs 里的 resolveLlm() 走 stub（handler 不带 env 参数，读 process.env）
process.env.PVMCP_LLM = 'ollama';
process.env.OLLAMA_BASE_URL = LLM_BASE;
process.env.OLLAMA_MODEL = 'qwen3-e2e';

const call = (name, args) => handleMessage({ id: 1, method: 'tools/call', params: { name, arguments: args } });
const ts = Date.now().toString(36);
// 会话名登记：收尾时只关自己开过的会话。绝不用 close-all —— 那会把 --parallel
// 并发兄弟套件的会话一起杀掉（并行假失败的踩踏面之一，见 verify-all 调度注释）。
const usedSessions = [];
const sess = (name) => { usedSessions.push(name); return name; };

log(`靶站：${SITE}　stub LLM：${LLM_BASE}\n`);

/* ---- A) LLM 全链路：规划→真执行→Pass 报告 ---- */
log('=== A) nl_test_goal：LLM 规划 + 真浏览器执行 ===');
{
  const r = await call('nl_test_goal', {
    goal: '输入关键词并点击搜索后，结果区应显示 "RESULT-OK"',
    url: `${SITE}/`,
    cwd: ROOT,
    session: sess(`nl-e2e-a-${ts}`),
    maxSteps: 12,
  });
  check('全链路判定 Pass 且不报 isError', !r.result.isError && r.result.structuredContent?.verdict === 'Pass',
    JSON.stringify(r.result.structuredContent?.verdict) + ' | ' + (r.result.content?.[0]?.text || '').slice(0, 120));
  check('计划来源标注为 llm', r.result.structuredContent?.source === 'llm', r.result.structuredContent?.planNote);
  const steps = r.result.structuredContent?.steps || [];
  check('五个步骤全部执行（goto/fill/click/expect_text/screenshot）',
    steps.length === 5 && steps.every((s) => s.ok === true), steps.map((s) => `${s.act}:${s.ok}`).join(','));
  check('LLM 桩真的被请求过（/api/chat）', llmSeen.some((s) => s.url === '/api/chat' && s.body?.format === 'json'));

  const reportFile = r.result.structuredContent?.reportFile;
  check('JSON 报告落盘且含 CI 判定字段',
    !!reportFile && fs.existsSync(reportFile)
    && JSON.parse(fs.readFileSync(reportFile, 'utf8')).verdict === 'Pass', reportFile);
  const ev = steps.filter((s) => s.evidence && fs.existsSync(s.evidence));
  check('步骤证据文件真实存在（快照/截图）', ev.length >= 2, ev.map((e) => path.basename(e.evidence)).join(','));
}

/* ---- B) 降级骨架：LLM off 仍可判定，如实标注 fallback ---- */
log('=== B) nl_test_goal：llm=off 降级骨架 ===');
{
  const r = await call('nl_test_goal', {
    goal: '打开首页应能看到 "Welcome E2E"',
    url: `${SITE}/`,
    cwd: ROOT,
    session: sess(`nl-e2e-b-${ts}`),
    llm: 'off',
  });
  check('骨架判定 Pass（引号断言被抽取）', !r.result.isError && r.result.structuredContent?.verdict === 'Pass',
    r.result.content?.[0]?.text?.slice(0, 120));
  check('来源如实标注 fallback', r.result.structuredContent?.source === 'fallback');
}

/* ---- C) 断言不成立 → Fail，绝不放宽 ---- */
log('=== C) nl_test_goal：断言不成立必须 Fail ===');
{
  const r = await call('nl_test_goal', {
    goal: '页面应显示 "MISSING-TEXT-XYZ"',
    url: `${SITE}/`,
    cwd: ROOT,
    session: sess(`nl-e2e-c-${ts}`),
    llm: 'off',
  });
  check('断言不成立 → isError 且 verdict=Fail', r.result.isError === true
    && r.result.structuredContent?.verdict === 'Fail',
    r.result.structuredContent?.verdict);
  check('失败原因写明「不放宽」', (r.result.structuredContent?.steps || []).some((s) => (s.detail || '').includes('不放宽')));
}

/* ---- D) explore_page：死链坏图报 Fail，干净页 Pass ---- */
log('=== D) explore_page：死链/坏图巡检 ===');
{
  const bad = await call('explore_page', {
    url: `${SITE}/`,
    cwd: ROOT,
    session: sess(`nl-e2e-d1-${ts}`),
    maxLinks: 10,
  });
  check('问题页 → isError 且 verdict=Fail', bad.result.isError === true
    && bad.result.structuredContent?.verdict === 'Fail', bad.result.structuredContent?.verdict);
  const issues = bad.result.structuredContent?.issues || [];
  check('死链被点名（/dead HTTP 404）', issues.some((i) => i.kind === 'dead-link' && String(i.href).includes('/dead')),
    JSON.stringify(issues).slice(0, 160));
  check('坏图被点名（/broken.png 加载失败）', issues.some((i) => i.kind === 'broken-image' && String(i.src).includes('/broken.png')),
    JSON.stringify(issues).slice(0, 160));
  check('报告落盘', !!bad.result.structuredContent?.issues && fs.existsSync(
    path.join(ROOT, '.playwright-artifacts', 'reports'),
  ));

  const good = await call('explore_page', {
    url: `${SITE}/clean`,
    cwd: ROOT,
    session: sess(`nl-e2e-d2-${ts}`),
    maxLinks: 10,
  });
  check('干净页 → Pass 且不报 isError', !good.result.isError
    && good.result.structuredContent?.verdict === 'Pass',
    JSON.stringify(good.result.structuredContent?.issues || []));
  check('干净页仍有盘点数据（链接/图片/表单字段）',
    (good.result.structuredContent?.links?.total || 0) >= 1
    && (good.result.structuredContent?.images?.total || 0) >= 1,
    JSON.stringify(good.result.structuredContent?.links));

  /* ---- D 续：表单指纹与两期对比真跑（v1.8.12）---- */
  const f1 = await call('explore_page', {
    url: `${SITE}/form`,
    cwd: ROOT,
    session: sess(`nl-e2e-d3-${ts}`),
    checkLinks: false,
  });
  const fr1 = f1.result.structuredContent || {};
  check('D 续 一期报告带表单指纹与 facts 指针：formsHash/逐表单 hash/factsFile 落盘可读',
    f1.result.isError !== true && /^[0-9a-f]{16}$/.test(fr1.formsHash || '')
    && /^[0-9a-f]{16}$/.test(fr1.forms?.[0]?.hash || '')
    && typeof fr1.factsFile === 'string' && fs.existsSync(fr1.factsFile),
    `formsHash=${fr1.formsHash}`);
  const f2 = await call('explore_page', {
    url: `${SITE}/form`,
    cwd: ROOT,
    session: sess(`nl-e2e-d3-${ts}`),
    checkLinks: false,
    diffAgainst: fr1.factsFile,
  });
  const fr2 = f2.result.structuredContent || {};
  const fd = fr2.formsDiff || {};
  check('D 续 两期对比真跑：靶站翻版后 formsHash 变化 + 三分检出（删 pass/加 mobile/email 变必填）+ verdict 不因对比翻 Fail',
    f2.result.isError !== true && fr2.formsHash !== fr1.formsHash
    && fd.changed === true && fd.fieldsRemovedTotal === 1 && fd.fieldsRemoved?.[0]?.name === 'pass'
    && fd.fieldsAddedTotal === 1 && fd.fieldsAdded?.[0]?.name === 'mobile'
    && fd.requiredChangedTotal === 1 && fd.requiredChanged?.[0]?.name === 'email'
    && fd.requiredChanged?.[0]?.from === false && fd.requiredChanged?.[0]?.to === true
    && fr2.verdict === 'Pass',
    JSON.stringify({ removed: fd.fieldsRemoved, added: fd.fieldsAdded, req: fd.requiredChanged }));
  const badDiff = await call('explore_page', {
    url: `${SITE}/form`,
    cwd: ROOT,
    session: sess(`nl-e2e-d3-${ts}`),
    checkLinks: false,
    diffAgainst: 'C:/definitely/not/here-facts.json',
  });
  check('D 续 diffAgainst 不可读 → 诚实报错 DIFF_TARGET_INVALID（绝不静默当「无对比」）',
    badDiff.result.isError === true && badDiff.result.structuredContent?.errorCode === 'DIFF_TARGET_INVALID',
    badDiff.result.structuredContent?.errorCode);
}

/* ---- 收尾 ---- */
// 浏览器会话必须收：不收会留下 playwright-cli daemon 与 headless 浏览器孤儿进程，
// 它们带着文件句柄，会让后续整树打包（distribute 的 rmSync）报 EPERM —— 实测踩过。
// 但只关**自己登记过的**会话：close-all 会把 --parallel 并发兄弟套件的会话一起杀掉
// （那正是并行假失败的踩踏面之一）。真有漏网孤儿时，由 verify-all 收尾的 kill-all 统一收割。
try {
  const { runCli } = await import('../lib/cli.js');
  for (const s of usedSessions) {
    await runCli({ cwd: ROOT, subcommand: 'close', args: [], session: s, timeoutMs: 30_000 });
  }
} catch { /* 清理尽力而为：失败不影响判定 */ }
for (const s of sockets) s.destroy();
await new Promise((r) => site.close(() => r()));
await new Promise((r) => llm.close(() => r()));

log('');
log(failures === 0 ? 'nl-agent-e2e：全部通过' : `nl-agent-e2e：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
