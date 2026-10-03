// 操作记录：每一次转发/投递都留痕，支持重新发送到另一个目标与导出。
// 存储：store 的 history 表（store.logHistory / store.listHistory）与 delivery 表。
// 注意：本模块与 targets.mjs 互相 import（rerun 要用 deliver，deliver 要写记录）。
// 两边都只在函数体内互相调用，不做模块级求值，ESM 的函数声明提升保证循环引用安全。
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.mjs";
import { listHistory, logHistory, pj, store } from "../store.mjs";
import { fmtDay, fmtLocal, toCsv, truncate } from "../util.mjs";
import { deliver } from "./targets.mjs";

/** 历史记录默认条数 */
const DEFAULT_LIMIT = 50;

function decorate(row) {
  return {
    ...row,
    at: row.ts ? fmtLocal(new Date(row.ts)) : "",
    day: row.ts ? fmtDay(new Date(row.ts)) : "",
    title: row.title ?? "",
    files: Array.isArray(row.files) ? row.files : [],
    payload: row.payload ?? null,
    chars: row.chars ?? 0,
    ok: row.ok !== false,
  };
}

/**
 * 记录一次操作（转发、导出、技能运行等）。
 * @returns {string} 记录 id
 */
export function recordOperation({ action, target, title, chars, files, payload, ok = true, ts, id } = {}) {
  const body = payload ?? null;
  const fileList = Array.isArray(files) ? files : [];
  return storeHistory({
    id,
    ts: ts ?? Date.now(),
    action: action ?? "forward",
    target: target ?? null,
    title: title ?? "",
    chars: Number.isFinite(chars) ? chars : (typeof body === "object" && body?.markdown ? String(body.markdown).length : 0),
    files: fileList,
    payload: body,
    ok,
  });
}

/** 包一层，保证任何异常都不会打断投递（记录失败不能反过来弄丢内容） */
function storeHistory(entry) {
  try {
    // store.logHistory 是唯一写 history 表的入口
    return logHistory(entry);
  } catch {
    return null;
  }
}

/** 列出操作记录 */
export function listOperations({ limit = DEFAULT_LIMIT, action, target } = {}) {
  try {
    return listHistory({ limit, action, target }).map(decorate);
  } catch {
    return [];
  }
}

/** 读取单条记录；不存在返回 null */
export function getOperation(id) {
  const key = String(id ?? "").trim();
  if (!key) return null;
  try {
    const row = store().prepare("SELECT * FROM history WHERE id=?").get(key);
    if (!row) return null;
    return decorate({ ...row, files: pj(row.files, []), payload: pj(row.payload, null), ok: !!row.ok });
  } catch {
    return null;
  }
}

/**
 * 把一条历史记录再次投递到另一个目标。
 * @returns {object} deliver 的返回值 + {rerunOf, rerunId}
 */
export function rerun(id, { target, dryRun = false, scene = null } = {}) {
  const op = getOperation(id);
  if (!op) return { target: target ?? null, status: "error", detail: "未找到记录：" + String(id ?? "") };
  const stored = op.payload ?? {};
  const payload = stored.payload ?? stored;
  const targetId = target ?? stored.target ?? op.target;
  if (!targetId) return { target: null, status: "error", detail: "没有可用的目标，请在 rerun 时传入 target。", rerunOf: id };
  const result = deliver(payload, { target: targetId, scene: scene ?? stored.scene ?? null, dryRun });
  const rerunId = recordOperation({
    action: "rerun",
    target: typeof result.target === "string" ? result.target : targetId,
    title: payload?.title ?? op.title,
    chars: payload?.body ? String(payload.body).length : op.chars,
    files: result.files ?? [],
    payload: { payload, scene: scene ?? stored.scene ?? null, source: id },
    ok: result.status === "ok",
  });
  return { ...result, rerunOf: id, rerunId };
}

