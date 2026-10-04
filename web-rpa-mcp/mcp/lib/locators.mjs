// web-rpa-mcp — 定位符解析 + 多策略降级 + 指纹自愈
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const L = logger('locators');

let _src = null;
export function pageScriptSource() {
  if (_src == null) _src = fs.readFileSync(path.join(__dirname, 'page-script.js'), 'utf8');
  return _src;
}

/** 已注入辅助脚本的 context：addInitScript 会在 context 生命周期里累积，重复调用等于每个新文档多跑一份 */
const HELPERED = new WeakSet();

/** 注入录制/定位辅助脚本（对新文档生效；同一 context 只注入一次） */
export async function installHelpers(context) {
  if (HELPERED.has(context)) return;
  await context.addInitScript({ content: pageScriptSource() });
  HELPERED.add(context);
}

/** 打开/关闭录制开关（对已有页面立即生效） */
export async function setRecordingFlag(context, active) {
  const code = 'window.__rpaRecordActive = ' + (active ? 'true' : 'false') + ';';
  await context.addInitScript({ content: code });
  for (const p of context.pages()) {
    try {
      if (!active) await p.evaluate(() => { try { if (window.__rpa && window.__rpa.flush) window.__rpa.flush(); } catch (e) { /* ignore */ } });
      await p.evaluate(code);
    } catch { /* 页面可能已关闭 */ }
  }
}

/** 确保当前文档里已有 __rpa（页面在注入前就已加载时使用） */
export async function ensureHelpersInPage(page) {
  if (!page || page.isClosed?.()) return;
  try {
    const has = await page.evaluate(() => !!window.__rpa);
    if (!has) await page.addScriptTag({ content: pageScriptSource() });
    await page.evaluate(() => { window.__rpaRecordActive = true; });
  } catch (e) {
    const msg = String(e?.message ?? e);
    // 页面正好在跳转中把旧文档销毁了：新文档由 init script 自带辅助脚本，不算失败
    if (!/Execution context was destroyed/i.test(msg)) L.warn('注入辅助脚本失败', { err: msg });
  }
}

export function frameSelectorsToCss(f) {
  if (!f) return null;
  if (typeof f === 'string') return f;
  if (f.strategy === 'css') return f.value;
  if (f.strategy === 'xpath') return 'xpath=' + f.value;
  if (f.strategy === 'name') return '[name=' + JSON.stringify(f.value) + ']';
  if (f.strategy === 'testid') return '[data-testid=' + JSON.stringify(f.value) + ']';
  if (f.strategy === 'id') return '#' + String(f.value).replace(/([^\w-])/g, '\\$1');
  return f.value;
}

/** 在 Page 或 FrameLocator 上按一个描述符造 locator */
function factory(scope, d) {
  const v = d.value;
  switch (d.strategy) {
    case 'testid': return scope.getByTestId(v);
    case 'role': return d.name ? scope.getByRole(v, { name: d.name, exact: !!d.exact }) : scope.getByRole(v);
    case 'label': return scope.getByLabel(v, d.exact ? { exact: true } : undefined);
    case 'placeholder': return scope.getByPlaceholder(v, d.exact ? { exact: true } : undefined);
    case 'text': return d.exact ? scope.getByText(v, { exact: true }) : scope.getByText(v);
    case 'alt': return scope.getByAltText(v);
    case 'title': return scope.getByTitle(v);
    case 'name': return scope.locator('[name=' + JSON.stringify(v) + ']');
    case 'css': return scope.locator(v);
    case 'xpath': return scope.locator('xpath=' + v);
    case 'id': return scope.locator('#' + String(v).replace(/([^\w-])/g, '\\$1'));
    default: throw new Error('未知定位策略: ' + d.strategy);
  }
}

/** 按 step.locators / step.frame 构造 scope + locator */
export function buildLocator(page, step, overrideLocs) {
  let scope = page;
  const chain = step.frame || step.framePath;
  if (Array.isArray(chain)) {
    for (const f of chain) {
      const css = frameSelectorsToCss(f);
      if (!css) continue;
      scope = scope.frameLocator(css);
    }
  } else if (chain) {
    scope = scope.frameLocator(frameSelectorsToCss(chain));
  }
  const list = overrideLocs || step.locators || [];
  if (!list.length) throw new Error('步骤缺少定位符');
  let loc = factory(scope, list[0]);
  for (let i = 1; i < list.length; i++) loc = loc.or(factory(scope, list[i]));
  if (step.nth !== undefined && step.nth !== null) loc = loc.nth(step.nth);
  return loc;
}

