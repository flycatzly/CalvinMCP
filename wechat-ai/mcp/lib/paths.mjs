// 路径与数据根解析：wechat-ai 本地数据根（默认 ~/.wechat-ai）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 包根目录（wechat-ai/） */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MCP_DIR = path.join(PKG_ROOT, "mcp");
export const ASSETS_DIR = path.join(PKG_ROOT, "assets");
export const SAMPLES_DIR = path.join(PKG_ROOT, "samples");

/** 数据根：WECHAT_AI_HOME 优先，其次 ~/.wechat-ai */
/**
 * Windows 扩展长度路径。
 * SQLite / CreateFileW 默认受 MAX_PATH(260) 限制，深目录下会直接 "unable to open database file"。
 * 超过阈值时加 \\\\?\\ 前缀（必须是绝对路径且使用反斜杠）。
 */
export function longPath(target) {
  if (process.platform !== "win32") return target;
  const abs = path.resolve(target);
  if (abs.startsWith("\\\\?\\")) return abs;
  if (abs.length < 240) return abs;
  return "\\\\?\\" + abs.replace(/\//g, "\\");
}

/** 目录创建同样走长路径前缀，失败时回退普通创建 */
export function mkdirLong(dir) {
  try {
    fs.mkdirSync(longPath(dir), { recursive: true });
    return true;
  } catch {
    try { fs.mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
  }
}

export function home() {
  const env = process.env.WECHAT_AI_HOME;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), ".wechat-ai");
}

function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 返回全部数据路径（必要时建目录） */
export function paths() {
  const h = home();
  return {
    home: h,
    config: path.join(h, "config.json"),
    profile: path.join(h, "profile.json"),
    store: path.join(h, "store.db"),
    inbox: path.join(h, "inbox"),
    inboxNew: path.join(h, "inbox", "new"),
    inboxProcessing: path.join(h, "inbox", "processing"),
    inboxProcessed: path.join(h, "inbox", "processed"),
    inboxFailed: path.join(h, "inbox", "failed"),
    vault: path.join(h, "vault"),
    output: path.join(h, "output"),
    logs: path.join(h, "logs"),
    cache: path.join(h, "cache"),
    contacts: path.join(h, "contacts"),
  };
}

/** 建好所有目录 */
export function ensureHome() {
  const p = paths();
  for (const key of ["home", "inbox", "inboxNew", "inboxProcessing", "inboxProcessed", "inboxFailed", "vault", "output", "logs", "cache", "contacts"]) {
    mk(p[key]);
  }
  return p;
}

export function runDir(kind, stamp) {
  const p = paths();
  return mk(path.join(p.output, `${kind}-${stamp}`));
}

export function timestampSlug(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
