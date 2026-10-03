// WCDB Reader：只读解析微信 4.x 的 db_storage 目录（Windows 与 macOS 同构）。
// 支持 session/contact/message/favorite/sns/hardlink 六类库；不解密、不注入、不 Hook。
// 与上游 rion-wechat-reader 的实体口径保持一致；仅支持「已解密副本」或明文库。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { envelope, inferKind, matchKeywords, paginate, sortByTime, toReaderMessage } from "./common.mjs";

const SQLITE_MAGIC = Buffer.from("SQLite format 3\u0000", "utf8");
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export const KIND_NAME = {
  1: "text", 3: "image", 34: "voice", 43: "video", 47: "sticker", 48: "location",
  50: "voip", 10000: "system", 67: "unknown",
};

export function kindName(type, subtype) {
  const t = Number(type);
  if (t === 49) {
    const s = Number(subtype ?? 0);
    if (s === 5) return "link";
    if (s === 6 || s === 8) return "file";
    if (s === 19) return "forward_chat";
    if (s === 33) return "miniprogram";
    if (s === 51) return "channel_video";
    if (s === 53) return "solitaire";
    if (s === 57) return "quote";
    if (s === 62) return "pat";
    if (s === 2000) return "transfer";
    if (s === 2001) return "red_packet";
    return "app";
  }
  if (KIND_NAME[t]) return KIND_NAME[t];
  return `type_${t}`;
}

export function md5hex(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

function isPlainSqlite(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return buf.equals(SQLITE_MAGIC);
  } catch {
    return false;
  }
}

function openRo(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec("PRAGMA query_only=ON"); } catch { /* ignore */ }
  return db;
}

function tableNames(db) {
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name); } catch { return []; }
}
function hasTable(db, name) {
  const t = tableNames(db);
  return t.some((x) => x.toLowerCase() === name.toLowerCase());
}
function cols(db, table) {
  try { return db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name); } catch { return []; }
}
const S = (v) => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v));

/** node:sqlite 的 BLOB 是 Uint8Array，Buffer.isBuffer 对它返回 false */
const isBlob = (v) => Buffer.isBuffer(v) || v instanceof Uint8Array;
const toBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v));

/** WCDB 压缩文本：BLOB 且 CTRL==4 时按 zstandard 解压 */
function decodeContent(row) {
  const ctrl = row.WCDB_CT_message_content;
  let raw = row.message_content;
  if (raw === null || raw === undefined) raw = row.compress_content;
  const enc = row.WCDB_CT_compress_content;
  if (isBlob(raw)) {
    if (ctrl === 4 || enc === 4) {
      try { return zlib.zstdDecompressSync(raw).toString("utf8"); } catch { /* fallthrough */ }
    }
    if (toBuf(raw).subarray(0, 4).equals(ZSTD_MAGIC)) {
      try { return zlib.zstdDecompressSync(raw).toString("utf8"); } catch { /* fallthrough */ }
    }
    return toBuf(raw).toString("utf8");
  }
  return S(raw);
}

/** 从 XML/JSON 里提取元数据 */
function extractMeta(text) {
  const out = {};
  const src = String(text ?? "");
  // 两种形态都要认：<md5>值</md5> 与 <img md5="值" length="20480"/>
  const pick = (key, names) => {
    for (const n of names) {
      const tagged = new RegExp(`<${n}>(?:<!\\[CDATA\\[)?([^<\\]]*)`, "i");
      const m1 = src.match(tagged);
      if (m1 && m1[1]) { out[key] = m1[1].slice(0, 500); return; }
      const attr = new RegExp(`\\b${n}\\s*=\\s*["']([^"']+)["']`, "i");
      const m2 = src.match(attr);
      if (m2 && m2[1]) { out[key] = m2[1].slice(0, 500); return; }
    }
  };
  pick("md5", ["md5", "filemd5", "rawfilemd5"]);
  pick("filename", ["filename", "file_name"]);
  pick("title", ["title"]);
  pick("size", ["length", "filesize", "totallen"]);
  return out;
}

/** 群消息正文去掉 "wxid_xxx:\n" 前缀 */
function stripSenderPrefix(text) {
  return String(text ?? "").replace(/^(wxid_[A-Za-z0-9_-]+|[a-zA-Z0-9_-]+@chatroom|[a-zA-Z0-9_-]{6,}):\n/, "");
}