/** 按目标/动作/日期计数 */
export function historySummary() {
  const empty = { total: 0, ok: 0, failed: 0, byTarget: {}, byAction: {}, byDay: {}, first_ts: null, last_ts: null, topTargets: [] };
  try {
    const db = store();
    const total = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) ok_n, MIN(ts) first_ts, MAX(ts) last_ts FROM history").get();
    if (!total || !total.n) return empty;
    const group = (col) => db.prepare("SELECT COALESCE(" + col + ",'(未指定)') k, COUNT(*) n FROM history GROUP BY k ORDER BY n DESC").all();
    const byTarget = Object.fromEntries(group("target").map((r) => [r.k, r.n]));
    const byAction = Object.fromEntries(group("action").map((r) => [r.k, r.n]));
    const byDay = Object.fromEntries(
      db.prepare("SELECT day, COUNT(*) n FROM (SELECT date(ts/1000,'unixepoch','localtime') day FROM history) GROUP BY day ORDER BY day DESC LIMIT 60")
        .all()
        .map((r) => [r.day, r.n]),
    );
    return {
      total: total.n,
      ok: total.ok_n ?? 0,
      failed: total.n - (total.ok_n ?? 0),
      byTarget,
      byAction,
      byDay,
      first_ts: total.first_ts ?? null,
      last_ts: total.last_ts ?? null,
      topTargets: Object.entries(byTarget).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([target, count]) => ({ target, count })),
    };
  } catch {
    return empty;
  }
}

/**
 * 导出历史记录。
 * @param {{outDir?:string, format?:'json'|'csv'|'md', limit?:number}} options
 */
export function exportHistory({ outDir = null, format = "json", limit = 1000 } = {}) {
  const rows = listOperations({ limit });
  const dir = outDir ? path.resolve(outDir) : paths().output;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const slug = "" + stamp.getFullYear() + p2(stamp.getMonth() + 1) + p2(stamp.getDate()) + "-" + p2(stamp.getHours()) + p2(stamp.getMinutes()) + p2(stamp.getSeconds());
  const fmt = String(format ?? "json").toLowerCase();
  let file;
  let text;
  if (fmt === "csv") {
    file = path.join(dir, "history-" + slug + ".csv");
    text = toCsv(rows.map((r) => ({
      id: r.id, at: r.at, action: r.action, target: r.target, title: r.title,
      chars: r.chars, ok: r.ok ? 1 : 0, files: r.files.join(" | "),
    })), ["id", "at", "action", "target", "title", "chars", "ok", "files"]);
  } else if (fmt === "md" || fmt === "markdown") {
    file = path.join(dir, "history-" + slug + ".md");
    const lines = ["# 操作记录（" + rows.length + " 条）", "", "| 时间 | 动作 | 目标 | 标题 | 字数 | 结果 |", "| --- | --- | --- | --- | --- | --- |"];
    for (const r of rows) {
      const title = truncate(String(r.title ?? "").replace(/\|/g, "\\|"), 40);
      lines.push("| " + r.at + " | " + (r.action ?? "") + " | " + (r.target ?? "") + " | " + title + " | " + r.chars + " | " + (r.ok ? "成功" : "失败") + " |");
    }
    text = lines.join("\n") + "\n";
  } else {
    file = path.join(dir, "history-" + slug + ".json");
    text = JSON.stringify({
      exported_at: new Date().toISOString(),
      count: rows.length,
      summary: historySummary(),
      operations: rows,
    }, null, 2);
  }
  fs.writeFileSync(file, text, "utf8");
  return { path: file, format: fmt, count: rows.length, bytes: Buffer.byteLength(text, "utf8") };
}

// ---------- delivery 表 ----------

/** 写一条投递记录（targets.deliver 调用） */
export function recordDelivery({ entryId = null, target, status, detail = "", path: filePath = null } = {}) {
  try {
    store().prepare("INSERT INTO delivery(entry_id,target,status,ts,detail,path) VALUES(?,?,?,?,?,?)")
      .run(entryId, target ?? null, status ?? "unknown", Date.now(), String(detail ?? "").slice(0, 2000), filePath);
    return true;
  } catch {
    return false;
  }
}

/** 读取投递记录 */
export function listDeliveries({ target, status, limit = 50 } = {}) {
  try {
    const where = [];
    const args = [];
    if (target) { where.push("target=?"); args.push(target); }
    if (status) { where.push("status=?"); args.push(status); }
    args.push(limit);
    return store().prepare("SELECT * FROM delivery " + (where.length ? "WHERE " + where.join(" AND ") + " " : "") + "ORDER BY ts DESC LIMIT ?")
      .all(...args)
      .map((r) => ({ ...r, at: r.ts ? fmtLocal(new Date(r.ts)) : "", ok: r.status === "ok" }));
  } catch {
    return [];
  }
}
