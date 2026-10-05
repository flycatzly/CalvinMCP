// G. 内容分析：词频/短语/表情、话题聚类、意图识别、实体抽取、抽取式摘要、检索问答。
// 口径：全部是确定性规则 + n-gram 近似，不做模型推断；问答只引用真实命中的 msg_id，不编造。
import { termFreq, bumpTextInto, finishTermFreq, catchphrases, emojiTop, classifyMessage, evidence, round, truncate } from "./core.mjs";
import { extractAmounts, extractDueDates } from "../signals.mjs";

// ---------------- 话题聚类（关键词集合命中） ----------------
export const TOPIC_SETS = {
  工作: /项目|排期|需求|方案|评审|上线|交付|客户|汇报|开会|加班|KPI|OKR|offer|简历|面试|甲方|乙方|需求文档|工时/,
  商务: /合作|商单|投放|报价|预算|品牌|推广|佣金|返佣|结算|发票|合同|签约|brief|campaign|sponsor|invoice|付款|定金|尾款/,
  家庭: /爸妈|父亲|母亲|家里|孩子|儿子|女儿|老婆|老公|长辈|家人|回家|过年|年夜饭|家/,
  感情: /喜欢|想你|爱你|对象|男朋友|女朋友|分手|吵架|和好|恋爱|约会|表白|结婚/,
  金钱: /转账|红包|还款|借钱|工资|房租|水电|账单|AA|平摊|报销|理财|基金|股票|存款|花呗|信用卡/,
  健康: /医院|看病|发烧|感冒|药|体检|牙|疼|睡眠|失眠|锻炼|跑步|减肥|复诊/,
  学业: /作业|考试|论文|课程|老师|同学|学校|复习|成绩|毕业|答辩|实验室|论文/,
  娱乐: /电影|游戏|追剧|综艺|演唱会|剧本杀|开黑|排位|球|健身|露营|旅行|旅游|攻略/,
  餐饮: /吃饭|外卖|火锅|奶茶|咖啡|餐厅|好吃|菜|做饭|约饭|宵夜|烧烤/,
  技术: /bug|代码|接口|部署|服务器|数据库|模型|算法|上线|报错|崩溃|版本|npm|git|API|MCP|微信|机器人/,
  购物: /买了|下单|快递|退货|优惠|券|拼单|淘宝|京东|拼多多|链接|店铺|包邮|打折/,
  出行: /机票|高铁|火车|航班|打车|地铁|导航|酒店|民宿|行程|出发|晚点|值机/,
};

function topicRows(messages, { minHits = 2, topTerms = 5, maxN = 4 } = {}, globalCounts = null) {
  const total = messages.length || 1;
  const topics = Object.entries(TOPIC_SETS);
  const N = topics.length;
  const hitsArr = topics.map(() => []);
  // 单表 + 槽位数组（命中位图分桶）：term → 长度 N 的计数槽，n-gram 每条消息只枚举一次，
  // 逐槽累加等价于逐话题 termFreq(hits)（minCount 预筛只影响末尾过滤，不影响计数本身）
  const counts = new Map();
  const cur = [];
  const slotInc = (term) => {
    let arr = counts.get(term);
    if (arr === undefined) { arr = new Array(N).fill(0); counts.set(term, arr); }
    for (let j = 0; j < cur.length; j += 1) arr[cur[j]] += 1;
  };
  // 轮17：传入 globalCounts 时同一次枚举兼落全局词频（contentAnalysis 免枚举两遍 n-gram）；
  // 未传时 inc 即 slotInc，topicClusters 独立路径与原实现操作序列逐位一致。
  const inc = globalCounts
    ? (term) => { globalCounts.set(term, (globalCounts.get(term) ?? 0) + 1); if (cur.length) slotInc(term); }
    : slotInc;
  for (const m of messages) {
    const text = String(m?.content ?? "");
    cur.length = 0;
    for (let ti = 0; ti < N; ti += 1) {
      if (!topics[ti][1].test(text)) continue;
      hitsArr[ti].push(m);
      cur.push(ti);
    }
    if (globalCounts || cur.length) bumpTextInto(inc, text, maxN);
  }
  const buckets = topics.map(() => new Map());
  for (const [term, arr] of counts) {
    for (let ti = 0; ti < N; ti += 1) {
      const c = arr[ti];
      if (c >= 2) buckets[ti].set(term, c); // 与 finishTermFreq 的 minCount:2 预筛同义
    }
  }
  const rows = [];
  for (let ti = 0; ti < N; ti += 1) {
    const hits = hitsArr[ti];
    if (hits.length < minHits) continue;
    rows.push({
      topic: topics[ti][0],
      hits: hits.length,
      share: round(hits.length / total, 4),
      top_terms: finishTermFreq(buckets[ti], { limit: topTerms, minCount: 2 }),
      sample: hits.slice(0, 2).map((m) => evidence(m, { limit: 80 })),
    });
  }
  return rows.sort((a, b) => b.hits - a.hits || a.topic.localeCompare(b.topic, "zh"));
}

