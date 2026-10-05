// 回复草稿与语气学习：先判断“要不要回”，再从本人本地样本学长度/语气
// 对应上游 references/reply-style.md 与 intelligence_views.py 的 _summarize_reply_style / _reply_draft。
// 隐私：只保留聚合指标，不把私聊原文复制到报告或外部系统。
import { store, rowToMessage } from "./store.mjs";
import { isOwnerName, loadProfile } from "./profile.mjs";
import { classifyChat } from "./signals.mjs";
import { clamp, truncate, uniq } from "./util.mjs";

export const ATTACHMENT_ONLY = /^\[[^\]]{1,12}\]$/;
const URL_ONLY = /^(https?:\/\/|www\.)/i;
const MAX_SAMPLE_CHARS = 500;

/** 关系语域（对应上游 _reply_relationship，收敛为 6 类） */
export const RELATIONSHIPS = ["亲近朋友", "熟人/同辈", "熟悉的合作对象", "新商务联系人", "客户/上级/老师", "群聊"];

export const REPLY_CLOSE_TERMS = /(?:bro|bros?|hhh?)|兄弟|哥们|宝宝|宝贝|好滴|好叭|捏|哈哈|～|~|\[(?:旺柴|破涕为笑|社会社会|狗头|裂开)\]/i;
export const REPLY_PROFESSIONAL_TERMS = /老师|您好|辛苦|合作|报价|预算|brief|交付|排期|审核|结算|付款|发票|项目/i;
export const REPLY_CLOSURE_TERMS = /^(?:好|好的|好滴|行|可以|收到|明白|了解|ok|嗯+|谢谢|辛苦|哈哈+|hhh+|\[(?:表情|图片)\])[。！!～~ ]*$/i;
export const REPLY_ADVICE_TERMS = /建议|我觉得|最好|可以.{0,12}(?:精简|优化|调整)|对你.{0,12}(?:有用|有帮助|比较好)/i;
/** 客户/上级/老师语域信号：对方用敬语或称呼老师 */
export const REPLY_CLIENT_TERMS = /您|贵司|贵公司|麻烦您|请教|老师您好|辛苦老师/i;

/** 明确禁止的模板腔（生成后会被剔除） */
export const BANNED_TEMPLATES = ["老师你好，收到", "我会结合前面的上下文", "为了避免口径偏差", "有需要补充的信息我会集中列出"];

const LAUGH_PATTERNS = [
  ["hhh", /h{3,}/i],
  ["hh", /(?<!h)hh(?!h)/i],
  ["哈哈哈", /哈哈哈+/],
  ["哈哈", /(?<!哈)哈哈(?!哈)/],
];
const ACK_PATTERNS = [
  ["好滴", /(?:^|[，,。\s])好滴(?:$|[呀啊哈～~！!，,。\s])/i],
  ["好嘞", /(?:^|[，,。\s])好嘞(?:$|[呀啊哈～~！!，,。\s])/i],
  ["好的", /(?:^|[，,。\s])好的(?:$|[呀啊哈～！!，,。\s])/],
  ["收到", /(?:^|[，,。\s])收到(?:$|[呀啊哈～~！!，,。\s])/],
  ["ok", /(?:^|\s)ok(?:$|[呀啊哈～~！!，,。\s])/i],
  ["嗯嗯", /(?:^|[，,。\s])嗯嗯(?:$|[呀啊哈～~！!，,。\s])/],
  ["行", /(?:^|[，,。\s])行(?:$|[呀啊哈～~！!，,。\s])/],
];
const ADDRESS_TERMS = ["老师", "老板", "兄弟", "哥们", "宝子", "亲", "大佬", "同学", "哥", "姐", "总", "您"];

/** 本人称呼集合：显式传入 > profile.owner_aliases > 通用“我” */
export function resolveSelfNames(selfNames) {
  const explicit = (selfNames || []).map((s) => String(s).trim()).filter(Boolean);
  if (explicit.length) return uniq(["我", "自己", "本人", ...explicit]);
  const aliases = (loadProfile().owner_aliases || []).map((s) => String(s).trim()).filter(Boolean);
  return uniq(["我", "自己", "本人", ...aliases]);
}

