/**
 * floating-check.mjs — 猫耳悬浮球行为钉（第 37 轮）
 *
 * 钉什么：录制纯函数核（vm 加载真 recorder.js）+ 悬浮器内容脚本（stub DOM 在 vm 里
 * 真跑真 floating.js，观察挂载树/监听器/发包断言行为）+ SW 中转（真 background.js
 * + 存根 chrome/fetch）+ manifest 契约。
 * 红线钉：敏感字段值绝不进录制数据/存储/任何发包；生成输入键集恰在 generate_scripts
 * 的 schema 白名单内、overwrite 恒 false；内容脚本无直连网络。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const EXT = path.join(ROOT, 'extension');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail !== undefined ? '  ' + String(detail) : ''}`);
  }
}

const recorderSrc = fs.readFileSync(path.join(EXT, 'recorder.js'), 'utf8');
const floatingSrc = fs.readFileSync(path.join(EXT, 'floating.js'), 'utf8');
const backgroundSrc = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* ================= A. 录制纯函数核（vm 加载真文件） ================= */
const recSandbox = {};
vm.createContext(recSandbox);
vm.runInContext(recorderSrc, recSandbox, { filename: 'recorder.js' });
const core = recSandbox.pvRecorderCore;
check('recorder 核 vm 加载成功且导出完整函数面',
  !!core && ['isSensitiveField', 'buildLocator', 'locatorToQuery', 'normalizeRecordedSteps', 'stepsToGenerateInput', 'describeStep']
    .every((k) => typeof core[k] === 'function'));

// 定位器优先级（与 generate.js canonicalLocator 同口径：testid > label > role > placeholder > text > selector）
const dFull = { tag: 'button', type: 'submit', testid: 't1', label: 'L1', name: 'B1', placeholder: 'P1', text: 'T1', id: 'i1', nameAttr: 'n1' };
check('buildLocator 有 testid → testid 最优先', core.buildLocator(dFull).kind === 'testid');
check('buildLocator 无 testid 有 label → label', core.buildLocator({ ...dFull, testid: '' }).kind === 'label');
check('buildLocator 无前两者有按钮名 → role', core.buildLocator({ ...dFull, testid: '', label: '' }).kind === 'role');
check('buildLocator 无语义信号有 placeholder → placeholder', core.buildLocator({ tag: 'input', type: 'text', placeholder: '搜订单' }).kind === 'placeholder');
check('buildLocator 仅可见文本 → text', core.buildLocator({ tag: 'a', name: '', text: '下一页' }).kind === 'text');
const LONG_HEADING = '这是一个很长的中文标题用于验证录制不截断'.repeat(2);
check('buildLocator：长文本整段保留（回放等值匹配，不截断埋雷）',
  core.buildLocator({ tag: 'h2', name: '', text: LONG_HEADING }).text === LONG_HEADING);
// 录制质量防护：CSS/代码文本不产文本定位器（真机实测抓过 .gitee-modal{…} 被录成 text、回放必失配）
check('looksLikeCode：代码特征命中（花括号/!important/function 声明）',
  core.looksLikeCode('.gitee-modal { width: 500px !important; }')
  && core.looksLikeCode('function login() {')
  && core.looksLikeCode('var x = 1;'));
check('looksLikeCode：普通中文说明文不误伤（含。（）、数字）',
  core.looksLikeCode('仓库说明：零预装依赖（纯净发布），不含 node_modules 与 . 前缀文件。') === false);
check('buildLocator：代码文本降级 selector（绝不产 text 定位器），正常段落仍走 text',
  (() => {
    const codeLoc = core.buildLocator({ tag: 'div', text: '.gitee-modal { width: 500px !important; }' });
    const proseLoc = core.buildLocator({ tag: 'p', text: '仓库说明：零预装依赖（纯净发布）。' });
    return codeLoc.kind === 'selector' && proseLoc.kind === 'text';
  })());
const selLoc = core.buildLocator({ tag: 'input', nameAttr: 'username' });
check('buildLocator 全无信号 → selector 兜底且无 nth-child/XPath',
  selLoc.kind === 'selector' && selLoc.selector === 'input[name="username"]' && !/nth-child|xpath/i.test(selLoc.selector));

// 敏感字段（凭据红线：宁可多跳过不可漏过）
check('isSensitiveField：口令类型命中', core.isSensitiveField({ type: 'password' }) === true);
check('isSensitiveField：卡号 autocomplete（cc-）命中', core.isSensitiveField({ autocomplete: 'cc-number' }) === true);
check('isSensitiveField：名称模式（cvv/密码/验证码）命中',
  core.isSensitiveField({ name: 'cvv' }) === true && core.isSensitiveField({ label: '支付密码' }) === true && core.isSensitiveField({ placeholder: '验证码' }) === true);
check('isSensitiveField：表单字段名（nameAttr）同样进敏感判定（DOM 胶水喂的形状）',
  core.isSensitiveField({ tag: 'input', type: 'text', nameAttr: 'order_cvv' }) === true);
check('isSensitiveField：普通字段不误伤', core.isSensitiveField({ tag: 'input', type: 'text', name: 'username' }) === false);

// 归一
const normed = core.normalizeRecordedSteps([
  { act: 'fill', locator: { kind: 'selector', selector: 'input[name="u"]' }, value: 'a' },
  { act: 'fill', locator: { kind: 'selector', selector: 'input[name="u"]' }, value: 'ab' },
  { act: 'fill', locator: { kind: 'selector', selector: 'input[name="u"]' }, value: 'abc' },
  { act: 'click', locator: { kind: 'text', text: 'X' } },
  { act: 'click', locator: { kind: 'text', text: 'X' } },
  { act: 'teleport', locator: { kind: 'text', text: 'Y' } },
]);
check('normalize：同字段连续 fill 合并为最后一次（逐键输入不产 N 条）',
  normed.filter((s) => s.act === 'fill').length === 1 && normed.filter((s) => s.act === 'fill')[0].value === 'abc');
check('normalize：同定位器同值 fill 跨 press 丢弃（Playwright Enter 补发 change 的无损归一），改值则保留',
  (() => {
    const L = { kind: 'selector', selector: 'input[name="u"]' };
    const s = core.normalizeRecordedSteps([
      { act: 'fill', locator: L, value: 'a' },
      { act: 'press', locator: L, key: 'Enter' },
      { act: 'fill', locator: L, value: 'a' },   // 同值 → 丢弃
      { act: 'click', locator: { kind: 'text', text: 'X' } },
      { act: 'fill', locator: L, value: 'b' },   // 改值 → 保留
    ]);
    const fills = s.filter((x) => x.act === 'fill');
    return s.length === 4 && fills.length === 2 && fills[0].value === 'a' && fills[1].value === 'b';
  })());
check('normalize：完全相同的连续步骤去重（连点两下算一次）',
  normed.filter((s) => s.act === 'click').length === 1);
check('normalize：未知动作丢弃（不把不认识的步骤喂给生成器）',
  normed.every((s) => s.act !== 'teleport'));
const many = [];
for (let i = 0; i < 500; i += 1) many.push({ act: 'click', locator: { kind: 'text', text: String(i) } });
check(`normalize：超上限截断到 MAX_RECORDED_STEPS（${core.MAX_RECORDED_STEPS}）`, core.normalizeRecordedSteps(many).length === core.MAX_RECORDED_STEPS);

// 回放查询
check('locatorToQuery：六种 mode 正确展开', ['testid', 'label', 'role', 'placeholder', 'text', 'selector'].every((k, i) => {
  const loc = [{ kind: 'testid', id: 'a' }, { kind: 'label', text: 'b' }, { kind: 'role', role: 'button', name: 'c' }, { kind: 'placeholder', text: 'd' }, { kind: 'text', text: 'e' }, { kind: 'selector', selector: '#f' }][i];
  return core.locatorToQuery(loc).mode === k;
}));
let qErr = null;
try { core.locatorToQuery({ kind: 'xpath' }); } catch (e) { qErr = e; }
check('locatorToQuery：非法 kind 抛错（回放绝不猜元素）', !!qErr && /未知的定位类型/.test(qErr.message));

