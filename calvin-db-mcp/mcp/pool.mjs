/**
 * pool.mjs — calvin-db-mcp 的连接层（v1.4.0 从 server.mjs 拆出）
 *
 * 职责：三库连接管理（mysql2 池 / pg 池 / node:sqlite 单文件连接，LRU 上限）
 *       与统一的 runQuery 读写分流（mysql affectedRows / pg rowCount / sqlite changes）。
 * 依赖注入：cfg（timeoutMs 等）与 getSource 由 server.mjs 构造时传入，模块自身零全局状态耦合，
 *       可独立加载做连接层单测。
 *
 * 安全要点（与 guard.mjs 的纵深关系）：
 *  - mysql：multipleStatements: false（驱动层拒多语句）；bigNumberStrings 防 BIGINT 精度篡改；
 *  - pg：queryMode:"extended" 强制扩展协议（单语句，v1.0.3 守卫绕过修复的驱动层半边）；
 *  - sqlite：prepare 仅执行首条语句（第二条被忽略，实测）；setReadBigInts 防 INTEGER 精度篡改。
 */
import mysql from "mysql2/promise";
import pg from "pg";
import { firstWord, stripLeadingComments, ToolError } from "./guard.mjs";
import { createObsState, obsRecord } from "./observe.mjs";

/**
 * v1.5.0: 重复列名消歧（纯函数供单测）——mysql/pg 驱动把 SELECT a.id, b.id 的行对象化时
 * 会静默折叠同名列（后者覆盖前者），模型拿到残缺行还以为完整。改以数组行模式取回后按列名
 * zip 成对象，重复名追加 __N 后缀（id、id__2、id__3…），renamed 返回新名→原名映射供提示，
 * fields 返回消歧后的列名（与行对象键一致，供 columns 展示）。
 * sqlite（node:sqlite）无数组行模式，但驱动自带 :N 后缀消歧（实测重复列返回 id、id:1，值不丢），
 * 故不重建以免二次改名；mysql 经 query 工具的自动 LIMIT 派生表本就对重复列名报 ER_DUP_FIELDNAME
 * （明确报错提示加别名），数组模式重建是 runQuery 通用层的兜底（直接调用路径不再静默折叠）。
 */
export function zipFieldNames(fields) {
  const seen = new Map();
  return fields.map((f) => {
    const n = String(f);
    const c = seen.get(n) || 0;
    seen.set(n, c + 1);
    return c === 0 ? n : `${n}__${c + 1}`;
  });
}

export function zipRows(fields, arrayRows) {
  const names = zipFieldNames(fields);
  const renamed = {};
  names.forEach((n, i) => { if (n !== String(fields[i])) renamed[n] = String(fields[i]); });
  const rows = zipRowObjects(names, arrayRows);
  return { rows, renamed, fields: names };
}

/**
 * v1.6.37: 行对象构建——常量键对象字面量工厂快路径（bench_r1637_ab 同脚本并排实测：
 * 1000 行 54.0→18.5µs（−65.7%，88.8× 噪声地板）、100 行 6.9→3.0µs（−56.5%，9.8×））。
 * 字段名组缓存 → new Function 生成工厂（键名经 JSON.stringify 转义进字符串字面量，
 * 引号/反斜杠/换行/代理项列名困在字面量里，无代码注入面；键为常量 → 单态 hidden class，
 * 免逐格动态键查找）。禁项两条实测入档：
 *  ① 逐格 `i === protoAt` 分支进热循环是负优化（1000 行 +5.7%，勿再试）——`__proto__`
 *     列名整表落下方 defineProperty 慢路径（对象字面量的 "__proto__" 键是设原型语法，
 *     与 v1.6.36 normPost 同款处置），正常列名零分支；
 *  ② null 原型行对象 +280µs/1000 行（V1.6.36 已否，勿再试）。
 * 逃生阀：列数 > 512 或超函数参数上限不进工厂，走逐格赋值循环；缓存上限 64 超限整清
 *（与 stmt/sanitize 缓存同策略）。两路径输出逐字节恒等（selftest 差分钉）。
 */
const ZIP_FACTORY_CACHE = new Map();
const ZIP_FACTORY_MAX = 64;
const ZIP_FACTORY_MAX_ARGS = 512;
function zipRowFactory(names) {
  const key = JSON.stringify(names);
  let mk = ZIP_FACTORY_CACHE.get(key);
  if (mk === undefined) {
    const args = names.map((_, i) => "a" + i).join(",");
    const body = "return {" + names.map((n, i) => JSON.stringify(String(n)) + ":a" + i).join(",") + "};";
    mk = new Function(args, body);
    if (ZIP_FACTORY_CACHE.size >= ZIP_FACTORY_MAX) ZIP_FACTORY_CACHE.clear();
    ZIP_FACTORY_CACHE.set(key, mk);
  }
  return mk;
}
/**
 * v1.6.37: 单行 zip 转换器——形态判定与工厂查找按查询做一次，流式路径逐行复用零查找。
 * 输出与 zipRows 行对象同构（__proto__ 列走 defineProperty 慢路径，普通赋值会设原型/丢值，实测丢值）。
 */
function makeZipRow(names) {
  const L = names.length;
  if (L > ZIP_FACTORY_MAX_ARGS || names.indexOf("__proto__") >= 0) {
    const protoAt = names.indexOf("__proto__");
    return (arr) => {
      const o = {};
      for (let i = 0; i < L; i++) {
        if (i === protoAt) Object.defineProperty(o, "__proto__", { value: arr[i], enumerable: true, writable: true, configurable: true });
        else o[names[i]] = arr[i];
      }
      return o;
    };
  }
  const mk = zipRowFactory(names);
  return (arr) => mk(...arr);
}
function zipRowObjects(names, arrayRows) {
  const zip = makeZipRow(names);
  return arrayRows.map((arr) => zip(arr));
}