export function isSelfSender(sender, selfNames) {
  const s = String(sender || "").trim();
  if (!s) return false;
  if (/^(我|自己|本人|me|ME|Me)$/.test(s)) return true;
  const names = selfNames || resolveSelfNames();
  return names.some((n) => n && (s === n || s.includes(n)));
}

function isLearnableText(content) {
  const text = String(content == null ? "" : content).trim();
  if (!text) return false;
  if (text.length > MAX_SAMPLE_CHARS) return false;
  if (ATTACHMENT_ONLY.test(text)) return false;
  if (URL_ONLY.test(text)) return false;
  if (/^\[(?:图片|文件|语音|视频|链接|位置|表情)\]/.test(text)) return false;
  if (/^(?:转发了|以下是转发|Forwarded)/.test(text)) return false;
  return true;
}

function charLength(text) {
  return [...String(text == null ? "" : text)].length;
}
function hanLength(text) {
  return (String(text == null ? "" : text).match(/[\u4e00-\u9fff]/g) || []).length;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.round((ordered.length - 1) * p)));
  return ordered[index];
}
function median(values) {
  return percentile(values, 0.5);
}

function preferredToken(texts, patterns) {
  const hits = [];
  for (const text of texts) {
    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) hits.push(label);
    }
  }
  if (!hits.length) return "";
  const counts = new Map();
  const lastSeen = new Map();
  hits.forEach((token, index) => {
    counts.set(token, (counts.get(token) || 0) + 1);
    lastSeen.set(token, index);
  });
  let best = "";
  let bestScore = [-1, -1];
  for (const [token, count] of counts) {
    const score = [count, lastSeen.get(token) || 0];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = token;
      bestScore = score;
    }
  }
  return best;
}

function summarizeShape(texts) {
  const clean = texts.map((t) => String(t).trim()).filter(Boolean);
  const lengths = clean.map(charLength);
  const total = clean.length || 1;
  const lines = clean.map((t) => t.split(/\r?\n/).filter((x) => x.trim()).length || 1);
  return {
    messages: clean.length,
    medianLen: median(lengths),
    p80Chars: percentile(lengths, 0.8),
    pctUnder20: clean.length ? Math.round((100 * clean.filter((t) => charLength(t) <= 20).length) / total) : 0,
    pctMultiline: clean.length ? Math.round((100 * clean.filter((t) => t.includes("\n")).length) / total) : 0,
    pctFinalPeriod: clean.length ? Math.round((100 * clean.filter((t) => /[。.]$/.test(t)).length) / total) : 0,
    medianLines: median(lines),
    preferredAck: preferredToken(clean, ACK_PATTERNS),
    preferredLaugh: preferredToken(clean, LAUGH_PATTERNS),
  };
}

function chatRows(chatName, { limit = 200, sinceMs, untilMs, order = "asc" } = {}) {
  const where = ["session_name=?"];
  const args = [String(chatName)];
  if (sinceMs) {
    where.push("ts>=?");
    args.push(Number(sinceMs));
  }
  if (untilMs) {
    where.push("ts<=?");
    args.push(Number(untilMs));
  }
  args.push(Math.max(1, Number(limit) || 200));
  return store()
    .prepare("SELECT * FROM messages WHERE " + where.join(" AND ") + " ORDER BY ts " + (order === "desc" ? "DESC" : "ASC") + " LIMIT ?")
    .all(...args)
    .map(rowToMessage);
}

