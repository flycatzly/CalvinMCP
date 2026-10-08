// web-rpa-mcp — 录制器：把人工演示的点击/填写/跳转沉淀成可审阅的步骤清单
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs, readConfig, logger, nowIso, shortId } from './core.mjs';
import { launchContext, closeContext } from './browser.mjs';
import { installHelpers, setRecordingFlag, ensureHelpersInPage } from './locators.mjs';
import { newFlowId, saveFlow, loadFlow, backupFlow, flowMarkdown, stepLabel } from './store.mjs';
import { lintFlow } from './lint.mjs';
import { autodetectVariables, resolveParams } from './vars.mjs';
import { acquireLock, releaseLock } from './ops.mjs';
import { _internal as playerInternals, replayPrefixSteps } from './player.mjs';

const L = logger('recorder');
const ROW_SELECTORS = playerInternals.ROW_SELECTORS;

let ACTIVE = null;

export function activeSession() { return ACTIVE; }

/** 只有真正的网页才值得录成步骤：浏览器内置页（edge:// chrome:// about: devtools://）会污染流程 */
function isRecordableUrl(u) {
  if (!u) return false;
  return /^https?:\/\//i.test(u) || /^file:\/\//i.test(u);
}

function primaryKey(desc) {
  const l = (desc && desc.locators) || [];
  if (!l.length) return null;
  const best = l[0];
  return best.strategy + '|' + best.value + '|' + (best.name || '');
}

function baseStep(payload) {
  const d = payload.desc || {};
  const step = {
    op: 'click',
    locators: d.locators || [],
    fingerprint: d.fingerprint || null,
    tag: d.tag || null,
    text: (d.text || '').slice(0, 80) || undefined,
  };
  if (Array.isArray(d.frame) && d.frame.length) step.frame = d.frame;   // iframe 链，回放时逐层进入
  if (d.sensitive) { step.sensitive = true; step.sensitiveReason = d.sensitiveReason || 'sensitive-field'; }
  if (d.captchaPresent) step.captchaPresent = true;
  return step;
}

function toStep(payload) {
  const step = baseStep(payload);
  switch (payload.kind) {
    case 'click':
      step.op = 'click';
      break;
    case 'fill':
      step.op = 'fill';
      if (payload.sensitive) { step.value = ''; step.valueMasked = '[已隐藏]'; }
      else step.value = payload.value === undefined ? '' : payload.value;
      break;
    case 'select':
      step.op = 'select';
      step.value = payload.value;
      if (payload.label) step.label = payload.label;
      break;
    case 'check':
      step.op = 'check';
      step.checked = !!payload.checked;
      break;
    case 'press':
      step.op = 'press';
      step.key = payload.key || 'Enter';
      break;
    case 'hover':
      step.op = 'hover';
      break;
    case 'setInputFiles':
      step.op = 'setInputFiles';
      step.fileNames = payload.fileNames || [];
      step.warning = '浏览器安全限制无法获取文件绝对路径，请在步骤里补全 path';
      break;
    default:
      step.op = String(payload.kind || 'click');
  }
  return step;
}

function pushStep(session, step) {
  const last = session.steps[session.steps.length - 1];
  const k = primaryKey({ locators: step.locators });
  if (last && k && primaryKey({ locators: last.locators }) === k) {
    if (step.op === 'fill' && last.op === 'fill') { session.steps[session.steps.length - 1] = step; return; }
    // 点一下复选框/下拉，浏览器紧跟一个 change —— 只保留语义更明确的 change，去掉多余的那次 click
    if ((step.op === 'check' || step.op === 'select') && last.op === 'click') {
      session.steps[session.steps.length - 1] = step;
      return;
    }
    if (step.op === last.op && step.op === 'click' && (Date.now() - session.lastClickAt) < 700) return;
  }
  step.seq = session.steps.length + 1;
  session.steps.push(step);
}

