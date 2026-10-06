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
import { StringDecoder } from "node:string_decoder";
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
  enforceLimit, checkWhereFragment, createTableGuard, createTableName, ToolError,
} from "./guard.mjs";
import { createPoolManager, pgStreamable } from "./pool.mjs";
// v1.6.9 观测面打点（可选）：DBMCP_ERR_LOG 未设置时零行为，写失败静默，契约零侵入
import { setScrub, logToolCall } from "./observe.mjs";
export {
  sanitizeSql, stripComments, guardReadOnly, guardWrite, extractWriteTarget,
  whereHasColumn, exprHasColumn, extractWhereClause, ToolError,
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
export const VERSION = pkgVersion("1.6.32");

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
    throw new ToolError("E_PARAM", `Invalid '${name}': expected an integer, got ${JSON.stringify(v)}.`);
  }
  if (n < min) throw new ToolError("E_PARAM", `Invalid '${name}': must be >= ${min}, got ${n}.`);
  return Math.min(max, n);
}

/**
 * v1.6.26: 校验「枚举型」字符串参数（与 intArg 同一设计哲学）。
 * 旧版 format:"xml" 会被静默兜底成默认格式（query_plan→text、export_data→csv），
 * 调用方以为拿到了 xml 却得到另一种格式，且毫无提示——与 limit 静默夹断同一类误导。
 * 规则：缺失（undefined/null/""）→ 用默认值；命中允许值（去首尾空白、大小写不敏感）→ 归一为小写；
 * 其它 → E_PARAM（no-retry）报错并列出允许值。
 * 只接受字符串命中——类型混淆（数字/布尔/数组/对象）一律拒绝：单元素数组 String(["json"])==="json"
 * 会绕过校验被静默执行（实测 bug），任何非字符串都不参与匹配。
 */
export function enumArg(v, name, allowed, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const s = typeof v === "string" ? v.trim().toLowerCase() : null;
  if (s !== null && s !== "" && allowed.includes(s)) return s;
  throw new ToolError("E_PARAM", `Invalid '${name}': ${JSON.stringify(v)} is not one of [${allowed.join(", ")}].`);
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

/**
 * v1.6.27: scrub 的字节域形态——逐 key 在 UTF-8 字节流上把口令替换为 ***，直出 Buffer。
 * 动机：export_data 落盘旧链路是 scrub(content) 的 split/join + Buffer.from，content 与 join
 * 产物两份完整字符串同时在堆上，scrub 段堆峰 76MB、进程 RSS 峰 204MB（30k 行/16CSV 实测）。
 *
 * 形态是原地压实（in-place compaction），不是「输入+输出双缓冲」：双缓冲版本实测把堆省下的
 * 又还给外部内存（RSS 204→208，无收益）。*** 恒为 3 字节，凡 key ≥3 字节时输出指针永远落后或
 * 等于读指针（每次命中净消耗 |key|-3 字节），可在同一块 Buffer 上边扫边压实，全程零额外分配；
 * 扫描始终看压实前的原区（write ≤ read 保证未读区不被改写），与字符串链匹配集一致。
 * |key|<3 的罕见形态（替换后输出可能增长）回落片段拼接。多个 key 逐 pass 进行，
 * pass 间用收窄视图衔接——与字符串链「上一 key 的产物是下一 key 的输入」语义一致，
 * 跨替换边界的匹配（如 ["X","a***b"] 遇 "aXb"）不丢失。
 *
 * 恒等性（与 Buffer.from(scrubWith(t, list), "utf8") 逐字节相同，自测差分钉死）：
 * 替换串 "***" 是 ASCII，任何位置都不会切碎 UTF-8 多字节序列；UTF-8 自同步且 key 良构，
 * 字节域匹配集与字符串域一一对应。
 *
 * 回落：文本或任一 key 含孤立代理项时走 scrubWith 旧链路再转 Buffer——孤立代理在 UTF-8 编码中
 * 变成 U+FFFD，与字面 U+FFFD 同字节，字节域匹配集会与字符串域分叉；回落保证这种退化输入下
 * 字节仍与旧行为恒等。
 *
 * 明确偏离 scrubWith 的退化输入（SECRET_LIST 不会产生，语义钉在自测里）：空 key 跳过
 * （scrubWith 对 "" 会在每个码元间插 "***"，无产品语义）；非字符串 key 跳过（scrubWith 会隐式强转）。
 */
const SCRUB_STAR = Buffer.from("***", "utf8");
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// v1.6.31: 逐格哨兵预筛——孤立代理必然先是代理码元，普通格一步类正则失败即免掉 lookaround 正则
//（30k 行微基准：无预筛 14.1-15.3ms vs 预筛 13.8-15.2ms，预筛恒不更慢且省掉无谓 lookaround）
const ANY_SURROGATE = /[\uD800-\uDFFF]/;

/** 单 key 原地压实：把 buf[0,len) 中的 kb 替换为 ***（要求 kb.length ≥ 3），返回新长度。write ≤ read 不变式保证未读区不被改写。 */
function scrubPassInPlace(buf, len, kb) {
  let read = 0, write = 0, idx;
  while ((idx = buf.indexOf(kb, read)) !== -1) {
    const gap = idx - read;
    if (gap > 0) { buf.copy(buf, write, read, idx); write += gap; }
    SCRUB_STAR.copy(buf, write); write += 3;
    read = idx + kb.length;
  }
  if (len > read) { buf.copy(buf, write, read, len); write += len - read; }
  return write;
}

/**
 * scrub 的字节域入口（输入已是 UTF-8 Buffer）：逐 key 原地压实替换为 ***。
 * 前置：buf 与 list 均不含孤立代理项痕迹（Buffer 侧不可检测——孤立代理编码后与字面 U+FFFD
 * 同字节；字符串入口 scrubToBuffer 自动守门，直调本函数的组装链由 exportToCsvBuffer 的
 * saw_lone_surrogate 哨兵守门）。返回可能是原 Buffer 的收窄视图，调用方按 .length 计量。
 */
export function scrubBuffer(buf, list) {
  const keys = (list || []).filter((k) => typeof k === "string" && k.length > 0);
  let cur = buf;
  let len = buf.length;
  for (const k of keys) {
    const kb = Buffer.from(k, "utf8");
    if (kb.length >= 3) {
      len = scrubPassInPlace(cur, len, kb);
      cur = cur.subarray(0, len);   // 收窄视图（不拷贝），下一个 key 在压实产物上再扫
    } else {
      // |key|<3：替换后输出可能增长，原地压实不再安全，走片段拼接
      const view = cur.subarray(0, len);
      const parts = [];
      let start = 0, idx;
      while ((idx = view.indexOf(kb, start)) !== -1) {
        if (idx > start) parts.push(view.subarray(start, idx));
        parts.push(SCRUB_STAR);
        start = idx + kb.length;
      }
      if (start === 0) continue;   // 无命中：直通
      if (start < view.length) parts.push(view.subarray(start));
      cur = Buffer.concat(parts);
      len = cur.length;
    }
  }
  return cur;
}

export function scrubToBuffer(text, list) {
  const s = String(text);
  const keys = (list || []).filter((k) => typeof k === "string" && k.length > 0);
  if (LONE_SURROGATE.test(s) || keys.some((k) => LONE_SURROGATE.test(k))) {
    return Buffer.from(scrubWith(s, keys), "utf8");
  }
  return scrubBuffer(Buffer.from(s, "utf8"), keys);
}

/**
 * v1.6.29: 流式清洗管线——把 scrubWith/scrubBuffer 的「整段逐 key 替换」摊平成可逐块喂入的
 * 流式替换，供 export 整链流式写盘消掉 scrubbed 全量缓冲。每 key 一级：feed(chunk[, emit])
 * 逐块喂入，emit 形态逐片流出当前可确定的输出（零拷贝视图），末尾 flush([emit]) 吐出尾随暂存。
 * 恒等性（与 Buffer.from(scrubWith(t, list), "utf8") 逐字节相同，自测切分不变性钉死）：
 * - 单级 = 左到右贪心非重叠全局替换，与 split/join 语义一致：凡完整落进已喂字节的匹配立即替换；
 *   未确定区（尾部 < |k| 字节）整体暂存——尾部长度不足以藏完整匹配，下一块连同暂存重扫，
 *   跨块边界与跨 UTF-8 多字节序列的匹配不丢，贪心次序与整段扫描一致（跨界候选最左优先）；
 * - 多级串接：第 i 级吃第 i−1 级的完整输出流（flush 时先放行上级尾部再放行本级），与
 *   「上一 key 的产物是下一 key 的输入」一致，跨替换边界的匹配（如 ["X","a***b"] 遇 "aXb"）不丢；
 * - 替换串 "***" 可长于短 key（|k|<3），流式路径不做原地压实、无输出增长约束，短 key 同口径处理。
 * 实现（v1.6.29 二版）：碎片原生零拷贝——尾部暂存是 ≤|k|-1 字节的小拷贝，未匹配间隙直接
 * 流出调用方缓冲的视图、不做整块 concat。首版整块 concat 形态实测把分配抖动顶到 ~120MB，
 * 流式链 RSS 反而高于缓冲链（145.6 vs 137.1，产品 201 vs 177.5），故改为零拷贝。
 * 输出碎片契约：emit 收到的碎片是输入缓冲视图或共享常量 SCRUB_STAR，仅在回调期间有效、
 * 回调内不得改写；需留存请自行 Buffer.from 拷贝。feed(chunk) 无 emit 时聚合返回单缓冲（供测试）。
 * 前置（与 scrubBuffer 相同）：内容与 list 不含孤立代理项（字节域与字符串域匹配集会分叉），
 * 产品路径由 doExportData 的哨兵门守着；空 key/非字符串 key 跳过（同 scrubBuffer 语义）。
 */
export function createScrubPipeline(list) {
  const keys = (list || []).filter((k) => typeof k === "string" && k.length > 0);
  const EMPTY = Buffer.alloc(0);
  if (!keys.length) {
    return {
      feed(chunk, emit) {
        if (emit) { if (chunk && chunk.length) emit(chunk); return undefined; }
        return chunk || EMPTY;
      },
      flush(emit) { return emit ? undefined : EMPTY; },
    };
  }
  // 逐级：kb = key 字节，m = |k|，hold = 尾部暂存上限 |k|-1，tail = 待定未匹配尾（独立小拷贝）
  const stages = keys.map((k) => {
    const kb = Buffer.from(k, "utf8");
    return { kb, m: kb.length, hold: Math.max(0, kb.length - 1), tail: EMPTY };
  });
  // 发射虚拟流 V = tail ++ chunk 上的未匹配区间 [a,b)（跨 tail|chunk 边界拆两片视图）
  const emitGap = (st, emit, a, b) => {
    if (a >= b) return;
    const tl = st.tail.length;
    if (a < tl) emit(st.tail.subarray(a, Math.min(b, tl)));
    if (b > tl) emit(st.chunk.subarray(Math.max(a, tl) - tl, b - tl));
  };
  const runStage = (st, chunk, emit) => {
    st.chunk = chunk;   // emitGap 取片用（调用级生命周期）
    const tl = st.tail.length, fl = chunk.length;
    const Vlen = tl + fl;
    let cur = 0;        // 虚拟流上的未匹配发射游标
    let fpos = 0;       // chunk 内扫描起点（跨界命中后跳过已消费区）
    // phase A：起点落在尾部暂存区的跨块匹配（≤ |k|-1 个候选，最左优先；命中即消费到 chunk 内）
    for (let s = 0; s < tl; s++) {
      if (s + st.m > Vlen) break;                       // 起点过晚、匹配不完整，留给下一块
      const j = tl - s;                                 // 命中取自 tail 的字节数（≥1）
      if (st.m - j <= fl
          && Buffer.compare(st.tail.subarray(s), st.kb.subarray(0, j)) === 0
          && Buffer.compare(chunk.subarray(0, st.m - j), st.kb.subarray(j)) === 0) {
        emitGap(st, emit, cur, s);
        emit(SCRUB_STAR);
        cur = s + st.m;
        fpos = st.m - j;
        break;
      }
    }
    // phase B：chunk 内匹配（贪心左到右非重叠）
    let idx;
    while ((idx = chunk.indexOf(st.kb, fpos)) !== -1) {
      emitGap(st, emit, cur, tl + idx);
      emit(SCRUB_STAR);
      cur = tl + idx + st.m;
      fpos = idx + st.m;
    }
    // 尾部暂存：只放行确定部分（其后再无完整匹配可能），其余留待下一块重扫
    const cut = Math.max(cur, Vlen - st.hold);
    emitGap(st, emit, cur, cut);
    if (cut >= Vlen) st.tail = EMPTY;
    else if (cut >= tl) st.tail = Buffer.from(chunk.subarray(cut - tl));   // 小拷贝：立即释放对 chunk 的引用
    else st.tail = Buffer.concat([st.tail.subarray(cut), chunk]);          // 新尾跨界（短流首块）：≤ |k|-1 字节
  };
  const chain = (i, chunk, emit) => {
    if (!chunk || !chunk.length) return;
    if (i === stages.length) { emit(chunk); return; }
    runStage(stages[i], chunk, (frag) => chain(i + 1, frag, emit));
  };
  const release = (fn) => {
    // 尾部按流序放行：上级尾部先过下游各级（会更新下游 tail），再逐级放行本级
    for (let i = 0; i < stages.length; i++) {
      const t = stages[i].tail;
      stages[i].tail = EMPTY;
      if (t.length) chain(i + 1, t, fn);
    }
  };
  return {
    feed(chunk, emit) {
      if (emit) { chain(0, chunk, emit); return undefined; }
      const got = [];
      chain(0, chunk, (b) => { if (b.length) got.push(b); });
      return got.length ? (got.length === 1 ? got[0] : Buffer.concat(got)) : EMPTY;
    },
    flush(emit) {
      if (emit) { release(emit); return undefined; }
      const got = [];
      release((b) => { if (b.length) got.push(b); });
      return got.length ? (got.length === 1 ? got[0] : Buffer.concat(got)) : EMPTY;
    },
  };
}
// v1.6.9：观测日志的脱敏复用同一 scrub（单一真相源，防清洗规则漂移）
setScrub(scrub);

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
  if (cfg.__initRequired) throw new ToolError("E_CONFIG", INIT_HINT);
  const s = cfg.sources[id];
  if (!s) {
    const names = Object.keys(cfg.sources).join(", ") || "(none)";
    throw new ToolError("E_NOT_FOUND", `Unknown source '${id}'. Available sources: ${names}`);
  }
  // v1.6.8 真实测试修复：sqlite 源支持 url（sqlite://path）与 file 两种形态（sqliteFilePath/列表层早已双认），
  // 旧版此处只认 s.url——file 形态的源能被列出却在所有数据工具报 "Unknown source"（错误码/文案双误导）。
  if (!s.url && !s.file) {
    throw new ToolError("E_CONFIG", `Source '${id}' 缺少连接信息（url 或 file），请检查 dbmcp.config.json。`);
  }
  // v1.0.1: 类型归一化移至加载期，工具调用期不再改写共享配置对象
  if (s.type !== "mysql" && s.type !== "postgres" && s.type !== "sqlite") {
    throw new ToolError("E_CONFIG", `Source '${id}' has unsupported type '${s.type}' (mysql | postgres | oceanbase-as-mysql | sqlite).`);
  }
  return s;
}