/** 按名字解析会话（精确优先，其次唯一模糊匹配） */
export function resolveChatName(query) {
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new Error("请提供联系人或会话名称");
  const db = store();
  const rows = db
    .prepare("SELECT session_name AS name, COUNT(*) AS n, MAX(ts) AS last_ts FROM messages WHERE session_name LIKE ? GROUP BY session_name ORDER BY last_ts DESC LIMIT 12")
    .all("%" + q + "%");
  if (!rows.length) throw noSessionError(db, q);
  const exact = rows.filter((r) => String(r.name).toLowerCase() === q.toLowerCase());
  if (exact.length) return String(exact[0].name);
  const exactLoose = rows.filter((r) => String(r.name).replace(/\s+/g, "") === q.replace(/\s+/g, ""));
  if (exactLoose.length) return String(exactLoose[0].name);
  if (rows.length === 1) return String(rows[0].name);
  throw new Error("“" + q + "”匹配多个会话，请使用更完整的名字：" + rows.slice(0, 8).map((r) => r.name).join("、"));
}

/** 找不到会话时，区分「完全不存在」与「是发送者但没有同名会话」，给出可执行的下一步。
 *  带 code='no_session' 标记，供 resolvePerson 判定是否走发送者回退（不依赖错误文案）。 */
function noSessionError(db, q) {
  const senders = db
    .prepare("SELECT sender AS name, COUNT(*) AS n FROM messages WHERE sender LIKE ? GROUP BY sender ORDER BY n DESC LIMIT 12")
    .all("%" + q + "%");
  const hit = senders.find((r) => String(r.name).toLowerCase() === q.toLowerCase())
    ?? senders.find((r) => String(r.name).replace(/\s+/g, "") === q.replace(/\s+/g, ""))
    ?? (senders.length === 1 ? senders[0] : null);
  const e = hit
    ? new Error("「" + q + "」是消息发送者但没有同名会话（出现 " + hit.n + " 条）。按会话查询请用群名/私聊会话名；查这个人说过什么用 wai_chat_search 或 wai_topic，查联系人档案用 wai_person（支持按发送者建档）。")
    : new Error("情报库里找不到联系人或会话：" + q);
  e.code = "no_session";
  return e;
}

/**
 * 按名字解析「人或会话」：先按会话名解析（精确 → 松散精确 → 唯一模糊），
 * 没有会话时回退按发送者解析（同名唯一命中）。返回 { name, by }：
 * by='session' 表示 name 是会话名，by='sender' 表示 name 是跨会话的发送者。
 * 仍然找不到（或模糊命中多个）时抛出可执行的错误信息。
 */
export function resolvePerson(query) {
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new Error("请提供联系人或会话名称");
  try {
    return { name: resolveChatName(q), by: "session" };
  } catch (e) {
    if (e?.code !== "no_session") throw e; // 多会话命中等歧义错误照常上抛，不做发送者回退
  }
  const db = store();
  const rows = db
    .prepare("SELECT sender AS name, COUNT(*) AS n, MAX(ts) AS last_ts FROM messages WHERE sender LIKE ? GROUP BY sender ORDER BY last_ts DESC LIMIT 12")
    .all("%" + q + "%");
  const exact = rows.filter((r) => String(r.name).toLowerCase() === q.toLowerCase());
  if (exact.length) return { name: String(exact[0].name), by: "sender" };
  const exactLoose = rows.filter((r) => String(r.name).replace(/\s+/g, "") === q.replace(/\s+/g, ""));
  if (exactLoose.length) return { name: String(exactLoose[0].name), by: "sender" };
  if (rows.length === 1) return { name: String(rows[0].name), by: "sender" };
  if (rows.length > 1) throw new Error("“" + q + "”匹配多个发送者，请使用更完整的名字：" + rows.slice(0, 8).map((r) => r.name).join("、"));
  throw new Error("情报库里找不到联系人或会话：" + q);
}

/**
 * 全局风格：只统计本人跨联系人私聊文本，只输出长度/分段/标点等聚合指标。
 * samples 也是聚合样本（字数/行数/是否句号结尾），不含原文，避免私聊内容外泄。
 */