// 生成输入（键集必须落在 generate_scripts 的 schema 白名单内）
const genIn = core.stepsToGenerateInput([
  { act: 'goto', url: 'https://shop.example.com/list' },
  { act: 'click', locator: { kind: 'text', text: '加入购物车' } },
  { act: 'fill', locator: { kind: 'selector', selector: 'input[name="u"]' }, value: 'alice' },
], { navPath: '/list?x=1', write: false });
const GEN_KEYS = ['pages', 'cases', 'spec', 'cwd', 'outDir', 'write', 'overwrite'];
check('stepsToGenerateInput：键集恰在 schema 白名单内（多字段会被服务端拒）',
  Object.keys(genIn).every((k) => GEN_KEYS.includes(k)) && Object.keys(genIn).length >= 6);
check('stepsToGenerateInput：overwrite 恒 false（绝不静默覆盖手写脚本）', genIn.overwrite === false);
check('stepsToGenerateInput：默认 write:false（先审再写）', genIn.write === false && core.stepsToGenerateInput([{ act: 'click', locator: { kind: 'text', text: 'x' } }]).write === false);
check('stepsToGenerateInput：goto 不进页面层步骤（导航走 navPath）',
  genIn.pages[0].navPath === '/list?x=1' && genIn.pages[0].steps.every((s) => s.act !== 'goto') && genIn.cases[0].nav === true);
check('describeStep：人话一行（面板日志可读）', /点击「加入购物车」/.test(core.describeStep({ act: 'click', locator: { kind: 'text', text: '加入购物车' } })));

// 录制管理纯函数（多条列表，单槽升级）
check('录制管理：makeRecording + addRecording 前插、id 唯一、容量帽 dropped 诚实', (() => {
  const r1 = core.makeRecording('A', 'u', [{ act: 'click', locator: { kind: 'text', text: 'x' } }]);
  const r2 = core.makeRecording('B', 'u', []);
  const add1 = core.addRecording([r1], r2);
  const many = Array.from({ length: 10 }, (_, i) => core.makeRecording('n' + i, 'u', []));
  const capped = core.addRecording(many, r2);
  return add1.list[0].id === r2.id && add1.list[1].id === r1.id && add1.dropped === 0
    && r1.id !== r2.id
    && capped.list.length === core.MAX_RECORDINGS && capped.dropped === 1;
})());
check('录制管理：rename 生效；空名拒绝；未命中 id 诚实不动', (() => {
  const r1 = core.makeRecording('A', 'u', []);
  return core.renameRecording([r1], r1.id, '  ')[0].name === 'A'
    && core.renameRecording([r1], r1.id, '新名')[0].name === '新名'
    && core.renameRecording([r1], 'nope', 'X')[0].name === 'A';
})());
check('录制管理：delete 删中；未命中 id 不动（不报成功）', (() => {
  const r1 = core.makeRecording('A', 'u', []);
  const r2 = core.makeRecording('B', 'u', []);
  return core.deleteRecording([r1, r2], r2.id).length === 1
    && core.deleteRecording([r1], 'nope').length === 1;
})());
check('录制管理：旧单槽迁移（老数据不丢、自动命名；空/坏数据不伪造条目）', (() => {
  const legacy = { url: 'u', steps: [{ act: 'click', locator: { kind: 'text', text: '旧' } }], savedAt: 1 };
  const migrated = core.migrateLegacyRecordings(legacy);
  return core.migrateLegacyRecordings(null).length === 0
    && core.migrateLegacyRecordings({ steps: [] }).length === 0
    && migrated.length === 1 && migrated[0].steps.length === 1 && migrated[0].name.indexOf('旧录制') === 0;
})());

/* ================= B. 悬浮器（stub DOM 在 vm 里真跑 floating.js） ================= */
const PAGE_URL = 'https://shop.example.com/list?x=1';

function makeEl(tag, els) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parent: null,
    style: { cssText: '', display: '', top: '', right: '' },
    attrs: {},
    listeners: {},
    className: '',
    textContent: '',
    innerHTML: '',
    id: '',
    value: '',
    checked: false,
    title: '',
    disabled: false,
    getAttribute(n) { return this.attrs[n] != null ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { (this.listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    contains(node) {
      if (node === this) return true;
      return this.children.some((c) => c.contains && c.contains(node));
    },
    attachShadow() { this.shadow = makeEl('#shadow', els); return this.shadow; },
    querySelector(sel) { return queryTree(this.shadow || this, sel); },
    querySelectorAll(sel) { return queryAllTree(this.shadow || this, sel); },
    click() { this.clicks = (this.clicks || 0) + 1; (this.listeners.click || []).forEach((fn) => fn({ type: 'click', target: this, composedPath: () => [this] })); },
    focus() {},
    // 真实 DOM 语义：a.remove() 把节点摘下树——桩只记账（r48 导出链要断言 remove 被调；
    // stub 盲区家族纪律：桩按真实 DOM 面给方法，缺方法会把产品行为误判成「崩了」）
    remove() { this.removed = true; },
  };
  // 真实 DOM 语义：textContent 赋值会清空子节点（'' 亦然）——普通属性会让 renderRecordingList 行累积
  let _text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return _text; },
    set(v) { _text = String(v); if (_text === '') el.children.length = 0; },
    configurable: true,
  });
  els.push(el);
  return el;
}

function walk(root, fn) {
  fn(root);
  (root.children || []).forEach((c) => walk(c, fn));
}

function matchSel(el, sel) {
  if (sel === '*') return true;
  if (sel[0] === '#') return el.id === sel.slice(1);
  const compound = /^(?:([a-z0-9-]+))?\[([\w-]+)(?:="([^"]*)")?\]$/i.exec(sel);
  if (compound) {
    if (compound[1] && el.tagName !== compound[1].toUpperCase()) return false;
    const v = el.getAttribute(compound[2]);
    return v !== null && (compound[3] === undefined || v === compound[3]);
  }
  const multi = sel.split(',').map((s) => s.trim());
  return multi.some((s) => {
    if (s[0] === '[') return matchSel(el, s);
    return el.tagName === s.toUpperCase();
  });
}

function queryTree(root, sel) {
  let found = null;
  walk(root, (el) => { if (!found && matchSel(el, sel)) found = el; });
  return found;
}

function queryAllTree(root, sel) {
  const out = [];
  walk(root, (el) => { if (matchSel(el, sel)) out.push(el); });
  return out;
}

