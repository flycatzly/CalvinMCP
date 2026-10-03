/**
 * nl-agent-check.mjs — 智能体线（自然语言声明式测试）的无浏览器验证
 *
 * 覆盖三块：
 *   1) llmclient：对着**真实回环 HTTP 桩**（node:http）验证 Ollama/DeepSeek 两种协议的
 *      请求形态与响应解析 —— 不 mock fetch，走真 socket，请求体/鉴权头都能断言；
 *   2) nlplan/agent/explore 纯函数层：动作白名单拒绝静默丢弃、危险目标拒绝、
 *      生产地址审批口径、fail-fast 执行、JSON 报告形状、死链坏图判定口径；
 *   3) 工具面：tools/list 13 个工具、nl_test_goal 的拒绝路径（不开浏览器）。
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
  assertGoalAllowed, assertTargetAllowed, executePlan, buildReport, writeReport, DANGEROUS_GOAL_PATTERNS,
} from '../lib/agent.js';
import {
  parseFactsFile, judgeImages, classifyLinks, probeLinks, judgeExplore, parseConsoleErrors,
} from '../lib/explore.js';
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
}

/* ================= E) 工具面与拒绝路径（不开浏览器） ================= */
log('=== E) 工具面：13 个工具 + nl_test_goal 拒绝路径 ===');

{
  const list = await handleMessage({ id: 1, method: 'tools/list', params: {} });
  const tools = list.result.tools;
  check('tools/list 返回 13 个工具', tools.length === 13, `${tools.length} 个`);
  const EXPECTED = [
    'check_config', 'lint_spec', 'summarize_report', 'run_verify', 'cli_session', 'cli_health',
    'explore_page', 'nl_test_goal', 'generate_scripts', 'check_standards', 'orchestrate_excel',
    'explain_rules', 'selfcheck',
  ];
  check('13 个工具名齐全', EXPECTED.every((t) => tools.some((x) => x.name === t)),
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
}

log('');
log(failures === 0 ? 'nl-agent-check：全部通过' : `nl-agent-check：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
