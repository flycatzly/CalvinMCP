// vault Reader：把本机导出的聊天文件（txt/md/json/jsonl/csv）当作只读微信数据源
import fs from "node:fs";
import path from "node:path";
import { ensureHome, paths } from "../paths.mjs";
import { minMax, readJson, sha1, writeJson } from "../util.mjs";
import { parseAny, parseJsonChat } from "../parse.mjs";
import { envelope, fail, inferKind, matchKeywords, paginate, sortByTime, toReaderMessage } from "./common.mjs";

const TEXT_EXT = new Set([".txt", ".md", ".log", ".text"]);
const JSON_EXT = new Set([".json", ".jsonl", ".ndjson"]);
const CSV_EXT = new Set([".csv"]);

function cacheFile() {
  return path.join(paths().cache, "vault-cache.json");
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (/^(\.|node_modules$|__pycache__$)/.test(it.name)) continue;
      walk(full, out, depth + 1);
    } else {
      const ext = path.extname(it.name).toLowerCase();
      if (TEXT_EXT.has(ext) || JSON_EXT.has(ext) || CSV_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

function parseCsv(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const head = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const o = {};
    head.forEach((h, idx) => { o[h] = cells[idx] ?? ""; });
    rows.push(o);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseFile(file) {
  const ext = path.extname(file).toLowerCase();
  const raw = fs.readFileSync(file, "utf8");
  const base = path.basename(file, ext);
  if (JSON_EXT.has(ext)) {
    if (ext === ".jsonl" || ext === ".ndjson") {
      const rows = [];
      for (const line of raw.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        try { rows.push(JSON.parse(s)); } catch { /* skip bad line */ }
      }
      return rows.length && rows[0]?.content !== undefined
        ? { chat: rows[0].chat ?? base, rows }
        : { chat: base, rows: parseJsonChat(rows, { defaultChat: base }).messages };
    }
    let obj = null;
    try { obj = JSON.parse(raw); } catch { return { chat: base, rows: parseAny(raw, { defaultChat: base }).messages }; }
    const parsed = parseJsonChat(obj, { defaultChat: base });
    return { chat: parsed.chat || base, rows: parsed.messages };
  }
  if (CSV_EXT.has(ext)) {
    const rows = parseCsv(raw);
    if (rows.length && ("content" in rows[0] || "内容" in rows[0])) {
      return { chat: rows[0].chat ?? rows[0].会话 ?? base, rows };
    }
    return { chat: base, rows: parseAny(raw, { defaultChat: base }).messages };
  }
  const parsed = parseAny(raw, { defaultChat: base });
  return { chat: parsed.chat || base, rows: parsed.messages };
}

/** 建立/复用解析缓存 */
export function loadVault({ dirs, force = false } = {}) {
  ensureHome();
  const roots = (dirs && dirs.length ? dirs : [paths().vault]).filter((d) => d && fs.existsSync(d));
  const files = roots.flatMap((d) => walk(d));
  const cache = force ? {} : readJson(cacheFile(), {});
  const next = {};
  const sessions = new Map();
  let parsedCount = 0;
  let cacheHits = 0;

  for (const file of files) {
    let st = null;
    try { st = fs.statSync(file); } catch { continue; }
    const key = sha1(file);
    const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
    let rec = cache[key];
    if (!rec || rec.stamp !== stamp) {
      try {
        const p = parseFile(file);
        rec = { stamp, file, chat: p.chat, rows: p.rows };
      } catch (e) {
        rec = { stamp, file, chat: path.basename(file), rows: [], error: String(e.message ?? e) };
      }
      parsedCount += 1;
    } else {
      cacheHits += 1;
    }
    next[key] = rec;
    for (const r of rec.rows) {
      const chat = String(r.chat ?? rec.chat ?? path.basename(file, path.extname(file)));
      if (!sessions.has(chat)) sessions.set(chat, { name: chat, kind: inferKind(chat), messages: [], files: new Set() });
      const s = sessions.get(chat);
      s.files.add(file);
      s.messages.push(toReaderMessage({ ...r, chat }, { chat }));
    }
  }
  writeJson(cacheFile(), next);
  const list = [...sessions.values()].map((s) => {
    const ts = s.messages.map((m) => m.ts).filter(Boolean);
    const { min, max } = minMax(ts);
    return {
      ...s,
      files: [...s.files],
      msg_count: s.messages.length,
      first_ts: min,
      last_ts: max,
    };
  }).sort((a, b) => (b.last_ts ?? 0) - (a.last_ts ?? 0));
  return { sessions: list, files: files.length, parsedCount, cacheHits, roots };
}

export function createVaultReader({ dirs, force = false } = {}) {
  let cached = null;
  const get = () => {
    if (!cached || force) cached = loadVault({ dirs, force });
    return cached;
  };
  return {
    id: "vault",
    kind: "vault",
    describe: () => {
      const v = get();
      return { reader: "vault", roots: v.roots, files: v.files, sessions: v.sessions.length, parsed: v.parsedCount, cache_hits: v.cacheHits };
    },
    version: async () => envelope({ tool: "vault-reader", command: "version", data: { version: "1.0.0", reader: "vault", protocol: "wechat-reader/1" } }),
    status: async () => {
      const v = get();
      const state = v.files === 0 ? "needs_access" : v.sessions.length === 0 ? "ready_to_configure" : "ready";
      return envelope({
        tool: "vault-reader", command: "status",
        data: {
          state, reader: "vault", decrypted_dir: v.roots.join(";"), message_count: v.sessions.reduce((a, s) => a + s.msg_count, 0),
          session_count: v.sessions.length, source_files: v.files, detail: state === "ready" ? "本地导出目录可读" : "未发现可读聊天文件",
        },
      });
    },
    sessions: async ({ limit = 80, typeFilter } = {}) => {
      const v = get();
      let rows = v.sessions;
      if (typeFilter) {
        const types = String(typeFilter).split(",").map((x) => x.trim()).filter(Boolean);
        if (types.length) rows = rows.filter((s) => types.includes(s.kind));
      }
      rows = rows.slice(0, limit);
      return envelope({ tool: "vault-reader", command: "sessions", data: { sessions: rows.map((s) => ({ name: s.name, kind: s.kind, message_count: s.msg_count, first_ts: s.first_ts, last_ts: s.last_ts })) } });
    },
    resolveChat: async (name, { typeFilter } = {}) => {
      const v = get();
      const q = String(name ?? "").trim();
      const hits = v.sessions.filter((s) => s.name === q)
        .concat(v.sessions.filter((s) => s.name !== q && s.name.includes(q)));
      const filtered = typeFilter ? hits.filter((s) => String(s.kind) === String(typeFilter) || String(typeFilter).includes(s.kind)) : hits;
      if (!filtered.length) return envelope({ tool: "vault-reader", command: "resolve-chat", ok: false, data: { candidates: v.sessions.filter((s) => s.name.includes(q)).map((s) => s.name), state: "not_found" } });
      return envelope({ tool: "vault-reader", command: "resolve-chat", data: { chat: filtered[0].name, talker: filtered[0].name, kind: filtered[0].kind, ambiguous: filtered.length > 1, candidates: filtered.slice(0, 10).map((s) => s.name) } });
    },
    timeline: async (talker, { limit = 200, offset = 0, displayOrder = "asc", since, before, includeMediaPaths = false } = {}) => {
      const v = get();
      const s = v.sessions.find((x) => x.name === talker) ?? v.sessions.find((x) => x.name.includes(String(talker)));
      if (!s) return envelope({ tool: "vault-reader", command: "timeline", ok: false, data: { messages: [], state: "not_found" } });
      let rows = sortByTime(s.messages, displayOrder === "asc" ? "asc" : "desc");
      if (since) { const t = Date.parse(since); if (!Number.isNaN(t)) rows = rows.filter((m) => (m.ts ?? 0) >= t); }
      if (before) { const t = Date.parse(before); if (!Number.isNaN(t)) rows = rows.filter((m) => (m.ts ?? 0) <= t); }
      const p = paginate(rows, { limit, offset });
      return envelope({
        tool: "vault-reader", command: "timeline",
        data: {
          talker: s.name, chat: s.name, messages: p.rows.map((m) => (includeMediaPaths ? m : { ...m, media: m.media })),
          query: p.query,
        },
      });
    },
    members: async (chatroomId, { limit = 500 } = {}) => {
      const v = get();
      const s = v.sessions.find((x) => x.name === chatroomId) ?? v.sessions.find((x) => x.name.includes(String(chatroomId)));
      if (!s) return envelope({ tool: "vault-reader", command: "members", ok: false, data: { members: [] } });
      const seen = new Map();
      for (const m of s.messages) {
        if (!seen.has(m.sender)) seen.set(m.sender, { name: m.sender, id: m.sender_id, message_count: 0 });
        seen.get(m.sender).message_count += 1;
      }
      return envelope({ tool: "vault-reader", command: "members", data: { chat: s.name, members: [...seen.values()].sort((a, b) => b.message_count - a.message_count).slice(0, limit) } });
    },
    search: async (keyword, { limit = 100, offset = 0, maxTextChars = 240, inChat, after, before } = {}) => {
      const v = get();
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
      return envelope({
        tool: "vault-reader", command: "search",
        data: { keyword, messages: p.rows.map((m) => ({ ...m, content: m.content.slice(0, maxTextChars) })), query: p.query },
      });
    },
    sql: async ({ query, limit = 100 } = {}) => envelope({ tool: "vault-reader", command: "sql", ok: false, data: { rows: [], error: "vault reader 不支持 sql" } }),
    stats: async () => {
      const v = get();
      const perChat = v.sessions.map((s) => ({ chat: s.name, talker: s.name, messages: s.msg_count }));
      return envelope({
        tool: "vault-reader", command: "stats",
        data: {
          reader: "vault", sessions: v.sessions.length, contacts: 0,
          total_messages: v.sessions.reduce((a, s) => a + s.msg_count, 0),
          source_files: v.files, parsed: v.parsedCount, cache_hits: v.cacheHits,
          top_chats: perChat.sort((a, b) => b.messages - a.messages).slice(0, 20),
        },
      });
    },
  };
}
