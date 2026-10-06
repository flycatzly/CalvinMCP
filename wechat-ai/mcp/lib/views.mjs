// 分析视图：联系人档案 / 主题检索 / 今日行动 / 待分流 / 联系人日报 / 共同群 / 跨群链接 / 商单雷达 / 首页
// 对应上游 intelligence_views.py + wechat_intelligence_hub.py 的 build_contact_daily_rows 等视图。
// 全部视图复用 store()（node:sqlite 本地索引）与 signals.mjs（情报引擎），不重复实现信号规则。
import { store, rowToMessage, messagesInWindow, messagesForAnalyze, listSessions, labelsOf, storeStats, crossGroupLinks as storeCrossGroupLinks, linkAppearances } from "./store.mjs";
import { analyze, classifyChat, extractAmounts, extractDueDates, isAck, isClosing, isOwnerName } from "./signals.mjs";
import { freshness } from "./ingest.mjs";
import { listInbox, listOpportunities, listToday, countByStatus, countInbox, countToday } from "./opportunities.mjs";
import { draftReply, learnChatStyle, learnStyle, resolveChatName, resolvePerson, resolveSelfNames, isSelfSender } from "./replystyle.mjs";
import { loadProfile } from "./profile.mjs";
import { clamp, extractUrls, fmtDay, fmtLocal, isHeatLink, normalizeUrl, truncate, truncateOutsideUrl, uniq } from "./util.mjs";

// ---------------- 词表（参照上游 intelligence_views.py） ----------------
export const COMMERCIAL_TERMS = /合作|商单|推广|投放|品牌|报价|预算|brief|排期|发布|审核|结算|付款|培训|讲师|授课|工作坊|咨询|项目|招募|佣金|返佣|campaign|sponsor|invoice|payment/i;
export const REQUEST_TERMS = /请问|麻烦|方便|能否|可以吗|什么时候|确认一下|发我|给我|回复|报价|预算|价位|价格|费用|多少钱|怎么收费|多少(?:呢|钱)?|大致.{0,8}(?:价|费用)|brief|排期/i;
export const PROMISE_TERMS = /我(?:会|来|可以|今晚|明天|之后|稍后|回头).{0,32}(?:整理|确认|回复|发|给|做|改|补|推进|安排|加热|转发|quote|联系|提交|发布|完成|跟进|回传)|(?:整理好|写好|改好|确认后).{0,16}(?:发你|给你|回复你)|(?:今天|明天|后天|周[一二三四五六日天]|本周|下周).{0,24}(?:给|发|提交|发布|完成|安排|回传)|(?:可以|能).{0,12}(?:给|发|提交).{0,12}(?:初稿|二稿|终稿|方案|数据)/i;
export const PROMISE_COMPLETION_TERMS = /(?:已经|已)(?:完成|安排|提交|发送|发给|发布|联系|转发|加热|回传)|(?:完成|安排|提交|发送|发布|联系|转发|加热|回传)(?:了|好啦|好了)|(?:初稿|二稿|终稿|数据|链接).{0,12}(?:发你|给你|已发|提交)/i;
export const POST_PUBLISH_ACTION_TERMS = /浏览量.{0,16}(?:低|少|只有)|增加.{0,16}曝光|补(?:量|曝光|互动)|找.{0,16}(?:KOL|博主|达人).{0,16}(?:转发|加热)|(?:KOL|博主|达人).{0,16}(?:转发|加热)|多\s*quote|数据统计.{0,16}(?:发布后|天|截止)|数据回传|回传数据/i;

export const TOPIC_EXPANSIONS = {
  培训: ["培训", "讲师", "授课", "工作坊", "课程", "教练"],
  赚钱: ["赚钱", "变现", "收入", "报价", "预算", "佣金", "付费", "项目合作"],
  商单: ["商单", "品牌合作", "推广", "投放", "campaign", "sponsor", "brief"],
  结算: ["结算", "付款", "打款", "到账", "发票", "invoice", "payment"],
};

export const CONTACT_ACK_TERMS = /^(?:(?:好(?:的|呀|滴)?|收到|明白|嗯嗯|没问题|可以|谢谢(?:老师)?|辛苦(?:老师)?了?|不客气)[呀啊哈啦~～，,、。！!\s]*)+$/i;
export const CONTACT_REPLY_REQUEST_TERMS = /请问|麻烦|方便|能否|可以吗|怎么|多少|什么时候|哪天|确认一下|回复一下|发我|给我|报价|预算|费用|价格|brief|排期|初稿|二稿|终稿|审核|修改|结算|付款|发票|invoice|payment|\?|？/i;
export const CONTACT_STATUS_LABELS = {
  待兑现: "待兑现（先完成再回）",
  待回复: "待回复（等你回应）",
  等待对方: "等待对方（不追发）",
  留意: "留意",
  无需立即回复: "无需立即回复",
};
export const CONTACT_STATUS_RANK = { 待兑现: 5, 待回复: 4, 等待对方: 3, 留意: 2, 无需立即回复: 1 };
export const CONTACT_DIRECTIONS = {
  settlement: "先核对发布与结算材料，直接回复缺什么、何时可以补齐。",
  review: "直接确认修改范围和下一版时间，不重复介绍背景。",
  quote: "先回答报价问题；只补问缺失的交付形式、授权范围和排期。",
  brief: "确认已收到需求，集中列出待确认项并给出下一节点。",
  schedule: "给明确可执行日期；暂时不能确认时，说明最晚何时回准信。",
  request: "先直接回答对方最后一个问题，再补一句明确的下一步。",
  general: "承接对方最新内容并推进到下一节点；没有新信息时不要为了回复而回复。",
};

/** 回复方向：结算 → 审核 → 报价 → brief → 排期 → 一般请求 → 兜底（顺序与上游一致） */
export function contactReplyDirection(content, stage) {
  const text = String((content == null ? "" : content) + " " + (stage == null ? "" : stage));
  if (/结算|付款|打款|发票|invoice|payment/i.test(text)) return CONTACT_DIRECTIONS.settlement;
  if (/审核|修改|反馈|初稿|二稿|终稿/i.test(text)) return CONTACT_DIRECTIONS.review;
  if (/报价|预算|费用|价格|多少/i.test(text)) return CONTACT_DIRECTIONS.quote;
  if (/brief|需求|素材|卖点/i.test(text)) return CONTACT_DIRECTIONS.brief;
  if (/排期|时间|什么时候|哪天|发布/i.test(text)) return CONTACT_DIRECTIONS.schedule;
  if (CONTACT_REPLY_REQUEST_TERMS.test(String(content == null ? "" : content))) return CONTACT_DIRECTIONS.request;
  return CONTACT_DIRECTIONS.general;
}

