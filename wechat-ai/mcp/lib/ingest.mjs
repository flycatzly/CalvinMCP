// 采集与索引：文件扫描 / Inbox 落库 / 从 Reader 拉取建索引
import fs from "node:fs";
import path from "node:path";
import { ensureHome, paths } from "./paths.mjs";
import { parseAny, parseJsonChat } from "./parse.mjs";
import { addLink, applyContactDelta, insertMessages, kvSet, normalizeMessage, recalcSessionCounts, rebuildContactStats, tx, store } from "./store.mjs";
import { extractUrls, fmtDay, inferKindSafe, isHeatLink, normalizeUrl, sha1, writeJson } from "./util.mjs";
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
  const baseTs = Date.now(); // 仅用于缺时间戳消息的兜底时间
  const idSeen = new Map(); // 缺时间戳的同内容消息按批内出现序号区分，避免被 INSERT OR IGNORE 塌缩成一条
  for (let i = 0; i < msgs.length; i++) {
    const raw = msgs[i];
    const chat = raw.session_name ?? raw.chat ?? "未知会话";
    const kind = raw.session_kind ?? inferKindSafe(chat);
    const canonical = rowToCanonical({ ...raw, ts: raw.ts ?? 0 }, { chat, source, kind });
    const m = normalizeMessage(canonical, { source, runId });
    if (!m.ts) {
      // 无时间戳时 id 已按 ts=0 算出（重扫同一文件仍幂等）；同 id 的第 2 条起按出现序号改写 id，
      // 避免 K 条「同会话+同发送者+同内容」被 INSERT OR IGNORE 塌缩成 1 条
      const n = (idSeen.get(m.id) ?? 0) + 1;
      idSeen.set(m.id, n);
      if (n > 1) m.id = sha1(`${m.id} ${n}`).slice(0, 20);
      m.ts = baseTs + i;
      m.day = fmtDay(new Date(m.ts)); // 兜底时间戳也要带 day，否则按日统计漏掉这些行
    }
    m._links = canonical.links; // 仅供 buildLinks 使用，不落库
    prepared.push(m);
    if (!sessMap.has(chat)) sessMap.set(chat, { name: chat, kind, msgs: [] });
    sessMap.get(chat).msgs.push(m);
  }
  const normSet = new Set();
  let res;
  tx(db, () => {
    // insertMessages 内部已按批 upsert 会话行（first_ts/last_ts/名字），这里不再重复写；
    // 统计重算与联系人增量也收进同一事务：一次 ingestMessages 只提交一次
    res = insertMessages(db, prepared, { source, runId, skipSessionRecalc: true });
    // 清理早期版本写入的逐字符脏数据（一次性迁移：buildLinks 的过滤保证不会再产生这类行）
    if (!_linksCleaned) {
      try { db.exec("DELETE FROM links WHERE length(norm) < 8 AND norm NOT LIKE 'http%'"); _linksCleaned = true; } catch { /* ignore */ }
    }
    for (const m of prepared) buildLinks(db, m, normSet);
    if (!deferStats) {
      // 只重算本次涉及的会话与发送者（全量重算会让逐会话索引退化成 O(n^2)）
      recalcSessionCounts(db, prepared.map((p) => p.session_id));
      // 联系人统计按本次真正落库的行增量累加，不重扫发送者全量历史
      applyContactDelta(db, res.senderStats);
    }
  });
  return { ...res, sessions: sessMap.size, links: normSet.size, sessionIds: prepared.map((p) => p.session_id), senders: prepared.map((p) => p.sender) };
}

/**
 * 批量索引的收尾：把逐会话调用攒下来的会话 id 一次性重算、联系人增量一次性落账。
 * 之前收尾走 rebuildContactStats 逐发送者重扫全量历史（O(发送者×历史)），
 * 现在直接合并各批 insertMessages 收集的 senderStats 增量（纯 upsert，零扫描）。
 */
