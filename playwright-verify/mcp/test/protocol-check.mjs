/**
 * protocol-check.mjs — MCP 协议与工具面回归测试
 *
 * 分两部分：
 *   A) 进程内协议测试：直接驱动 handleMessage，验证握手 / version 协商 / tools/list / tools/call 的形状与错误语义。
 *      （不走子进程，因此不受沙箱管道限制影响，能稳定跑在 CI 里。）
 *   B) 真实 stdio 冒烟：真的 spawn 一次 server.mjs，用「stdin 重定向文件 + stdout 重定向文件」通信，
 *      证明 stdio 传输在真实进程里可用（沙箱下不能用管道捕获输出，所以用文件）。
 *
 * 钉死的性质：
 *   1) 客户端请求的受支持版本必须原样回；不支持的版本回落我们最高的。
 *   2) 未知方法返回 -32601；未知工具返回 -32602；JSON 解析失败返回 -32700。
 *   3) tools/list 里每个工具都要有 name/title/description/inputSchema，且 schema 必须是合法 JSON Schema 对象。
 *   4) 每个工具都能被至少调用一次而不抛异常（用 dry-run / 只读参数）。
 *   5) 失败必须以 isError:true 表达，绝不静默成功。
 *   6) 通知（无 id）不产生响应。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  handleMessage, TOOLS, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION, VERSION,
} from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(__dirname, '..', 'server.mjs');

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

const call = (method, params, id = 1) => handleMessage({ jsonrpc: '2.0', id, method, params });

/* ================= A) 进程内协议 ================= */

log('=== A) 进程内协议测试 ===');

const init = await call('initialize', {
  protocolVersion: LATEST_PROTOCOL_VERSION,
  clientInfo: { name: 'protocol-check', version: '1' },
  capabilities: {},
});
check('initialize 返回 result', !!init.result);
check('回显客户端请求的受支持版本', init.result.protocolVersion === LATEST_PROTOCOL_VERSION, init.result.protocolVersion);
check('serverInfo 有 name/version', init.result.serverInfo.name === 'playwright-verify' && !!init.result.serverInfo.version, JSON.stringify(init.result.serverInfo));
check('声明 tools capability', !!init.result.capabilities.tools);
check('给出 instructions（含硬规则与推荐顺序）',
  typeof init.result.instructions === 'string'
  && /硬规则/.test(init.result.instructions)
  && /check_config/.test(init.result.instructions));
check('版本与仓库根 package.json 一致（版本单一真相源，防读错目录漂移）',
  VERSION === JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  `v${VERSION}`);

// 版本协商：每个受支持版本都要原样回
for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
  const r = await call('initialize', { protocolVersion: v, clientInfo: { name: 't', version: '1' } });
  check(`版本协商 ${v}`, r.result.protocolVersion === v, r.result.protocolVersion);
}
const oldVer = await call('initialize', { protocolVersion: '1999-01-01', clientInfo: { name: 't', version: '1' } });
check('不支持的版本回落到最新', oldVer.result.protocolVersion === LATEST_PROTOCOL_VERSION, oldVer.result.protocolVersion);

// 通知不产生响应
check('notifications/initialized 不产生响应', (await call('notifications/initialized', {})) === null);
check('无 id 的请求不产生响应', (await handleMessage({ jsonrpc: '2.0', method: 'ping' })) === null);

// ping
check('ping 返回空 result', JSON.stringify((await call('ping', {})).result) === '{}');

// 错误语义
const unknownMethod = await call('no/such/method', {});
check('未知方法 → -32601', unknownMethod.error?.code === -32601, JSON.stringify(unknownMethod.error));
const unknownTool = await call('tools/call', { name: 'nope', arguments: {} });
check('未知工具 → -32602', unknownTool.error?.code === -32602, JSON.stringify(unknownTool.error));
check('未知工具的错误里列出可用工具', Array.isArray(unknownTool.error?.data?.available) && unknownTool.error.data.available.length >= 10);

// resources/prompts 空列表（不报错）
check('resources/list 返回空数组', Array.isArray((await call('resources/list', {})).result.resources));
check('prompts/list 返回空数组', Array.isArray((await call('prompts/list', {})).result.prompts));

/* ---- tools/list 形状 ---- */
const list = await call('tools/list', {});
const tools = list.result.tools;
check('tools/list 返回工具数组', Array.isArray(tools) && tools.length >= 13, `${tools?.length} 个`);
check('每个工具有 name/title/description/inputSchema',
  tools.every((t) => t.name && t.title && t.description && t.inputSchema));
check('工具名唯一', new Set(tools.map((t) => t.name)).size === tools.length);
check('工具名是合法的 MCP 工具名', tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name)), tools.map((t) => t.name).join(','));
check('每个 inputSchema 都是 object 类型且带 properties',
  tools.every((t) => t.inputSchema.type === 'object' && typeof t.inputSchema.properties === 'object'));
check('inputSchema 不含非法 JSON Schema 关键字',
  tools.every((t) => !('$schema' in t.inputSchema) && !('definitions' in t.inputSchema)));

/* ---- annotations：副作用声明（客户端自动放行 / 要求确认的机器依据） ---- */
/*
 * 为什么钉这个：annotations 是 MCP 给客户端的机器可读副作用契约。
 * 分类错一个方向都是事故：把 run_verify 标成只读 → 客户端自动放行执行任意测试代码；
 * 把 explain_rules 标成破坏性 → 人被无谓打断，门禁疲劳后开始无脑确认。
 * 所以按「实际行为」定死集合（不是只断言字段存在），并钉语义自洽不变量。
 */
check('每个工具都带 annotations 且四 hint 全是 boolean',
  tools.every((t) => t.annotations
    && ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
      .every((k) => typeof t.annotations[k] === 'boolean')),
  `${tools.filter((t) => t.annotations).length}/${tools.length} 带 annotations`);

const READONLY_SET = ['check_config', 'lint_spec', 'check_standards', 'explain_rules', 'selfcheck'];
check('只读工具集合恰好是纯读/纯自省五个（多一个=副作用工具被自动放行；'
  + 'summarize_report v1.8.7 起多报告趋势会落盘 md，已移出只读集合）',
  tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort().join(',')
  === [...READONLY_SET].sort().join(','),
  tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort().join(','));

const DESTRUCTIVE_SET = ['run_verify', 'cli_session', 'nl_test_goal', 'generate_scripts', 'orchestrate_excel'];
check('破坏性工具集合恰好是执行/写盘/驱动页面五个（少一个=会改状态的工具免确认）',
  tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort().join(',')
  === [...DESTRUCTIVE_SET].sort().join(','),
  tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort().join(','));

