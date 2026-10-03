// 采集与索引：文件扫描 / Inbox 落库 / 从 Reader 拉取建索引
import fs from "node:fs";
import path from "node:path";
import { ensureHome, paths } from "./paths.mjs";
import { parseAny, parseJsonChat } from "./parse.mjs";
import { addLink, applyContactDelta, insertMessages, kvSet, normalizeMessage, recalcSessionCounts, rebuildContactStats, rowToSession, sessionId, tx, upsertSession, store } from "./store.mjs";
import { extractUrls, inferKindSafe, isHeatLink, normalizeUrl, sha1, writeJson } from "./util.mjs";
import { inboxClaim, inboxComplete, inboxFail, inboxFiles, inboxGet } from "./inbox.mjs";
import { isOwnerName } from "./profile.mjs";

/** 链接脏数据清理只做一次（迁移性质，见 ingestMessages 里的调用） */
let _linksCleaned = false;
import { pickReader, getSource } from "./reader/index.mjs";
import { toReaderMessage } from "./reader/common.mjs";

const TEXT_EXT = new Set([".txt", ".md", ".log", ".text", ".json", ".jsonl", ".ndjson", ".csv"]);

/** 递归收集可解析文件 */
export function collectFiles(target) {
  const out = [];
  const st = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!st) return out;
  if (st.isFile()) return TEXT_EXT.has(path.extname(target).toLowerCase()) ? [target] : [];
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (/^(\.|node_modules$|__pycache__$)/.test(it.name)) continue;
        walk(full, depth + 1);
      } else if (TEXT_EXT.has(path.extname(it.name).toLowerCase())) out.push(full);
    }
  };
  walk(target);
  return out;
}

function buildLinks(db, m, normSet) {
  // 注意：normalizeMessage 之后 m.links 已经是 JSON 字符串，直接 for...of 会逐字符迭代。
  // 因此这里只认规范化之前挂在 _links 上的真实数组。
  const list = Array.isArray(m._links) ? m._links : [];
  for (const raw of list) {
    const url = String(raw ?? "").trim();
    if (!/^https?:\/\//i.test(url)) continue; // 只收录真正的 URL，避免脏数据
    const norm = normalizeUrl(url);
    if (norm.length < 8) continue;
    addLink(db, { url, norm, session_id: m.session_id, session_name: m.session_name, sender: m.sender, ts: m.ts, msg_id: m.id, heat: isHeatLink(url) ? 1 : 0, context: String(m.content ?? "").slice(0, 200) });
    normSet.add(norm);
  }
}

function rowToCanonical(m, { chat, source, kind }) {
  const sender = m.sender ?? "未知";
  const links = (m.links?.length ? m.links : extractUrls(m.content)).map(String);
  return {
    session_name: chat,
    session_kind: kind ?? inferKindSafe(chat),
    sender,
    sender_id: m.sender_id ?? null,
    is_owner: m.is_owner ?? isOwnerName(sender),
    ts: m.ts ?? 0,
    content: m.content ?? "",
    links,
    attachments: m.attachments ?? m.media ?? [],
    source,
  };
}

/** 把一批规范化消息写入索引 */
export function ingestMessages(db, msgs, { source = "scan", runId = null, deferStats = false } = {}) {
  const prepared = [];
  const sessMap = new Map();
  for (const raw of msgs) {
    const chat = raw.session_name ?? raw.chat ?? "未知会话";
    const kind = raw.session_kind ?? inferKindSafe(chat);
    const canonical = rowToCanonical({ ...raw, ts: raw.ts ?? 0 }, { chat, source, kind });
    const m = normalizeMessage(canonical, { source, runId });
    if (!m.ts) m.ts = Date.now();
    m.day = m.day ?? null;
    m._links = canonical.links; // 仅供 buildLinks 使用，不落库
    prepared.push(m);
    if (!sessMap.has(chat)) sessMap.set(chat, { name: chat, kind, msgs: [] });
    sessMap.get(chat).msgs.push(m);
  }
  const normSet = new Set();
  let res;
  tx(db, () => {
    res = insertMessages(db, prepared, { source, runId, skipSessionRecalc: deferStats });
    // 清理早期版本写入的逐字符脏数据（一次性迁移：buildLinks 的过滤保证不会再产生这类行）
    if (!_linksCleaned) {
      try { db.exec("DELETE FROM links WHERE length(norm) < 8 AND norm NOT LIKE 'http%'"); _linksCleaned = true; } catch { /* ignore */ }
    }
    for (const [name, meta] of sessMap) {
      const ms = meta.msgs;
      const ts = ms.map((x) => x.ts);
      upsertSession(db, { id: sessionId(name, meta.kind), name, kind: meta.kind, is_group: meta.kind === "group", first_ts: Math.min(...ts), last_ts: Math.max(...ts), msg_count: ms.length, source });
    }
    for (const m of prepared) buildLinks(db, m, normSet);
  });
  // 只重算本次涉及的会话与发送者（全量重算会让逐会话索引退化成 O(n^2)）
  const sessionIds = prepared.map((p) => p.session_id);
  const senders = prepared.map((p) => p.sender);
  if (!deferStats) {
    recalcSessionCounts(db, sessionIds);
    // 联系人统计按本次真正落库的行增量累加，不重扫发送者全量历史（flushIngestStats 收尾仍精确重算）
    applyContactDelta(db, res.senderStats);
  }
  return { ...res, sessions: sessMap.size, links: normSet.size, sessionIds, senders };
}

/**
 * 批量索引的收尾：把逐会话调用攒下来的 id/sender 一次性重算。
 * 逐会话各开一次事务时，事务提交本身会成为主要开销（实测 600 个会话约 1800 次提交）。
 */
export function flushIngestStats(db, batches = []) {
  const sessionIds = new Set();
  const senders = new Set();
  for (const b of batches) {
    for (const id of b?.sessionIds ?? []) sessionIds.add(id);
    for (const s of b?.senders ?? []) senders.add(s);
  }
  if (sessionIds.size) recalcSessionCounts(db, [...sessionIds]);
  if (senders.size) rebuildContactStats(db, [...senders]);
  return { sessions: sessionIds.size, senders: senders.size };
}

/** 扫描文件/目录并落库 */
export function scanPath(target, { source = "scan", runId = null, out = null } = {}) {
  ensureHome();
  const files = collectFiles(target);
  const db = store();
  const perFile = [];
  const scanPending = [];
  let total = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const base = path.basename(file, path.extname(file));
    const parsed = file.endsWith(".json") ? (() => { try { return parseJsonChat(JSON.parse(raw), { defaultChat: base }); } catch { return parseAny(raw, { defaultChat: base }); } })() : parseAny(raw, { defaultChat: base });
    const chat = parsed.chat || base;
    const msgs = parsed.messages.map((m) => ({ ...m, chat, session_name: m.chat ?? chat }));
    const res = ingestMessages(db, msgs, { source, runId, deferStats: true });
    scanPending.push(res);
    perFile.push({ file, chat, format: parsed.format, messages: msgs.length, inserted: res.inserted });
    total += res.inserted;
  }
  flushIngestStats(db, scanPending);
  kvSet("last_index_ts", Date.now());
  const summary = { target, files: files.length, inserted: total, perFile };
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    writeJson(path.join(out, "scan-summary.json"), summary);
  }
  return summary;
}