export function flushIngestStats(db, batches = []) {
  const sessionIds = new Set();
  const senders = new Set();
  const deltas = new Map(); // sender -> {n,f,l}
  for (const b of batches) {
    for (const id of b?.sessionIds ?? []) sessionIds.add(id);
    for (const s of b?.senders ?? []) senders.add(s);
    if (b?.senderStats) {
      for (const [name, d] of b.senderStats) {
        if (!d || !d.n) continue;
        const cur = deltas.get(name);
        if (!cur) deltas.set(name, { n: d.n, f: d.f, l: d.l });
        else { cur.n += d.n; if (d.f < cur.f) cur.f = d.f; if (d.l > cur.l) cur.l = d.l; }
      }
    }
  }
  if (sessionIds.size) recalcSessionCounts(db, [...sessionIds]);
  if (deltas.size) applyContactDelta(db, deltas);
  else if (senders.size) rebuildContactStats(db, [...senders]); // 兼容不带增量信息的旧调用方
  return { sessions: sessionIds.size, senders: Math.max(senders.size, deltas.size) };
}

/**
 * 攒批写入器：把「逐批一次 ingestMessages」收进「每 chunkSize 批一个外层事务」，
 * 统计由 finish() 里的 flushIngestStats 一次收尾。tx 可重入（见 tests 的「嵌套事务
 * 可重入」），内层 ingestMessages 的 BEGIN/COMMIT 退化为直执行，N 次提交收敛为
 * ceil(N/chunkSize) 次。写入幂等（确定性 id + INSERT OR IGNORE），失败后重跑即可补齐。
 * 事务语义：批内原子——同批任一消息批写入抛错则整批回滚、错误上抛（已提交批次保留），
 * 不吞错继续写，避免批内半成品落库。
 * 实测量级（600 会话/3 万条）：每会话一事务 + 即时统计 1607ms，单事务对照 385ms。
 * chunkSize 默认 100：调参实测（4000 会话/20 万条中位数）20→1246ms、100→637ms、500→519ms
 * （单事务地板 478ms）——100 已近地板，再大只省一成多而批内驻留内存线性上涨。
 *
 * add() 逐批喂入（调用方取数可以是异步的，如 indexFromReader 逐页拉取）；
 * finish() 收尾并返回 { sessions, chunks, inserted, stats, results }，
 * results 与 add() 顺序同序，供调用方做逐项记账（scanPath 的 perFile、search 的关键词）。
 */
export function sessionBatchWriter(db, { source = "vault", runId = null, chunkSize = 100 } = {}) {
  const size = Math.max(1, Math.min(500, Number(chunkSize) || 100));
  const pending = [];
  let chunks = 0;
  let inserted = 0;
  let sessions = 0;
  let chunk = [];
  const flushChunk = () => {
    if (!chunk.length) return;
    const items = chunk;
    chunk = [];
    tx(db, () => {
      for (const msgs of items) {
        const res = ingestMessages(db, msgs, { source, runId, deferStats: true });
        pending.push(res);
        inserted += res.inserted;
      }
    });
    chunks += 1;
    sessions += items.length;
  };
  return {
    add(msgs) {
      chunk.push(msgs);
      if (chunk.length >= size) flushChunk();
    },
    finish() {
      flushChunk();
      const stats = flushIngestStats(db, pending);
      return { sessions, chunks, inserted, stats, results: pending };
    },
  };
}

/** 同步批式外壳：入参可为「消息数组的数组」或任意可迭代对象（生成器边解析边写，内存有界） */
export function ingestSessionBatches(db, sessionMsgs, opts = {}) {
  const writer = sessionBatchWriter(db, opts);
  for (const msgs of sessionMsgs) writer.add(msgs);
  return writer.finish();
}

