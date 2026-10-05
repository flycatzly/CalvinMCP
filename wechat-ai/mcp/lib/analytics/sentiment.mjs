// C. 情绪与心理趋势：词典法情感打分、日/周/月聚合、压力源话题、夜间消息、冲突/安慰词。
// 重要：这是文本情绪线索，不是心理/医疗诊断；输出必须带 limitations。
import { round, evidence, topEntries, fmtDay } from "./core.mjs";

const POS_RE = /开心|高兴|喜欢|太棒|不错|赞|厉害|优秀|顺利|成功|搞定|完成|感谢|谢谢|幸福|期待|好玩|好看|舒服|满意|值得|稳了|破防了|好耶|哈哈|嘿嘿|加油|恭喜|温暖|感动|甜/;
const NEG_RE = /难过|伤心|失望|生气|愤怒|气死|烦|焦虑|担心|害怕|崩溃|累死|压力|痛苦|哭|糟糕|失败|出错|报错|坑|投诉|垃圾|离谱|无语|委屈|孤独|难受|疼|病|失眠|拖延|后悔|抱歉|对不起|可惜|凉了|完蛋|翻车|吵架|分手/;
const NEGATION_RE = /(?:不|没|没有|别|未|无|毫不|不再|不算|不至于)/;
const INTENSIFIER_RE = /(?:太|超|超|特别|非常|真的|好|真|挺|很|巨|老|贼|简直)/;
const CONFLICT_RE = /吵|争执|翻脸|投诉|举报|骗子|骗|凭什么|太过分|忍无可忍|拉黑|绝交|对骂/;
const COMFORT_RE = /别担心|没关系|没事的?|抱抱|辛苦了|加油|慢慢来|不着急|理解你|会好的|我陪你|放心/;
const STRESS_TOPICS = {
  工作: /加班|deadline|赶工|通宵|绩效|裁员|汇报|甲方|需求变更|开会|出差|996|职场/,
  金钱: /缺钱|还不上|账单|借款|月光|负债|房贷|房租|信用卡|花呗|穷|借钱/,
  健康: /失眠|发烧|感冒|住院|吃药|疼|复诊|体检|焦虑|抑郁|不舒服/,
  感情: /分手|吵架|冷战|异地|失恋|暧昧|表白|结婚|催婚/,
  学业: /考试|论文|挂科|延毕|答辩|作业|复习|成绩/,
  家庭: /爸妈|父母|催婚|带娃|婆媳|家里|孩子|老人/,
  人际: /同事|朋友|室友|误会|背后|闲话|孤立|不合群/,
};
// scoreOf 每调用 new RegExp 会把编译成本摊到每条消息（200k 逐条实测 177→94ms）；
// /g 形态与源正则同 pattern/flags，matchAll 内部克隆、String.match(/g) 重置 lastIndex，
// 共享副本不回写状态（跨调用无关性由 analytics 状态锁测试与固定语料 sha256 对拍锁定）。
const POS_G = new RegExp(POS_RE.source, "g");
const NEG_G = new RegExp(NEG_RE.source, "g");
const CONFLICT_G = new RegExp(CONFLICT_RE.source, "g");
const COMFORT_G = new RegExp(COMFORT_RE.source, "g");
// 逐消息循环里的常量表提升，免每条消息重建 entries 数组（键序 = 对象字面量插入序，不变）。
const STRESS_ENTRIES = Object.entries(STRESS_TOPICS);

/**
 * 情绪趋势。score ∈ [-1,1]：正向 +1、负向 -1、中性 0，否定词翻转、程度词加权。
 * @param {Array} messages 归一化消息行
 */
