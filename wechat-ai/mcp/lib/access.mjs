// 接入状态机：access-plan / compat-check / reader 自检 / 能力汇总 / Windows 接入路线
// 对应上游 rion-wechat-reader 的 access_plan、wechat_intelligence_hub.py 的 run_compatibility_check。
// 红线：不获取密钥、不解密、不注入、不 Hook；只读取用户提供的已解密副本或导出目录。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { ensureHome, paths } from "./paths.mjs";
import { configExists, loadConfig } from "./config.mjs";
import { getSource, listSources, pickReader } from "./reader/index.mjs";
import { ensureDir, fmtIso, readJson, uniq, writeJson } from "./util.mjs";

export const READER_VERSION = "1.0.0";
export const RETRY_POLICY = "同样的错误不循环重试；条件改变后再检查。";

const CORE_STATE_COUNTS = [
  "configured_message_databases",
  "missing_databases",
  "core_databases_without_key",
  "account_candidates",
  "session",
  "contact",
  "messages",
  "scanned_databases",
  "unresolved_databases",
];

const IGNORED_MEDIA_DIRS = new Set(["attach", "attachments", "cache", "file", "files", "image", "images", "tmp", "video", "videos", "emoji", "sns"]);

function defaultDatabaseRoots() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return [
      path.join(home, "Documents", "xwechat_files"),
      path.join(home, "Documents", "WeChat Files"),
      path.join(home, "AppData", "Roaming", "Tencent", "WeChat"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library", "Containers", "com.tencent.xinWeChat", "Data", "Library", "Application Support", "com.tencent.xinWeChat"),
      path.join(home, "Library", "Containers", "com.tencent.xinWeChat", "Data", "Documents", "xwechat_files"),
    ];
  }
  return [path.join(home, "Documents", "xwechat_files")];
}

function defaultDatabaseRoot() {
  for (const candidate of defaultDatabaseRoots()) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* 不存在则继续 */
    }
  }
  return null;
}

function redactPath(value) {
  let out = String(value == null ? "" : value);
  const home = os.homedir();
  if (home) out = out.split(home).join("~");
  out = out.replace(/wxid_[A-Za-z0-9_-]+/g, "<wechat-id>");
  out = out.replace(/\S+@chatroom/g, "<chatroom-id>");
  return out;
}

/** 错误信息脱敏（换行→空格、路径→~、微信 id→占位符、截断 240 字） */
export function sanitizeError(error) {
  const text = String((error && error.message) || error || "");
  const out = redactPath(text).replace(/\r?\n/g, " ").trim();
  return out.length > 240 ? out.slice(0, 239) + "…" : out;
}

function isPlaintextSqlite(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(16);
      const read = fs.readSync(fd, buffer, 0, 16, 0);
      return read === 16 && buffer.toString("utf8") === "SQLite format 3\u0000";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function openReadOnly(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    try {
      const db = new DatabaseSync(file);
      db.exec("PRAGMA query_only=ON");
      return db;
    } catch {
      return null;
    }
  }
}

