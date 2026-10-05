// 批量采集状态机：pending → staging → ready → delivering → done，失败进 failed（可重试回 pending）。
// 落盘：paths().output/batch-<id>/manifest.json + items/<index>.json。
// 原则：失败的条目必须保留原始载荷（items/<index>.json 永不删除），重试只改状态。
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.mjs";
import { paths, timestampSlug } from "../paths.mjs";
import { ensureDir, fmtLocal, readJson, sha1, shortId, writeJson } from "../util.mjs";
import { recordOperation } from "./history.mjs";
import { matchSceneFor } from "./scenes.mjs";
import { deliver } from "./targets.mjs";

/** manifest 结构版本 */
export const BATCH_SCHEMA = "wechat-ai/batch@1";

/** 状态集合 */
export const BATCH_STATES = ["pending", "staging", "ready", "delivering", "done", "failed"];

/** 合法迁移表（failed → pending 即"重试"） */
export const BATCH_TRANSITIONS = {
  pending: ["staging", "ready", "failed"],
  staging: ["ready", "failed", "staging"],
  ready: ["delivering", "failed", "staging"],
  delivering: ["done", "failed"],
  done: [],
  failed: ["pending", "staging"],
};

const ID_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,80}$/;

/** 批次目录：output/batch-<id> */
export function batchDir(id) {
  const key = String(id ?? "").trim();
  if (!ID_RE.test(key)) throw new Error("批次 id 不合法：" + key);
  return path.join(paths().output, "batch-" + key);
}

export function manifestPath(id) {
  return path.join(batchDir(id), "manifest.json");
}

function canMove(from, to) {
  return from === to || (BATCH_TRANSITIONS[from] ?? []).includes(to);
}

function asText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function tsRangeOf(raw) {
  if (raw.tsRange) return String(raw.tsRange);
  const from = Number.isFinite(raw.ts_min) ? raw.ts_min : (Number.isFinite(raw.sinceMs) ? raw.sinceMs : null);
  const to = Number.isFinite(raw.ts_max) ? raw.ts_max : (Number.isFinite(raw.untilMs) ? raw.untilMs : null);
  if (from && to) return fmtLocal(new Date(from)) + " ~ " + fmtLocal(new Date(to));
  if (from) return fmtLocal(new Date(from)) + " ~ 未标注";
  if (to) return "未标注 ~ " + fmtLocal(new Date(to));
  return "";
}

/** 归一化一个待采集条目 */
function normalizeItem(raw, index) {
  const obj = typeof raw === "string" ? { title: raw } : (raw ?? {});
  const title = asText(obj.title ?? obj.name ?? obj.chat ?? "未命名条目").trim() || "未命名条目";
  const chat = asText(obj.chat ?? obj.session_name ?? "").trim();
  const text = asText(obj.text ?? obj.body ?? obj.content ?? "");
  const file = obj.file ?? obj.path ?? null;
  const tsRange = tsRangeOf(obj);
  const hash = asText(obj.hash).trim() || sha1([title, chat, tsRange, text, asText(file)].join("\u0001")).slice(0, 16);
  return {
    index,
    title,
    chat,
    tsRange,
    hash,
    status: "pending",
    error: null,
    artifact: null,
    ts_min: Number.isFinite(obj.ts_min) ? obj.ts_min : null,
    ts_max: Number.isFinite(obj.ts_max) ? obj.ts_max : null,
    link: obj.link ?? null,
    // 原始载荷：创建时即写进 items/<index>.json（manifest 不存正文，防膨胀）
    text,
    file,
  };
}

function loadManifest(id) {
  const file = manifestPath(id);
  const data = readJson(file, null);
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data.items)) data.items = [];
  return data;
}

function saveManifest(manifest) {
  manifest.updated_ts = Date.now();
  manifest.status = aggregateStatus(manifest.items, manifest.status === "delivering");
  writeJson(manifestPath(manifest.id), manifest);
  return manifest;
}