function makeFloatEnv(seedStorage, respOverride) {
  const els = [];
  const docListeners = {};
  const messages = [];
  const storageData = Object.assign({}, seedStorage || {});
  const pageRoot = makeEl('html', els);
  const body = makeEl('body', els);
  pageRoot.appendChild(body);
  const documentStub = {
    createElement(tag) { return makeEl(tag, els); },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { return queryTree(pageRoot, sel); },
    querySelectorAll(sel) { return queryAllTree(pageRoot, sel); },
    documentElement: pageRoot,
    body,
  };
  const windowStub = {
    location: { href: PAGE_URL },
    addEventListener() {},
    removeEventListener() {},
  };
  const chromeStub = {
    runtime: {
      sendMessage(msg, cb) {
        messages.push(msg);
        if (cb) cb(respOverride || { ok: true, status: 200, json: { jsonrpc: '2.0', result: { content: [{ text: 'ok' }] } } });
      },
      getURL(p) { return 'chrome-extension://pvtest/' + p; },
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          [].concat(keys).forEach((k) => { if (storageData[k] !== undefined) out[k] = storageData[k]; });
          cb(out);
        },
        set(obj) { Object.assign(storageData, obj); },
      },
    },
  };
  // r48 导出链观测面：Blob/URL 存根（记录调用，不实现下载）+ setTimeout 包一层
  //（真定时器照跑保 sleep/replay 语义，另记账供钉断言 revoke 排程；unref 免得 10s
  // 回收定时器拖住套件退出——钉的场地自己保证，不靠运气）。
  const blobCalls = [];
  const urlCalls = { created: [], revoked: [] };
  const timers = [];
  class BlobStub { constructor(parts, opts) { this.parts = parts; this.opts = opts; blobCalls.push(this); } }
  const URLStub = {
    createObjectURL(b) { urlCalls.created.push(b); return 'blob:pvtest/' + urlCalls.created.length; },
    revokeObjectURL(u) { urlCalls.revoked.push(u); },
  };
  const sandbox = {
    document: documentStub, window: windowStub, chrome: chromeStub,
    Blob: BlobStub, URL: URLStub,
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); try { if (t && t.unref) t.unref(); } catch (e) { /* 浏览器无 unref */ } timers.push({ fn, ms, t }); return t; },
    clearTimeout(id) { return clearTimeout(id); },
  };
  vm.createContext(sandbox);
  vm.runInContext(recorderSrc, sandbox, { filename: 'recorder.js' });
  vm.runInContext(floatingSrc, sandbox, { filename: 'floating.js' });

  const host = els.find((e) => e.tagName === 'PV-FLOATING');
  const shadow = host && host.shadow;
  const panel = shadow && shadow.children.find((c) => c.className === 'pv-panel');
  const ball = shadow && shadow.children.find((c) => /pv-ball/.test(c.className));
  const badge = ball && ball.children.find((c) => c.className === 'pv-badge');
  const log = panel && panel.children.find((c) => c.className === 'pv-log');
  // 状态点是 head 的孙子节点（dot 在 .pv-head 里），且类名带模式态后缀 —— 递归按前缀找
  let dot = null;
  if (panel) walk(panel, (el) => { if (!dot && /pv-dot/.test(el.className || '')) dot = el; });
  const goal = panel && panel.children.find((c) => c.getAttribute('data-act') === 'goal');
  const byAct = (act) => panel && panel.children.find((c) => c.getAttribute('data-act') === act);
  const mkEv = (act) => ({ composedPath: () => [{ getAttribute: (n) => (n === 'data-act' ? act : null) }] });
  const clickAct = (act) => panel.listeners.click[0](mkEv(act));
  const addPageEl = (tag, attrs, props) => {
    const el = makeEl(tag, els);
    Object.assign(el.attrs, attrs || {});
    Object.assign(el, props || {});
    body.appendChild(el);
    return el;
  };
  return { els, docListeners, messages, storageData, host, panel, ball, badge, log, dot, goal, byAct, mkEv, clickAct, addPageEl, windowStub, sandbox, pageRoot, body, blobCalls, urlCalls, timers };
}

const env = makeFloatEnv();
check('悬浮器注入：Shadow DOM 挂载且猫耳球在位（data-pv-floating + <svg>）',
  !!env.host && env.host.getAttribute('data-pv-floating') === '1' && /<svg/.test(env.ball.innerHTML) && /linearGradient/.test(env.ball.innerHTML));
check('悬浮器注入：快捷面板按钮齐全（录制/结束/回放/生成/巡检/采集/NL/控制台）',
  ['record', 'stop', 'replay', 'generate', 'explore', 'collect', 'nl', 'console'].every((a) => !!env.byAct(a)));
check('悬浮器注入：幂等（二次注入不重复建树）',
  (() => { const before = env.els.length; vm.runInContext(floatingSrc, env.sandbox, { filename: 'floating.js' }); return env.els.length === before; })());
check('悬浮器注入：启动即探活（pv-health 已发往中转）', env.messages.some((m) => m.type === 'pv-health'));
check('悬浮器注入：点球开面板（display 切换）', (() => { env.ball.click(); return env.panel.style.display === 'block'; })());

// 拖拽：mousedown + mousemove → **球体自身**位置变（球是 position:fixed，改 host 是空操作——真机抓过）；mouseup → 落 storage
check('拖拽：移动改球体自身定位并落盘（pv_ball_pos）', (() => {
  const down = env.ball.listeners.mousedown[0];
  down({ clientX: 100, clientY: 300 });
  const moves = env.docListeners.mousemove || [];
  moves[0]({ clientX: 80, clientY: 320 });
  const up = (env.docListeners.mouseup || [])[0];
  if (up) up({});
  return /px$/.test(env.ball.style.top) && !!env.storageData.pv_ball_pos && typeof env.storageData.pv_ball_pos.top === 'number';
})());

// 录制链路（真捕获：文档级 capture 监听 → 归一 → 保存）
check('录制：开始后文档级 capture 监听齐（click/input/change/keydown）',
  ['click', 'input', 'change', 'keydown'].every((k) => (env.docListeners[k] || []).length >= 1));
const btn = env.addPageEl('button', {}, { textContent: '加入购物车' });
const inpUser = env.addPageEl('input', { type: 'text', name: 'username' }, { value: '' });
const inpPwd = env.addPageEl('input', { type: 'password', name: 'login_pwd' }, { value: 'hunter2-secret' });
check('录制：开始后角标亮起且球体进脉冲态', (() => { env.clickAct('record'); return env.badge.style.display === 'block' && /pv-rec/.test(env.ball.className); })());
const fireDoc = (type, el) => (env.docListeners[type] || [])[0]({ type, target: el, composedPath: () => [el] });
fireDoc('click', btn);
inpUser.value = 'alice'; // 用户先打字后触发 input 事件（与真实输入时序一致）
fireDoc('input', inpUser);
check('录制：捕获 click + fill 两步（角标 = 2）', Number(env.badge.textContent) === 2);
fireDoc('input', inpPwd);
check('录制：敏感字段（口令）录制期即跳过（角标不变）', env.badge.textContent === '2');
// 第二道敏感防线（名称模式）：type=text 但字段名是 cvv —— TEXT_TYPES 白名单拦不住它，必须靠 isSensitiveField
const inpCvv = env.addPageEl('input', { type: 'text', name: 'order_cvv' }, { value: '999-777' });
fireDoc('input', inpCvv);
check('录制：名称模式敏感字段（cvv 文本框）同样录制期跳过', env.badge.textContent === '2');

// 红线：敏感值不出现在任何存储/发包载荷
const allPayloads = JSON.stringify([env.messages, env.storageData]);
check('红线：敏感字段值不进录制数据/存储/任何发包', !allPayloads.includes('hunter2-secret'));

// 结束保存 → storage 真收到归一后的步骤
check('结束保存：storage 收到归一后的 2 步（url=当前页）', (() => {
  env.clickAct('stop');
  const rec = env.storageData.pv_recordings;
  return !!rec && rec.url === PAGE_URL && rec.steps.length === 2 && rec.steps[0].act === 'click' && rec.steps[1].act === 'fill' && rec.steps[1].value === 'alice';
})());
check('结束保存：角标熄灭且回放/生成按钮解禁', env.badge.style.display === 'none' && env.byAct('replay').disabled === false && env.byAct('generate').disabled === false);

// 回放守门：URL 不符诚实拒绝
check('回放守门：非录制页诚实拒绝（提示回录制页）', (() => {
  env.windowStub.location.href = 'https://other.example.com/';
  env.clickAct('replay');
  return /请回到录制页面/.test(env.log.textContent);
})());