const OPENWORLD_SET = ['run_verify', 'cli_session', 'explore_page', 'nl_test_goal', 'orchestrate_excel', 'collect_table'];
check('openWorld 集合恰好是碰外部实体的六个（data: 页与本机探测不算开放世界）',
  tools.filter((t) => t.annotations.openWorldHint).map((t) => t.name).sort().join(',')
  === [...OPENWORLD_SET].sort().join(','),
  tools.filter((t) => t.annotations.openWorldHint).map((t) => t.name).sort().join(','));

check('语义自洽：readOnly ⇒ 非破坏 ∧ 幂等；破坏 ⇒ 非只读（矛盾声明比缺声明更误导）',
  tools.every((t) => {
    const a = t.annotations;
    return (!a.readOnlyHint || (!a.destructiveHint && a.idempotentHint)) && (!a.destructiveHint || !a.readOnlyHint);
  }));

check('tools/list 线上真发 annotations（只写在 TOOLS 里不接线 = 等于没声明）',
  tools.every((t) => t.annotations)
  && JSON.stringify(tools.map((t) => t.annotations))
    === JSON.stringify(TOOLS.map((t) => t.annotations)));

// 期望的工具面完整
const EXPECTED_TOOLS = [
  'check_config', 'lint_spec', 'summarize_report', 'run_verify',
  'cli_session', 'cli_health', 'explore_page', 'nl_test_goal', 'collect_table',
  'generate_scripts', 'check_standards', 'orchestrate_excel', 'explain_rules', 'selfcheck',
];
for (const t of EXPECTED_TOOLS) {
  check(`工具存在：${t}`, tools.some((x) => x.name === t));
}

/* ---- 逐个调用（只读 / 干跑参数） ---- */
const cwd = ROOT;
async function callTool(name, args) {
  const r = await call('tools/call', { name, arguments: args }, 100);
  if (r.error) return { protocolError: r.error };
  return r.result;
}

// check_config：基线必须通过，反例必须被阻断
const cfgOk = await callTool('check_config', { cwd, file: 'demo/configs/playwright.config.baseline.ts', format: 'json' });
check('check_config 基线 PASS', cfgOk.structuredContent?.summary?.verdict === 'PASS' && !cfgOk.isError,
  JSON.stringify(cfgOk.structuredContent?.summary));
const cfgBad = await callTool('check_config', { cwd, file: 'demo/configs/playwright.config.legacy.ts', format: 'json' });
check('check_config 反例 BLOCK 且 isError', cfgBad.isError === true && cfgBad.structuredContent?.summary?.exitCode === 1,
  JSON.stringify(cfgBad.structuredContent?.summary));
const cfgMissing = await callTool('check_config', { cwd: path.join(os.tmpdir(), 'no-such-dir-xyz') });
check('check_config 找不到配置时明确失败', cfgMissing.isError === true && /没找到|not found|未找到/i.test(cfgMissing.content[0].text));

// lint_spec：样例集三态
const lintClean = await callTool('lint_spec', { cwd, target: 'demo/tests/clean.spec.ts', format: 'json' });
check('lint_spec clean → 0 ERROR 不阻断', lintClean.structuredContent?.summary?.errorCount === 0 && !lintClean.isError);
const lintMessy = await callTool('lint_spec', { cwd, target: 'demo/tests/messy.spec.ts', format: 'json' });
check('lint_spec messy → ERROR 且 isError', lintMessy.isError === true && lintMessy.structuredContent?.summary?.errorCount > 0,
  `ERROR ${lintMessy.structuredContent?.summary?.errorCount}`);
const lintTricky = await callTool('lint_spec', { cwd, target: 'demo/tests/tricky.spec.ts', format: 'json' });
check('lint_spec tricky → 0 ERROR 0 WARN（不冤枉）',
  lintTricky.structuredContent?.summary?.errorCount === 0 && lintTricky.structuredContent?.summary?.warnCount === 0,
  JSON.stringify(lintTricky.structuredContent?.summary));
const lintMissing = await callTool('lint_spec', { cwd, target: 'no/such/path' });
check('lint_spec 目标不存在时明确失败', lintMissing.isError === true);

// summarize_report：固定真报告夹具
//
// 为什么用夹具而不是 demo/test-results/report.json（活的）——实测踩过的假失败：
//   活报告的内容取决于上一次浏览器回归跑成什么样。浏览器缺装时它是 9 条
//   browserType.launch 失败，「4 个根因 / 1 偶发」就变成 2 个 FAIL ——
//   而那是环境坏了，不是协议坏了：协议套件因此假红，正是「门禁冤枉人」的形态。
//   夹具是一份从真实回归里捕获的 Playwright JSON 报告（2 通过 / 6 失败 / 1 偶发），
//   既有真实格式，又不随环境漂移。活报告的端到端消费由「真实浏览器回归矩阵」套件守。
const reportPath = 'mcp/test/fixtures/report-regression.json';
if (fs.existsSync(path.join(cwd, reportPath))) {
  const sum = await callTool('summarize_report', { cwd, file: reportPath, format: 'json' });
  check('summarize_report 压成 4 个根因', sum.structuredContent?.clusters?.length === 4,
    JSON.stringify(sum.structuredContent?.clusters?.map((c) => `${c.category}:${c.count}`)));
  check('summarize_report 识别 odd 偶发单独列出', sum.structuredContent?.flakes?.length === 1);
} else {
  check('summarize_report 夹具存在（mcp/test/fixtures/report-regression.json）', false,
    '夹具缺失 —— 请从一次成功的 demo 回归里捕获 report.json 放到该路径');
}
const sumMissing = await callTool('summarize_report', { cwd, file: 'no/such/report.json' });
check('summarize_report 报告不存在时明确失败并指向 CFG004', sumMissing.isError === true && /CFG004|json reporter/.test(sumMissing.content[0].text));
// 输入校验：坏 JSON / 非报告形状必须 isError+REPORT_ERROR —— 协议不变量「失败必须以 isError 表达，绝不静默成功」
// （2026-10-04 真实测试实测：旧实现静默返回全零空报告，调用方会把解析失败当成没有失败）
const sumBadJson = await callTool('summarize_report', { cwd, json: '{"not": "a report"' });
check('summarize_report 不可解析 JSON 必须 isError+REPORT_ERROR（不给全零假绿）',
  sumBadJson.isError === true && sumBadJson.structuredContent?.errorCode === 'REPORT_ERROR' && !sumBadJson.structuredContent?.totals,
  sumBadJson.structuredContent?.errorCode || '(无 errorCode)');
