// 情报信号引擎：待回复 / 承诺 / 截止 / 结算 / 商机 / 培训 / 资源 / 复联 / 跨群链接 / 群话题
// 规则来源：上游 wechat-intelligence-hub 的 signal-rules.md 与打分口径，Windows 侧重新实现。
import { isOwnerName, loadProfile } from "./profile.mjs";
import { dayOfWeekCn, nextWeekday, parseDueDate } from "./duedate.mjs";
import { isHeatLink, messageLinks, normalizeUrl, truncate } from "./util.mjs";

// ---------------- 词表 ----------------
export const BRAND_DEAL_TERMS = [
  "商单", "投放", "推广", "报价", "预算", "brief", "Brief", "BRIEF", "稿费", "佣金", "保底", "CPM", "CPC",
  "KOL", "kol", "博主", "创作者", "达人", "账号", "档期", "排期", "出片", "发布", "加热", "转推", "三连", "四连",
  "名额", "审核", "brief发", "合作方式", "结款", "结算", "返点", "坑位", "带货", "置换", "寄拍", "试用",
];
export const TRAINING_TERMS = [
  "讲师", "教练", "顾问", "内训", "企业培训", "课程", "课程大纲", "工作坊", "训练营", "课时", "试讲", "听众",
  "学员", "培训", "咨询", "陪跑", "授课", "课件", "线下课", "线上课", "分享嘉宾", "圆桌",
];
export const PROJECT_TERMS = [
  "项目", "交付", "初稿", "终稿", "对接群", "合作群", "排期", "需求", "验收", "里程碑", "上线", "对接人",
  "修改点", "评审", "方案", "报价单", "合同", "签约",
];
export const RESOURCE_TERMS = [
  "资源", "引荐", "介绍", "推荐", "对接人", "渠道", "代理", "Agency", "agency", "群主", "拉群", "认识一下",
  "帮忙介绍", "转介绍", "人脉",
];
export const DEADLINE_TERMS = [
  "截止", "截止时间", "deadline", "Deadline", "DDL", "ddl", "之前", "前完成", "前给", "前发", "要交付", "必须",
  "今天要", "明天要", "本周", "下周", "周五", "周四", "周三", "周二", "周一", "周末前", "月底", "尽快",
];
export const SETTLEMENT_TERMS = ["invoice", "Invoice", "发票", "结算", "付款", "打款", "转账", "佣金", "稿费", "尾款", "账期", "财务"];
export const PUBLISH_TERMS = ["已发布", "已上线", "发出去了", "发布数据", "数据回传", "加热", "扩散", "效果", "曝光", "阅读量"];
export const HEAT_TERMS = ["红包", "领红包", "三连", "四连", "已加热", "加热一下", "截图结算", "点赞", "转推", "求转发", "帮忙转"];
export const NON_DEAL_TERMS = ["非商单", "不是商单", "纯分享", "无商业", "只是分享", "自用推荐", "不是广告"];
export const LOW_VALUE_TERMS = [
  "爬山", "天气", "吃", "午饭", "晚饭", "外卖", "娃", "孩子", "作业", "追剧", "综艺", "游戏", "打牌",
  "股票", "彩票", "早安", "晚安", "打卡", "接龙", "表情包", "拼车", "团购", "秒杀", "红包来了",
];
export const HIGH_FOLLOWER_TERMS = ["万粉", "十万粉", "百万粉", "粉丝", "主页数据", "账号数据", "播放量"];

export const PROMISE_PATTERNS = [
  /(我|稍后|回头|今天|今晚|明天|后天|本周|这周|下周|周[一二三四五六日天]|月[底初]|尽快|马上)[^。！？\n]{0,24}(发|给|整理|出|发你|发您|发过去|同步|提供|回|确认|安排|拉群|对接)/,
  /(发|给|整理|出|提供|同步)[^。！？\n]{0,16}(你|您)(一版|一份|一份儿|个|条|套)?[^。！？\n]{0,12}(报价|大纲|方案|初稿|终稿|invoice|发票|数据|名单|链接|文件|brief|资料|文档)/,
  /(我这就|我这就去|马上给你|稍后给你|回头给你|明天给你|今晚给你|下午给你|上午给你)/,
];
export const QUESTION_PATTERNS = [
  /[?？]/,
  /(吗|呢|吧)\s*$/,
  /(能不能|可不可以|可以吗|行不行|有没有|是否|要不要|要不要我)/,
  /(什么时候|多久|怎么|如何|多少|几点|哪里|哪个|谁)/,
  /(麻烦|请|帮忙|劳烦|拜托)[^。！？\n]{0,20}(发|给|确认|回复|看|查|安排|提供|处理)/,
  /(等|等您|等你)[^。！？\n]{0,10}(回复|确认|答复|反馈)/,
  /(有结论了吗|有进展吗|怎么样了|好了吗|收到了吗|定了吗)/,
];
export const REQUEST_VERBS = [
  "发一下", "发我", "发你", "确认一下", "确认下", "回复", "反馈", "给我", "提供", "安排", "报价", "报个价",
  "初稿", "大纲", "invoice", "合同", "名单", "资料", "brief", "brief发", "拉群", "对接",
];
export const ACK_TERMS = ["好的", "好", "嗯", "嗯嗯", "收到", "ok", "OK", "Ok", "谢谢", "感谢", "辛苦了", "棒", "赞"];
export const CLOSING_TERMS = ["后面有机会", "下次再聊", "以后再联系", "有需要再找我", "先这样", "回头聊", "保持联系"];

const AMOUNT_RE = /(\d[\d,.]*)\s*(万|w|W|k|K|元|块|RMB|rmb|人民币|美元|USD|usd|美金|刀|\$)/g;
const CN_AMOUNT_RE = /([一二三四五六七八九十百千万两]+)\s*(万|元|块|k|K)/g;

// 组合词表：在逐条/逐会话热循环里避免每次 [...A, ...B] 重建数组
const OPPORTUNITY_TERMS = [...BRAND_DEAL_TERMS, ...TRAINING_TERMS, ...PROJECT_TERMS, ...RESOURCE_TERMS];
const DEADLINE_CONTEXT_TERMS = [...PROJECT_TERMS, ...BRAND_DEAL_TERMS, ...TRAINING_TERMS];
const PUBLISH_CONTEXT_TERMS = [...BRAND_DEAL_TERMS, ...PUBLISH_TERMS];