// 回放真跑：同页逐条执行（找到元素 → click/fill 真发生；断言在异步结算后取值，不把 Promise 当 ok）
let replayOk = false;
await new Promise((resolve) => {
  env.windowStub.location.href = PAGE_URL;
  let clicked = false;
  let filled = null;
  btn.addEventListener('click', () => { clicked = true; });
  inpUser.addEventListener('input', () => { filled = inpUser.value; });
  env.clickAct('replay');
  setTimeout(() => {
    const text = String(env.log.textContent);
    replayOk = text.includes('✓') && !text.includes('未找到') && clicked === true && filled === 'alice';
    resolve();
  }, 420);
});
check('回放：同页回放真执行（日志逐条 ✓，元素真被点/填）', replayOk);

// 回放失败诚实停止：保存的录制在当前页找不到第一步 → 明说并停，后续步骤不执行
let failStopOk = false;
await new Promise((resolve) => {
  btn.textContent = '被改名的按钮'; // 第一步定位目标消失
  env.clickAct('replay');
  setTimeout(() => {
    const t = String(env.log.textContent);
    failStopOk = /元素未找到，已停止/.test(t) && !t.includes('填写「username」');
    resolve();
  }, 200);
});
check('回放失败：元素未找到即停（绝不执行后续步骤）', failStopOk);

