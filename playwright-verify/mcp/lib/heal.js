/**
 * heal.js — 元素自愈定位（动作步的选择器修复；断言绝不进这道门）
 *
 * 来源（两篇文章合并中的「文章一」差异化能力）：
 *   选择器失效 → 失败现场（快照+截图+日志）→ 找替代定位 → 重试。
 *   文章的口径有一条硬边界，本模块原样继承：
 *   **自愈只解决「定位」问题，不改变断言逻辑** —— expect_* 失败永远是失败，
 *   宁可红着交回人判，也不做「换个元素让断言过」这种放宽（全局红线「不自动放宽断言」）。
 *
 * 与真实 API 的对齐（不臆造方言）：
 *   playwright-cli 的 `click/fill <target>` 吃「快照 ref 或唯一选择器」，
 *   所以自愈链不是编造 `role=button[name=...]` 选择器，而是：
 *     1) `snapshot` 拿最新可访问性树（落盘，不回灌上下文）；
 *     2) 在快照行里按「可见名称」找回语义匹配的节点 ref（文章的 role+text 启发式，
 *        在快照行上表现为 角色 + 引号名 的匹配与角色优先级）；
 *     3) 用 ref 重试同一个动作 —— 动作与参数不变，只修「怎么找到它」。
 *
 * 安全阀（宁漏不误报）：
 *   - 每步最多试 3 个候选、只跑一轮，不递归；
 *   - 候选名必须整词/整体包含检索词，杜绝「点了名字相近的另一个按钮」；
 *   - 找不到候选就维持原失败 —— 自愈失败要如实说，不能装作没发生过。
 */
import fs from 'node:fs';

import { runCli } from './cli.js';
import { llmChatJson } from './llmclient.js';

/** 可自愈的动作步。断言（expect_）在名单外 —— 这是边界，不是疏漏。 */
export const HEALABLE_ACTS = new Set(['click', 'fill']);

/** 动作 → 快照行里可接受的角色前缀（role+text 启发式的角色半边）。 */
const ACTION_ROLES = {
  click: ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox'],
  fill: ['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'],
};

/** 单步自愈的候选上限：够覆盖「改名后的同类元素」，又不至于变成乱点。 */
export const MAX_HEAL_CANDIDATES = 3;

/** 整次运行的自愈 LLM 调用预算：默认 2（事件驱动也得有总闸），硬上限 10。 */
export const DEFAULT_HEAL_LLM_BUDGET = 2;
export const HEAL_LLM_BUDGET_MAX = 10;

/**
 * 自愈第二层（LLM 挑选）的调用预算。一次运行一个实例，所有自愈尝试共享。
 * 为什么需要总闸：单步最多烧 1 次调用，但自愈成功后执行继续，
 * 10 步计划就能烧 10 次 LLM —— 事件驱动不等于不设防，成本要有上限。
 * 预算耗尽后**不再问 LLM**，如实以 HEAL_LLM_BUDGET_EXHAUSTED 失败（不静默降级）。
 * limit=0 即「只用确定性快照自愈」。
 */
export function createHealLlmBudget(limit = DEFAULT_HEAL_LLM_BUDGET) {
  const n = Number(limit);
  if (!Number.isFinite(n)) throw new TypeError(`healLlmBudget 应为数字，收到 ${JSON.stringify(limit)}`);
  const cap = Math.min(HEAL_LLM_BUDGET_MAX, Math.max(0, Math.trunc(n)));
  let used = 0;
  return {
    limit: cap,
    get used() { return used; },
    get remaining() { return Math.max(0, cap - used); },
    /** 预留一次调用名额；false=预算已尽（调用方必须放弃本次 LLM 调用）。 */
    take() { if (used >= cap) return false; used += 1; return true; },
  };
}

/**
 * 从原始 target 提取快照检索词。
 *   纯文本/中文按钮名 → 原样（自愈的主力场景：计划给的是语义名）；
 *   #id / .class / [data-testid="x"] / text=x / role=...[name="x"] → 取语义片段；
 *   只剩 [type=submit] 这类无名属性 → 返回 null（没有可检索的语义，不硬凑）。
 */
