// sqlite Reader：只读打开「已解密的」微信数据库副本（Windows 现实可行路径之一）
// 支持微信 3.x（MSG 表）与 4.x（message 表 + Name2Id）两套 schema 的自动识别。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { minMax } from "../util.mjs";
import { envelope, inferKind, matchKeywords, paginate, sortByTime, toReaderMessage } from "./common.mjs";

function listDbFiles(root) {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 5 || !fs.existsSync(dir)) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (/\.db$/i.test(it.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function openRo(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec("PRAGMA query_only=ON"); } catch { /* ignore */ }
  return db;
}

function tables(db) {
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name); } catch { return []; }
}
function columns(db, table) {
  try { return db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name); } catch { return []; }
}

/** 探测一个数据库的 schema 并返回可读描述 */
export function describeDb(file) {
  let db;
  try { db = openRo(file); } catch (e) { return { file, ok: false, error: String(e.message ?? e) }; }
  try {
    const t = tables(db);
    const has = (n) => t.some((x) => x.toLowerCase() === n.toLowerCase());
    if (has("MSG")) {
      const cols = columns(db, "MSG");
      return { file, ok: true, schema: "wechat3", tables: t.length, has: { MSG: true }, columns: cols };
    }
    if (has("message")) {
      const cols = columns(db, "message");
      return { file, ok: true, schema: "wechat4", tables: t.length, has: { message: true, Name2Id: has("Name2Id") }, columns: cols };
    }
    if (has("contact") || has("Contact")) {
      return { file, ok: true, schema: "contact", tables: t.length, has: { contact: true }, columns: columns(db, has("contact") ? "contact" : "Contact") };
    }
    if (has("Session") || has("session")) {
      return { file, ok: true, schema: "session", tables: t.length, has: { session: true } };
    }
    return { file, ok: true, schema: "unknown", tables: t.length, names: t.slice(0, 40) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// node:sqlite 的 BLOB 是 Uint8Array：必须按 UTF-8 解码，String() 会得到 "1,2,3" 这样的字节列表
const cstr = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.isBuffer(v) ? v : Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    try { return zlib.zstdDecompressSync(b).toString("utf8"); } catch { /* 非 zstd */ }
    return b.toString("utf8");
  }
  return String(v);
};

function decodeWeChat3Text(row) {
  const raw = cstr(row.StrContent);
  if (raw) return raw;
  const disp = cstr(row.DisplayContent);
  if (disp) return disp;
  return "";
}

export function createSqliteReader({ roots = [], files = [], cache = true } = {}) {
  let discovered = null;
  let cacheData = null;
  const cacheTtlMs = 30_000;
  let cacheAt = 0;

  const discover = () => {
    if (discovered) return discovered;
    const all = [];
    for (const r of roots) all.push(...listDbFiles(r));
    for (const f of files) if (fs.existsSync(f)) all.push(f);
    discovered = [...new Set(all)].map((f) => ({ file: f, ...describeDb(f) }));
    return discovered;
  };

  const loadAll = () => {
    if (cache && cacheData && Date.now() - cacheAt < cacheTtlMs) return cacheData;
    const sessions = new Map();
    const nameMap = new Map();
    const dbs = discover().filter((d) => d.ok);
    // 先读 Name2Id / Contact 建立 id→名字映射
    for (const d of dbs) {
      if (d.schema === "wechat4" && d.has?.Name2Id) {
        let db = null;
        try {
          db = openRo(d.file);
          for (const r of db.prepare("SELECT rowid, user_name FROM Name2Id").all()) nameMap.set(Number(r.rowid), cstr(r.user_name));
        } catch { /* ignore */ } finally { try { db?.close(); } catch { /* ignore */ } }
      }
      if (d.schema === "contact" || d.schema === "wechat4") {
        const table = d.schema === "contact" ? (d.has.contact ? "contact" : "Contact") : null;
        if (table) {
          let db = null;
          try {
            db = openRo(d.file);
            const cols = columns(db, table);
            const nameCol = cols.find((c) => /^(username|user_name)$/i.test(c));
            const nickCol = cols.find((c) => /^(nickname|nick_name)$/i.test(c));
            const remarkCol = cols.find((c) => /^(remark|con_remark)$/i.test(c));
            if (nameCol) {
              for (const r of db.prepare(`SELECT * FROM "${table}" LIMIT 20000`).all()) {
                const nm = cstr(r[nameCol]);
                if (nm) nameMap.set(nm, cstr(r[remarkCol]) || cstr(r[nickCol]) || nm);
              }
            }
          } catch { /* ignore */ } finally { try { db?.close(); } catch { /* ignore */ } }
        }
      }
    }
    const display = (id) => (id === null || id === undefined ? "" : (nameMap.get(Number(id)) ?? nameMap.get(cstr(id)) ?? cstr(id)));

    for (const d of dbs) {
      if (d.schema === "wechat3") {
        let db = null;
        try {
          db = openRo(d.file);
          const rows = db.prepare(`SELECT localId, StrTalker, IsSender, CreateTime, Type, StrContent, DisplayContent, BytesExtra, CompressContent FROM MSG ORDER BY CreateTime ASC LIMIT 500000`).all();
          for (const r of rows) {
            const chat = cstr(r.StrTalker);
            const sender = Number(r.IsSender) === 1 ? "__owner__" : chat;
            const m = toReaderMessage({
              chat, sender, sender_id: sender, ts: Number(r.CreateTime) > 1e12 ? Number(r.CreateTime) : Number(r.CreateTime) * 1000,
              type: Number(r.Type), content: decodeWeChat3Text(r), id: `w3-${path.basename(d.file)}-${r.localId}`,
            });
            addTo(sessions, chat, m);
          }
        } catch { /* ignore */ } finally { try { db?.close(); } catch { /* ignore */ } }
      } else if (d.schema === "wechat4") {
        let db = null;
        try {
          db = openRo(d.file);
          const rows = db.prepare("SELECT local_id, local_type, create_time, real_sender_id, message_content, source FROM message ORDER BY create_time ASC LIMIT 500000").all();
          for (const r of rows) {
            const sender = display(r.real_sender_id);
            const chat = cstr(r.source) || sender;
            const m = toReaderMessage({
              chat, sender, sender_id: cstr(r.real_sender_id),
              ts: Number(r.create_time) > 1e12 ? Number(r.create_time) : Number(r.create_time) * 1000,
              type: Number(r.local_type), content: cstr(r.message_content), id: `w4-${path.basename(d.file)}-${r.local_id}`,
            });
            addTo(sessions, chat, m);
          }
        } catch { /* ignore */ } finally { try { db?.close(); } catch { /* ignore */ } }
      }
    }
    const list = [...sessions.values()].map((s) => {
      const { min, max } = minMax(s.messages.map((m) => m.ts).filter(Boolean));
      return { ...s, msg_count: s.messages.length, first_ts: min, last_ts: max };
    }).sort((a, b) => (b.last_ts ?? 0) - (a.last_ts ?? 0));
    cacheData = { sessions: list, dbs };
    cacheAt = Date.now();
    return cacheData;
  };

  function addTo(map, chat, m) {
    const key = chat || "未知会话";
    if (!map.has(key)) map.set(key, { name: key, kind: inferKind(key), messages: [] });
    map.get(key).messages.push(m);
  }

  return {
    id: "sqlite",
    kind: "sqlite",
    describe: () => {
      const d = discover();
      return { reader: "sqlite", roots, databases: d.length, readable: d.filter((x) => x.ok).length, schemas: d.map((x) => ({ file: x.file, schema: x.schema, ok: x.ok, error: x.error })) };
    },
    version: async () => envelope({ tool: "sqlite-reader", command: "version", data: { version: "1.0.0", reader: "sqlite", protocol: "wechat-reader/1" } }),
    status: async () => {
      const d = discover();
      const readable = d.filter((x) => x.ok && x.schema !== "unknown");
      const state = !d.length ? "needs_access" : !readable.length ? "needs_access" : "ready";
      const v = state === "ready" ? loadAll() : { sessions: [] };
      return envelope({
        tool: "sqlite-reader", command: "status",
        data: {
          state, reader: "sqlite", databases: d.length, readable: readable.length,
          message_count: v.sessions.reduce((a, s) => a + s.msg_count, 0), session_count: v.sessions.length,
          schemas: d.map((x) => ({ file: x.file, schema: x.schema, ok: x.ok })),
          detail: state === "ready" ? "已解密的微信数据库可读（只读打开）" : "未发现可读的已解密微信数据库；请提供解密副本或改用其它数据源",
        },
      });
    },
    stats: async () => {
      const v = loadAll();
      const perChat = v.sessions.map((s) => ({ chat: s.name, talker: s.name, messages: s.msg_count }));
      return envelope({
        tool: "sqlite-reader", command: "stats",
        data: {
          reader: "sqlite", sessions: v.sessions.length, contacts: 0,
          total_messages: v.sessions.reduce((a, s) => a + s.msg_count, 0),
          message_database_count: v.dbs.length,
          top_chats: perChat.sort((a, b) => b.messages - a.messages).slice(0, 20),
        },
      });
    },
    sessions: async ({ limit = 80, typeFilter } = {}) => {
      const v = loadAll();
      let rows = v.sessions;
      if (typeFilter) {
        const types = String(typeFilter).split(",").map((x) => x.trim());
        if (types.length) rows = rows.filter((s) => types.includes(s.kind));
      }
      return envelope({ tool: "sqlite-reader", command: "sessions", data: { sessions: rows.slice(0, limit).map((s) => ({ name: s.name, kind: s.kind, message_count: s.msg_count, first_ts: s.first_ts, last_ts: s.last_ts })) } });
    },
    resolveChat: async (name, { typeFilter } = {}) => {
      const v = loadAll();
      const q = String(name ?? "");
      const hits = v.sessions.filter((s) => s.name === q || s.name.includes(q));
      const filtered = typeFilter ? hits.filter((s) => s.kind === typeFilter) : hits;
      if (!filtered.length) return envelope({ tool: "sqlite-reader", command: "resolve-chat", ok: false, data: { candidates: [], state: "not_found" } });
      return envelope({ tool: "sqlite-reader", command: "resolve-chat", data: { chat: filtered[0].name, talker: filtered[0].name, kind: filtered[0].kind, ambiguous: filtered.length > 1, candidates: filtered.slice(0, 10).map((s) => s.name) } });
    },
    timeline: async (talker, { limit = 200, offset = 0, displayOrder = "asc", since, before } = {}) => {
      const v = loadAll();
      const s = v.sessions.find((x) => x.name === talker) ?? v.sessions.find((x) => x.name.includes(String(talker)));
      if (!s) return envelope({ tool: "sqlite-reader", command: "timeline", ok: false, data: { messages: [] } });
      let rows = sortByTime(s.messages, displayOrder === "asc" ? "asc" : "desc");
      if (since) { const t = Date.parse(since); if (!Number.isNaN(t)) rows = rows.filter((m) => (m.ts ?? 0) >= t); }
      if (before) { const t = Date.parse(before); if (!Number.isNaN(t)) rows = rows.filter((m) => (m.ts ?? 0) <= t); }
      const p = paginate(rows, { limit, offset });
      return envelope({ tool: "sqlite-reader", command: "timeline", data: { talker: s.name, chat: s.name, messages: p.rows, query: p.query } });
    },
    members: async (chatroomId, { limit = 500 } = {}) => {
      const v = loadAll();
      const s = v.sessions.find((x) => x.name === chatroomId) ?? v.sessions.find((x) => x.name.includes(String(chatroomId)));
      if (!s) return envelope({ tool: "sqlite-reader", command: "members", ok: false, data: { members: [] } });
      const seen = new Map();
      for (const m of s.messages) {
        if (!seen.has(m.sender)) seen.set(m.sender, { name: m.sender, id: m.sender_id, message_count: 0 });
        seen.get(m.sender).message_count += 1;
      }
      return envelope({ tool: "sqlite-reader", command: "members", data: { chat: s.name, members: [...seen.values()].slice(0, limit) } });
    },
    search: async (keyword, { limit = 100, offset = 0, maxTextChars = 240, inChat, after, before } = {}) => {
      const v = loadAll();
      const kws = String(keyword).split(",").map((x) => x.trim()).filter(Boolean);
      let rows = [];
      for (const s of v.sessions) {
        if (inChat && s.name !== inChat && !s.name.includes(inChat)) continue;
        for (const m of s.messages) {
          if (!matchKeywords(m.content, kws)) continue;
          if (after) { const t = Date.parse(after); if (!Number.isNaN(t) && (m.ts ?? 0) < t) continue; }
          if (before) { const t = Date.parse(before); if (!Number.isNaN(t) && (m.ts ?? 0) > t) continue; }
          rows.push(m);
        }
      }
      rows = sortByTime(rows, "desc");
      const p = paginate(rows, { limit, offset });
      return envelope({ tool: "sqlite-reader", command: "search", data: { keyword, messages: p.rows.map((m) => ({ ...m, content: m.content.slice(0, maxTextChars) })), query: p.query } });
    },
    sql: async ({ query, limit = 100 } = {}) => {
      const dbs = discover().filter((x) => x.ok);
      if (!dbs.length) return envelope({ tool: "sqlite-reader", command: "sql", ok: false, data: { rows: [], error: "无可用数据库" } });
      const db = openRo(dbs[0].file);
      try {
        if (!/^\s*(select|with|pragma)\b/i.test(String(query ?? ""))) {
          return envelope({ tool: "sqlite-reader", command: "sql", ok: false, data: { rows: [], error: "仅允许只读 SELECT/WITH/PRAGMA" } });
        }
        const rows = db.prepare(String(query)).all().slice(0, limit);
        return envelope({ tool: "sqlite-reader", command: "sql", data: { rows, file: dbs[0].file } });
      } catch (e) {
        return envelope({ tool: "sqlite-reader", command: "sql", ok: false, data: { rows: [], error: String(e.message ?? e) } });
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    },
  };
}