/** 联系人状态：本人最后发言 ⇒ 等待对方；纯 ACK ⇒ 无需立即回复；有请求或商业上下文 ⇒ 待回复；否则留意 */
export function contactDailyStatus(latest, selfNames, hasCommercialContext) {
  const names = selfNames || resolveSelfNames();
  if (!latest) return { status: "留意", replyDirection: CONTACT_DIRECTIONS.general };
  if (latest.is_owner || isSelfSender(latest.sender, names)) {
    return { status: "等待对方", replyDirection: "暂不追发；若超过约定时间仍无回复，再按商机状态跟进。" };
  }
  const content = String(latest.content || "").trim();
  if (CONTACT_ACK_TERMS.test(content)) {
    return { status: "无需立即回复", replyDirection: "对方只是确认收到；继续完成已经承诺的动作即可。" };
  }
  if (CONTACT_REPLY_REQUEST_TERMS.test(content) || hasCommercialContext) {
    return { status: "待回复", replyDirection: contactReplyDirection(content) };
  }
  return { status: "留意", replyDirection: "先看前后文判断是否需要承接；没有明确问题或动作时可不回复。" };
}

function inferPromiseAction(content) {
  const text = String(content == null ? "" : content);
  if (POST_PUBLISH_ACTION_TERMS.test(text)) return "落实补量、Quote/KOL 转发，并在统计截止前回传新增数据";
  if (/初稿|二稿|终稿|草稿/i.test(text)) return "按承诺时间完成并提交稿件";
  if (/发布|上线/i.test(text)) return "确认发布排期并按时上线";
  if (/联系|转发|加热|quote/i.test(text)) return "完成已承诺的联系、转发或加热动作";
  if (/数据|回传/i.test(text)) return "整理并回传约定数据";
  return "完成这项承诺并向对方同步结果";
}

/** 会话消息（精确匹配会话名） */
function chatMessages(chat, { sinceMs, untilMs, limit = 500, order = "asc" } = {}) {
  const where = ["session_name=?"];
  const args = [String(chat)];
  if (sinceMs) {
    where.push("ts>=?");
    args.push(Number(sinceMs));
  }
  if (untilMs) {
    where.push("ts<=?");
    args.push(Number(untilMs));
  }
  args.push(Math.max(1, Number(limit) || 500));
  return store()
    .prepare("SELECT * FROM messages WHERE " + where.join(" AND ") + " ORDER BY ts " + (order === "desc" ? "DESC" : "ASC") + " LIMIT ?")
    .all(...args)
    .map(rowToMessage);
}

/** 发送者视角取行：没有同名会话的联系人按 sender 跨会话归集（wai_person 建档回退路径） */
function senderMessages(sender, { sinceMs, untilMs, limit = 500, order = "asc" } = {}) {
  const where = ["sender=?"];
  const args = [String(sender)];
  if (sinceMs) {
    where.push("ts>=?");
    args.push(Number(sinceMs));
  }
  if (untilMs) {
    where.push("ts<=?");
    args.push(Number(untilMs));
  }
  args.push(Math.max(1, Number(limit) || 500));
  return store()
    .prepare("SELECT * FROM messages WHERE " + where.join(" AND ") + " ORDER BY ts " + (order === "desc" ? "DESC" : "ASC") + " LIMIT ?")
    .all(...args)
    .map(rowToMessage);
}

function shortText(value, limit) {
  return truncateOutsideUrl(String(value == null ? "" : value).replace(/\s+/g, " ").trim(), limit || 220);
}

function rowBrief(m) {
  return {
    ts: m.ts,
    time: fmtLocal(new Date(m.ts)),
    sender: m.sender,
    is_owner: Boolean(m.is_owner),
    content: shortText(m.content, 240),
  };
}

/**
 * 承诺逾期口径：优先按承诺文本里的到期日判定（与 signals.mjs promises 的 overdue 同源
 * extractDueDates，brief「已逾期」即此口径）；文本无日期可解析时退化为「发出超 3 天未兑现」
 * 兜底（保留本文件原启发式，避免无日期的陈旧承诺永不上榜）。上游 find_open_contact_promise
 * 的精确 overdue 语义待确认。
 */
function promiseOverdue(content, ts, nowMs, delivered = false) {
  if (delivered) return false;
  const due = extractDueDates(String(content ?? ""), new Date(ts))[0] ?? null;
  if (due) return due.date.getTime() < nowMs;
  return nowMs - ts > 3 * 86400000;
}

/**
 * 我答应过的事项：取最后一条本人承诺，若其后有本人完成消息则视为已兑现。
 * 对应上游 find_open_contact_promise / brief_report 的 open_promises 口径。
 */
export function openPromisesOf(messages, { selfNames, lookbackDays = 30, now } = {}) {
  const names = selfNames || resolveSelfNames();
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const sinceMs = nowMs - Math.max(1, lookbackDays) * 86400000;
  const list = (messages || []).filter((m) => m && m.ts >= sinceMs).sort((a, b) => a.ts - b.ts);
  const indexes = [];
  list.forEach((m, index) => {
    if (!(m.is_owner || isSelfSender(m.sender, names))) return;
    if (!PROMISE_TERMS.test(String(m.content || ""))) return;
    indexes.push(index);
  });
  if (!indexes.length) return [];
  const index = indexes[indexes.length - 1];
  const laterSelf = list.slice(index + 1).filter((m) => m.is_owner || isSelfSender(m.sender, names));
  if (laterSelf.some((m) => PROMISE_COMPLETION_TERMS.test(String(m.content || "")))) return [];
  const promise = list[index];
  return [
    {
      chat: promise.session_name,
      ts: promise.ts,
      time: fmtLocal(new Date(promise.ts)),
      content: shortText(promise.content, 220),
      action: inferPromiseAction(promise.content),
      state: "待兑现",
      overdue: promiseOverdue(promise.content, promise.ts, nowMs),
    },
  ];
}

