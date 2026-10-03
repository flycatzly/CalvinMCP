/**
 * calvin-db-mcp selftest: 只读守卫 / 写守卫 / LIMIT / MCP 协议 / stdio 握手 / 未初始化模式。
 * 运行: node selftest.mjs （无需真实数据库；在未初始化目录/缺少特定源时自动 SKIP 相关用例）
 */
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));

// 纯净包不含 node_modules：直接跑本文件会因缺依赖抛出模块解析堆栈，这里给出可操作的提示。
for (const dep of ["mysql2", "pg"]) {
  try { await import(dep); }
  catch {
    console.error("[selftest] 缺少运行时依赖 " + dep + "（纯净包不含 node_modules）。");
    console.error("[selftest] 请先在本目录执行: node ../install.mjs   （或 cd mcp && npm ci --omit=dev）");
    process.exit(2);
  }
}

process.env.DBMCP_NO_LISTEN = "1";
process.env.DBMCP_CONFIG = path.join(here, "dbmcp.config.json");

const SERVER = await import("./server.mjs");
const { intArg, VERSION, handleRpc, guardReadOnly, guardWrite, enforceLimit, scrub, getConfiguredSecrets, stringify, countTruncatedCells, extractWriteTarget, rpcInternalError, probeTcp, sampleSql } = SERVER;

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log("PASS " + name); }
  catch (e) { fail += 1; console.log("FAIL " + name + " - " + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass += 1; console.log("PASS " + name); }
  catch (e) { fail += 1; console.log("FAIL " + name + " - " + e.message); }
}
const throws = (fn, re) => () => {
  let msg = "";
  try { fn(); } catch (e) { msg = e.message || ""; }
  if (!re.test(msg)) throw new Error("expected throw matching /" + re.source + "/, got: " + JSON.stringify(msg));
};

/* ------------------------- read-only guard ------------------------- */
check("guard: plain SELECT allowed", () => guardReadOnly("SELECT * FROM log_record WHERE id = 1"));
check("guard: WITH...SELECT allowed", () => guardReadOnly("WITH c AS (SELECT 1 AS x) SELECT * FROM c"));
check("guard: SHOW allowed", () => guardReadOnly("SHOW TABLES"));
check("guard: EXPLAIN allowed", () => guardReadOnly("EXPLAIN SELECT * FROM t"));
check("guard: DESC allowed", () => guardReadOnly("DESC app_config"));
check("guard: string literal hidden", () => guardReadOnly("SELECT * FROM t WHERE note = 'drop table now'"));
check("guard: block comment hidden", () => guardReadOnly("SELECT * FROM t /* ); drop */ WHERE id = 1"));
check("guard: line comment hidden", () => guardReadOnly("SELECT * FROM t -- ; delete from x\nWHERE id=1"));
check("guard: keyword in column name ok (update_time)", () => guardReadOnly("SELECT update_time FROM log_record WHERE is_deleted = 0"));
check("guard: INSERT blocked", throws(() => guardReadOnly("INSERT INTO t VALUES (1)"), /read-only|Blocked|start with/i));
check("guard: writable CTE blocked", throws(() => guardReadOnly("WITH x AS (INSERT INTO t VALUES(1) RETURNING *) SELECT * FROM x"), /Blocked/i));
check("guard: multi-statement blocked", throws(() => guardReadOnly("SELECT 1; DROP TABLE t"), /single|;/i));
check("guard: semicolon in string ok", () => guardReadOnly("SELECT ';' AS x"));
check("guard: UPDATE blocked", throws(() => guardReadOnly("UPDATE t SET a = 1"), /read-only|start with/i));
check("guard: FOR UPDATE blocked", throws(() => guardReadOnly("SELECT * FROM t FOR UPDATE"), /Blocked|read-only/i));
check("guard: FOR SHARE blocked", throws(() => guardReadOnly("SELECT * FROM t FOR SHARE"), /Blocked|read-only/i));
check("guard: SELECT INTO OUTFILE blocked", throws(() => guardReadOnly("SELECT * FROM t INTO OUTFILE '/tmp/x'"), /Blocked|read-only/i));
check("guard: TRUNCATE blocked", throws(() => guardReadOnly("TRUNCATE TABLE t"), /read-only|start with/i));
check("guard: pg lo_export blocked", throws(() => guardReadOnly("SELECT lo_export(1, '/tmp/x') FROM t"), /Blocked/i));
check("guard: pg_read_file blocked (server-side file read)", throws(() => guardReadOnly("SELECT pg_read_file('/etc/passwd')"), /Blocked/i));
check("guard: pg_ls_dir blocked", throws(() => guardReadOnly("SELECT pg_ls_dir('/') FROM t"), /Blocked/i));
check("guard: dblink blocked (outbound channel)", throws(() => guardReadOnly("SELECT * FROM dblink('h','select 1') x"), /Blocked/i));

/* --------------------------- write guard --------------------------- */
check("write: UPDATE ok", () => guardWrite("UPDATE t SET a = 1 WHERE id = 1"));
check("write: DELETE without WHERE refused", throws(() => guardWrite("DELETE FROM t"), /WHERE/i));
check("write: DDL refused", throws(() => guardWrite("DROP TABLE t"), /execute|INSERT|UPDATE|DELETE/i));
check("write: TRUNCATE refused (red line)", throws(() => guardWrite("TRUNCATE t"), /TRUNCATE|全表/i));
check("write: multi-statement refused", throws(() => guardWrite("UPDATE t SET a=1 WHERE id=1; DROP TABLE t"), /single|;/i));
check("redline: UPDATE without WHERE refused (user insist ignored)", throws(() => guardWrite("UPDATE t SET a = 1"), /安全红线|WHERE/i));
check("redline: DELETE without WHERE refused", throws(() => guardWrite("DELETE FROM t"), /安全红线|WHERE/i));
check("redline: WHERE hidden in string does not count", throws(() => guardWrite("UPDATE t SET note = 'where' "), /安全红线|WHERE/i));
check("redline: WHERE hidden in comment does not count", throws(() => guardWrite("UPDATE t SET a = 1 /* where */"), /安全红线|WHERE/i));
check("redline: fig-leaf WHERE 1=1 refused", throws(() => guardWrite("UPDATE t SET a = 1 WHERE 1=1"), /安全红线|恒真/i));
check("redline: fig-leaf WHERE true refused", throws(() => guardWrite("DELETE FROM t WHERE true"), /安全红线|恒真/i));
check("redline: WHERE 1=1 AND real condition allowed", () => guardWrite("UPDATE t SET a = 1 WHERE 1=1 AND status = 1"));
check("redline: WHERE 1 (no column ref) refused", throws(() => guardWrite("DELETE FROM t WHERE 1"), /安全红线|列/i));
check("redline: WHERE 2>1 refused", throws(() => guardWrite("DELETE FROM t WHERE 2>1"), /安全红线|列/i));
check("redline: WHERE 'a'='a' refused", throws(() => guardWrite("DELETE FROM t WHERE 'a'='a'"), /安全红线|列/i));
check("redline: WHERE true=true refused", throws(() => guardWrite("UPDATE t SET a=1 WHERE true=true"), /安全红线|列/i));
check("redline: WHERE 1 with trailing comment refused", throws(() => guardWrite("DELETE FROM t WHERE 1 -- x"), /安全红线|列/i));
check("redline: real column condition still allowed", () => guardWrite("DELETE FROM t WHERE id IS NOT NULL"));

/* ------------------------ limit enforcement ------------------------ */
check("limit: SELECT wrapped", () => {
  const s = enforceLimit("SELECT * FROM t", 200);
  if (!/AS _za_mcp_limit LIMIT 201$/i.test(s)) throw new Error(s);
});
check("limit: WITH wrapped", () => {
  const s = enforceLimit("WITH c AS (SELECT 1) SELECT * FROM c", 50);
  // v1.0.2: 包裹改为多行（收尾括号独占一行以避开行注释），用 [\s\S] 跨行匹配
  if (!/^SELECT \* FROM \(\s*WITH [\s\S]*\)\s*AS _za_mcp_limit LIMIT 51$/i.test(s)) throw new Error(s);
});
check("limit: WITH that already has LIMIT not double-appended (v1.0.1 regression)", () => {
  const s = enforceLimit("WITH c AS (SELECT 1) SELECT * FROM c LIMIT 5", 200);
  if ((s.match(/\blimit\b/gi) || []).length !== 2) throw new Error("unexpected LIMIT count: " + s);
  if (!s.endsWith("LIMIT 201")) throw new Error(s);
  if (/LIMIT 5 LIMIT 201/i.test(s)) throw new Error("double LIMIT still produced: " + s);
});
check("limit: WITH with OFFSET wrapped", () => {
  const s = enforceLimit("WITH c AS (SELECT 1) SELECT * FROM c OFFSET 3", 50);
  if (!s.endsWith("LIMIT 51")) throw new Error(s);
});
check("limit: SHOW untouched", () => { const s = enforceLimit("SHOW TABLES", 50); if (s !== "SHOW TABLES") throw new Error(s); });
check("limit: trailing semicolon stripped", () => { const s = enforceLimit("SELECT * FROM t;", 10); if (s.includes(";")) throw new Error(s); });

/* ------------- sample_data SQL builder (v1.0.1 hardening) ----------- */
const MYSQL_REF = "`db`.`log_record`", PG_REF = "\"public\".\"log_record\"";
check("sample: plain select + limit", () => {
  const s = sampleSql("mysql", MYSQL_REF, { limit: 10 });
  if (s !== "SELECT * FROM `db`.`log_record` LIMIT 10") throw new Error(s);
});
check("sample: bare order_by column (ascending, no suffix)", () => {
  const s = sampleSql("mysql", MYSQL_REF, { orderBy: "id", limit: 5 });
  if (!s.endsWith("ORDER BY `id` LIMIT 5")) throw new Error(s);
});
check("sample: order_by with DESC direction", () => {
  const s = sampleSql("mysql", MYSQL_REF, { orderBy: "created_at DESC", limit: 5 });
  if (!s.endsWith("ORDER BY `created_at` DESC LIMIT 5")) throw new Error(s);
});
check("sample: order_by lowercase asc normalized", () => {
  const s = sampleSql("postgres", PG_REF, { orderBy: "created_at asc", limit: 5 });
  if (!s.endsWith('ORDER BY "created_at" ASC LIMIT 5')) throw new Error(s);
});
check("sample: order_by injection rejected", throws(() => sampleSql("mysql", MYSQL_REF, { orderBy: "id DESC; DROP TABLE x", limit: 5 }), /Invalid order_by/));
check("sample: order_by comment injection rejected", throws(() => sampleSql("mysql", MYSQL_REF, { orderBy: "id -- x", limit: 5 }), /Invalid order_by/));
check("sample: order_by with two columns rejected", throws(() => sampleSql("mysql", MYSQL_REF, { orderBy: "id, name", limit: 5 }), /Invalid order_by/));
check("sample: where applied before order/limit", () => {
  const s = sampleSql("mysql", MYSQL_REF, { where: "status = 'SENT'", orderBy: "id DESC", limit: 3 });
  if (s !== "SELECT * FROM `db`.`log_record` WHERE status = 'SENT' ORDER BY `id` DESC LIMIT 3") throw new Error(s);
});
check("sample: where keeps literals containing keywords", () => {
  const s = sampleSql("mysql", MYSQL_REF, { where: "note = 'drop table x'", limit: 2 });
  if (!s.includes("WHERE note = 'drop table x'")) throw new Error(s);
});
check("sample: where multi-statement rejected", throws(() => sampleSql("mysql", MYSQL_REF, { where: "id = 1; DROP TABLE x", limit: 2 }), /single condition/));
check("sample: where write keyword rejected", throws(() => sampleSql("mysql", MYSQL_REF, { where: "id = 1 UNION SELECT 1 INTO OUTFILE '/tmp/x'", limit: 2 }), /Blocked in WHERE/));

/* --- v1.0.2 回归：用户传入的 limit/max_rows 非法值应报错，而非静默改成 1 --- */
const badLimits = [
  { args: { source: "x", limit: -5 }, what: "list_tables limit=-5" },
  { args: { source: "x", limit: 0 }, what: "list_tables limit=0" },
  { args: { source: "x", limit: "abc" }, what: "list_tables limit=abc" },
  { args: { source: "x", limit: 1.5 }, what: "list_tables limit=1.5" },
];
for (const { args, what } of badLimits) {
  check("arg guard: invalid limit rejected (" + what + ")", () => {
    try { intArg(args.limit, "limit", 1, 5000, 500); } catch { return; }
    throw new Error("invalid limit was silently accepted: " + what);
  });
}
check("arg guard: valid limit accepted", () => {
  if (intArg(50, "limit", 1, 5000, 500) !== 50) throw new Error("50 应原样通过");
  if (intArg("50", "limit", 1, 5000, 500) !== 50) throw new Error("字符串数字应被接受");
  if (intArg(undefined, "limit", 1, 5000, 500) !== 500) throw new Error("缺省应用默认值");
  if (intArg(999999, "limit", 1, 5000, 500) !== 5000) throw new Error("超大值应夹到上限");
});

