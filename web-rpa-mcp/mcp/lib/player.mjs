// web-rpa-mcp — 回放引擎：执行步骤 / 结果校验 / 自愈学习 / 证据截图 / 运行报告
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs, readConfig, logger, stampId, maskSecret, nowIso } from './core.mjs';
import { launchContext, closeContext, closeAll } from './browser.mjs';
import {
  acquireLock, releaseLock, releaseAllLocks, lockInfo,
  writeRunningMarker, clearRunningMarker, pruneRuns,
} from './ops.mjs';
import { locate, probe, installHelpers, buildLocator, frameSelectorsToCss } from './locators.mjs';
import { resolveParams, resolveDeep } from './vars.mjs';
import { saveRun, stepLabel, backupFlow } from './store.mjs';
import { lintFlow } from './lint.mjs';
import { sendNotify, composeRunMessage, shouldNotify } from './notify.mjs';

const L = logger('player');

const EMPTY_TEXTS = [
  '暂无数据', '没有数据', '无数据', '暂无记录', '没有记录', '查询结果为空', '暂无内容',
  'no data', 'no records', 'no results', 'empty', 'nothing found',
];
const ROW_PLACEHOLDER_HINTS = ['暂无数据', '没有数据', '无数据', '暂无记录', '没有记录', '查询结果为空', '暂无内容', 'no data', 'no records', 'no results'];
const ERROR_SELECTORS = ['.el-message--error', '.ant-message-error', '.toast-error', '.error-message', '.alert-danger', '#error-message'];
const ROW_SELECTORS = ['table tbody tr', '.el-table__row', '.ant-table-row', '[role="row"]', 'ul li.list-item', '.vxe-body--row'];
const SUBMIT_RE = /提交|保存|确定|确认|发送|导出|付款|支付|submit|save|confirm|send|export|pay/i;

function escRe(s) { return String(s).replace(/[.*+?^$()|[\]\\]/g, '\\$&'); }

function isSubmitLike(step) {
  const parts = [];
  for (const l of step.locators || []) parts.push(String(l.value || ''), String(l.name || ''));
  if (step.text) parts.push(String(step.text));
  return SUBMIT_RE.test(parts.join(' '));
}

function isRetryable(step) {
  if (step.retryable === true) return true;
  if (step.retryable === false) return false;
  if (['goto', 'fill', 'select', 'check', 'waitFor', 'waitForText', 'extract', 'screenshot', 'assert', 'hover', 'scrollIntoView', 'press'].includes(step.op)) return true;
  if (step.op === 'click' && !isSubmitLike(step) && !step.expectDownload) return true;
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- 无人值守：崩溃收尾 / 弹窗 / 截图脱敏 ---------------- */

let _crashHandlersInstalled = false;
function installCrashHandlers() {
  if (_crashHandlersInstalled) return;
  _crashHandlersInstalled = true;
  const bye = (sig) => async () => {
    L.warn('收到退出信号，正在收尾', { sig });
    try { await closeAll(); } catch { /* ignore */ }
    try { releaseAllLocks(); } catch { /* ignore */ }
    // 故意不删 running.json：下次 status_report 会把它报成"中断的执行"
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', bye('SIGINT'));
  process.once('SIGTERM', bye('SIGTERM'));
}

const MASK_CSS = 'input[type="password"],[data-rpa-mask]{filter:blur(6px) !important}';

/** 截图前把密码框等敏感字段打码（只在确实存在敏感字段时才动 DOM） */
async function maskSensitive(page, cfg) {
  try {
    if (cfg.security && cfg.security.maskFieldsInScreenshots === false) return false;
    const n = await page.evaluate(() => document.querySelectorAll('input[type="password"],[data-rpa-mask]').length);
    if (!n) return false;
    await page.evaluate((css) => {
      let s = document.getElementById('__rpa_mask_style');
      if (!s) {
        s = document.createElement('style');
        s.id = '__rpa_mask_style';
        (document.head || document.documentElement).appendChild(s);
      }
      s.textContent = css;
    }, MASK_CSS);
    return true;
  } catch { return false; }
}

async function unmaskSensitive(page) {
  try { await page.evaluate(() => { const s = document.getElementById('__rpa_mask_style'); if (s) s.remove(); }); }
  catch { /* ignore */ }
}

/** 统一截图入口：先打码，再截图，最后还原 */
async function capture(page, cfg, file, fullPage) {
  const masked = await maskSensitive(page, cfg);
  try { await page.screenshot({ path: file, fullPage: !!fullPage }); }
  finally { if (masked) await unmaskSensitive(page); }
  return masked;
}

/* ---------------- 结果校验 ---------------- */

/** 在主页与所有子框架里找"空状态"提示文字——iframe 里渲染的报表同样要能识别 */
async function visibleEmptyState(page) {
  const hits = [];
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate((texts) => {
        const out = [];
        if (!document.body) return out;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const t = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 40) continue;
          const low = t.toLowerCase();
          for (const e of texts) {
            if (low === e || low.indexOf(e) >= 0) {
              const el = n.parentElement;
              if (!el) continue;
              const rc = el.getBoundingClientRect();
              if (rc.width > 0 && rc.height > 0) { out.push(t); break; }
            }
          }
        }
        return out.slice(0, 3);
      }, EMPTY_TEXTS);
      for (const h of r) if (hits.indexOf(h) < 0) hits.push(h);
    } catch { /* 跨域框架忽略 */ }
  }
  return hits.slice(0, 5);
}

/**
 * 统计"真实数据行"：排除空状态占位行（如 <td colspan=4>暂无数据</td>）——文章头号坑的核心。
 * 跨所有子框架统计，iframe 里渲染的报表同样算数。
 */
