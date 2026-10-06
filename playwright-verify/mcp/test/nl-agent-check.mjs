/**
 * nl-agent-check.mjs — 智能体线（自然语言声明式测试）的无浏览器验证
 *
 * 覆盖三块：
 *   1) llmclient：对着**真实回环 HTTP 桩**（node:http）验证 Ollama/DeepSeek 两种协议的
 *      请求形态与响应解析 —— 不 mock fetch，走真 socket，请求体/鉴权头都能断言；
 *   2) nlplan/agent/explore 纯函数层：动作白名单拒绝静默丢弃、危险目标拒绝、
 *      生产地址审批口径、fail-fast 执行、JSON 报告形状、死链坏图判定口径；
 *   3) 工具面：tools/list 16 个工具、nl_test_goal 的拒绝路径（不开浏览器）；
 *   4) 自愈线与采集线纯函数（v1.8.0）：语义词提取、候选排序、选择题边界、翻页归并与两期对比；
 *   5) 自愈 LLM 预算闸门（v1.8.1）：整次运行调用预算、耗尽短路零调用、穿线与报告用量；
 *   6) 探活预算闸门（v1.8.5）：慢死主机单探测超时、整段总预算、耗尽诚实 partial 不静默吞链接。
 *
 * 为什么 LLM 用桩而不用真模型：本套要能离线、可复现、随分发跑绿。
 * 真模型只影响「规划质量」，不影响「链路正确性」；链路正确性就是本套要钉的东西。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLlm, llmChatJson, llmStatus, maskSecrets } from '../lib/llmclient.js';
import { normalizePlan, fallbackPlan, verdictOf, buildPlanMessages, ACTS, PLAN_MAX_STEPS } from '../lib/nlplan.js';
import {
  assertGoalAllowed, assertTargetAllowed, executePlan, buildReport, writeReport, DANGEROUS_GOAL_PATTERNS, stepCliArgs, judgeExpectation,
} from '../lib/agent.js';
import { browserChannelFlags } from '../lib/cli.js';
import {
  parseFactsFile, judgeImages, classifyLinks, probeLinks, judgeExplore, parseConsoleErrors,
  formHash, formsSummary, diffForms,
} from '../lib/explore.js';
import {
  HEALABLE_ACTS, needleFromTarget, refFromLine, healCandidates, isLikelyLocatorFailure,
  parseSnapshotInventory, parseHealPick, buildHealMessages, tryHealStep,
  createHealLlmBudget, DEFAULT_HEAL_LLM_BUDGET, HEAL_LLM_BUDGET_MAX,
} from '../lib/heal.js';
import { mergeRows, diffRows, formatCsv, judgeCollect, planResume } from '../lib/collect.js';
import { planFingerprint, createPlanCache, PLAN_CACHE_TTL_MS, PLAN_CACHE_CAPACITY } from '../lib/plancache.js';
import { runCli } from '../lib/cli.js';
import { handleMessage } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

/* ================= A) LLM 协议回环（真实 HTTP 桩） ================= */
log('=== A) llmclient：协议形态与失败归因（回环桩） ===');

/** 起一个假 LLM 服务：记录请求，按剧本回响应。routes 返回 {noResponse:true} 时不回包（触发超时）。 */
function startStub(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 非 JSON 请求也记录 */ }
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed, raw: body });
      const r = routes(req.url, parsed);
      if (r && r.noResponse) return; // 故意不回包：验证客户端超时归因
      const rr = r || { status: 404, json: { error: 'not found' } };
      res.writeHead(rr.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rr.json || {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        seen,
        base: `http://127.0.0.1:${server.address().port}`,
        // closeAllConnections：否则挂着的超时连接会让进程退出时触发 libuv 断言
        close: () => new Promise((res) => {
          server.closeAllConnections?.();
          server.close(() => res());
        }),
      });
    });
  });
}

{
  // 假 Ollama：/api/chat 回合法计划 JSON
  const planJson = JSON.stringify({ steps: [{ act: 'goto', target: 'https://t.example.com' }, { act: 'expect_text', value: 'OK' }] });
  const stub = await startStub((url) => (url === '/api/chat'
    ? { status: 200, json: { message: { content: planJson } } }
    : null));
  const env = { PVMCP_LLM: 'ollama', OLLAMA_BASE_URL: stub.base, OLLAMA_MODEL: 'qwen3-test' };
  const r = await llmChatJson({ system: 'S', user: 'U', env });
  check('Ollama 回环：ok 且解析出 JSON 计划', r.ok && r.json?.steps?.length === 2 && r.provider === 'ollama', JSON.stringify(r).slice(0, 120));
  const req = stub.seen[0];
  check('Ollama 请求走 /api/chat 且 method=POST', req?.url === '/api/chat' && req?.method === 'POST', req?.url);
  check('Ollama 请求体带 model/messages/format=json/stream=false',
    req?.body?.model === 'qwen3-test'
    && Array.isArray(req?.body?.messages) && req.body.messages.length === 2
    && req?.body?.format === 'json' && req?.body?.stream === false);
  check('Ollama 不带任何 Authorization（本地服务不需要凭据）', !req?.headers?.authorization);
  await stub.close();
}

{
  // 假 DeepSeek：/chat/completions 回 choices 结构；鉴权头必须来自 env
  const planJson = JSON.stringify({ steps: [{ act: 'screenshot' }, { act: 'expect_visible', target: '#x' }] });
  const stub = await startStub((url) => (url === '/chat/completions'
    ? { status: 200, json: { choices: [{ message: { content: planJson } }] } }
    : null));
  const key = 'sk-test-key-abcdef123456';
  const env = { PVMCP_LLM: 'deepseek', DEEPSEEK_API_KEY: key, DEEPSEEK_BASE_URL: stub.base };
  const r = await llmChatJson({ system: 'S', user: 'U', env });
  const req = stub.seen[0];
  check('DeepSeek 回环：ok 且解析出 JSON 计划', r.ok && r.json?.steps?.length === 2 && r.provider === 'deepseek');
  check('DeepSeek 鉴权头来自环境变量（Bearer）', req?.headers?.authorization === `Bearer ${key}`, String(req?.headers?.authorization));
  check('DeepSeek 请求带 response_format=json_object 与 stream=false',
    req?.body?.response_format?.type === 'json_object' && req?.body?.stream === false);
  check('DeepSeek key 不出现在 URL（凭据不进地址）', !req?.url.includes(key));
  await stub.close();
}

{
  // key 缺失 / off / 不可达 / 非 JSON / 超时 / HTTP 错误 —— 每种失败都要有明确 reason
  const noKey = await llmChatJson({ system: 'S', user: 'U', env: { PVMCP_LLM: 'deepseek' } });
  check('deepseek 缺 key → LLM_KEY_MISSING（凭据只从 env）', !noKey.ok && noKey.reason === 'LLM_KEY_MISSING', noKey.why);

  const off = await llmChatJson({ system: 'S', user: 'U', env: { PVMCP_LLM: 'off' } });
  check('PVMCP_LLM=off → LLM_OFF', !off.ok && off.reason === 'LLM_OFF');

  const stubBad = await startStub(() => ({ status: 200, json: { message: { content: '这不是 JSON 只是闲聊' } } }));
  const notJson = await llmChatJson({ system: 'S', user: 'U', env: { PVMCP_LLM: 'ollama', OLLAMA_BASE_URL: stubBad.base } });
  check('LLM 返回非 JSON → LLM_NOT_JSON（不编造解析结果）', !notJson.ok && notJson.reason === 'LLM_NOT_JSON', notJson.why);
  await stubBad.close();

  const stub500 = await startStub(() => ({ status: 500, json: { error: 'boom' } }));
  const http500 = await llmChatJson({ system: 'S', user: 'U', env: { PVMCP_LLM: 'ollama', OLLAMA_BASE_URL: stub500.base } });
  check('LLM 服务 500 → LLM_HTTP_500', !http500.ok && http500.reason === 'LLM_HTTP_500', http500.reason);
  await stub500.close();

  const stubSlow = await startStub(() => ({ noResponse: true }));
  // 桩不回响应 → 超时
  const slow = await llmChatJson({ system: 'S', user: 'U', env: { PVMCP_LLM: 'ollama', OLLAMA_BASE_URL: stubSlow.base }, timeoutMs: 300 });
  check('LLM 无响应 → LLM_TIMEOUT', !slow.ok && slow.reason === 'LLM_TIMEOUT', slow.reason);
  await stubSlow.close();

  const unreachable = await llmChatJson({ system: 'S', user: 'U', env: { PVMCP_LLM: 'ollama', OLLAMA_BASE_URL: 'http://127.0.0.1:1' }, timeoutMs: 2000 });
  check('LLM 不可达 → LLM_UNREACHABLE', !unreachable.ok && unreachable.reason === 'LLM_UNREACHABLE', unreachable.reason);
}

