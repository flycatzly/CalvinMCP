/**
 * guard.mjs — calvin-db-mcp 的 SQL 安全核心（v1.1.1 从 server.mjs 拆出）
 *
 * 职责：词法掩码（方言感知）→ 只读/写守卫 → 恒真 WHERE 判定 → 写目标解析 →
 *       LIMIT 包裹 → CREATE TABLE 守卫与表名提取。
 * 本模块零依赖（不 import 任何东西）：纯函数 + ToolError 错误类（v1.6.6 起，错误码载体，无副作用），
 * 可独立审计、可单独加载做单元测试。
 * server.mjs 从这里导入并对外重导出（selftest 经由 server.mjs 消费，API 面不变）。
 *
 * 方言背景（v1.0.3 两族修复，详见各函数注释）：
 *  - MySQL：-- 后须跟 ASCII 空白才是注释；可执行注释（/*! / /*M! 开头）是代码；# 是注释；'...' 反斜杠转义。
 *  - PostgreSQL：-- 总是注释；无可执行注释；# 是运算符；'...' 反斜杠是字面量（仅 E''/U&'' 转义）。
 */

/* v1.6.6: ToolError —— 工具错误在抛出点显式携带机器可读错误码（E_*）与重试态，
 * 不再依赖消息模式匹配（server.mjs classifyError 的模式匹配仅作未标注错误/驱动错误的兜底）。
 * 属性名用 errCode/errRetry 而非 code：驱动错误的 e.code（如 ECONNREFUSED）会被
 * callTool 的 catch 拼进消息文本展示，不能被覆盖。 */
const ERR_DEFAULT_RETRY = {
  E_SAFETY: "no-retry",     // 守卫/安全红线拒绝——同样调用永远失败
  E_PARAM: "no-retry",      // 参数或语句形态错误——修正后重试
  E_NOT_FOUND: "no-retry",  // 源/表/列/文件不存在
  E_CONFIG: "no-retry",     // 部署/配置态（初始化、权限）——需运维动作
  E_LIMIT: "conditional",   // 超上限——缩小范围后重试
  E_DB: "no-retry",         // 数据库/驱动错误——调用点可显式指定重试态（如批写入结果未知=conditional）
  E_INTERNAL: "no-retry",   // 未分类兜底（fail-closed）
};

export class ToolError extends Error {
  constructor(code, message, retry) {
    super(message);
    this.name = "ToolError";
    this.errCode = code;
    this.errRetry = retry || ERR_DEFAULT_RETRY[code] || "no-retry";
  }
}

/**
 * Mask out string literals / quoted identifiers / comments; detect multi-statement.
 * 输出与输入逐字符等长（extractWriteTarget 依赖脱敏下标回切原文）。
 *
 * v1.0.3 方言感知——修复两族「掩码语义 ≠ 数据库语义」造成的守卫盲区：
 *  A. 注释族（MySQL）：-- 后必须跟 ASCII 空白/控制字符才是注释（"1--1" 实为 1-(-1)），
 *     JS 的 \s 还覆盖 NBSP/全角空格，用它判断会重新"多抹"；MySQL「可执行注释」（斜杠星叹号开头）
 *     与 MariaDB 变体（斜杠星M叹号开头）是代码而非注释；# 仅 MySQL 是注释。"多抹"比"少抹"危险——
 *     守卫看不见的内容（如 INTO OUTFILE / DUMPFILE）数据库照样执行（实测复现 "SELECT 1--1 INTO OUTFILE" 被放行）。
 *  B. 字符串族（PG）：standard_conforming_strings=on（9.1 起默认）下普通 '...' 里反斜杠是字面量，
 *     字符串比 MySQL 转义语义早一个引号结束。旧版统一按 MySQL 处理反斜杠转义，
 *     "…'a\'; DROP TABLE t -- '" 的 "; DROP" 被误判在字符串内而放行（实测复现）。
 *     现 PG 方言仅 E'...' / U&'...' 转义串内反斜杠作转义；"..." 定界标识符亦无反斜杠转义。
 *     MySQL 语义不变（默认 sql_mode 反斜杠转义；NO_BACKSLASH_ESCAPES 由驱动层 multipleStatements:false 兜底，
 *     PG 侧多语句则由 server.mjs runQuery 的 queryMode:"extended" 在驱动层一并拒绝）。
 *
 * opts.keepLiterals=true 时保留字符串/引号标识符原文，只抹注释（供 stripComments 取表名等展示用途）。
 */
