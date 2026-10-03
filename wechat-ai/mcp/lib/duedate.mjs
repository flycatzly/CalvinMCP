// 日期推断：中文星期、本周/下周、相对日期
export const DOW_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
export const DOW_NAME = ["日", "一", "二", "三", "四", "五", "六"];

export function dayOfWeekCn(d) {
  return DOW_NAME[new Date(d).getDay()];
}

/**
 * 求「本周/下周/这周」的某个星期几；缺省取当天之后最近一次。
 * @param {number} dow 0=周日 .. 6=周六
 * @param {string} which "" | "这" | "本" | "下" | "下个"
 * @param {Date} ref
 */
export function nextWeekday(dow, which = "", ref = new Date()) {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const cur = d.getDay();
  const mondayOffset = (cur + 6) % 7; // 周一=0
  const monday = new Date(d);
  monday.setDate(d.getDate() - mondayOffset);
  if (/下/.test(which)) {
    const target = new Date(monday);
    target.setDate(monday.getDate() + 7 + ((dow + 6) % 7));
    return target;
  }
  if (/本|这/.test(which)) {
    const target = new Date(monday);
    target.setDate(monday.getDate() + ((dow + 6) % 7));
    return target;
  }
  // 无修饰：取今天之后（含今天）最近的一次
  let delta = (dow - cur + 7) % 7;
  if (delta === 0) delta = 7;
  const target = new Date(d);
  target.setDate(d.getDate() + delta);
  return target;
}

/** 解析单条日期表达式 */
export function parseDueDate(text, ref = new Date()) {
  const s = String(text ?? "");
  const m = s.match(/(这|本|下|下个)?\s*(?:周|星期|礼拜)([一二三四五六日天])/);
  if (m) return nextWeekday(DOW_CN[m[2]], m[1] ?? "", ref);
  if (/明天|明日/.test(s)) { const d = new Date(ref); d.setDate(d.getDate() + 1); return d; }
  if (/后天/.test(s)) { const d = new Date(ref); d.setDate(d.getDate() + 2); return d; }
  if (/今天|今日|今晚/.test(s)) return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const dm = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (dm) return new Date(+dm[1], +dm[2] - 1, +dm[3]);
  const md = s.match(/(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
  if (md) return new Date(ref.getFullYear(), +md[1] - 1, +md[2]);
  return null;
}

export function fmtDateCn(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