/** 读取明文 SQLite 的表名并按 session/contact/messages 分类 */
export function inspectPlainDatabase(file) {
  const db = openReadOnly(file);
  if (!db) return null;
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    const kinds = new Set();
    for (const table of tables) {
      const lower = table.toLowerCase();
      if (lower.startsWith("session")) kinds.add("session");
      if (lower.startsWith("contact")) kinds.add("contact");
      if (lower.startsWith("msg_") || lower.startsWith("message")) kinds.add("messages");
    }
    return { tables, kinds: [...kinds] };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function hasMessageTables(file) {
  const info = inspectPlainDatabase(file);
  return Boolean(info && info.tables.length);
}

function accountRootsOf(root) {
  const out = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, "db_storage");
      try {
        if (fs.statSync(candidate).isDirectory()) out.push(candidate);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  const direct = path.join(root, "db_storage");
  try {
    if (fs.statSync(direct).isDirectory()) out.push(direct);
  } catch {
    /* ignore */
  }
  return out;
}

/** 只读扫描候选数据库：识别明文 SQLite，统计无法打开/加密的文件 */
export function discoverDatabases(root, maxFiles, keysFile) {
  const result = {
    root: path.resolve(root),
    scanned_file_count: 0,
    unresolved_database_count: 0,
    scan_error_count: 0,
    truncated: false,
    candidates: { session: [], contact: [], messages: [] },
  };
  const storageRoots = accountRootsOf(root);
  const searchRoots = storageRoots.length ? storageRoots : [root];
  let scanned = 0;
  let stop = false;
  for (const searchRoot of searchRoots) {
    if (stop) break;
    const stack = [{ dir: searchRoot, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      if (depth > 6) continue;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        result.scan_error_count += 1;
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_MEDIA_DIRS.has(entry.name.toLowerCase())) continue;
          stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".db")) continue;
        if (scanned >= maxFiles) {
          result.truncated = true;
          stop = true;
          break;
        }
        scanned += 1;
        if (!isPlaintextSqlite(full)) {
          result.unresolved_database_count += 1;
          continue;
        }
        const info = inspectPlainDatabase(full);
        if (!info || !info.kinds.length) {
          result.unresolved_database_count += 1;
          continue;
        }
        for (const kind of info.kinds) {
          if (result.candidates[kind]) result.candidates[kind].push(path.resolve(full));
        }
      }
    }
  }
  result.scanned_file_count = scanned;
  result.keys_file_supplied = Boolean(keysFile);
  for (const kind of Object.keys(result.candidates)) result.candidates[kind] = uniq(result.candidates[kind]);
  return result;
}

