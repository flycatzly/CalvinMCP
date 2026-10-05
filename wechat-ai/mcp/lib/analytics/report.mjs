// A. 年度/月度聊天报告：消息量、类型、活跃时段、Top 联系人/群、口头禅、表情、
//    回复间隔、连续天数、趋势与洞察。输出 JSON（对外渲染走 render.mjs，证据脱敏）。
import {
  typeBreakdown, hourBuckets, weekdayBuckets, dayBuckets, monthBuckets,
  activityStreaks, replyIntervals, termFreq, catchphrases, emojiTop,
  groupByChat, countBy, topEntries, round, evidence,
} from "./core.mjs";

/**
 * 生成期间报告。
 * @param {Array} messages 归一化消息行（store.rowToMessage 形状）
 * @param {{sinceMs:number,untilMs:number,top?:number,now?:Date,minSample?:number}} opts
 */
export function periodReport(messages, { sinceMs, untilMs, top = 20, now = new Date(), minSample = 20 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  const selfMessages = list.filter((m) => m.is_owner).length;
  const received = total - selfMessages;

  // 会话排行（私聊名=联系人，群名=群）
  const chatStats = new Map();
  for (const m of list) {
    const name = m.session_name ?? "未知会话";
    const kind = m.session_kind === "group" || /群|组|team|group/i.test(name) ? "group" : "private";
    let row = chatStats.get(name);
    if (!row) chatStats.set(name, (row = { name, kind, messages: 0, self: 0, others: 0, senders: new Set(), first_ts: m.ts, last_ts: m.ts, by_month: new Map() }));
    row.messages += 1;
    if (m.is_owner) row.self += 1; else row.others += 1;
    if (m.sender) row.senders.add(m.sender);
    if (m.ts) {
      row.first_ts = Math.min(row.first_ts || m.ts, m.ts);
      row.last_ts = Math.max(row.last_ts || m.ts, m.ts);
      const month = new Date(m.ts).toISOString().slice(0, 7);
      row.by_month.set(month, (row.by_month.get(month) ?? 0) + 1);
    }
  }
  const rankRows = [...chatStats.values()]
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name, "zh"))
    .map((r) => ({
      name: r.name, kind: r.kind, messages: r.messages, self: r.self, others: r.others,
      share: total ? round(r.messages / total, 4) : 0,
      senders: r.senders.size,
    }));
  const topContacts = rankRows.filter((r) => r.kind === "private").slice(0, top);
  const topGroups = rankRows.filter((r) => r.kind === "group").slice(0, top);

  // 关系升温/降温：末月 vs 前两个月均值
  const relationshipTrend = [...chatStats.values()].map((r) => {
    const months = [...r.by_month.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (months.length < 2) return { chat: r.name, trend: "样本不足", detail: "跨月数据不足" };
    const last = months[months.length - 1][1];
    const prev = months.slice(-3, -1);
    const base = prev.reduce((a, b) => a + b[1], 0) / (prev.length || 1);
    const delta = base ? (last - base) / base : 0;
    const trend = delta >= 0.3 ? "升温" : delta <= -0.3 ? "降温" : "稳定";
    return { chat: r.name, trend, last_month: months[months.length - 1][0], last_month_messages: last, baseline: round(base, 1), change: round(delta, 3) };
  }).filter((x) => x.trend !== "样本不足").sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, top);

  // 消息长度与回复节奏
  const lengths = list.map((m) => String(m.content ?? "").length).filter((n) => n > 0).sort((a, b) => a - b);
  const messageLength = lengths.length
    ? {
        avg: round(lengths.reduce((a, b) => a + b, 0) / lengths.length, 1),
        median: lengths[Math.floor(lengths.length / 2)],
        p90: lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))],
        max: lengths[lengths.length - 1],
      }
    : { avg: 0, median: 0, p90: 0, max: 0 };
  const reply = replyIntervals(list);
  const activity = activityStreaks(list);

  // 夜间消息（23:00-05:00）与周末占比
  const hours = hourBuckets(list);
  const night = hours.filter((h) => h.hour >= 23 || h.hour < 5).reduce((a, b) => a + b.count, 0);
  const weekdays = weekdayBuckets(list);
  const weekend = weekdays.filter((w) => w.weekday === 0 || w.weekday === 6).reduce((a, b) => a + b.count, 0);

  const keywords = termFreq(list, { limit: 30, minCount: Math.max(2, Math.floor(total / 500)) });
  const phrases = catchphrases(list, { limit: 15, minCount: 3 });
  const emojis = emojiTop(list, { limit: 30 });

  const insufficient = total < minSample;
  const period = {
    since: sinceMs ? new Date(sinceMs).toISOString() : null,
    until: untilMs ? new Date(untilMs).toISOString() : null,
    label: `${new Date(sinceMs ?? 0).toISOString().slice(0, 10)} ~ ${new Date(untilMs ?? now).toISOString().slice(0, 10)}`,
    sample_note: insufficient ? "样本不足" : null,
  };

  return {
    period,
    total_messages: total,
    self_messages: selfMessages,
    received_messages: received,
    type_breakdown: typeBreakdown(list),
    active_hours: hours,
    active_weekdays: weekdays,
    daily_trend: dayBuckets(list),
    monthly_trend: monthBuckets(list),
    top_contacts: topContacts,
    top_groups: topGroups,
    keywords,
    catchphrases: phrases,
    emojis,
    message_length: messageLength,
    reply_interval: reply,
    activity,
    night_messages: { count: night, ratio: total ? round(night / total, 4) : 0 },
    weekend_messages: { count: weekend, ratio: total ? round(weekend / total, 4) : 0 },
    relationship_trend: relationshipTrend,
    insights: buildInsights({ total, selfMessages, topContacts, topGroups, hours, activity, reply, messageLength, night, emojis, phrases, relationshipTrend, insufficient }),
    caliber: "统计口径：按消息行计数（含表情/附件标记）；关键词为 2-4 字 n-gram 近似，无词典；回复间隔只统计同一会话内 7 天内的换人衔接；证据一律脱敏。",
  };
}