export function sanitizeSql(sql, dialect = "mysql", opts = {}) {
  const keep = opts.keepLiterals === true;
  const pgDialect = dialect === "postgres";
  const out = [];
  let i = 0;
  const n = sql.length;
  let state = "normal";
  let squoteEscape = true;  // '...' 内反斜杠是否转义（MySQL: 是；PG: 仅 E''/U&'' 是）
  let dquoteEscape = true;  // "..." 内反斜杠是否转义（MySQL 字符串: 是；PG 定界标识符: 否）
  // v1.6.21+（adv26）：引号标识符（"..." / `...`）调用形态记录——名字 + 闭引号下标。
  // 掩码把引号标识符整体抹掉后黑名单函数名对守卫不可见，需按名字二次校验（见 guardReadOnly 尾部）。
  const quotedIdents = [];
  let identStart = -1;
  // PG 转义串前缀：紧邻引号前的裸 e 或 U&（前一个字符不能再是标识符字符，防 name'…' 误判）
  const isPgEscapePrefix = (quoteAt) => {
    const p1 = sql[quoteAt - 1] || "";
    const p2 = sql[quoteAt - 2] || "";
    const p3 = sql[quoteAt - 3] || "";
    const ident = /[\w$]/;
    return (((p1 === "e" || p1 === "E") && !ident.test(p2))
         || (p1 === "&" && (p2 === "u" || p2 === "U") && !ident.test(p3)));
  };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (state === "normal") {
      if (c === "-" && d === "-") {
        // MySQL 只认 ASCII 空白/控制字符（\x00-\x20、\x7f）——JS 的 \s 还覆盖 NBSP/全角空格/行分隔符，
        // 用 \s 判断会把它们误当注释，注释之后的内容就被"多抹"掉（守卫看不见、数据库照执行）。
        // 另注意："1--1" 里的 -- 不是注释（MySQL 要求 -- 后必须跟空白/控制字符），实为 1-(-1)。
        const after = sql[i + 2];
        if (pgDialect || after === undefined || /[\x00-\x20\x7f]/.test(after)) {
          state = "line"; out.push("  "); i += 2; continue;
        }
      }
      if (c === "/" && d === "*") {
        // MySQL/MariaDB 可执行注释 /*!...*/ 与 /*M!...*/ 是代码而非注释；
        // 优化器提示 /*+ ... */ 不受影响（第三字符是 +）。
        const c2 = sql[i + 2], c3 = sql[i + 3];
        if (!pgDialect && (c2 === "!" || (c2 === "M" && c3 === "!"))) {
          return { error: "executable-comment" };
        }
        state = "block"; out.push("  "); i += 2; continue;
      }
      if (c === "#" && !pgDialect) { state = "line"; out.push(" "); i += 1; continue; }
      if (c === "'") {
        state = "squote";
        squoteEscape = !pgDialect || isPgEscapePrefix(i);
        out.push(keep ? c : " "); i += 1; continue;
      }
      if (c === '"') {
        state = "dquote";
        dquoteEscape = !pgDialect;
        identStart = i;
        out.push(keep ? c : " "); i += 1; continue;
      }
      if (c === "`") { state = "btick"; identStart = i; out.push(keep ? c : " "); i += 1; continue; }
      if (c === "$") {
        // v1.0.3 复核修复：标签遵循 PG scan.l 的 dolqdelim 规则——字母/下划线开头、仅字母/数字/下划线
        // （标签是两个 $ 之间的内容，构造上不能含 $）。旧正则不认 $tag1$（误报 multi-statement）；
        // 若把 $ 放进续写类又会贪婪吞掉 "$t1$x$t1$" 整段 opener，把真实第二语句掩进字符串（fail-open，
        // 已实测）。现 /以下字母或下划线开头、\w 连续/ 与 PG 语义一致；$1$ 是位置参数不掩蔽（正确）。
        // 非 ASCII 标签（PG 允许 ≥0x80 字节）不识别 → fail-closed，可接受。
        const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i)); // pg dollar-quoted string
        if (m) {
          const end = sql.indexOf(m[0], i + m[0].length);
          const close = end === -1 ? n : end + m[0].length;
          // v1.0.3: 等长不变量修复——旧版把「绝对结束下标」当增量用（push close 个空格、i += close），
          // 含 $$ 的语句输出比输入长（实测 47 字符掩出 63 字符），extractWriteTarget 回切原文错位，
          // 影响行数预检可能算错。现按 [i, close) 区间等长掩蔽（m 至少 2 字符，close > i 恒成立）。
          for (let k = i; k < close; k++) out.push(" ");
          i = close;
          continue;
        }
      }
      if (c === ";") {
        const rest = sql.slice(i + 1);
        if (rest.trim().length > 0) return { error: "multi-statement" };
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n" || c === "\r") { state = "normal"; out.push(c); } else out.push(" ");
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "normal"; out.push("  "); i += 2; continue; }
      out.push(" ");
      i += 1;
      continue;
    }
    if (state === "squote" || state === "dquote") {
      const escape = state === "squote" ? squoteEscape : dquoteEscape;
      if (escape && c === "\\") { // backslash escape（按方言；keep 模式保留原文）
        if (keep) { out.push(c); out.push(d === undefined ? " " : d); } else { out.push("  "); }
        i += 2; continue;
      }
      if (c === (state === "squote" ? "'" : '"')) {
        if (d === c) { // doubled quote
          if (keep) { out.push(c); out.push(d); } else { out.push("  "); }
          i += 2; continue;
        }
        if (state === "dquote") quotedIdents.push({ name: sql.slice(identStart + 1, i), end: i });
        state = "normal"; out.push(keep ? c : " "); i += 1; continue;
      }
      out.push(keep ? c : " ");
      i += 1;
      continue;
    }
    if (state === "btick") {
      if (c === "`") { quotedIdents.push({ name: sql.slice(identStart + 1, i), end: i }); state = "normal"; out.push(keep ? c : " "); } else out.push(keep ? c : " ");
      i += 1;
      continue;
    }
  }
  const masked = out.join("");
  // 调用形态判定：闭引号后紧跟左括号（中间允许空白/注释——注释已掩为空格）才视为函数调用；
  // 允许一个右括号覆盖 ("f")(x) 复合形态。列名引用（无左括号）不进调用名单，不误伤。
  const quotedCalls = [];
  for (const qi of quotedIdents) {
    if (/^\s*\)?\s*\(/.test(masked.slice(qi.end + 1))) quotedCalls.push(qi.name);
  }
  return { text: masked, quotedCalls };
}

