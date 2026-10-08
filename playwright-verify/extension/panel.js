/**
 * panel.js — 控制台前端（零框架：一个 html 里把活干完，不引构建链）
 *
 * 设计要点：
 *  1) **工具清单只来自 tools/list**：不在前端维护第二份工具表 —— 服务端加了工具，
 *     这里自动出现（schema 驱动表单）。两份清单的漂移是静默的，前端那份永远会旧。
 *  2) **一切走 JSON-RPC 2.0（POST /rpc）**：与 MCP stdio 通道同一处理器，
 *     错误码、isError、structuredContent 形状完全一致。
 *  3) **断言不放宽的口径同样适用于这里**：结果原样呈现（含 isError），
 *     不做「失败但显示成功」的美化。
 *  4) 口令只存浏览器本地（chrome.storage.local / localStorage），只随请求发往
 *     127.0.0.1，不发往任何其它地方。
 */

const DEFAULT_BASE = 'http://127.0.0.1:7395';
const HISTORY_MAX = 30;

const $ = (id) => document.getElementById(id);
const state = {
  base: DEFAULT_BASE,
  token: '',
  tools: [],
  selected: null,
  lastResult: '',
  history: [],
  // 插拔式双模（r49）：mcp=依赖桥（全工具面）；local=独立模式（本页只留本地能力说明，
  // 悬浮球的录制/回放/导出不依赖桥）。模式持久化 pv_mode，与悬浮球同一键。
  mode: 'mcp',
};

/** 双模应用（纯 UI 态）：本地模式禁用工具面、显诚实说明；依赖模式走原连接流程。 */
function applyMode(opts) {
  const local = state.mode === 'local';
  const btn = $('modeBtn');
  if (btn) btn.textContent = local ? '🔋 独立模式' : '⚡ 依赖 MCP';
  const notice = $('localNotice');
  if (notice) notice.hidden = !local;
  const run = $('runBtn');
  if (run) run.disabled = local;
  const filter = $('toolFilter');
  if (filter) filter.disabled = local;
  if (local) {
    setStatus('local', '独立模式：工具面已停用（悬浮球录制/回放/导出本地可用）');
    $('serverInfo').textContent = '独立模式（不依赖 MCP 桥）';
    state.tools = [];
    renderToolList();
    $('toolTitle').textContent = '独立模式';
    $('toolDesc').textContent = '本页工具面需要 MCP 桥；悬浮球的录制、回放、导出录制 JSON 在独立模式下照常可用。点右上「⚡ 依赖 MCP」恢复全工具面。';
  } else if (!(opts && opts.silent === true)) {
    reconnect(); // 切回依赖模式：重新探活拉清单；silent 用于初始化时（连接由 init 自己发起）
  }
}

function setMode(mode, opts) {
  state.mode = mode === 'local' ? 'local' : 'mcp';
  try { chrome.storage.local?.set({ pv_mode: state.mode }); } catch { /* 存储不可用不阻塞 */ }
  applyMode(opts);
}

/* ---------------- 结构化结果可视化（纯函数核，可被 vm 直接加载测试） ----------------
 * 原则：只产**视图模型**（{kind:'kv'|'table'|'line'} 节点数组），渲染走 DOM API 的
 * textContent 赋值 —— 工具数据永不经 innerHTML，XSS 面为零；行数/深度有帽，
 * 结构化数据保真（值原样进模型，不做「失败显示成功」式美化）。
 */
function pvCellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v).slice(0, 80); } catch { return '[object]'; } }
  return String(v).slice(0, 120);
}
function pvStructuredModel(sc, depth) {
  depth = depth || 0;
  if (depth > 3 || sc === null || typeof sc !== 'object') {
    return [{ kind: 'line', text: pvCellText(sc) }];
  }
  if (Array.isArray(sc)) {
    if (!sc.length) return [{ kind: 'line', text: '（空数组）' }];
    if (sc.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const keys = [];
      sc.slice(0, 20).forEach((o) => Object.keys(o).forEach((k) => { if (keys.indexOf(k) === -1) keys.push(k); }));
      const cols = keys.slice(0, 6);
      return [{
        kind: 'table',
        columns: cols,
        rows: sc.slice(0, 20).map((o) => cols.map((k) => pvCellText(o[k]))),
        total: sc.length,
      }];
    }
    return [{ kind: 'line', text: sc.slice(0, 20).map(pvCellText).join('、') + (sc.length > 20 ? ' …' : '') }];
  }
  const out = [];
  Object.keys(sc).forEach((k) => {
    const v = sc[k];
    if (v && typeof v === 'object') {
      out.push({ kind: 'kv', key: k, value: '' });
      pvStructuredModel(v, depth + 1).forEach((n) => out.push(n));
    } else {
      out.push({ kind: 'kv', key: k, value: pvCellText(v) });
    }
  });
  return out;
}
function pvRenderModelInto(container, model) {
  container.textContent = '';
  model.forEach((node) => {
    if (node.kind === 'kv') {
      const row = document.createElement('div');
      row.className = 'sc-kv';
      const k = document.createElement('b');
      k.textContent = node.key;
      row.appendChild(k);
      row.appendChild(document.createTextNode(' ' + node.value));
      container.appendChild(row);
    } else if (node.kind === 'table') {
      const table = document.createElement('table');
      table.className = 'sc-table';
      const thead = document.createElement('tr');
      node.columns.forEach((c) => { const th = document.createElement('th'); th.textContent = c; thead.appendChild(th); });
      table.appendChild(thead);
      node.rows.forEach((r) => {
        const tr = document.createElement('tr');
        r.forEach((cell) => { const td = document.createElement('td'); td.textContent = cell; tr.appendChild(td); });
        table.appendChild(tr);
      });
      container.appendChild(table);
      const more = document.createElement('div');
      more.className = 'sc-more';
      more.textContent = `…共 ${node.total} 行，显示前 ${node.rows.length} 行（完整数据在文本通道/落盘产物）`;
      container.appendChild(more);
    } else {
      const line = document.createElement('div');
      line.className = 'sc-line';
      line.textContent = node.text;
      container.appendChild(line);
    }
  });
}
globalThis.pvStructuredModel = pvStructuredModel;
globalThis.pvCellText = pvCellText;

/* ---------------- 结果预览一行（r50：历史区富渲染） ----------------
 * pvFactsLine 与悬浮球 floating.js 的 r42 实现**同口径**（键序前 4 席：顶层标量 +
 * 一层嵌套标量 + 数组计数含 0 如实；verdict 不剔除进 facts（预览单独前置）；值保真；
 * 非对象 → ''）。两份实现无共享模块（无构建链），口径由 bridge-check 双面钉
 * （同一组输入两边产同一行输出）防漂移 —— 复制实现的代价就是这枚钉。
 */
function pvFactsLine(sc, max) {
  if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return '';
  const cap = max > 0 ? max : 4;
  const facts = [];
  const push = (k, v) => {
    if (facts.length >= cap) return;
    if (v === null || v === undefined || typeof v === 'object') return;
    if (k === 'verdict') return;
    facts.push(`${k} ${String(v)}`);
  };
  Object.keys(sc).forEach((k) => {
    const v = sc[k];
    if (Array.isArray(v)) { push(`${k} count`, v.length); return; }
    if (v && typeof v === 'object') {
      Object.keys(v).forEach((k2) => push(`${k}.${k2}`, v[k2]));
      return;
    }
    push(k, v);
  });
  return facts.join(' · ');
}
/** 历史行预览：【verdict】前置 + facts 一行；两者皆无 → ''（不硬凑不伪造）。 */
function pvResultPreview(result) {
  const sc = result && result.structuredContent;
  const verdict = (sc && typeof sc.verdict === 'string' && sc.verdict) ? `【${sc.verdict}】` : '';
  const facts = pvFactsLine(sc);
  return (verdict && facts) ? `${verdict} ${facts}` : (verdict || facts);
}
globalThis.pvFactsLine = pvFactsLine;
globalThis.pvResultPreview = pvResultPreview;

/* ---------------- 配置存取（本地，不出机） ----------------
 * 键统一为 pv_base/pv_token（r49）：旧版面板写 base/token、背景/悬浮球读
 * pv_base/pv_token —— 面板里改了桥地址，悬浮球中转永远看不见（配置键分裂 bug）。
 * 现在单键集单一源；首载做一次旧键迁移（老配置不丢）。
 */
const store = {
  async load() {
    try {
      if (globalThis.chrome?.storage?.local) {
        const got = await chrome.storage.local.get(['pv_base', 'pv_token', 'base', 'token']);
        let base = got.pv_base;
        let token = got.pv_token;
        if ((base === undefined || base === '') && got.base) {
          // 旧键迁移：面板历史配置并入 pv_*，悬浮球中转从此看得见
          base = got.base;
          token = token || got.token || '';
          try { await chrome.storage.local.set({ pv_base: base, pv_token: token }); } catch { /* 迁移失败不阻塞 */ }
        }
        return { base, token };
      }
    } catch { /* 回退 localStorage */ }
    return {
      base: globalThis.localStorage?.getItem('pvmcp.base') || '',
      token: globalThis.localStorage?.getItem('pvmcp.token') || '',
    };
  },
  async save(base, token) {
    try {
      if (globalThis.chrome?.storage?.local) {
        await chrome.storage.local.set({ pv_base: base, pv_token: token });
        return;
      }
    } catch { /* 回退 localStorage */ }
    globalThis.localStorage?.setItem('pvmcp.base', base);
    globalThis.localStorage?.setItem('pvmcp.token', token);
  },
};

