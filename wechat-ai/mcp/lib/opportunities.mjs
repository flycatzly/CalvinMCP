// 商机持久状态机：候选构造 / 去重合并 / 人工反馈 / 人工分流
// 对应上游 opportunity_store.py + wechat_intelligence_hub.py 的 build_opportunity_candidates，
// 复用 store() 的 opportunities / opportunity_events / feedback 三张表（缺少的列按需增量迁移，不改 store.mjs）。
import crypto from "node:crypto";
import { store, tx, pj } from "./store.mjs";
import { isOwnerName, loadProfile } from "./profile.mjs";
import { classifyChat } from "./signals.mjs";
import { clamp, extractUrls, fmtDay, fmtLocal, messageLinks, truncate, uniq } from "./util.mjs";

// ---------------- 枚举与中文标签 ----------------
export const OPEN_STATUSES = ["new", "active", "waiting", "paused"];
export const CLOSED_STATUSES = ["won", "lost"];
export const INACTIVE_STATUSES = ["ignored", "stale", "archived"];
export const ALL_STATUSES = [...OPEN_STATUSES, ...CLOSED_STATUSES, ...INACTIVE_STATUSES];
export const RECORD_TYPES = ["candidate", "opportunity"];
export const CONFIDENCE_LEVELS = ["low", "medium", "high", "confirmed"];
export const FEEDBACK_VERDICTS = ["confirmed", "false_positive", "ignore", "low_priority"];
export const TRIAGE_DECISIONS = {
  pursue: "active",
  wait: "waiting",
  pause: "paused",
  ignore: "ignored",
  won: "won",
  lost: "lost",
};
export const STAGE_ORDER = [
  "新线索",
  "待回复",
  "待报价",
  "待 brief",
  "待确认报价/排期",
  "待创作",
  "待品牌审核",
  "待发布",
  "已发布待结算",
  "已发布待数据跟进",
  "已收款",
];

export const STATUS_LABELS = {
  new: "新发现",
  active: "推进中",
  waiting: "等待对方",
  paused: "暂缓",
  won: "已成交",
  lost: "未成交",
  ignored: "已忽略",
  stale: "已过期",
  archived: "已归档",
};
export const RECORD_LABELS = { candidate: "待审核候选", opportunity: "正式机会" };
export const CONFIDENCE_LABELS = { low: "低置信", medium: "待核实", high: "高置信", confirmed: "人工确认" };

/** 各阶段的默认下一步动作 */
export const STAGE_NEXT_ACTIONS = {
  新线索: "判断是否值得接，补问预算/目标/平台",
  待回复: "尽快回复，避免线索冷掉",
  待报价: "发报价和可选档位",
  "待 brief": "催 brief、素材、发布时间和审核要求",
  "待确认报价/排期": "确认价格、排期、交付形式和结算方式",
  待创作: "整理 brief，进入初稿",
  待品牌审核: "跟进修改反馈或确认过稿",
  待发布: "确认发布时间和发布素材",
  已发布待结算: "跟进数据回传、发票/收款",
  已发布待数据跟进: "落实补量、Quote/KOL 转发，并在统计截止前回传新增数据",
  已收款: "归档复盘，保温复购",
};

export function inferNextAction(stage) {
  return STAGE_NEXT_ACTIONS[String(stage)] || "人工检查";
}

export function stageRank(stage) {
  const i = STAGE_ORDER.indexOf(String(stage));
  return i < 0 ? 0 : i;
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2, confirmed: 3 };

// ---------------- 词表（参照上游正则；正则不带 g，避免 lastIndex 污染） ----------------
export const EXPLICIT_NON_DEAL_TERMS = /非商单|不是商单|并非商单|纯分享|非推广|无商业合作/i;
export const PAID_BOOST_TERMS = /红包|加热|#?接龙|三连|四连|3连|4连|quote|引用|截图.{0,8}(?:结算|发群|丢群)|统一结算|名额|(?:\d+(?:\.\d+)?)\s*(?:元|rmb)/i;
export const DEAL_OPPORTUNITY_TERMS = /商单|品牌方|投放|推广|广告|赞助|campaign|sponsor|KOL|达人|博主|谁想接|有人想接|想接|可接|接单|招募.{0,12}(?:KOL|达人|博主)|(?:推荐|求推荐).{0,12}(?:KOL|达人|博主)|名额|brief|返佣|佣金|CPS|CPA|红包|加热|接龙|三连|四连/i;
export const TRAINING_PROJECT_TERMS = /企业培训|线上培训|线下培训|AI\s*培训|培训项目|想搞.{0,8}培训|工作坊|讲师|授课|课时|课程体系|成套.{0,6}(?:课程|线上课)|咨询项目|顾问项目|FDE|外包项目|项目合作|合作项目|(?:谁|有没有人|有人).{0,12}(?:接|做).{0,8}(?:项目|培训|咨询|工作坊)/i;
export const DIRECT_DEAL_TERMS = /brief|报价|预算|排期|审核|修改|发布|结算|付款|invoice|payment|campaign|sponsor|商单|合作|推广|投放/i;
export const PIPELINE_CONTEXT_TERMS = /合作|商单|推广|投放|品牌方|项目方|报价|预算|brief|排期|发布时间|初稿|审核|修改|发布|结算|付款|打款|收款|invoice|payment|培训|工作坊|讲师|授课|咨询项目|项目合作|浏览量|曝光|KOL|博主转发|达人转发|补量|加热|数据统计|数据回传|回传数据/i;
export const GROUP_ACTIONABLE_DEAL_TERMS = /商单|谁想接|有人想接|想接|可接|接单|招募|名额|brief|返佣|佣金|CPS|CPA|(?:品牌方|项目方).{0,16}(?:招|找|需要|合作|投放|预算|名额|发)|(?:招|找|需要|合作|投放|预算|名额).{0,16}(?:品牌方|项目方)|(?:合作|campaign|sponsor).{0,16}(?:机会|招募|预算|报价|名额|报名|找人|博主|达人)|(?:有|给|确认|需要|可谈).{0,10}(?:预算|报价)|找.{0,10}(?:KOL|达人|博主)|想找.{0,12}(?:发|推|合作)/i;
export const GROUP_ACTIONABLE_TRAINING_TERMS = /(?:有没有|谁|需要|招募?|找|寻找?|推荐|想搞|准备|计划|有个|有一场|接).{0,20}(?:培训|讲师|课程|工作坊|项目|教练)|(?:培训|讲师|课程|工作坊|项目|教练).{0,20}(?:招募?|需要|找|寻找?|合作|报名|预算|报价|课时|授课|推荐|机会|需求)/i;
export const DISCUSSION_DEADLINE_TERMS = /(?:今天|今晚|明天|本周|周[1-7一二三四五六日天]).{0,10}(?:前|内|截止|截稿|发布|报名|交付|确认|安排|排期)|截止|截稿|截至|最晚|排期|发布时间/i;
export const BUDGET_TERMS = /预算|报价|稿费|佣金|保底|课时费|授课费/i;
export const PROJECT_CHAT_NAME_TERMS = /未结|初稿|终稿|对接群|交付群|合作群|项目群/i;
export const GROUP_RECAP_TERMS = /^\s*(?:#{1,6}\s*)?(?:(?:\d{4}|\d{1,2}[./月-]\d{1,2}日?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s*)?(?:(?:[\w·&+.-]{0,16})(?:微信群聊日报|群聊日报|群日报|群聊总结)|(?:今日|昨日|本日|当天|每日).{0,6}(?:日报|总结|回顾)|daily\s*(?:brief|digest|recap))(?:\s|[:：|｜\-—]|$)/i;

// 金额口径：只认带币种/单位或货币符号的数字，避免把“2 天课程”当成预算
const AMOUNT_PATTERN = /(?:[$￥¥]\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:USD|AUD|RMB|CNY|美元|澳币|人民币|刀|元))?|\d[\d,]*(?:\.\d+)?(?:\s*[-~到至]\s*\d[\d,]*(?:\.\d+)?)?\s*(?:USD|AUD|RMB|CNY|美元|澳币|人民币|刀|元|万|块|k|K))/g;

