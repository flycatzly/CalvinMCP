// web-rpa-mcp — MCP 工具全量实测：44 个工具逐个通过 stdio JSON-RPC 真实调用
// 目标不是"跑通主链路"，而是保证"没有任何一个工具是没人用过的死代码"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from '../../demo/app.mjs';
import { getPlaywright } from '../lib/browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'server.mjs');

let pass = 0, fail = 0, skip = 0;
const failures = [];
const skips = [];
// 诚实 SKIP 口径（与 mysql-validate 退出码 3 同义）：探针证明环境解析不到 playwright，
// 且失败原因就是缺依赖（或其级联）时降级为 SKIP；装了依赖还报缺 = 产品缺陷 = 照旧 FAIL。
const depSig = /未找到可用的 playwright|PLAYWRIGHT_NOT_FOUND/;
let pwMissing = false, depTainted = false;
try { await getPlaywright(); } catch (e) { pwMissing = !!(e && e.code === 'PLAYWRIGHT_NOT_FOUND'); }
function ok(name) { pass++; console.log('  ok   ' + name); }
// 状态前置依赖：这些用例的前提状态（profile / 录制会话）由上游浏览器面用例创建。
// 上游因缺依赖诚实 SKIP 后它们的失败只是级联（前置状态根本没机会建），不是产品缺陷。
const stateDep = {
  profile_info: ['profile_login'], profile_reset: ['profile_login'],
  record_status: ['record_start'], record_cancel: ['record_start', 'record_splice_start'],
};
const depSkippedNames = new Set();
function bad(name, e) {
  const msg = e && e.message ? e.message : String(e);
  const stateProducers = stateDep[name] || [];
  const stateCascade = pwMissing && stateProducers.some((p) => depSkippedNames.has(p));
  const dep = pwMissing && (depSig.test(msg) || stateCascade || (depTainted && /Cannot read properties of null/.test(msg)));
  if (dep) {
    if (depSig.test(msg)) depTainted = true;
    depSkippedNames.add(name);
    skip++;
    const why = depSig.test(msg) ? '缺 playwright 依赖' : (stateCascade ? '级联自上游缺依赖，前置状态未创建' : '级联自上游缺依赖');
    skips.push(name + ' -> ' + why);
    console.log('  SKIP ' + name + '\n       （诚实 SKIP：' + (depSig.test(msg) ? '环境缺 playwright 依赖' : (stateCascade ? '级联自上游缺依赖，前置状态未创建（' + stateProducers.join('/') + ' 因缺依赖未跑）' : '级联自上游缺依赖，前置未跑')) + '）');
    return;
  }
  fail++;
  failures.push(name + ' -> ' + msg);
  console.log('  FAIL ' + name + '\n       ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 工具输出形如 "摘要\n\n{...JSON...}"，摘要里也可能出现 { 或 [ —— 逐处尝试直到整段能解析 */
function parse(text) {
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '{' && ch !== '[') continue;
    try { return JSON.parse(s.slice(i).trim()); } catch { /* 继续找下一处 */ }
  }
  return null;
}
function startAlarmReceiver() {
  const got = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { got.push(JSON.parse(b)); } catch { got.push({ raw: b }); } res.writeHead(200); res.end('{"ok":true}'); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, url: 'http://127.0.0.1:' + server.address().port + '/hook' })));
}

/* ---------------- MCP 客户端 ---------------- */
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { const r = pending.get(msg.id); pending.delete(msg.id); r(msg); }
  }
});
let seq = 0;
function call(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('超时: ' + method + ' ' + JSON.stringify(params).slice(0, 80))); }, 180000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const called = new Set();
async function T(name, args, expect) {
  const exp = expect || {};
  const r = await call('tools/call', { name, arguments: args || {} });
  called.add(name);
  try {
    if (r.error) throw new Error('JSON-RPC 错误: ' + JSON.stringify(r.error));
    const res = r.result;
    if (!res || !Array.isArray(res.content) || !res.content[0] || typeof res.content[0].text !== 'string') {
      throw new Error('返回结构不合法: ' + JSON.stringify(res).slice(0, 200));
    }
    if (exp.isError === true && res.isError !== true) throw new Error('期望 isError=true，实际 false；输出: ' + res.content[0].text.slice(0, 200));
    if (exp.isError === false && res.isError === true) throw new Error('期望 isError=false，实际 true；输出: ' + res.content[0].text.slice(0, 300));
    if (typeof exp.check === 'function') exp.check(res, parse(res.content[0].text));
    ok(name);
  } catch (e) { bad(name, e); }
  return r;
}

