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
import { firstWord } from "./guard.mjs";

/**
 * v1.5.0: 重复列名消歧（纯函数供单测）——mysql/pg 驱动把 SELECT a.id, b.id 的行对象化时
 * 会静默折叠同名列（后者覆盖前者），模型拿到残缺行还以为完整。改以数组行模式取回后按列名
 * zip 成对象，重复名追加 __N 后缀（id、id__2、id__3…），renamed 返回新名→原名映射供提示，
 * fields 返回消歧后的列名（与行对象键一致，供 columns 展示）。
 * sqlite（node:sqlite）无数组行模式，但驱动自带 :N 后缀消歧（实测重复列返回 id、id:1，值不丢），
 * 故不重建以免二次改名；mysql 经 query 工具的自动 LIMIT 派生表本就对重复列名报 ER_DUP_FIELDNAME
 * （明确报错提示加别名），数组模式重建是 runQuery 通用层的兜底（直接调用路径不再静默折叠）。
 */
export function zipRows(fields, arrayRows) {
  const seen = new Map();
  const names = fields.map((f) => {
    const n = String(f);
    const c = seen.get(n) || 0;
    seen.set(n, c + 1);
    return c === 0 ? n : `${n}__${c + 1}`;
  });
  const renamed = {};
  names.forEach((n, i) => { if (n !== String(fields[i])) renamed[n] = String(fields[i]); });
  const rows = arrayRows.map((arr) => {
    const o = {};
    for (let i = 0; i < names.length; i++) o[names[i]] = arr[i];
    return o;
  });
  return { rows, renamed, fields: names };
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

export function createPoolManager({ cfg, getSource, clampInt, sqliteFilePath, scrub }) {
  const pools = new Map(); // Map 保序，用作 LRU
  const busy = new Map();  // v1.5.2: 源 → 在途查询计数（驱逐只挑空闲池）
  // v1.2.0: 惰性加载 node:sqlite（Node <22.5 无此模块，不用 sqlite 的部署永不触发，保持 >=18.17 兼容）
  let sqliteDbSync = null;

  async function getPool(sourceId) {
    if (pools.has(sourceId)) {
      const existing = pools.get(sourceId);
      pools.delete(sourceId);          // 触碰即刷新 LRU 位置
      pools.set(sourceId, existing);
      return existing;
    }
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
          throw new Error(`SQLite 支持需要 node:sqlite 内置模块（Node >= 22.5，当前 ${process.versions.node}）: ${e.message}`);
        }
      }
      const file = sqliteFilePath(src);
      if (!file) throw new Error(`SQLite source '${sourceId}' 缺少有效的文件路径（url 形如 sqlite://D:/data/x.db，或字段 file）`);
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

  /** 三库统一执行（单语句）。写返回 changes/rowCount/affectedRows 之一，读返回 rows+fields。 */
  async function runOnPool(pool, src, sql, values, t0) {
    if (src.type === "mysql") {
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
      const stmt = pool.prepare(sql);
      stmt.setReadBigInts(true);
      // v1.5.0: firstWord 剥前导注释——旧版按首个空白分词，`/* c */ INSERT` 会被误判为读
      //（all() 不返回 changes，影响行数静默丢失）
      const first = firstWord(sql);
      if (first === "INSERT" || first === "UPDATE" || first === "DELETE" || first === "REPLACE") {
        const r = stmt.run(...values);
        return { rows: [], fields: [], ms: Date.now() - t0, changes: Number(r?.changes ?? 0) };
      }
      const rows = stmt.all(...values) || [];
      let fields = [];
      try { fields = (stmt.columns() || []).map((c) => c.name); } catch { /* 旧版无 columns() */ }
      if (!fields.length && rows.length) fields = Object.keys(rows[0]);
      return { rows, fields, ms: Date.now() - t0 };
    }
    // v1.0.3 安全修复：PG 分支强制扩展查询协议（Parse/Bind/Execute）。旧版 values 为空数组时
    // pg 走简单查询协议（requiresPreparation() 以 values.length>0 判定），允许分号分隔的多条语句
    // 真实执行——配合掩码器的 MySQL 转义语义差异构成守卫绕过：
    // "…'a\'; DROP TABLE t -- '" 在掩码器看来整段在字符串里，PG（standard_conforming_strings=on）
    // 却在第二个引号处闭串，"; DROP" 成为真实第二条语句（已实测守卫层放行）。
    // 扩展协议天然单语句，与掩码器方言修复（sanitizeSql B 族）构成纵深防御。
    const res = await pool.query({ text: sql, values, queryMode: "extended", rowMode: "array" });
    return rowsFromArrays(res.fields, res.rows, { ms: Date.now() - t0, rowCount: res.rowCount });
  }

  // v1.5.3: 慢查询日志——默认 2s，DBMCP_SLOW_MS 可调（0 = 关闭）。SQL 先过 scrub（注入的
  // 输出清洗）再截断落 stderr，语句里的字面量数据不随日志外溢。
  const SLOW_MS = clampInt(process.env.DBMCP_SLOW_MS, 0, 3600000, 2000);
  function logSlow(sourceId, sql, ms) {
    const line = slowQueryLine(sourceId, scrub ? scrub(String(sql)) : String(sql), ms, SLOW_MS);
    if (line) console.error(line);
  }

  async function runQuery(sourceId, sql, values = []) {
    const src = getSource(sourceId);
    const pool = await getPool(sourceId);
    busy.set(sourceId, (busy.get(sourceId) || 0) + 1);   // v1.5.2: 在途计数，驱逐不掐忙池
    const t0 = Date.now();
    try {
      const out = await runOnPool(pool, src, sql, values, t0);
      logSlow(sourceId, sql, out.ms);
      return out;
    } finally {
      const n = (busy.get(sourceId) || 1) - 1;
      if (n <= 0) busy.delete(sourceId); else busy.set(sourceId, n);
    }
  }

  /**
   * v1.5.3: 单事务执行器——fn(run) 里的全部语句在同一连接上以一个事务提交，任一失败整体回滚。
   * mysql/pg 池有 2 连接，事务语句必须钉在同一连接上（pool.query 每次可能换连接，事务会失效），
   * 故各自 getConnection()/connect() 独占一条连接；sqlite 本就是单文件连接，BEGIN/COMMIT 即可。
   * 供 import_data 的 atomic: true（全文件原子）使用；run 执行器仅写语义（无读写分流）。
   */
  async function withTransaction(sourceId, fn) {
    const src = getSource(sourceId);
    const pool = await getPool(sourceId);
    busy.set(sourceId, (busy.get(sourceId) || 0) + 1);
    const t0 = Date.now();
    try {
      let result;
      if (src.type === "mysql") {
        const conn = await pool.getConnection();
        try {
          await conn.query("START TRANSACTION");
          result = await fn((sql, values = []) => conn.query(sql, values));
          await conn.query("COMMIT");
        } catch (e) {
          try { await conn.query("ROLLBACK"); } catch { /* 连接已断：服务端断连自动回滚未提交事务 */ }
          throw e;
        } finally { conn.release(); }
      } else if (src.type === "postgres") {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          result = await fn((sql, values = []) => client.query(sql, values));
          await client.query("COMMIT");
        } catch (e) {
          try { await client.query("ROLLBACK"); } catch { /* 同上 */ }
          throw e;
        } finally { client.release(); }
      } else {
        pool.exec("BEGIN");
        try {
          result = await fn((sql, values = []) => {
            const stmt = pool.prepare(sql);
            stmt.setReadBigInts(true);
            return stmt.run(...values);
          });
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

  return { getPool, runQuery, withTransaction, _pools: pools };
}