// 工具快捷（走 SW 中转的三件套 + 生成 + NL + 控制台）
check('工具快捷：巡检/采集带当前页 URL 走中转', (() => {
  env.clickAct('explore');
  env.clickAct('collect');
  const calls = env.messages.filter((m) => m.type === 'pv-bridge' && m.params && (m.params.name === 'explore_page' || m.params.name === 'collect_table'));
  return calls.length === 2 && calls.every((m) => m.params.arguments.url === PAGE_URL);
})());
check('工具快捷：生成脚本走中转且键集/覆盖语义守住（write:false + overwrite:false）', (() => {
  env.clickAct('generate');
  const call = env.messages.filter((m) => m.type === 'pv-bridge' && m.params && m.params.name === 'generate_scripts').pop();
  const args = (call && call.params.arguments) || {};
  return !!call && Object.keys(args).every((k) => GEN_KEYS.includes(k)) && args.overwrite === false && args.write === false
    && Array.isArray(args.pages) && args.pages[0].steps.length === 2 && args.pages[0].steps[0].act === 'click';
})());
check('工具快捷：NL 测试无目标诚实拒绝；有目标带 goal 走中转', (() => {
  env.clickAct('nl');
  const refused = /先在输入框/.test(String(env.log.textContent));
  env.goal.value = '点击加入购物车后购物车里应看到该商品';
  env.clickAct('nl');
  const call = env.messages.filter((m) => m.type === 'pv-bridge' && m.params && m.params.name === 'nl_test_goal').pop();
  return refused && !!call && call.params.arguments.goal === '点击加入购物车后购物车里应看到该商品' && call.params.arguments.url === PAGE_URL;
})());
check('工具快捷：打开完整控制台走中转（pv-open-panel）', (() => {
  env.clickAct('console');
  return env.messages.some((m) => m.type === 'pv-open-panel');
})());
check('内容脚本网络边界：floating.js / recorder.js 无直连网络（只经 chrome.runtime.sendMessage）',
  !/fetch\s*\(|XMLHttpRequest/.test(floatingSrc) && !/fetch\s*\(|XMLHttpRequest/.test(recorderSrc));

// 真页面实测补钉：README 标题（h2，非按钮元素）录制 → 回放必须能找到并执行
const h2El = env.addPageEl('h2', {}, { textContent: 'README 使用说明章节' });
check('录制：h2 标题点击录成 text 定位器（整段文本）', (() => {
  env.windowStub.location.href = PAGE_URL;
  env.clickAct('record');
  fireDoc('click', h2El);
  env.clickAct('stop');
  const rec = env.storageData.pv_recordings;
  return !!rec && rec.steps.length === 1 && rec.steps[0].locator.kind === 'text'
    && rec.steps[0].locator.text === 'README 使用说明章节';
})());
let h2ReplayOk = false;
await new Promise((resolve) => {
  env.clickAct('replay');
  setTimeout(() => {
    const t = String(env.log.textContent);
    h2ReplayOk = /✓/.test(t) && !/未找到/.test(t);
    resolve();
  }, 300);
});
check('回放：h2 标题 text 定位器真能找到并执行（候选集含标题 + 整段兜底）', h2ReplayOk);

// 真机实测补钉：捕获取 composedPath 首元素（影子树事件在 document 层被重定向成 host，会录出垃圾文本）
check('录制：keydown Enter 录成 press 步骤（key 在事件上不在元素上——真机抓过的盲区）', (() => {
  const inp = env.addPageEl('input', { type: 'text', name: 'kw' }, { value: '' });
  env.clickAct('record');
  (env.docListeners.keydown || [])[0]({ type: 'keydown', key: 'Enter', target: inp, composedPath: () => [inp] });
  env.clickAct('stop');
  const rec = env.storageData.pv_recordings;
  return !!rec && rec.steps.length === 1 && rec.steps[0].act === 'press' && rec.steps[0].key === 'Enter';
})());
check('录制：非 Enter 按键不录（只认回车提交语义）', (() => {
  const inp = env.addPageEl('input', { type: 'text', name: 'kw2' }, { value: '' });
  env.clickAct('record');
  (env.docListeners.keydown || [])[0]({ type: 'keydown', key: 'a', target: inp, composedPath: () => [inp] });
  env.clickAct('stop');
  const rec = env.storageData.pv_recordings;
  return !!rec && rec.steps.length === 0;
})());
check('录制：捕获取 composedPath 首元素（Shadow DOM 重定向不污染定位器）', (() => {
  const inner = env.addPageEl('span', { 'data-testid': 'shadow-inner' }, { textContent: '内部元素' });
  const hostLike = env.addPageEl('gitee-widget', {}, { textContent: '面包屑 CalvinMCP .gitee-modal { width: 500px }' });
  env.clickAct('record');
  (env.docListeners.click || [])[0]({ type: 'click', target: hostLike, composedPath: () => [inner, hostLike] });
  env.clickAct('stop');
  const rec = env.storageData.pv_recordings;
  return !!rec && rec.steps.length === 1 && rec.steps[0].locator.kind === 'testid' && rec.steps[0].locator.id === 'shadow-inner';
})());

// 真机实测补钉：刷新恢复态 —— 有存量录制时回放/生成按钮解禁（URL 守门检查靠它可达）
const env2 = makeFloatEnv({ pv_recordings: { url: PAGE_URL, steps: [{ act: 'click', locator: { kind: 'text', text: 'X' } }], savedAt: 0 } });
check('恢复态：注入时读到存量录制 → 回放/生成按钮解禁', (() => {
  const replay2 = env2.panel.children.find((c) => c.getAttribute('data-act') === 'replay');
  const gen2 = env2.panel.children.find((c) => c.getAttribute('data-act') === 'generate');
  return replay2.disabled === false && gen2.disabled === false;
})());

// 真机实测补钉：回放深搜穿透开放影子树（Gitee 仓库头部 web component 场景）
let shadowReplayOk = false;
await new Promise((resolve) => {
  const comp = env.addPageEl('gitee-widget', {}, {});
  const sr = makeEl('#sr', env.els);
  comp.shadowRoot = sr;
  const inner = makeEl('p', env.els);
  inner.textContent = '影子树里的仓库描述';
  sr.appendChild(inner);
  env.windowStub.location.href = PAGE_URL;
  env.clickAct('record');
  (env.docListeners.click || [])[0]({ type: 'click', target: inner, composedPath: () => [inner] });
  env.clickAct('stop');
  const rec = env.storageData.pv_recordings;
  env.clickAct('replay');
  setTimeout(() => {
    const t = String(env.log.textContent);
    shadowReplayOk = !!rec && rec.steps.length === 1 && rec.steps[0].locator.kind === 'text'
      && /✓/.test(t) && !/未找到/.test(t);
    resolve();
  }, 300);
});
check('录制+回放：开放影子树目标深搜命中（组件化页面真场景）', shadowReplayOk);

// 结构化结果可视化：verdict 徽标（工具判定前置一眼可见，值保真）
// 注意：stub 回调同步但 .then 是微任务 —— 断言必须异步结算后取值（check() 喂同步快照会恒红/恒真）
let verdictChipOk = false;
await new Promise((resolve) => {
  const envV = makeFloatEnv(null, { ok: true, status: 200, json: { jsonrpc: '2.0', result: { content: [{ text: '巡检完成：链接 199' }], structuredContent: { verdict: 'Pass', total: 199 } } } });
  envV.windowStub.location.href = PAGE_URL;
  envV.clickAct('explore');
  setTimeout(() => {
    const t = String(envV.log.textContent);
    verdictChipOk = t.startsWith('【Pass】') && t.includes('巡检完成');
    resolve();
  }, 50);
});
check('悬浮球：structuredContent.verdict → 日志【徽标】前置（值保真不改写）', verdictChipOk);
let noChipOk = false;
await new Promise((resolve) => {
  const envNV = makeFloatEnv(null, { ok: true, status: 200, json: { jsonrpc: '2.0', result: { content: [{ text: '纯文本结果' }] } } });
  envNV.windowStub.location.href = PAGE_URL;
  envNV.clickAct('collect');
  setTimeout(() => {
    noChipOk = String(envNV.log.textContent) === '纯文本结果';
    resolve();
  }, 50);
});
check('悬浮球：无 verdict 不加徽标（不伪造判定）', noChipOk);


const floatingSrcCache = fs.readFileSync(path.join(ROOT, 'extension', 'floating.js'), 'utf8');
const recorderSrcCache = fs.readFileSync(path.join(ROOT, 'extension', 'recorder.js'), 'utf8');
function sandboxFacts() {
  try {
    const permissive = () => ({
      style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
      className: '', textContent: '', innerHTML: '', title: '', value: '', children: [],
      addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
      appendChild(c) { this.children.push(c); return c; },
      attachShadow() { return permissive(); },
      contains() { return false; },
    });
    const html = permissive(); const body = permissive(); html.children.push(body);
    const s = {
      document: { getElementById() { return null; }, createElement() { return permissive(); }, addEventListener() {}, documentElement: html, body },
      window: { location: { href: 'about:blank' }, addEventListener() {}, removeEventListener() {} },
      chrome: { runtime: { sendMessage() {}, getURL: (x) => x }, storage: { local: { get(k, cb) { cb({}); }, set() {} } } },
      setTimeout, clearTimeout,
    };
    vm.createContext(s);
    vm.runInContext(recorderSrcCache, s, { filename: 'recorder.js' });
    vm.runInContext(floatingSrcCache, s, { filename: 'floating.js' });
    return typeof s.pvFactsLine === 'function' ? s.pvFactsLine : null;
  } catch { return null; } // 异常兜成 null：钉干净变红，不崩整个套件
}

// 富渲染：verdict + 关键事实一行化（纯函数 + 真行为）
check('富渲染：pvFactsLine 键序前 4 席（顶层标量/一层嵌套），不含 verdict、超出丢弃', (() => {
  const f = sandboxFacts();
  if (!f) return false;
  const line = f({ verdict: 'Pass', total: 199, probed: 20, images: { total: 35, broken: 0 }, links: [{}, {}], skipped: 122 });
  return line === 'total 199 · probed 20 · images.total 35 · images.broken 0';
})());
check('富渲染：数组计数进事实（0 也如实；键序在前则占席）', (() => {
  const f = sandboxFacts();
  if (!f) return false;
  return f({ rows: [1, 2, 3] }) === 'rows count 3' && f({ ok: 1, rows: [] }) === 'ok 1 · rows count 0';
})());
check('富渲染：仅 verdict/非对象 → 空串（不硬凑不伪造）', (() => {
  const f = sandboxFacts();
  if (!f) return false;
  return f({ verdict: 'Pass' }) === '' && f(null) === '' && f([1, 2]) === '' && f('text') === '';
})());
let richRenderOk = false;
await new Promise((resolve) => {
  const envR = makeFloatEnv(null, { ok: true, status: 200, json: { jsonrpc: '2.0', result: { content: [{ text: '巡检完成：链接 199' }], structuredContent: { verdict: 'Pass', total: 199, probed: 20 } } } });
  envR.windowStub.location.href = PAGE_URL;
  envR.clickAct('explore');
  setTimeout(() => {
    const t2 = String(envR.log.textContent);
    richRenderOk = t2.startsWith('【Pass】') && t2.includes('total 199') && t2.includes('probed 20') && t2.includes('巡检完成');
    resolve();
  }, 50);
});
check('富渲染：真行为 —— 日志【verdict】facts | 正文 一段看全', richRenderOk);
let richEmptyOk = false;
await new Promise((resolve) => {
  const envR = makeFloatEnv(null, { ok: true, status: 200, json: { jsonrpc: '2.0', result: { content: [{ text: '纯文本结果原文' }], structuredContent: { verdict: 'Blocked', nested: { deep: { deeper: 1 } } } } } });
  envR.windowStub.location.href = PAGE_URL;
  envR.clickAct('collect');
  setTimeout(() => {
    const t2 = String(envR.log.textContent);
    richEmptyOk = t2.startsWith('【Blocked】') && t2.includes('纯文本结果原文') && !t2.includes(' | ');
    resolve();
  }, 50);
});
check('富渲染：无可提取事实 → 只徽标不硬凑（无 facts 段）', richEmptyOk);
let richTextOk = false;
await new Promise((resolve) => {
  const longText = '长'.repeat(500);
  const envR = makeFloatEnv(null, { ok: true, status: 200, json: { jsonrpc: '2.0', result: { content: [{ text: longText }] } } });
  envR.windowStub.location.href = PAGE_URL;
  envR.clickAct('explore');
  setTimeout(() => {
    const t2 = String(envR.log.textContent);
    richTextOk = t2.length <= 300 && !t2.startsWith('【');
    resolve();
  }, 50);
});
check('富渲染：无结构化时正文截 300 保紧凑、零前缀（回归不破）', richTextOk);

// 录制管理胶水（stub DOM 真跑：列表 UI / 选中回放 / 删除 / 容量帽 / 旧槽迁移）
let mgmtSave2 = false;
await new Promise((resolve) => {
  const envM = makeFloatEnv();
  envM.windowStub.location.href = PAGE_URL;
  const elA = envM.addPageEl('button', {}, { textContent: '录制甲按钮' });
  const elB = envM.addPageEl('button', {}, { textContent: '录制乙按钮' });
  envM.clickAct('record');
  (envM.docListeners.click || [])[0]({ type: 'click', target: elA, composedPath: () => [elA] });
  envM.clickAct('stop');
  envM.clickAct('record');
  (envM.docListeners.click || [])[0]({ type: 'click', target: elB, composedPath: () => [elB] });
  envM.clickAct('stop');
  setTimeout(() => {
    const list = envM.storageData.pv_recordings_list;
    const latest = envM.storageData.pv_recordings;
    const rows = envM.panel.children.find((c) => c.className === 'pv-rec-list');
    mgmtSave2 = Array.isArray(list) && list.length === 2
      && list[0].steps.length === 1 && list[0].steps[0].locator.name === '录制乙按钮'
      && latest && latest.steps[0].locator.name === '录制乙按钮'
      && rows && rows.children.length === 2;
    resolve();
  }, 50);
});
check('录制管理：连录两条 → 列表 2（新在前）、旧槽=最新、UI 2 行', mgmtSave2);

let selectOlderOk = false;
await new Promise((resolve) => {
  const envM = makeFloatEnv();
  envM.windowStub.location.href = PAGE_URL;
  const elA = envM.addPageEl('button', {}, { textContent: '较早录制按钮' });
  const elB = envM.addPageEl('button', {}, { textContent: '较新录制按钮' });
  envM.clickAct('record');
  (envM.docListeners.click || [])[0]({ type: 'click', target: elA, composedPath: () => [elA] });
  envM.clickAct('stop');
  envM.clickAct('record');
  (envM.docListeners.click || [])[0]({ type: 'click', target: elB, composedPath: () => [elB] });
  envM.clickAct('stop');
  setTimeout(() => {
    const rows = envM.panel.children.find((c) => c.className === 'pv-rec-list');
    const olderRow = rows.children[1]; // 前插序：0=最新，1=较早
    rows.listeners.click[0]({ composedPath: () => [olderRow] });
    envM.clickAct('replay');
    setTimeout(() => {
      const txt = String(envM.log.textContent);
      selectOlderOk = /较早录制按钮/.test(txt) && /✓/.test(txt);
      resolve();
    }, 200);
  }, 50);
});
check('录制管理：选中较早一条 → 回放执行的是它的步骤', selectOlderOk);

let deleteOk = false;
await new Promise((resolve) => {
  const envM = makeFloatEnv();
  envM.windowStub.location.href = PAGE_URL;
  const elA = envM.addPageEl('button', {}, { textContent: '将被删除的录制' });
  const elB = envM.addPageEl('button', {}, { textContent: '保留的录制' });
  envM.clickAct('record');
  (envM.docListeners.click || [])[0]({ type: 'click', target: elA, composedPath: () => [elA] });
  envM.clickAct('stop');
  envM.clickAct('record');
  (envM.docListeners.click || [])[0]({ type: 'click', target: elB, composedPath: () => [elB] });
  envM.clickAct('stop');
  setTimeout(() => {
    const rows = envM.panel.children.find((c) => c.className === 'pv-rec-list');
    const delBtn = rows.children[1].children[3]; // 删较早那条（列序 [span,ren,meta,del]）
    rows.listeners.click[0]({ composedPath: () => [delBtn] });
    setTimeout(() => {
      const list = envM.storageData.pv_recordings_list;
      deleteOk = Array.isArray(list) && list.length === 1
        && list[0].steps[0].locator.name === '保留的录制'
        && /已删除/.test(String(envM.log.textContent))
        && rows.children.length === 1;
      resolve();
    }, 50);
  }, 50);
});
check('录制管理：删除较早一条 → 列表/UI/storage 同步为 1，日志如实', deleteOk);

let capOk = false;
await new Promise((resolve) => {
  const envM = makeFloatEnv();
  envM.windowStub.location.href = PAGE_URL;
  let i = 0;
  const fire = () => {
    if (i >= core.MAX_RECORDINGS + 1) {
      setTimeout(() => {
        const list = envM.storageData.pv_recordings_list;
        capOk = Array.isArray(list) && list.length === core.MAX_RECORDINGS
          && /已淘汰/.test(String(envM.log.textContent));
        resolve();
      }, 50);
      return;
    }
    const el = envM.addPageEl('button', {}, { textContent: '容量测试按钮 ' + i });
    envM.clickAct('record');
    (envM.docListeners.click || [])[0]({ type: 'click', target: el, composedPath: () => [el] });
    envM.clickAct('stop');
    i += 1;
    fire();
  };
  fire();
});
check('录制管理：容量帽 10 —— 第 11 条触发最旧淘汰且日志如实（不静默吞）', capOk);

const envMG = makeFloatEnv({ pv_recordings: { url: PAGE_URL, steps: [{ act: 'click', locator: { kind: 'text', text: '旧槽步骤' } }], savedAt: 1 } });

// 行内重命名（r41 纯函数 + r43 面板入口闭环）
// 教训：renderRecordingList 每次全量重建行 —— 钉必须在动作后**重取**行/输入框，
// 保存旧引用会在断言时读到已脱离树的旧行（本轮实测踩过）。
function mkRecEnvWithOne() {
  const env = makeFloatEnv();
  env.windowStub.location.href = PAGE_URL;
  const el = env.addPageEl('button', {}, { textContent: '重命名目标按钮' });
  env.clickAct('record');
  (env.docListeners.click || [])[0]({ type: 'click', target: el, composedPath: () => [el] });
  env.clickAct('stop');
  return env;
}
function freshRows(env) { return env.panel.children.find((c) => c.className === 'pv-rec-list'); }
function enterRename(env) {
  const rows = freshRows(env);
  const renBtn = rows.children[0].children[1]; // [span, ren, meta, del]
  rows.listeners.click[0]({ composedPath: () => [renBtn] });
  return freshRows(env).children[0].children[0]; // 重渲染后的输入框
}

let renameOpenOk = false;
await new Promise((resolve) => {
  const env = mkRecEnvWithOne();
  setTimeout(() => {
    const input = enterRename(env);
    const row = freshRows(env).children[0];
    const origName = env.storageData.pv_recordings_list[0].name; // 录制名是自动命名，不是步骤目标文案
    renameOpenOk = !!input && input.className === 'pv-rec-rename' && input.value === origName
      && !row.children.some((c) => c.tagName === 'SPAN' && c.textContent === origName);
    resolve();
  }, 30);
});
check('重命名：点 ✎ → 行内输入框出现（值=原名，span 消失）', renameOpenOk);

let renameCommitOk = false;
await new Promise((resolve) => {
  const env = mkRecEnvWithOne();
  setTimeout(() => {
    const input = enterRename(env);
    input.value = '新的录制名字';
    freshRows(env).listeners.keydown[0]({ key: 'Enter', composedPath: () => [input] });
    setTimeout(() => {
      const stored = env.storageData.pv_recordings_list;
      const nameSpan = freshRows(env).children[0].children[0];
      renameCommitOk = Array.isArray(stored) && stored[0].name === '新的录制名字'
        && nameSpan.tagName === 'SPAN' && nameSpan.textContent === '新的录制名字'
        && /已重命名 →「新的录制名字」/.test(String(env.log.textContent));
      resolve();
    }, 30);
  }, 30);
});
check('重命名：Enter 提交 → storage/行显示/日志三处同步新名', renameCommitOk);

let renameEmptyOk = false;
await new Promise((resolve) => {
  const env = mkRecEnvWithOne();
  setTimeout(() => {
    const input = enterRename(env);
    input.value = '   ';
    freshRows(env).listeners.keydown[0]({ key: 'Enter', composedPath: () => [input] });
    setTimeout(() => {
      const stored = env.storageData.pv_recordings_list;
      const origName = env.origName || (env.origName = stored[0].name);
      renameEmptyOk = Array.isArray(stored) && stored[0].name === origName
        && /名称不能为空（未改动）/.test(String(env.log.textContent));
      resolve();
    }, 30);
  }, 30);
});
check('重命名：空名 Enter → 纯函数拒绝 + 日志如实（不制造无名录制）', renameEmptyOk);

let renameEscOk = false;
await new Promise((resolve) => {
  const env = mkRecEnvWithOne();
  setTimeout(() => {
    const input = enterRename(env);
    input.value = '不要这个名字';
    freshRows(env).listeners.keydown[0]({ key: 'Escape', composedPath: () => [input] });
    setTimeout(() => {
      const stored = env.storageData.pv_recordings_list;
      const nameSpan = freshRows(env).children[0].children[0];
      const origName = env.origName || (env.origName = stored[0].name);
      renameEscOk = Array.isArray(stored) && stored[0].name === origName
        && nameSpan.tagName === 'SPAN' && !/已重命名/.test(String(env.log.textContent));
      resolve();
    }, 30);
  }, 30);
});
check('重命名：Esc 取消 → 不落盘不改名不报成功', renameEscOk);

let renameAbortOk = false;
await new Promise((resolve) => {
  const env = mkRecEnvWithOne();
  setTimeout(() => {
    enterRename(env);
    const rows = freshRows(env);
    rows.listeners.click[0]({ composedPath: () => [rows.children[0]] }); // 重命名中点行本身 → 退出
    setTimeout(() => {
      const nameSpan = freshRows(env).children[0].children[0];
      const origName = env.origName || (env.origName = env.storageData.pv_recordings_list[0].name);
      renameAbortOk = nameSpan.tagName === 'SPAN'
        && env.storageData.pv_recordings_list[0].name === origName;
      resolve();
    }, 30);
  }, 30);
});
check('重命名：进行中点行切换选中 → 退出重命名态（无悬挂输入框）', renameAbortOk);

let renameDataOk = false;
await new Promise((resolve) => {
  const env = mkRecEnvWithOne();
  setTimeout(() => {
    const input = enterRename(env);
    input.value = '只改名不改数据';
    freshRows(env).listeners.keydown[0]({ key: 'Enter', composedPath: () => [input] });
    setTimeout(() => {
      const stored = env.storageData.pv_recordings_list[0];
      renameDataOk = stored.name === '只改名不改数据'
        && stored.steps.length === 1 && stored.steps[0].locator.name === '重命名目标按钮'
        && stored.url === PAGE_URL;
      resolve();
    }, 30);
  }, 30);
});
check('重命名：只改名不改数据（steps/url 原样保真）', renameDataOk);

check('录制管理：刷新只带旧单槽 → 自动迁移入列表（老数据不丢、按钮解禁）', (() => {
  const list = envMG.storageData.pv_recordings_list;
  const replayBtn = envMG.panel.children.find((c) => c.className === 'pv-rec-list')
    ? envMG.byAct('replay') : null;
  return Array.isArray(list) && list.length === 1 && list[0].steps.length === 1
    && replayBtn.disabled === false;
})());

/* ================= C. SW 中转（真 background.js + 存根 chrome/fetch） ================= */
function makeBackgroundEnv() {
  const listeners = {};
  const fetchCalls = [];
  const tabsCreated = [];
  const storageData = { pv_base: 'http://127.0.0.1:17395', pv_token: 'tok-abc' };
  let fetchMode = 'ok';
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener(fn) { listeners.action = fn; } } },
      runtime: {
        getURL(p) { return 'chrome-extension://pvbg/' + p; },
        onMessage: { addListener(fn) { listeners.message = fn; } },
      },
      tabs: { create(o) { tabsCreated.push(o); } },
      storage: {
        local: {
          get(keys, cb) { const out = {}; [].concat(keys).forEach((k) => { if (storageData[k] !== undefined) out[k] = storageData[k]; }); cb(out); },
          set(obj) { Object.assign(storageData, obj); },
        },
      },
    },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      if (fetchMode === 'throw') throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ text: 'ok' }] } }) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(backgroundSrc, sandbox, { filename: 'background.js' });
  return { listeners, fetchCalls, tabsCreated, storageData, setFetchMode(m) { fetchMode = m; } };
}