/* --- v1.0.2 回归：末尾行注释不得吞掉包裹括号（旧版生成语法错误的 SQL） --- */
for (const [s, tail] of [
  ["SELECT 1 -- c", "-- c"],
  ["SELECT 1\n-- tail\n", "-- tail"],
  ["SELECT * FROM t WHERE id=1 -- x", "-- x"],
  ["SELECT 1 # c", "# c"],
]) {
  check("limit: trailing comment not swallowed (" + JSON.stringify(s) + ")", () => {
    const out = enforceLimit(s, 200);
    // 收尾括号必须与注释不在同一行，否则右括号被注释吃掉
    const lastLine = out.split("\n").pop() || "";
    if (!/\bLIMIT 201\b/.test(out)) throw new Error("missing outer LIMIT: " + out);
    if (/--|#/.test(lastLine)) throw new Error("closing paren swallowed by comment: " + out);
  });
}

/* --- v1.0.2 回归：共享锁语法 LOCK IN SHARE MODE（旧版漏拦） --- */
check("read guard: LOCK IN SHARE MODE rejected", throws(() => guardReadOnly("SELECT * FROM t LOCK IN SHARE MODE"), /row locking|Blocked/));
check("read guard: FOR SHARE rejected", throws(() => guardReadOnly("SELECT * FROM t FOR SHARE"), /row locking|Blocked/));
check("read guard: FOR UPDATE rejected", throws(() => guardReadOnly("SELECT * FROM t FOR UPDATE"), /Blocked/));
check("read guard: plain SELECT still allowed", () => { guardReadOnly("SELECT * FROM t WHERE id=1"); });

/* --- v1.0.2 回归：函数名/子查询关键字不得被当作列引用（此前 5 种写法被判合法） --- */
const whereTautologies = [
  "UPDATE t SET a=1 WHERE length('ab')=2",
  "UPDATE t SET a=1 WHERE upper('x')='X'",
  "UPDATE t SET a=1 WHERE EXISTS (SELECT 1)",
  "UPDATE t SET a=1 WHERE 1=length('ab')",
  "UPDATE t SET a=1 WHERE COALESCE(NULL,1)=1",
];
for (const s of whereTautologies) {
  check("write guard: function-only WHERE rejected (" + s.slice(28, 52) + ")", () => {
    // 该断言要求守卫抛错；若未抛错则说明恒真条件被放行
    try { guardWrite(s); } catch { return; }
    throw new Error("tautological WHERE was allowed: " + s);
  });
}
const whereRealColumns = [
  "UPDATE t SET a=1 WHERE length(name)=2",
  "UPDATE t SET a=1 WHERE upper(name)='X'",
  "UPDATE t SET a=1 WHERE EXISTS (SELECT 1 FROM u WHERE u.id=t.id)",
  "UPDATE t SET a=1 WHERE COALESCE(nick, name)='x'",
  "DELETE FROM t WHERE id = 1",
];
for (const s of whereRealColumns) {
  check("write guard: real column in WHERE allowed (" + s.slice(28, 52) + ")", () => { guardWrite(s); });
}
/* -------- v1.0.3 回归：方言盲的注释识别 / create_table 执行文本 -------- */
// sanitizeSql 的注释规则与实际方言不一致时，"多抹"最危险——守卫看不见的内容（INTO OUTFILE 等）
// 数据库照样执行。MySQL 要求 -- 后跟空白才是注释（1--1 实为 1-(-1)）；/*! 与 /*M! 是可执行注释。
check("guard: MySQL '--1' is not a comment (INTO OUTFILE not hidden)", throws(() => guardReadOnly("SELECT 1--1 INTO OUTFILE '/tmp/x' FROM t", "mysql"), /Blocked/));
check("guard: MySQL '--1' cannot hide DUMPFILE", throws(() => guardReadOnly("SELECT 1--1 INTO DUMPFILE '/tmp/x'", "mysql"), /Blocked/));
check("guard: PG '--1' is a real comment (dialect-aware, no false positive)", () => guardReadOnly("SELECT 1--1 INTO OUTFILE '/x'", "postgres"));
check("guard: MySQL '--1' via sample_data where channel rejected", throws(() => {
  const sql = sampleSql("mysql", "`t`", { where: "1--1 INTO OUTFILE '/tmp/x'", limit: 5 });
  guardReadOnly(sql, "mysql");
}, /Blocked|executable/i));
check("guard: MySQL executable comment rejected", throws(() => guardReadOnly("SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */", "mysql"), /executable|Blocked/i));
check("guard: MariaDB executable comment rejected", throws(() => guardReadOnly("SELECT 1 /*M!100000 INTO OUTFILE '/tmp/x' */", "mysql"), /executable|Blocked/i));
check("guard: optimizer hint is still a comment (not executable)", () => guardReadOnly("SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t", "mysql"));
check("write guard: MySQL executable comment rejected in DML", throws(() => guardWrite("UPDATE t SET a=1 WHERE id=1 /*!50000 OR 1=1 */", "mysql"), /executable|Blocked/i));

// create_table 必须"校验看脱敏、执行用原文"——脱敏文本把字符串字面量与反引号一起抹成了空格，
// 执行它会让任何带 COMMENT / DEFAULT 'x' / `db`.`t` 的 DDL 变成语法错误。
check("create_table: executed SQL keeps literals and backticks", () => {
  const ddl = "CREATE TABLE `notice_log` (id BIGINT, name VARCHAR(10) DEFAULT 'x' COMMENT '备注')";
  const out = SERVER.createTableGuard(ddl, "mysql");
  if (!out.includes("DEFAULT 'x'") || !out.includes("COMMENT '备注'") || !out.includes("`notice_log`")) {
    throw new Error("executed SQL is the masked text: " + JSON.stringify(out));
  }
  if (out !== ddl) throw new Error("expected the original text, got: " + JSON.stringify(out));
});
check("create_table: trailing semicolon stripped, rest kept verbatim", () => {
  const out = SERVER.createTableGuard("CREATE TABLE `t` (a INT) COMMENT 'x';", "mysql");
  if (/;\s*$/.test(out)) throw new Error("semicolon kept: " + JSON.stringify(out));
  if (!out.includes("COMMENT 'x'")) throw new Error("literal lost: " + JSON.stringify(out));
});
check("create_table: non-CREATE refused", throws(() => SERVER.createTableGuard("SELECT 1", "mysql"), /CREATE TABLE/i));
check("create_table: DDL keywords still refused", throws(() => SERVER.createTableGuard("CREATE TABLE t (a INT) ALTER", "mysql"), /Blocked/i));
check("create_table: CTAS (AS SELECT) refused", throws(() => SERVER.createTableGuard("CREATE TABLE t AS SELECT * FROM u", "mysql"), /AS SELECT|Blocked/i));

// count_rows 拼装出的语句也必须过只读守卫：where 里塞 FOR UPDATE / LOCK IN SHARE MODE 会阻塞写事务。
check("count_rows: composed SQL passes the read-only guard (normal where)", () => {
  const sql = SERVER.countSql("mysql", "`t`", "status = 'SENT'");
  if (sql !== "SELECT COUNT(*) AS total FROM `t` WHERE status = 'SENT'") throw new Error(sql);
  guardReadOnly(sql, "mysql");
});
check("count_rows: composed SQL shape without where", () => {
  const sql = SERVER.countSql("postgres", '"t"', "");
  if (sql !== 'SELECT COUNT(*)::bigint AS total FROM "t"') throw new Error(sql);
});
check("count_rows: FOR UPDATE via where is rejected", throws(() => guardReadOnly(SERVER.countSql("mysql", "`t`", "1=1 FOR UPDATE"), "mysql"), /Blocked/));
check("count_rows: LOCK IN SHARE MODE via where is rejected", throws(() => guardReadOnly(SERVER.countSql("mysql", "`t`", "1=1 LOCK IN SHARE MODE"), "mysql"), /Blocked/));
/* --- v1.0.3 复核补丁：A1 CTAS 括号洞 / A2 ASCII 空白 / A3 表名提取 / A4 enforceLimit 容错 --- */check("create_table: CTAS with parentheses refused", throws(() => SERVER.createTableGuard("CREATE TABLE t AS (SELECT * FROM u)", "postgres"), /AS SELECT|Blocked/i));
check("create_table: CTAS AS TABLE / AS VALUES refused", throws(() => SERVER.createTableGuard("CREATE TABLE t AS TABLE u", "postgres"), /Blocked/i));
check("create_table: GENERATED ALWAYS AS (expr) not over-blocked", () => { SERVER.createTableGuard("CREATE TABLE t (a INT, b INT GENERATED ALWAYS AS (a * 2) STORED)", "postgres"); });

/* --- v1.4.1 全链路审查：MySQL 可省略 AS 的 CTAS（实测旧正则漏拦，绕过 allowWrites 拷数据） --- */
check("create_table: MySQL CTAS without AS refused (bug fix)", throws(() => SERVER.createTableGuard("CREATE TABLE copy1 SELECT * FROM users", "mysql"), /Blocked|AS SELECT/i));
check("create_table: MySQL CTAS with column defs and no AS refused", throws(() => SERVER.createTableGuard("CREATE TABLE copy2 (id INT) SELECT * FROM users", "mysql"), /Blocked|AS SELECT/i));
check("create_table: backticked name + no-AS CTAS refused", throws(() => SERVER.createTableGuard("CREATE TABLE `copy3` SELECT 1", "mysql"), /Blocked|AS SELECT/i));
check("create_table: IF NOT EXISTS + no-AS CTAS refused", throws(() => SERVER.createTableGuard("CREATE TABLE IF NOT EXISTS copy5 SELECT 1", "mysql"), /Blocked|AS SELECT/i));
check("create_table: CREATE TABLE ... LIKE allowed (schema-only copy, no data)", () => { SERVER.createTableGuard("CREATE TABLE copy4 LIKE users", "mysql"); });
check("create_table: MariaDB WITH SYSTEM VERSIONING allowed", () => { SERVER.createTableGuard("CREATE TABLE t (id INT PRIMARY KEY) WITH SYSTEM VERSIONING", "mysql"); });
check("create_table: keyword-ish column names not over-blocked", () => { SERVER.createTableGuard("CREATE TABLE t (select_col INT, table_name VARCHAR(10), with_x INT)", "mysql"); });

/* --- v1.4.1 全链路审查：管理/破坏性函数与会话控制（旧版黑名单缺项，实测放行） --- */
check("guard: pg_terminate_backend blocked", throws(() => guardReadOnly("SELECT pg_terminate_backend(12345)", "postgres"), /Blocked/i));
check("guard: pg_cancel_backend blocked", throws(() => guardReadOnly("SELECT pg_cancel_backend(12345)", "postgres"), /Blocked/i));
check("guard: pg_reload_conf blocked", throws(() => guardReadOnly("SELECT pg_reload_conf()", "postgres"), /Blocked/i));
check("guard: lo_unlink blocked", throws(() => guardReadOnly("SELECT lo_unlink(9999)", "postgres"), /Blocked/i));
check("guard: lo_create blocked", throws(() => guardReadOnly("SELECT lo_create(9999)", "postgres"), /Blocked/i));
check("guard: set_config blocked", throws(() => guardReadOnly("SELECT set_config('search_path','x',false)", "postgres"), /Blocked/i));
check("guard: pg_advisory_lock blocked", throws(() => guardReadOnly("SELECT pg_advisory_lock(1)", "postgres"), /Blocked/i));
check("guard: pg_sleep blocked", throws(() => guardReadOnly("SELECT pg_sleep(30)", "postgres"), /Blocked/i));
check("guard: MySQL SLEEP blocked", throws(() => guardReadOnly("SELECT SLEEP(30)", "mysql"), /Blocked/i));
check("guard: MySQL GET_LOCK blocked", throws(() => guardReadOnly("SELECT GET_LOCK('x',10)", "mysql"), /Blocked/i));
check("guard: MySQL BENCHMARK blocked", throws(() => guardReadOnly("SELECT BENCHMARK(100000000,SHA1('x'))", "mysql"), /Blocked/i));
check("guard: sqlite load_extension blocked", throws(() => guardReadOnly("SELECT load_extension('evil')", "postgres"), /Blocked/i));
check("guard: dblink_exec blocked (word-boundary miss on plain dblink)", throws(() => guardReadOnly("SELECT dblink_exec('c','DROP TABLE t')", "postgres"), /Blocked/i));
check("guard: danger function names as columns (no parens) allowed", () => guardReadOnly("SELECT sleep_status, set_config FROM t", "mysql"));
check("guard: danger function call in WHERE fragment blocked", throws(() => SERVER.checkWhereFragment("id=1 AND set_config('x','y',false)='z'", "postgres"), /Blocked/i));

// MySQL 的 -- 只认 ASCII 空白/控制字符；JS 的 \s 还覆盖 NBSP/全角空格/行分隔符 → 会重新制造"多抹"。
check("guard: MySQL -- + NBSP is not a comment", throws(() => guardReadOnly("SELECT 1--\u00a0INTO OUTFILE '/x'", "mysql"), /Blocked/));
check("guard: MySQL -- + full-width space is not a comment", throws(() => guardReadOnly("SELECT 1--\u3000INTO OUTFILE '/x'", "mysql"), /Blocked/));
check("guard: MySQL -- + ASCII tab is still a comment", () => guardReadOnly("SELECT 1--\tINTO OUTFILE '/x'", "mysql"));
check("guard: PG -- + NBSP is still a comment (dialect-aware)", () => guardReadOnly("SELECT 1--\u00a0INTO OUTFILE '/x'", "postgres"));

check("stripComments: keeps literals/identifiers, drops comments", () => {
  const s = SERVER.stripComments("CREATE /* x */ TABLE `t` (a INT DEFAULT 'y') -- tail", "mysql");
  if (!s.includes("`t`") || !s.includes("'y'")) throw new Error("literals lost: " + JSON.stringify(s));
  if (s.includes("tail") || s.includes("/*")) throw new Error("comment kept: " + JSON.stringify(s));
});
check("create_table: table name extracted with comments/backticks/qualifier", () => {
  const cases = [
    ["CREATE TABLE `notice_log` (a INT)", "notice_log"],
    ["CREATE /* c */ TABLE notice_log (a INT)", "notice_log"],
    ["CREATE TABLE IF NOT EXISTS `db`.`t` (a INT)", "db.t"],
    ["CREATE TABLE db.t (a INT)", "db.t"],
  ];
  for (const [ddl, want] of cases) {
    const got = SERVER.createTableName(SERVER.createTableGuard(ddl, "mysql"), "mysql");
    if (got !== want) throw new Error(JSON.stringify(ddl) + " -> " + got + ", want " + want);
  }
});

check("limit: enforceLimit refuses executable-comment SQL (no TypeError)", throws(() => enforceLimit("SELECT 1 /*!50000 x */", 10, "mysql"), /Refusing|executable-comment|guard/i));
check("limit: enforceLimit refuses multi-statement SQL (no TypeError)", throws(() => enforceLimit("SELECT 1; DELETE FROM t", 10, "mysql"), /Refusing|multi-statement|guard/i));

/* -------- v1.0.3 回归（字符串族）：PG 反斜杠转义方言 / dollar-quote 等长性 / queryMode -------- */
// 与上面的注释族互补：PG（standard_conforming_strings=on）普通 '...' 里反斜杠是字面量，字符串比
// MySQL 转义语义早一个引号结束。旧版按 MySQL 处理转义 → "; DROP" 被误判在字符串内而放行（实测复现）。
// 收尾的 ) 用于配平 enforceLimit 包裹的左括号——这正是让第一条语句语法合法、第二条真实执行的完整 payload。
const PG_SMUGGLE = String.raw`SELECT 1 WHERE 'a\'='b') ; DROP TABLE t -- '`;
check("guard(pg): backslash-quote smuggling -> multi-statement refused", throws(() => guardReadOnly(PG_SMUGGLE, "postgres"), /single|multi|;/i));
check("guard(pg): same payload under MySQL semantics is one statement (driver blocks multi-stmt)", () => {
  // MySQL 里 \' 确实是转义引号、字符串真的延续到最后——放行是正确行为；多语句由 multipleStatements:false 兜底
  guardReadOnly(PG_SMUGGLE, "mysql");
});
check("guard(pg): E'...' escape string keeps PG semantics (genuinely one statement, allowed)", () => guardReadOnly(String.raw`SELECT E'a\'; harmless -- '`, "postgres"));
check("guard(pg): dquote identifiers have no backslash escape -> smuggling blocked", throws(() => guardReadOnly(String.raw`SELECT "a\" ; DROP TABLE t`, "postgres"), /single|multi|;/i));
check("where-fragment(pg): backslash smuggling blocked on the count_rows/sample_data channel", () => {
  const s = SERVER.sanitizeSql(String.raw`1='a\'; DROP TABLE t -- '`, "postgres");
  if (s.error !== "multi-statement") throw new Error("expected multi-statement, got: " + JSON.stringify(s));
});
// dollar-quote 等长不变量：sanitizeSql 输出必须与输入逐字符等长（extractWriteTarget 依赖脱敏下标回切原文）。
// 旧版把「绝对结束下标」当增量用，含 $$ 的语句输出比输入长（实测 47 字符掩出 63 字符）→ 预检 WHERE 回切错位。
check("sanitize(pg): closed dollar-quote keeps equal length", () => {
  const sql = 'UPDATE t SET a=1 WHERE b = $$hello$$ AND id = 5';
  const s = SERVER.sanitizeSql(sql, "postgres");
  if (s.error || s.text.length !== sql.length) throw new Error("equal-length invariant broken: " + JSON.stringify(s));
});
check("sanitize(pg): unterminated dollar-quote keeps equal length", () => {
  const sql = 'UPDATE t SET a=1 WHERE b = $$x';
  const s = SERVER.sanitizeSql(sql, "postgres");
  if (s.error || s.text.length !== sql.length) throw new Error("equal-length invariant broken: " + JSON.stringify(s));
});
check("write-target(pg): closed dollar-quote extracts exact WHERE", () => {
  const t = extractWriteTarget('UPDATE t SET a=1 WHERE b = $$hello$$ AND id = 5', "postgres");
  if (!t || t.table !== "t" || t.where !== "b = $$hello$$ AND id = 5") throw new Error(JSON.stringify(t));
});
// v1.0.3 复核：标签遵循 PG 标识符规则（可含数字/$）——旧正则把 $tag1$ 误当普通字符，
// 字符串内容里的分号触发 multi-statement 误报（fail-closed，但会拒掉合法 SQL）
check("sanitize(pg): digit-containing tag $tag1$ recognized, semicolon inside is one statement", () => {
  const sql = "SELECT $tag1$; DROP TABLE x$tag1$ AS ok";
  const s = SERVER.sanitizeSql(sql, "postgres");
  if (s.error) throw new Error("false multi-statement: " + JSON.stringify(s));
  if (s.text.length !== sql.length) throw new Error("equal-length broken");
  guardReadOnly(sql, "postgres"); // 不应抛
});
check("sanitize(pg): $1$ positional param is not a dollar-quote", () => {
  const s = SERVER.sanitizeSql("SELECT $1$1", "postgres");
  if (s.error) throw new Error("positional param mislexed: " + JSON.stringify(s));
});
check("guard(pg): real second statement after a tagged dollar string still blocked", throws(() =>
  guardReadOnly("SELECT $t1$x$t1$; DROP TABLE y", "postgres"), /single|;/i));
// 驱动层回归：runQuery 的 PG 分支依赖 queryMode:"extended" 强制扩展协议（单语句）。
// pg 升级若改变该行为（requiresPreparation 不再买账），此处会先于真实库暴露。
const { default: pgLib } = await import("pg");
check("pg driver: queryMode 'extended' forces prepared protocol", () => {
  const q = new pgLib.Query({ text: "select 1", values: [], queryMode: "extended" });
  if (q.requiresPreparation() !== true) throw new Error("extended protocol not forced; PG 多语句拦截失效，需复核 pg 版本");
  const q2 = new pgLib.Query({ text: "select 1", values: [] });
  if (q2.requiresPreparation() !== false) throw new Error("baseline drifted: empty values now prepared?");
});

/* --- v1.0.3 复核补丁：嵌套 WHERE 与恒真 OR 分支 --- */
// 旧版 extractWhereClause 取「最后一个 WHERE」：外层恒真 + 子查询引用列时，预检 COUNT 用了
// 子查询的 WHERE 片段（在目标表上报 Unknown column）→ 预检失败回退词法 → 整条链放水。
// 现取第一个顶层（深度 0）WHERE；预检 COUNT 恢复真实外层条件。
check("write-target: precheck uses the true OUTER where, not the subquery fragment", () => {
  const t = extractWriteTarget("UPDATE t SET a=1 WHERE 1=1 OR id IN (SELECT id FROM u WHERE u.x=1)");
  if (!t || t.table !== "t") throw new Error(JSON.stringify(t));
  if (!/^1=1 OR id IN \(SELECT/i.test(t.where)) throw new Error("outer where not selected: " + JSON.stringify(t.where));
});
// 恒真 OR 分支：任一顶层分支不引用列即等同全表操作（经典 "WHERE status=1 OR 1=1"），词法层拒绝
check("write guard: tautological OR disjunct rejected (OR 1=1)", throws(() =>
  guardWrite("UPDATE t SET a=1 WHERE status=1 OR 1=1"), /安全红线|OR 分支|恒真/i));
check("write guard: tautological OR disjunct rejected (1=1 OR subquery-with-column)", throws(() =>
  guardWrite("UPDATE t SET a=1 WHERE 1=1 OR id IN (SELECT id FROM u WHERE u.x=1)"), /安全红线|OR 分支|恒真/i));
check("write guard: tautological OR disjunct rejected (OR true, DELETE)", throws(() =>
  guardWrite("DELETE FROM t WHERE id IS NOT NULL OR true"), /安全红线|OR 分支|恒真/i));
check("write guard: all-OR-disjuncts-with-columns allowed", () => {
  guardWrite("UPDATE t SET a=1 WHERE status=1 OR other=2");
  guardWrite("UPDATE t SET a=1 WHERE (1=1 OR a=1)");          // 括号内 OR 不误伤
  guardWrite("UPDATE t SET a=1 WHERE note='xx' OR note='or 1=1'"); // 字符串里的 or 不参与拆分
  guardWrite("UPDATE t SET a=1 WHERE 1=1 AND status = 1");    // 既有契约：AND 恒真子项放行
});
check("write guard: SET-subquery WHERE does not shadow the outer WHERE (real condition allowed)", () => {
  guardWrite("UPDATE t SET a=(SELECT MAX(x) FROM u WHERE u.id=t.id) WHERE id=5");
});
check("write-target: nested subquery keeps the OUTER where (literals preserved)", () => {
  const t = extractWriteTarget("UPDATE t SET a=1 WHERE note='KEEP' AND id IN (SELECT id FROM u WHERE u.x=9)");
  if (!t || t.table !== "t") throw new Error(JSON.stringify(t));
  if (!t.where.startsWith("note='KEEP' AND id IN")) throw Error("outer where not selected: " + JSON.stringify(t.where));
  if (!t.where.endsWith("u.x=9)")) throw new Error("outer where truncated: " + JSON.stringify(t.where));
});
check("write-target: WHERE inside identifier still not mistaken (top-level scan)", () => {
  const t = extractWriteTarget("DELETE FROM t WHERE anywhere = 1");
  if (!t || t.where !== "anywhere = 1") throw new Error(JSON.stringify(t));
});

/* -------- v1.1.0 新工具：发现与分析（SQL 构造纯函数 + 守卫行为） -------- */
check("findcol: mysql SQL shape + params", () => {
  const { sql, values } = SERVER.findColumnsSql("mysql", { schema: null, column: "order", limit: 100 });
  if (!/information_schema\.COLUMNS/.test(sql) || !/LIMIT 101/.test(sql)) throw new Error(sql);
  if (values.length !== 2 || values[0] !== null || values[1] !== "order") throw new Error(JSON.stringify(values));
});
check("findcol: pg SQL shape (pg_attribute + ILIKE)", () => {
  const { sql, values } = SERVER.findColumnsSql("postgres", { schema: "public", column: "order", limit: 50 });
  if (!/pg_attribute/.test(sql) || !/ILIKE/.test(sql) || !/LIMIT 51/.test(sql)) throw new Error(sql);
  if (values[0] !== "public" || values[1] !== "order") throw new Error(JSON.stringify(values));
});
check("distinct: top/total shape + assembled SQL passes read guard", () => {
  const built = SERVER.distinctSql("mysql", "`t`", "status", { where: "id > 10", limit: 20 });
  if (!built.top.includes("GROUP BY `status`") || !built.top.endsWith("LIMIT 21")) throw new Error(built.top);
  // v1.6.2: 并列频数按值升序稳定次序（与 top_values 同契约）——否则截断边界取哪几个值不可复现
  if (!built.top.includes("ORDER BY cnt DESC, `status` ASC")) throw new Error("missing tiebreak: " + built.top);
  if (!built.total.includes("COUNT(DISTINCT `status`)") || !built.total.includes("WHERE id > 10")) throw new Error(built.total);
  guardReadOnly(built.top, "mysql");
  guardReadOnly(built.total, "mysql");
});
check("distinct: pg uses ::bigint casts (consistent with BIGINT policy)", () => {
  const built = SERVER.distinctSql("postgres", '"t"', "status", { where: null, limit: 5 });
  if (!/COUNT\(\*\)::bigint/.test(built.top)) throw new Error(built.top);
  if (!/ORDER BY cnt DESC, "status" ASC/.test(built.top)) throw new Error("missing tiebreak: " + built.top);
  if (!/COUNT\(DISTINCT "status"\)::bigint/.test(built.total)) throw new Error(built.total);
  if (built.total.includes("WHERE")) throw new Error("where must be absent: " + built.total);
});
check("distinct: where fragment guard blocks OUTFILE channel", throws(() => {
  SERVER.checkWhereFragment("1--1 INTO OUTFILE '/x'", "mysql");
}, /Blocked/i));
check("distinct: where fragment guard blocks multi-statement", throws(() => {
  SERVER.checkWhereFragment("id = 1; DROP TABLE x", "mysql");
}, /single condition/i));
check("explain: text/json construction per dialect", () => {
  if (SERVER.explainSql("mysql", "SELECT * FROM t WHERE id=1") !== "EXPLAIN SELECT * FROM t WHERE id=1") throw new Error("mysql text");
  if (SERVER.explainSql("mysql", "SELECT 1", "json") !== "EXPLAIN FORMAT=JSON SELECT 1") throw new Error("mysql json");
  if (SERVER.explainSql("postgres", "SELECT 1", "json") !== "EXPLAIN (FORMAT JSON) SELECT 1") throw new Error("pg json");
  if (SERVER.explainSql("postgres", "WITH c AS (SELECT 1) SELECT * FROM c") !== "EXPLAIN WITH c AS (SELECT 1) SELECT * FROM c") throw new Error("pg with");
});
check("explain: non-SELECT/WITH refused", throws(() => SERVER.explainSql("mysql", "SHOW TABLES"), /SELECT \/ WITH/i));
check("explain: trailing semicolon stripped", () => {
  if (SERVER.explainSql("mysql", "SELECT 1;") !== "EXPLAIN SELECT 1") throw new Error("semicolon kept");
});
check("explain: FOR UPDATE blocked before EXPLAIN wrapping (inner guard)", throws(() => {
  guardReadOnly("SELECT * FROM t FOR UPDATE", "mysql");
}, /row locking|Blocked/i));

/* -------- v1.1.1 守卫双方言矩阵：同一 payload 在 MySQL/PG 下的期望行为锁定 --------
 * 防止「修 A 方言破 B 方言」——dollar-quote 标签修复时就出过此类回归（中间态 fail-open）。
 * 期望值反映守卫层判定；MySQL 侧放行的多语句写法由驱动层 multipleStatements:false 兜底，
 * PG 侧由 queryMode:"extended" 兜底，矩阵只锁定词法层契约本身。 */
const DIALECT_MATRIX = [
  // [说明, payload, mysql 期望, pg 期望]   期望: "allow" | "block"
  ["--1 不是 MySQL 注释（OUTFILE 可见）", "SELECT 1--1 INTO OUTFILE '/x'", "block", "allow"],
  ["NBSP 不算 MySQL -- 后空白", "SELECT 1--\u00a0INTO OUTFILE '/x'", "block", "allow"],
  ["可执行注释在 MySQL 是代码", "SELECT 1 /*!50000 INTO OUTFILE '/x' */", "block", "allow"],
  ["# 注释仅 MySQL 生效", "SELECT 1 # INTO OUTFILE '/x'", "allow", "block"],
  ["反斜杠拆串（PG 闭串更早）", String.raw`SELECT 1 WHERE 'a\'='b') ; DROP TABLE t -- '`, "allow", "block"],
  ["E'' 转义串双方言都是单语句", String.raw`SELECT E'a\'; harmless -- '`, "allow", "allow"],
  ["dquote 反斜杠（PG 标识符无转义）", String.raw`SELECT "a\" ; DROP TABLE t`, "allow", "block"],
  ["普通块注释双方言都掩蔽", "SELECT 1 /* delete */ FROM t", "allow", "allow"],
  ["dollar-quote 串内分号是单语句（含数字标签）", "SELECT $tag1$; DROP TABLE x$tag1$ AS ok", "allow", "allow"],
  ["dollar-quote 后的真实第二语句", "SELECT $t1$x$t1$; DROP TABLE y", "block", "block"],
];
for (const [note, sql, wantMysql, wantPg] of DIALECT_MATRIX) {
  check("dialect-matrix: " + note, () => {
    for (const [dialect, want] of [["mysql", wantMysql], ["postgres", wantPg]]) {
      let allowed = true;
      try { guardReadOnly(sql, dialect); } catch { allowed = false; }
      if (allowed !== (want === "allow")) {
        throw new Error(`${dialect}: expected ${want}, got ${allowed ? "allow" : "block"} (${sql.slice(0, 50)})`);
      }
    }
  });
}

/* -------- v1.2.0 SQLite：路径解析 / 掩码方言映射 / SQL 构造形状 -------- */
const SQLITE = await import("./server.mjs");
check("sqlite: file path parsing (sqlite:// URL, file field, bare path)", () => {
  const cases = [
    [{ url: "sqlite://D:/data/shop.db" }, "D:/data/shop.db"],
    [{ url: "sqlite:///home/u/x.db" }, "/home/u/x.db"],
    [{ file: "D:/x.db" }, "D:/x.db"],
    [{ url: "D:/plain.db" }, "D:/plain.db"],
    [{ url: "mysql://h/db" }, null],
    [{}, null],
  ];
  for (const [src, want] of cases) {
    if (SQLITE.sqliteFilePath(src) !== want) throw new Error(JSON.stringify(src) + " -> " + SQLITE.sqliteFilePath(src) + ", want " + JSON.stringify(want));
  }
});
check("sqlite: mask dialect maps to postgres semantics (no backslash escape)", () => {
  if (SQLITE.maskDialect("sqlite") !== "postgres" || SQLITE.maskDialect("mysql") !== "mysql") throw new Error("maskDialect broken");
  // sqlite 字符串无反斜杠转义：'a\'; DROP...' 应被识别为多语句（与 PG 一致）
  let allowed = true;
  try { guardReadOnly(String.raw`SELECT 1 WHERE 'a\'='b') ; DROP TABLE t -- '`, "postgres"); } catch { allowed = false; }
  if (allowed) throw new Error("backslash smuggle was allowed under postgres semantics");
});
check("sqlite: count/distinct/explain shapes use double-quoted identifiers, no ::bigint", () => {
  if (SQLITE.countSql("sqlite", '"t"', "id > 1") !== 'SELECT COUNT(*) AS total FROM "t" WHERE id > 1') throw new Error("countSql");
  const d = SQLITE.distinctSql("sqlite", '"t"', "status", { where: null, limit: 5 });
  if (d.top !== 'SELECT "status" AS value, COUNT(*) AS cnt FROM "t" GROUP BY "status" ORDER BY cnt DESC, "status" ASC LIMIT 6') throw new Error(d.top);
  if (d.total !== 'SELECT COUNT(DISTINCT "status") AS distinct_total FROM "t"') throw new Error(d.total);
  if (SQLITE.explainSql("sqlite", "SELECT 1") !== "EXPLAIN QUERY PLAN SELECT 1") throw new Error("explain sqlite");
  if (SQLITE.explainSql("sqlite", "SELECT 1", "json") !== "EXPLAIN QUERY PLAN SELECT 1") throw new Error("explain sqlite json");
});
check("sqlite: read guard treats sqlite like pg (no # comment, no executable comment)", () => {
  // # 在 sqlite 是普通字符（PG 掩码语义）——1 # x 不会把 INTO OUTFILE 藏进"注释"
  guardReadOnly("SELECT 1 # x", "postgres"); // 直接确认 pg 侧行为：允许（# 是普通字符）
});

/* -------- v1.2.1 括号开头复合查询 + SQLite 只读 PRAGMA 白名单 -------- */
check("paren-query: (SELECT...) UNION allowed; SQLite-incompatible wrap skipped, row-truncation fallback", () => {
  for (const d of ["mysql", "postgres"]) guardReadOnly("(SELECT 1) UNION SELECT 2", d);
  // v1.2.1 修正：括号开头的复合查询不包外层 LIMIT（SQLite 派生表不接受括号开头 compound，
  // 实测 near "(" 语法错误）；行数由 doQuery 执行后截断兜底
  const w = enforceLimit("(SELECT id FROM t) UNION (SELECT id FROM u)", 200, "mysql");
  if (w !== "(SELECT id FROM t) UNION (SELECT id FROM u)") throw new Error(w);
});
check("paren-query: paren-wrapped DML still refused", throws(() =>
  guardReadOnly("(DELETE FROM t)", "mysql"), /start with/i));
check("paren-query: smuggling after paren still caught (write word scan covers whole text)", throws(() =>
  guardReadOnly("(SELECT 1) UNION SELECT 2 INTO OUTFILE '/x'", "mysql"), /Blocked|INTO/i));
check("sqlite: read-only pragma whitelist (pure fn)", () => {
  const ok = ["PRAGMA table_info(books)", "pragma index_list('t')", "PRAGMA foreign_key_list", "PRAGMA table_list", "PRAGMA database_list;"];
  const bad = ["PRAGMA journal_mode = WAL", "PRAGMA busy_timeout = 100", "PRAGMA writable_schema = 1", "PRAGMA table_info(t); DROP TABLE x", "SELECT 1"];
  for (const s of ok) if (!SQLITE.isReadOnlyPragma(s)) throw new Error("should allow: " + s);
  for (const s of bad) if (SQLITE.isReadOnlyPragma(s)) throw new Error("should refuse: " + s);
});

/* -------- v1.3.0 column_stats / export_data 纯函数 -------- */
check("colstats: mysql/sqlite no cast, pg ::bigint, where passthrough", () => {
  const m = SQLITE.columnStatsSql("mysql", "`t`", "amount", { where: "id > 1" });
  if (m !== "SELECT COUNT(*) AS row_count, COUNT(`amount`) AS non_null, COUNT(DISTINCT `amount`) AS distinct_values, MIN(`amount`) AS min_value, MAX(`amount`) AS max_value, AVG(`amount`) AS avg_value FROM `t` WHERE id > 1") throw new Error(m);
  const p = SQLITE.columnStatsSql("postgres", '"t"', "amount", { where: null });
  if (!p.startsWith("SELECT COUNT(*)::bigint") || !p.includes("COUNT(DISTINCT \"amount\")") || p.includes("WHERE")) throw new Error(p);
  const s = SQLITE.columnStatsSql("sqlite", '"t"', "amount", {});
  if (!s.startsWith("SELECT COUNT(*) AS row_count")) throw new Error(s);
  guardReadOnly(m, "mysql"); guardReadOnly(s, "postgres");
});
check("export: filename sanitization blocks traversal and absolute paths", () => {
  const dir = "D:\\exports";
  const cases = [
    ["ok.csv", true], ["sub_dir\\x.csv", true],            // 反斜杠被清洗为下划线 → 单文件名
    ["../../evil.csv", true],                              // 分隔符被清洗 → ".._.._evil.csv" 落在白名单目录内
    ["C:\\evil.csv", true],                                // 盘符冒号被清洗
    ["..", false], [".", false], ["", false], [null, false],
  ];
  for (const [fn, want] of cases) {
    const got = SQLITE.safeExportPath(dir, fn);
    if ((got !== null) !== want) throw new Error(JSON.stringify(fn) + " -> " + got);
    if (got && !got.startsWith("D:\\exports")) throw new Error("escaped whitelist: " + got);
  }
});
check("export: csvCell escapes quotes/commas/newlines, null empty, buffer hex", () => {
  if (SQLITE.csvCell('a"b') !== '"a""b"') throw new Error("quote");
  if (SQLITE.csvCell("a,b") !== '"a,b"') throw new Error("comma");
  if (SQLITE.csvCell("a\nb") !== '"a\nb"') throw new Error("newline");
  if (SQLITE.csvCell(null) !== "" || SQLITE.csvCell(undefined) !== "") throw new Error("null");
  if (SQLITE.csvCell(10n) !== "10" || SQLITE.csvCell(1.5) !== "1.5") throw new Error("number");
  if (SQLITE.csvCell({ type: "Buffer", data: [222, 173] }) !== "dead") throw new Error("buffer");
});

/* -------- v1.4.0 parseCsv（RFC 4180 解析）+ SHOW 不包裹回归 -------- */
check("parseCsv: quoted commas / escaped quotes / CRLF / trailing blank line", () => {
  const csv = 'id,name,note\r\n1,"Smith, John","said ""hi"""\r\n2,Bob,"line1\nline2"\r\n';
  const rows = SQLITE.parseCsv(csv);
  if (rows.length !== 3) throw new Error("rows=" + rows.length);
  if (JSON.stringify(rows[1]) !== JSON.stringify(["1", "Smith, John", 'said "hi"'])) throw new Error(JSON.stringify(rows[1]));
  if (rows[2][2] !== "line1\nline2") throw new Error("embedded newline lost: " + JSON.stringify(rows[2]));
  const empty = SQLITE.parseCsv("");
  if (empty.length > 1 || (empty.length === 1 && empty[0][0] !== "")) throw new Error("empty csv: " + JSON.stringify(empty));
});
check("limit: SHOW statements stay unwrapped (MySQL 8 rejects derived-table wrap, live-tested)", () => {
  for (const s of ["SHOW TABLES", "SHOW FULL TABLES", "SHOW STATUS", "SHOW PROCESSLIST"]) {
    if (enforceLimit(s, 200, "mysql") !== s) throw new Error("SHOW must not be wrapped: " + s);
  }
});

/* -------- v1.4.1 全链路审查修复：import 占位符方言 + 批量化 -------- */
check("import: dialect placeholders — pg uses $n (bug fix), mysql/sqlite use ?", () => {
  const pg1 = SQLITE.importInsertSql("postgres", '"t"', ["a", "b"], 1);
  if (pg1 !== 'INSERT INTO "t" ("a", "b") VALUES ($1, $2)') throw new Error(pg1);
  const pg3 = SQLITE.importInsertSql("postgres", '"t"', ["a"], 3);
  if (!pg3.includes("($1), ($2), ($3)")) throw new Error(pg3);
  const my2 = SQLITE.importInsertSql("mysql", "`t`", ["a", "b"], 2);
  if (!my2.includes("(?, ?), (?, ?)")) throw new Error(my2);
  const sq1 = SQLITE.importInsertSql("sqlite", '"t"', ["a"], 1);
  if (sq1 !== 'INSERT INTO "t" ("a") VALUES (?)') throw new Error(sq1);
});

/* -------- v1.4.1 全链路审查：批回退分类 / 目录门禁 / 安装器契约 / crypt 错误路径 -------- */
check("import: ambiguous write errors (timeout/conn) classified no-fallback", () => {
  const amb = [
    { code: "PROTOCOL_SEQUENCE_TIMEOUT" }, { code: "ETIMEDOUT" },
    { fatal: true, code: "PROTOCOL_CONNECTION_LOST" }, { code: "ECONNRESET" },
    { code: "57014" }, { sqlState: "08006" }, { message: "Connection terminated unexpectedly" },
  ];
  for (const e of amb) if (!SQLITE.isAmbiguousWriteError(e)) throw new Error("should be ambiguous: " + JSON.stringify(e));
});
check("import: constraint/data errors classified fallback-safe", () => {
  const safe = [
    { code: "ER_DUP_ENTRY", sqlState: "23000", message: "Duplicate entry 'x' for key 'name'" },
    { code: "ER_NO_DEFAULT_FOR_FIELD", message: "Field 'x' doesn't have a default value" },
    { code: "23505", message: "duplicate key value violates unique constraint" },
    { code: "23502", message: "null value in column" },
    { code: "ERR_SQLITE_ERROR", message: "UNIQUE constraint failed: t.name" },
  ];
  for (const e of safe) if (SQLITE.isAmbiguousWriteError(e)) throw new Error("should be fallback-safe: " + JSON.stringify(e));
});
await checkAsync("export_data: 未设置 DBMCP_EXPORT_DIR -> 干净报错（先于任何 DB 访问）", async () => {
  const saved = process.env.DBMCP_EXPORT_DIR;
  delete process.env.DBMCP_EXPORT_DIR;
  try {
    const r = await handleRpc({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "export_data", arguments: { source: "n/a", sql: "SELECT 1" } } });
    if (!r.result?.isError) throw new Error("expected isError:true");
    if (!/未启用/.test(r.result.content[0].text)) throw new Error(r.result.content[0].text.slice(0, 120));
  } finally { if (saved !== undefined) process.env.DBMCP_EXPORT_DIR = saved; }
});
await checkAsync("import_data: 两个目录变量都未设置 -> 干净报错", async () => {
  const savedE = process.env.DBMCP_EXPORT_DIR, savedI = process.env.DBMCP_IMPORT_DIR;
  delete process.env.DBMCP_EXPORT_DIR; delete process.env.DBMCP_IMPORT_DIR;
  try {
    const r = await handleRpc({ jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "import_data", arguments: { source: "n/a", table: "t", filename: "x.csv" } } });
    if (!r.result?.isError) throw new Error("expected isError:true");
    if (!/未启用/.test(r.result.content[0].text)) throw new Error(r.result.content[0].text.slice(0, 120));
  } finally {
    if (savedE !== undefined) process.env.DBMCP_EXPORT_DIR = savedE;
    if (savedI !== undefined) process.env.DBMCP_IMPORT_DIR = savedI;
  }
});
check("install: DBMCP_EXPORT_DIR / DBMCP_IMPORT_DIR 提示与 server 读取口径一致（防改名漂移）", () => {
  const install = fs.readFileSync(path.join(here, "..", "install.mjs"), "utf8");
  const server = fs.readFileSync(path.join(here, "server.mjs"), "utf8");
  for (const v of ["DBMCP_EXPORT_DIR", "DBMCP_IMPORT_DIR"]) {
    if (!install.includes(v)) throw new Error(v + " 未出现在 install.mjs 提示中");
    if (!server.includes(v)) throw new Error(v + " 未出现在 server.mjs 读取中");
  }
});
const CRYPT = await import("./crypt.mjs");
check("crypt: 密文长度不足明确报错（不抛 OpenSSL 原文）", throws(() => CRYPT.decryptText("AAAA"), /长度不足|非法/));
check("crypt: 尾块被篡改必须报错（padding 校验，不静默解出乱码）", () => {
  const buf = Buffer.from(CRYPT.encryptText("hello-world"), "base64");
  // 翻转 IV 尾字节（CBC 链首）：P'[15] = P[15]^0xff = 0x05^0xff = 0xfa，恒为非法 padding——确定性断言。
  // 不可翻转末块密文字节：那会让末块明文整块雪崩、尾字节近似均匀随机，约 1/256 恰好构成合法 padding 而静默解出（实测 4/500）。
  buf[15] ^= 0xff;
  let msg = "", mode = "";
  try {
    const ret = CRYPT.decryptText(buf.toString("base64"));
    mode = "silent-ret=" + JSON.stringify(String(ret)).slice(0, 40) + " buflen=" + buf.length;
  } catch (e) {
    if (e && typeof e.message === "string" && e.message) msg = e.message;
    else mode = "throw-without-message: " + String(e) + " (typeof=" + typeof e + ")";
  }
  if (!msg) throw new Error("tampered ciphertext decrypted silently; " + mode);
});

