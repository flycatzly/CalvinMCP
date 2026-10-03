// 通用工具：时间格式化、哈希、URL 规范化、JSON/CSV IO、脱敏
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const pad2 = (n) => String(n).padStart(2, "0");

/** 本地时间 -> "YYYY-MM-DD HH:mm" */
export function fmtLocal(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地时间 -> "YYYY-MM-DD" */
export function fmtDay(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间 -> ISO8601（带时区偏移） */
export function fmtIso(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad2(Math.floor(Math.abs(off) / 60));
  const om = pad2(Math.abs(off) % 60);
  return `${fmtDay(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${oh}:${om}`;
}

export function sha1(s) {
  return crypto.createHash("sha1").update(typeof s === "string" ? s : JSON.stringify(s)).digest("hex");
}

export function shortId(s, len = 12) {
  return sha1(s).slice(0, len);
}

export function slugify(s, fallback = "item") {
  const t = String(s ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .trim();
  return t ? t.slice(0, 80) : fallback;
}

/** Windows 文件名安全化（保留中文） */
export function safeFileName(s, fallback = "file") {
  const t = String(s ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return t ? t.slice(0, 120) : fallback;
}

const URL_RE = /https?:\/\/[^\s<>"'\u3000\uff08\uff09\u3010\u3011\u300a\u300b\u300c\u300d\u300e\u300f\u2018\u2019\u201c\u201d]+/gi;

export function extractUrls(text) {
  const s = String(text ?? "");
  const found = new Set();
  for (const m of s.matchAll(URL_RE)) {
    let u = m[0].replace(/[),.;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001\u201d\u2019]+$/u, "");
    if (u.length > 8) found.add(u);
  }
  return [...found];
}

/**
 * 消息的链接来源，一套规则：
 * - 库行（_indexed 标记）的 links 字段在索引期已完整提取，空数组即「无链接」，不再对正文跑提取正则；
 * - 手写消息（无标记，含测试固件显式 links: []）一律回退正文提取，保持原语义。
 */
export function messageLinks(m) {
  const links = m?.links;
  if (Array.isArray(links) && (links.length > 0 || m._indexed)) return links;
  return extractUrls(String(m?.content ?? ""));
}

/** URL 规范化：去 tracking 参数、统一大小写与尾斜杠，用于跨群去重 */
export function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    const drop = [];
    for (const k of u.searchParams.keys()) {
      if (/^(utm_|from|isappinstalled|scene|clicktime|enterid|ascene|devicetype|version|nettype|fontScale|pass_ticket|wx_header|share|share_source|share_medium|mpshare|srcid|chksm|exportkey|sessionid|subscene|xi\.)/i.test(k)) drop.push(k);
    }
    for (const k of drop) u.searchParams.delete(k);
    u.protocol = "https:";
    u.hash = "";
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "twitter.com" || host === "mobile.twitter.com") host = "x.com";
    u.hostname = host;
    // X/Twitter 状态页规范化
    const st = u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    let out;
    if (host === "x.com" && st) {
      out = `https://x.com/${st[1]}/status/${st[2]}`;
    } else {
      u.pathname = u.pathname.replace(/\/+$/, "") || "/";
      if (u.pathname === "/" && u.search) u.pathname = "";
      out = u.toString();
      out = out.replace(/\/$/, "");
    }
    return out;
  } catch {
    return String(raw ?? "").trim();
  }
}

/** 纯分享/加热类链接（微信红包、点赞、转推等），只作加热证据 */
export function isHeatLink(url) {
  return /(mp\.weixin\.qq\.com\/mp\/appmsgalbum|weixin\.110|\/redpacket|\/hongbao)/i.test(String(url ?? ""));
}

/** 由会话名推断群聊/私聊 */
export function inferKindSafe(name) {
  const n = String(name ?? "");
  if (/(群|群聊|group|团队|小队|俱乐部|社群|频道)/i.test(n)) return "group";
  return "private";
}

export function uniq(arr) {
  return [...new Set(arr)];
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function truncate(s, n, suffix = "…") {
  const t = String(s ?? "");
  return t.length <= n ? t : t.slice(0, Math.max(0, n - suffix.length)) + suffix;
}

export function stripControl(s) {
  return String(s ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  atomicWrite(file, JSON.stringify(obj, null, 2));
  return file;
}

export function atomicWrite(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line + "\n", "utf8");
}

export function toCsv(rows, columns) {
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
}

/** 敏感信息脱敏：密钥、口令、token */
export function redact(s) {
  return String(s ?? "")
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|salt|key)\s*[:=]\s*)([^\s,;"'}]{3,})/gi, "$1<REDACTED>")
    .replace(/(\b[a-f0-9]{64}\b)/gi, "<KEY64>")
    .replace(/(\b[a-f0-9]{32}\b)/gi, "<KEY32>");
}

/** 判断文本是否可能包含真实凭据（隐私扫描用） */
export function looksLikeSecret(s) {
  const t = String(s ?? "");
  return /(?:BEGIN [A-Z ]*PRIVATE KEY|sqlcipher|PRAGMA key|wxid_[A-Za-z0-9_-]{6,}\s*[:=])/i.test(t);
}

export function deepGet(obj, dotted, fallback = undefined) {
  let cur = obj;
  for (const part of String(dotted).split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return fallback;
    cur = cur[part];
  }
  return cur === undefined ? fallback : cur;
}

export function daysAgo(n, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return d;
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function diffDays(a, b) {
  return Math.floor((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000);
}
