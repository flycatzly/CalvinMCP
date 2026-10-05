// B. 社交关系分析：谁主动、回复速度、双向性、月度变化、群内核心/边缘/桥梁、同群共现聚类。
// 口径：只描述互动模式，不做道德评判；「主动」= 会话内间隔超过阈值（默认 4 小时）后新一段对话的首条。
import { groupByChat, round, median, countBy, fmtLocal } from "./core.mjs";

const BURST_GAP_MS = 4 * 3600000;

/** 数值年月（y*12+m）回译成 toISOString().slice(0,7) 同款键（含 ±YYYYYY 扩展年截断）。 */
function fmtYm(ym) {
  const y = Math.floor(ym / 12);
  const m = ym - y * 12 + 1;
  if (y >= 0 && y <= 9999) return String(y).padStart(4, "0") + "-" + String(m).padStart(2, "0");
  return (y < 0 ? "-" : "+") + String(Math.abs(y)).padStart(6, "0");
}

/** 把一条会话的消息流切成「对话段」（间隔 > gapMs 即新段） */
export function burstsOf(list, gapMs = BURST_GAP_MS) {
  const sorted = [...list].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const bursts = [];
  let cur = null;
  for (const m of sorted) {
    if (!cur || (m.ts ?? 0) - (cur.end.ts ?? 0) > gapMs) {
      cur = { start: m, end: m, messages: [m] };
      bursts.push(cur);
    } else {
      cur.end = m;
      cur.messages.push(m);
    }
  }
  return bursts;
}

export function socialGraph(messages, { sinceMs, untilMs, top = 15, gapMs = BURST_GAP_MS, now = new Date() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const byChat = groupByChat(list);
  const peers = [];
  const groups = [];

  for (const [name, msgs] of byChat) {
    const isGroup = msgs.some((m) => m.session_kind === "group") || /群|组|team|group/i.test(name);
    const self = msgs.filter((m) => m.is_owner).length;
    const others = msgs.length - self;
    const bursts = burstsOf(msgs, gapMs);
    let myInitiated = 0, theirInitiated = 0;
    for (const b of bursts) {
      if (b.start.is_owner) myInitiated += 1;
      else theirInitiated += 1;
    }
    // 逐会话回复间隔（我回对方 / 对方回我）
    const mine = [], theirs = [];
    const sorted = [...msgs].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1], cur = sorted[i];
      if (!!prev.is_owner === !!cur.is_owner || !prev.ts || !cur.ts) continue;
      const hours = (cur.ts - prev.ts) / 3600000;
      if (hours < 0 || hours > 24 * 7) continue;
      (cur.is_owner ? mine : theirs).push(hours * 60);
    }
    // 月度消息量（用于升温/降温）
    const byMonth = new Map();
    for (const m of msgs) {
      if (!m.ts) continue;
      const d = new Date(m.ts);
      const key = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (key !== key) d.toISOString(); // truthy 但非法时间：与旧实现同款抛 RangeError
      byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
    }
    const monthly = [...byMonth.entries()].map(([ym, count]) => ({ month: fmtYm(ym), count })).sort((a, b) => (a.month < b.month ? -1 : 1));
    let trend = "样本不足", change = 0;
    if (monthly.length >= 2) {
      const last = monthly[monthly.length - 1].count;
      const base = monthly.slice(-3, -1).reduce((a, b) => a + b.count, 0) / Math.max(1, monthly.slice(-3, -1).length);
      change = base ? (last - base) / base : 0;
      trend = change >= 0.3 ? "升温" : change <= -0.3 ? "降温" : "稳定";
    }
    const lastMsg = sorted[sorted.length - 1];
    const row = {
      name,
      kind: isGroup ? "group" : "private",
      messages: msgs.length,
      self_messages: self,
      other_messages: others,
      senders: new Set(msgs.map((m) => m.sender).filter(Boolean)).size,
      bursts: bursts.length,
      my_initiated: myInitiated,
      their_initiated: theirInitiated,
      initiative_ratio: bursts.length ? round(theirInitiated / bursts.length, 3) : null,
      my_reply_median_minutes: mine.length ? Math.round(median(mine)) : null,
      their_reply_median_minutes: theirs.length ? Math.round(median(theirs)) : null,
      reply_samples: mine.length + theirs.length,
      monthly,
      trend,
      change: round(change, 3),
      last_message_at: lastMsg?.ts ? fmtLocal(new Date(lastMsg.ts)) : null,
      last_sender: lastMsg?.is_owner ? "我" : (lastMsg?.sender ?? null),
    };
    (isGroup ? groups : peers).push(row);
  }

  const sortByMsgs = (a, b) => b.messages - a.messages || a.name.localeCompare(b.name, "zh");
  peers.sort(sortByMsgs);
  groups.sort(sortByMsgs);

  // 双向性标签（描述性口径，不做价值判断）
  const bidirectional = peers.map((p) => {
    const ratio = p.messages ? round(Math.min(p.self_messages, p.other_messages) / Math.max(1, Math.max(p.self_messages, p.other_messages)), 3) : 0;
    let label = "双向互动";
    if (p.their_initiated > p.my_initiated * 2 && p.self_messages < p.other_messages * 0.5) label = "对方主动居多";
    else if (p.my_initiated > p.their_initiated * 2 && p.other_messages < p.self_messages * 0.5) label = "我方主动居多";
    else if (p.messages < 5) label = "互动太少";
    return { name: p.name, self_messages: p.self_messages, other_messages: p.other_messages, balance_ratio: ratio, my_initiated: p.my_initiated, their_initiated: p.their_initiated, label };
  }).sort((a, b) => a.balance_ratio - b.balance_ratio);

  // 群聊网络：度中心性（发言占比）、核心/边缘、跨群桥梁（近似）
  const memberGroups = new Map();
  const groupNetwork = groups.map((g) => {
    const msgs = byChat.get(g.name) ?? [];
    const senders = [...countBy(msgs.filter((m) => !m.is_owner && m.sender), (m) => m.sender).entries()]
      .map(([sender, count]) => ({ sender, count, share: round(count / Math.max(1, msgs.length), 3) }))
      .sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender, "zh"));
    for (const s of senders) {
      if (!memberGroups.has(s.sender)) memberGroups.set(s.sender, new Set());
      memberGroups.get(s.sender).add(g.name);
    }
    const core = senders.slice(0, 5);
    const edge = senders.filter((s) => s.count <= 2).slice(0, 10);
    return {
      group: g.name,
      messages: g.messages,
      active_senders: senders.length,
      core_members: core,
      edge_members: edge,
      top_senders: senders.slice(0, 10),
    };
  });
  const bridges = [...memberGroups.entries()]
    .map(([sender, set]) => ({ sender, groups: [...set].sort(), group_count: set.size }))
    .filter((b) => b.group_count >= 2)
    .sort((a, b) => b.group_count - a.group_count || a.sender.localeCompare(b.sender, "zh"))
    .slice(0, top);

  // 同群共现聚类（近似社群结构：两人共同发言的群越多越近）
  const clusters = clusterByCooccurrence(memberGroups);

  // 互动模式线索（谨慎措辞，只描述不评判）
  const risks = [];
  for (const p of peers) {
    if (p.their_initiated >= 3 && p.my_initiated === 0 && p.self_messages < p.other_messages * 0.3) {
      risks.push({ type: "对方主动居多", chat: p.name, level: "低", description: `对方发起 ${p.their_initiated} 段对话，我方几乎未主动发起（我 ${p.self_messages} 条 / 对方 ${p.other_messages} 条）。互动模式仅供参考。`, evidence: [] });
    }
    if (p.last_sender === "我" && p.last_message_at) {
      const days = (Date.now() - Date.parse(p.last_message_at.replace(" ", "T") + ":00")) / 86400000;
      if (Number.isFinite(days) && days > 7) {
        risks.push({ type: "待回复悬置", chat: p.name, level: "低", description: `最后一条由我发出，已 ${Math.round(days)} 天没有后续。`, evidence: [] });
      }
    }
    if (p.trend === "降温" && p.change <= -0.5 && p.messages >= 20) {
      risks.push({ type: "互动降温", chat: p.name, level: "低", description: `末月消息量环比 ${round(p.change * 100, 0)}%。可能是周期性，也可能是关系变化，需结合语境判断。`, evidence: [] });
    }
  }

  return {
    overview: {
      peers: peers.length,
      groups: groups.length,
      messages: list.length,
      self_messages: list.filter((m) => m.is_owner).length,
      window: { since: sinceMs ? new Date(sinceMs).toISOString() : null, until: untilMs ? new Date(untilMs).toISOString() : null },
    },
    who_contacts_me_most: peers.filter((p) => p.their_initiated > 0).sort((a, b) => b.their_initiated - a.their_initiated || b.messages - a.messages).slice(0, top),
    who_i_contact_most: peers.filter((p) => p.my_initiated > 0).sort((a, b) => b.my_initiated - a.my_initiated || b.messages - a.messages).slice(0, top),
    reply_time: peers.filter((p) => p.reply_samples > 0).sort((a, b) => (a.my_reply_median_minutes ?? 1e9) - (b.my_reply_median_minutes ?? 1e9)).slice(0, top),
    bidirectional,
    relationship_change: [...peers, ...groups].filter((p) => p.trend !== "样本不足").sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, top),
    group_network: groupNetwork,
    bridge_members: bridges,
    clusters,
    interaction_notes: risks,
    caliber: "主动=对话段首条（间隔>4h 切段）；回复间隔取中位数，只算 7 天内换人衔接；群中心性=发言占比；桥梁=同窗口内活跃于多个群（近似中介，非图论精确值）；共现聚类=同群发言的标签传播。",
  };
}