async function countRealRows(page, selector) {
  let total = 0;
  let real = 0;
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate((arg) => {
        let nodes = [];
        try { nodes = Array.prototype.slice.call(document.querySelectorAll(arg.selector)); } catch (e) { return { total: 0, real: 0 }; }
        let rl = 0;
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i];
          const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (!t) continue;
          let placeholder = false;
          for (const h of arg.hints) { if (t.indexOf(h) >= 0) { placeholder = true; break; } }
          if (placeholder) continue;
          if (el.querySelector && el.querySelector('td[colspan],th[colspan]') && t.length <= 24) continue;
          rl++;
        }
        return { total: nodes.length, real: rl };
      }, { selector, hints: ROW_PLACEHOLDER_HINTS });
      total += r.total;
      real += r.real;
    } catch { /* 跨域框架忽略 */ }
  }
  return { total, real };
}

async function countRows(page) {
  for (const sel of ROW_SELECTORS) {
    let n = 0;
    for (const f of page.frames()) {
      try { n += await f.evaluate((s) => { try { return document.querySelectorAll(s).length; } catch (e) { return 0; } }, sel); }
      catch { /* ignore */ }
    }
    if (n > 0) return { selector: sel, count: n };
  }
  return { selector: null, count: 0 };
}

/** 在主页 + 所有子框架里找文字（iframe 里的结果页也能被断言到） */
async function textAnywhere(page, text, exact, frameDesc) {
  const scopes = [];
  if (Array.isArray(frameDesc) && frameDesc.length) {
    let sc = page;
    for (const f of frameDesc) {
      const css = frameSelectorsToCss(f);
      if (css) sc = sc.frameLocator(css);
    }
    scopes.push(sc);
  } else {
    for (const f of page.frames()) scopes.push(f);
  }
  let total = 0;
  let visible = false;
  for (const sc of scopes) {
    try {
      const loc = exact ? sc.getByText(text, { exact: true }) : sc.getByText(text);
      const n = await loc.count();
      total += n;
      if (!visible && n > 0) visible = await loc.first().isVisible().catch(() => false);
    } catch { /* ignore */ }
  }
  return { total, visible, scanned: scopes.length };
}

async function checkAssertion(page, a, ctx) {
  const min = a.min === undefined ? 1 : Number(a.min);
  try {
    switch (a.kind) {
      case 'textPresent': {
        const r = await textAnywhere(page, a.text, !!a.exact, a.frame);
        return { pass: r.visible, detail: '匹配 ' + r.total + ' 处，可见=' + r.visible + (r.scanned > 1 ? '（扫描 ' + r.scanned + ' 个文档）' : '') };
      }
      case 'textAbsent': {
        const r = await textAnywhere(page, a.text, false, a.frame);
        return { pass: r.total === 0, detail: '匹配 ' + r.total + ' 处（期望 0）' };
      }
      case 'elementVisible': {
        let spec = a;
        if ((!spec.locators || !spec.locators.length) && spec.selector) {
          spec = { ...spec, locators: [{ strategy: 'css', value: spec.selector }] };
        }
        if ((!spec.locators || !spec.locators.length) && spec.text) {
          spec = { ...spec, locators: [{ strategy: 'text', value: spec.text, exact: !!spec.exact }] };
        }
        if (!spec.locators || !spec.locators.length) {
          return { pass: false, detail: '断言缺少 locators / selector / text，无法判断可见性' };
        }
        const r = await locate(page, spec, {
          timeoutMs: a.timeoutMs || 5000,
          heal: true,
          minScore: ctx && ctx.config ? ctx.config.run.healMinScore : 0.72,
        });
        return { pass: true, detail: '命中策略 ' + r.strategy + (r.healed ? '（自愈置信度 ' + r.confidence + '）' : '') };
      }
      case 'elementAbsent': {
        let n = 0;
        try {
          if (a.locators && a.locators.length) {
            const loc = buildLocator(page, { ...a, locators: [a.locators[0]] });
            n = await loc.count();
          } else if (a.selector) {
            n = await page.locator(a.selector).count();
          } else if (a.text) {
            n = await page.getByText(a.text).count();
          }
        } catch { n = 0; }
        return { pass: n === 0, detail: '匹配 ' + n + ' 处（期望 0）' };
      }
      case 'tableNotEmpty': case 'listNotEmpty': {
        const sel = a.selector || (a.kind === 'tableNotEmpty' ? 'table tbody tr' : 'ul li');
        const rr = await countRealRows(page, sel);
        const raw = rr.total;
        const real = rr.real;
        const empties = await visibleEmptyState(page);
        const pass = real >= min && empties.length === 0;
        return {
          pass,
          detail: '选择器 ' + sel + ' 共 ' + raw + ' 行，有效数据行 ' + real + '（要求 >= ' + min + '）' +
            (empties.length ? '，页面提示「' + empties[0] + '」' : ''),
        };
      }
      case 'url': {
        const u = page.url();
        let pass = false;
        if (a.regex) pass = new RegExp(a.regex).test(u);
        else if (a.equals) pass = u === a.equals;
        else pass = u.indexOf(a.contains || '') >= 0;
        return { pass, detail: '当前 URL=' + u };
      }
      case 'title': {
        const t = await page.title();
        let pass = false;
        if (a.regex) pass = new RegExp(a.regex).test(t);
        else if (a.equals) pass = t === a.equals;
        else pass = t.indexOf(a.contains || '') >= 0;
        return { pass, detail: '标题=' + t };
      }
      case 'download': {
        const want = Number(a.minBytes === undefined ? 1 : a.minBytes);
        const minLines = a.minLines === undefined ? 0 : Number(a.minLines);
        const rows = [];
        for (const d of ctx.downloads || []) {
          const rec = { name: d.name, path: d.path, bytes: -1, lines: null, ok: false };
          if (fs.existsSync(d.path)) {
            rec.bytes = fs.statSync(d.path).size;
            if (minLines > 0 && /\.(csv|tsv|txt|json|md)$/i.test(d.path)) {
              try {
                const txt = fs.readFileSync(d.path, 'utf8');
                rec.lines = txt.split(/\r?\n/).filter((l) => l.trim() !== '').length;
              } catch { rec.lines = null; }
            }
            rec.ok = rec.bytes >= want && (minLines === 0 || (rec.lines !== null && rec.lines >= minLines));
          }
          rows.push(rec);
        }
        const valid = rows.filter((r) => r.ok);
        return {
          pass: valid.length > 0,
          detail: '下载文件 ' + rows.length + ' 个：' +
            rows.map((r) => r.name + '(' + r.bytes + 'B' + (r.lines === null ? '' : '/' + r.lines + '行') + ')').join(', ') +
            (minLines ? '　要求 >= ' + want + 'B 且 >= ' + minLines + ' 行数据' : ''),
        };
      }
      case 'extracted': {
        const v = (ctx.extracted || {})[a.as];
        let pass;
        if (a.equals !== undefined) pass = String(v) === String(a.equals);
        else if (a.matches) pass = new RegExp(a.matches).test(String(v === undefined ? '' : v));
        else pass = v !== undefined && v !== null && String(v).trim() !== '';
        return { pass, detail: a.as + '=' + JSON.stringify(v === undefined ? null : String(v).slice(0, 120)) };
      }
      case 'noErrorBanner': {
        const found = [];
        for (const sel of ERROR_SELECTORS) {
          const n = await page.locator(sel).count().catch(() => 0);
          if (n > 0) found.push(sel + ' x' + n);
        }
        return { pass: found.length === 0, detail: found.length ? '发现错误提示元素: ' + found.join(', ') : '未发现错误提示元素' };
      }
      default:
        return { pass: false, detail: '未知断言类型: ' + a.kind };
    }
  } catch (e) {
    return { pass: false, detail: '断言执行异常: ' + String(e && e.message ? e.message : e) };
  }
}

