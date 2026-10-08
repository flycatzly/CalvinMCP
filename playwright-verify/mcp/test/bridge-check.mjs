/**
 * bridge-check.mjs — 浏览器插件本地桥的行为钉
 *
 * 这座桥是「浏览器插件 ↔ MCP 工具」的唯一通道，所以它错不起两件事：
 *   1) **通道不失真**：/rpc 打穿到 handleMessage，错误码/通知语义/批量与 stdio 一致 ——
 *      通道若各写一份实现，两边行为漂移是静默的；
 *   2) **边界不松**：只回环、挡 DNS rebinding（Host）、挡网页来源（Origin）、
 *      可选口令、脱敏（参数值永不进日志）—— 本机工具被「顺手暴露」成远程后端
 *      是这类桥最常见的事故形态，守门必须有钉。
 *
 * 钉的风格沿用全仓约定：真 HTTP 打真服务（不 mock），每条钉可独立变红；
 * 负向咬合（故意回退实现验钉变红）在改代码时人工执行，不在本文件里常驻。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startBridge, MAX_BODY, tokenMatches, guard } from '../bridge.mjs';
import { TOOLS, VERSION } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const LOOPBACK = '127.0.0.1';

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

const rpc = (base, msg, headers = {}) => fetch(`${base}/rpc`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof msg === 'string' ? msg : JSON.stringify(msg),
});
const j = (id, method, params) => ({ jsonrpc: '2.0', id, method, params: params || {} });

/* ================= 启动与健康 ================= */
const bridge = await startBridge({ port: 0 });
check('桥监听回环地址且拿到真实端口（127.0.0.1 不对外暴露）',
  bridge.address === '127.0.0.1' && bridge.port > 0 && bridge.url === `http://127.0.0.1:${bridge.port}`,
  `${bridge.url}`);

const health = await (await fetch(`${bridge.url}/health`)).json();
check('GET /health：ok、版本与 package.json 单一源一致、工具数与 TOOLS 同步',
  health.ok === true && health.version === VERSION && health.tools === TOOLS.length,
  `v${health.version} / ${health.tools} 个工具`);

const hKeys = Object.keys(health).sort().join(',');
check('GET /health 只回元数据（ok/name/version/protocol/tools，无凭据无参数）',
  hKeys === 'name,ok,protocol,tools,version', hKeys);

/* ================= JSON-RPC 通道（打穿到 handleMessage） ================= */
const initRes = await (await rpc(bridge.url, j(1, 'initialize', {
  protocolVersion: '2025-11-25', clientInfo: { name: 'bridge-check', version: '0' }, capabilities: {},
}))).json();
check('initialize 握手：serverInfo 与协议版本协商回显（与 stdio 同一处理器）',
  initRes.result?.serverInfo?.name === 'playwright-verify'
  && initRes.result?.serverInfo?.version === VERSION
  && initRes.result?.protocolVersion === '2025-11-25');

const listRes = await (await rpc(bridge.url, j(2, 'tools/list'))).json();
const tools = listRes.result?.tools || [];
check('tools/list：全部工具可达且个个带 inputSchema（不维护第二份工具清单）',
  tools.length === TOOLS.length && tools.every((t) => t.name && t.inputSchema),
  `${tools.length} 个工具`);

const callRes = await (await rpc(bridge.url, j(3, 'tools/call', { name: 'explain_rules', arguments: { group: 'lint' } }))).json();
check('tools/call 打穿到真 handler：explain_rules 有文本结果且非 isError',
  callRes.result && !callRes.result.isError
  && Array.isArray(callRes.result.content)
  && callRes.result.content.some((c) => c.type === 'text' && c.text.trim()),
  `content ${callRes.result?.content?.length ?? 0} 块`);

const unknownRes = await (await rpc(bridge.url, j(4, 'tools/call', { name: 'no_such_tool', arguments: {} }))).json();
check('未知工具 → JSON-RPC 错误 -32602（不静默成功）', unknownRes.error?.code === -32602);

const noNameRes = await (await rpc(bridge.url, j(5, 'tools/call', { arguments: {} }))).json();
check('tools/call 缺 name → -32602 且带 available 列表',
  noNameRes.error?.code === -32602 && Array.isArray(noNameRes.error?.data?.available));