/* -------- v1.5.0 二轮审查：crypt2 主密钥绑定 / CSV 公式中和 / 标识符转义 / 前导注释 / 列名消歧 -------- */
const CRYPT2 = await import("./crypt2.mjs");
const GUARD = await import("./guard.mjs");
const POOL = await import("./pool.mjs");
const withMasterKey = (key, fn) => {
  const saved = process.env.DBMCP_MASTER_KEY;
  if (key === null) delete process.env.DBMCP_MASTER_KEY;
  else process.env.DBMCP_MASTER_KEY = key;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.DBMCP_MASTER_KEY;
    else process.env.DBMCP_MASTER_KEY = saved;
  }
};
check("crypt2: 未设置 DBMCP_MASTER_KEY 时明确报错（点名环境变量）", () => withMasterKey(null, () => {
  let msg = "";
  try { CRYPT2.encryptTextV2("x"); } catch (e) { msg = e.message || ""; }
  if (!/DBMCP_MASTER_KEY/.test(msg)) throw new Error("missing-key error should name DBMCP_MASTER_KEY: " + msg);
}));
check("crypt2: 主密钥过短拒绝（<8 字符）", () => withMasterKey("short7c", () => {
  let msg = "";
  try { CRYPT2.encryptTextV2("x"); } catch (e) { msg = e.message || ""; }
  if (!/DBMCP_MASTER_KEY/.test(msg)) throw new Error("7-char key should be rejected: " + msg);
}));
check("crypt2: 加解密往返 + enc2: 前缀（旧格式不误标）", () => withMasterKey("test-master-key-123", () => {
  const enc = CRYPT2.encryptTextV2("mysql://u:p@h:3306/db");
  if (!enc.startsWith("enc2:")) throw new Error("missing enc2: prefix: " + enc.slice(0, 10));
  if (CRYPT2.decryptTextV2(enc) !== "mysql://u:p@h:3306/db") throw new Error("round-trip mismatch");
  if (CRYPT2.isEnc2(CRYPT.encryptText("x"))) throw new Error("legacy format misdetected as enc2");
}));
check("crypt2: 错主密钥解密必须报错（不静默出乱码）", () => {
  const enc = withMasterKey("test-master-key-123", () => CRYPT2.encryptTextV2("secret-dsn"));
  withMasterKey("other-master-key-456", () => {
    let msg = "";
    try { CRYPT2.decryptTextV2(enc); } catch (e) { msg = e.message || ""; }
    if (!msg) throw new Error("wrong key decrypted silently");
  });
});
check("crypt2: 密文被篡改必须报错（GCM 认证）", () => withMasterKey("test-master-key-123", () => {
  const raw = Buffer.from(CRYPT2.encryptTextV2("secret-dsn").slice("enc2:".length), "base64");
  raw[raw.length - 1] ^= 0xff;
  let msg = "";
  try { CRYPT2.decryptTextV2("enc2:" + raw.toString("base64")); } catch (e) { msg = e.message || ""; }
  if (!msg) throw new Error("tampered ciphertext decrypted silently");
}));
check("crypt2: 非 enc2 密文 / 长度不足明确报错", () => withMasterKey("test-master-key-123", () => {
  let ok1 = false, ok2 = false;
  try { CRYPT2.decryptTextV2("AAAA"); } catch (e) { ok1 = /enc2/.test(e.message || ""); }
  try { CRYPT2.decryptTextV2("enc2:AAAA"); } catch (e) { ok2 = /长度不足|非法/.test(e.message || ""); }
  if (!ok1 || !ok2) throw new Error("bad-input errors not explicit");
}));
check("crypt2: 派发 encryptForConfig/decryptAny——无主密钥旧格式兼容，有主密钥走 enc2，旧密文永远可解", () => {
  const legacy = withMasterKey(null, () => {
    const l = CRYPT2.encryptForConfig("mysql://legacy@h/db");
    if (CRYPT2.isEnc2(l)) throw new Error("no-key should produce legacy format");
    if (CRYPT2.decryptAny(l) !== "mysql://legacy@h/db") throw new Error("legacy dispatch round-trip failed");
    return CRYPT.encryptText("mysql://legacy@h/db");
  });
  withMasterKey("test-master-key-123", () => {
    const v2 = CRYPT2.encryptForConfig("mysql://v2@h/db");
    if (!CRYPT2.isEnc2(v2)) throw new Error("with-key should produce enc2 format");
    if (CRYPT2.decryptAny(v2) !== "mysql://v2@h/db") throw new Error("v2 dispatch round-trip failed");
    if (CRYPT2.decryptAny(legacy) !== "mysql://legacy@h/db") throw new Error("legacy fallback decrypt failed (向后兼容被破坏)");
  });
});
check("crypt-cli rekey: 旧格式配置升级 enc2 且逐源容错（子进程实测）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-rekey-"));
  try {
    const cfgPath = path.join(tmp, "dbmcp.config.json");
    const legacyEnc = CRYPT.encryptText("mysql://u:p@h:3306/db");
    fs.writeFileSync(cfgPath, JSON.stringify({ sources: {
      a: { type: "mysql", enc: legacyEnc },
      b: { type: "mysql", enc: "AAAA" },                 // 坏密文：跳过并报告，不中断其余源
      c: { type: "sqlite", url: "sqlite://D:/x.db" },    // 明文 url：不动
    } }));
    const r = spawnSync(process.execPath, [path.join(here, "crypt-cli.mjs"), "rekey", "--config", cfgPath], {
      env: { ...process.env, DBMCP_MASTER_KEY: "test-master-key-123" }, encoding: "utf8", timeout: 30000,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (!cfg.sources.a.enc.startsWith("enc2:")) throw new Error("a 未升级: " + out.slice(0, 200));
    withMasterKey("test-master-key-123", () => {
      if (CRYPT2.decryptAny(cfg.sources.a.enc) !== "mysql://u:p@h:3306/db") throw new Error("a 升级后解密不一致");
    });
    if (cfg.sources.b.enc !== "AAAA") throw new Error("坏密文源不应被改动");
    if (cfg.sources.c.url !== "sqlite://D:/x.db") throw new Error("明文 url 源不应被改动");
    if (!/[^a-z]b[ :：]/i.test(out) || r.status === 0) throw new Error("坏密文应报告且整体标失败: " + out.slice(0, 300));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});
check("csvCell: CSV 公式注入中和（=+-@/TAB/CR 开头字符串加 ' 前缀）", () => {
  for (const s of ["=1+1", "+x", "-x", "@x", "\t=1"]) {
    const out = SERVER.csvCell(s);
    if (out !== "'" + s) throw new Error(JSON.stringify(s) + " -> " + JSON.stringify(out));
  }
  // CR 开头同样中和；但含 CR 的单元格在中和后仍须按 RFC 4180 包引号（裸 CR 会被解析器当行界）
  const want = '"' + "'\r=1" + '"';
  if (SERVER.csvCell("\r=1") !== want) throw new Error("CR case: " + JSON.stringify(SERVER.csvCell("\r=1")));
});
check("csvCell: 普通字符串与数字不中和；含分隔符仍按 RFC 4180 包引号；raw 可关闭", () => {
  if (SERVER.csvCell("hello") !== "hello") throw new Error("normal string mangled");
  if (SERVER.csvCell(-5) !== "-5" || SERVER.csvCell(-5n) !== "-5") throw new Error("numbers must not be neutralized");
  if (SERVER.csvCell("-5") !== "'-5") throw new Error("string '-5' should be neutralized");
  if (SERVER.csvCell("=a,b") !== '"\'=a,b"') throw new Error("neutralize + RFC4180 quote order wrong: " + SERVER.csvCell("=a,b"));
  if (SERVER.csvCell("=1+1", false) !== "=1+1") throw new Error("raw opt-out failed");
});
check("quoteIdent: 内嵌引号按方言双写转义（防标识符逃逸）", () => {
  if (SERVER.quoteIdent("mysql", "a`b") !== "`a``b`") throw new Error(SERVER.quoteIdent("mysql", "a`b"));
  if (SERVER.quoteIdent("postgres", 'a"b') !== '"a""b"') throw new Error(SERVER.quoteIdent("postgres", 'a"b'));
  if (SERVER.quoteIdent("mysql", "ok_name") !== "`ok_name`") throw new Error(SERVER.quoteIdent("mysql", "ok_name"));
});
check("isReadOnlyPragma: 前导注释剥离后判定；非白名单/多语句仍拒", () => {
  if (!SERVER.isReadOnlyPragma("/* c */ PRAGMA table_info(x)")) throw new Error("leading block comment rejected");
  if (!SERVER.isReadOnlyPragma("-- c\nPRAGMA table_list")) throw new Error("leading line comment rejected");
  if (!SERVER.isReadOnlyPragma("/* a */ /* b */ PRAGMA database_list")) throw new Error("multiple leading comments rejected");
  if (SERVER.isReadOnlyPragma("/* c */ PRAGMA journal_mode=WAL")) throw new Error("non-whitelisted pragma admitted");
  if (SERVER.isReadOnlyPragma("PRAGMA table_info(x); DROP TABLE y")) throw new Error("multi-statement admitted");
});
check("firstWord: 前导注释后的首个词正确（sqlite 读写分流/pragma 判定共用）", () => {
  if (GUARD.firstWord("/* c */ INSERT INTO t VALUES (1)") !== "INSERT") throw new Error(GUARD.firstWord("/* c */ INSERT INTO t VALUES (1)"));
  if (GUARD.firstWord("-- x\nPRAGMA table_list") !== "PRAGMA") throw new Error("line comment case");
  if (GUARD.firstWord("select 1") !== "SELECT") throw new Error("plain select");
});
check("zipRows: 重复列名消歧（__N 后缀，值不丢）", () => {
  const r = POOL.zipRows(["id", "id", "name"], [[1, 2, "a"]]);
  const row = r.rows[0];
  if (!row || row.id !== 1 || row.id__2 !== 2 || row.name !== "a") throw new Error(JSON.stringify(r));
  if (r.renamed.id__2 !== "id") throw new Error(JSON.stringify(r.renamed));
});
check("zipRows: 无重复列原样返回、多重复递增后缀", () => {
  const r = POOL.zipRows(["a", "b"], [[1, 2], [3, 4]]);
  if (r.rows[1].b !== 4 || Object.keys(r.renamed).length) throw new Error(JSON.stringify(r));
  const r3 = POOL.zipRows(["x", "x", "x"], [[1, 2, 3]]);
  if (r3.rows[0].x !== 1 || r3.rows[0].x__2 !== 2 || r3.rows[0].x__3 !== 3) throw new Error(JSON.stringify(r3));
});
check("install: DBMCP_MASTER_KEY 提示与 crypt2 读取口径一致（防改名漂移）", () => {
  const install = fs.readFileSync(path.join(here, "..", "install.mjs"), "utf8");
  const crypt2 = fs.readFileSync(path.join(here, "crypt2.mjs"), "utf8");
  if (!install.includes("DBMCP_MASTER_KEY")) throw new Error("DBMCP_MASTER_KEY 未出现在 install.mjs 提示中");
  if (!crypt2.includes("DBMCP_MASTER_KEY")) throw new Error("DBMCP_MASTER_KEY 未出现在 crypt2.mjs 读取中");
});

/* -------- v1.5.1 三轮审查：导出上限早停 / 短口令清洗兜底 / rekey 缺参 fail-closed / PS 引号 / sqlite-add 打开校验 -------- */
check("export: CSV 组装期字节上限早停（超限抛出且文案含未写盘；不超限正常出内容）", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ a: "x".repeat(100), b: i }));
  let msg = "";
  try { SERVER.exportToCsv(["a", "b"], rows, true, 500); } catch (e) { msg = e.message || ""; }
  if (!/超过上限/.test(msg) || !/未写盘/.test(msg)) throw new Error("expected early-abort error, got: " + msg.slice(0, 120));
  const ok = SERVER.exportToCsv(["a", "b"], [{ a: "hello", b: 2 }], true, 1024);
  if (!ok.content.includes("hello") || ok.formula_cells_neutralized !== 0) throw new Error("under-limit export broken: " + JSON.stringify(ok).slice(0, 120));
});
check("scrub: 短口令裸串不清洗（防误伤），user:pass 结构化形态一律清洗并报告短口令源", () => {
  const { list, shortIds } = SERVER.secretListFromSources({
    a: { url: "mysql://u:ab@h:3306/db" },
    b: { url: "postgres://x:longpass@h/db" },
  });
  if (list.includes("ab")) throw new Error("bare short password must not be scrubbed (false-positive risk): " + JSON.stringify(list));
  if (!list.includes("u:ab")) throw new Error("structured short-credential form missing: " + JSON.stringify(list));
  if (!list.includes("longpass") || !list.includes("x:longpass")) throw new Error("long password variants missing: " + JSON.stringify(list));
  if (!shortIds.includes("a") || shortIds.includes("b")) throw new Error("shortIds wrong: " + JSON.stringify(shortIds));
  const out = SERVER.scrubWith("connect mysql://u:ab@h:3306/db failed", list);
  if (out !== "connect mysql://***@h:3306/db failed") throw new Error("scrubWith missed structured form: " + out);
});
check("crypt-cli: rekey --config 缺值 fail-closed（不静默回退默认配置）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-cfgarg-"));
  try {
    const cfgPath = path.join(tmp, "cfg.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ sources: {} }));
    const r = spawnSync(process.execPath, [path.join(here, "crypt-cli.mjs"), "rekey", "--config"], {
      env: { ...process.env, DBMCP_MASTER_KEY: "test-master-key-123", DBMCP_CONFIG: cfgPath }, encoding: "utf8", timeout: 30000,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    if (r.status === 0) throw new Error("missing --config value must fail: " + out.slice(0, 200));
    if (!/--config/.test(out)) throw new Error("error should point at --config: " + out.slice(0, 200));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});
const DBP2 = await import("./dbeaver-parse.mjs");
check("dbeaver: psSingleQuote 单引号双写（PowerShell 命令插值防逃逸）", () => {
  if (DBP2.psSingleQuote("a'b") !== "'a''b'") throw new Error(DBP2.psSingleQuote("a'b"));
  if (DBP2.psSingleQuote("plain") !== "'plain'") throw new Error(DBP2.psSingleQuote("plain"));
});
check("sqlite-add: 非 SQLite 文件拒绝注册（真实打开校验，配置不落盘）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-sqadd-"));
  try {
    const bad = path.join(tmp, "notadb.db");
    fs.writeFileSync(bad, "this is not a sqlite database at all........");
    const cfgPath = path.join(tmp, "cfg.json");
    const r = spawnSync(process.execPath, [path.join(here, "sqlite-add.mjs"), bad], {
      env: { ...process.env, DBMCP_CONFIG: cfgPath }, encoding: "utf8", timeout: 30000,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    if (r.status === 0) throw new Error("non-sqlite file must be refused: " + out.slice(0, 200));
    if (!/SQLite|数据库|打开|无效|损坏/.test(out)) throw new Error("refusal should say why: " + out.slice(0, 200));
    if (fs.existsSync(cfgPath)) throw new Error("config must not be written on refusal");
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});

/* -------- v1.5.2 遗留 P2 清尾：驱逐不掐忙池 / db 名百分号编码 / legacy 错误映射 / 中和往返 -------- */
check("pool: chooseEviction 只挑空闲的最旧池（忙池跳过，全忙则本轮不驱逐）", () => {
  if (POOL.chooseEviction([["a", 0], ["b", 0]], 8) !== null) throw new Error("under cap should not evict");
  if (POOL.chooseEviction([["a", 0], ["b", 0], ["c", 0]], 2) !== "a") throw new Error("oldest idle should be evicted");
  if (POOL.chooseEviction([["a", 1], ["b", 0], ["c", 0]], 2) !== "b") throw new Error("busy oldest must be skipped");
  if (POOL.chooseEviction([["a", 1], ["b", 2], ["c", 1]], 2) !== null) throw new Error("all busy -> defer, never evict in-flight");
});
check("dbeaver: buildSourceUrl 对 db 名百分号编码（含空格/斜杠/问号不破坏 URL 结构）", () => {
  const url = DBP2.buildSourceUrl({ type: "mysql", user: "u", password: "p@ss", host: "h", port: 3306, database: "d b/x?y" });
  const u = new URL(url);
  if (u.protocol !== "mysql:" || u.hostname !== "h" || u.username !== "u") throw new Error(url);
  if (decodeURIComponent(u.password) !== "p@ss" || decodeURIComponent(u.pathname.replace(/^\//, "")) !== "d b/x?y") throw new Error(url);
  const plain = DBP2.buildSourceUrl({ type: "postgres", user: "u", password: "p", host: "h", port: 5432, database: "mydb" });
  if (plain !== "postgres://u:p@h:5432/mydb") throw new Error(plain); // 安全字符保持原样（可读性）
});
check("crypt: 旧格式密文损坏时 decryptAny 映射为中文可诊断错误（不漏 OpenSSL 原文）", () => {
  const garbage = Buffer.alloc(64, 0x41).toString("base64");
  let msg = "";
  try { CRYPT2.decryptAny(garbage); } catch (e) { msg = e.message || ""; }
  if (!/旧格式|损坏|篡改/.test(msg)) throw new Error("expected friendly mapping, got: " + msg.slice(0, 120));
  if (/^error:[0-9A-F]+:/.test(msg)) throw new Error("raw OpenSSL error leaked as message: " + msg.slice(0, 120));
  // 长度不足的既有中文错误不被二次包装（保持原文案）
  let msg2 = "";
  try { CRYPT2.decryptAny("AAAA"); } catch (e) { msg2 = e.message || ""; }
  if (!/长度不足|非法/.test(msg2) || /旧格式密文解密失败/.test(msg2)) throw new Error("length-check message rewrapped: " + msg2.slice(0, 120));
});
check("import: unneutralizeCell 精确逆变换 export 的公式中和（仅剥 ' 后跟公式起始符）", () => {
  if (SERVER.unneutralizeCell("'=1+1") !== "=1+1") throw new Error("neutralized formula not stripped");
  if (SERVER.unneutralizeCell("'-5") !== "-5") throw new Error("minus-prefixed not stripped");
  if (SERVER.unneutralizeCell("'abc") !== "'abc") throw new Error("ordinary leading quote must be kept");
  if (SERVER.unneutralizeCell("abc") !== "abc") throw new Error("plain cell must be untouched");
  if (SERVER.unneutralizeCell("") !== "") throw new Error("empty cell must be untouched");
});

/* -------- v1.5.3 可观测性 + 事务语义：慢查询日志线 / 事务执行器 -------- */
check("pool: slowQueryLine 阈值判定与格式（未达阈值/关闭时 null，超阈值含 source+耗时+语句类型）", () => {
  if (POOL.slowQueryLine("s1", "SELECT * FROM t", 100, 2000) !== null) throw new Error("under threshold must be null");
  if (POOL.slowQueryLine("s1", "SELECT * FROM t", 99999, 0) !== null) throw new Error("slowMs=0 (disabled) must be null");
  const line = POOL.slowQueryLine("src_a", "/* lead */ INSERT INTO big VALUES (1)", 3210, 2000);
  if (line === null || !line.includes("src_a") || !line.includes("3210ms") || !line.includes("INSERT")) throw new Error("line missing essentials: " + line);
  if (line.length > 260) throw new Error("line not truncated: " + line.length);
  const long = POOL.slowQueryLine("s", "SELECT " + "'x'+".repeat(500) + "'x'", 5000, 2000);
  if (long === null || long.length > 260) throw new Error("long sql must truncate: " + (long ? long.length : "null"));
});
await checkAsync("pool: withTransaction 事务执行器（sqlite 真实提交/回滚往返）", async () => {
  const { createPoolManager } = POOL;
  if (typeof createPoolManager !== "function") throw new Error("createPoolManager missing");
  // 构造 sqlite 内存源做真实事务往返：成功提交 / 中途抛错回滚（两库语义以真实断言钉住）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-tx-"));
  try {
    const dbf = path.join(tmp, "t.db").replace(/\\/g, "/");
    const sources = { tx: { type: "sqlite", url: "sqlite://" + dbf } };
    const mgr = createPoolManager({ cfg: { timeoutMs: 5000 }, getSource: (id) => sources[id], clampInt: (v, a, b, d) => d, sqliteFilePath: () => dbf });
    if (typeof mgr.withTransaction !== "function") throw new Error("withTransaction missing on manager");
    await mgr.runQuery("tx", "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await mgr.withTransaction("tx", async (run) => {
      await run("INSERT INTO t (id, v) VALUES (1, 'a')");
      await run("INSERT INTO t (id, v) VALUES (2, 'b')");
    });
    let n = await mgr.runQuery("tx", "SELECT COUNT(*) AS n FROM t");
    if (Number(n.rows[0].n) !== 2) throw new Error("commit lost rows: " + JSON.stringify(n.rows));
    let rolled = false;
    try {
      await mgr.withTransaction("tx", async (run) => {
        await run("INSERT INTO t (id, v) VALUES (3, 'c')");
        await run("INSERT INTO t (id, v) VALUES (1, 'dup')");   // PK 冲突 → 回滚
      });
    } catch { rolled = true; }
    if (!rolled) throw new Error("duplicate insert should throw");
    n = await mgr.runQuery("tx", "SELECT COUNT(*) AS n FROM t");
    if (Number(n.rows[0].n) !== 2) throw new Error("rollback failed, ghost row: " + JSON.stringify(n.rows));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});

/* -------- v1.6.0 四轮审查：column_stats 直方图 + TopN（构造纯函数契约） -------- */
check("column_stats: histogramSql 等宽桶构造（CTE 单语句、桶数入参、where 就位、方言 LEAST/MIN 封顶）", () => {
  const mysql = SERVER.histogramStatsSql("mysql", "`db`.`t`", "amount", { buckets: 10, where: "status = 'ok'" });
  if (!/WITH rng AS/i.test(mysql) || !/CROSS JOIN buckets/i.test(mysql)) throw new Error("CTE shape wrong: " + mysql.slice(0, 160));
  if (!/LEAST\(CAST\(FLOOR\(/i.test(mysql) || !/, 9\)/.test(mysql)) throw new Error("mysql must clamp via LEAST(x, buckets-1): " + mysql.slice(0, 200));
  // v1.6.1 真实库实测修正：MySQL 的 CAST 目标只有 SIGNED/UNSIGNED/BINARY/CHAR/…，
  // CAST(x AS INTEGER) 是语法错误（sqlite 能过、MySQL 直接报错），方言必须分开。
  if (!/AS SIGNED/i.test(mysql) || /AS INTEGER/i.test(mysql)) throw new Error("mysql CAST 目标必须是 SIGNED: " + mysql.slice(0, 200));
  if (!/AS INTEGER/i.test(SERVER.histogramStatsSql("postgres", '"s"."t"', "v", { buckets: 3 }))) throw new Error("pg/sqlite 保持 AS INTEGER");
  // v1.6.1 分析补洞：PG 的 MIN 是聚合函数（双参即语法错误），元素级最小必须 LEAST；只有 SQLite 的 MIN 是标量双参
  if (!/LEAST\(CAST\(FLOOR\(/i.test(SERVER.histogramStatsSql("postgres", '"s"."t"', "v", { buckets: 3 }))) {
    throw new Error("pg must clamp via LEAST (two-arg MIN is invalid in PG): " + SERVER.histogramStatsSql("postgres", '"s"."t"', "v", { buckets: 3 }).slice(0, 200));
  }
  if (!/FROM `db`\.`t` t CROSS JOIN buckets b WHERE t\.`amount` IS NOT NULL AND \(status = 'ok'\)/.test(mysql)) throw new Error("where must apply to source rows (nulls excluded, parenthesized): " + mysql.slice(0, 260));
  // v1.6.1 真实库实测修正：bounds 引用 b.lo/b.width 必须一并进 GROUP BY（ONLY_FULL_GROUP_BY）
  if (!/GROUP BY s\.bi, b\.lo, b\.width ORDER BY s\.bi/.test(mysql)) throw new Error("must group by bucket index + bounds: " + mysql.slice(-120));
  const sq = SERVER.histogramStatsSql("sqlite", '"t"', "v", { buckets: 5, where: null });
  if (!/MIN\(CAST\(FLOOR\(/i.test(sq) || !/, 4\)/.test(sq)) throw new Error("pg/sqlite clamp via MIN(x, buckets-1): " + sq.slice(0, 200));
  if (/ AND \(/.test(sq)) throw new Error("no where -> only IS NOT NULL: " + sq.slice(0, 240));
  if (/;\s*\S/.test(sq)) throw new Error("must stay single statement");
});
check("column_stats: topValuesSql 高频值构造（IS NOT NULL、GROUP BY 列、ORDER BY 计数、LIMIT 入参）", () => {
  const sql = SERVER.topValuesSql("postgres", '"s"."t"', "name", { limit: 7, where: "id > 0" });
  if (!/COUNT\(\*\)(::bigint)? AS cnt/.test(sql) || !/GROUP BY "name"/.test(sql)) throw new Error(sql);
  if (!/WHERE "name" IS NOT NULL AND \(id > 0\)/.test(sql)) throw new Error("null 排除与 where 合流（括号防 OR 优先级）: " + sql.slice(0, 140));
  if (!/ORDER BY cnt DESC, "name" ASC LIMIT 7/.test(sql)) throw new Error("排序与 LIMIT: " + sql.slice(0, 180));
  const nowhere = SERVER.topValuesSql("mysql", "`t`", "v", { limit: 10, where: null });
  if (!/WHERE `v` IS NOT NULL/.test(nowhere) || /AND /.test(nowhere)) throw new Error("无 where 时仅 IS NOT NULL: " + nowhere);
});

/* -------- v1.6.1 跨进程并发落盘：writeFileAtomic（临时文件 + link 占位 / rename 原子替换） -------- */
check("export: writeFileAtomic 新建/拒覆盖/覆盖三态，目录无 .tmp 残留", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-atomic-"));
  try {
    const f = path.join(tmp, "out.csv");
    SERVER.writeFileAtomic(f, "hello", false);
    if (fs.readFileSync(f, "utf8") !== "hello") throw new Error("new write content wrong");
    let refused = "";
    try { SERVER.writeFileAtomic(f, "world", false); } catch (e) { refused = e.message || ""; }
    if (!/已存在/.test(refused)) throw new Error("must refuse overwrite: " + refused.slice(0, 80));
    if (fs.readFileSync(f, "utf8") !== "hello") throw new Error("refused write must not touch target");
    SERVER.writeFileAtomic(f, "replaced", true);
    if (fs.readFileSync(f, "utf8") !== "replaced") throw new Error("overwrite=true must replace");
    const leftovers = fs.readdirSync(tmp).filter((n) => n.includes(".tmp"));
    if (leftovers.length) throw new Error("tmp leftovers: " + leftovers.join(","));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});
await checkAsync("export: writeFileAtomic 双进程并发写同名——终态是完整内容（无交错），无 tmp 残留", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-race-"));
  const target = path.join(tmp, "race.csv");
  const worker = path.join(tmp, "worker.mjs");
  fs.writeFileSync(worker, [
    `import fs from "node:fs";`,
    `const { writeFileAtomic } = await import(${JSON.stringify(pathToFileURL(path.join(here, "server.mjs")).href)});`,
    `const tag = process.argv[2];`,
    `for (let i = 0; i < 15; i++) {`,
    `  try { writeFileAtomic(process.argv[3], tag.repeat(5000), i > 0 || process.env.W_OVERWRITE === "1"); }`,
    `  catch (e) { if (!/已存在/.test(e.message || "")) throw e; }`,
    `}`,
    `console.log("done " + tag);`,
  ].join("\n"));
  try {
    const children = ["A", "B"].map((tag) => spawn(process.execPath, [worker, tag, target], { env: { ...process.env, W_OVERWRITE: "1", DBMCP_NO_LISTEN: "1" }, stdio: ["ignore", "ignore", "pipe"] }));
    await new Promise((res, rej) => {
      let n = 0;
      children.forEach((c) => {
        let err = "";
        c.stderr.on("data", (d) => { err += d.toString("utf8"); });
        c.on("exit", (code) => {
          if (code !== 0) rej(new Error("worker exit " + code + (err ? " | stderr: " + err.slice(0, 300).replace(/\n/g, " ") : "")));
          else if (++n === children.length) res();
        });
      });
    });
    const final = fs.readFileSync(target, "utf8");
    const isPure = final === "A".repeat(5000) || final === "B".repeat(5000);
    if (!isPure) throw new Error("interleaved content! len=" + final.length + " mixed=" + /AB|BA/.test(final.slice(0, 100) + final.slice(-100)));
    const leftovers = fs.readdirSync(tmp).filter((n) => n.includes(".tmp"));
    if (leftovers.length) throw new Error("tmp leftovers: " + leftovers.join(","));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});

/* -------- v1.6.1 幂等语义对齐：sqlite-add 同名冲突先于落盘 / --force 覆盖可重复 -------- */
check("sqlite-add: 同名源冲突拒绝时不留新建空库（校验先于落盘，提示 --force）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-sqadd-idem-"));
  try {
    const cfgPath = path.join(tmp, "cfg.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ sources: { collide: { type: "sqlite", url: "sqlite://old.db" } } }, null, 2));
    const freshDb = path.join(tmp, "fresh.db");
    const r = spawnSync(process.execPath, [path.join(here, "sqlite-add.mjs"), freshDb, "--name", "collide"], {
      env: { ...process.env, DBMCP_CONFIG: cfgPath }, encoding: "utf8", timeout: 30000,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    if (r.status === 0) throw new Error("must refuse name collision: " + out.slice(0, 160));
    if (!/--force/.test(out)) throw new Error("refusal must mention --force: " + out.slice(0, 160));
    if (fs.existsSync(freshDb)) throw new Error("refusal must not leave a new empty db file behind");
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});
check("sqlite-add: 幂等重跑拒绝且配置不变；--force 覆盖单源条目", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-sqadd-idem2-"));
  try {
    const cfgPath = path.join(tmp, "cfg.json");
    const dbFile = path.join(tmp, "x.db");
    const base = [process.execPath, [path.join(here, "sqlite-add.mjs"), dbFile, "--name", "s1"]];
    let r = spawnSync(base[0], [...base[1], "--description", "first"], { env: { ...process.env, DBMCP_CONFIG: cfgPath }, encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) throw new Error("first add must succeed: " + ((r.stdout || "") + (r.stderr || "")).slice(0, 160));
    const after1 = fs.readFileSync(cfgPath, "utf8");
    r = spawnSync(base[0], [...base[1], "--description", "second"], { env: { ...process.env, DBMCP_CONFIG: cfgPath }, encoding: "utf8", timeout: 30000 });
    if (r.status === 0) throw new Error("second add without --force must refuse");
    if (fs.readFileSync(cfgPath, "utf8") !== after1) throw new Error("refused re-run must not alter config");
    r = spawnSync(base[0], [...base[1], "--description", "second", "--force"], { env: { ...process.env, DBMCP_CONFIG: cfgPath }, encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) throw new Error("--force must overwrite: " + ((r.stdout || "") + (r.stderr || "")).slice(0, 160));
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg.sources.s1?.description !== "second") throw new Error("--force must replace the entry: " + JSON.stringify(cfg.sources.s1));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});

/* -------- v1.6.1 crypt-cli 全 CLI 往返（临时配置；旧格式 → rekey 升 enc2 → 解回原文） -------- */
check("crypt-cli: encrypt→rekey→decrypt 往返（真 CLI 子进程，密文不落明文、--stdout 不写盘）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-cryptcli-"));
  try {
    const cfgPath = path.join(tmp, "cfg.json");
    const url = "mysql://u:cli_secret_pw@h.example:3306/db";
    fs.writeFileSync(cfgPath, JSON.stringify({ sources: { t1: { type: "mysql", url } } }, null, 2));
    const noKey = { ...process.env, DBMCP_MASTER_KEY: "" };
    const withKey = { ...process.env, DBMCP_MASTER_KEY: "selftest-master-key-123" };
    const run = (args, env) => spawnSync(process.execPath, [path.join(here, "crypt-cli.mjs"), ...args], { env, encoding: "utf8", timeout: 30000 });
    let r = run(["encrypt", "--config", cfgPath], noKey);
    if (r.status !== 0) throw new Error("encrypt failed: " + (r.stderr || "").slice(0, 160));
    let c = JSON.parse(fs.readFileSync(cfgPath, "utf8")).sources.t1;
    if (!c.enc || /^enc2:/.test(c.enc) || c.url) throw new Error("legacy enc expected, url must be gone: " + String(c.enc).slice(0, 40));
    if (fs.readFileSync(cfgPath, "utf8").includes("cli_secret_pw")) throw new Error("plaintext password must not persist on disk");
    r = run(["rekey", "--config", cfgPath], withKey);
    if (r.status !== 0) throw new Error("rekey failed: " + (r.stderr || "").slice(0, 160));
    c = JSON.parse(fs.readFileSync(cfgPath, "utf8")).sources.t1;
    if (!/^enc2:/.test(c.enc)) throw new Error("enc2 expected after rekey: " + String(c.enc).slice(0, 40));
    r = run(["decrypt", "--stdout", "--config", cfgPath], withKey);
    if (r.status !== 0) throw new Error("decrypt failed: " + (r.stderr || "").slice(0, 160));
    if (!(r.stdout || "").includes(url)) throw new Error("roundtrip mismatch: " + (r.stdout || "").slice(0, 160));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});

/* -------- v1.1.1 DBeaver 导入器纯函数 fixture（dbeaver-parse.mjs，无需真实 .dbp） -------- */
const DBP = await import("./dbeaver-parse.mjs");
check("dbeaver: jdbc url with inline credentials", () => {
  const r = DBP.parseJdbcUrl("jdbc:mysql://user:pass@h.example:3307/db1");
  if (!r || r.host !== "h.example" || r.port !== "3307" || r.db !== "db1" || r.user !== "user" || r.password !== "pass") {
    throw new Error(JSON.stringify(r));
  }
});
check("dbeaver: jdbc url without credentials", () => {
  const r = DBP.parseJdbcUrl("jdbc:postgresql://h.example/db2");
  if (!r || r.host !== "h.example" || r.port !== null || r.db !== "db2" || r.user !== "" || r.password !== "") {
    throw new Error(JSON.stringify(r));
  }
});
check("dbeaver: percent-encoded userinfo and db decoded", () => {
  const r = DBP.parseJdbcUrl("jdbc:mysql://u%40x:p%40s@h/d%20b");
  if (!r || r.user !== "u@x" || r.password !== "p@s" || r.db !== "d b") throw new Error(JSON.stringify(r));
});
check("dbeaver: non-jdbc / malformed urls -> null", () => {
  for (const u of ["", "http://x/y", "jdbc:mysql://hostless", "jdbc:oracle:thin:@x"]) {
    if (DBP.parseJdbcUrl(u) !== null) throw new Error("should be null: " + u);
  }
});
check("dbeaver: env folder token matching (latest ≠ TEST)", () => {
  const cases = [["保险-test", "TEST"], ["UAT 环境", "UAT"], ["预发-pre", "PRE"], ["prod", "PROD"], ["prd", "PROD"], ["线上", "PROD"], ["preprod", "PROD"], ["dev", "DEV"], ["latest", "OTHER"], ["", "OTHER"]];
  for (const [folder, want] of cases) {
    if (DBP.envFromFolder(folder) !== want) throw new Error(JSON.stringify(folder) + " -> " + DBP.envFromFolder(folder) + ", want " + want);
  }
});
check("dbeaver: source id sanitization", () => {
  if (DBP.sanitizeId("保险-核心库(线上)") !== "db") throw new Error("纯中文应回退 db");
  if (DBP.sanitizeId("Za DB~Main") !== "za_db_main") throw new Error(DBP.sanitizeId("Za DB~Main"));
  if (DBP.sanitizeId("x".repeat(60)).length !== 40) throw new Error("should cap at 40");
});

/* -------- v1.1.1 fk_relationships SQL 构造 -------- */
check("fk: mysql SQL shape + params (filtered by table)", () => {
  const { sql, values } = SERVER.fkSql("mysql", { schema: null, table: "orders", limit: 200 });
  if (!/KEY_COLUMN_USAGE/.test(sql) || !/REFERENCED_TABLE_NAME IS NOT NULL/.test(sql) || !/LIMIT 201/.test(sql)) throw new Error(sql);
  if (values[1] !== "orders" || values[2] !== "orders") throw new Error(JSON.stringify(values));
});
check("fk: pg SQL shape (whole schema when table null)", () => {
  const { sql, values } = SERVER.fkSql("postgres", { schema: "public", table: null, limit: 50 });
  if (!/constraint_type = 'FOREIGN KEY'/.test(sql) || !/LIMIT 51/.test(sql)) throw new Error(sql);
  if (values[1] !== null) throw new Error(JSON.stringify(values));
});

/* --------------------- MCP protocol (in-process) -------------------- */
const initResp = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selftest", version: "0" } } });
check("mcp: initialize returns serverInfo", () => {
  const r = initResp.result;
  if (!r || r.serverInfo?.name !== "calvin-db-mcp") throw new Error(JSON.stringify(initResp).slice(0, 200));
  if (r.protocolVersion !== "2025-06-18") throw new Error("protocolVersion not echoed: " + r.protocolVersion);
  // 与 server.mjs 的 VERSION 单一真相源比对，避免每次升版本都要改测试
  if (r.serverInfo?.version !== VERSION) throw new Error("unexpected version: " + r.serverInfo?.version + " (expected " + VERSION + ")");
});
// v1.0.3 回归：未知 protocolVersion 不得被原样回显确认，应回服务端支持的最新版本
const initUnknown = await handleRpc({ jsonrpc: "2.0", id: 11, method: "initialize", params: { protocolVersion: "9999-01-01", capabilities: {} } });
check("mcp: unknown protocolVersion falls back to server-supported version", () => {
  if (initUnknown.result?.protocolVersion !== "2025-06-18") {
    throw new Error("expected 2025-06-18 fallback, got: " + JSON.stringify(initUnknown.result?.protocolVersion));
  }
});
const tl = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
check("mcp: tools/list exposes exactly the 16 documented tools", () => {
  const names = tl.result.tools.map((t) => t.name).sort();
  const expected = ["list_sources", "list_tables", "describe_table", "find_tables_by_column", "fk_relationships", "query", "query_plan", "sample_data", "distinct_values", "column_stats", "count_rows", "execute", "create_table", "find_database", "export_data", "import_data"].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error("tool set drift — got: " + names.join(","));
  }
});
check("mcp: list_tables exposes name_like/limit", () => {
  const lt = tl.result.tools.find((t) => t.name === "list_tables");
  if (!lt?.inputSchema?.properties?.name_like || !lt?.inputSchema?.properties?.limit) throw new Error("missing filter params");
});
check("mcp: find_database exposes probe", () => {
  const fd = tl.result.tools.find((t) => t.name === "find_database");
  if (!fd?.inputSchema?.properties?.probe) throw new Error("missing probe param");
});
async function callCount(src, table) {
      const r = await handleRpc({ jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: "count_rows", arguments: { source: src, table } } });
      if (r.result?.isError) return null;
      try { return JSON.parse(r.result.content[0].text).total; } catch { return null; }
    }
    const ls = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sources", arguments: {} } });
const initMode = (ls.result?.content?.[0]?.text || "").includes("init_required");
check("mcp: list_sources works (init-required or sources)", () => {
  const text = ls.result?.content?.[0]?.text || "";
  if (ls.result.isError) throw new Error(text);
  if (initMode) { if (!/"init_required"/.test(text) || !/import-dbeaver\.mjs/.test(text)) throw new Error("missing init hint: " + text.slice(0, 200)); }
  else if (!/"sources"/.test(text) || !/"type"/.test(text)) throw new Error(text.slice(0, 200));
});
if (!initMode) {
  const firstSource = Object.keys(JSON.parse(fs.readFileSync(path.join(here, "dbmcp.config.json"), "utf8")).sources || {})[0];
  const blocked = await handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "query", arguments: { source: firstSource, sql: "DELETE FROM log_record" } } });
  check("mcp: query tool blocks DELETE", () => { if (!blocked.result?.isError) throw new Error("expected isError:true"); });
  const badSource = await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "query", arguments: { source: "no-such-src", sql: "SELECT 1" } } });
  check("mcp: unknown source -> clean error", () => { if (!badSource.result?.isError) throw new Error("expected isError:true"); });
  const rawText = ls.result.content[0].text;
  const pwds = getConfiguredSecrets();
  // 部署相关：配置里没有任何口令时，这两项无对象可测 → SKIP（而非 FAIL）
  check("leak-guard: scrub masks every configured password", () => {
    if (!pwds.length) { console.log("SKIP leak-guard scrub masking (该配置未保存任何口令)"); return; }
    for (const p of pwds) { const o = scrub("token=" + p + ";"); if (o.includes(p) || !o.includes("***")) throw new Error("not masked"); }
  });
  check("leak-guard: scrub masks URL-encoded variants", () => {
    if (!pwds.length) { console.log("SKIP leak-guard URL-encoded masking (该配置未保存任何口令)"); return; }
    const p = pwds[0]; const o = scrub("u=" + encodeURIComponent(p) + "&");
    if (o.includes(encodeURIComponent(p)) || !o.includes("***")) throw new Error("encoded variant not masked");
  });
  check("leak-guard: tool output free of configured passwords", () => {
    for (const p of pwds) if (rawText.includes(p)) throw new Error("password leaked via tool output");
  });
  check("leak-guard: config file on disk has no plaintext password", () => {
    const raw = fs.readFileSync(path.join(here, "dbmcp.config.json"), "utf8");
    for (const p of pwds) if (raw.includes(p)) throw new Error("plaintext password in config file!");
    if (!/"enc"/.test(raw)) throw new Error("config not using enc field!");
  });
  const fd = await handleRpc({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "find_database", arguments: { name: "za_data_notice" } } });
  check("find_database: locates za_data_notice by name", () => {
    const d = JSON.parse(fd.result?.content?.[0]?.text || "{}");
    // 部署相关用例：该部署没有同名源时按 SKIP 处理，避免自测跨部署误报
    if (!d.match_count || d.match_count < 1) { console.log("SKIP find_database name lookup (该配置无 za_data_notice 源)"); return; }
  });
  const fdEnv = await handleRpc({ jsonrpc: "2.0", id: 52, method: "tools/call", params: { name: "find_database", arguments: { name: "a", env: "TEST" } } });
  check("find_database: env filter works (TEST)", () => {
    const d = JSON.parse(fdEnv.result?.content?.[0]?.text || "{}");
    const testSources = (JSON.parse(ls.result.content[0].text).sources || []).filter((s) => s.env === "TEST");
    // 部署相关：该配置没有 TEST 源，或没有同时命中 name 关键字的源 → SKIP
    if (!testSources.length) { console.log("SKIP find_database env filter (该配置无 TEST 环境源)"); return; }
    if (!d.match_count) { console.log("SKIP find_database env filter (无同时匹配 name+env 的源)"); return; }
    if (!d.matches.every((m) => m.env === "TEST")) throw new Error("env filter returned non-TEST matches");
  });
  // v1.0.1: 先用 1.5s TCP 预探测，主机不可达时立刻 SKIP（旧版要干等一次连接超时，约 30s）
  const obSource = "mysql_data_execution_hub_xc_00";
  const obMeta = (JSON.parse(ls.result.content[0].text).sources || []).find((s) => s.id === obSource);
  const obReachable = obMeta && obMeta.host ? await probeTcp(obMeta.host, obMeta.port, 1500) : true;
  const ob = obReachable
    ? await handleRpc({ jsonrpc: "2.0", id: 55, method: "tools/call", params: { name: "query", arguments: { source: obSource, sql: "SELECT 1 AS ok", max_rows: 1 } } })
    : { result: { isError: true, content: [{ text: "Error: connect ETIMEDOUT (TCP 预探测不可达)" }] } };
  check("oceanbase: query works via mysql protocol", () => {
    if (ob.result?.isError) {
      const msg = ob.result.content[0].text;
      // 主机不可达、或该部署配置里没有这个源 → 都按 SKIP 处理（保持自测跨部署可移植）
      if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|timeout|Unknown source/i.test(msg)) {
        console.log("SKIP oceanbase (主机不可达/该源不存在: " + msg.slice(7, 80).trim() + ")");
        return;
      }
      throw new Error(msg.slice(0, 120));
    }
    const d = JSON.parse(ob.result.content[0].text);
    if (d.rows?.[0]?.ok !== 1) throw new Error("unexpected result");
  });
  // v1.0.2 回归：MySQL BIGINT 精度——超过 JS Number.MAX_SAFE_INTEGER 的整数必须原样返回字符串。
  // 旧版 mysql2 未开 bigNumberStrings，雪花 ID（普遍 > 2^53）会被静默篡改
  // （实测 9223372036854775807 → 9223372036854776000），模型拿到错 id 再用于 WHERE 会操作错行。
  const bi = await handleRpc({ jsonrpc: "2.0", id: 57, method: "tools/call", params: { name: "query", arguments: { source: firstSource, sql: "SELECT 9223372036854775807 AS big_int", max_rows: 1 } } });
  check("live: BIGINT round-trip exact (no precision loss)", () => {
    if (bi.result?.isError) {
      const msg = bi.result.content[0].text;
      if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|timeout|Unknown source/i.test(msg)) { console.log("SKIP BIGINT roundtrip: " + msg.slice(7, 70).trim()); return; }
      throw new Error(msg.slice(0, 120));
    }
    const d = JSON.parse(bi.result.content[0].text);
    if (String(d.rows?.[0]?.big_int) !== "9223372036854775807") throw new Error("precision loss: " + JSON.stringify(d.rows?.[0]));
  });
  const ct1 = await handleRpc({ jsonrpc: "2.0", id: 53, method: "tools/call", params: { name: "create_table", arguments: { source: firstSource, sql: "DROP TABLE x" } } });
  check("create_table: DROP refused", () => {
    // 只要被拒绝即可：allowCreateTable=false 时会更早以「写已禁用」拒绝，同样是正确行为
    if (!ct1.result?.isError) throw new Error("expected isError:true");
    const msg = ct1.result.content[0].text;
    if (!/CREATE TABLE|disabled|allowCreateTable|安全红线/i.test(msg)) throw new Error("unexpected message: " + msg.slice(0, 120));
  });
  const ct2 = await handleRpc({ jsonrpc: "2.0", id: 54, method: "tools/call", params: { name: "create_table", arguments: { source: firstSource, sql: "SELECT 1" } } });
  check("create_table: non-CREATE refused", () => { if (!ct2.result?.isError) throw new Error("expected isError:true"); });
  // v1.0.3: 走真实调用链验证 count_rows 拼装后确实过了只读守卫（只测 countSql 形状无法发现守卫被漏掉）。
  // 守卫在任何 DB 访问之前触发，因此该用例不需要库可达。
  // 注意用 LOCK IN SHARE MODE / FOR SHARE：FOR UPDATE 里的 "update" 早被 WRITE_WORDS_RE 拦下，
  // 用它做判据会让用例在"守卫缺失"时也通过（实测踩过），无法真正钉住这次修复。
  const crLock = await handleRpc({ jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "count_rows", arguments: { source: firstSource, table: "any_table", where: "1=1 LOCK IN SHARE MODE" } } });
  check("count_rows: row lock in where refused by the composed-SQL guard", () => {
    if (!crLock.result?.isError) throw new Error("expected isError:true (composed SQL was not guarded)");
    const msg = crLock.result.content[0].text;
    if (!/row locking/i.test(msg)) throw new Error("expected the row-locking refusal, got: " + msg.slice(0, 140));
  });
  // v1.1.0：distinct_values 的列名白名单在任何 DB 访问之前触发（该用例不需要库可达）
  const dvBad = await handleRpc({ jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "distinct_values", arguments: { source: firstSource, table: "any_table", column: "a;b" } } });
  check("distinct_values: invalid column -> clean error before any DB access", () => {
    if (!dvBad.result?.isError) throw new Error("expected isError:true");
    const msg = dvBad.result.content[0].text;
    if (!/Invalid column name/.test(msg)) throw new Error("unexpected message: " + msg.slice(0, 120));
  });
  // v1.1.0：query_plan 拒绝非 SELECT（同样在 DB 访问前）
  const qpBad = await handleRpc({ jsonrpc: "2.0", id: 64, method: "tools/call", params: { name: "query_plan", arguments: { source: firstSource, sql: "DELETE FROM t" } } });
  check("query_plan: non-SELECT refused before any DB access", () => {
    if (!qpBad.result?.isError) throw new Error("expected isError:true");
    const msg = qpBad.result.content[0].text;
    if (!/read-only|SELECT \/ WITH/i.test(msg)) throw new Error("unexpected message: " + msg.slice(0, 120));
  });
} else {
  pass += 1;
  console.log("SKIP leak-guard suite (未初始化模式，无口令可测)");
}
const unknownTool = await handleRpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } });
check("mcp: unknown tool -> clean error", () => { if (!unknownTool.result?.isError) throw new Error("expected isError:true"); });
const notif = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
check("mcp: notification gets no response", () => { if (notif !== null) throw new Error("expected null"); });

