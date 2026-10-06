// Reader 注册表：统一选择可用的只读数据源
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.mjs";
import { paths } from "../paths.mjs";
import { storeStats } from "../store.mjs";
import { createCliReader } from "./cli.mjs";
import { createLocalReader } from "./local.mjs";
import { createMockReader } from "./mock.mjs";
import { createSqliteReader } from "./sqlite.mjs";
import { createVaultReader } from "./vault.mjs";
import { createWcdbReader } from "./wcdb.mjs";

const _cache = new Map();

export function cliReaders(cfg = loadConfig()) {
  const out = [];
  for (const r of cfg.readers ?? []) {
    if (r.enabled === false) continue;
    if (!r.command) continue;
    out.push(createCliReader({ id: r.id, name: r.name, command: r.command, args: r.args ?? [], cwd: r.cwd, env: r.env }));
  }
  return out;
}

export function vaultDirs(cfg = loadConfig()) {
  const dirs = (cfg.vaults ?? []).filter((v) => v.enabled !== false).map((v) => v.path).filter(Boolean);
  if (!dirs.length) dirs.push(paths().vault);
  return dirs;
}

/** 列出所有可用数据源及其状态（不含凭据） */
export function listSources({ probe = false } = {}) {
  const cfg = loadConfig({ reload: true });
  const stats = storeStats();
  const vaultDirsList = vaultDirs(cfg);
  const sqliteRoots = (cfg.sqliteSources ?? []).filter((s) => s.enabled !== false).map((s) => s.path).filter(Boolean);
  const sources = [];
  sources.push({
    id: "local", kind: "local", name: "本地索引",
    detail: `${stats.messages} 条消息 / ${stats.sessions} 个会话`,
    available: stats.messages > 0,
    last_index_ts: stats.lastIndexTs, last_message_ts: stats.lastMessageTs,
  });
  for (const d of vaultDirsList) {
    const exists = fs.existsSync(d);
    sources.push({ id: `vault:${d}`, kind: "vault", name: `导出目录 ${path.basename(d) || d}`, path: d, available: exists, detail: exists ? "存在" : "目录不存在" });
  }
  for (const s of sqliteRoots) {
    const exists = fs.existsSync(s);
    sources.push({ id: `sqlite:${s}`, kind: "sqlite", name: `解密数据库 ${path.basename(s)}`, path: s, available: exists, detail: exists ? "存在" : "路径不存在" });
    sources.push({ id: `wcdb:${s}`, kind: "wcdb", name: `微信 4.x db_storage ${path.basename(s)}`, path: s, available: exists, detail: exists ? "存在" : "路径不存在" });
  }
  for (const r of cfg.readers ?? []) {
    if (r.enabled === false || !r.command) continue;
    const cmdOk = fs.existsSync(r.command) || /^[a-zA-Z0-9_.-]+$/.test(r.command);
    sources.push({ id: `cli:${r.id ?? r.command}`, kind: "cli", name: r.name ?? r.id ?? r.command, command: r.command, args: r.args ?? [], available: cmdOk, detail: cmdOk ? "已配置" : "命令不存在" });
  }
  sources.push({ id: "mock", kind: "mock", name: "演示数据（虚构）", available: true, detail: "零数据验证全链路" });

  if (probe) {
    return sources.map((s) => {
      const reader = getSource(s.id);
      return { ...s, probe: reader ? "ready" : "unavailable" };
    });
  }
  return sources;
}

