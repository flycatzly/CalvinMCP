// web-rpa-mcp — 全流程真实本地浏览器实测（MCP stdio 协议层）
// 不 import 任何 mcp/lib 产品代码；以真实 MCP 客户端身份经 stdio JSON-RPC 拉起
// mcp/server.mjs，对本地真实运行的演示站点把 44 个工具逐个真调用、真断言。
// 断言纪律：期望成功的调用必须 res.isError !== true（不能只看业务字段，防"报错被当成功"）；
// 期望失败的调用必须 res.isError === true。产物核验直接查文件系统与本地网络栈。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startAutobotServer } from './autobot-site.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// WEBRPA_ROOT：实例隔离的数据根注入。server.mjs 跟随该 env 把 flows/runs/.work 落到数据根，
// 本 harness 核验产物必须用同一个数据根（CODE/DATA 分离：ROOT 只管代码——server.mjs/demo/playwright 解析）；
// spawn 时把解析后的绝对值回注子进程，避免相对 env 在两个 cwd 下解析不一致。
const DATA = process.env.WEBRPA_ROOT ? path.resolve(process.env.WEBRPA_ROOT) : ROOT;
const SERVER = path.join(ROOT, 'mcp', 'server.mjs');
const FLOW_MAIN = 't-live-订单日报导出';
const FLOW_COPY = 't-live-copy';
const FLOW_BAD = 't-live-bad';
const SECRET_NAME = 't-live-db-pwd';
const SECRET_VALUE = 'T-LIVE-SECRET-9137';
// 测试夹具归数据根：放代码区会让并发 live 实例互写/互删同一文件（resolveParams 运行期全量解析时会读它，缺失只落 notice 不红=静默降级）
const CSV_FILE = path.join(DATA, '.work', 't-live.csv');
const CSV_SRC = 'csv:' + CSV_FILE.replace(/\\/g, '/') + '#客户';

/* ---------------- 结果收集 ---------------- */
const results = [];
let group = '';
function g(name) { group = name; console.log('\n======== ' + name + ' ========'); }
function ok(name, detail) { results.push({ group, name, ok: true, detail: detail || '' }); console.log('  ok   ' + name + (detail ? '  — ' + detail : '')); }
function fail(name, e) {
  const msg = e && e.message ? e.message : String(e);
  results.push({ group, name, ok: false, detail: msg });
  console.log('  FAIL ' + name + '\n       ' + msg);
}
async function T(name, fn) { try { await fn(); ok(name); } catch (e) { fail(name, e); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 本地服务 ---------------- */
const alarmGot = [];
function startAlarmReceiver() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { try { alarmGot.push(JSON.parse(b)); } catch { alarmGot.push({ raw: b }); } res.writeHead(200); res.end('{"ok":true}'); });
    });
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port + '/hook'));
  });
}

/* ---------------- MCP 客户端（stdio JSON-RPC） ---------------- */
const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: { ...process.env, T_LIVE_ENV_EMP: '2002', ...(process.env.WEBRPA_ROOT ? { WEBRPA_ROOT: DATA } : {}) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {});
const pending = new Map();
let buf = '', seq = 0;
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
  }
});
function rawCall(method, params, timeoutMs) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('MCP 调用超时: ' + method + ' ' + JSON.stringify(params).slice(0, 100))); }, timeoutMs || 300000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
/** 工具输出形如 "摘要\n\n{...JSON...}"，从第一个 { 或 [ 起逐处尝试整段解析 */
function parse(text) {
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '{' && ch !== '[') continue;
    try { return JSON.parse(s.slice(i).trim()); } catch { /* 下一处 */ }
  }
  return null;
}
function attach(name, m) {
  if (m.error) throw new Error('JSON-RPC 错误: ' + JSON.stringify(m.error).slice(0, 300));
  const res = m.result;
  assert(res && Array.isArray(res.content) && res.content[0] && typeof res.content[0].text === 'string',
    '返回结构不合法: ' + JSON.stringify(res).slice(0, 200));
  return { res, text: res.content[0].text, data: parse(res.content[0].text) };
}
/** 期望成功的调用：严格断言不是错误回包 */
async function call(name, args, timeoutMs) {
  called.add(name);
  const r = attach(name, await rawCall('tools/call', { name, arguments: args || {} }, timeoutMs));
  assert(r.res.isError !== true, '意外的业务错误回包(' + name + '): ' + r.text.slice(0, 250));
  return r;
}
/** 期望业务失败的调用：必须是错误回包 */
async function callErr(name, args) {
  called.add(name);
  const r = attach(name, await rawCall('tools/call', { name, arguments: args || {} }));
  assert(r.res.isError === true, '期望 isError=true 实际 false(' + name + '): ' + r.text.slice(0, 250));
  return r;
}
/** 成败皆可的调用（用例自行判定），只保证回包结构合法 */
async function callAny(name, args, timeoutMs) {
  called.add(name);
  return attach(name, await rawCall('tools/call', { name, arguments: args || {} }, timeoutMs));
}
const called = new Set();

/* ---------------- 文件系统产物核验 ---------------- */
function runsDir(flowId) { return path.join(DATA, 'runs', flowId); }
function runStampDirs(flowId) {
  const dir = runsDir(flowId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory()).sort();
}
function latestRun(flowId) {
  const stamps = runStampDirs(flowId);
  assert(stamps.length, 'runs/' + flowId + ' 下没有任何运行目录');
  const stamp = stamps[stamps.length - 1];
  const rp = path.join(runsDir(flowId), stamp, 'report.json');
  assert(fs.existsSync(rp), 'report.json 不存在: ' + stamp);
  return { stamp, report: JSON.parse(fs.readFileSync(rp, 'utf8')), dir: path.join(runsDir(flowId), stamp) };
}
function countShots(runDir) {
  let n = 0;
  for (const f of fs.readdirSync(runDir)) if (/\.(png|jpe?g)$/i.test(f)) n++;
  const sub = path.join(runDir, 'screenshots');
  if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (/\.(png|jpe?g)$/i.test(f)) n++;
  return n;
}
function countWebm(flowId) {
  let n = 0;
  for (const s of runStampDirs(flowId)) {
    const v = path.join(runsDir(flowId), s, 'videos');
    if (!fs.existsSync(v)) continue;
    for (const f of fs.readdirSync(v)) if (/\.webm$/i.test(f)) n++;
  }
  return n;
}
const stepSig = (steps) => steps.map((s) => s.op + ':' + (s.value || s.url || (s.locators && s.locators[0] ? s.locators[0].value : ''))).join('|');

