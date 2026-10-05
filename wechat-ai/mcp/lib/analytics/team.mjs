// H. 工作/团队分析：沟通复盘、决策追溯、任务分配、风险提醒、客服质检、销售线索、FAQ。
// 合规前提：企业会话存档必须已获授权与告知；风险只做提示，不做定性；不输出无关私人隐私。
import { replyIntervals, countBy, round, truncate, maskPii, fmtLocal } from "./core.mjs";
import { extractDueDates } from "../signals.mjs";

const DECISION_RE = /决定|定了|拍板|敲定|确认采用|最终确认|就这样(?:定|办)|按.{0,8}(?:方案|版本|口径)执行|不再改|变更如下|调整为|改为|上线时间定/;
const ASSIGN_RE = /(?:你|麻烦你|请|让|由|交给|负责)\s*[\u4e00-\u9fa5]{0,6}?(?:负责|跟进|对接|处理|整理|准备|写|改|发|审|验收|部署|测试)/;
const RISK_RULES = [
  { type: "延期", re: /延期|推迟|来不及|赶不上|延后|逾期|未交付|没交|还在做|delay/ },
  { type: "阻塞", re: /卡住|阻塞|卡在|等.{0,8}(?:确认|审批|资料|排期)|依赖.{0,6}(?:没|未|还没)|缺.{0,6}(?:资料|信息|权限|资源)/ },
  { type: "冲突", re: /吵|争执|分歧|不同意|反对|投诉|指责|甩锅|背锅|不合理|凭什么/ },
  { type: "信息缺失", re: /没说|不清楚|不明|待定|待确认|缺.{0,6}(?:文档|说明|标准|口径)|不知道谁|口径不一/ },
];
const COMPLAINT_RE = /投诉|不满|态度差|太慢|推诿|敷衍|没解决|又出问题|又坏了|退款|差评/;
const POSITIVE_SERVICE_RE = /满意|专业|及时|靠谱|响应快|解决|感谢|好评|点赞/;
const QUESTION_RE = /(?:请问|问一下|想问|咨询一下|请教|怎么|如何|能不能|是否|有没有|多少|什么时候|哪里)[^。！？!?]{2,40}[?？]/;
const NEED_RE = /需求|想要|需要(?:一个|一套|一款|做|开发|定制)|痛点|期望|目标|功能|预算|报价|价格|多少钱|怎么收费/;
const OBJECTION_RE = /太贵|超预算|考虑一下|再看看|竞品|别家|对比|不划算|降点|打折|优惠|免费/;

/** 数值日键（y*384+mo*32+d）回译成 toISOString().slice(0,10) 同款键（扩展年截断 ±YYYYYY-MM）。 */
function fmtDayKey(k) {
  const y = Math.floor(k / 384);
  const rem = k - y * 384;
  const mo = Math.floor(rem / 32);
  const d = rem - mo * 32;
  const mm = String(mo + 1).padStart(2, "0");
  if (y >= 0 && y <= 9999) return String(y).padStart(4, "0") + "-" + mm + "-" + String(d).padStart(2, "0");
  return (y < 0 ? "-" : "+") + String(Math.abs(y)).padStart(6, "0") + "-" + mm;
}

/**
 * 团队/项目沟通复盘。
 * @param {{projectName?:string,now?:Date}} opts
 */