const sumBadShape = await callTool('summarize_report', { cwd, json: '{"foo": 1}' });
check('summarize_report 非报告形状必须 isError+REPORT_ERROR（缺 suites/stats）',
  sumBadShape.isError === true && sumBadShape.structuredContent?.errorCode === 'REPORT_ERROR',
  sumBadShape.structuredContent?.errorCode || '(无 errorCode)');

// run_verify：默认干跑（装了 Playwright → 识别版本；没装 → 必须诚实报缺。
// 两种环境各断言一条：纯净包（无 node_modules）不许假装成功，也不许把「缺依赖」断成失败）
const dry = await callTool('run_verify', { cwd });
const dryMissing = dry.isError && /找不到|未安装|npm i -D @playwright\/test/.test(dry.content?.[0]?.text || '');
if (dryMissing) {
  check('run_verify 未装 Playwright 时诚实报缺（纯净包口径）', /npm i -D @playwright\/test/.test(dry.content?.[0]?.text || ''),
    (dry.content?.[0]?.text || '').split('\n')[0]);
} else {
  check('run_verify 默认干跑且识别出 Playwright', !dry.isError && dry.structuredContent?.dryRun === true && !!dry.structuredContent?.version,
    JSON.stringify({ ver: dry.structuredContent?.version, runner: dry.structuredContent?.runner }));
}
const dryBad = await callTool('run_verify', { cwd: path.join(os.tmpdir(), 'nope-xyz') });
check('run_verify 目录不存在时明确失败', dryBad.isError === true);

// cli_health / cli_session
const health = await callTool('cli_health', { cwd });
const hMissing = health.isError && /CLI_NOT_INSTALLED|找不到 playwright-cli/.test(JSON.stringify(health.structuredContent) + (health.content?.[0]?.text || ''));
if (hMissing) {
  check('cli_health 未装 CLI 时诚实报缺（纯净包口径）', true,
    health.structuredContent?.reason || 'CLI_NOT_INSTALLED');
} else {
  check('cli_health 最小闭环通过', !health.isError && health.structuredContent?.ok === true,
    (health.content?.[0]?.text || '').split('\n')[0]);
}
const badCmd = await callTool('cli_session', { cwd, subcommand: 'rm-rf-everything' });
check('cli_session 拒绝白名单外子命令', badCmd.isError === true && /白名单/.test(JSON.stringify(badCmd.structuredContent)),
  badCmd.structuredContent?.reason);

// generate_scripts：门禁
const genArgs = {
  cwd,
  spec: 'protocol-check',
  pages: [{
    name: 'demo', navPath: '/demo',
    steps: [
      { act: 'fill', locator: { kind: 'label', text: 'account' }, value: 'u1' },
      { act: 'click', locator: { kind: 'role', role: 'button', name: 'Submit' } },
      { act: 'assertVisible', locator: { kind: 'testid', id: 'done' } },
    ],
  }],
  cases: [{
    title: 'demo happy path', page: 'demo', claims: '证明 demo 页提交后出现完成标记',
    steps: [
      { act: 'fill', locator: { kind: 'label', text: 'account' }, value: 'u1' },
      { act: 'assertVisible', locator: { kind: 'testid', id: 'done' } },
    ],
  }],
};
const gen = await callTool('generate_scripts', genArgs);
check('generate_scripts 门禁通过', !gen.isError && gen.structuredContent?.lint?.passed === true, gen.structuredContent?.verdict);
check('generate_scripts 不写盘时明确说明', /未写盘/.test(gen.content[0].text));
const genBlocked = await callTool('generate_scripts', {
  ...genArgs,
  pages: [{ name: 'x', steps: [{ act: 'click', locator: { kind: 'role', role: 'button', name: 'x' } }] }],
  cases: [{ title: 'no assert', page: 'x', claims: 'c', steps: [{ act: 'click', locator: { kind: 'role', role: 'button', name: 'x' } }] }],
});
check('generate_scripts 无断言时被门禁阻断', genBlocked.isError === true && genBlocked.structuredContent?.lint?.passed === false);
const genBadSel = await callTool('generate_scripts', {
  ...genArgs,
  pages: [{ name: 'y', steps: [{ act: 'click', locator: { kind: 'selector', selector: '//div[3]/span[2]' } }] }],
  cases: [{ title: 't', page: 'y', claims: 'c', steps: [{ act: 'click', locator: { kind: 'selector', selector: '//div[3]/span[2]' } }] }],
});
check('generate_scripts 拒绝裸 XPath', genBadSel.isError === true && /脆弱选择器|XPath/.test(genBadSel.content[0].text));

// check_standards
const stdTemplate = await callTool('check_standards', { templateOnly: true });
check('check_standards 模板含四条规范',
  ['STD001', 'STD002', 'STD003', 'STD004'].every((s) => stdTemplate.content[0].text.includes(s)));
const stdMissing = await callTool('check_standards', { target: path.join(os.tmpdir(), 'no-agents-here-xyz') });
check('check_standards 找不到规范时不阻断但列出缺失', stdMissing.isError !== true && stdMissing.structuredContent?.missing === 4,
  JSON.stringify(stdMissing.structuredContent?.summary));

// orchestrate_excel readOnly
const xlsx = path.join(cwd, 'demo/cases/regression.xlsx');
if (fs.existsSync(xlsx)) {
  const orch = await callTool('orchestrate_excel', { cwd, input: 'demo/cases/regression.xlsx', readOnly: true });
  check('orchestrate_excel 只读模式读到 3 条用例', !orch.isError && orch.structuredContent?.caseCount === 3,
    String(orch.structuredContent?.caseCount));
  check('orchestrate_excel 报出无法映射的步骤', /无法映射/.test(orch.content[0].text));
} else {
  log('SKIP  orchestrate_excel（缺 demo/cases/regression.xlsx）');
}
const orchBad = await callTool('orchestrate_excel', { cwd, input: 'no/such.xlsx', readOnly: true });
check('orchestrate_excel 文件不存在时明确失败', orchBad.isError === true);

// explain_rules / selfcheck
const rules = await callTool('explain_rules', { group: 'all' });
check('explain_rules 列出 lint 规则', Array.isArray(rules.structuredContent?.lint) && rules.structuredContent.lint.length >= 14,
  `${rules.structuredContent?.lint?.length} 条`);