/** 扫描文件/目录并落库 */
export function scanPath(target, { source = "scan", runId = null, out = null } = {}) {
  ensureHome();
  // 路径不存在必须报错：静默返回 files:0 会让用户以为扫描成功（真实测试发现的缺陷）
  if (!fs.existsSync(target)) throw new Error("扫描目标不存在：" + target);
  const files = collectFiles(target);
  const db = store();
  const perFile = [];
  // 生成器逐文件懒解析，攒批事务每 100 个文件一提交（sessionBatchWriter 默认 chunkSize；旧的逐文件一事务提交成本随文件数增长，
  // 同量级实测每会话一事务 1607ms vs 攒批 569ms）；内存最多驻留一个批次的解析结果。
  function* parseFiles() {
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      const base = path.basename(file, path.extname(file));
      const parsed = file.endsWith(".json") ? (() => { try { return parseJsonChat(JSON.parse(raw), { defaultChat: base }); } catch { return parseAny(raw, { defaultChat: base }); } })() : parseAny(raw, { defaultChat: base });
      const chat = parsed.chat || base;
      const msgs = parsed.messages.map((m) => ({ ...m, chat, session_name: m.chat ?? chat }));
      perFile.push({ file, chat, format: parsed.format, messages: msgs.length, inserted: 0 });
      yield msgs;
    }
  }
  const write = ingestSessionBatches(db, parseFiles(), { source, runId });
  for (let i = 0; i < perFile.length; i++) perFile[i].inserted = write.results[i].inserted;
  kvSet("last_index_ts", Date.now());
  kvSet("last_index_source", "scan"); // 通道事实（F7）：scan 通道也要盖章，否则通道值永远停在最后一次 reader 索引
  const summary = { target, files: files.length, inserted: write.inserted, perFile };
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
  kvSet("last_index_source", "inbox"); // 通道事实（F7）：与 scan 同款盖章；消息级来源另存 messages.source
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
  // 攒批写入：一次 ingestMessages 一个事务时，提交本身占了大头（实测单事务可快 2.5 倍）。
  // 取数是异步的（逐页拉取），用 sessionBatchWriter 逐页 add、末尾 finish 一次收尾，
  // 与 scanPath/wai_vault_scan 共用同一套攒批+统计逻辑（不再各自维护 flushChunk）。
  const writer = sessionBatchWriter(db, { source: `reader:${sourceId}`, runId, chunkSize: 100 });
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
      writer.add(msgs.map((m) => ({ ...m, chat: m.chat })));
      report.sessions.push({ keyword: kw, messages: msgs.length, inserted: 0 });
      report.totals.messages += msgs.length;
    }
    const write = writer.finish();
    for (let i = 0; i < report.sessions.length; i++) report.sessions[i].inserted = write.results[i].inserted;
    report.totals.sessions = report.sessions.length;
    report.totals.inserted = write.inserted;
    report.stats = write.stats;
    kvSet("last_index_ts", Date.now());
    kvSet("last_index_source", String(sourceId)); // search 早退分支此前漏盖通道章（F7）
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
    for (let page = 0; page < 20; page++) {
      const limit = Math.min(perChatLimit, 500);
      const t = await reader.timeline(name, { limit, offset, displayOrder: "asc" });
      const rows = t.data?.messages ?? [];
      if (!rows.length) break;
      const msgs = rows.map((m) => toReaderMessage(m, { chat: name }));
      const filtered = msgs.filter((m) => (sinceMs === undefined || (m.ts ?? 0) >= sinceMs) && (untilMs === undefined || (m.ts ?? 0) <= untilMs));
      if (filtered.length) writer.add(filtered.map((m) => ({ ...m, chat: name })));
      fetched += rows.length;
      if (!t.data?.query?.has_more) break;
      offset = t.data.query.next_offset ?? offset + rows.length;
      if (rows.length < limit) break; // 本页没取满（对照实际请求的 limit，而非写死的 50）
    }
    report.sessions.push({ name, fetched });
    report.totals.messages += fetched;
  }
  const write = writer.finish();
  report.totals.sessions = report.sessions.length;
  report.totals.inserted = write.inserted;
  report.stats = write.stats;
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
  const channel = db.prepare("SELECT v FROM kv WHERE k='last_index_source'").get()?.v ?? null;
  const ageHours = last.ts ? (Date.now() - last.ts) / 3600_000 : null;
  const indexAgeHours = lastIndex ? (Date.now() - lastIndex) / 3600_000 : null;
  // source = 语料真实来源口径：messages.source 按量主来源（sources 给全量构成）。
  // 旧实现读 kv last_index_source——那是"最后一次走的索引通道"，而 pickReader 自动档
  // 只要 vault 目录存在就偏好 vault，真机出现过 0 条 vault 语料却标 source=vault。
  // 通道事实保留为 last_index_channel，两种口径各归其位（F7）。
  const comp = db.prepare("SELECT source, COUNT(*) n FROM messages GROUP BY source ORDER BY n DESC, source ASC").all();
  const sources = {};
  for (const r of comp) sources[String(r.source ?? "unknown")] = Number(r.n);
  return {
    messages: last.n,
    last_message_ts: last.ts || null,
    last_message_at: last.ts ? new Date(last.ts).toISOString() : null,
    data_age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    last_index_ts: lastIndex || null,
    index_age_hours: indexAgeHours === null ? null : Math.round(indexAgeHours * 10) / 10,
    fresh: ageHours !== null && ageHours <= 24,
    source: comp.length ? String(comp[0].source ?? "unknown") : null,
    sources,
    last_index_channel: channel,
  };
}

export { getSource };