/** 空结果兜底：文章作者的头号坑——改版点错位置却产出了空报表 */
export async function emptyResultGuard(page) {
  const rows = await countRows(page);
  const empties = await visibleEmptyState(page);
  if (empties.length) {
    return { suspicious: true, reason: '页面出现空状态提示「' + empties[0] + '」', rows };
  }
  if (rows.selector && rows.count === 0) {
    return { suspicious: true, reason: '存在数据表格（' + rows.selector + '）但一行数据都没有', rows };
  }
  return { suspicious: false, reason: null, rows };
}

/* ---------------- 步骤执行 ---------------- */

/**
 * 选择当前活动页。
 * 关键：不要被"临时空白页"抢走焦点（点击导出时浏览器可能瞬间开一个 about:blank），
 * 只在出现了"更新的、有真实地址的"页面时才切换。
 */
function activePage(context, prev) {
  const pages = context.pages().filter((p) => !p.isClosed());
  if (!pages.length) return prev;
  const real = pages.filter((p) => {
    try { const u = p.url(); return !!u && u !== 'about:blank'; } catch { return false; }
  });
  if (prev && pages.indexOf(prev) >= 0) {
    const idxPrev = real.indexOf(prev);
    if (idxPrev >= 0) {
      const newer = real.slice(idxPrev + 1);
      if (newer.length) return newer[newer.length - 1];   // 有意开的新标签页
      return prev;                                        // 保持当前页
    }
    // prev 存在但不是"真实页"（例如还是 about:blank）：优先回到真实页
    if (real.length) return real[real.length - 1];
    return prev;
  }
  return real.length ? real[real.length - 1] : pages[pages.length - 1];
}

