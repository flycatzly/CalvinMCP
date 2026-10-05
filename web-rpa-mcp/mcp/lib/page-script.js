/* web-rpa-mcp — 注入到页面的录制/定位辅助脚本（浏览器侧，非模块）
 * 提供 window.__rpa：多策略定位符生成、元素指纹、敏感元素识别
 * 以及在 window.__rpaRecordActive === true 时启用的录制事件监听
 */
(function () {
  if (window.__rpa) return;

  var TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-tid'];
  var SENSITIVE_RE = /pass(word|wd)?|pwd|secret|token|credential|otp|sms[-_]?code|verif(y|ication)?[-_]?code|auth|密码|验证码|动态码|短信码/i;
  var CAPTCHA_RE = /captcha|geetest|recaptcha|hcaptcha|tcaptcha|nc_|nocaptcha|slide|verify|人机|滑块/i;
  var CODE_RE = /验证码|动态码|短信|otp|sms|mfa|two[-_]?factor/i;

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/([^\w-])/g, '\\$1');
  }

  function attr(el, n) { return el && el.getAttribute ? el.getAttribute(n) : null; }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return true;
  }

  function labelTextFor(el) {
    if (!el) return '';
    var id = el.id;
    if (id) {
      try {
        var lab = document.querySelector('label[for="' + cssEscape(id) + '"]');
        if (lab) return norm(lab.innerText || lab.textContent);
      } catch (e) { /* ignore */ }
    }
    var p = el.closest ? el.closest('label') : null;
    if (p) {
      var clone = p.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('input,select,textarea,button'), function (x) { x.remove(); });
      var t = norm(clone.innerText || clone.textContent);
      if (t) return t;
    }
    var al = attr(el, 'aria-labelledby');
    if (al) {
      var parts = String(al).split(/\s+/).map(function (id2) {
        var n = document.getElementById(id2);
        return n ? norm(n.innerText || n.textContent) : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    return '';
  }

  function implicitRole(el) {
    var r = attr(el, 'role');
    if (r) return r;
    var tag = el.tagName.toLowerCase();
    var type = (attr(el, 'type') || '').toLowerCase();
    if (tag === 'a') return attr(el, 'href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'file') return null;
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return attr(el, 'multiple') != null ? 'listbox' : 'combobox';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'form') return 'form';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'summary') return 'button';
    return null;
  }

  function accessibleName(el) {
    var al = attr(el, 'aria-label');
    if (al && norm(al)) return norm(al);
    var lt = labelTextFor(el);
    if (lt) return lt;
    var ph = attr(el, 'placeholder');
    if (ph && norm(ph)) return norm(ph);
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON') {
      var ty = (attr(el, 'type') || '').toLowerCase();
      if ((ty === 'submit' || ty === 'button' || ty === 'reset' || tag === 'BUTTON') && norm(el.value || '')) return norm(el.value);
    }
    var alt = attr(el, 'alt');
    if (alt && norm(alt)) return norm(alt);
    var t = attr(el, 'title');
    if (t && norm(t)) return norm(t);
    return norm(el.innerText || el.textContent).slice(0, 120);
  }

  function isInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'option', 'label'].indexOf(tag) >= 0) return true;
    var role = attr(el, 'role');
    if (role && /button|link|tab|menuitem|checkbox|radio|switch|option|combobox|textbox|searchbox/i.test(role)) return true;
    if (attr(el, 'onclick') || attr(el, 'contenteditable') === 'true') return true;
    var cs = getComputedStyle(el);
    if (cs && cs.cursor === 'pointer' && norm(el.innerText || el.textContent)) return true;
    return false;
  }

  /** 从 el 向上找最近的可交互祖先（含自身），最多 4 层 */
  function actionableFrom(el) {
    var cur = el;
    var depth = 0;
    while (cur && cur.nodeType === 1 && depth <= 4) {
      if (isInteractive(cur)) return cur;
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 6) {
      var tag = cur.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      var id = cur.id;
      if (id && /^[A-Za-z][\w-]*$/.test(id)) { parts.unshift('#' + cssEscape(id)); break; }
      var seg = tag;
      var stableCls = Array.prototype.filter.call(cur.classList || [], function (c) {
        return c && c.length < 40 && !/^(css-|sc-|jsx-|_)|^[a-z]{1,2}\d{4,}/i.test(c) && !/\d{4,}/.test(c);
      }).slice(0, 2);
      if (stableCls.length) seg += '.' + stableCls.map(cssEscape).join('.');
      var parent = cur.parentElement;
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (s) { return s.tagName === cur.tagName; });
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = parent;
    }
    var p = parts.join(' > ');
    return p ? p : null;
  }

  function xPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '//*[@id="' + el.id + '"]';
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 5) {
      var tag = cur.tagName.toLowerCase();
      if (tag === 'html') break;
      var idx = 1;
      var sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(tag + '[' + idx + ']');
      cur = cur.parentElement;
    }
    return parts.length ? '//' + parts.join('/') : null;
  }

  function inIframe() {
    try { return window.top !== window.self; } catch (e) { return true; }
  }

  /** 向上收集 iframe 选择器链（同源部分），供回放时 frameLocator 逐层进入 */
  function frameChain() {
    var chain = [];
    var w = window;
    var guard = 0;
    try {
      while (w !== w.top && guard++ < 5) {
        var fe = w.frameElement;
        if (!fe) break;
        var sel = null;
        try { sel = cssPath(fe); } catch (e) { sel = null; }
        if (!sel) {
          if (fe.id) sel = '#' + cssEscape(fe.id);
          else if (attr(fe, 'name')) sel = 'iframe[name=' + JSON.stringify(attr(fe, 'name')) + ']';
          else if (TESTID_ATTRS.length && attr(fe, TESTID_ATTRS[0])) sel = '[data-testid=' + JSON.stringify(attr(fe, TESTID_ATTRS[0])) + ']';
        }
        if (!sel) break;
        chain.unshift({ strategy: 'css', value: sel });
        w = w.parent;
      }
    } catch (e) { /* 跨域则只能记录到同源为止 */ }
    return chain;
  }

  /** 生成按稳定性排序的定位符候选 */
  function locators(el) {
    var out = [];
    var seen = {};
    function add(strategy, value, extra) {
      if (value === null || value === undefined) return;
      var v = String(value);
      if (!v.trim()) return;
      var key = strategy + '|' + v + '|' + JSON.stringify(extra || {});
      if (seen[key]) return;
      seen[key] = 1;
      var d = { strategy: strategy, value: v };
      if (extra) { for (var k in extra) if (extra[k] !== undefined) d[k] = extra[k]; }
      out.push(d);
    }

    for (var i = 0; i < TESTID_ATTRS.length; i++) {
      var tv = attr(el, TESTID_ATTRS[i]);
      if (tv && norm(tv)) { add('testid', norm(tv)); break; }
    }
    var nameAttr = attr(el, 'name');
    var tag = el.tagName.toLowerCase();
    if (nameAttr && norm(nameAttr) && /input|select|textarea|button/.test(tag)) add('name', norm(nameAttr));

    var role = implicitRole(el);
    var an = accessibleName(el);
    if (role && an) add('role', role, { name: an, exact: true });
    if (role && an) add('role', role, { name: an, exact: false });

    var lt = labelTextFor(el);
    if (lt) add('label', lt, { exact: true });

    var ph = attr(el, 'placeholder');
    if (ph && norm(ph)) add('placeholder', norm(ph));

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      var ty = (attr(el, 'type') || '').toLowerCase();
      if (ty === 'submit' || ty === 'button' || ty === 'reset') {
        var v2 = norm(el.value || '');
        if (v2) add('css', 'input[type="' + ty + '"][value="' + v2.replace(/"/g, '\\"') + '"]');
      }
    }

    if (an && an.length <= 60 && /a|button|summary|label|li|span|div|td|th|h[1-6]/i.test(tag)) {
      add('text', an, { exact: true });
    }

    var alt = attr(el, 'alt');
    if (alt && norm(alt)) add('alt', norm(alt));
    var ti = attr(el, 'title');
    if (ti && norm(ti)) add('title', norm(ti));

    var cp = cssPath(el);
    if (cp) add('css', cp);
    var xp = xPath(el);
    if (xp) add('xpath', xp);

    return out;
  }

  /** 元素指纹：用于定位符全部失效时的自愈匹配 */
  function fingerprint(el) {
    var path = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 5) {
      var seg = cur.tagName.toLowerCase();
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) seg += '#' + cur.id;
      else {
        var c = Array.prototype.filter.call(cur.classList || [], function (x) { return x && x.length < 40 && !/\d{4,}/.test(x); }).slice(0, 2);
        if (c.length) seg += '.' + c.join('.');
      }
      path.unshift(seg);
      cur = cur.parentElement;
    }
    var prev = el.previousElementSibling ? norm(el.previousElementSibling.innerText || el.previousElementSibling.textContent).slice(0, 60) : '';
    var next = el.nextElementSibling ? norm(el.nextElementSibling.innerText || el.nextElementSibling.textContent).slice(0, 60) : '';
    var attrs = {};
    ['id', 'name', 'type', 'aria-label', 'placeholder', 'title', 'href', 'value'].forEach(function (k) {
      var v = attr(el, k);
      if (v) attrs[k] = String(v).slice(0, 120);
    });
    var classes = Array.prototype.slice.call(el.classList || []).filter(function (c) { return c && c.length < 40; }).slice(0, 6);
    return {
      tag: el.tagName.toLowerCase(),
      role: implicitRole(el),
      name: accessibleName(el).slice(0, 120),
      text: norm(el.innerText || el.textContent).slice(0, 160),
      attrs: attrs,
      classes: classes,
      path: path,
      prevText: prev,
      nextText: next,
    };
  }

  function sensitivityReason(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = el.tagName.toLowerCase();
    var type = (attr(el, 'type') || '').toLowerCase();
    if (tag === 'input' && type === 'password') return 'password';
    var hay = [attr(el, 'name'), attr(el, 'id'), attr(el, 'placeholder'), attr(el, 'aria-label'), attr(el, 'autocomplete'), labelTextFor(el)].filter(Boolean).join(' ');
    if (!hay) return null;
    if (type === 'password' || /pwd|密码/i.test(hay)) return 'password';
    if (CODE_RE.test(hay)) return 'verification-code';
    if (SENSITIVE_RE.test(hay)) return 'sensitive-field';
    return null;
  }

  /** 页面是否包含验证码组件 */
  function captchaPresent() {
    try {
      var sel = 'iframe[src*="captcha" i],iframe[src*="geetest" i],iframe[src*="recaptcha" i],iframe[src*="tcaptcha" i],div[id*="captcha" i],div[class*="captcha" i],div[id*="geetest" i],div[class*="geetest" i],[id*="nc_"],[class*="nc_"]';
      var nodes = document.querySelectorAll(sel);
      for (var i = 0; i < nodes.length; i++) if (isVisible(nodes[i])) return true;
      return false;
    } catch (e) { return false; }
  }

  function describe(el, extra) {
    var d = {
      locators: locators(el),
      fingerprint: fingerprint(el),
      frame: frameChain(),
      inIframe: inIframe(),
      href: attr(el, 'href') || null,
      tag: el.tagName.toLowerCase(),
      type: (attr(el, 'type') || '').toLowerCase() || null,
      text: norm(el.innerText || el.textContent).slice(0, 120),
      value: (typeof el.value === 'string' ? el.value : null),
    };
    var reason = sensitivityReason(el);
    if (reason) { d.sensitive = true; d.sensitiveReason = reason; }
    if (captchaPresent()) d.captchaPresent = true;
    if (extra) { for (var k in extra) d[k] = extra[k]; }
    return d;
  }

  window.__rpa = {
    norm: norm,
    isVisible: isVisible,
    isInteractive: isInteractive,
    actionableFrom: actionableFrom,
    implicitRole: implicitRole,
    accessibleName: accessibleName,
    labelTextFor: labelTextFor,
    cssPath: cssPath,
    xPath: xPath,
    locators: locators,
    fingerprint: fingerprint,
    describe: describe,
    frameChain: frameChain,
    sensitivityReason: sensitivityReason,
    captchaPresent: captchaPresent,
  };

  /* ---------------- 录制器 ---------------- */
  if (window.__rpaRecorderInstalled) return;
  window.__rpaRecorderInstalled = true;
  try {   // 监听器安装整体兜底：任何异常都记录下来，方便定位（静默失败最难查）

  function emit(payload) {
    if (!window.__rpaRecordActive) return;
    // 一个定位符都解析不出来的目标（如 <html>）录成步骤回放时必然点不着，
    // 只会变成「点击 (无定位符)」把流程卡在阻断级——不是有效交互，不录
    if (payload && payload.desc && payload.desc.locators && !payload.desc.locators.length) return;
    try {
      if (typeof window.__rpaEmit === 'function') { window.__rpaEmit(payload); return; }
    } catch (e) { /* binding 不可用时退回日志 */ }
    try { console.debug('[rpa-record]', payload); } catch (e) { /* ignore */ }
  }

  var pendingFill = null;
  var pendingTimer = null;

  function flushFill() {
    if (!pendingFill) return;
    var p = pendingFill;
    pendingFill = null;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    emit(p);
  }

  // record_stop / 暂停录制前 Node 侧会调用它：防抖窗口（700ms）内挂起的填入
  // 必须随录制停止一起提交，否则录完就丢了最后一步输入
  window.__rpa.flush = flushFill;

  document.addEventListener('click', function (ev) {
    if (!window.__rpaRecordActive) return;
    var path = ev.composedPath ? ev.composedPath() : [ev.target];
    var target = null;
    for (var i = 0; i < path.length && i < 6; i++) {
      if (path[i] && path[i].nodeType === 1) { target = path[i]; break; }
    }
    if (!target) return;
    var el = window.__rpa.actionableFrom(target) || target;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' && (attr(el, 'type') || '').toLowerCase() === 'file') return;
    flushFill();
    var d = window.__rpa.describe(el);
    // 该元素在空闲态点不到 -> 是 hover 揭出来的 -> 先补一步 hover，否则回放时点不着
    if (needsHover(el)) {
      var ht = pickHoverTrigger(el);
      if (ht) {
        emit({ kind: 'hover', url: location.href, ts: Date.now() - 1, desc: window.__rpa.describe(ht) });
      }
    }
    emit({ kind: 'click', url: location.href, ts: Date.now(), desc: d, rect: rectOf(el) });
  }, true);

  function rectOf(el) {
    try { var r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }
    catch (e) { return null; }
  }

  document.addEventListener('change', function (ev) {
    if (!window.__rpaRecordActive) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    var type = (attr(el, 'type') || '').toLowerCase();
    if (tag === 'select') {
      flushFill();
      var opt = el.options[el.selectedIndex];
      emit({ kind: 'select', url: location.href, ts: Date.now(), desc: window.__rpa.describe(el), value: el.value, label: opt ? window.__rpa.norm(opt.textContent) : '' });
    } else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      flushFill();
      emit({ kind: 'check', url: location.href, ts: Date.now(), desc: window.__rpa.describe(el), checked: !!el.checked });
    } else if (tag === 'input' && type === 'file') {
      var names = Array.prototype.map.call(el.files || [], function (f) { return f.name; });
      flushFill();
      emit({ kind: 'setInputFiles', url: location.href, ts: Date.now(), desc: window.__rpa.describe(el), fileNames: names, warning: '浏览器安全限制无法获取文件绝对路径，请在步骤里补全 path' });
    }
  }, true);

  document.addEventListener('input', function (ev) {
    if (!window.__rpaRecordActive) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    var type = (attr(el, 'type') || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    if (type === 'checkbox' || type === 'radio' || type === 'file' || type === 'range' || type === 'color') return;
    var sensitive = window.__rpa.sensitivityReason(el);
    pendingFill = {
      kind: 'fill',
      url: location.href,
      ts: Date.now(),
      desc: window.__rpa.describe(el),
      value: sensitive ? '' : el.value,
      valueMasked: sensitive ? '[已隐藏]' : el.value,
      sensitive: !!sensitive,
      sensitiveReason: sensitive || undefined,
    };
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flushFill, 700);
  }, true);

  document.addEventListener('blur', function () {
    if (!window.__rpaRecordActive) return;
    flushFill();   // 失焦立即提交挂起的输入，不用等防抖
  }, true);

  /* ---------------- hover 触发菜单的识别 ----------------
     两个实测结论决定了这里的设计：
     1) 纯 CSS 的 :hover 揭层，在 mouseover 回调里 :hover 已经生效，
        "悬停前后可见元素数量对比"永远相等（实测 36 -> 36），该思路不可用；
     2) "空闲态快照"绝不能在悬停过程中重采——实测悬停期间重采会把已展开的菜单
        当成空闲态（35 -> 37），于是需要 hover 的元素被误判为普通元素、漏掉 hover 步骤。
     因此：空闲态基线只在文档就绪时采一次（此后再不自动刷新）；
     判定"需要 hover"的条件是元素自身与其某个祖先容器都不在基线里（说明是一整块被揭开）；
     补的 hover 还要落在与被揭容器"近邻"的触发元素上（企业后台菜单基本是兄弟节点）。 */
  var idleSigs = null;
  var recentHovers = [];

  function elementSig(el) {
    if (!el || el.nodeType !== 1) return '';
    var tag = el.tagName.toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var tid = '';
    for (var i = 0; i < TESTID_ATTRS.length; i++) {
      var v = attr(el, TESTID_ATTRS[i]);
      if (v) { tid = '[' + v + ']'; break; }
    }
    return tag + id + tid + '|' + norm(el.innerText || el.textContent).slice(0, 40);
  }

  function visibleSigSet() {
    var set = {};
    try {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length && i < 1200; i++) {
        if (isVisible(all[i])) set[elementSig(all[i])] = 1;
      }
    } catch (e) { /* ignore */ }
    return set;
  }

  /**
   * 空闲态基线：尽早、多次采样，**只认最早那一次**。
   * 实测教训：如果要求"用户还没交互"才采，自动化里几乎永远采不到
   * （第一次 selectOption/check 立刻产生 mouseover），idleSigs 一直为 null，
   * hover 检测被静默关闭 —— 表现就是"有时录不到 hover"。
   * 反之，一旦采到就绝不自动覆盖：悬停期间重采会把已展开的菜单误当成空闲态。
   */
  var baselineFrozen = false;

  function takeIdleBaseline() {
    if (baselineFrozen) return;                 // 交互一开始就冻结，绝不在悬停期间重采
    var snap = visibleSigSet();
    if (Object.keys(snap).length < 5) return;   // DOM 尚未建好，等下一次采样
    idleSigs = snap;                            // 保留最新一次（冻结前 DOM 越完整越好）
  }

  function scheduleBaseline(delay) { setTimeout(takeIdleBaseline, delay); }

  [0, 120, 300, 700, 1500, 2500, 4000, 6000].forEach(scheduleBaseline);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scheduleBaseline(0); scheduleBaseline(150); });
  }
  window.addEventListener('load', function () { scheduleBaseline(0); scheduleBaseline(200); });

  /** 返回"在空闲态不存在"的最近祖先容器（说明它是被 hover 揭出来的） */
  function missingAncestor(el) {
    if (!idleSigs) return null;
    var cur = el.parentElement;
    var depth = 0;
    while (cur && cur !== document.body && depth++ < 4) {
      if (!idleSigs[elementSig(cur)]) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /** 该元素在"没有 hover"时点得到吗？点不到就需要先 hover */
  function needsHover(el) {
    if (!idleSigs) return false;
    if (idleSigs[elementSig(el)]) return false;   // 自身在空闲态就可见 -> 不需要 hover
    return !!missingAncestor(el);                  // 必须是一整块容器被揭开
  }

  /** 两个元素是否"近邻"（同级、父子或爷孙），用于确认揭层开关 */
  function nearSiblings(a, b) {
    if (!a || !b || !a.parentElement || !b.parentElement) return false;
    var ap = a.parentElement;
    var bp = b.parentElement;
    if (ap === bp) return true;
    if (ap === bp.parentElement) return true;
    if (bp === ap.parentElement) return true;
    return false;
  }

  /** 挑出最可能的"揭层开关"：最近悬停过、与被揭容器近邻、且不是自己 */
  function pickHoverTrigger(el, missing) {
    for (var i = recentHovers.length - 1; i >= 0; i--) {
      var h = recentHovers[i];
      if (Date.now() - h.ts > 10000) continue;
      var t = h.trigger;
      if (!t || t === el || !t.tagName) continue;
      try { if (!isVisible(t)) continue; } catch (e) { continue; }
      if (t.contains && t.contains(el)) continue;
      if (el.contains && el.contains(t)) continue;
      var target = missing || missingAncestor(el);
      if (target && !nearSiblings(t, target)) continue;
      return t;
    }
    return null;
  }

  document.addEventListener('mouseover', function (ev) {
    if (!window.__rpaRecordActive) return;
    baselineFrozen = true;   // 从这一刻起空闲态基线不再更新（避免把 hover 揭出来的东西当成空闲态）
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    var trigger = window.__rpa.actionableFrom(el) || el;
    recentHovers.push({ trigger: trigger, ts: Date.now() });
    if (recentHovers.length > 6) recentHovers.shift();
  }, true);

  /** 诊断用：解释"这一步为什么（没）补 hover" */
  window.__rpa.hoverDecision = function (el) {
    var missing = el ? missingAncestor(el) : null;
    return {
      hasBaseline: !!idleSigs,
      baselineCount: idleSigs ? Object.keys(idleSigs).length : 0,
      elSig: el ? elementSig(el) : null,
      elInBaseline: !!(idleSigs && el && idleSigs[elementSig(el)]),
      missingAncestor: missing ? elementSig(missing) : null,
      needsHover: el ? needsHover(el) : null,
      picked: el && pickHoverTrigger(el, missing) ? elementSig(pickHoverTrigger(el, missing)) : null,
      recent: recentHovers.map(function (h) { return { sig: elementSig(h.trigger), ageMs: Date.now() - h.ts, visible: isVisible(h.trigger) }; }),
    };
  };
  /** SPA 二次渲染后可以手工重建基线 */
  window.__rpa.rebaselineHover = function () {
    baselineFrozen = false;
    idleSigs = visibleSigSet();
    baselineFrozen = true;
    return idleSigs ? Object.keys(idleSigs).length : 0;
  };
  document.addEventListener('keydown', function (ev) {
    if (!window.__rpaRecordActive) return;
    if (ev.key !== 'Enter') return;
    var el = ev.target;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && !attr(el, 'contenteditable')) return;
    flushFill();
    emit({ kind: 'press', url: location.href, ts: Date.now(), desc: window.__rpa.describe(el), key: 'Enter' });
  }, true);

  window.__rpa.flush = flushFill;
  window.__rpaRecorderReady = true;
  } catch (e) {
    window.__rpaRecorderError = String(e && e.message ? e.message : e);
    try { console.error('[rpa-record] 监听器安装失败:', window.__rpaRecorderError); } catch (e2) { /* ignore */ }
  }
})();
