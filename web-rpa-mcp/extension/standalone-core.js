/* PagePilot 独立模式核心（插拔式：不依赖 MCP/桥接也能录制回放）
 * 同一经典脚本被两处加载（无构建工具）：
 *   - content_scripts（悬浮球侧）：createRecorder / replaySteps 在当前页工作
 *   - popup 页（控制台侧）：listLocal / saveLocal / deleteLocal / toMcpFlow 管理与升级
 * 存储：chrome.storage.local.rpaLocalFlows（与桥接侧 flows/ 目录互不相干，属「本地流程」）。
 * 能力边界（诚实）：原生录制捕获当前页 click/input/change（密码框不录）；
 *   回放为同页 DOM 操作（合成事件），跨页/下载/弹窗类流程请连桥接用 MCP 模式。
 *
 * v1.22.0（unidesk 202 步流程实测教训）：
 *  - 旧 cssPath 从元素向上爬 6 层、每段 tag.首个类:nth-child(n)，SPA 数据加载后
 *    表格/卡片一重渲染整条路径作废——回放第 1 步即「找不到元素」；
 *  - 报错把定位符截到 60 字符，类名被拦腰砍断（div.ant-card-），看起来像「选择器坏了」；
 *  - hover 逐元素记录（鼠标划过即录），一条移动路径录出多层 hover，回放极其脆弱。
 * 新做法：录制时在当前页面**实测唯一性**、按稳定性排序生成多候选定位；回放逐个尝试 +
 * 文本兜底 + 短重试（等 SPA 重渲染）；hover 定位失效跳过（hover 是手段不是目的）；
 * 报错不再截断定位符。 */