function callMessage(bg, msg) {
  return new Promise((resolve) => {
    const isAsync = bg.listeners.message(msg, null, resolve);
    if (isAsync !== true) resolve(undefined);
  });
}

const bg = makeBackgroundEnv();
check('中转：onMessage 接线在位（pv-bridge / pv-health / pv-open-panel）', typeof bg.listeners.message === 'function' && typeof bg.listeners.action === 'function');
const resp1 = await callMessage(bg, { type: 'pv-bridge', method: 'tools/list', params: {} });
const call1 = bg.fetchCalls[bg.fetchCalls.length - 1];
const body1 = JSON.parse(call1.opts.body);
check('中转：pv-bridge → POST 桥 /rpc，口令只经请求头（x-bridge-token）',
  !!resp1 && resp1.ok === true && call1.url === 'http://127.0.0.1:17395/rpc' && call1.opts.method === 'POST'
  && call1.opts.headers['x-bridge-token'] === 'tok-abc' && body1.method === 'tools/list' && body1.jsonrpc === '2.0'
  && !String(call1.opts.body).includes('tok-abc'));
await callMessage(bg, { type: 'pv-health' });
const call2 = bg.fetchCalls[bg.fetchCalls.length - 1];
check('中转：pv-health → GET /health 且免口令（探活不带 token）',
  call2.url === 'http://127.0.0.1:17395/health' && call2.opts.method === 'GET' && !(call2.opts.headers && call2.opts.headers['x-bridge-token']));
