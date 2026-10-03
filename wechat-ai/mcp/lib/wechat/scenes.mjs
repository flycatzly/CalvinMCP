// 场景：按群名/标题匹配"这次转发该让 Agent 做什么"。
// 存储策略：config.scenes 是默认与匹配用的权威列表（config.matchScene 直接读它），
// store 的 scenes 表是用户改动后的持久化层；写入时两边同步，读取时以 store 覆盖 config。
import { DEFAULT_SCENES, loadConfig, matchScene, saveConfig } from "../config.mjs";
import { normalizePayload } from "../inbox.mjs";
import { pj, store, tx } from "../store.mjs";
import { fmtLocal, shortId, truncate, uniq } from "../util.mjs";

/** 场景字段白名单：upsertScene 只接受这些字段，避免写入脏数据 */
const SCENE_FIELDS = ["id", "name", "match", "priority", "task", "targets", "enabled", "summary", "output", "skills", "note"];

function asArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return String(value).split(/[,，、;；\s]+/).map((v) => v.trim()).filter(Boolean);
}

/** 把任意输入整理成场景对象（缺省值补齐，字段类型收敛） */
export function normalizeScene(input = {}) {
  const name = String(input.name ?? "").trim();
  const id = String(input.id ?? "").trim() || "scene-" + shortId(name || Date.now());
  const scene = {
    id,
    name: name || id,
    match: uniq(asArray(input.match ?? input.keywords)),
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
    task: String(input.task ?? input.instruction ?? "").trim(),
    targets: uniq(asArray(input.targets)),
    enabled: input.enabled === undefined ? true : !!input.enabled,
    summary: String(input.summary ?? "").trim(),
    output: String(input.output ?? input.outputSpec ?? "").trim(),
    skills: uniq(asArray(input.skills ?? input.requiredSkillIDs)),
    note: String(input.note ?? "").trim(),
    source: input.source ?? "store",
  };
  if (input.updated_ts) scene.updated_ts = input.updated_ts;
  return scene;
}

function rowToScene(r) {
  return normalizeScene({
    id: r.id,
    name: r.name,
    match: pj(r.match, []),
    priority: r.priority,
    task: r.task,
    targets: pj(r.targets, []),
    enabled: r.enabled === 0 || r.enabled === false ? false : true,
    ...(pj(r.meta, {}) ?? {}),
    source: "store",
    updated_ts: r.updated_ts ?? null,
  });
}

/** 读取 store 中的场景行（按优先级倒序） */
export function storedScenes() {
  try {
    return store().prepare("SELECT * FROM scenes ORDER BY priority DESC, id ASC").all().map(rowToScene);
  } catch {
    return [];
  }
}

/** 全部场景：config 默认值 + store 覆盖，按优先级倒序 */
export function listScenes() {
  const cfg = loadConfig();
  const merged = new Map();
  const base = Array.isArray(cfg.scenes) && cfg.scenes.length ? cfg.scenes : DEFAULT_SCENES;
  for (const s of base) {
    const scene = normalizeScene({ ...s, source: "config" });
    merged.set(scene.id, scene);
  }
  for (const s of storedScenes()) merged.set(s.id, s);
  return [...merged.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name, "zh"));
}

/** 单个场景；未知返回 null */
export function getScene(id) {
  const key = String(id ?? "").trim();
  if (!key) return null;
  return listScenes().find((s) => s.id === key) ?? null;
}

/** 把场景表同步回 config.scenes（匹配逻辑读的是 config） */
function syncConfigScenes(scenes) {
  const cfg = loadConfig();
  const next = scenes.map((s) => ({
    id: s.id,
    name: s.name,
    match: s.match,
    priority: s.priority,
    task: s.task,
    targets: s.targets,
    enabled: s.enabled,
    ...(s.summary ? { summary: s.summary } : {}),
    ...(s.output ? { output: s.output } : {}),
    ...(s.skills?.length ? { skills: s.skills } : {}),
  }));
  saveConfig({ ...cfg, scenes: next });
  return next;
}

/**
 * 新增或更新一个场景（同时写 store.scenes 与 config.scenes）。
 * @returns {object} 规范化后的场景
 */
