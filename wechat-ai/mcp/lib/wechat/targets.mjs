// 转发目标与投递：把一次「微信流」载荷送到 Agent / Obsidian / 剪贴板 / 文件夹 / 自定义命令。
// 平台边界（Windows 无 GUI 场景）：
//   - Agent 目标只把提示词写成文件，并给出「把该文件内容粘贴给 <Agent>」的指引；
//     没有系统授权通道时绝不假装已经注入其它应用。
//   - 自定义目标通过「文件 + 环境变量 + 附加参数」传载荷，命令串不做 shell 插值。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_TARGETS, loadConfig, saveConfig } from "../config.mjs";
import { paths } from "../paths.mjs";
import { ensureDir, fmtDay, fmtLocal, safeFileName, slugify, truncate } from "../util.mjs";
import { clipboardSupport, setClipboardText } from "./clipboard.mjs";
import { recordDelivery, recordOperation } from "./history.mjs";
import { normalizeDeliveryPayload, sceneTaskPreview } from "./scenes.mjs";
import { writeObsidianNote } from "./obsidian.mjs";

/** 支持的目标类型 */
export const TARGET_KINDS = ["agent", "obsidian", "clipboard", "folder", "custom"];

/** 模板变量名（{{out}}/{{slug}}/{{title}}/{{date}}/{{chat}}） */
export const TEMPLATE_KEYS = ["out", "slug", "title", "date", "chat", "target", "kind"];

/** 默认输出目录（agent 提示词与剪贴板回退文件都落在这里） */
function defaultOut() {
  return paths().output;
}

function expandHome(p) {
  const s = String(p ?? "").trim();
  if (!s) return "";
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return String(value).split(/[,，、;；]+/).map((v) => v.trim()).filter(Boolean);
}

/** 规范化目标定义（缺省 kind=agent，补上 enabled/名称） */
export function normalizeTarget(input = {}) {
  const id = String(input.id ?? "").trim();
  const kindRaw = String(input.kind ?? "agent").trim().toLowerCase();
  const kind = TARGET_KINDS.includes(kindRaw) ? kindRaw : "agent";
  const out = {
    ...input,
    id,
    name: String(input.name ?? id).trim() || id,
    kind,
    enabled: input.enabled === undefined ? true : !!input.enabled,
  };
  // 未配置 folder 时不留这个键，避免默认值覆盖已有设置
  if (input.folder === undefined || input.folder === null) delete out.folder;
  else out.folder = String(input.folder);
  return out;
}

/** 全部目标：内置默认值 + config.targets 覆盖 */
export function listTargets() {
  const cfg = loadConfig();
  const merged = new Map();
  for (const t of DEFAULT_TARGETS) {
    const target = normalizeTarget({ ...t, source: "default" });
    merged.set(target.id, target);
  }
  for (const t of cfg.targets ?? []) {
    if (!t || !t.id) continue;
    merged.set(String(t.id), normalizeTarget({ ...t, source: "config" }));
  }
  return [...merged.values()];
}

/** 解析目标：接受 id 或目标对象；未知返回 null */
export function resolveTarget(target) {
  if (target && typeof target === "object") {
    const base = listTargets().find((t) => t.id === String(target.id ?? "")) ?? {};
    const merged = normalizeTarget({ ...base, ...target });
    return merged.id ? merged : null;
  }
  const key = String(target ?? "").trim();
  if (!key) return null;
  const hit = listTargets().find((t) => t.id === key);
  return hit ? { ...hit } : null;
}

/** 只取 Agent 类目标 */
export function agentTargets() {
  return listTargets().filter((t) => t.kind === "agent");
}

/** 新增或更新一个目标（写回 config.targets） */
export function upsertTarget(input = {}) {
  const incoming = normalizeTarget(input);
  if (!incoming.id) throw new Error("目标缺少 id。");
  const cfg = loadConfig();
  const list = [...(cfg.targets ?? [])];
  const index = list.findIndex((t) => String(t.id) === incoming.id);
  const clean = { ...incoming };
  delete clean.source;
  // 未显式传入 folder 时不写这个键，保留目标上已有的配置
  if (input.folder === undefined) delete clean.folder;
  if (index >= 0) {
    const enabled = input.enabled === undefined ? list[index].enabled !== false : !!input.enabled;
    list[index] = { ...list[index], ...clean, enabled };
  } else {
    list.push(clean);
  }
  saveConfig({ ...cfg, targets: list });
  return resolveTarget(incoming.id);
}

