/* Web RPA 独立模式核心（插拔式：不依赖 MCP/桥接也能录制回放）
 * 同一经典脚本被两处加载（无构建工具）：
 *   - content_scripts（悬浮球侧）：createRecorder / replaySteps 在当前页工作
 *   - popup 页（控制台侧）：listLocal / saveLocal / deleteLocal / toMcpFlow 管理与升级
 * 存储：chrome.storage.local.rpaLocalFlows（与桥接侧 flows/ 目录互不相干，属「本地流程」）。
 * 能力边界（诚实）：原生录制捕获当前页 click/input/change（密码框不录）；
 *   回放为同页 DOM 操作（合成事件），跨页/下载/弹窗类流程请连桥接用 MCP 模式。 */
(function (g) {
  'use strict';

  var STORE_KEY = 'rpaLocalFlows';

  function cssEscape(s) {
    try { return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'); }
    catch (e) { return String(s); }
  }

  /* 元素定位：data-testid > #id > 受限深度 css 路径（跳过 rpa 自有类名，避免悬      浮球样式串进定位） */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [], cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      var part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cssEscape(cur.id)); break; }
      var cls = '';
      if (cur.className && typeof cur.className === 'string') {
        var cands = cur.className.trim().split(/\s+/).filter(function (c) { return c && c.indexOf('rpa') < 0; });
        cls = cands[0] || '';
      }
      if (cls) part += '.' + cssEscape(cls);
      var p = cur.parentElement;
      if (p && p.children && p.children.length > 1) {
        part += ':nth-child(' + (Array.prototype.indexOf.call(p.children, cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;
    var tid = el.getAttribute && el.getAttribute('data-testid');
    if (tid) return { strategy: 'testid', value: tid };
    if (el.id) return { strategy: 'css', value: '#' + cssEscape(el.id) };
    var path = cssPath(el);
    return path ? { strategy: 'css', value: path } : null;
  }

  function resolveNode(sel) {
    if (!sel || !sel.value) return null;
    try {
      if (sel.strategy === 'testid') {
        return document.querySelector('[data-testid="' + String(sel.value).replace(/"/g, '\\"') + '"]');
      }
      return document.querySelector(sel.value);
    } catch (e) { return null; }
  }

  function inBallHost(t) {
    return !!(t && t.closest && t.closest('#__rpa-ball-host'));
  }

  /* 原生录制器：capture 阶段监听 click/input/change/hover(mouseover)/press(keydown)；
   * 悬浮球自身与密码框不录；连续输入按元素合并（800ms）；
   * a[href] http(s) 链接点击识别为 goto 步（跨页=导航，回放走同源自续播）；
   * hover 去重（同元素 1s 内只记一步——菜单揭层场景足够）；press 只录 Enter/Escape */
  var EDITABLE = 'input,textarea,select,[contenteditable="true"],[contenteditable=""]';
  function createRecorder(onStep) {
    var steps = [], on = false;
    function push(s) { steps.push(s); if (onStep) onStep(steps); }
    function clickH(e) {
      if (!on || (typeof e.button === 'number' && e.button !== 0)) return;
      var t = e.target;
      if (inBallHost(t)) return;
      var el = (t && t.closest) ? t.closest('a,button,input,select,textarea,[role=button],[onclick],label,summary') : t;
      if (!el || el.nodeType !== 1) el = t;
      // 跨页链接 → goto 步（同源跳转在回放时由 sessionStorage 续播）
      if (el.tagName === 'A' && el.href && /^https?:/i.test(el.href)) {
        var cur = location.href.split('#')[0];
        var tgt = el.href.split('#')[0];
        if (tgt !== cur) { push({ op: 'goto', url: el.href, text: String(el.textContent || '').trim().slice(0, 30), ts: Date.now() }); return; }
      }
      var sel = selectorFor(el);
      if (!sel) return;
      push({ op: 'click', locator: sel, text: String((el.textContent) || '').trim().slice(0, 30), ts: Date.now() });
    }
    function valH(e) {
      if (!on) return;
      var el = e.target;
      if (inBallHost(el)) return;
      if (el && el.type === 'password') return; // 敏感值不落盘（红线）
      var tag = el && el.tagName ? el.tagName.toLowerCase() : '';
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      var sel = selectorFor(el);
      if (!sel) return;
      var v = (el.type === 'checkbox' || el.type === 'radio') ? String(el.checked) : String(el.value || '');
      var last = steps[steps.length - 1];
      if (last && last.op === 'fill' && last.locator.strategy === sel.strategy && last.locator.value === sel.value && (Date.now() - last.ts) < 800) {
        last.value = v; last.ts = Date.now();
        if (onStep) onStep(steps);
      } else {
        push({ op: 'fill', locator: sel, value: v, ts: Date.now() });
      }
    }
    function hoverH(e) {
      if (!on) return;
      var t = e.target;
      if (inBallHost(t) || !t || t.nodeType !== 1) return;
      var sel = selectorFor(t);
      if (!sel) return;
      var last = steps[steps.length - 1];
      if (last && last.op === 'hover' && last.locator.strategy === sel.strategy && last.locator.value === sel.value && (Date.now() - last.ts) < 1000) return;
      push({ op: 'hover', locator: sel, ts: Date.now() });
    }
    function pressH(e) {
      if (!on) return;
      var key = e.key;
      if (key !== 'Enter' && key !== 'Escape') return;
      var t = e.target;
      if (inBallHost(t)) return;
      var el = (t && t.nodeType === 1) ? t : null;
      var editable = el && el.closest && el.closest(EDITABLE);
      if (!editable && key === 'Enter') return; // Enter 只在可编辑语境录（表单提交语义）
      var sel = selectorFor(editable || el);
      if (!sel) return;
      push({ op: 'press', locator: sel, key: key, ts: Date.now() });
    }
    return {
      start: function () {
        if (on) return;
        on = true; steps = [];
        document.addEventListener('click', clickH, true);
        document.addEventListener('input', valH, true);
        document.addEventListener('change', valH, true);
        document.addEventListener('mouseover', hoverH, true);
        document.addEventListener('keydown', pressH, true);
      },
      stop: function () {
        on = false;
        document.removeEventListener('click', clickH, true);
        document.removeEventListener('input', valH, true);
        document.removeEventListener('change', valH, true);
        document.removeEventListener('mouseover', hoverH, true);
        document.removeEventListener('keydown', pressH, true);
        return steps.slice();
      },
      count: function () { return steps.length; },
      isOn: function () { return on; },
    };
  }

  /* 原生回放器：顺序执行、步间停顿、出错即停（返回 {ok,done,total,error?}）
   * v1.21.0：press（Enter/Escape 键事件链）、hover（mouseover 事件链，菜单揭层）、
   * goto（同源跨页：剩余步骤存 sessionStorage，新页面 content script 自动续播；
   *       跨源链接无法续播——sessionStorage 按 origin 隔离，回放在该步诚实停止） */
  var RESUME_KEY = 'rpaStandaloneResume';
  function saveResume(steps, i, gap, done) {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({ steps: steps, i: i, gapMs: gap, total: steps.length, done: done, ts: Date.now() }));
      return true;
    } catch (e) { return false; }
  }
  function clearResumeLater(ms) {
    setTimeout(function () { try { sessionStorage.removeItem(RESUME_KEY); } catch (e) { /* ignore */ } }, ms || 1500);
  }
  function fire(el, type) {
    var ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
    el.dispatchEvent(ev);
  }
  function replaySteps(steps, opts) {
    opts = opts || {};
    var gap = typeof opts.gapMs === 'number' ? opts.gapMs : 350;
    return new Promise(function (resolve) {
      var i = 0, done = 0;
      function next() {
        if (i >= steps.length) return resolve({ ok: true, done: done, total: steps.length });
        var s = steps[i++];
        try {
          if (s.op === 'goto') {
            var sameOrigin = false;
            try { sameOrigin = new URL(s.url, location.href).origin === location.origin; } catch (e) { sameOrigin = false; }
            if (!sameOrigin) {
              return resolve({ ok: false, done: done, total: steps.length, step: i,
                error: '第 ' + i + ' 步是跨源链接（' + String(s.url).slice(0, 60) + '）——独立模式续播仅支持同源跳转，已回放到此' });
            }
            saveResume(steps, i, gap, done);
            location.href = s.url;
            return resolve({ ok: true, done: done, total: steps.length, navigating: true, step: i });
          }
          var node = resolveNode(s.locator);
          if (!node) {
            return resolve({ ok: false, done: done, total: steps.length, step: i,
              error: '第 ' + i + ' 步找不到元素（' + (s.locator && s.locator.strategy || '') + '=' + String(s.locator && s.locator.value || '').slice(0, 60) + '）' });
          }
          if (node.scrollIntoView) node.scrollIntoView({ block: 'center' });
          if (s.op === 'click') {
            // 表单提交类点击会触发跨页导航（真实站点登录/查询流）——同源自续播（真实观察轮实锤的盲区）：
            // 点击前预存续播状态；若 1.5s 内页面未卸载（JS 拦截了提交）则自清，防陈旧续播误触发
            var isSubmit = !!(node.form && node.matches && node.matches('button[type="submit"],input[type="submit"],button:not([type])'));
            if (isSubmit) saveResume(steps, i, gap, done);
            node.click();
            if (isSubmit) { clearResumeLater(1500); done++; return resolve({ ok: true, done: done, total: steps.length, navigating: true, step: i }); }
          } else if (s.op === 'fill') {
            var tag = (node.tagName || '').toLowerCase();
            if (tag === 'select') {
              node.value = s.value; node.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (node.type === 'checkbox' || node.type === 'radio') {
              node.checked = String(s.value) === 'true'; node.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              node.focus();
              node.value = s.value;
              node.dispatchEvent(new Event('input', { bubbles: true }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else if (s.op === 'hover') {
            fire(node, 'pointerover'); fire(node, 'mouseover'); fire(node, 'mousemove');
          } else if (s.op === 'press') {
            var ke = { key: s.key, bubbles: true, cancelable: true };
            node.dispatchEvent(new KeyboardEvent('keydown', ke));
            node.dispatchEvent(new KeyboardEvent('keypress', ke));
            node.dispatchEvent(new KeyboardEvent('keyup', ke));
          } else {
            return resolve({ ok: false, done: done, total: steps.length, step: i, error: '未知步骤类型 ' + s.op });
          }
          done++;
        } catch (e) {
          return resolve({ ok: false, done: done, total: steps.length, step: i, error: '第 ' + i + ' 步执行出错: ' + ((e && e.message) || e) });
        }
        setTimeout(next, gap);
      }
      next();
    });
  }

  /* 同源自续播：goto 步导航前把剩余步骤写入 sessionStorage，新页面加载时由 content.js 调用本函数接续 */
  function maybeResume() {
    var raw = null;
    try { raw = sessionStorage.getItem(RESUME_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try { sessionStorage.removeItem(RESUME_KEY); } catch (e) { /* ignore */ }
    var st = null;
    try { st = JSON.parse(raw); } catch (e) { return null; }
    if (!st || !Array.isArray(st.steps)) return null;
    if (Date.now() - (st.ts || 0) > 60000) return null; // 60s 过期，防陈旧续播
    return st;
  }

  /* ---- 本地流程存储 ---- */
  function listLocal(cb) {
    try {
      chrome.storage.local.get(STORE_KEY, function (st) {
        var v = st && st[STORE_KEY];
        cb(Array.isArray(v) ? v : []);
      });
    } catch (e) { cb([]); }
  }
  function saveLocal(flow, cb) {
    listLocal(function (flows) {
      var idx = -1;
      for (var i = 0; i < flows.length; i++) if (flows[i].id === flow.id) { idx = i; break; }
      flow.updatedAt = Date.now();
      if (idx >= 0) flows[idx] = flow;
      else { flow.createdAt = flow.createdAt || Date.now(); flows.unshift(flow); }
      var o = {}; o[STORE_KEY] = flows;
      chrome.storage.local.set(o, function () { if (cb) cb(flow); });
    });
  }
  function deleteLocal(id, cb) {
    listLocal(function (flows) {
      var next = flows.filter(function (f) { return f.id !== id; });
      var o = {}; o[STORE_KEY] = next;
      chrome.storage.local.set(o, function () { if (cb) cb(next); });
    });
  }

  /* 升级映射：本地步骤 → MCP 流程 DSL（goto 起手；click/fill 带定位符）——
   * 独立模式录的流程可以「插」回 MCP 侧成为完整44 工具面下的流程 */
  function toMcpFlow(local, startUrl) {
    var url = startUrl || local.startUrl || '';
    var steps = [{ op: 'goto', seq: 1, url: url }];
    (local.steps || []).forEach(function (s, i) {
      var seq = i + 2;
      if (s.op === 'click') steps.push({ op: 'click', seq: seq, locators: [s.locator] });
      else if (s.op === 'fill') steps.push({ op: 'fill', seq: seq, locators: [s.locator], value: s.value });
    });
    // 默认断言：起始域 url 校验——升级后的流程必须可直接回放（无断言会被 L010 静态检查阻断，
    // 悬浮球列表 ▶ 不带 allowLintErrors，体感旅程实锤的缺口，v1.21.2 修复）
    var assertions = [];
    try { var origin = new URL(url, location.href).origin; if (origin) assertions.push({ kind: 'url', contains: origin, message: '流程应停留在起始站点（升级流程默认断言）' }); } catch (e) { /* url 不可解析则不加 */ }
    return {
      id: local.id, name: local.name, version: 1, startUrl: url, params: [],
      steps: steps, assertions: assertions, localPromoted: true,
      notes: ['由扩展独立模式本地流程升级（' + (local.steps || []).length + ' 步）'],
    };
  }

  /* 反向映射：MCP 流程 DSL → 本地流程（popup「导入」用；只取 goto+click/fill 可映射面） */
  function toLocalFromMcp(mcpFlow) {
    var steps = [];
    (mcpFlow.steps || []).forEach(function (s) {
      if (s.op === 'goto' && s.url) steps.push({ op: 'goto', url: s.url, ts: Date.now() });
      else if (s.op === 'click' && s.locators && s.locators[0]) steps.push({ op: 'click', locator: s.locators[0], ts: Date.now() });
      else if (s.op === 'fill' && s.locators && s.locators[0]) steps.push({ op: 'fill', locator: s.locators[0], value: s.value, ts: Date.now() });
      else if (s.op === 'hover' && s.locators && s.locators[0]) steps.push({ op: 'hover', locator: s.locators[0], ts: Date.now() });
      else if (s.op === 'press') steps.push({ op: 'press', locator: s.locators && s.locators[0] || { strategy: 'css', value: 'body' }, key: s.key || 'Enter', ts: Date.now() });
    });
    if (!steps.length) return null;
    return { id: mcpFlow.id || ('local-import-' + Date.now()), name: mcpFlow.name || mcpFlow.id || '导入流程', startUrl: mcpFlow.startUrl || (steps[0].op === 'goto' ? steps[0].url : ''), steps: steps, importedFromMcp: true };
  }

  g.RpaStandalone = {
    STORE_KEY: STORE_KEY,
    RESUME_KEY: RESUME_KEY,
    createRecorder: createRecorder,
    replaySteps: replaySteps,
    maybeResume: maybeResume,
    listLocal: listLocal,
    saveLocal: saveLocal,
    deleteLocal: deleteLocal,
    toMcpFlow: toMcpFlow,
    toLocalFromMcp: toLocalFromMcp,
    selectorFor: selectorFor,
    resolveNode: resolveNode,
  };
})(typeof window !== 'undefined' ? window : this);