async function capturePageShape(page) {
  try {
    return await page.evaluate((sels) => {
      const rowCounts = {};
      for (const s of sels) { try { rowCounts[s] = document.querySelectorAll(s).length; } catch (e) { /* ignore */ } }
      const emptyTexts = ['暂无数据', '没有数据', '无数据', '暂无记录', '查询结果为空', '暂无内容', 'no data', 'no records'];
      let emptyHit = null;
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const raw = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (!raw || raw.length > 40) continue;
          const low = raw.toLowerCase();
          for (const e of emptyTexts) { if (low.indexOf(e) >= 0) { emptyHit = raw; break; } }
          if (emptyHit) break;
        }
      } catch (e) { /* ignore */ }
      return { rowCounts, emptyHit, url: location.href, title: document.title };
    }, ROW_SELECTORS);
  } catch (e) {
    return { rowCounts: {}, emptyHit: null, url: null, title: null, error: String(e && e.message ? e.message : e) };
  }
}

/** 开始录制：打开可见浏览器并挂钩事件 */
export async function startRecording({ url, name, viewport } = {}) {
  if (ACTIVE) {
    return { ok: false, error: '已有一个录制会话在进行中（id=' + ACTIVE.id + '）。请先 record_stop 或 record_cancel。' };
  }
  ensureDirs();
  const cfg = readConfig();
  const handle = await launchContext({ headed: true, viewport: viewport || cfg.browser.recordViewport });
  const session = {
    id: shortId('rec-'),
    name: name || null,
    startedAt: nowIso(),
    steps: [],
    context: handle.context,
    browser: handle.browser,
    downloads: [],
    downloadTasks: [],
    lastClickAt: 0,
    pendingNavFromClick: 0,
    suppressedUntil: 0,
    booting: false,
    firstShape: null,
    lastShape: null,
    notes: [],
    recordingEnabled: false,
    splice: null,          // 非空表示这是一次"片段重录"会话
    lockFlowId: null,      // 片段重录期间持有的流程锁
  };
  ACTIVE = session;
  await wireSession(session, handle);
  await setSessionRecording(session, handle, true);

  const page = handle.context.pages()[0] || await handle.context.newPage();
  session.page = page;

  if (url) {
    session.startUrl = url;
    session.steps.push({ op: 'goto', url, seq: 1 });
    session.lastUrl = url;
    session.booting = true;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.run.navTimeoutMs });
    } finally {
      session.booting = false;
    }
    const landed = page.url();
    if (landed && landed !== 'about:blank' && landed !== url) {
      session.steps[0].url = landed;
      session.steps[0].redirectedFrom = url;
      session.startUrl = landed;
    }
    session.lastUrl = landed;
    session.suppressedUntil = Date.now() + 1500;
    session.firstShape = await capturePageShape(page);
  } else {
    session.startUrl = null;
    session.notes.push('未指定起始网址：请手动在打开的浏览器里访问目标页面，首个导航会被记录下来');
  }

  L.info('录制已开始', { id: session.id, url: url || null });
  return {
    ok: true,
    sessionId: session.id,
    startedAt: session.startedAt,
    browser: handle.plan ? handle.plan.kind : 'unknown',
    startUrl: session.startUrl,
    message: '请在刚打开的浏览器窗口里，按你平时的流程慢一点操作一遍（每步停顿约半秒）。操作完成后调用 record_stop 生成技能。',
  };
}