{
  // 配置解析：未知值回落本地（宁可本地，不静默切云端）；key 永不进返回值
  const cfg = resolveLlm({ PVMCP_LLM: 'wat' });
  check('PVMCP_LLM 未知取值回落 ollama（不静默切云端）', cfg.kind === 'ollama', cfg.why);
  const ds = resolveLlm({ PVMCP_LLM: 'deepseek', DEEPSEEK_API_KEY: 'sk-secret-xyz-123456' });
  check('resolveLlm 返回值不带 key 明文', !JSON.stringify({ ...ds, sign: undefined }).includes('sk-secret'), JSON.stringify({ ...ds, sign: undefined }).slice(0, 80));
  const masked = maskSecrets('报错里带着 sk-secret-xyz-123456 与 Bearer abcdefghijklmnop', { DEEPSEEK_API_KEY: 'sk-secret-xyz-123456' });
  check('maskSecrets 抹掉 key 与 Bearer', !masked.includes('sk-secret-xyz-123456') && !masked.includes('abcdefghijklmnop'), masked);
  const st = llmStatus({ PVMCP_LLM: 'off' });
  check('llmStatus 只报配置不报 key', st.provider === 'off' && !JSON.stringify(st).includes('API_KEY'));
}

/* ================= B) 计划归一化（白名单拒绝静默丢弃） ================= */
log('=== B) nlplan：计划契约与降级骨架 ===');

{
  const good = normalizePlan({ steps: [
    { act: 'goto', target: 'https://t.example.com' },
    { act: 'fill', target: '#q', value: 'hello' },
    { act: 'click', target: '#go' },
    { act: 'expect_text', value: 'RESULT-OK' },
    { act: 'screenshot' },
  ] });
  check('合法计划全收', good.ok && good.steps.length === 5 && good.problems.length === 0);

  const bad = normalizePlan({ steps: [
    { act: 'goto', target: 'https://t.example.com' },
    { act: 'eval', target: 'alert(1)' },
    { act: 'expect_text', value: 'x' },
  ] });
  check('白名单外动作（eval）被拒绝且**不静默丢弃**', !bad.ok && bad.problems.some((p) => p.includes('eval')) && bad.steps.length === 0,
    bad.problems.join('；'));
  check('拒绝文案说明「不做不错」', bad.problems.some((p) => p.includes('不做不错')), bad.problems.join('；'));

  const missing = normalizePlan({ steps: [{ act: 'fill', target: '#q' }] });
  check('缺参数（fill 缺 value）被拒绝', !missing.ok && missing.problems.some((p) => p.includes('value')));

  const fileUrl = normalizePlan({ steps: [{ act: 'goto', target: 'file:///etc/passwd' }] });
  check('goto 非 http/https 被拒绝', !fileUrl.ok && fileUrl.problems.some((p) => p.includes('http')));

  const huge = normalizePlan({ steps: Array.from({ length: PLAN_MAX_STEPS + 1 }, () => ({ act: 'screenshot' })) });
  check(`超过 ${PLAN_MAX_STEPS} 步被拒绝（不截断执行）`, !huge.ok && huge.problems.some((p) => p.includes('上限')));

  const notJson = normalizePlan('只是自然语言没有 JSON');
  check('非 JSON 计划报解析问题', !notJson.ok && notJson.problems.length > 0);
}

{
  // 降级骨架：引号断言抽取 + 无引号时如实说明证明力有限
  const fb = fallbackPlan({ goal: '登录后应看到 "RESULT-OK" 与「欢迎」', url: 'https://t.example.com' });
  check('骨架抽取引号断言', fb.source === 'fallback'
    && fb.steps[0].act === 'goto'
    && fb.steps.some((s) => s.act === 'expect_text' && s.value === 'RESULT-OK')
    && fb.steps.some((s) => s.act === 'expect_text' && s.value === '欢迎'), JSON.stringify(fb.steps));
  const bare = fallbackPlan({ goal: '随便看看页面', url: 'https://t.example.com' });
  check('无引号目标如实声明「证明不了对」', bare.problems.some((p) => p.includes('证明不了')), bare.problems.join('；'));
}

{
  // 判定语义：没有断言就不算 Pass（防「全绿但什么都没验」的静默假通过）
  check('verdictOf 全动作步无断言 → Blocked', verdictOf([
    { act: 'goto', ok: true }, { act: 'screenshot', ok: true },
  ]) === 'Blocked');
  check('verdictOf 有断言且全过 → Pass', verdictOf([
    { act: 'goto', ok: true }, { act: 'expect_text', ok: true },
  ]) === 'Pass');
  check('verdictOf 任一步失败 → Fail', verdictOf([
    { act: 'goto', ok: true }, { act: 'expect_text', ok: false },
  ]) === 'Fail');
  check('verdictOf 空结果 → Blocked', verdictOf([]) === 'Blocked');
  const msgs = buildPlanMessages({ goal: 'g', url: 'u', facts: { a: 1 } });
  check('规划消息含输出契约与动作白名单', msgs.system.includes('只输出一个 JSON') && msgs.user.includes('动作白名单'));
}

/* ================= C) 守门（禁止做什么是代码不是口号） ================= */
log('=== C) agent：危险目标/生产地址拒绝 + fail-fast 执行 ===');

{
  const dangers = [
    '把生产库的订单数据全部删除',
    '对真实资金账户发起转账',
    'drop table users',
    '向所有用户群发邮件通知',
    '批量注册 1000 个账号',
    '给供应商转账 5000 元',
  ];
  for (const g of dangers) {
    const r = assertGoalAllowed(g);
    check(`危险目标被拒绝：${g.slice(0, 18)}…`, !r.ok && !!r.why, r.why);
  }
  const moneyRefused = assertGoalAllowed('给供应商转账 5000 元');
  check('资金动词无测试语境时拒绝文案给出路（注明测试语境即可）',
    !moneyRefused.ok && moneyRefused.why.includes('测试'), moneyRefused.why);
  const benign = [
    '登录后把商品加入购物车，购物车里应看到该商品',
    '验证搜索结果页能看到 "RESULT-OK"',
    '测试环境走一遍下单流程，确认订单状态为待支付（测试数据）',
    '演练支付回调的展示逻辑，确认状态徽标正确',
  ];
  for (const g of benign) {
    const r = assertGoalAllowed(g);
    check(`正常目标放行：${g.slice(0, 18)}…`, r.ok === true, r.why || '');
  }
  check('危险清单非空且条条有 why', DANGEROUS_GOAL_PATTERNS.length >= 5
    && DANGEROUS_GOAL_PATTERNS.every((p) => p.why && p.re));

  check('file:// 被拒绝', !assertTargetAllowed('file:///etc/passwd').ok);
  check('非 URL 被拒绝', !assertTargetAllowed('not a url').ok);
  check('测试主机放行', assertTargetAllowed('https://app.test.example.com').ok === true);
  const prod = assertTargetAllowed('https://shop.production.example.com');
  check('生产主机默认拒绝并要求独立审批', !prod.ok && prod.why.includes('confirmProd'), prod.why);
  check('confirmProd=true 后放行（审批留痕生效）', assertTargetAllowed('https://shop.production.example.com', { confirmProd: true }).ok === true);
}

{
  // fail-fast：注入假执行器，第一步失败后不跑第二步
  const ran = [];
  const fakeRun = async ({ step }) => {
    ran.push(step.act);
    return { act: step.act, ok: step.act !== 'click', detail: step.act === 'click' ? '点了没反应' : '' };
  };
  const r = await executePlan({
    steps: [
      { act: 'goto', target: 'https://t.example.com' },
      { act: 'click', target: '#go' },
      { act: 'expect_text', value: 'X' },
    ],
    cwd: ROOT, session: 'fake', runStep: fakeRun,
  });
  check('失败步骤后立即停止（fail fast）', r.stopped && ran.length === 2 && !ran.includes('expect_text'), ran.join(','));
  check('停止原因人能看懂', String(r.reason).includes('点了没反应'), r.reason);

  const report = buildReport({
    goal: 'g', url: 'u', source: 'fallback', plan: { steps: [] },
    stepResults: r.steps, problems: ['p1'], startedAt: 't0',
  });
  check('报告含 CI 判定字段（verdict/steps/problems/source）',
    report.verdict === 'Fail' && Array.isArray(report.steps) && report.problems[0] === 'p1' && report.source === 'fallback');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-nl-'));
  const f = writeReport(tmp, report, 'nl');
  check('报告落盘为 JSON 文件', fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).verdict === 'Fail', f);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ================= D) 巡检判定（死链坏图口径） ================= */