async function main() {
  const demo = await startDemoServer(0);
  const alarm = await startAlarmReceiver();
  const DEMO = demo.url;
  console.log('演示站点: ' + DEMO);

  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tools-test', version: '1' } });
  assert.ok(init.result && init.result.serverInfo, 'initialize 失败');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await call('tools/list', {});
  const allTools = list.result.tools.map((t) => t.name);
  console.log('服务器声明工具数: ' + allTools.length);

  const CHECK = (fn, label) => (res, data) => {
    if (fn(res, data)) return;
    // 断言失败先看底层输出有没有缺依赖原文：有就把证据拼进错误消息，让 bad() 按证据降级，
    // 不让标签（如「回放未通过」）吞掉根因；输出里没有缺依赖字样的照旧 FAIL（不遮真实缺陷）
    const raw = JSON.stringify(data) + ' ' + (res && res.content && res.content[0] ? res.content[0].text : '');
    const m = raw.match(depSig);
    throw new Error((label || '校验未通过') + (m ? ' — 根因: ' + m[0] : ''));
  };

  console.log('\n[环境与 profile]');
  await T('doctor', {}, { isError: false, check: CHECK((res, d) => d && d.version && d.browser, 'doctor 缺少关键字段') });
  await T('profile_info', {}, { isError: false, check: CHECK((res, d) => d && typeof d.enabled === 'boolean' && typeof d.dir === 'string') });
  await T('profile_reset', { confirm: false }, { isError: true });
  await T('profile_login', { url: DEMO + '/dialog', successUrlContains: '/dialog', timeoutMs: 60000 }, {
    isError: false,
    check: CHECK((res, d) => d && d.loggedIn === true && d.profile && d.profile.enabled === true, 'profile_login 未保存登录态'),
  });
  // successText 判定路径：页面上出现目标文字即算登录成功（/form 的「提交工单」按钮常驻）
  await T('profile_login', { url: DEMO + '/form', successText: '提交工单', timeoutMs: 60000 }, {
    isError: false,
    check: CHECK((res, d) => d && d.loggedIn === true && d.url, 'successText 命中应判定登录成功'),
  });

  console.log('\n[流程管理与校验]');
  const mainFlow = {
    id: 't-tool-main', name: 't-tool-main', version: 1, startUrl: DEMO + '/form',
    params: [], assertions: [{ kind: 'textPresent', text: '工单提交成功' }],
    steps: [
      { op: 'goto', url: DEMO + '/form' },
      { op: 'fill', locators: [{ strategy: 'testid', value: 'orderNo' }], value: 'SO-TOOL' },
      { op: 'check', locators: [{ strategy: 'testid', value: 'agree' }], checked: true },
      { op: 'click', locators: [{ strategy: 'testid', value: 'formSubmit' }], waitForNav: 'load' },
      { op: 'waitForText', text: '工单提交成功' },
    ],
  };
  const mutFlow = {
    id: 't-tool-mut', name: 't-tool-mut', version: 1, startUrl: DEMO + '/form',
    params: [], assertions: [{ kind: 'textPresent', text: '提交工单' }],
    steps: [
      { op: 'goto', url: DEMO + '/form' },
      { op: 'fill', locators: [{ strategy: 'testid', value: 'orderNo' }], value: 'A' },
      { op: 'sleep', ms: 100 },
    ],
  };
  await T('flow_import', { flow: JSON.stringify(mainFlow), overwrite: true }, { isError: false, check: CHECK((res, d) => d && d.flowId === 't-tool-main') });
  await T('flow_import', { flow: mutFlow, overwrite: true }, { isError: false });
  await T('flow_list', {}, { isError: false, check: CHECK((res, d) => d && d.flows.some((f) => f.id === 't-tool-main')) });
  await T('flow_show', { flowId: 't-tool-main', format: 'markdown' }, { isError: false, check: CHECK((res, d) => d && /步骤/.test(d.markdown)) });
  await T('flow_show', { flowId: 't-tool-main', format: 'json' }, { isError: false });
  await T('flow_lint', { flowId: 't-tool-main' }, { isError: false, check: CHECK((res, d) => d && Array.isArray(d.errors)) });
  await T('flow_param_add', { flowId: 't-tool-mut', name: 'P', default: 'x' }, { isError: false });
  await T('flow_param_remove', { flowId: 't-tool-mut', name: 'P' }, { isError: false });
  await T('flow_assertion_add', { flowId: 't-tool-mut', kind: 'url', contains: '/form', message: '应在表单页' }, { isError: false });
  await T('flow_assertion_remove', { flowId: 't-tool-mut', index: 2 }, { isError: false });
  await T('flow_step_update', { flowId: 't-tool-mut', index: 2, patch: { value: 'SO-MUT' } }, { isError: false, check: CHECK((res, d) => d && /SO-MUT/.test(JSON.stringify(d))) });
  await T('flow_step_move', { flowId: 't-tool-mut', from: 2, to: 3 }, { isError: false });
  await T('flow_step_delete', { flowId: 't-tool-mut', index: 3 }, { isError: false });
  await T('flow_rename', { flowId: 't-tool-mut', name: 't-tool-mut-renamed' }, { isError: false, check: CHECK((res, d) => d && d.name === 't-tool-mut-renamed') });
  await T('flow_export', { flowId: 't-tool-mut' }, { isError: false, check: CHECK((res, d) => d && typeof d.json === 'string' && JSON.parse(d.json).id === 't-tool-mut') });

  console.log('\n[备份与回滚]');
  // 流程改动前会自动备份：flow_restore 必须能真的把刚才的改动撤回去
  await T('flow_restore', { flowId: 't-tool-mut', list: true }, { isError: false, check: CHECK((res, d) => d && Array.isArray(d.backups) && d.backups.length > 0, '改动流程后应有自动备份') });
  await T('flow_restore', { flowId: 't-tool-mut' }, { isError: false, check: CHECK((res, d) => d && d.restoredFrom && typeof d.stepCount === 'number', '回滚结果缺字段') });
  await T('flow_show', { flowId: 't-tool-mut', format: 'json' }, { isError: false, check: CHECK((res, d) => d && d.name === 't-tool-mut', '回滚后应回到重命名之前的状态（name=t-tool-mut）') });
  // 保留策略：超过 30 天的旧备份会在下一次改动留备份时被清掉（伪造一份 40 天前的）
  {
    const dir = path.join(__dirname, '..', '..', '.work', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 't-tool-mut.20200101-000000-000.json');
    fs.writeFileSync(stale, '{}');
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    fs.utimesSync(stale, old, old);
    await T('flow_rename', { flowId: 't-tool-mut', name: 't-tool-mut' }, { isError: false });
    await T('flow_restore', { flowId: 't-tool-mut', list: true }, {
      isError: false,
      check: CHECK((res, d) => d && Array.isArray(d.backups) && !d.backups.some((b) => String(b.file || b.at || '').indexOf('20200101') >= 0), '30 天前的旧备份应在留新备份时被清掉'),
    });
  }
  await T('flow_restore', { flowId: '__没有备份的流程__' }, { isError: true });

  // flow_assertion_add 的 regex 字段必须原样落到断言上（url 断言正则匹配的行为由集成套锁住）
  await T('flow_assertion_add', { flowId: 't-tool-mut', kind: 'url', regex: '/form$', message: '地址应匹配正则' }, {
    isError: false,
    check: CHECK((res, d) => d && d.added && d.added.regex === '/form$' && (d.assertions || []).some((x) => x.regex === '/form$'), 'regex 字段未原样落到断言上'),
  });

  console.log('\n[回放 / 预检 / 报告 / 串联]');
  await T('flow_preflight', { flowId: 't-tool-main' }, { isError: false, check: CHECK((res, d) => d && Array.isArray(d.steps)) });
  await T('flow_run', { flowId: 't-tool-main', trigger: 'tools-test' }, {
    isError: false,
    // 预算/启动可观测字段要透出到工具响应（修前只有 report.json 里有，MCP 客户端看不到）；无预算时 budgetSource=null
    check: CHECK((res, d) => d && d.status === 'pass' && typeof d.budgetOverrunMs === 'number' && (d.budgetSource === null || typeof d.budgetSource === 'string') && typeof d.launchMs === 'number', '回放未通过或预算/启动可观测字段缺失'),
  });
  await T('run_history', { flowId: 't-tool-main', limit: 5 }, { isError: false, check: CHECK((res, d) => d && d.runs.length > 0) });
  await T('run_report', { flowId: 't-tool-main' }, { isError: false, check: CHECK((res, d) => d && d.status === 'pass' && Array.isArray(d.steps)) });
  await T('chain_run', { items: [{ flow: 't-tool-main' }] }, { isError: false, check: CHECK((res, d) => d && d.status === 'pass') });
  await T('status_report', {}, { isError: false, check: CHECK((res, d) => d && d.summary && typeof d.summary.flows === 'number') });
  await T('runs_prune', {}, { isError: false, check: CHECK((res, d) => d && d.dryRun === true) });

  console.log('\n[锁]');
  await T('lock_status', {}, { isError: false, check: CHECK((res, d) => d && Array.isArray(d.locks)) });
  await T('lock_status', { flowId: 't-tool-main' }, { isError: false, check: CHECK((res, d) => d && d.held === false) });
  await T('lock_release', { flowId: 't-tool-main' }, { isError: false });

  console.log('\n[凭据]');
  await T('secret_set', { name: 't_tool_secret', value: 'S3CRET-VALUE-9' }, { isError: false, check: CHECK((res) => res.content[0].text.indexOf('S3CRET-VALUE-9') < 0, '明文回显了凭据') });
  await T('secret_list', {}, { isError: false, check: CHECK((res, d) => d && d.secrets.some((s) => s.name === 't_tool_secret')) });
  await T('secret_delete', { name: 't_tool_secret' }, { isError: false, check: CHECK((res, d) => d && d.deleted === true) });

  console.log('\n[告警]');
  await T('notify_config', {}, { isError: false, check: CHECK((res, d) => d && d.notify && 'enabled' in d.notify) });
  await T('notify_config', { enabled: true, type: 'generic', webhook: alarm.url, on: ['failure', 'success'] }, { isError: false });
  await T('notify_test', { message: 'tools 测试消息' }, { isError: false, check: CHECK((res) => true) });
  await sleep(500);
  assert.ok(alarm.got.length > 0, '告警接收端没收到 notify_test 的消息');
  // null = 恢复默认（否则测试会把自己的偏好留在配置里）
  await T('notify_config', { enabled: false, webhook: null, on: null }, { isError: false });

  console.log('\n[配置]');
  await T('config_get', {}, { isError: false, check: CHECK((res, d) => d && d.config && d.configPath) });
  await T('config_set', { patch: { run: { stepTimeoutMs: 12345 } } }, { isError: false, check: CHECK((res, d) => d && d.config.run.stepTimeoutMs === 12345) });
  await T('config_set', { patch: { run: { stepTimeoutMs: 15000 } } }, { isError: false });

  console.log('\n[profile 复查与关闭]');
  await T('profile_info', {}, { isError: false, check: CHECK((res, d) => d && d.enabled === true && d.exists === true, 'profile 未被创建') });
  await T('profile_reset', { confirm: true }, { isError: false, check: CHECK((res, d) => d && d.result.removed === true) });
  await T('config_set', { patch: { browser: { persistProfile: null } } }, { isError: false });

  console.log('\n[定时]');
  await T('schedule_add', { flowId: 't-tool-main', frequency: 'daily', at: '23:58' }, { isError: false, check: CHECK((res, d) => d && d.ok === true, '注册定时失败') });
  await T('schedule_list', {}, { isError: false, check: CHECK((res, d) => d && d.tasks.some((t2) => t2.flowId === 't-tool-main')) });
  await T('schedule_run_now', { flowId: 't-tool-main' }, { isError: false, check: CHECK((res, d) => d && d.ok === true) });
  // schedule_run_now 是异步触发（任务计划拉起 runner 进程）：等这次执行真正结束（新运行报告落盘且锁释放）
  // 再继续，否则后面的锁敏感测试（片段重录要拿同一条流程的锁）会跟后台执行撞车；固定 sleep 在机器慢时不够
  {
    const raw = (n2, a2) => call('tools/call', { name: n2, arguments: a2 }).then((m) => parse(m.result.content[0].text));
    const beforeSig = JSON.stringify((((await raw('run_history', { flowId: 't-tool-main', limit: 20 })) || {}).runs || [])[0] || null);
    let settled = false;
    for (let w = 0; w < 180 && !settled; w++) {
      await sleep(1000);
      const hist = await raw('run_history', { flowId: 't-tool-main', limit: 20 });
      const st = await raw('lock_status', { flowId: 't-tool-main' });
      const sig = JSON.stringify(((hist || {}).runs || [])[0] || null);
      if (st && st.held === false && sig !== beforeSig) settled = true;
    }
    if (settled) ok('定时触发的后台执行已结束（新报告落盘且锁释放）');
    else bad('定时触发的后台执行已结束（新报告落盘且锁释放）', new Error('180s 内没等到 schedule_run_now 的执行结束'));
  }
  await T('schedule_remove', { flowId: 't-tool-main' }, { isError: false, check: CHECK((res, d) => d && d.ok === true) });

  console.log('\n[录制]');
  await T('record_start', { url: DEMO + '/form', name: 't-tool-rec' }, { isError: false, check: CHECK((res, d) => d && d.ok === true && d.sessionId) });
  await T('record_status', {}, { isError: false, check: CHECK((res, d) => d && d.recording === true) });
  await T('record_cancel', {}, { isError: false, check: CHECK((res, d) => d && d.ok === true) });
  await T('record_stop', {}, { isError: true });

  console.log('\n[片段重录]');
  // 真实启动一次 splice：校验步骤序号/变量、用同一个执行器重放前缀、拿流程锁；没操作就取消（原流程不动）
  await T('record_splice_start', { flowId: 't-tool-main', from: 3, to: 4, headed: false }, {
    isError: false,
    check: CHECK((res, d) => d && d.ok === true && d.splice && d.splice.prefixCount === 2, '片段重录未正确启动（应先重放前 2 步）'),
  });
  await T('record_cancel', {}, { isError: false, check: CHECK((res, d) => d && d.ok === true && d.originalFlowUntouched === true, '取消片段重录应声明原流程未改动') });

  console.log('\n[清理]');
  await T('flow_delete', { flowId: 't-tool-main' }, { isError: false, check: CHECK((res, d) => d && d.deleted === true) });
  await T('flow_delete', { flowId: 't-tool-mut' }, { isError: false, check: CHECK((res, d) => d && d.deleted === true) });

  /* ---------------- 覆盖度断言 ---------------- */
  console.log('\n[覆盖度]');
  const missing = allTools.filter((t2) => !called.has(t2));
  if (missing.length) bad(allTools.length + ' 个工具全部被真实调用过', new Error('从未被调用的工具: ' + JSON.stringify(missing)));
  else ok(allTools.length + ' 个工具全部被真实调用过');
  const extra = [...called].filter((c) => !allTools.includes(c));
  if (extra.length) bad('没有多余调用', new Error(JSON.stringify(extra)));
  else ok('没有多余调用');

  child.stdin.end();
  await sleep(400);
  try { child.kill(); } catch { /* ignore */ }
  alarm.server.close();
  demo.server.close();
  try { fs.rmSync(path.join(__dirname, '..', '..', 'runs', 't-tool-main'), { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    const bdir = path.join(__dirname, '..', '..', '.work', 'backups');
    for (const f of fs.readdirSync(bdir)) if (f.indexOf('t-tool-') === 0) fs.rmSync(path.join(bdir, f), { force: true });
  } catch { /* ignore */ }

  console.log('\n总计: ' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' 诚实SKIP' : ''));
  if (fail) console.log('\n失败项:\n' + failures.join('\n'));
  if (skip) console.log('\n诚实 SKIP（不计通过也不计失败）:\n' + skips.join('\n'));
  process.exit(fail ? 1 : skip ? 3 : 0);
}

main().catch((e) => {
  console.error('工具全量测试异常: ' + String(e && e.stack ? e.stack : e));
  try { child.kill(); } catch { /* ignore */ }
  process.exit(1);
});