/** 把录制钩子接到一个已经打开的浏览器上（普通录制与片段重录共用同一套） */
async function wireSession(session, handle) {
  await handle.context.exposeBinding('__rpaEmit', async (source, payload) => {
    try { onEvent(session, payload, source && source.page ? source.page : null); }
    catch (e) { L.warn('录制事件处理失败', { err: String(e && e.message ? e.message : e) }); }
  });
  await installHelpers(handle.context);

  // 弹窗：还没开始记录时（例如片段重录的前缀重放）只接受、不记录；开始记录后挂到触发它的那次点击上
  session.onDialog = async (d) => {
    if (!ACTIVE || ACTIVE !== session) { try { await d.dismiss(); } catch { /* ignore */ } return; }
    if (!session.recordingEnabled) { try { await d.accept(); } catch { /* ignore */ } return; }
    let target = null;
    for (let i = session.steps.length - 1; i >= 0; i--) {
      if (session.steps[i].op === 'click') { target = session.steps[i]; break; }
    }
    const info = { accept: true, type: d.type(), message: String(d.message() || '').slice(0, 200) };
    if (target) target.expectDialog = info;
    else session.steps.push({ op: 'dialog', accept: true, type: d.type(), message: info.message, seq: session.steps.length + 1 });
    session.notes.push('捕获浏览器弹窗（' + d.type() + '：' + info.message.slice(0, 80) + '）→ 已标记为「接受」，请确认是否本该点「取消」');
    try { await d.accept(); } catch { /* ignore */ }
  };
  for (const pg of handle.context.pages()) pg.on('dialog', session.onDialog);
  handle.context.on('page', (pg) => pg.on('dialog', session.onDialog));

  handle.context.on('page', async (p) => {
    if (!ACTIVE || ACTIVE !== session) return;
    // 只给"这个新页面"补注入；不要再加 init script，否则每开一个弹窗都会堆一份
    try { await ensureHelpersInPage(p); } catch { /* ignore */ }
    let entry = null;   // 这个新标签页的「进入跳转」步骤；重定向链就地改地址，不记成多步
    p.on('framenavigated', (frame) => {
      if (frame !== p.mainFrame()) return;
      if (!session.recordingEnabled) return;
      if (session.page && p === session.page) return;   // 主录制页的跳转要推断 waitForNav，交给 onNavigate
      const u = frame.url();
      if (!isRecordableUrl(u)) return;   // edge://downloads-hub 之类的内置页不录
      if (entry && (Date.now() - entry.at) < 1500) { entry.step.url = u; return; }   // 重定向链收敛到最终地址
      if (entry && (!session.page || session.page.isClosed())) {
        // 主录制页已被用户关掉，这个已在用的标签页接替它：跳转按主页面推断（waitForNav / 被动 goto），
        // 不再记成「开了个新标签」——回放时也不会再多开一页
        session.page = p;
        onNavigate(session, u, p);
        return;
      }
      if (entry) {
        // 已进入过的标签页又跳转（主录制页还在，例如用户手动输入了网址）：
        // 不是开新标签，记成普通 goto，回放时落在这个（最新的）标签页上
        session.lastUrl = u;
        const last = session.steps[session.steps.length - 1];
        if (!(last && last.op === 'goto' && last.url === u && !last.newTab)) {
          session.steps.push({ op: 'goto', url: u, seq: session.steps.length + 1, afterNav: true });
        }
        return;
      }
      if (session.steps.some((s) => s.op === 'goto' && s.url === u && s.newTab)) return;
      const step = { op: 'goto', url: u, newTab: true, seq: session.steps.length + 1 };
      session.steps.push(step);
      entry = { step, at: Date.now() };
    });
  });

  handle.context.on('download', (d) => {
    if (!ACTIVE || ACTIVE !== session) return;
    if (!session.recordingEnabled) return;   // 前缀重放期间产生的下载不记入片段
    session.pendingNavFromClick = 0;   // 下载是这次点击的终点：之后的跳转不能再算到它头上
    let target = null;
    for (let i = session.steps.length - 1; i >= 0; i--) {
      if (session.steps[i].op === 'click') { target = session.steps[i]; break; }
    }
    if (target) {
      target.expectDownload = true;
      target.downloadHint = d.suggestedFilename();
      // 记录真实文件的字节数与数据行数，作为"结果非空"断言的基线
      session.downloadTasks.push((async () => {
        try {
          const p = await d.path();
          if (!p || !fs.existsSync(p)) return;
          target.downloadBytes = fs.statSync(p).size;
          try {
            const txt = fs.readFileSync(p, 'utf8');
            target.downloadLines = txt.split(/\r?\n/).filter((l) => l.trim() !== '').length;
          } catch { /* 二进制文件 */ }
        } catch { /* ignore */ }
      })());
    }
    session.downloads.push({ name: d.suggestedFilename() });
    session.notes.push('捕获下载：' + d.suggestedFilename() + '（已在该点击步骤上标记 expectDownload）');
  });

  for (const p of handle.context.pages()) {
    p.on('framenavigated', (frame) => {
      if (frame !== p.mainFrame()) return;
      onNavigate(session, frame.url(), p);
    });
  }
  handle.context.on('page', (p) => {
    p.on('framenavigated', (frame) => {
      if (frame !== p.mainFrame()) return;
      onNavigate(session, frame.url(), p);
    });
  });
}

