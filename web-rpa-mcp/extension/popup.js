/* Web RPA 控制台 — 通过本地桥接服务调用 web-rpa-mcp 的全部工具 */
'use strict';

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

const DEFAULT_BASE = 'http://127.0.0.1:8317';
let BASE = DEFAULT_BASE;

/** 桥接地址归一化：设置输入框与 ?bridge= 参数都可能只给裸端口（"8321"）或 host:port，
 *  原样存进 BASE 会让 fetch 打到 /8321/api/call 这类 404 静默全功能失效——
 *  统一补成完整 origin（裸端口按 127.0.0.1，其余按 http://host）。 */
function normalizeBridgeUrl(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return DEFAULT_BASE;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\d+$/.test(s)) return 'http://127.0.0.1:' + s;
  return 'http://' + s;
}

/* ---------------- 基础工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtMs(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's';
}

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return String(t);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

let toastTimer = null;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = kind || '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hide'), kind === 'err' ? 6000 : 3000);
}

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  const token = await getToken();
  if (token) headers['X-RPA-Token'] = token;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

/* 访问令牌：插件模式存 chrome.storage（rpaToken）；网页版 /console?token=xxx 先存 localStorage 再复用。
 * 未设置（空串）时不带头——桥接未启用 token 时行为逐字节不变。 */
async function getToken() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      const st = await chrome.storage.local.get({ rpaToken: '' });
      return st.rpaToken || '';
    } catch (e) { /* fall through to localStorage（网页版兜底） */ }
  }
  try { return localStorage.getItem('rpaToken') || ''; } catch (e) { return ''; }
}

/* 调用 MCP 工具。失败（isError）时抛错但把 text 挂在异常上，供调用方展示详情。 */
async function tool(name, args) {
  const r = await api('/api/call', { method: 'POST', body: { name, args: args || {} } });
  if (!r.ok) {
    const e = new Error(r.summary || '调用失败');
    e.detail = r.text || JSON.stringify(r.data || {}, null, 2);
    throw e;
  }
  return r;
}

/* 按钮busy态包装：调用期间禁用并显示进行中文案 */
async function withBusy(btn, busyText, fn) {
  if (!btn) return fn();
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function showOut(el, summary, data, cls) {
  if (!el) return;
  el.classList.remove('hide');
  const head = cls === 'err' ? '❌ ' : (cls === 'ok' ? '✅ ' : '');
  el.innerHTML = '<span class="' + (cls || '') + '">' + esc(head + (summary || '')) + '</span>' +
    (data === undefined || data === null ? '' : '\n' + esc(JSON.stringify(data, null, 2)));
}

function parseJsonTextarea(textarea, fallback) {
  const raw = (textarea.value || '').trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('JSON 格式有误：' + e.message); }
}

/* 通用对象数组 -> 小表格 */
function tableHtml(rows, cols) {
  if (!rows || !rows.length) return '<div class="muted">（空）</div>';
  const th = cols.map((c) => '<th>' + esc(c.title) + '</th>').join('');
  const tr = rows.map((r) => '<tr>' + cols.map((c) => {
    const v = typeof c.val === 'function' ? c.val(r) : r[c.val];
    return '<td>' + (v == null || v === '' ? '—' : v) + '</td>';
  }).join('') + '</tr>').join('');
  return '<table class="mini"><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>';
}

function statusBadge(s) {
  const k = s == null || s === '' ? 'none' : String(s);
  return '<span class="badge ' + esc(k) + '">' + esc(k) + '</span>';
}

/* ---------------- 连接与设置 ---------------- */

async function connect() {
  const dot = $('#conn-dot');
  const text = $('#conn-text');
  dot.className = 'dot';
  text.textContent = '连接中…';
  try {
    const h = await api('/health');
    if (h.ok && h.mcp && h.mcp.ready) {
      dot.className = 'dot ok';
      text.textContent = '已连接 · MCP v' + (h.mcp.serverInfo && h.mcp.serverInfo.version) + ' · ' + h.mcp.toolCount + ' 个工具';
      return h;
    }
    dot.className = 'dot bad';
    text.textContent = '桥接在，MCP 未就绪';
    toast('桥接服务在，但 MCP 服务器没起来：' + ((h.mcp && h.mcp.error) || '未知'), 'err');
  } catch (e) {
    dot.className = 'dot bad';
    text.textContent = '未连接';
    toast('连不上桥接服务（' + BASE + '）：先在仓库目录执行 node mcp/bridge.mjs', 'err');
  }
  return null;
}

async function loadSettings() {
  // URL 参数优先（跨端口跳转时 localStorage 按 origin 隔离读不到旧值——跳转把 bridge/token 带在
  // URL 上，目标页落地后写入本 origin 的 localStorage，此后与插件模式同链路）
  try {
    const sp = new URLSearchParams(location.search);
    const urlToken = sp.get('token');
    if (urlToken) { localStorage.setItem('rpaToken', urlToken); }
    const urlBridge = sp.get('bridge');
    if (urlBridge) { localStorage.setItem('bridgeUrl', normalizeBridgeUrl(urlBridge)); }
  } catch (e) { /* ignore */ }
  try {
    const st = await chrome.storage.local.get({ bridgeUrl: DEFAULT_BASE, rpaToken: '' });
    BASE = normalizeBridgeUrl(st.bridgeUrl || DEFAULT_BASE);
    $('#rpa-token').value = st.rpaToken || '';
    try { localStorage.setItem('bridgeUrl', BASE); } catch (e) { /* ignore */ } // 网页版兜底同步
  } catch (e) {
    // 网页版无 chrome API：localStorage 兜底（与 rpaToken 同款）——否则 bridgeUrl 不可配置、
    // 改过桥接端口后页面永远连默认端口（Origin 校验 403 全功能失败）。
    // 默认值优先取 location.origin：/console 由桥接本身托管（如悬浮球 🩵 打开 8324/console）时，
    // 空 localStorage 若回落硬编码 8317 会「看着连着、实际打到别的桥接」（新旧代码行为分歧的根源，
    // 观察期实锤：8324 新代码页面静默调用 8317 旧子进程）；非桥接托管场景仍用 DEFAULT_BASE。
    const servedByBridge = /^127\.0\.0\.1:|^localhost:/i.test(location.host) && location.origin && location.origin !== 'null';
    try { BASE = normalizeBridgeUrl(localStorage.getItem('bridgeUrl') || (servedByBridge ? location.origin : DEFAULT_BASE)); } catch (e2) { BASE = DEFAULT_BASE; }
    try { $('#rpa-token').value = localStorage.getItem('rpaToken') || ''; } catch (e2) { /* ignore */ }
  }
  $('#bridge-url').value = BASE;
}

async function saveSettings() {
  const url = normalizeBridgeUrl($('#bridge-url').value);
  const token = $('#rpa-token').value;
  BASE = url;
  try { localStorage.setItem('rpaToken', token); localStorage.setItem('bridgeUrl', url); } catch (e) { /* ignore */ } // 网页版兜底（插件模式无害）
  try { await chrome.storage.local.set({ bridgeUrl: url, rpaToken: token }); } catch (e) { /* ignore */ }
  // 网页版：保存后若桥接地址与当前页面不同源，直接跳过去——否则本页 fetch 仍走旧端口，
  // 被桥接 Origin 校验 403，永远显示未连接（实锤：设置改端口后不刷新页面就死循环连不上）
  if (isWebMode()) {
    try {
      const b = new URL(BASE);
      if (location.host !== b.host) {
        // localStorage 按 origin 隔离：跨端口后新 origin 读不到旧值会跳回默认端口死循环——
        // 把 bridge 带在 URL 参数上传给目标页（落地后写入新 origin 的 localStorage 收敛）
        const sp = new URLSearchParams(location.search);
        sp.set('bridge', BASE);
        location.replace(b.origin + '/console?' + sp.toString());
        return;
      }
    } catch (e) { /* BASE 非法时交给 connect 报错 */ }
  }
  $('#settings-msg').textContent = '已保存，正在重连…';
  await connect();
  $('#settings-msg').textContent = '';
  initTab(currentTab, true);
}

/* ---------------- 插拔式双模：运行模式横幅 + 本地流程（独立模式） ---------------- */

async function renderModeBanner() {
  const body = $('#mode-body');
  if (!body) return;
  try {
    const h = await api('/health');
    if (h && h.ok && h.mcp && h.mcp.ready) {
      body.innerHTML = '<span class="ok">● 依赖 MCP 模式</span>：桥接 ' + esc(location.host) +
        ' · MCP v' + esc((h.mcp.serverInfo && h.mcp.serverInfo.version) || '?') +
        ' —— 全部 44 工具可用（录制/回放/定时/告警/凭据…）。' +
        '断开桥接即自动回落独立模式（本地录制回放仍可用）。';
    } else {
      body.innerHTML = '<span class="err">● 独立模式</span>：桥接未连接——本地录制/回放/导出/升级流程照常可用（不依赖 MCP）。' +
        '要解锁完整功能：终端跑 <code>node mcp/bridge.mjs</code>，然后在「系统」页把桥接地址填 <code>http://127.0.0.1:8317</code> 保存。';
    }
  } catch (e) {
    body.innerHTML = '<span class="err">● 独立模式</span>：' + esc(String(e.message || e).slice(0, 100)) + '（本地功能不受影响）';
  }
}