/* ---------------- 指纹自愈（在页面内打分，避免大量往返） ---------------- */
const HEAL_FN = (arg) => {
  const rpa = window.__rpa;
  if (!rpa) return null;
  const target = arg.target || {};
  const tag = target.tag || 'button';

  function sim(a, b) {
    a = String(a == null ? '' : a).replace(/\s+/g, ' ').trim();
    b = String(b == null ? '' : b).replace(/\s+/g, ' ').trim();
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a === b) return 1;
    const m = a.length, n = b.length;
    if (m * n > 20000) {
      const A = new Set(a.split(/\s+/)), B = new Set(b.split(/\s+/));
      let inter = 0;
      A.forEach((x) => { if (B.has(x)) inter++; });
      const denom = A.size + B.size;
      return denom ? (2 * inter) / denom : 0;
    }
    let prev = new Array(n + 1).fill(0);
    let cur = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      const t = prev; prev = cur; cur = t;
      cur.fill(0);
    }
    return prev[n] / Math.max(m, n);
  }

  function jaccard(A, B) {
    if (!A.length && !B.length) return 1;
    if (!A.length || !B.length) return 0;
    const a = new Set(A), b = new Set(B);
    let inter = 0;
    a.forEach((x) => { if (b.has(x)) inter++; });
    const uni = new Set([...A, ...B]).size;
    return uni ? inter / uni : 0;
  }

  function score(cand) {
    let s = 0;
    s += cand.tag === target.tag ? 0.10 : 0;
    s += (cand.role || '') === (target.role || '') ? 0.10 : 0;
    s += 0.25 * sim(cand.name, target.name);
    s += 0.15 * sim(cand.text, target.text);
    const keys = ['id', 'name', 'type', 'aria-label', 'placeholder', 'title', 'href'];
    const ta = target.attrs || {};
    const ca = cand.attrs || {};
    let matched = 0, considered = 0;
    for (const k of keys) {
      if (!ta[k] && !ca[k]) continue;
      considered += 1;
      matched += sim(ta[k], ca[k]);
    }
    s += considered ? 0.15 * (matched / considered) : 0.08;
    s += 0.10 * jaccard(cand.classes || [], target.classes || []);
    s += 0.08 * sim((cand.path || []).join('/'), (target.path || []).join('/'));
    s += 0.07 * (0.5 * sim(cand.prevText, target.prevText) + 0.5 * sim(cand.nextText, target.nextText));
    return s;
  }

  let nodes = [];
  try { nodes = Array.prototype.slice.call(document.querySelectorAll(tag)); } catch (e) { nodes = []; }
  if (!nodes.length) {
    try { nodes = Array.prototype.slice.call(document.querySelectorAll('*')); } catch (e) { nodes = []; }
  }
  const scored = [];
  const limitTotal = 4000;
  for (let i = 0; i < nodes.length && i < limitTotal; i++) {
    const el = nodes[i];
    if (!rpa.isVisible(el)) continue;
    const fp = rpa.fingerprint(el);
    scored.push({ el: el, score: score(fp), idx: i });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const best = scored[0];
  if (best.score < (arg.minScore || 0.72)) return null;
  const second = scored[1] ? scored[1].score : 0;
  return {
    score: Number(best.score.toFixed(4)),
    margin: Number((best.score - second).toFixed(4)),
    ambiguous: !!(scored[1] && best.score - second < 0.05),
    locators: rpa.locators(best.el),
    fingerprint: rpa.fingerprint(best.el),
    text: String(best.el.innerText || best.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  };
};

/**
 * 解析步骤的定位符：按录制顺序尝试 -> 失败则指纹自愈。
 */
export async function locate(page, step, { timeoutMs = 8000, heal = true, minScore = 0.72, scope = null } = {}) {
  const list = step.locators || [];
  const errors = [];
  const root = scope || page;

  for (let i = 0; i < list.length; i++) {
    const one = { ...step, locators: [list[i]], nth: list.length > 1 ? undefined : step.nth };
    try {
      const loc = buildLocator(root, one).first();
      await loc.waitFor({ state: 'visible', timeout: i === 0 ? timeoutMs : Math.min(1200, timeoutMs) });
      return {
        locator: loc,
        strategy: list[i].strategy,
        index: i,
        healed: i > 0,
        healedFrom: i > 0 ? list[0].strategy : null,
        heuristic: false,
        confidence: i > 0 ? 0.9 : 1,
      };
    } catch (e) {
      errors.push(list[i].strategy + ': ' + String(e && e.message ? e.message : e).split('\n')[0].slice(0, 120));
    }
  }

  if (!heal) {
    const err = new Error('定位失败（未启用自愈）：\n' + errors.join('\n'));
    err.code = 'LOCATE_FAILED';
    throw err;
  }

  const target = step.fingerprint;
  if (!target) {
    const err = new Error('定位失败且无指纹可用于自愈：\n' + errors.join('\n'));
    err.code = 'LOCATE_FAILED';
    throw err;
  }

  const res = await page.evaluate(HEAL_FN, { target, minScore }).catch(() => null);
  if (!res) {
    const err = new Error(
      '定位失败：' + list.length + ' 种策略全部失效，指纹自愈也未达到阈值 ' + minScore + '。\n' +
      '这通常意味着页面改版。请重新录制该段步骤，或手动修正定位符。\n尝试记录：\n' + errors.join('\n')
    );
    err.code = 'LOCATE_FAILED';
    err.attempts = errors;
    throw err;
  }

  const healedStep = { ...step, locators: res.locators, nth: undefined };
  const loc = buildLocator(root, healedStep).first();
  await loc.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  return {
    locator: loc,
    strategy: 'heal:fingerprint',
    index: -1,
    healed: true,
    healedFrom: list[0] && list[0].strategy ? list[0].strategy : null,
    heuristic: true,
    confidence: res.score,
    margin: res.margin,
    ambiguous: !!res.ambiguous,
    learnedLocators: res.locators,
    healedText: res.text,
  };
}

/** 非破坏性健康检查：当前页面上这些定位符是否可解析 */
export async function probe(page, step, timeoutMs = 2500) {
  const list = step.locators || [];
  const results = [];
  for (const d of list) {
    try {
      const loc = buildLocator(page, { ...step, locators: [d] }).first();
      const n = await loc.count().catch(() => 0);
      let visible = false;
      if (n > 0) visible = await loc.isVisible().catch(() => false);
      results.push({ strategy: d.strategy, value: String(d.value).slice(0, 80), count: n, visible });
    } catch (e) {
      results.push({ strategy: d.strategy, value: String(d.value).slice(0, 80), count: 0, visible: false, error: String(e && e.message ? e.message : e).slice(0, 100) });
    }
  }
  const okAny = results.some((r) => r.count > 0);
  return { ok: okAny, results, best: results.find((r) => r.count > 0) || null };
}

export const _internal = { HEAL_FN, factory, frameSelectorsToCss };