export function needleFromTarget(target) {
  const t = String(target || '').trim();
  if (!t) return null;

  // text=提交 / role=button[name="提交"] / getByText('提交') 这类显式语义
  const named = /(?:name|text|label|placeholder|aria-label)\s*[=:]\s*["']?([^"'\]]{2,60})["']?/i.exec(t);
  if (named) return named[1].trim();

  // CSS #id / .class / [data-testid="x"] / [data-test="x"]。
  // 标识符允许中文（\w 不含 CJK，实测 #提交订单 会提不出语义词 → 自愈整个放弃）；
  // 排除组合器/伪类字符，#a>b 这类复合选择器不当成单个 id。
  const attr = /\[\s*(?:data-testid|data-test|data-cy|id|name|aria-label)\s*=\s*["']?([^"'\]]+)["']?\s*\]/i.exec(t);
  if (attr) return attr[1].trim();
  if (/^#[^\s#.:[\]()"',><=+~*|^$]+$/.test(t) || /^\.[^\s#.:[\]()"',><=+~*|^$]+$/.test(t)) return t.slice(1);

  // 纯文本（含中文、含空格的可见名）
  if (!/[[\]#.:>=()[\]"']/.test(t)) return t;

  // 其它选择器形态：取出最后一段 kebab/snake 语义词（加购按钮 → add-to-cart-btn → add-to-cart-btn）
  const seg = /([\w-]{3,})\s*$/.exec(t);
  return seg ? seg[1] : null;
}

/**
 * 检索词的宽松变体：`add-to-cart-btn` → ['add-to-cart-btn', 'add cart']。
 * 快照里的可见名与旧选择器的字面量经常只共享词干，值得多试一种写法；
 * 变体也保持「整词包含」判定，不放宽成模糊相似度。
 */
export function needleVariants(needle) {
  const out = [needle];
  const spaced = String(needle).replace(/[-_]+/g, ' ').trim();
  if (spaced && spaced !== needle) out.push(spaced);
  return out;
}

/** 快照行是否「整词」包含检索词（中文按子串，ASCII 按词边界防 add 匹配 address）。 */
function lineMatches(line, needle) {
  const lower = line.toLowerCase();
  const n = String(needle).toLowerCase();
  if (!n) return false;
  if (lower.includes(n)) {
    if (/^[\x00-\x7f]+$/.test(n)) {
      const before = lower.split(n)[0];
      const after = lower.slice((before + n).length);
      const okBefore = !/[a-z0-9]$/.test(before);
      const okAfter = !/^[a-z0-9]/.test(after);
      return okBefore && okAfter;
    }
    return true;
  }
  return false;
}

/** 从快照行提取 ref（真实格式探针定型：[ref=e12] 与 ref=e12 两种都认）。 */
export function refFromLine(line) {
  const m = /\[ref=([^\]\s]+)\]/.exec(line) || /\bref=([A-Za-z0-9_.:-]+)/.exec(line);
  return m ? m[1] : null;
}

/**
 * 在快照文本里找自愈候选。返回 [{ref, role, name, line}]，去重、保序、封顶。
 * 角色优先：与动作匹配的角色排前（role 半边），同角色内按出现顺序。
 */
export function healCandidates(snapshotText, needle, { act = 'click', max = MAX_HEAL_CANDIDATES } = {}) {
  const text = String(snapshotText || '');
  if (!needle) return [];
  const roles = ACTION_ROLES[act] || ACTION_ROLES.click;

  const hits = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!lineMatches(line, needle)) continue;
    const ref = refFromLine(line);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const roleM = /^\s*-?\s*([a-z]+)/i.exec(line.trim());
    const role = roleM ? roleM[1].toLowerCase() : '';
    hits.push({ ref, role, line: line.trim().slice(0, 160) });
  }

  hits.sort((a, b) => {
    const ai = roles.indexOf(a.role);
    const bi = roles.indexOf(b.role);
    return (ai < 0 ? roles.length : ai) - (bi < 0 ? roles.length : bi);
  });
  return hits.slice(0, max);
}

/**
 * 「定位类失败」识别：只有这类失败值得自愈。
 * 真实失败文本以探针为准（timeout/断言类失败不自愈 —— 那不是定位问题）。
 * 探针实录（v1.8.0）：playwright-cli 对失效选择器的真实报错是
 * `Error: "#submit-btn" does not match any elements.` —— 第一版正则漏了这个句式，
 * 自愈根本不会启动（真实测试抓到的洞，已钉进 flow-check）。
 */
export function isLikelyLocatorFailure(detail) {
  const d = String(detail || '');
  return /(not found|not resolved|no element|unknown element|cannot find|unable to find|does not match any elements|matches no elements|no elements matching|strict mode violation|resolved to \d+ elements|waiting for locator|element is not (visible|enabled|editable)|timeout\s*\d+ms exceeded)/i.test(d);
}

/**
 * 从快照文本提取「可交互元素清单」：[{ref, role, name}]，封顶 40 条。
 * 用途是自愈第二层（LLM 挑选）的候选枚举 —— 只给 ref/角色/可见名，
 * 不把整棵快照灌进模型（上下文纪律）。
 */
