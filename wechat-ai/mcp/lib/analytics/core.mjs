// 分析共享核心：消息归类、中文无词典分词、时间桶、回复间隔、脱敏证据。
// 口径约定（对外报告需原样说明）：
// - 分词是 n-gram 近似（2-4 字滑窗 + 停用词裁剪 + 长词优先），不引入词典/分词器；
// - 消息类型由内容/附件标记推断，推不出就是 text；
// - 所有进报告的证据片段一律 maskPii + 截断，不输出第三方敏感原文。
import { fmtLocal, fmtDay, truncate } from "../util.mjs";

// ---------------- 消息类型 ----------------
const TRANSFER_RE = /转账|转给你|转我|给你转|给我转|收款|付款|已付|已收|打款|汇款|还款|还你|AA|平摊|红包|恭喜发财|领了.{0,6}红包|扫(?:码)?(?:付|收款)|二维码收款|零钱|提现/;
const REDPACKET_RE = /红包|恭喜发财|开红包|领取了?红包/;
const LOCATION_RE = /位置|定位|共享实时位置|地图|导航|在.{0,8}(?:路|街|道|巷|号|大厦|大楼|广场|中心|园区|酒店|咖啡|餐厅|地铁站?|机场|车站)/;
const VOICE_MARK = /\[(?:语音|声音|Voice)[^\]]*\]/i;
const IMAGE_MARK = /\[(?:图片|照片|image|photo|动画表情|表情包)[^\]]*\]/i;
const FILE_MARK = /\[(?:文件|视频|video|文件|聊天记录)[^\]]*\]|\.[a-z0-9]{2,5}\b(?![\d.])/i;