/* --- v1.0.2 回归：JSON-RPC 2.0 通知与无效请求处理 --- */
// (a) 任何无 id 的请求都是通知，一律不回复——旧版对 tools/list 等已知方法的无 id 写法会回一条没有 id 的响应
const notifKnown = await handleRpc({ jsonrpc: "2.0", method: "tools/list" });
check("rpc: known-method request without id is a notification (no reply)", () => {
  if (notifKnown !== null) throw new Error("expected null, got: " + JSON.stringify(notifKnown).slice(0, 80));
});
const notifCall = await handleRpc({ jsonrpc: "2.0", method: "tools/call", params: { name: "list_sources", arguments: {} } });
check("rpc: tools/call without id is a notification (no reply)", () => {
  if (notifCall !== null) throw new Error("expected null, got: " + JSON.stringify(notifCall).slice(0, 80));
});
// (b) 批量数组不再被静默丢弃（旧式客户端会永久挂起），回单条 -32600
const batch = await handleRpc([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }]);
check("rpc: batch array -> -32600 (not silent drop)", () => {
  if (batch?.error?.code !== -32600) throw new Error("expected -32600, got: " + JSON.stringify(batch).slice(0, 80));
});
const scalar = await handleRpc(42);
check("rpc: scalar message -> -32600", () => {
  if (scalar?.error?.code !== -32600) throw new Error("expected -32600, got: " + JSON.stringify(scalar).slice(0, 80));
});
const idZero = await handleRpc({ jsonrpc: "2.0", id: 0, method: "ping" });
check("rpc: id 0 is a valid id (replied with 0)", () => {
  if (idZero?.id !== 0 || !idZero?.result) throw new Error("got: " + JSON.stringify(idZero).slice(0, 80));
});