async function bridgeHealthy() {
  try { const h = await api('/health'); return !!(h && h.ok && h.mcp && h.mcp.ready); } catch (e) { return false; }
}

async function renderLocalFlows() {
  const body = $('#local-flows-body');
  const count = $('#local-flows-count');
  if (!body) return;
  window.RpaStandalone.listLocal(async (flows) => {
    if (count) count.textContent = flows.length + ' 条 · 存浏览器本地';
    if (!flows.length) {
      body.className = 'muted';
      body.textContent = '还没有本地流程。悬浮球面板「🎬 本地录制当前页」录一段即出现在这里（也可在网页版 /console 的悬浮球上录）。';
      return;
    }
    const dep = await bridgeHealthy();
    body.className = '';
    body.innerHTML = '';
    flows.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'row local-flow-row';
      row.style.marginBottom = '6px';
      const name = document.createElement('span');
      name.style.flex = '1';
      name.innerHTML = '<b>' + esc(f.name || f.id) + '</b> <span class="muted">' + (f.steps || []).length + ' 步 · ' + esc(String(f.startUrl || '').slice(0, 40)) + '</span>';
      row.appendChild(name);
      const mk = (label, title, fn) => {
        const b = document.createElement('button');
        b.className = 'small'; b.textContent = label; if (title) b.title = title;
        b.addEventListener('click', fn);
        row.appendChild(b);
        return b;
      };
      mk('▶ 回放到当前标签', '向当前活动标签页的悬浮球发独立回放指令', async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab || !tab.id) { toast('没有活动标签页', 'err'); return; }
          chrome.tabs.sendMessage(tab.id, { type: 'rpa-local-replay', flowId: f.id }, (r) => {
            if (chrome.runtime.lastError) { toast('当前标签没有悬浮球（刷新页面后重试）', 'err'); return; }
            toast(r && r.ok ? '✅ 独立回放完成（' + r.done + '/' + r.total + '）' : '❌ ' + ((r && r.error) || '回放失败'), r && r.ok ? 'ok' : 'err');
          });
        } catch (e) { toast(String(e.message || e), 'err'); }
      });
      mk('导出', '下载本地流程 JSON（可留档或另行导入）', () => {
        const blob = new Blob([JSON.stringify(f, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (f.id || 'local-flow') + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
        toast('已导出 ' + (f.id || 'local-flow') + '.json', 'ok');
      });
      const up = mk('升级到 MCP', '把本地流程映射为 MCP 流程 DSL 并 flow_import（需桥接）', async () => {
        if (!dep) { toast('桥接未连接——先启动 node mcp/bridge.mjs', 'err'); return; }
        try {
          const flow = window.RpaStandalone.toMcpFlow(f, f.startUrl);
          const r = await tool('flow_import', { flow, overwrite: true });
          toast('✅ 已升级到 MCP 流程：' + f.id + '（' + ((r.data && r.data.stepCount) || flow.steps.length) + ' 步）——上方 MCP 列表可见', 'ok');
          if (currentTab === 'flows') refreshFlows();
        } catch (e) { toast(String(e.message || e), 'err'); }
      });
      if (!dep) up.classList.add('ghost');
      mk('🗑', '删除本地流程', () => {
        if (!window.confirm('删除本地流程「' + (f.name || f.id) + '」？')) return;
        window.RpaStandalone.deleteLocal(f.id, () => { toast('已删除', 'ok'); renderLocalFlows(); });
      });
      body.appendChild(row);
    });
  });
}

/* ---------------- 页签切换 ---------------- */

let currentTab = 'status';
const tabInited = new Set();

function switchTab(name) {
  currentTab = name;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((s) => s.classList.toggle('on', s.id === 'tab-' + name));
  if (name !== 'record') stopRecordPolling();
  if (name !== 'status') stopRunningPolling();
  initTab(name, false);
}

function initTab(name, force) {
  if (tabInited.has(name) && !force) {
    if (name === 'record') startRecordPolling();
    if (name === 'status') startRunningPolling();
    return;
  }
  tabInited.add(name);
  if (name === 'status') { refreshHealth(); renderModeBanner(); startRunningPolling(); }
  if (name === 'record') { startRecordPolling(); refreshFlowSelects(); }
  if (name === 'flows') { refreshFlows(); renderLocalFlows(); }
  if (name === 'schedule') { refreshSchedules(); refreshFlowSelects(); }
  if (name === 'console') refreshToolList();
}

/* ---------------- 运行中回放 live 进度（状态页 3s 轮询；离开页签即停） ----------------
 * 数据源：status_report 的 items[].running（active marker：pid 活=进行中）与 waitingHuman
 * （humanHandoff 等待窗口）。report.json 收尾才写，运行中没有步骤级明细——
 * 显示「流程名/触发/pid/已运行时长/等待人工」是 marker 能诚实支持的粒度，不假装步骤进度。 */
let runningPollTimer = null;
let runningPollBusy = false;

function stopRunningPolling() { if (runningPollTimer) { clearInterval(runningPollTimer); runningPollTimer = null; } }
function startRunningPolling() {
  refreshRunning();
  stopRunningPolling();
  runningPollTimer = setInterval(refreshRunning, 3000);
}

async function refreshRunning() {
  if (runningPollBusy) return;
  runningPollBusy = true;
  try {
    const r = await tool('status_report', { onlyProblems: false });
    const items = (r.data && r.data.items) || [];
    const running = items.filter((i) => i.running);
    const body = $('#running-body');
    $('#running-when').textContent = '3s 自动刷新';
    if (!running.length) {
      body.className = 'muted';
      body.textContent = '当前没有运行中的回放。启动 flow_run 后这里会实时显示。';
      return;
    }
    body.className = '';
    body.innerHTML = running.map((i) => {
      const since = i.running && i.running.since ? new Date(i.running.since) : null;
      const durSec = since && !isNaN(since.getTime()) ? Math.round((Date.now() - since.getTime()) / 1000) : null;
      const st = i.running && i.running.step;
      const stepTxt = st && st.index
        ? ' · 第 ' + st.index + '/' + st.total + ' 步 · ' + (OP_LABEL[st.op] || st.op)
        : '';
      const wh = i.waitingHuman;
      return '<div class="erow"><span class="elabel"><b>▶ 运行中：' + esc(i.name || i.flowId) + '</b>' +
        ' <span class="muted">· ' + esc((i.running && i.running.trigger) || '—') +
        ' · pid ' + esc((i.running && i.running.pid) || '?') + esc(stepTxt) +
        (durSec !== null ? ' · 已运行 ' + (durSec >= 60 ? Math.floor(durSec / 60) + 'm' + (durSec % 60) + 's' : durSec + 's') : '') +
        '</span>' + (wh ? '<br><span class="muted">⏸ 正在等待人工接管：' + esc(wh.reason || '需要人工') + (wh.until ? '（截止 ' + esc(wh.until) + '）' : '') + '</span>' : '') +
        '</span></div>';
    }).join('');
  } catch (e) {
    const body = $('#running-body');
    body.className = 'muted';
    body.textContent = '运行中查询失败：' + e.message;
  } finally {
    runningPollBusy = false;
  }
}

/* ---------------- 状态页 ---------------- */