function materialEntries(material) {
  if (!material || typeof material !== "object") return {};
  if (material.salt_keys && typeof material.salt_keys === "object") return material.salt_keys;
  if (material.keys && typeof material.keys === "object") return material.keys;
  const out = {};
  for (const [key, value] of Object.entries(material)) {
    if (["database_root", "db_root", "schema_version", "wxid", "image_key"].includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** 访问材料权限：POSIX 要求 600；Windows ACL 需用户自行确认，本项目不自动放权 */
export function keyFileIsSafe(file) {
  try {
    const stat = fs.statSync(file);
    if (process.platform === "win32") return true;
    return (stat.mode & 0o077) === 0;
  } catch {
    return true;
  }
}

/**
 * 接入诊断：只做只读检查，不获取密钥、不写配置、不执行 provider。
 * 状态优先级（首个命中即返回）：
 * unsafe_key_permissions → invalid_access_material →
 * （存在配置文件且未显式给 root/keys 时）ready / database_missing / needs_access / dependency_required / verification_failed →
 * needs_database_location → account_selection_required → filesystem_access_required → scan_incomplete →
 * database_layout_ambiguous → partial → needs_access → dependency_required → verification_failed →
 * ready_to_configure → database_layout_unsupported → configuration_check_failed
 */
export function accessPlan({ databaseRoot, keysFile, maxFiles = 500 } = {}) {
  ensureHome();
  const result = {
    schema_version: 1,
    environment: { system: process.platform, architecture: process.arch, reader_version: READER_VERSION, node: process.version },
    state: "needs_database_location",
    live_database_read_ok: false,
    scope: "not_verified",
    performed: { key_acquisition: false, configuration_write: false, provider_execution: false },
    counts: Object.fromEntries(CORE_STATE_COUNTS.map((k) => [k, 0])),
    retry_policy: RETRY_POLICY,
    provider: {
      mode: "external_optional_not_executed",
      compatibility: "not_tested_by_this_check",
      confirmation_required: ["process_access", "wechat_restart_or_resign", "administrator_credential_storage"],
    },
    message: "",
    next_actions: [],
  };
  const finish = (state, message, actions) => {
    result.state = state;
    result.message = message;
    const list = (Array.isArray(actions) ? actions : [actions]).filter(Boolean);
    result.next_actions = list.length ? list : ["按提示修正本机条件后重新运行 access-plan。"];
    return result;
  };
  const fileLimit = Math.max(1, Number(maxFiles) || 500);

  try {
    const configPath = paths().config;
    const hasConfig = configExists() && fs.existsSync(configPath);
    const explicitKeys = keysFile ? path.resolve(String(keysFile)) : null;
    const envKeys = process.env.WECHAT_AI_KEYS ? path.resolve(String(process.env.WECHAT_AI_KEYS)) : null;
    const defaultKeys = path.join(paths().home, "keys.json");
    const selectedKeys = explicitKeys || envKeys || (fs.existsSync(defaultKeys) ? defaultKeys : null);

    if (selectedKeys && fs.existsSync(selectedKeys) && !keyFileIsSafe(selectedKeys)) {
      return finish(
        "unsafe_key_permissions",
        "访问材料权限未通过检查，尚未读取其内容。",
        process.platform === "win32"
          ? "用 Windows ACL 收紧该文件权限，只允许本人账户读取；不要靠 chmod 模式位判断。"
          : "把该文件的权限收紧为 600（仅本人可读写）后再运行。",
      );
    }

    let material = {};
    if (selectedKeys && fs.existsSync(selectedKeys)) {
      const raw = readJson(selectedKeys, null);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return finish(
          "invalid_access_material",
          "访问材料无法读取或不是 JSON 对象。",
          "检查用户明确提供的文件与格式；不要打印文件内容或填入示例 key。",
        );
      }
      material = raw;
    }
    const entries = materialEntries(material);
    const hasMaterial = Boolean(entries && Object.keys(entries).length);

    // ---- 已有配置且未显式指定 root/keys：先判断现网是否可读 ----
    if (hasConfig && !databaseRoot && !keysFile) {
      const cfg = loadConfig({ reload: true });
      const sources = (cfg.sqliteSources || []).filter((s) => s.enabled !== false && s.path);
      result.counts.configured_message_databases = sources.length;
      const existing = sources.map((s) => path.resolve(String(s.path))).filter((p) => fs.existsSync(p));
      result.counts.missing_databases = sources.length - existing.length;
      const readable = existing.filter((p) => isPlaintextSqlite(p) && hasMessageTables(p));
      if (readable.length) {
        result.live_database_read_ok = true;
        result.scope = "configured_local_databases_only";
        result.counts.core_databases_without_key = 0;
        return finish("ready", "已有配置可读，无需重新获取 key。", [
          "直接使用读取命令；抽检所需私聊、群聊、标签和时间范围。",
          "读取成功只代表本机已解密副本可读，不代表手机完整历史已同步。",
        ]);
      }
      if (result.counts.missing_databases > 0) {
        return finish("database_missing", "配置指向的部分数据库已不存在。", [
          "核对当前账号、迁移和数据库位置；不要先重新获取 key。",
          "确认路径后重跑 access-plan。",
        ]);
      }
      const notPlain = existing.filter((p) => !isPlaintextSqlite(p));
      result.counts.core_databases_without_key = notPlain.filter(() => !hasMaterial).length;
      if (result.counts.core_databases_without_key > 0) {
        return finish("needs_access", "部分核心数据库缺少匹配的访问材料。", [
          "已有材料可显式导入；没有材料则先阅读接入指引，确认合法来源。",
          "不要循环 setup：材料没有变化时重跑不会改变结果。",
        ]);
      }
      if (notPlain.length && hasMaterial) {
        return finish("dependency_required", "有访问材料，但当前运行环境缺少 SQLCipher 依赖。", [
          "Node 侧不支持 SQLCipher：请提供已解密副本或导出目录。",
          "安装依赖后重跑 compat-check，不要重复获取 key。",
        ]);
      }
      if (existing.length) {
        return finish("verification_failed", "现有材料或数据库结构未通过读取验证。", [
          "分别核对材料、加密参数与数据库结构；此结果不能证明一定是 key 错误。",
          "必要时重新导出明文副本后再检查。",
        ]);
      }
    }

    // ---- 目录定位 ----
    let root = databaseRoot ? path.resolve(String(databaseRoot)) : null;
    if (!root) {
      const bundled = material.database_root || material.db_root;
      if (bundled) root = path.resolve(String(bundled));
    }
    if (!root) root = defaultDatabaseRoot();
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return finish("needs_database_location", "尚未找到所选账号的数据库目录。", [
        "确认本人微信已登录并有本地记录；显式指定 --database-root。",
        "本命令不会全盘搜索 key，也不会自动解密。",
      ]);
    }

    const accountRoots = accountRootsOf(root);
    if (accountRoots.length > 1) {
      result.counts.account_candidates = accountRoots.length;
      return finish("account_selection_required", "发现多个账号目录，未自动选择或读取数据库。", [
        "由用户确认目标账号，再指定该账号的 db_storage 目录。",
        "不要自动合并多个账号的数据。",
      ]);
    }

    const discovery = discoverDatabases(root, fileLimit, selectedKeys);
    result.counts.session = discovery.candidates.session.length;
    result.counts.contact = discovery.candidates.contact.length;
    result.counts.messages = discovery.candidates.messages.length;
    result.counts.scanned_databases = discovery.scanned_file_count;
    result.counts.unresolved_databases = discovery.unresolved_database_count;

    if (discovery.scan_error_count) {
      return finish("filesystem_access_required", "扫描存在文件访问错误，结果不完整。", [
        "核对所选目录的文件访问权限后重试。",
        "完全磁盘访问不等于进程调试权限。",
      ]);
    }
    if (discovery.truncated) {
      return finish("scan_incomplete", "达到数据库扫描上限，不能据此判定完整覆盖。", [
        "缩小到单一账号目录后重试。",
        "或显式提高 --max-files 再检查。",
      ]);
    }
    if (result.counts.session > 1 || result.counts.contact > 1) {
      return finish("database_layout_ambiguous", "核心数据库候选不唯一。", [
        "明确目标目录，或通过配置指定具体数据库。",
        "不能自动合并账号数据。",
      ]);
    }

    const coreFound = result.counts.session === 1 && result.counts.contact === 1 && result.counts.messages > 0;
    if (result.counts.unresolved_databases > 0) {
      if (coreFound) {
        result.scope = "partial_candidates_only";
        return finish("partial", "已识别核心数据库，但仍有未能识别或打开的数据库。", [
          "核对缺失项与目标时间范围；可以配置已验证的核心库。",
          "不可读文件也可能是损坏，不等于都已证明加密；不可声称全量覆盖。",
        ]);
      }
      if (!hasMaterial) {
        return finish("needs_access", "存在不能直接读取的数据库，尚无访问材料。", [
          "先确认这些文件是加密还是损坏；不要急着重装。",
          "如已有合法材料，显式导入后再检查。",
        ]);
      }
      return finish("dependency_required", "有访问材料，但当前运行环境缺少 SQLCipher 依赖。", [
        "Node 侧不支持 SQLCipher：请改用已解密的副本或导出目录。",
        "不要重复获取 key：材料没有变化时结果不会改变。",
      ]);
    }
    if (coreFound) {
      return finish("ready_to_configure", "核心数据库候选可读，尚未写入配置。", [
        "用相同的 database-root 写入配置（本项目只写本地配置，不解密、不取 key）。",
        "配置后运行 compat-check 与真实数据抽检。",
      ]);
    }
    return finish("database_layout_unsupported", "未识别到所需的核心数据库结构。", [
      "核对目录与微信版本；不要将结构不支持当成缺 key。",
      "如果是导出目录，请确认包含会话/联系人/消息表。",
    ]);
  } catch (error) {
    return finish("configuration_check_failed", "配置或本地文件检查失败，详细原文未输出以免泄露隐私。", [
      "在本机检查配置字段和文件访问，修复后重试。",
      "不要提交原始配置或诊断原文到 Issue。",
      sanitizeError(error) ? "本机错误摘要：" + sanitizeError(error) : "",
    ]);
  }
}

function cacheIsFresh(previous, identity, maxAgeHours) {
  if (!previous || !["ready", "degraded"].includes(String(previous.result))) return false;
  if (String(previous.source || "") !== String(identity.source || "")) return false;
  if (String(previous.reader?.version || "") !== String(identity.readerVersion || "")) return false;
  if (String(previous.reader?.path || "") !== String(identity.readerPath || "")) return false;
  const checked = Date.parse(String(previous.checked_at || ""));
  if (Number.isNaN(checked)) return false;
  return Date.now() - checked <= Math.max(0.1, Number(maxAgeHours) || 6) * 3600000;
}

function readerDescriptor(sourceId, reader) {
  const id = String(sourceId || "");
  if (id.includes(":")) return redactPath(id.slice(id.indexOf(":") + 1));
  return redactPath(id || (reader && reader.id) || "(内存数据源)");
}

/**
 * 实时只读通道兼容检查。
 * 缓存写到 paths().cache/compat-latest.json；沿用 ≤ maxAgeHours。
 * 隐私：缓存只保存计数、能力布尔值和脱敏错误，绝不含消息正文或会话 id。
 */
export async function compatCheck({ source, force = false, maxAgeHours = 6 } = {}) {
  ensureHome();
  const cacheFile = path.join(paths().cache, "compat-latest.json");
  const previous = readJson(cacheFile, null);
  const picked = pickReader({ source, allowDemo: false });
  const reader = picked.reader;
  let version = "unknown";
  let readerName = picked.sourceId || "local";
  if (reader) {
    try {
      const info = await reader.version();
      version = String(info?.data?.version || "unknown");
      readerName = String(info?.data?.reader || readerName);
    } catch (error) {
      version = "unknown";
    }
  }
  const readerPath = readerDescriptor(picked.sourceId, reader);
  const identity = { source: picked.sourceId || "local", readerVersion: version, readerPath };

  const base = {
    checked_at: new Date().toISOString(),
    result: "blocked",
    version_changed: false,
    cache_reused: false,
    source: identity.source,
    reader: { path: readerPath, version, name: readerName, reason: picked.reason },
    checks: {
      status: { ok: false, live_read_ok: false, readiness: "unknown" },
      sessions: { ok: false, count: 0 },
      timeline: { ok: false, attempted: false, count: 0 },
    },
    capabilities: {},
    warnings: [],
    missing_capabilities: [],
    errors: [],
    next_action: "",
  };

  if (!force && cacheIsFresh(previous, identity, maxAgeHours)) {
    return { ...previous, cache_reused: true };
  }

  const report = { ...base, checked_at: new Date().toISOString() };
  report.version_changed = Boolean(previous && (previous.reader?.version !== version || previous.source !== identity.source));

  if (!reader) {
    report.errors.push("未找到可用数据源：" + sanitizeError(picked.reason || identity.source));
    report.next_action = "已阻止实时读取。先用 db-search 查历史情报库，更新读取适配器后重跑 compat-check。";
    writeJson(cacheFile, report);
    return report;
  }

  try {
    const statusEnvelope = await reader.status();
    const data = (statusEnvelope && statusEnvelope.data) || {};
    const declared = data.capabilities && typeof data.capabilities === "object" ? data.capabilities : {};
    report.capabilities = Object.fromEntries(Object.entries(declared).map(([k, v]) => [k, Boolean(v)]));
    report.warnings = Array.isArray(data.warnings) ? data.warnings.map((w) => sanitizeError(w)).filter(Boolean) : [];
    const state = String(data.state || "unknown");
    const readiness = String(data.readiness || (state === "ready" ? "ready" : state));
    const liveReadOk = Boolean(data.live_database_read_ok ?? data.live_read_ok ?? state === "ready");
    report.checks.status = { ok: statusEnvelope.ok !== false, live_read_ok: liveReadOk, readiness };
  } catch (error) {
    report.errors.push("status: " + sanitizeError(error));
  }

  let smoke = null;
  try {
    const sessionsEnvelope = await reader.sessions({ limit: 3 });
    const rows = (sessionsEnvelope && sessionsEnvelope.data && sessionsEnvelope.data.sessions) || [];
    report.checks.sessions = { ok: sessionsEnvelope.ok !== false, count: rows.length };
    smoke = rows.find((row) => row && (row.username || row.talker || row.chatroom_id || row.session_id || row.name)) || null;
  } catch (error) {
    report.errors.push("sessions: " + sanitizeError(error));
  }

  if (smoke) {
    report.checks.timeline.attempted = true;
    const talker = String(smoke.username || smoke.talker || smoke.chatroom_id || smoke.session_id || smoke.name);
    try {
      const timelineEnvelope = await reader.timeline(talker, { limit: 1 });
      const rows = (timelineEnvelope && timelineEnvelope.data && timelineEnvelope.data.messages) || [];
      report.checks.timeline = { ok: timelineEnvelope.ok !== false, attempted: true, count: rows.length };
    } catch (error) {
      // 错误信息里的会话标识必须替换掉，缓存不得含会话 id
      const message = sanitizeError(error).split(talker).join("<session-id>");
      report.errors.push("timeline: " + message);
    }
  }

  const statusOk = report.checks.status.ok && report.checks.status.live_read_ok;
  const sessionsOk = report.checks.sessions.ok;
  const timelineOk = report.checks.timeline.attempted ? report.checks.timeline.ok : false;
  const coreOk = Boolean(statusOk && sessionsOk && timelineOk);
  const declaredNames = Object.keys(report.capabilities);
  report.missing_capabilities = declaredNames.length
    ? ["sessions", "timeline", "search"].filter((name) => !report.capabilities[name])
    : [];
  const readiness = report.checks.status.readiness;
  if (coreOk && readiness === "ready" && !report.warnings.length && !report.missing_capabilities.length) report.result = "ready";
  else if (coreOk) report.result = "degraded";
  else report.result = "blocked";

  report.next_action =
    report.result === "ready"
      ? "实时只读通道可用，可继续生成日报和检索。"
      : report.result === "degraded"
        ? "实时读取可用，但存在非核心警告；可继续使用并关注后续更新。"
        : "已阻止实时读取。先用 db-search 查历史情报库，更新读取适配器后重跑 compat-check。";

  writeJson(cacheFile, report);
  return report;
}

/** 读取适配器自检：Node 侧无 SQLCipher，必须如实说明只支持已解密副本 */
export async function readerSelfTest({ source } = {}) {
  const checks = { sqlite: false, snapshot: false, query_only: false };
  const notes = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-ai-self-test-"));
  const file = path.join(dir, "self-test.db");
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec("CREATE TABLE probe(value TEXT)");
      db.prepare("INSERT INTO probe VALUES(?)").run("ok");
      checks.sqlite = true;
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    const copy = path.join(dir, "snapshot.db");
    fs.copyFileSync(file, copy);
    const ro = openReadOnly(copy);
    if (ro) {
      try {
        checks.snapshot = String(ro.prepare("SELECT value FROM probe").get().value) === "ok";
        ro.exec("PRAGMA query_only=ON");
        try {
          ro.prepare("INSERT INTO probe VALUES(?)").run("blocked");
          checks.query_only = false;
        } catch {
          checks.query_only = true;
        }
      } catch (error) {
        notes.push("快照读取失败：" + sanitizeError(error));
      } finally {
        try {
          ro.close();
        } catch {
          /* ignore */
        }
      }
    }
  } catch (error) {
    notes.push("SQLite 自检失败：" + sanitizeError(error));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  let zstandard = { available: false, roundtrip: false };
  try {
    const probe = Buffer.from("wcdb-zstandard-ok", "utf8");
    const packed = zlib.zstdCompressSync(probe);
    zstandard = { available: true, roundtrip: zlib.zstdDecompressSync(packed).toString("utf8") === "wcdb-zstandard-ok" };
  } catch {
    zstandard = { available: false, roundtrip: false };
  }

  const sqlcipher = { available: false, driver: "", roundtrip: false };
  notes.push("Node 内置 node:sqlite 不支持 SQLCipher：本项目只支持已解密副本或导出目录，不获取密钥、不解密、不注入、不 Hook。");
  if (!zstandard.available) notes.push("当前 Node 缺少 zstandard 支持：部分压缩字段需要 Node 22.15+ 才能解压。");

  let readerState = null;
  try {
    const picked = pickReader({ source, allowDemo: false });
    if (picked.reader) {
      const status = await picked.reader.status();
      readerState = { source: picked.sourceId, state: status?.data?.state ?? "unknown", live_database_read_ok: Boolean(status?.data?.live_database_read_ok) };
    }
  } catch (error) {
    notes.push("数据源状态读取失败：" + sanitizeError(error));
  }

  return {
    passed: Boolean(checks.sqlite && checks.snapshot && checks.query_only),
    checks,
    sqlcipher,
    sqlcipher_required: false,
    zstandard,
    reader: readerState,
    notes,
  };
}

/** 汇总各数据源的能力与状态 */
export async function capabilityReport({ source } = {}) {
  const sources = listSources({ probe: true });
  const picked = pickReader({ source, allowDemo: false });
  const notes = [];
  let status = null;
  let describe = null;
  if (picked.reader) {
    try {
      status = (await picked.reader.status()).data || null;
    } catch (error) {
      notes.push("状态读取失败：" + sanitizeError(error));
    }
    try {
      describe = picked.reader.describe ? await picked.reader.describe() : null;
    } catch (error) {
      notes.push("能力读取失败：" + sanitizeError(error));
    }
  }
  const declared = status && status.capabilities && typeof status.capabilities === "object" ? status.capabilities : {};
  const capabilities = Object.fromEntries(Object.entries(declared).map(([k, v]) => [k, Boolean(v)]));
  return {
    source: picked.sourceId,
    reason: picked.reason,
    state: (status && status.state) || "unknown",
    live_database_read_ok: Boolean(status && status.live_database_read_ok),
    capabilities,
    describe: describe
      ? {
          root: describe.root ? redactPath(describe.root) : undefined,
          plaintext_databases: describe.plaintext_databases,
          encrypted_databases: describe.encrypted_databases,
          session_dbs: describe.session_dbs,
          contact_dbs: describe.contact_dbs,
          message_dbs: describe.message_dbs,
          errors: Array.isArray(describe.errors) ? describe.errors.map(sanitizeError) : [],
        }
      : null,
    sources: sources.map((s) => ({ id: s.id, kind: s.kind, name: s.name, available: Boolean(s.available), probe: s.probe || null })),
    notes,
  };
}

/** Windows 接入路线：社区经验尚未纳入本仓库，本命令不做任何获取动作 */
export function windowsAccessRoute() {
  return {
    status: "community_report_not_integrated",
    reported_dll_version: "4.1.13.12",
    reference: "references/windows-access.md",
    acquisition_performed: false,
    note: "本项目不获取密钥、不解密、不注入、不 Hook；只读取用户提供的已解密副本或导出目录。",
  };
}

/** 状态 → 中文说明（供 CLI 直接展示） */
export function accessStateLabel(state) {
  const labels = {
    ready: "已有配置可读",
    ready_to_configure: "可读，等待写入配置",
    needs_access: "缺少访问材料",
    dependency_required: "缺少读取依赖",
    verification_failed: "材料或结构未通过验证",
    database_missing: "配置指向的数据库不存在",
    needs_database_location: "未找到数据库目录",
    account_selection_required: "需要选择账号目录",
    filesystem_access_required: "目录权限不足",
    scan_incomplete: "扫描不完整",
    database_layout_ambiguous: "数据库候选不唯一",
    database_layout_unsupported: "数据库结构不支持",
    partial: "仅核心候选可读",
    unsafe_key_permissions: "访问材料权限过宽",
    invalid_access_material: "访问材料格式无效",
    configuration_check_failed: "配置检查失败",
  };
  return labels[String(state)] || "未知状态";
}

export { redactPath, uniq, fmtIso, ensureDir, getSource };