async function runStep(page, step, ctx) {
  const cfg = ctx.config;
  const timeout = Number(step.timeoutMs || cfg.run.stepTimeoutMs);

  switch (step.op) {
    case 'goto': {
      let target = page;
      if (step.newTab) {
        target = await ctx.context.newPage();
        await installHelpers(ctx.context);
        await target.addInitScript({ content: 'window.__rpaRecordActive = false;' });
      }
      await target.goto(step.url, { waitUntil: step.waitUntil || 'domcontentloaded', timeout: Number(step.navTimeoutMs || cfg.run.navTimeoutMs) });
      ctx.page = target;
      return { page: target, detail: '已打开 ' + step.url };
    }
    case 'sleep':
      await sleep(Number(step.ms) || 1000);
      return { page, detail: '等待 ' + (step.ms || 1000) + 'ms' };
    case 'scrollTo': {
      // 滚动加载型列表（无限滚动）必须显式滚动，Playwright 的自动滚动只在"要点击时"发生
      if (step.locators && step.locators.length) {
        const r = await locate(page, step, { timeoutMs: timeout, minScore: cfg.run.healMinScore });
        await r.locator.scrollIntoViewIfNeeded({ timeout });
        return { page, locate: r, detail: '已滚动到指定元素' };
      }
      const to = step.to === 'top' ? 'top' : 'bottom';
      const times = Math.max(1, Number(step.times) || 1);
      for (let i = 0; i < times; i++) {
        await page.evaluate((arg) => {
          try {
            const max = Math.max(0, document.body.scrollHeight - window.innerHeight);
            // 交替 1px，保证每次都是"位置真的有变化"，否则同一位置不会触发 scroll 事件
            const y = arg.to === 'top' ? 0 : Math.max(0, max - (arg.i % 2));
            window.scrollTo(0, y);
          } catch (e) { /* ignore */ }
        }, { to, i });
        await sleep(Number(step.waitMs) || 500);
      }
      return { page, detail: '已滚动到' + (to === 'top' ? '顶部' : '底部') + (times > 1 ? ' x' + times : '') };
    }
    case 'dialog':
      // 为"下一个动作"设定弹窗处理方式（confirm 必须接受才代表用户真的点了确定）
      ctx.dialogPolicy = { accept: step.accept !== false, promptText: step.promptText, once: true };
      return { page, detail: '已设定下一个浏览器弹窗：' + (step.accept !== false ? '接受' : '取消') };
    case 'click': case 'clickAndDownload': case 'hover': case 'scrollIntoView': {
      let r;
      try {
        r = await locate(page, step, { timeoutMs: timeout, minScore: cfg.run.healMinScore });
      } catch (e) {
        if (step.optional) return { page, detail: '可选步骤：元素不存在，已跳过' };
        throw e;
      }
      if (step.expectDialog) {
        ctx.dialogPolicy = { accept: step.expectDialog.accept !== false, promptText: step.expectDialog.promptText, once: true };
      }
      let downloadInfo = null;
      const wantsDownload = step.expectDownload || step.op === 'clickAndDownload';
      if (step.op === 'hover') { await r.locator.hover({ timeout }); }
      else if (step.op === 'scrollIntoView') { await r.locator.scrollIntoViewIfNeeded({ timeout }); }
      else if (wantsDownload) {
        const dlDir = ctx.downloadsDir;
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: Number(step.downloadTimeoutMs || 60000) }),
          r.locator.click({ timeout, button: step.button || 'left' }),
        ]);
        const name = step.saveAs ? path.basename(step.saveAs) : dl.suggestedFilename();
        const dest = step.saveAs ? path.resolve(step.saveAs) : path.join(dlDir, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await dl.saveAs(dest);
        const size = fs.existsSync(dest) ? fs.statSync(dest).size : -1;
        const info = { path: dest, name, size };
        ctx.downloads.push(info);
        downloadInfo = info;
        if (size === 0) throw new Error('下载文件为 0 字节：' + dest);
      } else {
        await r.locator.click({ timeout, button: step.button || 'left' });
      }
      const after = step.waitForNav || step.waitFor ? activePage(ctx.context, page) : page;
      if (step.waitForNav) await after.waitForLoadState(step.waitForNav === true ? 'load' : step.waitForNav, { timeout: timeout }).catch(() => {});
      ctx.page = after;
      return { page: after, locate: r, detail: (downloadInfo ? '已点击并保存下载 → ' + downloadInfo.path : '已点击') };
    }
    case 'fill': {
      const r = await locate(page, step, { timeoutMs: timeout, minScore: cfg.run.healMinScore });
      if (step.clear) await r.locator.fill('', { timeout });
      await r.locator.fill(String(step.value === undefined ? '' : step.value), { timeout });
      if (step.pressEnter) await r.locator.press('Enter', { timeout });
      return { page, locate: r, detail: '已填入' + (step.sensitive ? '（敏感值已隐藏）' : ' ' + JSON.stringify(String(step.value).slice(0, 40))) };
    }
    case 'select': {
      const r = await locate(page, step, { timeoutMs: timeout, minScore: cfg.run.healMinScore });
      if (step.label) await r.locator.selectOption({ label: step.label }, { timeout });
      else await r.locator.selectOption(String(step.value), { timeout });
      return { page, locate: r, detail: '已选择 ' + (step.label || step.value) };
    }
    case 'check': {
      const r = await locate(page, step, { timeoutMs: timeout, minScore: cfg.run.healMinScore });
      if (step.checked === false) await r.locator.uncheck({ timeout });
      else await r.locator.check({ timeout });
      return { page, locate: r, detail: step.checked === false ? '已取消勾选' : '已勾选' };
    }
    case 'press': {
      const r = await locate(page, step, { timeoutMs: timeout, minScore: cfg.run.healMinScore });
      await r.locator.press(step.key || 'Enter', { timeout });
      if (step.waitForNav) await page.waitForLoadState('load', { timeout: Number(step.navTimeoutMs || cfg.run.navTimeoutMs) }).catch(() => {});
      return { page, locate: r, detail: '已按键 ' + (step.key || 'Enter') };
    }
    case 'setInputFiles': {
      const r = await locate(page, step, { timeoutMs: timeout, minScore: cfg.run.healMinScore });
      if (!step.path) throw new Error('上传步骤缺少本地路径（浏览器无法自动获取，请手动补 path）');
      await r.locator.setInputFiles(path.resolve(step.path), { timeout });
      return { page, locate: r, detail: '已上传 ' + step.path };
    }
    case 'waitFor': {
      if (step.text) {
        await page.getByText(step.text).first().waitFor({ state: step.state || 'visible', timeout });
        return { page, detail: '等到文字「' + step.text + '」' };
      }
      const r = await locate(page, step, { timeoutMs: timeout, minScore: cfg.run.healMinScore });
      await r.locator.waitFor({ state: step.state || 'visible', timeout });
      return { page, locate: r, detail: '等到元素 ' + r.strategy };
    }
    case 'waitForText': {
      await page.getByText(step.text).first().waitFor({ state: step.state || 'visible', timeout: Number(step.timeoutMs || 30000) });
      return { page, detail: '等到文字「' + step.text + '」' };
    }
    case 'humanHandoff': {
      const ms = Number(step.timeoutMs || cfg.run.humanHandoffTimeoutMs);
      if (cfg.browser.headless && !ctx.headed) {
        throw new Error('步骤需要人工接管（' + (step.reason || '验证码/登录') + '），但当前是无头模式。请改用 headed 运行。');
      }
      const deadline = Date.now() + ms;
      ctx.notes.push('等待人工接管：' + (step.reason || '验证码/登录'));
      while (Date.now() < deadline) {
        if (step.resumeWhenTextGone) {
          const n = await page.getByText(step.resumeWhenTextGone).count().catch(() => 0);
          if (n === 0) return { page, detail: '人工接管完成（「' + step.resumeWhenTextGone + '」已消失）' };
        } else if (step.resumeWhenText) {
          const n = await page.getByText(step.resumeWhenText).count().catch(() => 0);
          if (n > 0) return { page, detail: '人工接管完成（出现「' + step.resumeWhenText + '」）' };
        } else if (step.resumeUrlContains) {
          if (page.url().indexOf(step.resumeUrlContains) >= 0) return { page, detail: '人工接管完成（URL 已变化）' };
        } else {
          await sleep(Math.min(3000, ms));
          return { page, detail: '人工接管等待结束（无恢复条件，按固定时长放行）' };
        }
        await sleep(1000);
      }
      throw new Error('人工接管超时（' + Math.round(ms / 1000) + 's）：' + (step.reason || ''));
    }
    case 'screenshot': {
      const file = path.join(ctx.shotsDir, String(ctx.currentStep).padStart(2, '0') + '-' + (step.name || 'shot') + '.png');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const masked = await capture(page, cfg, file, !!step.fullPage);
      if (masked) ctx.evidenceMasked = true;
      ctx.screenshots.push(file);
      return { page, detail: '已截图 ' + path.basename(file) + (masked ? '（敏感字段已打码）' : '') };
    }
    case 'extract': {
      const r = await locate(page, step, { timeoutMs: timeout, minScore: cfg.run.healMinScore });
      let value;
      if (step.attr) value = await r.locator.first().getAttribute(step.attr);
      else if (step.multiple) value = await r.locator.allInnerTexts();
      else {
        // 表单控件取 value（innerText 对 input 永远是空），其它元素取可见文本
        const tag = await r.locator.first().evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        value = ['input', 'textarea', 'select'].indexOf(tag) >= 0
          ? await r.locator.first().inputValue()
          : await r.locator.first().innerText();
      }
      if (typeof value === 'string') value = value.trim();
      ctx.extracted[step.as || ('v' + ctx.steps.length)] = value;
      return { page, locate: r, detail: '取得 ' + (step.as || '') + ' = ' + JSON.stringify(String(value).slice(0, 100)) };
    }
    case 'download': {
      if (!ctx.downloads.length) {
        if (step.optional) return { page, detail: '无下载（可选步骤跳过）' };
        throw new Error('此步骤要求下载，但此前没有捕获到任何下载文件');
      }
      return { page, detail: '已有下载 ' + ctx.downloads.length + ' 个' };
    }
    case 'assert': {
      const res = await checkAssertion(page, step, ctx);
      if (!res.pass) throw new Error('校验失败 [' + step.kind + '] ' + (step.message || '') + ' — ' + res.detail);
      return { page, detail: '校验通过 [' + step.kind + '] ' + res.detail };
    }
    case 'chain': {
      const { runChain } = await import('./chain.mjs');
      const out = await runChain([{ flow: step.flow, params: step.params || {} }], {
        config: ctx.config,
        headed: ctx.headed,
        trigger: 'chain:' + ctx.flowId,
        chainContext: ctx.chainOut,
        notify: false,
      });
      ctx.chainResults.push({ flow: step.flow, status: out.status });
      if (out.status !== 'pass' && !step.continueOnError) {
        throw new Error('串联流程 ' + step.flow + ' 执行失败：' + (out.error || '未知原因'));
      }
      if (out.chains) Object.assign(ctx.chainOut, out.chains);
      ctx.chainOut[step.flow] = Object.assign({}, ctx.chainOut[step.flow] || {}, {
        status: out.status,
        extracted: out.extracted || {},
        downloads: out.downloads || [],
      });
      return { page, detail: '串联流程 ' + step.flow + ' 状态=' + out.status };
    }
    default:
      throw new Error('未知步骤类型: ' + step.op);
  }
}