/** 删除一个目标；内置目标只关闭不删除，返回是否发生改动 */
export function deleteTarget(id) {
  const key = String(id ?? "").trim();
  if (!key) return false;
  const cfg = loadConfig();
  const list = (cfg.targets ?? []).filter((t) => String(t.id) !== key);
  if (list.length === (cfg.targets ?? []).length) return false;
  saveConfig({ ...cfg, targets: list });
  return true;
}

// ---------- 模板 ----------

/** 模板变量：{{out}} {{slug}} {{title}} {{date}} {{chat}} 等 */
export function templateVars(payload, target = null) {
  const p = payload && payload.messages ? payload : normalizeDeliveryPayload(payload ?? {});
  const rawOut = target?.out ? expandHome(target.out) : "";
  return {
    out: rawOut || defaultOut(),
    slug: safeFileName(slugify(p.title || p.chat || "微信内容"), "wechat"),
    title: String(p.title || p.chat || "微信内容"),
    date: fmtDay(new Date()),
    chat: String(p.chat || "微信内容"),
    target: String(target?.id ?? ""),
    kind: String(target?.kind ?? ""),
  };
}

/** 替换 {{key}}；未知变量原样保留，避免误伤用户文本 */
export function applyTemplate(text, vars) {
  let out = String(text ?? "");
  for (const key of TEMPLATE_KEYS) {
    if (vars[key] === undefined) continue;
    out = out.split("{{" + key + "}}").join(String(vars[key]));
  }
  return out;
}

// ---------- 载荷渲染 ----------

function stamp(ts) {
  return ts ? fmtLocal(new Date(ts)) : "时间未标注";
}

function renderMarkdown(p, scene, task) {
  const lines = [];
  lines.push("# " + (p.title || p.chat));
  lines.push("");
  lines.push("> 来源群名：" + (p.chat || "未标注") + " · 时间范围：" + (p.sinceMs ? stamp(p.sinceMs) : "未标注") + " ~ " + (p.untilMs ? stamp(p.untilMs) : "未标注") + " · 消息 " + p.count + " 条 · 链接 " + p.links.length + " 条");
  lines.push("");
  lines.push("## 场景要求");
  lines.push("");
  lines.push(task);
  if (scene?.output) {
    lines.push("");
    lines.push("## 输出规范");
    lines.push("");
    lines.push(scene.output);
  }
  lines.push("");
  lines.push("## 消息（" + p.count + " 条）");
  lines.push("");
  if (p.messages.length) {
    for (const m of p.messages) {
      const who = m.is_owner ? m.sender + "（我）" : m.sender;
      lines.push("- **" + stamp(m.ts) + "** " + who + "：" + String(m.content ?? "").replace(/\r?\n/g, " "));
    }
  } else if (p.body.trim()) {
    lines.push(p.body.trim());
  } else {
    lines.push("（无文本内容，见附件）");
  }
  if (p.links.length) {
    lines.push("");
    lines.push("## 链接");
    lines.push("");
    for (const url of p.links) lines.push("- [" + url + "](" + url + ")");
  }
  if (p.files.length) {
    lines.push("");
    lines.push("## 附件");
    lines.push("");
    for (const f of p.files) lines.push("- " + f.name + "（" + f.path + "）");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 统一的转发载荷：标题、Markdown 正文、给 Agent 的提示词、附件清单。
 * @returns {{title:string, markdown:string, prompt:string, files:object[], payload:object, scene:object|null, task:string, vars:object}}
 */
export function renderPayload(payload, target = null, { scene = null } = {}) {
  const t = resolveTarget(target);
  const p = normalizeDeliveryPayload(payload);
  const sceneId = typeof scene === "string" ? scene : (scene?.id ?? null);
  const preview = sceneTaskPreview(sceneId, p);
  const title = p.title || p.chat || "微信内容";
  const vars = templateVars(p, t);
  const markdown = renderMarkdown(p, preview.scene, preview.task);
  const lines = [];
  lines.push(preview.prompt);
  lines.push("");
  lines.push("【附件清单】" + (p.files.length ? p.files.map((f) => f.name + "（" + f.path + "）").join("、") : "无"));
  if (preview.scene?.output) {
    lines.push("");
    lines.push("【输出规范】" + preview.scene.output);
  }
  lines.push("");
  lines.push("【说明】以上内容来自微信群「" + (p.chat || "未标注") + "」的聊天记录，时间范围 " + (p.sinceMs ? stamp(p.sinceMs) : "未标注") + " ~ " + (p.untilMs ? stamp(p.untilMs) : "未标注") + "，共 " + p.count + " 条消息。请直接按要求处理，不要复述本提示词。");
  const prompt = lines.join("\n");
  return {
    title,
    markdown,
    prompt,
    files: p.files,
    payload: p,
    scene: preview.scene,
    task: preview.task,
    vars,
    target: t,
  };
}

// ---------- 投递实现 ----------

function uniqueFile(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate) && n < 10000; n += 1) candidate = path.join(dir, stem + "-" + n + ext);
  return candidate;
}