bg.storageData.pv_token = '';
await callMessage(bg, { type: 'pv-bridge', method: 'tools/list', params: {} });
const call3 = bg.fetchCalls[bg.fetchCalls.length - 1];
check('中转：未配口令时不带 token 头（可选口令语义）', !('x-bridge-token' in call3.opts.headers));
bg.storageData.pv_token = 'tok-abc';
const respBad = await new Promise((resolve) => {
  bg.setFetchMode('throw');
  bg.listeners.message({ type: 'pv-bridge', method: 'tools/list', params: {} }, null, resolve);
});
check('中转：桥不可达时诚实返回 { ok:false, error }（不吞因）', !!respBad && respBad.ok === false && /ECONNREFUSED/.test(String(respBad.error)));
bg.setFetchMode('ok');
const respOpen = await callMessage(bg, { type: 'pv-open-panel' });
check('中转：pv-open-panel → 打开控制台整页', respOpen && respOpen.ok === true && bg.tabsCreated.some((t) => /panel\.html$/.test(t.url)));
await callMessage(bg, { type: 'pv-bridge', method: 'tools/call', params: { name: 'explore_page', arguments: { url: PAGE_URL } } });
const call5 = bg.fetchCalls[bg.fetchCalls.length - 1];
const body5 = JSON.parse(call5.opts.body);
check('中转：工具调用透传 params（name/arguments 原样进 /rpc）',
  body5.params && body5.params.name === 'explore_page' && body5.params.arguments.url === PAGE_URL && body5.method === 'tools/call');

/* ================= D. manifest 契约 ================= */
const cs = (manifest.content_scripts || [])[0] || {};
check('manifest：content_scripts 注入 recorder.js → floating.js（顺序即依赖）',
  Array.isArray(cs.js) && cs.js.length === 2 && cs.js[0] === 'recorder.js' && cs.js[1] === 'floating.js' && cs.run_at === 'document_idle');
check('manifest：注入面只圈 http/https 网页（matches 恰为两条 http/https 通配）',
  Array.isArray(cs.matches) && cs.matches.length === 2
  && cs.matches[0] === 'http://*/*' && cs.matches[1] === 'https://*/*');
check('manifest：host_permissions 仍只圈本机 2 条（网络面不扩权）',
  Array.isArray(manifest.host_permissions) && manifest.host_permissions.length === 2
  && manifest.host_permissions.includes('http://127.0.0.1/*') && manifest.host_permissions.includes('http://localhost/*'));
check('manifest：permissions 仍只有 storage（无 tabs 等扩权）',
  Array.isArray(manifest.permissions) && manifest.permissions.length === 1 && manifest.permissions[0] === 'storage');
check('manifest.version 与 package.json 单一源同步', manifest.version === pkg.version, `v${manifest.version} vs v${pkg.version}`);

/* ---- r48：导出录制为 generate_scripts 输入 JSON（纯函数载荷/文件名 + vm 行为链） ---- */
check('exportFileName：保留字符/空白清洗 + stamp 注入 + .json 后缀（自动命名「录制 10:30:22」实形）',
  core.exportFileName('录制 10:30:22', 'abc') === 'pv-export-录制-10_30_22-abc.json'
  && core.exportFileName('a/b\\c:d*e?f"g<h>i|j', 'x') === 'pv-export-a_b_c_d_e_f_g_h_i_j-x.json',
  core.exportFileName('录制 10:30:22', 'abc'));
