// 本地索引库（node:sqlite，零依赖）。所有数据留在本机。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureHome, longPath, mkdirLong, paths } from "./paths.mjs";
import { fmtDay, sha1 } from "./util.mjs";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'unknown', is_group INTEGER DEFAULT 0,
     member_count INTEGER, owner TEXT, labels TEXT, first_ts INTEGER, last_ts INTEGER,
     msg_count INTEGER DEFAULT 0, source TEXT, meta TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_ts DESC)`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, session_name TEXT NOT NULL, session_kind TEXT,
     sender TEXT, sender_id TEXT, is_owner INTEGER DEFAULT 0, ts INTEGER NOT NULL, day TEXT,
     content TEXT, links TEXT, attachments TEXT, source TEXT, run_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender, ts DESC)`,
  `CREATE TABLE IF NOT EXISTS contacts (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, alias TEXT, remark TEXT, is_owner INTEGER DEFAULT 0,
     labels TEXT, first_ts INTEGER, last_ts INTEGER, msg_count INTEGER DEFAULT 0, source TEXT, meta TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_last ON contacts(last_ts DESC)`,
  `CREATE TABLE IF NOT EXISTS labels (name TEXT PRIMARY KEY, contact_count INTEGER DEFAULT 0, meta TEXT)`,
  `CREATE TABLE IF NOT EXISTS contact_labels (contact_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(contact_id,label))`,
  `CREATE INDEX IF NOT EXISTS idx_contact_labels_label ON contact_labels(label)`,
  `CREATE TABLE IF NOT EXISTS links (
     id TEXT PRIMARY KEY, url TEXT, norm TEXT, session_id TEXT, session_name TEXT, sender TEXT,
     ts INTEGER, msg_id TEXT, heat INTEGER DEFAULT 0, context TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_links_norm ON links(norm)`,
  `CREATE INDEX IF NOT EXISTS idx_links_ts ON links(ts DESC)`,
  `CREATE TABLE IF NOT EXISTS opportunities (
     id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, title TEXT, type TEXT, status TEXT,
     stage TEXT, chat TEXT, contact TEXT, role TEXT, confidence TEXT, evidence TEXT,
     follow_up TEXT, next_action TEXT, note TEXT, amount TEXT, links TEXT,
     created_ts INTEGER, updated_ts INTEGER, source TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status)`,
  `CREATE TABLE IF NOT EXISTS opportunity_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, opp_id INTEGER, ts INTEGER, kind TEXT, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS feedback (
     id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target TEXT, verdict TEXT, note TEXT, created_ts INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_target ON feedback(target_type, target)`,
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY, kind TEXT, started_ts INTEGER, finished_ts INTEGER, params TEXT,
     out_dir TEXT, summary TEXT, status TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_ts DESC)`,
  `CREATE TABLE IF NOT EXISTS history (
     id TEXT PRIMARY KEY, ts INTEGER, action TEXT, target TEXT, title TEXT, chars INTEGER,
     files TEXT, payload TEXT, ok INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts DESC)`,
  `CREATE TABLE IF NOT EXISTS inbox_entries (
     id TEXT PRIMARY KEY, created_ts INTEGER, source TEXT, kind TEXT, title TEXT, body TEXT,
     scene TEXT, target TEXT, status TEXT, files TEXT, payload TEXT, hash TEXT, ts_min INTEGER, ts_max INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_entries(created_ts DESC)`,
  `CREATE TABLE IF NOT EXISTS delivery (
     id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT, target TEXT, status TEXT, ts INTEGER,
     detail TEXT, path TEXT)`,
  `CREATE TABLE IF NOT EXISTS exclusions (
     pattern TEXT PRIMARY KEY, kind TEXT, note TEXT, created_ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS scenes (
     id TEXT PRIMARY KEY, name TEXT, match TEXT, priority INTEGER DEFAULT 0, task TEXT,
     targets TEXT, enabled INTEGER DEFAULT 1, meta TEXT, updated_ts INTEGER)`,
];

let _db = null;
let _lastTarget = null;

export function openStore(file) {
  ensureHome();
  const p = paths();
  const target = file || p.store;
  mkdirLong(path.dirname(target));
  // Windows 深目录下 SQLite 受 MAX_PATH 限制，需要扩展长度前缀
  const db = new DatabaseSync(longPath(target));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("PRAGMA busy_timeout=5000");
  for (const ddl of SCHEMA) db.exec(ddl);
  // 默认库路径的首个句柄注册为单例：长驻进程里句柄失效（被 close/回收）时 store() 才能察觉并自愈
  if (!file && !_db) {
    _db = db;
    _lastTarget = target;
  }
  return db;
}

/** 当前单例是否仍然指向一个存在的文件（长驻进程里用户可能删掉/替换 store.db） */
export function storeFilePresent() {
  try {
    return fs.existsSync(longPath(paths().store));
  } catch {
    return false;
  }
}

let _storeNotice = null;

/** 探测当前句柄是否仍然可用（很便宜，用于长驻进程自愈） */
function handleUsable(db) {
  try {
    cached(db,"SELECT count(*) AS n FROM sqlite_master").get();
    return true;
  } catch {
    return false;
  }
}

export function store() {
  // 长驻的 MCP 服务器里，store.db 可能被外部删除、替换或损坏；
  // 继续用失效句柄会静默返回旧数据，所以这里做一次廉价探测并自愈。
  const target = paths().store;
  if (_db) {
    if (_lastTarget !== target) {
      // WECHAT_AI_HOME 切换：静默换绑，不算异常（多 home 测试/多工作区会走到）
      closeStore();
    } else if (!storeFilePresent()) {
      closeStore();
      _storeNotice = "store.db 已被外部删除，已自动重建为空库（原索引需要重新 wai_db_index）";
    } else if (!handleUsable(_db)) {
      closeStore();
      // 句柄失效但文件可能完好（被外部 close/回收），先尝试重开；
      // 只有重开也失败才按损坏处理，避免误把健康库改名成 *.corrupt-*.bak
      try {
        _db = openStore();
        _storeNotice = "store.db 句柄失效，已自动重新打开";
        return _db;
      } catch {
        try {
          fs.renameSync(paths().store, `${paths().store}.corrupt-${Date.now()}.bak`);
          _storeNotice = "store.db 无法读取，已备份为 *.corrupt-*.bak 并重建为空库（原索引需要重新 wai_db_index）";
        } catch {
          _storeNotice = "store.db 无法读取，已重建为空库";
        }
      }
    }
  } else if (_lastTarget === target && !storeFilePresent()) {
    // 句柄已在调用间隙释放（tools/call 结束会 closeStore），文件在间隙里被外部删除
    _storeNotice = "store.db 已被外部删除，已自动重建为空库（原索引需要重新 wai_db_index）";
  }
  if (!_db) {
    try {
      _db = openStore();
    } catch {
      // 打不开且文件存在：按损坏处理（openStore 直接调用仍会抛错，见「损坏库可诊断」用例）
      try {
        fs.renameSync(paths().store, `${paths().store}.corrupt-${Date.now()}.bak`);
        _storeNotice = "store.db 无法读取，已备份为 *.corrupt-*.bak 并重建为空库（原索引需要重新 wai_db_index）";
      } catch {
        _storeNotice = "store.db 无法读取，已重建为空库";
      }
      _db = openStore();
    }
  }
  return _db;
}

/** 读取并消费自愈通知（一次性；未读过的通知会保留到下一次查询） */
export function storeNotice() {
  const n = _storeNotice;
  _storeNotice = null;
  return n;
}

/** 当前是否已有句柄（tools/call 用它区分「本次自开」与「嵌入方自持」） */
export function storeHandleOpen() {
  return !!_db;
}

export function closeStore() {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

/**
 * 事务包装（可重入）。
 * 一次 ingestMessages 会依次调用 insertMessages / recalcSessionCounts / rebuildContactStats，
 * 各自 BEGIN+COMMIT 会变成 3 次提交；嵌套时只让最外层提交，实测可省约 1/3 的写入开销。
 */
export function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
}

export const j = (v) => JSON.stringify(v ?? null);
export const pj = (v, dflt = null) => {
  if (v === null || v === undefined || v === "") return dflt;
  try { return JSON.parse(v); } catch { return dflt; }
};
const b = (v) => (v ? 1 : 0);

// ---------- 语句缓存 ----------
// 同一 SQL 在一次工具调用里会被反复 prepare（逐会话索引、逐联系人重算），
// node:sqlite 的 prepare 不便宜；按连接缓存，句柄 close/重建后旧缓存随 WeakMap 自动失效。
const _stmtCache = new WeakMap();
const STMT_CACHE_MAX = 256;

function cached(db,sql) {
  let m = _stmtCache.get(db);
  if (!m) { m = new Map(); _stmtCache.set(db, m); }
  let s = m.get(sql);
  if (!s) {
    if (m.size >= STMT_CACHE_MAX) m.clear();
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}

// ---------- kv ----------
export function kvGet(k, dflt = null) {
  const row = cached(store(),"SELECT v FROM kv WHERE k=?").get(k);
  return row ? row.v : dflt;
}
export function kvSet(k, v) {
  cached(store(),"INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v));
}

// ---------- sessions ----------
export function sessionId(name, kind = "unknown") {
  return sha1(`${kind}::${String(name ?? "").trim()}`).slice(0, 16);
}

export function upsertSession(db, s) {
  const id = s.id || sessionId(s.name, s.kind);
  cached(db,`INSERT INTO sessions(id,name,kind,is_group,member_count,owner,labels,first_ts,last_ts,msg_count,source,meta)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      kind=excluded.kind,
      is_group=excluded.is_group,
      member_count=COALESCE(excluded.member_count, sessions.member_count),
      owner=COALESCE(excluded.owner, sessions.owner),
      labels=COALESCE(excluded.labels, sessions.labels),
      first_ts=CASE WHEN sessions.first_ts IS NULL THEN excluded.first_ts
                    WHEN excluded.first_ts IS NULL THEN sessions.first_ts
                    ELSE MIN(sessions.first_ts, excluded.first_ts) END,
      last_ts=CASE WHEN sessions.last_ts IS NULL THEN excluded.last_ts
                   WHEN excluded.last_ts IS NULL THEN sessions.last_ts
                   ELSE MAX(sessions.last_ts, excluded.last_ts) END,
      source=COALESCE(excluded.source, sessions.source),
      meta=COALESCE(excluded.meta, sessions.meta)`).run(
    id, s.name, s.kind ?? "unknown", b(s.is_group), s.member_count ?? null, s.owner ?? null,
    s.labels ? j(s.labels) : null, s.first_ts ?? null, s.last_ts ?? null, s.msg_count ?? 0,
    s.source ?? null, s.meta ? j(s.meta) : null,
  );
  return id;
}

/**
 * 重算会话统计。
 * 传入 ids 时只重算这些会话——索引是「每个会话调用一次 ingestMessages」，
 * 全量重算会让整体退化成 O(会话数 x 消息数)。
 */
export function recalcSessionCounts(db, ids = null) {
  // 单语句 + 相关子查询 + IN 批量回写。语义与逐会话重算完全一致：
  // 只回写本次涉及且在 messages 里有行的会话，其它会话（含哨兵测试钉死的坏值）不动。
  // （实测 UPDATE ... FROM 分组扫描反而慢 3 倍：相关子查询走 idx_messages_session 是索引点查。）
  const base = `UPDATE sessions SET
      msg_count = (SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id),
      first_ts = (SELECT MIN(ts) FROM messages m WHERE m.session_id = sessions.id),
      last_ts = (SELECT MAX(ts) FROM messages m WHERE m.session_id = sessions.id)
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)`;
  if (!ids || !ids.length) {
    db.exec(base);
    return;
  }
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return;
  // json_each 传一个 JSON 数组参数：语句形状固定（可复用缓存），也没有 32766 个绑定参数的上限
  cached(db, `${base} AND sessions.id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(list));
}