/** 把附件复制到目标目录（重名追加 -2），单个失败不影响整体 */
export function copyAttachmentsTo(dir, files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return { dir: null, copied: [], failed: [] };
  ensureDir(dir);
  const copied = [];
  const failed = [];
  for (const f of list) {
    const source = typeof f === "string" ? f : f.path;
    const name = safeFileName(typeof f === "string" ? path.basename(f) : (f.name ?? path.basename(f.path)), "attachment");
    if (!source || !fs.existsSync(source)) {
      failed.push({ source, error: "文件不存在" });
      continue;
    }
    const dest = uniqueFile(dir, name);
    try {
      fs.copyFileSync(source, dest);
      copied.push(dest);
    } catch (e) {
      failed.push({ source, error: String(e?.message ?? e) });
    }
  }
  return { dir, copied, failed };
}

function deliverAgent(t, rendered, p) {
  const file = path.resolve(applyTemplate(t.promptFile ?? "{{out}}/{{slug}}.prompt.md", rendered.vars));
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, rendered.prompt, "utf8");
  const bytes = Buffer.byteLength(rendered.prompt, "utf8");
  return {
    status: "ok",
    path: file,
    bytes,
    detail:
      "提示词已写入 " + file + "（" + bytes + " 字节）。请打开该文件并把内容粘贴给「" + t.name +
      "」——Windows 下没有授权通道，wechat-ai 不会激活或自动注入其它应用" +
      (p.files.length ? "；附件仍在本机原路径：" + p.files.map((f) => f.path).join("、") : "") + "。",
  };
}

function deliverObsidian(t, rendered, p) {
  const vault = expandHome(t.vault);
  if (!vault) {
    return { status: "error", detail: "目标「" + t.name + "」还没有配置 Obsidian 知识库目录（vault）。" };
  }
  const note = writeObsidianNote({
    vault,
    folder: t.folder || "微信流",
    title: rendered.title,
    markdown: rendered.markdown,
    attachments: p.files.map((f) => f.path),
    tags: asArray(t.tags).length ? asArray(t.tags) : ["微信流"],
    sourceChat: p.chat,
    sourceUrl: p.links[0] ?? "",
    sinceMs: p.sinceMs,
    untilMs: p.untilMs,
  });
  const failed = note.attachments.filter((a) => !a.target);
  return {
    status: "ok",
    path: note.path,
    bytes: note.bytes,
    files: note.attachmentPaths,
    attachmentPaths: note.attachmentPaths,
    note: note.note,
    detail:
      "已写入 Obsidian 笔记 " + note.path + "（附件 " + note.attachmentPaths.length + " 个）" +
      (failed.length ? "；" + failed.length + " 个附件复制失败：" + failed.map((f) => f.name).join("、") : "") + "。",
  };
}

function deliverClipboard(t, rendered) {
  const text = t.copy === "prompt" ? rendered.prompt : rendered.markdown;
  const written = setClipboardText(text);
  if (written.ok) {
    return {
      status: "ok",
      path: null,
      bytes: written.bytes,
      detail:
        "已写入系统剪贴板（" + written.bytes + " 字节，方式：" + written.via + "）" +
        (written.verified === false ? "；未能校验回读内容，粘贴前请确认。" : "。") +
        (written.warning ? written.warning : ""),
    };
  }
  // 回退：写文件，并明确说明剪贴板没写成功
  const file = uniqueFile(ensureDir(rendered.vars.out), safeFileName(rendered.vars.slug) + ".md");
  fs.writeFileSync(file, text, "utf8");
  return {
    status: "ok",
    degraded: true,
    clipboardError: written.error ?? "未知错误",
    path: file,
    bytes: Buffer.byteLength(text, "utf8"),
    detail:
      "剪贴板写入失败（" + (written.error ?? "未知错误") + "），已回退写入文件 " + file +
      "；请手动打开该文件复制内容。本机剪贴板通道：" + JSON.stringify(clipboardSupport()),
  };
}

