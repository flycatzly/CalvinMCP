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
import * as OBSM from "./observe.mjs";

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
const { intArg, enumArg, VERSION, handleRpc, guardReadOnly, guardWrite, enforceLimit, scrub, scrubWith, scrubToBuffer, getConfiguredSecrets, stringify, stringifyReplacer, countTruncatedCells, extractWriteTarget, splitIdent, exprHasColumn, rpcInternalError, peekRpcId, probeTcp, sampleSql, classifyError, ToolError, trackRpc, finishRpc, beginDispatch, isCancelNotification, cancelRpc, stripLeadingInvis, csvCellDigitMask, normalizeCfg, computeChangedSources } = SERVER;
// v1.6.9 观测面打点（DBMCP_ERR_LOG）
const { fmtLogLine, logToolCall, setScrub, MAX_FIELD } = await import("./observe.mjs");

let pass = 0;
let fail = 0;
// v1.6.14: 断言数自证常量——与 3 处文档计数同源。新增/删除断言必须同步改这里与文档，
// 否则末尾自证检查 FAIL（防 298→301 那类静默口径漂移）。两口径实测 2026-10-05：
// 未初始化 325 / 已初始化 339（差 14 = init 块 15 钉 vs else 分支 +1；
// v1.6.20 +4 = import 批大小动态钉 ×2 + 直方图 LEAST-NULL/文本列锚定钉 ×2；
// v1.6.21 +2 = import COPY 分方言路由钉 + COPY 文本转义逐字节保真钉；
// v1.6.25 +6 = parseCsv 构建重写边界钉 + csvSegmenter 全偏移/随机多切分等价钉 ×2（并行工作线落的钉）
//             + .dbp 参数简写解析钉 ×2 + install/import 解析接线钉 ×1；
// v1.6.26 +3 = format 枚举校验钉（拒绝语义 E_PARAM/no-retry + 大小写归一与缺省 + 合法值恒等）；
// v1.6.27 +2 = scrubToBuffer 字节恒等差分钉（对抗矩阵+种子模糊）+ 孤立代理回落/退化键跳过语义钉。
// v1.6.28 +2 = exportToCsvBuffer 直出 Buffer 恒等差分钉（共用发射器差分+scrub 接线+早停边界+种子模糊）+ 孤立代理哨兵/scrubBuffer 直调语义钉。
// v1.6.29 +2 = createScrubPipeline 流式清洗切分不变性钉（任意切分/跨块/跨替换边界/短 key/flush）+ measureCsv/streamCsvLines 整链恒等钉（三链差分+早停零写盘+哨兵口径）。
// v1.6.30 +1 = createBatchWriter 集束写钉（批边界不变性+超大碎片零拷贝直写+flush 尾批+写调用收数）。
// v1.6.31 +1 = 零物化组装差分钉（融合计数/直写/scratch vs 行串真源逐字节恒等 + 逐格哨兵等价 + 早停边界 + 种子模糊）。
// v1.6.32 +2 = createCsvRowSink 行接收器钉（增量喂入 vs 整链逐字节恒等 + eager/惰性表头 + 哨兵旗/abort 中止 + E_LIMIT 零写盘 + 种子模糊）
//             + writeFileStreamAtomic 异步 writeFn 钉（thenable 延迟占位 + 失败清理 + EEXIST/overwrite 与同步面同语义）。
// v1.6.33 +1 = PG_FETCH_BATCH 单一真源钉（FETCH 语句/游标退出阈值共用常量，消字面量漂移→静默截断 bug 类）。
// v1.6.34 +7 = where 顶层子句关键字拒绝钉 + 括号子查询/标识符/字面量放行钉 + 注释尾巴 semiAt 钉
//             + stripStatementTail 形态钉 + 注释藏语句/可执行注释尾巴仍拒钉 + enforceLimit 注释尾巴包裹钉
//             + findcol 字面子串形状钉（LIKE 通配符→INSTR/strpos 字面量）。
// v1.6.35 +4 = sanitizeSql 嵌套缓存键钉（命中同对象/k-m 与方言槽不串/等长不变量）+ setSanitizeCache
//             绕过与溢出整清恒等钉 + sqlite 预编译句柄缓存钉 ×2（参数化重绑定/BigInt 保真/重名前置拒绝
//             在缓存路径 + 早停再全量流式/64 上限轮转/逃生阀语义等价）。
// v1.6.36 +3 = stringify 规范化 walk 差分钉（vs 冻结 stringifyReplacer 真源：对抗行集+边界载荷
//             ×响应/导出/pretty/导出pretty 四模式逐字节恒等 + 根级边界 + 抛出同责）
//             + stringify 手写期望钉（bigint 串化/截断后缀逐字/二进制预览 3B·9B/导出 hex/
//             装箱 NaN→null/链式 toJSON 只作用一次/toJSON 键非函数保留）
//             + scrubWith 预筛等价钉（零命中/命中/重叠键双序/元字符不误伤/空键/空表/非串输入
//             与旧循环逐字恒等 + 同表缓存命中不漂移）；ctc 语义边界内扩进「truncated cell
//             counting」钉（零计数漂移：阈值严格大于/同行多长串计 1/数组·嵌套·键名不计/非对象行）。
// v1.6.37 +4 = zipRows 常量键工厂差分钉（vs 冻结逐格循环真源：常规/重复消歧/空名/数字形名/
//             对抗名（引号/反斜杠/换行/U+2028/孤立代理项）/多类型值（BigInt/NaN/Inf/undefined）/
//             空结果/600 列逃生阀逐字节恒等 + 键序恒等）
//             + __proto__ 列名手写期望钉（自有属性+值存活/原型不被换/JSON 视图含值/
//             对象值不设原型/与消歧并存）
//             + 对抗列名+工厂缓存隔离钉（10 形态键值存活 + 交替列名集不串味）
//             + sqlite 数组行产品路径钉（setReturnArrays+zip 值类型口径/BigInt/BLOB/键序/
//             空结果带列名/缓存开关两分支同口径/重名前置拒绝不放宽）。
// v1.6.38 +1 = resultContent 双份序列化契约钉（wire 双重编码还原数据 + text 含转义内引号；
//             剖析定盘 pass2 为协议必需，单遍预转义 emitter 负优化 2× 回退后的防漂移钉）。
// v1.6.39 +1 = pg 命名预编译缓存正确性钉（字面量缓存命中两次查询恒等 + 坏 SQL 两次同错误且
//             无 "prepared statement does not exist" 毒化；v1.6.41 扩展为参数化 named 跨值复用可用）。
// v1.6.42 +1 = 数字口令上下文清洗钉（数字 token 保留/字符串字面量掩/pretty 空格回扫/
//             长数字片段防误伤/已知取舍显式钉/非数字键行为不漂移）。
// v1.6.43 +1 = csv 数字口令单元格级处置钉（全数字单元保真/文本内部掩/引号格内掩/
//             JSON-CSV 不对称显式钉/三链 digitKeys 恒等+手写期望整文件/无 digitKeys 零变化）。
// v1.6.53 +2 = offset 分页形状钉（sampleSql OFFSET 追加/零不追加字节不变/enforceLimit 外层
//             耦合锁定/负值直通）+ e2e 分页钉（init 仅：query offset 三页无重叠无遗漏 +
//             sample_data offset 页 + 不包裹语句 slice 层偏移）。
// v1.6.54 +3 = server_stats 纯函数钉（计数/错误/慢计数/ring 顺序与 cap32/scrub 注入/avg）
//             + e2e 钉（init 仅：计数接线/version/慢阈值默认）+ 部署态钉（双口径：未初始化
//             显式 init_required 提示 / 已初始化 version+形状）。
// v1.6.55 +2 = reload 纯函数钉（normalizeCfg 形态校验/clamp/init_required +
//             computeChangedSources 新增/删除/改file/enc轮换/零差异）+ reload_config e2e 钉
//             （init 仅：同内容零差异/增源生效+list_sources 反映/坏 JSON 回滚内存态+复位清 dummy）。
// v1.6.56 +1 = report 聚合钉（错误码分布含 UNKNOWN 兜底 + 慢查询按类型聚合/排序 +
//             非慢错误不入慢表 + 注释开头归 other；e2e 钉内扩 report 形状断言）。
const EXPECTED_TOTAL = { uninit: 361, init: 380 };
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
// v1.6.21+（adv26 内扩钉，零计数漂移）：一组形态同拦/同放断言折进既有 check 体——
// 引号标识符调用形态（`f`(x) / "f"(x) / U&"f"(x) / schema 限定 / 注释隔开）必须与裸名同拦，
// 引号列名引用（非调用形态）必须放行。每组多形态断言不新增 check()，EXPECTED_TOTAL 不动。
const blockAll = (cases, re = /Blocked/i) => () => {
  for (const [sql, dialect] of cases) {
    let msg = "";
    try { guardReadOnly(sql, dialect); } catch (e) { msg = e.message || ""; }
    if (!re.test(msg)) throw new Error("未拦截: " + JSON.stringify(sql) + " (" + (msg || "放行") + ")");
  }
};
const allowAll = (cases) => () => {
  for (const [sql, dialect] of cases) {
    try { guardReadOnly(sql, dialect); }
    catch (e) { throw new Error("误伤拦截: " + JSON.stringify(sql) + " - " + e.message); }
  }
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
check("guard: pg lo_export blocked", blockAll([
  ["SELECT lo_export(1, '/tmp/x') FROM t", "postgres"],
  ['SELECT "lo_export"(1, \'/tmp/x\')', "postgres"],
]));
check("guard: pg_read_file blocked (server-side file read)", blockAll([
  ["SELECT pg_read_file('/etc/passwd')", "postgres"],
  ['SELECT "pg_read_file"(\'/etc/passwd\')', "postgres"],
  ['SELECT U&"pg_read_file"(\'/etc/passwd\')', "postgres"],
  ['SELECT pg_catalog."pg_read_file"(\'/etc/passwd\')', "postgres"],
  ["SELECT load_file('/etc/passwd')", "mysql"],
  ["SELECT `load_file`('/etc/passwd')", "mysql"],
]));
check("guard: pg_ls_dir blocked", blockAll([
  ["SELECT pg_ls_dir('/') FROM t", "postgres"],
  ['SELECT "pg_ls_dir"(\'/\') FROM t', "postgres"],
]));
check("guard: dblink blocked (outbound channel)", blockAll([
  ["SELECT * FROM dblink('h','select 1') x", "postgres"],
  ['SELECT "dblink"(\'h\',\'select 1\')', "postgres"],
  ['SELECT "dblink_exec"(\'c\',\'select 1\')', "postgres"],
]));

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

check("cfg: reload 纯函数钉（v1.6.55）normalizeCfg 形态校验/clamp/init_required + computeChangedSources 差异面", () => {
  const eq = (got, want, label) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(label + "\n  got:  " + JSON.stringify(got) + "\n  want: " + JSON.stringify(want)); };
  // normalizeCfg：非法形态拒绝（ToolError）
  for (const bad of [null, 42, "x", [1, 2]]) {
    let threw = false;
    try { normalizeCfg(bad, "f"); } catch (e) { threw = e instanceof ToolError || /E_CONFIG/.test(String(e)); }
    if (!threw) throw new Error("非法 raw 未拒: " + JSON.stringify(bad));
  }
  let threw2 = false;
  try { normalizeCfg({ sources: [1] }, "f"); } catch (e) { threw2 = true; }
  if (!threw2) throw new Error("sources 数组形态未拒");
  // clamp + __initRequired
  const c1 = normalizeCfg({ maxRows: 99999, timeoutMs: 5, allowWrites: "yes", maxAffectedRows: -1, sources: { a: { type: "sqlite", file: "/x" } } }, "f");
  eq([c1.maxRows, c1.timeoutMs, c1.allowWrites, c1.maxAffectedRows, c1.__initRequired], [5000, 1000, false, 1, false], "clamp 面（maxAffectedRows=-1→1；500 仅 NaN 默认）");
  const c2 = normalizeCfg({}, "f");
  eq([c2.maxRows, c2.sources && Object.keys(c2.sources).length, c2.__initRequired], [200, 0, true], "默认面/空源=init_required");
  // computeChangedSources：新增/删除/改 url|file/未变
  const oldS = { keep: { type: "mysql", url: "mysql://u:p@h/db" }, gone: { type: "sqlite", file: "/a" }, chg: { type: "sqlite", file: "/old" } };
  const newS = { keep: { type: "mysql", url: "mysql://u:p@h/db" }, chg: { type: "sqlite", file: "/new" }, add: { type: "sqlite", file: "/b" } };
  const ch = computeChangedSources(oldS, newS).sort();
  eq(ch, ["add", "chg", "gone"], "差异面（新增/改file/删除；keep 不动）");
  eq(computeChangedSources(oldS, { ...oldS }), [], "同配置零差异");
  // enc 变化也算差异（同 url 不同密文=凭据轮换）
  eq(computeChangedSources({ s: { enc: "enc:v1:x" } }, { s: { enc: "enc:v2:y" } }), ["s"], "enc 轮换=变更");
});

check("obs: report 聚合钉（v1.6.56）错误码分布 + 慢查询按类型 + 排序 + UNKNOWN 兜底 + 非慢错误不入慢表", () => {
  const st = OBSM.createObsState(100);
  OBSM.obsRecord(st, "s1", 50, false, "SELECT ok", null);            // 非慢成功：哪儿都不进
  OBSM.obsRecord(st, "s1", 150, false, "SELECT slow a", null);       // 慢成功 → slow_by_type select
  OBSM.obsRecord(st, "s1", 30, true, "UPDATE t SET x=1", "E_DB");    // 非慢错误 → 仅 error_codes
  OBSM.obsRecord(st, "s1", 250, true, "DELETE FROM t", "E_PARAM");   // 慢错误 → 两侧都进
  OBSM.obsRecord(st, "s1", 300, false, "INSERT INTO t VALUES (1)", null);
  OBSM.obsRecord(st, "s2", 400, true, "SELECT x FROM y", null);      // 无码 → UNKNOWN
  const rep = OBSM.obsSnapshot(st, (t) => t).report;
  const ec = rep.error_codes;
  if (JSON.stringify(ec) !== JSON.stringify([{ code: "E_DB", count: 1 }, { code: "E_PARAM", count: 1 }, { code: "UNKNOWN", count: 1 }])) throw new Error("error_codes（同 count 按插入序）: " + JSON.stringify(ec));
  const styp = rep.slow_by_type;
  const sel = styp.find((x) => x.type === "select");
  const del = styp.find((x) => x.type === "delete");
  const ins = styp.find((x) => x.type === "insert");
  const upd = styp.find((x) => x.type === "update");
  if (!sel || sel.count !== 2 || sel.total_ms !== 550 || sel.avg_ms !== 275) throw new Error("select 聚合（150+s2 的 400，均 ≥100 慢阈值）: " + JSON.stringify(sel));
  if (!del || del.count !== 1 || del.total_ms !== 250) throw new Error("delete 聚合: " + JSON.stringify(del));
  if (!ins || ins.count !== 1 || ins.total_ms !== 300) throw new Error("insert 聚合: " + JSON.stringify(ins));
  if (upd) throw new Error("非慢错误不应入 slow_by_type: " + JSON.stringify(upd));
  // 排序：count 降序（select 2 领先；同 count 保持插入序）
  if (styp[0].type !== "select") throw new Error("slow_by_type 未按 count 降序: " + JSON.stringify(styp.map((x) => x.type)));
  // 语句类型归类兜底：注释开头 → other
  const st2 = OBSM.createObsState(50);
  OBSM.obsRecord(st2, "s", 90, false, "-- c SELECT 1", null);
  const ty = OBSM.obsSnapshot(st2, (t) => t).report.slow_by_type;
  if (ty.length !== 1 || ty[0].type !== "other") throw new Error("注释开头应归 other: " + JSON.stringify(ty));
});

check("obs: server_stats 纯函数钉（v1.6.54）计数/错误/慢计数/ring 顺序与 cap/scrub 注入/avg", () => {
  const st = OBSM.createObsState(100);
  const snap0 = OBSM.obsSnapshot(st, (t) => t);
  if (snap0.per_source.length !== 0 || snap0.recent_slow.length !== 0 || snap0.slow_ms_threshold !== 100) throw new Error("空状态形状: " + JSON.stringify(snap0));
  OBSM.obsRecord(st, "s1", 50, false, "SELECT ok");
  OBSM.obsRecord(st, "s1", 150, false, "SELECT slow");
  OBSM.obsRecord(st, "s1", 30, true, "SELECT bad");
  OBSM.obsRecord(st, "s2", 200, false, "SELECT s2slow");
  const snap = OBSM.obsSnapshot(st, (t) => t);
  const s1 = snap.per_source.find((x) => x.source === "s1");
  if (!s1 || s1.count !== 3 || s1.errors !== 1 || s1.slow !== 1 || s1.total_ms !== 230 || s1.avg_ms !== 77) throw new Error("s1 计数: " + JSON.stringify(s1));
  if (snap.recent_slow.length !== 2 || snap.recent_slow[0].source !== "s1" || snap.recent_slow[1].source !== "s2") throw new Error("ring 顺序/内容: " + JSON.stringify(snap.recent_slow));
  // scrub 注入（head 脱敏）
  OBSM.obsRecord(st, "s3", 500, false, "token=secret-x");
  const snap2 = OBSM.obsSnapshot(st, (t) => String(t).split("secret").join("***"));
  const last = snap2.recent_slow[snap2.recent_slow.length - 1];
  if (last.sql_head !== "token=***-x") throw new Error("scrub 未生效: " + last.sql_head);
  // ring cap 32（43 条慢记录 → 保尾 32，首条=h8）
  for (let i = 0; i < 40; i++) OBSM.obsRecord(st, "s4", 999, false, "h" + i);
  const snap3 = OBSM.obsSnapshot(st, (t) => t);
  if (snap3.recent_slow.length !== 32) throw new Error("ring cap: " + snap3.recent_slow.length);
  if (snap3.recent_slow[0].sql_head !== "h8" || snap3.recent_slow[31].sql_head !== "h39") throw new Error("ring 首尾漂移: " + snap3.recent_slow[0].sql_head + " / " + snap3.recent_slow[31].sql_head);
});

check("v1.6.53: offset 分页形状钉——sampleSql OFFSET 追加/零不追加字节不变 + enforceLimit 外层耦合锁定", () => {
  const eq = (got, want, label) => { if (got !== want) throw new Error(label + "\n  got:  " + got + "\n  want: " + want); };
  // sampleSql：offset=0/缺省 → 旧形状字节不变（既有钉零漂移的显式锁定）
  eq(sampleSql("mysql", MYSQL_REF, { limit: 10 }), "SELECT * FROM `db`.`log_record` LIMIT 10", "缺省不追加");
  eq(sampleSql("mysql", MYSQL_REF, { limit: 10, offset: 0 }), "SELECT * FROM `db`.`log_record` LIMIT 10", "offset=0 不追加");
  // offset>0 → LIMIT..OFFSET（三驱动同形；纯数字直拼零注入面——intArg 在 handler 层校验）
  eq(sampleSql("mysql", MYSQL_REF, { limit: 10, offset: 20 }), "SELECT * FROM `db`.`log_record` LIMIT 10 OFFSET 20", "mysql OFFSET");
  eq(sampleSql("postgres", PG_REF, { orderBy: "id DESC", limit: 5, offset: 15 }), 'SELECT * FROM "public"."log_record" ORDER BY "id" DESC LIMIT 5 OFFSET 15', "pg 组合 OFFSET");
  eq(sampleSql("sqlite", 's"."t', { where: "a > 1", limit: 3, offset: 7 }), 'SELECT * FROM s"."t WHERE a > 1 LIMIT 3 OFFSET 7', "sqlite OFFSET");
  // 负 offset 直通旧行为（intArg 在 handler 层拒绝负值；纯函数层 >0 判定）
  eq(sampleSql("mysql", MYSQL_REF, { limit: 10, offset: -5 }), "SELECT * FROM `db`.`log_record` LIMIT 10", "负 offset 不追加");
  // enforceLimit 外层耦合：offset>0 时包裹语句 = LIMIT maxRows+1 OFFSET offset（doQuery 的
  // wrappedOffset 判定与该前缀输出耦合，此钉锁定耦合面）
  eq(enforceLimit("SELECT 1 AS a", 100, "mysql", 0), "SELECT * FROM (\nSELECT 1 AS a\n) AS _za_mcp_limit LIMIT 101", "enforceLimit offset=0 旧形状");
  eq(enforceLimit("SELECT 1 AS a", 100, "mysql", 25), "SELECT * FROM (\nSELECT 1 AS a\n) AS _za_mcp_limit LIMIT 101 OFFSET 25", "enforceLimit OFFSET 外层");
});
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

/* --- v1.6.26 回归：format 枚举非法值应显式报 E_PARAM，而非静默兜底成默认格式（query_plan→text / export_data→csv） --- */
check("arg guard: invalid enum rejected as E_PARAM no-retry", () => {
  for (const bad of ["xml", "JSON5", "text2", 123, true, ["json"], ["csv"], new String("json")]) {
    for (const [allowed, dflt] of [[["text", "json"], "text"], [["csv", "json"], "csv"]]) {
      let err = null;
      try { enumArg(bad, "format", allowed, dflt); } catch (e) { err = e; }
      if (!err) throw new Error("invalid enum was silently accepted: " + JSON.stringify(bad));
      if (err.errCode !== "E_PARAM" || err.errRetry !== "no-retry") {
        throw new Error("应为 E_PARAM/no-retry，got " + err.errCode + "/" + err.errRetry);
      }
      if (!err.message.includes("[" + allowed.join(", ") + "]")) {
        throw new Error("错误信息应列出允许值: " + err.message);
      }
    }
  }
});
check("arg guard: enum trim/case normalize, missing uses default", () => {
  if (enumArg("JSON", "format", ["text", "json"], "text") !== "json") throw new Error("JSON 应归一为 json");
  if (enumArg(" Text ", "format", ["text", "json"], "text") !== "text") throw new Error("首尾空白+大小写应归一为 text");
  if (enumArg(undefined, "format", ["csv", "json"], "csv") !== "csv") throw new Error("缺省应用默认值");
  if (enumArg(null, "format", ["csv", "json"], "csv") !== "csv") throw new Error("null 应用默认值");
  if (enumArg("", "format", ["csv", "json"], "csv") !== "csv") throw new Error("空串应用默认值");
});
check("arg guard: valid enum values pass byte-identical", () => {
  if (enumArg("text", "format", ["text", "json"], "text") !== "text") throw new Error("text 应原样通过");
  if (enumArg("json", "format", ["text", "json"], "text") !== "json") throw new Error("json 应原样通过");
  if (enumArg("csv", "format", ["csv", "json"], "csv") !== "csv") throw new Error("csv 应原样通过");
});

