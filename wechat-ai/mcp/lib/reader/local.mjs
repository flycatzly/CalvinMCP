// local Reader：把已落到本地索引库的内容当作数据源（微信流 Inbox / scan / db-index 之后）
import { DatabaseSync } from "node:sqlite";
import { longPath, paths } from "../paths.mjs";
import { listSessions, messagesInWindow, searchMessages, storeStats, store } from "../store.mjs";
import { envelope, inferKind, matchKeywords, paginate, sortByTime, toReaderMessage } from "./common.mjs";

/** LIKE 通配符转义（%、_、\ 本身），配合 ESCAPE '\' 使用，避免会话名里的通配符扫全表 */
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => "\\" + c);
const safeJson = (s, dflt) => { try { return JSON.parse(s || "null") ?? dflt; } catch { return dflt; } };

export function createLocalReader() {
  const allMessages = () => {
    const rows = messagesInWindow({ sinceMs: 0, untilMs: Date.now() + 86400000, limit: 2_000_000 });
    return rows.map((m) => toReaderMessage({
      chat: m.session_name, sender: m.sender, sender_id: m.sender_id, ts: m.ts, content: m.content,
      links: m.links, media: m.attachments, is_owner: !!m.is_owner, id: m.id,
    }));
  };

  return {
    id: "local",
    kind: "local",
    describe: () => ({ reader: "local", ...storeStats() }),
    version: async () => envelope({ tool: "local-reader", command: "version", data: { version: "1.0.0", reader: "local", protocol: "wechat-reader/1" } }),
    status: async () => {
      const s = storeStats();
      const state = s.messages > 0 ? "ready" : "needs_access";
      return envelope({
        tool: "local-reader", command: "status",
        data: {
          state, reader: "local", message_count: s.messages, session_count: s.sessions, contact_count: s.contacts,
          last_message_ts: s.lastMessageTs, last_index_ts: s.lastIndexTs,
          detail: state === "ready" ? "本地索引可读" : "本地索引为空：请先扫描导出目录、导入 Inbox 或接入外部读取器",
        },
      });
    },
    sessions: async ({ limit = 80, typeFilter } = {}) => {
      const kinds = typeFilter ? String(typeFilter).split(",").map((x) => x.trim()) : null;
      const rows = listSessions({ limit: Math.max(limit, 2000) }).filter((s) => !kinds || kinds.includes(s.kind));
      return envelope({ tool: "local-reader", command: "sessions", data: { sessions: rows.slice(0, limit).map((s) => ({ name: s.name, kind: s.kind, message_count: s.msg_count, first_ts: s.first_ts, last_ts: s.last_ts, labels: s.labels })) } });
    },
    stats: async () => {
      const s = storeStats();
      const perChat = listSessions({ limit: 20 }).map((r) => ({ chat: r.name, talker: r.name, messages: r.msg_count }));
      return envelope({
        tool: "local-reader", command: "stats",
        data: {
          reader: "local", sessions: s.sessions, contacts: s.contacts, total_messages: s.messages,
          top_chats: perChat,
        },
      });
    },
    resolveChat: async (name, { typeFilter } = {}) => {
      const q = String(name ?? "");
      const rows = listSessions({ limit: 5000 });
      const exact = rows.filter((s) => s.name === q);
      const partial = rows.filter((s) => s.name !== q && s.name.includes(q));
      let hits = [...exact, ...partial];
      if (typeFilter) hits = hits.filter((s) => s.kind === typeFilter);
      if (!hits.length) return envelope({ tool: "local-reader", command: "resolve-chat", ok: false, data: { state: "not_found", candidates: [] } });
      return envelope({ tool: "local-reader", command: "resolve-chat", data: { chat: hits[0].name, talker: hits[0].name, kind: hits[0].kind, ambiguous: hits.length > 1, candidates: hits.slice(0, 10).map((s) => s.name) } });
    },
    timeline: async (talker, { limit = 200, offset = 0, displayOrder = "asc", since, before } = {}) => {
      const name = String(talker);
      // 精确匹配优先；无精确命中才退回子串匹配（并转义通配符，避免 %/_ 拉全表）
      const db = store();
      let hit = db.prepare("SELECT * FROM messages WHERE session_name = ? ORDER BY ts ASC LIMIT 500000").all(name);
      let ambiguous = false;
      if (!hit.length) {
        hit = db.prepare("SELECT * FROM messages WHERE session_name LIKE ? ESCAPE '\\' ORDER BY ts ASC LIMIT 500000")
          .all(`%${likeEscape(name)}%`);
        ambiguous = new Set(hit.map((m) => m.session_name)).size > 1;
      }
      const rows = hit.map((m) => toReaderMessage({
        chat: m.session_name, sender: m.sender, sender_id: m.sender_id, ts: m.ts, content: m.content,
        links: safeJson(m.links, []), media: safeJson(m.attachments, []), is_owner: !!m.is_owner, id: m.id,
      }));
      let list = sortByTime(rows, displayOrder === "desc" ? "desc" : "asc");
      if (since) { const t = Date.parse(since); if (!Number.isNaN(t)) list = list.filter((m) => (m.ts ?? 0) >= t); }
      if (before) { const t = Date.parse(before); if (!Number.isNaN(t)) list = list.filter((m) => (m.ts ?? 0) <= t); }
      const p = paginate(list, { limit, offset });
      return envelope({ tool: "local-reader", command: "timeline", data: { talker, chat: talker, messages: p.rows, query: p.query, ambiguous: ambiguous || undefined } });
    },
    members: async (chatroomId, { limit = 500 } = {}) => {
      const name = String(chatroomId);
      const db = store();
      const exact = db.prepare("SELECT sender, sender_id, COUNT(*) n FROM messages WHERE session_name = ? GROUP BY sender ORDER BY n DESC LIMIT ?")
        .all(name, limit);
      const rows = exact.length
        ? exact
        : db.prepare("SELECT sender, sender_id, COUNT(*) n FROM messages WHERE session_name LIKE ? ESCAPE '\\' GROUP BY sender ORDER BY n DESC LIMIT ?")
            .all(`%${likeEscape(name)}%`, limit);
      return envelope({ tool: "local-reader", command: "members", data: { chat: chatroomId, members: rows.map((r) => ({ name: r.sender, id: r.sender_id, message_count: r.n })) } });
    },
    search: async (keyword, { limit = 100, offset = 0, maxTextChars = 240, inChat, after, before, since, until } = {}) => {
      const kws = String(keyword).split(",").map((x) => x.trim()).filter(Boolean);
      const rows = searchMessages({
        keywords: kws, chat: inChat,
        sinceMs: after ? Date.parse(after) : since ? Date.parse(since) : undefined,
        untilMs: before ? Date.parse(before) : until ? Date.parse(until) : undefined,
        limit: 200000,
      });
      const mapped = rows.map((m) => toReaderMessage({ chat: m.session_name, sender: m.sender, ts: m.ts, content: m.content, links: m.links, id: m.id, is_owner: !!m.is_owner }));
      const p = paginate(mapped, { limit, offset });
      return envelope({ tool: "local-reader", command: "search", data: { keyword, messages: p.rows.map((m) => ({ ...m, content: m.content.slice(0, maxTextChars) })), query: p.query } });
    },
    sql: async ({ query, limit = 100 } = {}) => {
      const q = String(query ?? "").trim();
      if (!/^(select|with|pragma)\b/i.test(q)) {
        return envelope({ tool: "local-reader", command: "sql", ok: false, data: { rows: [], error: "仅允许只读 SELECT/WITH/PRAGMA" } });
      }
      // 拒绝多语句（末尾分号除外）：`WITH x AS (...) DELETE ...` 这类写语句必须挡在库外
      if (q.replace(/;\s*$/, "").includes(";")) {
        return envelope({ tool: "local-reader", command: "sql", ok: false, data: { rows: [], error: "不允许多语句" } });
      }
      let ro = null;
      try {
        // 独立的只读句柄 + query_only：即使白名单被绕过，SQLite 层也拒绝写入
        ro = new DatabaseSync(longPath(paths().store), { readOnly: true });
        try { ro.exec("PRAGMA query_only=ON"); } catch { /* 只读句柄上可能不支持，忽略 */ }
        const rows = ro.prepare(q).all().slice(0, limit);
        return envelope({ tool: "local-reader", command: "sql", data: { rows } });
      } catch (e) {
        return envelope({ tool: "local-reader", command: "sql", ok: false, data: { rows: [], error: String(e.message ?? e) } });
      } finally {
        try { ro?.close(); } catch { /* ignore */ }
      }
    },
    _allMessages: allMessages,
  };
}

export { matchKeywords, inferKind };
