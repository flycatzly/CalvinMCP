// 时间窗解析：--hours / --days / --since / --until / week / month，及聊天时间戳解析
import { endOfDay, fmtDay, fmtLocal, pad2, startOfDay } from "./util.mjs";

const CJK_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cn2num(s) {
  if (CJK_NUM[s] !== undefined) return CJK_NUM[s];
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CJK_NUM[s[1]];
  if (/^[一二三四五六七八九]十$/.test(s)) return CJK_NUM[s[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) return CJK_NUM[s[0]] * 10 + CJK_NUM[s[2]];
  return NaN;
}

/**
 * 解析用户给定的时间表达式为 Date。
 * 支持：ISO、2026-06-30、2026-06-30 10:12、2026/6/30、2026年6月30日 10:12、
 * 今天/昨天/前天/明天/现在/刚刚、N 天前 / N 小时前 / N 周前、上周/本周/上月/本月、
 * 以及裸 "10:12"（今天）。
 * @param {string|number|Date} input
 * @param {Date} now
 * @param {{endOfDayWhenDateOnly?: boolean}} opts
 */
export function parseWhen(input, now = new Date(), opts = {}) {
  if (input instanceof Date) return new Date(input);
  if (typeof input === "number") return new Date(input);
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const s = raw.normalize("NFKC").replace(/\s+/g, " ");

  const rel = s.match(/^(\d+)\s*(分钟|分|小时|时|天|日|周|星期|个?月|年)前$/);
  if (rel) {
    const n = Number(rel[1]);
    const d = new Date(now);
    const unit = rel[2];
    if (/分钟|分/.test(unit)) d.setMinutes(d.getMinutes() - n);
    else if (/小时|时/.test(unit)) d.setHours(d.getHours() - n);
    else if (/天|日/.test(unit)) d.setDate(d.getDate() - n);
    else if (/周|星期/.test(unit)) d.setDate(d.getDate() - n * 7);
    else if (/月/.test(unit)) d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d;
  }
  const relCn = s.match(/^([一二两三四五六七八九十]+)\s*(分钟|分|小时|时|天|日|周|星期|个?月|年)前$/);
  if (relCn) {
    const n = cn2num(relCn[1]);
    if (!Number.isNaN(n)) return parseWhen(`${n}${relCn[2]}前`, now);
  }
  if (/^(现在|刚刚|刚才|此刻)$/.test(s)) return new Date(now);
  if (/^(今天|今日|本日)$/.test(s)) return opts.endOfDayWhenDateOnly ? endOfDay(now) : startOfDay(now);
  if (/^(昨天|昨日)$/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return opts.endOfDayWhenDateOnly ? endOfDay(d) : startOfDay(d);
  }
  if (/^(前天)$/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 2);
    return opts.endOfDayWhenDateOnly ? endOfDay(d) : startOfDay(d);
  }
  if (/^(明天|明日)$/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return opts.endOfDayWhenDateOnly ? endOfDay(d) : startOfDay(d);
  }
  if (/^(上周|上星期)$/.test(s)) {
    const d = startOfDay(now);
    const dow = (d.getDay() + 6) % 7; // 周一=0
    d.setDate(d.getDate() - dow - 7);
    return d;
  }
  if (/^(本周|这周|这个星期)$/.test(s)) {
    const d = startOfDay(now);
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    return d;
  }
  if (/^(上(个)?月|上月)$/.test(s)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return opts.endOfDayWhenDateOnly ? endOfDay(new Date(now.getFullYear(), now.getMonth(), 0)) : d;
  }
  if (/^(本月|这个月)$/.test(s)) return new Date(now.getFullYear(), now.getMonth(), 1);

  const secondsOnly = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (secondsOnly) {
    const d = new Date(now);
    d.setHours(Number(secondsOnly[1]), Number(secondsOnly[2]), Number(secondsOnly[3] ?? 0), 0);
    return d;
  }

  const cn = s.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?(?:\s*(\d{1,2})\s*[::时]\s*(\d{1,2})?(?:\s*[::分]\s*(\d{1,2}))?)?$/);
  if (cn) {
    const [, y, mo, da, h, mi, se] = cn;
    return h === undefined
      ? (opts.endOfDayWhenDateOnly ? endOfDay(new Date(+y, +mo - 1, +da)) : new Date(+y, +mo - 1, +da, 0, 0, 0, 0))
      : new Date(+y, +mo - 1, +da, +h, +(mi ?? 0), +(se ?? 0), 0);
  }

  const ymd = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (ymd) {
    const [, y, mo, da, h, mi, se] = ymd;
    return h === undefined
      ? (opts.endOfDayWhenDateOnly ? endOfDay(new Date(+y, +mo - 1, +da)) : new Date(+y, +mo - 1, +da, 0, 0, 0, 0))
      : new Date(+y, +mo - 1, +da, +h, +(mi ?? 0), +(se ?? 0), 0);
  }

  const md = s.match(/^(\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (md) {
    const [, mo, da, h, mi, se] = md;
    const base = new Date(now.getFullYear(), +mo - 1, +da, h === undefined ? 0 : +h, +(mi ?? 0), +(se ?? 0), 0);
    return h === undefined && opts.endOfDayWhenDateOnly ? endOfDay(base) : base;
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return null;
}

/**
 * 解析聊天消息里的时间戳（不含年份时用参考年补齐）。
 * 支持：[2026-06-30 10:12]、2026-06-30 10:12:33、06-30 10:12、10:12、今天 10:12 等。
 */
export function parseMessageTime(input, ref = new Date()) {
  const s = String(input ?? "").trim().normalize("NFKC");
  if (!s) return null;
  const full = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[T\s]+(\d{1,2})[:时](\d{1,2})(?:[:分](\d{1,2}))?)?/);
  if (full) {
    const [, y, mo, da, h, mi, se] = full;
    return new Date(+y, +mo - 1, +da, +(h ?? 0), +(mi ?? 0), +(se ?? 0), 0);
  }
  const short = s.match(/(?:^|[^\d])(\d{1,2})[-/.月](\d{1,2})日?[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (short) {
    const [, mo, da, h, mi, se] = short;
    return new Date(ref.getFullYear(), +mo - 1, +da, +h, +mi, +(se ?? 0), 0);
  }
  const hm = s.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/);
  if (hm) {
    const d = new Date(ref);
    d.setHours(+hm[1], +hm[2], +(hm[3] ?? 0), 0);
    if (d.getTime() > ref.getTime() + 3600_000) d.setDate(d.getDate() - 1); // 未来时间视为昨天
    return d;
  }
  return null;
}

/**
 * 解析报告时间窗。
 * @param {{hours?:number|string, days?:number|string, since?:string, until?:string, week?:boolean, month?:boolean, now?:Date}} spec
 * @returns {{since:Date, until:Date, sinceMs:number, untilMs:number, hours:number, label:string, explicitSince:boolean, explicitUntil:boolean}}
 */
export function resolveWindow(spec = {}) {
  const now = spec.now instanceof Date ? spec.now : new Date();
  let since = null;
  let until = null;
  let explicitSince = false;
  let explicitUntil = false;

  if (spec.since) {
    since = parseWhen(spec.since, now);
    explicitSince = !!since;
  }
  if (spec.until) {
    until = parseWhen(spec.until, now, { endOfDayWhenDateOnly: true });
    explicitUntil = !!until;
  }
  if (spec.week) {
    const d = startOfDay(now);
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    if (!since) since = d;
    explicitSince = true;
  }
  if (spec.month) {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    if (!since) since = d;
    explicitSince = true;
  }
  if (!since) {
    const hours = num(spec.hours, num(spec.days, 0) * 24 || 24);
    since = new Date(now.getTime() - hours * 3600_000);
  }
  if (!until) until = now;

  if (since.getTime() > until.getTime()) {
    const t = since;
    since = until;
    until = t;
  }
  const hours = Math.max(0, (until.getTime() - since.getTime()) / 3600_000);
  const label = explicitSince || explicitUntil
    ? `${fmtLocal(since)} ~ ${fmtLocal(until)}`
    : `过去 ${round(hours)} 小时`;
  return { since, until, sinceMs: since.getTime(), untilMs: until.getTime(), hours, label, explicitSince, explicitUntil };
}

function num(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function round(n) {
  return Number.isInteger(n) ? n : Math.round(n * 10) / 10;
}

/** 生成报表用的分区日期串 */
export function windowTag(w) {
  const a = fmtDay(w.since);
  const b = fmtDay(w.until);
  return a === b ? a : `${a}_${b}`;
}

/** 一天内的分钟数（用于群日报时间窗判断，如 "06:50-07:20"） */
export function parseHmRange(s) {
  const m = String(s ?? "").match(/(\d{1,2}):(\d{2})\s*[-~至]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return { from: +m[1] * 60 + +m[2], to: +m[3] * 60 + +m[4] };
}

export function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

export { fmtDay, fmtLocal, pad2 };