// v1.4.0: 连接层拆分至 pool.mjs（依赖注入 cfg/getSource/clampInt/sqliteFilePath），此处构造单例
// v1.5.3: 注入 scrub（慢查询日志的 SQL 预览同过输出清洗）+ 解构 withTransaction（import atomic）
// v1.6.21: runCopyIn（import_data 的 PG COPY FROM STDIN 批路径）
const { getPool, runQuery, runQueryStream, runCopyIn, withTransaction } = createPoolManager({ cfg, getSource, clampInt, sqliteFilePath, scrub });

/* ------------------------------ identifier utils ---------------------------- */

export function splitIdent(table) {
  const parts = String(table).split(".");
  if (parts.length > 2) throw new ToolError("E_PARAM", `Invalid table name: ${table}`);
  const [t, s] = [parts[parts.length - 1], parts.length === 2 ? parts[0] : null];
  for (const p of [t, s].filter(Boolean)) {
    // v1.6.8 真实测试修复：Unicode 感知——旧版纯 ASCII 正则把中文表名/列名判为
    // "Invalid identifier"（国内库常态名称全被拒）。注入字符（引号/分号/空格等）依旧拒绝。
    if (!/^[_\p{L}][\p{L}\p{N}$_]*$/u.test(p)) {
      throw new ToolError("E_PARAM", `Invalid identifier '${p}'. Pass plain names; use the schema parameter instead of qualified names.`);
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

/**
 * v1.6.3: opts.export=true 为落盘导出模式（export_data 的 JSON 路径专用）——
 *  1) 不做单元格截断：响应面的 2000 字符截断是为省上下文，但导出文件是"交接数据给用户/下游工具"，
 *     旧版把 >2000 字符的 TEXT 截成 "… <truncated N chars>" 属静默数据丢失（CSV 路径不截断，
 *     两条路径口径不一致，往返对比会对不上）；文件大小由 20MB 导出上限兜底。
 *  2) Buffer 输出完整十六进制（与 csvCell 同口径，往返可还原），不再用 <binary …> 预览标记。
 * 工具响应面行为不变（截断 + 8 字节预览）。口令清洗两条路径都在出口统一做（scrub）。
 */
export function stringify(v, opts = {}) {
  const exportMode = opts.export === true;
  const pretty = process.env.DBMCP_PRETTY === "1";
  const max = exportMode ? Infinity : maxCellChars();
  return JSON.stringify(
    v,
    (k, x) => {
      if (typeof x === "bigint") return x.toString();
      if (typeof x === "number" && !Number.isFinite(x)) return String(x);
      if (typeof x === "string") {
        // 超长文本先清洗口令再截断，避免口令被截成前缀后清洗失效
        return x.length > max ? truncateCell(scrub(x), max) : x;
      }
      // v1.6.16: live 字节视图（Uint8Array/Buffer/DataView）统一十六进制口径——node:sqlite 的
      // BLOB 返回 Uint8Array（无 toJSON），旧版只认 {type:"Buffer"} 形状，Uint8Array 被 JSON
      // 序列化成 {"0":..} 键值垃圾（对抗测试台实测抓获）；mysql2/pg 的 Buffer 实例同走此分支
      if (x && typeof x === "object" && ArrayBuffer.isView(x)) {
        const buf = Buffer.from(x.buffer, x.byteOffset, x.byteLength);
        if (exportMode) return buf.toString("hex");
        const hex = buf.subarray(0, 8).toString("hex");
        return buf.length > 8 ? `<binary ${buf.length} bytes: ${hex}…>` : `<binary ${buf.length} bytes: ${hex}>`;
      }
      if (x && typeof x === "object" && x.type === "Buffer" && Array.isArray(x.data)) {
        if (exportMode) return Buffer.from(x.data).toString("hex");
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
    title: "List Sources",
    description:
      "List configured database connections (MySQL/PostgreSQL/SQLite) with type/host/port/database (SQLite shows the local file path). Call this first to see what you can query. Example: {}.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_tables",
    title: "List Tables",
    description:
      "List tables/views of a source with estimated row counts and comments. Use comments and names to locate the right table before querying. Example: {\"source\": \"demo\", \"name_like\": \"notice\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        name_like: { type: "string", description: "Optional case-insensitive substring filter on table/view name (e.g. \"notice\")." },
        limit: { type: "integer", minimum: 1, maximum: 5000, description: "Max tables returned (default 500). Values above the max are clamped to the max, not rejected." },
      },
      required: ["source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "describe_table",
    title: "Describe Table",
    description:
      "Show columns (name/type/nullable/default/PK/comment), indexes, table comment and approximate row count. Call before writing SQL against an unfamiliar table. Example: {\"source\": \"demo\", \"table\": \"notice_msg\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        table: { type: "string", description: "Table name (plain). Use schema param for another schema." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
      },
      required: ["source", "table"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "find_tables_by_column",
    title: "Find Tables by Column",
    description:
      "Find tables that contain a column matching a keyword (case-insensitive substring). " +
      "Returns column name/type/PK/comment per match and the distinct table list. " +
      "Use it when you know a column name (e.g. 'order_no') but not which table holds it. Example: {\"source\": \"demo\", \"column\": \"order_no\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        column: { type: "string", description: "Column name or keyword (case-insensitive substring)." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max column matches returned (default 100). Values above the max are clamped to the max, not rejected." },
      },
      required: ["source", "column"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "fk_relationships",
    title: "Foreign Key Relationships",
    description:
      "List foreign-key relationships (table.column -> referenced_table.column) for one table or the whole schema (default limit 200). " +
      "Use it to build correct JOINs and understand referential integrity before writing cross-table queries. Example: {\"source\": \"demo\", \"table\": \"notice_msg\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        table: { type: "string", description: "Optional table name. Omit to list all FKs of the schema." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Max relationships returned (default 200). Values above the max are clamped to the max, not rejected." },
      },
      required: ["source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "query",
    title: "Run Read-Only Query",
    description:
      "Run a READ-ONLY SQL statement: SELECT / WITH...SELECT / SHOW / DESCRIBE / EXPLAIN. Writes, DDL, multi-statements and row locks are blocked. A LIMIT is enforced automatically (default 200 rows). Results: columns, rows (JSON objects), row_count, truncated. For row-count checks use count_rows. Example: {\"source\": \"demo\", \"sql\": \"SELECT id, title FROM notice_msg ORDER BY id DESC LIMIT 20\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        sql: { type: "string", description: "A single read-only statement. Prefer an explicit LIMIT for large tables." },
        max_rows: { type: "integer", minimum: 1, maximum: 5000, description: "Max rows returned (default from config, usually 200). Values above the max are clamped to the max, not rejected." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "query_plan",
    title: "Explain Query Plan",
    description:
      "Run EXPLAIN on a single SELECT / WITH...SELECT statement and return the execution plan (format: 'text' default, or 'json'). " +
      "Read-only: the statement itself is never executed (ANALYZE is not supported). " +
      "Use it to check index usage and row estimates before running an expensive query. Example: {\"source\": \"demo\", \"sql\": \"SELECT * FROM notice_msg WHERE status = 'SENT'\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        sql: { type: "string", description: "A single SELECT / WITH...SELECT statement." },
        format: { type: "string", enum: ["text", "json"], description: "Plan format (default 'text')." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "sample_data",
    title: "Sample Rows",
    description:
      "Peek at the first N rows of a table (SELECT * ... LIMIT, default 10, max 50). Optionally filter with a WHERE condition and/or order by a column, e.g. where: \"status = 'SENT'\", order_by: \"created_at DESC\". Quick way to see real data shape and verify content. Example: {\"source\": \"demo\", \"table\": \"notice_msg\", \"where\": \"status = 'SENT'\", \"order_by\": \"created_at DESC\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        table: { type: "string", description: "Table name (plain). Use schema param for another schema." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max rows to sample (default 10). Values above the max are clamped to the max, not rejected." },
        where: { type: "string", description: "Optional WHERE condition (boolean expression, without the WHERE keyword)." },
        order_by: { type: "string", description: "\"column\" or \"column ASC|DESC\" (e.g. created_at DESC). Defaults to ascending." },
      },
      required: ["source", "table"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "distinct_values",
    title: "Distinct Values",
    description:
      "Top-N value distribution of a column: GROUP BY column ORDER BY count DESC (default 20, max 200), plus the exact distinct total. " +
      "Great for enum/status columns and data verification (compare observed values vs expected set). NULL is one group. Optional where filter. " +
      "Note: counting scans matching rows; prefer a where filter on very large tables. Example: {\"source\": \"demo\", \"table\": \"notice_msg\", \"column\": \"status\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        table: { type: "string", description: "Table name (plain). Use schema param for another schema." },
        column: { type: "string", description: "Plain column name (no qualification)." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        where: { type: "string", description: "Optional WHERE condition (boolean expression, without the WHERE keyword)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max distinct values returned (default 20). Values above the max are clamped to the max, not rejected." },
      },
      required: ["source", "table", "column"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "column_stats",
    title: "Column Statistics",
    description:
      "Statistical profile of one column in a single aggregate query, returned in a stats object: row_count, non_null, distinct_values, min_value, max_value (lexicographic for text), avg_value (numeric; null for non-numeric columns on PostgreSQL). " +
      "Avg dialect semantics: MySQL/SQLite coerce non-numeric text to 0 in AVG, PostgreSQL type-gates to NULL for non-numeric columns. " +
      "Optional where filter; optional histogram (equal-width buckets for numeric columns; non-numeric columns yield an empty array) and top_values (most frequent values). " +
      "Use for data sanity checks: null rate, value ranges, cardinality, distribution shape. Note: COUNT(DISTINCT) scans matching rows on large tables. Example: {\"source\": \"demo\", \"table\": \"notice_msg\", \"column\": \"created_at\", \"histogram\": {\"buckets\": 10}}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        table: { type: "string", description: "Table name (plain). Use schema param for another schema." },
        column: { type: "string", description: "Plain column name (no qualification)." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "count_rows",
    title: "Count Rows",
    description:
      "Exact row count of a table, optionally with a WHERE condition (e.g. status = 'SENT' AND created_at >= '2025-01-01'). Use it to verify data: compare counts before/after, assert expected totals, check for duplicates (count vs distinct). Example: {\"source\": \"demo\", \"table\": \"notice_msg\", \"where\": \"status = 'SENT'\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        table: { type: "string", description: "Table name (plain). Use schema param for another schema." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        where: { type: "string", description: "Optional WHERE condition (boolean expression, without the WHERE keyword)." },
      },
      required: ["source", "table"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "execute",
    title: "Execute Write Statement",
    description:
      "Execute a single INSERT/UPDATE/DELETE (only when allowWrites=true in config; disabled by default). " +
      "SECURITY RED LINE: UPDATE/DELETE without a WHERE clause and TRUNCATE TABLE are ALWAYS refused - " +
      "even if the user explicitly requests full-table changes; direct the user to perform such operations manually via other channels (e.g. DBeaver) with DBA approval. " +
      "DDL is never allowed. Returns affected row count for verification. Example: {\"source\": \"demo\", \"sql\": \"UPDATE notice_msg SET status = 'SENT' WHERE id = 123\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        sql: { type: "string", description: "A single INSERT/UPDATE/DELETE statement with explicit WHERE for UPDATE/DELETE." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "create_table",
    title: "Create Table",
    description:
      "Create a new table (single CREATE TABLE statement). " +
      "Requires allowCreateTable=true in the config. DROP/TRUNCATE/ALTER and data-changing statements are never allowed. " +
      "OceanBase sources must be MySQL-mode. SQLite: CREATE TABLE without AUTOINCREMENT (use INTEGER PRIMARY KEY for rowid alias). Returns the executed DDL for verification. Example: {\"source\": \"demo\", \"sql\": \"CREATE TABLE t_check (id INT PRIMARY KEY, note VARCHAR(64))\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        sql: { type: "string", description: "A single CREATE TABLE statement (MySQL or PostgreSQL dialect matching the source type)." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "find_database",
    title: "Find Database",
    description:
      "Find configured sources by database name, source id or environment (e.g. 'za_data_notice', 'test', 'TEST', 'pre', 'uat'). " +
      "Returns matching source ids to use as 'source' in other tools. Optionally probes TCP reachability. Example: {\"name\": \"za_data_notice\", \"env\": \"TEST\"}.",
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "export_data",
    title: "Export Query Result",
    description:
      "Export the result of a single read-only SELECT to a CSV or JSON file on the MCP server host. " +
      "Requires DBMCP_EXPORT_DIR (server-side allowlist directory); filenames are sanitized and cannot escape it; refuses to overwrite unless overwrite:true; 20MB size cap. " +
      "Row limit defaults to 5000 (max 100000). Use for handing data to the user or feeding other tools. Example: {\"source\": \"demo\", \"sql\": \"SELECT id, title FROM notice_msg\", \"format\": \"csv\", \"filename\": \"notice.csv\"}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        sql: { type: "string", description: "A single read-only SELECT / WITH statement." },
        format: { type: "string", enum: ["csv", "json"], description: "Output format (default csv)." },
        filename: { type: "string", description: "Optional file name (sanitized; auto-generated when omitted). Must stay inside DBMCP_EXPORT_DIR." },
        limit: { type: "integer", minimum: 1, maximum: 100000, description: "Max rows to export (default 5000). Values above the max are clamped to the max, not rejected." },
        overwrite: { type: "boolean", description: "Overwrite existing file (default false)." },
        raw_formulas: { type: "boolean", description: "CSV only: disable formula-injection neutralization (default false — string cells starting with = + - @ TAB CR get a ' prefix so spreadsheet apps don't execute them)." },
      },
      required: ["source", "sql"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "import_data",
    title: "Import CSV Rows",
    description:
      "Import rows from a CSV file on the MCP server host into a table (batched parameterized INSERTs on MySQL/SQLite, COPY FROM STDIN on PostgreSQL). " +
      "First CSV line must be plain column names. Requires allowWrites and DBMCP_IMPORT_DIR (or DBMCP_EXPORT_DIR) allowlist directory; " +
      "filenames are sanitized; caps: 10000 rows / 20MB; emptyAsNull maps empty cells to NULL; strip_neutralization reverses " +
      "export_data's formula neutralization (round-trip); atomic wraps the whole file in one transaction (all-or-nothing). " +
      "Aborts on width mismatch or row error. Example: {\"source\": \"demo\", \"table\": \"notice_msg\", \"filename\": \"notice.csv\", \"emptyAsNull\": true}.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source id from list_sources." },
        table: { type: "string", description: "Table name (plain). Use schema param for another schema." },
        filename: { type: "string", description: "CSV file name inside the import allowlist directory (first line = column names)." },
        schema: { type: "string", description: "Optional schema/database name. Defaults to the connection database (MySQL) or 'public' (PostgreSQL)." },
        emptyAsNull: { type: "boolean", description: "Treat empty cells as NULL (default false = empty string)." },
        strip_neutralization: { type: "boolean", description: "Reverse export_data's formula neutralization: strip the leading ' from cells like '=1+1 (exact inverse; default false keeps file content as-is)." },
        atomic: { type: "boolean", description: "Wrap the whole file in ONE transaction (all-or-nothing: any error rolls back everything). Default false = per-batch atomicity with row-wise fallback that locates the bad row but keeps earlier rows." },
      },
      required: ["source", "table", "filename"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

const INSTRUCTIONS =
  "calvin-db-mcp: operate MySQL, PostgreSQL, OceanBase (MySQL mode) and local SQLite files across TEST/PRE/UAT/DEV environments. " +
  "Workflow: list_sources/find_database -> list_tables/describe_table/find_tables_by_column/fk_relationships -> " +
  "query/sample_data/distinct_values/column_stats/count_rows (query_plan to check a plan before expensive queries) -> " +
  "execute (INSERT/UPDATE/DELETE when allowWrites=true) / create_table (when allowCreateTable=true). " +
  "export_data writes a read-only query result to a CSV/JSON file (requires DBMCP_EXPORT_DIR on the server host); " +
  "import_data loads a CSV from the import allowlist into a table (batched parameterized INSERTs on MySQL/SQLite, COPY FROM STDIN on PostgreSQL; requires allowWrites). " +
  "'query' is strictly read-only (single statement, auto LIMIT, timeout). SECURITY RED LINES: UPDATE/DELETE without WHERE, " +
  "TRUNCATE, and any WHERE that does not reference a real column (1=1, true, 2>1, 'a'='a') are ALWAYS refused even if the user insists. " +
  "UPDATE/DELETE are pre-counted with the same WHERE and refused when they would exceed maxAffectedRows. " +
  "Use find_database to locate a database by name or environment; same-instance cross-database reads work with db.table qualified names. " +
  "Verify affected row counts with count_rows after writes. " +
  "ERROR SEMANTICS: tool errors start with 'Error: [E_CODE:retry]': E_SAFETY=guard/red-line refusal (never retry the same call); " +
  "E_PARAM=bad arguments or statement shape (fix then retry); E_NOT_FOUND=source/table/column/file missing; " +
  "E_CONFIG=deployment/config state (init or permissions, needs operator action); E_LIMIT=over a limit (narrow scope, then retry); " +
  "E_DB=database error (the retry tag says whether a same-args retry may work); E_INTERNAL=unclassified (do not retry unchanged). " +
  "The retry tag is one of retryable | conditional | no-retry. " +
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
    if (!cols.rows.length) throw new ToolError("E_NOT_FOUND", `Table '${table}' not found in schema '${schema || "(connection database)"}'.`);
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
    if (!cols.length) throw new ToolError("E_NOT_FOUND", `Table '${table}' not found (sqlite file).`);
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
  if (!cols.rows.length) throw new ToolError("E_NOT_FOUND", `Table '${table}' not found in schema '${schema || "public"}'.`);
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
      throw new ToolError("E_PARAM", 
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
    const m = /^([\p{L}\p{N}$_]+)\s*(?:(ASC|DESC))?$/iu.exec(String(orderBy).trim());
    if (!m) throw new ToolError("E_PARAM", "Invalid order_by: use \"column\" or \"column ASC|DESC\" (e.g. created_at DESC).");
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
  if (!column) throw new ToolError("E_PARAM", "Provide a column name or keyword, e.g. 'order_no'.");
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
    throw new ToolError("E_PARAM", "query_plan only accepts a single SELECT / WITH ... SELECT statement.");
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
  const format = enumArg(args.format, "format", ["text", "json"], "text");
  // 内层语句必须是合法只读语句（拦 FOR UPDATE / INTO OUTFILE / 行锁等），EXPLAIN 整句再过一次（纵深）
  const inner = String(args.sql).trim().replace(/;\s*$/, "");
  guardReadOnly(inner, maskDialect(src.type));
  const sql = explainSql(src.type, inner, format);
  guardReadOnly(sql, maskDialect(src.type));
  const { rows, fields, ms } = await runQuery(args.source, sql);
  return {
    source: args.source,
    sql_explained: inner,
    plan_format: src.type === "sqlite" ? "text (EXPLAIN QUERY PLAN)" : format === "json" ? "json" : "text",
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
  // v1.6.18 真实库实测：PG 的 AVG(varchar) 是硬错误（42883 undefined_function），文本列整条
  // 画像语句失败——top_values 的主用例（tag 之类低基数文本列）在 PG 上完全跑不通（MySQL 靠
  // 隐式强转侥幸通过）。按类型门控：仅数值类型求均值，文本列 avg 为 NULL（min/max 文本仍按
  // 字典序，契约不变）；mysql/sqlite 保持原生 AVG 语义。CASE 短路保证 THEN 的 cast 不在文本行求值。
  // 补洞（真实库时间列抓获）：CASE 短路只挡运行时——timestamp/date/uuid 等没有 →numeric 注册
  // cast 的类型，裸 )::numeric 在计划期就报 42846（cannot cast）整条画像失败；走 ::text::numeric
  //（text→numeric 是显式 cast，计划期任意类型合法），运行时仍由 CASE 类型门控保证非数值列不进 THEN。
  const avg = dbType === "postgres"
    ? `AVG(CASE WHEN pg_typeof(${q}) IN ('smallint'::regtype, 'integer'::regtype, 'bigint'::regtype, 'numeric'::regtype, 'real'::regtype, 'double precision'::regtype) THEN (${q})::text::numeric END)`
    : `AVG(${q})`;
  return `SELECT ${cnt} AS row_count, COUNT(${q}) AS non_null, COUNT(DISTINCT ${q}) AS distinct_values, MIN(${q}) AS min_value, MAX(${q}) AS max_value, ${avg} AS avg_value FROM ${ref}${w}`;
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
  // v1.6.20 真实库实测：文本列直方图三库三种坏法——PG 的 (hi-lo)/(val-lo) 是 text-text 减法，
  // 42883 硬错误整条失败（与 v1.6.18 AVG(varchar) 同族）；mysql 把字符串算术得 NULL 宽、sqlite
  // 强转 0 得 0 宽再除出 NULL 桶号，外层 GROUP BY 各产出一行 bucket_index=null 的脏桶。修复：
  // PG 按类型门控做减法（非数值列恒 NULL），三库统一在 GROUP BY 前过滤 bi IS NOT NULL——
  // 非数值列直方图语义收口为「空数组」（不炸不脏）；mysql/sqlite 对数字样文本的强转 GIGO
  // 与 avg 契约哲学一致，不在 SQL 层强拉平。
  const numv = (expr) => dbType === "postgres"
    ? `(CASE WHEN pg_typeof(${expr}) IN ('smallint'::regtype, 'integer'::regtype, 'bigint'::regtype, 'numeric'::regtype, 'real'::regtype, 'double precision'::regtype) THEN (${expr})::text::numeric END)`
    : dbType === "mysql"
      // 残洞（真实库第 25 轮抓获）：DATETIME/DATE 隐式转数是「读数字头」（'2024-01-01 00:00:05'
      // → 20240101000005），桶界产出 20240101000000.00000 伪数值脏桶，破上文「非数值列 → 空数组
      // （不炸不脏）」承诺——PG 类型门控、sqlite 0 宽除 NULL 均已收口，唯 mysql 时间列漏网。按值
      // 形状门控：仅数值形状（可带小数/指数）参与减法；数值样文本照旧强转 GIGO（「数字样文本」
      // 注记不变），时间列/纯文本 → 桶号 NULL → 外层过滤 → 空数组。字符类 [.] 免 SQL 字面量
      // 反斜杠转义歧义（\x60 陷阱同族）。
      ? `(CASE WHEN ${expr} REGEXP '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' THEN ${expr} END)`
      : expr;
  const biRaw = `CAST(FLOOR((${numv(`t.${q}`)} - b.lo) / b.width) AS ${cast})`;
  // v1.6.20 续修（探针复跑抓获）：PG 的 LEAST 忽略 NULL 参数——LEAST(NULL, n-1) 得 n-1，
  // 非数值行的 NULL 桶号会被顶成末桶号漏过过滤；mysql 的 LEAST 与 sqlite 的 MIN 都是 NULL 透传。
  // PG 用 CASE 显式透传 NULL，钳位语义三库对齐：非数值行 bi=NULL → 外层过滤 → 空数组。
  const bi = dbType === "postgres"
    ? `CASE WHEN ${biRaw} IS NULL THEN NULL ELSE LEAST(${biRaw}, ${n - 1}) END`
    : `${clampFn}(${biRaw}, ${n - 1})`;
  return `WITH rng AS (SELECT MIN(${numv(q)}) AS lo, MAX(${numv(q)}) AS hi FROM ${ref}${where ? ` WHERE (${where})` : ""}), ` +
    `buckets AS (SELECT lo, hi, CASE WHEN hi = lo THEN 1.0 ELSE (hi - lo) * 1.0 / ${n} END AS width FROM rng), ` +
    `s AS (SELECT ${bi} AS bi ${inner}) ` +
    `SELECT s.bi AS bucket_index, ${cnt} AS row_count, ${lo} AS bucket_lower, b.lo + (s.bi + 1) * b.width AS bucket_upper ` +
    `FROM s CROSS JOIN buckets b WHERE s.bi IS NOT NULL GROUP BY s.bi, b.lo, b.width ORDER BY s.bi`;
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
  if (!/^[_\p{L}][\p{L}\p{N}$_]*$/u.test(column)) {
    throw new ToolError("E_PARAM", `Invalid column name '${column}'. Pass a plain column name (letters/digits/_/$, not starting with a digit).`);
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
//  2) 注入面——mysql/sqlite 批量参数化 INSERT、postgres COPY FROM STDIN 文本载荷，
//     CSV 单元格永不拼接进 SQL 文本（COPY 的表/列名同样经 quoteIdent 白名单）；
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
 * v1.6.20: 导入批大小按方言占位符预算 × 列数动态定（原硬编码 100）。
 * 直连实测（万行非事务路径，2026-10-05）：批 100 时 mysql 672ms / sqlite 607ms——每条
 * 多 VALUES 语句一个网络往返 + 一次提交，批越大往返越少；批 1000 mysql 降至 ~108ms
 * （5×）、pg 86→60ms 后趋平（甜点）、sqlite 同数量级收益。占位符硬上限：mysql/pg
 * 65535、node:sqlite 编译默认 32766（实测 25_000 占位符可用）——各留裕量后按列数均摊，
 * 宽表自动降批（60 列 CSV sqlite 100 行实测通过）。批失败回退逐行的定位语义不受批大小
 * 影响。纯函数供单测。
 */
export function importBatchSize(dbType, colCount) {
  const cols = Math.max(1, Math.floor(Number(colCount) || 1));
  // 预算裕量: sqlite 20000 < 32766（编译默认，且 25000 实测可用）; mysql/pg 50000 < 65535
  const budget = dbType === "sqlite" ? 20000 : 50000;
  return Math.max(1, Math.min(1000, Math.floor(budget / cols)));
}

/**
 * v1.6.21: import_data 的 postgres 批路径改用 COPY FROM STDIN（文本格式）——每批一次
 * 网络往返整批灌入，绕过逐行绑定/解析开销（万行非事务实测 ~5 倍，见 mcp/bench.mjs）。
 * mysql/sqlite 仍走参数化多 VALUES INSERT。批大小沿用 importBatchSize（回退逐行的成本上界
 * 不变，批失败语义与批 INSERT 完全一致：批原子未写入 → 回退逐行定位坏行）。
 * 纯函数供单测。
 */
export function importUsesCopy(dbType) {
  return dbType === "postgres";
}

/**
 * COPY 目标语句。表/列名全部经 quoteIdent（splitIdent 已把表名钉死为裸标识符、
 * CSV 表头同样正则白名单），值绝不进入 SQL 文本——语句用简单查询协议下发（COPY IN
 * 不支持扩展协议），注入面为零。
 */
export function importCopySql(dbType, ref, columns) {
  if (!importUsesCopy(dbType)) throw new ToolError("E_INTERNAL", "importCopySql 仅用于 postgres（mysql/sqlite 走参数化 INSERT）");
  const cols = columns.map((c) => quoteIdent(dbType, c)).join(", ");
  return `COPY ${ref} (${cols}) FROM STDIN`;
}

/**
 * COPY 文本格式单字段转义（PG 文本格式逐字节契约）：NULL = \N；值内 \ → \\、
 * LF → \n、CR → \r、TAB → \t、BS → \b、FF → \f、VT → \v；字面量 "\N" 编码为 \\N
 * （与 NULL 区分）；空串保持空字段。值内换行（v1.6.13 CSV 引号内 CRLF 保真）经此
 * 转义后原样往返——CSV 解析出的值不做任何换行归一。纯函数供单测。
 */
export function copyTextField(v) {
  if (v === null || v === undefined) return "\\N";
  const s = typeof v === "string" ? v : String(v);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c === "\b") out += "\\b";
    else if (c === "\f") out += "\\f";
    else if (c === "\v") out += "\\v";
    else out += c;
  }
  return out;
}

/** 整批行 → COPY 文本载荷：字段 TAB 分隔、记录裸 LF 分隔。纯函数供单测。 */
export function copyTextPayload(rows) {
  let out = "";
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) out += (i ? "\t" : "") + copyTextField(r[i]);
    out += "\n";
  }
  return out;
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

/**
 * 完整 CSV 文本 → 行数组（RFC 4180：引号内逗号/换行/双引号转义；BOM 由调用方剥）。纯函数供单测。
 * v1.6.13 保真修正：换行归一**只作用于记录分隔符**（引号外的 CRLF/CR/LF）；引号内的换行
 * 是数据值的一部分，必须原样保留——旧版先全局 \r\n→\n，"L1\r\nL2" 经导出→导入回环被压平成
 * "L1\nL2"（实测往返丢真）。记录分隔符在引号外识别（\r\n 一体消费），引号内逐字进值。
 */
export function parseCsv(text) {
  const src = String(text);
  const rows = [];
  let row = [];
  let inQuotes = false;
  // v1.6.25 构建重写（语义逐字不变，既有保真钉全绿）：旧版 field += c 逐字符拼接产生 per-char
  // cons rope——实测 18MB CSV 解析驻留 574MB（~32B/字符 rope 节点，V8 cons cell）。改为
  // 「原样 run 切片 + 合成片段 join」：引号开/闭与 "" 转义是 run 断点，字段内容仍是逐字节
  // 相同的字符序列（引号内换行/转义引号/记录分隔归一语义全部不变）。
  let parts = [];      // 当前字段已完成片段
  let runStart = -1;   // 当前原样 run 起点（-1 = 无进行中 run）
  const endRun = (p) => {
    if (runStart !== -1) {
      if (p > runStart) parts.push(src.slice(runStart, p));
      runStart = -1;
    }
  };
  const takeField = (end) => {
    endRun(end);
    const field = parts.length === 1 ? parts[0] : parts.join("");
    parts = [];
    return field;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { endRun(i); parts.push('"'); i += 1; }
        else { endRun(i); inQuotes = false; }
      } else if (runStart === -1) runStart = i;
      continue;
    }
    if (c === '"') { endRun(i); inQuotes = true; continue; }
    if (c === ",") { row.push(takeField(i)); continue; }
    if (c === "\n" || c === "\r") {
      const end = i;
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      row.push(takeField(end)); rows.push(row); row = []; continue;
    }
    if (runStart === -1) runStart = i;
  }
  const field = takeField(src.length);
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop(); // 尾空行
  return rows;
}

// v1.6.24: 大导入阶段间让出事件循环——读盘/CSV 解析/值变换等同步块切开，取消通知与定时器
// 在阶段间得以插队（实测 8MB 导入取消插队延迟峰值 109ms→见 changelog；串行队列语义不变）
const yieldEventLoop = () => new Promise((r) => setImmediate(r));

/**
 * v1.6.25: CSV 流式分段器（纯步进器，供 selftest 全偏移切分等价钉直接断言）。
 * 等价契约：对任意文本与任意 push 切分序列，concat(parseCsv(seg_i)) === parseCsv(整体)。
 * 切分规则（缺一即破等价，selftest 钉死）：
 *  1) 只在「引号外、非空记录」的记录终止符后定切点；空记录（[""] 形）归入下一段——
 *     否则段尾 [""] 会被 parseCsv 的尾空行弹出误吃，与整体解析不等价；
 *  2) 引号状态跨 push 持续；lookahead 相关的收尾字符（引号内的 `"`、引号外的 `\r`）
 *     停在段尾时暂缓定性，等下一 push 再判（CRLF 跨块不产生幻影空记录，`""` 跨块不拆对）；
 *  3) end() 余段原样交回 parseCsv 整体收口（EOF 弹出/未闭引号收尾与整体解析逐字节一致）。
 */
export function createCsvSegmenter() {
  let inQuotes = false;
  let fieldTouched = false; // 当前记录已有字段内容（非 [""] 形）
  let sawComma = false;     // 当前记录含逗号（行宽 ≥2，必非 [""] 形）
  let pending = "";
  let scanPos = 0;
  let cut = -1;             // pending 内安全切点（含），-1 = 无
  return {
    push(text) {
      pending += text;
      let i = scanPos;
      const end = pending.length;
      while (i < end) {
        const c = pending[i];
        // 收尾定性暂缓：段尾 lookahead 未知的字符（引号外 `\r` 待判 CRLF、引号内 `"` 待判转义对）
        if (i === end - 1 && ((!inQuotes && c === "\r") || (inQuotes && c === '"'))) break;
        if (inQuotes) {
          if (c === '"') {
            if (pending[i + 1] === '"') { fieldTouched = true; i += 1; }
            else inQuotes = false;
          } else fieldTouched = true;
          i += 1;
          continue;
        }
        if (c === '"') { inQuotes = true; i += 1; continue; }
        if (c === ",") { sawComma = true; i += 1; continue; }
        if (c === "\n" || c === "\r") {
          if (c === "\r" && pending[i + 1] === "\n") i += 1;
          if (sawComma || fieldTouched) cut = i + 1; // 非空记录终止→切点前进；空记录不设切点（归下一段）
          fieldTouched = false;
          sawComma = false;
          i += 1;
          continue;
        }
        fieldTouched = true;
        i += 1;
      }
      scanPos = i;
      if (cut > 0) {
        const seg = pending.slice(0, cut);
        pending = pending.slice(cut);
        scanPos -= cut;
        cut = -1;
        return [seg];
      }
      return [];
    },
    end() {
      // 余段（含暂缓未定性字符）整体交回 parseCsv：EOF 语义与整体解析逐字节一致
      return pending !== "" ? [pending] : [];
    },
  };
}

/**
 * v1.6.25: 流式 CSV 导入解析——分片读盘（256KB）+ UTF-8 多字节安全解码 + 记录边界分段 +
 * 段间让出事件循环。取代旧「readFileSync 整文件 + parseCsv 全量 + dataRows/valueRows 多份驻留」：
 * 实测 18MB 文件解析驻留 574MB（parseCsv cons rope 病理）→ 流式后 ~20MB（见 changelog 实测）。
 * 错误文案/检查顺序逐字不变：空文件→表头空→重名→非法列名→无数据行→超限 在解析期抛（先于
 * splitIdent）；行宽首违只记录（{i, actual}），由 doImportData 在 SQL 准备之后抛——保持旧代码
 * 「splitIdent 先于行宽」的错误优先级可观测行为逐字不变。
 */
export async function readCsvForImport(file, transform) {
  const fd = fs.openSync(file, "r");
  try {
    const seg = createCsvSegmenter();
    const decoder = new StringDecoder("utf8");
    const buf = Buffer.allocUnsafe(256 * 1024);
    let header = null;
    let rawHeader = null;
    let totalData = 0;
    let overCap = false;
    let widthViolation = null; // 首违标量（第 i 数据行、实际列数），全量计数后再解析抛出
    let sawAnyRow = false;
    const valueRows = [];
    const consume = (segText) => {
      const rows = parseCsv(segText);
      if (!rows.length) return;
      sawAnyRow = true;
      let start = 0;
      if (header === null) {
        rawHeader = rows[0].map((h) => String(h).trim());
        header = rawHeader.filter(Boolean);
        if (!header.length) throw new ToolError("E_PARAM", "CSV 首行（表头）为空。");
        // v1.6.13 重名列拒绝语义逐字不变
        const dup = header.find((h, i) => header.indexOf(h) !== i);
        if (dup) throw new ToolError("E_PARAM", `CSV 表头列名重复: '${dup}'（重名列导入会静默丢值）。请修改列名后重试。未写入任何行。`);
        for (const h of header) {
          if (!/^[_\p{L}][\p{L}\p{N}$_]*$/u.test(h)) throw new ToolError("E_PARAM", `CSV 表头含非法列名 '${h}'（仅允许字母/数字/_/$，且不以数字开头；字母含中文等 Unicode 文字）。`);
        }
        start = 1;
      }
      for (let r = start; r < rows.length; r++) {
        const row = rows[r];
        if (!(row.length > 1 || String(row[0]).trim() !== "")) continue; // 空记录过滤（同旧 dataRows.filter）
        totalData++;
        // 超限行只计数不驻留：LIMIT 文案要真实总数（「数据行 N 超过上限」），内存不吃全量
        if (totalData > MAX_IMPORT_ROWS) { overCap = true; continue; }
        if (widthViolation === null && row.length !== header.length) widthViolation = { i: totalData - 1, actual: row.length };
        valueRows.push(row.map(transform));
      }
    };
    let firstText = true;
    const feed = async (text) => {
      if (firstText && text !== "") { text = text.replace(/^\uFEFF/, ""); firstText = false; }
      for (const s of seg.push(text)) {
        consume(s);
        await yieldEventLoop(); // 段间让出——取消通知/定时器插队点（v1.6.25 收解析残余同步块）
      }
    };
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      await feed(decoder.write(buf.subarray(0, n)));
    }
    await feed(decoder.end());
    for (const s of seg.end()) consume(s);
    if (!sawAnyRow) throw new ToolError("E_PARAM", "CSV 为空。");
    if (!totalData) throw new ToolError("E_PARAM", "CSV 无数据行。");
    if (overCap) throw new ToolError("E_LIMIT", `数据行 ${totalData} 超过上限 ${MAX_IMPORT_ROWS}（10000）。`);
    return { header, rawHeader, valueRows, widthViolation };
  } finally {
    fs.closeSync(fd);
  }
}

async function doImportData(args, signal) {
  // 目录门禁最先（配置级错误先于源查找/DB 访问暴露，未初始化部署也能得到明确指引）
  const dir = process.env.DBMCP_IMPORT_DIR || process.env.DBMCP_EXPORT_DIR;
  if (!dir) {
    throw new ToolError("E_CONFIG", "import_data 未启用：在 MCP 服务的环境中设置 DBMCP_IMPORT_DIR=<允许读取导入文件的目录> 后重启（服务端白名单，防任意路径读取）。");
  }
  const src = getSource(args.source);
  const writable = cfg.allowWrites === true || src.allowWrites === true;
  if (!writable) throw new ToolError("E_CONFIG", "import_data 需要写权限：在 dbmcp.config.json 设置 allowWrites=true（全局或该源）后重启。");
  const file = safeExportPath(dir, args.filename);
  if (!file || !fs.existsSync(file)) throw new ToolError("E_NOT_FOUND", `导入文件不存在（或文件名含 Windows 保留设备名/非法字符、被清洗拒绝）: ${args.filename}`);
  const bytes = fs.statSync(file).size;
  if (bytes > MAX_IMPORT_BYTES) throw new ToolError("E_LIMIT", `文件 ${bytes} 字节超过上限 ${MAX_IMPORT_BYTES}（20MB）。`);

  // v1.6.25: 流式解析（readCsvForImport）——不再整文件驻留 readFileSync+parseCsv 全量副本；
  // 分段解析 + 值变换就地完成、段间让出事件循环。错误文案与检查顺序逐字不变：空文件/表头空/
  // 重名/非法列名/无数据行/超限 在解析期抛（先于 splitIdent）；行宽首违记录为标量，
  // 在 SQL 准备之后再抛（保持旧「splitIdent 先于行宽」的错误优先级可观测行为）。
  // v1.5.2: 值变换一次性前移完成（含 emptyAsNull 与可选的中和逆变换）——批失败回退逐行时
  // 不再重复转换，剥离计数也只计一次（旧版 toValues 在批/回退两路径各调一次）。
  const stripNeutralized = args.strip_neutralization === true;
  let strippedCount = 0;
  const transform = (v) => {
    let u = v;
    if (stripNeutralized && typeof v === "string") {
      const s = unneutralizeCell(v);
      if (s !== v) { strippedCount++; u = s; }
    }
    return u === "" && args.emptyAsNull === true ? null : u;
  };
  const { header, rawHeader, valueRows, widthViolation } = await readCsvForImport(file, transform);

  const split = splitIdent(args.table);
  const schema = args.schema || split.schema || (src.type === "mysql" || src.type === "sqlite" ? null : "public");
  const ref = tableRef(src.type, schema, split.table);

  // v1.4.1: 占位符按方言生成（pg 扩展协议只认 $n，不认 ? —— 旧版对 postgres 源必炸，全链路审查发现）
  // + 批量化导入（多 VALUES 语句，仍全参数化——注入面为零）；
  // 批失败自动回退该批逐行导入，精确定位坏行后整批中止（已写入行数如实回报）。
  // v1.6.20: 批大小不再硬编码 100——按方言占位符预算 × 列数动态定（实测万行非事务
  // mysql 672→~150ms、sqlite 607→~80ms；见 importBatchSize 注释）。
  // v1.6.21: postgres 非事务批路径改用 COPY FROM STDIN（文本格式，逐字节转义保真，
  // 见 importUsesCopy/importCopySql/copyTextPayload）；批失败回退逐行的契约逐字不变
  //（COPY 批语句同样原子失败、不写入，与批 INSERT 语义一致）。mysql/sqlite 不动。
  // v1.6.23: atomic（事务）路径同样按 useCopy 路由——postgres 事务内 COPY（withTransaction
  // 的 copyIn 助手），mysql/sqlite 事务内参数化 INSERT 不变。
  const BATCH = importBatchSize(src.type, header.length);
  const singleSql = importInsertSql(src.type, ref, header, 1);
  const batchSql = (n) => importInsertSql(src.type, ref, header, n);
  const useCopy = importUsesCopy(src.type);
  const copySql = useCopy ? importCopySql(src.type, ref, header) : null;

  // 行宽一次性预检（v1.6.25：首违已在流式解析中记录为标量，全量行数已知后再解析抛出）：
  // 批内中途才报宽度错误时，文案的"此前 N 行已写入"会把本批未写入的行数也算进去（实测虚报）；
  // 预检在任何写入前完成，文案恒为"未写入任何行"。
  if (widthViolation !== null) {
    // v1.6.13：表头有空列名被忽略时（如 "a,b," 尾空列）旧文案只说"期望 2 列实际 3"，
    // 用户看表头明明 3 列——把被忽略的空列名数写进文案，指向真正要改的地方
    const dropped = rawHeader.length - header.length;
    const hint = dropped ? `（表头含 ${dropped} 个空列名已被忽略）` : "";
    throw new ToolError("E_PARAM", `行宽不一致：期望 ${header.length} 列${hint}，实际 ${widthViolation.actual}（第 ${widthViolation.i + 1} 数据行）。请补全空列名或删除多余列后重试。未写入任何行。`);
  }

  await yieldEventLoop(); // v1.6.24: 阶段让出（值变换/宽度预检后，写入前）
  let inserted = 0;
  const t0 = Date.now();
  if (args.atomic === true) {
    // v1.5.3: 全文件单事务——任一批失败整体回滚，无"部分行保留"中间态（也不做逐行回退定位：
    // 消除部分写入正是 atomic 的目的；要定位坏行用默认模式）。mysql/pg 事务钉在单连接上执行。
    // v1.6.23: postgres 事务内也走 COPY FROM STDIN（与非事务路径同一封包，钉在事务连接上）——
    // COPY 随事务 ROLLBACK 整体消失，「原子导入失败，已全部回滚」契约逐字不变；mysql/sqlite 不动。
    try {
      await withTransaction(args.source, async (run, copyIn) => {
        for (let b = 0; b < valueRows.length; b += BATCH) {
          // v1.6.24: 取消传导——批界/传输中止即抛错 → withTransaction ROLLBACK，
          // 「原子导入失败，已全部回滚（未写入任何行）」文案契约逐字不变
          if (signal?.aborted) throw new Error("导入已被客户端取消");
          const batch = valueRows.slice(b, b + BATCH);
          if (useCopy) await copyIn(copySql, copyTextPayload(batch), { signal });
          else await run(batchSql(batch.length), batch.flat());
          inserted += batch.length;
        }
      });
    } catch (e) {
      throw new ToolError("E_DB", `原子导入失败，已全部回滚（未写入任何行）: ${e.message}`);
    }
  } else {
    for (let b = 0; b < valueRows.length; b += BATCH) {
      const batch = valueRows.slice(b, b + BATCH);
      // v1.6.24: 取消传导——批前/批后/逐行回退三处检查；取消中止如实回报已写入行数
      if (signal?.aborted) {
        throw new ToolError("E_DB", `导入已被客户端取消（中止于第 ${b + 1}-${b + batch.length} 行批写入前；此前 ${inserted} 行已写入）`);
      }
      try {
        if (useCopy) await runCopyIn(args.source, copySql, copyTextPayload(batch), { signal });
        else await runQuery(args.source, batchSql(batch.length), batch.flat());
        inserted += batch.length;
      } catch (e) {
        // 取消优先于错误分类：取消引发的传输错误不是「结果未知」，也绝不回退逐行重试
        if (signal?.aborted) {
          throw new ToolError("E_DB", `导入已被客户端取消（第 ${b + 1}-${b + batch.length} 行批中止；此前 ${inserted} 行已写入——如需清场请用 execute 按条件删除）`);
        }
        // 超时/连接类错误下批语句结果未知（可能已在服务端提交）——回退逐行会重复插入，必须中止
        if (isAmbiguousWriteError(e)) {
          throw new ToolError("E_DB", `批写入结果未知（超时/连接中断，安全中止、不自动回退）：第 ${b + 1}-${b + batch.length} 行可能已全部或部分写入，请用 count_rows 核对后人工决定是否补插（此前批次已确认写入 ${inserted} 行）。原始错误: ${e.message}`, "conditional");
        }
        // 约束/数据类错误：批语句原子未写入 → 回退逐行精确定位坏行
        for (let i = 0; i < batch.length; i++) {
          if (signal?.aborted) {
            throw new ToolError("E_DB", `导入已被客户端取消（逐行回退中止于第 ${b + i + 1} 行；此前 ${inserted} 行已写入）`);
          }
          try {
            await runQuery(args.source, singleSql, valueRows[b + i]);
            inserted++;
          } catch (e2) {
            const tail = isAmbiguousWriteError(e2)
              ? "该行写入结果未知（超时/连接中断）"
              : `此前 ${inserted} 行已写入——如需清场请用 execute 按条件删除`;
            throw new ToolError("E_DB", `第 ${b + i + 1} 行导入失败，整批中止（${tail}）: ${e2.message}`);
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
  const clean0 = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
  // v1.6.13 尾点/尾空格归一：Win32 对 "a.csv." 的寻址不一致（实测 Node existsSync 判不存在，
  // 某些 API 又归一到 "a.csv"）——读写双方都先归一到规范名，杜绝"报了文件名却找不到文件"
  if (!clean0) return null;
  // v1.6.13 Windows 保留设备名拒绝：CON/PRN/AUX/NUL/COM1-9/LPT1-9（含带扩展名形态 NUL.csv）。
  // 实测这类名字会落成"多数工具读不到/删不掉"的怪文件或直通设备命名空间（导出"成功"但数据
  // 不可用）——属数据可用性陷阱，按微软命名规范显式拒绝。注意 COM10/console 等非保留名不误伤。
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(clean0)) return null;
  // v1.6.13 超长截断保扩展名：旧版 slice(0,120) 直接切断 ".csv"（118 字基名导出成 ".c"、
  // 130 字基名导出成无扩展名文件，实测）——先取扩展名（上限 16 字符防病态长后缀），基名让位
  let clean = clean0;
  if (clean.length > 120) {
    const ext = path.extname(clean).slice(0, 16);
    clean = clean.slice(0, 120 - ext.length) + ext;
  }
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
      if (e?.code === "EEXIST") throw new ToolError("E_PARAM", `目标文件已存在: ${file}（overwrite: true 可覆盖）`);
      throw e;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 目标位已让出或从未写成 */ }
  }
}

/**
 * v1.6.29: writeFileAtomic 的流式形态——内容经 writeFn(fd) 逐块写入临时文件，全程不物化
 * 整份内容缓冲（export CSV 流式直写路径用）。原子占位/覆盖/并发语义与 writeFileAtomic 一致：
 * overwrite=true 走 rename；否则 link 原子占位，EEXIST 显式报「目标文件已存在」。
 * 错误语义：writeFn 抛错时临时文件必删、目标文件不出现（rename/link 未让位），错误原样上抛。
 * v1.6.32: writeFn 可返回 Promise（行集流式消费在 writeFn 内 await 驱动流）——返回 thenable 时
 * 函数返回 Promise、消费完成后才做原子占位；同步 writeFn 的完成与报错面逐字不变（同步抛错仍同步）。
 */
export function writeFileStreamAtomic(file, writeFn, overwrite) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`);
  const fd = fs.openSync(tmp, "w");
  const cleanup = () => {
    try { fs.closeSync(fd); } catch { /* 已关闭或从未可用 */ }
    try { fs.unlinkSync(tmp); } catch { /* 没写成的暂存不留残骸 */ }
  };
  const commit = () => {
    try {
      fs.closeSync(fd);
    } catch (e) {
      cleanup();
      throw e;
    }
    try {
      if (overwrite === true) {
        renameWithRetry(() => fs.renameSync(tmp, file));
        return;
      }
      try {
        renameWithRetry(() => fs.linkSync(tmp, file));   // 原子占位：并发者只有一个成功
      } catch (e) {
        if (e?.code === "EEXIST") throw new ToolError("E_PARAM", `目标文件已存在: ${file}（overwrite: true 可覆盖）`);
        throw e;
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 目标位已让出或从未写成 */ }
    }
  };
  let r;
  try {
    r = writeFn(fd);
  } catch (e) {
    cleanup();
    throw e;
  }
  if (r && typeof r.then === "function") {
    return Promise.resolve(r).then(commit, (e) => { cleanup(); throw e; });
  }
  commit();
}

/**
 * v1.6.30: 集束写缓冲器——把高频小块写收成低频大块写（Windows 单次 WriteFile 开销 µs 级，
 * 15.5MB/1856 片逐片 writeSync 实测拖慢 export ~9ms）。push(b) 同步消费碎片：拷入复用批缓冲
 * （碎片若是短命视图——如 streamCsvLines 的 scratch 视图——该契约必须成立），批满时经
 * write(批视图) 落出；flush() 吐出尾批。超大碎片（≥ batchBytes）零拷贝整块直写：先冲刷
 * 现批再原缓冲 write。批块大小恒 ≤ batchBytes（超大碎片直写时块即碎片本身）；write 在
 * push/flush 内同步调用。
 */
export function createBatchWriter(write, batchBytes = 262144) {
  const BATCH = Math.max(4096, Math.floor(batchBytes));
  const batch = Buffer.allocUnsafe(BATCH);
  let off = 0;
  const drain = () => {
    if (off > 0) { write(batch.subarray(0, off)); off = 0; }
  };
  return {
    push(b) {
      if (!b || b.length === 0) return;
      if (b.length >= BATCH) { drain(); write(b); return; }
      if (off + b.length > BATCH) drain();
      b.copy(batch, off);
      off += b.length;
    },
    flush: drain,
  };
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
  // v1.6.16: live 字节视图（Uint8Array/Buffer）→ hex——旧版掉进 String(v) 把 BLOB 变成
  // "0,1,2,255"（Uint8Array）/ utf8 mojibake（Buffer），导出不可辨认（对抗台实测抓获）
  else if (v && typeof v === "object" && ArrayBuffer.isView(v)) s = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex");
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
 * CSV 行发射器（字符串链真源/回落路径）：逐行格式化并 emit(line)，组装期逐行累计字节，超过
 * maxBytes 立即抛错（早停）。v1.5.1 语义：旧行为是整表拼完再查 20MB，超限导出会先把内存吃到
 * 峰值才拒；现在超限在组装中即中止，文案如实"未写盘"。emit 顺序 = 表头行 + 每数据行各一次。
 * 返回 totalBytes = 最终内容字节数（行字节 + 每行 2 字节 CRLF，含尾行），neutralized = 中和计数。
 * v1.6.31 分工调整：exportToCsv（回落/保真字符串链）继续走这里；measureCsv/exportToCsvBuffer/
 * streamCsvLines 改走零物化融合循环（见各函数注释）。本函数保留行串物化形态即为差分钉的真源：
 * 流式三链 vs 本函数的逐字节恒等由自测模糊钉锁定（非同义反复——两套实现）。
 */
function eachCsvLine(fields, rows, neutralize, maxBytes, emit) {
  let neutralized = 0;
  const cell = (v) => {
    if (neutralize && typeof v === "string" && /^[=+\-@\t\r]/.test(v)) neutralized++;
    return csvCell(v, neutralize);
  };
  const header = fields.map((f) => cell(f)).join(",");
  let bytes = Buffer.byteLength(header, "utf8") + 2;
  if (bytes > maxBytes) {
    throw new ToolError("E_LIMIT", `导出内容超过上限 ${maxBytes} 字节（组装期早停，未写盘）。请用 limit 参数缩小范围后重试。`);
  }
  emit(header);
  for (const r of rows) {
    const line = fields.map((f) => cell(r?.[f])).join(",");
    bytes += Buffer.byteLength(line, "utf8") + 2;
    if (bytes > maxBytes) {
      throw new ToolError("E_LIMIT", `导出内容超过上限 ${maxBytes} 字节（组装期早停，未写盘）。请用 limit 参数缩小范围后重试。`);
    }
    emit(line);
  }
  return { neutralized, totalBytes: bytes };
}

/**
 * 组装 CSV 字符串（v1.5.1 早停语义）。保留字符串形态作为保真真源：孤立代理项行（字节域会与
 * 字面 U+FFFD 混同）的回落路径要维持旧版字符串级 scrub 语义时走这里。
 */
export function exportToCsv(fields, rows, neutralize = true, maxBytes = MAX_EXPORT_BYTES) {
  const lines = [];
  const { neutralized } = eachCsvLine(fields, rows, neutralize, maxBytes, (line) => lines.push(line));
  return { content: lines.join("\r\n") + "\r\n", formula_cells_neutralized: neutralized };
}

/**
 * v1.6.28: CSV 组装直出 Buffer（两遍精确预铺）——pass 1 只计量行字节（顺带孤立代理哨兵），
 * pass 2 逐格格式化直写预铺缓冲、格串即时丢弃，全程不物化行串与整表内容串（旧行为 lines[] +
 * join 产物两份 15.8MB 驻留，30k 行实测堆峰被它顶起）。
 * v1.6.31 零物化融合：pass 1 走 measureCsv 融合计数循环，pass 2 走本函数内联直写循环（逐格
 * buf.write，省行串 join 与整行 UTF-8 二次扫描；30k 行微基准同场对照 fill 段 18-24ms → 17-18ms）。
 * 逐字节恒等（vs exportToCsv 行串真源）由 UTF-8 整码位碎片可拼接性 + 自测差分钉锁定：
 * 格间恒有 "," 分隔，代理对不跨碎片边界，逐格编码 ≡ 整行编码；pass 1/pass 2 字节账一致由
 * 末尾 off === scan.totalBytes 守卫兜底（不一致抛 E_INTERNAL，防静默截断）。
 * 前置：fields/rows 在两遍之间稳定（产品路径传普通数组，满足）。
 * saw_lone_surrogate：任一格含孤立代理项时为 true——这种内容物化成字节后与字面 U+FFFD 不可分，
 * 字节域口令匹配可能与字符串域分叉，调用方应回落字符串链（见 doExportData）。
 */
export function exportToCsvBuffer(fields, rows, neutralize = true, maxBytes = MAX_EXPORT_BYTES) {
  const scan = measureCsv(fields, rows, neutralize, maxBytes);
  const buf = Buffer.allocUnsafe(scan.totalBytes);
  const n = fields.length;
  let off = 0;
  for (let j = 0; j < n; j++) {
    if (j) off += buf.write(",", off, "utf8");
    off += buf.write(csvCell(fields[j], neutralize), off, "utf8");
  }
  off += buf.write("\r\n", off, "utf8");
  for (const r of rows) {
    for (let j = 0; j < n; j++) {
      if (j) off += buf.write(",", off, "utf8");
      off += buf.write(csvCell(r?.[fields[j]], neutralize), off, "utf8");
    }
    off += buf.write("\r\n", off, "utf8");
  }
  if (off !== scan.totalBytes) {
    throw new ToolError("E_INTERNAL", `CSV 直写缓冲字节账不一致（计量 ${scan.totalBytes}，直写 ${off}）`);
  }
  return { content: buf, formula_cells_neutralized: scan.neutralized, saw_lone_surrogate: scan.saw_lone_surrogate };
}

/**
 * v1.6.29: CSV pass 1 计量（单一真相源）。v1.6.31 零物化融合：逐格格式化只累加字节（Σ格字节 +
 * 常量分隔符 + 2/行，与行串 byteLength 恒等）、顺带孤立代理哨兵（ANY_SURROGATE 预筛 →
 * LONE_SURROGATE 精判；格间恒有 ","，代理对不跨格，逐格判定 ≡ 逐行判定），不物化行串
 * （30k 行微基准同场对照 pass1 15.1-16.6ms → 14.1-14.6ms）。
 * totalBytes = 内容字节数（行字节 + 每行 2 字节 CRLF，含尾行），neutralized = 公式中和计数。
 * 超 maxBytes 抛 E_LIMIT（组装期早停，文案如实"未写盘"；逐行边界与 eachCsvLine 同点位）。
 */
export function measureCsv(fields, rows, neutralize = true, maxBytes = MAX_EXPORT_BYTES) {
  let neutralized = 0;
  let sawLone = false;
  const n = fields.length;
  let bytes = 0;
  const overLimit = () => new ToolError("E_LIMIT", `导出内容超过上限 ${maxBytes} 字节（组装期早停，未写盘）。请用 limit 参数缩小范围后重试。`);
  let lb = 2;
  for (let j = 0; j < n; j++) {
    const v = fields[j];
    if (neutralize && typeof v === "string" && /^[=+\-@\t\r]/.test(v)) neutralized++;
    const s = csvCell(v, neutralize);
    if (j) lb += 1;
    lb += Buffer.byteLength(s, "utf8");
    if (!sawLone && ANY_SURROGATE.test(s) && LONE_SURROGATE.test(s)) sawLone = true;
  }
  bytes += lb;
  if (bytes > maxBytes) throw overLimit();
  for (const r of rows) {
    lb = 2;
    for (let j = 0; j < n; j++) {
      const v = r?.[fields[j]];
      if (neutralize && typeof v === "string" && /^[=+\-@\t\r]/.test(v)) neutralized++;
      const s = csvCell(v, neutralize);
      if (j) lb += 1;
      lb += Buffer.byteLength(s, "utf8");
      if (!sawLone && ANY_SURROGATE.test(s) && LONE_SURROGATE.test(s)) sawLone = true;
    }
    bytes += lb;
    if (bytes > maxBytes) throw overLimit();
  }
  return { totalBytes: bytes, neutralized, saw_lone_surrogate: sawLone };
}

/**
 * v1.6.32: 行集流式路径的内容哨兵中止信号（内部协议，不外泄为工具错误）——CSV 行接收器在
 * 流式直写途中发现孤立代理项格（该内容物化成字节后与字面 U+FFFD 不可分，字节域口令匹配会
 * 与字符串域分叉）时抛出本信号：writeFileStreamAtomic 收到即清理临时文件（目标文件不出现），
 * doExportData 回落旧物化链重新查询导出（与旧版"哨兵 → scrubToBuffer 字符串级清洗"语义逐字
 * 节恒等；两遍快照在并发写库时不保证一致——与旧版两遍链同级的已知面，见 doExportData 注释）。
 */
export class ContentSentinelAbort extends Error {
  constructor() {
    super("content sentinel: lone surrogate cell in stream");
    this.name = "ContentSentinelAbort";
  }
}
export function isContentSentinelAbort(e) {
  return e instanceof ContentSentinelAbort || e?.name === "ContentSentinelAbort";
}

/**
 * v1.6.32: CSV 行接收器——逐行喂入、格式化经 scrub 管线直写（write 同步消费），行集/内容
 * 缓冲全程不物化（query 侧行集流式：驱动行流 → row() → 集束写 → fd，单遍直通；对比
 * exportToCsvBuffer+scrubBuffer 省掉预铺 Buffer 与清洗输入缓冲，对比旧 query 形态省掉驱动
 * 行集驻留）。表头两种形态：fields 为数组（旧链形态）构造即发；fields 为 null 惰性——首个
 * row() 以 Object.keys 定列并发表头，零行时 finish() 发空列表头（与 exportToCsv 空 fields
 * 恒等）。账面与 eachCsvLine/measureCsv 逐格逐行对齐：neutralized 在**原始值**上按
 * /^[=+\-@\t\r]/ 计数（含表头格），lb = 2 + Σ(格字节 + 逗号)，bytes 按行边界累计、超
 * maxBytes 抛 E_LIMIT（文案与 eachCsvLine 逐字一致；行入 scratch 未冲刷即判限 → 小批量
 * 早停零写盘，同旧 streamCsvLines）。v1.6.31 保守界沿用：格串 UTF-8 字节数恒 ≤ 3×UTF-16
 * 码元数，能整格放入 scratch 即直写，否则先冲刷；超大格精确 byteLength、超 scratch 整格
 * 独立成块直喂。哨兵：格式化后格串命中 LONE_SURROGATE（ANY_SURROGATE 预筛）记
 * saw_lone_surrogate；opts.sentinel === "abort" 当场抛 ContentSentinelAbort（流式路径用），
 * 默认只记旗不中止（旧链形态，调用方哨兵门已先挡）。
 * write 契约同旧 streamCsvLines：必须同步消费碎片 b（b 是内部 scratch 的视图，仅在回调
 * 期间有效、回调内不得改写；需留存请自行 Buffer.from 拷贝）。
 */
export function createCsvRowSink(write, fields, list, neutralize = true, maxBytes = MAX_EXPORT_BYTES, opts = {}) {
  const pipeline = createScrubPipeline(list);
  let written = 0;
  const emit = (b) => { if (b.length) { write(b); written += b.length; } };
  // 行碎片写入可复用 scratch（write 同步消费、管线只暂存小拷贝 → 整块可回收复用）：
  // 消逐行小缓冲与攒批 concat 的分配抖动（v1.6.29 首版整块 concat 形态实测把流式链 RSS 反而顶高）。
  const SCRATCH = 65536;
  const scratch = Buffer.allocUnsafe(SCRATCH);
  let off = 0;
  const flushScratch = () => {
    if (off > 0) { pipeline.feed(scratch.subarray(0, off), emit); off = 0; }
  };
  const put = (s) => {
    if (off + s.length * 3 <= SCRATCH) { off += scratch.write(s, off, "utf8"); return; }
    flushScratch();
    if (s.length * 3 <= SCRATCH) { off += scratch.write(s, off, "utf8"); return; }
    // 超大格（export 不截断长文本单元格）：精确核算，超 scratch 整格独立成块直喂
    const need = Buffer.byteLength(s, "utf8");
    if (need > SCRATCH) { pipeline.feed(Buffer.from(s, "utf8"), emit); return; }
    off += scratch.write(s, off, "utf8");
  };
  let cols = null;             // null = 表头未定（惰性：首个 row() 以 Object.keys 定列）
  let neutralized = 0;
  let sawLone = false;
  let bytes = 0;
  const abortOnSentinel = opts.sentinel === "abort";
  const overLimit = () => new ToolError("E_LIMIT", `导出内容超过上限 ${maxBytes} 字节（组装期早停，未写盘）。请用 limit 参数缩小范围后重试。`);
  const cell = (v) => {
    if (neutralize && typeof v === "string" && /^[=+\-@\t\r]/.test(v)) neutralized++;
    const s = csvCell(v, neutralize);
    if (!sawLone && ANY_SURROGATE.test(s) && LONE_SURROGATE.test(s)) {
      sawLone = true;
      if (abortOnSentinel) throw new ContentSentinelAbort();
    }
    return s;
  };
  const line = (get) => {
    let lb = 2;
    for (let j = 0; j < cols.length; j++) {
      if (j) { put(","); lb += 1; }
      const s = cell(get(j));
      put(s);
      lb += Buffer.byteLength(s, "utf8");
    }
    put("\r\n");
    bytes += lb;
    if (bytes > maxBytes) throw overLimit();
  };
  const emitHeader = () => { line((j) => cols[j]); };
  const header = (names) => {
    if (cols !== null) throw new ToolError("E_INTERNAL", "CSV 行接收器表头重复设置");
    cols = names.slice();
    emitHeader();
  };
  const row = (r) => {
    if (cols === null) { cols = Object.keys(r ?? {}); emitHeader(); }
    line((j) => r?.[cols[j]]);
  };
  const finish = () => {
    if (cols === null) { cols = []; emitHeader(); }
    flushScratch();
    pipeline.flush(emit);
    return { written, neutralized, saw_lone_surrogate: sawLone };
  };
  if (Array.isArray(fields)) header(fields);
  return { header, row, finish };
}

/**
 * v1.6.29: CSV 整链流式直写（旧链形态入口，v1.6.32 起为 createCsvRowSink 的薄封装——实现
 * 收进行接收器，账面/scratch/管线契约不变，逐字节恒等由自测差分钉锁定）。返回实际写出的
 * 清洗后字节数（= 旧链 scrubbed.length 口径，doExportData 的 bytes 响应字段语义不变）。
 * 前置：fields/rows 在 measureCsv（pass 1）与本函数（pass 2）之间稳定；内容与 list 无孤立
 * 代理项（doExportData 哨兵门守着）——与 scrubBuffer 同口径。早停：按行边界累计字节、超
 * maxBytes 抛 E_LIMIT（文案与 eachCsvLine 逐字一致）；产品路径 pass 1 已先行封顶，pass 2
 * 早停仅在两遍间行集被改的互斥场景触发，届时已刷出的批只落临时文件、目标文件不出现
 *（原子占位未让位）。
 */
export function streamCsvLines(write, fields, rows, list, neutralize = true, maxBytes = MAX_EXPORT_BYTES) {
  const sink = createCsvRowSink(write, fields, list, neutralize, maxBytes);
  for (const r of rows) sink.row(r);
  return sink.finish().written;
}

/**
 * v1.6.32: export 目标文件名解析（流式/物化两路共用，杜绝双份清洗逻辑漂移）。行为与历史
 * 版本逐字一致：v1.6.13 文件名归一——尾点/尾空格先剥（"report2.csv." 不再变成
 * "report2.csv..csv"），扩展名判定大小写不敏感（"REPORT.CSV" 不再追加成 "REPORT.CSV.csv"）；
 * 清洗后为空的病态名字显式拒绝（旧行为会拼出 "....csv" 之类的垃圾文件名）；safeExportPath
 * 拒绝 Windows 保留设备名/非法字符/越界。
 */
export function resolveExportTarget(dir, args, src, ext) {
  const nm = args.filename != null && String(args.filename).trim()
    ? String(args.filename).trim().replace(/[. ]+$/, "")
    : "";
  if (args.filename != null && String(args.filename).trim() && !nm) {
    throw new ToolError("E_PARAM", `Invalid export filename '${args.filename}'（清洗后为空）。`);
  }
  const filename = nm
    ? (nm.toLowerCase().endsWith(ext) ? nm : nm + ext)
    : `export-${src.type}-${new Date().toISOString().replace(/[:.]/g, "-")}${ext}`;
  const file = safeExportPath(dir, filename);
  if (!file) throw new ToolError("E_PARAM", `Invalid export filename '${args.filename}'（含 Windows 保留设备名 CON/PRN/AUX/NUL/COM1-9/LPT1-9、非法字符或越界，被清洗拒绝；也可能 DBMCP_EXPORT_DIR 未正确设置）。`);
  return file;
}

/**
 * v1.6.32: CSV 行集流式导出（query 侧 → export 侧单遍直通）。驱动行流逐行喂 CSV 行接收器
 *（格式化 → 口令清洗管线 → 集束写 → fd），rows[]/内容缓冲全程不物化（mysql2/pg 驱动结果行
 * 集驻留是 e2e maxRSS 剩余大头，30k 行实测 ~50MB@142MB 峰——本函数消掉的就是它）。响应字段
 * 与物化链逐字段一致（source/file/format/row_count/truncated/bytes/duration_ms/
 * formula_cells_neutralized/note），语义对齐点：
 *  - 截断：finalSql 已带 LIMIT limit+1（enforceLimit），第 limit+1 行到达即 truncated=true
 *    并停消费（mysql/sqlite 收尾丢弃、pg 游标真停），row_count 只数可见行；不包裹的语句
 *   （SHOW/括号复合）同样在 limit+1 行早停，响应面与物化链的 slice 截断恒等；
 *  - E_LIMIT：行边界早停（文案与 eachCsvLine 逐字一致），临时文件随 writeFileStreamAtomic
 *    清理、目标文件不出现（"未写盘"文案如实）；
 *  - 哨兵：流式途中命中孤立代理项即 ContentSentinelAbort → 临时文件清理后由 doExportData
 *    回落物化链重查导出；
 *  - 连接释放时序由 runQueryStream 保证（mysql 完整消费 release / 出错 destroy；pg
 *    CLOSE+COMMIT / 出错 ROLLBACK+release；sqlite 迭代器收尾）。
 * 错误序（与物化链的差异，仅共现场合可观察）：文件名解析与存在预检先于查询（快速失败预检，
 * 省去无谓等待）——E_PARAM → E_DB → E_LIMIT；物化链为 E_DB → E_LIMIT → E_PARAM。
 */
async function exportCsvStreaming(args, src, dir, finalSql, limit, neutralizeFormulas, t0) {
  const file = resolveExportTarget(dir, args, src, ".csv");
  // 快速失败预检（省去无谓等待）；跨进程互斥由 writeFileStreamAtomic 的原子占位最终强制
  if (fs.existsSync(file) && args.overwrite !== true) {
    throw new ToolError("E_PARAM", `目标文件已存在: ${file}（overwrite: true 可覆盖）`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let rowCount = 0;
  let truncated = false;
  let formulaCells = 0;
  let bytes = 0;
  await writeFileStreamAtomic(file, async (fd) => {
    // v1.6.30: 集束写——碎片经 createBatchWriter 攒批落盘；push 同步消费满足行接收器的
    // 碎片生命周期契约。writeFn 为 async（writeFileStreamAtomic v1.6.32 混合形态）：驱动流
    // 消费完成后才做原子占位。
    const bw = createBatchWriter((b) => { fs.writeSync(fd, b); });
    const sink = createCsvRowSink(bw.push, null, SECRET_LIST, neutralizeFormulas, MAX_EXPORT_BYTES, { sentinel: "abort" });
    await runQueryStream(args.source, finalSql, {
      onFields: (names) => sink.header(names),
      onRow: (r) => {
        console.error("TRACE server:2539 onRow rowCount=%d limit=%d", rowCount, limit);
        if (rowCount >= limit) { truncated = true; console.error("TRACE server:2539 TRUNCATE rowCount=%d >= limit=%d", rowCount, limit); return false; }
        sink.row(r);
        rowCount++;
        return true;
      },
    });
    const fin = sink.finish();
    bw.flush();
    formulaCells = fin.neutralized;
    bytes = fin.written;
    // 保险丝（实际不可达：行接收器已按 MAX_EXPORT_BYTES 封顶，SECRET_LIST 口令 ≥4 字节清洗
    // 只缩不涨）：保留旧链"超限拒写"语义——在临时文件让位于目标名之前中止，目标文件不会出现。
    if (bytes > MAX_EXPORT_BYTES) {
      throw new ToolError("E_LIMIT", `导出内容 ${bytes} 字节超过上限 ${MAX_EXPORT_BYTES}（20MB）。请用 limit 参数缩小范围后重试。`);
    }
  }, args.overwrite === true);
  return {
    source: args.source, file, format: "csv", row_count: rowCount, truncated, bytes,  // TRACE rowCount=%d limit=%d at return  // TRACE rowCount=%d limit=%d at return
    duration_ms: Date.now() - t0,
    formula_cells_neutralized: formulaCells,
    note: "文件已写入 MCP 服务所在机器的导出白名单目录。",
  };
}

async function doExportData(args) {
  const t0 = Date.now();
  // 目录门禁最先（配置级错误先于源查找/DB 访问暴露，未初始化部署也能得到明确指引）
  const dir = process.env.DBMCP_EXPORT_DIR;
  if (!dir) {
    throw new ToolError("E_CONFIG", "export_data 未启用：在 MCP 服务的环境中设置 DBMCP_EXPORT_DIR=<允许导出的目录> 后重启（服务端白名单，防任意路径写盘）。");
  }
  const src = getSource(args.source);
  const format = enumArg(args.format, "format", ["csv", "json"], "csv");
  const limit = intArg(args.limit, "limit", 1, 100000, 5000);
  // v1.5.0: 公式注入中和默认开启；raw_formulas=true 显式关闭（仅 CSV 面临此风险）
  const neutralizeFormulas = !(args.raw_formulas === true);
  guardReadOnly(args.sql, maskDialect(src.type));
  const finalSql = enforceLimit(args.sql, limit, maskDialect(src.type));
  // v1.6.32 query 侧行集流式：CSV 快乐路径把驱动行流直接接进 CSV 行接收器 → 集束写 → 临时
  // 文件，rows[]/内容缓冲全程不物化（mysql2/pg 驱动结果行集驻留是 e2e maxRSS 剩余大头，30k
  // 行实测 ~50MB@142MB 峰）。回退物化链的条件（任一成立，物化链语义与历史版本逐字节恒等）：
  //  - JSON 格式（stringify 需整行集，本轮不动）；
  //  - 密钥含孤立代理项（keySentinel：字节域清洗会与字符串域分叉，须走字符串链）；
  //  - pg 非 SELECT/WITH 家族（游标 DECLARE 只吃查询语句，EXPLAIN/SHOW 等走物化链；
  //    括号复合 (SELECT…)UNION(…) 与 WITH 已真库实测游标可吃——pg_paren_check_v1632）；
  //  - 流式途中内容哨兵命中（ContentSentinelAbort：临时文件已清理、目标未出现 → 物化链重查
  //    导出）。已知面（待确认）：哨兵回落是"流式读到哨兵行 → 重查"两遍，两遍之间数据被并发
  //    修改时第二遍快照可能与第一遍不同——与旧版 measureCsv/exportToCsv 两遍链同级，不新增
  //    劣化。
  const keySentinel = SECRET_LIST.some((k) => LONE_SURROGATE.test(k));
  const pgStreamOk = src.type !== "postgres" || pgStreamable(finalSql);
  if (format === "csv" && !keySentinel && pgStreamOk) {
    try {
      return await exportCsvStreaming(args, src, dir, finalSql, limit, neutralizeFormulas, t0);
    } catch (e) {
      if (!isContentSentinelAbort(e)) throw e;
      // 内容哨兵命中：回落物化链（重查 → measureCsv 哨兵 → 字符串链 scrubToBuffer）
    }
  }
  const { rows, fields } = await runQuery(args.source, finalSql);
  const truncated = rows.length > limit;
  const visible = truncated ? rows.slice(0, limit) : rows;
  const cols = fields.length ? fields : (visible[0] ? Object.keys(visible[0]) : []);

  let scrubbed;            // 落盘缓冲（v1.6.29: CSV 快乐路径改流式直写不再物化；此处仅 JSON/哨兵回落用）
  let formulaCells = 0;
  let csvStreaming = false;
  if (format === "json") {
    // v1.3.1 修正：必须用 stringify()——原生 JSON.stringify 无法序列化 BigInt（sqlite 读出的
    // INTEGER 经 setReadBigInts 是 BigInt，实测崩溃），且需要 Buffer 十六进制与 scrub 清洗。
    // v1.6.3: export 模式不截断单元格、Buffer 全量 hex——导出文件要数据保真（见 stringify 注释）。
    // v1.6.28: JSON 路径无逐行结构，仍走 字符串 → scrubToBuffer（内部守孤立代理门）。
    const content = stringify({ row_count: visible.length, truncated, columns: cols, rows: visible }, { export: true });
    scrubbed = scrubToBuffer(content, SECRET_LIST);
  } else {
    // v1.6.29: pass 1 只计量（顺带孤立代理哨兵）——早停文案"未写盘"仍如实（此时零写盘）。
    // 哨兵触发则回落字符串链（语义与旧版逐字节恒等，见 scrubToBuffer 注释）；
    // 未触发走流式直写（逐行 → scrub 管线 → fd，消 scrubbed 全量缓冲）。
    const scan = measureCsv(cols, visible, neutralizeFormulas);
    formulaCells = scan.neutralized;
    if (scan.saw_lone_surrogate || SECRET_LIST.some((k) => LONE_SURROGATE.test(k))) {
      const content = exportToCsv(cols, visible, neutralizeFormulas).content;
      scrubbed = scrubToBuffer(content, SECRET_LIST);
    } else {
      csvStreaming = true;
    }
  }

  const ext = "." + format;
  // v1.6.32: 文件名解析收敛 resolveExportTarget（与流式路径共用同一清洗逻辑，行为与历史逐字一致）
  const file = resolveExportTarget(dir, args, src, ext);
  // 快速失败预检（省去无谓等待）；跨进程互斥由 writeFileAtomic/writeFileStreamAtomic 的原子占位最终强制
  if (fs.existsSync(file) && args.overwrite !== true) {
    throw new ToolError("E_PARAM", `目标文件已存在: ${file}（overwrite: true 可覆盖）`);
  }
  let bytes;
  if (csvStreaming) {
    // v1.6.29: 流式直写——逐行格式化经 scrub 管线直写临时文件 fd，清洗后字节即写即弃，
    // 全程不物化内容缓冲；原子占位/覆盖/并发语义与 writeFileAtomic 一致。
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let written = 0;
    writeFileStreamAtomic(file, (fd) => {
      // v1.6.30: 集束写——碎片经 createBatchWriter 攒批落盘（1856 次 WriteFile → ~60 次），
      // push 同步消费满足 streamCsvLines 的碎片生命周期契约。
      const bw = createBatchWriter((b) => { fs.writeSync(fd, b); });
      written = streamCsvLines(bw.push, cols, visible, SECRET_LIST, neutralizeFormulas);
      bw.flush();
      // 保险丝（实际不可达：pass 1 已按 MAX_EXPORT_BYTES 封顶，SECRET_LIST 口令 ≥4 字节清洗只缩
      // 不涨）：保留旧链"超限拒写"语义——在临时文件让位于目标名之前中止，目标文件不会出现。
      if (written > MAX_EXPORT_BYTES) {
        throw new ToolError("E_LIMIT", `导出内容 ${written} 字节超过上限 ${MAX_EXPORT_BYTES}（20MB）。请用 limit 参数缩小范围后重试。`);
      }
    }, args.overwrite === true);
    bytes = written;
  } else {
    bytes = scrubbed.length;
    if (bytes > MAX_EXPORT_BYTES) {
      throw new ToolError("E_LIMIT", `导出内容 ${bytes} 字节超过上限 ${MAX_EXPORT_BYTES}（20MB）。请用 limit 参数缩小范围后重试。`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, scrubbed, args.overwrite === true);
  }
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
  if (!/^[_\p{L}][\p{L}\p{N}$_]*$/u.test(column)) {
    throw new ToolError("E_PARAM", `Invalid column name '${column}'. Pass a plain column name (letters/digits/_/$, not starting with a digit).`);
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
    throw new ToolError("E_CONFIG", 
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
    throw new ToolError("E_SAFETY", 
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
    throw new ToolError("E_CONFIG", '建表未启用：在 dbmcp.config.json 设置 "allowCreateTable": true（全局或该源）后重启 MCP。安全红线（无 WHERE 的 UPDATE/DELETE、TRUNCATE）不受此开关影响，始终生效。');
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
  if (!q) throw new ToolError("E_PARAM", "Provide a database name or keyword, e.g. 'za_data_notice', 'test', 'pre'.");
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

/**
 * v1.6.5 错误语义标准化：工具错误携带稳定机器可读错误码，格式 `Error: [E_CODE:retry] 原文`。
 * 原文逐字保留在标签之后（存量客户端按子串匹配错误文案的行为不变）；错误码让调用方判断
 * 「同一参数重试是否有意义」，避免对安全拒绝/参数错误做无效重试（烧 token 且无进展）。
 * retry 取值：retryable=同参重试可能成功（连接类瞬时错误）| conditional=改变参数/范围后可重试 |
 * no-retry=同参重试必然失败（守卫拒绝/参数错误/配置缺失）。
 * 分类优先级：显式标签（v1.6.6 ToolError）> 安全红线 > 配置态 > 对象不存在 > 上限 > 导入语义 > 参数语义 > 驱动错误码 > 兜底；
 * 未知错误兜底 E_INTERNAL:no-retry（fail-closed，不鼓励盲目重试）。
 * v1.6.6: 69 个 throw 点（guard.mjs 27 + server.mjs 40 + pool.mjs 2）已全部显式携带错误码，
 * 消息模式匹配降级为未标注错误/第三方驱动错误的兜底（不再承担主分类职责）。
 */
const DB_RETRYABLE_CODES = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|PROTOCOL_CONNECTION_LOST|PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR|57P03)$/;
export function classifyError(e) {
  if (e && typeof e.errCode === "string") return { code: e.errCode, retry: e.errRetry || "no-retry" };
  const msg = (e && e.message) || String(e);
  if (/安全红线|read-only guard/i.test(msg)) return { code: "E_SAFETY", retry: "no-retry" };
  if (/未启用|尚未初始化|init_required|需写权限|unsupported type/i.test(msg)) return { code: "E_CONFIG", retry: "no-retry" };
  if (/Unknown source|not found|不存在|doesn't exist|does not exist/i.test(msg)) return { code: "E_NOT_FOUND", retry: "no-retry" };
  if (/超过上限|缩小范围/i.test(msg)) return { code: "E_LIMIT", retry: "conditional" };
  if (/批写入结果未知/i.test(msg)) return { code: "E_DB", retry: "conditional" };
  if (/原子导入失败/i.test(msg)) return { code: "E_DB", retry: "no-retry" };
  if (/Unknown tool|Invalid '|Invalid |Empty SQL|Only a single SQL statement|expected an integer|must be >=|Provide a column|表头含非法列名|行宽不一致|目标文件已存在|query_plan only accepts|CSV 为空|CSV 首行|CSV 无数据行/.test(msg)) {
    return { code: "E_PARAM", retry: "no-retry" };
  }
  const code = e && e.code;
  // v1.6.20 真实库超时抓获：查询/执行超时此前按报文形态散落三口径——pg query_timeout 无 code 掉
  // E_INTERNAL 兜底、pg statement_timeout 57014 与 mysql2 PROTOCOL_SEQUENCE_TIMEOUT 走驱动码层
  // E_DB:no-retry。超时是「同参重试必然再超、改变范围可成」的条件态，统一 E_DB:conditional；
  // 写路径结果未知的告诫由 import 批回退显式标签（批写入结果未知）与错误类矩阵超时行承担。
  // 连接建立超时 ETIMEDOUT 不在此列（瞬时连接错误，仍走驱动码层 E_DB:retryable）。
  if (code === "57014" || code === "PROTOCOL_SEQUENCE_TIMEOUT" ||
      /Query read timeout|Query inactivity timeout|canceling statement due to statement timeout|query (?:was )?canceled/i.test(msg)) {
    return { code: "E_DB", retry: "conditional" };
  }
  if (code && typeof code === "string") return { code: "E_DB", retry: DB_RETRYABLE_CODES.test(code) ? "retryable" : "no-retry" };
  return { code: "E_INTERNAL", retry: "no-retry" };
}
function errorContent(message, meta) {
  const m = meta || { code: "E_INTERNAL", retry: "no-retry" };
  return { content: [{ type: "text", text: "Error: [" + m.code + ":" + m.retry + "] " + scrub(message) }], isError: true };
}

// v1.6.13: 复制粘贴真实形态——聊天/网页/Excel 复制 SQL、表名、条件时常夹带前导不可见字符
//（零宽空格 ZWSP/ZWNJ/ZWJ、软连字符、方向控制符等 Unicode Cf 类）。这些字符在词法单元之前
// 不可能承载语义，却让只读守卫首词误拒（"statement must start with SELECT"）、驱动报
// "no such column: ​id"（实测）。剥前导即可让守卫与驱动看到干净语句；**只剥前导**、不动
// 语句内部，字符串字面量里的不可见字符（真实数据）零影响。红线检查在剥除后的语句上照常执行。
const LEADING_INVIS_RE = /^[\s\u00A0\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]+/;
export function stripLeadingInvis(s) {
  return typeof s === "string" ? s.replace(LEADING_INVIS_RE, "") : s;
}
// 词法/标识符/条件片段类参数键——filename 是不透明文件名（可能真以不可见字符开头），不在其列
const INVIS_ARG_KEYS = ["sql", "where", "order_by", "table", "column", "schema", "source"];

async function callTool(name, args, logMeta) {
  // v1.6.9 观测面：每次 tools/call（含失败/未知工具）出口恰好打 1 条审计记录；
  // DBMCP_ERR_LOG 未设置时 logToolCall 零行为，result/error 载荷契约零改动
  const t0 = Date.now();
  // v1.6.13: 参数级前导不可见字符归一（见 stripLeadingInvis 注释）——在任何校验/执行前完成
  if (args && typeof args === "object") {
    for (const k of INVIS_ARG_KEYS) {
      if (typeof args[k] === "string") args[k] = stripLeadingInvis(args[k]);
    }
  }
  let out, errMeta = null, errMsg = null;
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
      case "import_data":     data = await doImportData(args, logMeta?.signal); break;
      case "count_rows":      data = await countRows(args); break;
      case "execute":         data = await doExecute(args); break;
      case "create_table":    data = await doCreateTable(args); break;
      case "find_database":   data = await findDatabase(args); break;
      default:
        errMeta = { code: "E_PARAM", retry: "no-retry" };
        errMsg = `Unknown tool '${name}'. Available: ${TOOLS.map((t) => t.name).join(", ")}`;
        out = errorContent(errMsg, errMeta);
    }
    if (!out) out = resultContent(data);
  } catch (e) {
    errMeta = classifyError(e);
    errMsg = e?.code ? `${e.message} (${e.code})` : e?.message || String(e);
    out = errorContent(errMsg, errMeta);
  }
  logToolCall({
    id: logMeta?.id ?? null, tool: name, args,
    duration_ms: Date.now() - t0,
    is_error: !!out.isError, code: errMeta?.code ?? null, retry: errMeta?.retry ?? null,
    err_msg: errMsg,
  });
  return out;
}

/** JSON-RPC 内部错误响应（v1.0.1：不回栈信息，避免细节外泄） */
export function rpcInternalError(id) {
  return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
}

/**
 * v1.6.3: 从超长/坏 JSON 行里尽力恢复请求 id（有界扫描，不解析整行）。
 * 动机：旧版超长行拒收回 id:null、坏 JSON 行直接静默丢弃——请求方拿不到可关联的响应，
 * 该请求永久挂起（实测复现：客户端等 id=900 的响应直到超时）。JSON-RPC 对 parse/invalid
 * 错误要求响应回带 id（无法确定时为 null）；客户端通常把 id 放在报文头部，前 8KB 扫描
 * 大概率命中。局限（如实）：id 若埋在超长 params 之后、或 params 里恰有更早的 "id" 字面量
 * 会漏/误配——此为 >2MB 报文的尽力而为降级路径，正常报文不受影响。
 */
export function peekRpcId(line, scanLimit = 8192) {
  const m = /"id"\s*:\s*(-?\d+|"([^"\\]|\\.)*")/.exec(String(line).slice(0, scanLimit));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// v1.0.3: 支持的 MCP 协议版本（initialize 按规范回「服务端支持的版本」——旧版直接回显客户端
// 版本，传 "9999-01-01" 也会被原样确认；现仅当客户端版本在支持列表内才沿用之，否则回最新支持版）
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-06-18"]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";

/* ------------------------- 请求取消（v1.6.12） ------------------------- */
/**
 * MCP 2025-06-18「Cancellation」：notifications/cancelled（params: requestId, reason?）。
 * 落地语义（逐条对照规范 SHOULD/MAY）：
 *  - 运行中请求：abort 在途 AbortController → 停止等待、**不发响应**（规范明示
 *    “Not send a response for the cancelled request”；不引入 -32800——那是 LSP 习惯，
 *    MCP 此处要求不回响应，客户端按规范忽略迟到响应）；
 *  - 排队中请求（已发出未派发）：派发时消费取消标记 → 不执行、不响应——对写工具是
 *    安全方向（被取消的 UPDATE 不应落库）；
 *  - 未知 id / 已完成 / 无效通知：忽略（“Invalid cancellation notifications SHOULD be ignored”）；
 *  - initialize 不可被取消（规范 MUST NOT）：它从不入表，取消天然被忽略；
 *  - id 严格同类型匹配（JSON-RPC id number/string 不得互配）。
 * 在途表 pending 在报文**到达**即登记（区分「未知 id」与「排队中」），派发/应答后删除，
 * 天然有界（≤ 队列深度）。
 * 服务端工作侧边界（如实，v1.6.24 收口）：取消释放「等待与响应」，并尽力中断
 * import_data——COPY 传输期可中断（未发完补 copyFail、连接不滞留）：atomic 随 ROLLBACK
 * 整体归零，非 atomic 停在批界（已写入批保留、如实回报行数）。其余在执行的驱动查询不
 * 回滚、不中断——由各驱动既有超时上界约束（mysql2 单查询 timeout / pg statement_timeout /
 * sqlite 同步执行不可中断）。COPY 之外的写操作若已开跑仍可能落库，取消不是事务回滚；
 * 串行派发队列语义不变（并发调用仍按到达顺序排队，取消通知插队除外）。
 */
const pendingRpc = new Map();
const CANCELLED = Symbol("dbmcp.cancelled");

/** 报文到达即登记（仅 tools/call）：返回该请求的 AbortController */
export function trackRpc(id) {
  const ac = new AbortController();
  pendingRpc.set(id, { ac, cancelled: false });
  return ac;
}
/** 应答完成/异常收尾：注销在途条目（其后同 id 的取消按「已完成」忽略） */
export function finishRpc(id) { pendingRpc.delete(id); }
/** 派发口消费取消标记：false = 已取消，调用方不执行、不响应；标记一次性，id 复用安全 */
export function beginDispatch(id) {
  const e = pendingRpc.get(id);
  if (!e) return true;
  if (e.cancelled) { pendingRpc.delete(id); return false; }
  return true;
}
/** 规范形状判别：无 id 的 notifications/cancelled 且 params 为对象 */
export function isCancelNotification(m) {
  return !!m && typeof m === "object" && !Array.isArray(m)
    && (m.id === undefined || m.id === null)
    && m.method === "notifications/cancelled"
    && m.params !== undefined && m.params !== null && typeof m.params === "object" && !Array.isArray(m.params);
}
/** 处理取消：cancelled = 命中在途/排队请求；ignored = 未知 id/无效通知（规范 SHOULD ignore） */
export function cancelRpc(params) {
  const rid = params?.requestId;
  if (typeof rid !== "number" && typeof rid !== "string") return "ignored";
  const e = pendingRpc.get(rid);
  if (!e) return "ignored";
  e.cancelled = true;
  try { e.ac.abort(typeof params.reason === "string" ? params.reason : undefined); } catch { /* ignore */ }
  return "cancelled";
}

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
      // v1.6.12: 取消语义——派发前消费取消标记（排队中被取消 ⇒ 不执行不响应，写安全），
      // 运行中与 AbortController 竞速，被取消则不发响应。工具契约零改动：callTool 仍
      // 产出正常结果/错误（观测审计照常 1 条），只是结果被丢弃。
      if (!beginDispatch(id)) return null;
      const ac = pendingRpc.get(id)?.ac ?? new AbortController();
      const abortP = new Promise((resolve) => {
        if (ac.signal.aborted) resolve(CANCELLED);
        else ac.signal.addEventListener("abort", () => resolve(CANCELLED), { once: true });
      });
      try {
        const r = await Promise.race([callTool(params?.name, params?.arguments || {}, { id, signal: ac.signal }), abortP]);
        if (r === CANCELLED) return null;
        return { jsonrpc: "2.0", id, result: r };
      } finally {
        finishRpc(id);
      }
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
    const trimmed = line.trim();
    if (!trimmed) return;
    // v1.6.12: 取消通知必须插队（out-of-band）——串行队列会把它排到长查询之后，永远
    // 来不及中断。按规范不产生任何响应；仅对疑似取消通知的行做一次短路解析（普通流量
    // 零额外开销）。解析失败/形状不符则交回常规队列（坏 JSON 照旧回 -32700）。
    if (trimmed.length <= MAX_LINE_CHARS && trimmed[0] === "{" && trimmed.includes('"notifications/cancelled"')) {
      let note = null;
      try { note = JSON.parse(trimmed); } catch { /* 交回常规队列 */ }
      if (note && isCancelNotification(note)) {
        const verdict = cancelRpc(note.params);
        if (verdict === "cancelled") {
          // 规范 SHOULD log cancellation reasons：理由来自请求方，出 stderr 前过权威 scrub
          console.error("[calvin-db-mcp] request cancelled: id=" + String(note.params.requestId) + " reason=" + scrub(String(note.params.reason ?? "")));
        }
        return;
      }
    }
    // 到达即解析一次（≤2MB）：tools/call 登记在途表——取消语义需区分「未知 id 忽略」
    // 与「排队中可取消」；解析/拒收语义与旧版逐条一致（超长 -32600、坏 JSON -32700、
    // 噪声静默、标量 -32600），只是解析从派发时提前到到达时。
    const tooLarge = trimmed.length > MAX_LINE_CHARS;
    let msg, parseFailed = false;
    if (!tooLarge) {
      try { msg = JSON.parse(trimmed); } catch { parseFailed = true; }
    }
    if (msg && typeof msg === "object" && !Array.isArray(msg)
        && msg.id !== undefined && msg.id !== null && msg.method === "tools/call") {
      trackRpc(msg.id);
    }
    queue = queue
      .then(async () => {
        if (tooLarge) {
          // v1.6.3: 拒收也要回带可关联的请求 id（peekRpcId）——id:null 的错误响应让客户端
          // 对该请求永久等待；尽力恢复 id，恢复不到才按规范回 null。
          await writeLine(JSON.stringify({ jsonrpc: "2.0", id: peekRpcId(trimmed), error: { code: -32600, message: "Invalid Request: message too large" } }));
          return;
        }
        if (parseFailed) {
          // v1.6.3: 坏 JSON 行必须回 -32700 Parse error（JSON-RPC 规范），静默丢弃会让客户端
          // 对该请求永久挂起。仅对疑似 JSON 的行（{ / [ 开头）响应——普通噪声行（日志混入等）
          // 维持旧的静默忽略，避免给 stdout 制造无主报文。
          if (trimmed[0] === "{" || trimmed[0] === "[") {
            await writeLine(JSON.stringify({ jsonrpc: "2.0", id: peekRpcId(trimmed), error: { code: -32700, message: "Parse error" } }));
          }
          return;
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