/** 汇总状态：任一 failed 且没有待处理项 → failed；全部 done → done；否则取最靠前的阶段 */
export function aggregateStatus(items = [], deliveringFlag = false) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return "pending";
  const count = (s) => list.filter((i) => i.status === s).length;
  if (count("done") === list.length) return "done";
  if (deliveringFlag || count("delivering") > 0) return "delivering";
  if (count("failed") === list.length) return "failed";
  if (count("ready") > 0) return "ready";
  if (count("staging") > 0) return "staging";
  if (count("pending") > 0) return "pending";
  if (count("failed") > 0) return "failed";
  return "pending";
}

/** 计数表 */
export function statusCounts(items = []) {
  const counts = Object.fromEntries(BATCH_STATES.map((s) => [s, 0]));
  for (const item of Array.isArray(items) ? items : []) {
    const key = BATCH_STATES.includes(item.status) ? item.status : "pending";
    counts[key] += 1;
  }
  return counts;
}

function itemView(item) {
  return {
    index: item.index,
    title: item.title,
    chat: item.chat,
    tsRange: item.tsRange,
    hash: item.hash,
    status: item.status,
    error: item.error ?? null,
    artifact: item.artifact ?? null,
    deliveredAt: item.deliveredAt ?? null,
    delivery: item.delivery ?? null,
  };
}

/**
 * 新建一个批次。
 * @param {{items?:Array, source?:string, scene?:string, target?:string}} options
 * @returns {{id:string, manifestPath:string, count:number, dropped:number, duplicates:number, maxItems:number, status:string}}
 */
export function createBatch({ items = [], source = "manual", scene = null, target = null } = {}) {
  const cfg = loadConfig();
  const maxItems = Number.isFinite(Number(cfg.settings?.batchMaxItems)) ? Number(cfg.settings.batchMaxItems) : 100;
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const kept = [];
  let duplicates = 0;
  let dropped = 0;
  for (const raw of list) {
    const item = normalizeItem(raw, kept.length);
    if (seen.has(item.hash)) { duplicates += 1; continue; } // 同 hash 只保留一条
    if (kept.length >= maxItems) { dropped += 1; continue; }
    seen.add(item.hash);
    kept.push(item);
  }
  const id = timestampSlug() + "-" + shortId([source, Date.now(), list.length, kept.map((i) => i.hash).join(",")].join("|"), 6);
  // 创建即落原始载荷（items/<index>.json 永不丢弃），正文不进 manifest
  const itemsDir = ensureDir(path.join(batchDir(id), "items"));
  for (const item of kept) {
    writeJson(path.join(itemsDir, String(item.index) + ".json"), {
      index: item.index,
      title: item.title,
      chat: item.chat,
      tsRange: item.tsRange,
      hash: item.hash,
      text: item.text,
      file: item.file,
      link: item.link ?? null,
      createdAt: Date.now(),
    });
    item.artifact = path.join("items", String(item.index) + ".json");
  }
  const manifest = {
    schema: BATCH_SCHEMA,
    id,
    created_ts: Date.now(),
    updated_ts: Date.now(),
    source: String(source ?? "manual"),
    scene: scene ? String(scene) : null,
    target: target ? String(target) : null,
    max_items: maxItems,
    dropped,
    duplicates,
    status: "pending",
    items: kept.map(({ text, file, ...rest }) => rest),
  };
  saveManifest(manifest);
  recordOperation({
    action: "batch-create",
    target: manifest.target,
    title: "批次 " + id,
    chars: 0,
    files: [],
    payload: { id, count: kept.length, dropped, duplicates, source: manifest.source, scene: manifest.scene },
    ok: true,
  });
  return {
    id,
    manifestPath: manifestPath(id),
    count: kept.length,
    dropped,
    duplicates,
    maxItems,
    status: "pending",
    source: manifest.source,
    scene: manifest.scene,
    target: manifest.target,
  };
}

function requireManifest(id) {
  const manifest = loadManifest(id);
  if (!manifest) throw new Error("未找到批次：" + String(id ?? ""));
  return manifest;
}

function findItem(manifest, index) {
  const n = Number(index);
  const item = manifest.items.find((i) => Number(i.index) === n);
  if (!item) throw new Error("批次 " + manifest.id + " 中没有第 " + index + " 条。");
  return item;
}

/**
 * 暂存一条内容：原始载荷写进 items/<index>.json（永不丢弃），状态置为 staging。
 * @param {{text?:string, file?:string, raw?:object}} source
 */