/**
 * v1.0.3: 只抹注释、保留字符串与引号标识符原文（sanitizeSql 的 keepLiterals 模式）。
 * 用途：从 DDL 原文里安全地读表名——注释里可能藏着 "CREATE TABLE fake"，必须先抹掉再匹配。
 */
export function stripComments(sql, dialect) {
  const rr = sanitizeSql(sql, dialect, { keepLiterals: true });
  return rr.text === undefined ? "" : rr.text;
}

/**
 * v1.5.0: 剥掉前导注释后取语句首词（大写）。sqlite 读写分流与 PRAGMA 白名单判定共用——
 * 旧版直接 trim().split(/\s+/)[0] / ^\s*word 切词，`/* c *\/ INSERT` 会被误判成注释开头。
 * MySQL 可执行注释（/*!、/*M!）是代码不是注释：不当注释跳过，返回空串（fail-closed）。
 */
export function stripLeadingComments(sql) {
  let s = String(sql ?? "");
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("/*")) {
      if (/^\/\*(!|M!)/i.test(s)) return "";
      const e = s.indexOf("*/");
      if (e < 0) return "";
      s = s.slice(e + 2);
      continue;
    }
    if (s.startsWith("--") || s.startsWith("#")) {
      const e = s.indexOf("\n");
      if (e < 0) return "";
      s = s.slice(e + 1);
      continue;
    }
    return s;
  }
}

export function firstWord(sql) {
  const s = stripLeadingComments(sql);
  const m = s.match(/^[A-Za-z_][\w$]*/);
  return m ? m[0].toUpperCase() : "";
}