export function topicClusters(messages, opts) {
  return topicRows(messages, opts);
}

/** 词频×话题共享单遍（轮17）：一次 bumpTextInto 同时落全局词频计数与话题槽位，免对同一
 *  语料枚举两遍 n-gram（长消息实测省 20-25%；短串语料枚举占比低、收益趋零）。keywords 与
 *  termFreq(messages,{limit}) 逐位一致、topics 与 topicClusters(messages) 逐位一致
 *  （固定语料 sha256 对拍 + analytics 逐字段等价测试锁定）。 */
export function keywordsAndTopics(messages, { maxN = 4, minCount = 2, limit = 30, keepLongerRatio = 0.75, minHits = 2, topTerms = 5 } = {}) {
  const counts = new Map();
  const topics = topicRows(messages, { minHits, topTerms, maxN }, counts);
  return {
    keywords: finishTermFreq(counts, { minCount, limit, keepLongerRatio }),
    topics,
  };
}

// ---------------- 意图识别 ----------------
const INTENT_RULES = [
  // 顺序即优先级：冲突/抱怨优先于普通询问，避免「你们怎么这么慢？」只算询问
  { intent: "冲突", re: /吵|凭什么|不讲理|骗子|骗我|投诉你|要投诉|太过分|忍无可忍|绝交|拉黑|删了你/ },
  { intent: "抱怨", re: /烦死|气死|无语|离谱|坑|太慢|太贵|垃圾|受够了|崩溃|好累|累死|加班到|又被/ },
  { intent: "安慰", re: /别担心|没关系|没事的|抱抱|辛苦了|加油|理解你|会好的|慢慢来|不着急/ },
  { intent: "请求", re: /麻烦|帮忙|拜托|求你|能不能帮|可以帮我|发我一下|给我一份|支援一下|救急/ },
  { intent: "询问", re: /请问|[?？]|多少|什么时候|哪天|哪里|怎么|谁|哪个|是否|有没有|是不是|吗[?？]?\s*$/ },
  { intent: "约定", re: /约|见面|碰面|开会|会议|几点|周[一二三四五六日天]|明天|后天|下周|改天|约个时间|日程|排期确认|定在/ },
  { intent: "通知", re: /通知|公告|请注意|即日起|调整为|已更新|已发布|上线了|改到|延期|取消了|照常/ },
  { intent: "确认", re: /^(?:收到|好的|好滴|好呀|OK|ok|没问题|确认|可以|嗯嗯|明白)[!！~～。.\s]*$/ },
  { intent: "感谢", re: /谢谢|感谢|多谢|麻烦你了|辛苦(?:老师|你|啦|了)/ },
  { intent: "承诺", re: /我会|我来|我稍后|我明天|回头我|待会.{0,6}(?:发|给|弄)|记得提醒我/ },
];

export function intentDistribution(messages, { examplesPerIntent = 2 } = {}) {
  const counts = new Map();
  const examples = new Map();
  for (const m of messages) {
    const text = String(m?.content ?? "");
    if (!text.trim()) continue;
    let hit = "其他";
    for (const rule of INTENT_RULES) {
      if (rule.re.test(text)) { hit = rule.intent; break; }
    }
    counts.set(hit, (counts.get(hit) ?? 0) + 1);
    if (hit !== "其他" && (examples.get(hit)?.length ?? 0) < examplesPerIntent) {
      if (!examples.has(hit)) examples.set(hit, []);
      examples.get(hit).push(evidence(m, { limit: 60 }));
    }
  }
  const total = messages.length || 1;
  return {
    counts: Object.fromEntries(counts),
    ratio: Object.fromEntries([...counts].map(([k, v]) => [k, round(v / total, 4)])),
    examples: Object.fromEntries(examples),
    caliber: "意图按规则关键词匹配，一条消息只归一类（按冲突>抱怨>安慰>请求>询问>约定>通知>确认>感谢>承诺的优先级）。",
  };
}