const badJsonRes = await rpc(bridge.url, '{ 这不是 JSON');
const badJsonBody = await badJsonRes.json();
check('非法 JSON 请求体 → HTTP 400 + JSON-RPC -32700、id:null',
  badJsonRes.status === 400 && badJsonBody.error?.code === -32700 && badJsonBody.id === null);

const notifRes = await rpc(bridge.url, { jsonrpc: '2.0', method: 'ping' });
check('通知（无 id）→ 204 无响应体（通知语义不被 HTTP 层破坏）',
  notifRes.status === 204 && (await notifRes.text()) === '');

const batchRes = await (await rpc(bridge.url, [j(10, 'ping'), j(11, 'tools/list')])).json();
check('批量请求 → 响应数组且 id 逐条对应',
  Array.isArray(batchRes) && batchRes.length === 2
  && batchRes.some((r) => r.id === 10) && batchRes.some((r) => r.id === 11));

const batchNotifRes = await rpc(bridge.url, [{ jsonrpc: '2.0', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
check('批量全通知 → 204（没有该回的消息就不回）',
  batchNotifRes.status === 204 && (await batchNotifRes.text()) === '');

const notFoundRes = await fetch(`${bridge.url}/nope`);
check('未知路径 → 404 且列出可用路由', notFoundRes.status === 404 && (await notFoundRes.json()).routes?.length === 2);

const wrongMethodRes = await fetch(`${bridge.url}/rpc`, { method: 'GET' });
check('GET /rpc → 405（rpc 只收 POST）', wrongMethodRes.status === 405);

/* ================= 守门（安全红线） ================= */
/** 原生 http.request 打一发「伪造 Host 头」请求 —— fetch 的受限头不允许覆盖 Host，
 *  用它测等于没测（守门钉必须真的把 Host 头送进服务端）。 */
const fakeHostStatus = await new Promise((resolve) => {
  const req = http.request({
    hostname: LOOPBACK, port: bridge.port, path: '/health', method: 'GET',
    headers: { host: 'evil.example' },
  }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(0));
  req.end();
});
check('Host 头不是本机名 → 403（挡 DNS rebinding）', fakeHostStatus === 403, `HTTP ${fakeHostStatus}`);

const evilOriginRes = await rpc(bridge.url, j(20, 'ping'), { origin: 'https://evil.example' });
check('网页来源 Origin → 403（不给恶网页一条本机后端通道）', evilOriginRes.status === 403);

const extOriginRes = await rpc(bridge.url, j(21, 'ping'), { origin: 'chrome-extension://abcdefghijklmnop' });
check('浏览器扩展来源 Origin → 放行（真插件形态）', extOriginRes.status === 200);

const guarded = await startBridge({ port: 0, token: 'bridge-secret-a1b2' });
const noTokenRes = await rpc(guarded.url, j(22, 'ping'));
check('设口令后无 x-bridge-token → 401', noTokenRes.status === 401);

const guardedHealth = await fetch(`${guarded.url}/health`);
check('设口令后 /health 探活仍不需口令（探活不该被门禁挡住）', guardedHealth.status === 200);

const goodTokenRes = await rpc(guarded.url, j(23, 'ping'), { 'x-bridge-token': 'bridge-secret-a1b2' });
check('带正确口令 → 放行', goodTokenRes.status === 200);

const wrongTokenRes = await rpc(guarded.url, j(24, 'ping'), { 'x-bridge-token': 'bridge-secret-a1b3' });
check('近似口令（差 1 字符）→ 401（逐字符比较不被前缀骗过）', wrongTokenRes.status === 401);
await guarded.close();

check('口令比较纯函数：长度不同/空串/等长差一 一律不相等',
  !tokenMatches('abc', 'abcd') && !tokenMatches('', '') && !tokenMatches('abc', 'abd') && tokenMatches('abc', 'abc'));

check('守门纯函数：本机 Host + 扩展 Origin 放行，外部 Origin 拒绝',
  guard({ headers: { host: '127.0.0.1:7395', origin: 'chrome-extension://x' } }, '') === null
  && (guard({ headers: { host: 'evil.example' } }, '') || {}).status === 403
  && (guard({ headers: { host: 'localhost:1', origin: 'https://x.example' } }, '') || {}).status === 403);

const preflightRes = await fetch(`${bridge.url}/rpc`, {
  method: 'OPTIONS',
  headers: { origin: 'chrome-extension://abcdefghijklmnop', 'access-control-request-method': 'POST' },
});
const allowHeaders = String(preflightRes.headers.get('access-control-allow-headers') || '');
check('OPTIONS 预检 → 204 且 Allow-Headers 含 x-bridge-token',
  preflightRes.status === 204 && allowHeaders.includes('x-bridge-token'), allowHeaders);

// 超限请求体用原生 http 打：服务端会在上传中途回 413 并排空，
// fetch 对「响应早于请求体发完」会抛连接错 —— 那是客户端行为，不是服务端判定，
// 钉要测的是服务端回什么状态码。
const bigBody = 'a'.repeat(MAX_BODY + 512);
const bigStatus = await new Promise((resolve) => {
  const req = http.request({
    hostname: LOOPBACK, port: bridge.port, path: '/rpc', method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(bigBody),
    },
  }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(-1));
  req.end(bigBody);
});
check('超过 4MB 请求体 → 413（不给内存放大器开口）', bigStatus === 413, `HTTP ${bigStatus}`);

/* ================= 串行队列 ================= */
const concurrent = await Promise.all([
  rpc(bridge.url, j(30, 'tools/call', { name: 'explain_rules', arguments: { group: 'config' } })),
  rpc(bridge.url, j(31, 'tools/call', { name: 'explain_rules', arguments: { group: 'category' } })),
  rpc(bridge.url, j(32, 'tools/call', { name: 'explain_rules', arguments: { group: 'all' } })),
]);
const concurrentBodies = await Promise.all(concurrent.map((r) => r.json()));
check('并发 3 个 tools/call 全部完成且 id 各归各（串行队列不失位）',
  concurrentBodies.length === 3
  && concurrentBodies.every((b) => b.result && !b.result.isError)
  && new Set(concurrentBodies.map((b) => b.id)).size === 3);

/* ================= CLI 真实启动 + 脱敏哨兵 ================= */
const SENTINEL = 'SENTINEL-a7f3e9d2-secret-arg';
const child = spawn(process.execPath, [path.join('mcp', 'bridge.mjs'), '--port', '0'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
let childErr = '';
child.stdout.on('data', (c) => { childOut += c.toString('utf8'); });
child.stderr.on('data', (c) => { childErr += c.toString('utf8'); });
const childUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('桥 CLI 启动超时')), 15_000);
  const tick = setInterval(() => {
    const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(childOut);
    if (m) { clearInterval(tick); clearTimeout(t); resolve(m[1]); }
    if (child.exitCode !== null) { clearInterval(tick); clearTimeout(t); reject(new Error(`桥 CLI 提前退出 ${child.exitCode}：${childErr}`)); }
  }, 50);
});