log('=== D) explore：事实解析与死链坏图判定 ===');

{
  const facts = { url: 'u', title: 't', images: [], links: [], forms: [] };
  check('parseFactsFile 裸 JSON', parseFactsFile(JSON.stringify(facts))?.title === 't');
  check('parseFactsFile 双层编码 JSON', parseFactsFile(JSON.stringify(JSON.stringify(facts)))?.title === 't');
  check('parseFactsFile 裹杂讯的 JSON', parseFactsFile(`eval result: ${JSON.stringify(facts)} done`)?.title === 't');
  check('parseFactsFile 垃圾输入 → null', parseFactsFile('完全不是 JSON') === null);

  const imgs = judgeImages([
    { src: 'https://a/ok.png', complete: true, naturalWidth: 100 },
    { src: 'https://a/broken.png', complete: true, naturalWidth: 0 },
    { src: 'https://a/loading.png', complete: false, naturalWidth: 0 },
    { src: '', complete: true, naturalWidth: 0 },
  ]);
  check('坏图=加载完成且宽度 0；加载中不算', imgs.broken.length === 1 && imgs.broken[0].src === 'https://a/broken.png'
    && imgs.total === 4 && imgs.skipped === 1, JSON.stringify(imgs));

  const cls = classifyLinks([
    { href: 'https://a/1' }, { href: 'mailto:x@y.z' }, { href: 'https://a/1' },
    { href: 'javascript:void(0)' }, { href: 'https://a/2' },
  ], { max: 1 });
  check('链接分类：去重/跳过非 http/受抽样上限约束',
    cls.probe.length === 1 && cls.skipped.length >= 3 && cls.total === 5, JSON.stringify(cls).slice(0, 160));

  const stub = await startStub((url) => {
    if (url === '/ok') return { status: 200, json: {} };
    if (url === '/dead') return { status: 404, json: {} };
    return { status: 500, json: {} };
  });
  const results = await probeLinks([
    { href: `${stub.base}/ok`, text: 'ok' },
    { href: `${stub.base}/dead`, text: 'dead' },
  ], { fetchImpl: globalThis.fetch, timeoutMs: 3000 });
  check('探活：200=ok，404=dead（HTTP ≥400 才算死链）',
    results.find((r) => r.href.endsWith('/ok'))?.kind === 'ok'
    && results.find((r) => r.href.endsWith('/dead'))?.kind === 'dead', JSON.stringify(results));
  await stub.close();

  const unreachableResults = await probeLinks([{ href: 'http://127.0.0.1:1/x', text: 'n' }], { timeoutMs: 1500 });
  check('网络不可达=unreachable（不是死链）', unreachableResults[0].kind === 'unreachable' && unreachableResults[0].status === 0);

  // v1.8.5 探活预算：慢死主机（接受连接但永不响应）的可控复现 —— 127.0.0.1:1 是「立即拒绝」型，
  // 兜不住「挂死」型；单探测超时与整段总预算都要对挂死主机有界，且预算耗尽不许静默吞链接。
  const stall = http.createServer(() => { /* 接受连接，永不响应 */ });
  await new Promise((r) => stall.listen(0, '127.0.0.1', r));
  const stallPort = stall.address().port;

  const tStall = Date.now();
  const stallRs = await probeLinks([{ href: `http://127.0.0.1:${stallPort}/x`, text: 's' }], { timeoutMs: 600 });
  check('D12 慢应答主机被单探测超时兜住（unreachable 且不拖成分钟级）',
    stallRs[0].kind === 'unreachable' && stallRs[0].latencyMs > 0 && stallRs[0].latencyMs < 3000 && Date.now() - tStall < 3000,
    JSON.stringify(stallRs[0]));

  const tBudget = Date.now();
  const budgetRs = await probeLinks(
    Array.from({ length: 4 }, (_, i) => ({ href: `http://127.0.0.1:${stallPort}/b${i}`, text: `b${i}` })),
    { timeoutMs: 600, concurrency: 1, budgetMs: 900 },
  );
  const flagged = budgetRs.filter((r) => r.budgetExhausted);
  check('D12 探测总预算耗尽 → 全量返回且未探条目记 budgetExhausted（不静默消失）',
    budgetRs.length === 4 && flagged.length >= 1 && flagged.length <= 3
    && budgetRs.every((r) => (r.budgetExhausted ? r.kind === 'unreachable' && r.status === 0 : true))
    && !budgetRs[0].budgetExhausted && budgetRs[0].kind === 'unreachable' && budgetRs[0].latencyMs > 0,
    JSON.stringify(budgetRs.map((r) => [r.kind, !!r.budgetExhausted])));
  check('D12 预算兜住整段（wall clock 有界，慢死主机不再按条数线性放大）',
    Date.now() - tBudget < 2500, `${((Date.now() - tBudget) / 1000).toFixed(1)}s`);
  stall.close();
  stall.closeIdleConnections?.();

  const stubCtrl = await startStub((url) => (url === '/ok' ? { status: 200, json: {} } : { status: 404, json: {} }));
  const ctrlRs = await probeLinks(
    [{ href: `${stubCtrl.base}/ok`, text: 'ok' }, { href: `${stubCtrl.base}/dead`, text: 'dead' }],
    { fetchImpl: globalThis.fetch, timeoutMs: 3000, budgetMs: 5000 },
  );
  check('D12 预算未耗尽 → 不凭空出现 budgetExhausted（ok/dead 判定不受预算影响）',
    ctrlRs.every((r) => !r.budgetExhausted)
    && ctrlRs.find((r) => r.href.endsWith('/ok'))?.kind === 'ok'
    && ctrlRs.find((r) => r.href.endsWith('/dead'))?.kind === 'dead',
    JSON.stringify(ctrlRs.map((r) => r.kind)));
  await stubCtrl.close();

  const judgedFail = judgeExplore({
    images: { broken: [{ src: 'b.png' }] },
    linkResults: [{ kind: 'dead', href: 'h', status: 404 }, { kind: 'unreachable', href: 'u', detail: 'offline' }],
    consoleErrors: ['Error: x'],
  });
  check('判定：死链/坏图 → Fail，不可达与控制台只进警告',
    judgedFail.verdict === 'Fail' && judgedFail.issues.length === 2 && judgedFail.warnings.length === 2,
    JSON.stringify(judgedFail).slice(0, 160));
  const judgedPass = judgeExplore({ images: { broken: [] }, linkResults: [{ kind: 'unreachable', href: 'u', detail: 'offline' }] });
  check('仅有不可达 → Pass（离线不误报）', judgedPass.verdict === 'Pass');
  check('console 解析只挑 error 级', parseConsoleErrors('info ok\nError: bad\nwarn x').length === 1);

  /* ---- D 续：表单指纹与两期对比（v1.8.12） ---- */
  const formV1 = {
    action: 'http://x/submit', method: 'post',
    inputs: [{ name: 'user', type: 'text' }, { name: 'pass', type: 'password', required: true }, { name: 'email', type: 'text' }],
  };
  const formV2 = {
    action: 'http://x/submit', method: 'post',
    inputs: [{ name: 'user', type: 'text' }, { name: 'email', type: 'text', required: true }, { name: 'mobile', type: 'number' }],
  };
  const h0 = formHash(formV1);
  check('D13 formHash 稳定：同表单同 hash、字段重排不变（序变是噪声不是漂移）、形态为 16 位十六进制',
    h0 === formHash({ ...formV1, inputs: [...formV1.inputs].reverse() }) && /^[0-9a-f]{16}$/.test(h0),
    `hash=${h0}`);
  const variants = [
    formHash({ ...formV1, inputs: [...formV1.inputs, { name: 'mobile', type: 'number' }] }), // 加字段
    formHash({ ...formV1, inputs: formV1.inputs.slice(0, 2) }), // 删字段
    formHash({ ...formV1, inputs: formV1.inputs.map((i) => (i.name === 'pass' ? { ...i, required: false } : i)) }), // 必填位翻转
    formHash({ ...formV1, action: 'http://x/submit2' }), // action 变
  ];
  check('D13 formHash 敏感：加/删字段、必填位翻转、action 变各自变 hash 且互不相同',
    variants.every((h) => h !== h0) && new Set(variants).size === 4,
    JSON.stringify(variants));
  check('D13 formsSummary：整页指纹 = 逐表单哈希串联，空表单页也出稳定 hash',
    formsSummary([formV1, formV2]).count === 2 && formsSummary([formV1, formV2]).formsHash !== formsSummary([formV1]).formsHash
    && /^[0-9a-f]{16}$/.test(formsSummary([]).formsHash) && formsSummary([]).count === 0,
    `empty=${formsSummary([]).formsHash}`);
  const d12 = diffForms([formV1], [formV2]);
  check('D13 diffForms 三分检出：字段新增/删除/必填位变化逐条对上（form 标识不带序号后缀）',
    d12.changed === true && d12.fieldsAddedTotal === 1 && d12.fieldsAdded[0].name === 'mobile' && d12.fieldsAdded[0].type === 'number'
    && d12.fieldsRemovedTotal === 1 && d12.fieldsRemoved[0].name === 'pass' && d12.fieldsRemoved[0].required === true
    && d12.requiredChangedTotal === 1 && d12.requiredChanged[0].name === 'email' && d12.requiredChanged[0].from === false && d12.requiredChanged[0].to === true
    && d12.formsAddedTotal === 0 && d12.formsRemovedTotal === 0
    && !d12.fieldsAdded[0].form.includes('#'),
    JSON.stringify({ a: d12.fieldsAdded, r: d12.fieldsRemoved, c: d12.requiredChanged }));
  const dSame = diffForms([formV1], [formV1]);
  check('D13 diffForms 无变更=changed false 全零；表单级增删按 method+action 检出',
    dSame.changed === false && dSame.fieldsAddedTotal === 0 && dSame.requiredChangedTotal === 0
    && diffForms([formV1], []).formsRemovedTotal === 1 && diffForms([], [formV1]).formsAddedTotal === 1,
    JSON.stringify({ same: dSame.changed }));
  const bigP = { action: 'http://x/s', method: 'post', inputs: Array.from({ length: 25 }, (_, i) => ({ name: `f${i}`, type: 'text' })) };
  const bigC = { action: 'http://x/s', method: 'post', inputs: Array.from({ length: 25 }, (_, i) => ({ name: `g${i}`, type: 'text' })) };
  const dBig = diffForms([bigP], [bigC]);
  check('D13 diffForms 明细有界：超 20 条各截 20 + *Total 诚实计数（对比结果回灌也有界）',
    dBig.fieldsAdded.length === 20 && dBig.fieldsAddedTotal === 25
    && dBig.fieldsRemoved.length === 20 && dBig.fieldsRemovedTotal === 25
    && dBig.changed === true,
    `added=${dBig.fieldsAdded.length}/${dBig.fieldsAddedTotal}`);
}

