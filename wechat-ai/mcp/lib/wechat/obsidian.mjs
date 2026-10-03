// Obsidian 笔记与附件：把一次转发落成一篇自包含的 Markdown 笔记。
// 文件名规则：<YYYY-MM-DD> <安全标题>.md，重名时追加 -2、-3……
// 附件统一复制到 <vault>/<folder>/attachments/，图片用 ![[文件名]] 嵌入，其它文件用 [[文件名]] 链接。
import fs from "node:fs";
import path from "node:path";
import { fmtDay, readText, safeFileName } from "../util.mjs";

/** 目录名安全化：按 / 拆成多级，逐级安全化后重新拼接 */
export function subfolderPath(raw, fallback = "微信流") {
  const parts = String(raw ?? "")
    .split(/[\\/]+/)
    .map((p) => safeFileName(p, ""))
    .filter(Boolean);
  return parts.length ? parts.join(path.sep) : fallback;
}

/** 笔记目录：<vault>/<folder> */
export function noteDir(vault, folder = "微信流") {
  const root = String(vault ?? "").trim();
  if (!root) throw new Error("尚未配置 Obsidian 知识库目录。");
  return path.join(path.resolve(root), subfolderPath(folder));
}

/** 附件目录：<vault>/<folder>/attachments */
export function attachmentsDir(vault, folder = "微信流") {
  return path.join(noteDir(vault, folder), "attachments");
}

function toDay(date) {
  if (!date) return fmtDay(new Date());
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? fmtDay(new Date()) : fmtDay(d);
}

function toStamp(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p2 = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
}

/** YAML 标量：含特殊字符时加双引号并转义 */
function yamlScalar(value) {
  const s = String(value ?? "");
  if (s === "") return '""';
  if (/^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\-./\u4e00-\u9fa5 ]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s)) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n") + '"';
}

/** 笔记首选路径（不做重名避让）：<vault>/<folder>/<YYYY-MM-DD> <安全标题>.md */
export function notePathFor(vault, folder, title, date) {
  const safe = safeFileName(title, "微信内容");
  return path.join(noteDir(vault, folder), toDay(date) + " " + safe + ".md");
}

/** 重名避让：<名字>.md → <名字>-2.md → <名字>-3.md */
export function uniqueNotePath(preferred) {
  if (!fs.existsSync(preferred)) return preferred;
  const ext = path.extname(preferred);
  const stem = preferred.slice(0, preferred.length - ext.length);
  for (let n = 2; n < 10000; n += 1) {
    const candidate = stem + "-" + n + ext;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return stem + "-" + Date.now() + ext;
}

function uniqueInDir(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate) && n < 10000; n += 1) {
    candidate = path.join(dir, stem + "-" + n + ext);
  }
  return candidate;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".avif", ".tiff"]);

/** 是否图片附件（决定用 ![[]] 还是 [[]]） */
export function isImageAttachment(name) {
  return IMAGE_EXT.has(path.extname(String(name ?? "")).toLowerCase());
}

/** Obsidian wikilink 安全化：转义会破坏链接语法的字符 */
function wikiEscape(name) {
  return String(name ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/#/g, "\\#")
    .replace(/\^/g, "\\^")
    .replace(/\|/g, "\\|");
}

/** 挂载附件：返回 [{source, name, target, markdown}]，同时把文件复制到 attachments 目录 */
function copyAttachments(vault, folder, attachments) {
  const list = (attachments ?? []).filter(Boolean);
  if (!list.length) return [];
  const dir = attachmentsDir(vault, folder);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const raw of list) {
    const item = typeof raw === "string" ? { path: raw } : raw;
    const source = String(item.path ?? item.file ?? "").trim();
    if (!source) continue;
    const name = safeFileName(item.name ?? path.basename(source), "attachment");
    const target = uniqueInDir(dir, name);
    try {
      fs.copyFileSync(source, target);
    } catch (e) {
      // 单个附件复制失败不影响笔记：在正文里如实标注，不假装已归档。
      out.push({ source, name, target: null, markdown: "（附件复制失败：" + name + "）", error: String(e?.message ?? e) });
      continue;
    }
    const saved = path.basename(target);
    const kind = item.kind ?? (isImageAttachment(saved) ? "image" : "file");
    out.push({
      source,
      name: saved,
      target,
      bytes: (() => { try { return fs.statSync(target).size; } catch { return null; } })(),
      kind,
      markdown: kind === "image" ? "![[" + wikiEscape(saved) + "]]" : "[[" + wikiEscape(saved) + "]]",
    });
  }
  return out;
}