export function learnStyle({ now = new Date(), styleDays = 30, selfNames } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const days = Math.max(1, Number(styleDays) || 30);
  const sinceMs = nowMs - days * 86400000;
  const names = resolveSelfNames(selfNames);
  const rows = store()
    .prepare("SELECT * FROM messages WHERE ts>=? AND ts<=? ORDER BY ts ASC")
    .all(sinceMs, nowMs)
    .map(rowToMessage);

  const texts = [];
  const chats = new Set();
  for (const m of rows) {
    const kind = m.session_kind === "group" ? "group" : classifyChat(m.session_name);
    if (kind === "group") continue;
    if (!(m.is_owner || isSelfSender(m.sender, names))) continue;
    if (!isLearnableText(m.content)) continue;
    const text = String(m.content).trim();
    texts.push(text);
    chats.add(m.session_name);
  }
  const shape = summarizeShape(texts);
  const samples = texts.slice(-12).map((t) => ({
    chars: charLength(t),
    lines: t.split(/\r?\n/).filter((x) => x.trim()).length || 1,
    endsWithPeriod: /[。.]$/.test(t),
    hasLaugh: LAUGH_PATTERNS.some(([, re]) => re.test(t)),
  }));
  return {
    window_days: days,
    sinceMs,
    untilMs: nowMs,
    medianLen: shape.medianLen,
    pctUnder20: shape.pctUnder20,
    punctuation: {
      pctFinalPeriod: shape.pctFinalPeriod,
      preferredAck: shape.preferredAck,
      preferredLaugh: shape.preferredLaugh,
    },
    paragraphing: {
      pctMultiline: shape.pctMultiline,
      medianLines: shape.medianLines,
      p80Chars: shape.p80Chars,
    },
    samples,
    messages: shape.messages,
    chats: chats.size,
    note: shape.messages ? "" : "尚未识别到本人私聊样本：请先在 profile 里配置 owner_aliases（本人微信昵称），样本不足时只给中性草稿。",
  };
}

/**
 * 当前会话风格：本人消息不足 minimumChatMessages 条时 laugh=null，
 * 且不迁移他人的确认词/笑声/称呼/英文习惯。
 */
export function learnChatStyle(chatName, { selfNames, minimumChatMessages = 5, limit = 200 } = {}) {
  const names = resolveSelfNames(selfNames);
  const chat = resolveChatName(chatName);
  const messages = chatRows(chat, { limit });
  const selfTexts = messages
    .filter((m) => m.is_owner || isSelfSender(m.sender, names))
    .map((m) => String(m.content || ""))
    .filter(isLearnableText);
  const enough = selfTexts.length >= Math.max(1, Number(minimumChatMessages) || 5);
  const shape = summarizeShape(enough ? selfTexts : []);
  const englishMix = enough
    ? Math.round((100 * selfTexts.filter((t) => /[A-Za-z]{2,}/.test(t)).length) / selfTexts.length)
    : 0;
  return {
    chat,
    count: selfTexts.length,
    minimumChatMessages: Math.max(1, Number(minimumChatMessages) || 5),
    enough,
    laugh: enough ? shape.preferredLaugh || null : null,
    ack: enough ? shape.preferredAck || null : null,
    addressTerms: enough ? ADDRESS_TERMS.filter((term) => selfTexts.some((t) => t.includes(term))).slice(0, 4) : [],
    englishMix,
    pctUnder20: enough ? shape.pctUnder20 : 0,
    medianLen: enough ? shape.medianLen : 0,
    relationship: inferRelationship(messages, { selfNames: names }),
    note: enough ? "" : "本人消息不足 " + Math.max(1, Number(minimumChatMessages) || 5) + " 条：不迁移他人习惯，只给中性草稿。",
  };
}

