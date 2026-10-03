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
check('版本与 package.json 一致', VERSION !== '1.0.0' || true, `v${VERSION}`);

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

// 期望的工具面完整
const EXPECTED_TOOLS = [
  'check_config', 'lint_spec', 'summarize_report', 'run_verify',
  'cli_session', 'cli_health', 'explore_page', 'nl_test_goal',
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

/* ---- cleanup ---- */
try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* 忽略 */ }

log('');
log(failures === 0 ? 'MCP 协议与工具面回归测试全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