/* ---------------- 主流程 ---------------- */

/**
 * 回放一个流程。
 * @param {object} flow 流程定义
 * @param {object} opts { params, headed, trigger, allowLintErrors, learn, notify, evidenceOn, dryRun, chainContext }
 */
export async function runFlow(flow, opts = {}) {
  const cfg = readConfig();
  const trigger = opts.trigger || 'manual';
  const stamp = stampId();
  const dir = path.join(DIRS.runs, flow.id, stamp);
  const shotsDir = path.join(dir, 'screenshots');
  const dlDir = path.join(dir, 'downloads');
  ensureDirs();
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(dlDir, { recursive: true });

  const startedAt = nowIso();
  const t0 = Date.now();

  const report = {
    flowId: flow.id,
    name: flow.name || flow.id,
    stamp,
    trigger,
    status: 'fail',
    startedAt,
    finishedAt: null,
    durationMs: 0,
    headed: !!opts.headed,
    params: {},
    steps: [],
    assertions: [],
    screenshots: [],
    downloads: [],
    healed: [],
    promoted: [],
    emptyGuard: null,
    extracted: {},
    failedStep: null,
    error: null,
    notifications: [],
    reportPath: null,
  };

  // 并发锁：定时任务与手工运行撞在一起会导致重复提交业务数据，必须挡住第二次
  const lock = acquireLock(flow.id, { trigger, stamp, headed: !!opts.headed });
  if (!lock.ok) {
    report.status = 'blocked';
    report.error = '流程正在执行中（pid ' + lock.heldBy.pid + '，开始于 ' + lock.heldBy.at +
      '，触发方式 ' + (lock.heldBy.trigger || '未知') + '），为避免重复提交已跳过本次执行';
    report.lock = { pid: lock.heldBy.pid, at: lock.heldBy.at, trigger: lock.heldBy.trigger };
    report.finishedAt = nowIso();
    report.durationMs = Date.now() - t0;
    await finalize(report, cfg, opts, [], null);
    return report;
  }
  installCrashHandlers();
  writeRunningMarker(flow.id, stamp, { trigger, headed: !!opts.headed, flowName: flow.name });

  // 结果校验前置检查（文章：缺了结果校验这一步，回去补）
  const lint = lintFlow(flow, cfg);
  report.lint = { errors: lint.errors, warnings: lint.warnings, infos: lint.infos };
  if (!lint.ok && !opts.allowLintErrors) {
    report.error = '流程未通过静态检查，拒绝执行（可用 allowLintErrors=true 强制运行）：\n' +
      lint.errors.map((e) => '  - [' + e.code + '] ' + (e.step ? '第' + e.step + '步 ' : '') + e.message).join('\n');
    report.status = 'blocked';
    report.finishedAt = nowIso();
    report.durationMs = Date.now() - t0;
    await finalize(report, cfg, opts, [], flow.id);
    return report;
  }

  const { values, missing, notices } = await resolveParams(flow, opts.params || {}, { chain: opts.chainContext || {} });
  const secretValues = secretValuesOf(flow, values);
  if (missing.length) {
    report.error = '缺少必填参数: ' + missing.join(', ') + '（请由人工提供后重跑）';
    report.status = 'blocked';
    report.finishedAt = nowIso();
    report.durationMs = Date.now() - t0;
    await finalize(report, cfg, opts, secretValues, flow.id);
    return report;
  }
  const safeParams = {};
  for (const p of flow.params || []) {
    const v = values[p.name];
    safeParams[p.name] = p.secret ? maskSecret(v) : (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v);
  }
  report.params = safeParams;
  if (notices.length) report.notes = notices;

  const resolvedSteps = resolveDeep(flow.steps || [], { values });
  const resolvedAssertions = resolveDeep(flow.assertions || [], { values });

  let handle = null;
  const ctx = {
    config: cfg, context: null, page: null, downloads: [], screenshots: [], extracted: {},
    notes: [], steps: resolvedSteps, shotsDir, downloadsDir: dlDir, flowId: flow.id,
    headed: !!opts.headed, chainResults: [], chainOut: Object.assign({}, opts.chainContext || {}),
    dialogs: [], dialogPolicy: null, currentStep: 0, evidenceMasked: false,
  };

  try {
    handle = await launchContext({ headed: !!opts.headed || !cfg.browser.headless, downloadsDir: dlDir });
    ctx.context = handle.context;
    // 浏览器弹窗：默认"取消"，但记录下来。confirm 被静默取消 = 操作没生效却看起来成功
    const onDialog = async (d) => {
      const pol = ctx.dialogPolicy;
      const rec = { step: ctx.currentStep, type: d.type(), message: String(d.message() || '').slice(0, 200), action: null, handled: !!pol, unhandled: !pol, at: nowIso() };
      try {
        if (pol && pol.accept) { rec.action = 'accept'; await d.accept(pol.promptText || undefined); }
        else { rec.action = 'dismiss'; await d.dismiss(); }
      } catch (e) { rec.error = String(e && e.message ? e.message : e); }
      if (pol && pol.once) ctx.dialogPolicy = null;
      ctx.dialogs.push(rec);
      if (rec.unhandled) L.warn('出现未预期的浏览器弹窗，已自动取消', { step: rec.step, type: rec.type, message: rec.message });
    };
    for (const pg of handle.context.pages()) pg.on('dialog', onDialog);
    handle.context.on('page', (pg) => pg.on('dialog', onDialog));
    await installHelpers(handle.context);
    await handle.context.addInitScript({ content: 'window.__rpaRecordActive = false;' });
    const first = handle.context.pages()[0] || await handle.context.newPage();
    ctx.page = first;
    let page = first;

    for (let i = 0; i < resolvedSteps.length; i++) {
      const step = resolvedSteps[i];
      ctx.currentStep = i + 1;
      page = activePage(handle.context, page);
      const stepRec = { index: i + 1, op: step.op, label: stepLabel(step), status: 'pass', ms: 0, detail: null, error: null, healed: null, screenshot: null };
      const s0 = Date.now();
      const attempts = 1 + (cfg.run.retries || 0) * (isRetryable(step) ? 1 : 0);
      let lastErr = null;
      let done = false;

      for (let attempt = 1; attempt <= attempts && !done; attempt++) {
        try {
          const res = await runStep(page, step, ctx);
          if (res.page) page = res.page;
          if (res.locate) {
            stepRec.healed = res.locate.healed || null;
            stepRec.strategy = res.locate.strategy;
            if (res.locate.healed) {
              report.healed.push({
                step: i + 1, from: res.locate.healedFrom, to: res.locate.strategy,
                confidence: res.locate.confidence, text: res.locate.healedText || null, ambiguous: !!res.locate.ambiguous,
              });
              if (opts.learn !== false && Array.isArray(res.locate.learnedLocators) && res.locate.learnedLocators.length) {
                const merged = res.locate.learnedLocators.concat(step.locators || []);
                const seen = new Set();
                step.locators = merged.filter((d) => {
                  const k = d.strategy + '|' + d.value;
                  if (seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });
                stepRec.promoted = true;
              } else if (opts.learn !== false && res.locate.index > 0 && step.locators && step.locators.length > 1) {
                const win = step.locators.splice(res.locate.index, 1)[0];
                step.locators.unshift(win);
                stepRec.promoted = true;
              }
            }
          }
          stepRec.detail = res.detail || null;
          done = true;
        } catch (e) {
          lastErr = e;
          if (attempt < attempts) { await sleep(Number(cfg.run.retryDelayMs) || 800); continue; }
        }
      }

      stepRec.ms = Date.now() - s0;
      if (!done) {
        stepRec.status = 'fail';
        stepRec.error = String(lastErr && lastErr.message ? lastErr.message : lastErr);
        report.failedStep = i + 1;
        report.error = stepRec.error;
        try {
          const shot = path.join(shotsDir, 'FAIL-' + String(i + 1).padStart(2, '0') + '.png');
          if (await capture(page, cfg, shot, false)) report.evidenceMasked = true;
          stepRec.screenshot = shot;
          report.screenshots.push(shot);
        } catch { /* ignore */ }
        report.steps.push(stepRec);
        throw lastErr;
      }
      report.steps.push(stepRec);
    }

    // 流程内联断言已在步骤里执行；这里执行流程级断言
    for (const a of resolvedAssertions) {
      const res = await checkAssertion(page, a, ctx);
      report.assertions.push({ kind: a.kind, message: a.message || null, pass: res.pass, detail: res.detail });
    }
    report.extracted = ctx.extracted;

    // 弹窗守卫：confirm 被静默取消 = 操作没生效，却看起来"跑成功了"
    const unhandledDialogs = (ctx.dialogs || []).filter((d) => d.unhandled);
    if ((ctx.dialogs || []).length) {
      report.assertions.push({
        kind: 'noUnexpectedDialog',
        message: unhandledDialogs.length
          ? '出现了流程未处理的浏览器弹窗（已被自动取消，很可能导致操作没真正生效）'
          : '浏览器弹窗均按预期处理',
        pass: !unhandledDialogs.length || cfg.run.strictDialogs === false,
        detail: (ctx.dialogs || []).map((d) => '第' + d.step + '步 ' + d.type + '：' + d.message + ' → 已' + (d.action === 'accept' ? '接受' : '取消')).join('；'),
      });
    }

    // 空结果兜底
    // 空结果守卫：只要页面呈现"空"的形态，就绝不判定为成功
    // （文章作者的原话：改版后按钮挪位，Skill 还在点老位置，生成了一张空表，我半天没发现）
    // 流程若确实允许空结果，可设置 flow.emptyResultOk = true 显式豁免。
    if (cfg.run.emptyResultGuard && !flow.emptyResultOk) {
      const g = await emptyResultGuard(page);
      report.emptyGuard = g;
      if (g.suspicious) {
        report.assertions.push({
          kind: 'emptyResultGuard',
          message: '结果疑似为空，按「空结果不算成功」判定失败',
          pass: false,
          detail: g.reason + '（如该流程确实允许空结果，可设 flow.emptyResultOk=true 豁免）',
        });
      }
    }

    const failedAssert = report.assertions.find((a) => !a.pass);
    if (failedAssert) {
      report.error = '结果校验未通过 [' + failedAssert.kind + '] ' + (failedAssert.message || '') + ' — ' + failedAssert.detail;
      report.status = 'fail';
    } else {
      report.status = 'pass';
    }

    // 末尾证据截图
    const ev = opts.evidenceOn || cfg.run.evidenceOn;
    if (cfg.run.saveEvidence && ev !== 'never' && (ev === 'always' || report.status === 'fail')) {
      const shot = path.join(shotsDir, '99-final.png');
      if (await capture(page, cfg, shot, true).catch(() => false)) report.evidenceMasked = true;
      if (fs.existsSync(shot)) report.screenshots.push(shot);
    }
    report.finalUrl = page.url();
    report.finalTitle = await page.title().catch(() => null);
  } catch (e) {
    report.status = 'fail';
    if (!report.error) report.error = String(e && e.message ? e.message : e);
    const ev = opts.evidenceOn || cfg.run.evidenceOn;
    if (cfg.run.saveEvidence && ev !== 'never' && ctx.page && !ctx.page.isClosed()) {
      const shot = path.join(shotsDir, '99-failure.png');
      if (await capture(ctx.page, cfg, shot, true).catch(() => false)) report.evidenceMasked = true;
      if (fs.existsSync(shot)) report.screenshots.push(shot);
    }
    report.finalUrl = ctx.page && !ctx.page.isClosed() ? ctx.page.url() : null;
  } finally {
    await closeContext(handle);
  }

  report.downloads = ctx.downloads;
  report.extracted = ctx.extracted;
  report.dialogs = ctx.dialogs || [];
  report.evidenceMasked = !!report.evidenceMasked || !!ctx.evidenceMasked;
  report.notes = (report.notes || []).concat(ctx.notes);
  report.finishedAt = nowIso();
  report.durationMs = Date.now() - t0;

  if (opts.learn !== false) {
    const patched = report.steps.some((s) => s.promoted);
    if (patched) {
      try {
        const { loadFlow, saveFlow } = await import('./store.mjs');
        const cur = loadFlow(flow.id);
        if (cur) {
          cur.steps = resolvedSteps.map((s, i) => ({
            ...(cur.steps[i] || s),
            locators: s.locators || (cur.steps[i] || {}).locators,
          }));
          cur.selfHealedAt = nowIso();
          try { backupFlow(flow.id); } catch { /* 备份失败不阻断回写 */ }
          saveFlow(cur);
          report.flowPatched = true;
        }
      } catch (e) { L.warn('自愈定位符回写失败', { err: String(e && e.message ? e.message : e) }); }
    }
  }

  await finalize(report, cfg, opts, secretValues, flow.id);
  return report;
}

/** 敏感参数的值在报告里一律替换掉（步骤说明、URL、断言明细、错误信息都可能带上它） */
function deepRedact(value, secrets) {
  if (!secrets || !secrets.length) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) {
      if (!s) continue;
      out = out.split(s).join('***');
      try { const enc = encodeURIComponent(s); if (enc !== s) out = out.split(enc).join('***'); } catch { /* ignore */ }
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = deepRedact(value[i], secrets);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = deepRedact(value[k], secrets);
    return value;
  }
  return value;
}