check('explain_rules 列出归因类别', (rules.structuredContent?.category || []).length >= 6);
const sc = await callTool('selfcheck', { cwd });
check('selfcheck 必需项通过', !sc.isError, sc.content[0].text.split('\n').slice(0, 8).join(' | '));

/* ================= B) 真实 stdio 冒烟 ================= */
log('');
log('=== B) 真实 stdio 冒烟（文件重定向，不用管道） ===');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-stdio-'));
const inFile = path.join(tmpdir, 'in.ndjson');
const outFile = path.join(tmpdir, 'out.ndjson');
const errFile = path.join(tmpdir, 'err.log');

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, clientInfo: { name: 'smoke', version: '1' }, capabilities: {} } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'selfcheck', arguments: { cwd } } },
  { jsonrpc: '2.0', id: 4, method: 'no/such/method', params: {} },
  'this is not json',
];
fs.writeFileSync(inFile, `${requests.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`, 'utf8');

const inFd = fs.openSync(inFile, 'r');
const outFd = fs.openSync(outFile, 'w');
const errFd = fs.openSync(errFile, 'w');
const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: [inFd, outFd, errFd],   // 关键：stdin/stdout 都走文件，不用管道
    windowsHide: true,
  });
  child.on('error', () => resolve(-1));
  child.on('close', (c) => resolve(c ?? -1));
});
fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd);

const outText = fs.readFileSync(outFile, 'utf8');
const lines = outText.split('\n').filter((l) => l.trim());
const responses = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
check('stdio 进程退出码 0', code === 0, `exit=${code}`);
check('stdio 产出 NDJSON 响应', responses.length >= 4, `${responses.length} 条`);
check('stdio 响应是合法 JSON-RPC 2.0', responses.every((r) => r.jsonrpc === '2.0' && r.id !== undefined));
check('stdio initialize 成功', responses.find((r) => r.id === 1)?.result?.serverInfo?.name === 'playwright-verify');
check('stdio tools/list 返回工具', (responses.find((r) => r.id === 2)?.result?.tools || []).length >= 10);
check('stdio tools/call selfcheck 成功', responses.find((r) => r.id === 3)?.result?.isError !== true);
check('stdio 未知方法返回 -32601', responses.find((r) => r.id === 4)?.error?.code === -32601);
check('stdio 非法 JSON 返回 -32700（id=null）',
  responses.some((r) => r.error?.code === -32700 && r.id === null));
check('通知未产生额外响应（响应数 = 请求数 - 通知数）', responses.length === 5, `${responses.length} 条（期望 5）`);

/* ---- B 续：stdin EOF 排空（批量末尾不许静默丢调用） ---- */
/*
 * 真实客户端的批量时序：一口气发 N 个调用随即关 stdin。close 事件先于串行队列排空到达，
 * 若 close 即 exit(0)，队尾调用被静默吞掉 —— 调用方拿不到响应也拿不到日志，
 * 只能靠事后对账「发了 N 只回来 M」。这里 40 连发 + 立即 EOF 钉死：一个都不能丢。
 *
 * 关键设计：连发里必须有**真实异步挂起**的调用，否则所有 handler 都是微任务级完成，
 * 旧实现在 close 到来前已全量应答，钉就咬不中。做法是塞一个假 runner
 * （tmpcwd/node_modules/@playwright/test/cli.js，--version 慢 300ms 退出），
 * 让首个 run_verify 干跑必然拉子进程 —— EOF 必然落在这个在飞调用上。
 */
{
  const burstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-burst-'));
  const fakeCli = path.join(burstDir, 'node_modules', '@playwright', 'test', 'cli.js');
  fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
  fs.writeFileSync(fakeCli, 'setTimeout(() => { console.log(\'Version 9.9.9\'); process.exit(0); }, 300);\n', 'utf8');

  const bIn = path.join(burstDir, 'in.ndjson');
  const bOut = path.join(burstDir, 'out.ndjson');
  const bErr = path.join(burstDir, 'err.log');
  const n = 40;
  const burst = [
    JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'run_verify', arguments: { cwd: burstDir, execution: false } } }),
    ...Array.from({ length: n - 1 }, (_, i) =>
      JSON.stringify({ jsonrpc: '2.0', id: 101 + i, method: 'tools/call', params: { name: 'selfcheck', arguments: { cwd: ROOT } } })),
  ];
  fs.writeFileSync(bIn, `${burst.join('\n')}\n`, 'utf8');

  const bi = fs.openSync(bIn, 'r');
  const bo = fs.openSync(bOut, 'w');
  const be = fs.openSync(bErr, 'w');
  const bCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      stdio: [bi, bo, be],   // 文件重定向：写完即 EOF，正是批量客户端的关闭时序
      windowsHide: true,
    });
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c ?? -1));
  });
  fs.closeSync(bi); fs.closeSync(bo); fs.closeSync(be);

  const bResp = fs.readFileSync(bOut, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const answered = bResp.filter((r) => r.id >= 100 && r.id < 100 + n).length;
  check('stdin EOF 先于排空：40 连发全部应答（在飞 + 队尾一个都不许静默丢）',
    bCode === 0 && answered === n, `exit=${bCode} 应答 ${answered}/${n}`);
}

/* ================= C) 可观测性：结构化一行日志 + 脱敏 ================= */
/*
 * PVMCP_LOG 是排查与度量的唯一落点：每请求一行、字段定长（name/ms/outcome/code），
 * 离线可直接聚合调用量/成功率/延迟分布/错误分布。钉三件事：
 *   1) 覆盖率 —— 协议级拒绝（未知工具 -32602）也要记账，否则「调用量」把被拒请求漏掉；
 *   2) 结构 —— 一请求一行、字段可解析（工具名/方法名是客户端可控值，\n 注入不许拆行）；
 *   3) 脱敏 —— arguments 值一律不落日志（哨兵钉住）：参数里可能有路径、目标地址、
 *      甚至用户随手塞的凭据，日志一旦记参数值就是静默泄密。
 */
log('');
log('=== C) 可观测性（PVMCP_LOG 每请求一行结构化日志、脱敏与防注入） ===');