export function listSessions({ kind, sinceMs, untilMs, limit = 200, minMessages = 1, order = "last" } = {}) {
  const where = [];
  const args = [];
  if (kind) {
    const kinds = Array.isArray(kind) ? kind : String(kind).split(",").map((x) => x.trim()).filter(Boolean);
    if (kinds.length) { where.push(`kind IN (${kinds.map(() => "?").join(",")})`); args.push(...kinds); }
  }
  if (sinceMs) { where.push("COALESCE(last_ts,0) >= ?"); args.push(sinceMs); }
  // 注意括号：OR 条件不加括号会被 AND 优先级架空，first_ts IS NULL 的会话绕过其余过滤
  if (untilMs) { where.push("(COALESCE(first_ts,0) <= ? OR first_ts IS NULL)"); args.push(untilMs); }
  if (minMessages > 1) { where.push("msg_count >= ?"); args.push(minMessages); }
  const sql = `SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ${order === "name" ? "name ASC" : "COALESCE(last_ts,0) DESC"} LIMIT ?`;
  args.push(limit);
  return cached(store(),sql).all(...args).map(rowToSession);
}

export function rowToSession(r) {
  return { ...r, is_group: !!r.is_group, labels: pj(r.labels, []), meta: pj(r.meta, {}) };
}