check('CLI 真实启动：启动行打出监听地址（isMainModule 真路径可用）',
  typeof childUrl === 'string' && childUrl.startsWith('http://127.0.0.1:'), childUrl);

// 哨兵：参数值经 tools/call 真打进去，日志里一个字节都不许出现（脱敏红线）
await rpc(childUrl, j(40, 'tools/call', {
  name: 'explain_rules', arguments: { group: SENTINEL },
}));
await new Promise((r) => setTimeout(r, 300));
check('脱敏哨兵：参数值不进观测日志（stderr 只记方法/工具名/耗时/状态）',
  !childOut.includes(SENTINEL) && !childErr.includes(SENTINEL) && childErr.includes('explain_rules'),
  `stderr ${childErr.split('\n').filter(Boolean).length} 行`);

child.kill();
await new Promise((r) => child.once('exit', r));
// 被信号杀掉时退出码是 null、信号码在案 —— 两个字段任一非空都算「进程真没了」
check('桥可退出（SIGTERM 后进程结束，不留孤儿）',
  child.exitCode !== null || child.signalCode !== null,
  `exit=${child.exitCode} signal=${child.signalCode}`);

/* ================= 浏览器插件形态 ================= */
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
check('manifest 是 MV3 且 host_permissions 只圈本机（127.0.0.1 / localhost）',
  manifest.manifest_version === 3
  && Array.isArray(manifest.host_permissions)
  && manifest.host_permissions.includes('http://127.0.0.1/*')
  && manifest.host_permissions.includes('http://localhost/*')
  && manifest.host_permissions.length === 2,
  (manifest.host_permissions || []).join(', '));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('manifest.version 与 package.json 单一源同步（版本不漂移到插件里）',
  manifest.version === pkg.version, `v${manifest.version}`);

