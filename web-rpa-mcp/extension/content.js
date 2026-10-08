// 可爱悬浮球：所有网页常驻一颗可拖拽的猫耳球，点开快捷面板——
// 🎬 一键录制当前页 / ⏹ 结束保存 / ▶ 快速回放最近流程 / 🧊 打开完整控制台。
// 设计参照「沉浸式翻译」悬浮窗：贴边可拖、位置记忆、录制中脉冲+步数角标。
// 实现：Shadow DOM 隔离（页面样式进不来、我们也不污染页面）；样式走 adoptedStyleSheets
//（不受页面 CSP style-src 约束）；全部 DOM 用 createElement/textContent 构建
//（不受页面 Trusted Types 约束，也无 XSS 面）；所有 MCP 调用经 background.js 中转。
(() => {
  'use strict';
  if (window.top !== window) return;                 // 只在顶层框架
  if (window.__rpaBallInjected) return;              // 防重复注入
  window.__rpaBallInjected = true;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.storage) return;
  try { if (sessionStorage.getItem('__rpaBallHidden') === '1') return; } catch (e) { /* ignore */ }
  // 桥接控制台页本身不注入（避免套娃）
  if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && location.pathname === '/console') return;

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError;
        resolve(r || { ok: false, summary: '后台服务不可达（扩展刚重载？请刷新页面）' });
      });
    } catch (e) {
      resolve({ ok: false, summary: String(e && e.message ? e.message : e) });
    }
  });
  const call = (tool, args) => send({ type: 'rpa-call', tool, args: args || {} });

  /* ---------------- 样式（CSSOM，绕开页面 CSP） ---------------- */
  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; left: 0; top: 0; z-index: 2147483647; font: 13px/1.45 system-ui, "Microsoft YaHei", sans-serif; }
    .ball { position: absolute; width: 52px; height: 52px; margin: -26px 0 0 -26px; border-radius: 50%;
      background: linear-gradient(135deg, #ffb3d1, #b39dff); border: 2px solid #fff;
      box-shadow: 0 4px 14px rgba(160,120,255,.45), 0 1px 3px rgba(0,0,0,.18);
      cursor: grab; user-select: none; touch-action: none; transition: transform .15s; }
    .ball:hover { transform: scale(1.08); }
    .ball:active { cursor: grabbing; }
    .ball.rec { animation: rpulse 1.6s infinite; }
    @keyframes rpulse {
      0% { box-shadow: 0 0 0 0 rgba(255,77,109,.45), 0 4px 14px rgba(160,120,255,.45); }
      70% { box-shadow: 0 0 0 14px rgba(255,77,109,0), 0 4px 14px rgba(160,120,255,.45); }
      100% { box-shadow: 0 0 0 0 rgba(255,77,109,0), 0 4px 14px rgba(160,120,255,.45); } }
    .ear { position: absolute; width: 15px; height: 15px; border: 2px solid #fff; border-radius: 55% 55% 10% 55%;
      background: linear-gradient(135deg, #ffb3d1, #c9a7ff); top: -10px; }
    .ear.l { left: 5px; transform: rotate(-24deg); }
    .ear.r { right: 5px; transform: rotate(114deg); }
    .gloss { position: absolute; left: 10px; top: 8px; width: 16px; height: 10px; border-radius: 50%;
      background: rgba(255,255,255,.75); transform: rotate(-22deg); }
    .eye { position: absolute; top: 20px; width: 7px; height: 9px; border-radius: 50%; background: #4a3b57; left: 15px; }
    .eye.r { left: auto; right: 15px; }
    .eye::after { content: ''; position: absolute; width: 3px; height: 3px; background: #fff; border-radius: 50%; left: 1px; top: 1px; }
    .blush { position: absolute; top: 30px; width: 9px; height: 5px; border-radius: 50%; background: rgba(255,110,160,.6); left: 8px; }
    .blush.r { left: auto; right: 8px; }
    .mouth { position: absolute; top: 31px; left: 50%; transform: translateX(-50%); width: 12px; height: 7px;
      border-bottom: 2.5px solid #4a3b57; border-radius: 0 0 12px 12px; }
    .badge { position: absolute; top: -7px; right: -9px; min-width: 20px; height: 20px; border-radius: 10px;
      background: #ff4d6d; color: #fff; font-size: 11px; font-weight: 700; line-height: 20px; text-align: center;
      padding: 0 5px; box-shadow: 0 2px 6px rgba(0,0,0,.25); }
    .hide { display: none !important; }
    .panel { position: absolute; top: 34px; width: 268px; border-radius: 18px; overflow: hidden;
      background: linear-gradient(180deg, #fff, #fdf3ff); border: 1px solid #f3e3ff;
      box-shadow: 0 10px 34px rgba(120,80,200,.28); color: #3d3350; }
    .panel.up { top: auto; bottom: 34px; }
    .phead { display: flex; align-items: center; gap: 6px; padding: 9px 12px;
      background: linear-gradient(135deg, #ff9ac6, #a78bfa); color: #fff; font-weight: 700; }
    .phead .x { margin-left: auto; cursor: pointer; border: 0; background: rgba(255,255,255,.25); color: #fff;
      width: 22px; height: 22px; border-radius: 50%; font-size: 12px; line-height: 1; }
    .pbody { padding: 10px 12px; max-height: 330px; overflow-y: auto; }
    .status { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #7a6f8f; margin-bottom: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #fbbf24; flex: none; }
    .dot.ok { background: #34d399; } .dot.bad { background: #f87171; }
    .sect { font-size: 11px; color: #a293b8; margin: 8px 0 4px; font-weight: 600; letter-spacing: .5px; }
    .mode-chip { margin-left: auto; font-size: 10px; padding: 1px 8px; border-radius: 999px; flex: none; }
    .mode-chip.dep { background: #e8f5ec; color: #2e7d4f; }
    .mode-chip.solo { background: #fff3e0; color: #b26a00; }
    .locsect { border-top: 1px dashed #f0e6fa; margin-top: 6px; padding-top: 2px; }
    .runnow { font-size: 11px; background: #eef2ff; color: #4a3b8f; border-radius: 10px; padding: 5px 8px; margin-bottom: 4px; }
    .runnow.none { background: transparent; color: #b3a6c9; padding: 0; }
    button.act { display: block; width: 100%; border: 0; border-radius: 12px; padding: 8px 10px; font: inherit;
      font-weight: 600; cursor: pointer; background: linear-gradient(135deg, #ffe1ef, #ece4ff); color: #5b4a7a;
      margin: 4px 0; text-align: left; }
    button.act.primary { background: linear-gradient(135deg, #ff9ac6, #a78bfa); color: #fff; }
    button.act.danger { background: #ffe4e6; color: #be123c; }
    button.act:disabled { opacity: .6; cursor: wait; }
    .frow { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px dashed #f0e6fa; }
    .frow:last-child { border-bottom: 0; }
    .fname { flex: 1; min-width: 0; font-size: 12px; }
    .fname .n { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #3d3350; }
    .fname .m { font-size: 10px; color: #b3a6c9; }
    .frow button { flex: none; border: 0; border-radius: 50%; width: 26px; height: 26px;
      background: linear-gradient(135deg, #ff9ac6, #a78bfa); color: #fff; cursor: pointer; font-size: 11px; }
    .frow button:disabled { opacity: .5; cursor: wait; }
    .fblock { padding: 4px 0 8px 6px; border-bottom: 1px dashed #f0e6fa; }
    .fblock:last-child { border-bottom: 0; }
    .fstep { font-size: 11px; color: #5b4a7a; padding: 2px 0; word-break: break-all; }
    .fstep .op { color: #a78bfa; font-weight: 600; }
    .fmgr { display: flex; gap: 6px; align-items: center; padding-top: 4px; }
    .fmgr input { flex: 1; min-width: 0; border: 1px solid #e9dcf7; border-radius: 8px; padding: 4px 8px;
      font: inherit; font-size: 12px; background: #fff; color: #3d3350; }
    .fmgr button { flex: none; border: 0; border-radius: 8px; padding: 4px 10px; font-size: 11px; cursor: pointer;
      background: linear-gradient(135deg, #ff9ac6, #a78bfa); color: #fff; font-family: inherit; }
    .fmgr button.del { background: #ffe4e6; color: #be123c; }
    .replay-last { margin-top: 4px; }
    .msg { font-size: 12px; color: #5b4a7a; background: #f6efff; border-radius: 10px; padding: 6px 8px;
      margin-top: 6px; word-break: break-all; max-height: 72px; overflow-y: auto; }
    .msg.err { background: #ffe4e6; color: #be123c; }
    .msg-act { margin-top: 4px; }
    .msg-act button { border: 0; border-radius: 8px; padding: 3px 10px; font-size: 11px; cursor: pointer;
      background: linear-gradient(135deg, #ff9ac6, #a78bfa); color: #fff; font-family: inherit; }
    .hint { font-size: 10px; color: #b3a6c9; margin-top: 4px; }
    .foot { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid #f3e8ff; }
    .foot button { flex: 1; border: 0; border-radius: 10px; padding: 6px; font-size: 12px; cursor: pointer;
      background: #f6efff; color: #6b5a8f; font-family: inherit; }
    .ctxmenu { position: absolute; width: 170px; border-radius: 14px; overflow: hidden;
      background: linear-gradient(180deg, #fff, #fdf3ff); border: 1px solid #f3e3ff;
      box-shadow: 0 8px 26px rgba(120,80,200,.3); padding: 4px; z-index: 2; }
    .ctxmenu button { display: block; width: 100%; border: 0; background: none; text-align: left;
      padding: 7px 10px; border-radius: 10px; font: inherit; font-size: 12px; color: #5b4a7a; cursor: pointer; }
    .ctxmenu button:hover { background: #f3e8ff; }
  `;

  /* ---------------- DOM 构建（不用 innerHTML：Trusted Types / XSS 双安全） ---------------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  let sheet = null;
  try { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); } catch (e) { sheet = null; }
  const host = document.createElement('div');
  host.id = '__rpa-ball-host';
  const root = host.attachShadow({ mode: 'open' });
  if (sheet) root.adoptedStyleSheets = [sheet];
  else { const st = document.createElement('style'); st.textContent = CSS; root.appendChild(st); }

  const ball = el('div', 'ball');
  ball.appendChild(el('div', 'ear l'));
  ball.appendChild(el('div', 'ear r'));
  ball.appendChild(el('div', 'gloss'));
  ball.appendChild(el('div', 'eye'));
  ball.appendChild(el('div', 'eye r'));
  ball.appendChild(el('div', 'blush'));
  ball.appendChild(el('div', 'blush r'));
  ball.appendChild(el('div', 'mouth'));
  const badge = el('div', 'badge hide', '0');
  ball.appendChild(badge);
  ball.title = 'Web RPA：点我打开快捷面板，拖动换位置';

  const panel = el('div', 'panel hide');
  const phead = el('div', 'phead', '🎀 Web RPA 快捷操作');
  const xBtn = el('button', 'x', '✕');
  xBtn.type = 'button';
  phead.appendChild(xBtn);
  const pbody = el('div', 'pbody');
  const statusLine = el('div', 'status');
  const dot = el('span', 'dot');
  const statusText = el('span', '', '检测中…');
  const modeChip = el('span', 'mode-chip', '');
  statusLine.appendChild(dot);
  statusLine.appendChild(statusText);
  statusLine.appendChild(modeChip);
  const recSec = el('div', '');
  const runNowSec = el('div', 'runnow none', '当前没有运行中的回放');
  const runSect = el('div', 'sect', '▶ 快速回放（最近流程）');
  const flowList = el('div', '');
  const msg = el('div', 'msg hide');
  const msgAct = el('div', 'msg-act hide');
  const msgConsole = el('button', '', '🩵 打开控制台看报告');
  msgConsole.type = 'button';
  msgConsole.addEventListener('click', () => send({ type: 'rpa-open-console' }));
  msgAct.appendChild(msgConsole);
  pbody.appendChild(statusLine);
  pbody.appendChild(recSec);
  pbody.appendChild(runNowSec);
  pbody.appendChild(runSect);
  pbody.appendChild(flowList);
  pbody.appendChild(msg);
  pbody.appendChild(msgAct);
  const foot = el('div', 'foot');
  const consoleBtn = el('button', '', '🧊 完整控制台');
  const hideBtn = el('button', '', '🙈 本页隐藏');
  foot.appendChild(consoleBtn);
  foot.appendChild(hideBtn);
  panel.appendChild(phead);
  panel.appendChild(pbody);
  panel.appendChild(foot);

  const ctxmenu = el('div', 'ctxmenu hide');
  const wrap = el('div', 'wrap');
  wrap.appendChild(panel);
  wrap.appendChild(ctxmenu);
  wrap.appendChild(ball);
  root.appendChild(wrap);
  document.documentElement.appendChild(host);

  /* ---------------- 状态与工具 ---------------- */
  let pos = { x: window.innerWidth - 60, y: Math.round(window.innerHeight * 0.4) };
  let panelOpen = false;
  let pollTimer = null;
  let lastFlowId = null; // 本轮会话内最近生成的技能（重播用）
  let mySession = false; // 录制会话是否由本页发起（防误操作他人的录制会话）
  /* 插拔式双模：bridgeHealthy=null 未知/true 依赖 MCP/false 独立模式（桥接不可用时本地录制回放仍可用） */
  let bridgeHealthy = null;
  let localRec = null; // RpaStandalone 录制器实例（独立模式本地录制）
  let localRecTimer = null;

  /* 与 lib/store.mjs stepLabel 同口径的一句话摘要（面板内查看步骤用） */
  const OP_LABEL = {
    goto: '打开网址', click: '点击', clickAndDownload: '点击并下载', fill: '填入', select: '选择',
    check: '勾选', press: '按键', setInputFiles: '上传文件', waitFor: '等待元素', waitForText: '等待文字',
    humanHandoff: '人工接管', screenshot: '截图', extract: '取值', download: '等待下载', assert: '校验',
    chain: '串联流程', hover: '悬停', scrollIntoView: '滚动到可见', sleep: '等待', dialog: '处理弹窗', scrollTo: '滚动页面',
  };
  function locHint(s) {
    const l = (s.locators || [])[0];
    if (!l) return '(无定位符)';
    return l.strategy + '=' + String(l.value).slice(0, 40);
  }
  function stepLabel(s, idx) {
    const n = (idx + 1) + '. ';
    const op = OP_LABEL[s.op] || s.op;
    switch (s.op) {
      case 'goto': return n + op + ' ' + (s.url || '');
      case 'click': case 'hover': case 'scrollIntoView':
        return n + op + ' ' + locHint(s) + (s.optional ? ' [可跳过]' : '');
      case 'fill': return n + op + ' ' + locHint(s) + ' = ' + (s.sensitive ? '******' : JSON.stringify(s.value));
      case 'select': return n + op + ' ' + locHint(s) + ' -> ' + (s.label || s.value);
      case 'check': return n + (s.checked === false ? '取消勾选' : '勾选') + ' ' + locHint(s);
      case 'press': return n + op + ' ' + (s.key || 'Enter') + ' ' + locHint(s);
      case 'setInputFiles': return n + op + ' ' + (s.path || (s.fileNames || []).join(','));
      case 'waitFor': return n + op + ' ' + locHint(s) + ' state=' + (s.state || 'visible');
      case 'waitForText': return n + op + ' 出现文字 ' + JSON.stringify(s.text);
      case 'humanHandoff': return n + '人工接管（' + (s.reason || '需要人工') + '）';
      case 'screenshot': return n + op + ' ' + (s.name || 'evidence');
      case 'extract': return n + op + ' ' + locHint(s) + ' as ' + (s.as || '?');
      case 'download': return n + op + ' 保存到 ' + (s.saveAs || '(自动)');
      case 'assert': return n + op + ' [' + (s.kind || '?') + '] ' + (s.message || '');
      case 'chain': return n + op + ' ' + (s.flow || '?');
      case 'sleep': return n + op + ' ' + (s.ms || 1000) + 'ms';
      case 'dialog': return n + op + '：' + (s.accept === false ? '取消' : '接受') + '弹窗';
      case 'scrollTo': return n + op + ' 到' + (s.to === 'top' ? '顶部' : '底部') + (s.times ? ' x' + s.times : '');
      default: return n + op;
    }
  }

  function clampPos(p) {
    const m = 30;
    return {
      x: Math.min(Math.max(p.x, m), Math.max(window.innerWidth - m, m)),
      y: Math.min(Math.max(p.y, m), Math.max(window.innerHeight - m, m)),
    };
  }
  function place() {
    pos = clampPos(pos);
    ball.style.left = pos.x + 'px';
    ball.style.top = pos.y + 'px';
    // 面板靠近屏幕下沿时向上展开；靠左右边时收拢偏移避免溢出
    panel.classList.toggle('up', pos.y > window.innerHeight * 0.55);
    const half = 134;
    const shift = pos.x < half + 8 ? (half + 8 - pos.x) : (pos.x + half > window.innerWidth - 8 ? (window.innerWidth - 8 - pos.x - half) : 0);
    panel.style.transform = 'translateX(calc(-50% + ' + shift + 'px))';
    panel.style.left = pos.x + 'px';
  }
  function setMsg(text, isErr) {
    msg.textContent = text;
    msg.className = 'msg' + (isErr ? ' err' : '') + (text ? '' : ' ' + 'hide');
    // 失败时补「打开控制台看报告」入口——完整报告（截图/步骤明细）在 /console，msg 一行装不下
    if (msgAct) {
      msgAct.classList.toggle('hide', !isErr || !text);
      if (isErr && text) msgAct.querySelector('button').textContent = '🩵 打开控制台看报告';
    }
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function startPoll() {
    stopPoll();
    let fails = 0; // 瞬时抖动容忍：单次 record_status 失败不再永久停轮询、不再把「自己的录制」误标成外部会话
    pollTimer = setInterval(async () => {
      let r;
      try { r = await call('record_status'); } catch (e) { r = { ok: false }; }
      const on = r.ok && r.data && r.data.recording;
      if (on) {
        fails = 0;
        badge.textContent = String(r.data.stepCount || 0);
      } else {
        fails++;
        if (fails >= 3) { // 连续 3 次拿不到录制状态才认定真的结束了
          stopPoll();
          mySession = false;
          badge.classList.add('hide');
          ball.classList.remove('rec');
          if (panelOpen) refresh();
        }
      }
    }, 3000);
  }

  /* ---------------- 面板渲染 ---------------- */
  /* 快速录制当前页（面板按钮与右键菜单共用） */
  async function quickRecord() {
    setMsg('正在打开录制窗口…');
    const hhmm = new Date().toTimeString().slice(0, 5).replace(':', '');
    const r = await call('record_start', { url: location.href, name: '悬浮-' + location.hostname + '-' + hhmm });
    if (r.ok) {
      mySession = true;
      setMsg('🎬 ' + (r.summary || '录制已开始'));
      startPoll();
      refresh();
    } else {
      // 被拒常见原因：录制器被其他会话占用（如片段重录中）——错误原文透传
      setMsg('❌ ' + (r.summary || '无法开始录制'), true);
      refresh(); // 刷新后走「外部会话只观察」分支
    }
  }

  function renderRec(rec) {
    recSec.textContent = '';
    const on = rec && rec.ok && rec.data && rec.data.recording;
    if (on && !mySession) {
      // 检测到外部会话的录制（如在别处发起的片段重录）：只观察不干预——
      // ⏹/✕ 作用于全局录制器，误点会结束别人的会话（gitee 实测轮实锤过此风险）
      badge.classList.add('hide');
      ball.classList.remove('rec');
      stopPoll();
      const other = el('div', 'msg', '⏳ 检测到其他会话正在录制（' + (rec.data.mode || '录制中') + '，已 ' + (rec.data.stepCount || 0) + ' 步）。本页未发起，不提供干预；要结束请到发起处操作。');
      recSec.appendChild(other);
      recSec.appendChild(el('div', 'hint', '发起录制后本页可结束/取消/重播；他人录制期间无法并行录制。'));
      return;
    }
    if (on) {
      badge.textContent = String(rec.data.stepCount || 0);
      badge.classList.remove('hide');
      ball.classList.add('rec');
      startPoll();
      const stop = el('button', 'act primary', '⏹ 结束并保存（' + (rec.data.stepCount || 0) + ' 步）');
      stop.type = 'button';
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        setMsg('正在生成技能…');
        const r = await call('record_stop', {});
        if (r.ok) { mySession = false; }
        if (r.ok && r.data && r.data.flowId) { lastFlowId = r.data.flowId; }
        setMsg((r.ok ? '✅ ' : '❌ ') + (r.summary || '') + (r.ok && r.data && r.data.flowId ? '（flowId=' + r.data.flowId + '）' : ''), !r.ok);
        refresh();
      });
      const cancel = el('button', 'act danger', '✕ 取消录制（丢弃已录步骤）');
      cancel.type = 'button';
      cancel.addEventListener('click', async () => {
        if (cancel.dataset.armed !== '1') {
          cancel.dataset.armed = '1';
          cancel.textContent = '⚠ 再点一次确认取消';
          setTimeout(() => { if (cancel.isConnected) { cancel.dataset.armed = '0'; cancel.textContent = '✕ 取消录制（丢弃已录步骤）'; } }, 3000);
          return;
        }
        cancel.disabled = true;
        const r = await call('record_cancel', {});
        if (r.ok) { mySession = false; }
        setMsg(r.ok ? '已取消录制' : '❌ ' + r.summary, !r.ok);
        refresh();
      });
      recSec.appendChild(stop);
      recSec.appendChild(cancel);
      recSec.appendChild(el('div', 'hint', '去弹出的录制窗口里演示操作；这里的 ⏹ 会生成技能。'));
    } else {
      badge.classList.add('hide');
      ball.classList.remove('rec');
      stopPoll();
      // 本轮刚生成的技能：一键重播
      if (lastFlowId) {
        const replay = el('button', 'act primary replay-last', '🔁 重播刚生成的技能');
        replay.type = 'button';
        replay.addEventListener('click', () => {
          replay.disabled = true;
          setMsg('重播 ' + lastFlowId + ' 中…（关掉本页不会中断）');
          // allowLintErrors：刚录制的流程用户已确认过步骤，简单页面常推断不出断言（L010），
          // 快速重播不应被阻断；常规流程列表的 ▶ 仍守静态检查。
          call('flow_run', { flowId: lastFlowId, allowLintErrors: true }).then((r) => {
            const d = r.data || {};
            const dur = typeof d.durationMs === 'number' ? '（' + (d.durationMs / 1000).toFixed(1) + 's）' : '';
            setMsg((r.ok && d.status === 'pass' ? '✅ 重播成功 ' : '❌ ') + (r.summary || '') + dur, !(r.ok && d.status === 'pass'));
            replay.disabled = false;
          });
        });
        recSec.appendChild(replay);
      }
      const start = el('button', 'act primary', '🎬 快速录制当前页');
      start.type = 'button';
      start.addEventListener('click', async () => {
        start.disabled = true;
        await quickRecord();
        start.disabled = false;
      });
      recSec.appendChild(start);
      recSec.appendChild(el('div', 'hint', '会打开一个独立录制窗口，在里面演示操作。'));
    }
  }

  function renderFlows(r) {
    flowList.textContent = '';
    const flows = (r && r.ok && r.data && r.data.flows) || [];
    if (!flows.length) {
      flowList.appendChild(el('div', 'hint', bridgeHealthy === false
        ? '桥接未连接——MCP 流程不可用，可用下方「本地流程」（独立模式）'
        : '还没有流程——先点上面的 🎬 录一个。'));
      return;
    }
    flows.slice(0, 5).forEach((f) => {
      const row = el('div', 'frow');
      const name = el('span', 'fname');
      name.appendChild(el('span', 'n', f.name || f.id));
      name.appendChild(el('span', 'm', f.stepCount + ' 步 · ' + f.assertionCount + ' 断言'));
      row.appendChild(name);

      // ▶ 重播（无头回放）
      const run = el('button', '', '▶');
      run.type = 'button';
      run.title = '无头回放 ' + f.id;
      run.addEventListener('click', () => {
        run.disabled = true;
        run.textContent = '⏳';
        setMsg('回放 ' + f.id + ' 中…（关掉本页不会中断）');
        call('flow_run', { flowId: f.id }).then((r2) => {
          const d = r2.data || {};
          const dur = typeof d.durationMs === 'number' ? '（' + (d.durationMs / 1000).toFixed(1) + 's）' : '';
          setMsg((r2.ok && d.status === 'pass' ? '✅ ' : '❌ ') + (r2.summary || '') + dur, !(r2.ok && d.status === 'pass'));
          run.disabled = false;
          run.textContent = '▶';
        });
      });
      row.appendChild(run);

      // 👁 查看步骤（行内展开步骤清单）
      const view = el('button', '', '👁');
      view.type = 'button';
      view.title = '查看 ' + f.id + ' 的步骤';
      let viewBox = null;
      view.addEventListener('click', async () => {
        if (viewBox) { viewBox.remove(); viewBox = null; return; }
        const box = el('div', 'fblock');
        box.appendChild(el('div', 'fstep', '加载步骤…'));
        row.insertAdjacentElement('afterend', box);
        viewBox = box;
        const r2 = await call('flow_show', { flowId: f.id, format: 'json' });
        if (viewBox !== box) return; // 已被再次点击关闭
        box.textContent = '';
        if (!r2.ok) { box.appendChild(el('div', 'fstep', '❌ ' + (r2.summary || '读取失败'))); return; }
        const steps = (r2.data && r2.data.steps) || [];
        steps.forEach((s, i) => box.appendChild(el('div', 'fstep', stepLabel(s, i))));
        const as = (r2.data && r2.data.assertions) || [];
        if (as.length) box.appendChild(el('div', 'fstep', '断言: ' + as.map((a) => a.kind).join(', ')));
        const ps = (r2.data && r2.data.params) || [];
        if (ps.length) box.appendChild(el('div', 'fstep', '变量: ' + ps.map((p) => p.name).join(', ')));
      });
      row.appendChild(view);

      // ⚙ 管理（行内重命名 / 删除）
      const gear = el('button', '', '⚙');
      gear.type = 'button';
      gear.title = '管理 ' + f.id;
      let mgrBox = null;
      gear.addEventListener('click', () => {
        if (mgrBox) { mgrBox.remove(); mgrBox = null; return; }
        const box = el('div', 'fblock');
        const input = el('input');
        input.type = 'text';
        input.value = f.name || f.id;
        const save = el('button', '', '✓ 保存');
        save.type = 'button';
        const del = el('button', 'del', '🗑 删除');
        del.type = 'button';
        del.title = '删除 ' + f.id + '（有备份可回滚）';
        const mgr = el('div', 'fmgr');
        mgr.appendChild(input);
        mgr.appendChild(save);
        mgr.appendChild(del);
        box.appendChild(mgr);

        // ✂ 重录片段（record_splice_start 快捷入口：前缀会重放，页面回到该步之前的真实状态）
        const spliceRow = el('div', 'fmgr');
        const spliceBtn = el('button', '', '✂ 重录片段');
        spliceBtn.type = 'button';
        spliceBtn.title = '只重录第 from~to 步（前缀自动重放）';
        spliceRow.appendChild(spliceBtn);
        box.appendChild(spliceRow);
        let spliceForm = null;
        spliceBtn.addEventListener('click', async () => {
          if (spliceForm) { spliceForm.remove(); spliceForm = null; return; }
          spliceBtn.disabled = true;
          const show = await call('flow_show', { flowId: f.id, format: 'json' });
          spliceBtn.disabled = false;
          if (spliceForm) return;
          if (!show.ok) { setMsg('❌ ' + (show.summary || '读取流程失败'), true); return; }
          const total = ((show.data && show.data.steps) || []).length || 1;
          const form = el('div', 'fblock');
          const row2 = el('div', 'fmgr');
          const fromIn = el('input'); fromIn.type = 'number'; fromIn.min = '1'; fromIn.value = '1';
          const toIn = el('input'); toIn.type = 'number'; toIn.min = '1'; toIn.value = String(total);
          const go = el('button', '', '开始重录');
          go.type = 'button';
          row2.appendChild(fromIn); row2.appendChild(toIn); row2.appendChild(go);
          form.appendChild(row2);
          form.appendChild(el('div', 'fstep', '共 ' + total + ' 步。前缀（第 1~from-1 步）会自动重放，页面回到该步之前的真实状态；完成后结束录制即自动拼接回本流程（原定义有备份可回滚）。'));
          box.appendChild(form);
          spliceForm = form;
          go.addEventListener('click', async () => {
            const from = parseInt(fromIn.value, 10), to = parseInt(toIn.value, 10);
            if (!(from >= 1) || !(to >= from)) { setMsg('❌ 区间无效：from≥1 且 to≥from', true); return; }
            go.disabled = true;
            setMsg('正在准备重录（前缀重放中，浏览器窗口即将打开）…');
            const r2 = await call('record_splice_start', { flowId: f.id, from, to, keepSuffix: true });
            if (r2.ok) {
              mySession = true;
              setMsg('✂ ' + (r2.summary || '片段重录已开始') + '——去录制窗口重做第 ' + from + '~' + to + ' 步，完成后点 ⏹ 自动拼接。');
              startPoll();
              refresh();
            } else {
              setMsg('❌ ' + (r2.summary || '无法开始重录'), true);
              go.disabled = false;
              refresh(); // 被外部占用时转只观察
            }
          });
        });

        row.insertAdjacentElement('afterend', box);
        mgrBox = box;
        save.addEventListener('click', async () => {
          const newName = input.value.trim();
          if (!newName || newName === f.name) return;
          save.disabled = true;
          const r2 = await call('flow_rename', { flowId: f.id, name: newName });
          setMsg(r2.ok ? '✅ 已重命名为 ' + newName : '❌ ' + (r2.summary || '改名失败'), !r2.ok);
          refresh();
        });
        del.addEventListener('click', async () => {
          if (del.dataset.armed !== '1') {
            del.dataset.armed = '1';
            del.textContent = '⚠ 再点确认删';
            setTimeout(() => { if (del.isConnected) { del.dataset.armed = '0'; del.textContent = '🗑 删除'; } }, 3000);
            return;
          }
          del.disabled = true;
          const r2 = await call('flow_delete', { flowId: f.id });
          setMsg(r2.ok ? '已删除 ' + f.id + '（flow_restore 可回滚）' : '❌ ' + (r2.summary || '删除失败'), !r2.ok);
          refresh();
        });
      });
      row.appendChild(gear);

      flowList.appendChild(row);
    });
    if (flows.length > 5) flowList.appendChild(el('div', 'hint', '共 ' + flows.length + ' 个，更多流程在完整控制台管理。'));
  }

  /* 运行中回放（live 进度）：lock_status 只查锁文件（轻量，可 3s 轮询）；
   * 持锁=流程在回放（trigger/pid 来自锁记录）；profile 锁=浏览器会话占用。
   * report.json 收尾才写——「进行中」级粒度是锁/marker 能诚实支持的，不假装步骤进度。 */
  let runNowPollTimer = null;
  function stopRunNowPoll() { if (runNowPollTimer) { clearInterval(runNowPollTimer); runNowPollTimer = null; } }
  function startRunNowPoll() {
    stopRunNowPoll();
    runNowPollTimer = setInterval(refreshRunNow, 3000);
  }
  async function refreshRunNow() {
    const r = await call('lock_status', {});
    const locks = (r.ok && r.data && r.data.locks) || [];
    const flowLocks = locks.filter((l) => !l.profile);
    const profileLock = locks.find((l) => l.profile);
    if (flowLocks.length) {
      runNowSec.className = 'runnow';
      runNowSec.textContent = flowLocks.map((l) =>
        '▶ 运行中: ' + (l.flowId || '?') + '（' + ((l.trigger || 'manual') + ' · pid ' + (l.pid || '?')) + '）').join('；');
    } else if (profileLock && profileLock.held) {
      runNowSec.className = 'runnow';
      runNowSec.textContent = '⏳ 浏览器 profile 被占用（可能有回放在跑）';
    } else {
      runNowSec.className = 'runnow none';
      runNowSec.textContent = '当前没有运行中的回放';
    }
  }

  /* ---------------- 独立模式（插拔式：桥接不可用时本地录制回放） ---------------- */
  function renderModeChip() {
    if (bridgeHealthy === true) { modeChip.textContent = '依赖 MCP'; modeChip.className = 'mode-chip dep'; }
    else if (bridgeHealthy === false) { modeChip.textContent = '独立模式'; modeChip.className = 'mode-chip solo'; }
    else { modeChip.textContent = ''; modeChip.className = 'mode-chip'; }
  }
  function localStepLabel(s, i) {
    const n = (i + 1) + '. ';
    if (s.op === 'goto') return n + '打开网址 ' + String(s.url || '').slice(0, 60);
    if (s.op === 'click') return n + '点击 ' + (s.locator.strategy === 'testid' ? 'testid=' + s.locator.value : s.locator.value.slice(0, 46)) + (s.text ? '（' + s.text + '）' : '');
    if (s.op === 'fill') return n + '填入 ' + s.locator.value.slice(0, 40) + ' = ' + JSON.stringify(String(s.value).slice(0, 20));
    if (s.op === 'hover') return n + '悬停 ' + s.locator.value.slice(0, 46);
    if (s.op === 'press') return n + '按键 ' + (s.key || 'Enter') + ' @ ' + s.locator.value.slice(0, 36);
    return n + s.op;
  }
  function startLocalRec() {
    if (localRec) return;
    localRec = window.RpaStandalone.createRecorder((steps) => {
      badge.textContent = String(steps.length);
      badge.classList.remove('hide');
      ball.classList.add('rec');
    });
    localRec.start();
    setMsg('🎬 独立录制中（不依赖 MCP）——在页面上操作，这里只录当前页');
    renderLocalSection();
  }
  function stopLocalRec(save) {
    if (!localRec) return;
    const steps = localRec.stop();
    localRec = null;
    if (localRecTimer) { clearInterval(localRecTimer); localRecTimer = null; }
    badge.classList.add('hide');
    ball.classList.remove('rec');
    if (save) {
      if (!steps.length) { setMsg('没有录到操作，未保存', true); }
      else {
        const hhmm = new Date().toTimeString().slice(0, 5).replace(':', '');
        const flow = { id: 'local-' + Date.now(), name: '本地-' + location.hostname + '-' + hhmm, startUrl: location.href, steps: steps };
        window.RpaStandalone.saveLocal(flow, () => setMsg('✅ 已保存到本地（' + steps.length + ' 步）——在「本地流程」里 ▶ 回放或到控制台升级到 MCP'));
      }
    } else {
      setMsg('已丢弃本地录制（' + steps.length + ' 步）');
    }
    refresh();
  }
  function renderLocalSection() {
    window.RpaStandalone.listLocal((flows) => {
      const box = el('div', 'locsect');
      const head = el('div', 'sect', '📁 本地流程（独立模式 · ' + flows.length + ' 条 · 存浏览器本地）');
      box.appendChild(head);
      const btnRow = el('div', 'frow');
      if (localRec) {
        const stopBtn = el('button', 'act primary', '⏹ 保存到本地');
        stopBtn.type = 'button';
        stopBtn.addEventListener('click', () => stopLocalRec(true));
        const dropBtn = el('button', 'act danger', '✕ 丢弃');
        dropBtn.type = 'button';
        dropBtn.addEventListener('click', () => stopLocalRec(false));
        btnRow.appendChild(stopBtn);
        btnRow.appendChild(dropBtn);
        btnRow.appendChild(el('span', 'hint', '独立录制中：角标显示已录步数'));
      } else {
        const recBtn = el('button', 'act', '🎬 本地录制当前页');
        recBtn.type = 'button';
        recBtn.title = '不依赖 MCP/桥接，直接在本页录制 DOM 操作';
        recBtn.addEventListener('click', startLocalRec);
        btnRow.appendChild(recBtn);
        if (bridgeHealthy === false) btnRow.appendChild(el('span', 'hint', '桥接未连接也能用；连上桥接后可「升级到 MCP」'));
      }
      box.appendChild(btnRow);
      if (resumeMsg) box.appendChild(el('div', 'hint', resumeMsg));
      if (!flows.length) {
        box.appendChild(el('div', 'hint', '还没有本地流程——点上面的 🎬 试录一段（独立模式，不发往任何服务器）'));
      }
      flows.slice(0, 5).forEach((f) => {
        const row = el('div', 'frow');
        const name = el('span', 'fname');
        name.appendChild(el('span', 'n', f.name || f.id));
        name.appendChild(el('span', 'm', (f.steps || []).length + ' 步 · 本地'));
        row.appendChild(name);
        const run = el('button', '', '▶');
        run.type = 'button';
        run.title = '在当前页回放（独立模式）';
        run.addEventListener('click', async () => {
          run.disabled = true; run.textContent = '⏳';
          setMsg('独立回放 ' + (f.name || f.id) + ' 中…');
          const r = await window.RpaStandalone.replaySteps(f.steps || []);
          run.disabled = false; run.textContent = '▶';
          setMsg(r.ok
            ? '✅ 独立回放完成（' + r.done + '/' + r.total + ' 步）'
            : '❌ 独立回放到第 ' + (r.step || r.done) + ' 步：' + (r.error || '失败') + '（' + r.done + '/' + r.total + '）', !r.ok);
        });
        row.appendChild(run);
        // 👁 查看步骤（与 MCP 流程行同款能力——体感不对称修复，v1.21.2）
        const view = el('button', '', '👁');
        view.type = 'button';
        view.title = '查看本地流程步骤';
        let viewBox = null;
        view.addEventListener('click', () => {
          if (viewBox) { viewBox.remove(); viewBox = null; return; }
          const box = el('div', 'fblock');
          (f.steps || []).forEach((s, i) => box.appendChild(el('div', 'fstep', localStepLabel(s, i))));
          row.insertAdjacentElement('afterend', box);
          viewBox = box;
        });
        row.appendChild(view);
        const del = el('button', '', '🗑');
        del.type = 'button';
        del.title = '删除本地流程';
        del.addEventListener('click', () => {
          if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = '⚠'; setTimeout(() => { if (del.isConnected) { del.dataset.armed = '0'; del.textContent = '🗑'; } }, 3000); return; }
          window.RpaStandalone.deleteLocal(f.id, () => { setMsg('已删除本地流程'); refresh(); });
        });
        row.appendChild(del);
        box.appendChild(row);
      });
      flowList.appendChild(box);
    });
  }

  async function refresh() {
    statusText.textContent = '检测中…';
    dot.className = 'dot';
    const [health, rec, flows] = await Promise.all([
      send({ type: 'rpa-health' }),
      call('record_status'),
      call('flow_list'),
    ]);
    bridgeHealthy = !!(health && health.ok && health.mcp && health.mcp.ready);
    renderModeChip();
    if (health && health.ok && health.mcp && health.mcp.ready) {
      dot.className = 'dot ok';
      statusText.textContent = '已连接 · MCP v' + (health.mcp.serverInfo && health.mcp.serverInfo.version);
    } else {
      dot.className = 'dot bad';
      // 失败原因尽量透传（如 token 鉴权 403 的配置指引），兜底提示桥接未启动
      statusText.textContent = (health && health.ok === false && health.summary)
        ? ('桥接异常：' + String(health.summary).slice(0, 80))
        : '桥接未连接（独立模式可用）· node mcp/bridge.mjs 解锁完整功能';
    }
    renderRec(rec);
    renderFlows(flows);
    renderLocalSection();
    refreshRunNow();
  }

  function togglePanel(force) {
    panelOpen = force !== undefined ? force : !panelOpen;
    panel.classList.toggle('hide', !panelOpen);
    if (panelOpen) { setMsg(''); refresh(); startRunNowPoll(); }
    else { stopRunNowPoll(); }
  }

  /* ---------------- 拖拽 + 点击 ---------------- */
  let drag = null;
  ball.addEventListener('pointerdown', (e) => {
    drag = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    try { ball.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  ball.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    pos = { x: drag.ox + dx, y: drag.oy + dy };
    place();
  });
  ball.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (drag.moved) {
      try { chrome.storage.local.set({ __rpaBallPos: pos }); } catch (err) { /* ignore */ }
    } else if (e.button !== 2) {
      togglePanel(); // 右键走 contextmenu 菜单，不开面板
    }
    drag = null;
  });
  ball.addEventListener('pointercancel', () => { drag = null; });

  /* ---------------- 右键快捷菜单（与左键开面板互补） ---------------- */
  function hideBall() {
    try { sessionStorage.setItem('__rpaBallHidden', '1'); } catch (e) { /* ignore */ }
    host.remove();
  }
  function closeCtx() { ctxmenu.classList.add('hide'); }
  function openCtx() {
    // 菜单贴在球旁；靠屏幕右/下缘时收拢避免溢出
    ctxmenu.classList.remove('hide');
    const w = 170, h = 132;
    const left = Math.min(pos.x + 16, Math.max(window.innerWidth - w - 8, 8));
    const top = Math.min(pos.y - 10, Math.max(window.innerHeight - h - 8, 8));
    ctxmenu.style.left = left + 'px';
    ctxmenu.style.top = top + 'px';
  }
  const ctxRec = el('button', '', '🎬 快速录制当前页');
  const ctxHide = el('button', '', '🙈 本页隐藏');
  const ctxSet = el('button', '', '⚙ 设置（打开完整控制台）');
  ctxmenu.appendChild(ctxRec);
  ctxmenu.appendChild(ctxHide);
  ctxmenu.appendChild(ctxSet);
  ctxRec.addEventListener('click', () => { closeCtx(); togglePanel(true); quickRecord(); });
  ctxHide.addEventListener('click', () => { closeCtx(); hideBall(); });
  ctxSet.addEventListener('click', () => { closeCtx(); send({ type: 'rpa-open-console' }); });

  ball.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtx();
  });
  // 点击球外任意处收起菜单（capture 阶段拦在页面脚本之前；Shadow DOM composedPath 仍可达菜单）
  document.addEventListener('click', (e) => {
    if (ctxmenu.classList.contains('hide')) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(ctxmenu) && !path.includes(ball)) closeCtx();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); }, true);

  xBtn.addEventListener('click', () => togglePanel(false));
  consoleBtn.addEventListener('click', () => send({ type: 'rpa-open-console' }));
  hideBtn.addEventListener('click', hideBall);

  /* ---------------- 同源自续播（v1.21.0）：goto 跨页后新页面自动接续本地回放 ---------------- */
  let resumeMsg = '';
  (function tryResume() {
    const st = window.RpaStandalone && window.RpaStandalone.maybeResume ? window.RpaStandalone.maybeResume() : null;
    if (!st) return;
    setMsg('🔁 检测到跨页续播（剩余 ' + (st.steps.length - st.i) + ' 步）…');
    window.RpaStandalone.replaySteps(st.steps.slice(st.i), { gapMs: st.gapMs }).then((r) => {
      resumeMsg = r.ok ? ('✅ 跨页续播完成（' + (st.done + r.done) + '/' + st.total + ' 步）')
        : ('❌ 跨页续放到第 ' + (st.i + (r.step || r.done)) + ' 步：' + (r.error || '失败'));
      setMsg(resumeMsg, !r.ok);
    });
  })();

  /* ---------------- 初始化 ---------------- */
  /* popup→content 通道：独立流程回放到当前页 / 状态查询（插拔式：popup 无桥接也能控本页） */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'rpa-local-replay') {
      window.RpaStandalone.listLocal(async (flows) => {
        const f = flows.find((x) => x.id === msg.flowId);
        if (!f) { sendResponse({ ok: false, error: '本地流程不存在' }); return; }
        setMsg('独立回放 ' + (f.name || f.id) + ' 中…');
        const r = await window.RpaStandalone.replaySteps(f.steps || []);
        setMsg(r.ok ? '✅ 独立回放完成（' + r.done + '/' + r.total + ' 步）'
          : '❌ 独立回放到第 ' + (r.step || r.done) + ' 步：' + (r.error || '失败'), !r.ok);
        sendResponse(r);
      });
      return true; // 异步应答
    }
    if (msg.type === 'rpa-local-state') {
      window.RpaStandalone.listLocal((flows) => {
        sendResponse({ ok: true, mode: bridgeHealthy === true ? 'dependent' : bridgeHealthy === false ? 'standalone' : 'unknown', localCount: flows.length, localRecording: !!localRec });
      });
      return true;
    }
  });
  (async () => {
    try {
      const st = await chrome.storage.local.get({ __rpaBallPos: null });
      if (st.__rpaBallPos && typeof st.__rpaBallPos.x === 'number') pos = st.__rpaBallPos;
    } catch (e) { /* 用默认位置 */ }
    place();
    // 录制进行中（比如刚在别的页面开始）也要亮角标
    const r = await call('record_status');
    if (r.ok && r.data && r.data.recording) {
      badge.textContent = String(r.data.stepCount || 0);
      badge.classList.remove('hide');
      ball.classList.add('rec');
      startPoll();
    }
  })();
})();