// ---------------- 工具 ----------------
// 逐词 .includes 由 V8 原生实现，长文本上远快于 JS 逐字符循环（POC：6KB 文本 8 组词表
// 0.051ms vs 跨表一趟扫描 0.135ms）；短文本 + 大词表才反过来，但本文件的热路径
// 逐消息词表调用都有正则预筛、触发率低，不值得为此分支。保持最简实现。
export function hits(text, terms) {
  const t = String(text ?? "");
  return terms.filter((k) => t.includes(k));
}
export function hitCount(text, terms) {
  return hits(text, terms).length;
}
/** 存在性判定：只问「有没有」时用 .some() 首处命中即停，且不分配命中数组。
 *  与 hitCount(text, terms) > 0 严格等价（词表实例级口径不变）。 */
export function hasAny(text, terms) {
  const t = String(text ?? "");
  return terms.some((k) => t.includes(k));
}
export function isQuestion(text) {
  const t = String(text ?? "");
  if (!t) return false;
  if (QUESTION_PATTERNS.some((re) => re.test(t))) return true;
  return REQUEST_VERBS.some((v) => t.includes(v));
}
export function isPromise(text) {
  const t = String(text ?? "");
  return PROMISE_PATTERNS.some((re) => re.test(t));
}
export function isAck(text) {
  const t = String(text ?? "").trim();
  return t.length <= 8 && ACK_TERMS.some((a) => t.includes(a));
}
export function isClosing(text) {
  return CLOSING_TERMS.some((c) => String(text ?? "").includes(c));
}
/** 交付证据词：承诺之后出现这些词视为「已兑现」。
 *  注意不能用裸「附件」——「附件太大发不了」「帮我下载附件」都不是交付。 */
const DELIVERED_RE = /(已发|发你了|发您了|发过去|已发你|已发您|见附件|附件如下|附件已发|已整理|已同步|已上传|链接如下)/;
export function extractAmounts(text) {
  const out = [];
  const t = String(text ?? "");
  for (const m of t.matchAll(AMOUNT_RE)) out.push(`${m[1]}${m[2]}`.replace(/\s+/g, ""));
  for (const m of t.matchAll(CN_AMOUNT_RE)) out.push(`${m[1]}${m[2]}`);
  return [...new Set(out)];
}
export function extractDueDates(text, ref = new Date()) {
  const out = [];
  const t = String(text ?? "");
  // 便宜预筛：任何日期形态都必须含数字或日期字（月/年/周/星期/礼拜/今/明/后/尽/马/刻）。
  // 一个字符类测试顶掉 12 组正则全扫；它是「有结果」的必要条件而非充分条件，语义不变。
  if (!/[0-9月年周星假期礼今明后尽马刻]/.test(t)) return [];
  // 年-月-日：前后不能紧贴数字/小数点，避免版本号、编号被当日期
  for (const m of t.matchAll(/(?<![\d.])((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) out.push({ text: m[0], date: new Date(+m[1], +m[2] - 1, +m[3]) });
  // 月-日：只有「N月M(日)」和「N-M / N/M」两种安全形态；
  // 旧正则把 3.5万 当 3月5日、把 3000-5000 当 5月5日、把 ISO 2026-06-30 再拆出两个假日期
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日?(?!\d)(?![\s]*[万wWkK])/g)) out.push({ text: m[0], date: new Date(ref.getFullYear(), +m[1] - 1, +m[2]) });
  for (const m of t.matchAll(/(?<![\d.\-\/:])(\d{1,2})\s*[-\/]\s*(\d{1,2})(?![\d.\-\/:年月日])/g)) out.push({ text: m[0], date: new Date(ref.getFullYear(), +m[1] - 1, +m[2]) });
  for (const m of t.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) out.push({ text: m[0], date: new Date(+m[1], +m[2] - 1, +m[3]) });
  for (const m of t.matchAll(/(这|本|下|下个)?\s*(周|星期|礼拜)([一二三四五六日天])/g)) {
    const which = m[1] ?? "";
    const dow = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[m[3]];
    out.push({ text: m[0], date: nextWeekday(dow, which, ref) });
  }
  if (/今天|今日|今晚/.test(t)) out.push({ text: "今天", date: new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 20, 0, 0) });
  if (/明天|明日/.test(t)) { const d = new Date(ref); d.setDate(d.getDate() + 1); d.setHours(20, 0, 0, 0); out.push({ text: "明天", date: d }); }
  if (/后天/.test(t)) { const d = new Date(ref); d.setDate(d.getDate() + 2); d.setHours(20, 0, 0, 0); out.push({ text: "后天", date: d }); }
  if (/本周|这周|这星期/.test(t)) { const d = nextWeekday(5, "本", ref); d.setHours(20, 0, 0, 0); out.push({ text: "本周", date: d }); }
  if (/下周/.test(t)) { const d = nextWeekday(5, "下", ref); d.setHours(20, 0, 0, 0); out.push({ text: "下周", date: d }); }
  if (/月底/.test(t)) out.push({ text: "月底", date: new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 20, 0, 0, 0) });
  if (/尽快|马上|立刻/.test(t)) { const d = new Date(ref); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); out.push({ text: "尽快", date: d, soft: true }); }
  const uniq = new Map();
  for (const o of out) if (o.date && !Number.isNaN(o.date.getTime())) uniq.set(o.text, o);
  return [...uniq.values()].sort((a, b) => a.date - b.date);
}

/**
 * 万粉信号识别（上游口径）。
 * 必须有「粉丝/账号/博主/蓝V」这类上下文词，否则「10万+爆款」会被误当成粉丝数。
 */
export function hasHighFollowerSignal(contexts) {
  const texts = (contexts ?? []).map((c) => `${c.sender ?? ""} ${c.content ?? ""}`);
  for (const t of texts) {
    if (/万粉/.test(t)) return true;
    if (/粉丝.{0,8}(?:1\s*[wW万]|10\s*[kK])/.test(t)) return true;
    const fwd = t.match(/(?:粉丝|粉丝量|蓝\s*[vV]|账号|博主).{0,10}(\d+(?:\.\d+)?)\s*([kKwW万])/);
    const rev = t.match(/(\d+(?:\.\d+)?)\s*([kKwW万])\s*(?:粉丝|粉)/);
    for (const m of [fwd, rev]) {
      if (!m) continue;
      const n = Number(m[1]) * (/[kK]/.test(m[2]) ? 1000 : 10000);
      if (n >= 10000) return true;
    }
  }
  return false;
}

/** 社交主页 URL：x/twitter 且只有一段路径 */
export function isSocialProfileUrl(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return false;
    return u.pathname.split("/").filter(Boolean).length === 1;
  } catch {
    return false;
  }
}