/** 消息类型归一：text|image|voice|file|transfer|redpacket|link|location */
export function classifyMessage(m) {
  const content = String(m?.content ?? "");
  const links = Array.isArray(m?.links) ? m.links : [];
  const atts = Array.isArray(m?.attachments) ? m.attachments : [];
  const kinds = new Set(atts.map((a) => String(a?.kind ?? "").toLowerCase()));
  if (kinds.has("image") || IMAGE_MARK.test(content)) return "image";
  if (kinds.has("voice") || VOICE_MARK.test(content)) return "voice";
  // URL 里的 .com/.cn 之类会被文件扩展名规则误伤：判定文件前先摘掉 URL
  const contentNoUrl = content.replace(/https?:\/\/\S+/gi, " ");
  if (kinds.has("file") || FILE_MARK.test(contentNoUrl)) return "file";
  if (REDPACKET_RE.test(content)) return "redpacket";
  if (TRANSFER_RE.test(content)) return "transfer";
  if (links.length > 0 || /https?:\/\//i.test(content)) return "link";
  if (LOCATION_RE.test(content)) return "location";
  return "text";
}

/** 消息类型分布（按 spec 的 type 口径） */
export function typeBreakdown(messages) {
  const counts = { text: 0, image: 0, voice: 0, file: 0, transfer: 0, redpacket: 0, link: 0, location: 0 };
  // classifyMessage 纯函数：每条只调一次（轮19 双调 hoist），输出逐位不变
  for (const m of messages) { const k = classifyMessage(m); counts[k] = (counts[k] ?? 0) + 1; }
  const total = messages.length || 0;
  const ratio = {};
  for (const [k, v] of Object.entries(counts)) ratio[k] = total ? Math.round((v / total) * 1000) / 10 : 0;
  return { counts, ratio, total };
}

// ---------------- 中文 n-gram 分词（无词典近似） ----------------
// 停用词按「词边界」裁剪：n-gram 首尾落在这些字/词上的一律不计。
const STOP_EDGE = new Set([
  ...Array.from("的了是我你他她它们这那就都也很还只把被让给对从到和与在有个不没会能要说看才并且或如果因为所以然后但是而且着过呢吗吧呀啊哦哈嗯呃嘛嘛哇哎唉嘿呵么之其及于以乃"),
]);
const STOP_WORDS = new Set([
  "我们", "你们", "他们", "这个", "那个", "什么", "怎么", "可以", "不是", "没有", "就是", "但是", "因为", "所以", "然后", "如果", "一个", "一下", "这样", "那样", "知道", "觉得", "现在", "时候", "问题", "谢谢", "好的", "哈哈", "嗯嗯", "已经", "还是", "还有", "这么", "那么", "比较", "其实", "直接", "需要", "应该", "可能", "或者", "开始", "今天", "明天", "昨天", "后天", "上午", "下午", "晚上", "时间", "消息", "收到", "OK",
]);
// 轮19：停用边字符位图（charCodeAt 直接索引，无哈希无分配）——热循环里首尾预检提到 slice
// 之前，被裁剪的 n-gram 不再分配子串、也不再做单字符字符串化查表。语义与旧「slice 后查
// term[0]/term[n-1]」逐位一致：CJK 串均为 BMP 单码元，charCodeAt 与字符串首尾等价
// （42 例 inc 序列 + termFreq sha256 对拍锁定）。
const STOP_EDGE_BITS = new Uint8Array(0x10000);
for (const c of STOP_EDGE) STOP_EDGE_BITS[c.codePointAt(0)] = 1;
const LATIN_RE = /[A-Za-z][A-Za-z0-9+#.\-]{1,20}/g;
const CJK_RUN_RE = /[一-龥]{2,}/g;
const CJK_UNIT_RE = /[一-龥]{1,4}(?:块钱|元|万|亿|人|天|次|条|个|张|部|台|位|岁|月|年|周|小时|分钟)/g;

/** 把一条文本的词（CJK n-gram + 数量单位 + 拉丁词）逐个交给 inc 计数：枚举一次，分桶方式由 inc 决定。 */
export function bumpTextInto(inc, text, maxN = 4) {
  if (!text) return;
  for (const run of text.match(CJK_RUN_RE) ?? []) {
    const lim = Math.min(maxN, run.length);
    for (let n = 2; n <= lim; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        // 首尾停用字符位图预检先行：不中才分配子串（被裁剪 n-gram 零分配）
        if (STOP_EDGE_BITS[run.charCodeAt(i)] || STOP_EDGE_BITS[run.charCodeAt(i + n - 1)]) continue;
        const term = run.slice(i, i + n);
        if (n === 2 && STOP_WORDS.has(term)) continue;
        inc(term);
      }
    }
  }
  for (const t of text.match(CJK_UNIT_RE) ?? []) inc(t);
  for (const t of text.match(LATIN_RE) ?? []) {
    const w = t.toLowerCase();
    if (w.length >= 2) inc(w);
  }
}

/** 计数表 → [{term,count}] 降序：minCount 预筛 + 长词优先裁剪 + 排序截断。 */
export function finishTermFreq(counts, { minCount = 2, limit = 30, keepLongerRatio = 0.75 } = {}) {
  // 长词优先：更长的 n-gram 覆盖了短词的绝大部分出现次数时，删掉短词，避免「合作/合作报/合作报价」三行都上榜。
  // 等价改写（防 O(E²) 退化）：other.includes(term) 且更长 ⟺ term 是 other 的连续子串，
  // 于是对每个词条枚举其 ≥2 字真子串、在 entries 里反查并记录覆盖计数上界，整体 O(E·L²)；
  // 删除条件「存在覆盖词计数 ≥ c×keepLongerRatio」取上界即与逐对比较完全一致（含多层嵌套覆盖）。
  const entries = [...counts.entries()].filter(([, c]) => c >= minCount);
  const inEntries = new Map(entries);
  const coverMax = new Map();
  for (const [term, c] of entries) {
    const L = term.length;
    for (let i = 0; i < L; i += 1) {
      for (let n = 2; n < L && i + n <= L; n += 1) {
        const sub = term.slice(i, i + n);
        if (!inEntries.has(sub)) continue;
        const prev = coverMax.get(sub);
        if (prev === undefined || c > prev) coverMax.set(sub, c);
      }
    }
  }
  const kept = entries.filter(([term, c]) => {
    const cov = coverMax.get(term);
    return cov === undefined || cov < c * keepLongerRatio;
  });
  kept.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
  return kept.slice(0, limit).map(([term, count]) => ({ term, count }));
}

/** 词频统计：返回 [{term,count}] 降序。n=2..maxN 滑窗，长词优先裁剪短词。 */
export function termFreq(messages, { maxN = 4, minCount = 2, limit = 30, keepLongerRatio = 0.75 } = {}) {
  const counts = new Map();
  const bump = (t) => counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const m of messages) bumpTextInto(bump, String(m?.content ?? ""), maxN);
  return finishTermFreq(counts, { minCount, limit, keepLongerRatio });
}

