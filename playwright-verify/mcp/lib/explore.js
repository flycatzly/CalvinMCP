/**
 * explore.js — 页面探索巡检（explore_page 的取数与判定，纯函数 + 一次网络探活）
 *
 * 对应文章「下一步行动建议」里的探索性测试：死链、坏图、表单盘点。
 * 这件事**不需要 LLM** —— 判据是确定的（图片 naturalWidth 为 0、链接 HTTP 4xx/5xx），
 * 用 LLM 判定反而会把确定的事变成概率的事，所以这里全是确定性逻辑。
 *
 * 取数方式：playwright-cli 的 eval（函数体自包含，结果走 --filename 落盘）——
 * 与全项目「产出落盘、返回摘要」的口径一致。
 *
 * 网络探活的诚实口径：
 *   - HTTP 4xx/5xx → 记「死链」（进 Fail）；
 *   - 网络不可达/超时/总预算耗尽 → 记「不可达」（只警告，不进 Fail）——
 *     离线环境下外链必然不可达，把环境问题算成页面问题就是制造假警报，
 *     一个会假报警的巡检比没有巡检更糟。预算耗尽的条目带 budgetExhausted 标记：
 *     报告可见「没探到」而不是「探过没问题」，同样不许静默。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { ARTIFACT_DIRS, safeSession } from './cli.js';

/** 页面事实采集脚本（自包含：不引用外部变量）。返回 JSON 字符串。 */
export const FACTS_EVAL_FN = `() => JSON.stringify({
  url: location.href,
  title: document.title,
  lang: document.documentElement.lang || '',
  links: Array.from(document.querySelectorAll('a[href]')).slice(0, 300).map((a) => ({
    href: a.href,
    text: (a.innerText || '').trim().slice(0, 80),
  })),
  images: Array.from(document.images).slice(0, 300).map((i) => ({
    src: i.currentSrc || i.src || '',
    alt: i.alt || '',
    complete: i.complete,
    naturalWidth: i.naturalWidth,
  })),
  forms: Array.from(document.forms).slice(0, 50).map((f) => ({
    action: f.action || '',
    method: (f.method || 'get').toLowerCase(),
    inputs: Array.from(f.querySelectorAll('input,select,textarea')).slice(0, 50).map((i) => ({
      name: i.name || i.id || '',
      type: i.type || i.tagName.toLowerCase(),
      required: !!i.required,
    })),
  })),
})`;

/**
 * 事实文件路径：eval 的结果显式落盘到报告目录（不回灌上下文）。
 * 命名沿用「session-序号-随机码」的构造即唯一约定。
 */
export function factsPath(cwd, session = 'explore') {
  const dir = path.join(cwd, ARTIFACT_DIRS.reports);
  fs.mkdirSync(dir, { recursive: true });
  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return path.join(dir, `facts-${safeSession(session)}-${uniq}.json`);
}

/** 判断对象是不是「页面事实」本体（而不是 CLI 信封之类）。 */
function looksLikeFacts(obj) {
  return !!obj && typeof obj === 'object' && ('links' in obj || 'images' in obj || 'url' in obj);
}

/**
 * 解析 eval 落盘的结果。三种形态都见过，都得认：
 *   1) 裸 JSON 事实对象；
 *   2) 「JSON 字符串的 JSON」（eval 返回字符串时外层带引号/转义）；
 *   3) CLI --json 信封（{result: ...}）或裹了杂讯的文本 —— 解包/截取后继续认。
 * 认不出就返回 null（宁可报「采集失败」，也不把信封当事实返回 —— 后者会让
 * 坏图/死链判定在空数组上「通过」，是最典型的静默假结果）。
 */