// ---------------- 实体抽取 ----------------
const ORG_RE = /[一-龥]{2,12}?(?:有限公司|股份公司|科技|集团|银行|医院|大学|学院|事务所|工作室|研究院|工作室|政府|支行|分行|基金会|协会|委员会|工作室)/g;
const PERSON_TITLE_RE = /(王|李|张|刘|陈|杨|赵|黄|周|吴|徐|孙|胡|朱|高|林|何|郭|马)(?:总|工|老师|医生|经理|主任|校长|教授|律师|师傅|同学|哥|姐|姐夫|阿姨|叔叔)/g;
const AT_RE = /@([一-龥A-Za-z0-9_\-]{2,20})/g;
const LOCATION_RE = /(?:地址[:：]?\s*)?(?:[一-龥]{2,10}(?:路|街|道|巷|弄|大道|大街)\d{0,4}号?|[一-龥]{2,12}(?:大厦|大楼|广场|中心|园区|产业园|酒店|宾馆|咖啡厅?|餐厅|书店|医院|学校|地铁站?|机场|火车站|高铁站|体育馆|公园|商场|超市))/g;
const EVENT_RE = /(会议|例会|评审会|发布会|上线|开工|奠基|签约|验收|交付|试讲|培训|团建|聚餐|婚礼|面试|考试|答辩|出差|旅行|搬家|年会|展会|沙龙|直播)/g;

/** 正则族预筛门（轮15）：从正则源串自动派生「必要条件字符类」——各最内层交替组的
 *  纯字面分支（可带 ? 量词尾）取首字符，再加源串首字面量（如 AT_RE 的 @）。这些正则的
 *  结构保证任一匹配必含至少一个分支首字符（分支纯字面，其匹配必含首字符），故门不中
 *  即可跳过全文扫描；门命中仅回退原正则，不做近似判定。解析不到字面分支返回 null
 *  （fail-open：直跑原正则，只丢优化不丢正确性）。门不带 g，test 无状态；
 *  等价由 analytics 双路径测试（全关键词正例 + 负例）与固定语料 sha256 对拍锁定。 */
function keywordGate(re) {
  try {
    const isLit = (s) => s && !/[[\]\\^$*+?{}|()/]/.test(s);
    let chars = "";
    for (const m of re.source.matchAll(/\((?:\?:)?([^()]*)\)/g)) {
      for (const frag of m[1].split("|")) {
        const lit = frag.replace(/\?$/, "");
        if (isLit(lit)) chars += lit[0];
      }
    }
    if (isLit(re.source[0])) chars += re.source[0];
    const cls = [...new Set(chars)].map((c) => c.replace(/[\\\]^-]/g, "\\$&")).join("");
    return cls ? new RegExp("[" + cls + "]") : null;
  } catch {
    return null;
  }
}
const LOCATION_GATE = keywordGate(LOCATION_RE);
const ORG_GATE = keywordGate(ORG_RE);
const EVENT_GATE = keywordGate(EVENT_RE);
const AT_GATE = keywordGate(AT_RE);
const PERSON_TITLE_GATE = keywordGate(PERSON_TITLE_RE);

// 供测试：从活正则源派生全量关键词夹具 + 直测门的必要条件（勿在业务路径引用）。
export const ENTITY_RES = { LOCATION_RE, ORG_RE, EVENT_RE, AT_RE, PERSON_TITLE_RE };
export { keywordGate };