/* ================= E) 工具面与拒绝路径（不开浏览器） ================= */
log('=== E) 工具面：16 个工具 + nl_test_goal 拒绝路径 ===');

{
  const list = await handleMessage({ id: 1, method: 'tools/list', params: {} });
  const tools = list.result.tools;
  check('tools/list 返回 16 个工具', tools.length === 16, `${tools.length} 个`);
  const EXPECTED = [
    'check_config', 'lint_spec', 'summarize_report', 'run_verify', 'setup-browser-config',
    'cli_session', 'cli_batch', 'cli_health',
    'explore_page', 'nl_test_goal', 'generate_scripts', 'check_standards', 'orchestrate_excel',
    'explain_rules', 'collect_table', 'selfcheck',
  ];
  check('16 个工具名齐全', EXPECTED.every((t) => tools.some((x) => x.name === t)),
    EXPECTED.filter((t) => !tools.some((x) => x.name === t)).join(','));

  const call = (name, args) => handleMessage({ id: 2, method: 'tools/call', params: { name, arguments: args } });

  const refused = await call('nl_test_goal', { goal: '删除生产库的所有订单', url: 'https://test.example.com' });
  check('nl_test_goal 危险目标 → isError GOAL_REFUSED',
    refused.result.isError === true && refused.result.structuredContent.error === 'GOAL_REFUSED',
    refused.result.structuredContent.why);
  check('拒绝发生在打开浏览器之前（无日志产物依赖）', refused.result.content[0].text.includes('硬拦截'));

  const prodRefused = await call('nl_test_goal', { goal: '验证登录页', url: 'https://app.production.example.com' });
  check('nl_test_goal 生产地址 → TARGET_REFUSED 且提示 confirmProd',
    prodRefused.result.isError === true && prodRefused.result.structuredContent.error === 'TARGET_REFUSED'
    && prodRefused.result.content[0].text.includes('confirmProd'));

  const schemeRefused = await call('explore_page', { url: 'file:///etc/passwd' });
  check('explore_page file:// → TARGET_REFUSED', schemeRefused.result.isError === true
    && schemeRefused.result.structuredContent.error === 'TARGET_REFUSED');

  const emptyGoal = await call('nl_test_goal', { goal: '', url: 'https://test.example.com' });
  check('空目标 → GOAL_REFUSED（不静默执行空计划）', emptyGoal.result.isError === true
    && emptyGoal.result.structuredContent.error === 'GOAL_REFUSED');

  const missingArgs = await call('nl_test_goal', { goal: 'x' });
  check('缺 url 的调用被 schema/守门拦下（不静默成功）', missingArgs.result.isError === true || !!missingArgs.error,
    JSON.stringify(missingArgs).slice(0, 80));

  // 整数参数拒绝浮点（实测 bug 钉）：keyIndex=1.5 曾静默零行并误报 COLLECT_EMPTY 怪给站点
  const badKey = await call('collect_table', {
    url: 'https://test.example.com/x', pagination: { mode: 'none' }, keyIndex: 1.5,
  });
  check('E collect_table keyIndex=1.5 → 参数层「应为整数」（不再误导 COLLECT_EMPTY）',
    badKey.result.isError === true
    && badKey.result.structuredContent.error === 'TOOL_EXCEPTION'
    && String(badKey.result.structuredContent.message || '').includes('应为整数')
    && !('rowCount' in badKey.result.structuredContent),
    JSON.stringify(badKey.result.structuredContent).slice(0, 120));

  const badPages = await call('collect_table', {
    url: 'https://test.example.com/x', pagination: { mode: 'pageInput' }, maxPages: 2.5,
  });
  check('E collect_table maxPages=2.5 → 参数层「应为整数」（不静默当 3 页用）',
    badPages.result.isError === true
    && badPages.result.structuredContent.error === 'TOOL_EXCEPTION'
    && String(badPages.result.structuredContent.message || '').includes('应为整数')
    && !('rowCount' in badPages.result.structuredContent),
    JSON.stringify(badPages.result.structuredContent).slice(0, 120));

  // v1.8.5 探活预算参数与 maxLinks 整数化：抽样上限/预算参数没有小数语义（与 keyIndex/maxPages 同一教训）
  const badProbeT = await call('explore_page', { url: 'https://test.example.com/x', probeTimeoutMs: 1.5 });
  check('E explore_page probeTimeoutMs=1.5 → 参数层「应为整数」（预算参数不接受小数）',
    badProbeT.result.isError === true
    && badProbeT.result.structuredContent.error === 'TOOL_EXCEPTION'
    && String(badProbeT.result.structuredContent.message || '').includes('应为整数'),
    JSON.stringify(badProbeT.result.structuredContent).slice(0, 120));

  const badMaxLinks = await call('explore_page', { url: 'https://test.example.com/x', maxLinks: 2.5 });
  check('E explore_page maxLinks=2.5 → 参数层「应为整数」（不静默当 2 或 3 条用）',
    badMaxLinks.result.isError === true
    && badMaxLinks.result.structuredContent.error === 'TOOL_EXCEPTION'
    && String(badMaxLinks.result.structuredContent.message || '').includes('应为整数'),
    JSON.stringify(badMaxLinks.result.structuredContent).slice(0, 120));

  // v1.8.6 整数化清扫（retries/timeoutMs×2/maxSteps）：重试次数、毫秒超时、步数上限都没有小数合法语义。
  // retries 用不存在的 cwd：参数闸必须在目录检查之前（否则「参数非法」会被报成 NOT_FOUND 误导修复方向）。
  const badRetries = await call('run_verify', { cwd: 'D:/definitely/not/exist', retries: 1.5 });
  check('E run_verify retries=1.5 → 参数层「应为整数」（且先于目录存在性检查）',
    badRetries.result.isError === true
    && badRetries.result.structuredContent.error === 'TOOL_EXCEPTION'
    && String(badRetries.result.structuredContent.message || '').includes('应为整数'),
    JSON.stringify(badRetries.result.structuredContent).slice(0, 120));

  const badRunTimeout = await call('run_verify', { cwd: 'D:/definitely/not/exist', timeoutMs: 0.5 });
  check('E run_verify timeoutMs=0.5 → 参数层「应为整数」（不再被 || 默认值放行成 0.5ms 真超时）',
    badRunTimeout.result.isError === true
    && badRunTimeout.result.structuredContent.error === 'TOOL_EXCEPTION'
    && String(badRunTimeout.result.structuredContent.message || '').includes('应为整数'),
    JSON.stringify(badRunTimeout.result.structuredContent).slice(0, 120));

  const badCliTimeout = await call('cli_session', { subcommand: 'console', timeoutMs: 0.5 });
  check('E cli_session timeoutMs=0.5 → 参数层「应为整数」（进 CLI 之前拦下）',
    badCliTimeout.result.isError === true
    && badCliTimeout.result.structuredContent.error === 'TOOL_EXCEPTION'
    && String(badCliTimeout.result.structuredContent.message || '').includes('应为整数'),
    JSON.stringify(badCliTimeout.result.structuredContent).slice(0, 120));

  const badMaxSteps = await call('nl_test_goal', { goal: '验证登录页能打开', url: 'https://test.example.com/x', maxSteps: 2.5, llm: 'off' });
  check('E nl_test_goal maxSteps=2.5 → 参数层「应为整数」（计划上限不静默夹成 2.5）',
    badMaxSteps.result.isError === true
    && badMaxSteps.result.structuredContent.error === 'TOOL_EXCEPTION'
    && String(badMaxSteps.result.structuredContent.message || '').includes('应为整数'),
    JSON.stringify(badMaxSteps.result.structuredContent).slice(0, 120));

  // v1.8.7 多报告趋势工具面：互斥口径 / 坏报告不静默跳过 / 真两份报告出趋势且 md 落盘
  const conflict = await call('summarize_report', { file: 'a.json', files: ['b.json', 'c.json'] });
  check('E summarize_report files 与 file/json 互斥 → BAD_ARGS（一次只用一种口径）',
    conflict.result.isError === true && conflict.result.structuredContent.error === 'BAD_ARGS',
    JSON.stringify(conflict.result.structuredContent).slice(0, 100));

  const tmpTrend = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-trend-'));
  const badMember = path.join(tmpTrend, 'broken.json');
  fs.writeFileSync(badMember, '{"not": "a report"', 'utf8');
  fs.writeFileSync(path.join(tmpTrend, 'good.json'), JSON.stringify({
    stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0, duration: 10 },
    suites: [{ title: 's', specs: [{ title: 'p', ok: true, file: 's.spec.ts', tests: [{ status: 'expected', results: [] }] }] }],
  }), 'utf8');
  const badTrend = await call('summarize_report', { cwd: tmpTrend, files: ['good.json', 'broken.json'] });
  check('E summarize_report 多报告成员不可解析 → REPORT_ERROR 指名道姓（不静默跳过再出假趋势）',
    badTrend.result.isError === true && badTrend.result.structuredContent.errorCode === 'REPORT_ERROR'
    && badTrend.result.content[0].text.includes('broken.json'),
    JSON.stringify(badTrend.result.structuredContent).slice(0, 120));

  const repJson = (nFail) => JSON.stringify({
    stats: { expected: 4 - nFail, unexpected: nFail, flaky: 0, skipped: 0, duration: 100 },
    suites: [{
      title: 's', specs: [
        ...Array.from({ length: 4 - nFail }, (_, j) => ({ title: `P${j}`, ok: true, file: 's.spec.ts', tests: [{ status: 'expected', results: [] }] })),
        ...Array.from({ length: nFail }, (_, j) => ({
          title: `F${j}`, ok: false, file: 's.spec.ts',
          tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 5, errors: [{ message: 'Error: expect(locator).toHaveText(a) failed' }] }] }],
        })),
      ],
    }],
  });
  fs.writeFileSync(path.join(tmpTrend, 'w1.json'), repJson(1), 'utf8');
  fs.writeFileSync(path.join(tmpTrend, 'w2.json'), repJson(2), 'utf8');
  const trendRes = await call('summarize_report', { cwd: tmpTrend, files: ['w1.json', 'w2.json'] });
  const tr = trendRes.result.structuredContent || {};
  check('E summarize_report 两份真报告 → trend 摘要 + md/JSON 双件落盘（只回摘要不灌全表；小形态 contextTruncated=false）',
    trendRes.result.isError !== true && tr.mode === 'trend' && tr.runCount === 2
    && /2 份报告：失败 1 → 2（\+1）/.test(tr.headline)
    && typeof tr.trendFile === 'string' && fs.existsSync(tr.trendFile) && tr.trendFile.endsWith('.md')
    && typeof tr.trendJsonFile === 'string' && fs.existsSync(tr.trendJsonFile) && tr.trendJsonFile.endsWith('.json')
    && tr.contextTruncated === false
    && trendRes.result.content[0].text.includes(tr.trendFile)
    && trendRes.result.content[0].text.includes(tr.trendJsonFile),
    JSON.stringify({ mode: tr.mode, runs: tr.runCount, headline: tr.headline, trendFile: tr.trendFile }));

  // v1.8.9 趋势 md 行截断工具面：签名爆炸时 md 有界 + 诚实计数，结构化数据保全量
  const bigRepJson = (p, extra) => JSON.stringify({
    stats: { expected: 4, unexpected: p + (extra || 0), flaky: 0, skipped: 0, duration: 1000 },
    suites: [{
      title: 's', specs: [
        ...Array.from({ length: p }, (_, i) => ({
          title: `F-P${String(i + 1).padStart(3, '0')}`, ok: false, file: 's.spec.ts',
          tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 5, errors: [{ message: `Error: 持续签名P${String(i + 1).padStart(3, '0')} 金额校验失败（期望 99 实得 100）` }] }] }],
        })),
        ...Array.from({ length: extra || 0 }, (_, i) => ({
          title: `F-N${String(i + 1).padStart(3, '0')}`, ok: false, file: 's.spec.ts',
          tests: [{ status: 'unexpected', results: [{ status: 'failed', duration: 5, errors: [{ message: `Error: 新签名N${String(i + 1).padStart(3, '0')} 元素找不到` }] }] }],
        })),
        ...Array.from({ length: 4 }, (_, i) => ({ title: `P${i}`, ok: true, file: 's.spec.ts', tests: [{ status: 'expected', results: [] }] })),
      ],
    }],
  });
  const tmpBig = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-trend-big-'));
  fs.writeFileSync(path.join(tmpBig, 'b1.json'), bigRepJson(60), 'utf8');
  fs.writeFileSync(path.join(tmpBig, 'b2.json'), bigRepJson(60, 5), 'utf8');
  const bigRes = await call('summarize_report', { cwd: tmpBig, files: ['b1.json', 'b2.json'] });
  const bigTr = bigRes.result.structuredContent || {};
  const bigMdFile = fs.existsSync(bigTr.trendFile) ? fs.readFileSync(bigTr.trendFile, 'utf8') : '';
  check('E 趋势上下文有界 + 全量 JSON 落盘（v1.8.11）：structuredContent 截 50 + total 65/60 + contextTruncated/v2 + 去 sample，落盘 JSON 回读 65 条全量含 sample（CI 对账不缺行），md 持续段 50 行 +「还有 10 条」',
    bigRes.result.isError !== true
    && bigTr.signatureSeries?.length === 50 && bigTr.signatureSeriesTotal === 65 && bigTr.persistingTotal === 60
    && bigTr.contextTruncated === true && bigTr.version === 2
    && !('sample' in bigTr.signatureSeries[0])
    && typeof bigTr.trendJsonFile === 'string' && fs.existsSync(bigTr.trendJsonFile)
    && (() => {
      const full = JSON.parse(fs.readFileSync(bigTr.trendJsonFile, 'utf8'));
      return full.version === 1 && full.signatureSeries.length === 65 && full.persisting.length === 60
        && 'sample' in full.signatureSeries[0];
    })()
    && /…（该列表还有 10 条未展示，共 60 条/.test(bigMdFile)
    && /趋势落盘的同名 JSON 文件/.test(bigMdFile),
    JSON.stringify({ series: bigTr.signatureSeries?.length, total: bigTr.signatureSeriesTotal }));
  const bigResJson = await call('summarize_report', { cwd: tmpBig, files: ['b1.json', 'b2.json'], format: 'json' });
  const slimText = (() => { try { return JSON.parse(bigResJson.result.content[0].text); } catch { return null; } })();
  check('E format=json text 通道同口径有界：parse 回 series=50 + total 65 + version 2 + 去 sample（全量以落盘 JSON 为准）',
    bigResJson.result.isError !== true && !!slimText && slimText.signatureSeries.length === 50
    && slimText.signatureSeriesTotal === 65 && slimText.version === 2 && !('sample' in slimText.signatureSeries[0]),
    JSON.stringify({ series: slimText?.signatureSeries?.length }));
  fs.rmSync(tmpBig, { recursive: true, force: true });
  fs.rmSync(tmpTrend, { recursive: true, force: true });
}