/** 解析 contact.extra_buffer 中 field 30 的标签串（protobuf wire type 2） */
function labelsFromExtraBuffer(buf) {
  if (!buf) return [];
  const b = isBlob(buf) ? toBuf(buf) : Buffer.from(String(buf), "hex");
  const out = [];
  let i = 0;
  while (i < b.length) {
    let key = 0;
    let shift = 0;
    let byte = 0;
    do {
      if (i >= b.length) return out;
      byte = b[i++];
      key |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      do { byte = b[i++]; } while (byte & 0x80 && i < b.length);
    } else if (wire === 2) {
      let len = 0;
      shift = 0;
      do {
        if (i >= b.length) return out;
        byte = b[i++];
        len |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      const val = b.subarray(i, i + len);
      i += len;
      if (field === 30) out.push(...val.toString("utf8").split(",").map((x) => x.trim()).filter(Boolean));
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else return out;
  }
  return out;
}

/** 在 root 下发现 db_storage 布局 */
export function discoverLayout(root) {
  const result = {
    root, dbStorage: null, plaintext: 0, encrypted: 0,
    session: [], contact: [], message: [], favorite: [], sns: [], hardlink: [], other: [], errors: [],
  };
  if (!root || !fs.existsSync(root)) { result.errors.push("root 不存在"); return result; }

  const candidates = [];
  const seenCandidates = new Set();
  const pushIf = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (seenCandidates.has(abs)) return; // 同一个目录可能被多条规则命中
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return;
    seenCandidates.add(abs);
    candidates.push(abs);
  };
  pushIf(root);
  pushIf(path.join(root, "db_storage"));
  try {
    for (const it of fs.readdirSync(root, { withFileTypes: true })) {
      if (!it.isDirectory()) continue;
      pushIf(path.join(root, it.name, "db_storage"));
      pushIf(path.join(root, it.name));
    }
  } catch { /* ignore */ }
  const KNOWN_SUBDIRS = ["session", "contact", "message", "favorite", "sns", "hardlink"];
  const hasKnownSubdirs = (dir) => KNOWN_SUBDIRS.some((k) => fs.existsSync(path.join(dir, k)));
  const hasDirectDb = (dir) => {
    try {
      return fs.readdirSync(dir).some((n) => /\.db$/i.test(n));
    } catch {
      return false;
    }
  };
  // 优先取「含 session/ contact/ message/ 等子目录」的目录；
  // 只有都不满足时才退化为「目录下直接放 .db」——否则会把自己的子目录也当成 db_storage，
  // 导致同一个库被扫描两次（会话/公告/收藏都会翻倍）。
  const withSubdirs = candidates.filter(hasKnownSubdirs);
  const dbStorages = withSubdirs.length ? withSubdirs : candidates.filter(hasDirectDb);
  result.dbStorages = dbStorages;
  result.dbStorage = dbStorages[0] ?? null;
  if (!result.dbStorage) {
    result.errors.push("未发现 db_storage 目录结构（需要 session/ contact/ message/ 等子目录，或目录下直接放 .db）");
    return result;
  }

  const classify = (file) => {
    if (!isPlainSqlite(file)) { result.encrypted += 1; return null; }
    result.plaintext += 1;
    let db;
    try { db = openRo(file); } catch (e) { result.errors.push(`${path.basename(file)}: ${String(e.message ?? e).slice(0, 80)}`); return null; }
    try {
      const tables = tableNames(db).map((x) => x.toLowerCase());
      if (tables.includes("sessiontable")) return "session";
      if (tables.includes("contact")) return "contact";
      if (tables.some((t) => t.startsWith("msg_")) || tables.includes("name2id")) return "message";
      if (tables.includes("fav_db_item")) return "favorite";
      if (tables.includes("snstimeline")) return "sns";
      if (tables.some((t) => t.includes("hardlink_info"))) return "hardlink";
      return "other";
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  };

  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/\.db$/i.test(it.name)) continue;
      const kind = classify(full);
      if (kind && result[kind]) result[kind].push(full);
      else if (!kind) { /* encrypted or unreadable */ }
    }
  };
  for (const ds of dbStorages) walk(ds);
  return result;
}

/**
 * 创建 WCDB reader。
 * @param {{roots?:string[], selfUsername?:string, resourceRoots?:string[]}} opts
 */