// =====================================================================================
// 群聊「可行动信号」类别（上游 GROUP_DIGEST_ACTIONABLE_* 口径）
// 这些正则要求上下文，而不是「出现某个词就算」——否则「保底就 108 个人参与了」
// 会被当成赚钱机会、「如果允许读取之前的商单」会被当成商单。
// =====================================================================================
export const ACTIONABLE_DEAL = /(?:来(?:了|个)?|新来).{0,4}(?:商单|单子)|(?<!所)(?:有个|有一批|有新(?:的)?|有一轮)商单|大单.{0,120}(?:campaign|品牌方|达人|KOL|原创|申请)|(?:campaign|品牌方).{0,120}(?:开放申请|报名开启|招募)|(?:投放|广告).{0,48}(?:预算|接广告|私信|找我)|(?:商单|合作|投放|推广).{0,20}(?:招募|报名|名额|预算|报价|找人|找博主|需要博主|可接|想接)|(?:谁|有没有人|有人|大家).{0,16}(?:想接|可接|接单|报名)|(?:品牌方|项目方).{0,20}(?:招募|找|需要|预算|报价|名额|投放|合作)|(?:招募|寻找?|需要|推荐).{0,16}(?:KOL|达人|博主)|(?:预算|稿费|保底|佣金).{0,12}(?:元|人民币|RMB|USD|U|美金|澳元)|(?:brief|需求).{0,16}(?:报名|招募|名额|预算|报价|发布时间)/i;

export const ACTIONABLE_TRAINING = /(?:有没有|谁|需要|招募?|寻找?|推荐|想搞|准备|计划|有个|有一场).{0,24}(?:企业培训|AI\s*培训|培训项目|讲师|工作坊|咨询项目|项目合作|教练)|(?:找|需要).{0,12}(?:讲师|培训师|老师|教练|顾问)|(?:企业培训|AI\s*培训|培训项目|讲师|工作坊|咨询项目|项目合作|教练).{0,24}(?:招募?|需要|寻找?|合作|报名|预算|报价|课时|授课|推荐|机会|需求)/i;

export const ACTIONABLE_PROJECT = /(?:项目合作|咨询项目|顾问项目|外包项目|FDE).{0,24}(?:招募|找|需要|合作|报名|预算|报价|推荐|人选|档期)|(?:招募|找|需要|报名|预算|报价|推荐|人选).{0,24}(?:项目合作|咨询项目|顾问项目|外包项目|FDE)/i;

export const ACTIONABLE_EVENT = /(?:活动|分享会|工作坊|workshop|峰会|大会|沙龙|直播|训练营|黑客松|hackathon|VibeHacks?).{0,24}(?:报名|招募|嘉宾|讲师|合作|赞助|举办|主办|时间|地点|名额|免费|付费)|(?:报名|招募|嘉宾|讲师|合作|赞助|举办|主办).{0,24}(?:活动|分享会|工作坊|workshop|峰会|大会|沙龙|直播|训练营|黑客松|hackathon|VibeHacks?)|(?:做一场|办一场|举办|准备|计划).{0,48}(?:活动|分享会|工作坊|workshop|峰会|大会|沙龙|直播|训练营|黑客松|hackathon|VibeHacks?)/i;

export const ACTIONABLE_JOB = /(?:招聘|急招|招募|内推|岗位|实习|兼职|外包|接单).{0,24}(?:人|同学|博主|运营|设计|开发|顾问|讲师|简历|报名|需要)|(?:找|需要).{0,16}(?:实习生|兼职|外包|运营人员|设计师|开发者|开发人员|工程师|顾问)/i;
/** 只有出现这些明确的用工词，才允许把「活动/招募」判成招聘外包 */
export const JOB_EXPLICIT = /招聘|急招|内推|岗位|实习|兼职|外包|接单/;

export const ACTIONABLE_MONEY = /(?:有偿|奖金|奖励|佣金|分成|返佣|课时费|稿费).{0,20}(?:报名|参与|可接|招募|任务|合作|名额|结算)|(?:报名|参与|可接|招募|任务|合作).{0,20}(?:有偿|奖金|奖励|佣金|分成|返佣|课时费|稿费|保底)|(?:收益|收入|能赚|可赚|赚个|赚到).{0,16}(?:破千|上千|过千|\d+(?:\.\d+)?\s*(?:元|万))|保底\s*\d+(?:\.\d+)?\s*(?:元|人民币|RMB|USD|U|美金|澳元|万)|(?:短平快项目|拉新任务).{0,20}(?:收益|佣金|结算|窗口|报名|教程)/i;

export const ACTIONABLE_RULES = [
  ["商单", ACTIONABLE_DEAL],
  ["培训", ACTIONABLE_TRAINING],
  ["项目合作", ACTIONABLE_PROJECT],
  ["活动", ACTIONABLE_EVENT],
  ["赚钱/奖励", ACTIONABLE_MONEY],
];

/** 一条消息可能命中多个可行动类别；招聘/外包需要额外的明确用工词 */
export function discussionCategories(text) {
  const t = String(text ?? "");
  const out = [];
  for (const [name, re] of ACTIONABLE_RULES) if (re.test(t)) out.push(name);
  if (ACTIONABLE_JOB.test(t) && (!ACTIONABLE_EVENT.test(t) || JOB_EXPLICIT.test(t))) out.push("招聘/外包");
  return out;
}