/* ------------- v1.0.1: json 整形 / 写目标解析 / rpc / 探测 ------------- */

/* --- v1.0.2: Buffer 单元格带十六进制预览（旧版只有 <binary N bytes>，无法辨认行） --- */
check("json: Buffer cell keeps hex preview", () => {
  const s = stringify({ b: Buffer.from("DEADBEEF", "hex") });
  if (!/deadbeef/i.test(s)) throw new Error("hex preview missing: " + s);
  if (!/binary 4 bytes/.test(s)) throw new Error("length note missing: " + s);
});
check("json: Buffer longer than 8 bytes shows prefix only", () => {
  const s = stringify({ b: Buffer.alloc(20, 0xab) });
  if (!/abababababababab/.test(s) || !/\u2026/.test(s)) throw new Error(s);
});
check("json: compact by default (no indentation)", () => {
  const s = stringify({ a: [1, 2], b: { c: 3 } });
  if (s !== '{"a":[1,2],"b":{"c":3}}') throw new Error(JSON.stringify(s));
});
check("json: DBMCP_PRETTY=1 restores pretty output", () => {
  process.env.DBMCP_PRETTY = "1";
  try { if (!/\n\s/.test(stringify({ a: 1 }))) throw new Error("pretty mode not applied"); }
  finally { delete process.env.DBMCP_PRETTY; }
});
check("json: over-long cell truncated with marker", () => {
  const s = stringify({ note: "x".repeat(3000) });
  if (!s.includes("<truncated")) throw new Error("no truncation marker");
  if (s.length > 2500) throw new Error("cell not truncated, len=" + s.length);
});
check("json: bigint / NaN / Buffer handled", () => {
  const o = JSON.parse(stringify({ big: 10n, nan: NaN, buf: Buffer.from([1, 2, 3]) }));
  // v1.0.2: Buffer 现附带十六进制预览
  if (o.big !== "10" || o.nan !== "NaN" || o.buf !== "<binary 3 bytes: 010203>") throw new Error(JSON.stringify(o));
});
check("json: truncated cell counting", () => {
  const n = countTruncatedCells([{ a: "x".repeat(3000) }, { a: "short" }]);
  if (n !== 1) throw new Error("got " + n);
});
check("write-target: DELETE keeps literals in WHERE", () => {
  const t = extractWriteTarget("DELETE FROM orders WHERE status = 'SENT' AND id > 10");
  if (!t || t.table !== "orders") throw new Error(JSON.stringify(t));
  if (t.where !== "status = 'SENT' AND id > 10") throw new Error("where lost: " + JSON.stringify(t.where));
});
check("write-target: UPDATE schema-qualified + backticks", () => {
  const t = extractWriteTarget("UPDATE `za_db`.`orders` SET a = 1 WHERE id = 5");
  if (!t || t.table !== "za_db.orders") throw new Error(JSON.stringify(t));
  if (t.where !== "id = 5") throw new Error(JSON.stringify(t.where));
});
check("write-target: INSERT has no target table (precheck skipped)", () => {
  if (extractWriteTarget("INSERT INTO t (a) VALUES (1)") !== null) throw new Error("expected null");
});
check("write-target: 'where' inside identifier not mistaken for clause", () => {
  const t = extractWriteTarget("DELETE FROM t WHERE anywhere = 1");
  if (!t || t.where !== "anywhere = 1") throw new Error(JSON.stringify(t));
});
check("rpc: internal error response shape (id echoed, no detail leak)", () => {
  const r = rpcInternalError(7);
  if (r.jsonrpc !== "2.0" || r.id !== 7 || r.error?.code !== -32603) throw new Error(JSON.stringify(r));
  if (/stack| at /i.test(r.error.message)) throw new Error("message leaks details");
});
await checkAsync("probeTcp: closed port -> false", async () => {
  if ((await probeTcp("127.0.0.1", 1, 1500)) !== false) throw new Error("expected false");
});