/** 把 Inbox 中的 new 条目加工进索引 */
export function ingestInbox({ limit = 100, runId = null } = {}) {
  ensureHome();
  const db = store();
  const files = inboxFiles("new").slice(0, limit);
  const results = [];
  for (const f of files) {
    const entry = inboxClaim(f.id);
    if (!entry) { results.push({ id: f.id, ok: false, error: "claim failed" }); continue; }
    try {
      const msgs = (entry.messages ?? []).map((m) => ({ ...m, chat: m.chat ?? entry.chat, session_name: m.chat ?? entry.chat }));
      const res = msgs.length ? ingestMessages(db, msgs, { source: entry.source ?? "inbox", runId }) : { inserted: 0 };
      inboxComplete(f.id, { inserted: res.inserted, chat: entry.chat });
      results.push({ id: f.id, ok: true, chat: entry.chat, inserted: res.inserted });
    } catch (e) {
      inboxFail(f.id, e);
      results.push({ id: f.id, ok: false, error: String(e.message ?? e) });
    }
  }
  kvSet("last_index_ts", Date.now());
  return { processed: results.length, ok: results.filter((r) => r.ok).length, results };
}

/** 从 Reader 拉取建索引：scope = sessions | labels | search | all */
export async function indexFromReader({
  source, scope = "sessions", sinceMs, untilMs, sessionType = "private,group", sessionLimit = 80,
  perChatLimit = 500, keywords = [], label, out = null, runId = null, allowDemo = false,
} = {}) {
  ensureHome();
  const { reader, sourceId, reason } = pickReader({ source, allowDemo });
  if (!reader) throw new Error("没有可用的数据源");
  const db = store();
  const pending = []; // 批量索引：统计信息收集起来一次性重算
  // 攒批写入：一次 ingestMessages 一个事务时，提交本身占了大头（实测单事务可快 2.5 倍）
  const CHUNK = 20;
  let chunk = [];
  const flushChunk = () => {
    if (!chunk.length) return;
    const items = chunk;
    chunk = [];
    tx(db, () => {
      for (const it of items) pending.push(ingestMessages(db, it.msgs, { source: `reader:${sourceId}`, runId, deferStats: true }));
    });
  };
  const report = { source: sourceId, reason, scope, sessionType, sinceMs, untilMs, keywords, sessions: [], totals: { messages: 0, inserted: 0, sessions: 0, links: 0 } };

  let chatNames = [];
  if (scope === "labels" && label) {
    const labels = Array.isArray(label) ? label : [label];
    const rows = db.prepare(`SELECT DISTINCT c.name FROM contacts c JOIN contact_labels cl ON cl.contact_id=c.id WHERE cl.label IN (${labels.map(() => "?").join(",")})`).all(...labels);
    chatNames = rows.map((r) => r.name);
    if (!chatNames.length) {
      const sessions = await reader.sessions({ limit: sessionLimit, typeFilter: sessionType });
      chatNames = (sessions.data?.sessions ?? []).filter((s) => (s.labels ?? []).some((l) => labels.includes(l))).map((s) => s.name);
    }
  } else if (scope === "search") {
    for (const kw of keywords) {
      const r = await reader.search(kw, { limit: perChatLimit, after: sinceMs ? new Date(sinceMs).toISOString() : undefined, before: untilMs ? new Date(untilMs).toISOString() : undefined });
      const msgs = (r.data?.messages ?? []).map((m) => toReaderMessage(m, { chat: m.chat }));
      const res = ingestMessages(db, msgs.map((m) => ({ ...m, chat: m.chat })), { source: `reader:${sourceId}`, runId, deferStats: true });
      pending.push(res);
      report.sessions.push({ keyword: kw, messages: msgs.length, inserted: res.inserted });
      report.totals.messages += msgs.length;
      report.totals.inserted += res.inserted;
    }
    flushChunk();
    report.totals.sessions = report.sessions.length;
    report.totals.inserted = pending.reduce((a, b) => a + (b?.inserted ?? 0), 0);
    report.stats = flushIngestStats(db, pending);
    kvSet("last_index_ts", Date.now());
    const summary = { ...report, out };
    if (out) { fs.mkdirSync(out, { recursive: true }); writeJson(path.join(out, "index-summary.json"), summary); }
    return summary;
  } else {
    const sessions = await reader.sessions({ limit: sessionLimit, typeFilter: sessionType });
    chatNames = (sessions.data?.sessions ?? []).map((s) => s.name);
  }

  if (!chatNames.length) {
    const sessions = await reader.sessions({ limit: sessionLimit, typeFilter: sessionType });
    const list = sessions.data?.sessions ?? [];
    const filtered = sinceMs ? list.filter((s) => (s.last_ts ?? 0) >= sinceMs) : list;
    chatNames = (filtered.length ? filtered : list).map((s) => s.name);
  }

  for (const name of chatNames.slice(0, sessionLimit)) {
    let offset = 0;
    let fetched = 0;
    let inserted = 0;
    for (let page = 0; page < 20; page++) {
      const t = await reader.timeline(name, { limit: Math.min(perChatLimit, 500), offset, displayOrder: "asc" });
      const rows = t.data?.messages ?? [];
      if (!rows.length) break;
      const msgs = rows.map((m) => toReaderMessage(m, { chat: name }));
      const filtered = msgs.filter((m) => (sinceMs === undefined || (m.ts ?? 0) >= sinceMs) && (untilMs === undefined || (m.ts ?? 0) <= untilMs));
      if (filtered.length) {
        chunk.push({ msgs: filtered.map((m) => ({ ...m, chat: name })) });
        if (chunk.length >= CHUNK) flushChunk();
      }
      fetched += rows.length;
      if (!t.data?.query?.has_more) break;
      offset = t.data.query.next_offset ?? offset + rows.length;
      if (rows.length < 50) break;
    }
    report.sessions.push({ name, fetched });
    report.totals.messages += fetched;
  }
  flushChunk();
  report.totals.sessions = report.sessions.length;
  report.totals.inserted = pending.reduce((a, b) => a + (b?.inserted ?? 0), 0);
  report.stats = flushIngestStats(db, pending);
  kvSet("last_index_ts", Date.now());
  kvSet("last_index_source", String(sourceId));
  const st = await reader.status().catch(() => null);
  report.readerStatus = st?.data ?? null;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    writeJson(path.join(out, "index-summary.json"), report);
  }
  return report;
}

/** 刷新新鲜度（db-status 用） */
export function freshness() {
  const db = store();
  const last = db.prepare("SELECT MAX(ts) ts, COUNT(*) n FROM messages").get();
  const lastIndex = Number(db.prepare("SELECT v FROM kv WHERE k='last_index_ts'").get()?.v ?? 0);
  const ageHours = last.ts ? (Date.now() - last.ts) / 3600_000 : null;
  const indexAgeHours = lastIndex ? (Date.now() - lastIndex) / 3600_000 : null;
  return {
    messages: last.n,
    last_message_ts: last.ts || null,
    last_message_at: last.ts ? new Date(last.ts).toISOString() : null,
    data_age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    last_index_ts: lastIndex || null,
    index_age_hours: indexAgeHours === null ? null : Math.round(indexAgeHours * 10) / 10,
    fresh: ageHours !== null && ageHours <= 24,
    source: db.prepare("SELECT v FROM kv WHERE k='last_index_source'").get()?.v ?? null,
  };
}

export { getSource };