/** 群内已有的日报（摘要/回顾），不应进入话题与机会 */
export const GROUP_RECAP_RE = /^\s*(?:#{1,6}\s*)?(?:(?:\d{4}|\d{1,2}[./月-]\d{1,2}日?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s*)?(?:(?:[\w·&+.-]{0,16})(?:微信群聊日报|群聊日报|群日报|群聊总结)|(?:今日|昨日|本日|当天|每日).{0,6}(?:日报|总结|回顾)|daily\s*(?:brief|digest|recap))(?:\s|[:：|｜\-—]|$)/i;

export function isGroupRecap(text) {
  return GROUP_RECAP_RE.test(String(text ?? ""));
}

/** 纯互动/加热消息（三连、已三连、收到…），不进入证据 */
export const BOOST_COORDINATION_RE = /红包|求加热|帮忙加热|#?接龙|三连|四连|3连|4连|五连|5连|点赞|评论|收藏|转发|转推|截图结算|统一结算|加热了|已加热/i;
export const LOW_VALUE_MSG_RE = /^(?:已?三连|已?点赞|已?转发|支持|收到|好的?|好滴|ok|okay|哈哈+|嘿嘿+|666+|冲+|赞+|蹲|围观|感谢分享|谢谢分享|辛苦了|[.。!！~～]+)$/i;

export function isBoostOnly(text) {
  const t = String(text ?? "").trim();
  if (!BOOST_COORDINATION_RE.test(t)) return false;
  // 若同时带有真实的招募/brief 上下文，则不算纯加热
  return !ACTIONABLE_RULES.some(([, re]) => re.test(t)) && !ACTIONABLE_JOB.test(t);
}

export function isLowValueMessage(text) {
  const t = String(text ?? "").trim().replace(/^[#＃]接龙/, "").replace(/^\d+[.、)]/, "").replace(/[🙏👍👏💪🔥🎉🥳🤝✅☑️❤❤️]/g, "").trim();
  return t === "" || LOW_VALUE_MSG_RE.test(t);
}

/** 娱乐/生活向群：群名或内容占比判定 */
export const ENTERTAINMENT_GROUP_NAME_RE = /吃喝玩乐|体育|运动群|球友|厨房|羽毛球|网球|外卖|福利群|薅羊毛|追星|校友闲聊|同学群|爬山|亲子|宠物/i;
export const ENTERTAINMENT_CONTENT_RE = /足球|篮球|世界杯|球赛|比分|演唱会|追星|八卦|外卖|红包福利|拼单|薅羊毛|吃饭|聚餐|喝酒|打牌|日常闲聊|旅游约伴|相亲|天气/i;

// 计数用全局正则只编译一次（旧实现每次调用 new RegExp + match 全量收集，仅为数个数）
const ENTERTAINMENT_CONTENT_GI = new RegExp(ENTERTAINMENT_CONTENT_RE.source, "gi");

export function isEntertainmentGroup(name, text) {
  if (ENTERTAINMENT_GROUP_NAME_RE.test(String(name ?? ""))) return true;
  const t = String(text ?? "");
  if (!t) return false;
  let n = 0;
  ENTERTAINMENT_CONTENT_GI.lastIndex = 0;
  while (ENTERTAINMENT_CONTENT_GI.exec(t)) n += 1;
  return n > 0 && n / Math.max(1, t.length / 60) > 0.5;
}

/** 会话分类（用于优先级与栏目归属） */
export function classifyChat(name) {
  const n = String(name ?? "");
  if (/群|群聊|group|俱乐部|社群/.test(n)) return "group";
  return "private";
}

export function chatTopics(name, text) {
  const profile = loadProfile();
  const blob = `${name}\n${text}`;
  const found = [];
  for (const [topic, kws] of Object.entries(profile.intelligence_priorities?.custom_topics ?? {})) {
    if ((kws ?? []).some((k) => blob.includes(k))) found.push(topic);
  }
  for (const area of profile.intelligence_priorities?.focus_areas ?? []) {
    if (blob.includes(area)) found.push(area);
  }
  return [...new Set(found)];
}

/** 低价值娱乐/闲聊判定：需要群名或讨论内容确实以生活/娱乐为主，且没有当前目标信号
 *  opportunityHits：调用方（analyze）已对 text 完成商机 4 组词表扫描时传入命中总数，
 *  免去把整段拼接全文再扫 90 词（OPPORTUNITY_TERMS 就是那 4 组的并集）；存在性口径与
 *  「名字+\n+全文」一次扫描严格等价（消费方只看 >0，名字补扫覆盖名字命中）。不传则维持原实现。 */
export function isLowValueChat({ name, text, opportunityHits = null }) {
  const n = String(name ?? "");
  const t = String(text ?? "");
  const targetSignals = opportunityHits == null
    ? hitCount(`${n}\n${t}`, OPPORTUNITY_TERMS)
    : (opportunityHits > 0 ? 1 : 0) + hitCount(n, OPPORTUNITY_TERMS);
  if (targetSignals > 0) return false;
  const nameHit = /(闲聊|娱乐|生活|爬山|吃喝|亲子|游戏|追剧|摸鱼|灌水|闲聊群)/.test(n);
  if (nameHit) return true;
  // 密度按「含低价值词的消息占比」算。旧实现用 hitCount（只数唯一词项）除以字数/40，
  // 长会话永远达不到阈值——那一支实际是死代码；改为消息级占比才真正生效
  const lines = t.split("\n").filter((l) => l.trim());
  if (!lines.length) return false;
  let low = 0;
  for (const l of lines) if (LOW_VALUE_TERMS.some((k) => l.includes(k))) low += 1;
  return low / lines.length > 0.6;
}

// ---------------- 主分析 ----------------
/**
 * 分析一个时间窗内的全部消息。
 * @param {Array} messages 规范化消息（store.rowToMessage 结构：session_name, sender, ts, content, is_owner, links）
 * @param {{sinceMs:number, untilMs:number, now?:Date, exclusions?:Set<string>}} opts
 */
export function analyze({ messages, sinceMs, untilMs, now = new Date(), extraExclusions = [] }) {
  const profile = loadProfile();
  // 本人判定按发送者名缓存：analyze 会对同一条消息反复判定本人/对方
  const ownerMemo = new Map();
  const ownerOf = (sender) => {
    let v = ownerMemo.get(sender);
    if (v === undefined) { v = isOwnerName(sender); ownerMemo.set(sender, v); }
    return v;
  };
  const isOwnerMsg = (m) => !!(m.is_owner || ownerOf(m.sender));
  // 可行动判定按内容文本记忆化：recap/boost/low/cats 四判只依赖文本，聊天语料重复度高
  // （寒暄/套话/转发刷屏），同一文本只判一次。内部分步短路与逐条判定完全同序——
  // 首次出现才计算，且 recap 命中就不算 boost/low/cats。缓存生命周期 = 本次 analyze 调用，
  // 键是文本引用、值百字节级，最坏全不同文本的峰值远小于消息数组本身。
  const actionCache = new Map();
  const actionOf = (text) => {
    let p = actionCache.get(text);
    if (p !== undefined) return p;
    if (isGroupRecap(text)) p = { recap: true };
    else if (isBoostOnly(text)) p = { boost: true };
    else if (isLowValueMessage(text)) p = { low: true };
    else p = { cats: Object.freeze(discussionCategories(text)) };
    actionCache.set(text, p);
    return p;
  };
  // 承诺/截止链路的文本判定同理记忆化：isAck / isPromise / 短承诺快判 / 交付证据只依赖文本。
  // due 另按（文本 × 消息本地日历日）记忆化——extractDueDates 的相对日期全部以 ref 的本地
  // y/m/d 计算（nextWeekday 还会归一到本地零点），同日同文本结果必然相同；键带长度前缀防碰撞。
  const chainCache = new Map();
  const chainOf = (text) => {
    let p = chainCache.get(text);
    if (p !== undefined) return p;
    p = {
      ack: isAck(text),
      delivered: DELIVERED_RE.test(text),
      shortPromise: PROMISE_PATTERNS[2].test(text),
      promise: isPromise(text),
    };
    chainCache.set(text, p);
    return p;
  };
  const dueCache = new Map();
  const dueOf = (text, ts) => {
    const d = new Date(ts);
    const dayNum = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const key = `${String(text).length}|${text}|${dayNum}`;
    let v = dueCache.get(key);
    if (v === undefined) {
      v = extractDueDates(text, d)[0] ?? null;
      dueCache.set(key, v);
    }
    return v;
  };
  // 兼容两种行结构：store 行用 session_name，reader 行用 chat
  const chatOf = (m) => m.session_name ?? m.chat ?? m.talker ?? "未知会话";
  const byChatMap = new Map();
  for (const m of messages) {
    if (m.session_name === undefined) m.session_name = chatOf(m);
    const k = m.session_name;
    if (!byChatMap.has(k)) byChatMap.set(k, []);
    byChatMap.get(k).push(m);
  }
  for (const [, arr] of byChatMap) arr.sort((a, b) => a.ts - b.ts);

  const sessions = [];
  const pendingReplies = [];
  const promises = [];
  const waiting = [];
  const deadlines = [];
  const settlements = [];
  const published = [];
  const brandDeals = [];
  const trainings = [];
  const projects = [];
  const resources = [];
  const heat = [];
  const lowValue = [];
  const links = new Map();
  const exclusions = new Set([...(profile.exclude_chats ?? []), ...extraExclusions]);

  // ---- 链接聚合先行：跨群判定与链接画像要看到全部会话的分布，不能依赖会话遍历顺序 ----
  for (const [chat, msgs] of byChatMap) {
    if (exclusions.has(chat)) continue;
    for (const m of msgs) {
      for (const url of messageLinks(m)) {
        const norm = normalizeUrl(url);
        const owner = isOwnerMsg(m);
        if (!links.has(norm)) links.set(norm, { norm, url, chats: new Set(), senders: new Set(), first_ts: m.ts, last_ts: m.ts, hits: 0, heat: false, contexts: [] });
        const rec = links.get(norm);
        rec.chats.add(chat);
        if (!owner) rec.senders.add(m.sender);
        rec.first_ts = Math.min(rec.first_ts, m.ts);
        rec.last_ts = Math.max(rec.last_ts, m.ts);
        rec.hits += 1;
        if (isHeatLink(url) || hasAny(m.content, HEAT_TERMS)) rec.heat = true;
        if (rec.contexts.length < 4) rec.contexts.push({ chat, sender: m.sender, ts: m.ts, content: truncate(m.content, 160), is_owner: owner });
      }
    }
  }

  for (const [chat, msgs] of byChatMap) {
    if (exclusions.has(chat)) continue;
    const kind = classifyChat(chat);
    const textAll = msgs.map((m) => m.content).join("\n");
    const ownerCount = msgs.reduce((a, m) => a + (isOwnerMsg(m) ? 1 : 0), 0);
    const others = msgs.length - ownerCount;
    const last = msgs[msgs.length - 1];
    const lastFromOwner = isOwnerMsg(last);
    const topics = chatTopics(chat, textAll);
    const dealHits = hits(textAll, BRAND_DEAL_TERMS);
    const trainHits = hits(textAll, TRAINING_TERMS);
    const projHits = hits(textAll, PROJECT_TERMS);
    const resHits = hits(textAll, RESOURCE_TERMS);
    const heatHits = hits(textAll, HEAT_TERMS);
    const amounts = extractAmounts(textAll);
    const senderCount = new Set(msgs.map((m) => m.sender)).size;

    // ---- 可行动信号（上游口径）：逐条消息做上下文判定，而不是「出现某词就算」 ----
    const actionable = { 商单: 0, 培训: 0, "项目合作": 0, 活动: 0, "招聘/外包": 0, "赚钱/奖励": 0 };
    let recapCount = 0;
    let boostCount = 0;
    let effectiveCount = 0;
    for (const m of msgs) {
      const text = String(m.content ?? "");
      const p = actionOf(text);
      if (p.recap) { recapCount += 1; continue; }                     // 群内已有日报不计入话题/机会
      if (p.boost) { boostCount += 1; continue; }                     // 三连/已三连等纯互动不计入证据
      if (p.low) continue;                                            // 收到/好的/表情等
      effectiveCount += 1;
      for (const c of p.cats) actionable[c] += 1;
    }
    const actionableHits = Object.values(actionable).reduce((a, b) => a + b, 0);
    const entertainment = kind === "group" && isEntertainmentGroup(chat, textAll);

    const session = {
      name: chat, kind, topic: kind === "group" ? "群聊" : "私聊",
      messages: msgs.length, senders: senderCount,
      effective: effectiveCount, recap_count: recapCount, boost_count: boostCount,
      actionable, actionable_hits: actionableHits,
      first_ts: msgs[0].ts, last_ts: last.ts,
      owner_messages: ownerCount, other_messages: others,
      last_sender: last.sender, last_from_owner: lastFromOwner,
      topics, deal_hits: dealHits.length, training_hits: trainHits.length,
      project_hits: projHits.length, resource_hits: resHits.length,
      amounts, low_value: false, priority: 0, signals: [],
      entertainment,
    };

    // 会话级信号标记：本会话的推送都发生在本次迭代内，用布尔标记代替结尾对全局数组的 .some() 全扫
    let flagPendingReply = false;
    let flagPromiseOpen = false;
    let flagWaiting = false;
    let flagDeadline = false;
    let flagSettlement = false;
    let flagBrandDeal = false;
    let flagTraining = false;

    // ---- 待回复：最后一条不是本人，且是提问/请求 ----
    if (!lastFromOwner && (isQuestion(last.content) || REQUEST_VERBS.some((v) => last.content.includes(v)))) {
      const reason = isQuestion(last.content) ? "对方提出问询/需要回应" : "对方发来需要处理的请求";
      pendingReplies.push({ chat, kind, sender: last.sender, ts: last.ts, content: last.content, reason, age_hours: round1((now.getTime() - last.ts) / 3600_000) });
      flagPendingReply = true;
    }
    // ---- 等待对方：最后一条是本人且带问题 ----
    if (lastFromOwner && isQuestion(last.content)) {
      waiting.push({ chat, kind, ts: last.ts, content: last.content, reason: "我方已发出问询，等待对方回复", age_hours: round1((now.getTime() - last.ts) / 3600_000) });
      flagWaiting = true;
    }

    // ---- 承诺：本人发出的交付承诺，检查之后是否已兑现 ----
    // 后缀预计算「此后的消息里有无交付证据 / 对方 ACK」，
    // 把原先每条承诺都向后 .some() 扫一遍的 O(n^2) 收敛为 O(n)
    const n = msgs.length;
    const laterDelivered = new Array(n + 1).fill(false);
    const laterAcked = new Array(n + 1).fill(false);
    for (let i = n - 1; i >= 0; i--) {
      const c = chainOf(msgs[i].content);
      laterDelivered[i] = laterDelivered[i + 1] || (isOwnerMsg(msgs[i]) && c.delivered);
      laterAcked[i] = laterAcked[i + 1] || (!isOwnerMsg(msgs[i]) && c.ack);
    }
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!isOwnerMsg(m)) continue;
      const c = chainOf(m.content);
      if (c.ack) continue;
      // 短消息多是寒暄碎片，但「明天给你」「发你报价」这类短承诺必须保留
      if (m.content.length < 6 && !c.shortPromise) continue;
      if (!c.promise) continue;
      const delivered = laterDelivered[i + 1];
      const due = dueOf(m.content, m.ts);
      const ackedByOther = laterAcked[i + 1];
      promises.push({
        chat, kind, ts: m.ts, content: m.content,
        due: due ? due.date.getTime() : null, due_text: due?.text ?? null,
        delivered, acknowledged: ackedByOther,
        state: delivered ? "已兑现" : "待兑现",
        overdue: !delivered && due ? due.date.getTime() < now.getTime() : false,
        note: delivered ? "后续本人消息显示已发送" : ackedByOther ? "对方已确认收到承诺，但未见交付证据" : "未见交付证据",
      });
      if (!delivered) flagPromiseOpen = true;
    }

    // ---- 截止：交付类词 + 日期 ----
    for (const m of msgs) {
      if (!/(截止|之前|前给|前发|要交付|必须|今天要|明天要|本周|下周|周[一二三四五六日天])/.test(m.content)) continue;
      if (!hasAny(m.content, DEADLINE_CONTEXT_TERMS)) continue;
      const due = dueOf(m.content, m.ts);
      if (!due) continue;
      deadlines.push({ chat, kind, ts: m.ts, sender: m.sender, content: m.content, due: due.date.getTime(), due_text: due.text, overdue: due.date.getTime() < now.getTime(), days_left: Math.round((due.date.getTime() - now.getTime()) / 86400000) });
      flagDeadline = true;
    }

    // ---- 结算 / 发布后义务 ----
    // 「已打款/已到账/结清了」是完成态：是过去的账，不再进「待结算」
    const settlementTerms = hits(textAll, SETTLEMENT_TERMS);
    const settlementDone = /(已打款|已付款|已结清|已到账|已收款|收到款|已开票|付过了|打过款|款已付|结算完成|结清了)/.test(textAll);
    if (settlementTerms.length > 0 && !settlementDone) {
      settlements.push({ chat, kind, ts: last.ts, terms: settlementTerms, amounts, last_sender: last.sender, content: truncate(last.content, 160), pending: !lastFromOwner });
      flagSettlement = true;
    }
    if (hasAny(textAll, PUBLISH_TERMS) && hitCount(textAll, PUBLISH_CONTEXT_TERMS) > 1) {
      published.push({ chat, kind, ts: last.ts, terms: hits(textAll, PUBLISH_TERMS) });
    }

    // ---- 商机打分（品牌 / 培训 / 项目 / 资源） ----
    const privateStage = kind === "private" && ownerCount > 0;
    const labelBonus = labelScore(chat, profile);
    const activeStage = /(排期|档期|发布时间|交付|初稿|终稿)/.test(textAll);
    const settlement = settlementTerms.length > 0;
    const directDeal = /(私聊|对接|直接联系|加我|发我邮箱|微信详聊)/.test(textAll);
    const lowName = /(闲聊|娱乐|灌水|资源群|互推群|涨粉)/.test(chat);

    const base = labelBonus * 10 + (activeStage ? 24 : 0) + (settlement ? 14 : 0) + (amounts.length ? 18 : 0) + (directDeal ? 12 : 0) + (resHits.length ? 8 : 0) - (lowName ? 14 : 0);
    const signalScore = Math.max(0, base) + dealHits.length * 3 + trainHits.length * 3 + projHits.length * 3;

    if (dealHits.length && !hasAny(textAll, NON_DEAL_TERMS)) {
      const explicitRequest = /(找|招|招募|需要有|想找|求推荐|谁可以|谁能)/.test(textAll);
      const hasBudget = amounts.length > 0 || /(预算|报价|稿费|佣金|保底)/.test(textAll);
      const hasDeadline = flagDeadline;
      const crossGroup = crossGroupHit(links, msgs);
      const qualification = clampScore(
        (explicitRequest ? 35 : 0) + (hasBudget ? 20 : 0) + (hasDeadline ? 10 : 0) + (crossGroup ? 30 : 0) +
        (kind === "private" ? 35 : 0) + (activeStage ? 15 : 0),
      );
      const confidence = qualification >= 60 ? "高概率" : qualification >= 40 ? "中概率" : "待核实";
      brandDeals.push({
        chat, kind, ts: last.ts, qualification, confidence, signal_score: signalScore,
        explicit_request: explicitRequest, has_budget: hasBudget, has_deadline: hasDeadline,
        cross_group: crossGroup, amounts, hits: dealHits.slice(0, 8),
        evidence: msgs.filter((m) => hasAny(m.content, BRAND_DEAL_TERMS)).slice(-3).map((m) => ({ sender: m.sender, ts: m.ts, content: truncate(m.content, 200), is_owner: isOwnerMsg(m) })),
        record_type: (projHits.length && (privateStage && activeStage)) || (privateStage && activeStage && qualification >= 55) ? "opportunity" : "candidate",
      });
      flagBrandDeal = true;
    }
    if (trainHits.length >= 2 || (trainHits.length === 1 && /(找|需要|招募|想请|求推荐)/.test(textAll))) {
      const qualification = clampScore((/(找|需要|招募|想请|求推荐)/.test(textAll) ? 30 : 0) + (amounts.length ? 20 : 0) + (kind === "private" ? 30 : 0) + (/(试讲|大纲|课时|排期|档期)/.test(textAll) ? 20 : 0));
      trainings.push({ chat, kind, ts: last.ts, qualification, confidence: qualification >= 50 ? "高概率" : qualification >= 30 ? "中概率" : "待核实", hits: trainHits.slice(0, 8), amounts, evidence: msgs.filter((m) => hasAny(m.content, TRAINING_TERMS)).slice(-3).map((m) => ({ sender: m.sender, ts: m.ts, content: truncate(m.content, 200) })) });
      flagTraining = true;
    }
    if (projHits.length >= 2 && !flagBrandDeal) {
      projects.push({ chat, kind, ts: last.ts, hits: projHits.slice(0, 8), score: projHits.length * 3 + (privateStage ? 10 : 0) });
    }
    if (resHits.length >= 1 && /(可以|帮忙|介绍|引荐|推荐|拉群)/.test(textAll)) {
      resources.push({ chat, kind, ts: last.ts, hits: resHits.slice(0, 6), evidence: msgs.filter((m) => hasAny(m.content, RESOURCE_TERMS)).slice(-2).map((m) => ({ sender: m.sender, ts: m.ts, content: truncate(m.content, 160) })) });
    }
    if (heatHits.length >= 1) {
      heat.push({ chat, kind, ts: last.ts, hits: heatHits.slice(0, 6) });
    }

    // ---- 低价值判定 ----
    // 商机 4 组词表已在上方扫过 textAll，命中总数直接复用（>0 存在性口径等价），不再重扫拼接全文
    session.low_value = isLowValueChat({ name: chat, text: textAll, opportunityHits: dealHits.length + trainHits.length + projHits.length + resHits.length });
    session.priority = signalScore + (session.low_value ? -20 : 0) + labelBonus * 5;
    if (session.low_value) lowValue.push({ name: chat, messages: msgs.length, reason: "以生活/娱乐/闲聊为主且无当前目标信号" });
    session.signals = [
      flagPendingReply ? "待回复" : null,
      flagPromiseOpen ? "待兑现承诺" : null,
      flagWaiting ? "等待对方" : null,
      flagDeadline ? "临近截止" : null,
      flagSettlement ? "待结算" : null,
      flagBrandDeal ? "商机" : null,
      flagTraining ? "培训合作" : null,
    ].filter(Boolean);
    sessions.push(session);
  }

  // ---- 跨群链接判定（上游口径） ----
  const linkRows = [...links.values()].map((l) => {
    const chatCount = l.chats.size;
    const contextText = l.contexts.map((c) => c.content).join("\n");
    const highFollower = hasHighFollowerSignal(l.contexts);
    const explicitNonDeal = NON_DEAL_TERMS.some((t) => contextText.includes(t));
    let probability = "普通内容";
    let rank = 0;
    let reason = "暂无足够商单信号";
    if (isSocialProfileUrl(l.url)) {
      // 账号主页不是可归因的推广帖或活动页
      probability = "普通内容";
      rank = 0;
      reason = "这是账号主页，不是可归因的推广帖或活动页";
    } else if (explicitNonDeal) {
      // 原文明确写了非商单/纯分享时，压过付费加热等旁证
      probability = "明确非商单";
      rank = 0;
      reason = "原文明确写了非商单/纯分享";
    } else if (chatCount >= 2 && l.heat) {
      probability = "高概率商单";
      rank = highFollower ? 3 : 2;
      reason = `同链接在 ${chatCount} 个群付费/红包加热${highFollower ? "，且有万粉以上博主信号" : ""}`;
    } else if (chatCount >= 3 && highFollower) {
      probability = "高概率商单";
      rank = 2;
      reason = `同链接跨 ${chatCount} 个群传播，且有万粉以上博主信号`;
    } else if (l.heat) {
      probability = "疑似商单";
      rank = 1;
      reason = "存在付费/红包加热，但跨群样本不足";
    } else if (chatCount >= 2) {
      probability = "疑似商单";
      rank = 1;
      reason = `同一推广链接在 ${chatCount} 个群出现`;
    }
    return {
      norm: l.norm, url: l.url, chats: [...l.chats], senders: [...l.senders],
      first_ts: l.first_ts, last_ts: l.last_ts, hits: l.hits, heat: l.heat,
      high_follower: highFollower, explicit_non_deal: explicitNonDeal,
      probability, rank, reason, contexts: l.contexts,
      note: l.heat ? "存在付费加热/红包/三连等证据" : undefined,
    };
  }).sort((a, b) => b.rank - a.rank || b.chats.length - a.chats.length);

  sessions.sort((a, b) => b.priority - a.priority || b.last_ts - a.last_ts);

  return {
    window: { sinceMs, untilMs },
    coverage: {
      sessions: sessions.length, messages: messages.length,
      groups: sessions.filter((s) => s.kind === "group").length,
      private: sessions.filter((s) => s.kind === "private").length,
      low_value_sessions: lowValue.length,
    },
    sessions,
    pendingReplies: pendingReplies.sort((a, b) => a.ts - b.ts),
    promises: promises.sort((a, b) => (a.overdue === b.overdue ? a.ts - b.ts : a.overdue ? -1 : 1)),
    waiting: waiting.sort((a, b) => a.ts - b.ts),
    deadlines: deadlines.sort((a, b) => a.due - b.due),
    settlements: settlements.sort((a, b) => b.ts - a.ts),
    published: published.sort((a, b) => b.ts - a.ts),
    brandDeals: brandDeals.sort((a, b) => b.qualification - a.qualification),
    trainings: trainings.sort((a, b) => b.qualification - a.qualification),
    projects: projects.sort((a, b) => b.score - a.score),
    resources: resources.sort((a, b) => b.ts - a.ts),
    heat: heat.sort((a, b) => b.ts - a.ts),
    links: linkRows,
    lowValue,
    sessionsByName: Object.fromEntries(sessions.map((s) => [s.name, s])),
  };
}

function crossGroupHit(links, msgs) {
  const self = msgs[0]?.session_name;
  for (const m of msgs) {
    for (const url of messageLinks(m)) {
      const rec = links.get(normalizeUrl(url));
      if (!rec) continue;
      // 同链接出现在别的会话才算跨群（链接表已含全部会话，与遍历顺序无关）
      for (const c of rec.chats) {
        if (c !== self) return true;
      }
    }
  }
  return false;
}

function labelScore(chat, profile) {
  const labels = [...(profile.labels?.priority ?? []), ...(profile.labels?.commercial ?? []), ...(profile.labels?.creator ?? [])];
  return labels.some((l) => l && chat.includes(l)) ? 1 : 0;
}

export function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 复联分析：长期未联系的候选 */
/** 决定性信号：有这些内容时会突破「沉默天数」门槛进入判定 */
const REACTIVATION_DECISIVE = [
  /暂不(?:考虑|合作|投放|需要|推进)|暂时不(?:考虑|合作|投放|需要|推进)|不合作|不考虑|没预算|预算不够|不太合适|不匹配|婉拒|拒绝/,
  /下一批|下批|下一轮|下轮|下次合作|之后.{0,6}(?:联系|联络)|后面.{0,6}(?:联系|联络)/,
  /暂时不负责|不再负责|已经离职|换(?:了)?负责人|交接/,
  /纯佣|仅返佣|只有返佣|没有(?:基础)?稿费|无保底|不保底/,
  /已经结算|结算完成|已付款|已打款|已到账|二次合作|继续合作/,
];

/** 合并预筛：任一信号词都可能命中的总入口，没命中就跳过全部细分检测（多数消息走这条快路径） */
const REACTIVATION_ANY_RE = new RegExp([
  ...CLOSING_TERMS.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  "(?:纯佣|只给佣金|没有预算|置换)", "(?:放弃|不合适|后面再说|暂缓)", "(?:交接|换人|离职|接手)",
  "(?:下一批|之后联系|后面还有|新一批|再合作)",
  ...REACTIVATION_DECISIVE.map((re) => re.source),
].join("|"));

export function reactivation({ messages, now = new Date(), inactiveDays = 21, maxPerBand = 20, label = null } = {}) {
  const profile = loadProfile();
  // 「限定标签」：非空时只保留会话名命中任一标签的会话，且这些会话按重点标签待遇（不受沉默天数门槛限制）
  const limitLabels = (Array.isArray(label) ? label : [label]).map((l) => String(l ?? "").trim()).filter(Boolean);
  const byChat = new Map();
  for (const m of messages) {
    if (m.session_name === undefined) m.session_name = m.chat ?? m.talker ?? "未知会话";
    if (!byChat.has(m.session_name)) byChat.set(m.session_name, []);
    byChat.get(m.session_name).push(m);
  }
  const priorityLabels = [...(profile.labels?.priority ?? []), ...(profile.labels?.reactivation ?? [])];
  // 本人判定按发送者名缓存：50 万条消息逐条走 isOwnerName 的正则不划算
  const ownerBySender = new Map();
  const isOwner = (m) => {
    if (m.is_owner) return true;
    let v = ownerBySender.get(m.sender);
    if (v === undefined) { v = isOwnerName(m.sender); ownerBySender.set(m.sender, v); }
    return v;
  };
  const rows = [];
  for (const [chat, msgs] of byChat) {
    msgs.sort((a, b) => a.ts - b.ts);
    const last = msgs[msgs.length - 1];
    const inactive = Math.floor((now.getTime() - last.ts) / 86400000);
    if (limitLabels.length && !limitLabels.some((l) => chat.includes(l))) continue;
    const labelMatch = limitLabels.length > 0 || priorityLabels.some((l) => l && chat.includes(l));
    // 单遍扫描：逐条消息累计信号并早停，不再把整个会话拼成一个巨型字符串跑 6 遍正则。
    // 各正则的最长命中不超过 48 字符，带上一条消息的尾部做重叠即可覆盖跨消息边界，
    // 与「拼接全文再测」等价。
    let owners = 0;
    let closing = false, commissionOnly = false, abandoned = false, handover = false, laterPositive = false, decisive = false;
    let prevTail = "";
    for (const m of msgs) {
      if (isOwner(m)) owners += 1;
      if (closing && commissionOnly && abandoned && handover && laterPositive && decisive) continue;
      const t = prevTail ? prevTail + "\n" + String(m.content ?? "") : String(m.content ?? "");
      prevTail = t.slice(-48);
      if (!REACTIVATION_ANY_RE.test(t)) continue;
      if (!closing && CLOSING_TERMS.some((c) => t.includes(c))) closing = true;
      if (!commissionOnly && /(纯佣|只给佣金|没有预算|置换)/.test(t)) commissionOnly = true;
      if (!abandoned && /(放弃|不合适|后面再说|暂缓)/.test(t)) abandoned = true;
      if (!handover && /(交接|换人|离职|接手)/.test(t)) handover = true;
      if (!laterPositive && /(下一批|之后联系|后面还有|新一批|再合作)/.test(t)) laterPositive = true;
      if (!decisive && REACTIVATION_DECISIVE.some((re) => re.test(t))) decisive = true;
    }
    const others = msgs.length - owners;
    // 有决定性信号（明确拒绝/交接/下一批/纯佣/已成交）时，即使最近联系过也要参与判定
    if (inactive < inactiveDays && !labelMatch && !decisive) continue;
    let band = "等待区";
    if (handover) band = "待交接跟进";
    else if (commissionOnly) band = "纯佣低优先级";
    else if (abandoned && !laterPositive) band = "我方主动放弃";
    else if (laterPositive) band = "今天优先看";
    else if (inactive >= inactiveDays * 2 || labelMatch) band = "今天优先看";
    rows.push({
      chat, inactive_days: inactive, last_ts: last.ts, last_sender: last.sender,
      messages: msgs.length, owner_messages: owners, other_messages: others,
      band, closing, later_positive: laterPositive,
      note: closing ? "上次以客套收尾，属于低优先级复联提醒" : undefined,
      suggested_follow_up: new Date(now.getTime() + (band === "今天优先看" ? 0 : 7) * 86400000).toISOString().slice(0, 10),
      reason: handover ? "原负责人可能已交接，应定位新负责人" : commissionOnly ? "纯佣合作模型，不是拒绝" : abandoned ? "曾主动放弃，需原风险消失后再考虑" : laterPositive ? "对方明确提过后续批次" : `已 ${inactive} 天无往来`,
    });
  }
  const order = ["今天优先看", "待交接跟进", "等待区", "纯佣低优先级", "我方主动放弃"];
  rows.sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band) || b.inactive_days - a.inactive_days);
  const bands = {};
  for (const b of order) bands[b] = rows.filter((r) => r.band === b).slice(0, maxPerBand);
  return {
    bands, all: rows, inactive_days: inactiveDays, immediate: bands["今天优先看"] ?? [],
    // 「下一批」信号的会话（上游的「待下一批跟进」在本实现折叠进 今天优先看）
    nextBatch: rows.filter((r) => r.later_positive).slice(0, maxPerBand),
  };
}

export { dayOfWeekCn, parseDueDate };
// 兼容导出：视图层习惯从 signals 取本人判定与 Profile
export { isOwnerName, loadProfile, ownerAliases, profileStatus } from "./profile.mjs";