function secretValuesOf(flow, values) {
  return (flow.params || [])
    .filter((pp) => pp.secret && values && values[pp.name])
    .map((pp) => String(values[pp.name]));
}

/** 脱敏 -> 清中断标记 -> 落盘报告 -> 留存清理 -> 发告警 -> 释放并发锁 */
async function finalize(report, cfg, opts, secrets, flowId) {
  deepRedact(report, secrets || []);
  if (flowId) clearRunningMarker(flowId, report.stamp);
  report.reportPath = saveRun(report);
  if (flowId) {
    try {
      const pr = pruneRuns(flowId, {});
      if (pr && pr.removed && pr.removed.length) {
        report.retention = { removedRuns: pr.removed.length, kept: pr.kept, keepCount: pr.keepCount, keepRunDays: pr.keepDays };
        report.reportPath = saveRun(report);
      }
    } catch (e) { L.warn('运行记录清理失败', { err: String(e && e.message ? e.message : e) }); }
  }
  await maybeNotify(report, cfg, opts);
  if ((report.notifications || []).length) {
    deepRedact(report, secrets || []);
    report.reportPath = saveRun(report);
  }
  if (flowId) releaseLock(flowId);
  return report.reportPath;
}

async function maybeNotify(report, cfg, opts) {
  if (opts.notify === false) return;
  const event = report.status === 'pass' ? 'success' : 'failure';
  const wantsHealed = (report.healed || []).length > 0 && shouldNotify('healed', cfg);
  if (!shouldNotify(event, cfg) && !wantsHealed) return;
  const msg = composeRunMessage(report, cfg);
  const res = await sendNotify(msg, cfg, { force: true });
  report.notifications.push(res);
}