/* ---------------- JSON-RPC 通道 ---------------- */
async function rpc(method, params) {
  const res = await fetch(`${state.base}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { 'x-bridge-token': state.token } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (res.status === 401) throw new Error('口令不对（桥返回 401）— 检查右上角口令框');
  if (res.status === 403) throw new Error('请求被桥拒绝（403）— 只允许浏览器扩展来源与本机 Host');
  if (res.status === 413) throw new Error('参数太大（413）— 桥的请求体上限是 4MB');
  if (res.status === 404) throw new Error('桥地址不对（404）— 检查右上角地址');
  const body = await res.json();
  if (body.error) {
    const e = new Error(`[${body.error.code}] ${body.error.message}`);
    e.rpcError = body.error;
    throw e;
  }
  return body.result;
}

async function health() {
  const res = await fetch(`${state.base}/health`, {
    headers: state.token ? { 'x-bridge-token': state.token } : {},
  });
  return res.ok ? res.json() : null;
}

/* ---------------- 状态指示 ---------------- */
function setStatus(kind, info) {
  const dot = $('statusDot');
  dot.className = `dot ${kind}`;
  $('serverInfo').textContent = info;
}

/* ---------------- 工具列表（来自 tools/list，不维护第二份清单） ---------------- */
function renderToolList() {
  const q = $('toolFilter').value.trim().toLowerCase();
  const nav = $('toolList');
  nav.innerHTML = '';
  for (const t of state.tools) {
    if (q && !`${t.name} ${t.title || ''} ${t.description || ''}`.toLowerCase().includes(q)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = state.selected?.name === t.name ? 'active' : '';
    btn.innerHTML = `<div class="tool-title"></div><div class="tool-blurb"></div>`;
    btn.querySelector('.tool-title').textContent = t.name;
    btn.querySelector('.tool-blurb').textContent = t.title || (t.description || '').slice(0, 40);
    btn.addEventListener('click', () => selectTool(t.name));
    nav.appendChild(btn);
  }
}

/* ---------------- schema 驱动表单 ---------------- */
function selectTool(name) {
  const tool = state.tools.find((t) => t.name === name);
  if (!tool) return;
  state.selected = tool;
  $('toolTitle').textContent = tool.title ? `${tool.name} — ${tool.title}` : tool.name;
  $('toolDesc').textContent = tool.description || '（该工具没有描述）';
  renderForm(tool);
  renderToolList();
}

function renderForm(tool) {
  const form = $('toolForm');
  form.innerHTML = '';
  const schema = tool.inputSchema || { type: 'object', properties: {} };
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const names = Object.keys(props);
  if (!names.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '该工具没有参数。';
    form.appendChild(p);
    return;
  }
  for (const name of names) {
    const prop = props[name] || {};
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.dataset.name = name;

    const label = document.createElement('label');
    label.textContent = `${name}${prop.title ? ` — ${prop.title}` : ''} `;
    if (required.has(name)) {
      const star = document.createElement('span');
      star.className = 'required';
      star.textContent = '*';
      label.appendChild(star);
    }
    wrap.appendChild(label);

    if (prop.description) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = prop.description;
      wrap.appendChild(hint);
    }

    wrap.appendChild(buildInput(name, prop));
    form.appendChild(wrap);
  }
}

function buildInput(name, prop) {
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (Array.isArray(prop.enum) && prop.enum.length) {
    const sel = document.createElement('select');
    sel.dataset.field = name;
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '（不传）';
    sel.appendChild(empty);
    for (const v of prop.enum) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = String(v);
      sel.appendChild(o);
    }
    return sel;
  }
  if (type === 'boolean') {
    const row = document.createElement('div');
    row.className = 'checkbox-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.field = name;
    cb.dataset.kind = 'boolean';
    const span = document.createElement('span');
    span.textContent = '启用（勾选 = true）';
    row.append(cb, span);
    return row;
  }
  if (type === 'number' || type === 'integer') {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = type === 'integer' ? '1' : 'any';
    inp.dataset.field = name;
    inp.dataset.kind = type;
    return inp;
  }
  if (type === 'array' || type === 'object') {
    const ta = document.createElement('textarea');
    ta.dataset.field = name;
    ta.dataset.kind = type;
    ta.placeholder = type === 'array'
      ? '每行一项；或直接写 JSON 数组（如 ["a","b"]）'
      : 'JSON 对象（如 {"key":"value"}）';
    return ta;
  }
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.spellcheck = false;
  inp.dataset.field = name;
  inp.dataset.kind = 'string';
  return inp;
}

/** 采集表单值：空的可选项直接省略（「不传」与「传空串」是两件事，省略才符合工具口径）。 */
function collectArgs() {
  const args = {};
  const errors = [];
  for (const el of $('toolForm').querySelectorAll('[data-field]')) {
    const name = el.dataset.field;
    const kind = el.dataset.kind || 'string';
    if (kind === 'boolean') {
      if (el.checked) args[name] = true;
      continue;
    }
    const raw = String(el.value || '').trim();
    if (!raw) continue;
    if (kind === 'number' || kind === 'integer') {
      const n = Number(raw);
      if (!Number.isFinite(n)) errors.push(`${name}：不是数字`);
      else if (kind === 'integer' && !Number.isInteger(n)) errors.push(`${name}：必须是整数`);
      else args[name] = n;
      continue;
    }
    if (kind === 'array') {
      try {
        args[name] = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').map((s) => s.trim()).filter(Boolean);
      } catch (e) {
        errors.push(`${name}：JSON 数组解析失败（${e.message}）`);
      }
      continue;
    }
    if (kind === 'object') {
      try {
        const v = JSON.parse(raw);
        if (v === null || typeof v !== 'object') throw new Error('需要对象');
        args[name] = v;
      } catch (e) {
        errors.push(`${name}：JSON 对象解析失败（${e.message}）`);
      }
      continue;
    }
    args[name] = raw;
  }
  return { args, errors };
}

/* ---------------- 调用与结果渲染 ---------------- */
async function runTool() {
  if (state.mode === 'local') {
    $('runStatus').className = 'run-status err';
    $('runStatus').textContent = '独立模式：工具调用需要 MCP 桥 —— 点右上「⚡ 依赖 MCP」切回';
    return;
  }
  const tool = state.selected;
  if (!tool) return;
  const { args, errors } = collectArgs();
  const status = $('runStatus');
  if (errors.length) {
    status.className = 'run-status err';
    status.textContent = `参数有误：${errors.join('；')}`;
    return;
  }
  $('runBtn').disabled = true;
  status.className = 'run-status';
  status.textContent = '调用中…（长任务会一直等到出结果）';
  const t0 = Date.now();
  try {
    const result = await rpc('tools/call', { name: tool.name, arguments: args });
    renderResult(result, Date.now() - t0);
    pushHistory(tool.name, args, result, Date.now() - t0);
    status.className = 'run-status ok';
    status.textContent = `完成，用时 ${Date.now() - t0} ms`;
  } catch (e) {
    // 通道级失败（桥没起来/口令错）与工具级失败（isError）分开呈现：
    // 混在一起会让「工具跑失败」和「根本没跑到」看起来一样。
    $('resultText').className = 'result-text is-error';
    $('resultText').textContent = `调用未完成：${e.message}`;
    $('structuredBox').hidden = true;
    pushHistory(tool.name, args, { isError: true, content: [{ type: 'text', text: e.message }] }, Date.now() - t0);
    status.className = 'run-status err';
    status.textContent = '调用失败（见结果区）';
  } finally {
    $('runBtn').disabled = false;
  }
}

function renderResult(result, ms) {
  const text = (result.content || [])
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n');
  $('resultText').className = `result-text${result.isError ? ' is-error' : ''}`;
  $('resultText').textContent = `${result.isError ? '⚠ 工具返回 isError=true（结果不成立，原样呈现，不做美化）\n\n' : ''}${text || '（无文本内容）'}\n\n—— 用时 ${ms} ms`;
  state.lastResult = text;
  const structured = result.structuredContent;
  if (structured !== undefined) {
    $('structuredBox').hidden = false;
    // 视图模型渲染（kv/表格/行）：数据只经 textContent，不走 innerHTML；原始 JSON 不再整块倾倒
    pvRenderModelInto($('resultStructured'), pvStructuredModel(structured, 0));
  } else {
    $('structuredBox').hidden = true;
  }
}

function pushHistory(name, args, result, ms) {
  state.history.unshift({
    name, args, ms,
    ok: !result.isError,
    at: new Date().toLocaleTimeString(),
    // r50：历史行富渲染预览（【verdict】+ 关键事实一行），推入时算好、渲染只搬字符串
    preview: pvResultPreview(result),
  });
  state.history = state.history.slice(0, HISTORY_MAX);
  renderHistory();
}

function renderHistory() {
  const ul = $('historyList');
  ul.textContent = ''; // 真 DOM 语义：清空子节点；全程零 innerHTML（XSS 面为零，r40 纪律）
  for (const h of state.history) {
    const li = document.createElement('li');
    // 全 createElement + textContent（r50）：模板 innerHTML 退场 —— 历史行零 innerHTML，
    // 工具数据（含 preview）只经 textContent，XSS 面为零；每行四段：名/态/时/预览
    const mk = (cls) => { const s = document.createElement('span'); s.className = cls; return s; };
    const nameEl = mk('h-name'); nameEl.textContent = h.name; li.appendChild(nameEl);
    const st = mk('h-status');
    st.textContent = h.ok ? '成功' : '失败';
    st.className = `h-status ${h.ok ? 'ok' : 'err'}`;
    li.appendChild(st);
    const metaEl = mk('h-meta'); metaEl.textContent = `${h.at} · ${h.ms} ms`; li.appendChild(metaEl);
    const pvEl = mk('h-preview'); pvEl.textContent = h.preview || ''; li.appendChild(pvEl);
    li.addEventListener('click', () => {
      selectTool(h.name);
      // 回填上次参数，改一改就能重跑
      for (const [k, v] of Object.entries(h.args || {})) {
        const el = $('toolForm').querySelector(`[data-field="${CSS.escape(k)}"]`);
        if (!el) continue;
        if (el.dataset.kind === 'boolean') el.checked = v === true;
        else if (el.dataset.kind === 'array' || el.dataset.kind === 'object') el.value = JSON.stringify(v, null, 2);
        else el.value = String(v);
      }
    });
    ul.appendChild(li);
  }
}

/* ---------------- 连接与初始化 ---------------- */
async function reconnect() {
  state.base = ($('baseUrl').value.trim() || DEFAULT_BASE).replace(/\/+$/, '');
  state.token = $('token').value.trim();
  await store.save(state.base, state.token);
  try {
    const h = await health();
    if (!h) throw new Error('health 无响应');
    setStatus('ok', `已连接 v${h.version} · ${h.tools} 个工具`);
    const init = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      // 版本单一源：从 manifest 读（r49 修掉硬编码 1.9.0 的陈旧漂移）
      clientInfo: { name: 'playwright-verify-extension', version: (chrome.runtime?.getManifest?.() || {}).version || 'dev' },
      capabilities: {},
    });
    const listed = await rpc('tools/list', {});
    state.tools = listed.tools || [];
    $('serverInfo').textContent =
      `已连接 ${init.serverInfo?.name || ''} v${init.serverInfo?.version || h.version} · ${state.tools.length} 个工具`;
    renderToolList();
    if (!state.selected && state.tools.length) selectTool(state.tools[0].name);
  } catch (e) {
    // 失败要给可执行的下一步（r51）：裸 "Failed to fetch" 分不清「桥没起/口令错/地址错」
    setStatus('err', `连接失败：${e.message} —— 桥未运行？在项目目录执行 node mcp/bridge.mjs 起桥后点「保存并重连」（独立模式可不依赖桥）`);
  }
}

async function init() {
  const cfg = await store.load();
  $('baseUrl').value = cfg.base || DEFAULT_BASE;
  $('token').value = cfg.token || '';
  $('saveCfg').addEventListener('click', reconnect);
  $('toolFilter').addEventListener('input', renderToolList);
  $('runBtn').addEventListener('click', runTool);
  $('resetBtn').addEventListener('click', () => state.selected && selectTool(state.selected.name));
  $('copyBtn').addEventListener('click', () => {
    globalThis.navigator?.clipboard?.writeText(state.lastResult || '')
      .then(() => { $('runStatus').textContent = '结果已复制'; })
      .catch(() => { $('runStatus').textContent = '复制失败（浏览器未授权剪贴板）'; });
  });
  // 模式恢复（pv_mode，与悬浮球同键）：默认 mcp；本地模式不发起连接（独立=不打桥）
  let savedMode = 'mcp';
  try { savedMode = (await chrome.storage.local.get(['pv_mode'])).pv_mode || 'mcp'; } catch { /* 默认 mcp */ }
  if (savedMode === 'local') {
    setMode('local', { silent: true });
  } else {
    await reconnect();
    applyMode({ silent: true }); // 统一按钮文案/禁用面（mcp 默认态也走同一渲染路径）
  }
  $('modeBtn').addEventListener('click', () => {
    setMode(state.mode === 'local' ? 'mcp' : 'local');
  });
}

init();