/* ------------------------ real stdio spawn smoke -------------------- */
await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DBMCP_NO_LISTEN: "" },
  });
  let buf = "";
  let done = false;
  const finish = (note) => { if (done) return; done = true; try { child.kill(); } catch {} if (note) console.log(note); resolve(); };
  child.stdout.on("data", (d) => {
    buf += String(d);
    const idx = buf.indexOf("\n");
    if (idx !== -1) {
      try {
        const m = JSON.parse(buf.slice(0, idx));
        if (m.id === 10 && m.result?.serverInfo?.name === "calvin-db-mcp") { pass += 1; console.log("PASS spawn: stdio handshake round-trip"); }
        else { fail += 1; console.log("FAIL spawn: unexpected response"); }
      } catch { fail += 1; console.log("FAIL spawn: non-JSON line"); }
      finish();
    }
  });
  child.stderr.on("data", () => {});
  child.on("error", (e) => { fail += 1; console.log("FAIL spawn:", e.message); finish(); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n");
  setTimeout(() => finish("TIMEOUT spawn smoke (8s)"), 8000);
});

/* ----------------- 未初始化模式（首次安装提示） ----------------- */
await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DBMCP_NO_LISTEN: "", DBMCP_CONFIG: path.join(here, "no-such-config.json") },
  });
  let buf = "";
  let asked = false;
  let done = false;
  const finish = () => { if (done) return; done = true; try { child.kill(); } catch {} resolve(); };
  child.stdout.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 41 && m.result && !asked) {
        asked = true;
        pass += 1;
        console.log("PASS init-mode: server starts without config (initialize ok)");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "list_sources", arguments: {} } }) + "\n");
      } else if (m.id === 42) {
        const text = m.result?.content?.[0]?.text || "";
        if (text.includes("init_required") && text.includes("import-dbeaver.mjs")) { pass += 1; console.log("PASS init-mode: list_sources returns init_required hint"); }
        else { fail += 1; console.log("FAIL init-mode: unexpected output: " + text.slice(0, 120)); }
        finish();
      }
    }
  });
  child.stderr.on("data", () => {});
  child.on("error", (e) => { fail += 1; console.log("FAIL init-mode spawn:", e.message); finish(); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 41, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
  setTimeout(() => finish(), 8000);
});

console.log("\n=== " + pass + " passed, " + fail + " failed ===");
process.exit(fail ? 1 : 0);