export function sentimentTrend(messages, { sinceMs, untilMs, now = new Date() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const daily = new Map();
  let positive = 0, negative = 0, neutral = 0, scoreSum = 0, scored = 0;
  const conflictHits = new Map(), comfortHits = new Map();
  const stressHits = new Map(Object.keys(STRESS_TOPICS).map((k) => [k, 0]));
  const stressSamples = new Map();
  const nightRows = [];

  for (const m of list) {
    const text = String(m?.content ?? "");
    if (!text.trim()) continue;
    const s = scoreOf(text);
    scored += 1;
    scoreSum += s.score;
    if (s.score > 0.2) positive += 1;
    else if (s.score < -0.2) negative += 1;
    else neutral += 1;

    const day = m.day ?? (m.ts ? fmtDay(new Date(m.ts)) : "未知");
    if (!daily.has(day)) daily.set(day, { day, messages: 0, positive: 0, negative: 0, neutral: 0, score_sum: 0 });
    const d = daily.get(day);
    d.messages += 1;
    d.score_sum += s.score;
    if (s.score > 0.2) d.positive += 1;
    else if (s.score < -0.2) d.negative += 1;
    else d.neutral += 1;

    for (const w of s.conflict) conflictHits.set(w, (conflictHits.get(w) ?? 0) + 1);
    for (const w of s.comfort) comfortHits.set(w, (comfortHits.get(w) ?? 0) + 1);

    for (const [topic, re] of STRESS_ENTRIES) {
      if (re.test(text)) {
        stressHits.set(topic, stressHits.get(topic) + 1);
        if ((stressSamples.get(topic)?.length ?? 0) < 3) {
          if (!stressSamples.has(topic)) stressSamples.set(topic, []);
          stressSamples.get(topic).push(evidence(m, { limit: 80 }));
        }
        break;
      }
    }
    const hour = m.ts ? new Date(m.ts).getHours() : -1;
    if ((hour >= 23 || hour < 5) && (s.score < -0.2 || CONFLICT_RE.test(text))) {
      nightRows.push({ ...evidence(m, { limit: 80 }), hour });
    }
  }

  const dailySentiment = [...daily.values()]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((d) => ({
      day: d.day,
      messages: d.messages,
      positive: d.positive,
      negative: d.negative,
      neutral: d.neutral,
      score: round(d.score_sum / Math.max(1, d.messages), 3),
    }));

  // 波动最大的日子：|当日得分 - 相邻日均值|
  const volatility = dailySentiment.map((d, i) => {
    const around = [dailySentiment[i - 1], dailySentiment[i + 1]].filter(Boolean);
    const base = around.length ? around.reduce((a, b) => a + b.score, 0) / around.length : 0;
    return { day: d.day, score: d.score, swing: round(Math.abs(d.score - base), 3), messages: d.messages };
  }).filter((v) => v.messages >= 2).sort((a, b) => b.swing - a.swing).slice(0, 8);

  // 高风险时段：负面占比高 / 冲突集中 / 夜间负面（仅线索，不做诊断）
  const highRisk = dailySentiment.filter((d) =>
    (d.negative >= 3 && d.negative / Math.max(1, d.messages) >= 0.5) || (d.messages >= 3 && d.score <= -0.5),
  ).slice(0, 10).map((d) => ({
    day: d.day,
    score: d.score,
    reasons: [
      d.negative / Math.max(1, d.messages) >= 0.5 ? `负面占比 ${round((d.negative / d.messages) * 100, 0)}%` : null,
      d.score <= -0.5 ? `当日均分 ${d.score}` : null,
    ].filter(Boolean),
    evidence: list.filter((m) => (m.day ?? (m.ts ? fmtDay(new Date(m.ts)) : null)) === d.day).slice(0, 3).map((m) => evidence(m, { limit: 60 })),
  }));

  const total = Math.max(1, scored);
  return {
    period: {
      since: sinceMs ? new Date(sinceMs).toISOString() : null,
      until: untilMs ? new Date(untilMs).toISOString() : null,
    },
    messages_scored: scored,
    positive_ratio: round(positive / total, 4),
    negative_ratio: round(negative / total, 4),
    neutral_ratio: round(neutral / total, 4),
    avg_score: round(scoreSum / total, 3),
    daily_sentiment: dailySentiment,
    volatility_periods: volatility,
    stress_topics: [...stressHits.entries()]
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([topic, hits]) => ({ topic, hits, ratio: round(hits / total, 4), sample: stressSamples.get(topic) ?? [] })),
    conflict_words: topEntries(conflictHits, 15).map((e) => ({ word: e.key, count: e.count })),
    comfort_words: topEntries(comfortHits, 15).map((e) => ({ word: e.key, count: e.count })),
    night_negative_messages: nightRows.slice(0, 15),
    high_risk_periods: highRisk,
    limitations: "词典 + 否定/程度规则的文本情绪线索，不是心理或医疗诊断；网络用语、反讽、表情包语义会误判；样本不足时结论不可靠。请把结果当趋势提示，不当临床结论。",
  };
}

/** 单条消息情感打分：{score, conflict, comfort}，score ∈ [-1.5,1.5] */
export function scoreOf(text) {
  const t = String(text ?? "");
  let score = 0;
  for (const m of t.matchAll(POS_G)) score += weightAt(t, m.index) * 1;
  for (const m of t.matchAll(NEG_G)) score += weightAt(t, m.index) * -1;
  const conflict = (t.match(CONFLICT_G) ?? []).slice(0, 5);
  const comfort = (t.match(COMFORT_G) ?? []).slice(0, 5);
  return { score: Math.max(-1.5, Math.min(1.5, score)), conflict, comfort };
}

/** 命中词前 4 字内出现否定词则翻转；程度词加权 1.4 */
function weightAt(text, index) {
  const before = text.slice(Math.max(0, index - 4), index);
  const after = text.slice(index, index + 6);
  let w = 1;
  if (NEGATION_RE.test(before)) w *= -1;
  if (INTENSIFIER_RE.test(before) || INTENSIFIER_RE.test(after)) w *= 1.4;
  return w;
}

export { topEntries };