export function entityTable(messages, { ref = new Date(), limit = 40 } = {}) {
  // 聚合直建 dedupe 映射（轮15）：原「push 入数组 → 事后 dedupe」会为每次命中分配
  // 临时对象（其中 time 字段从未被 dedupe 读取，属死分配），改为计数时直接落映射。
  // 逐行推进保持命中顺序，count 与前 5 条 msg_ids 语义与旧实现逐位一致（输出排序与插入序无关）。
  const times = new Map(), locations = new Map(), persons = new Map(), amounts = new Map(), orgs = new Map(), events = new Map();
  const push = (map, value, m) => {
    if (!value) return;
    let row = map.get(value);
    if (!row) { row = { value, count: 0, msg_ids: [] }; map.set(value, row); }
    row.count += 1;
    if (row.msg_ids.length < 5 && m?.id) row.msg_ids.push(m.id);
  };
  for (const m of messages) {
    const text = String(m?.content ?? "");
    if (!text) continue;
    for (const t of extractDueDates(text, m?.ts ? new Date(m.ts) : ref)) push(times, t.text, m);
    for (const a of extractAmounts(text)) push(amounts, a, m);
    if (!LOCATION_GATE || LOCATION_GATE.test(text)) for (const mm of text.matchAll(LOCATION_RE)) push(locations, mm[0], m);
    if (!ORG_GATE || ORG_GATE.test(text)) for (const mm of text.matchAll(ORG_RE)) push(orgs, mm[0], m);
    if (!EVENT_GATE || EVENT_GATE.test(text)) for (const mm of text.matchAll(EVENT_RE)) push(events, mm[0], m);
    if (!AT_GATE || AT_GATE.test(text)) for (const mm of text.matchAll(AT_RE)) push(persons, mm[1], m);
    if (!PERSON_TITLE_GATE || PERSON_TITLE_GATE.test(text)) for (const mm of text.matchAll(PERSON_TITLE_RE)) push(persons, mm[0], m);
    if (!m.is_owner && m.sender) push(persons, m.sender, m);
  }
  const dedupe = (map) => [...map.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh")).slice(0, limit);
  return {
    time: dedupe(times),
    location: dedupe(locations),
    person: dedupe(persons),
    amount: dedupe(amounts),
    org: dedupe(orgs),
    event: dedupe(events),
    caliber: "实体按正则与既有日期/金额抽取器提取；人名包含发送者昵称与 @提及，可能重复计数；不编造未出现实体。",
  };
}

// ---------------- 抽取式摘要 ----------------
// 打分/切句正则提级（轮18-②）：正则字面量每次求值都新建 RegExp 对象，逐句重复分配无谓；
// 提级为模块常量后共享（均无 /g，test 无状态，语义与字面量逐位一致，sha256 对拍锁定）。
const SEG_SPLIT_RE = /[。！？!?；;\n]/;
const DIGIT_RE = /[0-9一二三四五六七八九十百千万]/;
const LATIN3_RE = /[A-Za-z]{3,}/;
const KEYWORD_RE = /(?:会议|决定|确认|发布|上线|交付|签约|报价|预算|时间|地点|地址|截止|延期|完成|需要|问题)/;
const QUESTION_RE = /[?？]/;
const POLITE_RE = /^(?:好的|收到|嗯|哈哈|OK|ok|谢谢)/;

/** kinds（可选，轮18-①）：与 messages 等长的预分类结果；给出时每条不再重复 classifyMessage */
export function extractiveSummary(messages, { maxBullets = 8, now = new Date(), kinds = null } = {}) {
  const sentences = [];
  let i = 0;
  for (const m of messages) {
    const text = String(m?.content ?? "").trim();
    const pre = kinds ? kinds[i] : undefined;
    i += 1;
    // 句段是全文的切分片段（长度 ≤ 全文）：全文 < 8 字必无合格句段，前置短路免 split/打分
    if (text.length < 8) continue;
    const kind = pre === undefined ? classifyMessage(m) : pre;
    if (kind !== "text" && kind !== "link") continue;
    for (const seg of text.split(SEG_SPLIT_RE)) {
      const s = seg.trim();
      if (s.length < 8 || s.length > 120) continue;
      // 信息密度：实体命中 + 关键词长度 + 疑问/陈述修正
      let score = Math.min(s.length, 60) / 20;
      if (DIGIT_RE.test(s)) score += 1;
      if (LATIN3_RE.test(s)) score += 0.5;
      if (KEYWORD_RE.test(s)) score += 1.5;
      if (QUESTION_RE.test(s)) score -= 0.5;
      if (POLITE_RE.test(s)) score -= 2;
      sentences.push({ text: s, score, msg: m });
    }
  }
  sentences.sort((a, b) => b.score - a.score || (a.msg.ts ?? 0) - (b.msg.ts ?? 0));
  const bullets = [];
  for (const s of sentences) {
    if (bullets.length >= maxBullets) break;
    if (bullets.some((b) => b.text.slice(0, 10) === s.text.slice(0, 10))) continue;
    bullets.push({
      text: truncate(s.text, 100),
      score: round(s.score, 2),
      ...evidence(s.msg, { limit: 100 }),
    });
  }
  return {
    bullets,
    method: "抽取式（按信息密度打分选句），不是生成式改写；只保留原句片段，不扩写结论。",
  };
}

// ---------------- 检索问答（只引用命中证据） ----------------
const QA_STOP = new Set(["什么", "怎么", "为什么", "哪些", "这个", "那个", "我们", "你们", "请问", "一下", "知道", "可以", "没有", "是不是", "时候", "问题"]);

function qaTerms(query) {
  const terms = new Set();
  const q = String(query ?? "");
  for (const run of q.match(/[一-龥]{2,}/g) ?? []) {
    for (let n = 2; n <= Math.min(4, run.length); n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const t = run.slice(i, i + n);
        if (!QA_STOP.has(t)) terms.add(t);
      }
    }
  }
  for (const t of q.match(/[A-Za-z][A-Za-z0-9+#.\-]{1,20}/g) ?? []) terms.add(t.toLowerCase());
  for (const t of q.match(/\d+(?:\.\d+)?/g) ?? []) terms.add(t);
  return [...terms];
}

/**
 * 基于聊天记录的检索式问答：返回命中的证据与抽取式回答。
 * 找不到就明说找不到——绝不编造。
 */
export function answerQuestion(messages, query, { limit = 8, maxLength = 120 } = {}) {
  const terms = qaTerms(query);
  const scored = [];
  for (const m of messages) {
    const text = String(m?.content ?? "");
    if (!text) continue;
    let score = 0;
    for (const t of terms) if (text.toLowerCase().includes(t)) score += 1;
    if (!score) continue;
    // 完整问句出现在内容里时强命中
    const q = String(query ?? "").trim();
    if (q.length >= 4 && text.includes(q)) score += 3;
    scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.m.ts ?? 0) - (a.m.ts ?? 0));
  const hits = scored.slice(0, limit).map((s) => ({ ...evidence(s.m, { limit: maxLength }), score: s.score }));
  if (!hits.length) {
    return {
      query,
      answer: "在当前时间窗内的记录中没有找到相关消息（不臆测）。",
      evidence: [],
      confidence: "无",
      method: "关键词 + n-gram 检索；只返回真实命中，无命中即明说。",
    };
  }
  return {
    query,
    answer: `找到 ${scored.length} 条相关消息，最相关的 ${hits.length} 条见 evidence（原文片段已脱敏）。`,
    evidence: hits,
    confidence: scored.length >= 3 ? "中" : "低",
    method: "关键词 + n-gram 检索；只返回真实命中，无命中即明说。",
  };
}

/** 词频/短语/表情三件套（A、G 共用口径） */
export function lexicalStats(messages, { limit = 30 } = {}) {
  return {
    keywords: termFreq(messages, { limit }),
    catchphrases: catchphrases(messages, { limit: 15 }),
    emojis: emojiTop(messages, { limit }),
  };
}

/** 内容分析总入口（轮17：keywords×topics 走共享单遍，catchphrases/emojis 独立便宜勿动；
 *  轮18：classifyMessage 每条恰一次，summary 与 type_breakdown 共用；F4：type_breakdown 由 kinds 直建普通对象） */
export function contentAnalysis(messages, { top = 20, now = new Date() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const kinds = list.map((m) => classifyMessage(m));
  const { keywords, topics } = keywordsAndTopics(list, { limit: top });
  return {
    total: list.length,
    keywords,
    catchphrases: catchphrases(list, { limit: 15 }),
    emojis: emojiTop(list, { limit: top }),
    topics,
    intents: intentDistribution(list),
    entities: entityTable(list, { ref: now }),
    summary: extractiveSummary(list, { now, kinds }),
    type_breakdown: typeBreakdownFromKinds(kinds),
  };
}

/** 类型分布（F4）：由预分类 kinds 直接建 {counts, ratio, total}，与 core.typeBreakdown 同形同口径。
 *  不用 countBy：Map 在 JSON 序列化（MCP textResult / content.json）里会丢成 {}，必须是普通对象。 */
function typeBreakdownFromKinds(kinds) {
  const counts = { text: 0, image: 0, voice: 0, file: 0, transfer: 0, redpacket: 0, link: 0, location: 0 };
  for (const k of kinds) counts[k] = (counts[k] ?? 0) + 1;
  const total = kinds.length || 0;
  const ratio = {};
  for (const [k, v] of Object.entries(counts)) ratio[k] = total ? Math.round((v / total) * 1000) / 10 : 0;
  return { counts, ratio, total };
}