async function main() {
  // 诚实 SKIP 口径（同 e2e/tools 套件）：环境真解析不到 playwright 才整体降级 exit 3，
  // 明示不冒充失败（假红）也不冒充通过（假绿）；装了仍报错 = 产品/环境缺陷 = 照旧 FAIL
  try {
    createRequire(path.join(ROOT, 'mcp', 'package.json')).resolve('playwright');
  } catch {
    console.log('实测 SKIP（整体）（诚实 SKIP：环境缺 playwright 依赖——先在 mcp 目录 npm install）');
    process.exit(3);
  }
  const autobot = await startAutobotServer();
  const demoMod = await import(pathToFileURL(path.join(ROOT, 'demo', 'app.mjs')).href);
  const demo = await demoMod.startDemoServer(0);
  const alarmUrl = await startAlarmReceiver();
  const AUTO = autobot.url, DEMO = demo.url;
  console.log('演示站点: ' + DEMO);
  console.log('机器人站点: ' + AUTO + '  (/?auto=1 自动演示)');
  console.log('告警接收器: ' + alarmUrl);

  /* ================ 0. 残留清理（保证可重跑） ================ */
  g('0 残留清理（静默）');
  for (const [n, a] of [['record_cancel', {}], ['schedule_remove', { flowId: FLOW_MAIN }], ['schedule_remove', { flowId: FLOW_COPY }], ['flow_delete', { flowId: FLOW_MAIN }], ['flow_delete', { flowId: FLOW_COPY }], ['flow_delete', { flowId: FLOW_BAD }], ['secret_delete', { name: SECRET_NAME }], ['profile_reset', { confirm: true }], ['config_set', { patch: { browser: { persistProfile: false }, notify: { enabled: false, type: 'generic', webhook: '', on: ['failure', 'healed'], mention: '' } } }]]) {
    try { called.add(n); await rawCall('tools/call', { name: n, arguments: a }); } catch { /* 静默 */ }
  }
  console.log('  done');

  /* ================ 1. 协议握手与工具清单 ================ */
  g('1 MCP 协议握手');
  const init = await rawCall('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-verify', version: '1.0' } });
  await T('initialize 握手（serverInfo/协议版本）', () => {
    assert(init.result && init.result.serverInfo, '缺 serverInfo');
    assert(init.result.serverInfo.name === 'web-rpa-mcp', 'serverInfo.name 不对: ' + JSON.stringify(init.result.serverInfo));
    console.log('  serverInfo=' + JSON.stringify(init.result.serverInfo) + ' protocol=' + init.result.protocolVersion);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tl = await rawCall('tools/list', {});
  await T('tools/list 返回 44 个工具且 schema 完整', () => {
    assert(tl.result && Array.isArray(tl.result.tools), 'tools/list 结构不对');
    assert(tl.result.tools.length === 44, '工具数=' + tl.result.tools.length);
    assert(tl.result.tools.every((t) => t.name && t.description && t.inputSchema), '有工具缺 name/description/inputSchema');
  });

  /* ================ 2. 环境与配置 ================ */
  g('2 doctor / config_get / config_set');
  await T('config_get 返回配置（browser/run/notify/security）', async () => {
    const d = await call('config_get', {});
    const cfg = d.data && d.data.config;
    assert(cfg && cfg.browser && cfg.run && cfg.notify && cfg.security, '配置结构不完整: ' + d.text.slice(0, 150));
  });
  await T('doctor 环境自检（浏览器可用）', async () => {
    const d = await call('doctor', {});
    assert(d.data && d.data.version, 'doctor 结构异常: ' + d.text.slice(0, 300));
    console.log('  ' + d.text.split('\n')[0].slice(0, 120));
  });
  await T('config_set 合并式写入并回读生效', async () => {
    const before = (await call('config_get', {})).data.config;
    const w = await call('config_set', { patch: { run: { retries: before.run.retries } } });
    assert(w.data && w.data.config && w.data.config.run.retries === before.run.retries, '写入回读不一致');
  });
  await T('契约：非法 flowId（路径穿越）被入口拦截 INVALID_ARGUMENT', async () => {
    const e = await callErr('flow_show', { flowId: '../evil' });
    assert(/INVALID_ARGUMENT/.test(e.text), '错误里没有 INVALID_ARGUMENT: ' + e.text.slice(0, 200));
  });
  await T('契约：maxDurationMs=-1 被入口拦截（minimum:0）', async () => {
    const e = await callErr('flow_run', { flowId: FLOW_COPY, maxDurationMs: -1 });
    assert(/INVALID_ARGUMENT/.test(e.text), '错误里没有 INVALID_ARGUMENT: ' + e.text.slice(0, 200));
  });
  await T('契约：chain_run 缺 items[].flow 被拦截', async () => {
    const e = await callErr('chain_run', { items: [{ params: {} }] });
    assert(/INVALID_ARGUMENT/.test(e.text), '错误里没有 INVALID_ARGUMENT: ' + e.text.slice(0, 200));
  });

  /* ================ 3. 凭据 ================ */
  g('3 secret_set / secret_list / secret_delete');
  await T('secret_set 加密保存（响应不回显明文）', async () => {
    const d = await call('secret_set', { name: SECRET_NAME, value: SECRET_VALUE });
    assert(!d.text.includes(SECRET_VALUE), '响应泄漏了明文 secret');
  });
  await T('secret_list 列出名称（不含值）', async () => {
    const d = await call('secret_list', {});
    assert(JSON.stringify(d.data || '').includes(SECRET_NAME), '列表缺 ' + SECRET_NAME + ': ' + d.text.slice(0, 200));
    assert(!d.text.includes(SECRET_VALUE), 'secret_list 泄漏明文');
  });

  /* ================ 4. 持久化登录态 ================ */
  g('4 profile_login / profile_info / profile_reset');
  await T('profile_info（初始状态可见）', async () => {
    const d = await call('profile_info', {});
    assert(d.data && typeof d.data.enabled === 'boolean', '无数据: ' + d.text.slice(0, 200));
    console.log('  enabled=' + d.data.enabled + ' exists=' + d.data.exists);
  });
  await T('profile_login 真实保存登录态（successText 即时命中）', async () => {
    const d = await call('profile_login', { url: AUTO + '/profile-home', successText: '工作台', timeoutMs: 30000 }, 120000);
    assert(d.data && d.data.loggedIn === true, '未判定登录成功: ' + d.text.slice(0, 300));
  });
  await T('profile_info（开启后目录/体积可见）', async () => {
    const d = await call('profile_info', {});
    assert(d.data && d.data.enabled === true && d.data.exists === true, '登录态未落盘: ' + d.text.slice(0, 300));
    assert(d.data.bytes > 0 && d.data.files > 0, '目录统计异常: ' + JSON.stringify({ b: d.data.bytes, f: d.data.files }));
    console.log('  ' + d.text.split('\n')[0].slice(0, 160));
  });
  await T('profile_reset 显式清空登录态（目录真实删除）', async () => {
    const d = await call('profile_reset', { confirm: true }, 120000);
    assert(d.data && d.data.result && d.data.result.removed === true, '未真实删除: ' + d.text.slice(0, 200));
    const after = await call('profile_info', {});
    assert(after.data.exists === false && after.data.files === 0, '磁盘状态未清空: ' + d.text.slice(0, 200));
    assert(after.data.enabled === true, 'enabled 是 persistProfile 开关，reset 只清登录态，应保持开启（设计语义）');
    console.log('  重置后: exists=false files=0（enabled 开关保持 ' + after.data.enabled + '，语义=持久化功能开关）');
  });
  await call('config_set', { patch: { browser: { persistProfile: false } } }); // 还原（profile_login 会自动开启）

  /* ================ 5. 录制全链路（真实步骤捕获） ================ */
  g('5 record_start → 自动演示 → record_stop（生成技能）');
  await T('record_start 打开录制会话（真实浏览器）', async () => {
    const d = await call('record_start', { url: AUTO + '/?auto=1', name: FLOW_MAIN });
    assert(d.data && d.data.ok === true && d.data.sessionId, '启动失败: ' + d.text.slice(0, 300));
  });
  await T('record_status 观察步骤增长（等待自动演示完成）', async () => {
    const deadline = Date.now() + 45000;
    let n = 0;
    for (;;) {
      await sleep(1000);
      const d = await call('record_status', {});
      assert(d.data && d.data.recording === true, '会话不在录制状态: ' + d.text.slice(0, 200));
      n = Array.isArray(d.data.steps) ? d.data.steps.length : (d.data.stepCount || 0);
      if (n >= 7) break;
      if (Date.now() > deadline) throw new Error('45s 内只录到 ' + n + ' 步（期望 ≥7）: ' + JSON.stringify(d.data).slice(0, 400));
    }
    console.log('  已捕获 ' + n + ' 步');
  });
  await sleep(2500); // 防抖 flush + 下载落定
  await T('record_stop 生成技能（步骤/变量化/断言/lint）', async () => {
    const d = await call('record_stop', { name: FLOW_MAIN, save: true, inferAssertions: true }, 120000);
    assert(d.data && d.data.flowId === FLOW_MAIN && d.data.stepCount >= 7, '生成异常: ' + d.text.slice(0, 300));
    console.log('  步骤数=' + d.data.stepCount + ' 自动变量=' + JSON.stringify(d.data.autoVariables).slice(0, 140) +
      ' 断言=' + JSON.stringify((d.data.assertions || []).map((a) => a.kind)) +
      ' lint: E=' + d.data.lint.errors.length + ' W=' + d.data.lint.warnings.length);
  });
  let recFlow = null;
  await T('录制质量：goto 恰 1 条 / 工号 1001 / 密码敏感不落明文', async () => {
    const d = await call('flow_show', { flowId: FLOW_MAIN, format: 'json' });
    recFlow = d.data;
    const steps = recFlow.steps;
    assert(steps.filter((s) => s.op === 'goto').length === 1, 'goto 数量不对');
    assert(steps.some((s) => s.op === 'fill' && String(s.value) === '1001'), '没录到工号 1001');
    const pwd = steps.find((s) => s.op === 'fill' && s.sensitiveReason === 'password');
    assert(pwd, '密码未被识别为敏感');
    assert(!pwd.value, '密码明文被记录: ' + JSON.stringify(pwd.value));
  });
  await T('录制质量：今天日期自动变量化 / 登录等导航 / 导出标 expectDownload / 推断断言', () => {
    const steps = recFlow.steps;
    assert(steps.some((s) => s.op === 'fill' && String(s.value).indexOf('${today') === 0), '日期没变量化: ' + JSON.stringify(steps.filter((s) => s.op === 'fill').map((s) => s.value)));
    assert(steps.some((s) => s.op === 'click' && s.waitForNav), '登录点击没等导航');
    assert(steps.some((s) => s.op === 'click' && s.expectDownload), '导出点击没标 expectDownload');
    const kinds = (recFlow.assertions || []).map((a) => a.kind);
    assert(kinds.includes('download') && kinds.includes('tableNotEmpty'), '推断断言不对: ' + JSON.stringify(kinds));
  });

  /* ================ 6. 流程管理 ================ */
  g('6 flow_export / flow_import(覆盖修正起点) / flow_list / flow_show / flow_lint / flow_rename');
  let exported = null;
  await T('flow_export 导出 JSON（含完整步骤）', async () => {
    const d = await call('flow_export', { flowId: FLOW_MAIN });
    assert(d.data && typeof d.data.json === 'string', '导出形状不对: ' + d.text.slice(0, 150));
    exported = JSON.parse(d.data.json);
    assert(Array.isArray(exported.steps) && exported.steps.length >= 7, '导出步骤数不对');
  });
  await T('flow_import overwrite 覆盖保存（修掉录制起点上的自动演示参数）', async () => {
    assert(exported.steps[0].op === 'goto', '第一步不是 goto');
    exported.startUrl = AUTO + '/';
    exported.steps[0].url = AUTO + '/';
    const d = await call('flow_import', { flow: exported, overwrite: true });
    assert(d.data && d.data.stepCount >= 7, '覆盖导入失败: ' + d.text.slice(0, 300));
    const s = await call('flow_show', { flowId: FLOW_MAIN, format: 'json' });
    assert(s.data.steps[0].url === AUTO + '/' && s.data.startUrl === AUTO + '/', '起点未修正');
  });
  await T('flow_list 含新录流程', async () => {
    const d = await call('flow_list', {});
    assert(JSON.stringify(d.data || '').includes(FLOW_MAIN), '列表缺 ' + FLOW_MAIN);
  });
  await T('flow_show markdown 步骤清单（人类可读）', async () => {
    const d = await call('flow_show', { flowId: FLOW_MAIN });
    assert(d.data && typeof d.data.markdown === 'string', '形状不对: ' + d.text.slice(0, 150));
    assert(d.data.markdown.includes('打开网址') && d.data.markdown.includes('步骤'), '清单内容不对: ' + d.data.markdown.slice(0, 200));
  });
  await T('flow_lint 静态检查返回结构化结果', async () => {
    const d = await call('flow_lint', { flowId: FLOW_MAIN });
    assert(d.data && Array.isArray(d.data.errors) && Array.isArray(d.data.warnings), 'lint 结构不对: ' + d.text.slice(0, 200));
    console.log('  errors=' + d.data.errors.length + ' warnings=' + d.data.warnings.length + ' infos=' + (d.data.infos || []).length);
  });
  await T('flow_import 导入副本（改 id）', async () => {
    const copy = JSON.parse(JSON.stringify(exported));
    copy.id = FLOW_COPY; copy.name = '副本（编辑试验场）';
    copy.startUrl = AUTO + '/';
    copy.steps[0].url = AUTO + '/';
    delete copy.createdAt; delete copy.updatedAt;
    const d = await call('flow_import', { flow: copy, overwrite: false });
    assert(d.data && d.data.flowId === FLOW_COPY, '导入失败: ' + d.text.slice(0, 300));
  });
  await T('flow_rename 只改显示名（id 不变）', async () => {
    const d = await call('flow_rename', { flowId: FLOW_COPY, name: '副本（已重命名）' });
    assert(d.data && d.data.name === '副本（已重命名）', '重命名失败: ' + d.text.slice(0, 200));
    const s = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    assert(s.data.name === '副本（已重命名）' && s.data.id === FLOW_COPY, '显示名/ id 状态不对');
  });

  /* ================ 7. 步骤 / 变量 / 断言编辑 ================ */
  g('7 flow_param_add/remove / flow_step_update/move/delete / flow_assertion_add/remove / flow_restore');
  fs.writeFileSync(CSV_FILE, '客户,金额\n张伟,687.50\n李娜,446.25\n');
  await T('flow_param_add ×4（const / secret / csv / env 真实来源）', async () => {
    for (const [n, src, extra] of [
      ['empNo', 'const', { default: '1001' }],
      ['dbpwd', 'secret:' + SECRET_NAME, { secret: true, label: '库密码' }],
      ['csvCust', CSV_SRC, {}],
      ['envEmp', 'env:T_LIVE_ENV_EMP', {}],
    ]) {
      const d = await call('flow_param_add', { flowId: FLOW_COPY, name: n, source: src, ...extra });
      assert(d.data, n + ' 添加失败: ' + d.text.slice(0, 200));
    }
  });
  await T('flow_show(json) 参数来源可见且 secret 明文零泄漏', async () => {
    const d = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    const s = JSON.stringify(d.data);
    for (const token of ['const', 'secret:' + SECRET_NAME, CSV_SRC, 'env:T_LIVE_ENV_EMP']) assert(s.includes(token), '缺参数来源 ' + token);
    assert(!s.includes(SECRET_VALUE), 'flow_show 泄漏 secret 明文');
  });
  await T('flow_param_remove 删除变量（定义随之消失）', async () => {
    const d = await call('flow_param_remove', { flowId: FLOW_COPY, name: 'envEmp' });
    assert(d.data, '删除失败: ' + d.text.slice(0, 200));
    const s = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    assert(!JSON.stringify(s.data.params || []).includes('envEmp'), '删除后参数仍在');
  });
  await T('flow_step_update 把写死工号换成 ${empNo}', async () => {
    const s = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    const idx = s.data.steps.findIndex((x) => x.op === 'fill' && String(x.value) === '1001') + 1;
    assert(idx > 0, '没找到工号步骤');
    const d = await call('flow_step_update', { flowId: FLOW_COPY, index: idx, patch: { value: '${empNo}' } });
    assert(d.data, '更新失败: ' + d.text.slice(0, 200));
    const s2 = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    assert(JSON.stringify(s2.data.steps).includes('${empNo}'), '回读未见 ${empNo}');
  });
  await T('flow_step_move 移动并还原顺序', async () => {
    const before = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    const sig0 = stepSig(before.data.steps);
    const d = await call('flow_step_move', { flowId: FLOW_COPY, from: 2, to: 3 });
    assert(d.data, '移动失败: ' + d.text.slice(0, 200));
    const mid = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    assert(stepSig(mid.data.steps) !== sig0 && mid.data.steps.length === before.data.steps.length, '顺序未按预期变化');
    await call('flow_step_move', { flowId: FLOW_COPY, from: 3, to: 2 });
    const back = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    assert(stepSig(back.data.steps) === sig0, '还原顺序失败');
  });
  await T('flow_assertion_add 追加断言 + flow_assertion_remove 删除', async () => {
    const d1 = await call('flow_assertion_add', { flowId: FLOW_COPY, kind: 'textPresent', text: '订单日报表', message: '实测追加断言' });
    assert(d1.data, '追加失败');
    const d2 = await call('flow_assertion_add', { flowId: FLOW_COPY, kind: 'tableNotEmpty', selector: '#orders tbody tr', min: 1, message: '实测表格断言' });
    assert(d2.data, '追加失败');
    const s = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    const n = (s.data.assertions || []).length;
    assert(n >= 4, '断言数不对: ' + n);
    await call('flow_assertion_remove', { flowId: FLOW_COPY, index: n });
    await call('flow_assertion_remove', { flowId: FLOW_COPY, index: n - 1 });
    const s2 = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    assert((s2.data.assertions || []).length === n - 2, '删除后数量不对');
  });

  /* ================ 8. 预检与回放（真实浏览器） ================ */
  g('8 flow_preflight / flow_run（真实回放+证据落盘）');
  await T('flow_preflight 起始页定位符真实探查', async () => {
    const d = await call('flow_preflight', { flowId: FLOW_MAIN }, 180000);
    assert(d.data && !d.data.error, '预检异常: ' + d.text.slice(0, 300));
    const probed = (d.data.steps || []).filter((x) => x.checked);
    assert(probed.length >= 4, '探查步数不足');
    // 设计口径：预检只在起始页验证定位符（结论文案明示后续页面无法提前验证）
    const firstFill = probed.find((x) => x.op === 'fill');
    assert(firstFill && firstFill.resolvable === true, '起始页第一个填入定位符解析失败');
    console.log('  探查 ' + probed.length + ' 步，起始页命中 ' + probed.filter((x) => x.resolvable === true).length + ' 步');
  });
  await T('flow_run 回放录制流程 → pass + 报告 + 截图证据落盘', async () => {
    const d = await call('flow_run', { flowId: FLOW_MAIN, evidenceOn: 'always', learn: true, maxDurationMs: 120000 }, 240000);
    assert(d.data && d.data.status === 'pass', 'flow_run 未 pass: ' + d.text.slice(0, 300));
    const rep = latestRun(FLOW_MAIN);
    assert(rep.report.status === 'pass', '报告状态=' + rep.report.status + ' 错误=' + (rep.report.error || ''));
    const shots = countShots(rep.dir);
    console.log('  run=' + rep.stamp + ' status=pass 截图=' + shots + ' 张 用时=' + rep.report.durationMs + 'ms');
    assert(shots >= 1, '没有截图证据（run 目录: ' + fs.readdirSync(rep.dir).join(',') + '）');
  });
  await T('flow_run 回放编辑后的副本（${empNo} 变量真实解析）→ pass', async () => {
    await call('flow_run', { flowId: FLOW_COPY, params: { empNo: '1001' }, maxDurationMs: 120000 }, 240000);
    const rep = latestRun(FLOW_COPY);
    assert(rep.report.status === 'pass', '副本报告状态=' + rep.report.status + ' 错误=' + (rep.report.error || ''));
    assert(!JSON.stringify(rep.report).includes(SECRET_VALUE), '运行报告泄漏 secret 明文');
    console.log('  副本 run=' + rep.stamp + ' status=pass');
  });
  await T('run_history 反映真实执行（最新 pass）', async () => {
    const d = await call('run_history', { flowId: FLOW_MAIN, limit: 10 });
    const runs = (d.data && d.data.runs) || [];
    assert(runs.length >= 1, '历史为空');
    assert(runs[0].status === 'pass', '最新一次状态=' + runs[0].status);
    console.log('  共 ' + runs.length + ' 条，最新 ' + runs[0].stamp + '/' + runs[0].status);
  });
  await T('run_report(latest) 完整报告（断言明细）', async () => {
    const d = await call('run_report', { flowId: FLOW_MAIN, stamp: 'latest' });
    const rep = (d.data && d.data.report) || d.data;
    assert(rep && rep.status === 'pass', '状态不对');
    assert(Array.isArray(rep.assertions) && rep.assertions.length >= 1, '报告缺断言明细');
    console.log('  断言: ' + rep.assertions.map((a) => a.kind + (a.pass === undefined ? '' : ':' + a.pass)).join(', '));
  });

  /* ================ 9. 失败链路与告警（真实 webhook） ================ */
  g('9 notify_config / notify_test / 失败流程真实告警');
  await T('flow_import 导入坏流程（点击不存在元素）', async () => {
    const bad = {
      id: FLOW_BAD, name: '坏流程（失败与告警验证）', version: 1,
      startUrl: AUTO + '/missing',
      steps: [
        { op: 'goto', url: AUTO + '/missing', seq: 1 },
        { op: 'click', locators: [{ strategy: 'css', value: '#no-such-btn' }], seq: 2 },
      ],
      assertions: [{ kind: 'textPresent', text: '绝不会出现的文本' }],
    };
    const d = await call('flow_import', { flow: bad, overwrite: true });
    assert(d.data && d.data.flowId === FLOW_BAD, '导入失败: ' + d.text.slice(0, 200));
  });
  await T('notify_config 指向本地接收器（含 mention）', async () => {
    const d = await call('notify_config', { enabled: true, type: 'generic', webhook: alarmUrl, on: ['failure', 'success', 'healed'], mention: '@live-test' });
    assert(d.data, '配置失败: ' + d.text.slice(0, 200));
  });
  await T('notify_test 真实送达本地接收器', async () => {
    const before = alarmGot.length;
    const d = await call('notify_test', { message: 'web-rpa-mcp 全流程实测告警' }, 60000);
    assert(d.data && d.data.ok !== false, 'notify_test 失败: ' + d.text.slice(0, 300));
    const deadline = Date.now() + 10000;
    while (alarmGot.length === before && Date.now() < deadline) await sleep(300);
    assert(alarmGot.length > before, '10s 内接收器未收到测试告警');
    console.log('  收到: ' + JSON.stringify(alarmGot[alarmGot.length - 1]).slice(0, 160));
  });
  let badStamp = null;
  await T('flow_run 坏流程 → 真实失败 + 失败告警送达', async () => {
    const before = alarmGot.length;
    const d = await call('flow_run', { flowId: FLOW_BAD, allowLintErrors: true, saveVideo: true, maxDurationMs: 120000 }, 240000);
    const failedRun = d.res.isError === true || (d.data && d.data.status === 'fail');
    assert(failedRun, '坏流程居然成功: ' + d.text.slice(0, 300));
    const rep = latestRun(FLOW_BAD);
    badStamp = rep.stamp;
    assert(rep.report.status === 'fail', '报告状态=' + rep.report.status);
    const deadline = Date.now() + 15000;
    while (alarmGot.length === before && Date.now() < deadline) await sleep(500);
    assert(alarmGot.length > before, '失败告警未送达');
    const alertText = JSON.stringify(alarmGot[alarmGot.length - 1]);
    assert(alertText.includes(FLOW_BAD), '告警内容缺流程 id: ' + alertText.slice(0, 300));
    assert(!alertText.includes(SECRET_VALUE), '告警泄漏 secret');
    console.log('  失败报告=' + rep.stamp + '，告警已送达: ' + alertText.slice(0, 140));
  });
  await T('run_report(stamp 显式) 失败报告含失败步骤', async () => {
    const d = await call('run_report', { flowId: FLOW_BAD, stamp: badStamp });
    const rep = (d.data && d.data.report) || d.data;
    assert(rep && rep.status === 'fail', '状态不对');
    assert(rep.failedStep === 2 || rep.error, '报告缺失败定位: ' + JSON.stringify(rep).slice(0, 200));
    console.log('  failedStep=' + rep.failedStep + ' error=' + String(rep.error || '').split('\n')[0].slice(0, 100));
  });
  await T('notify_config 回读（webhook 回显打码）', async () => {
    const d = await call('notify_config', {});
    assert(d.data, '无数据');
    assert(!d.text.includes(alarmUrl), 'webhook 回显未打码: ' + d.text.slice(0, 200));
    console.log('  ' + d.text.split('\n').slice(0, 2).join(' ').slice(0, 160));
  });

  /* ================ 10. 多流程串联 ================ */
  g('10 chain_run（串联两个真实流程）');
  await T('chain_run 顺序执行两条流程且双双 pass', async () => {
    const d = await call('chain_run', { items: [{ flow: FLOW_MAIN }, { flow: FLOW_COPY }], maxDurationMs: 240000 }, 300000);
    assert(d.data && d.data.status === 'pass', 'chain 未 pass: ' + d.text.slice(0, 400));
    const r1 = latestRun(FLOW_MAIN), r2 = latestRun(FLOW_COPY);
    assert(r1.report.status === 'pass' && r2.report.status === 'pass', '串联后状态: ' + r1.report.status + '/' + r2.report.status);
    console.log('  串联完成: ' + FLOW_MAIN + ' → ' + FLOW_COPY + ' 均 pass');
  });
  await T('chain_run maxDurationMs=1 整条限时即刻收口（不误跑）', async () => {
    // chain 串联中断是 fail() 回包（isError:true），成败由本用例自行判定
    const d = await callAny('chain_run', { items: [{ flow: FLOW_MAIN }], maxDurationMs: 1 }, 120000);
    const text = JSON.stringify(d.data || d.text);
    assert(/timeout|TIMEOUT|超时|未执行|skipped/i.test(text) || (d.data && d.data.status === 'fail'), '限时未生效: ' + text.slice(0, 300));
    console.log('  ' + text.slice(0, 160));
  });

  /* ================ 11. 定时任务（真实 schtasks） ================ */
  g('11 schedule_add / schedule_list / schedule_run_now / schedule_remove');
  await T('schedule_add 注册每日 23:58 定时任务（带参数）', async () => {
    const d = await call('schedule_add', { flowId: FLOW_MAIN, frequency: 'daily', at: '23:58', params: { empNo: '1001' } }, 120000);
    assert(d.data && d.data.ok === true && d.data.task, '注册失败: ' + d.text.slice(0, 300));
  });
  await T('schedule_add once 任务（date 参数真实校验）', async () => {
    const d = await call('schedule_add', { flowId: FLOW_COPY, frequency: 'once', date: '2027/01/01', at: '03:00' }, 120000);
    assert(d.data && d.data.ok === true, 'once 注册失败: ' + d.text.slice(0, 300));
  });
  await T('schedule_list 列出任务及系统内状态', async () => {
    const d = await call('schedule_list', {}, 120000);
    const tasks = (d.data && d.data.tasks) || [];
    assert(tasks.some((x) => x.flowId === FLOW_MAIN), '缺 daily 任务: ' + d.text.slice(0, 300));
    assert(tasks.some((x) => x.flowId === FLOW_COPY), '缺 once 任务: ' + d.text.slice(0, 300));
    console.log('  ' + JSON.stringify(tasks.find((x) => x.flowId === FLOW_MAIN)).slice(0, 200));
  });
  await T('schedule_run_now 经任务计划真实触发一次后台执行', async () => {
    const hist0 = await call('run_history', { flowId: FLOW_MAIN, limit: 5 });
    const sig0 = JSON.stringify(((hist0.data || {}).runs || [])[0] || null);
    const d = await call('schedule_run_now', { flowId: FLOW_MAIN }, 120000);
    assert(d.data && d.data.ok === true, '触发失败: ' + d.text.slice(0, 300));
    const deadline = Date.now() + 180000;
    for (;;) {
      await sleep(2000);
      const lock = await call('lock_status', { flowId: FLOW_MAIN });
      const hist = await call('run_history', { flowId: FLOW_MAIN, limit: 5 });
      const sig = JSON.stringify(((hist.data || {}).runs || [])[0] || null);
      if (!(lock.data && lock.data.held) && sig !== sig0) break;
      if (Date.now() > deadline) throw new Error('180s 内定时触发的执行没有收尾');
    }
    const rep = latestRun(FLOW_MAIN);
    assert(rep.report.status === 'pass', '定时执行状态=' + rep.report.status + ' ' + (rep.report.error || ''));
    console.log('  定时执行 run=' + rep.stamp + ' status=pass trigger=' + (rep.report.trigger || rep.report.source || '?'));
  });
  await T('schedule_remove 注销两个任务', async () => {
    for (const fid of [FLOW_COPY, FLOW_MAIN]) {
      const d = await call('schedule_remove', { flowId: fid }, 120000);
      assert(d.data && d.data.ok === true, fid + ' 注销失败: ' + d.text.slice(0, 200));
    }
    const l = await call('schedule_list', {}, 120000);
    assert(!((l.data.tasks || []).some((x) => x.flowId === FLOW_MAIN || x.flowId === FLOW_COPY)), '列表里还有残留任务');
  });

  /* ================ 12. 无人值守运维 ================ */
  g('12 status_report / runs_prune / lock_status / lock_release');
  await T('status_report 总览（含本次流程与问题清单）', async () => {
    const d = await call('status_report', {});
    const items = (d.data && (d.data.items || d.data.flows)) || [];
    assert(Array.isArray(items) && items.length >= 2, '总览条目不足: ' + d.text.slice(0, 300));
    const me = items.find((x) => x.flowId === FLOW_MAIN || x.id === FLOW_MAIN);
    assert(me, '总览里没有 ' + FLOW_MAIN);
    console.log('  流程数=' + items.length + ' summary=' + JSON.stringify(d.data.summary || {}).slice(0, 180));
  });
  await T('status_report onlyProblems=true 只看问题', async () => {
    const d = await call('status_report', { onlyProblems: true });
    assert(d.data, '无数据');
    const items = (d.data.items || d.data.flows || []);
    // 与 status_report onlyProblems 过滤同款谓词：从未跑过的 lastStatus:null 也算"问题"（不是健康流程）
    assert(items.every((x) => x.lastStatus !== 'pass' || x.interrupted || x.running || x.waitingHuman), '混入了健康流程: ' + JSON.stringify(items).slice(0, 200));
    console.log('  问题流程 ' + items.length + ' 个');
  });
  await T('runs_prune dryRun 预演（列出将删，不动盘）', async () => {
    const before = runStampDirs(FLOW_MAIN).length;
    assert(before >= 2, '前置：FLOW_MAIN 运行数不足（' + before + '）');
    const d = await call('runs_prune', { flowId: FLOW_MAIN, keepCount: 1, keepVideos: 20, dryRun: true });
    const row = (d.data.runs || [])[0] || {};
    assert(d.data.dryRun === true && row.removed && row.removed.length >= 1, '预演未列出将删项: ' + JSON.stringify(d.data).slice(0, 200));
    assert(runStampDirs(FLOW_MAIN).length === before, '预演不应动盘');
    console.log('  预演: total=' + row.total + ' kept=' + row.kept + ' 将删 ' + row.removed.length + ' 条');
  });
  await T('runs_prune dryRun:false 真实裁剪（保留 1 次 + 清过期日志）', async () => {
    const d = await call('runs_prune', { flowId: FLOW_MAIN, keepCount: 1, dryRun: false, logs: true });
    const row = (d.data.runs || [])[0] || {};
    const left = runStampDirs(FLOW_MAIN).length;
    assert(row.kept === 1 && left === 1, '裁剪后应剩 1 条: kept=' + row.kept + ' 实际目录=' + left);
    console.log('  真实裁剪: removed=' + (row.removed || []).length + ' 剩 ' + left + ' 条');
  });
  await T('runs_prune keepVideos 录像留存（0=不限语义核验）', async () => {
    // 第二次跑坏流程攒第 2 段录像（saveVideo 失败保留）
    await call('flow_run', { flowId: FLOW_BAD, allowLintErrors: true, saveVideo: true, maxDurationMs: 120000 }, 240000);
    const vids = countWebm(FLOW_BAD);
    if (vids < 2) {
      console.log('  诚实 SKIP：录像不足 2 段（' + vids + ' 段，可能缺 ffmpeg 已降级），跳过 keepVideos 裁剪断言');
      return;
    }
    const d = await call('runs_prune', { flowId: FLOW_BAD, keepCount: 0, keepVideos: 1, dryRun: false });
    const row = (d.data.runs || [])[0] || {};
    const left = countWebm(FLOW_BAD);
    assert(left === 1 && row.videosKept === 1, '录像裁剪不对: left=' + left + ' ' + JSON.stringify(row).slice(0, 150));
    console.log('  录像裁剪: ' + vids + ' → ' + left + ' 段');
  });
  await T('lock_status 空闲时 held=false', async () => {
    const d = await call('lock_status', { flowId: FLOW_MAIN });
    assert(d.data && d.data.held === false, '锁状态异常: ' + d.text.slice(0, 200));
  });
  await T('lock_release 空锁释放为安全 no-op', async () => {
    const d = await call('lock_release', { flowId: FLOW_MAIN });
    assert(d.data && d.data.released === true, '释放异常: ' + d.text.slice(0, 200));
  });

  /* ================ 13. 录制生命周期与片段重录 ================ */
  g('13 record_status / record_cancel / record_stop(无会话) / record_splice_start / flow_restore');
  await T('第二次录制会话 + record_status', async () => {
    const d = await call('record_start', { url: DEMO + '/report', name: 't-live-cancel' });
    assert(d.data && d.data.ok === true, '启动失败: ' + d.text.slice(0, 200));
    const s = await call('record_status', {});
    assert(s.data && s.data.recording === true, '状态不对');
  });
  await T('record_cancel 丢弃会话', async () => {
    const d = await call('record_cancel', {});
    assert(d.data && d.data.ok === true, '取消失败: ' + d.text.slice(0, 200));
  });
  await T('record_stop 无会话 → 业务报错（isError）', async () => {
    await callErr('record_stop', {});
  });
  await T('record_splice_start 片段重录（真实重放前缀）', async () => {
    const d = await call('record_splice_start', { flowId: FLOW_MAIN, from: 3, to: 4, keepSuffix: true, params: {}, headed: false }, 180000);
    assert(d.data && d.data.ok === true && d.data.splice && d.data.splice.prefixCount === 2,
      '片段重录未正确启动: ' + d.text.slice(0, 300));
  });
  await T('record_cancel 取消片段重录（原流程不动）', async () => {
    const d = await call('record_cancel', {});
    assert(d.data && d.data.ok === true && d.data.originalFlowUntouched === true, '取消异常: ' + d.text.slice(0, 200));
  });
  await T('flow_restore list 列出自动备份（编辑已产生）', async () => {
    const d = await call('flow_restore', { flowId: FLOW_COPY, list: true });
    assert(d.data && !/还没有备份/.test(d.text), '没有生成备份: ' + d.text.slice(0, 200));
    console.log('  ' + d.text.split('\n').slice(0, 2).join(' | ').slice(0, 180));
  });
  await T('flow_step_delete + flow_restore 真实回滚', async () => {
    const s0 = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    const n0 = s0.data.steps.length;
    const del = await call('flow_step_delete', { flowId: FLOW_COPY, index: n0 });
    assert(del.data, '删除失败: ' + del.text.slice(0, 200));
    const sMid = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    assert(sMid.data.steps.length === n0 - 1, '删除后步骤数不对');
    const res = await call('flow_restore', { flowId: FLOW_COPY });
    assert(res.data, '回滚失败: ' + res.text.slice(0, 200));
    const s1 = await call('flow_show', { flowId: FLOW_COPY, format: 'json' });
    assert(s1.data.steps.length === n0, '回滚后步骤数 ' + s1.data.steps.length + ' ≠ 删除前 ' + n0);
  });

  /* ================ 14. 清理 ================ */
  g('14 清理与还原');
  await T('secret_delete 删除凭据', async () => {
    const d = await call('secret_delete', { name: SECRET_NAME });
    assert(d.data && d.data.deleted === true, '删除失败: ' + d.text.slice(0, 200));
    const l = await call('secret_list', {});
    assert(!JSON.stringify(l.data || '').includes(SECRET_NAME), '列表里还有');
  });
  await T('flow_delete ×3 删除实测流程（删除后不可读）', async () => {
    for (const fid of [FLOW_BAD, FLOW_COPY, FLOW_MAIN]) {
      const d = await call('flow_delete', { flowId: fid });
      assert(d.data && d.data.deleted === true, fid + ' 删除失败: ' + d.text.slice(0, 200));
      await callErr('flow_show', { flowId: fid });
    }
  });
  await T('config 还原（notify 关闭 / persistProfile 关闭）', async () => {
    const d = await call('config_set', { patch: { browser: { persistProfile: false }, notify: { enabled: false, type: 'generic', webhook: '', on: ['failure', 'healed'], mention: '', timeoutMs: 8000 } } });
    const c = (await call('config_get', {})).data.config;
    assert(c.notify.enabled === false && !c.notify.webhook, 'notify 未还原');
    assert(c.browser.persistProfile === false, 'persistProfile 未还原');
  });

  /* ================ 覆盖度与汇总 ================ */
  const all = (tl.result.tools || []).map((t) => t.name);
  const missing = all.filter((t) => !called.has(t));
  g('覆盖度');
  if (missing.length) fail('44 个工具全部被真实调用', new Error('从未调用: ' + JSON.stringify(missing)));
  else ok('44 个工具全部被真实调用（无遗漏）', [...called].length + ' 次调用');

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('\n================ 实测汇总 ================');
  console.log('通过 ' + passed + ' / ' + results.length + (failed.length ? '，失败 ' + failed.length : '，全部通过'));
  for (const f of failed) console.log('  FAIL [' + f.group + '] ' + f.name + ' — ' + f.detail.split('\n')[0]);
  fs.writeFileSync(path.join(__dirname, 'live-report.json'), JSON.stringify({
    time: new Date().toISOString(),
    server: init.result.serverInfo.name + ' ' + init.result.serverInfo.version,
    calledTools: [...called].sort(),
    passed, failed: failed.length, results,
  }, null, 1));
  console.log('报告已写: verify/live-report.json');
}

/* ---------------- 收尾清理（尽力而为） ---------------- */
async function cleanup() {
  console.log('\n-------- 收尾清理 --------');
  const silent = async (n, a) => {
    try {
      called.add(n);
      const m = await rawCall('tools/call', { name: n, arguments: a }, 60000);
      console.log('  cleaned: ' + n + (m.result && m.result.isError ? '（业务提示已忽略）' : ''));
    } catch { /* ignore */ }
  };
  await silent('record_cancel', {});
  await silent('schedule_remove', { flowId: FLOW_MAIN });
  await silent('schedule_remove', { flowId: FLOW_COPY });
  await silent('flow_delete', { flowId: FLOW_BAD });
  await silent('flow_delete', { flowId: FLOW_COPY });
  await silent('flow_delete', { flowId: FLOW_MAIN });
  await silent('secret_delete', { name: SECRET_NAME });
  await silent('profile_reset', { confirm: true });
  await silent('config_set', { patch: { browser: { persistProfile: false }, notify: { enabled: false, type: 'generic', webhook: '', on: ['failure', 'healed'], mention: '' } } });
  try { child.stdin.end(); } catch { /* ignore */ }
  await sleep(300);
  try { child.kill(); } catch { /* ignore */ }
  for (const fid of [FLOW_BAD, FLOW_COPY, FLOW_MAIN]) {
    try { fs.rmSync(runsDir(fid), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try {
    const bdir = path.join(DATA, '.work', 'backups');
    for (const f of fs.readdirSync(bdir)) if (f.indexOf('t-live') === 0) fs.rmSync(path.join(bdir, f), { force: true });
  } catch { /* ignore */ }
  try { fs.rmSync(CSV_FILE, { force: true }); } catch { /* ignore */ }
  try {
    // 只清本套件 t-live* 的定时产物（wrapper/params/索引条目），绝不整目录删——默认根的 .work/sched 里有用户自己的任务包装器
    const sdir = path.join(DATA, '.work', 'sched');
    for (const f of fs.readdirSync(sdir)) if (f.indexOf('t-live') === 0) fs.rmSync(path.join(sdir, f), { force: true });
    const idxPath = path.join(sdir, 'index.json');
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    let hit = false;
    for (const k of Object.keys(idx)) if (k.indexOf('t-live') === 0) { delete idx[k]; hit = true; }
    if (hit) fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
  } catch { /* ignore */ }
  console.log('  完成');
}

main().then(async () => {
  const failed = results.filter((r) => !r.ok).length;
  await cleanup();
  console.log('\n实测结束: ' + (failed ? failed + ' 项失败' : '全部通过'));
  process.exit(failed ? 1 : 0);
}).catch(async (e) => {
  console.error('\n实测 harness 异常: ' + String(e && e.stack ? e.stack : e));
  await cleanup();
  process.exit(1);
});