/** 口头禅：整条短文本重复出现的句子（长度 2-12 字，出现 >=3 次） */
export function catchphrases(messages, { minCount = 3, minLen = 2, maxLen = 12, limit = 15 } = {}) {
  const counts = new Map();
  for (const m of messages) {
    const t = String(m?.content ?? "").trim().replace(/\s+/g, "");
    if (t.length < minLen || t.length > maxLen) continue;
    if (/[【】\[\]{}<>@#|]/.test(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .slice(0, limit)
    .map(([text, count]) => ({ text, count }));
}

// ---------------- 表情 ----------------
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/gu;
const STICKER_RE = /\[[一-龥]{2,6}\]/g;
const STICKER_NOISE = new Set(["[图片]", "[视频]", "[语音]", "[文件]", "[位置]", "[聊天记录]", "[链接]", "[动画表情]"]);

export function emojiTop(messages, { limit = 30 } = {}) {
  const counts = new Map();
  const bump = (t) => counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const m of messages) {
    const text = String(m?.content ?? "");
    for (const e of text.match(EMOJI_RE) ?? []) bump(e);
    for (const s of text.match(STICKER_RE) ?? []) {
      if (!STICKER_NOISE.has(s)) bump(s);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .slice(0, limit)
    .map(([emoji, count]) => ({ emoji, count }));
}

// ---------------- 时间桶 ----------------
const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function hourBuckets(messages) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  for (const m of messages) {
    if (!m?.ts) continue;
    buckets[new Date(m.ts).getHours()].count += 1;
  }
  return buckets;
}

export function weekdayBuckets(messages) {
  const buckets = Array.from({ length: 7 }, (_, i) => ({ weekday: i, label: WEEKDAY_CN[i], count: 0 }));
  for (const m of messages) {
    if (!m?.ts) continue;
    buckets[new Date(m.ts).getDay()].count += 1;
  }
  return buckets;
}

export function dayBuckets(messages) {
  const map = new Map();
  for (const m of messages) {
    const day = m?.day ?? (m?.ts ? fmtDay(new Date(m.ts)) : null);
    if (!day) continue;
    map.set(day, (map.get(day) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, count]) => ({ day, count }));
}

export function monthBuckets(messages) {
  const map = new Map();
  for (const m of messages) {
    if (!m?.ts) continue;
    const key = fmtDay(new Date(m.ts)).slice(0, 7);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, count]) => ({ month, count }));
}

/** 最长连续聊天天数 / 单日峰值 / 最长静默间隔 */
export function activityStreaks(messages) {
  const days = dayBuckets(messages).map((d) => d.day);
  let best = 0, cur = 0, prev = null;
  for (const day of days) {
    if (prev && diffDayKeys(prev, day) === 1) cur += 1;
    else cur = 1;
    best = Math.max(best, cur);
    prev = day;
  }
  const daily = dayBuckets(messages);
  const peak = daily.reduce((acc, d) => (d.count > (acc?.count ?? -1) ? d : acc), null);
  let maxGap = 0, gapFrom = null, gapTo = null;
  const ts = messages.map((m) => Number(m.ts)).filter((t) => t > 0).sort((a, b) => a - b);
  for (let i = 1; i < ts.length; i += 1) {
    const gap = ts[i] - ts[i - 1];
    if (gap > maxGap) { maxGap = gap; gapFrom = ts[i - 1]; gapTo = ts[i]; }
  }
  return {
    longest_streak_days: best,
    peak_day: peak ? { day: peak.day, count: peak.count } : null,
    longest_gap_hours: maxGap ? Math.round((maxGap / 3600000) * 10) / 10 : 0,
    longest_gap: maxGap ? { from: fmtLocal(new Date(gapFrom)), to: fmtLocal(new Date(gapTo)) } : null,
  };
}

function diffDayKeys(a, b) {
  return Math.round((Date.parse(b + "T00:00:00") - Date.parse(a + "T00:00:00")) / 86400000);
}

// ---------------- 回复间隔 ----------------
/**
 * 会话内回复间隔：相邻两条不同发送者消息的时间差。
 * 我回复对方 = 上一条对方 → 下一条我；对方回复我 = 反向。只统计同一会话。
 */
export function replyIntervals(messages) {
  const byChat = groupByChat(messages);
  const mine = [], theirs = [];
  for (const list of byChat.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1], cur = list[i];
      if (!prev.ts || !cur.ts) continue;
      if (!!prev.is_owner === !!cur.is_owner) continue;
      const hours = (cur.ts - prev.ts) / 3600000;
      if (hours < 0 || hours > 24 * 7) continue; // 超过 7 天不视为「回复」
      (cur.is_owner ? mine : theirs).push(hours);
    }
  }
  const stat = (arr) => {
    if (!arr.length) return { count: 0, avg_minutes: null, median_minutes: null, p90_minutes: null };
    const mins = arr.map((h) => h * 60).sort((a, b) => a - b);
    return {
      count: mins.length,
      avg_minutes: Math.round(mins.reduce((a, b) => a + b, 0) / mins.length),
      median_minutes: Math.round(mins[Math.floor(mins.length / 2)]),
      p90_minutes: Math.round(mins[Math.min(mins.length - 1, Math.floor(mins.length * 0.9))]),
    };
  };
  return { mine: stat(mine), theirs: stat(theirs) };
}