export function parseSnapshotInventory(snapshotText, cap = 40) {
  const out = [];
  const seen = new Set();
  for (const line of String(snapshotText || '').split(/\r?\n/)) {
    const ref = refFromLine(line);
    if (!ref || seen.has(ref)) continue;
    const m = /^\s*-?\s*([a-z]+)\s+"([^"]*)"/i.exec(line.trim());
    if (!m) continue;
    seen.add(ref);
    out.push({ ref, role: m[1].toLowerCase(), name: m[2].slice(0, 80) });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 自愈第二层的提示词（文章一的原话口径：「我原本想点击 X，但选择器失效了，
 * 这是当前页面的可交互元素列表，帮我找一个最可能的替代」）。
 * 输出契约收得极紧：**只允许从给定 ref 列表里挑一个**，挑不出就 null ——
 * 模型做的是「选择题」不是「填空题」，它造不出列表外的 ref，
 * 而动作执行与断言判定仍然走确定性链路（模型编造不了「通过」）。
 */
export function buildHealMessages({ act, target, value, needle, elements }) {
  const system = [
    '你是测试脚本的定位修复器。原定位器失效了，你要从给定的页面元素清单里挑出最可能的替代项。',
    '纪律：只能挑清单里存在的 ref；没把握就回 {"ref":null}，绝不猜清单外的值；',
    '只输出一个 JSON 对象：{"ref":"eN"} 或 {"ref":null}，不要任何解释。',
  ].join('\n');
  const user = [
    `原动作：${act}${value !== undefined ? `（填值 ${JSON.stringify(String(value)).slice(0, 60)}）` : ''}`,
    `原目标：${target}${needle ? `（语义线索：${needle}）` : ''}`,
    '页面可交互元素清单：',
    ...elements.map((e, i) => `  ${i + 1}. ref=${e.ref} role=${e.role} name=${JSON.stringify(e.name)}`),
    '',
    '输出契约（JSON）：{"ref":"eN"} 或 {"ref":null}',
  ].join('\n');
  return { system, user };
}

/** 校验 LLM 的挑选：必须是清单里存在的 ref，否则一律当没挑出（宁漏不误点）。 */
export function parseHealPick(json, allowedRefs = []) {
  const ref = json && typeof json === 'object' ? json.ref : null;
  if (typeof ref !== 'string' || !ref) return null;
  return allowedRefs.includes(ref) ? ref : null;
}

/**
 * 按可见名称在最新快照里找 ref（自愈与翻页采集共用的定位原语）。
 * 返回 {ok, ref, candidates, snapFile} | {ok:false, why, snapFile?}。
 */
export async function findRefByNeedle({ cwd, session, needle, act = 'click', headed = false, runCliImpl } = {}) {
  const call = runCliImpl || runCli;
  const snapRes = await call({ cwd, session, subcommand: 'snapshot', args: [], headed });
  const snapFile = snapRes.artifacts?.snapshot;
  const snapText = snapFile && fs.existsSync(snapFile) ? fs.readFileSync(snapFile, 'utf8') : '';
  if (!snapText) return { ok: false, why: 'NO_SNAPSHOT', detail: '快照未产出', evidence: snapRes.logFiles?.stdout };

  const candidates = [];
  for (const v of needleVariants(needle)) {
    for (const c of healCandidates(snapText, v, { act })) {
      if (!candidates.some((x) => x.ref === c.ref)) candidates.push(c);
    }
    if (candidates.length >= MAX_HEAL_CANDIDATES) break;
  }
  if (!candidates.length) {
    return {
      ok: false, why: 'NO_CANDIDATE', snapFile,
      detail: `快照里找不到名字含「${needle}」的元素（不猜、不点相近名）`,
    };
  }
  return { ok: true, ref: candidates[0].ref, candidates, snapFile };
}

/**
 * 自愈一次动作步（集成层）：失败现场三件套 → 快照找 ref → 逐候选重试同一动作。
 * 返回 {ok, via, healedFrom, tried, evidence, detail}；不改动 step 本身。
 * llmBudget：整次运行共享的二级自愈调用预算（createHealLlmBudget 实例）；
 *   缺省=本步一次机会（与旧行为一致）。预算尽时**不问 LLM**，如实失败。
 * llmImpl：LLM 调用注入点（测试用；缺省 llmChatJson）。
 */