/** 金额清洗：去重、去空白、必须含数字（对应上游 clean_amounts） */
export function cleanAmounts(values) {
  const out = [];
  for (const raw of values || []) {
    const value = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    if (!value || !/\d/.test(value) || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/** 从文本抽取金额（上游 AMOUNT_PATTERN 口径） */
export function extractAmountsLoose(text) {
  return cleanAmounts(String(text == null ? "" : text).match(AMOUNT_PATTERN) || []);
}

export function isDealOpportunity(message) {
  const text = String((message && message.content) || "");
  if (EXPLICIT_NON_DEAL_TERMS.test(text)) return false;
  if (DEAL_OPPORTUNITY_TERMS.test(text) || PAID_BOOST_TERMS.test(text)) return true;
  return Boolean(extractAmountsLoose(text).length && DIRECT_DEAL_TERMS.test(text));
}
/** 上游同名函数别名（保持口径一致） */
export const is_deal_opportunity = isDealOpportunity;

export function isTrainingProjectOpportunity(message) {
  return TRAINING_PROJECT_TERMS.test(String((message && message.content) || ""));
}
export const is_training_project_opportunity = isTrainingProjectOpportunity;

export function isNoiseEvidence(content) {
  const text = String(content == null ? "" : content);
  return (
    text.includes("SystemMessages_HongbaoIcon") ||
    text.includes("领取了你的") ||
    text.includes("领取了红包") ||
    text.startsWith("收到转账") ||
    text.startsWith("恭喜发财，大吉大利")
  );
}

function isGroupRecapMessage(message) {
  return GROUP_RECAP_TERMS.test(String(message.content || "").trim());
}

/** 证据去重键（对应上游 evidence_dedupe_key） */
export function evidenceDedupeKey(content) {
  const text = String(content == null ? "" : content);
  const urls = extractUrls(text);
  if (urls.length) return "url:" + urls.slice().sort().join("|");
  let cleaned = text.replace(/https?:\/\/\S+/g, "");
  cleaned = cleaned.replace(/#?接龙/g, "");
  cleaned = cleaned.replace(/\b\d+[.、)]/g, "");
  cleaned = cleaned.replace(/[\u2460-\u2473]/g, "");
  cleaned = cleaned.replace(/\s+/g, "");
  cleaned = cleaned.replace(/[，。！？、；：,.!?:;|｜\-—_#*（）()\[\]【】"'“”‘’]/g, "");
  return "text:" + cleaned.slice(0, 120);
}

function escapeRegExp(text) {
  return String(text).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}
function sha256Short(s, len) {
  return sha256(s).slice(0, len);
}

// ---------------- 消息规范化 ----------------
function normMessage(m) {
  const chat = String((m && (m.session_name || m.chat)) || "未知会话").trim() || "未知会话";
  const kind = String((m && (m.session_kind || (m.is_group ? "group" : ""))) || "") || classifyChat(chat);
  const content = String((m && m.content) || "");
  const links = messageLinks(m).map(String);
  return {
    id: (m && m.id) || null,
    chat,
    kind: kind === "group" ? "group" : "private",
    sender: String((m && m.sender) || ""),
    sender_id: (m && m.sender_id) || null,
    is_owner: Boolean(m && (m.is_owner || isOwnerName(m.sender))),
    ts: Number((m && m.ts) || 0),
    content,
    links,
    source: (m && m.source) || null,
  };
}

function isSystemSender(sender) {
  return String(sender || "").trim() === "系统";
}

// ---------------- 候选构造（对应上游 build_opportunity_candidates） ----------------
function projectCollaborationTerms() {
  const profile = loadProfile();
  return uniq([...(profile.project_chat_terms || []), ...(profile.owner_aliases || [])]).filter(Boolean);
}

/** 直接交付/合作群：有项目语境 + 人少 + 群名带交付词或直接点名本人 */
export function isProjectCollaborationGroup(chat, rows, selfNames) {
  const senders = new Set(rows.map((r) => String(r.sender || "").trim()).filter((s) => s && s !== "系统"));
  const hasPipelineContext = rows.some((r) => PIPELINE_CONTEXT_TERMS.test(r.content));
  const names = uniq([...projectCollaborationTerms(), ...(selfNames || [])]).filter(Boolean);
  const lowerChat = String(chat).toLowerCase();
  const namedForDelivery = names.some((n) => n && lowerChat.includes(String(n).toLowerCase()));
  const addressAliases = uniq([...(selfNames || []), ...(loadProfile().owner_aliases || [])])
    .map(String)
    .filter((a) => a && !["我", "me", "自己"].includes(a.toLowerCase()));
  const directlyAddressesOwner = rows.some((r) =>
    addressAliases.some((a) => new RegExp("(?:@\\s*)?" + escapeRegExp(a) + "\\s*(?:老师)?", "i").test(r.content)),
  );
  return Boolean(hasPipelineContext && senders.size <= 12 && (namedForDelivery || directlyAddressesOwner));
}

/** 私聊阶段推断（群来源恒为“新线索”，私聊才推断） */
export function inferStage(text) {
  const t = String(text == null ? "" : text);
  if (/已收款|款已到账|收到款|已到账|已经付款|已付款/.test(t)) return "已收款";
  if (/结算|付款|打款|尾款|账期|财务|invoice|发票/i.test(t)) return "已发布待结算";
  if (/(审核|修改|反馈|review)/i.test(t) && /(初稿|稿子|稿件|待审核|过稿)/.test(t)) return "待品牌审核";
  if (/已发布|已上线|发出去了|数据回传|回传数据/.test(t)) return "已发布待数据跟进";
  if (/初稿|二稿|终稿|创作|写稿|出片|草稿|改稿/.test(t)) return "待创作";
  if (/brief|需求|要求|素材|卖点|大纲/i.test(t)) return "待 brief";
  if (/报价|预算|价格|费用|多少钱|怎么收费|quote|rate/i.test(t)) return "待报价";
  if (/排期|档期|发布时间|什么时候|哪天/.test(t)) return "待确认报价/排期";
  if (/回复|确认一下|麻烦|请问|能否|可以吗/.test(t)) return "待回复";
  return "新线索";
}

/** 候选优先级（1-5）：群来源默认 4，私聊按需求强度上浮 */
export function candidatePriority(c) {
  const text = String((c && c.text) || "");
  const explicit = GROUP_ACTIONABLE_DEAL_TERMS.test(text) || GROUP_ACTIONABLE_TRAINING_TERMS.test(text);
  const budget = BUDGET_TERMS.test(text);
  const training = Boolean(c && (c.training === true || String(c.opportunity_type || "").includes("培训")));
  if (c && !c.group_source && c.stage && c.stage !== "新线索") return 5;
  if (explicit && budget) return 5;
  if (training && (explicit || budget)) return 5;
  if (explicit || budget) return 4;
  if (c && c.project_collaboration) return 4;
  if (c && c.group_source) return 4;
  return 3;
}

/** 晋级打分：+35 明确需求 / +20 预算报价 / +10 时间节点 / +30 跨群重复 / +30 交付群 / +35 私聊非新线索 / +15 培训需求，上限 100 */
export function qualificationScore(c) {
  return qualificationReasons(c).score;
}

/** 打分 + 中文依据（同步时写入 qualification_reasons） */
export function qualificationReasons(c) {
  const text = String((c && (c.text || c._text)) || "");
  const explicit = GROUP_ACTIONABLE_DEAL_TERMS.test(text) || GROUP_ACTIONABLE_TRAINING_TERMS.test(text);
  const hasBudget = BUDGET_TERMS.test(text);
  const hasDeadline = DISCUSSION_DEADLINE_TERMS.test(text);
  const sourceChats = (c && c.source_chats) || [];
  const groupSource = Boolean(c && c.group_source);
  const repeated = groupSource && sourceChats.length >= 2;
  const projectCollaboration = Boolean(c && c.project_collaboration);
  const stage = String((c && c.stage) || "新线索");
  const training = Boolean(c && (c.training || String(c.opportunity_type || "").includes("培训")));
  const reasons = [];
  let score = 0;
  if (explicit) { score += 35; reasons.push("明确招募或合作需求"); }
  if (hasBudget) { score += 20; reasons.push("包含预算或报价"); }
  if (hasDeadline) { score += 10; reasons.push("包含时间节点"); }
  if (repeated) { score += 30; reasons.push("跨群重复投放"); }
  if (projectCollaboration) { score += 30; reasons.push("直接交付或合作群"); }
  if (!groupSource && stage !== "新线索") { score += 35; reasons.push("私聊已进入" + stage); }
  if (training && explicit) { score += 15; reasons.push("明确培训或项目需求"); }
  return { score: Math.min(score, 100), reasons };
}

/** 由候选计算 confidence / record_type / priority */
export function scoreCandidate(c) {
  const { score, reasons } = qualificationReasons(c);
  const confidence = score >= 60 ? "high" : score >= 40 ? "medium" : "low";
  const recordType =
    (c && c.project_collaboration) || (c && !c.group_source && String(c.stage || "新线索") !== "新线索" && score >= 55)
      ? "opportunity"
      : "candidate";
  return {
    qualification_score: score,
    qualification_reasons: reasons.length ? reasons.join("；") : "仅有弱上下文，需人工核实",
    confidence,
    record_type: recordType,
    priority: clamp(candidatePriority(c), 0, 5),
  };
}

/**
 * 从消息构造商机候选。
 * 群来源：命中 GROUP_ACTIONABLE_* 或同一条 URL 在 ≥2 个不同群被付费加热；
 * 私聊/项目群：命中 is_deal_opportunity / is_training_project_opportunity / PIPELINE_CONTEXT_TERMS。
 */
export function buildCandidates(messages) {
  const rows = (messages || []).filter(Boolean).map(normMessage);

  // 1) 付费加热过的 URL → 出现在哪些群
  const groupUrlSources = new Map();
  for (const m of rows) {
    if (m.kind !== "group" || isSystemSender(m.sender) || m.is_owner || isNoiseEvidence(m.content)) continue;
    if (!PAID_BOOST_TERMS.test(m.content)) continue;
    for (const url of m.links || []) {
      const key = String(url);
      if (!groupUrlSources.has(key)) groupUrlSources.set(key, new Set());
      groupUrlSources.get(key).add(m.chat);
    }
  }

  // 2) 项目协作群识别
  const byChat = new Map();
  for (const m of rows) {
    if (m.kind !== "group") continue;
    if (!byChat.has(m.chat)) byChat.set(m.chat, []);
    byChat.get(m.chat).push(m);
  }
  const selfNames = loadProfile().owner_aliases || [];
  const projectChats = new Set();
  for (const [chat, list] of byChat) {
    if (isProjectCollaborationGroup(chat, list, selfNames)) projectChats.add(chat);
  }

  // 3) 分组收集
  const privateGroups = new Map();
  const groupAnchors = new Map();

  for (const m of rows) {
    if (m.kind === "group" && !projectChats.has(m.chat)) {
      if (isSystemSender(m.sender) || m.is_owner || isNoiseEvidence(m.content)) continue;
      if (EXPLICIT_NON_DEAL_TERMS.test(m.content)) continue;
      if (/不是\s*(?:campaign|商单|合作|推广)/i.test(m.content)) continue;
      if (isGroupRecapMessage(m)) continue;
      const urls = m.links || [];
      const repeatedPaidLink = urls.some((u) => (groupUrlSources.get(String(u)) || new Set()).size >= 2);
      const explicitOpportunity =
        GROUP_ACTIONABLE_DEAL_TERMS.test(m.content) || GROUP_ACTIONABLE_TRAINING_TERMS.test(m.content);
      if (!explicitOpportunity && !repeatedPaidLink) continue;
      const anchor = urls.length ? String(urls[0]) : evidenceDedupeKey(m.content);
      const anchorDigest = sha256Short(anchor, 20);
      const scope = urls.length ? "url" : m.chat;
      const key = scope + "\u0001" + anchorDigest;
      if (!groupAnchors.has(key)) groupAnchors.set(key, { scope, anchorDigest, rows: [] });
      groupAnchors.get(key).rows.push(m);
      continue;
    }
    const isDeal = isDealOpportunity(m);
    const isTraining = isTrainingProjectOpportunity(m);
    if (!(isDeal || isTraining || PIPELINE_CONTEXT_TERMS.test(m.content))) continue;
    const project = projectChats.has(m.chat);
    const identity = project ? "project:" + m.chat : "name:" + m.chat;
    const key = identity + "\u0001" + m.chat;
    if (!privateGroups.has(key)) privateGroups.set(key, { identity, chat: m.chat, rows: [] });
    privateGroups.get(key).rows.push(m);
  }

  const candidates = [];

  const makeCandidate = (opportunityKey, chat, rawRows, opts) => {
    const list = [...rawRows].sort((a, b) => a.ts - b.ts);
    const trainingRows = list.filter((m) => isTrainingProjectOpportunity(m));
    const dealRows = list.filter((m) => isDealOpportunity(m));
    const opportunityType = trainingRows.length ? "培训/咨询/项目合作" : dealRows.length ? "商单/推广" : "其他合作";
    const text = list.map((m) => m.content).join(" ");
    const sourceChats = uniq(list.map((m) => m.chat));
    const lastSignalTime = list.length ? list[list.length - 1].ts : 0;
    const groupSource = Boolean(opts.groupSource);

    const stage = groupSource ? "新线索" : inferStage(text);
    let amount = "";
    if (groupSource) {
      // 群来源只认含预算/报价类词的消息，纯加热奖励不算
      amount = uniq(list.filter((m) => BUDGET_TERMS.test(m.content)).map((m) => extractAmountsLoose(m.content).join(" / ")))
        .filter(Boolean)
        .join(" / ");
    } else {
      amount = uniq(list.flatMap((m) => extractAmountsLoose(m.content))).join(" / ");
    }

    let title = chat;
    let displayChat = chat;
    if (groupSource) {
      let label = sourceChats.slice(0, 3).join("、");
      if (sourceChats.length > 3) label += "等" + sourceChats.length + "群";
      displayChat = label;
      title = label + "｜" + truncate(list.length ? list[list.length - 1].content : "", 42);
    }

    const base = {
      opportunity_key: opportunityKey,
      chat: displayChat,
      title,
      opportunity_type: opportunityType,
      stage,
      amount,
      last_signal_time: lastSignalTime,
      next_action: groupSource ? "回原群核实品牌、预算、名额和对接人" : inferNextAction(stage),
      replace_amount: groupSource,
      project_collaboration: Boolean(opts.projectCollaboration),
      group_source: groupSource,
      source_chats: sourceChats,
      text,
      training: trainingRows.length > 0,
      evidence: list.slice(-6).map((m) => ({
        message_id: m.id,
        chat: m.chat,
        sender: m.sender,
        ts: m.ts,
        content: truncate(m.content, 200),
        is_owner: m.is_owner,
      })),
      message_ids: list.map((m) => m.id).filter(Boolean),
      message_hashes: list.map((m) => sha256([m.chat, m.sender, String(m.ts), m.content].join("\n"))),
    };
    return { ...base, ...scoreCandidate(base) };
  };

  for (const item of privateGroups.values()) {
    const key = "private:" + sha256Short(item.identity, 24);
    candidates.push(
      makeCandidate(key, item.chat, item.rows, {
        groupSource: false,
        projectCollaboration: item.identity.startsWith("project:"),
      }),
    );
  }
  for (const item of groupAnchors.values()) {
    const key = "group:" + sha256Short(item.scope, 16) + ":" + item.anchorDigest;
    const anchorChat = item.rows[item.rows.length - 1].chat;
    candidates.push(makeCandidate(key, anchorChat, item.rows, { groupSource: true }));
  }
  return candidates;
}

/** 把 signals.analyze 的 brandDeals / trainings 转成候选，供 syncCandidates 使用 */
export function candidateFromAnalysis(analysis, messages) {
  const a = analysis || {};
  const byChat = new Map();
  for (const m of messages || []) {
    const chat = String((m && (m.session_name || m.chat)) || "");
    if (!chat) continue;
    if (!byChat.has(chat)) byChat.set(chat, []);
    byChat.get(chat).push(m);
  }
  const out = new Map();
  const push = (row, kind) => {
    if (!row || !row.chat) return;
    const chat = String(row.chat);
    const kindName = row.kind || classifyChat(chat);
    const groupSource = kindName === "group";
    const chatRows = byChat.get(chat) || [];
    const text = chatRows.length ? chatRows.map((m) => String(m.content || "")).join(" ") : "";
    const evidence = (row.evidence || []).map((e) => ({
      message_id: e.message_id || null,
      chat,
      sender: e.sender || null,
      ts: Number(e.ts) || 0,
      content: truncate(e.content || "", 200),
      is_owner: Boolean(e.is_owner),
    }));
    // 锚点口径与 buildCandidates 对齐：会话里出现过 URL 就用首个 URL，否则用证据去重键
    const chatUrls = chatRows.flatMap((m) => messageLinks(m).map(String));
    const anchorContent = evidence.length ? evidence[evidence.length - 1].content : chat;
    const anchor = chatUrls.length ? chatUrls[0] : evidenceDedupeKey(anchorContent);
    const anchorDigest = sha256Short(anchor, 20);
    const project =
      groupSource && chatRows.length
        ? isProjectCollaborationGroup(chat, chatRows.map(normMessage), loadProfile().owner_aliases || [])
        : false;
    const identity = project ? "project:" + chat : groupSource ? chat : "name:" + chat;
    const opportunityKey = groupSource
      ? "group:" + sha256Short(anchor.startsWith("url:") ? "url" : identity, 16) + ":" + anchorDigest
      : "private:" + sha256Short(identity, 24);
    const stage = groupSource ? "新线索" : inferStage(text || evidence.map((e) => e.content).join(" "));
    const base = {
      opportunity_key: opportunityKey,
      chat,
      title: chat,
      opportunity_type: kind === "training" ? "培训/咨询/项目合作" : "商单/推广",
      stage,
      amount: uniq(row.amounts || []).join(" / "),
      last_signal_time: Number(row.ts) || 0,
      next_action: groupSource ? "回原群核实品牌、预算、名额和对接人" : inferNextAction(stage),
      replace_amount: groupSource,
      project_collaboration: project,
      group_source: groupSource,
      source_chats: [chat],
      text: text + " " + (row.hits || []).join(" "),
      training: kind === "training",
      evidence,
      message_ids: evidence.map((e) => e.message_id).filter(Boolean),
      message_hashes: [],
      analysis_qualification: Number(row.qualification) || 0,
      analysis_confidence: row.confidence || null,
    };
    const scored = { ...base, ...scoreCandidate(base) };
    const prev = out.get(opportunityKey);
    if (!prev) {
      out.set(opportunityKey, scored);
      return;
    }
    // 同一会话同时命中商单与培训：合并证据，培训优先（与上游 training_rows 优先一致）
    const merged = {
      ...prev,
      training: prev.training || scored.training,
      text: prev.text + " " + scored.text,
      amount: uniq([...(prev.amount ? prev.amount.split(" / ") : []), ...(scored.amount ? scored.amount.split(" / ") : [])]).join(" / "),
      last_signal_time: Math.max(prev.last_signal_time, scored.last_signal_time),
      evidence: [...prev.evidence, ...scored.evidence].slice(-8),
      message_hashes: uniq([...prev.message_hashes, ...scored.message_hashes]),
    };
    merged.opportunity_type = merged.training ? "培训/咨询/项目合作" : merged.opportunity_type;
    const s = scoreCandidate(merged);
    out.set(opportunityKey, {
      ...merged,
      ...s,
      priority: Math.max(prev.priority, s.priority),
      qualification_score: Math.max(prev.qualification_score, s.qualification_score),
    });
  };
  for (const row of a.brandDeals || []) push(row, "deal");
  for (const row of a.trainings || []) push(row, "training");
  return [...out.values()];
}

// ---------------- 存储层：表结构增量迁移 ----------------
// store.mjs 的 opportunities 表是最小字段集；本模块需要 priority/locked/expires 等列，
// 这里做一次性、幂等的 ADD COLUMN 迁移（不修改 store.mjs，也不删除任何已有列）。
const EXTRA_COLUMNS = [
  ["priority", "INTEGER DEFAULT 0"],
  ["opportunity_type", "TEXT DEFAULT ''"],
  ["last_signal_time", "INTEGER DEFAULT 0"],
  ["stage_locked", "INTEGER DEFAULT 0"],
  ["priority_locked", "INTEGER DEFAULT 0"],
  ["next_action_locked", "INTEGER DEFAULT 0"],
  ["closed_at", "INTEGER"],
  ["qualification_score", "INTEGER DEFAULT 0"],
  ["qualification_reasons", "TEXT DEFAULT ''"],
  ["reinforcement_count", "INTEGER DEFAULT 1"],
  ["expires_at", "INTEGER"],
  ["last_reviewed_at", "INTEGER"],
];

// 每个连接只做一次迁移：list/get/count 等读路径每次调用都跑 PRAGMA+DDL 得不偿失
const _schemaDone = new WeakSet();

export function ensureOpportunitySchema(db) {
  const d = db || store();
  if (_schemaDone.has(d)) return d;
  let cols = new Set();
  try {
    cols = new Set(d.prepare("PRAGMA table_info(opportunities)").all().map((r) => String(r.name)));
  } catch {
    cols = new Set();
  }
  for (const [name, decl] of EXTRA_COLUMNS) {
    if (cols.has(name)) continue;
    try {
      d.exec("ALTER TABLE opportunities ADD COLUMN " + name + " " + decl);
    } catch {
      /* 并发迁移或已存在：忽略 */
    }
  }
  d.exec("CREATE INDEX IF NOT EXISTS idx_opp_key ON opportunities(key)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_opp_type_status ON opportunities(type, status)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_opp_follow ON opportunities(follow_up)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_opp_events ON opportunity_events(opp_id, kind)");
  _schemaDone.add(d);
  return d;
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt === undefined ? 0 : dflt;
}

/** DB 行 → 对外结构（type→record_type、note→notes、follow_up→next_follow_up） */
export function rowToOpportunity(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    opportunity_key: r.key || "",
    key: r.key || "",
    title: r.title || "",
    record_type: RECORD_TYPES.includes(String(r.type)) ? String(r.type) : "candidate",
    record_label: RECORD_LABELS[r.type] || "待审核候选",
    opportunity_type: r.opportunity_type || "其他合作",
    status: r.status || "new",
    status_label: STATUS_LABELS[r.status] || r.status || "",
    stage: r.stage || "新线索",
    chat: r.chat || "",
    contact: r.contact || "",
    role: r.role || "",
    confidence: CONFIDENCE_LEVELS.includes(String(r.confidence)) ? String(r.confidence) : "medium",
    confidence_label: CONFIDENCE_LABELS[r.confidence] || "待核实",
    evidence: pj(r.evidence, []),
    evidence_count: num(r.evidence_count, 0),
    links: pj(r.links, []),
    notes: r.note || "",
    note: r.note || "",
    amount: r.amount || "",
    next_action: r.next_action || "",
    next_follow_up: r.follow_up || "",
    priority: num(r.priority, 0),
    last_signal_time: num(r.last_signal_time, 0),
    last_signal_at: r.last_signal_time ? fmtLocal(new Date(num(r.last_signal_time))) : "",
    stage_locked: Boolean(num(r.stage_locked, 0)),
    priority_locked: Boolean(num(r.priority_locked, 0)),
    next_action_locked: Boolean(num(r.next_action_locked, 0)),
    closed_at: r.closed_at == null ? null : num(r.closed_at),
    qualification_score: num(r.qualification_score, 0),
    qualification_reasons: r.qualification_reasons || "",
    reinforcement_count: num(r.reinforcement_count, 1),
    expires_at: r.expires_at == null ? null : num(r.expires_at),
    last_reviewed_at: r.last_reviewed_at == null ? null : num(r.last_reviewed_at),
    created_ts: num(r.created_ts, 0),
    updated_ts: num(r.updated_ts, 0),
    source: r.source || null,
  };
}

function addEvent(db, oppId, ts, kind, detail) {
  db.prepare("INSERT INTO opportunity_events(opp_id, ts, kind, detail) VALUES(?,?,?,?)").run(
    oppId,
    ts,
    kind,
    detail == null ? null : typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

function latestFeedback(db, targetType, target) {
  const row = db
    .prepare("SELECT verdict FROM feedback WHERE target_type=? AND target=? ORDER BY id DESC LIMIT 1")
    .get(targetType, target);
  return row ? String(row.verdict) : "";
}

function candidateExpiry(candidateTime, createdAt, days) {
  const base = num(candidateTime, 0) || num(createdAt, 0) || Date.now();
  return base + Math.max(1, days) * 86400000;
}

/** 标记无新信号的候选为 stale（保留全部证据） */
export function expireStaleCandidates({ now, staleDays = 14, apply = false } = {}) {
  ensureOpportunitySchema();
  const db = store();
  const nowMs = num(now, Date.now());
  const cutoff = nowMs - Math.max(1, staleDays) * 86400000;
  const rows = db
    .prepare(
      "SELECT * FROM opportunities WHERE type='candidate' AND status='new'" +
        " AND (follow_up IS NULL OR follow_up='')" +
        " AND (last_reviewed_at IS NULL OR last_reviewed_at=0)" +
        " AND ((expires_at IS NOT NULL AND expires_at>0 AND expires_at<=?)" +
        " OR ((expires_at IS NULL OR expires_at=0) AND last_signal_time>0 AND last_signal_time<=?))" +
        " ORDER BY last_signal_time ASC, id ASC",
    )
    .all(nowMs, cutoff)
    .map(rowToOpportunity);
  if (apply && rows.length) {
    const stmt = db.prepare("UPDATE opportunities SET status='stale', updated_ts=? WHERE id=?");
    tx(db, () => {
      for (const r of rows) {
        stmt.run(nowMs, r.id);
        addEvent(db, r.id, nowMs, "expired", { stale_days: staleDays });
      }
    });
  }
  return rows;
}

function attachEvidence(db, oppId, candidate, ts) {
  const existing = new Set(
    db.prepare("SELECT detail FROM opportunity_events WHERE opp_id=? AND kind='evidence'").all(oppId).map((r) => String(r.detail)),
  );
  let added = 0;
  for (const e of candidate.evidence || []) {
    const detail = JSON.stringify({
      message_id: e.message_id || null,
      chat: e.chat || "",
      sender: e.sender || null,
      ts: num(e.ts, 0),
      content: truncate(e.content || "", 200),
    });
    if (existing.has(detail)) continue;
    existing.add(detail);
    addEvent(db, oppId, num(e.ts, ts) || ts, "evidence", detail);
    added += 1;
  }
  return added;
}

/**
 * 同步候选到商机库。
 * 单调规则：stage 只前进（未锁定）、priority 只取 max（未锁定）、record_type 不降级、confidence 只升级、
 * reinforcement_count 仅有新信号时 +1、amount 用 " / " 合并（群来源整体替换）。
 */
export function syncCandidates(candidates, { dryRun = false, staleDays = 14, now, runId = null, source = "opportunity-sync" } = {}) {
  ensureOpportunitySchema();
  const db = store();
  const nowMs = num(now, Date.now());
  const expired = expireStaleCandidates({ now: nowMs, staleDays, apply: !dryRun });
  const items = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const candidate of candidates || []) {
    const chat = String((candidate && candidate.chat) || "").trim();
    const opportunityKey = String((candidate && candidate.opportunity_key) || "").trim();
    if (!chat || !opportunityKey) {
      skipped += 1;
      items.push({ id: null, key: opportunityKey, action: "skipped", reason: "缺少 chat 或 opportunity_key", chat });
      continue;
    }
    const verdict = latestFeedback(db, "opportunity", opportunityKey) || latestFeedback(db, "chat", chat);
    if (verdict === "false_positive" || verdict === "ignore") {
      skipped += 1;
      items.push({ id: null, key: opportunityKey, action: "skipped", chat, reason: "人工反馈：" + verdict });
      continue;
    }

    let priority = clamp(num(candidate.priority, 0), 0, 5);
    if (verdict === "low_priority") priority = Math.min(priority, 1);
    else if (verdict === "confirmed") priority = Math.max(priority, 5);

    let recordType = RECORD_TYPES.includes(String(candidate.record_type)) ? String(candidate.record_type) : "candidate";
    if (verdict === "confirmed") recordType = "opportunity";
    let confidence = CONFIDENCE_LEVELS.includes(String(candidate.confidence)) ? String(candidate.confidence) : "medium";
    if (verdict === "confirmed") confidence = "confirmed";
    const qualification = clamp(num(candidate.qualification_score, 0), 0, 100);
    const reasons = String(candidate.qualification_reasons || "");
    const candidateTime = num(candidate.last_signal_time, 0);

    let latest = db.prepare("SELECT * FROM opportunities WHERE key=? ORDER BY id DESC LIMIT 1").get(opportunityKey);
    // 项目协作群：把旧的群键行升级为项目键，避免同一交付群出现两条管线
    if (!latest && candidate.project_collaboration) {
      const legacy = db
        .prepare(
          "SELECT * FROM opportunities WHERE chat=? AND key LIKE 'group:%' AND status IN ('new','active','waiting','paused')" +
            " ORDER BY last_signal_time DESC, id DESC LIMIT 1",
        )
        .get(chat);
      if (legacy) {
        if (!dryRun) db.prepare("UPDATE opportunities SET key=?, updated_ts=? WHERE id=?").run(opportunityKey, nowMs, legacy.id);
        latest = { ...legacy, key: opportunityKey };
      }
    }
    if (latest && String(latest.status) === "ignored") {
      skipped += 1;
      items.push({ id: Number(latest.id), key: opportunityKey, action: "skipped", chat, reason: "已被人工忽略" });
      continue;
    }

    const existingSignal = latest ? num(latest.last_signal_time, 0) : 0;
    const closed = latest ? CLOSED_STATUSES.includes(String(latest.status)) : false;
    const createNew = !latest || (closed && candidateTime > existingSignal);

    if (createNew) {
      if (dryRun) {
        created += 1;
        items.push({ id: null, key: opportunityKey, action: "created", chat, title: candidate.title, stage: candidate.stage, priority, record_type: recordType, dry_run: true });
        continue;
      }
      const expiresAt = recordType === "candidate" ? candidateExpiry(candidateTime, nowMs, staleDays) : null;
      const info = db
        .prepare(
          "INSERT INTO opportunities(key,title,type,status,stage,chat,contact,role,confidence,evidence,follow_up,next_action,note,amount,links," +
            "created_ts,updated_ts,source,priority,opportunity_type,last_signal_time,qualification_score,qualification_reasons,reinforcement_count,expires_at) " +
            "VALUES(?,?,?,'new',?,?,?,?,?,?,NULL,?,NULL,?,?,?,?,?,?,?,?,?,?,1,?)",
        )
        .run(
          opportunityKey,
          String(candidate.title || chat),
          recordType,
          String(candidate.stage || "新线索"),
          chat,
          candidate.contact || "",
          candidate.role || "",
          confidence,
          JSON.stringify(candidate.evidence || []),
          String(candidate.next_action || ""),
          String(candidate.amount || ""),
          JSON.stringify(candidate.links || []),
          nowMs,
          nowMs,
          source,
          priority,
          String(candidate.opportunity_type || "其他合作"),
          candidateTime,
          qualification,
          reasons,
          expiresAt,
        );
      const oppId = Number(info.lastInsertRowid);
      attachEvidence(db, oppId, candidate, nowMs);
      addEvent(db, oppId, nowMs, "created", {
        stage: candidate.stage,
        priority,
        record_type: recordType,
        confidence,
        qualification_score: qualification,
        run_id: runId,
      });
      created += 1;
      items.push({ id: oppId, key: opportunityKey, action: "created", chat, title: candidate.title, stage: candidate.stage, priority, record_type: recordType });
      continue;
    }

    // ---- 更新路径 ----
    const existingStage = String(latest.stage || "新线索");
    const incomingStage = String(candidate.stage || "新线索");
    let stage = existingStage;
    if (!num(latest.stage_locked, 0) && stageRank(incomingStage) >= stageRank(existingStage)) stage = incomingStage;

    const existingPriority = num(latest.priority, 0);
    const finalPriority = num(latest.priority_locked, 0) ? existingPriority : Math.max(existingPriority, priority);

    let nextAction = String(latest.next_action || "");
    if (!num(latest.next_action_locked, 0) && (stage !== existingStage || !nextAction)) {
      nextAction = String(candidate.next_action || nextAction);
    }

    const lastSignalTime = Math.max(existingSignal, candidateTime);
    let opportunityType = String(latest.opportunity_type || "");
    const incomingType = String(candidate.opportunity_type || "");
    if (incomingType === "培训/咨询/项目合作" || !opportunityType) opportunityType = incomingType || opportunityType;

    const hasNewSignal = candidateTime > existingSignal;
    let finalRecordType = RECORD_TYPES.includes(String(latest.type)) ? String(latest.type) : "candidate";
    if (finalRecordType === "candidate" && recordType === "opportunity") finalRecordType = "opportunity";
    let finalConfidence = CONFIDENCE_LEVELS.includes(String(latest.confidence)) ? String(latest.confidence) : "medium";
    if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[finalConfidence]) finalConfidence = confidence;
    let finalStatus = String(latest.status || "new");
    if (finalStatus === "stale" && hasNewSignal) finalStatus = "new";
    const reinforcementCount = num(latest.reinforcement_count, 1) + (hasNewSignal ? 1 : 0);
    let expiresAt = latest.expires_at == null ? null : num(latest.expires_at, 0);
    if (finalRecordType === "opportunity") expiresAt = null;
    else if (hasNewSignal || !expiresAt) expiresAt = candidateExpiry(candidateTime, nowMs, staleDays);
    const amount = candidate.replace_amount
      ? String(candidate.amount || "")
      : mergeValues(String(latest.amount || ""), String(candidate.amount || ""));
    const evidence = (candidate.evidence || []).length ? candidate.evidence : pj(latest.evidence, []);

    if (dryRun) {
      updated += 1;
      items.push({ id: Number(latest.id), key: opportunityKey, action: "updated", chat, stage, priority: finalPriority, record_type: finalRecordType, dry_run: true });
      continue;
    }
    db.prepare(
      "UPDATE opportunities SET title=?, type=?, status=?, stage=?, priority=?, amount=?, last_signal_time=?, next_action=?, " +
        "source=?, updated_ts=?, confidence=?, qualification_score=MAX(qualification_score,?), " +
        "qualification_reasons=CASE WHEN ?<>'' THEN ? ELSE qualification_reasons END, reinforcement_count=?, " +
        "expires_at=?, opportunity_type=?, evidence=? WHERE id=?",
    ).run(
      String(candidate.title || latest.title || chat),
      finalRecordType,
      finalStatus,
      stage,
      finalPriority,
      amount,
      lastSignalTime,
      nextAction,
      source,
      nowMs,
      finalConfidence,
      qualification,
      reasons,
      reasons,
      reinforcementCount,
      expiresAt,
      opportunityType,
      JSON.stringify(evidence),
      Number(latest.id),
    );
    const addedEvidence = attachEvidence(db, Number(latest.id), candidate, nowMs);
    addEvent(db, Number(latest.id), nowMs, hasNewSignal ? "reinforced" : "updated", {
      stage,
      priority: finalPriority,
      record_type: finalRecordType,
      confidence: finalConfidence,
      new_signal: hasNewSignal,
      evidence_added: addedEvidence,
      run_id: runId,
    });
    updated += 1;
    items.push({ id: Number(latest.id), key: opportunityKey, action: "updated", chat, stage, priority: finalPriority, record_type: finalRecordType, new_signal: hasNewSignal });
  }

  return { created, updated, skipped, expired: expired.length, items };
}

function mergeValues(existing, incoming) {
  const out = [];
  for (const value of [...splitAmounts(existing), ...splitAmounts(incoming)]) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out.join(" / ");
}
function splitAmounts(value) {
  return String(value == null ? "" : value)
    .split(" / ")
    .map((v) => v.trim())
    .filter(Boolean);
}

// ---------------- 查询 ----------------
const OPP_SELECT =
  "SELECT o.*, (SELECT COUNT(*) FROM opportunity_events e WHERE e.opp_id=o.id AND e.kind='evidence') AS evidence_count FROM opportunities o";

export function listOpportunities({ status, stage, chat, dueOnly = false, includeClosed = false, includeCandidates = false, minPriority = 0, limit = 50 } = {}) {
  ensureOpportunitySchema();
  const db = store();
  const where = [];
  const args = [];
  if (status) {
    where.push("o.status=?");
    args.push(String(status));
  } else if (!includeClosed) {
    where.push("o.status IN ('new','active','waiting','paused')");
  }
  if (stage) {
    where.push("o.stage=?");
    args.push(String(stage));
  }
  if (chat) {
    where.push("o.chat LIKE ?");
    args.push("%" + String(chat) + "%");
  }
  if (minPriority > 0) {
    where.push("o.priority>=?");
    args.push(Number(minPriority));
  }
  if (!includeCandidates) where.push("o.type='opportunity'");
  if (dueOnly) {
    where.push("o.follow_up IS NOT NULL AND o.follow_up<>'' AND substr(o.follow_up,1,10)<=?");
    args.push(fmtDay(new Date()));
  }
  const sql =
    OPP_SELECT +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY CASE WHEN o.follow_up IS NOT NULL AND o.follow_up<>'' THEN 0 ELSE 1 END, o.follow_up ASC, o.priority DESC, o.last_signal_time DESC LIMIT ?";
  args.push(Math.max(1, Number(limit) || 50));
  return db.prepare(sql).all(...args).map(rowToOpportunity);
}

/** 待分流收件箱：status=new 的高优先级候选，按置信度/强化次数排序 */
export function listInbox({ minPriority = 4, limit = 20 } = {}) {
  const rows = listOpportunities({ status: "new", minPriority, includeCandidates: true, limit: Math.max(1, limit) * 3 });
  rows.sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      b.reinforcement_count - a.reinforcement_count ||
      b.priority - a.priority ||
      b.last_signal_time - a.last_signal_time,
  );
  return rows.slice(0, Math.max(1, limit));
}

/** 与 listInbox 同口径的真实总数（status=new、priority>=minPriority、含候选），
 *  不受 limit 截断：首页 counts.inbox 用它，避免拿"展示条数"当总数（F6） */
export function countInbox({ minPriority = 4 } = {}) {
  ensureOpportunitySchema();
  const where = ["status='new'"];
  const args = [];
  if (minPriority > 0) {
    where.push("priority>=?");
    args.push(Number(minPriority));
  }
  return Number(store().prepare("SELECT COUNT(*) AS n FROM opportunities WHERE " + where.join(" AND ")).get(...args).n);
}

/** 与 listToday 同口径的真实总数（WHERE 逐条镜像，回归里与 listToday 长度钉等），不受 limit 截断（F6） */
export function countToday({ today, minPriority = 3 } = {}) {
  ensureOpportunitySchema();
  const day =
    today instanceof Date
      ? fmtDay(today)
      : typeof today === "number"
        ? fmtDay(new Date(today))
        : String(today || fmtDay(new Date())).slice(0, 10);
  const sql =
    "SELECT COUNT(*) AS n FROM opportunities WHERE status IN ('new','active','waiting') AND priority>=?" +
    " AND (type='opportunity' OR confidence IN ('high','confirmed'))" +
    " AND ((follow_up IS NOT NULL AND follow_up<>'' AND substr(follow_up,1,10)<=?) OR ((follow_up IS NULL OR follow_up='') AND status IN ('new','active')))";
  return Number(store().prepare(sql).get(Number(minPriority) || 0, day).n);
}

/** 今日行动：到期跟进 0 / 已发布待结算 1 / active 2 / 其它 3，再按 priority、last_signal_time 降序 */
export function listToday({ today, minPriority = 3, limit = 10 } = {}) {
  ensureOpportunitySchema();
  const db = store();
  const day =
    today instanceof Date
      ? fmtDay(today)
      : typeof today === "number"
        ? fmtDay(new Date(today))
        : String(today || fmtDay(new Date())).slice(0, 10);
  const sql =
    OPP_SELECT +
    " WHERE o.status IN ('new','active','waiting') AND o.priority>=?" +
    " AND (o.type='opportunity' OR o.confidence IN ('high','confirmed'))" +
    " AND ((o.follow_up IS NOT NULL AND o.follow_up<>'' AND substr(o.follow_up,1,10)<=?) OR ((o.follow_up IS NULL OR o.follow_up='') AND o.status IN ('new','active')))" +
    " ORDER BY CASE WHEN o.follow_up IS NOT NULL AND o.follow_up<>'' AND substr(o.follow_up,1,10)<=? THEN 0" +
    " WHEN o.stage='已发布待结算' THEN 1 WHEN o.status='active' THEN 2 ELSE 3 END," +
    " o.priority DESC, o.last_signal_time DESC LIMIT ?";
  return db
    .prepare(sql)
    .all(Number(minPriority) || 0, day, day, Math.max(1, Number(limit) || 10))
    .map(rowToOpportunity);
}

export function getOpportunity(id) {
  ensureOpportunitySchema();
  const row = store().prepare(OPP_SELECT + " WHERE o.id=?").get(Number(id));
  return rowToOpportunity(row);
}

export function countByStatus() {
  ensureOpportunitySchema();
  const db = store();
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM opportunities GROUP BY status").all();
  const out = { total: 0 };
  for (const s of ALL_STATUSES) out[s] = 0;
  for (const r of rows) {
    out[String(r.status)] = Number(r.n);
    out.total += Number(r.n);
  }
  out.open = OPEN_STATUSES.reduce((acc, s) => acc + (out[s] || 0), 0);
  out.closed = CLOSED_STATUSES.reduce((acc, s) => acc + (out[s] || 0), 0);
  out.inactive = INACTIVE_STATUSES.reduce((acc, s) => acc + (out[s] || 0), 0);
  out.candidates = Number(db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE type='candidate'").get().n);
  out.opportunities = Number(db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE type='opportunity'").get().n);
  return out;
}

export function listEvents(id, limit = 50) {
  ensureOpportunitySchema();
  return store()
    .prepare("SELECT * FROM opportunity_events WHERE opp_id=? ORDER BY ts DESC, id DESC LIMIT ?")
    .all(Number(id), Math.max(1, Number(limit) || 50))
    .map((r) => {
      let detail = r.detail;
      try {
        detail = r.detail ? JSON.parse(r.detail) : null;
      } catch {
        detail = r.detail;
      }
      return { id: Number(r.id), opp_id: Number(r.opp_id), ts: Number(r.ts), kind: r.kind, detail, at: fmtLocal(new Date(Number(r.ts))) };
    });
}

// ---------------- 更新 / 分流 / 反馈 ----------------
function normalizeFollowUp(value) {
  if (value == null) return "";
  if (typeof value === "number") return fmtDay(new Date(value));
  if (value instanceof Date) return fmtDay(value);
  const s = String(value).trim().replace(/\//g, "-");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0");
  const t = Date.parse(s);
  return Number.isNaN(t) ? s.slice(0, 10) : fmtDay(new Date(t));
}

/**
 * 更新商机：stage/priority/next_action 写入即锁定，unlock* 解锁；
 * status 变化写 closed_at；notes 追加 "[时间] 备注"；没有可更新字段时抛错。
 * follow_up 有两个入口名：对外参数 followUp（wai_opportunity_update）与内部名 nextFollowUp（triage 传入），都写同一列。
 */
export function updateOpportunity(id, patch = {}) {
  ensureOpportunitySchema();
  const db = store();
  const row = db.prepare("SELECT * FROM opportunities WHERE id=?").get(Number(id));
  if (!row) throw new Error("找不到商机 ID：" + id);
  const nowMs = num(patch.now, Date.now());
  const sets = [];
  const args = [];
  let touched = 0;
  const set = (col, value) => {
    sets.push(col + "=?");
    args.push(value);
    touched += 1;
  };

  if (patch.stage != null) {
    set("stage", String(patch.stage));
    set("stage_locked", 1);
  } else if (patch.unlockStage) set("stage_locked", 0);

  if (patch.status != null) {
    const status = String(patch.status);
    if (!ALL_STATUSES.includes(status)) throw new Error("不支持的状态：" + status);
    set("status", status);
    set("closed_at", CLOSED_STATUSES.includes(status) ? nowMs : null);
    if (["active", "waiting", "paused", "won", "lost"].includes(status)) {
      set("type", "opportunity");
      set("expires_at", null);
      set("last_reviewed_at", nowMs);
    } else if (INACTIVE_STATUSES.includes(status)) set("last_reviewed_at", nowMs);
  }

  if (patch.priority != null) {
    set("priority", clamp(Number(patch.priority) || 0, 0, 5));
    set("priority_locked", 1);
  } else if (patch.unlockPriority) set("priority_locked", 0);

  if (patch.nextAction != null) {
    set("next_action", String(patch.nextAction));
    set("next_action_locked", 1);
  } else if (patch.unlockNextAction) set("next_action_locked", 0);

  // followUp（对外）/nextFollowUp（triage 内部）都要落到 follow_up；
  // 此前只认 nextFollowUp，wai_opportunity_update 的 followUp 被静默丢弃，单独更新它还会误报「至少提供一项」
  const followRaw = patch.nextFollowUp != null ? patch.nextFollowUp : patch.followUp;
  if (patch.clearFollowUp) set("follow_up", null);
  else if (followRaw != null && String(followRaw).trim() !== "") set("follow_up", normalizeFollowUp(followRaw));

  if (patch.note && String(patch.note).trim()) {
    const entry = "[" + fmtLocal(new Date(nowMs)) + "] " + String(patch.note).trim();
    const existing = String(row.note || "");
    set("note", (existing ? existing + "\n" : "") + entry);
  }

  if (!touched) throw new Error("至少提供一项要更新的字段");
  sets.push("updated_ts=?");
  args.push(nowMs);
  args.push(Number(id));
  db.prepare("UPDATE opportunities SET " + sets.join(", ") + " WHERE id=?").run(...args);
  addEvent(db, Number(id), nowMs, patch.status != null && patch.status !== row.status ? "status" : "update", {
    from_status: row.status,
    status: patch.status || row.status,
    stage: patch.stage || row.stage,
    priority: patch.priority != null ? patch.priority : row.priority,
    note: patch.note || null,
  });
  return getOpportunity(id);
}

/** 人工分流：pursue/wait/pause/ignore/won/lost，wait 必须给跟进日期 */
export function triage(id, decision, { stage, priority, nextAction, followUp, note } = {}) {
  const key = String(decision || "").trim();
  if (!Object.prototype.hasOwnProperty.call(TRIAGE_DECISIONS, key)) {
    throw new Error("不支持的分流决定：" + decision);
  }
  const follow = normalizeFollowUp(followUp);
  if (key === "wait" && !follow) throw new Error("选择 wait 时必须提供 --follow-up，避免商机永久沉底");
  const updated = updateOpportunity(id, {
    status: TRIAGE_DECISIONS[key],
    stage,
    priority,
    nextAction,
    nextFollowUp: follow || undefined,
    note,
  });
  if (["pursue", "wait", "won"].includes(key)) {
    addFeedback({ targetType: "opportunity", target: updated.opportunity_key, verdict: "confirmed", note: "triage:" + key });
  } else if (key === "ignore") {
    addFeedback({ targetType: "opportunity", target: updated.opportunity_key, verdict: "ignore", note: "triage:ignore" });
  }
  return getOpportunity(id) || updated;
}

/** 人工反馈：chat 级 false_positive/ignore 会把该会话的开放商机整条忽略 */
export function addFeedback({ targetType, target, verdict, note } = {}) {
  ensureOpportunitySchema();
  const db = store();
  const type = String(targetType || "").trim();
  const value = String(target || "").trim();
  const v = String(verdict || "").trim();
  if (!FEEDBACK_VERDICTS.includes(v)) throw new Error("不支持的反馈结论：" + verdict);
  if (!type || !value) throw new Error("反馈对象类型和对象值不能为空");
  const nowMs = Date.now();
  const info = db
    .prepare("INSERT INTO feedback(target_type,target,verdict,note,created_ts) VALUES(?,?,?,?,?)")
    .run(type, value, v, String(note || "").trim(), nowMs);

  const openList = "('new','active','waiting','paused')";
  const withStale = "('new','active','waiting','paused','stale')";
  if (type === "chat") {
    if (v === "false_positive" || v === "ignore") {
      db.prepare("UPDATE opportunities SET status='ignored', updated_ts=? WHERE chat=? AND status IN " + openList).run(nowMs, value);
    } else if (v === "low_priority") {
      db.prepare("UPDATE opportunities SET priority=MIN(priority,1), priority_locked=1, updated_ts=? WHERE chat=? AND status IN " + openList).run(nowMs, value);
    } else if (v === "confirmed") {
      db.prepare("UPDATE opportunities SET priority=MAX(priority,5), updated_ts=? WHERE chat=? AND status IN " + openList).run(nowMs, value);
    }
  } else if (type === "opportunity") {
    const byId = /^\d+$/.test(value);
    const clause = byId ? "id=?" : "key=?";
    const lookup = byId ? Number(value) : value;
    if (v === "false_positive" || v === "ignore") {
      db.prepare(
        "UPDATE opportunities SET status='ignored', last_reviewed_at=?, updated_ts=? WHERE " + clause + " AND status IN " + withStale,
      ).run(nowMs, nowMs, lookup);
    } else if (v === "low_priority") {
      db.prepare(
        "UPDATE opportunities SET priority=MIN(priority,1), priority_locked=1, last_reviewed_at=?, updated_ts=? WHERE " + clause + " AND status IN " + withStale,
      ).run(nowMs, nowMs, lookup);
    } else if (v === "confirmed") {
      db.prepare(
        "UPDATE opportunities SET type='opportunity', confidence='confirmed', priority=MAX(priority,5), expires_at=NULL, last_reviewed_at=?, updated_ts=? WHERE " +
          clause +
          " AND status IN " +
          withStale,
      ).run(nowMs, nowMs, lookup);
    }
  }
  return Number(info.lastInsertRowid);
}

export function listFeedback({ targetType, limit = 50 } = {}) {
  ensureOpportunitySchema();
  const db = store();
  const args = [];
  let where = "";
  if (targetType) {
    where = " WHERE target_type=?";
    args.push(String(targetType));
  }
  args.push(Math.max(1, Number(limit) || 50));
  return db
    .prepare("SELECT * FROM feedback" + where + " ORDER BY id DESC LIMIT ?")
    .all(...args)
    .map((r) => ({
      id: Number(r.id),
      target_type: r.target_type,
      target: r.target,
      verdict: r.verdict,
      verdict_label: { confirmed: "已确认", false_positive: "误报", ignore: "忽略", low_priority: "低优先级" }[r.verdict] || r.verdict,
      note: r.note || "",
      created_ts: Number(r.created_ts),
      created_at: fmtLocal(new Date(Number(r.created_ts))),
    }));
}

export function deleteOpportunity(id) {
  ensureOpportunitySchema();
  const db = store();
  tx(db, () => {
    db.prepare("DELETE FROM opportunity_events WHERE opp_id=?").run(Number(id));
    db.prepare("DELETE FROM opportunities WHERE id=?").run(Number(id));
  });
  return true;
}