const panelJs = fs.readFileSync(path.join(ROOT, 'extension', 'panel.js'), 'utf8');
check('面板走 JSON-RPC 通道：tools/list 拉清单 + tools/call 打真调用',
  panelJs.includes("rpc('tools/list'") && panelJs.includes("rpc('tools/call'"));

check('面板表单 schema 驱动（inputSchema 生成表单，服务端加工具自动出现）',
  panelJs.includes('inputSchema') && panelJs.includes('renderForm'));

check('面板口令只走本机请求头且存本地（不外发）',
  panelJs.includes('x-bridge-token') && !/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(panelJs.replace(/https?:\/\/127\.0\.0\.1/g, '')));

/* ================= 面板结构化结果可视化（r40） ================= */
{
  const vm = await import('node:vm');
  const permissiveEl = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, className: '', children: [],
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return permissiveEl(); }, querySelectorAll() { return []; },
  });
  const els = {};
  const sandbox = {
    document: {
      getElementById(id) { if (!els[id]) els[id] = permissiveEl(); return els[id]; },
      createElement() { return permissiveEl(); },
      createTextNode(t) { return { textContent: t }; },
      addEventListener() {},
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ result: { tools: [{ name: 't1', inputSchema: { properties: {} } }], serverInfo: { name: 'stub', version: '0' } } }),
    }),
    console,
  };
  vm.createContext(sandbox);
  const panelSrc = fs.readFileSync(path.join(ROOT, 'extension', 'panel.js'), 'utf8');
  let panelLoaded = true;
  try { vm.runInContext(panelSrc, sandbox, { filename: 'panel.js' }); } catch { panelLoaded = false; }
  check('面板 vm 加载成功且暴露结构化视图模型纯函数',
    panelLoaded && typeof sandbox.pvStructuredModel === 'function' && typeof sandbox.pvCellText === 'function');
  const model = sandbox.pvStructuredModel;
  check('视图模型：对象 → kv 节点（键全覆盖）', (() => {
    const m = model({ verdict: 'Pass', total: 3 }, 0);
    return m.length === 2 && m[0].kind === 'kv' && m[0].key === 'verdict' && m[0].value === 'Pass' && m[1].key === 'total';
  })());
  check('视图模型：对象数组 → 表格（列并集、行帽 20、total 诚实）', (() => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i, name: '行' + i }));
    const m = model(rows, 0);
    return m.length === 1 && m[0].kind === 'table' && m[0].columns.join(',') === 'id,name'
      && m[0].rows.length === 20 && m[0].total === 30;
  })());
  check('视图模型：深度帽 3（深层降级 line，不无限递归）', (() => {
    const m = model({ a: { b: { c: { d: { e: 1 } } } } }, 0);
    return JSON.stringify(m).includes('"kind":"line"');
  })());
  check('视图模型：空数组 → 诚实空态', model([], 0)[0].text === '（空数组）');
  check('XSS 面：恶意载荷原样保真进模型；渲染函数只用 textContent（数据不经 innerHTML）', (() => {
    const fnBody = panelSrc.slice(panelSrc.indexOf('function pvRenderModelInto'), panelSrc.indexOf('globalThis.pvStructuredModel'));
    return sandbox.pvCellText('<img src=x onerror=alert(1)>') === '<img src=x onerror=alert(1)>'
      && fnBody.includes('textContent') && !fnBody.includes('innerHTML');
  })());
  check('renderResult 行为：structuredContent 渲成 kv/table 节点（不再整块 JSON 倾倒）', (() => {
    if (!panelLoaded) return false;
    const rr = vm.runInContext('typeof renderResult === "function" ? renderResult : null', sandbox);
    if (!rr) return false;
    rr({ content: [{ type: 'text', text: 'ok' }], structuredContent: { runs: [{ a: 1 }, { b: 2 }] } }, 5);
    const box = els.resultStructured;
    return !!box && box.children.length >= 1
      && box.children.some((c) => c.className === 'sc-table')
      && !String(box.textContent || '').trim().startsWith('{');
  })());
  check('renderResult 行为：无 structuredContent → 结构化箱隐藏（可选字段不伪造）', (() => {
    if (!panelLoaded) return false;
    const rr = vm.runInContext('typeof renderResult === "function" ? renderResult : null', sandbox);
    if (!rr) return false;
    rr({ content: [{ type: 'text', text: 'plain' }] }, 3);
    return els.structuredBox.hidden === true;
  })());
}