async function refreshHealth() {
  const el = $('#health-body');
  el.textContent = '加载中…';
  try {
    const h = await connect();
    if (!h) { el.innerHTML = '<span class="err">桥接不可达。点右上角 ⚙ 检查桥接地址；或启动服务：<code>node mcp/bridge.mjs</code></span>'; return; }
    const b = h.bridge || {}, m = h.mcp || {};
    el.innerHTML = tableHtml([{}], [
      { title: '桥接版本', val: () => esc(b.version) },
      { title: '端口', val: () => esc(b.port) },
      { title: '运行时长', val: () => esc(fmtMs((b.uptimeSec || 0) * 1000)) },
    ]) + tableHtml([{}], [
      { title: 'MCP 版本', val: () => esc(m.serverInfo && m.serverInfo.version) },
      { title: '工具数', val: () => esc(m.toolCount) },
      { title: 'pid', val: () => esc(m.pid) },
    ]);
  } catch (e) {
    el.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
}

async function runDoctor() {
  await withBusy($('#btn-doctor'), '自检中…', async () => {
    try {
      const r = await tool('doctor', {});
      showOut($('#doctor-out'), r.summary, r.data, r.data && r.data.problems && r.data.problems.length ? 'err' : 'ok');
    } catch (e) { showOut($('#doctor-out'), e.message, null, 'err'); }
  });
}

async function runStatusReport() {
  await withBusy($('#btn-status-report'), '查询中…', async () => {
    const out = $('#sr-out');
    try {
      const r = await tool('status_report', { onlyProblems: $('#sr-only-problems').checked });
      const flows = (r.data && r.data.items) || [];
      out.innerHTML =
        '<p class="muted">' + esc(r.summary) + '</p>' +
        tableHtml(flows, [
          { title: '流程', val: (f) => esc(f.name || f.flowId) },
          { title: '总次数', val: (f) => esc(f.totalRuns) },
          { title: '最后状态', val: (f) => statusBadge(f.lastStatus) },
          { title: '连败', val: (f) => f.consecutiveFailures ? '<b style="color:#dc2626">' + esc(f.consecutiveFailures) + '</b>' : '0' },
          { title: '最后运行', val: (f) => esc(fmtTime(f.lastRunAt)) },
          { title: '中断', val: (f) => f.interrupted ? '⚠' : '' },
          { title: '定时', val: (f) => f.scheduled ? '已配' : '—' },
        ]) +
        '<pre class="out">' + esc(JSON.stringify((r.data && r.data.problems) || [], null, 2)) + '</pre>';
    } catch (e) {
      out.innerHTML = '<pre class="out err">' + esc(e.message) + '</pre>';
    }
  });
}

/* ---------------- 录制页 ---------------- */

let recordPollTimer = null;
let recordPollBusy = false;
/* 本页发起的录制会话 id（sessionStorage，页面生命周期）——录制器被其他会话占用时
 * 只观察不干预（与悬浮球 v1.4.0 的 mySession 同款防护：⏹/✕ 作用于全局录制器，
 * 误点会结束别人的会话）。刷新页面后标记丢失→保守显示外部会话提示，不提供干预。 */
function myRecSession() {
  try { return sessionStorage.getItem('myRecSession') || ''; } catch (e) { return ''; }
}
function setMyRecSession(id) {
  try { if (id) sessionStorage.setItem('myRecSession', id); else sessionStorage.removeItem('myRecSession'); } catch (e) { /* ignore */ }
}

function startRecordPolling() {
  pollRecordStatus();
  stopRecordPolling();
  recordPollTimer = setInterval(pollRecordStatus, 3000);
}
function stopRecordPolling() {
  if (recordPollTimer) { clearInterval(recordPollTimer); recordPollTimer = null; }
}

async function pollRecordStatus() {
  if (recordPollBusy) return;
  recordPollBusy = true;
  try {
    const r = await tool('record_status', {});
    renderRecordStatus(r.data || {});
  } catch (e) {
    renderRecordStatus({});
  } finally {
    recordPollBusy = false;
  }
}

function renderRecordStatus(s) {
  const live = $('#rec-live'), idle = $('#rec-idle'), stopCard = $('#rec-stop-card');
  const hideStop = () => { if (stopCard) stopCard.style.display = 'none'; };
  const showStop = () => { if (stopCard) stopCard.style.display = ''; };
  if (s.recording && myRecSession() !== (s.sessionId || '')) {
    // 录制器被其他会话占用（如别处发起的片段重录）：只观察不干预——
    // ⏹/✕ 作用于全局录制器，误点会结束别人的会话（与悬浮球 v1.4.0 同款防护）
    live.style.display = '';
    idle.style.display = 'none';
    hideStop();
    $('#rec-mode').textContent = '（其他会话）';
    $('#rec-steps-count').textContent = '外部会话录制中';
    $('#rec-live-steps').textContent = '⏳ 检测到其他会话正在录制（' + (s.mode || '录制中') + '，已 ' + (s.stepCount || 0) + ' 步）。本页未发起，不提供结束/取消；要干预请到发起处操作。';
    $('#rec-live-notes').innerHTML = '<div class="hint">发起录制后本页可结束/取消/查看步骤；他人录制期间无法并行录制。</div>';
    return;
  }
  if (s.recording) {
    live.style.display = '';
    idle.style.display = 'none';
    showStop();
    $('#rec-mode').textContent = s.mode ? '（' + s.mode + '）' : '';
    $('#rec-steps-count').textContent = '已记录 ' + (s.stepCount || 0) + ' 步';
    $('#rec-live-steps').textContent = (s.steps || []).join('\n') || '（还没有步骤，去浏览器窗口里操作）';
    const notes = s.notes || [];
    $('#rec-live-notes').innerHTML = notes.length
      ? '<div class="hint">⚠ 提醒：' + notes.map(esc).join('；') + '</div>'
      : '';
  } else {
    setMyRecSession('');
    live.style.display = 'none';
    idle.style.display = '';
    hideStop();
  }
}

async function startRecording() {
  const url = $('#rec-url').value.trim();
  if (!url) { toast('请填写起始网址', 'err'); return; }
  const args = { url };
  const name = $('#rec-name').value.trim();
  if (name) args.name = name;
  const vw = parseInt($('#rec-vw').value, 10), vh = parseInt($('#rec-vh').value, 10);
  if (vw > 0 && vh > 0) args.viewport = { width: vw, height: vh };
  await withBusy($('#btn-record-start'), '打开录制窗口…', async () => {
    try {
      const r = await tool('record_start', args);
      toast(r.summary || '录制已开始', 'ok');
      if (r.data && r.data.sessionId) setMyRecSession(r.data.sessionId);
      renderRecordStatus(r.data && r.data.ok !== false ? Object.assign({ recording: true }, r.data) : {});
      pollRecordStatus();
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function stopRecording() {
  const args = {};
  const name = $('#rec-stop-name').value.trim();
  if (name) args.name = name;
  await withBusy($('#btn-record-stop'), '生成技能中…', async () => {
    try {
      const r = await tool('record_stop', args);
      setMyRecSession('');
      const d = r.data || {};
      const lint = d.lint || {};
      showOut($('#rec-stop-out'),
        (r.summary || '已生成') + '，flowId=' + (d.flowId || '?'),
        { 步骤: d.steps, 断言: d.assertions, 自动变量: d.autoVariables, 建议参数: d.paramSuggestions, 静态检查: lint, 下一步: d.next },
        lint.errors && lint.errors.length ? 'err' : 'ok');
      toast(r.summary || '技能已生成', 'ok');
      pollRecordStatus();
      tabInited.delete('flows');
    } catch (e) {
      showOut($('#rec-stop-out'), e.message, e.detail ? safeParse(e.detail) : null, 'err');
      toast(e.message, 'err');
    }
  });
}

function safeParse(text) {
  const i = text.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i)); } catch (e) { return null; }
}

async function cancelRecording() {
  if (!confirm('确定取消当前录制？已记录的步骤会全部丢弃。')) return;
  await withBusy($('#btn-record-cancel'), '取消中…', async () => {
    try {
      const r = await tool('record_cancel', {});
      setMyRecSession('');
      toast(r.summary || '已取消', 'ok');
      pollRecordStatus();
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function startSplice() {
  const flowId = $('#splice-flow').value;
  const from = parseInt($('#splice-from').value, 10);
  if (!flowId) { toast('请选择流程', 'err'); return; }
  if (!(from >= 1)) { toast('请填写从第几步开始', 'err'); return; }
  const args = { flowId, from };
  const to = parseInt($('#splice-to').value, 10);
  if (to >= 1) args.to = to;
  args.keepSuffix = $('#splice-keep-suffix').checked;
  try { args.params = parseJsonTextarea($('#splice-params'), undefined); }
  catch (e) { toast(e.message, 'err'); return; }
  await withBusy($('#btn-splice-start'), '重放前缀中…', async () => {
    try {
      const r = await tool('record_splice_start', args);
      // 记住本页发起的会话 id：否则自己的片段重录会被 renderRecordStatus 判成「外部会话」，
      // 停止/取消按钮永不出现（popup 发起却无法从 popup 停止——观察轮实锤的产品 bug）
      if (r.data && r.data.sessionId) setMyRecSession(r.data.sessionId);
      toast(r.summary || '片段重录已开始', 'ok');
      pollRecordStatus();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ---------------- 流程页 ---------------- */

async function refreshFlows() {
  const list = $('#flows-list');
  try {
    const r = await tool('flow_list', {});
    const flows = (r.data && r.data.flows) || [];
    $('#flows-count').textContent = '共 ' + flows.length + ' 个';
    list.innerHTML = flows.map(flowCardHtml).join('') || '<div class="card muted">还没有流程。切到「录制」页录一个。</div>';
    flows.forEach((f) => wireFlowCard(f));
    await refreshFlowSelects();
  } catch (e) {
    list.innerHTML = '<div class="card muted">' + esc(e.message) + '</div>';
  }
}

function flowCardHtml(f) {
  return '<details class="card flow-card" data-flow="' + esc(f.id) + '">' +
    '<summary><span class="fname">' + esc(f.name) + '</span>' +
    '<span class="fmeta">' + esc(f.id) + ' · ' + f.stepCount + ' 步 / ' + f.paramCount + ' 变量 / ' + f.assertionCount + ' 断言 · 更新于 ' + esc(fmtTime(f.updatedAt)) + '</span></summary>' +
    '<div class="acts">' +
    '<button class="primary act-run">▶ 回放</button>' +
    '<button class="act-preflight">预检</button>' +
    '<button class="act-lint">静态检查</button>' +
    '<button class="act-show">步骤清单</button>' +
    '<button class="act-history">运行历史</button>' +
    '<button class="act-report">最新报告</button>' +
    '<button class="act-export">导出</button>' +
    '<button class="act-restore">备份/回滚</button>' +
    '<button class="act-edit">变量/断言/步骤</button>' +
    '<button class="act-rename">重命名</button>' +
    '<button class="danger act-delete">删除</button>' +
    '</div>' +
    '<div class="run-area hide">' +
    '<label>变量 params JSON<textarea class="run-params" rows="2">{}</textarea></label>' +
    '<div class="row">' +
    '<label class="chk"><input type="checkbox" class="run-headed"> 显示浏览器窗口</label>' +
    '<label class="chk"><input type="checkbox" class="run-allow-lint"> 忽略阻断项强制运行</label>' +
    '<label class="chk"><input type="checkbox" class="run-learn" checked> 自愈后回写流程</label>' +
    '<label>总时限 ms<input class="run-maxms" type="number" min="0" placeholder="不限"></label>' +
    '</div>' +
    '<div class="row"><button class="primary run-go">▶ 开始回放</button>' +
    '<span class="muted">回放可能持续几分钟；关闭本窗口不会中断执行，结果稍后用「运行历史」查看。</span></div>' +
    '</div>' +
    '<div class="edit-area hide"></div>' +
    '<pre class="out hide"></pre>' +
    '</details>';
}

function cardOf(btn) { return btn.closest('.flow-card'); }
function flowIdOf(btn) { return cardOf(btn).dataset.flow; }
function outOf(btn) { return $('.out', cardOf(btn)); }

async function refreshFlowSelects() {
  let flows = [];
  try {
    const r = await tool('flow_list', {});
    flows = (r.data && r.data.flows) || [];
  } catch (e) { return; }
  const options = flows.map((f) => '<option value="' + esc(f.id) + '">' + esc(f.name) + '（' + esc(f.id) + '）</option>').join('');
  for (const sel of [$('#splice-flow'), $('#sched-flow')]) {
    const cur = sel.value;
    sel.innerHTML = options || '<option value="">（还没有流程）</option>';
    if (cur && flows.some((f) => f.id === cur)) sel.value = cur;
  }
}

function wireFlowCard(f) {
  const card = $('[data-flow="' + CSS.escape(f.id) + '"]', $('#flows-list'));
  if (!card) return;

  $('.act-run', card).addEventListener('click', () => {
    const area = $('.run-area', card);
    area.classList.toggle('hide');
  });

  $('.run-go', card).addEventListener('click', (ev) => {
    const args = { flowId: f.id };
    try { args.params = parseJsonTextarea($('.run-params', card), undefined); } catch (e) { toast(e.message, 'err'); return; }
    if (args.params === undefined) delete args.params;
    if ($('.run-headed', card).checked) args.headed = true;
    if ($('.run-allow-lint', card).checked) args.allowLintErrors = true;
    if (!$('.run-learn', card).checked) args.learn = false;
    const maxms = parseInt($('.run-maxms', card).value, 10);
    if (maxms > 0) args.maxDurationMs = maxms;
    withBusy(ev.target, '回放中…（可以关掉窗口，不中断）', async () => {
      try {
        const r = await tool('flow_run', args);
        renderRunResult(outOf(ev.target), r);
        toast((r.summary || '').slice(0, 80), r.data && r.data.status === 'pass' ? 'ok' : 'err');
      } catch (e) { renderRunResult(outOf(ev.target), { summary: e.message, data: safeParse(e.detail || ''), isError: true }); toast(e.message, 'err'); }
    });
  });

  $('.act-preflight', card).addEventListener('click', (ev) => {
    withBusy(ev.target, '预检中…', async () => {
      try {
        const r = await tool('flow_preflight', { flowId: f.id });
        const steps = (r.data && r.data.steps) || [];
        showOut(outOf(ev.target), r.summary, steps.map((s) =>
          (s.checked ? (s.resolvable ? '✓' : '✗ 找不到元素') : '· 跳过') + ' 第' + s.index + '步 ' + (s.label || s.op || '')), null);
      } catch (e) { showOut(outOf(ev.target), e.message, null, 'err'); }
    });
  });

  $('.act-lint', card).addEventListener('click', (ev) => {
    withBusy(ev.target, '检查中…', async () => {
      try {
        const r = await tool('flow_lint', { flowId: f.id });
        const d = r.data || {};
        const lines = [].concat((d.errors || []).map((x) => '⛔ ' + JSON.stringify(x)),
          (d.warnings || []).map((x) => '⚠ ' + JSON.stringify(x)));
        showOut(outOf(ev.target), r.summary, lines.length ? lines.join('\n') : '（没有问题）',
          (d.errors || []).length ? 'err' : 'ok');
      } catch (e) { showOut(outOf(ev.target), e.message, null, 'err'); }
    });
  });

  $('.act-show', card).addEventListener('click', (ev) => {
    withBusy(ev.target, '读取中…', async () => {
      try {
        const r = await tool('flow_show', { flowId: f.id });
        const el = outOf(ev.target);
        el.classList.remove('hide');
        el.innerHTML = '<span class="ok">' + esc(r.summary) + '</span>\n' +
          esc((r.data && r.data.markdown) || '') +
          ((r.data && r.data.params && r.data.params.length) ? '\n\n—— 变量 ——\n' + esc(JSON.stringify(r.data.params, null, 2)) : '');
      } catch (e) { showOut(outOf(ev.target), e.message, null, 'err'); }
    });
  });

  $('.act-history', card).addEventListener('click', (ev) => {
    withBusy(ev.target, '读取中…', async () => {
      try {
        const r = await tool('run_history', { flowId: f.id, limit: 15 });
        const runs = (r.data && r.data.runs) || [];
        // 历史表格放进独立容器插在 .out 之后，绝不替换/销毁 .out（其它按钮的输出还靠它）
        const old = $('.runs-table', card);
        if (old) old.remove();
        outOf(ev.target).insertAdjacentHTML('afterend',
          '<div class="runs-table"><p class="muted">' + esc(r.summary) + '</p>' +
          tableHtml(runs, [
            { title: '时间', val: (x) => esc(fmtTime(x.startedAt || x.stamp)) },
            { title: '状态', val: (x) => statusBadge(x.status) },
            { title: '耗时', val: (x) => esc(fmtMs(x.durationMs)) },
            { title: '触发', val: (x) => esc(x.trigger || '—') },
            { title: '自愈', val: (x) => esc(x.healedCount || x.healed || 0) },
            { title: '失败步', val: (x) => esc(x.failedStep || '—') },
          ]) + '</div>');
      } catch (e) { showOut(outOf(ev.target), e.message, null, 'err'); }
    });
  });

  $('.act-report', card).addEventListener('click', (ev) => {
    withBusy(ev.target, '读取中…', async () => {
      try {
        const r = await tool('run_report', { flowId: f.id });
        const d = r.data || {};
        // 摘要补透出归因/最终页（v1.9.6：观察期实锤「报告摘要 6 字段里没有归因」——
        // 风控重定向类失败在报告摘要里看不到线索，得去控制台原始调用才看得见；空值不显示不添噪音）
        const digest = { 状态: d.status, 步骤数: d.steps && d.steps.length, 错误: d.error };
        if (d.attribution) digest['归因'] = d.attribution;
        if (d.finalUrl) digest['最终页'] = d.finalUrl;
        digest['报告'] = d.reportPath;
        digest['截图'] = d.screenshots;
        showOut(outOf(ev.target), r.summary, digest, null);
      } catch (e) { showOut(outOf(ev.target), e.message, null, 'err'); }
    });
  });

  $('.act-export', card).addEventListener('click', async (ev) => {
    withBusy(ev.target, '导出中…', async () => {
      try {
        const r = await tool('flow_export', { flowId: f.id });
        const json = (r.data && typeof r.data.json === 'string') ? r.data.json : JSON.stringify(r.data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = f.id + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
        await navigator.clipboard.writeText(json).catch(() => {});
        toast('已下载 ' + f.id + '.json（并复制到剪贴板）', 'ok');
      } catch (e) { showOut(outOf(ev.target), e.message, null, 'err'); }
    });
  });

  $('.act-restore', card).addEventListener('click', (ev) => {
    withBusy(ev.target, '查询中…', async () => {
      try {
        const r = await tool('flow_restore', { flowId: f.id, list: true });
        const backups = (r.data && r.data.backups) || [];
        showOut(outOf(ev.target), r.summary, backups.map((b) => b.stamp || b.name || b).join('\n') || null, null);
        if (backups.length && confirm('共 ' + backups.length + ' 份备份。确定回滚到最近一次备份？')) {
          const r2 = await tool('flow_restore', { flowId: f.id });
          showOut(outOf(ev.target), r2.summary, r2.data, 'ok');
          toast(r2.summary, 'ok');
        }
      } catch (e) { showOut(outOf(ev.target), e.message, null, 'err'); }
    });
  });

  $('.act-rename', card).addEventListener('click', async (ev) => {
    const name = prompt('新的显示名称（id 不变）', f.name);
    if (!name || name === f.name) return;
    withBusy(ev.target, '改名中…', async () => {
      try {
        const r = await tool('flow_rename', { flowId: f.id, name });
        toast(r.summary, 'ok');
        refreshFlows();
      } catch (e) { toast(e.message, 'err'); }
    });
  });

  $('.act-delete', card).addEventListener('click', async (ev) => {
    if (!confirm('确定删除流程「' + f.name + '」（' + f.id + '）及其全部运行记录？')) return;
    if (!confirm('再次确认：删除后要用最近备份才能恢复，确定？')) return;
    withBusy(ev.target, '删除中…', async () => {
      try {
        await tool('flow_delete', { flowId: f.id });
        toast('已删除 ' + f.id, 'ok');
        refreshFlows();
      } catch (e) { toast(e.message, 'err'); }
    });
  });

  $('.act-edit', card).addEventListener('click', () => {
    const area = $('.edit-area', card);
    if (!area.classList.contains('hide')) { area.classList.add('hide'); return; }
    area.classList.remove('hide');
    loadEditor(f, card, area, 'step');
  });
}

/* ---------------- 流程编辑器（结构化：列表化渲染 + 行内操作，替代手填序号） ---------------- */

/* 与 mcp/lib/store.mjs 的 OP_LABEL/locHint/stepLabel 同口径（客户端渲染，不臆造格式） */
const OP_LABEL = {
  goto: '打开网址', click: '点击', clickAndDownload: '点击并下载', fill: '填入', select: '选择',
  check: '勾选', press: '按键', setInputFiles: '上传文件', waitFor: '等待元素', waitForText: '等待文字',
  humanHandoff: '人工接管', screenshot: '截图', extract: '取值', download: '等待下载', assert: '校验',
  chain: '串联流程', hover: '悬停', scrollIntoView: '滚动到可见', sleep: '等待', dialog: '处理弹窗', scrollTo: '滚动页面',
};
function locHint(s) {
  const l = (s.locators || [])[0];
  if (!l) return '(无定位符)';
  return l.strategy + '=' + String(l.value).slice(0, 60) + (l.name ? ' "' + l.name + '"' : '');
}
function stepLabel(s, idx) {
  const n = (idx + 1) + '. ';
  const op = OP_LABEL[s.op] || s.op;
  switch (s.op) {
    case 'goto': return n + op + ' ' + (s.url || s.locator || '');
    case 'click': case 'hover': case 'scrollIntoView':
      return n + op + ' ' + locHint(s) + (s.optional ? ' [可跳过]' : '') + (s.waitForNav ? ' [等导航]' : '') + (s.expectDownload ? ' [下载]' : '');
    case 'fill': return n + op + ' ' + locHint(s) + ' = ' + (s.sensitive ? '******' : JSON.stringify(s.value));
    case 'select': return n + op + ' ' + locHint(s) + ' -> ' + (s.label || s.value);
    case 'check': return n + (s.checked === false ? '取消勾选' : '勾选') + ' ' + locHint(s);
    case 'press': return n + op + ' ' + (s.key || 'Enter') + ' ' + locHint(s);
    case 'setInputFiles': return n + op + ' ' + locHint(s) + ' <- ' + (s.path || (s.fileNames || []).join(','));
    case 'waitFor': return n + op + ' ' + locHint(s) + ' state=' + (s.state || 'visible');
    case 'waitForText': return n + op + ' 出现文字 ' + JSON.stringify(s.text);
    case 'humanHandoff': return n + '人工接管（' + (s.reason || '需要人工') + '，最多 ' + Math.round((s.timeoutMs || 180000) / 1000) + 's）';
    case 'screenshot': return n + op + ' ' + (s.name || 'evidence');
    case 'extract': return n + op + ' ' + locHint(s) + ' as ' + (s.as || '?');
    case 'download': return n + op + ' 保存到 ' + (s.saveAs || '(自动)');
    case 'assert': return n + op + ' [' + (s.kind || '?') + '] ' + (s.message || '');
    case 'chain': return n + op + ' ' + (s.flow || '?') + ' ' + (s.params ? JSON.stringify(s.params) : '');
    case 'sleep': return n + op + ' ' + (s.ms || 1000) + 'ms';
    case 'dialog': return n + op + '：' + (s.accept === false ? '取消' : '接受') + '下一个浏览器弹窗';
    case 'scrollTo': return n + op + ' 到' + (s.to === 'top' ? '顶部' : '底部') + (s.times ? ' x' + s.times : '');
    default: return n + op + ' ' + JSON.stringify(s).slice(0, 100);
  }
}

/* 编辑器内的一次工具调用：成功后整编辑器重载（列表与卡片元信息同源刷新） */
async function editorOp(f, card, area, sub, toolName, args) {
  try {
    const r = await tool(toolName, args);
    showOut($('.out', card), r.summary, r.data, 'ok');
    await loadEditor(f, card, area, sub);
  } catch (e) {
    showOut($('.out', card), e.message, safeParse(e.detail || ''), 'err');
  }
}

async function loadEditor(f, card, area, curSub) {
  area.innerHTML = '<div class="muted">加载中…</div>';
  let flow;
  try {
    const r = await tool('flow_show', { flowId: f.id, format: 'json' });
    flow = r.data;
  } catch (e) {
    area.innerHTML = '<div class="muted">' + esc(e.message) + '</div>';
    return;
  }
  const steps = flow.steps || [], params = flow.params || [], assertions = flow.assertions || [];
  const meta = $('.fmeta', card);
  if (meta) meta.textContent = f.id + ' · ' + steps.length + ' 步 / ' + params.length + ' 变量 / ' + assertions.length + ' 断言 · 更新于 ' + fmtTime(flow.updatedAt);

  area.innerHTML =
    '<div class="subtabs">' +
    '<button data-sub="step">步骤（' + steps.length + '）</button>' +
    '<button data-sub="param">变量（' + params.length + '）</button>' +
    '<button data-sub="assert">断言（' + assertions.length + '）</button>' +
    '</div>' +
    '<div class="sub sub-step"></div>' +
    '<div class="sub sub-param hide"></div>' +
    '<div class="sub sub-assert hide"></div>' +
    '<div class="hint">改动前自动备份（flow_restore 可回滚）；步骤「改」是合并 patch：只覆盖传入字段。</div>';

  const subBtns = $$('.subtabs button', area);
  function show(sub) {
    subBtns.forEach((x) => x.classList.toggle('on', x.dataset.sub === sub));
    $$('.sub', area).forEach((s) => s.classList.add('hide'));
    $('.sub-' + sub, area).classList.remove('hide');
  }
  subBtns.forEach((b) => b.addEventListener('click', () => show(b.dataset.sub)));
  show(curSub || 'step');

  /* ---- 步骤 ---- */
  const stepBox = $('.sub-step', area);
  function renderSteps() {
    if (!steps.length) { stepBox.innerHTML = '<div class="muted">（没有步骤）</div>'; return; }
    stepBox.innerHTML = steps.map((s, i) =>
      '<div class="erow"><span class="elabel">' + esc(stepLabel(s, i)) + '</span>' +
      '<span class="eacts">' +
      (i > 0 ? '<button class="small st-up" data-i="' + i + '">↑</button>' : '') +
      (i < steps.length - 1 ? '<button class="small st-down" data-i="' + i + '">↓</button>' : '') +
      '<button class="small st-edit" data-i="' + i + '">改</button>' +
      '<button class="small danger st-del" data-i="' + i + '">删</button>' +
      '</span></div><div class="estep-edit hide" data-for="' + i + '"></div>'
    ).join('');
    $$('.st-up', stepBox).forEach((b) => b.addEventListener('click', () =>
      editorOp(f, card, area, 'step', 'flow_step_move', { flowId: f.id, from: +b.dataset.i + 1, to: +b.dataset.i })));
    $$('.st-down', stepBox).forEach((b) => b.addEventListener('click', () =>
      editorOp(f, card, area, 'step', 'flow_step_move', { flowId: f.id, from: +b.dataset.i + 1, to: +b.dataset.i + 2 })));
    $$('.st-del', stepBox).forEach((b) => b.addEventListener('click', () => {
      if (!confirm('确定删除第 ' + (+b.dataset.i + 1) + ' 步？（会自动备份，可回滚）')) return;
      editorOp(f, card, area, 'step', 'flow_step_delete', { flowId: f.id, index: +b.dataset.i + 1 });
    }));
    $$('.st-edit', stepBox).forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.i;
      const box = $('.estep-edit[data-for="' + i + '"]', stepBox);
      const open = !box.classList.contains('hide');
      $$('.estep-edit', stepBox).forEach((x) => { x.classList.add('hide'); x.innerHTML = ''; });
      if (open) return;
      box.classList.remove('hide');
      box.innerHTML = '<label>步骤 JSON（合并 patch：只覆盖传入字段）<textarea rows="4">' + esc(JSON.stringify(steps[i], null, 2)) + '</textarea></label>' +
        '<div class="row"><button class="primary st-save">保存</button><button class="st-cancel">取消</button></div>';
      $('.st-save', box).addEventListener('click', () => {
        let patch;
        try { patch = JSON.parse($('textarea', box).value || '{}'); }
        catch (e) { toast('JSON 有误：' + e.message, 'err'); return; }
        editorOp(f, card, area, 'step', 'flow_step_update', { flowId: f.id, index: i + 1, patch });
      });
      $('.st-cancel', box).addEventListener('click', () => { box.classList.add('hide'); box.innerHTML = ''; });
    }));
  }

  /* ---- 变量 ---- */
  const paramBox = $('.sub-param', area);
  function renderParams() {
    paramBox.innerHTML =
      (params.length ? params.map((p) =>
        '<div class="erow"><span class="elabel"><b>' + esc(p.name) + '</b>' +
        (p.source ? ' · ' + esc(p.source) : '') +
        (p.required ? ' · 必填' : '') + (p.secret ? ' · 敏感' : '') +
        (p.default ? ' · 默认 ' + esc(p.default) : '') + '</span>' +
        '<span class="eacts"><button class="small danger pm-del" data-n="' + esc(p.name) + '">删</button></span></div>'
      ).join('') : '<div class="muted">（没有变量）</div>') +
      '<div class="row"><label>变量名<input class="p-name" type="text" placeholder="日期"></label>' +
      '<label>source<input class="p-source" type="text" placeholder="const / excel:...#列@0 / secret:名 / prompt"></label></div>' +
      '<div class="row"><label>默认值<input class="p-default" type="text"></label>' +
      '<label class="chk"><input type="checkbox" class="p-required"> 必填</label>' +
      '<label class="chk"><input type="checkbox" class="p-secret"> 敏感</label>' +
      '<button class="primary p-add">添加/更新变量</button></div>';
    $$('.pm-del', paramBox).forEach((b) => b.addEventListener('click', () => {
      if (!confirm('确定删除变量 ' + b.dataset.n + '？')) return;
      editorOp(f, card, area, 'param', 'flow_param_remove', { flowId: f.id, name: b.dataset.n });
    }));
    $('.p-add', paramBox).addEventListener('click', async (ev) => {
      const name = $('.p-name', paramBox).value.trim();
      if (!name) { toast('请填变量名', 'err'); return; }
      const args = { flowId: f.id, name };
      const src = $('.p-source', paramBox).value.trim(); if (src) args.source = src;
      const def = $('.p-default', paramBox).value.trim(); if (def) args.default = def;
      if ($('.p-required', paramBox).checked) args.required = true;
      if ($('.p-secret', paramBox).checked) args.secret = true;
      await withBusy(ev.target, '保存中…', async () => {
        try { const r = await tool('flow_param_add', args); showOut($('.out', card), r.summary, r.data, 'ok'); await loadEditor(f, card, area, 'param'); }
        catch (e) { showOut($('.out', card), e.message, safeParse(e.detail || ''), 'err'); }
      });
    });
  }

  /* ---- 断言 ---- */
  const assertBox = $('.sub-assert', area);
  function renderAsserts() {
    const fields = ['selector', 'text', 'min', 'contains', 'equals', 'regex', 'as', 'minBytes', 'minLines'];
    assertBox.innerHTML =
      (assertions.length ? assertions.map((a, i) => {
        const parts = fields.filter((k) => a[k] !== undefined).map((k) => esc(k + '=' + a[k]));
        return '<div class="erow"><span class="elabel"><b>#' + (i + 1) + ' [' + esc(a.kind) + ']</b> ' +
          esc(a.message || '') + (parts.length ? ' <span class="muted">' + parts.join(' · ') + '</span>' : '') + '</span>' +
          '<span class="eacts"><button class="small danger am-del" data-i="' + i + '">删</button></span></div>';
      }).join('') : '<div class="muted">（没有断言）</div>') +
      '<div class="row"><label>kind<select class="a-kind">' +
      ['tableNotEmpty', 'listNotEmpty', 'textPresent', 'textAbsent', 'elementVisible', 'elementAbsent', 'url', 'title', 'download', 'extracted', 'noErrorBanner']
        .map((k) => '<option>' + k + '</option>').join('') +
      '</select></label><label>失败说明<input class="a-message" type="text"></label></div>' +
      '<div class="row"><label>text<input class="a-text" type="text"></label><label>selector<input class="a-selector" type="text" placeholder="table tbody tr"></label>' +
      '<label>min<input class="a-min" type="number" min="1"></label></div>' +
      '<div class="row"><label>contains<input class="a-contains" type="text"></label><label>equals<input class="a-equals" type="text"></label>' +
      '<label>regex<input class="a-regex" type="text"></label></div>' +
      '<div class="row"><label>as<input class="a-as" type="text"></label><label>minBytes<input class="a-minbytes" type="number" min="1"></label>' +
      '<label>minLines<input class="a-minlines" type="number" min="0"></label>' +
      '<button class="primary a-add">添加断言</button></div>';
    $$('.am-del', assertBox).forEach((b) => b.addEventListener('click', () => {
      editorOp(f, card, area, 'assert', 'flow_assertion_remove', { flowId: f.id, index: +b.dataset.i + 1 });
    }));
    $('.a-add', assertBox).addEventListener('click', async (ev) => {
      const args = { flowId: f.id, kind: $('.a-kind', assertBox).value };
      for (const [cls, key] of [['.a-message', 'message'], ['.a-text', 'text'], ['.a-selector', 'selector'],
        ['.a-contains', 'contains'], ['.a-equals', 'equals'], ['.a-regex', 'regex'], ['.a-as', 'as']]) {
        const v = $(cls, assertBox).value.trim();
        if (v) args[key] = v;
      }
      const min = parseInt($('.a-min', assertBox).value, 10); if (min >= 1) args.min = min;
      const minBytes = parseInt($('.a-minbytes', assertBox).value, 10); if (minBytes >= 1) args.minBytes = minBytes;
      const minLinesRaw = $('.a-minlines', assertBox).value.trim();
      const minLines = parseInt(minLinesRaw, 10); if (minLinesRaw !== '' && minLines >= 0) args.minLines = minLines;
      await withBusy(ev.target, '添加中…', async () => {
        try { const r = await tool('flow_assertion_add', args); showOut($('.out', card), r.summary, r.data, 'ok'); await loadEditor(f, card, area, 'assert'); }
        catch (e) { showOut($('.out', card), e.message, safeParse(e.detail || ''), 'err'); }
      });
    });
  }

  renderSteps();
  renderParams();
  renderAsserts();
}

function renderRunResult(el, r) {
  const d = r.data || {};
  const isPass = d.status === 'pass';
  const head = (r.isError ? '❌ ' : isPass ? '✅ ' : '') + (r.summary || '');
  el.classList.remove('hide');
  el.innerHTML = '<span class="' + (r.isError ? 'err' : isPass ? 'ok' : 'err') + '">' + esc(head) + '</span>' +
    '\n状态: ' + esc(d.status || '?') + '  耗时: ' + esc(fmtMs(d.durationMs)) +
    (d.flowSelfHealed ? '  已自愈并回写流程' : '') +
    (d.error ? '\n错误: ' + esc(String(d.error).split('\n')[0]) : '') +
    (d.attribution ? '\n归因: ' + esc(String(d.attribution)) : '') +
    (d.reportPath ? '\n报告: ' + esc(d.reportPath) : '') +
    (Array.isArray(d.screenshots) && d.screenshots.length ? '\n截图:\n  ' + d.screenshots.map((s) => esc(typeof s === 'string' ? s : s.path || JSON.stringify(s))).join('\n  ') : '') +
    '\n\n' + esc(JSON.stringify(d.stepDetails || [], null, 1));
}

/* ---------------- 定时页 ---------------- */

async function refreshSchedules() {
  const el = $('#sched-list');
  el.textContent = '加载中…';
  try {
    const r = await tool('schedule_list', {});
    const tasks = (r.data && r.data.tasks) || [];
    el.innerHTML = r.summary + tableHtml(tasks, [
      { title: '任务', val: (t) => esc(t.task || t.flowId) },
      { title: '频率', val: (t) => esc(t.spec ? JSON.stringify(t.spec) : '—') },
      { title: '系统内状态', val: (t) => statusBadge(t.exists ? (t.status || '存在') : '不存在') },
      { title: '下次运行', val: (t) => esc(t.nextRun || '—') },
      { title: '上次结果', val: (t) => esc(t.lastResult || '—') },
      { title: '', val: (t) => '<button class="small sched-run" data-flow="' + esc(t.flowId) + '">立即运行</button> ' +
        '<button class="small danger sched-del" data-flow="' + esc(t.flowId) + '">删除</button>' },
    ]) || '<div class="muted">（空）</div>';
    $$('.sched-run', el).forEach((b) => b.addEventListener('click', async () => {
      withBusy(b, '触发中…', async () => {
        try { const r2 = await tool('schedule_run_now', { flowId: b.dataset.flow }); toast(r2.summary, 'ok'); refreshSchedules(); }
        catch (e) { toast(e.message, 'err'); }
      });
    }));
    $$('.sched-del', el).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('确定删除定时任务 ' + b.dataset.flow + '？')) return;
      withBusy(b, '删除中…', async () => {
        try { const r2 = await tool('schedule_remove', { flowId: b.dataset.flow }); toast(r2.summary, 'ok'); refreshSchedules(); }
        catch (e) { toast(e.message, 'err'); }
      });
    }));
  } catch (e) {
    el.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
}

function wireScheduleForm() {
  $('#sched-freq').addEventListener('change', () => {
    const v = $('#sched-freq').value;
    $('#sched-days-row').classList.toggle('hide', v !== 'weekly');
    $('#sched-minute-row').style.display = v === 'minute' ? '' : 'none';
    $('#sched-hourly-row').style.display = v === 'hourly' ? '' : 'none';
    $('#sched-date-row').style.display = v === 'once' ? '' : 'none';
  });
  $('#btn-sched-add').addEventListener('click', async (ev) => {
    const flowId = $('#sched-flow').value;
    if (!flowId) { toast('请选择流程', 'err'); return; }
    const args = { flowId, frequency: $('#sched-freq').value };
    if ($('#sched-at').value.trim()) args.at = $('#sched-at').value.trim();
    const days = $$('#sched-days-row input:checked').map((i) => i.value);
    if (days.length) args.days = days;
    const em = parseInt($('#sched-every-min').value, 10); if (em >= 1) args.everyMinutes = em;
    const eh = parseInt($('#sched-every-hour').value, 10); if (eh >= 1) args.everyHours = eh;
    if ($('#sched-date').value.trim()) args.date = $('#sched-date').value.trim();
    if ($('#sched-headed').checked) args.headed = true;
    try { args.params = parseJsonTextarea($('#sched-params'), undefined); }
    catch (e) { toast(e.message, 'err'); return; }
    if (args.params === undefined) delete args.params;
    await withBusy(ev.target, '注册中…', async () => {
      try { const r = await tool('schedule_add', args); toast(r.summary, 'ok'); refreshSchedules(); }
      catch (e) { toast(e.message, 'err'); }
    });
  });
}

/* ---------------- 系统页 ---------------- */

function wireSystem() {
  $('#btn-notify-load').addEventListener('click', async () => {
    try {
      const r = await tool('notify_config', {});
      const n = (r.data && r.data.notify) || {};
      $('#nt-enabled').checked = !!n.enabled;
      $('#nt-type').value = n.type || 'generic';
      $('#nt-webhook').value = n.webhook || '';
      $('#nt-mention').value = n.mention || '';
      $$('#tab-system .chk input[value="failure"], #tab-system .chk input[value="healed"], #tab-system .chk input[value="success"], #tab-system .chk input[value="all"]')
        .forEach((i) => { i.checked = (n.on || []).includes(i.value); });
      showOut($('#notify-out'), r.summary, r.data, null);
    } catch (e) { showOut($('#notify-out'), e.message, null, 'err'); }
  });
  $('#btn-notify-save').addEventListener('click', async (ev) => {
    const args = {};
    args.enabled = $('#nt-enabled').checked;
    args.type = $('#nt-type').value;
    const wh = $('#nt-webhook').value.trim();
    if (wh) args.webhook = wh;
    const on = $$('#tab-system .chk input[value="failure"], #tab-system .chk input[value="healed"], #tab-system .chk input[value="success"], #tab-system .chk input[value="all"]')
      .filter((i) => i.checked).map((i) => i.value);
    if (on.length) args.on = on;
    const mention = $('#nt-mention').value.trim();
    if (mention) args.mention = mention;
    await withBusy(ev.target, '保存中…', async () => {
      try { const r = await tool('notify_config', args); toast(r.summary, 'ok'); showOut($('#notify-out'), r.summary, r.data, 'ok'); }
      catch (e) { showOut($('#notify-out'), e.message, null, 'err'); }
    });
  });
  $('#btn-notify-test').addEventListener('click', async (ev) => {
    await withBusy(ev.target, '发送中…', async () => {
      try { const r = await tool('notify_test', {}); showOut($('#notify-out'), r.summary, r.data, 'ok'); toast(r.summary, 'ok'); }
      catch (e) { showOut($('#notify-out'), e.message, safeParse(e.detail || ''), 'err'); toast(e.message, 'err'); }
    });
  });

  $('#btn-secret-list').addEventListener('click', async () => {
    try { const r = await tool('secret_list', {}); showOut($('#secret-out'), r.summary, r.data, null); }
    catch (e) { showOut($('#secret-out'), e.message, null, 'err'); }
  });
  $('#btn-secret-set').addEventListener('click', async (ev) => {
    const name = $('#sec-name').value.trim(), value = $('#sec-value').value;
    if (!name || !value) { toast('请填凭据名称和值', 'err'); return; }
    await withBusy(ev.target, '保存中…', async () => {
      try { const r = await tool('secret_set', { name, value }); toast(r.summary, 'ok'); $('#sec-value').value = ''; showOut($('#secret-out'), r.summary, null, 'ok'); }
      catch (e) { showOut($('#secret-out'), e.message, null, 'err'); }
    });
  });
  $('#btn-secret-delete').addEventListener('click', async (ev) => {
    const name = $('#sec-name').value.trim();
    if (!name) { toast('请填要删除的凭据名称', 'err'); return; }
    await withBusy(ev.target, '删除中…', async () => {
      try { const r = await tool('secret_delete', { name }); toast(r.summary, 'ok'); showOut($('#secret-out'), r.summary, null, 'ok'); }
      catch (e) { showOut($('#secret-out'), e.message, null, 'err'); }
    });
  });

  $('#btn-profile-login').addEventListener('click', async (ev) => {
    const url = $('#pf-url').value.trim();
    if (!url) { toast('请填登录后停留的网址', 'err'); return; }
    const args = { url };
    const st = $('#pf-success-text').value.trim();
    const su = $('#pf-success-url').value.trim();
    if (st) args.successText = st;
    if (su) args.successUrlContains = su;
    await withBusy(ev.target, '等待登录中…（最多 5 分钟，请在新开的窗口里完成登录）', async () => {
      try { const r = await tool('profile_login', args); showOut($('#profile-out'), r.summary, r.data, 'ok'); toast(r.summary, 'ok'); }
      catch (e) { showOut($('#profile-out'), e.message, safeParse(e.detail || ''), 'err'); toast(e.message, 'err'); }
    });
  });
  $('#btn-profile-info').addEventListener('click', async () => {
    try { const r = await tool('profile_info', {}); showOut($('#profile-out'), r.summary, r.data, null); }
    catch (e) { showOut($('#profile-out'), e.message, null, 'err'); }
  });
  $('#btn-profile-reset').addEventListener('click', async (ev) => {
    if (!confirm('确定清空持久化登录态？所有已登录会话都会失效。')) return;
    await withBusy(ev.target, '清空中…', async () => {
      try { const r = await tool('profile_reset', { confirm: true }); showOut($('#profile-out'), r.summary, r.data, 'ok'); }
      catch (e) { showOut($('#profile-out'), e.message, null, 'err'); }
    });
  });

  $('#btn-config-get').addEventListener('click', async () => {
    try { const r = await tool('config_get', {}); showOut($('#config-out'), r.summary, r.data && r.data.config, null); }
    catch (e) { showOut($('#config-out'), e.message, null, 'err'); }
  });
  $('#btn-config-set').addEventListener('click', async (ev) => {
    let patch;
    try { patch = JSON.parse($('#cfg-patch').value || '{}'); }
    catch (e) { toast('patch JSON 有误：' + e.message, 'err'); return; }
    if (!Object.keys(patch).length) { toast('patch 不能为空', 'err'); return; }
    await withBusy(ev.target, '更新中…', async () => {
      try { const r = await tool('config_set', { patch }); showOut($('#config-out'), r.summary, r.data && r.data.config, 'ok'); }
      catch (e) { showOut($('#config-out'), e.message, safeParse(e.detail || ''), 'err'); }
    });
  });

  $('#btn-lock-status').addEventListener('click', async () => {
    const args = {};
    const fid = $('#lock-flow').value.trim();
    if (fid) args.flowId = fid;
    try { const r = await tool('lock_status', args); showOut($('#lock-out'), r.summary, r.data, null); }
    catch (e) { showOut($('#lock-out'), e.message, null, 'err'); }
  });
  $('#btn-lock-release').addEventListener('click', async (ev) => {
    const fid = $('#lock-flow').value.trim();
    if (!fid) { toast('请填要释放锁的流程 id（防止误伤正在执行的流程）', 'err'); return; }
    if (!confirm('确定强制释放 ' + fid + ' 的锁？仅在上一次执行确实已经不在运行时使用。')) return;
    await withBusy(ev.target, '释放中…', async () => {
      try { const r = await tool('lock_release', { flowId: fid }); showOut($('#lock-out'), r.summary, r.data, 'ok'); }
      catch (e) { showOut($('#lock-out'), e.message, null, 'err'); }
    });
  });

  $('#btn-prune').addEventListener('click', async (ev) => {
    const args = { dryRun: $('#prune-dry').checked };
    const fid = $('#prune-flow').value.trim();
    if (fid) args.flowId = fid;
    const count = parseInt($('#prune-count').value, 10); if (count >= 0 && $('#prune-count').value !== '') args.keepCount = count;
    const days = parseInt($('#prune-days').value, 10); if (days >= 0 && $('#prune-days').value !== '') args.keepDays = days;
    if ($('#prune-logs').checked) args.logs = true;
    await withBusy(ev.target, args.dryRun ? '预演中…' : '清理中…', async () => {
      try { const r = await tool('runs_prune', args); showOut($('#prune-out'), r.summary, r.data, args.dryRun ? null : 'ok'); }
      catch (e) { showOut($('#prune-out'), e.message, safeParse(e.detail || ''), 'err'); }
    });
  });
}

/* ---------------- 控制台页 ---------------- */

let allTools = [];

async function refreshToolList() {
  const sel = $('#console-tool');
  try {
    const r = await api('/tools');
    allTools = r.tools || [];
    sel.innerHTML = allTools.map((t) => '<option value="' + esc(t.name) + '">' + esc(t.name) + ' — ' + esc(t.description.split('\n')[0].slice(0, 46)) + '</option>').join('');
    onToolPicked();
  } catch (e) {
    sel.innerHTML = '<option value="">' + esc('加载失败：' + e.message) + '</option>';
  }
}

function onToolPicked() {
  const name = $('#console-tool').value;
  const t = allTools.find((x) => x.name === name);
  const desc = $('#console-desc');
  if (!t) { desc.classList.add('hide'); return; }
  desc.classList.remove('hide');
  desc.textContent = t.description;
  $('#console-args').value = JSON.stringify(skeleton(t.inputSchema), null, 2);
}

/* 从 inputSchema 生成必填参数骨架，省得手敲 */
function skeleton(schema) {
  const out = {};
  if (!schema || schema.type !== 'object') return out;
  const props = schema.properties || {};
  const required = schema.required || Object.keys(props);
  for (const key of required) {
    const p = props[key];
    if (!p) { out[key] = ''; continue; }
    if (p.type === 'object') out[key] = p.required && p.required.length ? skeleton(p) : {};
    else if (p.type === 'array') out[key] = [];
    else if (p.type === 'integer' || p.type === 'number') out[key] = p.minimum ? p.minimum : 0;
    else if (p.type === 'boolean') out[key] = false;
    else if (p.enum && p.enum.length) out[key] = p.enum[0];
    else out[key] = '';
  }
  return out;
}

async function consoleCall() {
  const name = $('#console-tool').value;
  if (!name) return;
  let args;
  try { args = JSON.parse($('#console-args').value || '{}'); }
  catch (e) { toast('参数 JSON 有误：' + e.message, 'err'); return; }
  await withBusy($('#btn-console-call'), '调用中…（长时间运行的工具请耐心等待）', async () => {
    try {
      const r = await tool(name, args);
      showOut($('#console-out'), r.summary + '（' + fmtMs(r.elapsedMs) + '）', r.data, null);
    } catch (e) {
      showOut($('#console-out'), e.message, safeParse(e.detail || ''), 'err');
    }
  });
}

/* ---------------- 串联运行 ---------------- */

async function chainRun() {
  let items;
  try { items = JSON.parse($('#chain-items').value || '[]'); }
  catch (e) { toast('items JSON 有误：' + e.message, 'err'); return; }
  if (!Array.isArray(items) || !items.length) { toast('items 至少要有一项 [{flow:"id"}]', 'err'); return; }
  const args = { items };
  if ($('#chain-headed').checked) args.headed = true;
  if ($('#chain-notify').checked) args.notify = true;
  const maxms = parseInt($('#chain-maxms').value, 10);
  if (maxms > 0) args.maxDurationMs = maxms;
  await withBusy($('#btn-chain-run'), '串联运行中…（可以关掉窗口，不中断）', async () => {
    try {
      const r = await tool('chain_run', args);
      showOut($('#chain-out'), r.summary, r.data, r.data && r.data.status === 'pass' ? 'ok' : 'err');
    } catch (e) { showOut($('#chain-out'), e.message, safeParse(e.detail || ''), 'err'); }
  });
}

/* ---------------- 网页版自适应与缩放（仅 /console；扩展弹窗不受影响） ---------------- */

function isWebMode() {
  try { return typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL; } catch (e) { return true; }
}

function applyZoom(pct) {
  const v = Math.min(150, Math.max(75, Math.round(pct)));
  document.body.style.zoom = v / 100;
  $('#zoom-slider').value = String(v);
  $('#zoom-val').textContent = v + '%';
  try { localStorage.setItem('webZoom', String(v)); } catch (e) { /* ignore */ }
}

function wireWebMode() {
  document.body.classList.add('web');
  $('#zoom-bar').classList.remove('hide');
  let z = 100;
  try { z = parseInt(localStorage.getItem('webZoom') || '100', 10) || 100; } catch (e) { /* ignore */ }
  applyZoom(z);
  $('#zoom-slider').addEventListener('input', (e) => applyZoom(parseInt(e.target.value, 10)));
  $('#zoom-in').addEventListener('click', () => applyZoom(parseInt($('#zoom-slider').value, 10) + 5));
  $('#zoom-out').addEventListener('click', () => applyZoom(parseInt($('#zoom-slider').value, 10) - 5));
  $('#zoom-full').addEventListener('click', () => {
    // ⛶：浏览器窗口本身已是 100% 时切到 125% 铺满视觉内容区；已是大缩放时回 100%
    const cur = parseInt($('#zoom-slider').value, 10);
    applyZoom(cur > 100 ? 100 : 125);
  });
}

/* ---------------- 装配 ---------------- */

async function init() {
  await loadSettings();
  // 桥接地址与当前页面不同源时自动跳转（改过桥接端口后，旧端口链接打开的 /console
  // 所有请求都会被桥接的 Origin 校验 403——页面自愈到当前 storage 桥接的 /console，
  // ?token= 等参数随跳；新页面 host===BASE.host 收敛，不会循环跳转）
  if (isWebMode()) {
    try {
      const b = new URL(BASE);
      if (location.host !== b.host) {
        // localStorage 按 origin 隔离：跨端口后新 origin 读不到旧值会跳回默认端口死循环——
        // 把 bridge 带在 URL 参数上传给目标页（落地后写入新 origin 的 localStorage 收敛）
        const sp = new URLSearchParams(location.search);
        sp.set('bridge', BASE);
        location.replace(b.origin + '/console?' + sp.toString());
        return;
      }
    } catch (e) { /* BASE 非法时交给 connect 报错 */ }
  }
  if (isWebMode()) wireWebMode();
  $('#btn-settings').addEventListener('click', () => $('#settings').classList.toggle('hide'));
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  $('#btn-refresh-health').addEventListener('click', () => { refreshHealth(); renderModeBanner(); });
  $('#btn-doctor').addEventListener('click', runDoctor);
  $('#btn-status-report').addEventListener('click', runStatusReport);

  $('#btn-record-start').addEventListener('click', startRecording);
  $('#btn-record-status').addEventListener('click', pollRecordStatus);
  $('#btn-record-stop').addEventListener('click', stopRecording);
  $('#btn-record-cancel').addEventListener('click', cancelRecording);
  $('#btn-splice-start').addEventListener('click', startSplice);

  $('#btn-flows-refresh').addEventListener('click', () => { refreshFlows(); renderLocalFlows(); });
  // 本地流程导入：本地格式或 MCP 流程 JSON 均可（v1.21.0）
  $('#btn-local-import').addEventListener('click', () => $('#local-import-file').click());
  $('#local-import-file').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      let local = null;
      if (Array.isArray(j.steps) && j.steps.length && j.steps[0] && j.steps[0].locator) local = j; // 本地格式
      else if (Array.isArray(j.steps)) local = window.RpaStandalone.toLocalFromMcp(j); // MCP 格式
      if (!local || !local.steps || !local.steps.length) { toast('JSON 里没有可导入的步骤（支持本地格式或含 goto/click/fill 的 MCP 流程）', 'err'); return; }
      local.id = 'local-' + Date.now();
      local.name = local.name && local.name.indexOf('local-') !== 0 ? local.name : (f.name.replace(/\.json$/i, '') || local.id);
      window.RpaStandalone.saveLocal(local, () => { toast('✅ 已导入「' + local.name + '」（' + local.steps.length + ' 步）', 'ok'); renderLocalFlows(); });
    } catch (e) { toast('导入失败: ' + (e && e.message ? e : e), 'err'); }
  });
  $('#btn-chain-run').addEventListener('click', chainRun);

  $('#btn-sched-refresh').addEventListener('click', refreshSchedules);
  wireScheduleForm();

  wireSystem();

  $('#console-tool').addEventListener('change', onToolPicked);
  $('#btn-console-tools').addEventListener('click', () => { tabInited.delete('console'); refreshToolList(); });
  $('#btn-console-call').addEventListener('click', consoleCall);

  initTab('status', false);
}

document.addEventListener('DOMContentLoaded', init);
