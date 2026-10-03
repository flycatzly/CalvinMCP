#!/usr/bin/env node
/**
 * calvin-db-mcp — MySQL + PostgreSQL MCP server (stdio, JSON-RPC 2.0)
 *
 * Design goals:
 *  1. LLM-friendly: discovery tools (list_sources/list_tables/describe_table),
 *     reading (query/sample_data) and verification (count_rows/sample_data) return compact JSON.
 *  2. Safe by default: read-only SQL guard (lexer-level), single statement only,
 *     automatic row limit, statement timeout, no DDL, UPDATE/DELETE require WHERE.
 *  3. Zero protocol frameworks: hand-rolled MCP stdio loop; only mysql2 + pg drivers.
 *
 * Env:
 *  DBMCP_CONFIG  path to config JSON (default: dbmcp.config.json next to this file)
 *  DBMCP_NO_LISTEN=1  do not start the stdio loop (used by selftest)
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { selfCheck as cryptoSelfCheck } from "./crypt.mjs";
// v1.5.0: crypt2（enc2: 前缀，AES-256-GCM + scrypt，主密钥 DBMCP_MASTER_KEY）与旧格式
// 按前缀分派解密（decryptAny）；无主密钥时写入仍走旧格式（encryptForConfig），向后兼容。
import { decryptAny, isEnc2, masterKeyBound } from "./crypt2.mjs";
// v1.1.1: SQL 安全核心拆分到 guard.mjs（纯函数、零依赖、可独立审计）；此处导入自用并重导出，
//         对外 API 面（selftest 经 server.mjs 导入）保持不变。
import {
  sanitizeSql, stripComments, stripLeadingComments, guardReadOnly, guardWrite, extractWriteTarget,
  enforceLimit, checkWhereFragment, createTableGuard, createTableName,
} from "./guard.mjs";
import { createPoolManager } from "./pool.mjs";
export {
  sanitizeSql, stripComments, guardReadOnly, guardWrite, extractWriteTarget,
  whereHasColumn, exprHasColumn, extractWhereClause,
  enforceLimit, checkWhereFragment, createTableGuard, createTableName,
} from "./guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// v1.0.3: 版本单一真相源是 package.json（与 package-lock 对齐）；文件缺失/损坏时回退硬编码值。
// 旧版三处手改（server/package.json/文档）已出现漂移史，此处消除 server 侧的手同步。
function pkgVersion(fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || fallback;
  } catch { return fallback; }
}
export const VERSION = pkgVersion("1.6.2");

/* ------------------------- v1.2.0 SQLite 支持（助手） ------------------------- */

/**
 * 解析 sqlite 源的数据库文件路径：url 形如 "sqlite://D:/x.db" 或 "sqlite:///abs/path"，
 * 也接受裸路径字段 file 或裸路径 url。不存在时返回 null。纯函数供单测。
 */