export function createWcdbReader({ roots = [], selfUsername = "", resourceRoots = [] } = {}) {
  let layout = null;
  let sessionCache = null;
  const sessionErrors = [];
  /** 会话名 -> 消息表 md5 键（表名不等于 Msg_<md5(会话名)> 时使用） */
  const sessionTableKey = new Map();
  /** 会话层告警（例如缺少 SessionTable、由消息表合成会话） */
  const sessionWarnings = [];
  let contactCache = null;
  let msgCache = new Map();

  const getLayout = () => {
    if (layout) return layout;
    const all = { root: roots[0], dbStorage: null, dbStorages: [], plaintext: 0, encrypted: 0, session: [], contact: [], message: [], favorite: [], sns: [], hardlink: [], other: [], errors: [] };
    for (const r of roots) {
      const l = discoverLayout(r);
      if (!all.dbStorage && l.dbStorage) { all.dbStorage = l.dbStorage; all.root = r; }
      all.dbStorages.push(...(l.dbStorages ?? []));
      for (const k of ["session", "contact", "message", "favorite", "sns", "hardlink", "other"]) all[k].push(...l[k]);
      all.plaintext += l.plaintext;
      all.encrypted += l.encrypted;
      all.errors.push(...l.errors);
    }
    layout = all;
    return layout;
  };

  // ---------- contacts ----------
  const loadContacts = () => {
    if (contactCache) return contactCache;
    const L = getLayout();
    const map = new Map();
    const labels = new Map();
    for (const file of L.contact) {
      let db;
      try { db = openRo(file); } catch { continue; }
      try {
        if (hasTable(db, "contact_label")) {
          for (const r of db.prepare("SELECT * FROM contact_label").all()) {
            const id = S(r.label_id_ ?? r.label_id ?? r.id);
            const name = S(r.label_name_ ?? r.label_name ?? r.name);
            if (id && name) labels.set(id, name);
          }
        }
        const cs = cols(db, "contact");
        const cname = cs.find((c) => /^username$/i.test(c)) ?? "username";
        const nick = cs.find((c) => /^nick_name$/i.test(c)) ?? "nick_name";
        const remark = cs.find((c) => /^remark$/i.test(c)) ?? "remark";
        const alias = cs.find((c) => /^alias$/i.test(c)) ?? "alias";
        const extra = cs.find((c) => /^extra_buffer$/i.test(c));
        const rows = db.prepare(`SELECT * FROM contact LIMIT 200000`).all();
        for (const r of rows) {
          const username = S(r[cname]);
          if (!username) continue;
          const display = S(r[remark]) || S(r[nick]) || username;
          const lb = extra ? labelsFromExtraBuffer(r[extra]) : [];
          map.set(username, {
            username, nick_name: S(r[nick]), remark: S(r[remark]), alias: S(r[alias]),
            display_name: display, labels: lb,
            chat_type: username.endsWith("@chatroom") ? "group" : username.includes("@openim") ? "corp_im" : username.startsWith("gh_") ? "official_account" : "private",
          });
        }
        if (hasTable(db, "chat_room")) {
          for (const r of db.prepare("SELECT * FROM chat_room LIMIT 20000").all()) {
            const username = S(r.username ?? r.chat_room ?? r.room_id);
            if (username && !map.has(username)) {
              map.set(username, { username, nick_name: "", remark: "", alias: "", display_name: username, labels: [], chat_type: "group" });
            }
          }
        }
      } catch { /* ignore */ } finally { try { db.close(); } catch { /* ignore */ } }
    }
    contactCache = { map, labels };
    return contactCache;
  };

  const display = (username) => {
    const { map } = loadContacts();
    return map.get(username)?.display_name ?? username;
  };

  // ---------- sessions ----------
  const loadSessions = () => {
    if (sessionCache) return sessionCache;
    const L = getLayout();
    const { map } = loadContacts();
    const sessions = new Map();
    for (const file of L.session) {
      let db;
      try { db = openRo(file); } catch { continue; }
      try {
        const cs = cols(db, "SessionTable");
        const uname = cs.find((c) => /^username$/i.test(c)) ?? "username";
        const pick = (n) => cs.find((c) => c.toLowerCase() === n);
        // 注意：SQLite 的 COALESCE 至少要两个参数，只有一个排序列时必须退化为直接排序
        const orderCols = [pick("sort_timestamp"), pick("last_timestamp")].filter(Boolean);
        // SQLite 的 COALESCE 至少两个参数：只有一列时直接用它
        const orderBy = orderCols.length >= 2 ? `COALESCE(${orderCols.join(", ")})` : (orderCols[0] ?? "rowid");
        const sql = `SELECT * FROM SessionTable ORDER BY ${orderBy} DESC LIMIT 20000`;
        for (const r of db.prepare(sql).all()) {
          const username = S(r[uname]);
          if (!username) continue;
          const c = map.get(username);
          const summary = decodeMaybeBlob(r[pick("summary") ?? "summary"]);
          sessions.set(username, {
            username,
            display_name: c?.display_name ?? (S(r[pick("last_sender_display_name") ?? "last_sender_display_name"]) || username),
            chat_type: username.endsWith("@chatroom") ? "group" : c?.chat_type ?? "private",
            unread_count: Number(r[pick("unread_count") ?? "unread_count"] ?? 0),
            summary: String(summary).slice(0, 200),
            last_timestamp: Number(r[pick("last_timestamp") ?? "last_timestamp"] ?? 0) || null,
            sort_timestamp: Number(r[pick("sort_timestamp") ?? "sort_timestamp"] ?? 0) || null,
          });
        }
      } catch (e) {
        sessionErrors.push(`${path.basename(file)}: ${String(e.message ?? e).slice(0, 120)}`);
      } finally { try { db.close(); } catch { /* ignore */ } }
    }
    // 会话表缺失时，用 contact 兜底
    if (!sessions.size) {
      // 兜底 1：没有 SessionTable（或读取失败）时用联系人推断，但明确标注，避免被误当成真实会话视图
      for (const [u, c] of map) {
        if (u === selfUsername) continue; // 本人不是会话
        sessions.set(u, { username: u, display_name: c.display_name, chat_type: c.chat_type, unread_count: 0, summary: "", last_timestamp: null, sort_timestamp: null, derived: true });
      }
      if (sessions.size) sessionWarnings.push(`当前会话列表由联系人推断（缺少可用 SessionTable），没有未读数与最后消息时间`);
    }
    // 兜底 2：连联系人也没有时，按消息表合成会话（md5 不可逆，只能用可辨认的占位名）
    if (!sessions.size) {
      for (const [key, entry] of msgIndex()) {
        const md5key = key.replace(/^msg_/, "");
        if (!md5key) continue;
        const name = `未知会话-${md5key.slice(0, 8)}`;
        sessionTableKey.set(name, md5key);
        sessions.set(name, {
          username: name, display_name: name, chat_type: "private", unread_count: 0, summary: "",
          last_timestamp: null, sort_timestamp: null, derived: true, from_message_table: entry.table,
        });
      }
      if (sessions.size) {
        sessionWarnings.push(`缺少 SessionTable 与联系人库，已按 ${sessions.size} 个消息表合成会话名；显示名为占位（md5 不可逆），建议补齐 session/contact 库`);
      }
    }
    sessionCache = sessions;
    return sessionCache;
  };

  function decodeMaybeBlob(v) {
    if (isBlob(v)) {
      const b = toBuf(v);
      if (b.subarray(0, 4).equals(ZSTD_MAGIC)) { try { return zlib.zstdDecompressSync(b).toString("utf8"); } catch { /* fallthrough */ } }
      return b.toString("utf8");
    }
    return S(v);
  }

  // ---------- messages ----------
  /** 消息表索引：小写表名 -> { file, table(真实大小写) } */
  const msgIndex = () => {
    const L = getLayout();
    if (msgIndex._built) return msgIndex._built;
    const idx = new Map();
    for (const file of L.message) {
      let db;
      try { db = openRo(file); } catch { continue; }
      try {
        for (const t of tableNames(db)) {
          if (/^Msg_/i.test(t)) idx.set(t.toLowerCase(), { file, table: t });
        }
      } finally { try { db.close(); } catch { /* ignore */ } }
    }
    msgIndex._built = idx;
    return idx;
  };

  const loadChat = (username) => {
    if (msgCache.has(username)) return msgCache.get(username);
    // 表名不一定等于 Msg_<md5(显示名)>：优先用登记过的真实表名
    const override = sessionTableKey.get(username);
    const key = (override ?? `Msg_${md5hex(username)}`).toLowerCase();
    const entry = msgIndex().get(key) ?? msgIndex().get(override ? `msg_${override}`.toLowerCase() : "");
    if (!entry) { msgCache.set(username, []); return []; }
    const { file, table } = entry;
    let db;
    try { db = openRo(file); } catch { msgCache.set(username, []); return []; }
    let rows = [];
    try {
      const cs = cols(db, table);
      const has = (n) => cs.some((c) => c.toLowerCase() === n);
      const nameMap = new Map();
      if (hasTable(db, "Name2Id")) {
        for (const r of db.prepare("SELECT rowid, user_name FROM Name2Id").all()) nameMap.set(Number(r.rowid), S(r.user_name));
      }
      const contentCol = has("message_content") ? "message_content" : has("compress_content") ? "compress_content" : null;
      if (!contentCol) { msgCache.set(username, []); return []; }
      const ctrl = has("WCDB_CT_message_content") ? ", WCDB_CT_message_content" : ", NULL AS WCDB_CT_message_content";
      const ctrl2 = has("WCDB_CT_compress_content") ? ", WCDB_CT_compress_content" : ", NULL AS WCDB_CT_compress_content";
      const sub = has("local_type") ? "local_type" : "0 AS local_type";
      const hasLocal = has("local_id");
      const hasServer = has("server_id");
      const hasCreate = has("create_time");
      const sql = `SELECT ${hasLocal ? "local_id" : "rowid AS local_id"}, ${hasServer ? "server_id" : "NULL AS server_id"}, ${sub} AS local_type, real_sender_id, ${hasCreate ? "create_time" : "0 AS create_time"}, ${contentCol} AS message_content, ${has("compress_content") ? "compress_content" : "NULL AS compress_content"}${ctrl}${ctrl2} FROM "${table}" ORDER BY ${hasCreate ? "create_time" : "rowid"} ASC LIMIT 200000`;
      rows = db.prepare(sql).all();
      const chatDisplay = display(username);
      const out = [];
      for (const r of rows) {
        const rawType = Number(r.local_type) || 0;
        const base = rawType & 0xffffffff;
        const subtype = rawType > 0xffffffff ? Math.floor(rawType / 0x100000000) : 0;
        const senderWxid = nameMap.get(Number(r.real_sender_id)) ?? "";
        let text = decodeContent(r);
        let sender = senderWxid ? display(senderWxid) : chatDisplay;
        if (username.endsWith("@chatroom")) {
          const m = text.match(/^(wxid_[A-Za-z0-9_-]+|[a-zA-Z0-9_-]+@chatroom|[a-zA-Z0-9_-]{6,}):\n/);
          if (m) { sender = display(m[1]) || sender; text = stripSenderPrefix(text); }
        }
        const kn = kindName(base, subtype);
        const fromMe = !!(selfUsername && senderWxid === selfUsername);
        const row = toReaderMessage({
          chat: chatDisplay, chatroom_id: username, sender, sender_id: senderWxid,
          ts: Number(r.create_time) > 1e12 ? Number(r.create_time) : Number(r.create_time) * 1000,
          type: base, subtype, kind_name: kn, content: text,
          id: `${path.basename(file)}:${r.local_id}`,
          media: /image|video|voice|file|sticker/.test(kn) ? [extractMeta(text)] : [],
          is_owner: fromMe,
        }, { chat: chatDisplay });
        // toReaderMessage 只保留通用字段，这里补回上游协议会暴露的列与派生字段
        row.local_id = r.local_id ?? null;
        row.server_id = r.server_id ?? null;
        row.local_type = rawType;
        row.subtype = subtype;
        row.kind_name = kn;
        row.talker = username;
        row.from_me = fromMe;
        out.push(row);
      }
      msgCache.set(username, out);
      return out;
    } catch {
      msgCache.set(username, []);
      return [];
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  };

  const allChats = () => [...loadSessions().keys()];

  const searchAll = (keyword, { limit, offset, inChat, after, before, maxTextChars = 240 }) => {
    const kws = String(keyword).split(",").map((x) => x.trim()).filter(Boolean);
    const chats = inChat ? allChats().filter((u) => u.includes(inChat) || display(u).includes(inChat)) : allChats();
    let rows = [];
    for (const u of chats) {
      for (const m of loadChat(u)) {
        if (!matchKeywords(m.content, kws)) continue;
        if (after && m.ts < after) continue;
        if (before && m.ts > before) continue;
        rows.push(m);
      }
    }
    rows = sortByTime(rows, "desc");
    const p = paginate(rows, { limit, offset });
    return { rows: p.rows.map((m) => ({ ...m, content: m.content.slice(0, maxTextChars) })), query: p.query };
  };

  // ---------- 成员 / 群公告 ----------
  const loadMembers = (chatroomUsername) => {
    const L = getLayout();
    for (const file of L.contact) {
      let db;
      try { db = openRo(file); } catch { continue; }
      try {
        if (!hasTable(db, "chatroom_member") || !hasTable(db, "chat_room")) continue;
        const room = db.prepare("SELECT id, username FROM chat_room WHERE username=?").get(chatroomUsername);
        if (!room) continue;
        const rows = db.prepare(`SELECT c.username, c.nick_name, c.remark, c.alias, c.local_type
          FROM chatroom_member m JOIN contact c ON c.id = m.member_id WHERE m.room_id=?`).all(room.id);
        return rows.map((r) => ({
          username: S(r.username), nick_name: S(r.nick_name), remark: S(r.remark), alias: S(r.alias),
          display_name: S(r.remark) || S(r.nick_name) || S(r.username),
        }));
      } catch { /* ignore */ } finally { try { db.close(); } catch { /* ignore */ } }
    }
    return [];
  };

  const loadAnnouncements = (chatroomUsername) => {
    const L = getLayout();
    const out = [];
    for (const file of L.contact) {
      let db;
      try { db = openRo(file); } catch { continue; }
      try {
        if (!hasTable(db, "chat_room_info_detail") || !hasTable(db, "chat_room")) continue;
        const sql = chatroomUsername
          ? "SELECT d.*, r.username FROM chat_room_info_detail d JOIN chat_room r ON r.id=d.room_id_ WHERE r.username=?"
          : "SELECT d.*, r.username FROM chat_room_info_detail d JOIN chat_room r ON r.id=d.room_id_ LIMIT 200";
        const rows = chatroomUsername ? db.prepare(sql).all(chatroomUsername) : db.prepare(sql).all();
        for (const r of rows) {
          out.push({
            chatroom_id: S(r.username),
            announcement: S(r.announcement_ ?? r.announcement).slice(0, 4000),
            editor: S(r.announcement_editor_ ?? r.announcement_editor),
            publish_time: Number(r.announcement_publish_time_ ?? r.announcement_publish_time ?? 0) || null,
            time: Number(r.announcement_publish_time_ ?? 0) ? new Date(Number(r.announcement_publish_time_) * 1000).toISOString() : null,
          });
        }
      } catch { /* ignore */ } finally { try { db.close(); } catch { /* ignore */ } }
    }
    return out;
  };

  const loadFavorites = ({ limit = 100, after, before } = {}) => {
    const L = getLayout();
    const out = [];
    for (const file of L.favorite) {
      let db;
      try { db = openRo(file); } catch { continue; }
      try {
        for (const r of db.prepare("SELECT * FROM fav_db_item ORDER BY update_time DESC LIMIT ?").all(limit)) {
          const ts = Number(r.update_time ?? 0) * 1000;
          if (after && ts < after) continue;
          if (before && ts > before) continue;
          out.push({ local_id: r.local_id ?? null, server_id: r.server_id ?? null, type: r.type ?? null, source: "favorite", time: ts ? new Date(ts).toISOString() : null, ts, text: S(r.content).slice(0, 1000), chat: S(r.realchatname), sender: S(r.fromusr) });
        }
      } catch { /* ignore */ } finally { try { db.close(); } catch { /* ignore */ } }
    }
    return out;
  };

  const loadSnsFeed = ({ keyword, limit = 100 } = {}) => {
    const L = getLayout();
    const out = [];
    for (const file of L.sns) {
      let db;
      try { db = openRo(file); } catch { continue; }
      try {
        for (const r of db.prepare("SELECT * FROM SnsTimeLine LIMIT 5000").all()) {
          const xml = S(r.content);
          const create = Number((xml.match(/<createTime>(\d+)/) ?? [])[1] ?? 0) * 1000;
          const user = (xml.match(/<userName>(?:<!\[CDATA\[)?([^<\]]*)/) ?? [])[1] ?? S(r.user_name);
          const desc = (xml.match(/<contentDesc>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>|<\/contentDesc>)/) ?? [])[1] ?? "";
          const item = { tid: r.tid ?? null, user_name: user, text: desc.slice(0, 1000), ts: create, time: create ? new Date(create).toISOString() : null, source: "sns_timeline" };
          if (keyword && !matchKeywords(item.text, [keyword])) continue;
          out.push(item);
        }
      } catch { /* ignore */ } finally { try { db.close(); } catch { /* ignore */ } }
    }
    return out.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, limit);
  };

  const capabilityReport = () => {
    const L = getLayout();
    return {
      root: L.root, db_storage: L.dbStorage, db_storage_count: (L.dbStorages ?? []).length || (L.dbStorage ? 1 : 0),
      plaintext_databases: L.plaintext, encrypted_databases: L.encrypted,
      session_dbs: L.session.length, contact_dbs: L.contact.length, message_dbs: L.message.length,
      favorite_dbs: L.favorite.length, sns_dbs: L.sns.length, hardlink_dbs: L.hardlink.length,
      capabilities: {
        sessions: L.session.length > 0 || L.contact.length > 0,
        contacts: L.contact.length > 0,
        timeline: L.message.length > 0,
        search: L.message.length > 0,
        members: L.contact.length > 0,
        announcements: L.contact.length > 0,
        favorites: L.favorite.length > 0,
        sns: L.sns.length > 0,
      },
      errors: L.errors.slice(0, 20),
    };
  };

  const A = "wcdb-reader";

  return {
    id: "wcdb",
    kind: "sqlite",
    describe: capabilityReport,
    capabilities: capabilityReport,
    version: async () => envelope({ tool: A, command: "version", data: { version: "1.0.0", reader: "wcdb", protocol: "wechat-reader/1" } }),
    status: async () => {
      const cap = capabilityReport();
      const anyPlain = cap.plaintext_databases > 0;
      const state = !cap.db_storage ? "needs_database_location" : !anyPlain && cap.encrypted_databases > 0 ? "needs_access" : !cap.capabilities.timeline && !cap.capabilities.sessions ? "database_layout_unsupported" : "ready";
      return envelope({
        tool: A, command: "status",
        data: {
          state, live_database_read_ok: state === "ready", reader: "wcdb", ...cap,
          detail: state === "ready" ? "已解密的微信 4.x 数据库可读（只读打开，未修改任何文件）"
            : state === "needs_access" ? "检测到加密数据库：本机需提供已解密副本（本项目不获取密钥、不解密）"
              : state === "needs_database_location" ? "未找到 db_storage 目录，请用配置指定路径"
                : "目录存在但未识别出会话/消息表",
          warnings: [
            ...(cap.encrypted_databases > 0 && anyPlain ? [`${cap.encrypted_databases} 个数据库仍为加密状态，未纳入读取范围`] : []),
            ...sessionErrors.map((e) => `会话表读取失败，已退化为联系人推断：${e}`),
            ...sessionWarnings,
          ],
        },
      });
    },
    sessions: async ({ limit = 80, typeFilter, keyword } = {}) => {
      let rows = [...loadSessions().values()];
      if (typeFilter) { const ts = String(typeFilter).split(",").map((x) => x.trim()); rows = rows.filter((s) => ts.includes(s.chat_type)); }
      if (keyword) rows = rows.filter((s) => s.display_name.includes(keyword) || s.username.includes(keyword));
      rows.sort((a, b) => (b.sort_timestamp ?? b.last_timestamp ?? 0) - (a.sort_timestamp ?? a.last_timestamp ?? 0));
      return envelope({ tool: A, command: "sessions", data: { sessions: rows.slice(0, limit) } });
    },
    contacts: async ({ limit = 100, keyword, friendsOnly, groupsOnly } = {}) => {
      let rows = [...loadContacts().map.values()];
      if (keyword) rows = rows.filter((c) => c.display_name.includes(keyword) || c.username.includes(keyword));
      if (friendsOnly) rows = rows.filter((c) => c.chat_type === "private");
      if (groupsOnly) rows = rows.filter((c) => c.chat_type === "group");
      return envelope({ tool: A, command: "contacts", data: { contacts: rows.slice(0, limit), labels: [...loadContacts().labels.values()] } });
    },
    labels: async () => envelope({ tool: A, command: "labels", data: { labels: [...loadContacts().labels.values()], note: "微信标签通过 contact_label + contact.extra_buffer 只读解析，不会修改微信标签" } }),
    resolveChat: async (name, { typeFilter, limit = 10 } = {}) => {
      const q = String(name ?? "");
      const sessions = [...loadSessions().values()];
      const exact = sessions.filter((s) => s.display_name === q || s.username === q);
      const partial = sessions.filter((s) => !exact.includes(s) && (s.display_name.includes(q) || s.username.includes(q)));
      let hits = [...exact, ...partial];
      if (typeFilter) { const ts = String(typeFilter).split(",").map((x) => x.trim()); hits = hits.filter((s) => ts.includes(s.chat_type)); }
      if (!hits.length) return envelope({ tool: A, command: "resolve-chat", ok: false, data: { state: "not_found", candidates: [] } });
      return envelope({ tool: A, command: "resolve-chat", data: { chat: hits[0].display_name, talker: hits[0].username, kind: hits[0].chat_type, ambiguous: hits.length > 1, candidates: hits.slice(0, limit).map((s) => s.display_name) } });
    },
    timeline: async (talker, { limit = 200, offset = 0, displayOrder = "asc", since, before, keyword, sender, typeFilter } = {}) => {
      const username = resolveUsername(talker);
      if (!username) return envelope({ tool: A, command: "timeline", ok: false, data: { messages: [], state: "not_found" } });
      let rows = sortByTime(loadChat(username), displayOrder === "desc" ? "desc" : "asc");
      if (since) { const t = Date.parse(since); if (!Number.isNaN(t)) rows = rows.filter((m) => m.ts >= t); }
      if (before) { const t = Date.parse(before); if (!Number.isNaN(t)) rows = rows.filter((m) => m.ts <= t); }
      if (keyword) rows = rows.filter((m) => matchKeywords(m.content, [keyword]));
      if (sender) rows = rows.filter((m) => String(m.sender).includes(sender));
      if (typeFilter) rows = rows.filter((m) => m.kind_name === typeFilter);
      const p = paginate(rows, { limit, offset });
      return envelope({ tool: A, command: "timeline", data: { talker: username, chat: display(username), messages: p.rows, query: p.query } });
    },
    context: async ({ talker, localId, beforeCount = 20, afterCount = 20 } = {}) => {
      const username = resolveUsername(talker);
      if (!username) return envelope({ tool: A, command: "context", ok: false, data: { messages: [] } });
      const rows = loadChat(username);
      const idx = rows.findIndex((m) => String(m.id).endsWith(`:${localId}`));
      if (idx < 0) return envelope({ tool: A, command: "context", ok: false, data: { messages: [], state: "anchor_not_found" } });
      const slice = rows.slice(Math.max(0, idx - beforeCount), idx + afterCount + 1).map((m, i) => ({ ...m, context_role: i === idx - Math.max(0, idx - beforeCount) ? "anchor" : "context" }));
      return envelope({ tool: A, command: "context", data: { talker: username, messages: slice } });
    },
    members: async (chat, { limit = 500 } = {}) => {
      const username = resolveUsername(chat);
      if (!username) return envelope({ tool: A, command: "members", ok: false, data: { members: [] } });
      const members = loadMembers(username);
      return envelope({ tool: A, command: "members", data: { chatroom_id: username, total: members.length, members: members.slice(0, limit) } });
    },
    announcements: async (chat, { limit = 20 } = {}) => {
      const username = chat ? resolveUsername(chat) : null;
      const rows = loadAnnouncements(username);
      return envelope({ tool: A, command: "announcements", data: { announcements: rows.slice(0, limit) } });
    },
    favorites: async ({ limit = 100, after, before } = {}) => {
      const t = (x) => (x ? Date.parse(x) : undefined);
      const rows = loadFavorites({ limit, after: t(after), before: t(before) });
      return envelope({ tool: A, command: "favorites", data: { favorites: rows.slice(0, limit) } });
    },
    snsFeed: async ({ keyword, limit = 100 } = {}) => envelope({ tool: A, command: "sns-feed", data: { items: loadSnsFeed({ keyword, limit }) } }),
    snsSearch: async (keyword, { limit = 100 } = {}) => envelope({ tool: A, command: "sns-search", data: { keyword, items: loadSnsFeed({ keyword, limit }) } }),
    search: async (keyword, { limit = 100, offset = 0, maxTextChars = 240, inChat, after, before } = {}) => {
      const t = (x) => (x ? Date.parse(x) : undefined);
      const r = searchAll(keyword, { limit, offset, inChat, after: t(after), before: t(before), maxTextChars });
      return envelope({ tool: A, command: "search", data: { keyword, messages: r.rows, query: r.query } });
    },
    media: async ({ chat, kind, limit = 50 } = {}) => {
      const chats = chat ? [resolveUsername(chat)].filter(Boolean) : allChats();
      const out = [];
      for (const u of chats.slice(0, 200)) {
        for (const m of loadChat(u)) {
          if (!/image|video|voice|file|sticker/.test(m.kind_name)) continue;
          if (kind && m.kind_name !== kind) continue;
          out.push({ chat: m.chat, talker: u, local_id: String(m.id).split(":").pop(), kind_name: m.kind_name, sender: m.sender, ts: m.ts, time: m.time, meta: m.media?.[0] ?? {} });
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
      return envelope({ tool: A, command: "media", data: { media: out, note: "仅返回分类、元数据与本地已存在路径；不做 OCR/ASR" } });
    },
    redPackets: async ({ limit = 50 } = {}) => findAppMessages((_b, _s, m) => m.kind_name === "red_packet", limit, "red-packets"),
    transfers: async ({ limit = 50 } = {}) => findAppMessages((_b, _s, m) => m.kind_name === "transfer", limit, "transfers"),
    forwardHistory: async ({ limit = 50 } = {}) => findAppMessages((_b, _s, m) => m.kind_name === "forward_chat", limit, "forward-history"),
    unread: async ({ limit = 50 } = {}) => {
      const rows = [...loadSessions().values()].filter((s) => s.unread_count > 0).sort((a, b) => b.unread_count - a.unread_count);
      return envelope({ tool: A, command: "unread", data: { sessions: rows.slice(0, limit), total_unread: rows.reduce((a, s) => a + s.unread_count, 0) } });
    },
    stats: async () => {
      const cap = capabilityReport();
      let messages = 0;
      const perChat = [];
      for (const u of allChats()) {
        const n = loadChat(u).length;
        messages += n;
        if (n) perChat.push({ talker: u, chat: display(u), messages: n });
      }
      return envelope({ tool: A, command: "stats", data: { ...cap, sessions: loadSessions().size, contacts: loadContacts().map.size, total_messages: messages, top_chats: perChat.sort((a, b) => b.messages - a.messages).slice(0, 20) } });
    },
    sql: async ({ query, limit = 100 } = {}) => {
      const L = getLayout();
      if (!/^\s*(select|with|pragma)\b/i.test(String(query ?? ""))) {
        return envelope({ tool: A, command: "sql", ok: false, data: { rows: [], error: { code: "read_only_required", message: "仅允许只读 SELECT/WITH/PRAGMA" } } });
      }
      const files = [...L.session, ...L.contact, ...L.message, ...L.favorite, ...L.sns, ...L.hardlink];
      const errors = [];
      for (const f of files) {
        let db;
        try { db = openRo(f); } catch (e) { errors.push({ file: f, error: String(e.message ?? e).slice(0, 120) }); continue; }
        try {
          const rows = db.prepare(String(query)).all().slice(0, limit);
          if (rows.length) return envelope({ tool: A, command: "sql", data: { rows, file: f } });
        } catch (e) {
          errors.push({ file: path.basename(f), error: String(e.message ?? e).slice(0, 120) });
        } finally { try { db.close(); } catch { /* ignore */ } }
      }
      return envelope({ tool: A, command: "sql", ok: false, data: { rows: [], errors: errors.slice(0, 10) } });
    },
    exportMessages: async ({ chat, format = "jsonl", limit = 1000, since, before } = {}) => {
      const t = await createWcdbReader({ roots, selfUsername, resourceRoots }).timeline(chat, { limit, since, before, displayOrder: "asc" });
      const rows = t.data.messages ?? [];
      if (format === "markdown") {
        const md = rows.map((m) => `**${m.sender}** · ${m.time}\n\n${m.content}\n`).join("\n");
        return envelope({ tool: A, command: "export", data: { format, content: md, count: rows.length } });
      }
      if (format === "html") {
        const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
        return envelope({ tool: A, command: "export", data: { format, content: `<!doctype html><meta charset="utf-8"><body>${rows.map((m) => `<p><b>${esc(m.sender)}</b> <small>${esc(m.time)}</small><br>${esc(m.content)}</p>`).join("")}</body>`, count: rows.length } });
      }
      return envelope({ tool: A, command: "export", data: { format: "jsonl", content: rows.map((m) => JSON.stringify(m)).join("\n"), count: rows.length } });
    },
  };

  function findAppMessages(pred, limit, command) {
    const out = [];
    for (const u of allChats()) {
      for (const m of loadChat(u)) {
        // 兼容两种编码：标准 49|(subtype<<32) 与直接写子类型号
        const t = Number(m.local_type) || Number(m.type) || 0;
        const base = t & 0xffffffff;
        const sub = t > 0xffffffff ? Math.floor(t / 0x100000000) : t;
        if (pred(base, sub, m)) out.push({ chat: m.chat, talker: u, sender: m.sender, ts: m.ts, time: m.time, kind_name: m.kind_name, local_id: m.local_id, server_id: m.server_id, content: m.content.slice(0, 300) });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return envelope({ tool: A, command, data: { rows: out } });
  }

  function resolveUsername(talker) {
    const q = String(talker ?? "");
    const sessions = loadSessions();
    if (sessions.has(q)) return q;
    for (const [u, s] of sessions) if (s.display_name === q) return u;
    for (const [u, s] of sessions) if (s.display_name.includes(q) || u.includes(q)) return u;
    const table = `Msg_${md5hex(q)}`;
    if (msgIndex().has(table.toLowerCase())) return q;
    for (const [u] of sessions) if (u === q) return u;
    // 由消息表合成出来的会话
    for (const [u, key] of sessionTableKey) {
      if (u === q || key === q) return u;
    }
    return null;
  }
}