(function (g) {
  'use strict';

  var STORE_KEY = 'rpaLocalFlows';
  var DRAFT_SS = 'rpaLocalRecDraft';   // 同页导航兜底（sessionStorage 同步写，最可靠）
  var DRAFT_CS = 'rpaLocalDraftCs';    // 跨页/跨 origin 兜底（chrome.storage，beforeunload 时尽力而为）

  function cssEscape(s) {
    try { return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'); }
    catch (e) { return String(s); }
  }
  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s; // 显式省略号，绝不拦腰截断制造假选择器
  }

  /* 「生成态」类名：CSS Modules / 哈希类在重渲染后易变，不作定位依据 */
  var GENERATED_CLS = /^(css-|makeStyles-|jss-|sc-|emotion-|_|is-|rpa-|__[a-z])/i;
  function stableClasses(el) {
    if (!el.className || typeof el.className !== 'string') return [];
    return el.className.trim().split(/\s+/).filter(function (c) {
      return c && c.length <= 40 && !GENERATED_CLS.test(c);
    });
  }
  function attrSel(tag, attr, val) {
    return tag + '[' + attr + '=' + JSON.stringify(String(val)) + ']';
  }
  function queryAll(sel) {
    try { return document.querySelectorAll(sel); } catch (e) { return []; }
  }

  /* 从元素向上收集路径段（底锚定，最多 up 层；遇 id/testid/name 祖先即收口），
   * 产出「由短到长」的一组候选路径，供逐级实测唯一性。 */
  function cssCandidates(el, up) {
    var segs = [], cur = el, out = [];
    for (var i = 0; i <= (up || 3) && cur && cur.nodeType === 1; i++) {
      if (cur.id) { segs.unshift('#' + cssEscape(cur.id)); break; }
      var tid = cur.getAttribute && cur.getAttribute('data-testid');
      if (tid) { segs.unshift(attrSel(cur.tagName.toLowerCase(), 'data-testid', tid)); break; }
      var nm = cur.getAttribute && cur.getAttribute('name');
      if (nm) { segs.unshift(attrSel(cur.tagName.toLowerCase(), 'name', nm)); break; }
      var seg = cur.tagName.toLowerCase();
      var cls = stableClasses(cur)[0];
      if (cls) seg += '.' + cssEscape(cls);
      var p = cur.parentElement;
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) seg += ':nth-of-type(' + (Array.prototype.indexOf.call(same, cur) + 1) + ')';
      }
      segs.unshift(seg);
      cur = cur.parentElement;
      out.push(segs.join(' > '));
    }
    return out;
  }

  /* 多候选定位（v1.22.0）：按稳定性排序生成，**录制时实测**「在当前页恰好唯一」；
   * 全不唯一时退回最长路径收底（保证永远有值，绝不静默丢步）。 */
  function buildLocators(el) {
    if (!el || el.nodeType !== 1) return [];
    var out = [], seen = {};
    function push(strategy, value) {
      if (!value) return false;
      var k = strategy + '|' + value;
      if (seen[k]) return false;
      seen[k] = 1;
      out.push({ strategy: strategy, value: value });
      return true;
    }
    function uniq(sel) { return queryAll(sel).length === 1; }
    var tag = el.tagName.toLowerCase();
    // 1) testid / id（存在即最稳，仍实测防重复 id）
    var tid = el.getAttribute && el.getAttribute('data-testid');
    if (tid && uniq('[data-testid=' + JSON.stringify(tid) + ']')) push('testid', tid);
    if (el.id && uniq('#' + cssEscape(el.id))) push('css', '#' + cssEscape(el.id));
    // 2) name / aria-label / title / placeholder（不唯一时叠加首个稳定类再试）
    var attrs = [['name', true], ['aria-label', true], ['title', true], ['placeholder', (tag === 'input' || tag === 'textarea')]];
    for (var ai = 0; ai < attrs.length; ai++) {
      var a = attrs[ai][0], ok = attrs[ai][1];
      if (!ok || !el.getAttribute) continue;
      var v = el.getAttribute(a);
      if (!v) continue;
      if (uniq(attrSel(tag, a, v))) { push('css', attrSel(tag, a, v)); break; }
      var c1 = stableClasses(el)[0];
      if (c1 && uniq(tag + '.' + cssEscape(c1) + '[' + a + '=' + JSON.stringify(String(v)) + ']')) {
        push('css', tag + '.' + cssEscape(c1) + '[' + a + '=' + JSON.stringify(String(v)) + ']');
        break;
      }
    }
    // 3) 底锚定短路径：由短到长逐级实测，首个唯一者胜
    var cands = cssCandidates(el, 3), picked = false;
    for (var ci = 0; ci < cands.length; ci++) {
      if (uniq(cands[ci])) { push('css', cands[ci]); picked = true; break; }
    }
    if (!picked && cands.length) push('css', cands[cands.length - 1]); // 收底：最长路径（不唯一也存，回放还有文本兜底）
    // 4) 更长路径兜底（短路径全不唯一且元素在深层时）
    if (!picked) {
      var deep = cssCandidates(el, 5);
      if (deep.length > cands.length) out[out.length - 1] = { strategy: 'css', value: deep[deep.length - 1] };
    }
    return out.slice(0, 5);
  }

  function selectorFor(el) {
    var l = buildLocators(el);
    return l.length ? l[0] : null;
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

  /* 文本兜底（v1.22.0）：SPA 改版后结构路径全废时的最后救命稻草——
   * 在可点击语义元素集合里按可见文本匹配（录制时存的 text 前 30 字符）。 */
  var TEXT_SCAN = 'a,button,input,select,textarea,label,summary,[role=button],[role=tab],[role=menuitem],[role=option],[role=menuitemradio],[role=menuitemcheckbox],[onclick]';
  function findByText(text) {
    var want = String(text || '').trim();
    if (!want) return null;
    var nodes = document.querySelectorAll(TEXT_SCAN);
    var fallback = null;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var t = '';
      if (n.tagName === 'INPUT' && (n.type === 'button' || n.type === 'submit' || n.type === 'reset')) t = n.value || '';
      else t = (n.textContent || '').trim().replace(/\s+/g, ' ');
      if (!t) continue;
      var hit = t === want || t.slice(0, want.length) === want;
      if (!hit) continue;
      var vis = n.offsetParent !== null || (n.getClientRects && n.getClientRects().length > 0);
      if (!vis) continue;
      if (t === want) return n;
      if (!fallback) fallback = n;
    }
    return fallback;
  }

  /* 回放取元素：多候选逐试 + 文本兜底。schedule 为重试间隔（ms），
   * 点击/填入后 SPA 重渲染常需几百毫秒——等一等再判「找不到」，诚实但不武断。 */
  function locCandidates(step) {
    if (step.locators && step.locators.length) return step.locators;
    if (step.locator) return [step.locator];
    return [];
  }
  function resolveOnce(step) {
    var cands = locCandidates(step);
    for (var i = 0; i < cands.length; i++) {
      var n = resolveNode(cands[i]);
      if (n) return n;
    }
    if (step.text) {
      var t = findByText(step.text);
      if (t) return t;
    }
    return null;
  }
  function resolveLater(step) {
    var schedule = step.op === 'hover' ? [0] : [0, 250, 600, 1100, 1800, 2600];
    return new Promise(function (resolve) {
      var k = 0;
      function attempt() {
        var node = resolveOnce(step);
        if (node) return resolve({ node: node, attempts: k + 1 });
        k++;
        if (k >= schedule.length) return resolve({ node: null, attempts: k });
        setTimeout(attempt, schedule[k] - schedule[k - 1]);
      }
      attempt();
    });
  }

  function inBallHost(t) {
    return !!(t && t.closest && t.closest('#__rpa-ball-host'));
  }

  /* 原生录制器：capture 阶段监听 click/input/change/hover(mouseover)/press(keydown)；
   * 悬浮球自身与密码框不录；连续输入按元素合并（800ms）；
   * a[href] http(s) 链接点击识别为 goto 步（跨页=导航，回放走同源自续播）；
   * hover 去重（同元素 1s 内只记一步——菜单揭层场景足够）；press 只录 Enter/Escape */
  var EDITABLE = 'input,textarea,select,[contenteditable="true"],[contenteditable=""]';
  var CLICKABLE = 'a,button,input,select,textarea,[role=button],[role=tab],[role=menuitem],[role=option],[onclick],label,summary';
  function createRecorder(onStep) {
    var steps = [], on = false;
    var dropped = []; // 丢弃原因反馈（v1.22.0：录不上不 再静默——面板会显示「丢弃 N 次」）
    var lastHover = null; // { el, key, ts } hover 降噪状态
    function push(s) { steps.push(s); if (onStep) onStep(steps); }
    function drop(reason) { dropped.push({ reason: reason, ts: Date.now() }); if (onStep) onStep(steps); }
    function locs(el) {
      var arr = buildLocators(el);
      return arr.length ? arr : null;
    }
    function clickH(e) {
      if (!on || (typeof e.button === 'number' && e.button !== 0)) return;
      var t = e.target;
      if (inBallHost(t)) return;
      var el = (t && t.closest) ? t.closest(CLICKABLE) : t;
      if (!el || el.nodeType !== 1) el = t;
      // 跨页链接 → goto 步（同源跳转在回放时由 sessionStorage 续播）
      if (el.tagName === 'A' && el.href && /^https?:/i.test(el.href)) {
        var cur = location.href.split('#')[0];
        var tgt = el.href.split('#')[0];
        if (tgt !== cur) { push({ op: 'goto', url: el.href, text: String(el.textContent || '').trim().slice(0, 30), ts: Date.now() }); return; }
      }
      var arr = locs(el);
      if (!arr) { drop('无法生成定位符（' + (el && el.tagName || '?') + '）'); return; }
      push({ op: 'click', locator: arr[0], locators: arr, text: String((el.textContent) || '').trim().slice(0, 30), ts: Date.now() });
    }
    function valH(e) {
      if (!on) return;
      var el = e.target;
      if (inBallHost(el)) return;
      if (el && el.type === 'password') { drop('密码框不录（敏感值红线）'); return; } // 敏感值不落盘（红线）
      var tag = el && el.tagName ? el.tagName.toLowerCase() : '';
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      var arr = locs(el);
      if (!arr) { drop('输入框无法生成定位符'); return; }
      var sel = arr[0];
      var v = (el.type === 'checkbox' || el.type === 'radio') ? String(el.checked) : String(el.value || '');
      var last = steps[steps.length - 1];
      // change 与 input 同元素同值：不产生新信息，直接丢弃（降噪 v1.21.3——实测 Playwright fill 的
      // blur 触发 change 会在 hover/click 间隔后逃出 800ms 合并窗，且 hover 常插在两次 fill 之间打断
      // 「看 last」的合并判断：回溯跳过 hover/press 噪声找最近同元素 fill 再判同值）
      var prevFill = last;
      for (var bi = steps.length - 1; bi >= 0 && steps.length - bi <= 4; bi--) {
        var cand = steps[bi];
        if (cand.op === 'fill') { prevFill = cand; break; }
        if (cand.op !== 'hover' && cand.op !== 'press') break;
      }
      if (prevFill && prevFill.op === 'fill' && prevFill.locator.strategy === sel.strategy && prevFill.locator.value === sel.value && String(prevFill.value) === v && (Date.now() - prevFill.ts) < 2000) {
        if (e.type === 'change') return; // change 同值：丢弃
        if (e.type === 'input') return;  // input 同值且近窗：同样丢弃（重复事件）
      }
      if (last && last.op === 'fill' && last.locator.strategy === sel.strategy && last.locator.value === sel.value && (Date.now() - last.ts) < 800) {
        last.value = v; last.ts = Date.now();
        if (onStep) onStep(steps);
      } else {
        push({ op: 'fill', locator: sel, locators: arr, value: v, ts: Date.now() });
      }
    }
    /* hover 降噪（v1.22.0）：鼠标划过一条路径会触发十几次 mouseover，旧逻辑全录——
     * 202 步流程里大半是这类噪声。规则：
     *   同一可点击语境（按钮内图标→文字）不重复记；
     *   1.2s 内沿原路径往外走（离开）不记；
     *   往里走进新元素才记。菜单揭层语义（先 hover 触发器再点菜单项）保留。 */
    function hoverH(e) {
      if (!on) return;
      var t = e.target;
      if (inBallHost(t) || !t || t.nodeType !== 1) return;
      var now = Date.now();
      var key = (t.closest && t.closest(CLICKABLE)) || t;
      if (lastHover && lastHover.key === key && now - lastHover.ts < 1200) return;
      if (lastHover && now - lastHover.ts < 1200) {
        if (lastHover.el.contains(t)) return;            // 往里走进同语境子元素
        if (t.contains(lastHover.el)) { lastHover = { el: t, key: key, ts: now }; return; } // 往外走，不记
      }
      var arr = locs(t);
      if (!arr) { lastHover = { el: t, key: key, ts: now }; return; }
      push({ op: 'hover', locator: arr[0], locators: arr, text: String((t.textContent) || '').trim().slice(0, 30), ts: now });
      lastHover = { el: t, key: key, ts: now };
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
      var arr = locs(editable || el);
      if (!arr) { drop('按键目标无法生成定位符'); return; }
      push({ op: 'press', locator: arr[0], locators: arr, key: key, ts: Date.now() });
    }
    /* 离开页面（刷新/跳转/关标签）时本地录制会静默蒸发——先把已录步骤写草稿，
     * 下次回到扩展页面自动存成「草稿流程」，不再无声丢失（v1.22.0）。 */
    var onUnload = function () {
      if (!on || !steps.length) return;
      var payload;
      try { payload = JSON.stringify({ steps: steps, url: location.href, ts: Date.now() }); } catch (e) { return; }
      try { sessionStorage.setItem(DRAFT_SS, payload); } catch (e2) { /* ignore */ }
      try {
        var o = {}; o[DRAFT_CS] = payload;
        chrome.storage.local.set(o); // beforeunload 里尽力而为（异步不保证落盘）
      } catch (e3) { /* ignore */ }
    };
    return {
      start: function () {
        if (on) return;
        on = true; steps = []; dropped = []; lastHover = null;
        document.addEventListener('click', clickH, true);
        document.addEventListener('input', valH, true);
        document.addEventListener('change', valH, true);
        document.addEventListener('mouseover', hoverH, true);
        document.addEventListener('keydown', pressH, true);
        window.addEventListener('beforeunload', onUnload);
      },
      stop: function () {
        on = false;
        document.removeEventListener('click', clickH, true);
        document.removeEventListener('input', valH, true);
        document.removeEventListener('change', valH, true);
        document.removeEventListener('mouseover', hoverH, true);
        document.removeEventListener('keydown', pressH, true);
        window.removeEventListener('beforeunload', onUnload);
        try { sessionStorage.removeItem(DRAFT_SS); } catch (e) { /* ignore */ }
        try { chrome.storage.local.remove(DRAFT_CS); } catch (e2) { /* ignore */ }
        // 降噪（v1.21.3）：hover 若在 1.5s 内被同元素 click 跟随——点击自带「指针已到达」语义，抑制该 hover
        var out = [];
        for (var i = 0; i < steps.length; i++) {
          var s = steps[i];
          if (s.op === 'hover') {
            var absorbed = false;
            for (var j = i + 1; j < steps.length; j++) {
              var x = steps[j];
              if ((x.ts - s.ts) > 1500) break;
              if (x.op === 'click' && x.locator.strategy === s.locator.strategy && x.locator.value === s.locator.value) { absorbed = true; break; }
            }
            if (absorbed) continue;
          }
          out.push(s);
        }
        return out;
      },
      count: function () { return steps.length; },
      droppedCount: function () { return dropped.length; },
      droppedReasons: function () {
        // 去重计数（面板一行装得下：密码框不录 x2、无法定位 x1）
        var tally = {};
        for (var i = 0; i < dropped.length; i++) {
          var r = dropped[i].reason.split('（')[0];
          tally[r] = (tally[r] || 0) + 1;
        }
        return Object.keys(tally).map(function (k) { return k + ' x' + tally[k]; }).join('、');
      },
      isOn: function () { return on; },
    };
  }

  /* 原生回放器：顺序执行、步间停顿、出错即停（返回 {ok,done,total,skipped,error?}）
   * v1.21.0：press（Enter/Escape 键事件链）、hover（mouseover 事件链，菜单揭层）、
   * goto（同源跨页：剩余步骤存 sessionStorage，新页面 content script 自动续播；
   *       跨源链接无法续播——sessionStorage 按 origin 隔离，回放在该步诚实停止）
   * v1.22.0：定位走 resolveLater（多候选 + 文本兜底 + 短重试等 SPA 重渲染）；
   *   hover 定位失效**跳过**不判失败（鼠标路径 hover 是噪声，菜单揭层真失效时
   *   后续点击会诚实失败并报出真正缺的元素）；找不到元素的报错完整列出全部
   *   已试定位符（不再截成 60 字符的假选择器）。 */
  var RESUME_KEY = 'rpaStandaloneResume';
  function saveResume(steps, i, gap, done, total) {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({ steps: steps, i: i, gapMs: gap, total: total || steps.length, done: done, ts: Date.now() }));
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
  function notFoundError(i, s, attempts) {
    var cands = locCandidates(s);
    var parts = cands.map(function (c) { return c.strategy + '=' + clip(c.value, 120); });
    if (s.text) parts.push('文本“' + clip(s.text, 30) + '”');
    return '第 ' + i + ' 步（' + s.op + '）找不到元素：已试 ' + (attempts || 1) + ' 次，' +
      (parts.length ? parts.join('；') : '(该步无定位符)') +
      '——页面可能已改版/状态不同。hover 步会自动跳过；操作步可重录该步或升级到 MCP（10 种定位策略 + 指纹自愈）';
  }
  function replaySteps(steps, opts) {
    opts = opts || {};
    var gap = typeof opts.gapMs === 'number' ? opts.gapMs : 350;
    var total0 = typeof opts.total === 'number' ? opts.total : steps.length; // 绝对总数（跨页续播跨段不丢）
    return new Promise(function (resolve) {
      var i = 0, done = typeof opts.done === 'number' ? opts.done : 0, skipped = 0, skippedAt = [];
      function next() {
        if (i >= steps.length) return resolve({ ok: true, done: done, total: total0, skipped: skipped, skippedAt: skippedAt });
        var s = steps[i++];
        if (s.op === 'goto') {
          var sameOrigin = false;
          try { sameOrigin = new URL(s.url, location.href).origin === location.origin; } catch (e) { sameOrigin = false; }
          if (!sameOrigin) {
            return resolve({ ok: false, done: done, total: total0, step: i, skipped: skipped,
              error: '第 ' + i + ' 步是跨源链接（' + clip(s.url, 80) + '）——独立模式续播仅支持同源跳转，已回放到此' });
          }
          done++; // v1.22.6：goto 也是完成的一步，计入 done（否则全 goto 流程报 0/N）
          saveResume(steps, i, gap, done, total0);
          location.href = s.url;
          return resolve({ ok: true, done: done, total: total0, navigating: true, step: i, skipped: skipped });
        }
        resolveLater(s).then(function (res) {
          if (!res.node) {
            if (s.op === 'hover') { skipped++; skippedAt.push(i); return setTimeout(next, gap); }
            return resolve({ ok: false, done: done, total: total0, step: i, skipped: skipped, skippedAt: skippedAt, error: notFoundError(i, s, res.attempts) });
          }
          try {
            var node = res.node;
            if (node.scrollIntoView) node.scrollIntoView({ block: 'center' });
            if (s.op === 'click') {
              // 表单提交类点击会触发跨页导航（真实站点登录/查询流）——同源自续播（真实观察轮实锤的盲区）：
              // 点击前预存续播状态；若 1.5s 内页面未卸载（JS 拦截了提交）则自清，防陈旧续播误触发
              var isSubmit = !!(node.form && node.matches && node.matches('button[type="submit"],input[type="submit"],button:not([type])'));
              if (isSubmit) saveResume(steps, i, gap, done, total0);
              node.click();
              if (isSubmit) { clearResumeLater(1500); done++; return resolve({ ok: true, done: done, total: total0, navigating: true, step: i, skipped: skipped }); }
            } else if (s.op === 'fill') {
              // ant 等组件库常把 input 包在壳里：定位到壳时向下钻一层找真正的输入控件
              var tag0 = (node.tagName || '').toLowerCase();
              if (tag0 !== 'input' && tag0 !== 'textarea' && tag0 !== 'select') {
                var inner = node.querySelector && node.querySelector('input,textarea,select');
                if (inner) node = inner;
              }
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
              return resolve({ ok: false, done: done, total: total0, step: i, skipped: skipped, error: '未知步骤类型 ' + s.op });
            }
            done++;
          } catch (e) {
            return resolve({ ok: false, done: done, total: total0, step: i, skipped: skipped, error: '第 ' + i + ' 步执行出错: ' + ((e && e.message) || e) });
          }
          setTimeout(next, gap);
        });
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
   * 独立模式录的流程可以「插」回 MCP 侧成为完整44 工具面下的流程。
   * v1.22.0：多候选定位数组整体升级（MCP player 本就按序尝试 locators）。 */
  function toMcpFlow(local, startUrl) {
    var url = startUrl || local.startUrl || '';
    var steps = [{ op: 'goto', seq: 1, url: url }];
    (local.steps || []).forEach(function (s, i) {
      var seq = i + 2;
      var ls = (s.locators && s.locators.length ? s.locators : (s.locator ? [s.locator] : []));
      if (s.op === 'click') steps.push({ op: 'click', seq: seq, locators: ls });
      else if (s.op === 'fill') steps.push({ op: 'fill', seq: seq, locators: ls, value: s.value });
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

  /* 草稿取回（v1.22.0）：录制中途离开页面时 onUnload 落下的未保存步骤——
   * 优先 sessionStorage（同页导航必中），其次 chrome.storage（跨页/跨 origin 兜底）。
   * 12h 过期；取回即清，由调用方决定存成草稿流程。 */
  function takeDraft(cb) {
    var done = false;
    var finish = function (d) { if (!done) { done = true; cb(d && d.steps && d.steps.length ? d : null); } };
    var parsed = function (raw) {
      try { var st = JSON.parse(raw); if (st && Array.isArray(st.steps) && Date.now() - (st.ts || 0) < 12 * 3600 * 1000) return st; } catch (e) { /* ignore */ }
      return null;
    };
    try {
      var raw = sessionStorage.getItem(DRAFT_SS);
      if (raw) { sessionStorage.removeItem(DRAFT_SS); var st = parsed(raw); if (st) return finish(st); }
    } catch (e1) { /* ignore */ }
    try {
      chrome.storage.local.get(DRAFT_CS, function (o) {
        var raw2 = o && o[DRAFT_CS];
        if (raw2) { try { chrome.storage.local.remove(DRAFT_CS); } catch (e) { /* ignore */ } }
        finish(raw2 ? parsed(raw2) : null);
      });
    } catch (e2) { finish(null); }
  }

  g.RpaStandalone = {
    STORE_KEY: STORE_KEY,
    RESUME_KEY: RESUME_KEY,
    DRAFT_SS: DRAFT_SS,
    DRAFT_CS: DRAFT_CS,
    createRecorder: createRecorder,
    replaySteps: replaySteps,
    maybeResume: maybeResume,
    listLocal: listLocal,
    saveLocal: saveLocal,
    deleteLocal: deleteLocal,
    toMcpFlow: toMcpFlow,
    toLocalFromMcp: toLocalFromMcp,
    selectorFor: selectorFor,
    buildLocators: buildLocators,
    findByText: findByText,
    resolveNode: resolveNode,
    takeDraft: takeDraft,
  };
})(typeof window !== 'undefined' ? window : this);