export function stageItem(batchId, index, source = {}) {
  const manifest = requireManifest(batchId);
  const item = findItem(manifest, index);
  if (item.status === "done") return { ok: false, batchId: manifest.id, status: manifest.status, item: itemView(item), detail: "该条目已交付，未重复暂存。" };
  const dir = batchDir(manifest.id);
  const itemsDir = ensureDir(path.join(dir, "items"));
  const artifact = path.join(itemsDir, String(item.index) + ".json");
  const prev = readJson(artifact, null) ?? {}; // 创建时已落原始载荷：未提供新内容时保留原文
  const file = source.file ? path.resolve(String(source.file)) : (prev.file ?? null);
  const text = asText(source.text ?? source.body ?? "") || asText(prev.text ?? "");
  const raw = {
    index: item.index,
    title: item.title,
    chat: item.chat,
    tsRange: item.tsRange,
    hash: item.hash,
    text,
    file,
    link: item.link ?? null,
    stagedAt: Date.now(),
    ...(source.raw && typeof source.raw === "object" ? { raw: source.raw } : {}),
  };
  writeJson(artifact, raw);
  item.artifact = path.join("items", String(item.index) + ".json");
  item.status = "staging";
  item.error = null;
  item.stagedAt = raw.stagedAt;
  item.bytes = file ? (() => { try { return fs.statSync(file).size; } catch { return null; } })() : Buffer.byteLength(text, "utf8");
  saveManifest(manifest);
  return { ok: true, batchId: manifest.id, status: manifest.status, item: itemView(item), artifact: path.join(dir, item.artifact), bytes: item.bytes };
}

/** 标记为可交付（staging → ready） */
export function markReady(batchId, index) {
  const manifest = requireManifest(batchId);
  const item = findItem(manifest, index);
  if (!canMove(item.status, "ready")) {
    return { ok: false, batchId: manifest.id, status: manifest.status, item: itemView(item), detail: "状态 " + item.status + " 不能直接转为 ready。" };
  }
  item.status = "ready";
  item.error = null;
  saveManifest(manifest);
  return { ok: true, batchId: manifest.id, status: manifest.status, item: itemView(item) };
}

/** 标记失败（保留 artifact 与 error） */
export function failItem(batchId, index, error) {
  const manifest = requireManifest(batchId);
  const item = findItem(manifest, index);
  item.status = "failed";
  item.error = String(error?.message ?? error ?? "未知错误");
  saveManifest(manifest);
  return { ok: true, batchId: manifest.id, status: manifest.status, item: itemView(item) };
}

/** 重试全部失败项：failed → pending，原始载荷保持不动 */
export function retryFailed(batchId) {
  const manifest = requireManifest(batchId);
  let count = 0;
  for (const item of manifest.items) {
    if (item.status !== "failed") continue;
    item.status = "pending";
    item.lastError = item.error ?? null;
    item.error = null;
    count += 1;
  }
  if (count) {
    manifest.status = "pending";
    saveManifest(manifest);
  }
  return { ok: count > 0, batchId: manifest.id, retried: count, status: manifest.status, counts: statusCounts(manifest.items) };
}

/** 批次状态总览 */
export function batchStatus(batchId) {
  const manifest = requireManifest(batchId);
  return {
    id: manifest.id,
    path: batchDir(manifest.id),
    manifestPath: manifestPath(manifest.id),
    schema: manifest.schema,
    status: manifest.status,
    counts: statusCounts(manifest.items),
    count: manifest.items.length,
    dropped: manifest.dropped ?? 0,
    duplicates: manifest.duplicates ?? 0,
    source: manifest.source,
    scene: manifest.scene,
    target: manifest.target,
    created_ts: manifest.created_ts,
    updated_ts: manifest.updated_ts,
    createdAt: manifest.created_ts ? fmtLocal(new Date(manifest.created_ts)) : "",
    items: manifest.items.map(itemView),
  };
}