export function parseFactsFile(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  const tryOne = (input, depth = 0) => {
    if (depth > 3) return null;
    let obj = input;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch {
        const i = obj.indexOf('{');
        const j = obj.lastIndexOf('}');
        if (i < 0 || j <= i) return null;
        try { obj = JSON.parse(obj.slice(i, j + 1)); } catch { return null; }
      }
      // 解析出来还是字符串（双层编码）→ 继续解包
      if (typeof obj === 'string') return tryOne(obj, depth + 1);
    }
    if (!obj || typeof obj !== 'object') return null;
    if (looksLikeFacts(obj)) return obj;
    // CLI 信封：{result: <事实或其字符串>}/{stdout: ...} —— 解包再认
    for (const key of ['result', 'stdout', 'content', 'data']) {
      if (obj[key] !== undefined) {
        const inner = tryOne(obj[key], depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  };

  return tryOne(t);
}

/**
 * 图片判定：加载完成但宽度为 0 = 坏图（broken）。
 * 还没加载完（complete=false）不算坏图 —— 拿加载中的状态当坏图是假警报。
 */
export function judgeImages(images = []) {
  const broken = [];
  let skipped = 0;
  for (const img of images) {
    if (!img || !img.src) { skipped++; continue; }
    if (img.complete === true && Number(img.naturalWidth) === 0) {
      broken.push({ src: img.src, alt: img.alt || '' });
    }
  }
  return { total: images.length, broken, skipped };
}

/** 链接分类：只探 http/https，其余（mailto/javascript/data/锚点）跳过并计数。 */
export function classifyLinks(links = [], { max = 20, skipHosts = [] } = {}) {
  const probe = [];
  const skipped = [];
  const seen = new Set();
  for (const l of links) {
    const href = String(l?.href || '').trim();
    if (!href) { skipped.push({ href, why: '空 href' }); continue; }
    if (!/^https?:\/\//i.test(href)) { skipped.push({ href, why: '非 http(s)' }); continue; }
    if (seen.has(href)) continue;
    seen.add(href);
    if (skipHosts.some((h) => href.includes(h))) { skipped.push({ href, why: '命中跳过名单' }); continue; }
    if (probe.length >= max) { skipped.push({ href, why: `超出抽样上限 ${max}` }); continue; }
    probe.push({ href, text: String(l?.text || '').slice(0, 80) });
  }
  return { probe, skipped, total: links.length };
}

/**
 * 探活（HEAD，405/501 回落 GET 一次）。判定口径见文件头注释：
 * HTTP ≥400 是死链；网络层失败是「不可达」，只警告。
 *
 * 总预算（budgetMs > 0 才启用）：单探测超时只兜单条，慢死主机会把并发批次串成
 * 整分钟级的静默等待（实测 50 条上限 × 4 并发 × 5s ≈ 65s，调用方全程无反馈）。
 * 预算兜的是**整个探测阶段**：在飞的探测把超时帽到剩余预算，排队中的不再发起 ——
 * 但也不静默消失，逐条记 unreachable + budgetExhausted，报告可见（诚实 partial）。
 */
export async function probeLinks(links, { fetchImpl, timeoutMs = 5000, concurrency = 4, budgetMs = 0 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const out = [];
  const queue = [...links];
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;
  async function one(link, capMs) {
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), capMs);
    try {
      let res = await doFetch(link.href, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
      if (res.status === 405 || res.status === 501) {
        res = await doFetch(link.href, { method: 'GET', redirect: 'follow', signal: ctl.signal });
      }
      out.push({
        ...link,
        status: res.status,
        ok: res.status < 400,
        kind: res.status < 400 ? 'ok' : 'dead',
        latencyMs: Date.now() - started,
      });
    } catch (e) {
      out.push({
        ...link,
        status: 0,
        ok: false,
        kind: 'unreachable',
        detail: String(e?.message || e).slice(0, 120),
        latencyMs: Date.now() - started,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) {
      const link = queue.shift();
      if (deadline && Date.now() >= deadline) {
        out.push({
          ...link,
          status: 0,
          ok: false,
          kind: 'unreachable',
          detail: `探测总预算 ${budgetMs}ms 耗尽，未发起探测`,
          budgetExhausted: true,
          latencyMs: 0,
        });
        continue;
      }
      const cap = deadline ? Math.max(1, Math.min(timeoutMs, deadline - Date.now())) : timeoutMs;
      await one(link, cap);
    }
  });
  await Promise.all(workers);
  // 保持输入顺序，报告稳定可比
  out.sort((a, b) => links.findIndex((l) => l.href === a.href) - links.findIndex((l) => l.href === b.href));
  return out;
}

/**
 * 巡检总判定：
 *   Fail —— 有死链（HTTP ≥400）或坏图；
 *   Pass —— 无上述问题（不可达与跳过项只进 warnings）。
 */
export function judgeExplore({ images, linkResults, consoleErrors = [] }) {
  const issues = [];
  const warnings = [];
  for (const b of images?.broken || []) issues.push({ kind: 'broken-image', ...b });
  for (const l of linkResults || []) {
    if (l.kind === 'dead') issues.push({ kind: 'dead-link', href: l.href, status: l.status, text: l.text });
    if (l.kind === 'unreachable') warnings.push({ kind: 'link-unreachable', href: l.href, detail: l.detail });
  }
  for (const c of consoleErrors) warnings.push({ kind: 'console-error', detail: String(c).slice(0, 200) });
  return { verdict: issues.length ? 'Fail' : 'Pass', issues, warnings };
}

/** 从 CLI console 命令的落盘/输出文本里抽取 error 级条目（尽力而为）。 */
export function parseConsoleErrors(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/\b(error|failed|uncaught)\b/i.test(line)) out.push(line.trim());
  }
  return out.slice(0, 20);
}

/**
 * 单表单稳定指纹（v1.8.12 表单指纹）：字段按 name|type|required 排序后进哈希 ——
 * 字段顺序重排**不算漂移**（序变在两期对比里是噪声）；增删字段、改类型、必填位翻转、
 * action/method 变化才是真信号。16 位十六进制足够当指纹用（同页冲突概率可忽略）。
 */
export function formHash(form) {
  const fields = (form?.inputs || [])
    .map((i) => `${i?.name || ''}|${i?.type || ''}|${i?.required ? 1 : 0}`)
    .sort()
    .join('\n');
  return createHash('sha256')
    .update(`${(form?.method || 'get').toLowerCase()}\n${form?.action || ''}\n${fields}`)
    .digest('hex')
    .slice(0, 16);
}

/** 整页表单指纹：逐表单哈希按页面顺序串联 —— 一数回答「表单变没变」。 */
export function formsSummary(forms = []) {
  const hashes = (forms || []).map((f) => formHash(f));
  return {
    count: hashes.length,
    formsHash: createHash('sha256').update(hashes.join('\n')).digest('hex').slice(0, 16),
  };
}

/**
 * 两期表单对比（explore_page diffAgainst）：表单按（method+action+同类序号）配对、
 * 字段按 name 配对。检出三类：字段新增/删除、必填位变化（required 布尔翻转）、表单级增删。
 * 字段顺序变化不算变更（与 formHash 同一口径）；表单重排（同 action 多表单换位）按变更计 ——
 * 页面结构变化本身就是漂移。判定是对比不是质检：有变更不改 verdict（可能是有意改版）。
 * 明细各类截前 20 条 + *Total 诚实计数 —— 对比结果回灌上下文，也要有界。
 */
export function diffForms(prevForms = [], currForms = []) {
  const CAP = 20;
  const idOf = (f) => `${(f?.method || 'get').toLowerCase()} ${f?.action || ''}`;
  const withOcc = (forms) => {
    const seen = new Map();
    return (forms || []).map((f) => {
      const id = idOf(f);
      const occ = seen.get(id) || 0;
      seen.set(id, occ + 1);
      return { f, key: `${id}#${occ}`, id, occ };
    });
  };
  const prev = withOcc(prevForms);
  const curr = withOcc(currForms);
  const prevByKey = new Map(prev.map((e) => [e.key, e]));
  const currByKey = new Map(curr.map((e) => [e.key, e]));
  const formRef = (e) => ({ method: e.id.split(' ')[0], action: e.id.slice(e.id.indexOf(' ') + 1), occurrence: e.occ });

  // 明细各截前 CAP 条，*Total 独立计数 —— total 取截后数组长度是「静默少计数」
  // （钉抓过：25 条新增会报成 20/20），诚实口径两者必须分开。
  const formsAdded = [];
  const formsRemoved = [];
  const fieldsAdded = [];
  const fieldsRemoved = [];
  const requiredChanged = [];
  let formsAddedTotal = 0;
  let formsRemovedTotal = 0;
  let fieldsAddedTotal = 0;
  let fieldsRemovedTotal = 0;
  let requiredChangedTotal = 0;
  for (const e of curr) {
    const p = prevByKey.get(e.key);
    if (!p) {
      formsAddedTotal++;
      if (formsAdded.length < CAP) formsAdded.push(formRef(e));
      continue;
    }
    const pFields = new Map((p.f?.inputs || []).map((i) => [i?.name || '', i]));
    for (const i of e.f?.inputs || []) {
      const name = i?.name || '';
      const pi = pFields.get(name);
      if (!pi) {
        fieldsAddedTotal++;
        if (fieldsAdded.length < CAP) fieldsAdded.push({ form: e.id, name, type: i?.type || '', required: !!i?.required });
        continue;
      }
      if (!!pi?.required !== !!i?.required) {
        requiredChangedTotal++;
        if (requiredChanged.length < CAP) requiredChanged.push({ form: e.id, name, from: !!pi?.required, to: !!i?.required });
      }
    }
  }
  for (const e of prev.values()) {
    if (!currByKey.has(e.key)) {
      formsRemovedTotal++;
      if (formsRemoved.length < CAP) formsRemoved.push(formRef(e));
      continue;
    }
    const cFields = new Map((currByKey.get(e.key).f?.inputs || []).map((i) => [i?.name || '', i]));
    for (const i of e.f?.inputs || []) {
      const name = i?.name || '';
      if (!cFields.has(name)) {
        fieldsRemovedTotal++;
        if (fieldsRemoved.length < CAP) fieldsRemoved.push({ form: e.id, name, type: i?.type || '', required: !!i?.required });
      }
    }
  }
  return {
    changed: formsAddedTotal + formsRemovedTotal + fieldsAddedTotal + fieldsRemovedTotal + requiredChangedTotal > 0,
    formsAdded,
    formsRemoved,
    fieldsAdded,
    fieldsRemoved,
    requiredChanged,
    formsAddedTotal,
    formsRemovedTotal,
    fieldsAddedTotal,
    fieldsRemovedTotal,
    requiredChangedTotal,
  };
}

/** 读 eval 落盘件并解析（统一入口，含缺失容错）。 */
export function readFacts(file) {
  if (!file || !fs.existsSync(file)) return null;
  try { return parseFactsFile(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export default {
  FACTS_EVAL_FN, parseFactsFile, judgeImages, classifyLinks, probeLinks,
  judgeExplore, parseConsoleErrors, readFacts, formHash, formsSummary, diffForms,
};