/** 关系语域推断 */
export function inferRelationship(messages, { selfNames } = {}) {
  const names = resolveSelfNames(selfNames);
  const rows = (messages || []).filter((m) => m && String(m.sender || "") !== "系统");
  if (!rows.length) return "熟人/同辈";
  const isGroup = rows.some((m) => m.session_kind === "group") || classifyChat(rows[0].session_name || rows[0].chat || "") === "group";
  if (isGroup) return "群聊";
  const selfTexts = rows.filter((m) => m.is_owner || isSelfSender(m.sender, names)).map((m) => String(m.content || ""));
  const otherTexts = rows.filter((m) => !(m.is_owner || isSelfSender(m.sender, names))).map((m) => String(m.content || ""));
  const own = selfTexts.slice(-80).join(" ");
  const mutual = [...selfTexts.slice(-40), ...otherTexts.slice(-40)].join(" ");
  const close = REPLY_CLOSE_TERMS.test(mutual);
  const professional = REPLY_PROFESSIONAL_TERMS.test(own);
  const clientish = otherTexts.slice(-40).some((t) => REPLY_CLIENT_TERMS.test(t)) && /老师|合作|报价|预算|项目|培训/i.test(mutual);
  if (close && professional) return "熟悉的合作对象";
  if (close) return "亲近朋友";
  if (clientish) return "客户/上级/老师";
  if (professional) return rows.length >= 20 ? "熟人/同辈" : "新商务联系人";
  if (rows.length < 12) return "熟人/同辈";
  return "熟人/同辈";
}

/** 回复意图识别（对应上游 _reply_intent） */
export function replyIntent(latestContent, stage) {
  const text = String(latestContent == null ? "" : latestContent);
  const stageText = String(stage == null ? "" : stage);
  if (/结算|付款|打款|发票|invoice|payment|尾款/i.test(text)) return "settlement";
  if (/审核|修改|反馈|review/i.test(text)) return "review";
  if (/报价|预算|费用|价格|quote|rate|多少钱|怎么收费/i.test(text)) return "quote";
  if (/brief|需求|要求|交付|素材|卖点/i.test(text)) return "brief";
  if (/排期|发布时间|什么时候|日期|提交|交稿|初稿|二稿|终稿|deadline/i.test(text)) return "schedule";
  if (charLength(text.trim()) <= 8) {
    if (/结算|付款|发票/i.test(stageText)) return "settlement";
    if (/审核|修改/i.test(stageText)) return "review";
    if (/报价|预算/i.test(stageText)) return "quote";
  }
  return "general";
}

export const INTENT_LABELS = {
  settlement: "结算/付款",
  review: "修改反馈",
  quote: "报价",
  brief: "需求/brief",
  schedule: "排期/时间",
  advice: "建议反馈",
  general: "一般沟通",
};

function fitBudget(text, budget) {
  const value = String(text || "").trim();
  if (hanLength(value) <= budget) return value;
  const parts = value.split(/(?<=[。！？~～!?])/);
  let out = "";
  for (const part of parts) {
    if (hanLength(out + part) > budget) break;
    out += part;
  }
  if (!out) out = [...value].slice(0, Math.max(8, budget)).join("");
  return out.trim();
}

function stripBanned(text) {
  let out = String(text || "");
  for (const bad of BANNED_TEMPLATES) out = out.split(bad).join("");
  return out.replace(/\s{2,}/g, " ").trim();
}

/** 事实门禁：金额/日期/交付范围/授权/付款状态必须来自原文或用户确认 */
function collectFacts(messages) {
  const texts = (messages || []).map((m) => String(m.content || ""));
  const blob = texts.join(" ");
  return {
    amounts: uniq(blob.match(/\d[\d,]*(?:\.\d+)?\s*(?:USD|AUD|RMB|CNY|元|万|块|k|K|美元|刀)|[$￥¥]\s*\d[\d,]*/g) || []),
    hasDate: /\d{1,2}\s*[-/.月]\s*\d{1,2}|周[一二三四五六日天]|今天|明天|后天|本周|下周|月底|\d{4}-\d{1,2}-\d{1,2}/.test(blob),
    hasQuote: /报价|预算|费用|价格|多少钱|怎么收费|quote/i.test(blob),
    hasScope: /交付|初稿|二稿|终稿|素材|大纲|范围|brief|需求/i.test(blob),
    hasAuth: /授权|转载|署名|版权|独家|授权范围/i.test(blob),
    hasPayment: /结算|付款|打款|发票|尾款|invoice|payment/i.test(blob),
    hasPublish: /发布|上线|排期|发布时间/i.test(blob),
  };
}