// Keywords that can appear INSIDE a read-looking statement and turn it into a write
// (writable CTEs in PostgreSQL, SELECT ... INTO, FOR UPDATE, pg large-object writes).
// Statement-initial keywords (DROP/TRUNCATE/CALL/...) are already rejected by the allowlist.
// v1.0.1 扩充：函数级外泄/外联通道（服务端文件读取、外部数据源）也在只读守卫拦截范围内
const WRITE_WORDS_RE = /\b(insert|update|delete|merge|into|outfile|dumpfile|load_file|lo_import|lo_export|lo_put|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_execute_server_program|dblink)\b/i;
// v1.4.1: 管理/破坏性函数与会话控制（旧版黑名单缺项，实测 pg_terminate_backend/lo_unlink/
// set_config/pg_sleep 等经 query 直达）。要求调用形态（名字后紧跟 '('），不误伤同名列引用；
// dblink 词边界漏 dblink_exec（_ 是词字符）故显式列出；load_extension 可加载任意原生代码。
const DANGER_FUNC_RE = /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_log_rotate|pg_rotate_logfile|pg_advisory_lock|pg_advisory_xact_lock|pg_try_advisory_lock|pg_advisory_unlock_all|pg_sleep|pg_sleep_for|pg_sleep_until|set_config|lo_create|lo_unlink|lo_truncate|lo_from_bytea|dblink_exec|dblink_connect|load_extension|get_lock|release_lock|is_free_lock|is_used_lock|sleep|benchmark|master_pos_wait|wait_for_executed_gtid_set)\s*\(/i;
// v1.0.2: 旧版只拦 FOR SHARE，漏了 MySQL 旧式共享锁语法 LOCK IN SHARE MODE（同样会阻塞写事务）。
const LOCK_SHARE_RE = /\bfor\s+(key\s+)?share\b|\block\s+in\s+share\s+mode\b/i;

/** Throw unless the statement is a single, read-only statement. dialect: "mysql" | "postgres"（缺省按 mysql）. */
export function guardReadOnly(sql, dialect = "mysql") {
  if (!sql || !sql.trim()) throw new ToolError("E_PARAM", "Empty SQL.");
  const s = sanitizeSql(sql, dialect);
  if (s.error === "executable-comment") {
    throw new ToolError("E_SAFETY", 
      "Blocked by read-only guard: MySQL/MariaDB executable comments (/*!...*/, /*M!...*/) are code, not comments."
    );
  }
  if (s.error === "multi-statement") {
    throw new ToolError("E_PARAM", "Only a single SQL statement is allowed (found content after ';').");
  }
  const text = s.text.trim();
  // v1.2.1: 允许括号开头的复合查询（"(SELECT ...) UNION ..."）——旧版一票拒绝属可用性缺口
  //（fail-closed 不是安全洞）；括号仅是优先级语法，语句仍必须是 select/with 家族，写词/行锁照常被后续检查拦截。
  if (!/^(select|with|show|describe|desc|explain)\b/i.test(text) && !/^\(\s*(select|with)\b/i.test(text)) {
    throw new ToolError("E_PARAM", 
      "Read-only tool: statement must start with SELECT / WITH / SHOW / DESCRIBE / EXPLAIN. " +
      "Use the 'execute' tool for writes (only when enabled in config)."
    );
  }
  const w = text.match(WRITE_WORDS_RE);
  if (w) throw new ToolError("E_SAFETY", `Blocked by read-only guard: found '${w[1].toUpperCase()}' outside string literals.`);
  const df = text.match(DANGER_FUNC_RE);
  if (df) throw new ToolError("E_SAFETY", `Blocked by read-only guard: administrative/destructive function call '${df[1]}(' is not allowed in reads.`);
  // v1.6.21+（adv26 收口）：引号标识符调用形态同黑名单——掩码把 "..." / `...` 整体抹掉后黑名单
  // 函数名对上两段正则不可见，`sleep`(5) / "pg_sleep"(5) / U&"pg_sleep"(5) / pg_catalog."pg_sleep"(5)
  // 曾绕过守卫直达数据库（adv26 真实库实证：sleep/benchmark 实际执行、load_file/pg_read_file/
  // lo_export/dblink 触达驱动层）。调用形态（闭引号后紧跟左括号）的名字按同一黑名单拦截；
  // 引号列名引用（非调用形态）不受影响。
  for (const qn of s.quotedCalls) {
    const name = qn.trim();
    if (!name) continue;
    if (DANGER_FUNC_RE.test(name + "(")) {
      throw new ToolError("E_SAFETY", `Blocked by read-only guard: administrative/destructive function call '${name}(' is not allowed in reads.`);
    }
    if (WRITE_WORDS_RE.test(name)) {
      throw new ToolError("E_SAFETY", `Blocked by read-only guard: found '${name.toUpperCase()}' (quoted function name) outside string literals.`);
    }
  }
  if (LOCK_SHARE_RE.test(text)) throw new ToolError("E_SAFETY", "Blocked by read-only guard: row locking (FOR SHARE / LOCK IN SHARE MODE) is not allowed.");
}

/** Throw unless the statement is a single DML statement (INSERT/UPDATE/DELETE). */
/* 安全红线：无 WHERE 的 UPDATE/DELETE、TRUNCATE 一律拒绝，即使用户明确要求全表操作也不执行 */
const FIG_LEAF_WHERE_RE = /\bwhere\b\s*\(?\s*1\s*=\s*1\s*\)?\s*;?\s*$|\bwhere\b\s+true\s*;?\s*$/i;

// v1.0.1：恒真判定泛化。字符串字面量已在 sanitizeSql 阶段被抹为空格，
// 因此只要 WHERE 之后没有任何"列引用"，就视为无过滤条件的全表操作。
const WHERE_KEYWORDS = new Set([
  "true", "false", "null", "unknown", "and", "or", "not", "is", "in", "like", "ilike", "between",
  "exists", "case", "when", "then", "else", "end", "regexp", "rlike", "div", "mod", "xor", "binary",
  "collate", "interval",
  // v1.0.2: 子查询与其它 SQL 关键字——旧版缺这些，导致 WHERE EXISTS (SELECT 1) 里的 "select"
  //         被当成列名，从而把恒真条件判为"引用了列"。
  "select", "from", "as", "join", "inner", "left", "right", "full", "outer", "cross", "on", "using",
  "union", "all", "distinct", "group", "by", "having", "order", "limit", "offset", "asc", "desc",
  "cast", "escape", "any", "some", "value", "values", "set", "insert", "update", "delete", "into",
  "current_date", "current_time", "current_timestamp", "localtime", "localtimestamp", "default",
]);

/**
 * 取脱敏文本中第一个「顶层」WHERE（括号深度 0）之后的表达式——即 UPDATE/DELETE 的外层条件。
 * v1.0.3 修复：旧版取「最后一个 WHERE」，外层恒真 + 子查询引用列的写法被误判为合法——
 * "UPDATE t SET a=1 WHERE 1=1 OR id IN (SELECT id FROM u WHERE u.x=1)" 的全表更新被放行（实测复现）。
 * SET 子查询里的 WHERE（深度 ≥1）与外层 WHERE 同时存在时，正确选中后者。
 * 括号按脱敏文本统计：字符串/注释/dollar-quote 内容均已掩蔽，不会干扰深度。
 */
export function extractWhereClause(sanitizedText) {
  const src = String(sanitizedText);
  const isWord = /[\w$]/;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "(") { depth++; continue; }
    if (c === ")") { if (depth > 0) depth--; continue; }
    if (depth !== 0 || (c !== "w" && c !== "W")) continue;
    if (i > 0 && isWord.test(src[i - 1])) continue; // 标识符内的 where（如 anywhere）
    if (/^where\b/i.test(src.slice(i))) return src.slice(i + 5);
  }
  return null;
}