/* --- v1.6.27 回归：export 落盘清洗流式化（scrubToBuffer 字节域）必须与旧字符串链 scrubWith 逐字节恒等 --- */
check("scrubToBuffer: 字节域与 scrubWith 字符串链逐字节恒等（对抗矩阵 + 种子模糊）", () => {
  const cases = [
    ["abc", ["bc", "ab"]],               // key 集重叠：顺序 pass 语义
    ["aaaaaa", ["aa", "aaa"]],           // 自重叠 key
    ["aXb", ["X", "a***b"]],             // 后一 key 命中跨越前一 key 的替换边界
    ["a***b***c", ["***"]],              // 替换串本身是 key
    ["****", ["***"]],
    ["p=s3cr3t;s3cr3t2", ["s3cr3t2", "s3cr3t"]],  // 长短口令嵌套（SECRET_LIST 长度降序的形态）
    ["中文🔐emoji s3cr3t 尾", ["s3cr3t", "🔐"]],   // 多字节 UTF-8 / 代理对不得切碎
    ["mysql://u:p%40ss@h/db", ["u:p%40ss", "p%40ss"]],  // user:pass 与裸口令变体
    ["", ["x"]], ["no hits here", ["zzz", "qqq"]], ["tail", ["tail-longer-than-text"]],
  ];
  for (const [t, ks] of cases) {
    const a = scrubToBuffer(t, ks);
    const b = Buffer.from(scrubWith(t, ks), "utf8");
    if (Buffer.compare(a, b) !== 0) throw new Error("byte divergence: " + JSON.stringify([t, ks]));
  }
  let seed = 42;  // 固定种子伪随机：确定性可复现
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alpha = ["a", "b", "c", "*", "中", "🔐", "\n", ",", "s3cr3t"];
  for (let i = 0; i < 200; i++) {
    let t = "";
    for (let j = 0; j < rnd(40); j++) t += alpha[rnd(alpha.length)];
    const ks = [];
    for (let j = 0; j < 1 + rnd(3); j++) {
      let k = "";
      for (let m = 0; m < 1 + rnd(4); m++) k += alpha[rnd(6)];
      if (k) ks.push(k);
    }
    if (Buffer.compare(scrubToBuffer(t, ks), Buffer.from(scrubWith(t, ks), "utf8")) !== 0) {
      throw new Error("fuzz divergence @" + i + ": " + JSON.stringify([t, ks]));
    }
  }
});
check("scrubToBuffer: 孤立代理项回落旧链路；空键/非字符串键明确跳过（退化输入语义钉）", () => {
  for (const [t, ks] of [
    ["pre\uD800post", ["post", "x"]], ["pre\uDC00post", ["post"]], ["\uD800", ["x"]], ["x\uDBFF", ["x"]],
    ["abc\uD800def", ["c\ud800d"]],   // key 含孤立代理项同样回落
  ]) {
    const a = scrubToBuffer(t, ks);
    const b = Buffer.from(scrubWith(t, ks), "utf8");
    if (Buffer.compare(a, b) !== 0) throw new Error("lone-surrogate fallback divergence: " + JSON.stringify([t, ks]));
  }
  // 合法代理对（emoji）不触发回落，仍逐字节恒等
  if (Buffer.compare(scrubToBuffer("a🔐b", ["🔐"]), Buffer.from(scrubWith("a🔐b", ["🔐"]), "utf8")) !== 0) {
    throw new Error("emoji surrogate pair must stay byte-identical");
  }
  // 明确偏离（防语义漂移）：空 key 与非字符串 key 一律跳过——SECRET_LIST 不会产生，
  // scrubWith 对 "" 会在码元间插 "***"、对非字符串会隐式强转，均无产品语义
  if (Buffer.compare(scrubToBuffer("abc", ["", 123, null]), Buffer.from("abc", "utf8")) !== 0) {
    throw new Error("empty/non-string keys must be skipped");
  }
});

/* --- v1.6.28 回归：export CSV 两遍精确预铺直出 Buffer（消内容串驻留）——与字符串链逐字节恒等 --- */
check("exportToCsvBuffer: 直出 Buffer 与字符串组装逐字节恒等（共用发射器差分 + scrubBuffer 接线 + 早停边界）", () => {
  const f = ["a", "b", "c"];
  const rows = [
    { a: "plain", b: 1, c: null },
    { a: 'q"uote,comma', b: "line\nbreak", c: "中文🔐emoji" },
    { a: "=cmd|' /C calc'!A0", b: "+1-2", c: "@tab\tcr" },
    { a: 123n, b: 4.5, c: Buffer.from([0, 1, 255]) },
    { a: "", b: undefined, c: 'trail"' },
    { a: "p=s3cr3t;s3cr3t2", b: "u:p%40ss@h", c: "normal" },
  ];
  for (const neutralize of [true, false]) {
    const a = SERVER.exportToCsvBuffer(f, rows, neutralize);
    const s = SERVER.exportToCsv(f, rows, neutralize);
    if (Buffer.compare(a.content, Buffer.from(s.content, "utf8")) !== 0) throw new Error("builder divergence neutralize=" + neutralize);
    if (a.formula_cells_neutralized !== s.formula_cells_neutralized) throw new Error("neutralized count divergence: " + a.formula_cells_neutralized + " vs " + s.formula_cells_neutralized);
    // 整链接线（doExportData CSV 无哨兵分支语义）：Buffer 直洗 === 字符串链洗后转字节
    const ks = ["s3cr3t2", "s3cr3t", "u:p%40ss"];
    if (Buffer.compare(SERVER.scrubBuffer(a.content, ks), Buffer.from(scrubWith(s.content, ks), "utf8")) !== 0) {
      throw new Error("scrub chain divergence neutralize=" + neutralize);
    }
  }
  // 早停边界：恰等 totalBytes 放行且直出缓冲长度恰等；少 1 字节两条链同文案拒绝（未写盘如实）
  const exact = Buffer.byteLength(SERVER.exportToCsv(f, rows, true).content, "utf8");
  const okBuf = SERVER.exportToCsvBuffer(f, rows, true, exact);
  if (okBuf.content.length !== exact) throw new Error("exact-size alloc mismatch: " + okBuf.content.length + " vs " + exact);
  if (!okBuf.content.toString("utf8").endsWith("\r\n")) throw new Error("CSV content must end with CRLF");
  let msgB = "", msgS = "";
  try { SERVER.exportToCsvBuffer(f, rows, true, exact - 1); } catch (e) { msgB = e.message || ""; }
  try { SERVER.exportToCsv(f, rows, true, exact - 1); } catch (e) { msgS = e.message || ""; }
  if (!/超过上限/.test(msgB) || !/未写盘/.test(msgB)) throw new Error("exportToCsvBuffer early-abort message drifted: " + msgB.slice(0, 120));
  if (!/超过上限/.test(msgS) || !/未写盘/.test(msgS)) throw new Error("exportToCsv early-abort message drifted: " + msgS.slice(0, 120));
  // 种子模糊：随机行集两链逐字节恒等 + scrub 接线恒等（含字面 U+FFFD：无孤立代理时字节域零分叉）
  let seed = 20261005;  // 固定种子伪随机：确定性可复现
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alpha = ["a", "b", '"', ",", "\r", "\n", "中", "🔐", "*", "=", "s3cr3t", "\uFFFD", ""];
  for (let i = 0; i < 60; i++) {
    const ff = Array.from({ length: 1 + rnd(3) }, (_, j) => "c" + j);
    const rr = [];
    for (let j = 0; j < rnd(6); j++) {
      const o = {};
      for (const name of ff) {
        const roll = rnd(4);
        o[name] = roll === 0 ? rnd(1000) : roll === 1 ? null : Array.from({ length: rnd(6) }, () => alpha[rnd(alpha.length)]).join("");
      }
      rr.push(o);
    }
    for (const neutralize of [true, false]) {
      const a = SERVER.exportToCsvBuffer(ff, rr, neutralize);
      const s = SERVER.exportToCsv(ff, rr, neutralize);
      if (Buffer.compare(a.content, Buffer.from(s.content, "utf8")) !== 0) throw new Error("fuzz builder divergence @" + i);
      const ks = ["s3cr3t", "ab"];
      if (Buffer.compare(SERVER.scrubBuffer(a.content, ks), Buffer.from(scrubWith(s.content, ks), "utf8")) !== 0) {
        throw new Error("fuzz chain divergence @" + i);
      }
    }
  }
});
check("exportToCsvBuffer: 孤立代理哨兵 saw_lone_surrogate + scrubBuffer 直调恒等/退化键跳过（字节域 scrub 安全前置）", () => {
  const f = ["t"];
  const clean = SERVER.exportToCsvBuffer(f, [{ t: "a🔐b" }, { t: "plain" }], true);
  if (clean.saw_lone_surrogate !== false) throw new Error("valid surrogate pair must not set saw_lone_surrogate");
  for (const bad of ["pre\uD800post", "pre\uDC00post", "\uD800", "x\uDBFF"]) {
    const r = SERVER.exportToCsvBuffer(f, [{ t: bad }], true);
    if (r.saw_lone_surrogate !== true) throw new Error("lone surrogate must set saw_lone_surrogate: " + JSON.stringify(bad));
    // 哨兵触发时调用方回落字符串链（doExportData 哨兵分支语义）：回落产物与旧链逐字节一致
    const s = SERVER.exportToCsv(f, [{ t: bad }], true);
    if (Buffer.compare(scrubToBuffer(s.content, ["post", "x"]), Buffer.from(scrubWith(s.content, ["post", "x"]), "utf8")) !== 0) {
      throw new Error("fallback chain divergence for lone surrogate: " + JSON.stringify(bad));
    }
  }
  // scrubBuffer 直调（doExportData CSV 无哨兵分支的实际入口）：无孤立代理前置下与 scrubWith 逐字节恒等
  for (const [t, ks] of [
    ["p=s3cr3t;s3cr3t2 tail", ["s3cr3t2", "s3cr3t"]],
    ["aXb", ["X", "a***b"]],              // 后一 key 命中跨越前一 key 的替换边界
    ["中文🔐 s3cr3t", ["s3cr3t", "🔐"]],   // 多字节 UTF-8 / 代理对不得切碎
  ]) {
    if (Buffer.compare(SERVER.scrubBuffer(Buffer.from(t, "utf8"), ks), Buffer.from(scrubWith(t, ks), "utf8")) !== 0) {
      throw new Error("scrubBuffer direct divergence: " + JSON.stringify([t, ks]));
    }
  }
  // 退化键跳过语义与 scrubToBuffer 同口径：空 key/非字符串 key 一律跳过
  if (Buffer.compare(SERVER.scrubBuffer(Buffer.from("abc", "utf8"), ["", 123, null]), Buffer.from("abc", "utf8")) !== 0) {
    throw new Error("scrubBuffer must skip empty/non-string keys");
  }
});