/** 开/关"记录事件"（片段重录时，前缀重放阶段必须关掉，否则前缀会被录进片段） */
async function setSessionRecording(session, handle, on) {
  session.recordingEnabled = !!on;
  await setRecordingFlag(handle.context, session.recordingEnabled);
  if (session.recordingEnabled) {
    for (const pg of handle.context.pages()) {
      try { await ensureHelpersInPage(pg); } catch { /* ignore */ }
    }
  }
}


/**
 * 片段重录（splice）：只重录"录错的那一段"，不必整条重录。
 *   1) 先用同一个执行器把原流程的前 from-1 步重放一遍，让页面回到出错那一步之前的真实状态；
 *   2) 打开录制，让用户只把第 from~to 步正确地重做一遍；
 *   3) record_stop 时把 [前缀] + [新片段] + [后缀] 拼接回流程，并自动备份原定义。
 */
export async function startSplice({ flowId, from, to, keepSuffix = true, params = {}, headed = true, viewport } = {}) {
  if (ACTIVE) {
    return { ok: false, error: '已有一个录制会话在进行中（id=' + ACTIVE.id + '）。请先 record_stop 或 record_cancel。' };
  }
  ensureDirs();
  const cfg = readConfig();
  const flow = loadFlow(flowId);
  if (!flow) return { ok: false, error: '流程不存在: ' + flowId };

  const total = (flow.steps || []).length;
  const fromIdx = Number(from);
  const toIdx = (to === undefined || to === null || to === '') ? total : Number(to);
  if (!Number.isInteger(fromIdx) || fromIdx < 1) return { ok: false, error: 'from 必须是从 1 开始的步骤序号' };
  if (total === 0) return { ok: false, error: '该流程没有任何步骤，无需片段重录（直接重新录制即可）' };
  if (fromIdx > total) return { ok: false, error: 'from=' + fromIdx + ' 超出流程步骤数（共 ' + total + ' 步）' };
  if (!Number.isInteger(toIdx) || toIdx < fromIdx) return { ok: false, error: 'to 必须 >= from' };
  if (toIdx > total) return { ok: false, error: 'to=' + toIdx + ' 超出流程步骤数（共 ' + total + ' 步）' };

  // 与定时任务/手工执行互斥：重录期间不允许同一流程被执行
  const lock = acquireLock(flowId, { trigger: 'splice', from: fromIdx, to: toIdx });
  if (!lock.ok) {
    return { ok: false, error: '流程正在执行中（pid ' + lock.heldBy.pid + '，开始于 ' + lock.heldBy.at + '），请等它结束后再重录。' };
  }

  const prefix = (flow.steps || []).slice(0, fromIdx - 1);
  let handle = null;
  try {
    const { values, missing } = await resolveParams(flow, params, {});
    if (missing.length) {
      releaseLock(flowId);
      return { ok: false, error: '重放前缀需要这些参数：' + missing.join('、') + '（请在 record_splice_start 里用 params 传值）' };
    }

    handle = await launchContext({ headed: !!headed, viewport: viewport || cfg.browser.recordViewport });
    const session = {
      id: shortId('spl-'),
      name: flow.name,
      startedAt: nowIso(),
      steps: [],
      context: handle.context,
      browser: handle.browser,
      downloads: [],
      downloadTasks: [],
      lastClickAt: 0,
      pendingNavFromClick: 0,
      suppressedUntil: 0,
      booting: false,
      firstShape: null,
      lastShape: null,
      notes: [],
      recordingEnabled: false,
      lockFlowId: flowId,
      splice: {
        flowId, from: fromIdx, to: toIdx, keepSuffix: !!keepSuffix,
        prefixCount: prefix.length, totalBefore: total,
      },
    };
    ACTIVE = session;
    await wireSession(session, handle);
    await setSessionRecording(session, handle, false);   // 前缀重放期间不记录

    const replay = await replayPrefixSteps({
      handle, cfg, steps: prefix, values,
      downloadsDir: path.join(DIRS.work, 'splice-downloads'),
    });
    session.notes.push('已重放前缀 ' + prefix.length + ' 步，页面已到"待重录片段"之前的真实状态');

    session.page = replay.page && !replay.page.isClosed() ? replay.page : (handle.context.pages()[0] || null);
    session.spliceStartUrl = session.page ? session.page.url() : null;
    session.lastUrl = session.spliceStartUrl;
    session.suppressedUntil = Date.now() + 1500;   // 抑制重放收尾产生的被动 goto
    session.firstShape = session.page ? await capturePageShape(session.page) : null;
    await setSessionRecording(session, handle, true);   // 从这里开始才是"要录的片段"

    L.info('片段重录已开始', { id: session.id, flowId, from: fromIdx, to: toIdx, prefix: prefix.length });
    return {
      ok: true,
      sessionId: session.id,
      flowId,
      splice: session.splice,
      prefixSteps: prefix.map((s, i) => stepLabel(s, i)),
      currentUrl: session.spliceStartUrl,
      message: '已重放到第 ' + fromIdx + ' 步之前（当前页面：' + (session.spliceStartUrl || '未知') + '）。' +
        '请在浏览器里把第 ' + fromIdx + '~' + toIdx + ' 步（原本录错的那一段）正确地重做一遍，然后调用 record_stop 拼接回流程。',
    };
  } catch (e) {
    ACTIVE = null;
    releaseLock(flowId);
    if (handle) await closeContext({ context: handle.context, browser: handle.browser });
    return { ok: false, error: '片段重录启动失败: ' + String(e && e.message ? e.message : e) };
  }
}