export function sqliteFilePath(src) {
  const raw = (src && (src.file || src.url)) || "";
  const s = String(raw);
  if (!s) return null;
  if (src && src.file) return String(src.file);
  if (/^sqlite:/i.test(s)) {
    const p = s.replace(/^sqlite:\/\//i, "").replace(/^sqlite:/i, "");
    return p || null;
  }
  // 裸路径：win 盘符（X:\ 或 X:/）、posix 绝对路径、相对路径——排除其它 scheme（mysql: 等不算路径）
  return /^([A-Za-z]:[\\/]|\/|\.\.?[/\\])/.test(s) ? s : null;
}

/** 词法掩码方言映射：SQLite 字符串无反斜杠转义（'' 翻倍即转义），与 PG standard_conforming_strings 同语义 */
export function maskDialect(dbType) {
  return dbType === "mysql" ? "mysql" : "postgres";
}

/**
 * v1.2.1: SQLite 只读 PRAGMA 白名单（仅 sqlite 源的 query 工具放行）。
 * 只放行元数据读取类 pragma；任何会修改数据库设置/数据的 pragma（journal_mode、busy_timeout、
 * writable_schema 等）都不在白名单。纯函数供单测。
 */
const READONLY_PRAGMA_RE = /^\s*pragma\s+(table_info|table_list|index_list|index_info|foreign_key_list|database_list|schema_version)\b\s*(\(\s*['"`]?[\w$.]+['"`]?\s*\))?\s*;?\s*$/i;
export function isReadOnlyPragma(sql) {
  // v1.5.0: 先剥前导注释——旧版正则 ^\s*pragma 遇 `/* c */ PRAGMA …` 误判为非白名单而拒真只读语句；
  // 可执行注释（/*!、/*M!）由 stripLeadingComments fail-closed 返回空串 → 不匹配白名单。
  return READONLY_PRAGMA_RE.test(stripLeadingComments(String(sql || "")));
}

/* ---------------------------------- config --------------------------------- */

function loadConfig() {
  const file = process.env.DBMCP_CONFIG || path.join(__dirname, "dbmcp.config.json");
  if (!fs.existsSync(file)) {
    // 未初始化模式：默认没有连接配置，提示导入 DBeaver 导出项目后再使用
    console.error("[calvin-db-mcp] 尚未初始化连接配置（dbmcp.config.json 不存在）。");
    console.error("[calvin-db-mcp] 请先执行: node import-dbeaver.mjs <DBeaver导出的.dbp文件>");
    console.error("[calvin-db-mcp] 初始化前 list_sources 会返回 init_required 提示，其余工具暂不可用。");
    return {
      maxRows: 200, timeoutMs: 30000, allowWrites: false, maxAffectedRows: 500,
      sources: {}, __file: file, __initRequired: true,
    };
  }
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.maxRows = clampInt(cfg.maxRows, 1, 5000, 200);
  cfg.timeoutMs = clampInt(cfg.timeoutMs, 1000, 600000, 30000);
  cfg.allowWrites = cfg.allowWrites === true;
  // 影响行数预检上限（v1.0.1）：execute 前先 COUNT 同一 WHERE，超过该值即拒绝；0 = 关闭预检
  cfg.maxAffectedRows = Number(cfg.maxAffectedRows) === 0 ? 0 : clampInt(cfg.maxAffectedRows, 1, 1e9, 500);
  cfg.sources = cfg.sources || {};
  cfg.__file = file;
  return cfg;
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * v1.0.2: 校验「用户传入」的整数参数。
 * 旧版对外部参数也直接用 clampInt，于是 limit=-5 / limit=0 / limit="abc" 会被静默夹成 1，
 * 用户以为拿到了 5 条却只得到 1 条，且毫无提示——比直接报错更容易误导。
 * 规则：缺失 → 用默认值；非整数/非正数 → 报错；合法正数 → 夹到 [min, max]。
 */
export function intArg(v, name, min, max, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid '${name}': expected an integer, got ${JSON.stringify(v)}.`);
  }
  if (n < min) throw new Error(`Invalid '${name}': must be >= ${min}, got ${n}.`);
  return Math.min(max, n);
}

const cfg = loadConfig();

/* --------------------------- url 解密（enc → url，仅驻内存） --------------------------- */
// dbmcp.config.json 中的 url 以 enc 字段加密存储。v1.5.0 起两种格式按前缀分派（decryptAny）：
//  - enc2:…  = AES-256-GCM + scrypt，密钥绑定环境变量 DBMCP_MASTER_KEY（≥8 字符），可轮换；
//  - 无前缀  = 旧格式（AES-128-CBC 落盘混淆，静态派生密钥，向后兼容）。
// 解密结果只驻内存，不落盘、不进任何输出。
if (cfg.__initRequired) {
  console.error("[calvin-db-mcp] 运行于未初始化模式：执行 node import-dbeaver.mjs <DBeaver导出的.dbp文件> 完成初始化。");
} else if (!cryptoSelfCheck()) {
  console.error("[calvin-db-mcp] 加密模块自检失败（密钥派生漂移？），拒绝启动。");
  process.exit(1);
}
for (const [id, s] of Object.entries(cfg.sources)) {
  if (s.enc && !s.url) {
    try {
      s.url = decryptAny(s.enc);
    } catch (e) {
      console.error(`[calvin-db-mcp] source '${id}' 的 enc 解密失败: ${e.message}`);
      process.exit(1);
    }
  }
}
// 归一化 source 类型（仅在此加载阶段改写；工具调用期 getSource 不再改动共享配置对象）
for (const s of Object.values(cfg.sources)) {
  const declared = String(s.type || "").toLowerCase();
  // v1.2.0: sqlite 类型——声明 type: "sqlite" 直接通过；url 以 sqlite: 开头的也归为 sqlite
  s.type = declared ? (declared === "oceanbase" ? "mysql" : declared)
                    : (/^postgres/i.test(String(s.url || "")) ? "postgres"
                       : /^sqlite:/i.test(String(s.url || "")) ? "sqlite"
                       : "mysql");
}

/* ------------------------------ 外发防护（no-leak guard） ------------------------------ */

// 1) 输出清洗：任何工具响应/报错文本在出口处统一清洗已配置的口令（含 URL 编码变体）。
//    只清洗口令，不清洗用户名/主机——避免误伤正常查询结果（如数据恰含 "root" 字样）。
/**
 * 从源配置构造输出清洗用的口令变体列表。v1.5.1 补洞：
 * - user:pass 结构化形态（连接串泄露的最常见形态）无论口令长短一律清洗，且含 URL 编码变体；
 *   变体不含尾部 @——替换后保留 @ 分隔符（"mysql://***@host" 形态，与 curl 脱敏一致）；
 * - 裸口令仅 ≥4 字符参与清洗——1-3 字符替换会把正常文本打成筛子（如口令 "ab" 把 every/able 全打掉），
 *   误伤大于收益，故不清洗，但经 shortIds 返回由启动警告提示换强口令。
 * 排序按长度降序：长变体（user:pass）先于裸口令替换，避免留下 "user:***" 残片泄露用户名。
 */
export function secretListFromSources(sources) {
  const set = new Set();
  const shortIds = [];
  for (const [id, s] of Object.entries(sources || {})) {
    try {
      const u = new URL(s.url);
      if (!u.password) continue;
      if (u.password.length < 4) shortIds.push(id);
      set.add(`${u.username}:${u.password}`);
      set.add(`${u.username}:${encodeURIComponent(u.password)}`);
      if (u.password.length >= 4) {
        set.add(u.password);
        set.add(encodeURIComponent(u.password));
        set.add(encodeURI(u.password));
      }
    } catch { /* 非法 url：跳过该源 */ }
  }
  return { list: [...set].sort((a, b) => b.length - a.length), shortIds };
}

/** scrub 的纯函数形态（list 显式传入，供自测直接断言清洗行为） */
export function scrubWith(text, list) {
  let t = String(text);
  for (const k of list) if (t.includes(k)) t = t.split(k).join("***");
  return t;
}

const { list: SECRET_LIST, shortIds: SHORT_PWD_IDS } = secretListFromSources(cfg.sources);
if (SHORT_PWD_IDS.length) {
  console.error(`[calvin-db-mcp] 警告: 源 ${SHORT_PWD_IDS.join(", ")} 的口令长度 <4，裸口令不参与输出清洗（防误伤正常文本）；user:pass@ 结构化形态仍会清洗。建议改用更长口令。`);
}

/** 供自测/审计读取已加载的口令变体列表（解密后的内存态） */
export function getConfiguredSecrets() {
  return SECRET_LIST;
}

/** 将文本中出现的任何已配置口令替换为 ***（所有工具响应统一出口处调用）。includes 预判避免无命中时反复重建字符串 */
export function scrub(text) {
  return scrubWith(text, SECRET_LIST);
}

// 2) 启动门禁：含明文凭据的配置文件不允许被 git 跟踪、必须被 .gitignore 忽略（防随仓库外发）。
function guardConfigNotExportable() {
  const file = cfg.__file;
  const dir = path.dirname(file);
  const git = (args) => {
    try {
      execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
      return 0;
    } catch (e) {
      return e.status ?? null; // 1=未忽略/未跟踪, 128=非git仓库, null=git不可用
    }
  };
  if (git(["ls-files", "--error-unmatch", file]) === 0) {
    console.error(`[calvin-db-mcp] 拒绝启动: ${file} 含明文凭据且已被 git 跟踪（.gitignore 对已跟踪文件无效）。请执行: git rm --cached 后重启。`);
    process.exit(1);
  }
  if (git(["check-ignore", "--quiet", file]) === 1) {
    console.error(`[calvin-db-mcp] 拒绝启动: ${file} 含明文凭据但未被 .gitignore 忽略，存在随仓库外发风险。请先将其加入 .gitignore 再重启。`);
    process.exit(1);
  }
  // 0=已忽略；128/null=非 git 仓库或 git 不可用 → 跳过检查
}
if (!cfg.__initRequired) guardConfigNotExportable();

/* --------------------------- SQL guard（见 guard.mjs） --------------------------- */
// v1.1.1: 词法掩码/只读与写守卫/恒真 WHERE 判定/写目标解析/enforceLimit/createTable 守卫
// 全部拆分至 guard.mjs（纯函数、零依赖、可独立审计），在文件头 import 并重导出。
// v1.4.0: 连接层（三库池管理 + runQuery 读写分流）拆分至 pool.mjs，见 getSource 之后的构造。

const INIT_HINT =
  "尚未初始化连接配置：请执行 node import-dbeaver.mjs <DBeaver导出的.dbp文件> 生成 dbmcp.config.json，然后重启 MCP server。";

function getSource(id) {
  if (cfg.__initRequired) throw new Error(INIT_HINT);
  const s = cfg.sources[id];
  if (!s || !s.url) {
    const names = Object.keys(cfg.sources).join(", ") || "(none)";
    throw new Error(`Unknown source '${id}'. Available sources: ${names}`);
  }
  // v1.0.1: 类型归一化移至加载期，工具调用期不再改写共享配置对象
  if (s.type !== "mysql" && s.type !== "postgres" && s.type !== "sqlite") {
    throw new Error(`Source '${id}' has unsupported type '${s.type}' (mysql | postgres | oceanbase-as-mysql | sqlite).`);
  }
  return s;
}

// v1.4.0: 连接层拆分至 pool.mjs（依赖注入 cfg/getSource/clampInt/sqliteFilePath），此处构造单例
// v1.5.3: 注入 scrub（慢查询日志的 SQL 预览同过输出清洗）+ 解构 withTransaction（import atomic）
const { getPool, runQuery, withTransaction } = createPoolManager({ cfg, getSource, clampInt, sqliteFilePath, scrub });

/* ------------------------------ identifier utils ---------------------------- */

function splitIdent(table) {
  const parts = String(table).split(".");
  if (parts.length > 2) throw new Error(`Invalid table name: ${table}`);
  const [t, s] = [parts[parts.length - 1], parts.length === 2 ? parts[0] : null];
  for (const p of [t, s].filter(Boolean)) {
    if (!/^[A-Za-z_][\w$]*$/.test(p)) {
      throw new Error(`Invalid identifier '${p}'. Pass plain names; use the schema parameter instead of qualified names.`);
    }
  }
  return { table: t, schema: s };
}

/**
 * v1.5.0: 标识符引用转义——旧版盲包裹，名称内嵌的引号字符会逃逸出标识符位（注入面）。
 * 名称并非都来自调用方：fkRelationships 等会把库内读回的表/列名拼进 PRAGMA/SQL，库内字符串不可信。
 * mysql 反引号双写、postgres/sqlite 双引号双写。纯函数供单测。
 */
export function quoteIdent(dbType, name) {
  const n = String(name);
  return dbType === "mysql" ? "`" + n.replace(/`/g, "``") + "`" : '"' + n.replace(/"/g, '""') + '"';
}

/** 表引用（schema.table），按方言加引号 */
function tableRef(dbType, schema, table) {
  return (schema ? quoteIdent(dbType, schema) + "." : "") + quoteIdent(dbType, table);
}

function parseDsnDatabase(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent((u.pathname || "").replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}

/* --------------------------------- JSON out --------------------------------- */

// v1.0.1: 默认紧凑输出（缩进对模型无价值：实测 200 行结果省约 31% 字符 ≈ 3.2k tokens/次）；
// 超长单元格截断，避免单个 TEXT/BLOB 列一次吃满上下文。DBMCP_PRETTY=1 可恢复缩进，
// DBMCP_MAX_CELL_CHARS 可调截断阈值（默认 2000）。
const DEFAULT_MAX_CELL_CHARS = 2000;

function maxCellChars() {
  return clampInt(process.env.DBMCP_MAX_CELL_CHARS, 200, 200000, DEFAULT_MAX_CELL_CHARS);
}

function truncateCell(s, max) {
  return s.length > max ? s.slice(0, max) + `… <truncated ${s.length - max} chars>` : s;
}

/** 统计含被截断超长单元格的行数（用于在响应中标注） */
export function countTruncatedCells(rows) {
  const max = maxCellChars();
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const r of rows) {
    if (r && typeof r === "object" && Object.values(r).some((v) => typeof v === "string" && v.length > max)) n++;
  }
  return n;
}

export function stringify(v) {
  const pretty = process.env.DBMCP_PRETTY === "1";
  const max = maxCellChars();
  return JSON.stringify(
    v,
    (k, x) => {
      if (typeof x === "bigint") return x.toString();
      if (typeof x === "number" && !Number.isFinite(x)) return String(x);
      if (typeof x === "string") {
        // 超长文本先清洗口令再截断，避免口令被截成前缀后清洗失效
        return x.length > max ? truncateCell(scrub(x), max) : x;
      }
      if (x && typeof x === "object" && x.type === "Buffer" && Array.isArray(x.data)) {
        // v1.0.2: 附带前 8 字节十六进制预览——二进制主键/UUID 场景下，只有 <binary N bytes> 无法辨认行
        const hex = Buffer.from(x.data).subarray(0, 8).toString("hex");
        return x.data.length > 8 ? `<binary ${x.data.length} bytes: ${hex}…>` : `<binary ${x.data.length} bytes: ${hex}>`;
      }
      return x;
    },
    pretty ? 2 : undefined
  );
}

/* ------------------------------ tool definitions ---------------------------- */

const TOOLS = [
  {
    name: "list_sources",
    description:
      "List configured database connections (MySQL/PostgreSQL/SQLite) with type/host/port/database (SQLite shows the local file path). Call this first to see what you can query.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_tables",
    description:
      "List tables/views of a source with estimated row counts and comments. Use comments and names to locate the right table before querying.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        name_like: { type: "string", description: "Optional case-insensitive substring filter on table/view name (e.g. \"notice\")." },
        limit: { type: "integer", minimum: 1, maximum: 5000, description: "Max tables returned (default 500)." },
      },
      required: ["source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "describe_table",
    description:
      "Show columns (name/type/nullable/default/PK/comment), indexes, table comment and approximate row count. Call before writing SQL against an unfamiliar table.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        table: { type: "string", description: "Table name (plain). Use schema param for another schema." },
        schema: { type: "string" },
      },
      required: ["source", "table"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "find_tables_by_column",
    description:
      "Find tables that contain a column matching a keyword (case-insensitive substring). " +
      "Returns column name/type/PK/comment per match and the distinct table list. " +
      "Use it when you know a column name (e.g. 'order_no') but not which table holds it.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        column: { type: "string", description: "Column name or keyword (case-insensitive substring)." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max column matches returned (default 100)." },
      },
      required: ["source", "column"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fk_relationships",
    description:
      "List foreign-key relationships (table.column -> referenced_table.column) for one table or the whole schema (default limit 200). " +
      "Use it to build correct JOINs and understand referential integrity before writing cross-table queries.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        table: { type: "string", description: "Optional table name. Omit to list all FKs of the schema." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Max relationships returned (default 200)." },
      },
      required: ["source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "query",
    description:
      "Run a READ-ONLY SQL statement: SELECT / WITH...SELECT / SHOW / DESCRIBE / EXPLAIN. Writes, DDL, multi-statements and row locks are blocked. A LIMIT is enforced automatically (default 200 rows). Results: columns, rows (JSON objects), row_count, truncated. For row-count checks use count_rows.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        sql: { type: "string", description: "A single read-only statement. Prefer an explicit LIMIT for large tables." },
        max_rows: { type: "integer", minimum: 1, maximum: 5000, description: "Max rows returned (default from config, usually 200)." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "query_plan",
    description:
      "Run EXPLAIN on a single SELECT / WITH...SELECT statement and return the execution plan (format: 'text' default, or 'json'). " +
      "Read-only: the statement itself is never executed (ANALYZE is not supported). " +
      "Use it to check index usage and row estimates before running an expensive query.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        sql: { type: "string", description: "A single SELECT / WITH...SELECT statement." },
        format: { type: "string", enum: ["text", "json"], description: "Plan format (default 'text')." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "sample_data",
    description:
      "Peek at the first N rows of a table (SELECT * ... LIMIT, default 10, max 50). Optionally filter with a WHERE condition and/or order by a column, e.g. where: \"status = 'SENT'\", order_by: \"created_at DESC\". Quick way to see real data shape and verify content.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        table: { type: "string" },
        schema: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        where: { type: "string", description: "Optional WHERE condition (boolean expression, without the WHERE keyword)." },
        order_by: { type: "string", description: "\"column\" or \"column ASC|DESC\" (e.g. created_at DESC). Defaults to ascending." },
      },
      required: ["source", "table"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "distinct_values",
    description:
      "Top-N value distribution of a column: GROUP BY column ORDER BY count DESC (default 20, max 200), plus the exact distinct total. " +
      "Great for enum/status columns and data verification (compare observed values vs expected set). NULL is one group. Optional where filter. " +
      "Note: counting scans matching rows; prefer a where filter on very large tables.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        table: { type: "string" },
        column: { type: "string", description: "Plain column name (no qualification)." },
        schema: { type: "string" },
        where: { type: "string", description: "Optional WHERE condition (boolean expression, without the WHERE keyword)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max distinct values returned (default 20)." },
      },
      required: ["source", "table", "column"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "column_stats",
    description:
      "Statistical profile of one column in a single aggregate query: row_count, non_null, distinct_values, min/max (lexicographic for text), avg (numeric). " +
      "Optional where filter; optional histogram (equal-width buckets for numeric columns) and top_values (most frequent values). " +
      "Use for data sanity checks: null rate, value ranges, cardinality, distribution shape. Note: COUNT(DISTINCT) scans matching rows on large tables.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        table: { type: "string" },
        column: { type: "string", description: "Plain column name (no qualification)." },
        schema: { type: "string" },
        where: { type: "string", description: "Optional WHERE condition (boolean expression, without the WHERE keyword)." },
        histogram: {
          type: "object",
          properties: { buckets: { type: "integer", description: "Equal-width bucket count for numeric columns (2-50, default 10). NULLs excluded." } },
          description: "Optional per-bucket frequency distribution (one extra whitelisted query).",
        },
        top_values: {
          type: "object",
          properties: { limit: { type: "integer", description: "How many most-frequent values to return (1-100, default 10). NULLs excluded." } },
          description: "Optional most-frequent values with counts (one extra whitelisted query).",
        },
      },
      required: ["source", "table", "column"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "count_rows",
    description:
      "Exact row count of a table, optionally with a WHERE condition (e.g. status = 'SENT' AND created_at >= '2025-01-01'). Use it to verify data: compare counts before/after, assert expected totals, check for duplicates (count vs distinct).",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        table: { type: "string" },
        schema: { type: "string" },
        where: { type: "string", description: "Optional WHERE condition (boolean expression, without the WHERE keyword)." },
      },
      required: ["source", "table"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "execute",
    description:
      "Execute a single INSERT/UPDATE/DELETE (only when allowWrites=true in config; disabled by default). " +
      "SECURITY RED LINE: UPDATE/DELETE without a WHERE clause and TRUNCATE TABLE are ALWAYS refused - " +
      "even if the user explicitly requests full-table changes; direct the user to perform such operations manually via other channels (e.g. DBeaver) with DBA approval. " +
      "DDL is never allowed. Returns affected row count for verification.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        sql: { type: "string", description: "A single INSERT/UPDATE/DELETE statement with explicit WHERE for UPDATE/DELETE." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "create_table",
    description:
      "Create a new table (single CREATE TABLE statement). " +
      "Requires allowCreateTable=true in the config. DROP/TRUNCATE/ALTER and data-changing statements are never allowed. " +
      "OceanBase sources must be MySQL-mode. SQLite: CREATE TABLE without AUTOINCREMENT (use INTEGER PRIMARY KEY for rowid alias). Returns the executed DDL for verification.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        sql: { type: "string", description: "A single CREATE TABLE statement (MySQL or PostgreSQL dialect matching the source type)." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "find_database",
    description:
      "Find configured sources by database name, source id or environment (e.g. 'za_data_notice', 'test', 'TEST', 'pre', 'uat'). " +
      "Returns matching source ids to use as 'source' in other tools. Optionally probes TCP reachability.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Database name / source id / keyword (case-insensitive substring)." },
        env: { type: "string", description: "Optional environment filter: TEST / PRE / UAT / DEV / PROD / OTHER." },
        probe: { type: "boolean", description: "TCP-probe each match (default false, ~2.5s timeout per host)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "export_data",
    description:
      "Export the result of a single read-only SELECT to a CSV or JSON file on the MCP server host. " +
      "Requires DBMCP_EXPORT_DIR (server-side allowlist directory); filenames are sanitized and cannot escape it; refuses to overwrite unless overwrite:true; 20MB size cap. " +
      "Row limit defaults to 5000 (max 100000). Use for handing data to the user or feeding other tools.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        sql: { type: "string", description: "A single read-only SELECT / WITH statement." },
        format: { type: "string", enum: ["csv", "json"], description: "Output format (default csv)." },
        filename: { type: "string", description: "Optional file name (sanitized; auto-generated when omitted). Must stay inside DBMCP_EXPORT_DIR." },
        limit: { type: "integer", minimum: 1, maximum: 100000, description: "Max rows to export (default 5000)." },
        overwrite: { type: "boolean", description: "Overwrite existing file (default false)." },
        raw_formulas: { type: "boolean", description: "CSV only: disable formula-injection neutralization (default false — string cells starting with = + - @ TAB CR get a ' prefix so spreadsheet apps don't execute them)." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "import_data",
    description:
      "Import rows from a CSV file on the MCP server host into a table (INSERT, row-by-row parameterized). " +
      "First CSV line must be plain column names. Requires allowWrites and DBMCP_IMPORT_DIR (or DBMCP_EXPORT_DIR) allowlist directory; " +
      "filenames are sanitized; caps: 10000 rows / 20MB; emptyAsNull maps empty cells to NULL; strip_neutralization reverses " +
      "export_data's formula neutralization (round-trip); atomic wraps the whole file in one transaction (all-or-nothing). " +
      "Aborts on width mismatch or row error.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        table: { type: "string" },
        filename: { type: "string", description: "CSV file name inside the import allowlist directory (first line = column names)." },
        schema: { type: "string" },
        emptyAsNull: { type: "boolean", description: "Treat empty cells as NULL (default false = empty string)." },
        strip_neutralization: { type: "boolean", description: "Reverse export_data's formula neutralization: strip the leading ' from cells like '=1+1 (exact inverse; default false keeps file content as-is)." },
        atomic: { type: "boolean", description: "Wrap the whole file in ONE transaction (all-or-nothing: any error rolls back everything). Default false = per-batch atomicity with row-wise fallback that locates the bad row but keeps earlier rows." },
      },
      required: ["source", "table", "filename"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

const INSTRUCTIONS =
  "calvin-db-mcp: operate MySQL, PostgreSQL, OceanBase (MySQL mode) and local SQLite files across TEST/PRE/UAT/DEV environments. " +
  "Workflow: list_sources/find_database -> list_tables/describe_table/find_tables_by_column/fk_relationships -> " +
  "query/sample_data/distinct_values/column_stats/count_rows (query_plan to check a plan before expensive queries) -> " +
  "execute (INSERT/UPDATE/DELETE when allowWrites=true) / create_table (when allowCreateTable=true). " +
  "export_data writes a read-only query result to a CSV/JSON file (requires DBMCP_EXPORT_DIR on the server host); " +
  "import_data loads a CSV from the import allowlist into a table (parameterized INSERTs, requires allowWrites). " +
  "'query' is strictly read-only (single statement, auto LIMIT, timeout). SECURITY RED LINES: UPDATE/DELETE without WHERE, " +
  "TRUNCATE, and any WHERE that does not reference a real column (1=1, true, 2>1, 'a'='a') are ALWAYS refused even if the user insists. " +
  "UPDATE/DELETE are pre-counted with the same WHERE and refused when they would exceed maxAffectedRows. " +
  "Use find_database to locate a database by name or environment; same-instance cross-database reads work with db.table qualified names. " +
  "Verify affected row counts with count_rows after writes." +
  (cfg.__initRequired
    ? " INIT REQUIRED: config file missing - ask the user to run 'node import-dbeaver.mjs <dbeaver-export.dbp>' in the server directory, then restart."
    : "");

/* --------------------------------- tool impls -------------------------------- */

function listSources() {
  if (cfg.__initRequired) {
    return {
      init_required: true,
      init_command: "node import-dbeaver.mjs <DBeaver导出的.dbp文件>",
      message: INIT_HINT,
      sources: [],
    };
  }
  const items = Object.entries(cfg.sources).map(([id, s]) => {
    let host = null, port = null, database = null;
    if (s.type === "sqlite") {
      // v1.2.0: sqlite 无 host/port，database 字段显示本地文件路径（非凭据，可展示）
      database = sqliteFilePath(s);
    } else {
      try {
        const u = new URL(s.url);
        host = u.hostname;
        port = u.port || (s.type === "mysql" ? "3306" : "5432");
        database = parseDsnDatabase(s.url);
      } catch { /* keep nulls */ }
    }
    return {
      id,
      type: s.type || (/^postgres/i.test(String(s.url)) ? "postgres" : /^sqlite:/i.test(String(s.url)) ? "sqlite" : "mysql"),
      env: s.env || null,
      host,
      port,
      database,
      description: s.description || null,
      allow_writes: cfg.allowWrites === true || s.allowWrites === true,
    };
  });
  return { sources: items, max_rows: cfg.maxRows, timeout_ms: cfg.timeoutMs, notes: "Credentials are never returned." };
}

async function listTables(args) {
  const src = getSource(args.source);
  const schema = args.schema || null;
  const limit = intArg(args.limit, "limit", 1, 5000, 500);
  const nameLike = args.name_like ? String(args.name_like) : null;
  let rows;
  if (src.type === "sqlite") {
    // v1.2.0: sqlite 元数据走 sqlite_master（无表注释/行数估算——SQLite 不存储这些）
    rows = (await runQuery(
      args.source,
      `SELECT name,
              CASE type WHEN 'table' THEN 'table' ELSE 'view' END AS kind,
              NULL AS approx_rows,
              NULL AS comment
         FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND substr(name, 1, 7) <> 'sqlite_'
          AND (? IS NULL OR name LIKE '%' || ? || '%')
        ORDER BY name
        LIMIT ${limit + 1}`,
      [nameLike, nameLike]
    )).rows;
  } else if (src.type === "mysql") {
    ({ rows } = await runQuery(
      args.source,
      `SELECT TABLE_NAME AS name,
              CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'table' ELSE 'view' END AS kind,
              TABLE_ROWS AS approx_rows,
              NULLIF(TABLE_COMMENT, '') AS comment
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
          AND (? IS NULL OR TABLE_NAME LIKE CONCAT('%', ?, '%'))
        ORDER BY TABLE_NAME
        LIMIT ${limit + 1}`,
      [schema, nameLike, nameLike]
    ));
  } else {
    ({ rows } = await runQuery(
      args.source,
      `SELECT c.relname AS name,
              CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table'
                             WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' END AS kind,
              GREATEST(c.reltuples, 0)::bigint AS approx_rows,
              obj_description(c.oid) AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = COALESCE($1, 'public') AND c.relkind IN ('r','p','v','m')
          AND ($2::text IS NULL OR c.relname ILIKE '%' || $2 || '%')
        ORDER BY c.relname
        LIMIT ${limit + 1}`,
      [schema, nameLike]
    ));
  }
  // v1.0.1: 表数量上限（默认 500）+ 名称过滤，避免大库元数据一次刷满上下文
  const truncated = rows.length > limit;
  const tables = truncated ? rows.slice(0, limit) : rows;
  return {
    source: args.source,
    schema: schema || (src.type === "sqlite" ? "(file)" : src.type === "mysql" ? "(connection database)" : "public"),
    table_count: tables.length,
    truncated,
    ...(truncated ? { note: "仅显示前 " + limit + " 张表；可用 name_like 过滤或调大 limit。" } : {}),
    tables,
  };
}

async function describeTable(args) {
  const src = getSource(args.source);
  const split = splitIdent(args.table);
  const schema = args.schema || split.schema;
  const table = split.table;
  if (src.type === "mysql") {
    // v1.0.1: 三条元数据查询彼此独立 → 并行，少 2 次往返（跨网/VPN 场景明显）
    const [cols, idx, meta] = await Promise.all([
      runQuery(
        args.source,
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS col_type, IS_NULLABLE AS nullable,
                COLUMN_DEFAULT AS col_default, COLUMN_KEY AS col_key, EXTRA AS extra,
                COLUMN_COMMENT AS comment
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [schema, table]
      ),
      runQuery(
        args.source,
        `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique,
                GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
          GROUP BY INDEX_NAME, NON_UNIQUE
          ORDER BY INDEX_NAME`,
        [schema, table]
      ),
      runQuery(
        args.source,
        `SELECT TABLE_ROWS AS approx_rows, NULLIF(TABLE_COMMENT, '') AS table_comment
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`,
        [schema, table]
      ),
    ]);
    if (!cols.rows.length) throw new Error(`Table '${table}' not found in schema '${schema || "(connection database)"}'.`);
    return {
      source: args.source, table, schema: schema || "(connection database)",
      approx_rows: meta.rows[0]?.approx_rows ?? null,
      table_comment: meta.rows[0]?.table_comment ?? null,
      primary_key: cols.rows.filter((c) => c.col_key === "PRI").map((c) => c.name),
      columns: cols.rows.map((c) => ({
        name: c.name, type: c.col_type, nullable: c.nullable === "YES",
        default: c.col_default, key: c.col_key || null, extra: c.extra || null, comment: c.comment || null,
      })),
      indexes: idx.rows.map((r) => ({ name: r.name, unique: Number(r.non_unique) === 0, columns: r.cols })),
    };
  }
  if (src.type === "sqlite") {
    // v1.2.0: sqlite 元数据——PRAGMA table_info（列）+ index_list/index_info（索引）。
    // SQLite 无表注释/行数估算（approx_rows 返回精确 COUNT，本地文件成本低，失败不阻断）。
    const cols = (await runQuery(args.source, `PRAGMA table_info(${quoteIdent("sqlite", table)})`)).rows;
    if (!cols.length) throw new Error(`Table '${table}' not found (sqlite file).`);
    const pkCols = cols.filter((c) => Number(c.pk) > 0).sort((a, b) => a.pk - b.pk);
    const idxList = (await runQuery(args.source, `PRAGMA index_list(${quoteIdent("sqlite", table)})`)).rows;
    const indexes = [];
    for (const ix of idxList) {
      const info = (await runQuery(args.source, `PRAGMA index_info(${quoteIdent("sqlite", ix.name)})`)).rows;
      indexes.push({ name: ix.name, unique: Number(ix.unique) === 1, columns: info.map((c) => c.name) });
    }
    let approxRows = null;
    try { approxRows = Number((await runQuery(args.source, `SELECT COUNT(*) AS c FROM ${quoteIdent("sqlite", table)}`)).rows[0]?.c); } catch { /* ignore */ }
    return {
      source: args.source, table, schema: "(file)",
      approx_rows: approxRows,
      table_comment: null,
      primary_key: pkCols.map((c) => c.name),
      columns: cols.map((c) => ({
        name: c.name, type: c.type || "BLOB(affinity)", nullable: Number(c.notnull) === 0,
        default: c.dflt_value, key: Number(c.pk) > 0 ? "PRI" : null, extra: null, comment: null,
      })),
      indexes,
    };
  }
  // PostgreSQL
  // v1.0.1: 四条元数据查询彼此独立 → 并行（主键仅用于列映射，取回后再判定）
  const [cols, pk, idx, meta] = await Promise.all([
    runQuery(
      args.source,
      `SELECT column_name AS name, data_type AS col_type, is_nullable AS nullable,
              column_default AS col_default, character_maximum_length AS char_len,
              numeric_precision AS num_precision, numeric_scale AS num_scale
         FROM information_schema.columns
        WHERE table_schema = COALESCE($1, 'public') AND table_name = $2
        ORDER BY ordinal_position`,
      [schema, table]
    ),
    runQuery(
      args.source,
      `SELECT kcu.column_name AS name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = COALESCE($1, 'public') AND tc.table_name = $2
        ORDER BY kcu.ordinal_position`,
      [schema, table]
    ),
    runQuery(
      args.source,
      `SELECT indexname AS name, indexdef AS definition FROM pg_indexes
        WHERE schemaname = COALESCE($1, 'public') AND tablename = $2 ORDER BY indexname`,
      [schema, table]
    ),
    runQuery(
      args.source,
      `SELECT c.reltuples::bigint AS approx_rows, obj_description(c.oid) AS table_comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = COALESCE($1, 'public') AND c.relname = $2`,
      [schema, table]
    ),
  ]);
  if (!cols.rows.length) throw new Error(`Table '${table}' not found in schema '${schema || "public"}'.`);
  return {
    source: args.source, table, schema: schema || "public",
    approx_rows: meta.rows[0]?.approx_rows ?? null,
    table_comment: meta.rows[0]?.table_comment ?? null,
    primary_key: pk.rows.map((r) => r.name),
    columns: cols.rows.map((c) => ({
      name: c.name,
      type: c.char_len ? `${c.col_type}(${c.char_len})` : c.col_type,
      nullable: c.nullable === "YES",
      default: c.col_default,
      key: pk.rows.some((p) => p.name === c.name) ? "PRI" : null,
      comment: null,
    })),
    indexes: idx.rows,
  };
}

async function doQuery(args) {
  const src = getSource(args.source);
  // v1.2.1: sqlite 源放行只读 PRAGMA 白名单（元数据读取；其余 pragma 仍被只读守卫拒绝）
  if (!(src.type === "sqlite" && isReadOnlyPragma(args.sql))) {
    guardReadOnly(args.sql, maskDialect(src.type));
  }
  const maxRows = intArg(args.max_rows, "max_rows", 1, 5000, cfg.maxRows);
  const finalSql = enforceLimit(args.sql, maxRows, maskDialect(src.type));
  let qres;
  try {
    qres = await runQuery(args.source, finalSql);
  } catch (e) {
    // v1.0.3: 自动 LIMIT 的外层派生表要求列名唯一——未加别名的重名列（如 SELECT a.name, b.name）
    // 在 MySQL 上报 ER_DUP_FIELDNAME，透传原生错误会让用户以为 SQL 本身写错。给出可操作的提示。
    if (e?.code === "ER_DUP_FIELDNAME") {
      throw new Error(
        "自动 LIMIT 生成的派生表要求列名唯一：请为重名列添加别名（如 SELECT u.name AS user_name, o.name AS order_name）后重试。" +
        `（原始错误: ${e.message}）`
      );
    }
    throw e;
  }
  const { rows, fields, ms, renamed } = qres;
  const truncated = rows.length > maxRows;
  const visible = rows.slice(0, maxRows);
  return {
    source: args.source,
    sql_executed: finalSql,
    row_count: visible.length,
    truncated,
    truncated_cells: countTruncatedCells(visible),   // v1.0.1: 含被截断超长单元格的行数
    duration_ms: ms,
    columns: fields,
    rows: visible,
    // v1.5.0: 重复列名消歧映射（新名→原名，如 {"id__2":"id"}）。mysql/pg 驱动对象化同名列会静默
    // 折叠，已改为数组行模式重建并加 __N 后缀——此字段让模型知道列被改名、值未丢失。
    ...(renamed && Object.keys(renamed).length ? { renamed_duplicate_columns: renamed } : {}),
  };
}

/**
 * Build the sample_data SELECT. Pure function so the SQL shape is unit-testable without a DB.
 * v1.0.1: 新增 where 过滤；order_by 接受 "col" / "col ASC" / "col DESC"（旧版只接受裸列名，
 * 传 "created_at DESC" 会抛 Invalid identifier —— 而"看最新几条"正是最高频用法）。
 */
export function sampleSql(dbType, ref, { where, orderBy, limit } = {}) {
  let w = "";
  if (where) {
    // v1.1.1: 抽取为 guard.checkWhereFragment（与 count_rows / distinct_values 共用同一校验）
    checkWhereFragment(where, maskDialect(dbType));
    w = ` WHERE ${where}`;
  }
  let o = "";
  if (orderBy) {
    const m = /^([A-Za-z0-9_$]+)\s*(?:(ASC|DESC))?$/i.exec(String(orderBy).trim());
    if (!m) throw new Error("Invalid order_by: use \"column\" or \"column ASC|DESC\" (e.g. created_at DESC).");
    o = ` ORDER BY ${quoteIdent(dbType, m[1])}${m[2] ? " " + m[2].toUpperCase() : ""}`;
  }
  return `SELECT * FROM ${ref}${w}${o} LIMIT ${limit}`;
}

async function sampleData(args) {
  const src = getSource(args.source);
  const split = splitIdent(args.table);
  const schema = args.schema || split.schema || (src.type === "mysql" || src.type === "sqlite" ? null : "public");
  const limit = intArg(args.limit, "limit", 1, 50, 10);
  const sql = sampleSql(src.type, tableRef(src.type, schema, split.table), {
    where: args.where, orderBy: args.order_by, limit,
  });
  guardReadOnly(sql, maskDialect(src.type)); // 纵深防御：拼装后的语句再过一次只读守卫
  const { rows, fields, ms } = await runQuery(args.source, sql);
  return {
    source: args.source, table: split.table, where: args.where || null, sql_executed: sql, row_count: rows.length,
    truncated_cells: countTruncatedCells(rows),
    duration_ms: ms, columns: fields, rows,
  };
}

/**
 * v1.0.3: COUNT 语句构造抽成纯函数（与 sampleSql 同一套路），便于单测 SQL 形状与守卫行为。
 * where 为条件表达式（不含 WHERE 关键字）或空串。
 */
export function countSql(dbType, ref, where) {
  const w = where ? ` WHERE ${where}` : "";
  // v1.2.0: sqlite 与 mysql 同形（无 ::bigint 转换，INTEGER 天然安全整数内；BigInt 由驱动开关保证）
  return dbType === "mysql" || dbType === "sqlite"
    ? `SELECT COUNT(*) AS total FROM ${ref}${w}`
    : `SELECT COUNT(*)::bigint AS total FROM ${ref}${w}`;
}

async function countRows(args) {
  const src = getSource(args.source);
  const split = splitIdent(args.table);
  const schema = args.schema || split.schema || (src.type === "mysql" || src.type === "sqlite" ? null : "public");
  const ref = tableRef(src.type, schema, split.table);
  if (args.where) checkWhereFragment(args.where, maskDialect(src.type));   // v1.1.1: 与 sample_data/distinct_values 共用
  const sql = countSql(src.type, ref, args.where ? String(args.where) : "");
  // v1.0.3 安全修复：拼装后的语句必须再过一次只读守卫（与 sample_data 对齐）——
  // 旧版只查了多语句与写词，where 里塞 "FOR UPDATE" / "LOCK IN SHARE MODE" 会拿到行锁并阻塞写事务。
  guardReadOnly(sql, maskDialect(src.type));
  const { rows, ms } = await runQuery(args.source, sql);
  return { source: args.source, table: split.table, where: args.where || null, total: rows[0]?.total ?? null, duration_ms: ms };
}

/* ---------------- v1.1.0 发现与分析工具（find_columns / query_plan / distinct） ---------------- */


/** find_tables_by_column 的 SQL 构造（纯函数，供单测；limit 已由调用方 clamp） */
/** fk_relationships 的 SQL 构造（纯函数，供单测）。table 为 null 时列全 schema 外键 */
export function fkSql(dbType, { schema, table, limit }) {
  if (dbType === "mysql") {
    return {
      sql: `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                   REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column,
                   CONSTRAINT_NAME AS constraint_name
              FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
               AND REFERENCED_TABLE_NAME IS NOT NULL
               AND (? IS NULL OR TABLE_NAME = ?)
             ORDER BY TABLE_NAME, ORDINAL_POSITION
             LIMIT ${limit + 1}`,
      values: [schema, table, table],
    };
  }
  return {
    sql: `SELECT tc.table_name AS table_name, kcu.column_name AS column_name,
                 ccu.table_name AS ref_table, ccu.column_name AS ref_column,
                 tc.constraint_name AS constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = tc.table_schema
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_schema = COALESCE($1, 'public')
             AND ($2::text IS NULL OR tc.table_name = $2)
           ORDER BY tc.table_name, kcu.ordinal_position
           LIMIT ${limit + 1}`,
    values: [schema, table],
  };
}

async function fkRelationships(args) {
  const src = getSource(args.source);
  const table = args.table ? splitIdent(args.table).table : null;
  const schema = args.schema || (args.table ? splitIdent(args.table).schema : null);
  const limit = intArg(args.limit, "limit", 1, 1000, 200);
  let rows, ms;
  if (src.type === "sqlite") {
    // v1.2.0: sqlite 无 information_schema——遍历表 + PRAGMA foreign_key_list
    const t0 = Date.now();
    const tables = table
      ? [{ name: table }]
      : (await runQuery(args.source, "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name")).rows;
    rows = [];
    for (const t of tables) {
      const fks = (await runQuery(args.source, `PRAGMA foreign_key_list(${quoteIdent("sqlite", t.name)})`)).rows;
      for (const fk of fks) {
        rows.push({
          table_name: t.name, column_name: fk.from,
          ref_table: fk.table, ref_column: fk.to || "(implicit PK)",
          constraint_name: `fk_${t.name}_${fk.id}`,
        });
        if (rows.length > limit) break;
      }
      if (rows.length > limit) break;
    }
    ms = Date.now() - t0;
  } else {
    const { sql, values } = fkSql(src.type, { schema, table, limit });
    ({ rows, ms } = await runQuery(args.source, sql, values));
  }
  const truncated = rows.length > limit;
  const visible = truncated ? rows.slice(0, limit) : rows;
  const relationships = visible.map((r) => `${r.table_name}.${r.column_name} -> ${r.ref_table}.${r.ref_column}`);
  return {
    source: args.source,
    schema: schema || (src.type === "sqlite" ? "(file)" : src.type === "mysql" ? "(connection database)" : "public"),
    table: table || "(all)",
    fk_count: visible.length,
    truncated,
    relationships,
    details: visible,
    duration_ms: ms,
  };
}

export function findColumnsSql(dbType, { schema, column, limit }) {
  if (dbType === "mysql") {
    return {
      sql: `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                   COLUMN_TYPE AS column_type, COLUMN_KEY AS column_key,
                   NULLIF(COLUMN_COMMENT, '') AS comment
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
               AND COLUMN_NAME LIKE CONCAT('%', ?, '%')
             ORDER BY TABLE_NAME, ORDINAL_POSITION
             LIMIT ${limit + 1}`,
      values: [schema, column],
    };
  }
  return {
    sql: `SELECT c.relname AS table_name, a.attname AS column_name,
                 format_type(a.atttypid, a.atttypmod) AS column_type,
                 CASE WHEN EXISTS (
                   SELECT 1
                     FROM information_schema.table_constraints tc
                     JOIN information_schema.key_column_usage kcu
                       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                      AND tc.table_schema = n.nspname AND tc.table_name = c.relname
                      AND kcu.column_name = a.attname
                 ) THEN 'PRI' ELSE NULL END AS column_key,
                 col_description(c.oid, a.attnum) AS comment
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = COALESCE($1, 'public')
             AND c.relkind IN ('r', 'p', 'v', 'm')
             AND a.attnum > 0 AND NOT a.attisdropped
             AND a.attname ILIKE '%' || $2 || '%'
           ORDER BY c.relname, a.attnum
           LIMIT ${limit + 1}`,
    values: [schema, column],
  };
}

async function findTablesByColumn(args) {
  const src = getSource(args.source);
  const column = String(args.column || "").trim();
  if (!column) throw new Error("Provide a column name or keyword, e.g. 'order_no'.");
  const schema = args.schema || null;
  const limit = intArg(args.limit, "limit", 1, 500, 100);
  let rows, ms;
  if (src.type === "sqlite") {
    // v1.2.0: sqlite 无 information_schema——遍历表 + PRAGMA table_info，JS 侧做大小写不敏感子串匹配
    const t0 = Date.now();
    const kw = column.toLowerCase();
    const tables = (await runQuery(
      args.source,
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name"
    )).rows;
    rows = [];
    for (const t of tables) {
      const cols = (await runQuery(args.source, `PRAGMA table_info(${quoteIdent("sqlite", t.name)})`)).rows;
      for (const c of cols) {
        if (String(c.name).toLowerCase().includes(kw)) {
          rows.push({
            table_name: t.name, column_name: c.name,
            column_type: c.type || "BLOB(affinity)", column_key: Number(c.pk) > 0 ? "PRI" : null,
            comment: null,
          });
          if (rows.length > limit) break;
        }
      }
      if (rows.length > limit) break;
    }
    ms = Date.now() - t0;
  } else {
    const { sql, values } = findColumnsSql(src.type, { schema, column, limit });
    ({ rows, ms } = await runQuery(args.source, sql, values));
  }
  const truncated = rows.length > limit;
  const visible = truncated ? rows.slice(0, limit) : rows;
  const tables = [...new Set(visible.map((r) => r.table_name))];
  return {
    source: args.source,
    schema: schema || (src.type === "sqlite" ? "(file)" : src.type === "mysql" ? "(connection database)" : "public"),
    column_keyword: column,
    match_count: visible.length,
    table_count: tables.length,
    truncated,
    ...(truncated ? { note: "仅显示前 " + limit + " 个列匹配；可用更精确的关键字或调大 limit。" } : {}),
    tables,
    columns: visible,
    duration_ms: ms,
  };
}

/** query_plan 的语句构造（纯函数，供单测）。内层仅允许 SELECT/WITH——EXPLAIN SHOW/DESC 无意义，EXPLAIN UPDATE 危险 */
export function explainSql(dbType, sql, format) {
  const inner = String(sql).trim().replace(/;\s*$/, "");
  // v1.2.0: sqlite 掩码走 postgres 语义（字符串无反斜杠转义）
  const first = sanitizeSql(inner, maskDialect(dbType)).text.trim().split(/\s+/)[0] || "";
  if (!/^(select|with)$/i.test(first)) {
    throw new Error("query_plan only accepts a single SELECT / WITH ... SELECT statement.");
  }
  if (dbType === "sqlite") {
    // sqlite 无 FORMAT 选项，两种 format 都用 EXPLAIN QUERY PLAN（输出 id/parent/detail 树）
    return `EXPLAIN QUERY PLAN ${inner}`;
  }
  if (format === "json") {
    return dbType === "mysql" ? `EXPLAIN FORMAT=JSON ${inner}` : `EXPLAIN (FORMAT JSON) ${inner}`;
  }
  return `EXPLAIN ${inner}`;
}

async function doQueryPlan(args) {
  const src = getSource(args.source);
  // 内层语句必须是合法只读语句（拦 FOR UPDATE / INTO OUTFILE / 行锁等），EXPLAIN 整句再过一次（纵深）
  const inner = String(args.sql).trim().replace(/;\s*$/, "");
  guardReadOnly(inner, maskDialect(src.type));
  const sql = explainSql(src.type, inner, args.format);
  guardReadOnly(sql, maskDialect(src.type));
  const { rows, fields, ms } = await runQuery(args.source, sql);
  return {
    source: args.source,
    sql_explained: inner,
    plan_format: src.type === "sqlite" ? "text (EXPLAIN QUERY PLAN)" : args.format === "json" ? "json" : "text",
    columns: fields,
    plan: rows,
    duration_ms: ms,
  };
}

/** distinct_values 的 SQL 构造（纯函数，供单测）。column 由调用方校验为裸标识符后 quoteIdent
 *  v1.6.2: 并列频数按值升序稳定次序（与 top_values 同契约）——否则 limit 截断边界取哪几个值不可复现 */
export function distinctSql(dbType, ref, column, { where, limit }) {
  const w = where ? ` WHERE ${where}` : "";
  const q = quoteIdent(dbType, column);
  const noCast = dbType === "mysql" || dbType === "sqlite";
  const cnt = noCast ? "COUNT(*)" : "COUNT(*)::bigint";
  return {
    top: `SELECT ${q} AS value, ${cnt} AS cnt FROM ${ref}${w} GROUP BY ${q} ORDER BY cnt DESC, ${q} ASC LIMIT ${limit + 1}`,
    total: `SELECT COUNT(DISTINCT ${q})${noCast ? "" : "::bigint"} AS distinct_total FROM ${ref}${w}`,
  };
}

/** column_stats 的 SQL 构造（纯函数，供单测）：单条聚合产出列画像。别名避开各库保留字 */
export function columnStatsSql(dbType, ref, column, { where } = {}) {
  const q = quoteIdent(dbType, column);
  const w = where ? ` WHERE ${where}` : "";
  const cnt = dbType === "mysql" || dbType === "sqlite" ? "COUNT(*)" : "COUNT(*)::bigint";
  return `SELECT ${cnt} AS row_count, COUNT(${q}) AS non_null, COUNT(DISTINCT ${q}) AS distinct_values, MIN(${q}) AS min_value, MAX(${q}) AS max_value, AVG(${q}) AS avg_value FROM ${ref}${w}`;
}

/**
 * v1.6.0: column_stats 直方图 SQL 构造（纯函数，供单测）——单条 CTE 语句产出等宽桶频数。
 * 设计：rng 求值域（应用 where）→ buckets 求桶宽（hi=lo 时宽 1.0 防除零）→ s 对每行算桶号
 * （NULL 不入桶；桶号封顶 buckets-1，值=上界的那行归入末桶而非溢出桶；mysql 标量取小是 LEAST、
 * pg/sqlite 是 MIN 两参形态，方言分支）→ 外层按桶号聚合并给出桶界。
 * where 括号包裹拼进 AND（片段级 OR 的优先级不外溢）。
 */
export function histogramStatsSql(dbType, ref, column, { buckets, where } = {}) {
  const n = Math.max(2, Math.floor(Number(buckets) || 10));
  const q = quoteIdent(dbType, column);
  const inner = `FROM ${ref} t CROSS JOIN buckets b WHERE t.${q} IS NOT NULL${where ? ` AND (${where})` : ""}`;
  const lo = `b.lo + s.bi * b.width`;
  const cnt = dbType === "mysql" || dbType === "sqlite" ? "COUNT(*)" : "COUNT(*)::bigint";
  // v1.6.1 分析补洞：元素级封顶的方言映射——LEAST(a,b) 是 mysql/pg 的元素级最小；PG 的 MIN 是
  // 聚合函数（双参即语法错误），只有 SQLite 的 MIN(a,b) 是标量。故 sqlite 用 MIN，其余用 LEAST。
  const clampFn = dbType === "sqlite" ? "MIN" : "LEAST";
  // v1.6.1 真实库实测修正：MySQL 的 CAST 目标没有 INTEGER（语法错误），只能 SIGNED/UNSIGNED；
  // pg/sqlite 用 INTEGER。方言差异此前被 sqlite 单库验证漏掉，mysql-validate 套件抓获。
  const cast = dbType === "mysql" ? "SIGNED" : "INTEGER";
  return `WITH rng AS (SELECT MIN(${q}) AS lo, MAX(${q}) AS hi FROM ${ref}${where ? ` WHERE (${where})` : ""}), ` +
    `buckets AS (SELECT lo, hi, CASE WHEN hi = lo THEN 1.0 ELSE (hi - lo) * 1.0 / ${n} END AS width FROM rng), ` +
    `s AS (SELECT ${clampFn}(CAST(FLOOR((t.${q} - b.lo) / b.width) AS ${cast}), ${n - 1}) AS bi ${inner}) ` +
    `SELECT s.bi AS bucket_index, ${cnt} AS row_count, ${lo} AS bucket_lower, b.lo + (s.bi + 1) * b.width AS bucket_upper ` +
    `FROM s CROSS JOIN buckets b GROUP BY s.bi, b.lo, b.width ORDER BY s.bi`;
}

/** v1.6.0: column_stats TopN 高频值 SQL 构造（纯函数，供单测）。次序频数降序 + 值升序（结果稳定可复现）；别名 cnt 避开保留字 */
export function topValuesSql(dbType, ref, column, { limit, where } = {}) {
  const n = Math.max(1, Math.floor(Number(limit) || 10));
  const q = quoteIdent(dbType, column);
  const cnt = dbType === "mysql" || dbType === "sqlite" ? "COUNT(*)" : "COUNT(*)::bigint";
  return `SELECT ${q} AS value, ${cnt} AS cnt FROM ${ref} WHERE ${q} IS NOT NULL${where ? ` AND (${where})` : ""} ` +
    `GROUP BY ${q} ORDER BY cnt DESC, ${q} ASC LIMIT ${n}`;
}

async function columnStats(args) {
  const src = getSource(args.source);
  const split = splitIdent(args.table);
  const schema = args.schema || split.schema || (src.type === "mysql" || src.type === "sqlite" ? null : "public");
  const column = String(args.column || "").trim();
  if (!/^[A-Za-z_][\w$]*$/.test(column)) {
    throw new Error(`Invalid column name '${column}'. Pass a plain column name (letters/digits/_/$, not starting with a digit).`);
  }
  if (args.where) checkWhereFragment(args.where, maskDialect(src.type));
  const ref = tableRef(src.type, schema, split.table);
  const sql = columnStatsSql(src.type, ref, column, { where: args.where });
  guardReadOnly(sql, maskDialect(src.type));   // 纵深防御：where 里塞行锁写法在此被拦
  const { rows, ms } = await runQuery(args.source, sql);
  const result = {
    source: args.source, table: split.table, column,
    where: args.where || null,
    stats: rows[0] ?? null,
    duration_ms: ms,
  };

  // v1.6.0: 可选直方图（数值列等宽桶）与 TopN 高频值——各是一条独立的白名单拼装语句
  if (args.histogram && typeof args.histogram === "object") {
    const buckets = intArg(args.histogram.buckets, "histogram.buckets", 2, 50, 10);
    const hsql = histogramStatsSql(src.type, ref, column, { buckets, where: args.where });
    guardReadOnly(hsql, maskDialect(src.type));
    const h = await runQuery(args.source, hsql);
    result.histogram = h.rows;
    result.duration_ms += h.ms;
  }
  if (args.top_values && typeof args.top_values === "object") {
    const topN = intArg(args.top_values.limit, "top_values.limit", 1, 100, 10);
    const tsql = topValuesSql(src.type, ref, column, { limit: topN, where: args.where });
    guardReadOnly(tsql, maskDialect(src.type));
    const t = await runQuery(args.source, tsql);
    result.top_values = t.rows.map((r) => ({ value: r.value, count: Number(r.cnt ?? r.count) }));
    result.duration_ms += t.ms;
  }
  return result;
}

/* ------------------------- v1.4.0 import_data（CSV 导入） ------------------------- */

// 与 export_data 对称的反向工具。安全边界：
//  1) 文件来源——服务端 DBMCP_IMPORT_DIR 白名单目录（未设置时可回退 DBMCP_EXPORT_DIR；都未设置即拒）；
//  2) 注入面——逐行参数化 INSERT，CSV 单元格永不拼接进 SQL 文本；
//  3) 列名——仅接受裸标识符，quoteIdent 加引（表头即列名，构造方无法夹带 SQL 片段）；
//  4) 权限——走 allowWrites 开关（与 execute 同门）；行宽不一致即整批中止；
//  5) 容量——默认上限 10000 行 / 20MB 文件。
const MAX_IMPORT_ROWS = 10000;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/**
 * v1.4.1: 导入 INSERT 语句构造（纯函数，供单测）。占位符按方言：postgres 扩展协议只认 $n
 *（旧版用 ? 对 postgres 源必炸——全链路审查发现）；mysql/sqlite 用 ?。rowCount>1 为批量多 VALUES 形态。
 */
export function importInsertSql(dbType, ref, columns, rowCount) {
  const cols = columns.map((c) => quoteIdent(dbType, c));
  const ph = (rowIdx) => `(${cols.map((_, c) => dbType === "postgres" ? `$${rowIdx * columns.length + c + 1}` : "?").join(", ")})`;
  return `INSERT INTO ${ref} (${cols.join(", ")}) VALUES ${Array.from({ length: rowCount }, (_, i) => ph(i)).join(", ")}`;
}

/**
 * v1.4.1: 批量写入失败后是否「结果未知」。超时/连接类错误下批语句可能已在服务端提交
 *（mysql2 的 timeout 只回调报错、不撤服务端语句，连接也不销毁——审查实证），此时自动回退
 * 逐行会重复插入。这类错误必须中止并要求人工核对；约束/数据类错误语句原子回滚，才可安全
 * 回退逐行定位坏行。纯函数供单测。
 */
export function isAmbiguousWriteError(e) {
  if (!e) return false;
  if (e.fatal === true) return true;
  const code = String(e.code ?? e.errno ?? "");
  const sqlState = String(e.sqlState ?? "");
  if (/PROTOCOL_SEQUENCE_TIMEOUT|PROTOCOL_CONNECTION_LOST|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE/.test(code)) return true;
  if (/^08/.test(sqlState)) return true; // SQLSTATE 连接异常类 08xxx
  if (["57014", "57P01", "57P02", "57P03", "53300", "53400"].includes(code)) return true;
  return /timeout|timed out|connection (terminated|reset|refused|closed)/i.test(String(e.message ?? ""));
}

/** 完整 CSV 文本 → 行数组（RFC 4180：引号内逗号/换行/双引号转义；CRLF/LF 归一；BOM 由调用方剥）。纯函数供单测。 */
export function parseCsv(text) {
  const src = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop(); // 尾空行
  return rows;
}

async function doImportData(args) {
  // 目录门禁最先（配置级错误先于源查找/DB 访问暴露，未初始化部署也能得到明确指引）
  const dir = process.env.DBMCP_IMPORT_DIR || process.env.DBMCP_EXPORT_DIR;
  if (!dir) {
    throw new Error("import_data 未启用：在 MCP 服务的环境中设置 DBMCP_IMPORT_DIR=<允许读取导入文件的目录> 后重启（服务端白名单，防任意路径读取）。");
  }
  const src = getSource(args.source);
  const writable = cfg.allowWrites === true || src.allowWrites === true;
  if (!writable) throw new Error("import_data 需要写权限：在 dbmcp.config.json 设置 allowWrites=true（全局或该源）后重启。");
  const file = safeExportPath(dir, args.filename);
  if (!file || !fs.existsSync(file)) throw new Error(`导入文件不存在（或文件名被清洗拒绝）: ${args.filename}`);
  const bytes = fs.statSync(file).size;
  if (bytes > MAX_IMPORT_BYTES) throw new Error(`文件 ${bytes} 字节超过上限 ${MAX_IMPORT_BYTES}（20MB）。`);

  const clean = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(clean);
  if (rows.length < 1) throw new Error("CSV 为空。");
  const header = rows[0].map((h) => String(h).trim()).filter(Boolean);
  if (!header.length) throw new Error("CSV 首行（表头）为空。");
  for (const h of header) {
    if (!/^[A-Za-z_][\w$]*$/.test(h)) throw new Error(`CSV 表头含非法列名 '${h}'（仅允许字母/数字/_/$，且不以数字开头）。`);
  }
  const dataRows = rows.slice(1).filter((r) => r.length > 1 || String(r[0]).trim() !== "");
  if (!dataRows.length) throw new Error("CSV 无数据行。");
  if (dataRows.length > MAX_IMPORT_ROWS) throw new Error(`数据行 ${dataRows.length} 超过上限 ${MAX_IMPORT_ROWS}（10000）。`);

  const split = splitIdent(args.table);
  const schema = args.schema || split.schema || (src.type === "mysql" || src.type === "sqlite" ? null : "public");
  const ref = tableRef(src.type, schema, split.table);

  // v1.4.1: 占位符按方言生成（pg 扩展协议只认 $n，不认 ? —— 旧版对 postgres 源必炸，全链路审查发现）
  // + 批量化导入（默认 100 行/条多 VALUES 语句，仍全参数化——注入面为零）；
  // 批失败自动回退该批逐行导入，精确定位坏行后整批中止（已写入行数如实回报）。
  const BATCH = 100;
  const singleSql = importInsertSql(src.type, ref, header, 1);
  const batchSql = (n) => importInsertSql(src.type, ref, header, n);

  // v1.5.2: 值变换一次性前移完成（含 emptyAsNull 与可选的中和逆变换）——批失败回退逐行时
  // 不再重复转换，剥离计数也只计一次（旧版 toValues 在批/回退两路径各调一次）。
  const stripNeutralized = args.strip_neutralization === true;
  let strippedCount = 0;
  const valueRows = dataRows.map((r) => r.map((v) => {
    let u = v;
    if (stripNeutralized && typeof v === "string") {
      const s = unneutralizeCell(v);
      if (s !== v) { strippedCount++; u = s; }
    }
    return u === "" && args.emptyAsNull === true ? null : u;
  }));

  // 行宽一次性预检（数据全在内存）：批内中途才报宽度错误时，文案的"此前 N 行已写入"会把
  // 本批未写入的行数也算进去（实测虚报）；预检在任何写入前完成，文案恒为"未写入任何行"。
  for (let i = 0; i < dataRows.length; i++) {
    if (dataRows[i].length !== header.length) {
      throw new Error(`行宽不一致：期望 ${header.length} 列，实际 ${dataRows[i].length}（第 ${i + 1} 数据行）。未写入任何行。`);
    }
  }

  let inserted = 0;
  const t0 = Date.now();
  if (args.atomic === true) {
    // v1.5.3: 全文件单事务——任一批失败整体回滚，无"部分行保留"中间态（也不做逐行回退定位：
    // 消除部分写入正是 atomic 的目的；要定位坏行用默认模式）。mysql/pg 事务钉在单连接上执行。
    try {
      await withTransaction(args.source, async (run) => {
        for (let b = 0; b < valueRows.length; b += BATCH) {
          const batch = valueRows.slice(b, b + BATCH);
          await run(batchSql(batch.length), batch.flat());
          inserted += batch.length;
        }
      });
    } catch (e) {
      throw new Error(`原子导入失败，已全部回滚（未写入任何行）: ${e.message}`);
    }
  } else {
    for (let b = 0; b < valueRows.length; b += BATCH) {
      const batch = valueRows.slice(b, b + BATCH);
      try {
        await runQuery(args.source, batchSql(batch.length), batch.flat());
        inserted += batch.length;
      } catch (e) {
        // 超时/连接类错误下批语句结果未知（可能已在服务端提交）——回退逐行会重复插入，必须中止
        if (isAmbiguousWriteError(e)) {
          throw new Error(`批写入结果未知（超时/连接中断，安全中止、不自动回退）：第 ${b + 1}-${b + batch.length} 行可能已全部或部分写入，请用 count_rows 核对后人工决定是否补插（此前批次已确认写入 ${inserted} 行）。原始错误: ${e.message}`);
        }
        // 约束/数据类错误：批语句原子未写入 → 回退逐行精确定位坏行
        for (let i = 0; i < batch.length; i++) {
          try {
            await runQuery(args.source, singleSql, valueRows[b + i]);
            inserted++;
          } catch (e2) {
            const tail = isAmbiguousWriteError(e2)
              ? "该行写入结果未知（超时/连接中断）"
              : `此前 ${inserted} 行已写入——如需清场请用 execute 按条件删除`;
            throw new Error(`第 ${b + i + 1} 行导入失败，整批中止（${tail}）: ${e2.message}`);
          }
        }
      }
    }
  }
  return {
    source: args.source, table: split.table, file, columns: header,
    rows_imported: inserted, duration_ms: Date.now() - t0,
    ...(stripNeutralized ? { neutralization_stripped: strippedCount } : {}),
    note: "用 count_rows 验证导入行数；导入前建议先 sample_data 看目标表现有格式。",
  };
}

/* ------------------------- v1.3.0 export_data（导出落盘） ------------------------- */

// 导出安全边界：
//  1) 目录白名单——必须设置 DBMCP_EXPORT_DIR，文件只能落在该目录内；
//  2) 文件名清洗——替换路径分隔符等危险字符后再 join，杜绝 ../ 与绝对路径穿越；
//  3) 容量上限——20MB（防一次导出吃满磁盘/内存）；
//  4) 只读 SQL——语句过只读守卫 + 自动 LIMIT（行数上限独立于 maxRows，默认 5000，上限 100000）；
//  5) 输出清洗——落盘内容与工具响应同样过 scrub。
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

export function safeExportPath(dir, filename) {
  if (!dir || !filename) return null;
  const raw = String(filename).trim();
  // v1.3.1 修正："." / ".." / "..." 在清洗前拒绝——清洗会把它们变成 "_" 绕过检查（selftest 抓到）
  if (!raw || /^\.+$/.test(raw)) return null;
  const clean = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120);
  if (!clean) return null;
  const base = path.resolve(dir);
  const full = path.resolve(base, clean);
  return full.startsWith(base + path.sep) ? full : null; // 双保险：即使清洗漏网，越界即拒
}

/**
 * v1.6.1: 跨进程安全的导出落盘。旧 writeFileSync 直写目标：多客户端共享 EXPORT_DIR 时
 * 并发写同名文件会交错出损坏内容；且"查存在→写"的拒覆盖有 TOCTOU 窗口（两进程同时查到
 * 不存在，后写者静默覆盖先写者）。现改为：先写同目录唯一临时文件（同卷保证 rename 原子），
 * 再按模式落位——
 *  - 拒覆盖（overwrite !== true）：linkSync(tmp, target) 原子占位，目标已存在即 EEXIST
 *    （link 的创建语义是内核级原子的，跨进程互斥），随后删临时文件；
 *  - 覆盖（overwrite === true）：renameSync(tmp, target) 原子替换（libuv Windows 侧带
 *    MOVEFILE_REPLACE_EXISTING），读方（import_data）任一刻看到的都是完整旧内容或完整新内容。
 * 任何路径失败都清理临时文件，不留残渣。
 *
 * v1.6.1 真实并发实测修正：Windows 两个进程同时 rename 替换同一目标时，MoveFileEx 会短暂
 * 锁定目标位，后到者报瞬态 EPERM（5 轮双进程实测约 2 次），并非真失败——对 EPERM/EACCES/EBUSY
 * 做 2s 内同步小睡重试；EEXIST（拒覆盖的预期路径）等确定性错误立即抛出不重试。
 */
const RENAME_TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
function renameWithRetry(fn, deadlineMs = 2000, stepMs = 20) {
  const t0 = Date.now();
  for (;;) {
    try { return fn(); }
    catch (e) {
      if (!RENAME_TRANSIENT.has(e?.code) || Date.now() - t0 >= deadlineMs) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs); // 同步小睡（不引入异步状态机）
    }
  }
}
export function writeFileAtomic(file, content, overwrite) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.writeFileSync(tmp, content, "utf8");
  try {
    if (overwrite === true) {
      renameWithRetry(() => fs.renameSync(tmp, file));
      return;
    }
    try {
      renameWithRetry(() => fs.linkSync(tmp, file));   // 原子占位：并发者只有一个成功
    } catch (e) {
      if (e?.code === "EEXIST") throw new Error(`目标文件已存在: ${file}（overwrite: true 可覆盖）`);
      throw e;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 目标位已让出或从未写成 */ }
  }
}

/**
 * CSV 单元格转义（RFC 4180：引号/逗号/换行包引号；null 空串；Buffer 转十六进制）。
 * v1.5.0: CSV 公式注入中和（OWASP）——字符串单元格以 = + - @ TAB CR 开头时前置 '，
 * 否则 Excel/Sheets 打开导出文件即执行公式（"=cmd|' /C calc'!A0" 经典注入面）。
 * 数字/bigint 不中和（"-5" 是公式风险面但 -5 是数值，改写会破坏数值语义；字符串 "-5" 仍中和）。
 * neutralize=false 为逃生口（raw_formulas），仅供下游确实要公式语义时使用。
 */
export function csvCell(v, neutralize = true) {
  let s;
  let isStr = false;
  if (v === null || v === undefined) s = "";
  else if (typeof v === "bigint") s = v.toString();
  else if (typeof v === "number") s = String(v);
  else if (v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)) s = Buffer.from(v.data).toString("hex");
  else { s = String(v); isStr = true; }
  if (neutralize && isStr && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * v1.5.2: export 公式中和的精确逆变换——仅当单元格以 ' 开头且下一字符是公式起始符
 * （= + - @ TAB CR）时剥掉这一个 '。普通前导撇号（"'abc"）不是中和产物，原样保留。
 * import_data 的 strip_neutralization 用它做往返无损导入（export 默认中和 → import 显式还原）。
 */
export function unneutralizeCell(v) {
  return typeof v === "string" && /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

/**
 * 组装 CSV。v1.5.1: 组装期逐行累计字节，超过 maxBytes 立即抛错（早停）——
 * 旧行为是整表拼完再查 20MB，超限导出会先把内存吃到峰值才拒；
 * 现在超限在组装中即中止，文案如实"未写盘"。JSON 路径无逐行结构，保留执行后检查。
 */
export function exportToCsv(fields, rows, neutralize = true, maxBytes = MAX_EXPORT_BYTES) {
  let neutralized = 0;
  const cell = (v) => {
    if (neutralize && typeof v === "string" && /^[=+\-@\t\r]/.test(v)) neutralized++;
    return csvCell(v, neutralize);
  };
  const lines = [fields.map((f) => cell(f)).join(",")];
  let bytes = 0;
  for (const line of lines) bytes += Buffer.byteLength(line, "utf8") + 2;
  if (bytes > maxBytes) {
    throw new Error(`导出内容超过上限 ${maxBytes} 字节（组装期早停，未写盘）。请用 limit 参数缩小范围后重试。`);
  }
  for (const r of rows) {
    const line = fields.map((f) => cell(r?.[f])).join(",");
    bytes += Buffer.byteLength(line, "utf8") + 2;
    if (bytes > maxBytes) {
      throw new Error(`导出内容超过上限 ${maxBytes} 字节（组装期早停，未写盘）。请用 limit 参数缩小范围后重试。`);
    }
    lines.push(line);
  }
  return { content: lines.join("\r\n") + "\r\n", formula_cells_neutralized: neutralized };
}

async function doExportData(args) {
  const t0 = Date.now();
  // 目录门禁最先（配置级错误先于源查找/DB 访问暴露，未初始化部署也能得到明确指引）
  const dir = process.env.DBMCP_EXPORT_DIR;
  if (!dir) {
    throw new Error("export_data 未启用：在 MCP 服务的环境中设置 DBMCP_EXPORT_DIR=<允许导出的目录> 后重启（服务端白名单，防任意路径写盘）。");
  }
  const src = getSource(args.source);
  const format = args.format === "json" ? "json" : "csv";
  const limit = intArg(args.limit, "limit", 1, 100000, 5000);
  // v1.5.0: 公式注入中和默认开启；raw_formulas=true 显式关闭（仅 CSV 面临此风险）
  const neutralizeFormulas = !(args.raw_formulas === true);
  guardReadOnly(args.sql, maskDialect(src.type));
  const finalSql = enforceLimit(args.sql, limit, maskDialect(src.type));
  const { rows, fields } = await runQuery(args.source, finalSql);
  const truncated = rows.length > limit;
  const visible = truncated ? rows.slice(0, limit) : rows;
  const cols = fields.length ? fields : (visible[0] ? Object.keys(visible[0]) : []);

  let content;
  let formulaCells = 0;
  if (format === "json") {
    // v1.3.1 修正：必须用 stringify()——原生 JSON.stringify 无法序列化 BigInt（sqlite 读出的
    // INTEGER 经 setReadBigInts 是 BigInt，实测崩溃），且需要 Buffer 十六进制预览与 scrub 清洗
    content = stringify({ row_count: visible.length, truncated, columns: cols, rows: visible });
  } else {
    const csv = exportToCsv(cols, visible, neutralizeFormulas);
    content = csv.content;
    formulaCells = csv.formula_cells_neutralized;
  }
  content = scrub(content);   // 落盘内容与工具响应同标准清洗

  const ext = "." + format;
  const filename = args.filename
    ? (String(args.filename).endsWith(ext) ? String(args.filename) : String(args.filename) + ext)
    : `export-${src.type}-${new Date().toISOString().replace(/[:.]/g, "-")}${ext}`;
  const file = safeExportPath(dir, filename);
  if (!file) throw new Error(`Invalid export filename '${args.filename}' or DBMCP_EXPORT_DIR not set properly.`);
  // 快速失败预检（省去无谓等待）；跨进程互斥由 writeFileAtomic 的原子占位最终强制
  if (fs.existsSync(file) && args.overwrite !== true) {
    throw new Error(`目标文件已存在: ${file}（overwrite: true 可覆盖）`);
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_EXPORT_BYTES) {
    throw new Error(`导出内容 ${bytes} 字节超过上限 ${MAX_EXPORT_BYTES}（20MB）。请用 limit 参数缩小范围后重试。`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, content, args.overwrite === true);
  return {
    source: args.source, file, format, row_count: visible.length, truncated, bytes,
    duration_ms: Date.now() - t0,
    ...(format === "csv" ? { formula_cells_neutralized: formulaCells } : {}),
    note: "文件已写入 MCP 服务所在机器的导出白名单目录。",
  };
}

async function distinctValues(args) {
  const src = getSource(args.source);
  const split = splitIdent(args.table);
  const schema = args.schema || split.schema || (src.type === "mysql" || src.type === "sqlite" ? null : "public");
  const column = String(args.column || "").trim();
  if (!/^[A-Za-z_][\w$]*$/.test(column)) {
    throw new Error(`Invalid column name '${column}'. Pass a plain column name (letters/digits/_/$, not starting with a digit).`);
  }
  const limit = intArg(args.limit, "limit", 1, 200, 20);
  if (args.where) checkWhereFragment(args.where, maskDialect(src.type));
  const ref = tableRef(src.type, schema, split.table);
  const built = distinctSql(src.type, ref, column, { where: args.where, limit });
  // 纵深防御：拼装后的语句整体过只读守卫（与 count_rows 同标准，where 里塞行锁写法在此被拦）
  // v1.4.1: 掩码方言用 maskDialect（sqlite 归 postgres 语义）——旧版传 src.type，sqlite 源会按
  // MySQL 反斜杠转义语义掩码，与 doQuery/sample/count/column_stats 不一致（实测放行拆串 payload）
  guardReadOnly(built.top, maskDialect(src.type));
  guardReadOnly(built.total, maskDialect(src.type));
  const [top, total] = await Promise.all([
    runQuery(args.source, built.top),
    runQuery(args.source, built.total),
  ]);
  const truncated = top.rows.length > limit;
  const visible = truncated ? top.rows.slice(0, limit) : top.rows;
  return {
    source: args.source,
    table: split.table,
    column,
    where: args.where || null,
    // PG int8 返回字符串（与 BIGINT 策略一致）；MySQL 返回 number
    distinct_total: total.rows[0]?.distinct_total ?? null,
    returned: visible.length,
    truncated,
    ...(truncated ? { note: `仅显示计数最高的前 ${limit} 个取值（共 ${total.rows[0]?.distinct_total ?? "?"} 个去重值）。` } : {}),
    values: visible,
    duration_ms: top.ms,
  };
}

async function doExecute(args) {
  const src = getSource(args.source);
  const writable = cfg.allowWrites === true || src.allowWrites === true;
  if (!writable) {
    throw new Error(
      "Writes are disabled. Set allowWrites=true in dbmcp.config.json (globally or on this source), " +
      "then restart the MCP server. Prefer a least-privilege account."
    );
  }
  guardWrite(args.sql, maskDialect(src.type));
  const cleaned = String(args.sql).trim().replace(/;\s*$/, "");
  await guardAffectedRows(args.source, src, cleaned);   // v1.0.1 语义级红线：先按同一 WHERE 计数
  const { rows, ms, rowCount, changes } = await runQuery(args.source, cleaned);
  // v1.2.0: sqlite 影响行数来自 node:sqlite run() 的 changes
  const affected = src.type === "mysql" ? (rows?.affectedRows ?? null)
    : src.type === "sqlite" ? (changes ?? null)
    : (rowCount ?? null);
  return { source: args.source, affected_rows: affected, duration_ms: ms, note: "Verify with count_rows or query." };
}

/**
 * v1.0.1 安全红线（语义层）：执行 UPDATE/DELETE 前，用同一 WHERE 先做精确计数。
 * 命中行数超过 cfg.maxAffectedRows（默认 500，0 = 关闭预检）即拒绝——可拦住词法层无法判定的
 * 恒真写法（如 WHERE id IS NOT NULL OR 1=1）。计数失败（方言差异等）时不阻断，由词法守卫兜底，
 * 避免对合法语句引入新的失败模式；预检失败原因写 stderr 供运维排查。
 *
 * v1.0.3 注意（如实标注）：预检与执行是两次独立往返（TOCTOU）——计数后、执行前数据可能变化，
 * 预检是「护栏」而非精确配额；并发写入场景的超限防护需依赖数据库侧权限/配额，勿以此为准。
 */
async function guardAffectedRows(sourceId, src, sql) {
  const cap = cfg.maxAffectedRows;
  if (!(cap > 0)) return;
  if (!/^(update|delete)\b/i.test(sql.trim())) return;   // INSERT 不适用
  const target = extractWriteTarget(sql, maskDialect(src.type));
  if (!target) return;
  const split = splitIdent(target.table);
  const ref = tableRef(src.type, split.schema, split.table);
  const countSql = `SELECT COUNT(*) AS total FROM ${ref} WHERE ${target.where}`;
  let rows;
  try {
    ({ rows } = await runQuery(sourceId, countSql));
  } catch (e) {
    console.error("[calvin-db-mcp] 影响行数预检失败（回退到词法守卫）:", e?.message || e);
    return;
  }
  const total = Number(rows?.[0]?.total ?? NaN);
  if (Number.isFinite(total) && total > cap) {
    const verb = /^update/i.test(sql.trim()) ? "UPDATE" : "DELETE";
    throw new Error(
      `安全红线：该 ${verb} 将影响 ${total} 行，超过上限 ${cap}` +
      "（可在 dbmcp.config.json 调整 maxAffectedRows，0 = 关闭预检）。" +
      "如确需批量变更，请缩小 WHERE 范围后重试；全表/大批量操作请通过 DBeaver 等人工渠道由 DBA 执行。"
    );
  }
}

/* ---------------- create_table / find_database（环境感知） ---------------- */

async function doCreateTable(args) {
  const src = getSource(args.source);
  if (cfg.allowCreateTable !== true && src.allowCreateTable !== true) {
    throw new Error('建表未启用：在 dbmcp.config.json 设置 "allowCreateTable": true（全局或该源）后重启 MCP。安全红线（无 WHERE 的 UPDATE/DELETE、TRUNCATE）不受此开关影响，始终生效。');
  }
  // v1.0.3: 守卫只做校验并返回原文（旧版返回脱敏文本且被直接执行——带 COMMENT/'x'/反引号的 DDL 必然语法错误）
  const validated = createTableGuard(args.sql, maskDialect(src.type));
  const { ms } = await runQuery(args.source, validated);
  const name = createTableName(validated, src.type);   // v1.0.3: 先抹注释再取表名（旧正则遇注释会退化成 unknown）
  return { source: args.source, table_created: name, sql_executed: validated, duration_ms: ms, note: "Verify with describe_table." };
}

/** TCP 连通性探测（v1.0.1：find_database 的 probe 参数落地；自测也用它） */
export function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    let sock;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    try {
      sock = net.connect({ host: String(host), port: Number(port), timeout: timeoutMs });
    } catch { resolve(false); return; }
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

async function findDatabase(args) {
  const q = String(args.name || "").trim().toLowerCase();
  if (!q) throw new Error("Provide a database name or keyword, e.g. 'za_data_notice', 'test', 'pre'.");
  const envFilter = args.env ? String(args.env).trim().toLowerCase() : null;
  const out = [];
  for (const [id, s] of Object.entries(cfg.sources)) {
    let database = "", host = "", port = "";
    if (s.type === "sqlite") {
      database = sqliteFilePath(s) || "";   // v1.2.0: sqlite 显示文件路径，无 host/port
    } else {
      try {
        const u = new URL(s.url);
        host = u.hostname;
        port = u.port || (s.type === "mysql" ? "3306" : "5432");
        database = decodeURIComponent((u.pathname || "").replace(/^\//, ""));
      } catch { /* keep blanks */ }
    }
    const env = String(s.env || "").toLowerCase();
    if (envFilter && !env.includes(envFilter)) continue;
    const hay = (id + " " + database + " " + (s.description || "") + " " + env).toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({ id, type: s.type || "mysql", env: s.env || null, host, port, database, description: s.description || null });
  }
  // v1.0.1: probe=true 时并行探测每个命中主机（旧版该参数只在 schema 里，未实现）
  if (args.probe === true && out.length) {
    // v1.2.0: sqlite 无网络主机，probe 视为可达
    const reach = await Promise.all(out.map((m) => (m.type === "sqlite" ? Promise.resolve(true) : probeTcp(m.host, m.port, 2500))));
    out.forEach((m, i) => { m.reachable = reach[i]; });
  }
  return { query: args.name, env_filter: args.env || null, match_count: out.length, matches: out, note: out.length ? "Use the returned id as 'source' in other tools." : "No match - try list_sources." };
}

/* ------------------------------- MCP dispatch -------------------------------- */

function resultContent(data) {
  return { content: [{ type: "text", text: scrub(stringify(data)) }] };
}
function errorContent(message) {
  return { content: [{ type: "text", text: "Error: " + scrub(message) }], isError: true };
}

async function callTool(name, args) {
  try {
    let data;
    switch (name) {
      case "list_sources":    data = listSources(); break;
      case "list_tables":     data = await listTables(args); break;
      case "describe_table":  data = await describeTable(args); break;
      case "find_tables_by_column": data = await findTablesByColumn(args); break;
      case "fk_relationships": data = await fkRelationships(args); break;
      case "query":           data = await doQuery(args); break;
      case "query_plan":      data = await doQueryPlan(args); break;
      case "sample_data":     data = await sampleData(args); break;
      case "distinct_values": data = await distinctValues(args); break;
      case "column_stats":    data = await columnStats(args); break;
      case "export_data":     data = await doExportData(args); break;
      case "import_data":     data = await doImportData(args); break;
      case "count_rows":      data = await countRows(args); break;
      case "execute":         data = await doExecute(args); break;
      case "create_table":    data = await doCreateTable(args); break;
      case "find_database":   data = await findDatabase(args); break;
      default:
        return errorContent(`Unknown tool '${name}'. Available: ${TOOLS.map((t) => t.name).join(", ")}`);
    }
    return resultContent(data);
  } catch (e) {
    return errorContent(e?.code ? `${e.message} (${e.code})` : e?.message || String(e));
  }
}

/** JSON-RPC 内部错误响应（v1.0.1：不回栈信息，避免细节外泄） */
export function rpcInternalError(id) {
  return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
}

// v1.0.3: 支持的 MCP 协议版本（initialize 按规范回「服务端支持的版本」——旧版直接回显客户端
// 版本，传 "9999-01-01" 也会被原样确认；现仅当客户端版本在支持列表内才沿用之，否则回最新支持版）
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-06-18"]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";

export async function handleRpc(msg) {
  // v1.0.2: JSON-RPC 2.0 合规——
  // (a) 批量数组/标量：MCP 2025-06-18 已移除批量支持；旧版静默丢弃会让旧式客户端永久挂起，
  //     现回单条 -32600（id:null，按规范对无法定位 id 的无效请求的处理）。
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: expected a single JSON-RPC request object (batching is not supported)" } };
  }
  // (b) 无 id 的请求是通知：一律不得回复。旧版只静默 notifications/*，对 tools/list 等已知方法的
  //     无 id 写法会回一条没有 id 的响应，违反规范并污染客户端消息流。
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(params?.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "calvin-db-mcp", version: VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    case "tools/call": {
      const r = await callTool(params?.name, params?.arguments || {});
      return { jsonrpc: "2.0", id, result: r };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/* ---------------------------------- stdio ------------------------------------ */

function main() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  // v1.1.0 stdio 加固：
  //  1) 串行队列——请求严格按到达顺序处理与应答（旧版 async 回调并发，响应可能乱序，
  //     也与「MCP 调用是串行的」设计假设不符）；
  //  2) 单行长度上限（默认 2MB）——超长 JSON 行回 -32600 后丢弃，防内存放大；
  //  3) 写出带 flush 回调——大响应背压时等待 drain，而不是无限堆进 stdout 缓冲。
  const MAX_LINE_CHARS = 2_000_000;
  const writeLine = (s) => new Promise((res) => process.stdout.write(s + "\n", () => res()));
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    queue = queue
      .then(async () => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.length > MAX_LINE_CHARS) {
          await writeLine(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: message too large" } }));
          return;
        }
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return; // ignore non-JSON line
        }
        try {
          const resp = await handleRpc(msg);
          if (resp) await writeLine(JSON.stringify(resp));
        } catch (e) {
          console.error("[calvin-db-mcp] internal error:", e?.stack || e);
          // v1.0.1: 必须回一条 JSON-RPC 错误，否则客户端会永久等待该请求
          if (msg && msg.id !== undefined && msg.id !== null) {
            try { await writeLine(JSON.stringify(rpcInternalError(msg.id))); } catch { /* ignore */ }
          }
        }
      })
      .catch(() => { /* 上一行处理失败不阻断后续行 */ });
  });
  rl.on("close", () => process.exit(0));
  const names = Object.entries(cfg.sources)
    .map(([id, s]) => `${id}(${s.type || "mysql"})`)
    .join(", ");
  console.error(`[calvin-db-mcp] v${VERSION} started on stdio. sources: ${names || "(none)"}; allowWrites=${cfg.allowWrites}`);
}

if (process.env.DBMCP_NO_LISTEN !== "1") main();