const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-obs-'));
const obsLog = path.join(obsDir, 'obs.log');
const SENTINEL = 'PVMCP_ARG_LEAK_SENTINEL_9f3a7c';
const obsIn = path.join(obsDir, 'in.ndjson');
const obsOut = path.join(obsDir, 'out.ndjson');
const obsErr = path.join(obsDir, 'err.log');
const obsRequests = [
  { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'explain_rules', arguments: { group: 'all' } } },
  // 哨兵走 args.format（schema 内的合法属性）：handler 提前失败用不到它，但参数值进了进程
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_config', arguments: { cwd: path.join(os.tmpdir(), 'no-such-dir-xyz'), format: SENTINEL } } },
  // 工具名是客户端可控值：塞 \n 试图把一条日志拆成两行（日志注入）
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope\nINJECTED_LINE', arguments: {} } },
];
fs.writeFileSync(obsIn, `${obsRequests.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

const oIn = fs.openSync(obsIn, 'r');
const oOut = fs.openSync(obsOut, 'w');
const oErr = fs.openSync(obsErr, 'w');
await new Promise((resolve) => {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: [oIn, oOut, oErr],   // 同 B 段：文件重定向，不用管道
    windowsHide: true,
    env: { ...process.env, PVMCP_LOG: obsLog },
  });
  child.on('error', () => resolve(-1));
  child.on('close', (c) => resolve(c ?? -1));
});
fs.closeSync(oIn); fs.closeSync(oOut); fs.closeSync(oErr);

const obsRaw = fs.existsSync(obsLog) ? fs.readFileSync(obsLog, 'utf8') : '';
const obsLines = obsRaw.split('\n').filter((l) => l.trim());
const callLines = obsLines.filter((l) => l.includes('tools/call'));
const okLine = callLines.find((l) => l.includes('name=explain_rules')) || '';
const errLine = callLines.find((l) => l.includes('name=check_config')) || '';
const rejLine = callLines.find((l) => l.includes('outcome=rejected')) || '';

check('观测日志：三次 tools/call 恰好三行且每行含 name/ms/outcome/code 四字段',
  callLines.length === 3 && callLines.every((l) => /name=\S+ ms=\d+ outcome=(ok|error|rejected) code=\S+/.test(l)),
  `${callLines.length} 行`);
check('观测日志每行以 ISO 时间戳开头（\\n 注入不拆行、无裸注入行）',
  obsLines.length > 0 && obsLines.every((l) => /^\[\d{4}-\d{2}-\d{2}T/.test(l)),
  obsLines.map((l) => l.slice(0, 24)).join(' | '));
check('成功调用记 name/ms/outcome=ok/code=-',
  /name=explain_rules ms=\d+ outcome=ok code=-$/.test(okLine), okLine);
check('失败调用记错误码（错误分布可按 code 聚合）',
  /name=check_config ms=\d+ outcome=error code=CONFIG_NOT_FOUND/.test(errLine), errLine);
check('协议级拒绝也记账（outcome=rejected code=-32602，调用量不漏被拒请求）',
  /outcome=rejected code=-32602/.test(rejLine), rejLine);
check('日志脱敏：arguments 值（哨兵）绝不落日志',
  obsRaw.length > 0 && !obsRaw.includes(SENTINEL));
check('ms 字段可解析（非负整数，延迟分布可算）',
  callLines.length > 0 && callLines.every((l) => / ms=\d+ /.test(l)));

/* ---- C2：错误码语义化（错误分布的键必须是短码） ---- */
/*
 * 失败调用的日志 code= 就是「错误分布」聚合的键。旧实现只看 structuredContent.error，
 * 裸报告类失败（门禁不过、报告解析失败等）没有 error 字段，键就落字面 'isError' ——
 * 全部失败挤进一个无意义桶。钉三件事：键是语义短码、structuredContent.errorCode 同步可读、
 * 绝不出现 'isError' 或 'UNCLASSIFIED'（后者是漏配自曝码，出现即失败）。
 */
{
  const eDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-ecode-'));
  const eLog = path.join(eDir, 'e.log');
  const eIn = path.join(eDir, 'in.ndjson');
  const eOut = path.join(eDir, 'out.ndjson');
  const eErr = path.join(eDir, 'err.log');
  const eReqs = [
    // 门禁失败走裸报告（structured 无 error 字段）—— 正是旧实现落字面 isError 的路径
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lint_spec', arguments: { target: 'demo/tests/messy.spec.ts', cwd: ROOT, format: 'json' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_config', arguments: { cwd: ROOT, file: 'demo/configs/playwright.config.legacy.ts', format: 'json' } } },
  ];
  fs.writeFileSync(eIn, `${eReqs.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  const ei = fs.openSync(eIn, 'r');
  const eo = fs.openSync(eOut, 'w');
  const ee = fs.openSync(eErr, 'w');
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      stdio: [ei, eo, ee],
      windowsHide: true,
      env: { ...process.env, PVMCP_LOG: eLog },
    });
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c ?? -1));
  });
  fs.closeSync(ei); fs.closeSync(eo); fs.closeSync(ee);

  const eRaw = fs.existsSync(eLog) ? fs.readFileSync(eLog, 'utf8') : '';
  const eResp = fs.readFileSync(eOut, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const r1 = eResp.find((r) => r.id === 1)?.result;
  const r2 = eResp.find((r) => r.id === 2)?.result;
  check('错误码语义化：失败日志 code= 是语义短码（LINT_BLOCK/CONFIG_BLOCK）',
    /name=lint_spec ms=\d+ outcome=error code=LINT_BLOCK/.test(eRaw)
    && /name=check_config ms=\d+ outcome=error code=CONFIG_BLOCK/.test(eRaw),
    eRaw.split('\n').filter((l) => l.includes('tools/call')).join(' | '));
  check('错误码绝不落字面 isError 或 UNCLASSIFIED（错误分布不许出噪声键）',
    !/code=isError\b/.test(eRaw) && !/code=UNCLASSIFIED\b/.test(eRaw));
  check('structuredContent.errorCode 同步给出短码（调用方可直接聚合）',
    r1?.structuredContent?.errorCode === 'LINT_BLOCK' && r2?.structuredContent?.errorCode === 'CONFIG_BLOCK',
    `${r1?.structuredContent?.errorCode} / ${r2?.structuredContent?.errorCode}`);
}

/* ---- C 续：消费面（logsummary 聚合） ---- */
/*
 * 写了没人读 = 白写。聚合器的口径必须和写入侧对账，并且：
 *   · 解析异常行绝不静默丢弃（丢一行 = 调用量少一个，「不报错但数字错」）；
 *   · rejected 不进延迟样本（ms=0 是构造值，混进 P95 会把分位数拉假）。
 */
const { summarizeLog, formatText } = await import('../lib/logsummary.js');

