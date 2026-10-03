// 微信流 Inbox：本机手动选择的内容 → 落盘 → 加工 → 投递。
// 目录状态机：new → processing → processed | failed
import fs from "node:fs";
import path from "node:path";
import { ensureHome, paths, timestampSlug } from "./paths.mjs";
import { addInboxEntry, listInbox, store, updateInbox } from "./store.mjs";
import { extractUrls, readJson, safeFileName, sha1, writeJson } from "./util.mjs";
import { parseAny } from "./parse.mjs";
import { isOwnerName } from "./profile.mjs";

export const INBOX_SCHEMA = "wechat-ai/inbox@1";

function entryFile(status, id) {
  const p = paths();
  const dir = p[`inbox${status[0].toUpperCase()}${status.slice(1)}`] ?? path.join(p.inbox, status);
  return path.join(dir, `${id}.json`);
}

function moveEntry(id, from, to, extra = null) {
  const src = entryFile(from, id);
  if (!fs.existsSync(src)) return null;
  const dst = entryFile(to, id);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const entry = { ...readJson(src, {}), ...(extra ?? {}), status: to };
  writeJson(dst, entry);
  try { fs.unlinkSync(src); } catch { /* ignore */ }
  if (to === "failed" && extra?.error) {
    writeJson(dst.replace(/\.json$/, ".error.json"), { id, error: String(extra.error), ts: Date.now() });
  }
  return entry;
}

/** 规范化入站载荷 */
export function normalizePayload(input = {}) {
  const body = String(input.body ?? input.text ?? input.content ?? "");
  const parsed = input.messages?.length
    ? { chat: input.chat ?? input.title ?? "微信内容", messages: input.messages.map((m) => ({ ...m, chat: m.chat ?? input.chat ?? input.title ?? "微信内容" })), format: "structured", title: input.title ?? null }
    : parseAny(body, { defaultChat: input.chat ?? input.title ?? "微信内容" });
  const messages = parsed.messages.map((m) => ({
    ...m,
    is_owner: m.is_owner ?? isOwnerName(m.sender),
    links: m.links?.length ? m.links : extractUrls(m.content),
    attachments: m.attachments ?? [],
  }));
  const tsList = messages.map((m) => m.ts).filter((x) => Number.isFinite(x));
  const files = (input.files ?? []).map((f) => (typeof f === "string" ? { path: f, name: path.basename(f) } : f));
  const hash = sha1([input.source ?? "manual", input.chat ?? "", input.title ?? "", body, JSON.stringify(messages.map((m) => [m.sender, m.content]))].join("\u0001"));
  return {
    schema: INBOX_SCHEMA,
    id: input.id ?? `${timestampSlug()}-${hash.slice(0, 8)}`,
    created_ts: input.created_ts ?? Date.now(),
    source: input.source ?? "manual",
    kind: input.kind ?? guessKind(input, messages),
    title: input.title ?? parsed.title ?? messages[0]?.chat ?? "微信内容",
    chat: input.chat ?? parsed.chat ?? messages[0]?.chat ?? "微信内容",
    scene: input.scene ?? null,
    target: input.target ?? null,
    body,
    messages,
    files,
    links: [...new Set(messages.flatMap((m) => m.links ?? []))],
    ts_min: tsList.length ? Math.min(...tsList) : null,
    ts_max: tsList.length ? Math.max(...tsList) : null,
    hash,
    meta: input.meta ?? {},
    status: "new",
  };
}

function guessKind(input, messages) {
  const urls = messages.flatMap((m) => m.links ?? []);
  if (/mp\.weixin\.qq\.com/.test(urls.join(" "))) return "article";
  if (input.kind) return input.kind;
  if (messages.length > 1) return "chat";
  if (urls.length) return "link";
  return "text";
}

/** 入库：写入 DB + new/ 目录文件 */
export function inboxAdd(input = {}) {
  ensureHome();
  const entry = normalizePayload(input);
  // 内容级去重：同 hash 已处理过则跳过
  const db = store();
  const dup = db.prepare("SELECT id,status FROM inbox_entries WHERE hash=?").get(entry.hash);
  if (dup && !input.force) {
    return { id: dup.id, duplicate: true, status: dup.status, entry: null };
  }
  addInboxEntry(db, {
    id: entry.id, created_ts: entry.created_ts, source: entry.source, kind: entry.kind,
    title: entry.title, body: entry.body, scene: entry.scene, target: entry.target,
    status: "new", files: entry.files, payload: { chat: entry.chat, meta: entry.meta, schema: entry.schema },
    hash: entry.hash, ts_min: entry.ts_min, ts_max: entry.ts_max,
  });
  writeJson(entryFile("new", entry.id), entry);
  return { id: entry.id, duplicate: false, status: "new", entry };
}

export function inboxGet(id) {
  for (const st of ["new", "processing", "processed", "failed"]) {
    const f = entryFile(st, id);
    if (fs.existsSync(f)) return { ...readJson(f, {}), status: st };
  }
  return null;
}

export function inboxClaim(id) {
  const entry = moveEntry(id, "new", "processing");
  if (!entry) return null;
  try { updateInbox(store(), id, { status: "processing" }); } catch { /* ignore */ }
  return entry;
}

export function inboxComplete(id, result = {}) {
  const entry = moveEntry(id, "processing", "processed", { result });
  try { updateInbox(store(), id, { status: "processed" }); } catch { /* ignore */ }
  return entry;
}

export function inboxFail(id, error) {
  const entry = moveEntry(id, "processing", "failed", { error: String(error?.message ?? error) });
  try { updateInbox(store(), id, { status: "failed" }); } catch { /* ignore */ }
  return entry;
}

/** 列出目录中的条目（按状态） */
export function inboxFiles(status = "new") {
  const p = paths();
  const dir = p[`inbox${status[0].toUpperCase()}${status.slice(1)}`] ?? path.join(p.inbox, status);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".error.json"))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      const entry = readJson(full, {});
      return { id: f.replace(/\.json$/, ""), file: full, bytes: st.size, mtime: st.mtimeMs, title: entry.title, kind: entry.kind, source: entry.source, created_ts: entry.created_ts };
    })
    .sort((a, b) => a.mtime - b.mtime);
}

/** 汇总统计 */
export function inboxStats() {
  const db = store();
  const counts = db.prepare("SELECT status, COUNT(*) n FROM inbox_entries GROUP BY status").all();
  return {
    home: paths().home,
    dirs: { new: inboxFiles("new").length, processing: inboxFiles("processing").length, processed: inboxFiles("processed").length, failed: inboxFiles("failed").length },
    db: Object.fromEntries(counts.map((r) => [r.status, r.n])),
  };
}

/** 维护：清理过期的 processed/failed 条目 */
export function inboxMaintain({ days = 30, apply = false } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const plan = [];
  for (const st of ["processed", "failed"]) {
    for (const f of inboxFiles(st)) {
      if (f.mtime < cutoff) plan.push({ id: f.id, status: st, file: f.file, mtime: f.mtime });
    }
  }
  if (apply) {
    for (const it of plan) {
      try { fs.unlinkSync(it.file); } catch { /* ignore */ }
      try { fs.unlinkSync(it.file.replace(/\.json$/, ".error.json")); } catch { /* ignore */ }
    }
  }
  return { apply, days, count: plan.length, items: plan.slice(0, 100) };
}

export { listInbox, safeFileName };