export function groupByChat(messages) {
  const map = new Map();
  for (const m of messages) {
    const key = m?.session_name ?? m?.chat ?? "未知会话";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return map;
}

/** 会话对象（私聊取对方名；群聊取群名） */
export function counterpartOf(m) {
  return m?.is_owner ? "我" : (m?.sender ?? "未知");
}

// ---------------- 聚合小工具 ----------------
export function countBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

export function topEntries(map, limit = 20) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "zh"))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function round(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(Number(n) * p) / p;
}

// ---------------- 脱敏 ----------------
// 顺序即语义：长号码先于短号码。手机号规则若排在前面会先吞掉身份证/卡号的中段，
// 留下"前 6 后 1"碎片（如 110101199001011234 → 110101<手机号>4）。
const PII_RULES = [
  { re: /\d{17}[\dXx]/g, to: "<身份证>" },
  { re: /\d{16,19}/g, to: "<银行卡>" },
  { re: /1[3-9]\d{9}/g, to: "<手机号>" },
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g, to: "<邮箱>" },
  { re: /(?<![\d.])(?:密码|口令|验证码|校验码|pwd|password)\s*[:=：]?\s*\S{3,}/gi, to: "<凭据>" },
  { re: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/g, to: "<私钥>" },
];

/** 报告/证据脱敏：手机号、身份证、银行卡、邮箱、验证码口令一律打码 */
export function maskPii(text) {
  let out = String(text ?? "");
  for (const rule of PII_RULES) out = out.replace(rule.re, rule.to);
  return out;
}

/** JSON 脱敏：只对字符串值打码；数字/布尔保留原样，机器消费的字段不受影响 */
export function maskDeep(value) {
  if (typeof value === "string") return maskPii(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v);
    return out;
  }
  return value;
}

/**
 * 证据片段（对外展示用）：{msg_id, time, sender, chat, text}，文本已脱敏截断。
 * spec 要求结论附证据，但不主动暴露第三方敏感原文——这里统一口径。
 */
export function evidence(m, { limit = 120, now } = {}) {
  return {
    msg_id: m?.id ?? null,
    time: m?.ts ? fmtLocal(new Date(m.ts)) : null,
    sender: m?.is_owner ? "我" : (m?.sender ?? "未知"),
    chat: m?.session_name ?? m?.chat ?? "未知会话",
    text: maskPii(truncate(String(m?.content ?? "").replace(/\s+/g, " "), limit)),
  };
}

export { fmtLocal, fmtDay, truncate };