/** 同群共现 + 标签传播聚类（确定性：节点按名字排序，标签取邻居最常见，平票取小） */
function clusterByCooccurrence(memberGroups) {
  const nodes = [...memberGroups.keys()].sort((a, b) => a.localeCompare(b, "zh"));
  if (!nodes.length) return [];
  // 共现边：两人在同一个群会话里都发过言就连一条边（同群越多越近）
  const neighbors = new Map(nodes.map((n) => [n, new Set()]));
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = memberGroups.get(nodes[i]), b = memberGroups.get(nodes[j]);
      const shared = [...a].filter((g) => b.has(g));
      if (shared.length) {
        neighbors.get(nodes[i]).add(nodes[j]);
        neighbors.get(nodes[j]).add(nodes[i]);
      }
    }
  }
  let labels = new Map(nodes.map((n, i) => [n, i]));
  for (let iter = 0; iter < 8; iter += 1) {
    const next = new Map();
    for (const n of nodes) {
      const counts = new Map();
      for (const nb of neighbors.get(n)) {
        const l = labels.get(nb);
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      if (!counts.size) { next.set(n, labels.get(n)); continue; }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      next.set(n, Math.min(best, labels.get(n)));
    }
    labels = next;
  }
  const byLabel = new Map();
  for (const n of nodes) {
    const l = labels.get(n);
    if (!byLabel.has(l)) byLabel.set(l, []);
    byLabel.get(l).push(n);
  }
  return [...byLabel.values()]
    .sort((a, b) => b.length - a.length)
    .slice(0, 8)
    .map((members, i) => ({ cluster: i + 1, size: members.length, members: members.slice(0, 20) }));
}