export function upsertScene(input = {}) {
  const scene = normalizeScene(input);
  const meta = {
    summary: scene.summary,
    output: scene.output,
    skills: scene.skills,
    note: scene.note,
  };
  tx(store(), () => {
    store().prepare(
      `INSERT INTO scenes(id,name,match,priority,task,targets,enabled,meta,updated_ts)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, match=excluded.match, priority=excluded.priority, task=excluded.task,
         targets=excluded.targets, enabled=excluded.enabled, meta=excluded.meta, updated_ts=excluded.updated_ts`,
    ).run(
      scene.id,
      scene.name,
      JSON.stringify(scene.match),
      scene.priority,
      scene.task,
      JSON.stringify(scene.targets),
      scene.enabled ? 1 : 0,
      JSON.stringify(meta),
      Date.now(),
    );
  });
  const all = listScenes();
  syncConfigScenes(all);
  return all.find((s) => s.id === scene.id) ?? scene;
}

/**
 * 删除一个场景（store 与 config 同时删除）。
 * @returns {boolean} 是否真的删掉了
 */
export function deleteScene(id) {
  const key = String(id ?? "").trim();
  if (!key) return false;
  const before = listScenes();
  if (!before.some((s) => s.id === key)) return false;
  try {
    store().prepare("DELETE FROM scenes WHERE id=?").run(key);
  } catch { /* 表不可用时只删 config */ }
  syncConfigScenes(before.filter((s) => s.id !== key));
  return true;
}

/** 按标题/群名匹配场景（复用 config.matchScene 的打分规则） */
export function matchSceneFor(title) {
  const cfg = { ...loadConfig(), scenes: listScenes() };
  return matchScene(title, cfg) ?? null;
}

/** 场景列表摘要，便于 CLI/工具输出 */
export function scenesSummary() {
  const scenes = listScenes();
  return {
    count: scenes.length,
    enabled: scenes.filter((s) => s.enabled).length,
    scenes: scenes.map((s) => ({
      id: s.id,
      name: s.name,
      match: s.match,
      priority: s.priority,
      enabled: s.enabled,
      targets: s.targets,
      source: s.source,
    })),
  };
}

// ---------- 转发载荷规范化 ----------

function fileEntry(f) {
  if (!f) return null;
  if (typeof f === "string") {
    const name = f.split(/[\\/]/).pop() || f;
    return { path: f, name };
  }
  const p = String(f.path ?? f.file ?? "").trim();
  if (!p) return null;
  return { path: p, name: String(f.name ?? p.split(/[\\/]/).pop() ?? "附件"), bytes: f.bytes ?? null, kind: f.kind ?? null };
}

/**
 * 把入站载荷（Inbox 条目 / 解析结果 / 裸文本）统一成转发所需的形状。
 * 复用 inbox.normalizePayload（其内部又复用 parse.parseAny），失败时退回最小映射。
 */
export function normalizeDeliveryPayload(input = {}) {
  const raw = typeof input === "string" ? { body: input } : (input ?? {});
  let base = null;
  try {
    base = normalizePayload(raw);
  } catch {
    base = null;
  }
  const messages = (base?.messages ?? raw.messages ?? []).map((m) => ({
    sender: String(m.sender ?? m.from ?? "未知"),
    ts: Number.isFinite(m.ts) ? m.ts : null,
    content: String(m.content ?? m.text ?? ""),
    is_owner: !!m.is_owner,
    links: Array.isArray(m.links) ? m.links : [],
  }));
  const tsList = messages.map((m) => m.ts).filter((t) => Number.isFinite(t));
  const sinceMs = Number.isFinite(raw.ts_min) ? raw.ts_min : (tsList.length ? Math.min(...tsList) : null);
  const untilMs = Number.isFinite(raw.ts_max) ? raw.ts_max : (tsList.length ? Math.max(...tsList) : null);
  const files = (base?.files ?? raw.files ?? []).map(fileEntry).filter(Boolean);
  const links = uniq([
    ...(base?.links ?? []),
    ...messages.flatMap((m) => m.links ?? []),
    ...(Array.isArray(raw.links) ? raw.links : []),
  ]).filter(Boolean);
  const chat = String(raw.chat ?? base?.chat ?? raw.session_name ?? messages[0]?.chat ?? "微信内容");
  const title = String(raw.title ?? base?.title ?? chat ?? "微信内容");
  const body = String(raw.body ?? raw.text ?? raw.content ?? base?.body ?? "");
  return {
    schema: base?.schema ?? "wechat-ai/forward@1",
    id: raw.id ?? base?.id ?? null,
    source: raw.source ?? base?.source ?? "manual",
    kind: raw.kind ?? base?.kind ?? "chat",
    title,
    chat,
    body,
    messages,
    count: messages.length,
    links,
    files,
    sinceMs,
    untilMs,
    hash: raw.hash ?? base?.hash ?? shortId([chat, body, messages.length].join("|"), 16),
    scene: raw.scene ?? base?.scene ?? null,
    target: raw.target ?? base?.target ?? null,
    meta: raw.meta ?? base?.meta ?? {},
    created_ts: raw.created_ts ?? base?.created_ts ?? Date.now(),
  };
}