// ---------- messages ----------
export function messageId(m) {
  return sha1([m.session_name, m.sender ?? "", m.ts ?? "", String(m.content ?? "").slice(0, 400)].join("\u0001")).slice(0, 20);
}

export function normalizeMessage(m, { source = "unknown", runId = null } = {}) {
  const ts = Number(m.ts) || 0;
  const d = ts ? new Date(ts) : null;
  return {
    id: m.id || messageId({ ...m, ts }),
    session_id: m.session_id || sessionId(m.session_name, m.session_kind),
    session_name: m.session_name ?? m.chat ?? "未知会话",
    session_kind: m.session_kind ?? (m.is_group ? "group" : "private"),
    sender: m.sender ?? null,
    sender_id: m.sender_id ?? null,
    is_owner: b(m.is_owner),
    ts,
    day: d ? fmtDay(d) : null,
    content: String(m.content ?? ""),
    links: j(m.links ?? []),
    attachments: j(m.attachments ?? []),
    source,
    run_id: runId,
  };
}

/** 批量写入消息，返回 { inserted, skipped } */
export function insertMessages(db, msgs, opts = {}) {
  const skipSessionRecalc = !!opts.skipSessionRecalc;
  const stmt = cached(db,`INSERT OR IGNORE INTO messages
    (id,session_id,session_name,session_kind,sender,sender_id,is_owner,ts,day,content,links,attachments,source,run_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const sessStmt = cached(db,`INSERT INTO sessions(id,name,kind,is_group,first_ts,last_ts,msg_count,source)
        VALUES(?,?,?,?,?,?,0,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          kind=excluded.kind,
          is_group=excluded.is_group,
          first_ts=CASE WHEN sessions.first_ts IS NULL THEN excluded.first_ts ELSE MIN(sessions.first_ts, excluded.first_ts) END,
          last_ts=CASE WHEN sessions.last_ts IS NULL THEN excluded.last_ts ELSE MAX(sessions.last_ts, excluded.last_ts) END`);
  let inserted = 0;
  const senderStats = new Map();
  const rows = Array.isArray(msgs) ? msgs : [msgs];
  // 先落会话，保证 sessions 与 messages 始终一致
  const sess = new Map();
  const prepared = [];
  for (const raw of rows) {
    const m = raw.id && raw.session_id && raw.day !== undefined ? raw : normalizeMessage(raw, opts);
    if (!m.ts) continue;
    prepared.push(m);
    if (!sess.has(m.session_id)) sess.set(m.session_id, { id: m.session_id, name: m.session_name, kind: m.session_kind, first_ts: m.ts, last_ts: m.ts });
    else {
      const s = sess.get(m.session_id);
      s.first_ts = Math.min(s.first_ts, m.ts);
      s.last_ts = Math.max(s.last_ts, m.ts);
    }
  }
  tx(db, () => {
    for (const s of sess.values()) {
      sessStmt.run(s.id, s.name, s.kind ?? "unknown", s.kind === "group" ? 1 : 0, s.first_ts, s.last_ts, opts.source ?? null);
    }
    for (const m of prepared) {
      const r = stmt.run(
        m.id, m.session_id, m.session_name, m.session_kind, m.sender, m.sender_id, m.is_owner, m.ts,
        m.day, m.content, m.links, m.attachments, m.source, m.run_id,
      );
      if (r.changes > 0) {
        inserted += 1;
        // 记录本次真正落库的行，供联系人统计做增量（不重扫发送者全量历史）
        const nm = m.sender;
        if (nm !== null && nm !== undefined && String(nm) !== "") {
          let d = senderStats.get(nm);
          if (!d) senderStats.set(nm, (d = { n: 0, f: m.ts, l: m.ts }));
          d.n += 1;
          if (m.ts < d.f) d.f = m.ts;
          if (m.ts > d.l) d.l = m.ts;
        }
      }
    }
  });
  // deferStats 时由调用方在批量收尾统一重算，这里跳过，避免逐会话全量重算
  if (inserted > 0 && !skipSessionRecalc) recalcSessionCounts(db, [...sess.keys()]);
  const out = { inserted, skipped: rows.length - inserted };
  Object.defineProperty(out, "senderStats", { value: senderStats, enumerable: false });
  return out;
}

// 兜底共享冻结空数组：语义与逐行 [] 一致（全库对消息行 links/attachments 零变更点，已审计），
// 冻结让未来误改快速失败而非静默串数据；省 20 万行 × 2 次分配。
const EMPTY = Object.freeze([]);
// _indexed 挂原型（不可枚举）：库行的 links 列在索引期已完整提取（rowToCanonical），
// 空数组即「无链接」，分析路径不必再对正文跑提取正则。手写消息（无此原型）不受影响；
// spread 拷贝丢标记的行为与旧「不可枚举自有属性」完全一致（测试锁定）。
const INDEXED_PROTO = {};
Object.defineProperty(INDEXED_PROTO, "_indexed", { value: true, enumerable: false });

export function rowToMessage(r) {
  // 不用 {...r} 展开：node:sqlite 行是 null 原型对象，V8 对它展开走慢路径
  // （20 万行实测 205ms，同内容的纯 JS 对象整套映射才 41ms）；逐键拷贝语义等价：
  // 键面与键序（行键原序 + attachments 补尾）、JSON 序列化、spread 丢失行为均不变。
  const out = Object.create(INDEXED_PROTO);
  for (const k of Object.keys(r)) out[k] = k === "is_owner" ? !!r[k] : r[k];
  out.links = pj(r.links, EMPTY);
  out.attachments = pj(r.attachments, EMPTY);
  return out;
}

/** 轻量行：不解析 links/attachments JSON，供只读文本/时间戳的分析路径使用。
 *  不带 _indexed（links 未解析，messageLinks 需回退正文提取语义）。 */
function rowToMessageLight(r) {
  const out = {};
  for (const k of Object.keys(r)) out[k] = k === "is_owner" ? !!r[k] : r[k];
  out.links = EMPTY;
  out.attachments = EMPTY;
  return out;
}

/** 窗口行（非轻量）的消费列（下标映射的唯一事实源，SQL 拼接与 rowFromWindowTuple 共用）：
 *  analyze 用 session_name/sender/is_owner/ts/content/links，buildCandidates/normMessage 另需
 *  id/session_kind/sender_id/source，contactDailyRows 同覆盖。session_id/day/attachments/run_id
 *  在消费链路（signals/views/reportMd/opportunities/server）零读取，跳过可省列读取与
 *  attachments 的 JSON 解析；映射兜底让行上仍带 attachments: [] 键。 */
const WINDOW_COLS = ["id", "session_name", "session_kind", "sender", "sender_id", "is_owner", "ts", "content", "links", "source"];
const WINDOW_LIGHT_COLS = "id,session_id,session_name,session_kind,sender,sender_id,is_owner,ts,day,content";

/** 窗口行 数组行 → 消息行（下标取列，列序由 WINDOW_COLS 固定，取数前用 stmt.columns() 校验）。
 *  与 rowToMessage 的对象路径 JSON 逐行等价（键序、_indexed 原型、is_owner 布尔化、脏 links 回退）；
 *  links 列恰为 '[]' 时返回共享冻结空数组（见 rowFromTuple 注释）。 */
export function rowFromWindowTuple(r) {
  const out = Object.create(INDEXED_PROTO);
  out.id = r[0];
  out.session_name = r[1];
  out.session_kind = r[2];
  out.sender = r[3];
  out.sender_id = r[4];
  out.is_owner = !!r[5];
  out.ts = r[6];
  out.content = r[7];
  const lk = r[8];
  out.links = lk === "[]" ? EMPTY : pj(lk, EMPTY);
  out.source = r[9];
  out.attachments = EMPTY;
  return out;
}

export function messagesInWindow({ sinceMs, untilMs, sessionIds, limit = 100000, order = "asc", light = false } = {}) {
  const where = ["ts >= ?", "ts <= ?"];
  const args = [sinceMs ?? 0, untilMs ?? Date.now()];
  if (sessionIds && sessionIds.length) {
    where.push(`session_id IN (${sessionIds.map(() => "?").join(",")})`);
    args.push(...sessionIds);
  }
  const cols = light ? WINDOW_LIGHT_COLS : WINDOW_COLS.join(", ");
  const sql = `SELECT ${cols} FROM messages WHERE ${where.join(" AND ")} ORDER BY ts ${order === "desc" ? "DESC" : "ASC"} LIMIT ?`;
  args.push(limit);
  const stmt = cached(store(), sql);
  // 非轻量行走数组行模式（同 messagesForAnalyze：物化 301→237ms/20 万行，整链 408→235ms）；
  // 轻量行保持 rowToMessageLight（无调用方走 light:true，暂不动）。旧 Node 回退对象路径。
  if (!light && typeof stmt.setReturnArrays === "function") {
    const names = stmt.columns().map((c) => c.name);
    if (names.length !== WINDOW_COLS.length || names.some((n, i) => n !== WINDOW_COLS[i])) {
      throw new Error("messagesInWindow 列序与下标映射器不一致：" + names.join(","));
    }
    stmt.setReturnArrays(true);
    return stmt.all(...args).map(rowFromWindowTuple);
  }
  return stmt.all(...args).map(light ? rowToMessageLight : rowToMessage);
}

/** 裸行取数：只取 5 列且跳过 rowToMessage 映射，供只需要文本/时间戳/发送者的分析路径（复联）。
 *  行结构 { session_name, sender, is_owner, ts, content }，按 ts 升序（复联按会话分组前不需再取 links）。
 *  数组行模式（轮12）：裸行本无旧映射可省，取数级收益即物化差（POC 20 万行 5 列：对象行 ~220ms / 数组+映射 ~185ms，-12~-18%）；
 *  链路级更大（reactivation 400d 同版本 A/B 358→229/240ms，-34%）：{} 映射让行成为快隐藏类普通对象，
 *  下游逐行属性访问快于 null 原型行（rowFromRawTuple 用 {} 而非 Object.create(null)，实测再快 5-15%）。
 *  is_owner 保持裸值（0/1），
 *  行值/键序与旧「裸行直返」逐行 JSON 等价（对拍锁定）；行原型为普通对象（与 rowToMessage 行同型），
 *  旧 Node 回退返回 null 原型裸行——原型不作契约承诺。 */
const RAW_COLS = ["session_name", "sender", "is_owner", "ts", "content"];
export function rowFromRawTuple(r) {
  const out = {};
  out.session_name = r[0];
  out.sender = r[1];
  out.is_owner = r[2];
  out.ts = r[3];
  out.content = r[4];
  return out;
}
export function messagesRaw({ sinceMs, untilMs, limit = 500000 } = {}) {
  const stmt = cached(store(), `SELECT ${RAW_COLS.join(", ")} FROM messages WHERE ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?`);
  if (typeof stmt.setReturnArrays === "function") {
    const names = stmt.columns().map((c) => c.name);
    if (names.length !== RAW_COLS.length || names.some((n, i) => n !== RAW_COLS[i])) {
      throw new Error("messagesRaw 列序与下标映射器不一致：" + names.join(","));
    }
    stmt.setReturnArrays(true);
    return stmt.all(sinceMs ?? 0, untilMs ?? Date.now(), limit).map(rowFromRawTuple);
  }
  return stmt.all(sinceMs ?? 0, untilMs ?? Date.now(), limit);
}

/** analyze 专用行：只取分析实际消费的 6 列（跳过 id/session_id/session_kind/sender_id/day/attachments），
 *  links 列照常解析并打 _indexed 标记，messageLinks 不会对正文重跑 URL 提取。
 *  行结构兼容 analyze 的输入约定；attachments 恒为空数组。
 *  取数走数组行模式（Node 23.4+ 的 setReturnArrays）：跳过行对象物化与逐行 Object.keys，
 *  20 万行实测 .all() 对象 210ms / 数组 132ms、整链 311→152ms；旧 Node 无此 API 时
 *  回退对象行 + rowToMessage（与数组路径逐行 JSON 等价，测试锁定）。 */
const ANALYZE_COLS = ["session_name", "sender", "is_owner", "ts", "content", "links"];

/** 数组行 → 消息行（下标取列，列序由 ANALYZE_COLS 固定，取数前用 stmt.columns() 校验）。
 *  与 rowToMessage 的对象路径 JSON 逐行等价：键序同为 session_name…links + attachments 补尾、
 *  _indexed 同挂原型、is_owner 同布尔化、脏 links 同回退空数组。唯一差异：links 列恰为 '[]' 时
 *  返回共享冻结空数组而非新数组（JSON 形状一致；消息行 links 全库零变更点已审计，冻结使误改快速失败）。 */
export function rowFromTuple(r) {
  const out = Object.create(INDEXED_PROTO);
  out.session_name = r[0];
  out.sender = r[1];
  out.is_owner = !!r[2];
  out.ts = r[3];
  out.content = r[4];
  const lk = r[5];
  out.links = lk === "[]" ? EMPTY : pj(lk, EMPTY);
  out.attachments = EMPTY;
  return out;
}

export function messagesForAnalyze({ sinceMs, untilMs, sessionIds, limit = 100000 } = {}) {
  const where = ["ts >= ?", "ts <= ?"];
  const args = [sinceMs ?? 0, untilMs ?? Date.now()];
  if (sessionIds && sessionIds.length) {
    where.push(`session_id IN (${sessionIds.map(() => "?").join(",")})`);
    args.push(...sessionIds);
  }
  args.push(limit);
  const stmt = cached(store(), `SELECT ${ANALYZE_COLS.join(", ")} FROM messages WHERE ${where.join(" AND ")} ORDER BY ts ASC LIMIT ?`);
  if (typeof stmt.setReturnArrays === "function") {
    const names = stmt.columns().map((c) => c.name);
    if (names.length !== ANALYZE_COLS.length || names.some((n, i) => n !== ANALYZE_COLS[i])) {
      throw new Error("messagesForAnalyze 列序与下标映射器不一致：" + names.join(","));
    }
    stmt.setReturnArrays(true);
    return stmt.all(...args).map(rowFromTuple);
  }
  return stmt.all(...args).map(rowToMessage);
}

export function searchMessages({ keyword, keywords, chat, sender, sinceMs, untilMs, limit = 50, ownerOnly = false, excludeOwner = false } = {}) {
  const where = [];
  const args = [];
  const kws = (keywords && keywords.length ? keywords : keyword ? [keyword] : []).filter((x) => String(x).trim());
  for (const k of kws) {
    where.push("content LIKE ?");
    args.push(`%${String(k).trim()}%`);
  }
  if (chat) { where.push("session_name LIKE ?"); args.push(`%${chat}%`); }
  if (sender) { where.push("sender LIKE ?"); args.push(`%${sender}%`); }
  if (sinceMs) { where.push("ts >= ?"); args.push(sinceMs); }
  if (untilMs) { where.push("ts <= ?"); args.push(untilMs); }
  if (ownerOnly) where.push("is_owner = 1");
  if (excludeOwner) where.push("is_owner = 0");
  const sql = `SELECT * FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ?`;
  args.push(limit);
  return cached(store(),sql).all(...args).map(rowToMessage);
}

export function lastMessagesOf(sessionName, limit = 30) {
  return cached(store(),"SELECT * FROM messages WHERE session_name LIKE ? ORDER BY ts DESC LIMIT ?")
    .all(`%${sessionName}%`, limit).map(rowToMessage).reverse();
}

export function sessionDigest({ sinceMs, untilMs }) {
  return cached(store(),`SELECT session_name, session_kind, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
      COUNT(DISTINCT sender) AS senders
    FROM messages WHERE ts >= ? AND ts <= ? GROUP BY session_id ORDER BY n DESC`)
    .all(sinceMs ?? 0, untilMs ?? Date.now());
}

// ---------- contacts / labels ----------
export function upsertContact(db, c) {
  const id = c.id || sha1(String(c.name ?? "")).slice(0, 16);
  cached(db,`INSERT INTO contacts(id,name,alias,remark,is_owner,labels,first_ts,last_ts,msg_count,source,meta)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      alias=COALESCE(excluded.alias, contacts.alias),
      remark=COALESCE(excluded.remark, contacts.remark),
      is_owner=MAX(contacts.is_owner, excluded.is_owner),
      labels=COALESCE(excluded.labels, contacts.labels),
      first_ts=CASE WHEN contacts.first_ts IS NULL THEN excluded.first_ts ELSE MIN(contacts.first_ts, COALESCE(excluded.first_ts, contacts.first_ts)) END,
      last_ts=CASE WHEN contacts.last_ts IS NULL THEN excluded.last_ts ELSE MAX(contacts.last_ts, COALESCE(excluded.last_ts, contacts.last_ts)) END,
      source=COALESCE(excluded.source, contacts.source),
      meta=COALESCE(excluded.meta, contacts.meta)`).run(
    id, c.name, c.alias ?? null, c.remark ?? null, b(c.is_owner), c.labels ? j(c.labels) : null,
    c.first_ts ?? null, c.last_ts ?? null, c.msg_count ?? 0, c.source ?? null, c.meta ? j(c.meta) : null,
  );
  return id;
}

export function setContactLabels(db, contactRef, labels) {
  const row = cached(db,"SELECT id FROM contacts WHERE name=? OR id=?").get(contactRef, contactRef);
  if (!row) return false;
  const ins = cached(db,"INSERT OR IGNORE INTO contact_labels(contact_id,label) VALUES(?,?)");
  for (const l of labels ?? []) ins.run(row.id, String(l));
  return true;
}

export function labelsOf(contactIdOrName) {
  const row = cached(store(),"SELECT id FROM contacts WHERE id=? OR name=?").get(contactIdOrName, contactIdOrName);
  if (!row) return [];
  return cached(store(),"SELECT label FROM contact_labels WHERE contact_id=? ORDER BY label").all(row.id).map((r) => r.label);
}

export function listLabels() {
  return cached(store(),`SELECT l.name, COUNT(cl.contact_id) AS n FROM labels l
    LEFT JOIN contact_labels cl ON cl.label = l.name GROUP BY l.name ORDER BY n DESC, l.name`).all();
}

export function contactsByLabels(labels) {
  if (!labels || !labels.length) return [];
  const ph = labels.map(() => "?").join(",");
  return cached(store(),`SELECT DISTINCT c.* FROM contacts c
    JOIN contact_labels cl ON cl.contact_id=c.id WHERE cl.label IN (${ph}) ORDER BY COALESCE(c.last_ts,0) DESC`)
    .all(...labels);
}

/**
 * 重算联系人统计。
 * 传入 senders 时只重算这些发送者（增量索引路径），否则全量重建。
 */
export function rebuildContactStats(db, senders = null) {
  const stmt = cached(db,`INSERT INTO contacts(id,name,first_ts,last_ts,msg_count,is_owner)
    VALUES(?,?,?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET first_ts=excluded.first_ts, last_ts=excluded.last_ts, msg_count=excluded.msg_count`);
  const list = senders ? [...new Set(senders)].filter((x) => x !== null && x !== undefined && String(x) !== "") : null;
  if (list && !list.length) return 0;
  let rows;
  if (list) {
    const one = cached(db,"SELECT ? AS name, MIN(ts) AS f, MAX(ts) AS l, COUNT(*) AS n FROM messages WHERE sender = ?");
    rows = list.map((name) => one.get(name, name)).filter((r) => r && r.n > 0);
  } else {
    rows = cached(db,`SELECT sender AS name, MIN(ts) f, MAX(ts) l, COUNT(*) n FROM messages
      WHERE sender IS NOT NULL AND sender <> '' GROUP BY sender`).all();
  }
  tx(db, () => {
    for (const r of rows) stmt.run(sha1(String(r.name)).slice(0, 16), r.name, r.f, r.l, r.n);
  });
  return rows.length;
}

/**
 * 联系人统计增量更新：按 insertMessages 收集的「本次真正落库」行累加，
 * 不重扫发送者全量历史（全量聚合随历史行数增长，逐会话索引时是 O(n²)）。
 * 语义与 rebuildContactStats 精确重算一致（哨兵测试口径：只动本次发送者）。
 */
export function applyContactDelta(db, deltas) {
  if (!deltas) return 0;
  const upsert = cached(db, `INSERT INTO contacts(id,name,first_ts,last_ts,msg_count,is_owner)
    VALUES(?,?,?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET
      msg_count = contacts.msg_count + excluded.msg_count,
      first_ts = MIN(COALESCE(contacts.first_ts, excluded.first_ts), COALESCE(excluded.first_ts, contacts.first_ts)),
      last_ts = MAX(COALESCE(contacts.last_ts, excluded.last_ts), COALESCE(excluded.last_ts, contacts.last_ts))`);
  let n = 0;
  for (const [name, d] of deltas) {
    if (name === null || name === undefined || String(name) === "" || !d || !d.n) continue;
    upsert.run(sha1(String(name)).slice(0, 16), name, d.f, d.l, d.n);
    n += 1;
  }
  return n;
}

// ---------- links ----------
export function addLink(db, l) {
  const id = sha1(`${l.norm}|${l.session_id}|${l.ts}|${l.sender}`).slice(0, 20);
  cached(db,`INSERT OR IGNORE INTO links(id,url,norm,session_id,session_name,sender,ts,msg_id,heat,context)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    id, l.url ?? null, l.norm ?? null, l.session_id ?? null, l.session_name ?? null, l.sender ?? null,
    l.ts ?? 0, l.msg_id ?? null, b(l.heat), l.context ?? null,
  );
  return id;
}

export function crossGroupLinks({ sinceMs, untilMs, minChats = 2, limit = 200 } = {}) {
  return cached(store(),`SELECT norm, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(DISTINCT session_id) AS chats,
      COUNT(*) AS hits, MAX(heat) AS heat
    FROM links WHERE ts >= ? AND ts <= ?
    GROUP BY norm HAVING chats >= ? ORDER BY chats DESC, hits DESC LIMIT ?`)
    .all(sinceMs ?? 0, untilMs ?? Date.now(), minChats, limit);
}

export function linkAppearances(norm, limit = 50) {
  return cached(store(),"SELECT * FROM links WHERE norm=? ORDER BY ts ASC LIMIT ?").all(norm, limit);
}

// ---------- runs / history ----------
export function startRun({ kind, params, outDir, id }) {
  const rid = id || `${kind}-${Date.now()}`;
  cached(store(),"INSERT OR REPLACE INTO runs(id,kind,started_ts,finished_ts,params,out_dir,summary,status) VALUES(?,?,?,?,?,?,?,?)")
    .run(rid, kind, Date.now(), null, j(params), outDir ?? null, null, "running");
  return rid;
}
export function finishRun(id, { summary, status = "ok" } = {}) {
  cached(store(),"UPDATE runs SET finished_ts=?, summary=?, status=? WHERE id=?").run(Date.now(), summary ?? null, status, id);
}
export function listRuns(limit = 20) {
  return cached(store(),"SELECT * FROM runs ORDER BY started_ts DESC LIMIT ?").all(limit).map((r) => ({ ...r, params: pj(r.params, {}) }));
}
export function getRun(id) {
  const r = cached(store(),"SELECT * FROM runs WHERE id=?").get(id);
  return r ? { ...r, params: pj(r.params, {}) } : null;
}

export function logHistory(h) {
  const id = h.id || sha1(`${Date.now()}-${Math.random()}`).slice(0, 16);
  cached(store(),"INSERT OR REPLACE INTO history(id,ts,action,target,title,chars,files,payload,ok) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, h.ts ?? Date.now(), h.action ?? null, h.target ?? null, h.title ?? null, h.chars ?? 0,
      j(h.files ?? []), j(h.payload ?? null), b(h.ok ?? true));
  return id;
}
export function listHistory({ limit = 50, action, target } = {}) {
  const where = [];
  const args = [];
  if (action) { where.push("action=?"); args.push(action); }
  if (target) { where.push("target=?"); args.push(target); }
  args.push(limit);
  return cached(store(),`SELECT * FROM history ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ?`)
    .all(...args).map((r) => ({ ...r, files: pj(r.files, []), payload: pj(r.payload, {}), ok: !!r.ok }));
}

// ---------- inbox ----------
export function addInboxEntry(db, e) {
  const id = e.id || sha1(`${e.source}|${e.title}|${(e.body || "").slice(0, 500)}`).slice(0, 20);
  cached(db,`INSERT OR IGNORE INTO inbox_entries(id,created_ts,source,kind,title,body,scene,target,status,files,payload,hash,ts_min,ts_max)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, e.created_ts ?? Date.now(), e.source ?? "manual", e.kind ?? "chat", e.title ?? null,
    e.body ?? null, e.scene ?? null, e.target ?? null, e.status ?? "new", j(e.files ?? []),
    j(e.payload ?? null), e.hash ?? sha1(String(e.body ?? "")), e.ts_min ?? null, e.ts_max ?? null,
  );
  return id;
}
export function listInbox({ status, limit = 50 } = {}) {
  const args = [];
  let where = "";
  if (status) { where = "WHERE status=?"; args.push(status); }
  args.push(limit);
  return cached(store(),`SELECT * FROM inbox_entries ${where} ORDER BY created_ts DESC LIMIT ?`)
    .all(...args).map((r) => ({ ...r, files: pj(r.files, []), payload: pj(r.payload, {}) }));
}
export function updateInbox(db, id, patch) {
  const cur = cached(db,"SELECT * FROM inbox_entries WHERE id=?").get(id);
  if (!cur) return false;
  const next = { ...cur, ...patch };
  cached(db,"UPDATE inbox_entries SET status=?,scene=?,target=?,title=? WHERE id=?")
    .run(next.status, next.scene, next.target, next.title, id);
  return true;
}

// ---------- exclusions ----------
export function addExclusion(db, pattern, kind = "chat", note = null) {
  cached(db,"INSERT OR REPLACE INTO exclusions(pattern,kind,note,created_ts) VALUES(?,?,?,?)")
    .run(String(pattern), kind, note, Date.now());
}
export function listExclusions() {
  return cached(store(),"SELECT * FROM exclusions ORDER BY created_ts DESC").all();
}
export function isExcluded(name) {
  const rows = cached(store(),"SELECT pattern FROM exclusions WHERE kind='chat'").all();
  const n = String(name ?? "");
  return rows.some((r) => r.pattern && n.includes(r.pattern));
}

// ---------- stats ----------
export function storeStats() {
  // 一次查询取回全部计数：wai_status/homeState/窗口路径都调它，9 条独立 COUNT 太奢侈
  const r = cached(store(),`SELECT
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM contacts) AS contacts,
      (SELECT COUNT(*) FROM labels) AS labels,
      (SELECT COUNT(*) FROM links) AS links,
      (SELECT COUNT(*) FROM opportunities) AS opportunities,
      (SELECT COUNT(*) FROM inbox_entries) AS inbox,
      (SELECT MAX(ts) FROM messages) AS lastMessageTs`).get();
  return {
    messages: r.messages,
    sessions: r.sessions,
    contacts: r.contacts,
    labels: r.labels,
    links: r.links,
    opportunities: r.opportunities,
    inbox: r.inbox,
    lastMessageTs: r.lastMessageTs,
    lastIndexTs: Number(kvGet("last_index_ts", "0")) || null,
  };
}