function onNavigate(session, url, page) {
  if (!ACTIVE || ACTIVE !== session) return;
  // 只有主录制页的跳转才推断 waitForNav / 记被动 goto；
  // 新标签页的"进入跳转"由 context.on('page') 的处理器记成 goto(newTab)，这里不能重复记
  const isPrimary = !session.page || !page || page === session.page;
  if (!session.recordingEnabled) { if (isPrimary) session.lastUrl = url; session.suppressedUntil = Date.now() + 1200; return; }
  if (!isRecordableUrl(url)) { if (isPrimary) session.lastUrl = url; return; }
  if (session.booting) { if (isPrimary) session.lastUrl = url; return; }
  if (!isPrimary) return;
  const now = Date.now();
  const fromClick = (now - session.pendingNavFromClick) < 12000;
  const sameUrl = session.lastUrl === url;
  session.lastUrl = url;
  if (fromClick) {
    session.pendingNavFromClick = 0;
    session.suppressedUntil = now + 1500;   // 抑制重定向链产生的多余 goto
    // 点击引发了跳转：在点击步骤上标记"等待导航完成"，避免回放抢跑
    for (let i = session.steps.length - 1; i >= 0; i--) {
      if (session.steps[i].op === 'click') { session.steps[i].waitForNav = 'load'; break; }
    }
    return;
  }
  if (sameUrl) return;
  if (now < session.suppressedUntil) return;
  const first = session.steps.length === 0;
  session.steps.push({ op: 'goto', url, seq: session.steps.length + 1, afterNav: !first });
}

function onEvent(session, payload, page) {
  if (!ACTIVE || ACTIVE !== session) return;
  // 用户换到另一个标签页继续操作：把它升为主录制页，后续它的跳转才能正确推断 waitForNav
  if (page && page !== session.page && !page.isClosed() && isRecordableUrl(page.url())) session.page = page;
  const kind = payload.kind;
  if (kind === 'download') return;
  if (kind === 'click') session.lastClickAt = Date.now();
  const step = toStep(payload);
  if (kind === 'click') {
    session.pendingNavFromClick = Date.now();
    step.time = payload.ts || Date.now();
  }
  if (kind === 'setInputFiles') session.notes.push('录到上传文件步骤：' + ((payload.fileNames || []).join(', ') || '(未知文件)') + '，需手动补 path');
  if (kind === 'fill' && payload.sensitive) session.notes.push('录到敏感输入（' + (payload.sensitiveReason || '') + '）：值未保存，需人工接管或改用凭据参数');
  if (step.captchaPresent) session.notes.push('该页面存在验证码组件，必须改为 humanHandoff 步骤');
  if (step.sensitiveReason === 'verification-code') session.notes.push('录到验证码/动态码输入，自动回放会失败');
  pushStep(session, step);
}

