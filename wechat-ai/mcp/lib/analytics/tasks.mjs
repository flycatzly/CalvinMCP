// D. 时间与任务管理：从聊天抽取待办/约定/会议/提醒/生日/缴费/行程，给状态与 ICS。
// 口径：只抽「聊天里真实出现」的任务；时间模糊标「需确认」；区分我答应 / 别人答应。
import { extractDueDates } from "../signals.mjs";
import { round, fmtDay, truncate, maskPii } from "./core.mjs";

const KIND_RULES = [
  { kind: "会议", re: /开会|会议|例会|评审|宣讲|试讲|电话会|视频会|腾讯会议|zoom|面试|答辩/ },
  { kind: "约定", re: /见面|碰面|约|聚餐|吃饭|约饭|拜访|接你|送你|等你|集合|到场/ },
  { kind: "生日", re: /生日|诞辰|周岁/ },
  { kind: "缴费", re: /缴费|交房租|房租|月供|还款|话费|续费|年费|保险|水电|物业|学费/ },
  { kind: "行程", re: /出发|航班|高铁|火车|出差|旅行|接机|入住|退房|值机|集合/ },
  { kind: "提醒", re: /提醒我|记得|别忘|务必|到时|到时候|临走前|之前给我/ },
  { kind: "待办", re: /待办|要做|需要(?:做|处理|改|发|交|补|整理|准备)|回头|稍后|待会|尽快|安排一下|跟进|落实|排期/ },
];
const DONE_RE = /(?:已经|已)(?:完成|安排|提交|发送|发给|发你|发我|发布|联系|确认|搞定|弄好|交|改好|整理好)|(?:完成|搞定|弄好|改好|交了|发了|提交了|确认了)(?:啦|了|好了|完)|收到(?:了)?(?:确认|通过)|已上线|已交付|结清/;
const TITLE_CLEAN = /\s+/g;

export function taskExtract(messages, { now = new Date(), includeIcs = true } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const byChat = new Map();
  for (const m of list) {
    const key = m.session_name ?? "未知会话";
    if (!byChat.has(key)) byChat.set(key, []);
    byChat.get(key).push(m);
  }
  const tasks = [];
  let seq = 0;
  for (const m of list) {
    const text = String(m?.content ?? "");
    if (text.length < 4) continue;
    const hit = KIND_RULES.find((r) => r.re.test(text));
    if (!hit) continue;
    // 只有「有时间/地点/动词」的才算任务，纯寒暄不算
    const dueHits = extractDueDates(text, m.ts ? new Date(m.ts) : now);
    const hasTimeWord = /\d{1,2}[:\u5206]\d{2}|点|今晚|明天|后天|周[一二三四五六日天]|下周|本周|月底|之前|前给|之前给|deadline|截止|上午|下午|晚上/.test(text);
    const hasActionVerb = /发|给|做|改|交|提交|安排|确认|整理|准备|见|开|约|买|订|还|付|联系|跟进|上线|交付/.test(text);
    if (!dueHits.length && !hasTimeWord && hit.kind === "待办" && !hasActionVerb) continue;

    seq += 1;
    const due = dueHits.length ? dueHits[0] : null;
    const later = (byChat.get(m.session_name ?? "") ?? []).filter((x) => x.ts > (m.ts ?? 0)).slice(0, 60);
    const done = later.some((x) => DONE_RE.test(String(x.content ?? "")));

    let status = "待确认";
    if (done) status = "已完成";
    else if (!due) status = "待确认";
    else if (due.date.getTime() < now.getTime()) status = "逾期";
    else status = "已确认";

    const participants = new Set([m.is_owner ? "我" : (m.sender ?? "未知")]);
    if (!m.is_owner) participants.add("我");
    for (const p of String(text).match(/@[\u4e00-\u9fa5A-Za-z0-9_\-]{2,20}/g) ?? []) participants.add(p.slice(1));

    let confidence = 0.5;
    if (due) confidence += 0.25;
    if (/\d{1,2}:\d{2}/.test(text)) confidence += 0.15;
    if (m.is_owner || /我会|我来|我明天|我稍后|我回头/.test(text)) confidence += 0.05;

    tasks.push({
      task_id: `t${seq}`,
      kind: hit.kind,
      title: truncate(text.replace(TITLE_CLEAN, " "), 60),
      owner: m.is_owner ? "我" : (m.sender ?? "未知"),
      direction: m.is_owner ? "我答应别人" : "别人答应我",
      participants: [...participants],
      due: due ? fmtDay(due.date) : null,
      due_ts: due ? due.date.getTime() : null,
      time_text: due ? due.text : (hasTimeWord ? "时间待确认" : null),
      location: (String(text).match(/(?:地址[:：]?\s*)?[\u4e00-\u9fa5]{2,12}(?:大厦|大楼|广场|中心|园区|酒店|咖啡厅?|餐厅|地铁站?|机场|火车站|学校|医院)/)?.[0]) ?? null,
      status,
      source_msg_id: m.id ?? null,
      confidence: round(Math.min(0.95, confidence), 2),
      note: !due ? "时间未明确，需确认" : null,
    });
  }
  return {
    tasks,
    stats: {
      total: tasks.length,
      by_status: Object.fromEntries([...countStatus(tasks)]),
      by_kind: Object.fromEntries([...countKind(tasks)]),
    },
    ics: includeIcs ? toIcs(tasks.filter((t) => t.due_ts)) : null,
    caliber: "抽取规则：关键词触发 + 既有日期抽取器；「已完成」由同会话后续消息的完成词判定（可能漏）；无明确时间的任务标「需确认」，不编造时间。",
  };
}

function countStatus(tasks) {
  const map = new Map();
  for (const t of tasks) map.set(t.status, (map.get(t.status) ?? 0) + 1);
  return map;
}
function countKind(tasks) {
  const map = new Map();
  for (const t of tasks) map.set(t.kind, (map.get(t.kind) ?? 0) + 1);
  return map;
}

/** 生成 ICS（VEVENT 按天粒度；只含已解析出时间的任务） */
export function toIcs(tasks) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//wechat-ai//task-extract//CN",
    "CALSCALE:GREGORIAN",
  ];
  for (const t of tasks) {
    const day = t.due ? t.due.replace(/-/g, "") : null;
    if (!day) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.task_id}-${day}@wechat-ai`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART;VALUE=DATE:${day}`,
      `SUMMARY:${icsEscape(maskPii(truncate(t.title, 60)))}`,
      `DESCRIPTION:${icsEscape(`状态:${t.status} 来源:${t.source_msg_id ?? "-"} ${t.time_text ?? ""}`)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function icsEscape(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