export function teamReview(messages, { projectName = null, now = new Date(), top = 15 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  // 只看工作向会话（群 或 名字含项目词）；不含纯私人闲聊会话
  const workMsgs = list.filter((m) => m.session_kind === "group" || /项目|组|团队|team|群|部门|客户|公司|work/i.test(m.session_name ?? ""));
  const base = workMsgs.length ? workMsgs : list;

  const decisions = [], assignments = [], risks = [], complaints = [], questions = [], needs = [], objections = [];
  for (const m of base) {
    const text = String(m?.content ?? "");
    if (!text) continue;
    const actor = m.is_owner ? "我" : (m.sender ?? "未知");
    let row = null; // 死分配消除（轮21）：非命中消息从不消费 row，惰性到首个命中再建
    const getRow = () => (row ??= { actor, chat: m.session_name ?? "未知", ts: m.ts ?? null, msg_id: m.id ?? null, text: maskPii(truncate(text.replace(/\s+/g, " "), 100)) });
    if (DECISION_RE.test(text)) {
      const due = extractDueDates(text, m.ts ? new Date(m.ts) : now)[0];
      decisions.push({ ...getRow(), time: m.ts ? fmtLocal(new Date(m.ts)) : null, effective: due ? due.text : null });
    }
    if (ASSIGN_RE.test(text)) {
      const due = extractDueDates(text, m.ts ? new Date(m.ts) : now)[0];
      const assignee = /(?:你|麻烦你|请|让|由|交给)\s*([\u4e00-\u9fa5]{2,6})?/.exec(text)?.[1] ?? (m.is_owner ? "未指定" : (m.sender ?? "未指定"));
      assignments.push({ ...getRow(), assignee, due: due ? due.text : null, status: "待确认" });
    }
    for (const r of RISK_RULES) {
      if (r.re.test(text)) {
        risks.push({ ...getRow(), risk_type: r.type, level: /吵|投诉|指责|又出问题/.test(text) ? "中" : "低", suggestion: "结合上下文人工复核后再定性" });
        break;
      }
    }
    if (COMPLAINT_RE.test(text)) complaints.push(getRow());
    const q = QUESTION_RE.exec(text);
    if (q) questions.push({ ...getRow(), question: q[0] });
    if (NEED_RE.test(text)) needs.push(getRow());
    if (OBJECTION_RE.test(text)) objections.push(getRow());
  }

  const participants = [...countBy(base.filter((m) => m.sender), (m) => (m.is_owner ? "我" : m.sender)).entries()]
    .map(([sender, count]) => ({ sender, count, share: round(count / Math.max(1, base.length), 4) }))
    .sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender, "zh"))
    .slice(0, top);

  const reply = replyIntervals(base);
  const byDay = new Map();
  let unknownDay = 0;
  for (const m of base) {
    if (!m.ts) { unknownDay += 1; continue; }
    const d = new Date(m.ts);
    const key = d.getUTCFullYear() * 384 + d.getUTCMonth() * 32 + d.getUTCDate();
    if (key !== key) d.toISOString(); // truthy 但非法时间：与旧实现同款抛 RangeError
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }

  // FAQ：重复出现的问题句（去标点前 20 字）与其后的回答
  const qmap = new Map();
  for (const q of questions) {
    // 归一键：去标点与句末语气词，避免「怎么部署？」与「怎么部署呢？」算两个 FAQ
    const key = q.question.replace(/[?？\s，,。！!呢啊呀吗嘛吧了]/g, "").slice(0, 16);
    if (!key) continue;
    if (!qmap.has(key)) qmap.set(key, { question: key, count: 0, samples: [] });
    const row = qmap.get(key);
    row.count += 1;
    if (row.samples.length < 2) row.samples.push({ actor: q.actor, time: q.time ?? q.ts, msg_id: q.msg_id, text: q.text });
  }
  const faq = [...qmap.values()].filter((f) => f.count >= 2).sort((a, b) => b.count - a.count).slice(0, 10);

  return {
    project: projectName,
    window_messages: base.length,
    scope_note: base.length < list.length ? "已过滤为工作向会话（群/项目名命中），纯私人会话不纳入" : "全部会话纳入（未过滤）",
    activity: {
      by_day: [...byDay.entries()].map(([k, count]) => ({ day: fmtDayKey(k), count })).concat(unknownDay ? [{ day: "未知", count: unknownDay }] : []).sort((a, b) => (a.day < b.day ? -1 : 1)),
      participants,
      reply_interval: reply,
    },
    decisions: decisions.slice(0, top),
    assignments: assignments.slice(0, top),
    risks: risks.slice(0, top),
    service_qc: {
      complaints: complaints.slice(0, top),
      complaint_count: complaints.length,
      positive_signals: base.filter((m) => POSITIVE_SERVICE_RE.test(String(m.content ?? ""))).length,
      response_minutes_median: reply.mine.median_minutes,
      note: "质检只做计数与线索，不做态度打分定性；需人工复核。",
    },
    sales: {
      needs: needs.slice(0, top),
      objections: objections.slice(0, top),
      note: "客户需求/异议按关键词命中，仅供复盘，不构成成交预测。",
    },
    faq,
    caliber: "决策/任务/风险均由规则词命中 + 既有日期抽取器辅助；actor=发言者；全部片段已脱敏截断。企业场景必须走合规会话存档并告知员工。",
  };
}