/** 录制状态 */
export function recordingStatus() {
  if (!ACTIVE) return { recording: false };
  return {
    recording: true,
    sessionId: ACTIVE.id,
    name: ACTIVE.name,
    startedAt: ACTIVE.startedAt,
    stepCount: ACTIVE.steps.length,
    downloads: ACTIVE.downloads,
    notes: ACTIVE.notes,
    steps: ACTIVE.steps.map((s, i) => stepLabel(s, i)),
    splice: ACTIVE.splice || null,
    mode: ACTIVE.splice ? '片段重录' : '全新录制',
  };
}

/** 结束录制：生成流程 + 自动变量化 + 推断断言 + 静态检查 */
export async function stopRecording({ name, save = true, inferAssertions = true, keepBrowserOpen = false } = {}) {
  if (!ACTIVE) return { ok: false, error: '当前没有进行中的录制会话' };
  const session = ACTIVE;
  // 防抖挂起的填入先提交、再断开会话指针：事件经 onEvent 只认 ACTIVE 上的会话，
  // ACTIVE 一清这些事件就没人接收（修前 __rpa.flush 不存在，停止前 700ms 内的填入直接丢）
  try {
    for (const p of session.context.pages()) {
      if (p.isClosed()) continue;
      await p.evaluate(() => { try { if (window.__rpa && window.__rpa.flush) window.__rpa.flush(); } catch (e) { /* ignore */ } }).catch(() => {});
    }
  } catch { /* ignore */ }
  L.info('停止路径观测: flush后 steps=' + JSON.stringify((session.steps || []).map((s) => s.op)));
  ACTIVE = null;

  try {
    const primary = session.page && !session.page.isClosed() ? session.page : null;
    const shapes = [];
    for (const p of session.context.pages()) {
      if (p.isClosed()) continue;
      const u = p.url();
      if (!isRecordableUrl(u)) continue;
      const sh = await capturePageShape(p);
      shapes.push({ url: u, shape: sh, primary: p === primary });
    }
    await new Promise((r) => setTimeout(r, 600));
    if (session.downloadTasks && session.downloadTasks.length) {
      await Promise.allSettled(session.downloadTasks);
    }
    // 合并所有页面的形态：行数取各页最大值（下载/弹窗可能凭空多出一个空白页，不能让它覆盖真实结果页）
    const merged = { rowCounts: {}, emptyHit: null, url: null, title: null };
    for (const s of shapes) {
      const rc = s.shape.rowCounts || {};
      for (const sel of Object.keys(rc)) merged.rowCounts[sel] = Math.max(merged.rowCounts[sel] || 0, rc[sel]);
      if (!merged.emptyHit && s.shape.emptyHit) merged.emptyHit = s.shape.emptyHit;
    }
    const primaryShape = shapes.filter((s) => s.primary).pop() || shapes[shapes.length - 1] || null;
    if (primaryShape) { merged.url = primaryShape.url; merged.title = primaryShape.shape.title; }
    session.lastShape = merged;
    session.pageShapes = shapes.map((s) => ({ url: s.url, rowCounts: s.shape.rowCounts, emptyHit: s.shape.emptyHit }));
    if (primaryShape) session.lastUrl = primaryShape.url;
  } catch { /* ignore */ }

  if (!keepBrowserOpen) await closeContext({ context: session.context, browser: session.browser });

  // 末尾冗余的 goto 只在「紧跟一次已带 waitForNav 的点击」时才去掉（那次点击已经负责等导航）；
  // 地址栏输入、页面自带跳转这类真正的 goto 是唯一记录，必须保留
  let steps = session.steps.slice();
  L.info('停止路径观测: 切片 steps=' + JSON.stringify(steps.map((s) => s.op)));
  while (steps.length > 1) {
    const last = steps[steps.length - 1];
    const prev = steps[steps.length - 2];
    if (last.op !== 'goto' || !last.afterNav) break;
    if (!prev || prev.op !== 'click' || !prev.waitForNav) break;
    steps.pop();
  }
  steps.forEach((s, i) => { s.seq = i + 1; });

  // 片段重录会话：走"拼接回原流程"的分支
  if (session.splice) {
    return await finalizeSplice(session, steps, { save, inferAssertions, name });
  }

  const detected = autodetectVariables(steps, new Date());
  steps = detected.steps;

  const flowName = name || session.name || ('未命名流程-' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  const flowId = newFlowId(flowName);
  const startUrl = session.startUrl || ((steps.find((s) => s.op === 'goto') || {}).url || null);

  const assertions = [];
  if (inferAssertions) {
    if (session.downloads.length || steps.some((s) => s.expectDownload)) {
      const dlStep = steps.find((s) => s.expectDownload);
      const spec = { kind: 'download', minBytes: 1, minLines: 2, message: '导出文件必须真实生成、且至少有 1 行数据（只有表头等于空报表）' };
      assertions.push(spec);
      if (dlStep && dlStep.downloadLines) {
        spec.recordedLines = dlStep.downloadLines;
        spec.recordedBytes = dlStep.downloadBytes || null;
      }
    }
    const shape = session.lastShape || {};
    const counts = shape.rowCounts || {};
    let bestSel = null;
    for (const sel of ROW_SELECTORS) { if (counts[sel] > 0) { bestSel = sel; break; } }
    if (bestSel) assertions.push({ kind: 'tableNotEmpty', selector: bestSel, min: 1, message: '结果列表不能为空（页面改版点错位置时最容易产出空表）' });
    else if (shape.emptyHit) assertions.push({ kind: 'textAbsent', text: shape.emptyHit, message: '不应出现空状态提示「' + shape.emptyHit + '」' });
  }

  const flow = {
    id: flowId,
    name: flowName,
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startUrl,
    params: [],
    steps,
    assertions,
    recording: {
      sessionId: session.id,
      startedAt: session.startedAt,
      finishedAt: nowIso(),
      notes: session.notes,
      downloads: session.downloads,
      finalUrl: session.lastUrl || null,
      browserShape: session.lastShape || null,
    },
  };

  const lint = lintFlow(flow, readConfig());
  if (save) saveFlow(flow);

  return {
    ok: true,
    saved: save,
    flowId,
    flow,
    stepCount: steps.length,
    assertions,
    lint,
    autoVariables: detected.replaced,
    paramSuggestions: detected.suggestions,
    notes: session.notes,
    markdown: flowMarkdown(flow),
    next: lint.errors.length
      ? '流程存在阻断级问题，先按 lint.errors 修复（通常需要补断言 / 把验证码步骤改成 humanHandoff / 声明参数），再用 flow_run 回放。'
      : '流程已就绪，可以用 flow_run 回放（建议先用 flow_preflight 做非破坏性定位预检）。',
  };
}

export async function cancelRecording() {
  if (!ACTIVE) return { ok: false, error: '当前没有进行中的录制会话' };
  const s = ACTIVE;
  ACTIVE = null;
  await closeContext({ context: s.context, browser: s.browser });
  if (s.lockFlowId) releaseLock(s.lockFlowId);
  return { ok: true, discardedSteps: s.steps.length, splice: s.splice || null, originalFlowUntouched: !!s.splice };
}

/** 供 MCP 外部（如 record_stop 前）拿当前步骤 */
export function currentSteps() { return ACTIVE ? ACTIVE.steps.slice() : []; }

/**
 * 片段重录收尾：[前缀] + [新片段] + [后缀] 拼回原流程。
 * 安全性：新片段为空则拒绝保存；覆盖前自动备份；无论如何都释放流程锁。
 */
async function finalizeSplice(session, segSteps, { save = true, inferAssertions = true, name } = {}) {
  const sp = session.splice;
  const orig = loadFlow(sp.flowId);
  if (!orig) {
    releaseLock(sp.flowId);
    return { ok: false, error: '原流程已不存在: ' + sp.flowId + '（浏览器已关闭，未做任何修改）' };
  }

  // 片段从"当前页"开始，若开头被动录到了同一个地址的 goto，去掉它
  let seg = segSteps.slice();
  L.info('停止路径观测: finalizeSplice 入口 seg=' + JSON.stringify(seg.map((s) => s.op)) + ' spliceStartUrl=' + session.spliceStartUrl);
  while (seg.length && seg[0].op === 'goto' && session.spliceStartUrl && seg[0].url === session.spliceStartUrl) seg.shift();

  if (!seg.length) {
    releaseLock(sp.flowId);
    return {
      ok: false,
      error: '片段里没有录到任何步骤 —— 你可能没有在浏览器里操作，或操作没有触发可记录的事件。原流程未被修改。',
      originalFlow: { flowId: sp.flowId, stepCount: (orig.steps || []).length },
    };
  }

  const detected = autodetectVariables(seg, new Date());
  seg = detected.steps;

  const prefix = (orig.steps || []).slice(0, sp.from - 1);
  const suffix = sp.keepSuffix ? (orig.steps || []).slice(sp.to) : [];
  const steps = prefix.concat(seg, suffix);
  steps.forEach((s, i) => { s.seq = i + 1; });

  const assertions = (orig.assertions || []).slice();
  const segHasDownload = seg.some((s) => s.expectDownload);
  if (inferAssertions && (session.downloads.length || segHasDownload) && !assertions.some((a) => a.kind === 'download')) {
    const dl = seg.find((s) => s.expectDownload);
    const spec = { kind: 'download', minBytes: 1, minLines: 2, message: '导出文件必须真实生成、且至少有 1 行数据（只有表头等于空报表）' };
    if (dl && dl.downloadLines) { spec.recordedLines = dl.downloadLines; spec.recordedBytes = dl.downloadBytes || null; }
    assertions.push(spec);
  }
  if (inferAssertions && !suffix.length) {
    const counts = (session.lastShape || {}).rowCounts || {};
    let bestSel = null;
    for (const sel of ROW_SELECTORS) { if (counts[sel] > 0) { bestSel = sel; break; } }
    if (bestSel && !assertions.some((a) => a.kind === 'tableNotEmpty' || a.kind === 'listNotEmpty')) {
      assertions.push({ kind: 'tableNotEmpty', selector: bestSel, min: 1, message: '结果列表不能为空（页面改版点错位置时最容易产出空表）' });
    }
  }

  const next = Object.assign({}, orig, {
    name: name || orig.name,
    steps,
    assertions,
    updatedAt: nowIso(),
    spliceHistory: (orig.spliceHistory || []).concat([{
      at: nowIso(),
      from: sp.from, to: sp.to,
      replaced: sp.to - sp.from + 1,
      inserted: seg.length,
      keptSuffix: sp.keepSuffix,
      sessionId: session.id,
      notes: session.notes.slice(0, 20),
    }]).slice(-20),
  });

  const lint = lintFlow(next, readConfig());
  let backupPath = null;
  if (save) {
    backupPath = backupFlow(sp.flowId);   // 先备份，万一拼错可一键回滚
    saveFlow(next);
  }
  releaseLock(sp.flowId);

  const warnings = [];
  if (suffix.length) {
    warnings.push('保留了原第 ' + (sp.to + 1) + '~' + sp.totalBefore + ' 步作为后续步骤；新片段结束时的页面状态可能与它们不再匹配，务必先 flow_preflight 再 flow_run 验证。');
  }
  if (session.notes.length) warnings.push('录制提醒：' + session.notes.join('；'));

  return {
    ok: true,
    mode: 'splice',
    saved: save,
    flowId: sp.flowId,
    flow: next,
    // record_stop handler 统一按全新录制的形状读 stepCount/assertions/lint/notes——
    // splice 返回曾缺这三个字段，导致「拼接成功但 handler 抛 undefined.length、工具报 fail」
    //（成功被误报为失败；文件已保存、用户却看到错误）。补齐后 handler 两分支形状一致。
    stepCount: steps.length,
    assertions,
    notes: session.notes,
    splice: {
      from: sp.from, to: sp.to,
      replacedSteps: sp.to - sp.from + 1,
      insertedSteps: seg.length,
      keptSuffix: sp.keepSuffix,
      prefixSteps: prefix.length,
      suffixSteps: suffix.length,
      totalBefore: sp.totalBefore,
      totalAfter: steps.length,
    },
    insertedSteps: seg.map((s, i) => stepLabel(s, i)),
    backupPath,
    lint,
    autoVariables: detected.replaced,
    paramSuggestions: detected.suggestions,
    warnings,
    markdown: flowMarkdown(next),
    next: lint.errors.length
      ? '拼接后仍有阻断级问题，先按 lint.errors 修复再回放。'
      : (suffix.length
        ? '拼接完成。后续步骤未必还匹配新片段的结束状态 —— 先 flow_preflight 再 flow_run。'
        : '拼接完成，可以用 flow_run 回放验证。'),
  };
}