const synth = (n, mk) => Array.from({ length: n }, (_, i) => `[2026-10-04T00:00:00.000Z] ${mk(i)}`).join('\n');
const aggMixed = summarizeLog(synth(3, (i) => [
  'tools/call name=t1 ms=5 outcome=ok code=-',
  'tools/call name=t2 ms=6 outcome=error code=ERR_A',
  'tools/call name=t3 ms=0 outcome=rejected code=-32602',
][i]));
check('聚合口径：三态都计入调用量、成功率 = ok/total',
  aggMixed.total === 3 && aggMixed.ok === 1 && aggMixed.error === 1 && aggMixed.rejected === 1
  && Math.abs(aggMixed.successRate - 1 / 3) < 1e-9, JSON.stringify({ t: aggMixed.total, r: aggMixed.successRate }));
check('错误分布按 code 聚合（ok 的 code=- 不计）',
  aggMixed.byCode.ERR_A === 1 && aggMixed.byCode['-32602'] === 1 && !('-' in aggMixed.byCode),
  JSON.stringify(aggMixed.byCode));

const aggRank = summarizeLog(synth(100, (i) => `tools/call name=t ms=${i + 1} outcome=ok code=-`));
check('延迟分位数 nearest-rank 精确（1..100 → p50=50/p95=95/p99=99）',
  aggRank.latency.p50 === 50 && aggRank.latency.p95 === 95 && aggRank.latency.p99 === 99
  && aggRank.latency.max === 100 && aggRank.latency.count === 100,
  JSON.stringify(aggRank.latency));
const aggRej = summarizeLog(synth(2, (i) => [
  'tools/call name=t ms=0 outcome=rejected code=-32602',
  'tools/call name=t ms=7 outcome=ok code=-',
][i]));
check('rejected 不计入延迟样本（构造值不拉假 P95）',
  aggRej.latency.count === 1 && aggRej.latency.p50 === 7 && aggRej.latency.p95 === 7,
  JSON.stringify(aggRej.latency));

const aggBad = summarizeLog('[2026-10-04T00:00:00.000Z] tools/call name=x ms=oops outcome=ok code=-\n'
  + '[2026-10-04T00:00:00.000Z] tools/call name=y ms=1 outcome=ok code=-');
check('解析异常行绝不静默丢弃（malformed 计数 + 原文保留）',
  aggBad.malformedCount === 1 && aggBad.malformed.length === 1 && /ms=oops/.test(aggBad.malformed[0]) && aggBad.total === 1,
  JSON.stringify({ m: aggBad.malformedCount, t: aggBad.total }));
const aggOther = summarizeLog('[2026-10-04T00:00:00.000Z] initialize client=a@1 requested=1 → 1\n'
  + '[2026-10-04T00:00:00.000Z] ping id=1');
check('非 tools/call 事件不计入调用量（其他事件单列）',
  aggOther.total === 0 && aggOther.otherLines === 2 && aggOther.successRate === null,
  JSON.stringify({ t: aggOther.total, o: aggOther.otherLines }));
const aggEmpty = summarizeLog('');
check('空日志不炸（零调用、成功率 null）',
  aggEmpty.total === 0 && aggEmpty.successRate === null && aggEmpty.latency.count === 0 && aggEmpty.malformedCount === 0);