/* ================= F) 自愈线与采集线纯函数（v1.8.0） ================= */
log('=== F) heal/collect：语义提取、选择题边界、翻页归并与两期对比 ===');

{
  // 语义词提取是自愈的入口：提不出词就宁可失败（不猜元素）——表里钉住「提得出」与「该 null」两侧
  check('F needleFromTarget 语义提取（中文 #id 也算标识符）',
    needleFromTarget('#提交订单') === '提交订单' && needleFromTarget('#submit-btn') === 'submit-btn'
    && needleFromTarget('.add-cart') === 'add-cart' && needleFromTarget('text=提交订单') === '提交订单'
    && needleFromTarget('[data-testid="submit-order"]') === 'submit-order'
    && needleFromTarget('确认收货') === '确认收货' && needleFromTarget('[type=submit]') === null,
    JSON.stringify([needleFromTarget('#提交订单'), needleFromTarget('[type=submit]')]));

  check('F healCandidates 按名匹配 + 角色优先 + 封顶', (() => {
    const snap = '- generic [ref=e1]:\n  - link "提交订单" [ref=e2]\n  - button "提交订单" [ref=e3]\n  - button "提交订单管理" [ref=e4]';
    const c = healCandidates(snap, '提交订单', { act: 'click', max: 3 });
    return c.length === 3 && c[0].ref === 'e3' && c[0].role === 'button' && c[2].ref === 'e2'
      && healCandidates(snap, 'add', { act: 'click' }).length === 0; // ASCII 整词：add 不匹配 address 类
  })());

  check('F refFromLine 三种 ref 形态（含 frame 域 ref）',
    refFromLine('- button "x" [ref=e12]') === 'e12' && refFromLine('ref=e9 role=button') === 'e9'
    && refFromLine('- button "x" [ref=f1e37]') === 'f1e37' && refFromLine('- generic "x"') === null);

  check('F isLikelyLocatorFailure 认真实定位失败句、不误认断言不成立',
    isLikelyLocatorFailure('执行失败（退出码 1）：Error: "#submit-btn" does not match any elements.')
    && isLikelyLocatorFailure('waiting for locator')
    && !isLikelyLocatorFailure('expect_text 不成立：期望 下单成功 实际 未下单'));

  check('F HEALABLE_ACTS 只有 click/fill（断言绝不进自愈门）',
    HEALABLE_ACTS.has('click') && HEALABLE_ACTS.has('fill')
    && !HEALABLE_ACTS.has('expect_text') && !HEALABLE_ACTS.has('expect_visible') && !HEALABLE_ACTS.has('expect_url'));

  check('F parseSnapshotInventory 只取可交互元素清单且截断（不灌整棵快照）', (() => {
    const snap = '- button "提交订单" [ref=e3]\n- textbox "页码" [ref=e37]: "1"\n- generic "装饰"';
    const inv = parseSnapshotInventory(snap, 40);
    return inv.length === 2 && inv[0].ref === 'e3' && inv[0].role === 'button' && inv[0].name === '提交订单'
      && parseSnapshotInventory(snap, 1).length === 1;
  })());

  check('F parseHealPick 选择题边界（清单内采纳/清单外与 null 拒绝）',
    parseHealPick({ ref: 'e3' }, ['e3', 'e5']) === 'e3'
    && parseHealPick({ ref: 'e99' }, ['e3']) === null
    && parseHealPick({ ref: null }, ['e3']) === null
    && parseHealPick('not-json', ['e3']) === null);

  check('F buildHealMessages 契约（只许挑清单内 ref，输出 JSON 选择题）', (() => {
    const { system, user } = buildHealMessages({
      act: 'click', target: '#submit-btn', needle: 'submit-btn',
      elements: [{ ref: 'e3', role: 'button', name: '提交订单' }],
    });
    return system.includes('定位修复器') && system.includes('只能挑清单里存在的 ref')
      && user.includes('ref=e3 role=button') && user.includes('{"ref":"eN"}');
  })());

  check('F mergeRows 首见胜出 + 空行/空键跳过（防翻页重复计数）', (() => {
    const acc = { map: new Map() };
    const a = mergeRows(acc, [['D001', '甲'], ['D002', '乙'], ['', '空键'], ['   ', '全空白']]);
    const b = mergeRows(acc, [['D001', '甲改'], ['D003', '丙']]);
    return a === 2 && b === 1 && acc.map.get('D001')[1] === '甲' && acc.map.size === 3;
  })());

  check('F diffRows 两期对比数学（新增/删除/变化/未变）', (() => {
    const d = diffRows([['D001', '甲'], ['D002', '乙'], ['D003', '丙']], [['D001', '甲'], ['D002', '乙改'], ['D004', '丁']], 0);
    return d.added.length === 1 && d.added[0][0] === 'D004'
      && d.removed.length === 1 && d.removed[0][0] === 'D003'
      && d.changed.length === 1 && d.changed[0].key === 'D002'
      && d.unchanged === 1 && d.totalPrev === 3 && d.totalCurr === 3;
  })());

  check('F formatCsv BOM + CRLF + RFC4180 转义（Excel 双击不乱码）', (() => {
    const csv = formatCsv(['编号', '备注'], [['D001', '含,逗号'], ['D002', '含"引号']]);
    return csv.startsWith('﻿') && csv.includes('\r\n')
      && csv.includes('"含,逗号"') && csv.includes('"含""引号"');
  })());

  check('F judgeCollect 只判采集本身（零行 Fail，行数多不是失败）',
    judgeCollect({ rowCount: 0, stopReason: 'empty' }).verdict === 'Fail'
    && judgeCollect({ rowCount: 15, stopReason: 'empty' }).verdict === 'Pass'
    && judgeCollect({ rowCount: 5, stopReason: 'no-new-rows' }).verdict === 'Pass');

  // 实测抓到的洞：早退失败只给 message 不给 summary，调用方读 summary → 失败原因被吞成空 detail
  const early = await runCli({ cwd: ROOT, subcommand: 'not-a-real-subcommand', args: [] });
  check('F runCli 早退失败必带 summary（失败原因不被吞成空 detail）',
    early.ok === false && early.reason === 'SUBCOMMAND_NOT_ALLOWED'
    && typeof early.summary === 'string' && early.summary.includes('白名单'),
    JSON.stringify({ reason: early.reason, summary: early.summary }));
}