function deliverFolder(t, rendered, p) {
  const base = expandHome(t.path);
  if (!base) return { status: "error", detail: "目标「" + t.name + "」还没有配置文件目录（path）。" };
  ensureDir(base);
  const file = uniqueFile(base, safeFileName(rendered.vars.slug) + ".md");
  fs.writeFileSync(file, rendered.markdown, "utf8");
  const copied = copyAttachmentsTo(path.join(base, "attachments"), p.files);
  return {
    status: "ok",
    path: file,
    bytes: Buffer.byteLength(rendered.markdown, "utf8"),
    files: copied.copied,
    detail:
      "已写入 " + file + "（" + copied.copied.length + " 个附件复制到 " + path.join(base, "attachments") + "）" +
      (copied.failed.length ? "；" + copied.failed.length + " 个附件复制失败：" + copied.failed.map((f) => f.source).join("、") : "") + "。",
  };
}

/** 命令分词：支持单/双引号与反斜杠转义，绝不交给 shell 解释 */
export function parseCommand(command) {
  const text = String(command ?? "").trim();
  if (!text) return [];
  const argv = [];
  let current = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // 双引号内只有 \" 与 \\ 视为转义；其余反斜杠按字面保留（Windows 路径 D:\Users\... 必须原样传下去）
      if (quote === '"' && ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) {
        current += text[i + 1];
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has || current) { argv.push(current); current = ""; has = false; }
      continue;
    }
    current += ch;
  }
  if (has || current) argv.push(current);
  return argv;
}