/**
 * v1.6.32: pg 游标可消费性（纯函数）——DECLARE CURSOR FOR 只接受 SELECT/WITH 家族
 * （含括号复合查询），EXPLAIN/SHOW 等虽在只读守卫白名单内却不能进游标（实测）。
 * 形状判定与 guardReadOnly 的读语句白名单同源（select|with / 括号复合），仅去掉
 * show/describe/desc/explain。不能游标消费的语句由调用方走 runQuery 物化路径（行为不回退）。
 */
export function pgStreamable(sql) {
  const text = stripLeadingComments(String(sql || "")).trim();
  return /^(select|with)\b/i.test(text) || /^\(\s*(select|with)\b/i.test(text);
}

/** mysql/pg 数组行模式 → 对象行（含重复列消歧）。非结果集（OkPacket 等）原样透传。 */
function rowsFromArrays(fields, rows, extra) {
  const names = (fields || []).map((f) => f.name);
  if (Array.isArray(rows) && (rows.length === 0 || Array.isArray(rows[0]))) {
    const z = zipRows(names, rows);
    return { rows: z.rows, fields: z.fields, renamed: z.renamed, ...extra };
  }
  return { rows: rows || [], fields: names, ...extra };
}

// v1.0.1: 连接池收敛——MCP 调用是串行的，"每源 4 连接 × 41 源 = 最坏 164 连接"对数据库侧过重。
// 每源改为 2 连接，并给池表加 LRU 上限，超出时关闭最久未用的空闲池。
const MAX_POOLS = 8;

/**
 * v1.5.2: 驱逐候选纯函数——池数超上限时只挑「最旧的空闲池」；忙池（有在途查询）跳过，
 * 全忙则本轮不驱逐。旧行为无条件关最旧池：串行分发下正常无碰撞，但超时僵尸查询仍在
 * 服务端执行时被逐池关闭，在途连接被掐断报错面不可控。宁可暂时超上限也不掐在途查询
 *（超限量 = 在途查询源数，天然有界）。entries 为 [id, busyCount] 数组、LRU 序（最旧在前）。
 */
export function chooseEviction(entries, maxPools) {
  if (!Array.isArray(entries) || entries.length <= maxPools) return null;
  for (const [id, busy] of entries) if (!busy) return id;
  return null;
}

/**
 * v1.5.3: 慢查询日志线（纯函数）。ms < slowMs 或 slowMs=0（关闭）返回 null；
 * 否则返回单行 stderr 日志：源 + 耗时 + 语句类型（firstWord，含前导注释剥离）+ 压缩空白后
 * 截断 160 字符的语句预览。完整 SQL 不落日志（长语句与字面量数据不外溢）。
 */
export function slowQueryLine(sourceId, sql, ms, slowMs) {
  if (!slowMs || ms < slowMs) return null;
  const head = firstWord(sql) || "(empty)";
  const preview = String(sql).replace(/\s+/g, " ").trim().slice(0, 160);
  return `[calvin-db-mcp] slow query: source=${sourceId} ${ms}ms ${head} | ${preview}`;
}

/**
 * v1.6.21: PG COPY FROM STDIN 的传输封包（import_data 热路径）。不引 pg-copy-streams——
 * 走 pg 客户端的 Submittable 扩展点：client.query(obj) 见 obj.submit 即交出报文控制权
 *（pg/lib/client.js 的队列语义不变，读超时/连接错误仍会回调 handleError），COPY 三个报文
 * 封装是 pg/lib/connection.js 自带的 sendCopyFromChunk/endCopyFrom/sendCopyFail。
 * 数据逐字节走 COPY 文本流（编码由 server.mjs 纯函数 copyTextPayload 完成），SQL 文本里
 * 永远不出现值——注入面与参数化 INSERT 同为零。COPY IN 只能在简单查询协议下进行（扩展
 * 协议不支持），语句文本由 quoteIdent 结构化拼装（表名过 splitIdent、列名过导入表头的
 * 裸标识符钉），引号双写封死逃逸，单语句性质不因此破坏。
 *
 * 生命周期契约：服务端错误/客户端读超时后服务端可能仍在等 CopyData——不发 copyFail 连接
 * 会滞留在 copy-in 态无法复用，故 handleError 里对「未发完」的会补 copyFail（已发 copyDone
 * 的绝不再补，避免协议违例）；done 只 settle 一次（超时后迟到的 CommandComplete/ReadyForQuery
 * 均为无害 no-op）。
 */
const COPY_CHUNK = 64 * 1024;
// v1.6.24: 分块发送间让出事件循环——旧版大 payload 一个同步循环发完全部块（8MB ≈128 块，
// 实测取消通知插队延迟峰值 109ms）；现每块一次 setImmediate。pg 的 sendCopyFromChunk 无
// 背压返回值（纯写 socket 缓冲），这里是「让出」不是「等 drain」——不臆造 drain/flush 语义。
const yieldLoop = () => new Promise((r) => setImmediate(r));

class PgCopyInQuery {
  // v1.6.24: 第三参 signal（可选 AbortSignal）——MCP 取消尽力传导进 COPY 传输：未发完补
  // copyFail 并以取消错误 settle（上层据此原子回滚/批界中止）。生命周期契约逐字不变：
  // copyFail 只在未发完时补（_sentDone/_copyClosed 防双发）、done 只 settle 一次（_settled 防重）。
  constructor(sql, payload, signal) {
    this.sql = sql;
    this.payload = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    this._settled = false;
    this._sentDone = false;
    this._copyClosed = false; // 不再发 CopyData/CopyFail：已发 done、已补 fail、或已中止
    this._sawCopyIn = false;  // CopyInResponse 已到（服务端在 copy-in 态，fail 才有意义）
    this.done = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    this.signal = signal || null;
    this._onAbort = null;
    if (this.signal) {
      this._onAbort = () => this._abortByClient();
      if (this.signal.aborted) this._abortByClient();
      else this.signal.addEventListener("abort", this._onAbort, { once: true });
    }
  }

  submit(connection) {
    this.connection = connection;
    connection.query(this.sql); // 简单查询协议 → CopyInResponse
    return null;
  }

  handleCopyInResponse(connection) {
    this._sawCopyIn = true;
    if (this._copyClosed || this._settled) {
      // 中止/收口先于 CopyInResponse 到达：此刻服务端在 copy-in 态，补一次 fail 让它退出（连接不滞留）
      try { connection.sendCopyFail("cancelled by client"); } catch { /* 连接已断 */ }
      return;
    }
    this._pump(connection); // 异步泵送；错误在泵内收口（settle 一次），不外抛
  }

  // 分块泵送：块间让出（取消通知/定时器可插队）；_copyClosed/_settled 检查在每块发送前与
  // endCopyFrom 前——单线程下「检查→发送」之间无 await，无撕裂竞态
  async _pump(connection) {
    try {
      for (let off = 0; off < this.payload.length; off += COPY_CHUNK) {
        if (this._copyClosed || this._settled) return;
        connection.sendCopyFromChunk(this.payload.subarray(off, off + COPY_CHUNK));
        await yieldLoop();
      }
      if (this._copyClosed || this._settled) return;
      connection.endCopyFrom();
      this._sentDone = true;
      this._copyClosed = true;
    } catch (e) {
      const canFail = !this._sentDone && !this._copyClosed;
      this._copyClosed = true;
      if (canFail) { try { connection.sendCopyFail("client stream error"); } catch { /* 连接已断 */ } }
      this._settle(e);
    }
  }

  handleCommandComplete(msg) {
    const m = /COPY\s+(\d+)/.exec(String(msg?.text ?? ""));
    this._settle(null, m ? Number(m[1]) : 0);
  }

  handleError(err, connection) {
    if (!this._sentDone && !this._copyClosed) {
      this._copyClosed = true;
      try { (connection || this.connection)?.sendCopyFail("cancelled by client"); } catch { /* 连接已断 */ }
    }
    this._settle(err);
  }

  handleReadyForQuery() {
    this._settle(new Error("COPY FROM STDIN ended without CommandComplete"));
  }

  handleEmptyQuery() { this._settle(new Error("COPY FROM STDIN got empty query response")); }

  // COPY FROM STDIN 不产生这些报文；列出来避免 pg 客户端回调到不存在的方法
  handleRowDescription() {}
  handleDataRow() {}
  handlePortalSuspended() {}
  handleCopyData() {}

  // v1.6.24: 客户端取消/超时（notifications/cancelled → AbortSignal）——与 handleError 同形
  // 收口（未发完补 copyFail、settle 一次）；copyFail 仅在服务端已进 copy-in 态时补（_sawCopyIn），
  // 否则留给随后到达的 CopyInResponse 收口。q.done 以取消错误拒绝后：atomic 随 ROLLBACK 整体
  // 归零，非 atomic 在批界中止并如实回报已写入行数。
  _abortByClient() {
    const canFail = !this._sentDone && !this._copyClosed && this._sawCopyIn;
    if (!this._sentDone && !this._copyClosed) this._copyClosed = true;
    if (canFail) { try { this.connection?.sendCopyFail("cancelled by client"); } catch { /* 连接已断 */ } }
    this._settle(new Error("COPY FROM STDIN cancelled by client"));
  }

  _settle(err, rowCount) {
    if (this._settled) return;
    this._settled = true;
    this._copyClosed = true;
    if (this.signal && this._onAbort) this.signal.removeEventListener("abort", this._onAbort);
    if (err) this._reject(err); else this._resolve(rowCount ?? 0);
  }
}

// v1.6.35: sqlite 预编译句柄缓存——node:sqlite 每次 db.prepare 都走一遍 sqlite3_prepare_v2
// 编译，参数化重复语句（Agent 循环点查的主力形态）免重复编译：机制基准（bench_optim2 B 组
// 同脚本旁证）点查 4.46→0.96µs（4.6×）、范围 20 行 11.39→6.51µs（1.75×）；重活语句
// （LIKE 扫 48.8→47.0µs）收益可忽略，正好只加速该加速的。
// 复用安全前提（2026-10-06 实测）：①本文件对句柄的使用（all/run/iterate）都在单个同步块内
// 完成、不跨 tick 持有迭代器，同句柄不会交错；②break/throw 中断迭代后句柄完整复位
// （100 行表实测复用后仍回全量）；③真交错时 node:sqlite 抛 "iterator was invalidated"
// 而非静默脏读。若未来出现跨 tick 的 iterate，必须先改独占借用（busy 标志）再复用。
// 上限 64 条/库、超限整清（与 sanitize 缓存同策略）；prepare 失败不入缓存（错误照抛）。
let SQLITE_STMT_CACHE = new WeakMap(); // DatabaseSync -> Map<sql, StatementSync>
const SQLITE_STMT_CACHE_MAX = 64;
let sqliteStmtCacheOn = true;
// 供基准对照/逃生阀：false = 逐次 prepare（旧口径）并弃掉已缓存句柄（换新 WeakMap，
// 旧条目随 db 释放）。与 guard.setSanitizeCache 同款先例。
export function setSqliteStmtCache(on) {
  sqliteStmtCacheOn = on === true;
  if (!on) SQLITE_STMT_CACHE = new WeakMap();
}

// v1.6.39: pg 命名预编译语句缓存开关（runQuery 扩展协议路径；基准对照/逃生阀同款先例）。
let PG_PREPARED_ON = true;
export function setPgPreparedCache(on) {
  PG_PREPARED_ON = on === true;
}
function cachedPrepare(pool, sql) {
  if (!sqliteStmtCacheOn) {
    const stmt = pool.prepare(sql);
    stmt.setReadBigInts(true);
    if (typeof stmt.setReturnArrays === "function") stmt.setReturnArrays(true); // v1.6.37：数组行+zip 提速半边
    return stmt;
  }
  let m = SQLITE_STMT_CACHE.get(pool);
  if (m === undefined) { m = new Map(); SQLITE_STMT_CACHE.set(pool, m); }
  let stmt = m.get(sql);
  if (stmt === undefined) {
    stmt = pool.prepare(sql);
    stmt.setReadBigInts(true); // 与逐次 prepare 同口径：超安全整数读为 BigInt（stringify 转字符串）
    // v1.6.37: 数组行模式（Node 较新版 setReturnArrays；旧版无此 API 自动回落对象行）。
    // bench_r1637_ab 实测：对象行 552.8µs → 数组行+zipRows 413µs（1000 行，−25%）；
    // 输出与对象行逐字节恒等（差分钉），dup 列名早在 all() 前被显式拒绝，zip 消歧后缀不触发。
    if (typeof stmt.setReturnArrays === "function") stmt.setReturnArrays(true);
    if (m.size >= SQLITE_STMT_CACHE_MAX) m.clear();
    m.set(sql, stmt);
  }
  return stmt;
}

export function createPoolManager({ cfg, getSource, clampInt, sqliteFilePath, scrub, classify }) {
  const pools = new Map(); // Map 保序，用作 LRU
  const busy = new Map();  // v1.5.2: 源 → 在途查询计数（驱逐只挑空闲池）
  // v1.6.3: 首触去重——创建期存在让出点（sqlite 首次要 await import node:sqlite；mysql/pg 创建
  // 虽同步，此结构一并覆盖），并发首查（如 distinct_values 的 Promise.all 两条查询同时冷启动）
  // 旧版会各自建连接：后者覆盖 Map、前者成孤儿连接泄漏（文件句柄/连接数失控）。创建中的源以
  // promise 去重，并发调用共享同一结果；创建失败不留驻（finally 清理，下次调用可重试）。
  const creating = new Map();
  // v1.2.0: 惰性加载 node:sqlite（Node <22.5 无此模块，不用 sqlite 的部署永不触发，保持 >=18.17 兼容）
  let sqliteDbSync = null;

  async function createPoolFor(sourceId) {
    const src = getSource(sourceId);
    let pool;
    if (src.type === "mysql") {
      pool = mysql.createPool({
        uri: src.url,
        waitForConnections: true,
        connectionLimit: 2,
        maxIdle: 1,
        idleTimeout: 60000,
        enableKeepAlive: true,
        connectTimeout: cfg.timeoutMs,
        dateStrings: true,      // DATETIME as strings: no timezone surprises for the model
        multipleStatements: false,
        // v1.0.2: BIGINT/DECIMAL 一律返回字符串——旧版超过 Number.MAX_SAFE_INTEGER 的整数
        //（雪花 ID 普遍如此）会被 JS 静默篡改：实测 9223372036854775807 → 9223372036854776000。
        // 模型拿到错的 id 再用于 WHERE 会操作错行。与 PG 分支（int8 原生返回字符串）对齐。
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
    } else if (src.type === "sqlite") {
      // v1.2.0 SQLite：单文件连接，无需池；busy_timeout 对应 cfg.timeoutMs（并发写等待上限）。
      // DatabaseSync 对不存在的文件会创建空库（测试期最高权限语义）。
      if (!sqliteDbSync) {
        try { ({ DatabaseSync: sqliteDbSync } = await import("node:sqlite")); }
        catch (e) {
          throw new ToolError("E_CONFIG", `SQLite 支持需要 node:sqlite 内置模块（Node >= 22.5，当前 ${process.versions.node}）: ${e.message}`);
        }
      }
      const file = sqliteFilePath(src);
      if (!file) throw new ToolError("E_CONFIG", `SQLite source '${sourceId}' 缺少有效的文件路径（url 形如 sqlite://D:/data/x.db，或字段 file）`);
      pool = new sqliteDbSync(file);
      try { pool.exec(`PRAGMA busy_timeout = ${clampInt(cfg.timeoutMs, 0, 600000, 30000)}`); } catch { /* ignore */ }
      // v1.3.0: 源级 wal 选项——多进程同开一个 .db 文件时提升读写并发（会产生 -wal/-shm 边车文件）
      if (src.wal === true) { try { pool.exec("PRAGMA journal_mode = WAL"); } catch { /* ignore */ } }
    } else {
      pool = new pg.Pool({
        connectionString: src.url,
        max: 2,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: cfg.timeoutMs,
        statement_timeout: cfg.timeoutMs,
        query_timeout: cfg.timeoutMs,
      });
    }
    pools.set(sourceId, pool);
    if (pools.size > MAX_POOLS) {
      const evictId = chooseEviction([...pools.keys()].map((id) => [id, busy.get(id) || 0]), MAX_POOLS);
      if (evictId !== null) {
        const oldest = pools.get(evictId);
        pools.delete(evictId);
        busy.delete(evictId);
        try {
          if (typeof oldest.close === "function") oldest.close();       // sqlite DatabaseSync
          else Promise.resolve(oldest.end()).catch(() => {});            // mysql/pg pool
        } catch { /* ignore eviction error */ }
      }
    }
    return pool;
  }

  // v1.6.55: 配置热切换——被重载标记为 stale 的池：下次 getPool 触达且无在途查询时惰性关闭
  //（busy 不掐：在途查询在旧连接上跑完；之后重建即用新 url/凭据）。绝不主动杀忙池。
  const stalePools = new Set();
  function markStale(sourceId) { stalePools.add(sourceId); }

  async function getPool(sourceId) {
    if (pools.has(sourceId)) {
      const existing = pools.get(sourceId);
      if (stalePools.has(sourceId) && !(busy.get(sourceId) > 0)) {
        stalePools.delete(sourceId);
        pools.delete(sourceId);
        try { existing.close(); } catch { /* 关闭失败由驱动回收 */ }
      } else {
        pools.delete(sourceId);          // 触碰即刷新 LRU 位置
        pools.set(sourceId, existing);
        return existing;
      }
    }
    const inflight = creating.get(sourceId);
    if (inflight) return inflight;
    const p = createPoolFor(sourceId);
    creating.set(sourceId, p);
    try {
      return await p;
    } finally {
      creating.delete(sourceId);
    }
  }

  /** 三库统一执行（单语句）。写返回 changes/rowCount/affectedRows 之一，读返回 rows+fields。 */
  async function runOnPool(pool, src, sql, values, t0) {
    if (src.type === "mysql") {
      // v1.6.39 判据（勿再试）：mysql 服务端预编译复用候选已否决——①mysql2 `stmt.execute`
      // 不支持 rowsAsArray，对象行会让重名列静默折叠（重名消歧语义崩塌，V1.6.34 机制依赖数组行）；
      // ②直连基准点查 prepared 复用反慢 3.8µs（二进制协议解码开销）；③execute()（每次 prepare）
      // 与 text 协议打平（185 vs 188µs），收益仅来自 prepare-once 复用（144 vs 188µs）但被①②抵消。
      // v1.5.0: rowsAsArray + zipRows——防重复列名静默折叠（见 zipRows 注释）
      const [rows, fields] = await pool.query({ sql, values, timeout: cfg.timeoutMs, rowsAsArray: true });
      return rowsFromArrays(fields, rows, { ms: Date.now() - t0 });
    }
    if (src.type === "sqlite") {
      // v1.2.0: 读写分流——写语句用 run() 拿 changes（影响行数），读语句用 all()。
      // setReadBigInts(true)：超安全整数范围的 INTEGER 返回 BigInt（stringify 转字符串，
      // 与 mysql bigNumberStrings / pg int8 策略一致，避免雪花 ID 精度被 JS 篡改）。
      // 多语句安全：node:sqlite prepare 只取第一条语句（第二条被忽略不执行，已实测），
      // 词法守卫仍会先拒绝多语句——两层都安全，但语义上以词法守卫的"明确拒绝"为准。
      const stmt = cachedPrepare(pool, sql); // v1.6.35: 预编译复用（setReadBigInts 在缓存装入时设）；v1.6.37 装入时另设 setReturnArrays
      // v1.5.0: firstWord 剥前导注释——旧版按首个空白分词，`/* c */ INSERT` 会被误判为读
      //（all() 不返回 changes，影响行数静默丢失）
      const first = firstWord(sql);
      if (first === "INSERT" || first === "UPDATE" || first === "DELETE" || first === "REPLACE") {
        const r = stmt.run(...values);
        return { rows: [], fields: [], ms: Date.now() - t0, changes: Number(r?.changes ?? 0) };
      }
      // v1.6.13: 重名结果列前置拒绝——node:sqlite 只能以对象返回行，重名列会静默折叠（实测
      // `SELECT id AS x, id+1 AS x` 只剩后值）。LIMIT 包裹路径 sqlite 派生表会自动消歧
      // （x / x:1，值不丢），但括号开头复合查询、SHOW/PRAGMA 不走包裹——折叠即静默丢数据。
      // 与其猜语义不如显式拒绝，与 mysql ER_DUP_FIELDNAME 的处置口径一致（要求别名）。
      let preCols = [];
      try { preCols = stmt.columns() || []; } catch { /* 旧版无 columns() 或非查询语句 */ }
      const names = preCols.map((c) => c.name);
      if (names.length) {
        const dupName = names.find((n, i) => names.indexOf(n) !== i);
        if (dupName) {
          throw new ToolError("E_PARAM", `SQL 结果列名重复: '${dupName}'。SQLite 行以列名为键，重名列会静默折叠丢值；请为重名列添加别名（如 SELECT a.name AS a_name, b.name AS b_name）后重试。`);
        }
      }
      const out = stmt.all(...values) || [];
      // v1.6.37: columns() 单次复用（原 all() 后二次调用，bench_r1637_ab −3.3µs/查、
      // 驱动调用 4→2/查）+ 数组行 zipRows 常量键工厂重建（1000 行行物化 552.8→413µs，
      // 与对象行逐字节恒等）。数组行/对象行按首行形态自动分辨：旧 Node 无 setReturnArrays
      // 或 stmt 不支持时 all() 返回对象行，走原路径，行为不回退。
      if (out.length && Array.isArray(out[0])) {
        if (names.length) return { rows: zipRows(names, out).rows, fields: names, ms: Date.now() - t0 };
        // 罕见兜底：columns() 无名但有行——重开对象行语句取名（旧口径等价：Object.keys 首行）
        const objStmt = pool.prepare(sql);
        objStmt.setReadBigInts(true);
        const objRows = objStmt.all(...values) || [];
        return { rows: objRows, fields: objRows.length ? Object.keys(objRows[0]) : [], ms: Date.now() - t0 };
      }
      const rows = out;
      let fields = names;
      if (!fields.length && rows.length) fields = Object.keys(rows[0]);
      return { rows, fields, ms: Date.now() - t0 };
    }
    // v1.0.3 安全修复：PG 分支强制扩展查询协议（Parse/Bind/Execute）。旧版 values 为空数组时
    // pg 走简单查询协议（requiresPreparation() 以 values.length>0 判定），允许分号分隔的多条语句
    // 真实执行——配合掩码器的 MySQL 转义语义差异构成守卫绕过：
    // "…'a\'; DROP TABLE t -- '" 在掩码器看来整段在字符串里，PG（standard_conforming_strings=on）
    // 却在第二个引号处闭串，"; DROP" 成为真实第二条语句（已实测守卫层放行）。
    // 扩展协议天然单语句，与掩码器方言修复（sanitizeSql B 族）构成纵深防御。
    // v1.6.39: 命名预编译缓存——unnamed extended 每次 Parse+plan，named 复用后服务端跳过 Parse
    //（直连基准 bench_r1639：字面量 t100 点查 −47.5µs/−39%、100 行全表 −37.7µs/−22%）。
    // v1.6.41: 作用域扩展到参数化（values 非空）——直连干净基准（bench_r1641，15 交替轮 +
    // 地板臂）推翻了 V1.6.39 的字面量收窄依据：V1.6.39 产品级参数化 cell 的「反慢 −10.6%」
    // 是臂序偏置（两轮符号翻转 −10.6%→+16.4% 已示 bias）；V1.6.41 切换观察显示 named auto
    // 无 generic-plan 悬崖（第 6 次后反而更快 79.5 vs 199.2µs），稳态点查 unnamed 152.6 →
    // named-auto 58.6µs（−62%）、范围查 140.3 → 90.7µs（−35%），行数恒等。force_custom_plan
    // 反而更差（点查 69.5/范围 135.0µs——每执行付计划生成费）→ 不做 SET，auto 模式即最优。
    // 语句归属会话：per-client Map 挂在池连接对象上，连接销毁即随 GC 释放；上限 128 防服务端
    // 语句堆积（溢出整批 DEALLOCATE 重开）。错误路径见下方毒化自愈注释。
    if (!PG_PREPARED_ON) {
      const res = await pool.query({ text: sql, values, queryMode: "extended", rowMode: "array" });
      return rowsFromArrays(res.fields, res.rows, { ms: Date.now() - t0, rowCount: res.rowCount });
    }
    const client = await pool.connect();
    try {
      let m = client._dbmcpPrep;
      if (!m) m = client._dbmcpPrep = { map: new Map(), seq: 0 };
      let name = m.map.get(sql);
      if (name === undefined) {
        if (m.map.size >= 128) {
          for (const n of m.map.values()) await client.query({ text: `DEALLOCATE ${n}` });
          m.map.clear();
          // seq 单调不复用：pg 客户端仍跟踪旧 name→text 映射（pg/lib/query.js submit 同名不同文
          // 直接抛 "Prepared statements must be unique"），复用名称会撞客户端跟踪（实测 bench ④）。
        }
        name = `dbmcp_p${m.seq++}`;
        m.map.set(sql, name);
      }
      try {
        const res = await client.query({ name, text: sql, values, rowMode: "array" });
        return rowsFromArrays(res.fields, res.rows, { ms: Date.now() - t0, rowCount: res.rowCount });
      } catch (e) {
        // 毒化自愈：pg 在 Parse「发送时」就记 submittedNamedStatements（pg/lib/query.js prepare），
        // Parse 被服务端拒绝（坏 SQL/表不存在）也不回滚——不清则该连接同名查询永久
        // "prepared statement does not exist"。删客户端跟踪与本 map 后下次重 Parse
        //（Parse 同名=替换语义，不会 "already exists"）。连接级致命错误由池销毁连接自愈。
        m.map.delete(sql);
        try {
          const c = client.connection;
          if (c) {
            if (c.submittedNamedStatements) delete c.submittedNamedStatements[name];
            if (c.parsedStatements) delete c.parsedStatements[name];
          }
        } catch { /* pg 内部形态变化：忽略；名称唯一性由 seq 保证，无碰撞面 */ }
        throw e;
      }
    } finally {
      client.release();
    }
  }

  // v1.5.3: 慢查询日志——默认 2s，DBMCP_SLOW_MS 可调（0 = 关闭）。SQL 先过 scrub（注入的
  // 输出清洗）再截断落 stderr，语句里的字面量数据不随日志外溢。
  const SLOW_MS = clampInt(process.env.DBMCP_SLOW_MS, 0, 3600000, 2000);
  function logSlow(sourceId, sql, ms) {
    const line = slowQueryLine(sourceId, scrub ? scrub(String(sql)) : String(sql), ms, SLOW_MS);
    if (line) console.error(line);
  }
  // v1.6.54: 内存观测状态（server_stats 工具面，observe.mjs 纯函数簇）——常开轻量计数器 +
  // 慢查询环形缓冲；SQL 预览经注入 scrub 脱敏（与 logSlow 同一真相源）；fail-open 零行为影响。
  const OBS = createObsState(SLOW_MS);
  const sqlHead = (sql) => (scrub ? scrub(String(sql)) : String(sql)).replace(/\s+/g, " ").trim().slice(0, 160);

  async function runQuery(sourceId, sql, values = []) {
    const src = getSource(sourceId);
    const pool = await getPool(sourceId);
    busy.set(sourceId, (busy.get(sourceId) || 0) + 1);   // v1.5.2: 在途计数，驱逐不掐忙池
    const t0 = Date.now();
    try {
      const out = await runOnPool(pool, src, sql, values, t0);
      logSlow(sourceId, sql, out.ms);
      obsRecord(OBS, sourceId, out.ms, false, sqlHead(sql));
      return out;
    } catch (e) {
      obsRecord(OBS, sourceId, Date.now() - t0, true, sqlHead(sql), classify ? classify(e).code : null); // v1.6.56: 错误码分布（分类器经注入，避循环 import）
      throw e;
    } finally {
      const n = (busy.get(sourceId) || 1) - 1;
      if (n <= 0) busy.delete(sourceId); else busy.set(sourceId, n);
    }
  }

  // v1.6.33: pg 游标批量单一真源——FETCH 行数与退出阈值必须同值（两处各写 1000 字面量时
  // 曾可单独漂移：FETCH 大于退出阈值会把尾批之后的行静默丢掉）。调参扫描 pgfetch_sweep_v1633
  // 实测 250/500/1000/2000/5000：1000 墙钟最优；减批量是内存换墙钟的线性买卖（250 终峰
  // −2.7MB / 墙钟 +12.5ms，差值≈纯 FETCH 往返序列化，网络 RTT 场景按往返数放大），5000 两头劣化。
  const PG_FETCH_BATCH = 1000;

  /**
   * v1.6.32: 行集流式消费（export CSV 单遍直写路径专用读执行器）。与 runQuery 同守卫后
   * 语句、同列名消歧（zipFieldNames）、同在途计数/慢查询日志；差异只在消费形态：行不聚合成
   * 数组，逐行以瞬时对象经 onRow(row) 交付（onRow 返回 false = 提前停），onFields(names)
   * 先于首行（空结果集也带列名：mysql fields 事件 / pg 首个 FETCH 的 fieldNames /
   * sqlite columns()）。返回 { ms }（行计数由调用方在 onRow 里自记）。
   * 驱动形态（微基准 qstream_micro_v1632 实测定型，30k 行 maxRSS：mysql 204→101MB、
   * pg 231→159MB、sqlite 196→95MB，各驱动输出逐字节恒等）：
   *  - mysql：裸连接 query 事件流（fields/result/end，rowsAsArray 数组行按列名瞬时 zip）；
   *  - pg：事务内游标 DECLARE → FETCH FORWARD PG_FETCH_BATCH（rowMode:"array"；全链 queryMode:"extended"
   *    ——DECLARE 内嵌用户 SQL，扩展协议单语句性质是 v1.0.3 修复的驱动层半边）→ CLOSE → COMMIT；
   *  - sqlite：stmt.iterate()（v1.6.37 起与 runOnPool 同享 setReturnArrays 数组行，逐行 makeZipRow
   *    zip 回对象行；setReadBigInts 同 runQuery；重名列前置拒绝同文案）。
   * 提前停/出错的连接处置：mysql 事件流弃读不可安全还池（半读状态会污染下一条命令）→
   * pconn.destroy()（池内移除、换新连接）；正常提前停走「收尾丢弃」（协议流已在路上，收完
   * 再还）；pg 出错以 ROLLBACK 收口（隐式关游标）后 release，提前停 CLOSE+COMMIT 真早停；
   * sqlite 靠 for-of 迭代器收尾。事务/写路径不动。
   */
  async function runQueryStream(sourceId, sql, { onFields, onRow } = {}) {
    const src = getSource(sourceId);
    const pool = await getPool(sourceId);
    busy.set(sourceId, (busy.get(sourceId) || 0) + 1);
    const t0 = Date.now();
    try {
      await streamOnPool(pool, src, sql, onFields || (() => {}), onRow || (() => {}));
      const ms = Date.now() - t0;
      logSlow(sourceId, sql, ms);
      obsRecord(OBS, sourceId, ms, false, sqlHead(sql));
      return { ms };
    } finally {
      const n = (busy.get(sourceId) || 1) - 1;
      if (n <= 0) busy.delete(sourceId); else busy.set(sourceId, n);
    }
  }

  async function streamOnPool(pool, src, sql, onFields, onRow) {
    if (src.type === "mysql") {
      const pconn = await pool.getConnection();
      let ok = false;
      try {
        await new Promise((resolve, reject) => {
          let names = null;
          let zip = null;   // v1.6.37: 与 zipRows 同构的单行转换器（__proto__ 列走 defineProperty）
          let stopped = false;
          let settled = false;
          const fail = (e) => { if (!settled) { settled = true; reject(e); } };
          const q = pconn.connection.query({ sql, timeout: cfg.timeoutMs, rowsAsArray: true });
          q.on("fields", (fields) => {
            if (settled) return;
            try { names = zipFieldNames((fields || []).map((f) => f.name)); zip = makeZipRow(names); onFields(names); }
            catch (e) { fail(e); }
          });
          q.on("result", (row) => {
            if (settled || stopped) return;
            try {
              const o = zip ? zip(row) : row;
              if (onRow(o) === false) stopped = true;   // 提前停：收尾丢弃（协议流已在路上）
            } catch (e) { fail(e); }
          });
          q.on("error", fail);
          q.on("end", () => { if (!settled) { settled = true; resolve(); } });
        });
        ok = true;
      } finally {
        if (ok) pconn.release();
        else { try { pconn.destroy(); } catch { /* 连接已死由池剔除 */ } }
      }
      return;
    }
    if (src.type === "sqlite") {
      const stmt = cachedPrepare(pool, sql); // v1.6.35: 预编译复用
      // v1.5.0/v1.6.13 口径：重名结果列前置拒绝（行以列名为键，折叠即静默丢数据）——与
      // runOnPool 的 sqlite 分支同文案，流式/物化两条路径对同一语句给出同一错误。
      let preCols = [];
      try { preCols = stmt.columns() || []; } catch { /* 旧版无 columns() 或非查询语句 */ }
      if (preCols.length) {
        const names = preCols.map((c) => c.name);
        const dupName = names.find((n, i) => names.indexOf(n) !== i);
        if (dupName) {
          throw new ToolError("E_PARAM", `SQL 结果列名重复: '${dupName}'。SQLite 行以列名为键，重名列会静默折叠丢值；请为重名列添加别名（如 SELECT a.name AS a_name, b.name AS b_name）后重试。`);
        }
      }
      const outNames = preCols.map((c) => c.name);
      onFields(outNames);
      // v1.6.37: setReturnArrays 是语句级状态，iterate() 同样交付数组行——逐行 zip 回对象行
      //（与 runOnPool 同款 makeZipRow，行形状不变；旧 Node 无 setReturnArrays 仍是驱动对象行，原样透传）
      const zip = outNames.length ? makeZipRow(outNames) : null;
      let stopped = false;
      for (const row of stmt.iterate()) {
        if (stopped) continue;                        // 提前停：收尾丢弃（句柄不留半步状态）
        const o = Array.isArray(row) ? (zip ? zip(row) : row) : row;
        if (onRow(o) === false) stopped = true;
      }
      return;
    }
    // pg：游标只吃 SELECT/WITH 家族（EXPLAIN/SHOW 由调用方走物化路径，见 pgStreamable）
    if (!pgStreamable(sql)) {
      throw new ToolError("E_INTERNAL", "runQueryStream(pg) 仅支持 SELECT/WITH 家族语句（游标语法约束）");
    }
    const client = await pool.connect();
    try {
      await client.query({ text: "BEGIN", queryMode: "extended" });
      try {
        await client.query({ text: `DECLARE qm_cur NO SCROLL CURSOR FOR ${sql}`, queryMode: "extended" });
        let names = null;
        let zip = null;   // v1.6.37: 与 zipRows 同构的单行转换器（__proto__ 列走 defineProperty）
        for (;;) {
          const res = await client.query({ text: `FETCH FORWARD ${PG_FETCH_BATCH} FROM qm_cur`, rowMode: "array", queryMode: "extended" });
          if (names === null) {
            names = zipFieldNames((res.fields || []).map((f) => f.name));
            zip = makeZipRow(names);
            onFields(names);
          }
          let stopped = false;
          for (const arr of res.rows) {
            if (onRow(zip(arr)) === false) { stopped = true; break; }   // 游标可真早停
          }
          if (stopped || res.rows.length < PG_FETCH_BATCH) break;
        }
        await client.query({ text: "CLOSE qm_cur", queryMode: "extended" });
        await client.query({ text: "COMMIT", queryMode: "extended" });
      } catch (e) {
        try { await client.query({ text: "ROLLBACK", queryMode: "extended" }); } catch { /* 连接真死由池剔除 */ }
        throw e;
      }
    } finally {
      client.release();
    }
  }

  /**
   * v1.6.21: COPY FROM STDIN 执行器（仅 postgres）。与 runQuery 同等待遇：在途计数（驱逐
   * 不掐忙池）、慢查询日志、超时由池级 query_timeout 兜底（pg 对 Submittable 同样套读超时，
   * 超时错误文案含 timeout，isAmbiguousWriteError 按结果未知分类——与批 INSERT 一致）。
   * COPY 是连接态协议，须独占一条连接：pool.connect() 检出、finally 归还（行级错误的连接
   * 依旧健康可复用；真死连接由池的 error 监听剔除）。
   */
  async function runCopyIn(sourceId, sql, payload, opts = {}) {
    const src = getSource(sourceId);
    if (src.type !== "postgres") throw new ToolError("E_INTERNAL", "runCopyIn 仅支持 postgres 源（mysql/sqlite 走参数化 INSERT）");
    const pool = await getPool(sourceId);
    busy.set(sourceId, (busy.get(sourceId) || 0) + 1);
    const t0 = Date.now();
    let client;
    try {
      client = await pool.connect();
      const q = new PgCopyInQuery(sql, payload, opts.signal); // v1.6.24: opts.signal → 取消传导
      client.query(q); // Submittable：排入队列后 pg 客户端调 q.submit 接管报文
      const rowCount = await q.done;
      const ms = Date.now() - t0;
      logSlow(sourceId, sql, ms);
      obsRecord(OBS, sourceId, ms, false, sqlHead(sql));
      return { rows: [], fields: [], ms, rowCount };
    } finally {
      if (client) client.release();
      const n = (busy.get(sourceId) || 1) - 1;
      if (n <= 0) busy.delete(sourceId); else busy.set(sourceId, n);
    }
  }

  /**
   * v1.5.3: 单事务执行器——fn(run, copyIn) 里的全部语句在同一连接上以一个事务提交，任一失败整体回滚。
   * mysql/pg 池有 2 连接，事务语句必须钉在同一连接上（pool.query 每次可能换连接，事务会失效），
   * 故各自 getConnection()/connect() 独占一条连接；sqlite 本就是单文件连接，BEGIN/COMMIT 即可。
   * 供 import_data 的 atomic: true（全文件原子）使用；run 执行器仅写语义（无读写分流）。
   * v1.6.23: 第二参 copyIn(sql, payload)——postgres 事务内 COPY FROM STDIN（与 runCopyIn 同一
   * 封包，钉在事务连接上，超时由池级 query_timeout 兜底）；mysql/sqlite 传抛错占位（走参数化
   * INSERT）。事务内 COPY 天然原子：批失败随 ROLLBACK 整体消失，与批 INSERT 的事务语义逐字一致。
   * v1.6.24: copyIn 第三参 opts{signal}——MCP 取消传导（COPY 传输尽力中断，随 ROLLBACK 归零）。
   */
  async function withTransaction(sourceId, fn) {
    const src = getSource(sourceId);
    const pool = await getPool(sourceId);
    busy.set(sourceId, (busy.get(sourceId) || 0) + 1);
    const t0 = Date.now();
    const copyInUnsupported = async () => {
      throw new ToolError("E_INTERNAL", "事务内 COPY FROM STDIN 仅支持 postgres 源（mysql/sqlite 走参数化 INSERT）");
    };
    try {
      let result;
      if (src.type === "mysql") {
        const conn = await pool.getConnection();
        try {
          await conn.query("START TRANSACTION");
          result = await fn((sql, values = []) => conn.query(sql, values), copyInUnsupported);
          await conn.query("COMMIT");
        } catch (e) {
          try { await conn.query("ROLLBACK"); } catch { /* 连接已断：服务端断连自动回滚未提交事务 */ }
          throw e;
        } finally { conn.release(); }
      } else if (src.type === "postgres") {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          result = await fn((sql, values = []) => client.query(sql, values), async (copySql, payload, opts) => {
            const q = new PgCopyInQuery(copySql, payload, opts?.signal); // v1.6.24: 同 runCopyIn，取消传导
            client.query(q); // Submittable：与 runCopyIn 同路，只是钉在事务连接上
            const tc = Date.now();
            const rowCount = await q.done;
            logSlow(sourceId, copySql, Date.now() - tc);
            obsRecord(OBS, sourceId, Date.now() - tc, false, sqlHead(copySql));
            return rowCount;
          });
          await client.query("COMMIT");
        } catch (e) {
          try { await client.query("ROLLBACK"); } catch { /* 同上 */ }
          throw e;
        } finally { client.release(); }
      } else {
        pool.exec("BEGIN");
        try {
          result = await fn((sql, values = []) => {
            return cachedPrepare(pool, sql).run(...values); // v1.6.35: 预编译复用
          }, copyInUnsupported);
          pool.exec("COMMIT");
        } catch (e) {
          try { pool.exec("ROLLBACK"); } catch { /* 同上 */ }
          throw e;
        }
      }
      return { result, ms: Date.now() - t0 };
    } finally {
      const n = (busy.get(sourceId) || 1) - 1;
      if (n <= 0) busy.delete(sourceId); else busy.set(sourceId, n);
    }
  }

  return { getPool, runQuery, runQueryStream, runCopyIn, withTransaction, getObs: () => OBS, markStale, _pools: pools };
}