/* ================= G) 自愈 LLM 预算闸门（v1.8.1） ================= */
log('=== G) 自愈 LLM 预算闸门：总闸/短路/穿线/用量 ===');
{
  check('G 预算对象：take 名额制，used/remaining 随消耗走，默认 2', (() => {
    const b = createHealLlmBudget();
    return b.limit === DEFAULT_HEAL_LLM_BUDGET && b.limit === 2
      && b.take() === true && b.take() === true && b.take() === false
      && b.used === 2 && b.remaining === 0;
  })());

  check('G 预算 0=二级自愈关闭（一次都不许烧）', (() => {
    const b = createHealLlmBudget(0);
    return b.take() === false && b.used === 0 && b.remaining === 0 && b.limit === 0;
  })());

  check('G 硬夹：99→上限 10、-5→0、3.9→3（截断不进位）', (() => {
    return HEAL_LLM_BUDGET_MAX === 10
      && createHealLlmBudget(99).limit === HEAL_LLM_BUDGET_MAX
      && createHealLlmBudget(-5).limit === 0 && createHealLlmBudget(3.9).limit === 3;
  })());

  check('G 非数字预算抛 TypeError（看不懂的值报错，不静默当 0）', (() => {
    try { createHealLlmBudget('x'); return false; } catch (e) { return e instanceof TypeError; }
  })());

  // tryHealStep 闸门验证：快照桩（有名元素但名字不匹配 → 一级落空 → 必进二级）
  const snapFile = path.join(os.tmpdir(), `pv-heal-snap-${process.pid}.txt`);
  fs.writeFileSync(snapFile, '- button "确定" [ref=e1]\n- button "取消" [ref=e2]\n');
  const runCliStub = async ({ subcommand }) => {
    if (subcommand === 'snapshot') return { ok: true, artifacts: { snapshot: snapFile }, logFiles: { stdout: '' } };
    return { ok: true, summary: 'ok', logFiles: { stdout: '' } };
  };
  let llmCalls = 0;
  const llmStub = async () => { llmCalls += 1; return { ok: true, json: { ref: 'e1' } }; };
  const step = { act: 'click', target: '提交订单' };

  const out0 = await tryHealStep({
    step, cwd: ROOT, session: 'g', runCliImpl: runCliStub, llmImpl: llmStub,
    llmBudget: createHealLlmBudget(0),
  });
  check('G 预算尽 → HEAL_LLM_BUDGET_EXHAUSTED 且 LLM 零调用（不静默降级）',
    out0.ok === false && out0.why === 'HEAL_LLM_BUDGET_EXHAUSTED'
    && out0.detail.includes('预算已用尽') && llmCalls === 0,
    JSON.stringify({ why: out0.why, llmCalls }));

  // 共享预算跨步：首步烧掉唯一名额成功，次步必须被拒且不再调 LLM
  const shared = createHealLlmBudget(1);
  const first = await tryHealStep({ step, cwd: ROOT, session: 'g', runCliImpl: runCliStub, llmImpl: llmStub, llmBudget: shared });
  const second = await tryHealStep({ step, cwd: ROOT, session: 'g', runCliImpl: runCliStub, llmImpl: llmStub, llmBudget: shared });
  check('G 共享预算两连：首步 llm-pick 成功、次步预算尽拒绝，LLM 总调用恰 1 次',
    first.ok === true && first.via === 'llm-pick e1'
    && second.ok === false && second.why === 'HEAL_LLM_BUDGET_EXHAUSTED'
    && llmCalls === 1 && shared.used === 1,
    JSON.stringify({ via: first.via, why2: second.why, llmCalls }));

  fs.rmSync(snapFile, { force: true });

  // executePlan 穿线：所有步骤共享同一预算实例，用量随执行回报
  const seen = [];
  const res = await executePlan({
    steps: [{ act: 'a', target: 't' }, { act: 'b', target: 't' }], cwd: ROOT, session: 'g',
    healLlmBudget: 3,
    runStep: async (a) => { seen.push(a.healBudget); a.healBudget.take(); return { ok: true }; },
  });
  check('G executePlan 预算穿线：同步骤共享实例 + healLlm 用量回报',
    seen.length === 2 && seen[0] === seen[1]
    && res.healLlm.budget === 3 && res.healLlm.used === 2,
    JSON.stringify(res.healLlm));

  const resDef = await executePlan({
    steps: [{ act: 'a', target: 't' }], cwd: ROOT, session: 'g',
    runStep: async () => ({ ok: true }),
  });
  check('G executePlan 缺省预算 = 2（保守默认，不是不设防）',
    resDef.healLlm.budget === 2 && resDef.healLlm.used === 0);

  // 报告增量字段：有预算就带用量，没传就缺席（旧消费方形状不变）
  const rep = buildReport({ goal: 'g', url: 'http://t', source: 'fallback', stepResults: [], healLlm: { budget: 2, used: 1 } });
  const repOld = buildReport({ goal: 'g', url: 'http://t', source: 'fallback', stepResults: [] });
  check('G buildReport 增量字段：healLlmBudget/healLlmUsed 有则带、无则缺席',
    rep.healLlmBudget === 2 && rep.healLlmUsed === 1
    && !('healLlmBudget' in repOld) && !('healLlmUsed' in repOld));

  // 步骤→CLI 位置参数映射（单一源 stepCliArgs）：click 的第二位置参数是鼠标键
  // （left|right|middle），value 绝不得透传成 button —— 真浏览器矩阵抓到的回归：
  // 带 value 的 click 步在 cliBatch 路径每次必炸。runStep/cliBatch 两路径共用，钉死不再分叉。
  check('G stepCliArgs click 只传 target（第二位置参数是鼠标键，value 不得透传成 button）',
    JSON.stringify(stepCliArgs({ act: 'click', target: 'e12', value: '提交订单' })) === JSON.stringify(['e12']));
  check('G stepCliArgs click 空 value 不产第二位（undefined 不得变成 "undefined"）',
    JSON.stringify(stepCliArgs({ act: 'click', target: 'e7' })) === JSON.stringify(['e7']));
  check('G stepCliArgs fill 双位置参数 target+value',
    JSON.stringify(stepCliArgs({ act: 'fill', target: 'e5', value: 'abc' })) === JSON.stringify(['e5', 'abc']));
  check('G stepCliArgs goto 取 target、press 按键取 value（都空才容错回退）',
    JSON.stringify(stepCliArgs({ act: 'goto', value: 'http://t' })) === JSON.stringify(['http://t'])
    && JSON.stringify(stepCliArgs({ act: 'press', target: 'Enter' })) === JSON.stringify(['Enter'])
    && JSON.stringify(stepCliArgs({ act: 'press', target: 'e12', value: 'Enter' })) === JSON.stringify(['Enter']));
  check('G stepCliArgs 未知动作返回空数组（不瞎猜参数）',
    JSON.stringify(stepCliArgs({ act: 'expect_text', target: 'x', value: 'y' })) === JSON.stringify([]));
}