/**
 * 只顺序执行给定步骤（片段重录用）：不锁流程、不写报告、不跑流程级断言。
 * 与 flow_run 共用 runStep，保证"前缀重放"与"正式回放"行为完全一致。
 */
export async function replayPrefixSteps({ handle, cfg = readConfig(), steps = [], values = {}, downloadsDir, shotsDir }) {
  const ctx = {
    config: cfg, context: handle.context, page: null, downloads: [], screenshots: [], extracted: {},
    notes: [], steps, shotsDir: shotsDir || DIRS.work, downloadsDir,
    dialogs: [], dialogPolicy: null, currentStep: 0, evidenceMasked: false,
    chainResults: [], chainOut: {},
  };
  const resolved = resolveDeep(steps, { values });
  let page = handle.context.pages()[0] || await handle.context.newPage();
  ctx.page = page;
  for (let i = 0; i < resolved.length; i++) {
    const step = resolved[i];
    ctx.currentStep = i + 1;
    page = activePage(handle.context, page);
    const res = await runStep(page, step, ctx);
    if (res && res.page && !res.page.isClosed()) page = res.page;
  }
  return { page, ctx };
}

/* ---------------- 非破坏性预检 ---------------- */

export async function preflightFlow(flow, opts = {}) {
  const cfg = readConfig();
  const out = { flowId: flow.id, startUrl: flow.startUrl || null, steps: [], conclusion: null, note: null };
  let handle = null;
  try {
    handle = await launchContext({ headed: !!opts.headed });
    const context = handle.context;
    await installHelpers(context);
    const page = context.pages()[0] || await context.newPage();
    const steps = flow.steps || [];
    if (flow.startUrl) {
      await page.goto(flow.startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.run.navTimeoutMs });
      out.reachedStartUrl = true;
    } else {
      out.note = '流程没有 startUrl，只能在当前空白页做定位检查';
    }
    // 再依次走一遍开头的连续 goto，让预检落到"步骤真正作用的那一页"
    const leadGotos = [];
    for (const s of steps) {
      if (s.op === 'goto') leadGotos.push(s);
      else break;
    }
    for (const s of leadGotos) {
      const u = s.url || flow.startUrl;
      if (!u || u.indexOf('${') >= 0) { out.navSkip = '起始 goto 含未解析变量，已跳过'; continue; }
      try {
        await page.goto(u, { waitUntil: s.waitUntil || 'domcontentloaded', timeout: cfg.run.navTimeoutMs });
        out.lastNavigated = u;
      } catch (e) { out.navError = String(e && e.message ? e.message : e).split('\n')[0]; }
    }
    let probeCount = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const needsLocator = ['click', 'fill', 'select', 'check', 'press', 'hover', 'extract', 'scrollIntoView', 'setInputFiles', 'waitFor'].includes(s.op);
      if (!needsLocator) { out.steps.push({ index: i + 1, op: s.op, checked: false }); continue; }
      const r = await probe(page, s, 2000);
      probeCount++;
      out.steps.push({
        index: i + 1, op: s.op, checked: true, resolvable: r.ok,
        best: r.best ? r.best.strategy + '=' + r.best.value : null,
        strategies: r.results,
      });
    }
    out.probed = probeCount;
    out.conclusion = '说明：预检只在"起始页"上验证定位符，后续页面上的元素无法提前验证。' +
      '未命中的步骤不一定真失败（可能依赖前面的点击打开新界面），但命中为 0 的步骤值得人工确认。';
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  } finally {
    await closeContext(handle);
  }
  return out;
}

export const _internal = { checkAssertion, isRetryable, isSubmitLike, ROW_SELECTORS };