function promiseEntries(messages, { selfNames, now } = {}) {
  const names = selfNames || resolveSelfNames();
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const list = [...(messages || [])].sort((a, b) => a.ts - b.ts);
  // 后缀预计算「其后是否有本人完成消息」，把逐条 slice 后半段的 O(n^2) 收敛为 O(n)
  const n = list.length;
  const laterDelivered = new Array(n + 1).fill(false);
  for (let i = n - 1; i >= 0; i--) {
    const x = list[i];
    const self = x.is_owner || isSelfSender(x.sender, names);
    laterDelivered[i] = laterDelivered[i + 1] || (self && PROMISE_COMPLETION_TERMS.test(String(x.content || "")));
  }
  const out = [];
  list.forEach((m, index) => {
    if (!(m.is_owner || isSelfSender(m.sender, names))) return;
    if (!PROMISE_TERMS.test(String(m.content || ""))) return;
    const delivered = laterDelivered[index + 1];
    out.push({
      chat: m.session_name,
      ts: m.ts,
      time: fmtLocal(new Date(m.ts)),
      content: shortText(m.content, 220),
      action: inferPromiseAction(m.content),
      state: delivered ? "已兑现" : "待兑现",
      overdue: promiseOverdue(m.content, m.ts, nowMs, delivered),
    });
  });
  return out;
}

// ---------------- 联系人档案 ----------------
export function personDossier(name, { sinceMs, untilMs, limit = 500, selfNames, now } = {}) {
  // 先按会话名解析；没有同名会话时回退按发送者跨会话建档（matched_by 标明命中方式）
  const resolved = resolvePerson(name);
  const chat = resolved.name;
  const by = resolved.by;
  const names = resolveSelfNames(selfNames);
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const messages = by === "sender"
    ? senderMessages(chat, { sinceMs, untilMs, limit, order: "asc" })
    : chatMessages(chat, { sinceMs, untilMs, limit, order: "asc" });
  const kind = by === "sender"
    ? "private"
    : messages.length
      ? messages[messages.length - 1].session_kind === "group" || classifyChat(chat) === "group"
        ? "group"
        : "private"
      : classifyChat(chat);
  const owner = messages.filter((m) => m.is_owner || isSelfSender(m.sender, names));
  const others = messages.filter((m) => !(m.is_owner || isSelfSender(m.sender, names)));
  const latest = messages.length ? messages[messages.length - 1] : null;
  const direction = latest ? (latest.is_owner || isSelfSender(latest.sender, names) ? "我最后发出" : "对方最后发来") : "未知";

  const windowSince = sinceMs || (messages.length ? messages[0].ts : nowMs - 30 * 86400000);
  const windowUntil = untilMs || nowMs;
  const analysis = messages.length ? analyze({ messages, sinceMs: windowSince, untilMs: windowUntil, now: new Date(nowMs) }) : null;

  const commercial = messages.filter((m) => COMMERCIAL_TERMS.test(String(m.content || "")));
  const requests = others.filter((m) => REQUEST_TERMS.test(String(m.content || ""))).slice(-5);
  const opportunities = by === "sender"
    ? listOpportunities({ includeCandidates: true, limit: 50 }).filter((o) => String(o.contact || "") === chat || String(o.chat || "") === chat).slice(0, 10)
    : listOpportunities({ chat, includeCandidates: true, limit: 10 });
  const openPromises = openPromisesOf(messages, { selfNames: names, now: nowMs });
  const promises = promiseEntries(messages, { selfNames: names, now: nowMs });
  const deals = messages.filter((m) => m.links && m.links.length).slice(-5);

  return {
    chat,
    kind,
    matched_by: by,
    counts: {
      messages: messages.length,
      owner: owner.length,
      other: others.length,
      senders: uniq(messages.map((m) => m.sender)).length,
      commercial: commercial.length,
      links: deals.length,
      days: messages.length ? Math.max(1, Math.round((messages[messages.length - 1].ts - messages[0].ts) / 86400000)) : 0,
    },
    direction,
    opportunities,
    openPromises,
    promises,
    requests: requests.map(rowBrief),
    timeline: commercial.slice(-8).map(rowBrief),
    recent: messages.slice(-12).map(rowBrief),
    messages,
    analysis_summary: analysis
      ? {
          pendingReplies: analysis.pendingReplies.length,
          deadlines: analysis.deadlines.length,
          settlements: analysis.settlements.length,
          waiting: analysis.waiting.length,
        }
      : null,
    next_action:
      direction === "对方最后发来"
        ? "先回复对方最后一条消息" + (opportunities[0] && opportunities[0].next_action ? "；商机系统建议：" + opportunities[0].next_action : "")
        : opportunities[0] && opportunities[0].next_action
          ? String(opportunities[0].next_action)
          : "人工查看最近上下文",
  };
}

// ---------------- 回复草稿 ----------------
export function replyDraft(name, { limit = 120, styleDays, minimumChatMessages, now } = {}) {
  const chat = resolveChatName(name);
  const profile = loadProfile();
  const names = resolveSelfNames();
  const messages = chatMessages(chat, { limit, order: "asc" });
  const style = learnStyle({
    now: now ? new Date(now) : new Date(),
    styleDays: styleDays || profile.reply_style?.history_days || 30,
    selfNames: names,
  });
  const chatStyle = learnChatStyle(chat, {
    selfNames: names,
    minimumChatMessages: minimumChatMessages || profile.reply_style?.minimum_chat_messages || 5,
  });
  const opportunities = listOpportunities({ chat, includeCandidates: true, limit: 5 });
  const openPromise = openPromisesOf(messages, { selfNames: names, now })[0] || null;
  const result = draftReply(chat, { messages, style, chatStyle, opportunities, openPromise });
  return { chat, ...result };
}

// ---------------- 主题检索 ----------------
export function expandTopicTerms(topic, extraKeywords) {
  const terms = [];
  for (const value of [topic, ...(extraKeywords || [])]) {
    const clean = String(value == null ? "" : value).trim();
    if (!clean) continue;
    const expanded = TOPIC_EXPANSIONS[clean] || [clean];
    for (const term of expanded) {
      if (!terms.some((t) => t.toLowerCase() === term.toLowerCase())) terms.push(term);
    }
  }
  return terms;
}