/** 纯渲染：给定内容生成笔记全文（不落盘），便于预览与测试 */
export function renderNoteMarkdown({
  title,
  markdown = "",
  tags = [],
  sourceChat = "",
  sourceUrl = "",
  sinceMs = null,
  untilMs = null,
  date = null,
  attachmentItems = [],
} = {}) {
  const created = toStamp(date ?? new Date());
  const lines = ["---"];
  lines.push("title: " + yamlScalar(title));
  lines.push("created: " + yamlScalar(created));
  lines.push("source: wechat-ai");
  lines.push("chat: " + yamlScalar(sourceChat));
  lines.push("url: " + yamlScalar(sourceUrl));
  const tagList = (tags ?? []).map((t) => String(t).trim()).filter(Boolean);
  lines.push("tags: [" + tagList.map((t) => yamlScalar(t)).join(", ") + "]");
  if (sinceMs) lines.push("since: " + yamlScalar(toStamp(sinceMs)));
  if (untilMs) lines.push("until: " + yamlScalar(toStamp(untilMs)));
  lines.push("---", "", "# " + String(title ?? "微信内容"), "");
  const body = String(markdown ?? "").trim();
  if (body) lines.push(body);
  if (attachmentItems.length) {
    lines.push("", "## 附件", "");
    for (const item of attachmentItems) lines.push("- " + item.markdown);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 写一篇 Obsidian 笔记。
 * @returns {{path:string, attachmentPaths:string[], note:string, fileName:string, frontmatter:object, bytes:number, attachments:object[]}}
 */
export function writeObsidianNote({
  vault,
  folder = "微信流",
  title,
  markdown = "",
  attachments = [],
  tags = [],
  sourceChat = "",
  sourceUrl = "",
  sinceMs = null,
  untilMs = null,
  date = null,
} = {}) {
  const root = noteDir(vault, folder);
  fs.mkdirSync(root, { recursive: true });
  const attachmentItems = copyAttachments(vault, folder, attachments);
  const note = renderNoteMarkdown({
    title,
    markdown,
    tags,
    sourceChat,
    sourceUrl,
    sinceMs,
    untilMs,
    date,
    attachmentItems,
  });
  const target = uniqueNotePath(notePathFor(vault, folder, title, date));
  fs.writeFileSync(target, note, "utf8");
  return {
    path: target,
    attachmentPaths: attachmentItems.filter((a) => a.target).map((a) => a.target),
    note,
    fileName: path.basename(target),
    bytes: Buffer.byteLength(note, "utf8"),
    frontmatter: {
      title: String(title ?? ""),
      created: toStamp(date ?? new Date()),
      source: "wechat-ai",
      chat: String(sourceChat ?? ""),
      url: String(sourceUrl ?? ""),
      tags: (tags ?? []).map(String),
    },
    attachments: attachmentItems,
  };
}

/** 解析 frontmatter 的少量字段（只读前 40 行，够用且便宜） */
function readFrontmatter(file) {
  const text = readText(file);
  if (!text.startsWith("---")) return {};
  const out = {};
  const lines = text.replace(/\r\n/g, "\n").split("\n").slice(1, 40);
  for (const line of lines) {
    if (line.trim() === "---") break;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/s, "$1").replace(/\\n/g, "\n");
  }
  return out;
}

/** 列出笔记目录下的 Markdown 笔记（按修改时间倒序，默认 50 条） */
export function listNotes({ vault, folder = "微信流", limit = 50 } = {}) {
  let dir;
  try {
    dir = noteDir(vault, folder);
  } catch {
    return [];
  }
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => {
      const full = path.join(dir, f);
      let st = null;
      try { st = fs.statSync(full); } catch { /* 忽略 */ }
      const fm = readFrontmatter(full);
      return {
        path: full,
        name: f,
        title: fm.title ?? f.replace(/\.md$/i, ""),
        chat: fm.chat ?? "",
        created: fm.created ?? "",
        tags: (fm.tags ?? "").replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean),
        bytes: st?.size ?? 0,
        mtime: st?.mtimeMs ?? 0,
      };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(0, limit));
}