/**
 * 生成一条回复草稿（1-2 个微信气泡）。
 * 先判断是否需要回复：本人最后发言 ⇒ 不用再回；对方只是 ACK/结束语 ⇒ 无需回复。
 * 不生成三套模板；只有存在两个实质不同的决策时才给一条备选。
 */
export function draftReply(chatName, { messages, style, chatStyle, opportunities, openPromise } = {}) {
  const names = resolveSelfNames();
  const chat = chatName ? String(chatName) : "";
  const rows = (messages && messages.length ? messages : chat ? chatRows(chat, { limit: 120 }) : []).filter(
    (m) => m && String(m.sender || "") !== "系统",
  );
  const shape = style || { medianLen: 0, pctUnder20: 0, punctuation: {}, paragraphing: {} };
  const session = chatStyle || (chat ? learnChatStyle(chat, { selfNames: names }) : { count: 0, laugh: null, relationship: "熟人/同辈" });
  const opportunity = (opportunities || []).find((o) => o && (!chat || String(o.chat || "").includes(chat))) || (opportunities || [])[0] || null;
  const stage = opportunity ? String(opportunity.stage || "") : "";
  const relationship = session.relationship || inferRelationship(rows, { selfNames: names });

  const latestOverall = rows.length ? rows[rows.length - 1] : null;
  const ownerSentLast = Boolean(latestOverall && (latestOverall.is_owner || isSelfSender(latestOverall.sender, names)));
  const incoming = rows.filter((m) => !(m.is_owner || isSelfSender(m.sender, names)));
  const latestIncoming = incoming.length ? incoming[incoming.length - 1] : null;
  const closure = Boolean(latestIncoming && REPLY_CLOSURE_TERMS.test(String(latestIncoming.content || "").trim()));
  const advice = Boolean(latestIncoming && REPLY_ADVICE_TERMS.test(String(latestIncoming.content || "")));

  const base = {
    chat,
    relationship,
    intent: latestIncoming ? (advice ? "advice" : replyIntent(latestIncoming.content, stage)) : "general",
    hasIncoming: Boolean(latestIncoming),
    hasOpportunity: Boolean(opportunity),
    style,
    chatStyle: session,
    ownerSentLast,
  };

  if (!latestIncoming) {
    return {
      ...base,
      needed: false,
      reason: "当前会话没有需要回应的对方消息。",
      draft: "",
      bubbles: [],
      judgment: relationship + " · 暂无来消息",
      factsToConfirm: [],
    };
  }
  if (ownerSentLast) {
    return {
      ...base,
      needed: false,
      reason: "不用再回。你已经发过消息，等对方下一条。",
      draft: "",
      bubbles: [],
      judgment: relationship + " · " + INTENT_LABELS[base.intent] + " · 本人最后发言",
      factsToConfirm: [],
    };
  }
  if (closure) {
    return {
      ...base,
      needed: false,
      reason: "对方只是确认或收尾，不用特意回；熟人的话补个表情即可。",
      draft: "",
      bubbles: [],
      judgment: relationship + " · " + INTENT_LABELS[base.intent] + " · 无需追发",
      factsToConfirm: [],
    };
  }

  const close = relationship === "亲近朋友" || relationship === "熟悉的合作对象";
  const laugh = session.enough && close && session.laugh ? session.laugh : "";
  const ack = session.enough && session.ack ? session.ack : "";
  const casualAck = ack && ["好滴", "好嘞", "ok", "嗯嗯", "行"].includes(ack) ? ack : "收到";
  const neutralAck = ack && ["好的", "收到", "ok"].includes(ack) ? ack : "收到";
  const latestText = String(latestIncoming.content || "");

  let bubbles = [];
  let alternatives = [];
  if (advice) {
    bubbles = [close ? "有道理，我后面说人话点" + (laugh || "哈哈") : "有道理，我后面再精简一点"];
  } else if (base.intent === "settlement") {
    bubbles = [close ? "我核对下结算信息，确认后跟你说" : neutralAck + "，我核对下结算信息，确认后回复你"];
  } else if (base.intent === "review") {
    bubbles = [close ? casualAck + "，我按反馈改，改完发你" : neutralAck + "，我按反馈修改，完成后发你审核"];
  } else if (base.intent === "quote") {
    bubbles = [close ? "报价我整理一版给你，先确认下大概数量" : "报价我整理一版给你，麻烦先确认交付形式和大概数量"];
    alternatives = [
      {
        draft: close ? "前面是单条价，批量可以按数量重算" : "前面是单条定制价；批量可以按数量重算，麻烦先确认大概几条",
        when: "原文里已经有明确单条报价时",
      },
    ];
  } else if (base.intent === "brief") {
    bubbles = [close ? casualAck + "，我先看下，缺什么一起问你" : neutralAck + "，我先核对需求，缺的信息我集中确认"];
  } else if (base.intent === "schedule") {
    bubbles = [close ? "我看下现在的进度，确认后给你时间" : "我先核对进度，确认后给你具体时间"];
  } else {
    bubbles = [close ? "看到了，我确认下再跟你说" : neutralAck + "，我确认后回复你"];
  }

  // 长度约束：默认 ≤50 个汉字；滚动样本更长时以样本为准
  const median = Number(shape.medianLen) || 0;
  const budget = median > 50 ? clamp(Math.round(median * 1.5), 50, 120) : 50;
  bubbles = uniq(bubbles.map((b) => stripBanned(fitBudget(b, budget))).filter(Boolean)).slice(0, 2);
  alternatives = alternatives
    .map((alt) => ({ ...alt, draft: stripBanned(fitBudget(alt.draft, budget)) }))
    .filter((alt) => alt.draft && !bubbles.includes(alt.draft));

  const draft = bubbles.join("\n");

  // 事实门禁
  const facts = collectFacts(rows);
  const factsToConfirm = [];
  if (facts.hasQuote && !/\d/.test(draft)) factsToConfirm.push("报价/预算金额：原文未给出可直接引用的数字，需要你确认后再发。");
  if (facts.hasDate) factsToConfirm.push("具体日期或排期：草稿未承诺时间，回复前确认可执行的日期。");
  if (facts.hasScope) factsToConfirm.push("交付范围与交付形式：以原文的 brief/需求为准，不要自行扩大。");
  if (facts.hasAuth) factsToConfirm.push("授权范围（转载、署名、独家期）：必须来自原文或对方确认。");
  if (facts.hasPayment) factsToConfirm.push("付款或结算状态：用于结算材料核对，未核对前不要确认「已结算」。");
  if (facts.hasPublish && !facts.hasDate) factsToConfirm.push("发布时间：需要对方或你确认后再回复。");
  if (openPromise) factsToConfirm.push("此前承诺的完成状态：" + String(openPromise.content || openPromise.action || "").slice(0, 60) + "（先完成再同步，不用只回客套话）。");
  const draftNumbers = draft.match(/\d[\d,]*(?:\.\d+)?/g) || [];
  for (const n of draftNumbers) {
    if (!latestText.includes(n) && !facts.amounts.some((a) => a.includes(n))) {
      factsToConfirm.push("草稿中的数字 " + n + " 未在原文出现，需要你先确认。");
    }
  }

  return {
    ...base,
    needed: true,
    reason: "对方最后一条需要回应：" + truncate(latestText.replace(/\s+/g, " "), 60),
    draft,
    bubbles,
    alternatives,
    judgment:
      relationship +
      " · " +
      INTENT_LABELS[base.intent] +
      " · 需要回复" +
      (opportunity ? " · 商机 #" + opportunity.id + "｜" + (opportunity.stage || "") : "") +
      (shape.pctUnder20 ? " · 近 " + (shape.window_days || 30) + " 天 " + shape.pctUnder20 + "% 的私聊不超过 20 字" : ""),
    factsToConfirm: uniq(factsToConfirm),
    budget,
  };
}