/* ---- C 续2：计划缓存观测（cache= 字段，v1.8.10） ---- */
/*
 * 命中率回答「计划缓存省了多少次规划」。写侧只给 nl_test_goal 落 cache= 字段
 * （值取报告 planCache 单一源），解析侧三个边界：
 *   1) 字段可选 —— 缺字段的旧格式行照常解析，该工具不长 cache 桶（缺字段 ≠ 命中率 0%）；
 *   2) 白名单外的值整行进 malformed —— 与 ms=oops 同口径，不静默猜值、不吞坏数据；
 *   3) 命中率 = hit/(hit+miss)：skip 是「没查」（llm=off）不是查询结果，不进分母，
 *      只有 skip 时 null（不拿 0% 充数）。
 */
{
  const L = (s) => `[2026-10-05T00:00:00.000Z] ${s}`;
  const aggOld = summarizeLog(L('tools/call name=oldfmt ms=2 outcome=ok code=-'));
  check('C cache 字段可选：缺字段的旧格式行照常解析、该工具不长 cache 桶',
    aggOld.total === 1 && aggOld.malformedCount === 0 && aggOld.byTool.oldfmt.cache === undefined,
    JSON.stringify(aggOld.byTool));

  const cacheText = [
    L('tools/call name=nl_test_goal ms=10 outcome=ok code=- cache=hit'),
    L('tools/call name=nl_test_goal ms=11 outcome=ok code=- cache=hit'),
    L('tools/call name=nl_test_goal ms=12 outcome=ok code=- cache=hit'),
    L('tools/call name=nl_test_goal ms=13 outcome=error code=GOAL_FAIL cache=miss'),
    L('tools/call name=nl_test_goal ms=14 outcome=ok code=- cache=skip'),
    L('tools/call name=nl_test_goal ms=15 outcome=ok code=- cache=skip'),
    L('tools/call name=explain_rules ms=1 outcome=ok code=-'),
  ].join('\n');
  const aggCache = summarizeLog(cacheText);
  const c = aggCache.byTool.nl_test_goal.cache;
  check('C cache 三态按工具聚 + 命中率 = hit/(hit+miss)（skip 是没查、不进分母）',
    !!c && c.hit === 3 && c.miss === 1 && c.skip === 2 && c.total === 6
    && Math.abs(c.hitRate - 0.75) < 1e-9 && aggCache.byTool.explain_rules.cache === undefined,
    JSON.stringify(c));
  const aggSkipOnly = summarizeLog(L('tools/call name=nl_test_goal ms=5 outcome=ok code=- cache=skip'));
  const sc = aggSkipOnly.byTool.nl_test_goal.cache || {};
  check('C 只有 skip → 命中率 null（没查不是 0%，不拿 0% 充数）',
    sc.hitRate === null && sc.skip === 1,
    JSON.stringify(sc));

  const aggBadCache = summarizeLog(L('tools/call name=nl_test_goal ms=3 outcome=ok code=- cache=banana'));
  check('C 白名单外 cache 值进 malformed 不静默（与 ms=oops 同口径）',
    aggBadCache.malformedCount === 1 && aggBadCache.total === 0 && /cache=banana/.test(aggBadCache.malformed[0] || ''),
    JSON.stringify({ m: aggBadCache.malformedCount, t: aggBadCache.total }));

  const oldText = [
    '观测摘要：',
    '  调用量 1（ok 1 / error 0 / rejected 0）  成功率 100.0%',
    '  延迟 ms：p50 2 / p95 2 / p99 2 / max 2 / avg 2（样本 1，不含 rejected）',
    '  错误分布：无',
    '  按工具（按调用量降序）：',
    '  · oldfmt 共 1 ok 1 max 2ms',
    '  其他事件 0 行；解析异常 0 行',
  ].join('\n');
  check('C formatText：按工具块透出三态/命中率/maxMs，无 cache 工具不长 cache 段（v1.8.15 新形状逐字节）',
    /cache hit 3\/miss 1\/skip 2（命中率 75\.0%）/.test(formatText(aggCache)) && formatText(aggOld) === oldText
    && /· nl_test_goal 共 6 ok 5 error 1 max 15ms cache/.test(formatText(aggCache)),
    formatText(aggCache).split('\n').find((l) => l.includes('nl_test_goal')));
  const toolBlock = formatText(aggCache).split('\n');
  const iNl = toolBlock.findIndex((l) => l.includes('· nl_test_goal'));
  const iEx = toolBlock.findIndex((l) => l.includes('· explain_rules'));
  // 专用夹具：低频工具先插入 —— 插入序 ≠ 权重序，排序真被验到（咬合可咬红）
  const orderText = summarizeLog([
    L('tools/call name=aaa_first ms=1 outcome=ok code=-'),
    L('tools/call name=nl_test_goal ms=2 outcome=ok code=-'),
    L('tools/call name=nl_test_goal ms=3 outcome=ok code=-'),
    L('tools/call name=nl_test_goal ms=4 outcome=ok code=-'),
  ].join('\n'));
  const orderBlock = formatText(orderText).split('\n');
  const iAaa = orderBlock.findIndex((l) => l.includes('· aaa_first'));
  const iNl2 = orderBlock.findIndex((l) => l.includes('· nl_test_goal'));
  check('C formatText 按工具块：每工具独立一行、按调用量降序（权重序，调用多的先看）',
    toolBlock.some((l) => l.includes('按工具（按调用量降序）：')) && iNl !== -1 && iEx !== -1 && iNl < iEx
    && toolBlock[iNl].startsWith('  · ') && toolBlock[iEx].startsWith('  · ')
    && iNl2 < iAaa,
    `order: ${orderBlock.filter((l) => l.startsWith('  · ')).map((l) => l.trim().slice(0, 20)).join(' | ')}`);

  // CLI 与纯函数同一份判定（cache 字段不例外）：真跑 log_summary.mjs --json 对数
  const cacheLog = path.join(obsDir, 'cache.log');
  fs.writeFileSync(cacheLog, `${cacheText}\n`, 'utf8');
  const cOut2 = path.join(obsDir, 'cache-cli.json');
  const cErr2 = path.join(obsDir, 'cache-cli.err');
  const fdO = fs.openSync(cOut2, 'w');
  const fdE = fs.openSync(cErr2, 'w');
  const cacheCliCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'skill/playwright-verify/scripts/log_summary.mjs'), cacheLog, '--json'], {
      cwd: ROOT,
      stdio: ['ignore', fdO, fdE],
      windowsHide: true,
    });
    child.on('error', () => resolve(-1));
    child.on('close', (cc) => resolve(cc ?? -1));
  });
  fs.closeSync(fdO); fs.closeSync(fdE);
  let cacheCliJson = null;
  try { cacheCliJson = JSON.parse(fs.readFileSync(cOut2, 'utf8')); } catch { /* 保持 null */ }
  check('C CLI log_summary 与纯函数 cache 聚合一致（三态与命中率同一份判定）',
    cacheCliCode === 0 && !!cacheCliJson && !!c
    && JSON.stringify(cacheCliJson.byTool?.nl_test_goal?.cache) === JSON.stringify(c),
    `exit=${cacheCliCode} cache=${JSON.stringify(cacheCliJson?.byTool?.nl_test_goal?.cache)}`);
}

// CLI 与纯函数同一份判定（verify-lib 的存在意义）：真跑 log_summary.mjs --json 对数
const cliOut = path.join(obsDir, 'cli-out.json');
const cliErr = path.join(obsDir, 'cli-err.log');
const cOut = fs.openSync(cliOut, 'w');
const cErr = fs.openSync(cliErr, 'w');
const cliCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'skill/playwright-verify/scripts/log_summary.mjs'), obsLog, '--json'], {
    cwd: ROOT,
    stdio: ['ignore', cOut, cErr],
    windowsHide: true,
  });
  child.on('error', () => resolve(-1));
  child.on('close', (c) => resolve(c ?? -1));
});
fs.closeSync(cOut); fs.closeSync(cErr);
let cliJson = null;
try { cliJson = JSON.parse(fs.readFileSync(cliOut, 'utf8')); } catch { /* 保持 null */ }
const pure = summarizeLog(obsRaw);
check('CLI log_summary 与纯函数聚合一致（同一份判定）',
  cliCode === 0 && !!cliJson && cliJson.total === pure.total && cliJson.malformedCount === pure.malformedCount
  && cliJson.byCode.CONFIG_NOT_FOUND === 1 && cliJson.byCode['-32602'] === 1,
  `exit=${cliCode} total=${cliJson ? cliJson.total : '?'}`);