/* --- v1.6.29 回归：export 整链流式写盘（createScrubPipeline 流式清洗 + measureCsv/streamCsvLines） --- */
check("createScrubPipeline: 流式清洗与整段替换逐字节恒等（任意切分不变 + 跨块/跨替换边界/短 key/多级 + flush 尾部）", () => {
  const cases = [
    ["p=s3cr3t;s3cr3t2 tail", ["s3cr3t2", "s3cr3t"]],   // 多 key 重叠前缀
    ["aXb", ["X", "a***b"]],                             // 后 key 命中跨越前 key 的替换边界
    ["xxabxx", ["ab", "x"]],                             // 后 key 重扫前 key 替换产物
    ["中文🔐s3cr3t🔐中", ["🔐", "s3cr3t"]],              // 多字节/代理对跨切分
    ["aaaa", ["aa"]],                                    // 贪心非重叠（与 split/join 同语义）
    ["abc", ["c"]],                                      // 命中收尾
    ["abc", ["abcd"]],                                   // key 长于内容
    ["a\r\nb-crlf", ["a\r\nb"]],                         // key 跨行边界（CRLF 是流字节）
    ["s3cr3ts3cr3ts3cr3t", ["s3cr3t"]],                  // 连续命中
    ["tab\tcr=+@", ["\t"]],                              // 单字节 key（|k|-1=0 无暂存）
    ["ab-then-more", ["ab"]],                            // 短 key（|k|<3 输出可增长）
    ["", ["s3cr3t"]],                                    // 空内容
  ];
  for (const [t, ks] of cases) {
    const want = Buffer.from(scrubWith(t, ks), "utf8");
    const tb = Buffer.from(t, "utf8");
    const chunkings = [
      [tb],                                                       // 整段
      Array.from(tb, (b) => Buffer.from([b])),                    // 逐字节（切碎多字节序列）
    ];
    for (const sz of [2, 3, 5, 7]) {                              // 固定宽度循环切分
      const parts = [];
      for (let i = 0; i < tb.length; i += sz) parts.push(Buffer.from(tb.subarray(i, Math.min(i + sz, tb.length))));
      chunkings.push(parts);
    }
    let seed = 20261005 + tb.length;                              // 种子随机切分（确定性可复现）
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let round = 0; round < 3; round++) {
      const parts = [];
      let i = 0;
      while (i < tb.length) {
        const n = 1 + rnd(4);
        parts.push(Buffer.from(tb.subarray(i, Math.min(i + n, tb.length))));
        i += n;
      }
      parts.splice(rnd(Math.max(1, parts.length)), 0, Buffer.alloc(0));  // 空块注入不得扰动输出
      chunkings.push(parts);
    }
    for (const parts of chunkings) {
      const p = SERVER.createScrubPipeline(ks);
      const got = [];
      for (const c of parts) got.push(p.feed(c));
      got.push(p.flush());
      const merged = Buffer.concat(got.filter((b) => b.length));
      if (Buffer.compare(merged, want) !== 0) {
        throw new Error("pipeline divergence: " + JSON.stringify([t, ks]) + " chunks=" + parts.length);
      }
      // emit 形态（产品路径实际形态：碎片零拷贝流出，回调即拷贝留存）与返回形态同恒等
      const pE = SERVER.createScrubPipeline(ks);
      const gotE = [];
      const emit = (b) => gotE.push(Buffer.from(b));
      for (const c of parts) pE.feed(c, emit);
      pE.flush(emit);
      if (Buffer.compare(Buffer.concat(gotE), want) !== 0) {
        throw new Error("pipeline emit-form divergence: " + JSON.stringify([t, ks]) + " chunks=" + parts.length);
      }
    }
  }
  // 退化键跳过与 scrubBuffer 同口径；零 key 管线直通
  const p2 = SERVER.createScrubPipeline(["", 123, null]);
  const pass = p2.feed(Buffer.from("abc", "utf8"));
  if (Buffer.compare(pass, Buffer.from("abc", "utf8")) !== 0 || p2.flush().length !== 0) {
    throw new Error("degenerate/zero-key pipeline must pass through");
  }
  // flush 尾部语义：尾部 < |k| 不可能藏完整匹配——喂到只剩尾部即停，flush 原样放出且恒等
  const t3 = "xxs3cr3txx", k3 = ["s3cr3t"];
  const p3 = SERVER.createScrubPipeline(k3);
  const a3 = p3.feed(Buffer.from("xxs3cr", "utf8"));   // 停在 key 中间（尾部 6 字节暂存）
  const b3 = p3.feed(Buffer.from("3txx", "utf8"));     // 跨块补完匹配
  const c3 = p3.flush();
  const m3 = Buffer.concat([a3, b3, c3]);
  if (Buffer.compare(m3, Buffer.from(scrubWith(t3, k3), "utf8")) !== 0) {
    throw new Error("flush tail semantics divergence: " + m3.toString("hex"));
  }
});
check("measureCsv/streamCsvLines: 流式整链与 Buffer/字符串链逐字节恒等 + 早停零写盘 + 哨兵口径一致", () => {
  const f = ["a", "b", "c"];
  const rows = [
    { a: "plain", b: 1, c: null },
    { a: 'q"uote,comma', b: "line\nbreak", c: "中文🔐emoji" },
    { a: "=cmd|' /C calc'!A0", b: "+1-2", c: "@tab\tcr" },
    { a: 123n, b: 4.5, c: Buffer.from([0, 1, 255]) },
    { a: "", b: undefined, c: 'trail"' },
    { a: "p=s3cr3t;s3cr3t2", b: "u:p%40ss@h", c: "normal" },
  ];
  const ks = ["s3cr3t2", "s3cr3t", "u:p%40ss", "ab"];   // 含短 key "ab"（|k|<3 流式同口径）
  let strChain = null;
  for (const neutralize of [true, false]) {
    const scan = SERVER.measureCsv(f, rows, neutralize);
    strChain = Buffer.from(scrubWith(SERVER.exportToCsv(f, rows, neutralize).content, ks), "utf8");
    const bufChain = SERVER.scrubBuffer(SERVER.exportToCsvBuffer(f, rows, neutralize).content, ks);
    const w = [];
    const bytes = SERVER.streamCsvLines((b) => w.push(Buffer.from(b)), f, rows, ks, neutralize);
    const streamed = Buffer.concat(w);
    if (Buffer.compare(streamed, strChain) !== 0) throw new Error("stream vs string-chain divergence neutralize=" + neutralize);
    if (Buffer.compare(streamed, bufChain) !== 0) throw new Error("stream vs buffer-chain divergence neutralize=" + neutralize);
    if (bytes !== streamed.length) throw new Error("streamCsvLines byte count wrong: " + bytes + " vs " + streamed.length);
    if (bytes !== strChain.length) throw new Error("bytes must keep scrubbed.length semantics: " + bytes + " vs " + strChain.length);
    // pass 1 计量与既有两链口径一致（totalBytes/neutralized/saw_lone_surrogate）
    const ref = SERVER.exportToCsvBuffer(f, rows, neutralize);
    if (scan.totalBytes !== ref.content.length) throw new Error("measureCsv totalBytes divergence: " + scan.totalBytes + " vs " + ref.content.length);
    if (scan.neutralized !== ref.formula_cells_neutralized) throw new Error("measureCsv neutralized divergence");
    if (scan.saw_lone_surrogate !== false) throw new Error("clean rows must not set saw_lone_surrogate");
  }
  // 早停零写盘：measureCsv/streamCsvLines 超限同文案（/超过上限/未写盘/），小批负载下 write 零回调
  const exact = Buffer.byteLength(SERVER.exportToCsv(f, rows, true).content, "utf8");
  let msgM = "", msgS = "";
  const preWrites = [];
  try { SERVER.measureCsv(f, rows, true, exact - 1); } catch (e) { msgM = e.message || ""; }
  try { SERVER.streamCsvLines((b) => preWrites.push(b), f, rows, ks, true, exact - 1); } catch (e) { msgS = e.message || ""; }
  if (!/超过上限/.test(msgM) || !/未写盘/.test(msgM)) throw new Error("measureCsv early-abort message drifted: " + msgM.slice(0, 120));
  if (!/超过上限/.test(msgS) || !/未写盘/.test(msgS)) throw new Error("streamCsvLines early-abort message drifted: " + msgS.slice(0, 120));
  if (preWrites.length) throw new Error("early-stop must not write anything (未写盘如实)");
  // 恰等上限放行：流式字节数 = 洗后长度（与 scrubbed.length 同口径；注意中和模式会改长度，用同模式参照）
  const wantTrue = Buffer.from(scrubWith(SERVER.exportToCsv(f, rows, true).content, ks), "utf8");
  const okBytes = SERVER.streamCsvLines(() => {}, f, rows, ks, true, exact);
  if (okBytes !== wantTrue.length) throw new Error("exact-limit stream bytes wrong: " + okBytes + " vs " + wantTrue.length);
  // 哨兵口径：measureCsv 与 exportToCsvBuffer 同报 saw_lone_surrogate（doExportData 回落门的判定源）
  for (const bad of ["pre\uD800post", "pre\uDC00post", "\uD800"]) {
    const m = SERVER.measureCsv(f, [{ a: bad, b: 0, c: null }], true);
    const r = SERVER.exportToCsvBuffer(f, [{ a: bad, b: 0, c: null }], true);
    if (m.saw_lone_surrogate !== true || r.saw_lone_surrogate !== true) {
      throw new Error("sentinel divergence for lone surrogate: " + JSON.stringify(bad));
    }
  }
  // 种子模糊 40 轮：随机行集流式 == Buffer 链 == 字符串链（含短 key / 中文 / emoji / 引号换行）
  let seed = 20261005;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alpha = ["a", "b", '"', ",", "\r", "\n", "中", "🔐", "*", "=", "s3cr3t", "ab", "\uFFFD", ""];
  for (let i = 0; i < 40; i++) {
    const ff = Array.from({ length: 1 + rnd(3) }, (_, j) => "c" + j);
    const rr = [];
    for (let j = 0; j < rnd(6); j++) {
      const o = {};
      for (const name of ff) {
        const roll = rnd(4);
        o[name] = roll === 0 ? rnd(1000) : roll === 1 ? null : Array.from({ length: rnd(8) }, () => alpha[rnd(alpha.length)]).join("");
      }
      rr.push(o);
    }
    const want = Buffer.from(scrubWith(SERVER.exportToCsv(ff, rr, true).content, ks), "utf8");
    const w = [];
    const bytes = SERVER.streamCsvLines((b) => w.push(Buffer.from(b)), ff, rr, ks, true);
    const streamed = Buffer.concat(w);
    if (Buffer.compare(streamed, want) !== 0) throw new Error("fuzz stream divergence @" + i);
    if (bytes !== want.length) throw new Error("fuzz byte count wrong @" + i);
    if (Buffer.compare(SERVER.scrubBuffer(SERVER.exportToCsvBuffer(ff, rr, true).content, ks), want) !== 0) {
      throw new Error("fuzz buffer chain divergence @" + i);
    }
  }
  // writeFileStreamAtomic：流式写入 + 原子占位语义与 writeFileAtomic 一致（EEXIST 显式拒绝/overwrite 放行）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-streamw-"));
  const target = path.join(tmp, "out.bin");
  SERVER.writeFileStreamAtomic(target, (fd) => { fs.writeSync(fd, "hello-"); fs.writeSync(fd, "stream"); });
  if (fs.readFileSync(target, "utf8") !== "hello-stream") throw new Error("writeFileStreamAtomic content wrong");
  let eexist = "";
  try { SERVER.writeFileStreamAtomic(target, (fd) => { fs.writeSync(fd, "x"); }); } catch (e) { eexist = e.message || ""; }
  if (!/目标文件已存在/.test(eexist)) throw new Error("writeFileStreamAtomic must reject existing target: " + eexist.slice(0, 80));
  if (fs.readFileSync(target, "utf8") !== "hello-stream") throw new Error("failed link must not clobber target");
  SERVER.writeFileStreamAtomic(target, (fd) => { fs.writeSync(fd, "over"); }, true);
  if (fs.readFileSync(target, "utf8") !== "over") throw new Error("overwrite=true must replace target");
  let failKept = "";
  try { SERVER.writeFileStreamAtomic(path.join(tmp, "fail.bin"), (fd) => { fs.writeSync(fd, "partial"); throw new Error("boom"); }); } catch (e) { failKept = e.message || ""; }
  if (failKept !== "boom") throw new Error("writeFn error must propagate unchanged: " + failKept);
  if (fs.existsSync(path.join(tmp, "fail.bin"))) throw new Error("failed write must not leave target");
  if (fs.readdirSync(tmp).some((n) => n.endsWith(".tmp"))) throw new Error("tmp residue must be cleaned");
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* --- v1.6.32 回归：query 侧行集流式（createCsvRowSink 行接收器 + writeFileStreamAtomic 异步形态） --- */
check("createCsvRowSink: 增量喂入与整链逐字节恒等（eager/惰性表头 + 账面口径 + 哨兵旗/abort + E_LIMIT 零写盘）", () => {
  const f = ["a", "b", "c"];
  const rows = [
    { a: "plain", b: 1, c: null },
    { a: 'q"uote,comma', b: "line\nbreak", c: "中文🔐emoji" },
    { a: "=cmd|' /C calc'!A0", b: "+1-2", c: "@tab\tcr" },
    { a: 123n, b: 4.5, c: Buffer.from([0, 1, 255]) },
    { a: "", b: undefined, c: 'trail"' },
    { a: "p=s3cr3t;s3cr3t2", b: "u:p%40ss@h", c: "normal" },
  ];
  const ks = ["s3cr3t2", "s3cr3t", "u:p%40ss", "ab"];
  for (const neutralize of [true, false]) {
    const want = Buffer.from(scrubWith(SERVER.exportToCsv(f, rows, neutralize).content, ks), "utf8");
    const ref = SERVER.measureCsv(f, rows, neutralize);
    // eager 表头（fields 数组构造即发）逐行喂入 == 字符串链 == streamCsvLines 账面
    const w = [];
    const sink = SERVER.createCsvRowSink((b) => w.push(Buffer.from(b)), f, ks, neutralize);
    for (const r of rows) sink.row(r);
    const fin = sink.finish();
    if (Buffer.compare(Buffer.concat(w), want) !== 0) throw new Error("sink eager divergence neutralize=" + neutralize);
    if (fin.written !== want.length) throw new Error("sink written wrong: " + fin.written + " vs " + want.length);
    if (fin.neutralized !== ref.neutralized) throw new Error("sink neutralized divergence: " + fin.neutralized + " vs " + ref.neutralized);
    if (fin.saw_lone_surrogate !== false) throw new Error("clean rows must not set saw_lone_surrogate");
    // 惰性表头（fields=null，首行 Object.keys 定列）与 eager 逐字节恒等（fixture 列序一致）
    const w2 = [];
    const sink2 = SERVER.createCsvRowSink((b) => w2.push(Buffer.from(b)), null, ks, neutralize);
    for (const r of rows) sink2.row(r);
    const fin2 = sink2.finish();
    if (Buffer.compare(Buffer.concat(w2), want) !== 0) throw new Error("lazy-header divergence neutralize=" + neutralize);
    if (fin2.written !== want.length || fin2.neutralized !== ref.neutralized) throw new Error("lazy sink accounting wrong");
  }
  // 零行双形态：eager 表头 = 列名行；惰性 finish() 发空列表头——分别与 exportToCsv(f, [])/([], []) 恒等
  const wantH = Buffer.from(scrubWith(SERVER.exportToCsv(f, [], true).content, ks), "utf8");
  const wH = [];
  const finH = SERVER.createCsvRowSink((b) => wH.push(Buffer.from(b)), f, ks, true).finish();
  if (Buffer.compare(Buffer.concat(wH), wantH) !== 0 || finH.written !== wantH.length) throw new Error("eager zero-row header divergence");
  const wantE = Buffer.from(scrubWith(SERVER.exportToCsv([], [], true).content, ks), "utf8");
  const wE = [];
  const finE = SERVER.createCsvRowSink((b) => wE.push(Buffer.from(b)), null, ks, true).finish();
  if (Buffer.compare(Buffer.concat(wE), wantE) !== 0 || finE.written !== wantE.length) throw new Error("lazy zero-row empty-header divergence");
  // 表头重复设置显式拒绝（onFields 双发即内部不变量破坏，不静默双表头）
  let dupMsg = "";
  const sinkD = SERVER.createCsvRowSink(() => {}, f, ks, true);
  try { sinkD.header(f); } catch (e) { dupMsg = e.message || ""; }
  if (!/表头重复设置/.test(dupMsg)) throw new Error("duplicate header must be rejected: " + dupMsg.slice(0, 80));
  // 哨兵旗标模式（默认）：孤立代理项记旗不中止，输出与字符串链仍逐字节恒等
  //（ks 无 U+FFFD/代理项键——该键型才是字节域/字符串域分叉面，键哨兵由 doExportData 门挡）
  const D800 = String.fromCharCode(0xd800);
  const DC00 = String.fromCharCode(0xdc00);
  for (const bad of ["pre" + D800 + "post", "pre" + DC00 + "post", D800]) {
    const rr = [{ a: bad, b: 0, c: null }];
    const want = Buffer.from(scrubWith(SERVER.exportToCsv(f, rr, true).content, ks), "utf8");
    const w = [];
    const sink = SERVER.createCsvRowSink((b) => w.push(Buffer.from(b)), f, ks, true);
    for (const r of rr) sink.row(r);
    const fin = sink.finish();
    if (fin.saw_lone_surrogate !== true) throw new Error("sink sentinel flag missing");
    if (Buffer.compare(Buffer.concat(w), want) !== 0) throw new Error("flag-mode sentinel must not change bytes");
    if (fin.written !== want.length) throw new Error("flag-mode written wrong");
  }
  // abort 模式（流式产品路径）：首格命中即抛 ContentSentinelAbort，scratch 未冲刷 → 零写回调
  const wA = [];
  let abortErr = null;
  const sinkA = SERVER.createCsvRowSink((b) => wA.push(b), f, ks, true, 20 * 1024 * 1024, { sentinel: "abort" });
  try {
    for (const r of [{ a: "ok", b: 1, c: null }, { a: D800, b: 2, c: null }, { a: "never", b: 3, c: null }]) sinkA.row(r);
    sinkA.finish();
  } catch (e) { abortErr = e; }
  if (!abortErr || !SERVER.isContentSentinelAbort(abortErr) || abortErr.name !== "ContentSentinelAbort") {
    throw new Error("abort mode must raise ContentSentinelAbort");
  }
  if (wA.length) throw new Error("abort before flush must not write anything");
  if (SERVER.isContentSentinelAbort(new Error("x")) || SERVER.isContentSentinelAbort(null)) {
    throw new Error("isContentSentinelAbort must not misclassify");
  }
  // abort 对惰性表头格同样生效（首行 Object.keys → emitHeader 命中哨兵即中止）
  let abortHdr = null;
  const sinkB = SERVER.createCsvRowSink((b) => {}, null, ks, true, 20 * 1024 * 1024, { sentinel: "abort" });
  try { sinkB.row({ [D800]: 1 }); sinkB.finish(); } catch (e) { abortHdr = e; }
  if (!abortHdr || !SERVER.isContentSentinelAbort(abortHdr)) throw new Error("lazy header sentinel must abort");
  // E_LIMIT：行边界早停与 eachCsvLine 同文案（/超过上限/未写盘/），小批负载零写回调；恰等上限放行
  const exact = Buffer.byteLength(SERVER.exportToCsv(f, rows, true).content, "utf8");
  let msgL = "";
  const wL = [];
  const sinkL = SERVER.createCsvRowSink((b) => wL.push(b), f, ks, true, exact - 1);
  try {
    for (const r of rows) sinkL.row(r);
    sinkL.finish();
  } catch (e) { msgL = e.message || ""; }
  if (!/超过上限/.test(msgL) || !/未写盘/.test(msgL)) throw new Error("sink E_LIMIT message drifted: " + msgL.slice(0, 120));
  if (wL.length) throw new Error("sink early-stop must not write anything (未写盘如实)");
  const wantT = Buffer.from(scrubWith(SERVER.exportToCsv(f, rows, true).content, ks), "utf8");
  const wT = [];
  const sinkT = SERVER.createCsvRowSink((b) => wT.push(Buffer.from(b)), f, ks, true, exact);
  for (const r of rows) sinkT.row(r);
  const finT = sinkT.finish();
  if (finT.written !== wantT.length) throw new Error("exact-limit sink wrong: " + finT.written + " vs " + wantT.length);
  if (Buffer.compare(Buffer.concat(wT), wantT) !== 0) throw new Error("exact-limit sink divergence");
  // 种子模糊 20 轮：随机行集增量喂入 == 字符串链（惰性表头；含短 key/中文/emoji/引号换行）
  let seed = 20261005;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alpha = ["a", "b", '"', ",", "\r", "\n", "中", "🔐", "*", "=", "s3cr3t", "ab", ""];
  for (let i = 0; i < 20; i++) {
    const ff = Array.from({ length: 1 + rnd(3) }, (_, j) => "c" + j);
    const rr = [];
    for (let j = 0; j < rnd(6); j++) {
      const o = {};
      for (const name of ff) {
        const roll = rnd(4);
        o[name] = roll === 0 ? rnd(1000) : roll === 1 ? null : Array.from({ length: rnd(8) }, () => alpha[rnd(alpha.length)]).join("");
      }
      rr.push(o);
    }
    const want = Buffer.from(scrubWith(SERVER.exportToCsv(ff, rr, true).content, ks), "utf8");
    const w = [];
    // 惰性表头仅在有行时等价（首行 Object.keys）；零行产品面必有 onFields 列名 → 走 eager
    //（惰性零行的空列表头语义已单独钉为 exportToCsv([], []) 恒等）
    const sink = SERVER.createCsvRowSink((b) => w.push(Buffer.from(b)), rr.length ? null : ff, ks, true);
    for (const r of rr) sink.row(r);
    const fin = sink.finish();
    if (Buffer.compare(Buffer.concat(w), want) !== 0) throw new Error("fuzz sink divergence @" + i);
    if (fin.written !== want.length) throw new Error("fuzz sink byte count wrong @" + i);
  }
});
await checkAsync("writeFileStreamAtomic: 异步 writeFn 形态与同步面同语义（thenable 延迟占位 + 失败清理 + EEXIST/overwrite 一致）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-streamw-async-"));
  try {
    const target = path.join(tmp, "async.bin");
    let release;
    const gate = new Promise((r) => { release = r; });
    const p = SERVER.writeFileStreamAtomic(target, async (fd) => {
      fs.writeSync(fd, "async-");
      await gate;
      fs.writeSync(fd, "done");
    });
    if (!(p && typeof p.then === "function")) throw new Error("async writeFn must return a Promise");
    // 消费未完成 → 目标不出现（原子占位延迟到 writeFn 的 Promise 落定）
    if (fs.existsSync(target)) throw new Error("target must not appear before writeFn settles");
    release();
    await p;
    if (fs.readFileSync(target, "utf8") !== "async-done") throw new Error("async content wrong");
    // 异步失败：错误原样上抛、目标不出现、无 .tmp 残骸
    let failMsg = "";
    try {
      await SERVER.writeFileStreamAtomic(path.join(tmp, "fail.bin"), async (fd) => {
        fs.writeSync(fd, "partial");
        await Promise.resolve();
        throw new Error("async-boom");
      });
    } catch (e) { failMsg = e.message || ""; }
    if (failMsg !== "async-boom") throw new Error("async writeFn error must propagate unchanged: " + failMsg);
    if (fs.existsSync(path.join(tmp, "fail.bin"))) throw new Error("failed async write must not leave target");
    // EEXIST / overwrite 与同步面逐字一致（同 copy、失败不覆盖）
    let eexist = "";
    try {
      await SERVER.writeFileStreamAtomic(target, async (fd) => { fs.writeSync(fd, "x"); });
    } catch (e) { eexist = e.message || ""; }
    if (!/目标文件已存在/.test(eexist)) throw new Error("async EEXIST copy drifted: " + eexist.slice(0, 80));
    if (fs.readFileSync(target, "utf8") !== "async-done") throw new Error("failed async link must not clobber target");
    await SERVER.writeFileStreamAtomic(target, async (fd) => { await Promise.resolve(); fs.writeSync(fd, "over"); }, true);
    if (fs.readFileSync(target, "utf8") !== "over") throw new Error("async overwrite=true must replace target");
    if (fs.readdirSync(tmp).some((n) => n.endsWith(".tmp"))) throw new Error("tmp residue must be cleaned");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* --- v1.6.33 回归：pg 游标批量单一真源（消「FETCH 批量/退出阈值两处字面量漂移→超首批行静默截断」bug 类） --- */
check("pool.mjs: PG_FETCH_BATCH 单一真源（FETCH 语句与游标退出阈值共用常量，无裸数字字面量）", () => {
  const src = fs.readFileSync(path.join(here, "pool.mjs"), "utf8");
  const m = src.match(/const PG_FETCH_BATCH = (\d+);/);
  if (!m) throw new Error("PG_FETCH_BATCH 常量缺失");
  if (/FETCH FORWARD \d+/.test(src)) throw new Error("FETCH 批量存在裸数字字面量（须引用 PG_FETCH_BATCH）");
  if (/rows\.length < \d+/.test(src)) throw new Error("游标退出阈值存在裸数字字面量（须引用 PG_FETCH_BATCH）");
  if (!src.includes("res.rows.length < PG_FETCH_BATCH")) throw new Error("游标退出阈值未引用 PG_FETCH_BATCH");
  if (!src.includes("FETCH FORWARD ${PG_FETCH_BATCH} FROM qm_cur")) throw new Error("FETCH 语句未引用 PG_FETCH_BATCH");
});

/* --- v1.6.30 回归：createBatchWriter 集束写（高频小块收成低频大块，export 耗时回收本体） --- */
check("createBatchWriter: 集束写逐字节恒等（批边界不变 + 超大碎片零拷贝直写 + flush 尾批幂等 + 写调用收数）", () => {
  for (const batchBytes of [4096, 8192]) {
    const collected = [];
    const calls = [];
    const bw = SERVER.createBatchWriter((b) => { calls.push(b); collected.push(Buffer.from(b)); }, batchBytes);
    const pushed = [];
    const oversizeObjs = [];
    let seed = 20261005 + batchBytes;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 400; i++) {
      const pick = rnd(6);
      let sz;
      if (pick === 0) sz = 0;
      else if (pick === 1) sz = 1 + rnd(8);                    // 微片（"***" 3 字节同口径）
      else if (pick === 2) sz = batchBytes - 1 + rnd(3);        // 批边界 -1/0/+1
      else if (pick === 3) sz = batchBytes + rnd(batchBytes);   // 超大碎片（≥ BATCH，直写路径）
      else if (pick === 4) sz = 3;
      else sz = 1 + rnd(2000);
      const frag = Buffer.alloc(sz, 97 + (i % 26));
      if (sz >= batchBytes) oversizeObjs.push(frag);
      pushed.push(frag);
      bw.push(frag);
      if (i % 37 === 0) bw.flush();                             // 随机冲刷：批边界不得丢/重字节
    }
    bw.flush();
    bw.flush();                                                 // 幂等：二次 flush 不得多写
    if (Buffer.compare(Buffer.concat(collected), Buffer.concat(pushed)) !== 0) {
      throw new Error("batch writer byte divergence (batch=" + batchBytes + ")");
    }
    // 批块 ≤ batchBytes；超大碎片必须零拷贝整块直写（写回调收到同一缓冲对象）
    for (const b of calls) {
      if (b.length > batchBytes && !oversizeObjs.includes(b)) throw new Error("unexpected oversized block leaked");
    }
    for (const obj of oversizeObjs) {
      if (!calls.some((b) => b === obj)) throw new Error("oversize fragment must be written as-is (no copy)");
    }
    // 写调用收数：碎片数远多于落出块数（退回逐片直写须被钉住）
    const bound = oversizeObjs.length + Math.ceil(Buffer.concat(pushed).length / batchBytes) + 2;
    if (calls.length > bound) throw new Error("write calls not batched: " + calls.length + " > " + bound);
  }
  // 尾批只有 flush 才落出；flush 后 push 续写不丢
  const out = [];
  const bw = SERVER.createBatchWriter((b) => out.push(Buffer.from(b)));
  bw.push(Buffer.from("尾批"));
  if (out.length !== 0) throw new Error("partial batch must not leak before flush");
  bw.push(Buffer.from("-tail"));
  bw.flush();
  if (Buffer.concat(out).toString("utf8") !== "尾批-tail") throw new Error("flush must release tail batch");
  bw.push(Buffer.from("again"));
  bw.flush();
  if (Buffer.concat(out).toString("utf8") !== "尾批-tailagain") throw new Error("push after flush must keep working");
});
/* --- v1.6.31 回归：零物化行格式化（融合计数/直写/scratch 直写 vs 行串真源逐字节恒等） --- */
check("零物化组装差分钉（融合计数/直写/scratch vs 行串真源 + 逐格哨兵等价 + 早停边界 + 种子模糊）", () => {
  const truth = (ff, rr, nt) => SERVER.exportToCsv(ff, rr, nt).content;   // 行串真源（eachCsvLine）
  // 对抗字符以 fromCharCode 运行时构造（原始未配对代理字符不可写入源文本层）
  const HI = String.fromCharCode(0xD800);                                // 孤立高位代理
  const LO = String.fromCharCode(0xDC00);                                // 孤立低位代理
  const EMOJI = String.fromCharCode(0xD83D, 0xDE00);                     // 合法代理对（必须不误报哨兵）
  const FFFF = String.fromCharCode(0xFFFF);
  // 对抗行集：孤立代理在格首/格尾/格中、相邻格拼成合法代理对（必须不误报）、引号/逗号/CR/LF、
  // 公式中和、CJK、空值、非字符串（number/bigint/BLOB）、超大格（>21845 码元走 scratch 精确路径）
  const fields = ["a", "b", "c", "=head", "e"];
  const big = "x".repeat(30000);                                        // 超大格：scratch 整格直喂分支
  const rowsAdv = [
    { a: HI + "pre", b: "post" + LO, c: "ok", "=head": 1, e: null },
    { a: "x" + HI, b: LO + "y", c: "\"q,\" \r\n z", "=head": "=cmd", e: "好" },
    { a: EMOJI, b: EMOJI + "tail", c: "", "=head": "@x", e: 123n },
    { a: big, b: "z".repeat(21846), c: "t", "=head": -1, e: "u" },
    { a: null, b: undefined, c: 0.5, "=head": "\tT", e: Buffer.from([222, 173]) },
    { a: HI, b: LO, c: "\r", "=head": "\n", e: "s" },
  ];
  for (const nt of [true, false]) {
    const content = truth(fields, rowsAdv, nt);
    const want = Buffer.from(content, "utf8");
    // 1) 计量恒等：measureCsv.totalBytes ≡ 行串真源字节数；中和计数 ≡ 真源口径
    const scan = SERVER.measureCsv(fields, rowsAdv, nt);
    if (scan.totalBytes !== want.length) throw new Error("measure totalBytes divergence: " + scan.totalBytes + " vs " + want.length);
    const expectNeutral = (() => {
      let c = 0;
      const bump = (v) => { if (nt && typeof v === "string" && /^[=+\-@\t\r]/.test(v)) c++; };
      for (const f of fields) bump(f);
      for (const r of rowsAdv) for (const f of fields) bump(r?.[f]);
      return c;
    })();
    if (scan.neutralized !== expectNeutral) throw new Error("neutralized divergence: " + scan.neutralized + " vs " + expectNeutral);
    // 2) 逐格哨兵 ≡ 逐行哨兵（行串真源逐行 LONE 判定为基准）
    const wantLone = content.split("\r\n").some((l) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(l));
    if (scan.saw_lone_surrogate !== wantLone) throw new Error("sentinel divergence: per-cell " + scan.saw_lone_surrogate + " vs per-line " + wantLone);
    // 3) 直写恒等：exportToCsvBuffer ≡ 行串真源字节（含超大格的精确 byteLength 分支）
    const got = SERVER.exportToCsvBuffer(fields, rowsAdv, nt);
    if (Buffer.compare(got.content, want) !== 0) throw new Error("buffer chain divergence (adversarial)");
    if (got.saw_lone_surrogate !== wantLone) throw new Error("buffer sentinel divergence");
    // 4) scratch 直写恒等：streamCsvLines ≡ scrub(行串真源)，早停口径与真源同点位
    for (const list of [[], ["s3cr3t", "ok"], ["x"], ["好", EMOJI]]) {
      const w = [];
      const bytes = SERVER.streamCsvLines((b) => w.push(Buffer.from(b)), fields, rowsAdv, list, nt);
      const wantScrub = Buffer.from(SERVER.scrubWith(content, list), "utf8");
      if (Buffer.compare(Buffer.concat(w), wantScrub) !== 0) throw new Error("stream chain divergence (adversarial, keys=" + list.length + ")");
      if (bytes !== wantScrub.length) throw new Error("stream byte count divergence: " + bytes + " vs " + wantScrub.length);
    }
  }
  // 5) 早停边界：exact-1 抛 E_LIMIT 同一文案、零 write 回调；exact 过
  const ff = ["a", "b"];
  const rr = [{ a: "1", b: "2" }, { a: "3", b: "4" }];
  const base = SERVER.measureCsv(ff, rr, true);
  const over = base.totalBytes - 1;
  let msg = "";
  try { SERVER.measureCsv(ff, rr, true, over); } catch (e) { msg = e.message || ""; }
  if (!/超过上限/.test(msg) || !/组装期早停，未写盘/.test(msg)) throw new Error("early-stop copy drift: " + msg.slice(0, 60));
  let wmsg = "", wcalls = 0;
  try { SERVER.streamCsvLines(() => { wcalls++; }, ff, rr, [], true, over); } catch (e) { wmsg = e.message || ""; }
  if (!/超过上限/.test(wmsg) || !/组装期早停，未写盘/.test(wmsg)) throw new Error("stream early-stop copy drift: " + wmsg.slice(0, 60));
  if (wcalls !== 0) throw new Error("early-stop must not write (calls=" + wcalls + ")");
  if (SERVER.measureCsv(ff, rr, true, base.totalBytes).totalBytes !== base.totalBytes) throw new Error("exact-limit must pass");
  // 6) 种子模糊：随机行集三链逐字节恒等（真源 vs 融合计数/直写/scratch）
  let seed = 20261005;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alpha = ["p", "q\"", ",", "\n", "\r", "=", "@", "好", EMOJI, HI, FFFF, "'", "x".repeat(300), ""];
  for (let i = 0; i < 40; i++) {
    const nf = 1 + rnd(4);
    const ffs = Array.from({ length: nf }, (_, j) => "f" + j + (rnd(3) === 0 ? "名" : ""));
    const rrs = Array.from({ length: rnd(12) }, () => {
      const o = {};
      for (const f of ffs) {
        const p = rnd(5);
        o[f] = p === 0 ? rnd(1000) : p === 1 ? (rnd(2) ? "pre" + rnd(50) : "") : alpha[rnd(alpha.length)];
      }
      return o;
    });
    const content = truth(ffs, rrs, true);
    const want = Buffer.from(content, "utf8");
    const scan = SERVER.measureCsv(ffs, rrs, true);
    if (scan.totalBytes !== want.length) throw new Error("fuzz measure divergence @" + i);
    if (Buffer.compare(SERVER.exportToCsvBuffer(ffs, rrs, true).content, want) !== 0) throw new Error("fuzz buffer divergence @" + i);
    const w = [];
    const bytes = SERVER.streamCsvLines((b) => w.push(Buffer.from(b)), ffs, rrs, ["f0", "x"], true);
    const wantScrub = Buffer.from(SERVER.scrubWith(content, ["f0", "x"]), "utf8");
    if (Buffer.compare(Buffer.concat(w), wantScrub) !== 0) throw new Error("fuzz stream divergence @" + i);
    if (bytes !== wantScrub.length) throw new Error("fuzz stream bytes divergence @" + i);
  }
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

/* --- C1 DDL 表名标识符预校验：与 import_data.table 同口径（旧版落 [E_DB] unrecognized token，错误类误导） --- */
check("create_table: DDL 表名非法标识符 → E_PARAM Invalid identifier（mysql/postgres 双方言）", () => {
  for (const dialect of ["mysql", "postgres"]) {
    try {
      SERVER.createTableGuard("CREATE TABLE 1bad (x INT)", dialect);
      throw new Error("1bad accepted under " + dialect);
    } catch (e) {
      if (e.errCode !== "E_PARAM" || !/Invalid identifier '1bad'/.test(e.message)) {
        throw new Error("wrong error under " + dialect + ": " + e.errCode + " " + e.message);
      }
    }
  }
});
check("create_table: DDL 表名 Unicode 中文 / 合法限定名 / IF NOT EXISTS 仍放行", () => {
  SERVER.createTableGuard("CREATE TABLE 订单表 (id INT)", "postgres");
  SERVER.createTableGuard("CREATE TABLE db.t (x INT)", "mysql");
  SERVER.createTableGuard("CREATE TABLE IF NOT EXISTS t2 (x INT)", "mysql");
});
check("create_table: 表名提取失败的畸形 DDL 不在守卫层硬拦（交解析器报语法错）", () => {
  const out = SERVER.createTableGuard("CREATE TABLE (x INT)", "mysql");
  if (!out.includes("(x INT)")) throw new Error("guard rewrote malformed DDL: " + JSON.stringify(out));
});

/* --- v1.4.1 全链路审查：管理/破坏性函数与会话控制（旧版黑名单缺项，实测放行） --- */
check("guard: pg_terminate_backend blocked", blockAll([
  ["SELECT pg_terminate_backend(12345)", "postgres"],
  ['SELECT "pg_terminate_backend"(12345)', "postgres"],
]));
check("guard: pg_cancel_backend blocked", blockAll([
  ["SELECT pg_cancel_backend(12345)", "postgres"],
  ['SELECT "pg_cancel_backend"(12345)', "postgres"],
]));
check("guard: pg_reload_conf blocked", throws(() => guardReadOnly("SELECT pg_reload_conf()", "postgres"), /Blocked/i));
check("guard: lo_unlink blocked", blockAll([
  ["SELECT lo_unlink(9999)", "postgres"],
  ['SELECT "lo_unlink"(9999)', "postgres"],
]));
check("guard: lo_create blocked", throws(() => guardReadOnly("SELECT lo_create(9999)", "postgres"), /Blocked/i));
check("guard: set_config blocked", blockAll([
  ["SELECT set_config('search_path','x',false)", "postgres"],
  ['SELECT "set_config"(\'search_path\',\'x\',false)', "postgres"],
]));
check("guard: pg_advisory_lock blocked", throws(() => guardReadOnly("SELECT pg_advisory_lock(1)", "postgres"), /Blocked/i));
check("guard: pg_sleep blocked", blockAll([
  ["SELECT pg_sleep(30)", "postgres"],
  ['SELECT "pg_sleep"(30)', "postgres"],
  ['SELECT U&"pg_sleep"(30)', "postgres"],
  ['SELECT pg_catalog."pg_sleep"(30)', "postgres"],
  ['SELECT "pg_sleep"/*c*/(30)', "postgres"],
  ['SELECT ("pg_sleep")(30)', "postgres"],
]));
check("guard: MySQL SLEEP blocked", blockAll([
  ["SELECT SLEEP(30)", "mysql"],
  ["SELECT `SLEEP`(30)", "mysql"],
  ["SELECT `sleep`(30)", "mysql"],
  ["SELECT `sleep`/*c*/(30)", "mysql"],
]));
check("guard: MySQL GET_LOCK blocked", blockAll([
  ["SELECT GET_LOCK('x',10)", "mysql"],
  ["SELECT `GET_LOCK`('x',10)", "mysql"],
]));
check("guard: MySQL BENCHMARK blocked", blockAll([
  ["SELECT BENCHMARK(100000000,SHA1('x'))", "mysql"],
  ["SELECT `BENCHMARK`(100000000,SHA1('x'))", "mysql"],
]));
check("guard: sqlite load_extension blocked", blockAll([
  ["SELECT load_extension('evil')", "postgres"],
  ['SELECT "load_extension"(\'evil\')', "postgres"],
]));
check("guard: dblink_exec blocked (word-boundary miss on plain dblink)", throws(() => guardReadOnly("SELECT dblink_exec('c','DROP TABLE t')", "postgres"), /Blocked/i));
check("guard: danger function names as columns (no parens) allowed", allowAll([
  ["SELECT sleep_status, set_config FROM t", "mysql"],
  ["SELECT `sleep`, `set_config`, `load_file` FROM t", "mysql"],
  ['SELECT "pg_sleep", "lo_export", "pg_read_file" FROM t', "postgres"],
]));
check("guard: danger function call in WHERE fragment blocked", () => {
  for (const [where, dbType] of [
    ["id=1 AND set_config('x','y',false)='z'", "postgres"],
    ['id=1 AND "set_config"(\'x\',\'y\',false)=\'z\'', "postgres"],
    ["`sleep`(1)", "mysql"],
  ]) {
    let msg = "";
    try { SERVER.checkWhereFragment(where, dbType); } catch (e) { msg = e.message || ""; }
    if (!/Blocked/i.test(msg)) throw new Error("WHERE 旁路未拦截: " + JSON.stringify(where));
  }
});

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
check("findcol: pg SQL shape (pg_attribute + 字面子串)", () => {
  const { sql, values } = SERVER.findColumnsSql("postgres", { schema: "public", column: "order", limit: 50 });
  // v1.6.34: strpos(lower…) 字面子串匹配——旧 ILIKE 模式让 %/_ 当通配符，与"子串"语义不符
  if (!/pg_attribute/.test(sql) || !/strpos\(lower\(/.test(sql) || /ILIKE/.test(sql) || !/LIMIT 51/.test(sql)) throw new Error(sql);
  if (values[0] !== "public" || values[1] !== "order") throw new Error(JSON.stringify(values));
});
/* --- v1.6.34: 真实对抗测试抓获的产品缺陷回归钉（where 尾句静默错数 / 注释尾巴误判多语句 / 通配符子串） --- */
check("where: 顶层子句关键字拒绝（尾句 GROUP BY 曾让 count 静默错数）", () => {
  for (const w of ["id > 0 GROUP BY id", "id > 0 ORDER BY id", "id > 0 LIMIT 1", "id > 0 UNION SELECT 999",
                   "id > 0 HAVING count(*) > 1", "(id) > 0 OFFSET 2", "id > 0 WINDOW w AS ()"]) {
    let msg = "";
    try { SERVER.checkWhereFragment(w, "mysql"); } catch (e) { msg = e.message || ""; }
    if (!/plain condition expression/.test(msg)) throw new Error(w + " -> " + (msg || "放行"));
  }
});
check("where: 括号子查询放行 + 标识符/字面量子句词不误伤", () => {
  SERVER.checkWhereFragment("id IN (SELECT x FROM t ORDER BY x LIMIT 3)", "mysql");
  SERVER.checkWhereFragment("id = (SELECT max(y) FROM u GROUP BY z LIMIT 1)", "postgres");
  SERVER.checkWhereFragment("x_limit > 1 AND limit_flag = 1 AND order_no = 2", "mysql");
  SERVER.checkWhereFragment("name = 'GROUP BY x' AND note = 'LIMIT 1' AND `window` = 1", "mysql");
});
check("sanitize: 分号后注释尾巴不算多语句（semiAt 记录原文下标）", () => {
  const sql = "SELECT 1; -- done";
  const s = SERVER.sanitizeSql(sql, "mysql");
  if (s.error) throw new Error(JSON.stringify(s));
  if (s.semiAt !== sql.indexOf(";")) throw new Error("semiAt=" + s.semiAt);
  guardReadOnly(sql, "mysql"); // 不应抛
});
check("stripStatementTail: 注释尾巴/结尾分号/普通语句各形态", () => {
  const t = SERVER.stripStatementTail;
  if (t("SELECT 1; -- done", "mysql") !== "SELECT 1") throw new Error("line-comment tail");
  if (t("SELECT 1; /* c */", "mysql") !== "SELECT 1") throw new Error("block-comment tail");
  if (t("SELECT 1; -- done\n", "postgres") !== "SELECT 1") throw new Error("pg tail");
  if (t("SELECT 1;", "mysql") !== "SELECT 1") throw new Error("bare semi");
  if (t("SELECT 1", "mysql") !== "SELECT 1") throw new Error("plain");
});
check("guard: 注释尾巴后藏第二语句/可执行注释尾巴仍拒绝", () => {
  let msg = "";
  try { guardReadOnly("SELECT 1; /* c */ DROP TABLE t", "mysql"); } catch (e) { msg = e.message || ""; }
  if (!/single|;/i.test(msg)) throw new Error("block-comment smuggling: " + msg);
  try { guardReadOnly("SELECT 1; /*! DROP TABLE t */", "mysql"); } catch (e) { msg = e.message || ""; }
  if (!/single|;|Blocked/i.test(msg)) throw new Error("executable-comment tail: " + msg);
  try { guardReadOnly("SELECT 1; DROP TABLE t", "mysql"); } catch (e) { msg = e.message || ""; }
  if (!/single|;/i.test(msg)) throw new Error("classic multi: " + msg);
});
check("enforceLimit: 注释尾巴语句可包裹（尾巴不进派生表）", () => {
  const w = enforceLimit("SELECT 1; -- done", 10, "mysql");
  if (!/_za_mcp_limit LIMIT 11/.test(w)) throw new Error(w);
  if (/;/.test(w)) throw new Error("tail leaked into wrapper: " + w);
});
check("findcol: mysql 字面子串形状（INSTR/LOWER，%_ 不当通配符）", () => {
  const { sql } = SERVER.findColumnsSql("mysql", { schema: null, column: "a%b_c", limit: 10 });
  if (!/INSTR\(LOWER\(COLUMN_NAME\), LOWER\(\?\)\)/.test(sql) || /LIKE/.test(sql)) throw new Error(sql);
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
check("colstats: mysql/sqlite no cast, pg ::bigint + 类型门控 avg, where passthrough", () => {
  const m = SQLITE.columnStatsSql("mysql", "`t`", "amount", { where: "id > 1" });
  if (m !== "SELECT COUNT(*) AS row_count, COUNT(`amount`) AS non_null, COUNT(DISTINCT `amount`) AS distinct_values, MIN(`amount`) AS min_value, MAX(`amount`) AS max_value, AVG(`amount`) AS avg_value FROM `t` WHERE id > 1") throw new Error(m);
  const p = SQLITE.columnStatsSql("postgres", '"t"', "amount", { where: null });
  if (!p.startsWith("SELECT COUNT(*)::bigint") || !p.includes("COUNT(DISTINCT \"amount\")") || p.includes("WHERE")) throw new Error(p);
  // v1.6.18：pg avg 类型门控钉住——裸 AVG(varchar) 在 PG 是 42883 硬错误（真实库抓获），
  // 文本列 top_values 主用例整条失败；必须 pg_typeof 门控 + CASE 短路后再 cast
  if (!p.includes("pg_typeof") || !/\bAVG\(CASE WHEN/.test(p)) throw new Error(p);
  // 计划期 cast 合法性钉（真实库时间列抓获）：timestamp/date/uuid 等没有 →numeric 注册 cast，
  // 裸 )::numeric 在计划期报 42846 整条画像失败（CASE 短路只挡运行时）——必须 )::text::numeric
  if (!p.includes(")::text::numeric")) throw new Error(p);
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

/* -------- v1.6.20: import 批大小按方言占位符预算 × 列数动态定（原硬编码 100） -------- */
check("import: batch size dialect budget — 窄表封顶（v1.6.46 5000；sqlite cols=5 预算界 4000）", () => {
  for (const db of ["mysql", "postgres", "sqlite"]) {
    if (SQLITE.importBatchSize(db, 4) !== 5000) throw new Error(db + " 窄表(4列)应封顶 5000, got " + SQLITE.importBatchSize(db, 4));
  }
  if (SQLITE.importBatchSize("sqlite", 5) !== 4000) throw new Error("sqlite cols=5 应预算界 4000, got " + SQLITE.importBatchSize("sqlite", 5));
  if (SQLITE.importBatchSize("mysql", 5) !== 5000) throw new Error("mysql cols=5 应仍封顶 5000, got " + SQLITE.importBatchSize("mysql", 5));
});
check("import: batch size 宽表按预算降批 + 非法列数兜底 1 且永不为 0", () => {
  // sqlite 预算 20000: 60 列 → floor(20000/60)=333; mysql/pg 预算 50000: 60 列 → 833
  if (SQLITE.importBatchSize("sqlite", 60) !== 333) throw new Error("sqlite 60列: " + SQLITE.importBatchSize("sqlite", 60));
  if (SQLITE.importBatchSize("mysql", 60) !== 833) throw new Error("mysql 60列: " + SQLITE.importBatchSize("mysql", 60));
  if (SQLITE.importBatchSize("postgres", 60) !== 833) throw new Error("pg 60列: " + SQLITE.importBatchSize("postgres", 60));
  if (SQLITE.importBatchSize("sqlite", 0) !== 5000) throw new Error("cols=0 应按 1 兜底且封顶 5000（v1.6.46）");
  if (SQLITE.importBatchSize("mysql", NaN) !== 5000) throw new Error("NaN 应按 1 兜底且封顶 5000（v1.6.46）");
});

/* -------- v1.6.21: import_data 的 PG 批路径 COPY FROM STDIN（文本格式） -------- */
check("import: COPY 分方言路由——仅 postgres 走 COPY，mysql/sqlite 参数化 INSERT + COPY SQL 形状", () => {
  if (!SQLITE.importUsesCopy("postgres")) throw new Error("postgres 应走 COPY");
  if (SQLITE.importUsesCopy("mysql")) throw new Error("mysql 不应走 COPY");
  if (SQLITE.importUsesCopy("sqlite")) throw new Error("sqlite 不应走 COPY");
  const sql = SQLITE.importCopySql("postgres", '"public"."t"', ["a", "b"]);
  if (sql !== 'COPY "public"."t" ("a", "b") FROM STDIN') throw new Error(sql);
  const zh = SQLITE.importCopySql("postgres", '"表"', ["列1"]);
  if (zh !== 'COPY "表" ("列1") FROM STDIN') throw new Error(zh);
  const q = SQLITE.importCopySql("postgres", '"t"', ['a"b']);
  if (q !== 'COPY "t" ("a""b") FROM STDIN') throw new Error(q);
  for (const db of ["mysql", "sqlite"]) {
    let msg = "";
    try { SQLITE.importCopySql(db, '"t"', ["a"]); } catch (e) { msg = e.message || ""; }
    if (!/仅用于 postgres/.test(msg)) throw new Error(db + " 应拒绝 COPY SQL 构造, got: " + JSON.stringify(msg));
  }
});
check("import: COPY 文本格式转义逐字节保真——NULL/\\N/反斜杠/换行/制表/控制符", () => {
  const eq = (got, want, label) => { if (got !== want) throw new Error(label + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); };
  eq(SQLITE.copyTextField(null), "\\N", "null");
  eq(SQLITE.copyTextField(undefined), "\\N", "undefined");
  eq(SQLITE.copyTextField(""), "", "empty string 非 NULL");
  eq(SQLITE.copyTextField("plain"), "plain", "plain");
  eq(SQLITE.copyTextField("\\N"), "\\\\N", "字面量 \\N 不得坍缩为 NULL");
  eq(SQLITE.copyTextField("a\\b"), "a\\\\b", "backslash");
  eq(SQLITE.copyTextField("x\ty"), "x\\ty", "tab");
  eq(SQLITE.copyTextField("L1\nL2"), "L1\\nL2", "LF");
  eq(SQLITE.copyTextField("L1\r\nL2"), "L1\\r\\nL2", "CRLF（v1.6.13 引号内保真）");
  eq(SQLITE.copyTextField("\b\f\v"), "\\b\\f\\v", "BS/FF/VT");
  eq(SQLITE.copyTextPayload([["a", null], ["x\ty", "z\nw"]]), "a\t\\N\nx\\ty\tz\\nw\n", "payload 字段 TAB/记录 LF");
  eq(SQLITE.copyTextPayload([["\\N"]]), "\\\\N\n", "payload 字面量 \\N");
  eq(SQLITE.copyTextPayload([]), "", "empty rows");
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

/* -------- v1.6.37 行转换钉：zipRows 常量键工厂差分 / __proto__ 慢路径语义 / 对抗列名+缓存隔离
            （sqlite 产品路径钉在下方 pool 段） -------- */
check("zipRows: 常量键工厂 vs 冻结旧实现差分钉（v1.6.37 防行转换语义漂移）", () => {
  // 冻结的 pre-1.6.37 逐格循环实现（真源对照；__proto__ 语义缺陷不在差分范围，见专项手写钉）
  const zipOld = (fields, arrayRows) => {
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
  };
  // 序列化带类型标记：bigint/NaN/±Infinity/undefined 不被 JSON 静默折叠成同形
  const S = (x) => JSON.stringify(x, (k, v) => {
    if (typeof v === "bigint") return { $b: String(v) };
    if (typeof v === "number" && !Number.isFinite(v)) return { $n: String(v) };
    if (v === undefined) return { $u: 1 };
    return v;
  });
  const cases = [
    ["常规列", ["id", "name", "amount"], [[1, "a", 1.5], [2, null, 0]]],
    ["重复列名消歧", ["id", "id", "name"], [[1, 2, "x"], [3, 4, "y"]]],
    ["三重复+空名+数字形名", ["", "", "1", "0x"], [[1, 2, 3, 4]]],
    ["对抗名（引号/反斜杠/换行/U+2028/孤立代理项/原型方法名）",
      ['q"uote', "back\\slash", "ne\nw", " ", "\uD800", "constructor", "toString"],
      [["v1", "v2", "v3", "v4", "v5", "v6", "v7"]]],
    ["多类型值（BigInt/NaN/±Inf/undefined/null）", ["a", "b", "c", "d", "e", "f"],
      [[9007199254740993n, NaN, Infinity, -Infinity, undefined, null]]],
    ["空结果", ["x", "y"], []],
  ];
  for (const [label, fields, arr] of cases) {
    const cur = POOL.zipRows(fields, arr);
    const old = zipOld(fields, arr);
    if (S(cur.rows) !== S(old.rows) || S(cur.renamed) !== S(old.renamed) || S(cur.fields) !== S(old.fields)) {
      throw new Error(`差分失败 ${label}: ${S(cur)} vs ${S(old)}`);
    }
    cur.rows.forEach((row, i) => {
      const k1 = Object.keys(row).join(" ");
      const k2 = Object.keys(old.rows[i]).join(" ");
      if (k1 !== k2) throw new Error(`键序漂移 ${label}#${i}: ${JSON.stringify(k1)} vs ${JSON.stringify(k2)}`);
    });
  }
  // >512 列逃生阀走逐格慢路径，与旧实现字节恒等
  const wide = Array.from({ length: 600 }, (_, i) => "c" + i);
  const wideRows = [Array.from({ length: 600 }, (_, i) => i * 2)];
  const wc = POOL.zipRows(wide, wideRows);
  const wo = zipOld(wide, wideRows);
  if (S(wc.rows) !== S(wo.rows) || wc.fields.join() !== wo.fields.join()) throw new Error("600 列逃生阀差分失败");
  if (Object.keys(wc.rows[0]).length !== 600) throw new Error("600 列行键数不对: " + Object.keys(wc.rows[0]).length);
});
check("zipRows: __proto__ 列名手写期望钉（v1.6.37 defineProperty 慢路径；旧实现在此静默丢值/换原型）", () => {
  const r = POOL.zipRows(["__proto__", "id"], [["p1", 5]]);
  const row = r.rows[0];
  if (!Object.prototype.hasOwnProperty.call(row, "__proto__")) throw new Error("__proto__ 自有属性丢失");
  const d = Object.getOwnPropertyDescriptor(row, "__proto__");
  if (!d || d.value !== "p1") throw new Error("__proto__ 值丢失/被改: " + JSON.stringify(d));
  if (row.id !== 5) throw new Error("普通列受波及");
  if (Object.getPrototypeOf(row) !== Object.prototype) throw new Error("行原型被 __proto__ 列值篡改");
  if (JSON.stringify(row) !== '{"__proto__":"p1","id":5}') throw new Error("JSON视图丢 __proto__: " + JSON.stringify(row));
  // 对象值不得换原型（旧实现在此把 [[Prototype]] 换成该对象，再取 a 得 1 的假象）
  const r2 = POOL.zipRows(["__proto__"], [[{ a: 1 }]]);
  const row2 = r2.rows[0];
  if (Object.getPrototypeOf(row2) !== Object.prototype) throw new Error("对象值型 __proto__ 篡改了原型");
  const d2 = Object.getOwnPropertyDescriptor(row2, "__proto__");
  if (!d2 || typeof d2.value !== "object" || d2.value.a !== 1) throw new Error("__proto__ 对象值丢失");
  // 重复列名消歧与 __proto__ 并存
  const r3 = POOL.zipRows(["a", "__proto__", "a"], [[1, "p", 2]]);
  const row3 = r3.rows[0];
  if (row3.a !== 1 || row3.a__2 !== 2) throw new Error("重复名消歧受波及: " + JSON.stringify(r3.rows));
  const d3 = Object.getOwnPropertyDescriptor(row3, "__proto__");
  if (!d3 || d3.value !== "p") throw new Error("__proto__ 与消歧并存失败: " + JSON.stringify(d3));
  if (Object.getPrototypeOf(row3) !== Object.prototype) throw new Error("并存场景原型被篡改");
});
check("zipRows: 对抗列名 + 工厂缓存隔离钉（v1.6.37 常量键工厂）", () => {
  const names = ['q"uote', "back\\slash", "ne\nw", " ", "\uD800", "constructor", "toString", "", "1", "0x"];
  const r = POOL.zipRows(names, [names.map((_, i) => "v" + i)]);
  const row = r.rows[0];
  names.forEach((n, i) => {
    if (!Object.prototype.hasOwnProperty.call(row, n)) throw new Error(`键丢失: ${JSON.stringify(n)}`);
    if (row[n] !== "v" + i) throw new Error(`值漂移 ${JSON.stringify(n)}: ${JSON.stringify(row[n])}`);
  });
  if (Object.keys(row).length !== names.length) throw new Error("键数漂移: " + Object.keys(row).length);
  // 工厂缓存按列名集隔离：交替列名集不串味（缓存键 = JSON.stringify(names)）
  const a1 = POOL.zipRows(["x", "y"], [[1, 2]]);
  const b1 = POOL.zipRows(["x", "z"], [[3, 4]]);
  const a2 = POOL.zipRows(["x", "y"], [[5, 6]]);
  if (a1.rows[0].y !== 2 || b1.rows[0].z !== 4 || b1.rows[0].y !== undefined) throw new Error("缓存串味（B 混入 A 的键）");
  if (a2.rows[0].y !== 6 || a2.rows[0].z !== undefined || Object.keys(a2.rows[0]).join() !== "x,y") throw new Error("缓存串味（A 二次调用漂移）");
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

/* --- v1.6.3: getPool 首触去重——并发冷启动必须共享同一连接（旧版各建一个，孤儿连接泄漏） --- */
await checkAsync("pool: 并发首触 getPool 返回同一连接（创建去重，无孤儿连接）", async () => {
  const { createPoolManager } = POOL;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-race-"));
  try {
    const dbf = path.join(tmp, "r.db").replace(/\\/g, "/");
    const sources = { s: { type: "sqlite", url: "sqlite://" + dbf } };
    const mgr = createPoolManager({ cfg: { timeoutMs: 5000 }, getSource: (id) => sources[id], clampInt: (v, a, b, d) => d, sqliteFilePath: () => dbf });
    // 两条并发首查（distinct_values 的 Promise.all 形态）：sqlite 创建含 await import 让出点，
    // 旧版在此窗口各自 new DatabaseSync——后者覆盖 Map，前者成孤儿（句柄泄漏、LRU 管不到）。
    const [p1, p2] = await Promise.all([mgr.getPool("s"), mgr.getPool("s")]);
    if (p1 !== p2) throw new Error("并发首触拿到了两个连接对象（创建未去重）");
    if (mgr._pools.get("s") !== p1) throw new Error("Map 中驻留的不是共享连接");
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});

/* -------- v1.6.35 优化回归钉：sanitizeSql 嵌套缓存键 + sqlite 预编译句柄缓存 -------- */
check("guard: sanitizeSql 嵌套缓存键（v1.6.35）命中同对象 / k-m 槽不串 / 方言槽不串 / 等长不变量", () => {
  GUARD.setSanitizeCache(true);
  const sql = "SELECT id, `db`.`t`.`name` FROM `db`.`t` WHERE name = 'x' -- c";
  const r1 = GUARD.sanitizeSql(sql, "mysql");
  const r2 = GUARD.sanitizeSql(sql, "mysql");
  if (r1 !== r2) throw new Error("同参未命中同一缓存对象");
  const k1 = GUARD.sanitizeSql(sql, "mysql", { keepLiterals: true });
  const k2 = GUARD.sanitizeSql(sql, "mysql", { keepLiterals: true });
  if (k1 !== k2) throw new Error("keepLiterals 槽未命中同一对象");
  if (k1 === r1) throw new Error("k/m 两槽串位（同 SQL 不同模式共用槽）");
  if (r1.text.includes("'x'") || r1.text.includes("`db`")) throw new Error("掩码模式应抹掉字符串与引号标识符: " + r1.text.slice(0, 80));
  if (!k1.text.includes("'x'") || !k1.text.includes("`db`.`t`.`name`")) throw new Error("keepLiterals 应保留字符串与引号标识符原文: " + k1.text.slice(0, 80));
  if (r1.text.includes("--") || k1.text.includes("--")) throw new Error("两种模式都应抹掉注释");
  if (r1.text.length !== sql.length || k1.text.length !== sql.length) throw new Error("等长不变量破坏: " + r1.text.length + "/" + k1.text.length + " vs " + sql.length);
  const p1 = GUARD.sanitizeSql(sql, "postgres");
  if (p1 === r1 || p1 === k1) throw new Error("方言槽串位");
});
check("guard: setSanitizeCache(false) 绕过 + 溢出整清后重算恒等（v1.6.35）", () => {
  const sql = "SELECT 1 + 1 AS n";
  GUARD.setSanitizeCache(true);
  const a1 = GUARD.sanitizeSql(sql, "mysql");
  GUARD.setSanitizeCache(false);
  const b1 = GUARD.sanitizeSql(sql, "mysql");
  const b2 = GUARD.sanitizeSql(sql, "mysql");
  if (b1 === a1 || b1 === b2) throw new Error("关闭态必须每次新算（不缓存不命中）");
  if (b1.text !== a1.text) throw new Error("关闭态计算结果漂移");
  GUARD.setSanitizeCache(true);
  const c1 = GUARD.sanitizeSql(sql, "mysql");
  const c2 = GUARD.sanitizeSql(sql, "mysql");
  if (c1 !== c2 || c1 === b1) throw new Error("恢复后应重建缓存并命中");
  // 溢出：同槽位灌 40 条不同 SQL（上限 32 整清），被清条目重算结果必须恒等
  for (let i = 0; i < 40; i++) GUARD.sanitizeSql("SELECT " + i + " AS v /* r" + i + " */", "mysql");
  const d1 = GUARD.sanitizeSql(sql, "mysql");
  if (d1.text !== c1.text) throw new Error("溢出整清后重算结果漂移");
  if (d1 === c1) throw new Error("被清条目应重算（新对象）");
});
await checkAsync("pool: sqlite 预编译句柄缓存（v1.6.35）同 SQL 参数化重绑定 / BigInt 保真 / 重名前置拒绝在缓存路径", async () => {
  const { createPoolManager, setSqliteStmtCache } = POOL;
  if (typeof setSqliteStmtCache !== "function") throw new Error("setSqliteStmtCache missing");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-stmt-"));
  try {
    const dbf = path.join(tmp, "c.db").replace(/\\/g, "/");
    const sources = { s: { type: "sqlite", url: "sqlite://" + dbf } };
    const mgr = createPoolManager({ cfg: { timeoutMs: 5000 }, getSource: (id) => sources[id], clampInt: (v, a, b, d) => d, sqliteFilePath: () => dbf });
    setSqliteStmtCache(true);
    await mgr.runQuery("s", "CREATE TABLE k (id INTEGER PRIMARY KEY, name TEXT, big INTEGER)");
    await mgr.runQuery("s", "INSERT INTO k VALUES (1, 'a', 9007199254740993)");
    await mgr.runQuery("s", "INSERT INTO k VALUES (2, 'b', 7)");
    // 重绑定：同一 SQL 反复按参数取不同行——缓存句柄换绑不串值（首查 miss 装入，后续 hit）
    const q = "SELECT name FROM k WHERE id = ?";
    const n1 = (await mgr.runQuery("s", q, [1])).rows[0].name;
    const n2 = (await mgr.runQuery("s", q, [2])).rows[0].name;
    const n3 = (await mgr.runQuery("s", q, [1])).rows[0].name;
    if (n1 !== "a" || n2 !== "b" || n3 !== "a") throw new Error("参数化重绑定串值: " + [n1, n2, n3].join(","));
    // BigInt 保真：setReadBigInts(true) 在缓存装入时设，复用后超安全整数仍为 BigInt（不被静默转数丢精度）
    const g1 = (await mgr.runQuery("s", "SELECT big FROM k WHERE id = ?", [1])).rows[0].big;
    const g2 = (await mgr.runQuery("s", "SELECT big FROM k WHERE id = ?", [1])).rows[0].big;
    if (typeof g1 !== "bigint" || g1 !== 9007199254740993n) throw new Error("BigInt 保真破坏（首查）: " + typeof g1 + " " + g1);
    if (typeof g2 !== "bigint" || g2 !== 9007199254740993n) throw new Error("BigInt 保真破坏（缓存复用）: " + typeof g2 + " " + g2);
    // 重名前置拒绝必须在缓存路径同样生效（二次调用命中缓存也不放行静默折叠）
    let e1 = "", e2 = "";
    try { await mgr.runQuery("s", "SELECT id, id FROM k"); } catch (e) { e1 = e.message; }
    try { await mgr.runQuery("s", "SELECT id, id FROM k"); } catch (e) { e2 = e.message; }
    if (!/重复|别名/.test(e1) || !/重复|别名/.test(e2)) throw new Error("重名前置拒绝缓存路径失效: " + JSON.stringify([e1, e2]));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});
await checkAsync("pool: sqlite 句柄缓存（v1.6.35）早停后全量再流式 / 64 上限轮转正确 / setSqliteStmtCache 逃生阀语义等价", async () => {
  const { createPoolManager, setSqliteStmtCache } = POOL;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-stmt2-"));
  try {
    const dbf = path.join(tmp, "c2.db").replace(/\\/g, "/");
    const sources = { s: { type: "sqlite", url: "sqlite://" + dbf } };
    const mgr = createPoolManager({ cfg: { timeoutMs: 5000 }, getSource: (id) => sources[id], clampInt: (v, a, b, d) => d, sqliteFilePath: () => dbf });
    setSqliteStmtCache(true);
    await mgr.runQuery("s", "CREATE TABLE k (id INTEGER PRIMARY KEY, name TEXT)");
    await mgr.runQuery("s", "INSERT INTO k VALUES (1, 'a')");
    await mgr.runQuery("s", "INSERT INTO k VALUES (2, 'b')");
    await mgr.runQuery("s", "INSERT INTO k VALUES (3, 'c')");
    const sq = "SELECT id, name FROM k ORDER BY id";
    // 早停流（第 1 行即停）后，同 SQL 全量再流必须完整——缓存句柄不留半步 iterate 状态
    const first = [];
    await mgr.runQueryStream("s", sq, { onFields: () => {}, onRow: (row) => { first.push(row); return false; } });
    const full = [];
    await mgr.runQueryStream("s", sq, { onFields: () => {}, onRow: (row) => { full.push(row); } });
    if (first.length !== 1) throw new Error("早停流应只收 1 行: " + first.length);
    if (full.length !== 3 || full[0].name !== "a" || full[2].name !== "c") throw new Error("早停后再全量流式丢行/串值: " + JSON.stringify(full));
    // 64 条上限轮转（超限整清策略）：70 条独特 SQL 各查两遍，值必须全对；被清条目复查也正确
    //（setReadBigInts 口径下整数列为 BigInt，比较走 Number——与 withTransaction 钉同款）
    let rotOk = true;
    for (let i = 0; i < 70; i++) {
      const r = await mgr.runQuery("s", "SELECT " + i + " AS v, name FROM k WHERE id = 1");
      if (Number(r.rows[0].v) !== i || r.rows[0].name !== "a") rotOk = false;
    }
    const back = (await mgr.runQuery("s", "SELECT name FROM k WHERE id = ?", [2])).rows[0].name;
    if (!rotOk || back !== "b") throw new Error("64 上限轮转后结果漂移: back=" + back);
    // 逃生阀：关闭后逐次 prepare 语义等价（结果一致），恢复后缓存继续工作
    setSqliteStmtCache(false);
    const o1 = (await mgr.runQuery("s", "SELECT name FROM k WHERE id = ?", [1])).rows[0].name;
    const o2 = (await mgr.runQuery("s", "SELECT name FROM k WHERE id = ?", [3])).rows[0].name;
    setSqliteStmtCache(true);
    const o3 = (await mgr.runQuery("s", "SELECT name FROM k WHERE id = ?", [1])).rows[0].name;
    if (o1 !== "a" || o2 !== "c" || o3 !== "a") throw new Error("逃生阀路径语义漂移: " + [o1, o2, o3].join(","));
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
  // v1.6.20 续修钉：PG 的 LEAST 忽略 NULL 参数（LEAST(NULL, n-1)=n-1 顶成末桶漏过滤），
  // 钳位必须 CASE 显式透传 NULL；mysql LEAST / sqlite MIN 本身 NULL 透传无需包裹。
  const pgShape = SERVER.histogramStatsSql("postgres", '"s"."t"', "v", { buckets: 3 });
  if (!/IS NULL THEN NULL ELSE LEAST\(CAST\(FLOOR\(/i.test(pgShape)) {
    throw new Error("pg must null-passthrough before LEAST clamp (LEAST ignores NULL args in PG): " + pgShape.slice(0, 260));
  }
  if (!/FROM `db`\.`t` t CROSS JOIN buckets b WHERE t\.`amount` IS NOT NULL AND \(status = 'ok'\)/.test(mysql)) throw new Error("where must apply to source rows (nulls excluded, parenthesized): " + mysql.slice(0, 260));
  // v1.6.1 真实库实测修正：bounds 引用 b.lo/b.width 必须一并进 GROUP BY（ONLY_FULL_GROUP_BY）
  if (!/GROUP BY s\.bi, b\.lo, b\.width ORDER BY s\.bi/.test(mysql)) throw new Error("must group by bucket index + bounds: " + mysql.slice(-120));
  const sq = SERVER.histogramStatsSql("sqlite", '"t"', "v", { buckets: 5, where: null });
  if (!/MIN\(CAST\(FLOOR\(/i.test(sq) || !/, 4\)/.test(sq)) throw new Error("pg/sqlite clamp via MIN(x, buckets-1): " + sq.slice(0, 200));
  if (/ AND \(/.test(sq)) throw new Error("no where -> only IS NOT NULL: " + sq.slice(0, 240));
  if (/;\s*\S/.test(sq)) throw new Error("must stay single statement");
  // v1.6.20 真实库实测锚定：文本列直方图——PG 类型门控减法（text-text 是 42883 硬错误，
  // 与 v1.6.18 AVG 同族）+ 三库统一 GROUP BY 前滤 NULL 桶号（非数值列收口为空数组，不炸不脏）。
  const pgt = SERVER.histogramStatsSql("postgres", '"s"."t"', "tag", { buckets: 4 });
  if (!/pg_typeof/.test(pgt) || !/'smallint'::regtype/.test(pgt)) throw new Error("pg must type-gate subtraction: " + pgt.slice(0, 320));
  // 与 avg 同族的 42846 计划期钉：histogram 的 numv 减法也必须走 ::text::numeric（时间列裸 ::numeric 计划期整条失败）
  if (!pgt.includes(")::text::numeric")) throw new Error("histogram numv must cast via ::text::numeric: " + pgt.slice(0, 320));
  if (!/WHERE s\.bi IS NOT NULL/.test(mysql) || !/WHERE s\.bi IS NOT NULL/.test(pgt) || !/WHERE s\.bi IS NOT NULL/.test(sq)) {
    throw new Error("all dialects must drop NULL-bucket rows before GROUP BY");
  }
  // 残洞（真实库第 25 轮抓获）：mysql 时间列脏桶——DATETIME/DATE 隐式转数读数字头（'2024-01-01
  // 00:00:05' → 20240101000005），桶界产出 20240101000000.00000 伪数值脏桶，破「非数值列 → 空数组」
  // 承诺（v1.6.20 三库收口唯 mysql 时间列漏网）。mysql 减法前必须按值形状门控（REGEXP 数值形状、
  // 字符类 [.] 免字面量反斜杠转义歧义）；数值样文本照旧放行 GIGO；pg/sqlite 路径不得引入 REGEXP。
  const hmy = SERVER.histogramStatsSql("mysql", "`t_hg`", "ts", { buckets: 5 });
  if (!hmy.includes("REGEXP '^[+-]?[0-9]+")) throw new Error("mysql must shape-gate values before subtraction: " + hmy.slice(0, 320));
  if (!hmy.includes("[.]")) throw new Error("shape pattern must use [.] (SQL literal backslash-escape hazard): " + hmy.slice(0, 320));
  if (!hmy.includes("THEN t.`ts` END")) throw new Error("gated expr must pass value through unchanged: " + hmy.slice(0, 320));
  if (!mysql.includes("THEN t.`amount` END")) throw new Error("numeric column values must pass the shape gate: " + mysql.slice(0, 320));
  const hp2 = SERVER.histogramStatsSql("postgres", '"s"."t"', "ts", { buckets: 5 });
  if (hp2.includes("REGEXP")) throw new Error("pg keeps typeof gate only: " + hp2.slice(0, 200));
  const hs2 = SERVER.histogramStatsSql("sqlite", '"t"', "ts", { buckets: 5 });
  if (hs2.includes("REGEXP")) throw new Error("sqlite keeps native coercion path: " + hs2.slice(0, 200));
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

/* -------- v1.6.25 .dbp 参数简写解析（resolveDbpArg 注入式 fixture，无需真实 .dbp / 不触盘） -------- */
check("dbeaver: .dbp 参数解析——完整路径/同级目录裸名/通配符（cwd→脚本目录回退、大小写不敏感）", () => {
  const root = path.resolve("selftest-dbp-fixtures");
  const W = path.join(root, "w"), S = path.join(root, "s"), E = path.join(root, "e"), C = path.join(root, "c");
  const files = new Set([
    path.join(W, "x.dbp"), path.join(W, "notes.txt"), path.join(W, "sub", "c.dbp"),
    path.join(S, "保险-20260929.dbp"), path.join(C, "one.dbp"),
  ]);
  const tree = {
    [W]: ["x.dbp", "notes.txt", "sub"], [path.join(W, "sub")]: ["c.dbp"],
    [S]: ["保险-20260929.dbp"], [E]: [], [C]: ["one.dbp"],
  };
  const io = (cwd, scriptDir) => ({ cwd, scriptDir, listDir: (d) => tree[d] || [], isFile: (p) => files.has(p) });
  // ① 完整路径透传
  let r = DBP.resolveDbpArg(path.join(W, "x.dbp"), io(W, S));
  if (!r.ok || r.file !== path.join(W, "x.dbp")) throw new Error("完整路径: " + JSON.stringify(r));
  // ② 裸文件名先命中 cwd
  r = DBP.resolveDbpArg("x.dbp", io(W, S));
  if (!r.ok || r.file !== path.join(W, "x.dbp")) throw new Error("cwd 裸名: " + JSON.stringify(r));
  // ③ 裸文件名 cwd 没有 → 回退脚本目录（同级目录简写语义）
  r = DBP.resolveDbpArg("保险-20260929.dbp", io(W, S));
  if (!r.ok || r.file !== path.join(S, "保险-20260929.dbp")) throw new Error("脚本目录裸名: " + JSON.stringify(r));
  // ④ 相对子路径（/ 与 \ 同义）
  r = DBP.resolveDbpArg("sub/c.dbp", io(W, S));
  if (!r.ok || r.file !== path.join(W, "sub", "c.dbp")) throw new Error("相对子路径: " + JSON.stringify(r));
  // ⑤ 通配符唯一命中（脚本目录无 .dbp 时命中 cwd；目录项/非 .dbp 不误收；
  //    cwd 与脚本目录各有命中时按设计报 ambiguous——由失败钉覆盖）
  r = DBP.resolveDbpArg("*.dbp", io(W, E));
  if (!r.ok || r.file !== path.join(W, "x.dbp")) throw new Error("通配符 cwd: " + JSON.stringify(r));
  // ⑥ 通配符 cwd 无匹配 → 回退脚本目录唯一命中
  r = DBP.resolveDbpArg("*.dbp", io(E, S));
  if (!r.ok || r.file !== path.join(S, "保险-20260929.dbp")) throw new Error("通配符脚本目录回退: " + JSON.stringify(r));
  // ⑦ 通配符大小写不敏感（cmd 引号内不展开场景的真实形态）
  r = DBP.resolveDbpArg("*.DBP", io(C, E));
  if (!r.ok || r.file !== path.join(C, "one.dbp")) throw new Error("通配符大小写: " + JSON.stringify(r));
  // ⑧ 目录段通配符
  r = DBP.resolveDbpArg("sub/*.dbp", io(W, S));
  if (!r.ok || r.file !== path.join(W, "sub", "c.dbp")) throw new Error("目录段通配符: " + JSON.stringify(r));
  // ⑨ 字面名大小写不敏感唯一回退（Windows 文件系统语义）
  r = DBP.resolveDbpArg("X.DBP", io(W, S));
  if (!r.ok || r.file !== path.join(W, "x.dbp")) throw new Error("字面大小写回退: " + JSON.stringify(r));
});
check("dbeaver: .dbp 参数解析——零匹配/多匹配/大小写歧义一律拒绝并列候选（不静默挑一个）", () => {
  const root = path.resolve("selftest-dbp-fixtures");
  const W = path.join(root, "w"), E = path.join(root, "e"), M = path.join(root, "m"), D = path.join(root, "d");
  const files = new Set([path.join(M, "m1.dbp"), path.join(M, "m2.dbp"), path.join(D, "a.dbp"), path.join(D, "A.dbp")]);
  const tree = { [M]: ["m1.dbp", "m2.dbp"], [D]: ["a.dbp", "A.dbp"], [E]: [] };
  const io = (cwd, scriptDir) => ({ cwd, scriptDir, listDir: (d) => tree[d] || [], isFile: (p) => files.has(p) });
  // ① 通配符零匹配：报 no-match 并列出搜索目录
  let r = DBP.resolveDbpArg("*.dbp", io(E, E));
  if (r.ok || r.code !== "no-match" || !r.message.includes("通配符未匹配") || !r.message.includes(E)) throw new Error("零匹配: " + JSON.stringify(r));
  // ② 通配符多匹配：报 ambiguous 并列全候选
  r = DBP.resolveDbpArg("*.dbp", io(M, E));
  if (r.ok || r.code !== "ambiguous" || (r.candidates || []).length !== 2 || !r.message.includes("m1.dbp") || !r.message.includes("m2.dbp")) throw new Error("多匹配: " + JSON.stringify(r));
  // ③ 字面名不存在：报 no-match 并列出尝试过的绝对路径
  r = DBP.resolveDbpArg("missing.dbp", io(W, E));
  if (r.ok || r.code !== "no-match" || !r.message.includes("文件不存在") || !r.message.includes(path.resolve(W, "missing.dbp"))) throw new Error("字面缺失: " + JSON.stringify(r));
  // ④ 字面名大小写变体多个：同拒（ambiguous，不猜哪个）
  r = DBP.resolveDbpArg("a.DBp", io(D, E));
  if (r.ok || r.code !== "ambiguous" || (r.candidates || []).length !== 2) throw new Error("大小写歧义: " + JSON.stringify(r));
});
check("dbeaver: .dbp 简写解析接线（install.mjs 与 import-dbeaver.mjs 均经 resolveDbpArg，防改名漂移）", () => {
  const installTxt = fs.readFileSync(path.join(here, "..", "install.mjs"), "utf8");
  const importTxt = fs.readFileSync(path.join(here, "import-dbeaver.mjs"), "utf8");
  if (!installTxt.includes("resolveDbpArg") || !importTxt.includes("resolveDbpArg")) throw new Error("接线缺失：调用方未引用 resolveDbpArg");
  if (typeof DBP.resolveDbpArg !== "function") throw new Error("dbeaver-parse.mjs 未导出 resolveDbpArg");
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
check("mcp: tools/list exposes exactly the 18 documented tools", () => {
  const names = tl.result.tools.map((t) => t.name).sort();
  const expected = ["list_sources", "list_tables", "describe_table", "find_tables_by_column", "fk_relationships", "query", "query_plan", "sample_data", "distinct_values", "column_stats", "count_rows", "execute", "create_table", "find_database", "export_data", "import_data", "server_stats", "reload_config"].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error("tool set drift — got: " + names.join(","));
  }
});
check("mcp: 工具声明形状完整（title + annotations + inputSchema 收口）", () => {
  for (const t of tl.result.tools) {
    if (typeof t.title !== "string" || !t.title.trim()) throw new Error(`${t.name}: missing/empty title`);
    if (!t.annotations || typeof t.annotations !== "object") throw new Error(`${t.name}: missing annotations`);
    if (t.inputSchema?.type !== "object" || t.inputSchema?.additionalProperties !== false) {
      throw new Error(`${t.name}: inputSchema must be type=object with additionalProperties:false`);
    }
  }
});
check("mcp: 全部工具 description 含用法示例（Example: {json}）", () => {
  for (const t of tl.result.tools) {
    if (typeof t.description !== "string" || !t.description.includes("Example: {")) {
      throw new Error(`${t.name}: description missing Example: usage`);
    }
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
{
  const ss = await handleRpc({ jsonrpc: "2.0", id: 88, method: "tools/call", params: { name: "server_stats", arguments: {} } });
  check("obs: server_stats 部署态钉（v1.6.54）未初始化显式 init_required 提示 / 已初始化 version+形状", () => {
    const t = ss.result?.content?.[0]?.text || "";
    if (initMode) {
      const d = JSON.parse(t);
      if (d.init_required !== true || !d.note) throw new Error("未初始化未给显式提示: " + t.slice(0, 120));
    } else {
      const d = JSON.parse(t);
      if (!d.version || !Array.isArray(d.per_source) || !Array.isArray(d.recent_slow) || typeof d.slow_ms_threshold !== "number") throw new Error("init 形状: " + t.slice(0, 160));
    }
  });
}
/* v1.6.5 错误语义标准化：稳定错误码（分类纯钉 + 回环格式钉）。错误原文必须逐字保留在标签后。 */
check("errcode: 安全红线 → E_SAFETY:no-retry", () => {
  const m = classifyError(new Error("安全红线：拒绝执行无 WHERE 条件的 UPDATE/DELETE（会导致全表数据被覆盖/清空）。"));
  if (m.code !== "E_SAFETY" || m.retry !== "no-retry") throw new Error(JSON.stringify(m));
});
check("errcode: 只读守卫 → E_SAFETY:no-retry", () => {
  const m = classifyError(new Error("Blocked by read-only guard: found 'DELETE' outside string literals."));
  if (m.code !== "E_SAFETY" || m.retry !== "no-retry") throw new Error(JSON.stringify(m));
});
check("errcode: 参数校验 → E_PARAM:no-retry", () => {
  const m = classifyError(new Error("Invalid 'max_rows': must be >= 1, got 0."));
  if (m.code !== "E_PARAM" || m.retry !== "no-retry") throw new Error(JSON.stringify(m));
});
check("errcode: Unknown source → E_NOT_FOUND:no-retry", () => {
  const m = classifyError(new Error("Unknown source 'x'. Available sources: demo"));
  if (m.code !== "E_NOT_FOUND" || m.retry !== "no-retry") throw new Error(JSON.stringify(m));
});
check("errcode: 未初始化 → E_CONFIG:no-retry", () => {
  const m = classifyError(new Error("尚未初始化连接配置（dbmcp.config.json 不存在）。"));
  if (m.code !== "E_CONFIG" || m.retry !== "no-retry") throw new Error(JSON.stringify(m));
});
check("errcode: 超上限 → E_LIMIT:conditional", () => {
  const m = classifyError(new Error("导出内容超过上限 10485760 字节（组装期早停，未写盘）。请用 limit 参数缩小范围后重试。"));
  if (m.code !== "E_LIMIT" || m.retry !== "conditional") throw new Error(JSON.stringify(m));
});
check("errcode: 连接类驱动错误 → E_DB:retryable", () => {
  const e = new Error("connect ECONNREFUSED 127.0.0.1:3306"); e.code = "ECONNREFUSED";
  const m = classifyError(e);
  if (m.code !== "E_DB" || m.retry !== "retryable") throw new Error(JSON.stringify(m));
});
check("errcode: 语法/约束类驱动错误 → E_DB:no-retry", () => {
  const e = new Error("You have an error in your SQL syntax"); e.code = "ER_PARSE_ERROR";
  const m = classifyError(e);
  if (m.code !== "E_DB" || m.retry !== "no-retry") throw new Error(JSON.stringify(m));
});
check("errcode: 批写入结果未知 → E_DB:conditional", () => {
  const m = classifyError(new Error("批写入结果未知（超时/连接中断，安全中止、不自动回退）：第 1-100 行可能已全部或部分写入。"));
  if (m.code !== "E_DB" || m.retry !== "conditional") throw new Error(JSON.stringify(m));
});
check("errcode: 未知错误兜底 → E_INTERNAL:no-retry（fail-closed）", () => {
  const m = classifyError(new Error("something odd"));
  if (m.code !== "E_INTERNAL" || m.retry !== "no-retry") throw new Error(JSON.stringify(m));
});
check("errcode: 查询/执行超时三形态统一 E_DB:conditional（真实库超时抓获）", () => {
  // pg query_timeout 无 code 报文 / pg statement_timeout 57014 / mysql2 PROTOCOL_SEQUENCE_TIMEOUT——
  // 此前散落 E_INTERNAL 兜底与 E_DB:no-retry 三口径；超时是条件态（改范围可成），统一 conditional
  const a = classifyError(new Error("Query read timeout"));
  const b = classifyError(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
  const c = classifyError(Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" }));
  for (const m of [a, b, c]) if (m.code !== "E_DB" || m.retry !== "conditional") throw new Error(JSON.stringify(m));
});
check("errcode: 连接建立超时 ETIMEDOUT 仍 E_DB:retryable（不与查询超时混类）", () => {
  const m = classifyError(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
  if (m.code !== "E_DB" || m.retry !== "retryable") throw new Error(JSON.stringify(m));
});
await checkAsync("errcode: 错误回环格式 `Error: [E_CODE:retry] 原文` 兼容子串匹配", async () => {
  const r = await handleRpc({ jsonrpc: "2.0", id: 88, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
  const t = r.result?.content?.[0]?.text || "";
  if (!r.result?.isError) throw new Error("expected isError:true");
  if (!/^Error: \[E_PARAM:no-retry\] /.test(t)) throw new Error("missing/incorrect code tag: " + t.slice(0, 80));
  if (!t.includes("Unknown tool")) throw new Error("original message lost: " + t.slice(0, 120));
});
check("errcode: ToolError 显式标签优先于消息模式匹配", () => {
  // 消息含"安全红线"（模式匹配会误判 E_SAFETY），显式标签必须获胜——这是 v1.6.6 消除模式脆弱性的核心保证
  const e = new ToolError("E_LIMIT", "安全红线：假消息用于验证标签优先", "conditional");
  const m = classifyError(e);
  if (m.code !== "E_LIMIT" || m.retry !== "conditional") throw new Error(JSON.stringify(m));
});
check("errcode: ToolError 缺省重试态按码映射（E_SAFETY→no-retry / E_LIMIT→conditional）", () => {
  const a = classifyError(new ToolError("E_SAFETY", "x"));
  const b = classifyError(new ToolError("E_LIMIT", "x"));
  if (a.retry !== "no-retry" || b.retry !== "conditional") throw new Error(JSON.stringify({ a, b }));
});
/* v1.6.8 真实测试修复回归钉：Unicode 标识符（中文表/列名是国内库常态，旧版纯 ASCII 正则全拒） */
check("unicode: splitIdent 接受中文/Unicode 标识符并拒绝注入形态", () => {
  const a = splitIdent("订单表");
  const b = splitIdent("业务库.订单表");
  if (a.table !== "订单表" || a.schema !== null) throw new Error("plain CJK ident: " + JSON.stringify(a));
  if (b.table !== "订单表" || b.schema !== "业务库") throw new Error("qualified CJK ident: " + JSON.stringify(b));
  // ASCII 下划线/数字组合不得回归（v1.6.8 修复过续位字符类漏 `_` 致 customers_copy 被拒）
  for (const name of ["customers_copy", "order_items", "col_1", "_tmp", "a$b"]) {
    if (splitIdent(name).table !== name) throw new Error("ASCII ident rejected: " + name);
  }
  let threw = false;
  try { splitIdent('a"; DROP TABLE x'); } catch { threw = true; }
  if (!threw) throw new Error("injection form must be rejected");
  threw = false;
  try { splitIdent("a.b.c"); } catch { threw = true; }
  if (!threw) throw new Error("3-part name must be rejected");
  threw = false;
  try { splitIdent("1abc"); } catch { threw = true; }
  if (!threw) throw new Error("digit-leading ident must be rejected");
});
check("unicode: 红线列引用检测认中文列，恒真条件仍被识破", () => {
  if (!exprHasColumn("订单号='D001'")) throw new Error("CJK column ref not recognized");
  if (!exprHasColumn("金额>100 AND 状态='done'")) throw new Error("multi CJK columns not recognized");
  if (!exprHasColumn("客户名_备注 IS NOT NULL")) throw new Error("underscore CJK ident not recognized");
  if (exprHasColumn("my_func(' ')=1")) throw new Error("underscore function name must not count as column ref");
  // 生产调用形态是 sanitizeSql 脱敏后文本（字面量已被等长空格掩蔽），断言按该契约输入
  if (exprHasColumn("1=1")) throw new Error("tautology 1=1 must not count as column ref");
  if (exprHasColumn("true=true")) throw new Error("tautology true=true must not count as column ref");
  if (exprHasColumn("' '=' '")) throw new Error("masked literal comparison must not count as column ref");
  if (exprHasColumn("length('  ')=2")) throw new Error("function name must not count as column ref");
  // 端到端写路径：字面量伪装的恒真 WHERE（脱敏后无列引用）同样必须 E_SAFETY 拒绝
  for (const where of ["1=1 OR 1=1", "'a'='a'", "length('ab')=2"]) {
    let code = null;
    try { guardWrite(`UPDATE 订单表 SET 状态='X' WHERE ${where}`); } catch (e) { code = e.errCode; }
    if (code !== "E_SAFETY") throw new Error(`WHERE ${where} must be E_SAFETY-refused, got: ${code}`);
  }
});
/* v1.6.9 观测面打点（DBMCP_ERR_LOG）：默认关闭、格式、错误语义、脱敏、关联、fail-open */
check("observe: 默认关闭——未设 DBMCP_ERR_LOG 时零写盘", () => {
  const probe = path.join(os.tmpdir(), `dbmcp-obs-off-${process.pid}.ndjson`);
  try {
    process.env.DBMCP_ERR_LOG = probe;
    logToolCall({ id: 1, tool: "query", args: {}, duration_ms: 1, is_error: false, code: null, retry: null, err_msg: null });
    if (!fs.existsSync(probe)) throw new Error("enable case should write");
    fs.rmSync(probe, { force: true });
    delete process.env.DBMCP_ERR_LOG;
    logToolCall({ id: 2, tool: "query", args: {}, duration_ms: 1, is_error: false, code: null, retry: null, err_msg: null });
    if (fs.existsSync(probe)) throw new Error("disabled case must not write");
  } finally {
    delete process.env.DBMCP_ERR_LOG;
    try { fs.rmSync(probe, { force: true }); } catch { /* 清理失败不计入断言 */ }
  }
});
check("observe: 单行 NDJSON、字段完整", () => {
  const line = fmtLogLine({ id: 7, tool: "count_rows", args: { source: "demo", table: "orders" }, duration_ms: 12, is_error: false, code: null, retry: null, err_msg: null });
  if (line.includes("\n")) throw new Error("must be single line");
  const rec = JSON.parse(line);
  for (const k of ["ts", "id", "tool", "is_error", "code", "retry", "duration_ms", "source", "table", "sql_head", "err_head"]) {
    if (!(k in rec)) throw new Error("missing field: " + k);
  }
  if (rec.id !== 7 || rec.tool !== "count_rows" || rec.source !== "demo" || rec.table !== "orders" || rec.duration_ms !== 12) throw new Error(line);
  if (!Number.isFinite(Date.parse(rec.ts))) throw new Error("bad ts: " + rec.ts);
});
check("observe: 错误行带稳定错误码/重试态，成功行 code/retry 为 null", () => {
  const ok = JSON.parse(fmtLogLine({ id: 1, tool: "t", args: {}, duration_ms: 1, is_error: false, code: null, retry: null, err_msg: null }));
  if (ok.code !== null || ok.retry !== null || ok.err_head !== null) throw new Error(JSON.stringify(ok));
  const bad = JSON.parse(fmtLogLine({ id: 2, tool: "t", args: {}, duration_ms: 1, is_error: true, code: "E_PARAM", retry: "no-retry", err_msg: "Invalid 'max_rows': must be >= 1" }));
  if (bad.code !== "E_PARAM" || bad.retry !== "no-retry" || !/max_rows/.test(bad.err_head || "")) throw new Error(JSON.stringify(bad));
});
check("observe: 字段脱敏走权威 scrub（先整段脱敏再截断）", () => {
  setScrub((t) => scrubWith(t, ["fakeSecretPwd123"]));
  try {
    const line = fmtLogLine({ id: 3, tool: "query", args: { source: "s", sql: "SELECT * FROM t WHERE pw='fakeSecretPwd123'" }, duration_ms: 1, is_error: true, code: "E_DB", retry: "no-retry", err_msg: "connect failed for fakeSecretPwd123" });
    if (line.includes("fakeSecretPwd123")) throw new Error("secret leaked into log");
    if (!line.includes("***")) throw new Error("mask marker missing");
    const rec = JSON.parse(fmtLogLine({ id: 4, tool: "query", args: { sql: "x".repeat(5000) }, duration_ms: 1, is_error: false, code: null, retry: null, err_msg: null }));
    if (rec.sql_head.length > MAX_FIELD + 1) throw new Error("sql_head not bounded: " + rec.sql_head.length);
  } finally {
    setScrub(scrub);
  }
});
await checkAsync("observe: 端到端——每次 tools/call 恰好 1 条记录，id 可关联", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-obs-"));
  const file = path.join(dir, "audit.ndjson");
  process.env.DBMCP_ERR_LOG = file;
  try {
    const ok = await handleRpc({ jsonrpc: "2.0", id: 301, method: "tools/call", params: { name: "list_sources", arguments: {} } });
    const bad = await handleRpc({ jsonrpc: "2.0", id: "req-302", method: "tools/call", params: { name: "query", arguments: { source: "no-such-src", sql: "SELECT 1" } } });
    if (ok.result?.isError) throw new Error("list_sources should succeed");
    if (!bad.result?.isError) throw new Error("query should fail");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    if (lines.length !== 2) throw new Error("expected exactly 2 records, got " + lines.length);
    const [l1, l2] = lines;
    if (l1.id !== 301 || l1.tool !== "list_sources" || l1.is_error !== false) throw new Error(JSON.stringify(l1));
    // v1.6.14: 错误码形状改显式 7 码枚举——旧版 /^E_[A-Z]+$/ 不含下划线，E_NOT_FOUND 永远不匹配，
    // 已初始化部署（未知源真实报 E_NOT_FOUND）此钉必挂；未初始化报 E_CONFIG 才侥幸通过（实测抓获）。
    if (l2.id !== "req-302" || l2.tool !== "query" || l2.is_error !== true || !/^E_(SAFETY|PARAM|NOT_FOUND|CONFIG|LIMIT|DB|INTERNAL)$/.test(l2.code || "")) throw new Error(JSON.stringify(l2));
    if (typeof l2.duration_ms !== "number") throw new Error("duration_ms missing");
  } finally {
    delete process.env.DBMCP_ERR_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
await checkAsync("observe: 日志写失败不影响工具调用（fail-open）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-obs-fail-"));
  process.env.DBMCP_ERR_LOG = dir; // 指向目录：appendFileSync 抛错，必须静默吞掉
  try {
    const r = await handleRpc({ jsonrpc: "2.0", id: 303, method: "tools/call", params: { name: "list_sources", arguments: {} } });
    if (r.result?.isError) throw new Error("tool call must be unaffected by log failure: " + JSON.stringify(r.result).slice(0, 160));
  } finally {
    delete process.env.DBMCP_ERR_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
/* v1.6.10 日志滚动：总量有界、滚动后可读、保留上限、参数容错 */
check("observe: 超限滚动——旧日志转 .1、总量有界、最新记录可读", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-obs-rot-"));
  const file = path.join(dir, "a.ndjson");
  process.env.DBMCP_ERR_LOG = file;
  process.env.DBMCP_ERR_LOG_MAX_BYTES = "4096";
  process.env.DBMCP_ERR_LOG_KEEP = "3";
  try {
    for (let i = 0; i < 40; i++) { // 单行 ~200B × 40 ≈ 8KB > 4096 阈值，必然触发滚动
      logToolCall({ id: i, tool: "query", args: { sql: "SELECT " + i }, duration_ms: 1, is_error: false, code: null, retry: null, err_msg: null });
    }
    if (!fs.existsSync(file + ".1")) throw new Error("rotation did not happen");
    const cur = fs.readFileSync(file, "utf8").trim().split("\n");
    const last = JSON.parse(cur[cur.length - 1]);
    if (last.id !== 39) throw new Error("newest record not at tail: " + JSON.stringify(last));
    const rot = fs.readFileSync(file + ".1", "utf8").trim().split("\n");
    const old = JSON.parse(rot[0]);
    if (old.id >= 39) throw new Error("rotated file should hold older records: " + JSON.stringify(old));
    // 总量有界：单行 ≤2KB，滚动阈值 4096 → 每文件不超阈值+单行；保留份数外不得存在
    for (const p of [file, file + ".1", file + ".2", file + ".3"]) {
      if (fs.existsSync(p) && fs.statSync(p).size > 4096 + 2600) throw new Error("file exceeds bound: " + p);
    }
    if (fs.existsSync(file + ".4")) throw new Error("retention bound violated");
  } finally {
    delete process.env.DBMCP_ERR_LOG;
    delete process.env.DBMCP_ERR_LOG_MAX_BYTES;
    delete process.env.DBMCP_ERR_LOG_KEEP;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check("observe: 滚动保留上限 KEEP + 配置参数容错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-obs-keep-"));
  const file = path.join(dir, "b.ndjson");
  process.env.DBMCP_ERR_LOG = file;
  process.env.DBMCP_ERR_LOG_MAX_BYTES = "1024"; // 合法域下界
  process.env.DBMCP_ERR_LOG_KEEP = "2";
  try {
    for (let i = 0; i < 30; i++) {
      logToolCall({ id: i, tool: "t", args: {}, duration_ms: 1, is_error: false, code: null, retry: null, err_msg: null });
    }
    if (!fs.existsSync(file + ".1") || !fs.existsSync(file + ".2")) throw new Error("expected .1 and .2 under KEEP=2");
    if (fs.existsSync(file + ".3")) throw new Error("KEEP=2 must not retain .3");
    // 非法值（非数字/越界负数）回落缺省且不影响写盘
    process.env.DBMCP_ERR_LOG_MAX_BYTES = "not-a-number";
    process.env.DBMCP_ERR_LOG_KEEP = "-5";
    logToolCall({ id: 99, tool: "t", args: {}, duration_ms: 1, is_error: false, code: null, retry: null, err_msg: null });
    if (!fs.readFileSync(file, "utf8").includes('"id":99')) throw new Error("garbage env must fall back to defaults and still write");
  } finally {
    delete process.env.DBMCP_ERR_LOG;
    delete process.env.DBMCP_ERR_LOG_MAX_BYTES;
    delete process.env.DBMCP_ERR_LOG_KEEP;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  // v1.6.38: 双份序列化契约钉——resultContent 的 text 是「嵌进信封的 JSON 字符串」，wire 上
  // 双重编码：JSON.parse(JSON.parse(wire).result.content[0].text) 才还原数据，text 必含 \"
  //（内层结构引号已转义）。剖析定盘 pass2 信封转义为 MCP text 协议必需；单遍预转义 emitter
  // 候选已实测负优化 2× 回退（bench_r1638_mech）。本钉防未来「单遍序列化」重构漂移。
  const sqMeta = (JSON.parse(ls.result.content[0].text).sources || []).find((s) => s.type === "sqlite");
  const envResp = sqMeta
    ? await handleRpc({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "query", arguments: { source: sqMeta.id, sql: "SELECT 'x' AS tag", max_rows: 1 } } })
    : null;
  check("mcp: resultContent 双份序列化契约钉（v1.6.38 wire 双重编码还原数据 + wire 层含转义内引号）", () => {
    if (!sqMeta) { console.log("SKIP 双份序列化契约钉 (该配置无 sqlite 源)"); return; }
    if (envResp.result?.isError) throw new Error("sqlite query failed: " + String(envResp.result?.content?.[0]?.text).slice(0, 120));
    const wire = JSON.stringify(envResp); // 模拟 stdio writeLine 的信封序列化（pass2）
    if (!wire.includes('\\"row_count\\"')) throw new Error("wire missing double-encoded inner quotes (single-serialization drift?)");
    const text = JSON.parse(wire).result.content[0].text;
    if (typeof text !== "string" || !text.startsWith("{")) throw new Error("text is not a JSON document string");
    const data = JSON.parse(text);
    if (data.row_count !== 1 || data.rows[0].tag !== "x") throw new Error("double-parse roundtrip mismatch: " + text.slice(0, 120));
  });
  // v1.6.39: pg 命名预编译缓存正确性钉（字面量作用域）——同一字面量 SQL 两次查询结果逐字节
  // 恒等（第二次走缓存命中路径）；坏 SQL 两次报同一原生错误且无 "prepared statement ... does
  // not exist"（Parse 毒化自愈：pg 在 Parse 发送时记 submittedNamedStatements，失败不回滚，
  // 产品错误路径清客户端跟踪）；参数化语句保持 unnamed extended 原路径（find_tables_by_column
  // 带值走通）。部署无 pg 源时 SKIP。
  const pgMeta = (JSON.parse(ls.result.content[0].text).sources || []).find((s) => s.type === "postgres");
  const pgQ1 = pgMeta ? await handleRpc({ jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "query", arguments: { source: pgMeta.id, sql: "SELECT 39 AS v", max_rows: 1 } } }) : null;
  const pgQ2 = pgMeta ? await handleRpc({ jsonrpc: "2.0", id: 82, method: "tools/call", params: { name: "query", arguments: { source: pgMeta.id, sql: "SELECT 39 AS v", max_rows: 1 } } }) : null;
  const pgBad1 = pgMeta ? await handleRpc({ jsonrpc: "2.0", id: 83, method: "tools/call", params: { name: "query", arguments: { source: pgMeta.id, sql: "SELECT * FROM dbmcp_no_such_table_39", max_rows: 1 } } }) : null;
  const pgBad2 = pgMeta ? await handleRpc({ jsonrpc: "2.0", id: 84, method: "tools/call", params: { name: "query", arguments: { source: pgMeta.id, sql: "SELECT * FROM dbmcp_no_such_table_39", max_rows: 1 } } }) : null;
  const pgFind = pgMeta ? await handleRpc({ jsonrpc: "2.0", id: 85, method: "tools/call", params: { name: "find_tables_by_column", arguments: { column: "id", source: pgMeta.id, limit: 1 } } }) : null;
  const pgFind2 = pgMeta ? await handleRpc({ jsonrpc: "2.0", id: 86, method: "tools/call", params: { name: "find_tables_by_column", arguments: { column: "name", source: pgMeta.id, limit: 1 } } }) : null;
  check("pool: pg 命名预编译缓存正确性钉（v1.6.41 字面量缓存命中恒等 + Parse 毒化自愈 + 参数化 named 跨值复用可用）", () => {
    if (!pgMeta) { console.log("SKIP pg 预编译钉 (该配置无 postgres 源)"); return; }
    const t1 = pgQ1.result?.content?.[0]?.text, t2 = pgQ2.result?.content?.[0]?.text;
    if (pgQ1.result?.isError || pgQ2.result?.isError) throw new Error("literal query failed: " + String(t1 || t2).slice(0, 120));
    // duration_ms 每次必变，只比数据面：columns + rows
    const d1 = JSON.parse(t1), d2 = JSON.parse(t2);
    if (JSON.stringify([d1.columns, d1.rows]) !== JSON.stringify([d2.columns, d2.rows])) {
      throw new Error("cache-hit second query diverged: " + String(t2).slice(0, 120) + " vs " + String(t1).slice(0, 120));
    }
    const b1 = String(pgBad1.result?.content?.[0]?.text || ""), b2 = String(pgBad2.result?.content?.[0]?.text || "");
    if (!pgBad1.result?.isError || !pgBad2.result?.isError) throw new Error("bad SQL must error twice");
    if (/prepared statement .* does not exist/i.test(b2)) throw new Error("Parse poison not self-healed: " + b2.slice(0, 120));
    if (b1 !== b2) throw new Error("bad SQL errors diverged: " + b2.slice(0, 120) + " vs " + b1.slice(0, 120));
    // v1.6.41: 参数化 named 跨值复用——两次不同参数值的 find_tables_by_column（各带不同 SQL 文本
    // 与绑定值）都必须走通（named 路径对参数化已启用，values 非空不再回落 unnamed）。
    if (pgFind.result?.isError) throw new Error("parameterized named path (find id) failed: " + String(pgFind.result?.content?.[0]?.text).slice(0, 120));
    if (pgFind2.result?.isError) throw new Error("parameterized named path (find name) failed: " + String(pgFind2.result?.content?.[0]?.text).slice(0, 120));
  });
  // v1.6.53: e2e offset 分页钉——产品配置 sqlite 源直连建 25 行临时表，走产品 handleRpc：
  // query 三页（0/10/20×10 行）无重叠无遗漏 + offset 回显；sample_data offset 页（11..20）；
  // 不包裹语句（括号复合）走 slice 层偏移（offset 20×5 行 = 21..25）。结束直连删表。
  await checkAsync("v1.6.53: e2e offset 分页钉（query 三页无重叠无遗漏 + sample_data offset 页 + 不包裹语句 slice 偏移）", async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(here, "dbmcp.config.json"), "utf8"));
    const sqEntry = Object.entries(cfg.sources || {}).find(([, s]) => String(s.type || "").toLowerCase() === "sqlite" || /^sqlite:/i.test(s.url || ""));
    if (!sqEntry) { console.log("SKIP offset 分页钉 (该配置无 sqlite 源)"); return; }
    const [sqId, sqSrc] = sqEntry;
    const file = SQLITE.sqliteFilePath(sqSrc);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    db.exec("DROP TABLE IF EXISTS page_probe_v1653");
    db.exec("CREATE TABLE page_probe_v1653 (id INTEGER PRIMARY KEY, v TEXT)");
    db.exec("BEGIN");
    const ins = db.prepare("INSERT INTO page_probe_v1653 (id, v) VALUES (?, ?)");
    for (let i = 1; i <= 25; i++) ins.run(i, "v" + i);
    db.exec("COMMIT");
    try {
      const pages = [];
      for (const off of [0, 10, 20]) {
        const r = await handleRpc({ jsonrpc: "2.0", id: 90 + off, method: "tools/call", params: { name: "query", arguments: { source: sqId, sql: "SELECT id, v FROM page_probe_v1653 ORDER BY id", max_rows: 10, offset: off } } });
        if (r.result?.isError) throw new Error("page " + off + " failed: " + String(r.result.content?.[0]?.text).slice(0, 120));
        const d = JSON.parse(r.result.content[0].text);
        pages.push(d.rows.map((x) => Number(x.id)));
        if (off && d.offset !== off) throw new Error("offset echo missing: " + off);
      }
      const all = pages.flat();
      const set = new Set(all);
      if (all.length !== 25 || set.size !== 25) throw new Error("pages overlap/miss: " + JSON.stringify(pages));
      for (let i = 1; i <= 25; i++) if (!set.has(i)) throw new Error("missing id " + i);
      const r2 = await handleRpc({ jsonrpc: "2.0", id: 95, method: "tools/call", params: { name: "sample_data", arguments: { source: sqId, table: "page_probe_v1653", limit: 10, offset: 10, order_by: "id" } } });
      if (r2.result?.isError) throw new Error("sample_data offset failed: " + String(r2.result.content?.[0]?.text).slice(0, 120));
      const d2 = JSON.parse(r2.result.content[0].text);
      const ids2 = d2.rows.map((x) => Number(x.id));
      const want2 = Array.from({ length: 10 }, (_, i) => i + 11);
      if (JSON.stringify(ids2) !== JSON.stringify(want2)) throw new Error("sample_data offset page wrong: " + JSON.stringify(ids2));
      if (d2.offset !== 10) throw new Error("sample_data offset echo missing");
      const r3 = await handleRpc({ jsonrpc: "2.0", id: 96, method: "tools/call", params: { name: "query", arguments: { source: sqId, sql: "SELECT * FROM (SELECT id, v FROM page_probe_v1653 ORDER BY id)", max_rows: 5, offset: 20 } } });
      if (r3.result?.isError) throw new Error("wrapped-offset re-check failed: " + String(r3.result.content?.[0]?.text).slice(0, 120));
      const d3 = JSON.parse(r3.result.content[0].text);
      const ids3 = d3.rows.map((x) => Number(x.id));
      if (JSON.stringify(ids3) !== JSON.stringify([21, 22, 23, 24, 25])) throw new Error("wrapped offset page wrong: " + JSON.stringify(ids3));
      // 不包裹语句 slice 层偏移：sqlite prepare 拒裸括号 select（实测 near "(" 语法错误），
      // 不包裹分支用 mysql 复合语句（(SELECT…) UNION (…)——enforceLimit 括号分支不包裹）走 slice 偏移
      const myEntry = Object.entries(cfg.sources || {}).find(([, s]) => String(s.type || "").toLowerCase() === "mysql" && (s.url || s.enc));
      if (myEntry) {
        const { decryptAny } = await import(pathToFileURL(path.join(here, "crypt2.mjs")).href);
        const mysql = (await import("mysql2/promise")).default;
        const url = myEntry[1].url || decryptAny(myEntry[1].enc);
        const u = new URL(url);
        const conn = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, "") });
        try {
          await conn.query("DROP TABLE IF EXISTS page_probe_v1653");
          await conn.query("CREATE TABLE page_probe_v1653 (id INT PRIMARY KEY, v VARCHAR(16))");
          const batch = [];
          for (let i = 1; i <= 25; i++) batch.push(`(${i}, 'v${i}')`);
          await conn.query(`INSERT INTO page_probe_v1653 VALUES ${batch.join(",")}`);
          const r4 = await handleRpc({ jsonrpc: "2.0", id: 97, method: "tools/call", params: { name: "query", arguments: { source: myEntry[0], sql: "(SELECT id, v FROM page_probe_v1653 ORDER BY id) UNION (SELECT id, v FROM page_probe_v1653 WHERE 0 = 1)", max_rows: 5, offset: 20 } } });
          if (r4.result?.isError) throw new Error("unwrapped offset failed: " + String(r4.result.content?.[0]?.text).slice(0, 120));
          const d4 = JSON.parse(r4.result.content[0].text);
          const ids4 = d4.rows.map((x) => Number(x.id));
          if (JSON.stringify(ids4) !== JSON.stringify([21, 22, 23, 24, 25])) throw new Error("unwrapped offset slice wrong: " + JSON.stringify(ids4));
        } finally {
          await conn.query("DROP TABLE IF EXISTS page_probe_v1653");
          await conn.end();
        }
      } else {
        console.log("SKIP 不包裹 slice 偏移断言 (该配置无 mysql 源)");
      }
    } finally {
      db.exec("DROP TABLE IF EXISTS page_probe_v1653");
      db.close();
    }
  });
  // v1.6.54: server_stats e2e 钉——计数接线（先查一次真源）/ version 恒等 / 慢阈值默认 2000 / 形状
  await checkAsync("obs: server_stats e2e 钉（v1.6.54）计数接线 + version + 慢阈值默认", async () => {
    const cfg2 = JSON.parse(fs.readFileSync(path.join(here, "dbmcp.config.json"), "utf8"));
    const sq2 = Object.entries(cfg2.sources || {}).find(([, s]) => String(s.type || "").toLowerCase() === "sqlite" || /^sqlite:/i.test(s.url || ""));
    if (!sq2) { console.log("SKIP server_stats e2e 钉 (该配置无 sqlite 源)"); return; }
    await handleRpc({ jsonrpc: "2.0", id: 98, method: "tools/call", params: { name: "query", arguments: { source: sq2[0], sql: "SELECT 1 AS ok", max_rows: 1 } } });
    const r = await handleRpc({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "server_stats", arguments: {} } });
    if (r.result?.isError) throw new Error("server_stats failed: " + String(r.result.content?.[0]?.text).slice(0, 140));
    const d = JSON.parse(r.result.content[0].text);
    if (d.version !== VERSION) throw new Error("version drift: " + d.version);
    if (d.slow_ms_threshold !== 2000) throw new Error("slow threshold 非默认 2000: " + d.slow_ms_threshold);
    const sq = d.per_source.find((x) => x.source === sq2[0]);
    if (!sq || sq.count < 1) throw new Error("sqlite 计数未接线: " + JSON.stringify(d.per_source));
    if (!Array.isArray(d.recent_slow) || typeof d.uptime_s !== "number") throw new Error("形状: " + JSON.stringify(Object.keys(d)));
    if (!d.report || !Array.isArray(d.report.error_codes) || !Array.isArray(d.report.slow_by_type)) throw new Error("report 形状缺失（v1.6.56）: " + JSON.stringify(Object.keys(d)));
  });
  // v1.6.55: reload_config e2e 钉——临时配置副本三态：同内容零差异 / 增源生效+list_sources 反映 /
  // 坏 JSON → E_CONFIG 且内存态保持上次成功重载（复位：真配置 reload 清 dummy）。
  await checkAsync("cfg: reload_config e2e 钉（v1.6.55）同内容零差异 + 增源生效 + 坏 JSON 回滚内存态", async () => {
    const realPath = path.join(here, "dbmcp.config.json");
    const tmpPath = path.join(here, "dbmcp.reload_test.config.json");
    const envBak = process.env.DBMCP_CONFIG;
    let d1;
    try {
      fs.copyFileSync(realPath, tmpPath);
      process.env.DBMCP_CONFIG = tmpPath;
      const r1 = await handleRpc({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "reload_config", arguments: {} } });
      if (r1.result?.isError) throw new Error("同内容重载失败: " + String(r1.result.content?.[0]?.text).slice(0, 140));
      d1 = JSON.parse(r1.result.content[0].text);
      if (!Array.isArray(d1.changed) || d1.changed.length !== 0) throw new Error("同内容应零差异: " + JSON.stringify(d1.changed));
      const rawObj = JSON.parse(fs.readFileSync(realPath, "utf8"));
      rawObj.sources.__reload_dummy = { type: "sqlite", file: path.join(here, "dbmcp.reload_dummy.db") };
      fs.writeFileSync(tmpPath, JSON.stringify(rawObj, null, 2));
      const r2 = await handleRpc({ jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "reload_config", arguments: {} } });
      if (r2.result?.isError) throw new Error("增源重载失败: " + String(r2.result.content?.[0]?.text).slice(0, 140));
      const d2 = JSON.parse(r2.result.content[0].text);
      if (!d2.changed.includes("__reload_dummy") || d2.sources !== d1.sources + 1) throw new Error("增源面: " + JSON.stringify(d2));
      const ls2 = await handleRpc({ jsonrpc: "2.0", id: 73, method: "tools/call", params: { name: "list_sources", arguments: {} } });
      const ls2d = JSON.parse(ls2.result.content[0].text);
      if (!(ls2d.sources || []).some((s) => s.id === "__reload_dummy")) throw new Error("list_sources 未见新源");
      fs.writeFileSync(tmpPath, "{ 这不是 json !!!");
      const r3 = await handleRpc({ jsonrpc: "2.0", id: 74, method: "tools/call", params: { name: "reload_config", arguments: {} } });
      if (!r3.result?.isError || !/E_CONFIG/.test(String(r3.result.content?.[0]?.text || ""))) throw new Error("坏 JSON 未拒: " + String(r3.result.content?.[0]?.text).slice(0, 120));
      const ls3 = await handleRpc({ jsonrpc: "2.0", id: 75, method: "tools/call", params: { name: "list_sources", arguments: {} } });
      const ls3d = JSON.parse(ls3.result.content[0].text);
      if (!(ls3d.sources || []).some((s) => s.id === "__reload_dummy")) throw new Error("坏 JSON 后内存态不应丢（回滚=保持上次成功态）");
    } finally {
      process.env.DBMCP_CONFIG = realPath;
      await handleRpc({ jsonrpc: "2.0", id: 76, method: "tools/call", params: { name: "reload_config", arguments: {} } }); // 复位：真配置 reload 清 dummy
      process.env.DBMCP_CONFIG = envBak;
      fs.rmSync(tmpPath, { force: true });
      const lsF = await handleRpc({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "list_sources", arguments: {} } });
      const lsFd = JSON.parse(lsF.result.content[0].text);
      if ((lsFd.sources || []).some((s) => s.id === "__reload_dummy")) throw new Error("复位后 dummy 仍在");
    }
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
/* --- v1.6.16: Uint8Array（node:sqlite BLOB 返回值）序列化钉——对抗台抓获旧版
   只认 {type:"Buffer"} 形状，Uint8Array 被序列化成 {"0":..} 键值垃圾 --- */
check("json: Uint8Array cell → <binary N bytes: hex>（非键值垃圾）", () => {
  const s = stringify({ b: new Uint8Array([0, 1, 2, 255]) });
  if (s !== '{"b":"<binary 4 bytes: 000102ff>"}') throw new Error(s);
});
check("json export: Uint8Array → 全量 hex", () => {
  const s = stringify({ b: new Uint8Array([0, 1, 2, 255]) }, { export: true });
  if (s !== '{"b":"000102ff"}') throw new Error(s);
});
check("csv: Uint8Array 单元格 → 确定性 hex（旧版 String(v) 成 '0,1,2,255'）", () => {
  const c = SQLITE.csvCell(new Uint8Array([0, 1, 2, 255]));
  if (c !== "000102ff") throw new Error(c);
});
check("json: truncated cell counting", () => {
  const n = countTruncatedCells([{ a: "x".repeat(3000) }, { a: "short" }]);
  if (n !== 1) throw new Error("got " + n);
  // v1.6.36 内扩（零计数漂移）：语义边界钉——只看行顶层字符串值，阈值严格大于才计。
  const long = "L".repeat(2005);
  process.env.DBMCP_MAX_CELL_CHARS = "2000";
  try {
    if (countTruncatedCells([{ a: "x".repeat(2000) }]) !== 0) throw new Error("恰好阈值（=max）不得计");
    if (countTruncatedCells([{ a: "x".repeat(2001) }]) !== 1) throw new Error("超阈值 1 字符必须计");
    if (countTruncatedCells([{ a: long, b: long }]) !== 1) throw new Error("同行多长串应计 1 行");
    if (countTruncatedCells([{ a: [long] }, { a: { b: long } }]) !== 0) throw new Error("数组元素/嵌套对象长串不得计");
    if (countTruncatedCells([{ [long]: "s" }]) !== 0) throw new Error("超长键名不计（只看值）");
    if (countTruncatedCells([null, 42, "str", true, undefined]) !== 0) throw new Error("非对象行必须跳过");
    const inh = Object.create({ k: long }); inh.s = "ok";
    if (countTruncatedCells([inh]) !== 0) throw new Error("继承可枚举键不得计");
    if (countTruncatedCells([{ a: long }, { b: long }, { c: "ok" }]) !== 2) throw new Error("逐行长串应逐行计数");
  } finally { delete process.env.DBMCP_MAX_CELL_CHARS; }
});

/* --- v1.6.3: export 模式数据保真（响应面截断不动，落盘导出必须无损） --- */
check("json export: 长文本不截断 + Buffer 全量 hex（响应面行为不变）", () => {
  const long = "y".repeat(5000);
  const o = JSON.parse(stringify({ note: long, bin: Buffer.alloc(20, 0xab) }, { export: true }));
  if (o.note !== long) throw new Error("export 模式截断了长文本: len=" + String(o.note).length);
  if (!/^(ab)+$/.test(o.bin) || /\u2026/.test(o.bin) || o.bin.length !== 40) {
    throw new Error("export 模式 Buffer 必须全量 hex 无省略: " + o.bin);
  }
  const r = stringify({ note: long, bin: Buffer.alloc(20, 0xab) });   // 响应面：截断 + 8 字节预览
  if (!r.includes("<truncated") || !/…/.test(r)) throw new Error("响应面截断/预览行为被改动: " + r.slice(0, 120));
});

/* --- v1.6.36: 序列化改走「规范化一遍 + 原生 JSON.stringify」（逐值 replacer 回调为 CPU 头号
   自耗时）。旧实现冻结为 stringifyReplacer 真源，两者必须对任意载荷逐字节恒等；本组钉覆盖
   规范化 walk 的三个易碎语义：toJSON 只作用一次（链式返回值不再套用/副本不携带可调用 toJSON 键）、
   装箱原始值原样交还（原生派发按内部槽展开）、__proto__ 自有键与伪造 constructor 的复制语义。 --- */
check("json: stringify 规范化 walk vs 冻结 stringifyReplacer 差分钉（v1.6.36）四模式逐字节恒等 + 根级边界 + 抛出同责", () => {
  const longStr = "x".repeat(3000) + "tail";
  const mkAdv = () => ({
    source: "adv", row_count: 4, duration_ms: NaN,
    rows: [
      { a: 9007199254740993n, b: Infinity, c: -Infinity, d: longStr },
      { a: new Date("2026-10-06T12:34:56.789Z"), b: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), c: new Uint8Array([255, 254]), d: new DataView(new Uint8Array([1, 2, 3]).buffer) },
      { a: { type: "Buffer", data: [10, 20, 30, 40, 50, 60, 70, 80, 90] }, b: { nested: { deep: 123n, u: undefined, f: function () { } } }, c: [1, , 3, BigInt(4)], d: -0 },
      { a: { toJSON: () => longStr }, b: { toJSON: () => BigInt(55) }, c: { toJSON: () => ({ inner: 123n, big: new Uint8Array([9, 9]) }) }, d: { toJSON: () => undefined } },
    ],
  });
  const mkEdges = () => ({
    chained: { toJSON: () => ({ toJSON: () => "chained-final", k: 1n }) },          // toJSON 只作用一次
    keyEcho: { toJSON(k) { return { was: k }; } },                                   // toJSON 按 spec 收 key
    boxed: { n: new Number(5), s: new String("hi"), b: new Boolean(false), nan: new Number(NaN) },
    tojsonKey: { toJSON: "keep", a: 1 },                                             // 非函数 toJSON 键保留
    ctorSpoof: { constructor: Number, n: 7, s: "z" },                                // 伪造 constructor 落回普通复制
    arrTojson: Object.assign([1, 2], { toJSON: () => ({ arr: true, v: 9n }) }),      // 数组自身 toJSON
    repeats: (() => { const o = { v: 3n }; return { x: o, y: o }; })(),               // 同对象双引用独立复制
    protoKey: JSON.parse('{"__proto__": {"p": 1}, "own": 2}'),                       // __proto__ 自有键必须保留
    getters: (() => { const o = { a: 1 }; Object.defineProperty(o, "g", { enumerable: true, get() { return 42n; } }); return o; })(),
  });
  const inh = Object.create({ hidden: "inh" }); inh.visible = "own"; // 继承可枚举键不串入
  const modes = [["response", {}], ["export", { export: true }], ["pretty", {}], ["export+pretty", { export: true }]];
  const roots = [["root-undef", () => undefined], ["root-null", () => null], ["root-5n", () => 5n], ["root-boxed5n", () => Object(5n)],
    ["root-boxedNaN", () => new Number(NaN)], ["root-arr", () => [1n, "s", NaN]], ["root-tojson", () => ({ toJSON: () => ({ r: 1n }) })]];
  const runBoth = (mk, opts, label) => {
    let a, b, ta = "", tb = "";
    try { a = stringify(mk(), opts); } catch (e) { ta = e.name + ":" + e.message; }
    try { b = stringifyReplacer(mk(), opts); } catch (e) { tb = e.name + ":" + e.message; }
    if (ta !== tb) throw new Error("抛出同责破坏 @" + label + ": " + JSON.stringify([ta, tb]));
    if (!ta && a !== b) throw new Error("字节发散 @" + label + ": " + JSON.stringify([String(a).slice(0, 160), String(b).slice(0, 160)]));
  };
  try {
    for (const [mname, opts] of modes) {
      if (mname.includes("pretty")) process.env.DBMCP_PRETTY = "1"; else delete process.env.DBMCP_PRETTY;
      runBoth(mkAdv, opts, "adv " + mname);
      runBoth(mkEdges, opts, "edges " + mname);
      runBoth(() => ({ inh, arr: [undefined, , () => { }, Symbol("s")], neg0: -0, nested: [[{ deep: [{ q: 7n }] }]] }), opts, "mixed " + mname);
      for (const [rlabel, mk] of roots) runBoth(mk, opts, rlabel + " " + mname);
    }
  } finally { delete process.env.DBMCP_PRETTY; }
});
check("json: stringify 规范化 walk 手写期望钉（v1.6.36）bigint 串化/截断后缀逐字/二进制预览/导出 hex/装箱 NaN/链式 toJSON 一次", () => {
  const eq = (got, want, label) => { if (got !== want) throw new Error(label + "\n  got:  " + got + "\n  want: " + want); };
  process.env.DBMCP_MAX_CELL_CHARS = "2000";
  try {
    eq(stringify({ a: 9007199254740993n }), '{"a":"9007199254740993"}', "bigint 串化（超安全整数不丢精度）");
    eq(stringify({ a: "x".repeat(2005) }), '{"a":"' + "x".repeat(2000) + '… <truncated 5 chars>"}', "截断后缀逐字");
    eq(stringify({ a: Buffer.from([1, 2, 3]) }), '{"a":"<binary 3 bytes: 010203>"}', "3B 预览无省略号");
    eq(stringify({ a: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) }), '{"a":"<binary 9 bytes: 0102030405060708…>"}', "9B 预览 8 字节 hex + …");
    eq(stringify({ a: Buffer.from([1, 2, 3]) }, { export: true }), '{"a":"010203"}', "导出模式全量 hex");
    eq(stringify({ a: new Number(NaN) }), '{"a":null}', "装箱 NaN 原样交还（原生派发 → null，非 'NaN' 字符串）");
    eq(stringify({ x: { toJSON: () => ({ toJSON: () => "chained-final", k: 1n }) } }), '{"x":{"k":"1"}}', "链式 toJSON 只作用一次");
    eq(stringify({ toJSON: "keep", a: 1 }), '{"toJSON":"keep","a":1}', "toJSON 键非函数必须保留");
  } finally { delete process.env.DBMCP_MAX_CELL_CHARS; }
});
check("scrub: scrubWith 预筛等价钉（v1.6.36）零命中/命中/重叠键双序/元字符不误伤/空键/空表/非串 与旧循环逐字恒等", () => {
  // v1.6.35 及以前的旧实现（真源）：逐 key includes + split/join
  const ref = (text, list) => { let t = String(text); for (const k of list) if (t.includes(k)) t = t.split(k).join("***"); return t; };
  const cases = [
    ["零命中", "hello world, nothing here", ["pw1", "pw2"]],
    ["单命中", "a pw1 b", ["pw1"]],
    ["同键多命中", "pw1 x pw1", ["pw1"]],
    ["多键命中", "pw1 and pw2 and pw1", ["pw1", "pw2"]],
    ["重叠键 短前", "xx abcdef yy", ["abc", "abcdef"]],
    ["重叠键 长前", "xx abcdef yy", ["abcdef", "abc"]],
    ["元字符命中", "a.b axb", ["a.b"]],
    ["元字符不误伤", "axb", ["a.b"]],
    ["元字符组", "x+y (z*) [q] ^r$ end", ["x+y", "(z*)", "[q]", "^r$"]],
    ["空键", "abc", [""]],
    ["空表", "abc", []],
    ["非串输入", 12345, ["34"]],
    ["长文本零命中", "y".repeat(10000), ["no-such-secret", "another"]],
    ["长文本命中", "y".repeat(5000) + "pw1" + "z".repeat(5000), ["pw1"]],
    ["替换产物含后续键", "pw1pw1", ["pw1", "***"]],
  ];
  for (const [label, text, keys] of cases) {
    const want = ref(text, keys);
    const got = scrubWith(text, keys);
    if (got !== want) throw new Error("发散 @" + label + ": " + JSON.stringify([got, want]));
  }
  // 同一 list 对象二次调用命中 WeakMap 缓存后语义不变（缓存只存预筛正则，不改结果）
  const ks = ["pw1", "pw2"];
  const t = "pw1 tail pw2 tail pw1";
  const w = ref(t, ks);
  if (scrubWith(t, ks) !== w || scrubWith(t, ks) !== w) throw new Error("缓存命中后语义漂移");
  // 不同 list 对象不串缓存
  const a = scrubWith(t, ["pw1"]); const b = scrubWith(t, ["pw2"]);
  if (a !== ref(t, ["pw1"]) || b !== ref(t, ["pw2"])) throw new Error("不同表缓存串位: " + JSON.stringify([a, b]));
});

check("scrub: 数字口令上下文清洗钉（v1.6.42）数字 token 保留/字符串字面量掩/pretty 回扫/长数字防误伤", () => {
  const eq = (got, want, label) => { if (got !== want) throw new Error(label + "\n  got:  " + got + "\n  want: " + want); };
  const K = "424242";
  eq(scrubWith('{"amt":424242,"id":1}', [K]), '{"amt":424242,"id":1}', "compact 数字 token 保留（洗烂面修复）");
  eq(scrubWith('{"amt": 424242}', [K]), '{"amt": 424242}', "pretty 空格回扫数字 token 保留");
  eq(scrubWith('{"note":"token-424242-x"}', [K]), '{"note":"token-***-x"}', "字符串字面量内仍掩");
  eq(scrubWith('{"whole":"424242"}', [K]), '{"whole":"***"}', "整个字符串值等于口令也掩");
  eq(scrubWith('{"n":1424242}', [K]), '{"n":1424242}', "长数字串片段防误伤（前缀数字）");
  eq(scrubWith('{"n":4242420}', [K]), '{"n":4242420}', "长数字串片段防误伤（后缀数字）");
  eq(scrubWith('id: 424242 in text', [K]), 'id: 424242 in text', "已知取舍：冒号+空格+纯数字=数字token形态保真");
  eq(scrubWith('free 424242 tail', [K]), 'free *** tail', "自由文本非冒号前缀照掩");
  eq(scrubWith('{"a":"x","pw":999999}', ["999999"]), '{"a":"x","pw":999999}', "非口令数字零误伤");
  eq(scrubWith("a pw1 b", ["pw1"]), "a *** b", "非数字键照旧裸串清洗（行为不漂移）");
});

check("csv: 数字口令单元格级处置钉（v1.6.43）全数字单元保真/文本内部掩/JSON-CSV 不对称显式钉/三链 digitKeys 恒等", () => {
  const eq = (got, want, label) => { if (got !== want) throw new Error(label + "\n  got:  " + JSON.stringify(got) + "\n  want: " + JSON.stringify(want)); };
  const dk = "424242";
  const dks = [dk];
  // 手写期望：csvCellDigitMask 单元格级规则
  eq(csvCellDigitMask(dk, dks), dk, "全数字单元保真（裸值=数据）");
  eq(csvCellDigitMask("4242420", dks), "4242420", "长数字片段保真（后缀数字）");
  eq(csvCellDigitMask("0424242", dks), "0424242", "长数字片段保真（前缀数字）");
  eq(csvCellDigitMask(`token-${dk}-x`, dks), "token-***-x", "文本内部含口令掩（泄漏面）");
  eq(csvCellDigitMask(`"a,b=${dk}"`, dks), `"a,b=***"`, "引号包裹单元内掩（逗号格）");
  eq(csvCellDigitMask("999999", dks), "999999", "非口令数字零误伤");
  eq(csvCellDigitMask("plain", dks), "plain", "无口令文本不变");
  eq(csvCellDigitMask(dk, []), dk, "空列表快路径");
  // JSON/CSV 不对称显式钉：JSON 有引号结构可分（字符串值掩/数字 token 保真，V1.6.42 口径）；
  // CSV 无引号结构可分（文本与数字同形）→ 按数据保真整体保真——两口径不得漂移成同侧。
  eq(scrubWith(`{"whole":"${dk}"}`, [dk]), '{"whole":"***"}', "JSON 字符串值仍掩（V1.6.42 口径不漂移）");
  eq(scrubWith(`{"amt":${dk}}`, [dk]), `{"amt":${dk}}`, "JSON 数字 token 仍保真（V1.6.42 口径不漂移）");
  eq(csvCellDigitMask(dk, dks), dk, "CSV 全数字单元保真（与 JSON 字符串值不对称，格式无引号结构可分）");
  // 三链 digitKeys 恒等：exportToCsv / exportToCsvBuffer / streamCsvLines 同输入同 digitKeys 逐字节恒等 + 手写期望整文件
  const fields = ["id", "amt", "note"];
  const rows = [
    { id: 1, amt: dk, note: `token-${dk}-x` },
    { id: 2, amt: "999999", note: "plain" },
  ];
  const BIG = 20 * 1024 * 1024;
  const a = SERVER.exportToCsv(fields, rows, true, BIG, dks).content;
  const b = SERVER.exportToCsvBuffer(fields, rows, true, BIG, dks).content.toString("utf8");
  const parts = [];
  SERVER.streamCsvLines((buf) => parts.push(Buffer.from(buf)), fields, rows, [], true, BIG, { digitKeys: dks });
  const c = Buffer.concat(parts).toString("utf8");
  eq(b, a, "exportToCsvBuffer ≡ exportToCsv（digitKeys）");
  eq(c, a, "streamCsvLines ≡ exportToCsv（digitKeys）");
  eq(a, "id,amt,note\r\n1," + dk + ",token-***-x\r\n2,999999,plain\r\n", "三链产物手写期望（裸数字保留+文本掩）");
  // 无 digitKeys 时输出原始 csvCell 形态（exportToCsv 本身不 scrub——清洗在下游 scrubToBuffer/管线；
  // 默认参数 digitKeys=[] = 零行为变化，数字键清洗仍由字节域承担）
  const a0 = SERVER.exportToCsv(fields, rows, true, BIG).content;
  eq(a0, "id,amt,note\r\n1," + dk + ",token-" + dk + "-x\r\n2,999999,plain\r\n", "无 digitKeys 维持原始 csvCell 形态（零行为变化）");
});

check("rpc: peekRpcId 从坏行/超长行恢复请求 id（防客户端永久挂起）", () => {
  if (peekRpcId('{"jsonrpc":"2.0","id":900,"method":"tools/call"') !== 900) throw new Error("numeric id");
  if (peekRpcId('{"jsonrpc":"2.0","id":"abc-1","method":') !== "abc-1") throw new Error("string id");
  if (peekRpcId('{"jsonrpc":"2.0","id":"a\\"b","method":') !== 'a"b') throw new Error("escaped string id");
  if (peekRpcId('{"jsonrpc":"2.0","method":"ping"') !== null) throw new Error("no id -> null");
  if (peekRpcId("garbage") !== null) throw new Error("non-json -> null");
  if (peekRpcId("x".repeat(20000) + '"id":7') !== null) throw new Error("超出扫描窗的 id 不得误配");
});

/* --- v1.6.12: notifications/cancelled（MCP 2025-06-18 Cancellation）纯钉 --- */
check("rpc: isCancelNotification 形状判别（无 id 的 cancelled 通知 + 对象 params）", () => {
  if (!isCancelNotification({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "x" } })) throw new Error("标准形状必须命中");
  if (!isCancelNotification({ method: "notifications/cancelled", params: { requestId: "a" } })) throw new Error("reason 可选");
  if (isCancelNotification({ id: 3, method: "notifications/cancelled", params: { requestId: 3 } })) throw new Error("带 id 是请求不是通知");
  if (isCancelNotification({ method: "notifications/progress", params: {} })) throw new Error("其他通知方法");
  if (isCancelNotification({ method: "notifications/cancelled" })) throw new Error("缺 params");
  if (isCancelNotification({ method: "notifications/cancelled", params: [1] })) throw new Error("params 数组不合法");
  if (isCancelNotification("notifications/cancelled")) throw new Error("标量不合法");
});
check("rpc: cancelRpc 未知 id / 无效通知一律忽略（规范 SHOULD ignore）", () => {
  if (cancelRpc({ requestId: 424242 }) !== "ignored") throw new Error("未知 id 必须忽略");
  if (cancelRpc({}) !== "ignored") throw new Error("缺 requestId 必须忽略");
  if (cancelRpc({ requestId: { a: 1 } }) !== "ignored") throw new Error("非标量 requestId 必须忽略");
  if (cancelRpc(undefined) !== "ignored") throw new Error("无 params 必须忽略");
});
check("rpc: 取消登记表——运行中 abort 触发、id 严格同类型、完成后迟到取消忽略", () => {
  const ac = trackRpc(7001);
  if (cancelRpc({ requestId: 7001, reason: "测试" }) !== "cancelled") throw new Error("在途请求必须命中取消");
  if (!ac.signal.aborted) throw new Error("abort 必须触发");
  if (cancelRpc({ requestId: "7001" }) !== "ignored") throw new Error("string/number id 不得互配");
  finishRpc(7001);
  if (cancelRpc({ requestId: 7001 }) !== "ignored") throw new Error("已完成请求的迟到取消必须忽略");
});
check("rpc: beginDispatch 消费取消标记——被取消的排队请求不执行且 id 复用安全", () => {
  trackRpc(7002);
  cancelRpc({ requestId: 7002 });
  if (beginDispatch(7002) !== false) throw new Error("排队中被取消必须抑制派发");
  if (beginDispatch(7002) !== true) throw new Error("标记一次性：同 id 新请求（复用）不受影响");
  trackRpc(7003);
  if (beginDispatch(7003) !== true) throw new Error("正常请求派发放行");
  finishRpc(7003);
});
await checkAsync("rpc: 已取消的 tools/call 不执行不响应（null），未取消照常返回结果", async () => {
  trackRpc(7004);
  cancelRpc({ requestId: 7004 });
  const r = await handleRpc({ jsonrpc: "2.0", id: 7004, method: "tools/call", params: { name: "list_sources", arguments: {} } });
  if (r !== null) throw new Error("被取消请求必须返回 null（不发响应）: " + JSON.stringify(r).slice(0, 120));
  const okResp = await handleRpc({ jsonrpc: "2.0", id: 7005, method: "tools/call", params: { name: "list_sources", arguments: {} } });
  if (!okResp?.result) throw new Error("未取消请求必须照常返回结果");
  if (cancelRpc({ requestId: 7005 }) !== "ignored") throw new Error("已应答请求的取消必须忽略");
});
await checkAsync("rpc: 请求形状的 notifications/cancelled（带 id）走正常分发回 -32601", async () => {
  const r = await handleRpc({ jsonrpc: "2.0", id: 7006, method: "notifications/cancelled", params: { requestId: 7006 } });
  if (r?.error?.code !== -32601) throw new Error("带 id 的 cancelled 是请求，必须 -32601: " + JSON.stringify(r).slice(0, 120));
});

/* --- v1.6.13: 真实对抗测试台抓获的产品缺陷回归钉（复制粘贴不可见字符 / CSV 保真 / 文件名边界 / 重名列） --- */
check("argnorm: stripLeadingInvis 前导不可见字符剥除（混合空白+ZWSP 族），内部与非字符串零改动", () => {
  const zw = "\u200B\u200C\u200D\u2060";
  if (stripLeadingInvis(zw + "SELECT 1") !== "SELECT 1") throw new Error("ZWSP 族前导未剥除");
  if (stripLeadingInvis(" \u00A0\u00AD\u202E\uFEFF SELECT 1") !== "SELECT 1") throw new Error("混合前导空白/软连字符/BOM/RTL 未剥除");
  if (stripLeadingInvis("SELECT" + zw + " 1") !== "SELECT" + zw + " 1") throw new Error("语句内部不可见字符必须原样保留（可能是字面量真实数据）");
  if (stripLeadingInvis("") !== "") throw new Error("空串被改动");
  if (stripLeadingInvis("X") !== "X") throw new Error("普通串被改动");
  if (stripLeadingInvis(42) !== 42) throw new Error("非字符串必须原样透传");
});
check("guard: 前导不可见字符归一后只读/写守卫照常判定（真复制粘贴形态）", () => {
  guardReadOnly(stripLeadingInvis("\u200BSELECT 1"), "mysql");
  guardReadOnly(stripLeadingInvis("\u00ADSELECT 1"), "postgres");
  let redLine = "";
  try { guardWrite(stripLeadingInvis("\u200BUPDATE t SET a=1"), "mysql"); } catch (e) { redLine = e.message; }
  if (!/安全红线/.test(redLine)) throw new Error("剥除后无 WHERE UPDATE 必须命中安全红线: " + redLine);
});
check("parseCsv: 引号内 CRLF/LF 是数据原样保留；引号外 CRLF/CR 是记录分隔归一（v1.6.13 保真修正）", () => {
  const rows = SQLITE.parseCsv('id,txt\r\n1,"L1\r\nL2"\r\n2,"A\nB"\r\n3,"say ""hi"""\r\n');
  if (rows.length !== 4) throw new Error("rows=" + rows.length);
  if (rows[1][1] !== "L1\r\nL2") throw new Error("引号内 CRLF 被压平: " + JSON.stringify(rows[1]));
  if (rows[2][1] !== "A\nB") throw new Error("引号内 LF 被改动: " + JSON.stringify(rows[2]));
  if (rows[3][1] !== 'say "hi"') throw new Error("双引号转义被改动: " + JSON.stringify(rows[3]));
  const crOnly = SQLITE.parseCsv("a,b\r1,2\r");   // 老 Mac CR 分隔
  if (crOnly.length !== 2 || crOnly[1][0] !== "1") throw new Error("CR 记录分隔未识别: " + JSON.stringify(crOnly));
});
check("parseCsv: 引号中途开闭/纯空引号/连续转义/未闭引号收尾（v1.6.25 构建重写钉——run-slice 版逐字节保真）", () => {
  const mid = SQLITE.parseCsv('ab"cd"ef,x');           // 引号中途开闭：引号不入值，内容拼接
  if (mid[0][0] !== "abcdef" || mid[0][1] !== "x") throw new Error("中途引号: " + JSON.stringify(mid));
  const q = SQLITE.parseCsv('a,""\n');                 // 纯空引号字段是空值
  if (q.length !== 1 || q[0][1] !== "") throw new Error("空引号字段: " + JSON.stringify(q));
  const trail = SQLITE.parseCsv('a,b\n""\n');          // [""] 记录仍按尾空行弹出
  if (trail.length !== 1) throw new Error("[''] 记录应弹出: " + JSON.stringify(trail));
  const esc = SQLITE.parseCsv('"a""b""c"');            // 连续转义对逐个合成 "
  if (esc[0][0] !== 'a"b"c') throw new Error("连续转义: " + JSON.stringify(esc));
  const un = SQLITE.parseCsv('x,"ab');                 // 未闭引号 EOF 收尾不丢值
  if (un[0][1] !== "ab") throw new Error("未闭引号: " + JSON.stringify(un));
});
check("csvSegmenter: 全偏移单点切分与整体 parseCsv 逐行等价（v1.6.25 流式分段契约）", () => {
  const cases = [
    "a,b\r\nc,d\r\n",
    'id,txt\r\n1,"L1\r\nL2"\r\n2,"A\nB"\r\n3,"say ""hi"""\r\n',
    "a,b\r1,2\r",
    "a,b\n\n\nc,d\n\n",
    'x,"""",y\nq,,"p\nq"\n',
    "1,2\n\n3,4",
    '"a""b",c\n""\nd,e\n',
    "a\r\n\r\nb\r\n",
    "\n\nh1,h2\nv1,v2\n",
    "",
  ];
  for (const src of cases) {
    const whole = JSON.stringify(SQLITE.parseCsv(src));
    for (let k = 0; k <= src.length; k++) {
      const seg = SQLITE.createCsvSegmenter();
      const out = [...seg.push(src.slice(0, k)), ...seg.push(src.slice(k)), ...seg.end()];
      const got = JSON.stringify(out.flatMap((s) => SQLITE.parseCsv(s)));
      if (got !== whole) throw new Error(`切点 ${k} 不等价: src=${JSON.stringify(src)}\n whole=${whole}\n got=${got}`);
    }
    const seg2 = SQLITE.createCsvSegmenter();          // 空 push 混入不得扰动
    const out2 = [...seg2.push(""), ...seg2.push(src), ...seg2.push(""), ...seg2.end()];
    if (JSON.stringify(out2.flatMap((s) => SQLITE.parseCsv(s))) !== whole) throw new Error("空 push 混入不等价: " + JSON.stringify(src));
  }
});
check("csvSegmenter: 随机多切分序列等价（1-5 字符碎片，覆盖 CRLF/转义对/引号跨块与尾暂缓定性）", () => {
  let seed = 20261005;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const alpha = ["a", "b", ",", '"', "\n", "\r", " ", "中"];
  for (let t = 0; t < 2000; t++) {
    const len = Math.floor(rnd() * 40);
    let src = "";
    for (let i = 0; i < len; i++) src += alpha[Math.floor(rnd() * alpha.length)];
    const whole = JSON.stringify(SQLITE.parseCsv(src));
    const seg = SQLITE.createCsvSegmenter();
    const out = [];
    let pos = 0;
    while (pos < src.length) {
      const step = 1 + Math.floor(rnd() * 5);
      out.push(...seg.push(src.slice(pos, pos + step)));
      pos += step;
    }
    out.push(...seg.end());
    const got = JSON.stringify(out.flatMap((s) => SQLITE.parseCsv(s)));
    if (got !== whole) throw new Error(`随机多切不等价: src=${JSON.stringify(src)}\n whole=${whole}\n got=${got}`);
  }
});
check("export: safeExportPath Windows 保留设备名拒绝（含带扩展名形态），非保留名不误伤", () => {
  const dir = "D:\\exports";
  for (const fn of ["NUL", "CON", "COM1", "aux", "LPT1", "PRN", "nul.csv", "CON.txt", "COM1.csv"]) {
    if (SQLITE.safeExportPath(dir, fn) !== null) throw new Error("保留设备名必须拒绝: " + fn);
  }
  for (const fn of ["COM10.csv", "console.csv", "NULL.csv", "common.csv", "LPT10.csv"]) {
    const got = SQLITE.safeExportPath(dir, fn);
    if (!got || !got.startsWith("D:\\exports")) throw new Error("非保留名不得误伤: " + fn + " -> " + got);
  }
});
check("export: safeExportPath 超长截断保扩展名 + 尾点归一 + 清洗后为空拒绝", () => {
  const dir = "D:\\exports";
  const got1 = SQLITE.safeExportPath(dir, "a".repeat(118) + ".csv");
  if (path.basename(got1) !== "a".repeat(116) + ".csv") throw new Error("截断丢扩展名: " + path.basename(got1));
  const got2 = SQLITE.safeExportPath(dir, "b".repeat(130) + ".csv");
  if (path.basename(got2) !== "b".repeat(116) + ".csv") throw new Error("带扩展名超长截断错误: " + path.basename(got2));
  const got3 = SQLITE.safeExportPath(dir, "report.csv.");
  if (path.basename(got3) !== "report.csv") throw new Error("尾点未归一: " + path.basename(got3));
  const got4 = SQLITE.safeExportPath(dir, "data1.csv. ");
  if (path.basename(got4) !== "data1.csv") throw new Error("尾点+尾空格未归一: " + path.basename(got4));
  if (SQLITE.safeExportPath(dir, ". ") !== null) throw new Error("清洗后为空必须拒绝");
  if (SQLITE.safeExportPath(dir, "...") !== null) throw new Error("纯点名保持拒绝");
});
await checkAsync("pool: sqlite 重名结果列前置拒绝（runQuery 裸查询防 node:sqlite 静默折叠丢值）", async () => {
  const { createPoolManager } = POOL;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-dupcol-"));
  try {
    const dbf = path.join(tmp, "d.db").replace(/\\/g, "/");
    const sources = { s: { type: "sqlite", url: "sqlite://" + dbf } };
    const mgr = createPoolManager({ cfg: { timeoutMs: 5000 }, getSource: (id) => sources[id], clampInt: (v, a, b, d) => d, sqliteFilePath: () => dbf });
    await mgr.runQuery("s", "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await mgr.runQuery("s", "INSERT INTO t (id) VALUES (1)");
    let msg = "";
    try {
      // 裸查询（不经 enforceLimit 包裹）+ 重名结果列：node:sqlite 对象行会静默折叠只剩后值
      await mgr.runQuery("s", "SELECT id AS x, id+1 AS x FROM t");
    } catch (e) { msg = e.message; }
    if (!/重复/.test(msg) || !/别名/.test(msg)) throw new Error("重名列必须显式拒绝并要求别名: " + msg);
    const ok = await mgr.runQuery("s", "SELECT id AS x, id+1 AS y FROM t");
    if (ok.rows.length !== 1 || ok.fields.join(",") !== "x,y") throw new Error("合法查询被误伤: " + JSON.stringify(ok));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
});
await checkAsync("pool: sqlite 数组行 zip 产品口径钉（v1.6.37 setReturnArrays + columns 单次）", async () => {
  const { createPoolManager, setSqliteStmtCache } = POOL;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbmcp-zipcol-"));
  try {
    const dbf = path.join(tmp, "z.db").replace(/\\/g, "/");
    const sources = { s: { type: "sqlite", url: "sqlite://" + dbf } };
    const mgr = createPoolManager({ cfg: { timeoutMs: 5000 }, getSource: (id) => sources[id], clampInt: (v, a, b, d) => d, sqliteFilePath: () => dbf });
    await mgr.runQuery("s", "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amt REAL, big INTEGER, blob B)");
    await mgr.runQuery("s", "INSERT INTO t VALUES (1, 'α😀', 1.5, 9007199254740993, X'0001FF')");
    const r = await mgr.runQuery("s", "SELECT id, name, amt, big, blob FROM t");
    // 行对象键序 = 列序；INTEGER 走 setReadBigInts → BigInt（与 mysql bigNumberStrings/pg int8 同口径防精度篡改）
    if (r.fields.join(",") !== "id,name,amt,big,blob") throw new Error("fields 漂移: " + r.fields.join(","));
    const row = r.rows[0];
    if (Object.keys(row).join(",") !== "id,name,amt,big,blob") throw new Error("行键序漂移: " + Object.keys(row).join(","));
    const J = (x) => JSON.stringify(x, (k, v) => typeof v === "bigint" ? String(v) : v);
    if (row.id !== 1n || row.name !== "α😀" || row.amt !== 1.5 || row.big !== 9007199254740993n) throw new Error("值口径漂移: " + J(row));
    if (!(row.blob instanceof Uint8Array) || row.blob.length !== 3 || row.blob[0] !== 0x00 || row.blob[1] !== 0x01 || row.blob[2] !== 0xff) throw new Error("BLOB 口径漂移");
    // __proto__ 列经产品路径存活（数组行 zip 走 defineProperty 慢路径）
    const p = await mgr.runQuery("s", 'SELECT 1 AS "__proto__", 2 AS id');
    const prow = p.rows[0];
    const pd = Object.getOwnPropertyDescriptor(prow, "__proto__");
    if (!pd || pd.value !== 1n || prow.id !== 2n) throw new Error("__proto__ 列经产品路径丢值: " + J(p));
    if (Object.getPrototypeOf(prow) !== Object.prototype) throw new Error("__proto__ 列篡改了行原型");
    // 空结果仍带列名
    const e = await mgr.runQuery("s", "SELECT id, name FROM t WHERE 0");
    if (!Array.isArray(e.rows) || e.rows.length !== 0 || e.fields.join(",") !== "id,name") throw new Error("空结果口径漂移: " + J(e));
    // 流式路径行形状钉（setReturnArrays 是语句级状态：iterate() 数组行必须 zip 回对象行，键可直接取）
    const stRows = [];
    await mgr.runQueryStream("s", "SELECT id, name FROM t", { onFields: () => {}, onRow: (row) => { stRows.push(row); } });
    if (stRows.length !== 1 || stRows[0].id !== 1n || stRows[0].name !== "α😀") throw new Error("流式行形状漂移: " + J(stRows));
    const spRows = [];
    await mgr.runQueryStream("s", 'SELECT 1 AS "__proto__", 2 AS id', { onFields: () => {}, onRow: (row) => { spRows.push(row); } });
    const spd = Object.getOwnPropertyDescriptor(spRows[0], "__proto__");
    if (!spd || spd.value !== 1n || spRows[0].id !== 2n) throw new Error("流式 __proto__ 列丢值: " + J(spRows));
    if (Object.getPrototypeOf(spRows[0]) !== Object.prototype) throw new Error("流式 __proto__ 列篡改了行原型");
    // 流式早停后同 SQL 再全量流式完整（句柄不留半步状态——setReturnArrays 回归曾打穿此形态）
    const stFirst = [];
    await mgr.runQueryStream("s", "SELECT id, name FROM t", { onFields: () => {}, onRow: (row) => { stFirst.push(row); return false; } });
    const stFull = [];
    await mgr.runQueryStream("s", "SELECT id, name FROM t", { onFields: () => {}, onRow: (row) => { stFull.push(row); } });
    if (stFirst.length !== 1 || stFull.length !== 1 || stFull[0].name !== "α😀") throw new Error("流式早停后复跑漂移: " + J(stFull));
    // 语句缓存开/关两分支同口径（cachedPrepare 两分支都设 setReturnArrays）
    setSqliteStmtCache(false);
    try {
      const r2 = await mgr.runQuery("s", "SELECT id, name, amt, big, blob FROM t");
      if (J(r2.rows) !== J(r.rows) || r2.fields.join(",") !== r.fields.join(",")) throw new Error("缓存开关两分支输出漂移: " + J(r2));
    } finally { setSqliteStmtCache(true); }
    // 重名列仍前置拒绝（新数组行路径不得放宽）
    let msg = "";
    try { await mgr.runQuery("s", "SELECT id AS x, id+1 AS x FROM t"); } catch (err) { msg = err.message; }
    if (!/重复/.test(msg)) throw new Error("重名列前置拒绝失效: " + msg);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } }
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

/* --- v1.6.3: stdio 错误路径必须回带请求 id（旧版超长行回 id:null、坏 JSON 行静默丢弃，
       请求方对该 id 永久挂起，实测复现）；噪声行维持静默，不制造无主报文 --- */
await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DBMCP_NO_LISTEN: "" },
  });
  const seen = { errors: [], results: [], strays: 0 };
  let buf = "";
  let done = false;
  const finish = () => { if (done) return; done = true; try { child.kill(); } catch {} resolve(); };
  child.stdout.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { seen.strays += 1; continue; }
      if (m.error) seen.errors.push(m);
      else seen.results.push(m);
    }
    const ids = seen.errors.map((m) => m.id).join(",");
    if (seen.errors.length >= 2 && seen.results.some((m) => m.id === 902)) {
      const tooLarge = seen.errors.find((m) => m.id === 900);
      const parseErr = seen.errors.find((m) => m.id === 901);
      if (!tooLarge || tooLarge.error?.code !== -32600) { fail += 1; console.log("FAIL stdio: 超长行错误未回带 id 900（got ids: " + ids + "）"); }
      else if (!/too large/.test(tooLarge.error.message)) { fail += 1; console.log("FAIL stdio: 超长行错误文案不符"); }
      else if (!parseErr || parseErr.error?.code !== -32700) { fail += 1; console.log("FAIL stdio: 坏 JSON 行未回 -32700 + id 901（got ids: " + ids + "）"); }
      else if (seen.strays) { fail += 1; console.log("FAIL stdio: 噪声行不应有响应（strays=" + seen.strays + "）"); }
      else { pass += 1; console.log("PASS stdio: 超长行/坏行错误回带请求 id，噪声行静默"); }
      finish();
    }
  });
  child.stderr.on("data", () => {});
  child.on("error", (e) => { fail += 1; console.log("FAIL stdio error-path spawn:", e.message); finish(); });
  // ① 超长行（>2MB）：拒收但错误必须带 id 900
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 900, method: "tools/call", params: { name: "query", arguments: { source: "x", sql: "SELECT '" + "z".repeat(2_100_000) + "'" } } }) + "\n");
  // ② 坏 JSON（截断的请求）：-32700 + id 901
  child.stdin.write('{"jsonrpc":"2.0","id":901,"method":' + "\n");
  // ③ 噪声行：静默
  child.stdin.write("not json at all\n");
  // ④ 正常请求：证明服务仍存活
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 902, method: "ping" }) + "\n");
  setTimeout(() => { fail += 1; console.log("TIMEOUT stdio error-path (8s): errors=" + JSON.stringify(seen.errors.map((m) => m.id))); finish(); }, 8000);
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

// v1.6.14: 断言总数自证（不计入断言数）——与 EXPECTED_TOTAL 不符即 FAIL，逼迫口径变更显式化
{
  const expectedTotal = initMode ? EXPECTED_TOTAL.uninit : EXPECTED_TOTAL.init;
  const actualTotal = pass + fail;
  if (actualTotal !== expectedTotal) {
    fail += 1;
    console.log("FAIL meta: 断言总数 " + actualTotal + " ≠ EXPECTED_TOTAL." + (initMode ? "uninit" : "init") + "=" + expectedTotal + "（新增/删除断言请同步常量与 3 处文档计数）");
  } else {
    console.log("meta: 断言总数自证一致（" + actualTotal + "，" + (initMode ? "未初始化" : "已初始化") + "口径）");
  }
}
console.log("\n=== " + pass + " passed, " + fail + " failed ===");
process.exit(fail ? 1 : 0);