/** 时间范围文案：yyyy-MM-dd HH:mm ~ yyyy-MM-dd HH:mm（共 n 条消息） */
export function timeRangeText(payload) {
  const from = payload.sinceMs ? fmtLocal(new Date(payload.sinceMs)) : "未标注";
  const to = payload.untilMs ? fmtLocal(new Date(payload.untilMs)) : "未标注";
  return from + " ~ " + to + "（共 " + (payload.count ?? 0) + " 条消息）";
}

function clip(text, max) {
  return truncate(String(text ?? "").replace(/\r?\n/g, " ").trim(), max);
}

/** 场景要点的纯文本（模板变量 {{out}}/{{slug}} 等不在这里替换） */
export function sceneTaskText(scene) {
  if (!scene) return "总结要点、待办与需要我回复的内容。";
  return String(scene.task ?? "").trim() || "总结要点、待办与需要我回复的内容。";
}

/**
 * 场景任务预览：把场景要求与待转发内容拼成给 Agent 的完整提示词。
 * @returns {{scene:object|null, task:string, prompt:string, payload:object}}
 */
export function sceneTaskPreview(sceneId, payload = {}) {
  const p = normalizeDeliveryPayload(payload);
  const scene = (sceneId ? getScene(sceneId) : null) ?? matchSceneFor(p.chat || p.title);
  const task = sceneTaskText(scene);
  const senders = uniq(p.messages.map((m) => m.sender).filter(Boolean));
  const lines = [];
  lines.push("【任务场景】" + (scene ? scene.name + "（" + scene.id + "）" : "通用"));
  lines.push("【来源群名】" + (p.chat || "未标注"));
  if (p.title && p.title !== p.chat) lines.push("【内容标题】" + p.title);
  lines.push("【时间范围】" + timeRangeText(p));
  lines.push("【场景要求】" + task);
  if (scene?.output) lines.push("【输出要求】" + scene.output);
  if (scene?.summary) lines.push("【场景说明】" + scene.summary);
  if (scene?.skills?.length) lines.push("【需要技能】" + scene.skills.join("、"));
  lines.push("【参与人】" + (senders.length ? senders.join("、") : "未标注"));
  if (p.links.length) lines.push("【链接】" + p.links.length + " 条：" + p.links.slice(0, 10).join(" | "));
  if (p.files.length) lines.push("【附件】" + p.files.map((f) => f.name).join("、"));
  lines.push("", "【内容】");
  if (p.messages.length) {
    p.messages.forEach((m, i) => {
      const when = m.ts ? fmtLocal(new Date(m.ts)) : "时间未标注";
      lines.push(i + 1 + ". [" + when + "] " + m.sender + "：" + clip(m.content, 2000));
    });
  } else if (p.body.trim()) {
    lines.push(clip(p.body, 20000));
  } else {
    lines.push("（无文本内容，请根据附件处理）");
  }
  return { scene, task, prompt: lines.join("\n"), payload: p };
}