/* ================= r49：插拔式双模 + 配置键统一（面板 vm 行为面） ================= */
{
  const vm = await import('node:vm');
  const mkPanelEnv = (seedStorage) => {
    const els = {};
    const fetchLog = [];
    const makeEl = (id) => {
      const el = {
        _id: id, style: {}, value: '', textContent: '', innerHTML: '', hidden: false,
        disabled: false, className: '', children: [], _on: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener(type, fn) { (this._on[type] = this._on[type] || []).push(fn); },
        removeEventListener() {},
        appendChild(c) { this.children.push(c); return c; },
        setAttribute() {}, getAttribute() { return null; },
        querySelector() { return makeEl(id + '.q'); }, querySelectorAll() { return []; },
        dispatch(type) { (this._on[type] || []).forEach((fn) => fn({ type, target: this })); },
      };
      return el;
    };
    const storageData = Object.assign({}, seedStorage || {});
    const sandbox = {
      document: {
        getElementById(id) { if (!els[id]) els[id] = makeEl(id); return els[id]; },
        createElement() { return makeEl('dyn'); },
        createTextNode(t) { return { textContent: t }; },
        addEventListener() {},
      },
      fetch: async (url, opts) => {
        fetchLog.push({ url: String(url), body: opts && opts.body ? String(opts.body) : '' });
        return { ok: true, json: async () => ({ result: { tools: [{ name: 't1', inputSchema: { properties: {} } }], serverInfo: { name: 'stub', version: '0' } } }) };
      },
      chrome: {
        storage: { local: {
          async get(keys) { const o = {}; [].concat(keys).forEach((k) => { if (storageData[k] !== undefined) o[k] = storageData[k]; }); return o; },
          async set(obj) { Object.assign(storageData, obj); },
        } },
        runtime: { getManifest: () => ({ version: '9.9.9-test' }) },
      },
      console,
    };
    vm.createContext(sandbox);
    let loaded = true;
    try { vm.runInContext(panelJs, sandbox, { filename: 'panel.js' }); } catch (e) { loaded = false; sandbox._err = e.message; }
    return { els, sandbox, storageData, fetchLog, loaded };
  };
  const settle = () => new Promise((r) => setTimeout(r, 40));

  const em = mkPanelEnv({ pv_base: 'http://127.0.0.1:7395', pv_token: '' });
  await settle();
  check('面板双模：默认 mcp 形态（模式钮「⚡ 依赖 MCP」、连接流程照旧发起）',
    em.loaded && em.els.modeBtn.textContent === '⚡ 依赖 MCP'
    && em.els.runBtn.disabled === false && em.els.localNotice.hidden === true
    && em.fetchLog.length >= 2, // health + initialize + tools/list
    JSON.stringify({ loaded: em.loaded, modeBtn: em.els.modeBtn && em.els.modeBtn.textContent, fetches: em.fetchLog.length }));
  em.els.baseUrl.value = 'http://127.0.0.1:9999';
  em.els.saveCfg.dispatch('click');
  await settle();
  check('配置键统一：面板保存写 pv_base/pv_token（与背景/悬浮球同键，键分裂 bug 已修）',
    em.storageData.pv_base === 'http://127.0.0.1:9999'
    && em.storageData.base === undefined && em.storageData.token === undefined,
    JSON.stringify({ pv_base: em.storageData.pv_base, legacy: em.storageData.base }));
  check('clientInfo 版本单一源：initialize 带 manifest 版本（硬编码 1.9.0 漂移已修）',
    em.fetchLog.some((f) => f.url.endsWith('/rpc') && (() => { try { return JSON.parse(f.body).params.clientInfo.version === '9.9.9-test'; } catch { return false; } })()));
  em.els.modeBtn.dispatch('click');
  await settle();
  check('面板切独立模式：pv_mode 持久化、runBtn 停用、说明显形、模式钮文案切换',
    em.storageData.pv_mode === 'local' && em.els.runBtn.disabled === true
    && em.els.localNotice.hidden === false && em.els.modeBtn.textContent === '🔋 独立模式'
    && /独立模式/.test(em.els.serverInfo.textContent),
    `${em.els.modeBtn.textContent} | ${em.els.serverInfo.textContent}`);
  const fetchesBefore = em.fetchLog.length;
  em.els.runBtn.dispatch('click');
  await settle();
  check('面板独立模式：runTool 被守卫拦下（零 fetch 发出、状态行诚实指引）',
    em.fetchLog.length === fetchesBefore
    && /独立模式：工具调用需要 MCP 桥/.test(em.els.runStatus.textContent),
    em.els.runStatus.textContent);
  em.els.modeBtn.dispatch('click');
  await settle();
  check('面板切回依赖模式：重新拉清单（fetch 增长、runBtn 解禁、模式钮回 ⚡）',
    em.storageData.pv_mode === 'mcp' && em.els.runBtn.disabled === false
    && em.els.modeBtn.textContent === '⚡ 依赖 MCP' && em.fetchLog.length > fetchesBefore);

  const el2 = mkPanelEnv({ base: 'http://127.0.0.1:5555', token: 'legacy-tok', pv_mode: 'local' }); // 只有旧键 + 独立模式
  await settle();
  check('旧键迁移 + 独立模式恢复：legacy base/token 并入 pv_*（老配置不丢）、重开即 local 且零 fetch',
    el2.storageData.pv_base === 'http://127.0.0.1:5555' && el2.storageData.pv_token === 'legacy-tok'
    && el2.els.modeBtn.textContent === '🔋 独立模式' && el2.els.runBtn.disabled === true
    && el2.fetchLog.length === 0,
    JSON.stringify({ pv_base: el2.storageData.pv_base, fetches: el2.fetchLog.length }));
}

