/**
 * floating.js — 猫耳悬浮球（内容脚本，所有网页常驻）
 *
 * 形态参考「沉浸式翻译」的悬浮球：右缘一颗可拖拽的猫耳球，点开快捷面板 ——
 * 🎬 一键录制当前页 / ⏹ 结束保存 / ▶ 快速回放 / 打开完整控制台；
 * 录制中球体脉冲 + 步数角标。
 *
 * 架构（三条硬边界）：
 *   1) Shadow DOM 隔离 —— 页面 CSS 污染不了悬浮器，悬浮器样式也绝不漏进页面；
 *   2) 内容脚本不直接 fetch 127.0.0.1（页面 CSP/CORS 会拦）—— 一切桥调用走
 *      MV3 Service Worker 中转（background.js），口令只存在扩展 storage；
 *   3) 敏感字段（口令/卡号一类）录制期即跳过 —— 凭据绝不进录制数据、
 *      绝不进中转发包、绝不进生成脚本。
 *
 * 本文件是经典脚本（内容脚本不能用 ESM）；Node 测试用 stub DOM + chrome 存根
 * 在 vm 里真跑本文件，观察挂载树/监听器/发包来断言行为。
 */
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (window.__pvFloatingInjected) return; // 幂等：重复注入直接退出
  var core = (typeof pvRecorderCore !== 'undefined') ? pvRecorderCore : (globalThis && globalThis.pvRecorderCore);
  if (!core) return; // 录制核没装上（注入顺序问题）就整个不启，不半残
  window.__pvFloatingInjected = true;

  /* ================= 状态 ================= */
  var recording = false;
  var rawSteps = [];
  var recordings = []; // 多条录制列表 [{id,name,url,steps,savedAt}]（单槽升级）
  var activeId = '';   // 当前选中（回放/生成的目标）
  var renamingId = ''; // 行内重命名中的录制 id（空 = 无）
  var rpcSeq = 0;

  /* ================= 基础工具 ================= */
  function pageHref() { return String(window.location && window.location.href || ''); }
  // 导航路径从 href 字符串剥域名得到 —— 不碰 URL 的 pathname（中文/空格路径会百分号编码静默指错，H15 同款坑）
  function navPathOf(href) { var p = String(href || '').replace(/^https?:\/\/[^\/]+/, ''); return p || '/'; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function logLine(text) {
    if (logEl) {
      logEl.textContent = String(text || '').slice(0, 500);
    }
  }
  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          resolve(resp || { ok: false, error: '中转无响应（Service Worker 未就绪？）' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }
  function bridgeCall(name, args) {
    // 独立模式第二层守卫（r49）：按钮面已停用，这里兜底 —— 桥调用在本地模式绝不发出
    if (mode === 'local') {
      return Promise.resolve({ ok: false, error: '独立模式：此功能需要 MCP 桥（点 ⚡ 切回依赖模式）' });
    }
    return send({ type: 'pv-bridge', method: 'tools/call', params: { name: name, arguments: args } });
  }
  /** 结构化结果 → 关键事实一行（纯函数，vm 可测）：
   *  verdict 不重复（徽标已带）；顶层标量 + 一层嵌套标量 + 数组计数（0 也如实），
   *  上限 4 条；键名/值原样保真（不翻译不美化）；非对象 → ''（不硬凑）。 */
  function pvFactsLine(sc, max) {
    if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return '';
    var cap = max > 0 ? max : 4;
    var facts = [];
    var push = function (k, v) {
      if (facts.length >= cap) return;
      if (v === null || v === undefined || typeof v === 'object') return;
      if (k === 'verdict') return;
      facts.push(k + ' ' + String(v));
    };
    Object.keys(sc).forEach(function (k) {
      var v = sc[k];
      if (Array.isArray(v)) { push(k + ' count', v.length); return; }
      if (v && typeof v === 'object') {
        Object.keys(v).forEach(function (k2) { push(k + '.' + k2, v[k2]); });
        return;
      }
      push(k, v);
    });
    return facts.join(' · ');
  }
  function resultTextOf(resp) {
    if (!resp) return '无响应';
    var j = resp.json || {};
    if (j.error) return '错误 ' + (j.error.code || '') + '：' + (j.error.message || '未知');
    var r = j.result || {};
    // verdict 徽标：工具的结构化判定（Pass/Fail/Blocked…）前置一眼可见，值保真不改写
    var sc = r.structuredContent;
    var verdict = (sc && typeof sc.verdict === 'string' && sc.verdict) ? ('【' + sc.verdict + '】 ') : '';
    // 富渲染：关键事实一行前置（verdict · facts | 正文），正文截 300 保日志紧凑；无事实不硬凑
    var facts = pvFactsLine(sc);
    var head = verdict + (facts ? facts + ' | ' : '');
    if (r.isError) return head + '结果不成立：' + String(r.content && r.content[0] && r.content[0].text || '').slice(0, 300);
    return head + String(r.content && r.content[0] && r.content[0].text || JSON.stringify(r)).slice(0, 300);
  }

  /* ================= 录制捕获 ================= */
  function elDescriptor(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = String(el.tagName || '').toLowerCase();
    if (!tag || tag === 'html' || tag === 'body' || tag === 'pv-floating') return null;
    var get = function (n) { return String(el.getAttribute && el.getAttribute(n) || ''); };
    var label = '';
    var aria = get('aria-label');
    if (aria) label = aria;
    else if (el.labels && el.labels.length) label = String(el.labels[0].textContent || '').trim();
    else {
      var pid = get('id');
      if (pid && document.querySelector) {
        var lb = document.querySelector('label[for="' + pid + '"]');
        if (lb) label = String(lb.textContent || '').trim();
      }
    }
    var named = tag === 'button' || tag === 'a' || tag === 'summary';
    var text = named ? String(el.textContent || '').trim() : '';
    return {
      tag: tag,
      type: get('type'),
      autocomplete: get('autocomplete'),
      testid: get('data-testid') || get('data-test-id'),
      label: label,
      name: get('aria-label') || text,
      placeholder: get('placeholder'),
      text: text || String(el.textContent || '').trim().slice(0, 60),
      id: String(el.id || ''),
      nameAttr: get('name'),
    };
  }

  var TEXT_TYPES = ['text', 'email', 'search', 'tel', 'url', 'number', ''];

  function captureStep(kind, target) {
    if (!recording) return;
    var path = (target && target.composedPath && target.composedPath()) || [];
    // 语义目标取 composedPath 首元素：页面 web component 影子树里的事件在 document 层
    // 会被重定向成 host（录到的是整棵影子树的拼接文本——真机实测抓过）；host 自身仍靠 contains 排除
    var el = (path && path[0]) || (target && target.target);
    // 悬浮器自身不录（Shadow DOM 事件会冒泡到这里）
    if ((hostEl && (path.indexOf(hostEl) !== -1)) || (hostEl && hostEl.contains && hostEl.contains(el))) return;
    if (kind === 'keydown') {
      // key 在事件上不在元素上（真机实测抓过：读 el.key 恒空 → press 步骤永远录不进）
      var key = String((target && target.key) || '');
      if (key !== 'Enter') return;
      var dEnter = elDescriptor(el);
      if (!dEnter || core.isSensitiveField(dEnter)) return;
      rawSteps.push({ act: 'press', locator: core.buildLocator(dEnter), key: 'Enter' });
      updateBadge();
      return;
    }
    var desc = elDescriptor(el);
    if (!desc) return;
    if (core.isSensitiveField(desc)) return; // 敏感字段不录：值只留在页面里
    var loc = core.buildLocator(desc);
    if (kind === 'click') {
      if (desc.type === 'checkbox' || desc.type === 'radio') return; // 由 change 统一记 check/uncheck
      if (!loc) return;
      rawSteps.push({ act: 'click', locator: loc });
    } else if (kind === 'input' || kind === 'change') {
      var v = String(el && el.value || '');
      if (desc.tag === 'select') rawSteps.push({ act: 'select', locator: loc, value: v });
      else if (desc.type === 'checkbox') rawSteps.push({ act: el.checked ? 'check' : 'uncheck', locator: loc });
      else if (desc.type === 'radio') { if (el.checked) rawSteps.push({ act: 'click', locator: loc }); return; }
      else if (TEXT_TYPES.indexOf(desc.type) !== -1) rawSteps.push({ act: 'fill', locator: loc, value: v });
      else return;
    } else return;
    updateBadge();
  }

  /* ================= 回放（内容脚本内轻量执行） ================= */
  // 深搜：querySelectorAll 不进影子树，而组件化页面（Gitee 仓库头部等 web component）
  // 的交互目标常在开放影子树里 —— 递归扫 open shadowRoot（深度上限防病态页面）。
  var DEEP_SCAN_MAX = 4;
  function deepQueryAll(root, sel, depth) {
    var out = [];
    if (!root || !root.querySelectorAll) return out;
    var nodes = root.querySelectorAll(sel);
    for (var k = 0; k < nodes.length; k++) out.push(nodes[k]);
    if (depth <= 0) return out;
    var all = root.querySelectorAll('*');
    for (var m = 0; m < all.length; m++) {
      if (all[m].shadowRoot) out = out.concat(deepQueryAll(all[m].shadowRoot, sel, depth - 1));
    }
    return out;
  }
  function findElement(q) {
    var doc = document;
    var all, i;
    try {
      if (q.mode === 'testid') {
        all = deepQueryAll(doc, '[data-testid]', DEEP_SCAN_MAX);
        for (i = 0; i < all.length; i++) if (all[i].getAttribute('data-testid') === q.value) return all[i];
        return null;
      }
      if (q.mode === 'placeholder') {
        all = deepQueryAll(doc, '[placeholder]', DEEP_SCAN_MAX);
        for (i = 0; i < all.length; i++) if (String(all[i].getAttribute('placeholder') || '') === q.value) return all[i];
        return null;
      }
      if (q.mode === 'selector') {
        return doc.querySelector ? doc.querySelector(q.value) : null;
      }
      if (q.mode === 'label') {
        all = deepQueryAll(doc, 'label, input, textarea, select', DEEP_SCAN_MAX);
        for (i = 0; i < all.length; i++) {
          var e = all[i];
          if (String(e.textContent || '').trim() === q.value) return e;
          if (e.labels && e.labels.length && String(e.labels[0].textContent || '').trim() === q.value) return e;
        }
        return null;
      }
      if (q.mode === 'role') {
        all = deepQueryAll(doc, '*', DEEP_SCAN_MAX);
        for (i = 0; i < all.length; i++) {
          var e2 = all[i];
          var d2 = elDescriptor(e2);
          if (!d2) continue;
          if (core.deriveRole(d2) !== q.role) continue;
          if ((d2.name || '') === q.value) return e2;
        }
        return null;
      }
      if (q.mode === 'text') {
        // 主候选集：可点语义元素 + 标题（录制可能点到 README 标题这类非按钮）
        all = deepQueryAll(doc, 'button, a, summary, h1, h2, h3, label, [role="button"], [role="link"], [role="heading"], [role="tab"]', DEEP_SCAN_MAX);
        for (i = 0; i < all.length; i++) if (String(all[i].textContent || '').trim() === q.value) return all[i];
        // 兜底：任意元素精确整段文本匹配（含开放影子树——组件化页面的描述区/标题在这里）
        all = deepQueryAll(doc, '*', DEEP_SCAN_MAX);
        for (i = 0; i < all.length; i++) if (String(all[i].textContent || '').trim() === q.value) return all[i];
        return null;
      }
    } catch (e) { return null; }
    return null;
  }

  function fire(el, type) {
    if (el && el.dispatchEvent) {
      try { el.dispatchEvent({ type: type }); } catch (e) { /* 存根/老页面：忽略 */ }
    }
  }
  function setValue(el, v) {
    var proto = null;
    if (window.HTMLInputElement && el.tagName === 'INPUT') proto = window.HTMLInputElement.prototype;
    else if (window.HTMLTextAreaElement && el.tagName === 'TEXTAREA') proto = window.HTMLTextAreaElement.prototype;
    var applied = false;
    if (proto && Object.getOwnPropertyDescriptor) {
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) { desc.set.call(el, v); applied = true; }
    }
    if (!applied) el.value = v;
    fire(el, 'input');
    fire(el, 'change');
  }

  async function replaySteps(steps) {
    var lines = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i] || {};
      var line = (i + 1) + '. ' + core.describeStep(s) + ' ';
      var q;
      try { q = core.locatorToQuery(s.locator); }
      catch (e) { lines.push(line + '✗ 定位无效：' + (e && e.message || e)); return lines; }
      var el = findElement(q);
      if (!el) { lines.push(line + '✗ 元素未找到，已停止（绝不盲点下一个）'); return lines; }
      try {
        if (s.act === 'click') el.click();
        else if (s.act === 'fill') { if (el.focus) el.focus(); setValue(el, String(s.value || '')); }
        else if (s.act === 'press') { if (el.focus) el.focus(); fire(el, 'keydown'); }
        else if (s.act === 'check' || s.act === 'uncheck') { el.checked = s.act === 'check'; fire(el, 'change'); }
        else if (s.act === 'select') { el.value = String(s.value || ''); fire(el, 'change'); }
        else if (s.act === 'hover') fire(el, 'mouseover');
        lines.push(line + '✓');
      } catch (e) { lines.push(line + '✗ ' + (e && e.message || e)); return lines; }
      await sleep(120);
    }
    return lines;
  }

  /* ================= 存储（保存/回放素材） ================= */
  function findActive() { return core.findRecording(recordings, activeId); }
  function syncRecordingState() {
    var rec = findActive();
    var has = !!(rec && rec.steps && rec.steps.length);
    var local = mode === 'local';
    if (btnReplay) btnReplay.disabled = !has;
    if (btnGenerate) btnGenerate.disabled = !has || local; // 生成走桥：独立模式停用
    if (btnExport) btnExport.disabled = !has; // 导出是本地能力：独立模式照常可用
  }
  /** 双模应用（r49）：独立模式停用桥依赖按钮、状态点转橙、日志如实；切回走健康探活。 */
  function applyMode() {
    var local = mode === 'local';
    if (btnMode) btnMode.textContent = local ? '🔋 独立模式' : '⚡ 依赖 MCP';
    if (btnExplore) btnExplore.disabled = local;
    if (btnCollect) btnCollect.disabled = local;
    if (btnNl) btnNl.disabled = local;
    syncRecordingState();
    if (local) {
      if (dotEl) {
        dotEl.className = 'pv-dot pv-local';
        dotEl.title = '独立模式：录制/回放/导出本地可用（点 ⚡ 切回依赖模式）';
      }
      logLine('独立模式：录制/回放/导出 JSON 本地可用；巡检/采集/生成/NL 需要 MCP 桥（点 ⚡ 切回）。');
    } else {
      refreshStatus();
    }
  }
  function persistRecordings() {
    try {
      chrome.storage.local.set({ pv_recordings_list: recordings });
      // 旧单槽继续写最新一条（兼容旧读取方；列表是管理面单一源）
      var act = findActive() || (recordings.length ? recordings[0] : null);
      if (act) chrome.storage.local.set({ pv_recordings: { url: act.url, steps: act.steps, savedAt: act.savedAt } });
    } catch (e) { /* 存储不可用时内存态仍在 */ }
  }
  function saveRecording(url, steps) {
    var made = core.makeRecording('录制 ' + new Date().toLocaleTimeString(), url, steps);
    var added = core.addRecording(recordings, made);
    recordings = added.list;
    activeId = made.id;
    return { rec: made, dropped: added.dropped };
  }
  function renderRecordingList() {
    if (!recListEl) return;
    recListEl.textContent = '';
    recordings.forEach(function (rec) {
      var row = document.createElement('div');
      row.className = 'pv-rec-row' + (rec.id === activeId ? ' is-active' : '');
      row.setAttribute('data-rec-id', rec.id);
      if (renamingId === rec.id) {
        // 行内重命名：输入框替代名字；Enter 提交（空名由纯函数拒绝 + 日志如实）、Esc 取消
        var input = document.createElement('input');
        input.className = 'pv-rec-rename';
        input.value = rec.name;
        input.setAttribute('data-rename-input', rec.id);
        row.appendChild(input);
      } else {
        var name = document.createElement('span');
        name.textContent = rec.name;
        row.appendChild(name);
        var ren = document.createElement('button');
        ren.className = 'pv-rec-ren';
        ren.setAttribute('data-ren', rec.id);
        ren.textContent = '✎';
        row.appendChild(ren);
      }
      var meta = document.createElement('span');
      meta.textContent = rec.steps.length + ' 步';
      var del = document.createElement('button');
      del.className = 'pv-rec-del';
      del.setAttribute('data-del', rec.id);
      del.textContent = 'X';
      // name/input 已在各自分支 append；此处只补 meta/del（name 在重命名分支为 undefined——真机钉抓过）
      row.appendChild(meta);
      row.appendChild(del);
      recListEl.appendChild(row);
    });
    recListEl.style.display = recordings.length ? 'block' : 'none';
  }
  function restoreState() {
    try {
      chrome.storage.local.get(['pv_recordings_list', 'pv_recordings', 'pv_ball_pos', 'pv_mode'], function (v) {
        var list = (v && Array.isArray(v.pv_recordings_list)) ? v.pv_recordings_list : [];
        if (!list.length && v && v.pv_recordings) {
          // 旧单槽迁移（老数据不丢），迁完持久化新形状
          list = core.migrateLegacyRecordings(v.pv_recordings);
          if (list.length) { try { chrome.storage.local.set({ pv_recordings_list: list }); } catch (e2) { /* 忽略 */ } }
        }
        recordings = list;
        activeId = recordings.length ? recordings[0].id : '';
        mode = (v && v.pv_mode === 'local') ? 'local' : 'mcp'; // 双模恢复（r49，默认 mcp 保持旧行为）
        syncRecordingState();
        renderRecordingList();
        applyMode();
        if (v && v.pv_ball_pos && ballEl) {
          var pos = v.pv_ball_pos;
          if (typeof pos.top === 'number') ballEl.style.top = pos.top + 'px';
          if (typeof pos.right === 'number') ballEl.style.right = pos.right + 'px';
        }
      });
    } catch (e) { /* 存根或权限问题：不阻塞注入 */ }
  }

  /* ================= Shadow DOM UI ================= */
  var CAT_SVG =
    '<svg viewBox="0 0 64 64" width="46" height="46" aria-hidden="true">'
    + '<defs><linearGradient id="pvg" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#ffb6d9"/><stop offset="1" stop-color="#b39dff"/>'
    + '</linearGradient></defs>'
    + '<path d="M10 22 L14 4 L26 14 Z" fill="url(#pvg)"/>'
    + '<path d="M54 22 L50 4 L38 14 Z" fill="url(#pvg)"/>'
    + '<circle cx="32" cy="34" r="22" fill="url(#pvg)"/>'
    + '<ellipse cx="24" cy="33" rx="2.6" ry="3.4" fill="#4a3b52"/>'
    + '<ellipse cx="40" cy="33" rx="2.6" ry="3.4" fill="#4a3b52"/>'
    + '<circle cx="18" cy="40" r="3.2" fill="#ff8fb8" opacity="0.55"/>'
    + '<circle cx="46" cy="40" r="3.2" fill="#ff8fb8" opacity="0.55"/>'
    + '<path d="M29 41 Q32 44 35 41" stroke="#4a3b52" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
    + '</svg>';

  var STYLE = ''
    + ':host{all:initial;}'
    + '.pv-ball{position:fixed;right:14px;top:38%;z-index:2147483647;cursor:grab;user-select:none;'
    + 'width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;'
    + 'filter:drop-shadow(0 4px 10px rgba(150,100,200,.35));transition:transform .15s ease;}'
    + '.pv-ball:hover{transform:scale(1.08);}'
    + '.pv-ball.pv-rec{animation:pvPulse 1s ease-in-out infinite;}'
    + '@keyframes pvPulse{0%,100%{transform:scale(1);}50%{transform:scale(1.14);}}'
    + '.pv-badge{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;border-radius:10px;'
    + 'background:#ff5d8f;color:#fff;font:600 11px/20px system-ui,sans-serif;text-align:center;'
    + 'padding:0 5px;box-shadow:0 2px 6px rgba(255,93,143,.5);display:none;}'
    + '.pv-panel{position:fixed;right:76px;top:36%;z-index:2147483646;width:250px;border-radius:16px;'
    // 高度帽+内滚动（r49 e2e 实测两连坑）：① 高内容把底部按钮（含模式钮）顶出视口；
    // ② 帽若用 100vh 仍不够——面板 top:36%，盒子本身会伸出视口底且 fixed 面板不可滚到，
    // 帽必须按 36% 以下的剩余空间算（64vh - 边距），面板整体落进视口、内滚动才可达
    + 'max-height:calc(64vh - 24px);overflow-y:auto;'
    + 'background:rgba(255,252,255,.97);box-shadow:0 10px 34px rgba(90,60,140,.28);'
    + 'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#3d2f4f;padding:12px;'
    + 'display:none;}'
    + '.pv-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}'
    + '.pv-title{font-weight:700;font-size:13px;}'
    + '.pv-dot{width:8px;height:8px;border-radius:50%;background:#c9c2d6;margin-left:auto;}'
    + '.pv-dot.pv-ok{background:#4cd97b;}.pv-dot.pv-bad{background:#ff6b81;}'
    + '.pv-dot.pv-local{background:#f5a623;}'
    + '.pv-btn{display:flex;align-items:center;gap:6px;width:100%;margin:5px 0;padding:7px 10px;'
    + 'border:none;border-radius:10px;background:#f3edff;color:#4a3b6b;cursor:pointer;font:inherit;}'
    + '.pv-btn:hover{background:#e8dcff;}'
    + '.pv-btn:disabled{opacity:.45;cursor:default;}'
    + '.pv-btn.pv-primary{background:linear-gradient(135deg,#ffd3ec,#d9c8ff);font-weight:600;}'
    + '.pv-goal{width:100%;box-sizing:border-box;margin:5px 0;padding:6px 8px;border:1px solid #e3d9f5;'
    + 'border-radius:8px;font:inherit;color:inherit;background:#fff;}'
    + '.pv-log{margin-top:8px;max-height:110px;overflow:auto;white-space:pre-wrap;word-break:break-all;'
    + 'font-size:11px;color:#6b5b8a;background:#faf7ff;border-radius:8px;padding:6px 8px;min-height:16px;}'
    + '.pv-rec-list{max-height:96px;overflow:auto;margin:4px 0;}'
    + '.pv-rec-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:8px;cursor:pointer;'
    + 'font-size:11px;color:#5a4a7a;}'
    + '.pv-rec-row.is-active{background:#f3edff;}'
    + '.pv-rec-del{margin-left:auto;border:none;background:none;cursor:pointer;color:#c2566e;font:inherit;}'
    + '.pv-rec-ren{border:none;background:none;cursor:pointer;color:#7a6a9a;font:inherit;}'
    + '.pv-rec-rename{flex:1;min-width:0;font:inherit;border:1px solid #d9c8ff;border-radius:6px;padding:2px 4px;}';

  function buildUi() {
    hostEl = document.createElement('pv-floating');
    hostEl.setAttribute('data-pv-floating', '1');
    hostEl.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;';
    var shadow = (hostEl.attachShadow) ? hostEl.attachShadow({ mode: 'open' }) : hostEl;

    var style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    ballEl = document.createElement('div');
    ballEl.className = 'pv-ball';
    ballEl.innerHTML = CAT_SVG;
    ballEl.title = 'playwright-verify 悬浮球';
    badgeEl = document.createElement('div');
    badgeEl.className = 'pv-badge';
    ballEl.appendChild(badgeEl);

    panelEl = document.createElement('div');
    panelEl.className = 'pv-panel';

    var mkBtn = function (act, label, primary) {
      var b = document.createElement('button');
      b.className = 'pv-btn' + (primary ? ' pv-primary' : '');
      b.setAttribute('data-act', act);
      b.textContent = label;
      panelEl.appendChild(b);
      return b;
    };
    var head = document.createElement('div');
    head.className = 'pv-head';
    head.appendChild((function () {
      var s = document.createElement('span'); s.textContent = '🐱'; return s;
    })());
    head.appendChild((function () {
      var s = document.createElement('span'); s.className = 'pv-title'; s.textContent = 'playwright-verify'; return s;
    })());
    dotEl = document.createElement('span');
    dotEl.className = 'pv-dot';
    head.appendChild(dotEl);
    panelEl.appendChild(head);

    mkBtn('record', '🎬 一键录制当前页', true);
    mkBtn('stop', '⏹ 结束保存');
    recListEl = document.createElement('div');
    recListEl.className = 'pv-rec-list';
    panelEl.appendChild(recListEl);
    btnReplay = mkBtn('replay', '▶ 快速回放');
    btnReplay.disabled = true;
    goalEl = document.createElement('input');
    goalEl.className = 'pv-goal';
    goalEl.setAttribute('data-act', 'goal');
    goalEl.setAttribute('placeholder', '自然语言测试目标（可选）');
    panelEl.appendChild(goalEl);
    btnGenerate = mkBtn('generate', '📝 用录制生成脚本');
    btnGenerate.disabled = true;
    btnExport = mkBtn('export', '📤 导出录制 JSON');
    btnExport.disabled = true;
    btnExplore = mkBtn('explore', '🔍 页面巡检');
    btnCollect = mkBtn('collect', '📊 表格采集');
    btnNl = mkBtn('nl', '🤖 NL 测试');
    mkBtn('console', '🖥 打开完整控制台'); // 开控制台是扩展本地能力（SW 开 tab），独立模式保留
    btnMode = mkBtn('mode', '⚡ 依赖 MCP');
    logEl = document.createElement('div');
    logEl.className = 'pv-log';
    panelEl.appendChild(logEl);

    shadow.appendChild(ballEl);
    shadow.appendChild(panelEl);

    bindBall();
    bindPanel();
    updateBadge();
    restoreState();
    refreshStatus();
    (document.documentElement || document.body).appendChild(hostEl);
  }

  function setPanelOpen(open) {
    panelEl.style.display = open ? 'block' : 'none';
    if (open) refreshStatus();
  }
  function refreshStatus() {
    send({ type: 'pv-health' }).then(function (r) {
      if (!dotEl) return;
      dotEl.className = 'pv-dot ' + (r && r.ok ? 'pv-ok' : 'pv-bad');
      dotEl.title = r && r.ok ? '桥已连接' : '桥未连接（先起 node mcp/bridge.mjs）';
    });
  }
  function updateBadge() {
    if (!badgeEl || !ballEl) return;
    if (recording) {
      badgeEl.style.display = 'block';
      badgeEl.textContent = String(rawSteps.length);
      ballEl.className = 'pv-ball pv-rec';
    } else {
      badgeEl.style.display = 'none';
      ballEl.className = 'pv-ball';
    }
  }

  /* ================= 交互接线 ================= */
  var dragMoved = 0;
  function bindBall() {
    var onDown = function (e) {
      var startX = e.clientX || 0, startY = e.clientY || 0;
      dragMoved = 0;
      var onMove = function (ev) {
        var dx = (ev.clientX || 0) - startX, dy = (ev.clientY || 0) - startY;
        dragMoved = Math.abs(dx) + Math.abs(dy);
        // 球体自身是 position:fixed 贴视口，必须改球的内联定位才会真动（只改 host 是空操作——真机实测抓过）
        ballEl.style.right = Math.max(0, Math.min(200, -(dx))) + 'px';
        ballEl.style.top = Math.max(0, (startY + dy - 26)) + 'px';
      };
      var onUp = function () {
        if (document.removeEventListener) {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        try {
          chrome.storage.local.set({
            pv_ball_pos: { top: parseInt(ballEl.style.top || '0', 10) || 0, right: parseInt(ballEl.style.right || '0', 10) || 0 },
          });
        } catch (err) { /* 忽略 */ }
      };
      if (document.addEventListener) {
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }
    };
    var onClick = function () {
      if (dragMoved >= 5) return; // 拖过就不是点
      setPanelOpen(panelEl.style.display !== 'block');
    };
    ballEl.addEventListener('mousedown', onDown);
    ballEl.addEventListener('click', onClick);
  }

  function bindPanel() {
    panelEl.addEventListener('click', function (e) {
      var t = (e.composedPath && e.composedPath()[0]) || e.target;
      var act = t && t.getAttribute && t.getAttribute('data-act');
      if (!act) return;
      if (act === 'record') {
        rawSteps = [];
        recording = true;
        updateBadge();
        logLine('录制中…点击页面操作，敏感字段自动跳过。');
      } else if (act === 'stop') {
        recording = false;
        var steps = core.normalizeRecordedSteps(rawSteps);
        var saved = saveRecording(pageHref(), steps);
        updateBadge();
        syncRecordingState();
        renderRecordingList();
        persistRecordings();
        logLine('已保存 ' + steps.length + ' 步 →「' + saved.rec.name + '」'
          + (saved.dropped ? '（容量 ' + core.MAX_RECORDINGS + ' 已满，最旧 ' + saved.dropped + ' 条已淘汰）' : '')
          + '（敏感字段未录）。');
      } else if (act === 'replay') {
        var active = findActive();
        if (!active) { logLine('没有可回放的录制。'); return; }
        if (active.url !== pageHref()) {
          logLine('录制页是 ' + active.url + '，当前是 ' + pageHref() + ' —— 请回到录制页面再回放。');
          return;
        }
        var steps2 = core.normalizeRecordedSteps(active.steps);
        replaySteps(steps2).then(function (lines) { logLine(lines.join('\n')); });
      } else if (act === 'generate') {
        if (mode === 'local') { logLine('独立模式：生成需要 MCP 桥（点 ⚡ 切回依赖模式）；导出 JSON 是本地能力，可用。'); return; }
        var genRec = findActive();
        if (!genRec || !genRec.steps || !genRec.steps.length) { logLine('没有可生成的录制。'); return; }
        var input = core.stepsToGenerateInput(genRec.steps, { navPath: navPathOf(genRec.url), write: false });
        logLine('生成中…');
        bridgeCall('generate_scripts', input).then(function (r) { logLine(resultTextOf(r)); });
      } else if (act === 'export') {
        // 导出录制为 generate_scripts 输入 JSON（r48）：纯本地下载，不走桥不写盘——
        // 文件落在浏览器下载目录，用户直接带进自己项目的生成流（write/overwrite 恒 false 语义见 core）。
        // 整链 try/catch：导出是增强面，任何异常只进日志绝不掀翻面板（崩了不是红了）。
        try {
          var expRec = findActive();
          if (!expRec || !expRec.steps || !expRec.steps.length) { logLine('没有可导出的录制。'); return; }
          var expInput = core.stepsToGenerateInput(expRec.steps, { navPath: navPathOf(expRec.url), write: false });
          var expJson = JSON.stringify(expInput, null, 2);
          var expName = core.exportFileName(expRec.name, Date.now().toString(36));
          var blob = new Blob([expJson], { type: 'application/json' });
          var expUrl = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = expUrl;
          a.download = expName;
          (document.body || document.documentElement).appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { try { URL.revokeObjectURL(expUrl); } catch (e2) { /* 已回收 */ } }, 10000);
          logLine('已导出 ' + expName + '（' + expInput.pages[0].steps.length + ' 步 · generate_scripts 输入形态 · write:false）——在浏览器下载目录，可直接带进项目的生成流。');
        } catch (e) { logLine('导出失败：' + (e && e.message || e)); }
      } else if (act === 'explore') {
        if (mode === 'local') { logLine('独立模式：巡检需要 MCP 桥（点 ⚡ 切回依赖模式）。'); return; }
        logLine('巡检中…');
        bridgeCall('explore_page', { url: pageHref() }).then(function (r) { logLine(resultTextOf(r)); });
      } else if (act === 'collect') {
        if (mode === 'local') { logLine('独立模式：采集需要 MCP 桥（点 ⚡ 切回依赖模式）。'); return; }
        logLine('采集中…');
        bridgeCall('collect_table', { url: pageHref() }).then(function (r) { logLine(resultTextOf(r)); });
      } else if (act === 'nl') {
        if (mode === 'local') { logLine('独立模式：NL 测试需要 MCP 桥（点 ⚡ 切回依赖模式）。'); return; }
        var goal = goalEl && String(goalEl.value || '').trim();
        if (!goal) { logLine('先在输入框写测试目标，例如「点击加入购物车后购物车里应看到该商品」。'); return; }
        logLine('规划执行中…');
        bridgeCall('nl_test_goal', { url: pageHref(), goal: goal }).then(function (r) { logLine(resultTextOf(r)); });
      } else if (act === 'mode') {
        // 双模切换（r49）：持久化 pv_mode（与面板同键）；本地→切回时重新探活
        mode = (mode === 'local') ? 'mcp' : 'local';
        try { chrome.storage.local.set({ pv_mode: mode }); } catch (e) { /* 存储不可用不阻塞 */ }
        applyMode();
      } else if (act === 'console') {
        send({ type: 'pv-open-panel' });
      }
    });
    var onGoalKey = function (e) {
      var t = (e.composedPath && e.composedPath()[0]) || e.target;
      if (t === goalEl && e.key === 'Enter') panelEl.click();
    };
    panelEl.addEventListener('keydown', onGoalKey);
    if (recListEl) {
      recListEl.addEventListener('click', function (e) {
        var t = (e.composedPath && e.composedPath()[0]) || e.target;
        var delId = t && t.getAttribute && t.getAttribute('data-del');
        if (delId) {
          recordings = core.deleteRecording(recordings, delId);
          if (activeId === delId) activeId = recordings.length ? recordings[0].id : '';
          syncRecordingState();
          renderRecordingList();
          persistRecordings();
          var now = findActive();
          logLine(recordings.length ? '已删除；当前选中「' + (now ? now.name : '') + '」' : '已全部删除（没有可回放的录制了）。');
          return;
        }
        var renId = t && t.getAttribute && t.getAttribute('data-ren');
        if (renId) {
          renamingId = renId;
          renderRecordingList();
          return;
        }
        var rowId = t && t.getAttribute && t.getAttribute('data-rec-id');
        if (rowId) {
          activeId = rowId;
          renamingId = '';
          syncRecordingState();
          renderRecordingList();
        }
      });
      recListEl.addEventListener('keydown', function (e) {
        var t = (e.composedPath && e.composedPath()[0]) || e.target;
        var rid = t && t.getAttribute && t.getAttribute('data-rename-input');
        if (!rid) return;
        if (e.key === 'Escape') { renamingId = ''; renderRecordingList(); return; }
        if (e.key !== 'Enter') return;
        var before = (core.findRecording(recordings, rid) || {}).name;
        var next = core.renameRecording(recordings, rid, t.value);
        var after = (core.findRecording(next, rid) || {}).name;
        if (after === before) {
          logLine('名称不能为空（未改动）。');
        } else {
          recordings = next;
          logLine('已重命名 →「' + after + '」');
          persistRecordings();
        }
        renamingId = '';
        syncRecordingState();
        renderRecordingList();
      });
    }
  }

  /* ================= 启动 ================= */
  globalThis.pvFactsLine = pvFactsLine;

  var hostEl = null, panelEl = null, ballEl = null, badgeEl = null, logEl = null, dotEl = null, goalEl = null;
  var btnReplay = null, btnGenerate = null, btnExport = null, recListEl = null;
  var btnExplore = null, btnCollect = null, btnNl = null, btnMode = null;
  // 插拔式双模（r49）：mcp=依赖桥（巡检/采集/生成/NL 走中转）；local=独立模式
  // （录制/回放/导出/console 开控制台=本地能力照常；桥依赖按钮停用+诚实提示）。
  // 与面板同键 pv_mode 持久化。
  var mode = 'mcp';

  buildUi();
  document.addEventListener('click', function (e) { captureStep('click', e); }, true);
  document.addEventListener('input', function (e) { captureStep('input', e); }, true);
  document.addEventListener('change', function (e) { captureStep('change', e); }, true);
  document.addEventListener('keydown', function (e) { captureStep('keydown', e); }, true);
  // 页面跳转（真导航）时录制态不跨页：诚实停止，回放按保存的 URL 守门
  window.addEventListener('pagehide', function () {
    if (recording) {
      recording = false;
      updateBadge();
    }
  });
})();