export async function tryHealStep({ step, cwd, session, headed = false, runCliImpl, llmBudget, llmImpl } = {}) {
  const act = step.act;
  if (!HEALABLE_ACTS.has(act)) {
    return { ok: false, why: 'ACT_NOT_HEALABLE', detail: `${act} 不在自愈范围（断言与非定位动作不自愈）` };
  }
  const needle = needleFromTarget(step.target);
  if (!needle) {
    return { ok: false, why: 'NO_NEEDLE', detail: '目标里提不出可检索的语义词，放弃自愈（宁可失败也不猜元素）' };
  }
  const call = runCliImpl || runCli;
  const chat = llmImpl || llmChatJson;
  const budget = llmBudget || createHealLlmBudget(1);

  // 失败现场三件套之二：截图（日志已由 runToFiles 落盘；快照在下一步）
  await call({ cwd, session, subcommand: 'screenshot', args: [], headed });

  const found = await findRefByNeedle({ cwd, session, needle, act, headed, runCliImpl });
  let candidates = [];
  let snapFile;
  let via = 'snapshot-ref';
  if (found.ok) {
    candidates = found.candidates;
    snapFile = found.snapFile;
  } else {
    // 第二层（文章一的 LLM 智能分析）：确定性按名找不到时，让 LLM 从**枚举清单**里挑一个 ref。
    // 事件驱动：只有失败且第一层落空才烧这一次调用；LLM 不可用就如实维持原失败。
    // 预算闸门在调用**之前**：烧调用要先拿名额，拿不到就直接如实失败，一次都不打。
    if (!budget.take()) {
      return {
        ok: false, why: 'HEAL_LLM_BUDGET_EXHAUSTED', tried: [],
        detail: `本次运行的自愈 LLM 预算已用尽（上限 ${budget.limit}），不再询问 LLM，维持原失败`,
        evidence: found.snapFile || found.evidence,
      };
    }
    snapFile = found.snapFile || found.evidence;
    const snapText = snapFile && fs.existsSync(snapFile) ? fs.readFileSync(snapFile, 'utf8') : '';
    const inventory = parseSnapshotInventory(snapText);
    if (!inventory.length) {
      return {
        ok: false, why: found.why, tried: [],
        detail: `${found.detail}，维持原失败`,
        evidence: snapFile,
      };
    }
    const msgs = buildHealMessages({ act, target: step.target, value: step.value, needle, elements: inventory });
    const llmRes = await chat(msgs);
    const picked = llmRes.ok ? parseHealPick(llmRes.json, inventory.map((e) => e.ref)) : null;
    if (!picked) {
      return {
        ok: false, why: 'NO_CANDIDATE', tried: [],
        detail: `${found.detail}；LLM 也没挑出可靠替代（${llmRes.ok ? '未选中清单内 ref' : (llmRes.why || llmRes.reason)}），维持原失败`,
        evidence: snapFile,
      };
    }
    const hit = inventory.find((e) => e.ref === picked);
    candidates = [{ ref: hit.ref, role: hit.role, line: `${hit.role} "${hit.name}" [ref=${hit.ref}]` }];
    via = 'llm-pick';
  }
  if (!candidates.length) {
    return {
      ok: false, why: 'NO_CANDIDATE', tried: [],
      detail: `快照里找不到名字含「${needle}」的可${act === 'fill' ? '填写' : '点击'}元素（自愈未找到候选，维持原失败）`,
      evidence: snapFile,
    };
  }

  const tried = [];
  for (const c of candidates) {
    const args = act === 'fill' ? [c.ref, step.value] : [c.ref];
    const r = await call({ cwd, session, subcommand: act, args, headed });
    tried.push({ ref: c.ref, ok: r.ok, role: c.role });
    if (r.ok) {
      return {
        ok: true, via: `${via} ${c.ref}`, healedFrom: step.target, healedTo: c.ref,
        tried, evidence: snapFile,
        detail: `原定位器失效，已按可见名称「${needle}」自愈到 ${c.role || '元素'}(ref=${c.ref}) 并重试成功（${via}）`,
      };
    }
  }
  return {
    ok: false, why: 'ALL_CANDIDATES_FAILED', tried,
    detail: `自愈试了 ${tried.length} 个候选（${tried.map((t) => t.ref).join(', ')}）都没成功，维持原失败`,
    evidence: snapFile,
  };
}

export default {
  HEALABLE_ACTS, MAX_HEAL_CANDIDATES, DEFAULT_HEAL_LLM_BUDGET, HEAL_LLM_BUDGET_MAX,
  createHealLlmBudget, needleFromTarget, needleVariants, refFromLine,
  healCandidates, isLikelyLocatorFailure, parseSnapshotInventory, buildHealMessages,
  parseHealPick, findRefByNeedle, tryHealStep,
};
