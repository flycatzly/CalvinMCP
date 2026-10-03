// Reader 协议公共层：统一信封 + 消息规范化 + 会话推断
import { extractUrls } from "../util.mjs";
import { parseMessageTime } from "../timewin.mjs";

export const READER_PROTOCOL = "wechat-reader/1";

export function envelope({ tool = "wechat-ai", command, data, ok = true, warnings = [] }) {
  return { ok, tool, command, data: data ?? {}, warnings, protocol: READER_PROTOCOL };
}

export function fail(command, message, { tool = "wechat-ai", data = {} } = {}) {
  return { ok: false, tool, command, error: String(message), data, warnings: [], protocol: READER_PROTOCOL };
}

/** 把任意来源的一行消息规范化为 reader 行结构 */
export function toReaderMessage(row, { chat, refDate = new Date() } = {}) {
  const chatName = String(row.chat ?? row.session ?? row.talker ?? row.group ?? chat ?? "未知会话");
  const sender = String(row.sender ?? row.from ?? row.name ?? row.speaker ?? row.user ?? "").trim() || "未知";
  let ts = row.ts ?? row.timestamp ?? null;
  if (ts === null || ts === undefined) {
    const t = row.time ?? row.date ?? row.datetime ?? null;
    ts = t ? (parseMessageTime(String(t), refDate)?.getTime() ?? null) : null;
  } else if (typeof ts === "string") {
    ts = parseMessageTime(ts, refDate)?.getTime() ?? null;
  } else if (typeof ts === "number" && ts < 1e12) {
    ts = ts * 1000;
  }
  const content = String(row.content ?? row.text ?? row.message ?? row.msg ?? "");
  return {
    id: row.id ?? null,
    chat: chatName,
    chatroom_id: row.chatroom_id ?? row.room_id ?? null,
    sender,
    sender_id: row.sender_id ?? row.wxid ?? null,
    ts: ts ?? null,
    time: ts ? fmt(ts) : (row.time ?? null),
    type: row.type ?? null,
    content,
    links: row.links ?? extractUrls(content),
    media: row.media ?? row.attachments ?? [],
    is_owner: !!row.is_owner,
  };
}

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function inferKind(name, members) {
  const n = String(name ?? "");
  if (Array.isArray(members) && members.length > 2) return "group";
  if (/(群|群聊|group|团队|小队|俱乐部|社群)/i.test(n)) return "group";
  return "private";
}

/** 通用文本匹配：关键词全部命中（AND），大小写不敏感 */
export function matchKeywords(text, keywords, { mode = "and" } = {}) {
  const t = String(text ?? "").toLowerCase();
  const ks = (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean).map((k) => String(k).toLowerCase());
  if (!ks.length) return true;
  return mode === "or" ? ks.some((k) => t.includes(k)) : ks.every((k) => t.includes(k));
}

export function paginate(rows, { limit = 100, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 100, 5000));
  const off = Math.max(0, Number(offset) || 0);
  const slice = rows.slice(off, off + lim);
  return {
    rows: slice,
    query: { has_more: rows.length > off + lim, next_offset: rows.length > off + lim ? off + lim : null, total: rows.length, limit: lim, offset: off },
  };
}

export function sortByTime(rows, order = "asc") {
  const copy = [...rows];
  copy.sort((a, b) => (order === "desc" ? (b.ts ?? 0) - (a.ts ?? 0) : (a.ts ?? 0) - (b.ts ?? 0)));
  return copy;
}