/* ============ G2) 执行语义收敛：结果形状 + 断言判定（v1.8.16） ============ */
log('=== G2) executePlan 双路径语义收敛：结果带 act / expect_* 按快照判定 ===');
{
  const tmpSnap = path.join(os.tmpdir(), `pv-judge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`);
  fs.writeFileSync(tmpSnap, 'welcome result-ok page');
  const J = judgeExpectation;
  check('G2 judgeExpectation 命中：ok 且文案「页面包含」',
    J({ act: 'expect_text', value: 'RESULT-OK' }, tmpSnap).ok === true
    && J({ act: 'expect_text', value: 'RESULT-OK' }, tmpSnap).detail.includes('页面包含'));
  check('G2 judgeExpectation 不命中：ok=false 且文案钉「断言不成立，不放宽」',
    J({ act: 'expect_text', value: 'NOPE' }, tmpSnap).ok === false
    && J({ act: 'expect_text', value: 'NOPE' }, tmpSnap).detail.includes('断言不成立，不放宽'));
  check('G2 judgeExpectation 大小写不敏感 + evidence 透传快照路径',
    J({ act: 'expect_text', value: 'result-ok' }, tmpSnap).ok === true
    && J({ act: 'expect_text', value: 'result-ok' }, tmpSnap).evidence === tmpSnap);
  const resPass = await executePlan({
    steps: [
      { act: 'click', target: 'e12', value: '提交订单' },
      { act: 'expect_text', value: 'RESULT-OK' },
    ],
    cwd: '.', session: 'pin',
    cliBatch: async () => [
      { ok: true, detail: '操作已完成' },
      { ok: true, detail: '已取快照', evidence: tmpSnap },
    ],
  });
  check('G2 cliBatch 动作步结果带 act/target/value 且 expect_* 按快照判定（缺 act 误判 Blocked / 不判定则断言虚过）',
    resPass.steps[0].act === 'click' && resPass.steps[0].target === 'e12' && resPass.steps[0].value === '提交订单'
    && resPass.steps[1].ok === true && (resPass.steps[1].detail || '').includes('页面包含')
    && resPass.stopped === false && verdictOf(resPass.steps) === 'Pass');
  const resFail = await executePlan({
    steps: [{ act: 'expect_text', value: 'NOPE' }],
    cwd: '.', session: 'pin',
    cliBatch: async () => [{ ok: true, detail: '已取快照', evidence: tmpSnap }],
  });
  check('G2 判定不成立 → fail fast：verdict=Fail、detail 含「不放宽」',
    resFail.stopped === true && resFail.steps[0].ok === false
    && verdictOf(resFail.steps) === 'Fail' && (resFail.steps[0].detail || '').includes('不放宽'));
  fs.unlinkSync(tmpSnap);
}

/* ============ G3) 浏览器通道环境适配（v1.8.16） ============ */
log('=== G3) PVMCP_CLI_BROWSER：会话创建点注入，环境不设零变化 ===');
{
  check('G3 环境不设 → open/goto/click 全部零注入（默认 chromium 语义不变）',
    browserChannelFlags('open', {}).length === 0
    && browserChannelFlags('goto', {}).length === 0
    && browserChannelFlags('click', {}).length === 0);
  check('G3 设 msedge → 仅 open 注入 --browser（goto/click 附着既有会话不注入）',
    JSON.stringify(browserChannelFlags('open', { PVMCP_CLI_BROWSER: 'msedge' })) === JSON.stringify(['--browser', 'msedge'])
    && browserChannelFlags('goto', { PVMCP_CLI_BROWSER: 'msedge' }).length === 0
    && browserChannelFlags('click', { PVMCP_CLI_BROWSER: 'msedge' }).length === 0
    && browserChannelFlags('open', { PVMCP_CLI_BROWSER: '  ' }).length === 0);
}