function deliverCustom(t, rendered, p) {
  const argv = parseCommand(t.command);
  if (!argv.length) return { status: "error", detail: "目标「" + t.name + "」还没有配置 command。" };
  const outDir = rendered.vars.out;
  ensureDir(outDir);
  const slug = safeFileName(rendered.vars.slug);
  const payloadFile = path.join(outDir, slug + ".payload.json");
  const markdownFile = path.join(outDir, slug + ".md");
  const payload = {
    schema: "wechat-ai/target-payload@1",
    target: { id: t.id, name: t.name, kind: t.kind },
    title: rendered.title,
    chat: p.chat,
    sinceMs: p.sinceMs,
    untilMs: p.untilMs,
    scene: rendered.scene ? { id: rendered.scene.id, name: rendered.scene.name, task: rendered.task } : null,
    markdown: rendered.markdown,
    prompt: rendered.prompt,
    files: p.files,
    payload: p,
  };
  fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(markdownFile, rendered.markdown, "utf8");
  const env = {
    ...process.env,
    WECHAT_AI_PAYLOAD: payloadFile,
    WECHAT_AI_MARKDOWN: markdownFile,
    WECHAT_AI_TITLE: rendered.title,
    WECHAT_AI_CHAT: String(p.chat ?? ""),
    WECHAT_AI_TARGET: t.id,
  };
  let run;
  try {
    run = spawnSync(argv[0], [...argv.slice(1), payloadFile], {
      windowsHide: true,
      shell: false,
      cwd: t.cwd ? expandHome(t.cwd) : undefined,
      env,
      encoding: "utf8",
      timeout: Number.isFinite(Number(t.timeoutMs)) ? Number(t.timeoutMs) : 60000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    return { status: "error", path: payloadFile, detail: "执行自定义命令失败：" + String(e?.message ?? e) };
  }
  if (run.error) {
    return { status: "error", path: payloadFile, exitCode: null, detail: "执行自定义命令失败：" + String(run.error.message ?? run.error) + "；载荷文件已保留在 " + payloadFile };
  }
  const stderr = String(run.stderr ?? "").trim();
  const stdout = String(run.stdout ?? "").trim();
  return {
    status: run.status === 0 ? "ok" : "error",
    path: payloadFile,
    exitCode: run.status,
    stderr: stderr,
    stdout: stdout,
    detail:
      "已执行 " + argv[0] + "（退出码 " + run.status + "），载荷文件 " + payloadFile +
      (stderr ? "；stderr：" + truncate(stderr.replace(/\s+/g, " "), 300) : "；stderr 为空") +
      (stdout ? "；stdout 摘要：" + truncate(stdout.replace(/\s+/g, " "), 200) : ""),
  };
}

/**
 * 投递一次载荷。
 * @param {object|string} payload 待转发内容（Inbox 条目/消息数组/裸文本）
 * @param {{target: string|object, scene?: string|object|null, dryRun?: boolean, entryId?: string}} options
 * @returns {{target:string, targetName:string, kind:string, status:'ok'|'skipped'|'error', path:string|null, bytes:number|null, detail:string, files:object[], id:string|null}}
 */
export function deliver(payload, { target, scene = null, dryRun = false, entryId = null } = {}) {
  const t = resolveTarget(target);
  const at = Date.now();
  if (!t) {
    const detail = "未知转发目标：" + (typeof target === "string" ? target : JSON.stringify(target ?? null));
    return { target: typeof target === "string" ? target : null, targetName: "", kind: "", status: "error", path: null, bytes: null, detail, files: [], id: null, at };
  }
  let rendered;
  try {
    rendered = renderPayload(payload, t, { scene });
  } catch (e) {
    return { target: t.id, targetName: t.name, kind: t.kind, status: "error", path: null, bytes: null, detail: "渲染载荷失败：" + String(e?.message ?? e), files: [], id: null, at };
  }
  const p = rendered.payload;

  const finish = (result) => {
    // 演练没有失败可言；关闭的目标被跳过也不算成功记录
    const ok = dryRun ? true : result.status === "ok";
    const fileList = result.files ?? [];
    const detail = String(result.detail ?? "");
    const id = recordOperation({
      action: dryRun ? "dry-run" : "forward",
      target: t.id,
      title: rendered.title,
      chars: rendered.markdown.length,
      files: fileList,
      payload: {
        target: { id: t.id, name: t.name, kind: t.kind },
        scene: rendered.scene ? { id: rendered.scene.id, name: rendered.scene.name } : null,
        title: rendered.title,
        markdown: rendered.markdown,
        prompt: rendered.prompt,
        payload: p,
      },
      ok,
      ts: at,
    });
    recordDelivery({ entryId, target: t.id, status: result.status, detail, path: result.path ?? null });
    return {
      target: t.id,
      targetName: t.name,
      kind: t.kind,
      status: result.status,
      path: result.path ?? null,
      bytes: result.bytes ?? null,
      detail,
      files: fileList,
      id,
      at,
      ...(result.degraded ? { degraded: true, clipboardError: result.clipboardError } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode, stderr: result.stderr ?? "" } : {}),
      ...(result.attachmentPaths ? { attachmentPaths: result.attachmentPaths } : {}),
    };
  };

  if (dryRun) {
    const planned = t.kind === "agent"
      ? path.resolve(applyTemplate(t.promptFile ?? "{{out}}/{{slug}}.prompt.md", rendered.vars))
      : t.kind === "folder" && t.path
        ? path.join(expandHome(t.path), safeFileName(rendered.vars.slug) + ".md")
        : null;
    return finish({ status: "skipped", path: planned, bytes: null, detail: "演练模式：未写入任何文件、未改动剪贴板。" });
  }

  if (t.enabled === false) {
    return finish({
      status: "skipped",
      path: null,
      bytes: null,
      detail: "目标「" + t.name + "」处于关闭状态（enabled=false），未投递。可在 config.targets 或 upsertTarget 中启用。",
    });
  }

  try {
    if (t.kind === "agent") return finish(deliverAgent(t, rendered, p));
    if (t.kind === "obsidian") return finish(deliverObsidian(t, rendered, p));
    if (t.kind === "clipboard") return finish(deliverClipboard(t, rendered));
    if (t.kind === "folder") return finish(deliverFolder(t, rendered, p));
    if (t.kind === "custom") return finish(deliverCustom(t, rendered, p));
    return finish({ status: "error", path: null, bytes: null, detail: "不支持的目标类型：" + t.kind });
  } catch (e) {
    return finish({ status: "error", path: null, bytes: null, detail: "投递失败：" + String(e?.message ?? e) });
  }
}

/** 目标一览（含是否可用），便于 CLI/工具展示 */
export function targetsSummary() {
  return listTargets().map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    enabled: t.enabled !== false,
    configured:
      t.kind === "obsidian" ? !!expandHome(t.vault)
        : t.kind === "folder" ? !!expandHome(t.path)
          : t.kind === "custom" ? !!String(t.command ?? "").trim()
            : true,
  }));
}