/* ================= r50：面板历史区富渲染（pvFactsLine 双面同口径 + 历史行预览） ================= */
{
  const vm = await import('node:vm');
  // 双面钉的悬浮球侧：pvFactsLine 是 floating.js IIFE 内部函数 —— 切片取出纯函数体在微型沙箱求值
  const floatSrc2 = fs.readFileSync(path.join(ROOT, 'extension', 'floating.js'), 'utf8');
  const flSlice = floatSrc2.slice(floatSrc2.indexOf('function pvFactsLine'), floatSrc2.indexOf('function resultTextOf'));
  const flSb = {};
  vm.createContext(flSb);
  vm.runInContext(`${flSlice}\nthis.__floatingFacts = pvFactsLine;`, flSb);
  const floatFacts = flSb.__floatingFacts;

  const mkHistEnv = (opts) => {
    const o = opts || {};
    const els = {};
    const makeEl = (id) => {
      const el = {
        _id: id, style: {}, value: '', textContent: '', innerHTML: '', hidden: false,
        disabled: false, className: '', children: [], _on: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener(type, fn) { (this._on[type] = this._on[type] || []).push(fn); },
        removeEventListener() {},
        appendChild(c) { c.parent = this; this.children.push(c); return c; },
        setAttribute() {}, getAttribute() { return null; },
        querySelector(sel) { // 允忍模板/子节点查找：按 className 找子树（历史行四段读取面）
          let found = null;
          const walk = (n) => { if (found) return; (n.children || []).forEach((c) => { if (!found && c.className && String(c.className).split(' ').includes(String(sel).slice(1))) found = c; walk(c); }); };
          walk(this);
          return found || makeEl(id + '.q');
        },
        querySelectorAll() { return []; },
        dispatch(type) { (this._on[type] || []).forEach((fn) => fn({ type, target: this })); },
      };
      return el;
    };
    const storageData = { pv_base: 'http://127.0.0.1:7395', pv_token: '' };
    const sandbox = {
      document: {
        getElementById(id) { if (!els[id]) els[id] = makeEl(id); return els[id]; },
        createElement() { return makeEl('dyn'); },
        createTextNode(t) { return { textContent: t }; },
        addEventListener() {},
      },
      fetch: async (url, opts2) => {
        if (o.fetchReject) throw new Error('Failed to fetch'); // r51：桥未起的真实失败形态（网络层拒绝）
        let body = { result: {} };
        if (String(url).endsWith('/health')) { return { ok: true, json: async () => ({ ok: true, version: '0', tools: 1 }) }; }
        try {
          const req = JSON.parse(String(opts2 && opts2.body || '{}'));
          if (req.method === 'initialize') body = { result: { serverInfo: { name: 'stub', version: '0' } } };
          else if (req.method === 'tools/list') body = { result: { tools: [{ name: 't1', title: 'T1', inputSchema: { properties: {} } }], serverInfo: { name: 'stub', version: '0' } } };
          else if (req.method === 'tools/call') body = { result: { content: [{ type: 'text', text: 'ok' }], ...(o.sc !== undefined ? { structuredContent: o.sc } : {}) } };
        } catch { /* 按空请求处理 */ }
        return { ok: true, json: async () => body };
      },
      chrome: {
        storage: { local: {
          async get(keys) { const x = {}; [].concat(keys).forEach((k) => { if (storageData[k] !== undefined) x[k] = storageData[k]; }); return x; },
          async set(obj) { Object.assign(storageData, obj); },
        } },
        runtime: { getManifest: () => ({ version: '9.9.9-test' }) },
      },
      console,
    };
    vm.createContext(sandbox);
    let loaded = true;
    try { vm.runInContext(panelJs, sandbox, { filename: 'panel.js' }); } catch (e) { loaded = false; sandbox._err = e.message; }
    return { els, sandbox, loaded };
  };
  const settle2 = () => new Promise((r) => setTimeout(r, 40));

  // 1) 双面同口径：同一组输入，面板复刻版与悬浮球原版产出同一行（防复制实现静默漂移）
  const battery = [
    undefined, null, 'str', [],
    { verdict: 'Pass', total: 3 },
    { verdict: 'Fail', nested: { a: 1, b: 'x' }, rows: [], title: 't', zero: 0, nul: null, skip: { deep: 1 } },
    { k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6 },
  ];
  {
    const e1 = mkHistEnv({});
    await settle2();
    const pfB = vm.runInContext('typeof pvFactsLine === "function" ? pvFactsLine : null', e1.sandbox);
    check('pvFactsLine 双面同口径：面板复刻版与悬浮球 r42 原版逐输入同输出（复制实现的防漂移钉）',
      typeof floatFacts === 'function' && typeof pfB === 'function'
      && battery.every((x) => pfB(x === undefined ? null : x) === floatFacts(x === undefined ? null : x)),
      `float=${typeof floatFacts} panel=${typeof pfB}`);
  }
  {
    const e = mkHistEnv({});
    await settle2();
    const pf = vm.runInContext('typeof pvFactsLine === "function" ? pvFactsLine : null', e.sandbox);
    const pv = vm.runInContext('typeof pvResultPreview === "function" ? pvResultPreview : null', e.sandbox);
    check('面板 vm：pvFactsLine/pvResultPreview 暴露且口径边界（非对象空串/verdict 剔除/数组 0 计数/cap 4）',
      !!pf && !!pv
      && pf('not-object') === '' && pf([1, 2]) === ''
      && pf({ verdict: 'X', a: 1 }) === 'a 1'
      && pf({ arr: [] }) === 'arr count 0'
      && pf({ a: 1, b: 2, c: 3, d: 4, e: 5 }) === 'a 1 · b 2 · c 3 · d 4'
      && pv({ structuredContent: { verdict: 'Pass', total: 3 } }) === '【Pass】 total 3'
      && pv({ content: [{ type: 'text', text: 'x' }] }) === ''
      && pv(null) === '',
      JSON.stringify({ facts: pf ? pf({ verdict: 'X', a: 1 }) : null, pv: pv ? pv({ structuredContent: { verdict: 'Pass', total: 3 } }) : null }));
  }
  // 2) 行为：runTool 完成 → 历史首行预览含 【verdict】+facts（textContent only）
  {
    const e = mkHistEnv({ sc: { verdict: 'Pass', total: 3, broken: [] } });
    await settle2();
    e.els.runBtn.dispatch('click');
    await settle2();
    const li = e.els.historyList.children[0];
    const pv = li && li.children.find((c) => String(c.className).includes('h-preview'));
    check('历史行富渲染：runTool 完成后首行 .h-preview = 【verdict】+关键事实一行（textContent）',
      !!li && !!pv && pv.textContent === '【Pass】 total 3 · broken count 0',
      pv ? pv.textContent : '(无 h-preview)');
  }
  // 3) 行为 XSS：恶意 structuredContent 原样保真进预览；renderHistory 函数体零 innerHTML
  {
    const e = mkHistEnv({ sc: { verdict: '<img src=x onerror=alert(1)>', note: '"><svg onload=1>' } });
    await settle2();
    e.els.runBtn.dispatch('click');
    await settle2();
    const li = e.els.historyList.children[0];
    const pv = li && li.children.find((c) => String(c.className).includes('h-preview'));
    const rhBody = panelJs.slice(panelJs.indexOf('function renderHistory'), panelJs.indexOf('/* ---------------- 连接与初始化'));
    check('历史行保真：恶意载荷原样进 .h-preview（textContent，XSS 面为零），renderHistory 零 innerHTML',
      !!pv && pv.textContent.includes('<img src=x onerror=alert(1)>') && pv.textContent.includes('"><svg onload=1>')
      && !rhBody.replace(/\/\/[^\n]*/g, '').includes('innerHTML'), // 注释写「零 innerHTML」不算红——去注释后匹配（r41 口径）
      pv ? pv.textContent.slice(0, 80) : '(无 h-preview)');
  }
  // 4) 行为：无 structuredContent → 预览空串，行四段结构不塌
  {
    const e = mkHistEnv({});
    await settle2();
    e.els.runBtn.dispatch('click');
    await settle2();
    const li = e.els.historyList.children[0];
    const cls = li ? li.children.map((c) => String(c.className).split(' ')[0]) : [];
    check('历史行空态：无 structuredContent → 预览空串、四段结构（名/态/时/预览）在位不塌',
      !!li && cls.includes('h-name') && cls.includes('h-status') && cls.includes('h-meta') && cls.includes('h-preview')
      && li.children.find((c) => c.className === 'h-preview').textContent === '',
      JSON.stringify(cls));
  }
  // r51：连接失败要给可执行指引（裸 "Failed to fetch" 不再是终点）
  {
    const e = mkHistEnv({ fetchReject: true });
    await settle2();
    check('连接失败指引：fetch 拒绝 → 状态行含「桥未运行」与 bridge.mjs 启动命令（可执行下一步）',
      /连接失败：.*桥未运行？.*node mcp\/bridge\.mjs.*保存并重连/s.test(String(e.els.serverInfo.textContent || '')),
      String(e.els.serverInfo.textContent).slice(0, 120));
  }
  // r51：安装输出的插件加载引导（安装及可使用：装完知道去哪加载扩展、怎么起桥）
  {
    const installSrc = fs.readFileSync(path.join(ROOT, 'skill', 'playwright-verify', 'install.mjs'), 'utf8');
    check('install 输出含插件加载引导：加载已解压 + extension 目录 + 起桥命令 + 独立模式提示',
      installSrc.includes('加载已解压的扩展程序')
      && installSrc.includes("path.join(INSTALL_ROOT, 'extension')")
      && installSrc.includes('bridge.mjs')
      && installSrc.includes('独立模式'));
  }
}

/* ================= 收尾 ================= */
await bridge.close();

log('');
log(`共 ${failures ? '有失败' : '全部通过'}：${failures} 项失败`);
process.exit(failures ? 1 : 0);