/** 取一个具体数据源实例 */
export function getSource(id) {
  const cfg = loadConfig({ reload: true });
  const key = String(id ?? "").trim();
  const cacheKey = `${key}|${cfg.readers?.length ?? 0}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);
  let reader = null;

  if (key === "local") reader = createLocalReader();
  else if (key === "mock" || key === "demo") reader = createMockReader();
  else if (key.startsWith("vault")) {
    const p = key.includes(":") ? key.slice(key.indexOf(":") + 1) : null;
    reader = createVaultReader({ dirs: p ? [p] : undefined });
  } else if (key.startsWith("sqlite")) {
    const p = key.includes(":") ? key.slice(key.indexOf(":") + 1) : null;
    reader = createSqliteReader({ roots: p ? [p] : (cfg.sqliteSources ?? []).map((s) => s.path).filter(Boolean) });
  } else if (key === "wcdb" || key.startsWith("wcdb:")) {
    const p = key.includes(":") ? key.slice(key.indexOf(":") + 1) : null;
    reader = createWcdbReader({ roots: p ? [p] : (cfg.sqliteSources ?? []).map((s) => s.path).filter(Boolean) });
  } else if (key.startsWith("cli:")) {
    const rid = key.slice(4);
    const conf = (cfg.readers ?? []).find((r) => (r.id ?? r.command) === rid);
    if (conf) reader = createCliReader({ id: conf.id, name: conf.name, command: conf.command, args: conf.args ?? [], cwd: conf.cwd, env: conf.env });
  } else {
    const conf = (cfg.readers ?? []).find((r) => r.id === key);
    if (conf) reader = createCliReader({ id: conf.id, name: conf.name, command: conf.command, args: conf.args ?? [], cwd: conf.cwd, env: conf.env });
  }
  if (reader) _cache.set(cacheKey, reader);
  return reader;
}

/** 按优先级挑选可用数据源：显式指定 > cli > sqlite > vault > local > mock */
export function pickReader({ source, allowDemo = false, preferIndexed = false } = {}) {
  const cfg = loadConfig({ reload: true });
  if (source) {
    // 显式点名的路径型 source 指向不存在的路径必须报错（F14）：静默空集与 wai_scan/
    // wai_vault_scan 的「扫描目标不存在」是两种语义。与 getSource 同款解析（前缀+冒号后路径），
    // 只拦显式点名；无路径的 vault/sqlite 默认通道缺失仍走 needs_access/空集设计态
    // （vault_status 依赖），getSource/pickReadyReader 的探测路径也依赖其不抛错。
    const k = String(source);
    const fam = ["vault", "sqlite", "wcdb"].find((f) => k.startsWith(f));
    if (fam && k.includes(":")) {
      const p = k.slice(k.indexOf(":") + 1);
      if (p && !fs.existsSync(p)) throw new Error("扫描目标不存在：" + p);
    }
    const r = getSource(source);
    return { reader: r, sourceId: source, reason: "显式指定" };
  }
  const explicit = cfg.settings?.reader;
  if (explicit && explicit !== "auto") {
    const r = getSource(explicit);
    if (r) return { reader: r, sourceId: explicit, reason: "配置指定" };
  }
  const order = [];
  for (const r of cfg.readers ?? []) if (r.enabled !== false && r.command) order.push(`cli:${r.id ?? r.command}`);
  for (const s of cfg.sqliteSources ?? []) if (s.enabled !== false && s.path && fs.existsSync(s.path)) order.push(`sqlite:${s.path}`);
  if (preferIndexed) order.push("local");
  if (vaultDirs(cfg).some((d) => fs.existsSync(d))) order.push("vault");
  order.push("local");
  if (allowDemo) order.push("mock");
  for (const id of order) {
    const r = getSource(id);
    if (r) return { reader: r, sourceId: id, reason: `自动选择（${id}）` };
  }
  return { reader: createLocalReader(), sourceId: "local", reason: "回退到本地索引" };
}

/** 依次尝试各数据源，返回第一个 status().state === 'ready' 的 */
export async function pickReadyReader({ allowDemo = false } = {}) {
  const cfg = loadConfig({ reload: true });
  const tried = [];
  const explicit = cfg.settings?.reader;
  const order = [];
  if (explicit && explicit !== "auto") order.push(explicit);
  for (const r of cfg.readers ?? []) if (r.enabled !== false && r.command) order.push(`cli:${r.id ?? r.command}`);
  for (const s of cfg.sqliteSources ?? []) if (s.enabled !== false && s.path) order.push(`sqlite:${s.path}`);
  for (const d of vaultDirs(cfg)) order.push(`vault:${d}`);
  order.push("local");
  if (allowDemo) order.push("mock");
  for (const id of order) {
    const r = getSource(id);
    if (!r) continue;
    try {
      const st = await r.status();
      tried.push({ id, state: st.data?.state ?? "unknown" });
      if (st.data?.state === "ready") return { reader: r, sourceId: id, status: st, tried };
    } catch (e) {
      tried.push({ id, state: "error", error: String(e.message ?? e) });
    }
  }
  return { reader: null, sourceId: null, tried };
}

export function clearReaderCache() {
  _cache.clear();
}