/* ================= H) 断点续采计划与守门（v1.8.2） ================= */
log('=== H) 断点续采：指纹门 / 断点页计算 / 种子归并 / 工具守门 ===');
{
  const seed = {
    url: 'https://test.example.com/list', keyIndex: 0,
    rows: [['D001', '甲'], ['D002', '乙']],
    pages: [{ page: 1, rowCount: 2, added: 2 }, { page: 2, rowCount: 2, added: 2 }],
  };

  const okPlan = planResume(seed, { url: 'https://test.example.com/list', keyIndex: 0 });
  check('H planResume 指纹一致 → 带行带页，从最后产出页 +1 续采',
    okPlan.ok === true && okPlan.startPage === 3
    && okPlan.seedRows.length === 2 && okPlan.seedPages.length === 2,
    JSON.stringify(okPlan).slice(0, 120));

  const badPage = planResume({
    url: 'u', keyIndex: 0, rows: [['A', '1']],
    pages: [{ page: 1, rowCount: 5, added: 5 }, { page: 2, rowCount: 0, added: 0, note: '本页取数未产出可解析结果' }, { page: 3, rowCount: 4, added: 0 }],
  }, { url: 'u', keyIndex: 0 });
  check('H 断点页只跟 added>0 走（eval 失败/零新增页整段重扫）',
    badPage.ok === true && badPage.startPage === 2, JSON.stringify(badPage).slice(0, 120));

  check('H 基准一行没产出过 → 从第 1 页重扫（不比不续采更坏）',
    planResume({ url: 'u', keyIndex: 0, rows: [], pages: [] }, { url: 'u', keyIndex: 0 }).startPage === 1);

  const staleUrl = planResume(seed, { url: 'https://test.example.com/other', keyIndex: 0 });
  check('H url 指纹不符 → COLLECT_STALE（宁可从头，不爬错页污染基准）',
    staleUrl.ok === false && staleUrl.why === 'COLLECT_STALE' && staleUrl.detail.includes('指纹'),
    staleUrl.why);

  const staleKey = planResume(seed, { url: seed.url, keyIndex: 1 });
  check('H keyIndex 指纹不符 → COLLECT_STALE（键列不同行不可比）',
    staleKey.ok === false && staleKey.why === 'COLLECT_STALE', staleKey.why);

  const unreadables = [null, undefined, 'not-json', {}, { rows: [], pages: 'x' }, { rows: 'x', pages: [] }, { rows: [] }, { pages: [] }];
  check('H 基准不可解析/缺 rows|pages → COLLECT_RESUME_UNREADABLE（各形态都认）',
    unreadables.every((p) => {
      const r = planResume(p, { url: 'u', keyIndex: 0 });
      return r.ok === false && r.why === 'COLLECT_RESUME_UNREADABLE';
    }),
    JSON.stringify(unreadables.map((p) => planResume(p, { url: 'u', keyIndex: 0 }).why)));

  // 种子先占位：重扫页撞见同键行不覆盖基准值（与正常采集同一「首见胜出」语义）
  const acc = { map: new Map() };
  mergeRows(acc, seed.rows, 0);
  mergeRows(acc, [['D001', '甲改'], ['D003', '丙']], 0);
  check('H 续采种子先占位 + 重扫重行首见胜出（基准值不被覆盖）',
    acc.map.get('D001')[1] === '甲' && acc.map.size === 3);

  // 工具守门：不兼容组合与指纹不符都在打开浏览器之前拒掉
  const na = await handleMessage({
    id: 3, method: 'tools/call',
    params: { name: 'collect_table', arguments: { url: 'https://test.example.com/x', pagination: { mode: 'none' }, resumeFrom: 'no-matter.json' } },
  });
  check('H mode=none + resumeFrom → COLLECT_RESUME_NOT_APPLICABLE（单页没有断点可续）',
    na.result.isError === true
    && na.result.structuredContent.errorCode === 'COLLECT_RESUME_NOT_APPLICABLE'
    && na.result.content[0].text.includes('断点'),
    JSON.stringify(na.result.structuredContent).slice(0, 120));

  const staleFile = path.join(os.tmpdir(), `pv-resume-stale-${process.pid}.json`);
  fs.writeFileSync(staleFile, JSON.stringify({ url: 'https://other.example.com/list', keyIndex: 0, rows: [], pages: [] }), 'utf8');
  const staleCall = await handleMessage({
    id: 4, method: 'tools/call',
    params: { name: 'collect_table', arguments: { url: 'https://test.example.com/x', pagination: { mode: 'next' }, resumeFrom: staleFile } },
  });
  check('H 工具层指纹不符 → COLLECT_STALE（打开浏览器之前拒掉）',
    staleCall.result.isError === true && staleCall.result.structuredContent.errorCode === 'COLLECT_STALE'
    && staleCall.result.content[0].text.includes('拒绝续采'),
    JSON.stringify(staleCall.result.structuredContent).slice(0, 120));
  fs.rmSync(staleFile, { force: true });
}

/* ================= I) 计划缓存纯函数（v1.8.8：指纹/TTL/容量/报告字段） ================= */
log('=== I) 计划缓存：指纹四元组敏感、TTL 过期、容量 FIFO、报告增量字段 ===');
{
  const base = { goal: 'g', url: 'u', provider: 'ollama', model: 'm' };
  const fp0 = planFingerprint(base);
  check('I 同指纹输入 → 同指纹（确定性）', fp0 === planFingerprint(base) && /^[0-9a-f]{64}$/.test(fp0), fp0.slice(0, 12));
  const variants = [
    ['goal', { ...base, goal: 'g2' }],
    ['url', { ...base, url: 'u2' }],
    ['provider', { ...base, provider: 'deepseek' }],
    ['model', { ...base, model: 'm2' }],
  ];
  check('I 指纹四元组任一变即失效（goal/url/provider/model 各变 → 全不同）',
    variants.every(([, v]) => planFingerprint(v) !== fp0),
    variants.map(([k]) => k).join('/'));

  let clock = 1_000_000;
  const c = createPlanCache({ ttlMs: 100, capacity: 2, now: () => clock });
  const fpA = planFingerprint({ ...base, goal: 'A' });
  const fpB = planFingerprint({ ...base, goal: 'B' });
  const fpC = planFingerprint({ ...base, goal: 'C' });
  c.set(fpA, { steps: [{ act: 'goto', target: 'https://t.example.com' }], provider: 'ollama', model: 'm' });
  clock += 99;
  const fresh = c.get(fpA);
  check('I TTL 内命中且原样返回 steps/provider/model',
    !!fresh && fresh.steps.length === 1 && fresh.provider === 'ollama' && typeof fresh.ageMs === 'number');
  clock += 1;
  check('I 到达 TTL 即失效（过期即淘汰，不留脏条目）', c.get(fpA) === null && c.size === 0);

  c.set(fpA, { steps: [{ act: 'goto', target: 'https://a.example.com' }], provider: 'ollama', model: 'm' });
  c.set(fpB, { steps: [{ act: 'goto', target: 'https://b.example.com' }], provider: 'ollama', model: 'm' });
  c.set(fpC, { steps: [{ act: 'goto', target: 'https://c.example.com' }], provider: 'ollama', model: 'm' });
  check('I 容量 FIFO：超出即淘汰最旧（A 出、B/C 留）',
    c.get(fpA) === null && c.get(fpB) !== null && c.get(fpC) !== null && c.size === 2);

  const repDefault = buildReport({ goal: 'g', url: 'u', source: 'fallback', plan: { steps: [] }, stepResults: [] });
  const repHit = buildReport({ goal: 'g', url: 'u', source: 'llm', plan: { steps: [] }, stepResults: [], planCache: 'hit' });
  check('I buildReport 增量字段 planCache：缺省 miss（旧调用方兼容）、hit 透传',
    repDefault.planCache === 'miss' && repHit.planCache === 'hit');

  check('I 缓存默认口径：TTL 5 分钟 / 容量 8（「小」的常数钉）',
    PLAN_CACHE_TTL_MS === 300_000 && PLAN_CACHE_CAPACITY === 8,
    `ttl=${PLAN_CACHE_TTL_MS} cap=${PLAN_CACHE_CAPACITY}`);
}

log('');
log(failures === 0 ? 'nl-agent-check：全部通过' : `nl-agent-check：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