function dedupeKey(content) {
  const text = String(content == null ? "" : content);
  const urls = extractUrls(text);
  if (urls.length) return "url:" + urls.map((u) => normalizeUrl(u)).sort().join("|");
  return "text:" + text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, "").replace(/[，。！？、；：,.!?:;|｜\-—_#*（）()\[\]【】"'“”‘’]/g, "").slice(0, 100);
}

/** 主题检索是 OR 语义：一个主题展开出的多个词任意命中都算（store.searchMessages 是 AND，不能直接用） */
function searchTopicMessages(terms, { sinceMs, untilMs, limit }) {
  const where = ["(" + terms.map(() => "content LIKE ?").join(" OR ") + ")"];
  const args = terms.map((t) => "%" + String(t) + "%");
  if (sinceMs) {
    where.push("ts>=?");
    args.push(Number(sinceMs));
  }
  if (untilMs) {
    where.push("ts<=?");
    args.push(Number(untilMs));
  }
  args.push(Math.max(1, Number(limit) || 800));
  return store()
    .prepare("SELECT * FROM messages WHERE " + where.join(" AND ") + " ORDER BY ts DESC LIMIT ?")
    .all(...args)
    .map(rowToMessage);
}

export function topicReport(topic, { keywords, sinceMs, untilMs, limitMessages = 800, limitChats = 20, now } = {}) {
  const terms = expandTopicTerms(topic, keywords);
  if (!terms.length) throw new Error("请提供主题或关键词");
  const rows = searchTopicMessages(terms, { sinceMs, untilMs, limit: Math.max(1, Number(limitMessages) || 800) });
  const byChat = new Map();
  let deduped = 0;
  for (const m of rows) {
    if (!byChat.has(m.session_name)) byChat.set(m.session_name, new Map());
    const bucket = byChat.get(m.session_name);
    const key = dedupeKey(m.content);
    if (bucket.has(key)) {
      deduped += 1;
      continue;
    }
    bucket.set(key, m);
  }
  const groups = [...byChat.entries()]
    .map(([chat, bucket]) => {
      const list = [...bucket.values()].sort((a, b) => a.ts - b.ts);
      const commercial = list.filter((m) => COMMERCIAL_TERMS.test(String(m.content || ""))).length;
      const kind = list[list.length - 1].session_kind === "group" || classifyChat(chat) === "group" ? "group" : "private";
      return {
        chat,
        kind,
        kind_label: kind === "group" ? "群聊" : "私聊",
        count: list.length,
        commercial,
        first_ts: list[0].ts,
        last_ts: list[list.length - 1].ts,
        last_time: fmtLocal(new Date(list[list.length - 1].ts)),
        amounts: uniq(list.flatMap((m) => extractAmounts(m.content))),
        timeline: list.map(rowBrief),
      };
    })
    .sort((a, b) => b.commercial - a.commercial || b.count - a.count || b.last_ts - a.last_ts)
    .slice(0, Math.max(1, Number(limitChats) || 20));
  const timeline = groups
    .flatMap((g) => g.timeline.map((t) => ({ ...t, chat: g.chat, kind: g.kind })))
    .sort((a, b) => a.ts - b.ts);
  return {
    topic: String(topic),
    terms,
    sinceMs: sinceMs || 0,
    untilMs: untilMs || Date.now(),
    totals: { messages: rows.length, deduped, chats: byChat.size, shown_chats: groups.length },
    groups,
    timeline,
    note: rows.length ? "" : "没有命中任何消息；可换关键词或扩大时间范围。",
  };
}

// ---------------- 今日行动 ----------------
function priorityOfItem(item) {
  return clamp(Number(item.priority) || 3, 1, 5);
}

export function todayActions({ now = new Date(), minPriority = 3, limit = 10, days = 7 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const sinceMs = nowMs - Math.max(1, Number(days) || 7) * 86400000;
  // 只喂 analyze：走 6 列瘦身行（跳过 attachments 等未消费列的读取与解析）
  const messages = messagesForAnalyze({ sinceMs, untilMs: nowMs, limit: 50000 });
  const analysis = analyze({ messages, sinceMs, untilMs: nowMs, now: new Date(nowMs) });
  const items = [];

  for (const p of analysis.pendingReplies) {
    const ageHours = (nowMs - p.ts) / 3600000;
    items.push({
      kind: "待回复",
      chat: p.chat,
      title: "回复 " + p.chat,
      why: p.reason + "（已 " + Math.round(ageHours) + " 小时）",
      action: contactReplyDirection(p.content),
      due: null,
      priority: ageHours > 24 ? 5 : ageHours > 4 ? 4 : 3,
      ts: p.ts,
      evidence: { ts: p.ts, time: fmtLocal(new Date(p.ts)), sender: p.sender, content: shortText(p.content, 220) },
    });
  }
  for (const p of analysis.promises) {
    if (p.state !== "待兑现") continue;
    items.push({
      kind: "待兑现承诺",
      chat: p.chat,
      title: "兑现对 " + p.chat + " 的承诺",
      why: p.overdue ? "承诺已逾期：" + shortText(p.content, 60) : "承诺尚未兑现：" + shortText(p.content, 60),
      action: inferPromiseAction(p.content),
      due: p.due || null,
      priority: p.overdue ? 5 : 4,
      ts: p.ts,
      evidence: { ts: p.ts, time: fmtLocal(new Date(p.ts)), sender: "本人", content: shortText(p.content, 220) },
    });
  }
  for (const d of analysis.deadlines) {
    items.push({
      kind: "临近截止",
      chat: d.chat,
      title: "截止节点：" + shortText(d.content, 40),
      why: d.overdue ? "已过期（" + (d.due_text || "") + "）" : "还有 " + Math.max(0, d.days_left) + " 天（" + (d.due_text || "") + "）",
      action: "确认交付物状态并给出明确时间；来不及就提前说明。",
      due: d.due || null,
      priority: d.overdue || d.days_left <= 1 ? 5 : d.days_left <= 3 ? 4 : 3,
      ts: d.ts,
      evidence: { ts: d.ts, time: fmtLocal(new Date(d.ts)), sender: d.sender, content: shortText(d.content, 220) },
    });
  }
  for (const s of analysis.settlements) {
    if (!s.pending) continue;
    items.push({
      kind: "待结算",
      chat: s.chat,
      title: "跟进结算：" + s.chat,
      why: "对方最后提到结算/付款（" + (s.terms || []).slice(0, 3).join("、") + "）",
      action: "核对发布与结算材料，直接回复缺什么、何时补齐。",
      due: null,
      priority: 4,
      ts: s.ts,
      evidence: { ts: s.ts, time: fmtLocal(new Date(s.ts)), sender: s.last_sender, content: shortText(s.content, 220) },
    });
  }
  for (const o of listToday({ today: new Date(nowMs), minPriority: 1, limit: Math.max(10, Number(limit) * 2) })) {
    const due = o.next_follow_up ? Date.parse(o.next_follow_up + "T09:00:00") : null;
    items.push({
      kind: "商机跟进",
      chat: o.chat,
      title: "#" + o.id + " " + (o.title || o.chat),
      why: (o.stage || "新线索") + " · 优先级 " + o.priority + (o.next_follow_up ? " · 跟进 " + o.next_follow_up : ""),
      action: o.next_action || "人工确认下一步",
      due,
      priority: clamp(o.priority, 1, 5),
      ts: o.last_signal_time,
      opportunity_id: o.id,
      evidence: { ts: o.last_signal_time, time: o.last_signal_at, sender: null, content: shortText(o.qualification_reasons || o.amount || "", 220) },
    });
  }

  const rankOf = (item) => {
    if (item.kind === "待兑现承诺") return item.why.startsWith("承诺已逾期") ? 0 : 2;
    if (item.kind === "临近截止") return item.why.startsWith("已过期") ? 0 : 3;
    if (item.kind === "待回复") return item.priority >= 5 ? 1 : 2;
    if (item.kind === "待结算") return 3;
    if (item.kind === "商机跟进") return item.due && item.due <= nowMs ? 1 : 2;
    return 4;
  };
  const filtered = items.filter((item) => priorityOfItem(item) >= Number(minPriority || 0));
  filtered.sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      priorityOfItem(b) - priorityOfItem(a) ||
      (a.due || a.ts || 0) - (b.due || b.ts || 0),
  );
  const counts = {};
  for (const item of filtered) counts[item.kind] = (counts[item.kind] || 0) + 1;
  return {
    now: nowMs,
    sinceMs,
    untilMs: nowMs,
    minPriority: Number(minPriority) || 0,
    limit: Math.max(1, Number(limit) || 10),
    counts,
    total: filtered.length,
    items: filtered.slice(0, Math.max(1, Number(limit) || 10)),
  };
}

/** 待分流：新发现的高优先级线索，标注“待审核” */
export function inboxRows({ minPriority = 4, limit = 20 } = {}) {
  const rows = listInbox({ minPriority, limit });
  return rows.map((o) => ({
    ...o,
    review: "待审核",
    why: o.qualification_reasons || "仅有弱上下文，需人工核实",
    action: o.next_action || "人工判断是否值得接",
    evidence_note: "证据 " + o.evidence_count + " 条；强化 " + o.reinforcement_count + " 次",
  }));
}

// ---------------- 联系人日报 ----------------
function matchProfileLabels(chat) {
  const profile = loadProfile();
  const labels = profile.labels || {};
  const all = [...(labels.priority || []), ...(labels.commercial || []), ...(labels.creator || [])];
  const name = String(chat);
  return all.filter((l) => l && name.includes(String(l)));
}

function personalTopicsOf(chat, content) {
  const profile = loadProfile();
  const topics = profile.intelligence_priorities?.custom_topics || {};
  const blob = String(chat) + "\n" + String(content || "");
  const out = [];
  for (const [topic, keywords] of Object.entries(topics)) {
    if ((keywords || []).some((k) => k && blob.includes(String(k)))) out.push(topic);
  }
  const focus = profile.intelligence_priorities?.focus_areas || [];
  const personal = focus.filter((f) => f && !["AI", "商单", "培训", "赚钱", "出海", "产品", "Web3", "合作", "B端AI赋能", "自媒体运营与增长"].includes(f));
  for (const f of personal) if (blob.includes(f)) out.push(f);
  return uniq(out);
}

export function contactDailyRows({ sinceMs, untilMs, contacts, scope, selfNames } = {}) {
  const names = resolveSelfNames(selfNames);
  const profile = loadProfile();
  const contactScope = scope || profile.contact_daily?.scope || "hybrid";
  const until = Number(untilMs) || Date.now();
  const since = Number(sinceMs) || until - 7 * 86400000;
  const wanted = (contacts || []).map((c) => String(c).trim()).filter(Boolean);

  const rows = messagesInWindow({ sinceMs: since, untilMs: until, limit: 100000 });
  const groupNames = new Set(listSessions({ kind: "group", limit: 5000 }).map((s) => s.name));
  const byChat = new Map();
  for (const m of rows) {
    const isGroup = m.session_kind === "group" || groupNames.has(m.session_name) || classifyChat(m.session_name) === "group";
    if (isGroup) continue;
    if (!byChat.has(m.session_name)) byChat.set(m.session_name, []);
    byChat.get(m.session_name).push(m);
  }

  const oppMap = new Map();
  for (const o of listOpportunities({ includeCandidates: true, limit: 1000 })) {
    const key = String(o.chat || "");
    for (const chat of byChat.keys()) {
      if (key && (chat === key || key.includes(chat) || chat.includes(key))) {
        if (!oppMap.has(chat)) oppMap.set(chat, o);
      }
    }
  }

  const out = [];
  for (const [chat, listRaw] of byChat) {
    const list = [...listRaw].sort((a, b) => a.ts - b.ts);
    if (chat === "服务通知") continue;
    if (list.every((m) => String(m.source || "").includes("notifymessage") || String(m.sender || "").endsWith("@app"))) continue;
    if (wanted.length) {
      const hit = wanted.some((w) => chat.includes(w) || w.includes(chat));
      if (!hit) continue;
    }
    const labels = uniq([...labelsOf(chat), ...matchProfileLabels(chat)]);
    const priorityLabels = new Set(profile.labels?.priority || []);
    const commercialLabels = new Set(profile.labels?.commercial || []);
    const creatorLabels = new Set(profile.labels?.creator || []);

    const hasSelf = list.some((m) => m.is_owner || isSelfSender(m.sender, names));
    const commercialMessages = list.filter(
      (m) => COMMERCIAL_TERMS.test(String(m.content || "")) || REQUEST_TERMS.test(String(m.content || "")),
    );
    const externalCommercial = commercialMessages.filter((m) => !(m.is_owner || isSelfSender(m.sender, names)));
    const personalTopics = personalTopicsOf(chat, list.map((m) => m.content).join(" "));
    const personalMessages = list.filter((m) => personalTopicsOf(chat, m.content).length > 0);
    const externalPersonal = personalMessages.filter((m) => !(m.is_owner || isSelfSender(m.sender, names)));

    const opportunity = oppMap.get(chat) || null;
    const isPriorityContact = labels.some((l) => priorityLabels.has(l) || commercialLabels.has(l) || creatorLabels.has(l));
    if (contactScope === "priority_labels_only" && !isPriorityContact) continue;
    const manuallyTracked = Boolean(
      opportunity &&
        (["active", "waiting", "paused"].includes(opportunity.status) ||
          opportunity.stage_locked ||
          opportunity.priority_locked ||
          opportunity.next_action_locked),
    );
    const twoWayCommercial = Boolean(hasSelf && externalCommercial.length);
    const twoWayPersonal = Boolean(hasSelf && externalPersonal.length);
    // 调用方显式点名了这些联系人时，视为显式白名单，跳过启发式筛选
    const explicitlyRequested = wanted.length > 0;
    if (!explicitlyRequested && !(isPriorityContact || manuallyTracked || twoWayCommercial || twoWayPersonal)) continue;

    let role;
    if (labels.some((l) => commercialLabels.has(l)) && labels.some((l) => creatorLabels.has(l))) role = "客户/品牌 + 同行/创作者";
    else if (labels.some((l) => commercialLabels.has(l))) role = "客户/品牌/商务联系人";
    else if (labels.some((l) => creatorLabels.has(l))) role = "同行/创作者/资源方";
    else if (labels.some((l) => priorityLabels.has(l)))
      role = "重点标签联系人（" + labels.filter((l) => priorityLabels.has(l)).sort().join(" / ") + "）";
    else if (twoWayPersonal) role = "个人重点主题联系人";
    else role = "新商业联系人";

    const latest = list[list.length - 1];
    const stage = opportunity ? String(opportunity.stage || "") : "";
    const hasContext = Boolean(commercialMessages.length || personalMessages.length || opportunity);
    const base = contactDailyStatus(latest, names, hasContext);
    let status = base.status;
    let replyDirection = base.replyDirection;
    const openPromise = openPromisesOf(list, { selfNames: names, now: until })[0] || null;
    if (openPromise) {
      status = "待兑现";
      replyDirection = "先" + openPromise.action + "；完成后再向对方同步，不用只回一条客套消息。";
    }

    out.push({
      chat,
      role,
      status,
      statusLabel: CONTACT_STATUS_LABELS[status] || status,
      count: list.length,
      lastSender: latest.sender,
      lastContent: shortText(latest.content, 220),
      lastTs: latest.ts,
      lastTime: fmtLocal(new Date(latest.ts)),
      replyDirection,
      amounts: uniq(list.flatMap((m) => extractAmounts(m.content))),
      labels,
      personalPriority: Boolean(personalTopics.length),
      personalTopics,
      opportunity,
      openPromise,
      commercialCount: commercialMessages.length,
      messages: list.slice(-6).map(rowBrief),
    });
  }

  out.sort(
    (a, b) =>
      (CONTACT_STATUS_RANK[b.status] || 0) - (CONTACT_STATUS_RANK[a.status] || 0) ||
      (b.opportunity?.priority || 0) - (a.opportunity?.priority || 0) ||
      b.commercialCount - a.commercialCount ||
      b.lastTs - a.lastTs,
  );
  return {
    sinceMs: since,
    untilMs: until,
    scope: contactScope,
    counts: {
      chats: out.length,
      待兑现: out.filter((r) => r.status === "待兑现").length,
      待回复: out.filter((r) => r.status === "待回复").length,
      等待对方: out.filter((r) => r.status === "等待对方").length,
      留意: out.filter((r) => r.status === "留意").length,
      无需立即回复: out.filter((r) => r.status === "无需立即回复").length,
    },
    rows: out,
  };
}

// ---------------- 共同群 / 跨群链接 ----------------
function contactAliases(query) {
  const q = String(query == null ? "" : query).trim();
  let name = q;
  try {
    name = resolveChatName(q);
  } catch {
    name = q;
  }
  const aliases = new Set([q, name].filter(Boolean).map((s) => s.toLowerCase()));
  const rows = store().prepare("SELECT name, alias, remark FROM contacts WHERE name=? OR name=? OR alias=? OR remark=?").all(q, name, q, name);
  for (const r of rows) {
    for (const v of [r.name, r.alias, r.remark]) if (v) aliases.add(String(v).toLowerCase());
  }
  return { query: q, name, aliases: [...aliases] };
}

/** 用完整成员名核验共同群，不靠短昵称猜测 */
export function commonGroups(a, b, { sinceMs, groupLimit = 5000 } = {}) {
  const contacts = [contactAliases(a), contactAliases(b)];
  const db = store();
  const sessions = listSessions({ kind: "group", limit: groupLimit });
  const matches = [];
  let scanned = 0;
  for (const s of sessions) {
    if (sinceMs && (s.last_ts || 0) < sinceMs) continue;
    scanned += 1;
    const senders = db
      .prepare("SELECT sender, COUNT(*) AS n, MAX(ts) AS last_ts FROM messages WHERE session_id=? GROUP BY sender")
      .all(s.id);
    const matchedMembers = [];
    for (const c of contacts) {
      const hit = senders.find((r) => r.sender && c.aliases.includes(String(r.sender).toLowerCase()));
      if (hit) matchedMembers.push({ query: c.query, name: c.name, sender: hit.sender, messages: Number(hit.n), last_ts: Number(hit.last_ts) });
    }
    if (matchedMembers.length < 2) continue;
    const agg = db
      .prepare("SELECT COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM messages WHERE session_id=? AND ts>=?")
      .get(s.id, Number(sinceMs) || 0);
    const recent = db
      .prepare("SELECT * FROM messages WHERE session_id=? AND ts>=? ORDER BY ts DESC LIMIT 5")
      .all(s.id, Number(sinceMs) || 0)
      .map(rowToMessage)
      .reverse();
    matches.push({
      group: s.name,
      group_id: s.id,
      verified_by: "成员名精确匹配",
      matchedMembers,
      messageCount: Number(agg.n) || 0,
      first_ts: agg.first_ts || null,
      last_ts: agg.last_ts || null,
      recent: recent.map(rowBrief),
    });
  }
  matches.sort((x, y) => y.messageCount - x.messageCount || (y.last_ts || 0) - (x.last_ts || 0));
  return {
    contacts: contacts.map((c) => ({ query: c.query, name: c.name, aliases: c.aliases })),
    groupsScanned: scanned,
    matches,
    note: matches.length ? "" : "没有找到同时包含这些联系人的群聊（按完整成员名核验）。",
  };
}

function possibleRoles(app) {
  const text = String(app.context || "");
  const roles = [];
  if (/品牌方|项目方|需求方|甲方/.test(text)) roles.push("品牌方/项目方");
  if (/招募|推荐|引荐|拉群|名额|介绍/.test(text)) roles.push("中间人/资源方");
  if (app.heat || /红包|三连|四连|加热|转推/.test(text)) roles.push("加热者");
  if (/博主|达人|KOL|创作者|粉丝/.test(text)) roles.push("创作者/博主");
  return roles.length ? uniq(roles) : ["普通成员"];
}

/** links 表还没有可用 URL 时的兜底：直接对索引里的消息做同一套聚合（同一份数据，不引入第二套规则） */
function linksFromMessages({ sinceMs, untilMs, minChats, limit }) {
  const rows = store()
    .prepare("SELECT session_name, sender, ts, content, links, is_owner FROM messages WHERE ts>=? AND ts<=? ORDER BY ts ASC LIMIT 100000")
    .all(Number(sinceMs) || 0, Number(untilMs) || Date.now());
  const map = new Map();
  for (const r of rows) {
    let urls = [];
    try {
      urls = JSON.parse(r.links || "[]");
    } catch {
      urls = [];
    }
    if (!Array.isArray(urls)) urls = [];
    else if (!urls.length && !r.links) urls = extractUrls(r.content); // 仅旧版空列回退提取；现版空数组即「无链接」
    for (const raw of urls) {
      const url = String(raw || "");
      if (!/^https?:\/\//i.test(url)) continue;
      const norm = normalizeUrl(url);
      if (!norm) continue;
      if (!map.has(norm)) {
        map.set(norm, { norm, url, chats: new Set(), first_ts: r.ts, last_ts: r.ts, hits: 0, heat: false, apps: [] });
      }
      const rec = map.get(norm);
      const heat = isHeatLink(url) || /红包|加热|三连|四连|转推|点赞|quote|接龙/i.test(String(r.content || ""));
      rec.chats.add(r.session_name);
      rec.first_ts = Math.min(rec.first_ts, r.ts);
      rec.last_ts = Math.max(rec.last_ts, r.ts);
      rec.hits += 1;
      if (heat) rec.heat = true;
      if (rec.apps.length < 60) {
        rec.apps.push({ session_name: r.session_name, sender: r.sender, ts: r.ts, heat: heat ? 1 : 0, url, context: String(r.content || "").slice(0, 200) });
      }
    }
  }
  return [...map.values()]
    .filter((r) => r.chats.size >= minChats)
    .sort((a, b) => b.chats.size - a.chats.size || b.hits - a.hits)
    .slice(0, Math.max(1, Number(limit) || 50));
}

/** 跨群链接：每个 URL 只出现一次，附出现群、最早/最新时间、非加热发布者、可能角色 */
export function crossGroupLinks({ sinceMs, untilMs, minChats = 2, limit = 50 } = {}) {
  const entries = new Map();
  // 主路径：store.crossGroupLinks + linkAppearances（链接索引）
  for (const r of storeCrossGroupLinks({ sinceMs, untilMs, minChats, limit })) {
    const rawNorm = String(r.norm || "");
    if (!rawNorm || entries.has(rawNorm)) continue;
    const apps = linkAppearances(rawNorm, 60, sinceMs ?? 0, untilMs ?? Date.now());
    // 只保留真正的 http(s) 链接：历史索引里可能存在非 URL 的脏 norm
    const rawUrl = String((apps.find((a) => a && a.url) || {}).url || rawNorm);
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    const norm = normalizeUrl(rawUrl);
    if (!norm || entries.has(norm)) continue;
    entries.set(norm, { norm, url: rawUrl, first_ts: Number(r.first_ts) || 0, last_ts: Number(r.last_ts) || 0, hits: Number(r.hits) || 0, heat: Boolean(r.heat), apps, origin: "links_table" });
  }
  // 兜底：链接索引没有可用 URL 时，用索引消息聚合（不改变上面的调用口径）
  for (const r of linksFromMessages({ sinceMs, untilMs, minChats, limit })) {
    if (entries.has(r.norm)) continue;
    entries.set(r.norm, { norm: r.norm, url: r.url, first_ts: r.first_ts, last_ts: r.last_ts, hits: r.hits, heat: r.heat, apps: r.apps, origin: "messages" });
  }

  const links = [];
  for (const e of entries.values()) {
    const apps = e.apps;
    const chats = uniq(apps.map((a) => a.session_name));
    if (chats.length < minChats) continue;
    const heat = e.heat || apps.some((a) => a.heat);
    const nonHeat = apps.filter((a) => !a.heat);
    let probability = "普通内容";
    let rank = 0;
    if (chats.length >= 2 && heat) {
      probability = "高概率商单";
      rank = 3;
    } else if (heat) {
      probability = "疑似商单";
      rank = 1;
    } else if (chats.length >= 2) {
      probability = "疑似商单";
      rank = 1;
    }
    links.push({
      norm: e.norm,
      url: e.url,
      chats,
      chat_count: chats.length,
      first_ts: e.first_ts,
      last_ts: e.last_ts,
      first_time: fmtLocal(new Date(e.first_ts || 0)),
      last_time: fmtLocal(new Date(e.last_ts || 0)),
      hits: e.hits,
      origin: e.origin,
      heat,
      probability,
      rank,
      senders: uniq(apps.map((a) => a.sender).filter(Boolean)),
      non_heat_senders: uniq(nonHeat.map((a) => a.sender).filter(Boolean)),
      appearances: apps.map((a) => ({
        chat: a.session_name,
        sender: a.sender,
        ts: Number(a.ts) || 0,
        time: fmtLocal(new Date(Number(a.ts) || 0)),
        heat: Boolean(a.heat),
        roles: possibleRoles(a),
        content: shortText(a.context, 160),
      })),
      note: heat ? "存在付费加热/红包/三连等证据" : undefined,
    });
  }
  links.sort((a, b) => b.rank - a.rank || b.chat_count - a.chat_count || b.last_ts - a.last_ts);
  return { sinceMs: sinceMs || 0, untilMs: untilMs || Date.now(), minChats, links };
}

// ---------------- 商单雷达 ----------------
export function dealRadar(analysis, { messages, sinceMs, untilMs, now } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const a =
    analysis ||
    analyze({
      messages: messages || messagesForAnalyze({ sinceMs: sinceMs || nowMs - 72 * 3600000, untilMs: untilMs || nowMs, limit: 50000 }),
      sinceMs: sinceMs || nowMs - 72 * 3600000,
      untilMs: untilMs || nowMs,
      now: new Date(nowMs),
    });
  const dealRow = (row, extra) => ({
    chat: row.chat,
    kind: row.kind,
    kind_label: row.kind === "group" ? "群聊" : "私聊",
    qualification: row.qualification ?? row.score ?? 0,
    confidence: row.confidence || "待核实",
    amounts: row.amounts || [],
    hits: row.hits || [],
    ts: row.ts,
    time: fmtLocal(new Date(row.ts || 0)),
    evidence: row.evidence || [],
    action: extra || "人工确认后再决定是否推进",
  });
  const brand = (a.brandDeals || []).map((r) =>
    dealRow(r, r.record_type === "opportunity" ? "可直接推进：补 brief、报价与排期" : "先核实品牌方、预算与名额，再决定是否接"),
  );
  const trainings = (a.trainings || []).map((r) => dealRow(r, "确认听众、课时与报价，准备课程大纲"));
  const resources = (a.resources || []).map((r) => ({
    chat: r.chat,
    kind: r.kind,
    qualification: 0,
    hits: r.hits || [],
    ts: r.ts,
    time: fmtLocal(new Date(r.ts || 0)),
    evidence: r.evidence || [],
    action: "判断是否值得引荐：先确认需求方与交付形式",
  }));
  const settlements = (a.settlements || []).map((r) => ({
    chat: r.chat,
    kind: r.kind,
    terms: r.terms || [],
    amounts: r.amounts || [],
    pending: Boolean(r.pending),
    last_sender: r.last_sender,
    ts: r.ts,
    time: fmtLocal(new Date(r.ts || 0)),
    content: r.content || "",
    action: r.pending ? "核对发布与结算材料，直接回复缺什么" : "等待对方结算或确认到账",
  }));
  const links = (a.links || []).filter((l) => l.chats.length >= 2 || l.heat).slice(0, 20);
  return {
    window: a.window,
    columns: {
      品牌商单: brand,
      培训合作: trainings,
      资源对接: resources,
      结算跟进: settlements,
    },
    crossLinks: links,
    counts: {
      品牌商单: brand.length,
      培训合作: trainings.length,
      资源对接: resources.length,
      结算跟进: settlements.length,
      跨群链接: links.length,
    },
    coverage: a.coverage,
  };
}

// ---------------- 首页 ----------------
/** 首页行瘦身：保留 rowToOpportunity 信封全部字段，只收缩长文本与数组（F6） */
function slimValue(v, n) {
  return typeof v === "string" ? truncateOutsideUrl(v, n) : v;
}

function slimHomeRow(row) {
  const out = { ...row };
  for (const k of ["title", "next_action", "note", "notes", "qualification_reasons", "chat", "contact", "role", "amount"]) {
    out[k] = slimValue(out[k], 120);
  }
  out.evidence = (Array.isArray(row.evidence) ? row.evidence : []).slice(0, 2).map((e) => {
    if (e && typeof e === "object" && !Array.isArray(e)) {
      const o = {};
      for (const [k, v] of Object.entries(e)) o[k] = slimValue(v, 120);
      return o;
    }
    return slimValue(e, 120);
  });
  out.links = (Array.isArray(row.links) ? row.links : []).slice(0, 3).map((l) => slimValue(l, 120));
  return out;
}

/** 首页输出硬预算：textResult 走 JSON.stringify(obj, null, 2)，超宿主输出预算会被截断，
 *  消费方拿到不完整 JSON（F6）。逐级降载：清 evidence → 清 links → 从尾部裁数组行；
 *  counts.* 始终是诚实总数，不随数组缩水。48KB 留 2KB 余量给信封/summary（宿主截断阈值待确认）。 */
const HOME_TEXT_BUDGET = 48000;
function fitHomeBudget(state) {
  const size = () => JSON.stringify(state, null, 2).length;
  if (size() <= HOME_TEXT_BUDGET) return;
  for (const row of [...state.today, ...state.inbox]) row.evidence = [];
  if (size() <= HOME_TEXT_BUDGET) return;
  for (const row of [...state.today, ...state.inbox]) row.links = [];
  while (size() > HOME_TEXT_BUDGET && state.inbox.length) state.inbox.pop();
  while (size() > HOME_TEXT_BUDGET && state.today.length) state.today.pop();
}

export function homeState({ now } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const fresh = freshness();
  const stats = storeStats();
  const status = countByStatus();
  const today = listToday({ today: new Date(nowMs), minPriority: 3, limit: 10 }).map(slimHomeRow);
  const inbox = listInbox({ minPriority: 4, limit: 20 }).map(slimHomeRow);
  const due = listOpportunities({ dueOnly: true, includeClosed: false, limit: 100 });
  // counts.inbox / counts.today 用同口径 COUNT（不受 limit 截断）；wai_status.inbox 是
  // inbox_entries 暂存表行数，另一套数据，另设 counts.inbox_entries 消除同名歧义（F6）
  const inboxTotal = countInbox({ minPriority: 4 });
  const todayTotal = countToday({ today: new Date(nowMs), minPriority: 3 });
  const entries = [
    { id: "today", title: "今日总览", description: "近 24 小时变化、待回复、重点私聊和群聊。", action: "调用 today 工具" },
    { id: "topic", title: "主题搜索", description: "跨群聊和私聊检索一个主题，不受日报日期限制。", action: "调用 topic 工具" },
    { id: "person", title: "联系人", description: "查看双方要求、个人承诺、开放商机和最近上下文。", action: "调用 person 工具" },
    { id: "reply", title: "回复建议", description: "基于最近消息和商机状态生成草稿，必须人工确认后自行发送。", action: "调用 reply 工具" },
    { id: "radar", title: "商单雷达", description: "查看今日行动、待分流候选和完整商机管线。", action: "调用 inbox / opportunities 工具" },
  ];
  const surfaced = new Set([...today.map((o) => o.chat), ...inbox.map((o) => o.chat)]);
  const state = {
    now: nowMs,
    freshness: fresh,
    counts: {
      messages: stats.messages,
      sessions: stats.sessions,
      contacts: stats.contacts,
      links: stats.links,
      opportunities: status.total,
      opportunities_open: status.open,
      opportunities_due: due.length,
      candidates: status.candidates,
      inbox: inboxTotal,
      inbox_entries: stats.inbox,
      today: todayTotal,
    },
    entries,
    triage: {
      立即处理: due.length + today.filter((o) => o.next_follow_up).length,
      值得关注: inboxTotal,
      仅供存档: Math.max(0, stats.messages - surfaced.size),
    },
    today,
    inbox,
    status_counts: status,
    note: fresh.messages ? "" : "本地索引还没有数据：先运行 ingest / index 工具建立索引。",
    freshnessLabel: fresh.last_message_ts ? "最新索引 " + fmtLocal(new Date(fresh.last_message_ts)) + "（约 " + fresh.data_age_hours + " 小时前）" : "暂无索引",
  };
  fitHomeBudget(state);
  return state;
}

// ---------------- 会话历史 ----------------
export function chatHistory({ chat, sinceMs, untilMs, query, limit = 200 } = {}) {
  const name = resolveChatName(chat);
  let rows = chatMessages(name, { sinceMs, untilMs, limit: Math.max(1, Number(limit) || 200), order: "asc" });
  if (query) rows = rows.filter((m) => String(m.content || "").includes(String(query)));
  return {
    chat: name,
    sinceMs: sinceMs || 0,
    untilMs: untilMs || Date.now(),
    query: query || null,
    count: rows.length,
    messages: rows.map(rowBrief),
    raw: rows,
  };
}

export { resolveChatName, fmtDay };