/* ---- C3：日志容量上限与轮转（PVMCP_LOG_MAX_MB） ---- */
/*
 * 长跑 server 的日志只增不减：无上限会把磁盘和 log_summary 的读取一起拖垮，但轮转
 * 必须「数据不丢 + 汇总端知道少了一段」，否则就是新一轮静默错觉。钉六件事：
 *   1) 默认 2MB 超限轮转（前件移 .1，新日志从标记行起）；2) 标记行被聚合端容忍
 *   （进 otherLines，不混进调用量）；3) 0=关闭轮转（外挂方案的留口真留了）；
 *   4) 旋钮真控制阈值；5) 环境垃圾回退默认且 stderr 提示（调试旋钮不静默装没事）；
 *   6) log_summary 对 .1 前件给出提示（text 一行 / json 增量字段，形状兼容）。
 */
{
  const seedLog = (file, mb) => {
    const line = `${'z'.repeat(180)}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, line.repeat(Math.ceil((mb * 1024 * 1024) / line.length)), 'utf8');
  };
  const rotSpawn = async ({ logFile, extraEnv = {} }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-rot-'));
    const inFile = path.join(dir, 'in.ndjson');
    const outFile = path.join(dir, 'out.ndjson');
    const errFile = path.join(dir, 'err.log');
    const reqs = [1, 2].map((id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'explain_rules', arguments: { group: 'all' } } }));
    fs.writeFileSync(inFile, `${reqs.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const fi = fs.openSync(inFile, 'r');
    const fo = fs.openSync(outFile, 'w');
    const fe = fs.openSync(errFile, 'w');
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SERVER], {
        cwd: ROOT, stdio: [fi, fo, fe], windowsHide: true,
        env: { ...process.env, PVMCP_LOG: logFile, ...extraEnv },
      });
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c ?? -1));
    });
    fs.closeSync(fi); fs.closeSync(fo); fs.closeSync(fe);
    return { code, errText: fs.readFileSync(errFile, 'utf8'), dir };
  };
  const MB = 1024 * 1024;
  const rotDirs = [];

  const log1 = path.join(os.tmpdir(), `pvmcp-rot1-${process.pid}.log`);
  rotDirs.push(log1);
  seedLog(log1, 2.2);
  const s1 = await rotSpawn({ logFile: log1 });
  const cur1 = fs.existsSync(log1) ? fs.readFileSync(log1, 'utf8') : '';
  check('C3 默认 2MB 上限：超限自动轮转（前件移 .1、新日志从轮转标记行起）',
    s1.code === 0 && fs.existsSync(`${log1}.1`) && fs.statSync(`${log1}.1`).size >= 2 * MB
    && cur1.split('\n')[0].includes('log rotated') && fs.statSync(log1).size < 64 * 1024,
    `cur=${fs.existsSync(log1) ? fs.statSync(log1).size : '?'}B prev=${fs.existsSync(`${log1}.1`) ? fs.statSync(`${log1}.1`).size : '?'}B`);

  const agg1 = summarizeLog(cur1);
  const otherLines1 = cur1.split('\n').filter((l) => l.trim() && !l.includes('tools/call'));
  check('C3 轮转标记行被聚合端容忍（标记在日志里、进 otherLines，不混进调用量/错误分布）',
    agg1.total === 2 && agg1.otherLines >= 1 && agg1.malformedCount === 0
    && otherLines1.some((l) => l.includes('log rotated')),
    JSON.stringify({ t: agg1.total, o: agg1.otherLines, m: agg1.malformedCount, mark: otherLines1.some((l) => l.includes('log rotated')) }));

  const log3 = path.join(os.tmpdir(), `pvmcp-rot0-${process.pid}.log`);
  rotDirs.push(log3);
  seedLog(log3, 2.2);
  const s3 = await rotSpawn({ logFile: log3, extraEnv: { PVMCP_LOG_MAX_MB: '0' } });
  check('C3 PVMCP_LOG_MAX_MB=0 → 不轮转（外挂轮转方案的留口真的留了）',
    s3.code === 0 && !fs.existsSync(`${log3}.1`) && fs.statSync(log3).size >= 2 * MB);

  const log4 = path.join(os.tmpdir(), `pvmcp-rot2-${process.pid}.log`);
  rotDirs.push(log4);
  seedLog(log4, 1.2);
  await rotSpawn({ logFile: log4, extraEnv: { PVMCP_LOG_MAX_MB: '1' } });
  check('C3 旋钮真控制阈值：MAX_MB=1 时 1.2MB 也轮转',
    fs.existsSync(`${log4}.1`) && fs.statSync(`${log4}.1`).size >= 1 * MB);

  const log5 = path.join(os.tmpdir(), `pvmcp-rot3-${process.pid}.log`);
  rotDirs.push(log5);
  seedLog(log5, 2.2);
  const s5 = await rotSpawn({ logFile: log5, extraEnv: { PVMCP_LOG_MAX_MB: 'abc' } });
  check('C3 环境垃圾回退默认 2MB 且 stderr 提示一次（不静默装没事、不把服务弄挂）',
    s5.code === 0 && fs.existsSync(`${log5}.1`) && s5.errText.includes('PVMCP_LOG_MAX_MB'),
    `stderr=${s5.errText.trim().slice(0, 60)}`);

  const sumOut = path.join(os.tmpdir(), `pvmcp-rotsum-${process.pid}.txt`);
  const sumErr = path.join(os.tmpdir(), `pvmcp-rotsum-${process.pid}.err`);
  rotDirs.push(sumOut, sumErr);
  const so = fs.openSync(sumOut, 'w');
  const se = fs.openSync(sumErr, 'w');
  const sumCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'skill/playwright-verify/scripts/log_summary.mjs'), log1], {
      cwd: ROOT, stdio: ['ignore', so, se], windowsHide: true,
    });
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c ?? -1));
  });
  fs.closeSync(so); fs.closeSync(se);
  const sumText = fs.readFileSync(sumOut, 'utf8');
  check('C3 log_summary 对轮转前件给出提示（text 模式一行说明，调用量少一段不再静默）',
    sumCode === 0 && sumText.includes('轮转前日志') && sumText.includes('.1'), sumText.split('\n').slice(-2).join(' | '));

  const jsonOut = path.join(os.tmpdir(), `pvmcp-rotjson-${process.pid}.json`);
  rotDirs.push(jsonOut);
  const jo = fs.openSync(jsonOut, 'w');
  const je = fs.openSync(sumErr, 'w');
  const jsonCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'skill/playwright-verify/scripts/log_summary.mjs'), log1, '--json'], {
      cwd: ROOT, stdio: ['ignore', jo, je], windowsHide: true,
    });
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c ?? -1));
  });
  fs.closeSync(jo); fs.closeSync(je);
  let rotJson = null;
  try { rotJson = JSON.parse(fs.readFileSync(jsonOut, 'utf8')); } catch { /* 保持 null */ }
  check('C3 --json 模式轮转前件走增量字段 rotatedPrev（形状兼容，纯 JSON 不破）',
    jsonCode === 0 && rotJson?.rotatedPrev?.file === path.basename(`${log1}.1`)
    && rotJson.rotatedPrev.lines >= 1 && rotJson.total === 2,
    JSON.stringify(rotJson?.rotatedPrev || rotJson));

  for (const f of rotDirs) { try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } }
}

/* ---- cleanup ---- */
try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* 忽略 */ }
try { fs.rmSync(obsDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

log('');
log(failures === 0 ? 'MCP 协议与工具面回归测试全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
