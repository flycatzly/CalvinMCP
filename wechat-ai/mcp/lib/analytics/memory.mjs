// F. 个人记忆与知识库：重要事件/决策/文件/照片/地点/链接 → 知识卡片 + 时间线。
// 口径：只保留有明确线索的条目；不编造；来源 msg_id 必附；第三方隐私走脱敏。
import { classifyMessage, evidence, truncate, maskPii, fmtDay, fmtLocal } from "./core.mjs";
import { TOPIC_SETS } from "./content.mjs";

const CARD_RULES = [
  { kind: "决策", re: /决定|定了|就按|拍板|最终(?:确认|版)|敲定|采用|确认用|不再改|方案(?:定|确认)/ },
  { kind: "事件", re: /会议|发布会|上线|签约|交付|开工|验收|入职|离职|搬家|婚礼|婚礼|旅行|出差|聚餐|团建|活动|考试|答辩|手术|出院/ },
  { kind: "经验", re: /经验|教训|总结|复盘|心得|踩坑|避坑|注意|要点|方法论|技巧/ },
  { kind: "联系人", re: /介绍|引荐|推荐|名片|联系方式|加一下|拉群|对接人/ },
];
const FILE_RE = /[\u4e00-\u9fa5A-Za-z0-9_\-（）()\[\]]{2,40}\.[A-Za-z0-9]{2,5}\b/g;
const LOCATION_RE = /[\u4e00-\u9fa5]{2,12}(?:大厦|大楼|广场|中心|园区|产业园|酒店|宾馆|咖啡厅?|餐厅|书店|医院|学校|地铁站?|机场|火车站|高铁站|公园|商场|超市|体育馆)/g;

function tagsOf(text) {
  const tags = [];
  for (const [topic, re] of Object.entries(TOPIC_SETS)) if (re.test(text)) tags.push(topic);
  return tags.slice(0, 4);
}

/**
 * 知识卡片 + 时间线。
 * @param {{maxCards?:number,now?:Date}} opts
 */
export function memoryCards(messages, { maxCards = 60, now = new Date() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const cards = [];
  const seen = new Set();
  let seq = 0;

  const addCard = (m, kind, title, extra = {}) => {
    const sig = `${kind}|${(m.ts ? fmtDay(new Date(m.ts)) : "")}|${title.slice(0, 12)}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    seq += 1;
    cards.push({
      card_id: `c${seq}`,
      kind,
      title: maskPii(truncate(title, 60)),
      time: m.ts ? fmtLocal(new Date(m.ts)) : null,
      day: m.ts ? fmtDay(new Date(m.ts)) : null,
      people: [...new Set([m.is_owner ? "我" : (m.sender ?? "未知"), ...(m.is_owner ? [] : ["我"])])],
      location: extra.location ?? null,
      summary: maskPii(truncate(String(m.content ?? "").replace(/\s+/g, " "), 120)),
      tags: [...new Set([...tagsOf(String(m.content ?? "")), ...(extra.tags ?? [])])].slice(0, 5),
      files: extra.files ?? [],
      photos: extra.photos ?? [],
      links: extra.links ?? [],
      source_msg_ids: [m.id].filter(Boolean),
      confidence: extra.confidence ?? 0.6,
    });
  };

  for (const m of list) {
    const text = String(m?.content ?? "");
    const type = classifyMessage(m);
    const atts = Array.isArray(m?.attachments) ? m.attachments : [];

    // 决策/事件/经验/联系人
    for (const rule of CARD_RULES) {
      if (rule.re.test(text)) {
        addCard(m, rule.kind, text, { confidence: 0.7 });
        break;
      }
    }
    // 文件 / 照片
    const files = [...new Set([...(text.match(FILE_RE) ?? []), ...atts.filter((a) => String(a?.kind) === "file").map((a) => String(a.marker ?? a.name ?? "文件"))])];
    const photos = atts.filter((a) => String(a?.kind) === "image").length || (type === "image" ? 1 : 0);
    if (files.length) addCard(m, "文件", `文件：${files[0]}`, { files: files.slice(0, 5), confidence: 0.65 });
    if (photos && type === "image") addCard(m, "照片", `照片（${m.session_name ?? "会话"}）`, { photos: [m.id].filter(Boolean), confidence: 0.5 });
    // 地点
    const locs = text.match(LOCATION_RE) ?? [];
    if (locs.length) addCard(m, "地点", `地点：${locs[0]}`, { location: locs[0], confidence: 0.7 });
    // 链接
    const links = Array.isArray(m?.links) ? m.links : [];
    if (links.length) addCard(m, "链接", `链接：${links[0]}`, { links: links.slice(0, 5), confidence: 0.6 });
  }

  const sorted = cards
    .sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""))
    .slice(0, maxCards);

  const timeline = sorted.map((c) => ({
    time: c.time, day: c.day, kind: c.kind, title: c.title,
    people: c.people, location: c.location, tags: c.tags, source_msg_ids: c.source_msg_ids,
  }));

  return {
    cards: sorted,
    timeline,
    stats: {
      cards: sorted.length,
      by_kind: Object.fromEntries([...countKinds(sorted)]),
      with_location: sorted.filter((c) => c.location).length,
      with_files: sorted.filter((c) => c.files.length).length,
      with_links: sorted.filter((c) => c.links.length).length,
    },
    search_hint: "卡片支持按 kind/tag/人/地点/时间检索；后续问答请引用 source_msg_ids，不臆造。",
    caliber: "卡片由关键词规则 + 附件标记 + 链接抽取生成；同一会话同一天的同类同题去重；内容已脱敏截断；不是人工整理结论。",
  };
}

function countKinds(cards) {
  const map = new Map();
  for (const c of cards) map.set(c.kind, (map.get(c.kind) ?? 0) + 1);
  return map;
}

/**
 * 记忆问答：在知识卡片 + 消息里检索，返回时间线式回答（引证据，不编造）。
 */
export function memoryAnswer(messages, query, { limit = 8 } = {}) {
  const q = String(query ?? "").trim();
  const terms = [...new Set([...(q.match(/[一-龥]{2,}/g) ?? []), ...(q.match(/[A-Za-z0-9]+/g) ?? [])])].filter((t) => t.length >= 2);
  const hits = [];
  for (const m of messages) {
    const text = String(m?.content ?? "");
    let score = 0;
    for (const t of terms) if (text.includes(t)) score += 1;
    if (!score) continue;
    hits.push({ score, row: evidence(m, { limit: 120 }) });
  }
  hits.sort((a, b) => b.score - a.score || (b.row.time ?? "").localeCompare(a.row.time ?? ""));
  const picked = hits.slice(0, limit);
  return {
    query: q,
    found: hits.length,
    timeline: picked.map((h) => h.row),
    answer: hits.length
      ? `找到 ${hits.length} 条相关记录，最近/最相关的 ${picked.length} 条见 timeline（含时间与 msg_id）。`
      : "当前时间窗内没有匹配记录（不臆测）。",
    confidence: hits.length >= 3 ? "中" : hits.length ? "低" : "无",
    caliber: "检索式回答：只返回真实命中的消息与时间线；找不到就说找不到。",
  };
}