/** 由暂存的原始载荷还原转发载荷 */
function payloadFor(manifest, item) {
  const dir = batchDir(manifest.id);
  const raw = item.artifact ? (readJson(path.join(dir, item.artifact), null) ?? {}) : {};
  const text = asText(raw.text ?? "");
  const files = [];
  if (raw.file) {
    const name = String(raw.file).split(/[\\/]/).pop() || "附件";
    files.push({ path: raw.file, name });
  }
  return {
    title: item.title,
    chat: item.chat || item.title,
    body: text,
    files,
    links: raw.link ? [raw.link] : [],
    ts_min: item.ts_min ?? null,
    ts_max: item.ts_max ?? null,
    source: manifest.source,
    scene: manifest.scene,
    meta: { batchId: manifest.id, index: item.index, hash: item.hash },
  };
}

/**
 * 交付整个批次：ready 的条目依次投递，逐条记录结果。
 * @param {{target?:string, dryRun?:boolean, scene?:string}} options
 */
export function deliverBatch(batchId, { target = null, dryRun = false, scene = null } = {}) {
  const manifest = requireManifest(batchId);
  const targetId = target ?? manifest.target ?? null;
  const sceneId = scene ?? manifest.scene ?? null;
  const pending = manifest.items.filter((i) => i.status === "ready");
  if (!pending.length) {
    return {
      id: manifest.id,
      status: manifest.status,
      target: targetId,
      delivered: 0,
      failed: 0,
      skipped: 0,
      results: [],
      detail: "没有 ready 状态的条目；请先 wai_batch_stage。",
    };
  }
  if (!dryRun) {
    manifest.status = "delivering";
    for (const item of pending) item.status = "delivering";
    manifest.target = targetId ? String(targetId) : manifest.target;
    manifest.scene = sceneId ? String(sceneId) : manifest.scene;
    saveManifest(manifest);
  }
  const results = [];
  let delivered = 0;
  let failed = 0;
  for (const item of pending) {
    const payload = payloadFor(manifest, item);
    const result = deliver(payload, { target: targetId, scene: sceneId, dryRun });
    results.push({ index: item.index, ...result });
    if (dryRun) continue;
    if (result.status === "ok") {
      item.status = "done";
      item.error = null;
      delivered += 1;
    } else {
      item.status = "failed";
      item.error = result.detail;
      failed += 1;
    }
    item.deliveredAt = Date.now();
    item.delivery = { target: result.target, status: result.status, path: result.path ?? null, detail: result.detail };
    saveManifest(manifest);
  }
  if (!dryRun) {
    manifest.status = aggregateStatus(manifest.items, false);
    saveManifest(manifest);
    recordOperation({
      action: "batch-deliver",
      target: targetId,
      title: "批次 " + manifest.id,
      chars: 0,
      files: results.map((r) => r.path).filter(Boolean),
      payload: { id: manifest.id, delivered, failed, target: targetId, scene: sceneId },
      ok: failed === 0,
    });
  }
  return {
    id: manifest.id,
    status: dryRun ? "ready" : manifest.status,
    target: targetId,
    scene: sceneId,
    dryRun: !!dryRun,
    delivered,
    failed,
    skipped: results.filter((r) => r.status === "skipped").length,
    counts: statusCounts(manifest.items),
    results,
    manifestPath: manifestPath(manifest.id),
  };
}

/** 列出全部批次（按创建时间倒序） */
export function listBatches({ limit = 50 } = {}) {
  const root = paths().output;
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith("batch-")) continue;
    const id = name.slice("batch-".length);
    if (!ID_RE.test(id)) continue;
    const manifest = loadManifest(id);
    if (!manifest) continue;
    out.push({
      id,
      path: path.join(root, name),
      manifestPath: path.join(root, name, "manifest.json"),
      status: manifest.status,
      count: manifest.items.length,
      counts: statusCounts(manifest.items),
      source: manifest.source,
      scene: manifest.scene,
      target: manifest.target,
      created_ts: manifest.created_ts,
      updated_ts: manifest.updated_ts,
      createdAt: manifest.created_ts ? fmtLocal(new Date(manifest.created_ts)) : "",
    });
  }
  return out.sort((a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0)).slice(0, Math.max(0, limit));
}

/** 由标题推断场景（批次常用：转发前给整批挑一个场景） */
export function batchScene(batchId) {
  const manifest = requireManifest(batchId);
  const first = manifest.items[0];
  return matchSceneFor(first?.chat || first?.title || "");
}