/** WHERE 是否真正引用了列（脱敏后 'a'='a' 不构成列引用 → 视为恒真） */
export function whereHasColumn(sanitizedText) {
  const rest = extractWhereClause(sanitizedText);
  if (rest === null) return false;
  return exprHasColumn(rest);
}

/** 表达式（不含 WHERE 关键字）是否引用了至少一个列 */
export function exprHasColumn(expr) {
  // v1.0.2: 旧版把任何"非关键字标识符"都当作列，于是函数名（length / upper / COALESCE …）本身
  //         被误判成列，使 WHERE length('ab')=2 这类不引用任何列的恒真条件通过词法守卫。
  //         现规则：标识符后紧跟 "(" 者是函数名，其本身不算列引用；
  //         函数实参里的裸标识符（如 length(name) 的 name）仍照常计为列。
  // v1.6.8 真实测试修复：标识符识别改 Unicode 感知——旧版 [A-Za-z_] 纯 ASCII，
  // 中文列名（国内库常态）不被识别为列引用，导致 WHERE 订单号='D001' 被误判
  // 「WHERE 未引用任何列」而拒执行（红线误杀合法写）。规则不变：非关键字、非函数名的
  // 标识符即列引用；恒真形态（1=1 / true=true / 字面量对）依旧无标识符可命中。
  const re = /[_\p{L}][\p{L}\p{N}$_]*/gu;
  let m;
  while ((m = re.exec(expr))) {
    const name = m[0];
    if (WHERE_KEYWORDS.has(name.toLowerCase())) continue;
    if (/^\s*\(/.test(expr.slice(m.index + name.length))) continue; // 函数调用名
    return true;
  }
  return false;
}

/** 按顶层（括号深度 0）的 OR 关键字拆分表达式为分支列表（大小写不敏感，or/order、标识符内的 or 不误切） */
function splitTopLevelOr(expr) {
  const parts = [];
  let depth = 0, cur = "";
  const isWord = (ch) => /[\w$]/.test(ch);
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === "o" || c === "O")
        && (i === 0 || !isWord(expr[i - 1]))
        && /^or\b/i.test(expr.slice(i))) {
      parts.push(cur);
      cur = "";
      i += 1; // 循环尾再 +1，共跳过 "or"
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * 解析 UPDATE/DELETE 的目标表与外层 WHERE 原文（供影响行数预检使用）。
 * sanitizeSql 逐字符等长输出，故可用脱敏文本下标回切原始 SQL，从而保留字面量（如 'SENT'）。
 * 解析不出目标表（INSERT、多表 UPDATE、DELETE a FROM ... JOIN 等）时返回 null，调用方回退到纯词法守卫。
 */
export function extractWriteTarget(sql, dialect = "mysql") {
  const original = String(sql);
  const s = sanitizeSql(original, dialect);
  if (s.error) return null;
  const head = original.trim();
  // 目标表从原文头部取：标识符可能被反引号/双引号包裹，而 sanitizeSql 会把它们抹成空格
  const m = /^delete\s+from\s+(`?[\p{L}\p{N}$_]+`?(?:\.`?[\p{L}\p{N}$_]+`?)?)/iu.exec(head)
         || /^update\s+(?:low_priority\s+|ignore\s+)*(`?[\p{L}\p{N}$_]+`?(?:\.`?[\p{L}\p{N}$_]+`?)?)/iu.exec(head);
  if (!m) return null;
  const where = extractWhereClause(s.text);
  if (where === null) return null;
  return {
    table: m[1].replace(/[`"]/g, ""),
    where: original.slice(s.text.length - where.length).trim().replace(/;\s*$/, ""),
  };
}

export function guardWrite(sql, dialect = "mysql") {
  if (!sql || !sql.trim()) throw new ToolError("E_PARAM", "Empty SQL.");
  const s = sanitizeSql(sql, dialect);
  if (s.error === "executable-comment") {
    throw new ToolError("E_SAFETY", 
      "Blocked: MySQL/MariaDB executable comments (/*!...*/, /*M!...*/) are code, not comments."
    );
  }
  if (s.error === "multi-statement") {
    throw new ToolError("E_PARAM", "Only a single SQL statement is allowed (found content after ';').");
  }
  const text = s.text.trim();
  if (/^truncate\b/i.test(text)) {
    throw new ToolError("E_SAFETY", 
      "安全红线：禁止通过 MCP 执行 TRUNCATE TABLE（等同于无条件清空全表，且不可恢复）。" +
      "即使用户明确要求也不执行——如确有需要，请通过 DBeaver 等人工渠道由 DBA 操作。"
    );
  }
  if (!/^(insert|update|delete)\b/i.test(text)) {
    throw new ToolError("E_SAFETY", 
      "'execute' only allows single INSERT / UPDATE / DELETE statements. " +
      "DDL (CREATE/ALTER/DROP/TRUNCATE...) and admin statements must be run manually by a DBA."
    );
  }
  if (/^(update|delete)\b/i.test(text) && !/\bwhere\b/i.test(text)) {
    throw new ToolError("E_SAFETY", 
      "安全红线：拒绝执行无 WHERE 条件的 UPDATE/DELETE（会导致全表数据被覆盖/清空）。" +
      "即使用户明确要求全表操作也不执行——如确有需要，请通过 DBeaver 等人工渠道由 DBA 操作。请补充 WHERE 条件后重试。"
    );
  }
  if (/^(update|delete)\b/i.test(text) && FIG_LEAF_WHERE_RE.test(text)) {
    throw new ToolError("E_SAFETY", 
      "安全红线：WHERE 子句为恒真条件（如 WHERE 1=1 / WHERE true），等同无条件的全表操作，拒绝执行。" +
      "请写出真实业务条件；如确有全表操作需求，请通过人工渠道由 DBA 操作。"
    );
  }
  // v1.0.1：泛化恒真判定——WHERE 必须真正引用至少一个列
  // （覆盖旧版遗漏的 WHERE 1 / WHERE 2>1 / WHERE 'a'='a' / WHERE true=true 等写法）
  if (/^(update|delete)\b/i.test(text) && !whereHasColumn(text)) {
    throw new ToolError("E_SAFETY", 
      "安全红线：WHERE 子句未引用任何列（如 WHERE 1 / WHERE 2>1 / WHERE 'a'='a' / WHERE true=true），" +
      "等同于无条件的全表操作，拒绝执行。请写出真实业务条件；" +
      "如确有全表操作需求，请通过 DBeaver 等人工渠道由 DBA 操作。"
    );
  }
  // v1.0.3：OR 分支逐一判定——任一顶层 OR 分支不引用列（如 OR 1=1 / OR true / OR 1），
  // 该分支恒真使整个条件退化为全表操作（经典 "WHERE status=1 OR 1=1" 拖库写法）。
  // 文档原将此类写法划归语义预检拦截；现词法层前置拦截，语义预检退为纵深防御。
  // （仅查顶层 OR 分支；AND 链中的恒真子项（如 a=1 AND 1=1）不扩大结果集，放行，语义预检兜底。）
  if (/^(update|delete)\b/i.test(text)) {
    const outerWhere = extractWhereClause(text);
    if (outerWhere !== null) {
      for (const part of splitTopLevelOr(outerWhere)) {
        if (!exprHasColumn(part)) {
          throw new ToolError("E_SAFETY", 
            "安全红线：WHERE 存在不引用任何列的恒真 OR 分支（如 OR 1=1 / OR true），" +
            "恒真分支使整个条件等同无过滤的全表操作，拒绝执行。请写出真实业务条件；" +
            "如确有全表操作需求，请通过 DBeaver 等人工渠道由 DBA 操作。"
          );
        }
      }
    }
  }
}

/**
 * Enforce maxRows by wrapping the statement in a limited derived table.
 * v1.0.1: WITH 也改为外层包裹（旧版直接追加 LIMIT，遇到 `... LIMIT 5` 会生成
 * `LIMIT 5 LIMIT 201` 语法错误；包裹写法对 LIMIT/OFFSET/FETCH 一律安全）。
 */
export function enforceLimit(sql, maxRows, dialect) {
  const s = sql.trim().replace(/;\s*$/, "");
  const st = sanitizeSql(s, dialect);
  // v1.0.3: 异常语句给出明确错误，而不是 "Cannot read properties of undefined (reading 'trim')"。
  // 服务器路径上 guardReadOnly 会先拒绝，这里是兜底（enforceLimit 是导出 API）。
  if (st.error) {
    throw new ToolError("E_INTERNAL", "Refusing to build a limited query: " + st.error + " (the statement must be rejected by the guard first).");
  }
  // v1.2.1: 括号开头的复合查询（"(SELECT...) UNION..."）——SQLite 的派生表/顶层都不接受
  // 以括号开头的 compound 左操作数（实测 near "(" 语法错误），无法统一包裹；
  // 此类语句不包外层 LIMIT，行数由 doQuery 的执行后截断（rows.slice + truncated 标记）兜底。
  if (/^\(/.test(s)) return s;
  // v1.4.0（已实测否决）: MySQL 8 不接受 SELECT * FROM (SHOW ...)（活库实测全部语法错误），
  // SHOW 无法包裹——维持原样返回，大结果集（SHOW STATUS/PROCESSLIST 等）由 doQuery 执行后截断兜底。
  const first = (st.text.trim().replace(/^\(+\s*/, "").split(/\s+/)[0] || "").toLowerCase();
  if (first === "select" || first === "with") {
    // v1.0.2: 收尾括号必须独占一行——旧版单行拼接时，若 SQL 以行注释（-- / #）结尾，
    //         注释会把右括号一起吃掉，生成语法错误的语句。换行可终止行注释。
    return `SELECT * FROM (\n${s}\n) AS _za_mcp_limit LIMIT ${maxRows + 1}`;
  }
  return s; // SHOW / DESCRIBE / EXPLAIN return small result sets
}

/** 校验 where 条件片段（sample_data/count_rows/distinct_values 共用：多语句/可执行注释/写词拦截） */
export function checkWhereFragment(where, dbType) {
  const s = sanitizeSql(String(where), dbType);
  if (s.error === "multi-statement") throw new ToolError("E_PARAM", "WHERE must be a single condition expression.");
  if (s.error === "executable-comment") {
    throw new ToolError("E_SAFETY", "Blocked in WHERE: MySQL/MariaDB executable comments are not allowed.");
  }
  const m = s.text.match(WRITE_WORDS_RE);
  if (m) throw new ToolError("E_SAFETY", `Blocked in WHERE: found '${m[1].toUpperCase()}' outside string literals.`);
  const df = s.text.match(DANGER_FUNC_RE);
  if (df) throw new ToolError("E_SAFETY", `Blocked in WHERE: administrative/destructive function call '${df[1]}(' is not allowed.`);
  // v1.6.21+（adv26 收口）：引号标识符调用形态同黑名单（与 guardReadOnly 同口径，防 `sleep`(1) 经 where 通道绕行）
  for (const qn of s.quotedCalls) {
    const name = qn.trim();
    if (!name) continue;
    if (DANGER_FUNC_RE.test(name + "(")) {
      throw new ToolError("E_SAFETY", `Blocked in WHERE: administrative/destructive function call '${name}(' is not allowed.`);
    }
    if (WRITE_WORDS_RE.test(name)) {
      throw new ToolError("E_SAFETY", `Blocked in WHERE: found '${name.toUpperCase()}' (quoted function name) outside string literals.`);
    }
  }
}

export function createTableGuard(sql, dialect = "mysql") {
  if (!sql || !sql.trim()) throw new ToolError("E_PARAM", "Empty SQL.");
  const s = sanitizeSql(sql, dialect);
  if (s.error === "multi-statement") throw new ToolError("E_PARAM", "Only a single CREATE TABLE statement is allowed.");
  if (s.error === "executable-comment") {
    throw new ToolError("E_SAFETY", "Blocked: MySQL/MariaDB executable comments (/*!...*/, /*M!...*/) are not allowed.");
  }
  const text = s.text.trim().replace(/;\s*$/, "");
  if (!/^create\s+(temporary\s+)?table\b/i.test(text)) {
    throw new ToolError("E_SAFETY", "'create_table' only accepts a single CREATE TABLE statement. For reads use 'query'; for writes use 'execute'; TRUNCATE/DROP are prohibited.");
  }
  if (/\b(drop|truncate|delete|insert|update|alter|rename)\b/i.test(text)) {
    throw new ToolError("E_SAFETY", "Blocked: CREATE TABLE statement must not contain data-changing keywords.");
  }
  // v1.0.3: CTAS 会写入数据，绕开 allowWrites 开关；只允许纯建表。
  // v1.4.1: MySQL 的 CTAS 可省略 AS（CREATE TABLE t SELECT ...，实测旧正则漏拦）——表名或
  // 列定义列表之后直接跟 SELECT/VALUES/TABLE/EXECUTE 同样是数据写入。WITH 两种例外放行：
  // MariaDB 表选项 WITH SYSTEM VERSIONING、PG 存储参数 WITH (...)，其余 WITH 按 CTE 拦截。
  const ctasTail = /create\s+(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?[\s\S]*?(?:\bas\s*)?\(?\s*(select|table|values|execute)\b/i;
  const ctasWith = /create\s+(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?[\s\S]*?(?:\bas\s*)?\(?\s*with\b(?!\s*\()(?!\s+system\s+versioning)/i;
  if (ctasTail.test(text) || ctasWith.test(text)) {
    throw new ToolError("E_SAFETY", "Blocked: CREATE TABLE ... AS SELECT writes data; use the 'execute' tool (with allowWrites) instead.");
  }
  // C1 DDL 表名标识符预校验：与 import_data.table 的 splitIdent 同口径同文案（正则同族）。
  // 旧版表名原样透传解析器，CREATE TABLE 1bad 落 [E_DB] unrecognized token——错误类误导
  // （E_DB=数据库故障，实为参数问题）。名字提取复用 createTableName（先抹注释）；"(unknown)"
  // （提取失败的畸形 DDL）不硬拦，交还解析器报语法错。安全红线检查在前：带危险关键字的
  // 非法表名仍按 E_SAFETY 拒，参数语义不越过安全语义。
  const ddlName = createTableName(sql, dialect);
  if (ddlName !== "(unknown)") {
    for (const p of ddlName.split(".")) {
      if (!/^[_\p{L}][\p{L}\p{N}$_]*$/u.test(p)) {
        throw new ToolError("E_PARAM", `Invalid identifier '${p}'. Pass plain names; use the schema parameter instead of qualified names.`);
      }
    }
  }
  // v1.0.3 安全修复：校验只针对脱敏文本，返回/执行的必须是原文——sanitizeSql 会把字符串字面量与
  // 反引号标识符一起抹成空格，执行脱敏文本会让任何带 COMMENT 'x' / DEFAULT 'x' / `db`.`t` 的 DDL 报语法错误。
  return String(sql).trim().replace(/;\s*$/, "");
}

/**
 * v1.0.3: 从 CREATE TABLE 原文里取表名。旧实现直接在原文上跑正则：DDL 关键字之间夹注释时
 * 退化成 "(unknown)"；遇反引号库名限定（`db`.`t`）只取到 "db"。现先抹注释，再取整段限定名。
 */
export function createTableName(sql, dialect) {
  const text = stripComments(sql, dialect).trim();
  const m = /^\s*create\s+(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)/i.exec(text);
  return m ? m[1].replace(/[\[\]"`]/g, "") : "(unknown)";
}