check('exportFileName：空名/全符号回落 recording；60 字符帽且尾部再剥（尾帽后缀安全）',
  core.exportFileName('', 's') === 'pv-export-recording-s.json'
  && core.exportFileName('???', 's') === 'pv-export-recording-s.json'
  && core.exportFileName('长'.repeat(100), 's') === 'pv-export-' + '长'.repeat(60) + '-s.json',
  core.exportFileName('???', 's'));
{
  const expIn = core.stepsToGenerateInput([{ act: 'click', locator: { kind: 'text', text: 'x' } }], { navPath: '/p', write: false });
  check('导出载荷：generate_scripts 输入形态且 write/overwrite 恒 false（导出绝不携带写盘语义）',
    expIn.write === false && expIn.overwrite === false
    && Array.isArray(expIn.pages) && Array.isArray(expIn.cases) && typeof expIn.spec === 'string'
    && expIn.pages[0].navPath === '/p' && expIn.pages[0].steps.length === 1
    && expIn.cases[0].page === expIn.pages[0].name);
}
{
  const seedRec = { id: 'r48seed', name: '录制 10:30:22', url: PAGE_URL, steps: [{ act: 'click', locator: { kind: 'text', text: '加入购物车' } }], savedAt: 1 };
  const env2 = makeFloatEnv({ pv_recordings_list: [seedRec] });
  check('导出按钮：面板在位且随录制态解禁（有录制 → enabled，按钮态与回放/生成同口径）',
    (() => { const b = env2.byAct('export'); return !!b && b.disabled === false; })());
  env2.clickAct('export');
  check('导出行为：Blob 收到 JSON 载荷、download=清洗名、锚点 click+remove 被调、revoke 已排程 10s',
    (() => {
      const b = env2.blobCalls[0];
      const json = b && String(b.parts[0]);
      const parsed = json ? JSON.parse(json) : null;
      const anchor = env2.els.filter((e) => e.tagName === 'A').pop();
      return !!b && b.opts && b.opts.type === 'application/json'
        && !!parsed && parsed.pages[0].steps.length === 1 && parsed.write === false && parsed.overwrite === false
        && !!anchor && /^pv-export-录制-10_30_22-[0-9a-z]+\.json$/.test(anchor.download)
        && String(anchor.href).startsWith('blob:pvtest/') && anchor.clicks === 1 && anchor.removed === true
        && env2.urlCalls.created.length === 1 && env2.timers.some((t) => t.ms === 10000);
    })(), JSON.stringify({ blob: env2.blobCalls.length, timers: env2.timers.map((t) => t.ms), log: env2.log.textContent }));
  check('导出行为：日志回执 = 文件名 + 步数 + 输入形态 + write:false + 下载目录指引',
    /^已导出 pv-export-录制-10_30_22-[0-9a-z]+\.json（1 步 · generate_scripts 输入形态 · write:false）——在浏览器下载目录/.test(env2.log.textContent),
    env2.log.textContent);
  const env3 = makeFloatEnv({ pv_recordings_list: [] });
  env3.clickAct('export');
  check('导出行为：无活动录制 → 按钮禁用 + 日志提示 + 零 Blob 零下载（不硬凑不掀翻）',
    env3.byAct('export').disabled === true
    && env3.log.textContent.includes('没有可导出的录制')
    && env3.blobCalls.length === 0 && env3.urlCalls.created.length === 0,
    env3.log.textContent);
  const evil = { id: 'evil', name: '<img src=x onerror=alert(1)>/?:*', url: PAGE_URL, steps: [{ act: 'fill', locator: { kind: 'testid', name: 'n' }, value: '"><svg onload=1>' }], savedAt: 2 };
  const env4 = makeFloatEnv({ pv_recordings_list: [evil] });
  env4.clickAct('export');
  check('导出保真：步骤值原样进 JSON（导出不经 innerHTML，XSS 面为零），恶意录制名只走文件名清洗面',
    (() => {
      const json = String(env4.blobCalls[0].parts[0]);
      const a = env4.els.filter((e) => e.tagName === 'A').pop();
      const base = String(a.download).replace(/^pv-export-/, '').replace(/-[0-9a-z]+\.json$/, '');
      // 载荷只携带步骤（值保真）与页结构——录制名不进 generate 输入（设计如此），恶意名只可能出现在文件名侧
      return json.includes('"><svg onload=1>')
        && base.length > 0 && !/[\\/:*?"<>|]/.test(base) && String(a.download).endsWith('.json');
    })(), env4.els.filter((e) => e.tagName === 'A').pop().download);
}

/* ---- r49：插拔式双模（独立/依赖 MCP） ---- */
{
  const seed = { id: 'm49', name: '录制 10:30:22', url: PAGE_URL, steps: [{ act: 'click', locator: { kind: 'text', text: 'x' } }], savedAt: 1 };
  const em = makeFloatEnv({ pv_recordings_list: [seed] });
  check('双模默认 mcp：模式钮「⚡ 依赖 MCP」、generate/export 随录制解禁、探活照旧（旧行为零漂移）',
    em.byAct('mode').textContent === '⚡ 依赖 MCP'
    && em.byAct('generate').disabled === false && em.byAct('export').disabled === false
    && em.messages.some((m) => m.type === 'pv-health'),
    em.byAct('mode').textContent);
  em.clickAct('mode');
  check('切独立模式：pv_mode 持久化、状态点 pv-local、桥依赖按钮停用、本地能力保留、日志如实',
    em.storageData.pv_mode === 'local'
    && /pv-local/.test(em.dot.className) && /独立模式/.test(em.dot.title)
    && em.byAct('generate').disabled === true && em.byAct('explore').disabled === true
    && em.byAct('collect').disabled === true && em.byAct('nl').disabled === true
    && em.byAct('export').disabled === false && em.byAct('replay').disabled === false
    && em.byAct('console').disabled !== true
    && /独立模式：录制\/回放\/导出 JSON 本地可用/.test(em.log.textContent),
    `${em.dot.className} | ${em.log.textContent}`);
  const msgsBefore = em.messages.length;
  em.clickAct('generate');
  const genMsg = /独立模式：生成需要 MCP 桥/.test(em.log.textContent);
  em.clickAct('explore');
  const expMsg = /独立模式：巡检需要 MCP 桥/.test(em.log.textContent);
  em.clickAct('nl');
  check('独立模式：桥依赖分支被守卫拦下（逐分支日志指引 + 零 pv-bridge 发出、不掀翻）',
    genMsg && expMsg && /独立模式：NL 测试需要 MCP 桥/.test(em.log.textContent)
    && em.messages.length === msgsBefore
    && !em.messages.slice(msgsBefore).some((m) => m.type === 'pv-bridge'),
    `msgs +${em.messages.length - msgsBefore} | ${em.log.textContent}`);
  em.clickAct('mode');
  check('切回依赖模式：pv_mode=mcp、按钮解禁、重新探活（往返闭环）',
    em.storageData.pv_mode === 'mcp' && em.byAct('generate').disabled === false
    && em.byAct('explore').disabled === false && em.messages.length > msgsBefore);
  const e2 = makeFloatEnv({ pv_recordings_list: [seed], pv_mode: 'local' });
  check('独立模式持久化恢复：重注入即 local 形态（点位不被重置回 mcp）',
    e2.storageData.pv_mode === 'local' && /pv-local/.test(e2.dot.className)
    && e2.byAct('generate').disabled === true && e2.byAct('export').disabled === false
    && /独立模式/.test(e2.log.textContent),
    e2.log.textContent);
  check('面板高度帽+内滚动（e2e 实测两连坑：帽须按 top:36% 以下剩余空间 64vh 计，100vh 帽盒子仍伸出视口）',
    /\.pv-panel\{[^}]*max-height:calc\(64vh - 24px\);overflow-y:auto;/.test(floatingSrc));
}

/* ================= 收尾 ================= */
console.log('');
console.log(`floating-check：${failures ? `${failures} 项失败` : '全部通过'}`);
process.exit(failures ? 1 : 0);