function buildInsights({ total, selfMessages, topContacts, topGroups, hours, activity, reply, messageLength, night, emojis, phrases, relationshipTrend, insufficient }) {
  const out = [];
  if (insufficient) {
    out.push({ text: "样本不足（少于 20 条消息），统计结论仅供参考，不要当趋势。", confidence: "低" });
    return out;
  }
  const peakHour = hours.reduce((a, b) => (b.count > (a?.count ?? -1) ? b : a), null);
  if (peakHour && peakHour.count) {
    out.push({ text: `最活跃时段是 ${peakHour.hour}:00-${peakHour.hour + 1}:00（${peakHour.count} 条，占 ${round((peakHour.count / total) * 100, 1)}%）。`, confidence: "高" });
  }
  const top1 = topContacts[0] ?? topGroups[0];
  if (top1) out.push({ text: `消息最集中于「${top1.name}」：${top1.messages} 条（占 ${round(top1.share * 100, 1)}%），其中我发 ${top1.self} 条。`, confidence: "高" });
  if (reply.mine.count) {
    const med = reply.mine.median_minutes;
    const desc = med >= 60 ? `约 ${round(med / 60, 1)} 小时` : `约 ${med} 分钟`;
    out.push({ text: `我回复对方的中位间隔${desc}（样本 ${reply.mine.count} 次换人衔接）。`, confidence: "中" });
  }
  if (activity.longest_streak_days >= 3) {
    out.push({ text: `最长连续聊天天数 ${activity.longest_streak_days} 天，单日峰值 ${activity.peak_day?.count ?? 0} 条（${activity.peak_day?.day ?? "-"}）。`, confidence: "高" });
  }
  if (night.ratio >= 0.15) out.push({ text: `夜间（23:00-05:00）消息占 ${round(night.ratio * 100, 1)}%，作息/沟通窗口偏晚，仅作趋势提示。`, confidence: "中" });
  if (messageLength.avg) out.push({ text: `消息平均 ${messageLength.avg} 字、中位 ${messageLength.median} 字，${messageLength.avg > 60 ? "以长文本沟通为主" : "以短句即时沟通为主"}。`, confidence: "中" });
  if (phrases.length) out.push({ text: `高频口头禅：${phrases.slice(0, 3).map((p) => `「${p.text}」×${p.count}`).join("、")}。`, confidence: "中" });
  if (emojis.length) out.push({ text: `最常用表情：${emojis.slice(0, 3).map((e) => `${e.emoji}×${e.count}`).join("、")}。`, confidence: "中" });
  const warming = relationshipTrend.filter((r) => r.trend === "升温").slice(0, 2);
  const cooling = relationshipTrend.filter((r) => r.trend === "降温").slice(0, 2);
  if (warming.length) out.push({ text: `关系升温：${warming.map((r) => `「${r.chat}」末月环比 ${r.change > 0 ? "+" : ""}${round(r.change * 100, 0)}%`).join("、")}。`, confidence: "中" });
  if (cooling.length) out.push({ text: `关系降温：${cooling.map((r) => `「${r.chat}」末月环比 ${round(r.change * 100, 0)}%`).join("、")}。`, confidence: "中" });
  const selfRatio = total ? selfMessages / total : 0;
  out.push({
    text: selfRatio > 0.6
      ? `我方发言占 ${round(selfRatio * 100, 1)}%，沟通中我更主动。`
      : selfRatio < 0.4
        ? `我方发言仅占 ${round(selfRatio * 100, 1)}%，以接收为主。`
        : `我方发言占 ${round(selfRatio * 100, 1)}%，双向均衡。`,
    confidence: "高",
  });
  return out.slice(0, 10);
}

/** 内容分析（G）用的抽取式摘要输入：把消息压成可引用片段 */
export function briefEvidence(messages, { limit = 10 } = {}) {
  return messages.slice(0, limit).map((m) => evidence(m));
}

export { groupByChat, countBy, topEntries };
