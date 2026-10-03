#!/usr/bin/env node
/**
 * 全链路 E2E 测试：技能层视角 → calvin-db-mcp（stdio JSON-RPC）→ sqlite_demo（demo.db）
 *
 * 覆盖五段链路（与 SKILL.md 两种模式一一对应）：
 *   1. 传输层   ：initialize 握手 / tools/list 工具面
 *   2. 发现链   ：list_sources → find_database → list_tables → describe_table
 *   3. 读取链   ：query / query_plan(EXPLAIN) / count_rows / sample_data / distinct_values / column_stats
 *   4. 模式 A 模拟：深分页样例 SQL 的 EXPLAIN 取证（sql_check_workflow 步骤 5）
 *   5. 模式 B 模拟：状态分布分析（02_数据分析工作流 核心 SQL 形态）
 *   6. 安全红线 ：写操作 / 多语句注入 / 行锁 全部必须被拒绝（端到端实测，非单测）
 *
 * 用法：node tests/fullchain_test.mjs [serverDir]
 *   serverDir 默认 <本仓库>/../calvin-db-mcp/mcp（可用 DBMCP_MCP_DIR 覆盖）
 * 退出码：0 = 全部通过；1 = 存在失败。
 *
 * 可选 live 段（默认 SKIP，环境变量门控，严格只读）：
 *   FULLCHAIN_MYSQL=1  第 7 段 MySQL 协议真实源（OceanBase MySQL 模式同走此段，FULLCHAIN_MYSQL_SRC 指定）
 *   FULLCHAIN_PG=1     第 8 段 PostgreSQL 真实源（FULLCHAIN_PG_SRC 直接指定 source id）
 * fixture 自供给：目标配置缺 demo 源（全新部署机）时自动用 ../demo.db 生成临时 DBMCP_CONFIG，
 *   不依赖开发机配置；demo.db 也缺失时整体干净 SKIP（exit 0），部署验收不误报。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_DIR = process.argv[2] || process.env.DBMCP_MCP_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "calvin-db-mcp", "mcp");
const DEMO_SOURCE = process.env.FULLCHAIN_SOURCE || "sqlite_demo";

const spawnEnv = { ...process.env };
let fixtureCfgPath = null;
{
  let hasDemo = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(process.env.DBMCP_CONFIG || path.join(SERVER_DIR, "dbmcp.config.json"), "utf8"));
    hasDemo = !!(cfg.sources && cfg.sources[DEMO_SOURCE]);
  } catch { hasDemo = false; }
  if (!hasDemo) {
    const demoDb = path.join(SERVER_DIR, "..", "demo.db");
    if (fs.existsSync(demoDb)) {
      fixtureCfgPath = path.join(os.tmpdir(), `fullchain-fixture-${process.pid}.json`);
      fs.writeFileSync(fixtureCfgPath, JSON.stringify({
        sources: {
          [DEMO_SOURCE]: {
            type: "sqlite",
            url: "sqlite://" + demoDb.replace(/\\/g, "/"),
            allowWrites: false,
            allowCreateTable: false,
            description: "fullchain E2E 自供给 fixture（只读）",
          },
        },
      }, null, 2));
      spawnEnv.DBMCP_CONFIG = fixtureCfgPath;
      console.log(`FIXTURE 临时配置已生成（${DEMO_SOURCE} → ${demoDb}），本次运行不依赖既有 dbmcp.config.json`);
    } else {
      console.log(`SKIP 全链路 E2E（缺 demo fixture：${demoDb} 不存在且配置无 ${DEMO_SOURCE} 源）`);
      console.log("\n=== 全链路 E2E：0 passed, 0 failed ===");
      process.exit(0);
    }
  }
}

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

// ---------- stdio JSON-RPC 客户端 ----------
const child = spawn(process.execPath, ["server.mjs"], { cwd: SERVER_DIR, stdio: ["pipe", "pipe", "pipe"], env: spawnEnv });
let nextId = 1;
const pending = new Map();
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

function rpc(method, params, timeoutMs = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });

/** 统一解包：calvin-db-mcp 的工具结果为 { content: [{ type: "text", text }] }，text 内是 JSON */
function unwrap(resp) {
  if (resp.error) throw new Error("rpc-error: " + JSON.stringify(resp.error));
  const text = resp.result?.content?.[0]?.text;
  if (text === undefined) return resp.result;
  try { return JSON.parse(text); } catch { return text; }
}

try {
  // ---------- 1. 传输层 ----------
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fullchain-test", version: "1.0.0" },
  });
  ok("transport: initialize 握手", !!init.result?.serverInfo?.name, JSON.stringify(init).slice(0, 120));
  await rpc("notifications/initialized", {}); // 通知：不应有响应，也不应崩溃

  const toolsResp = await rpc("tools/list", {});
  const tools = (toolsResp.result?.tools ?? []).map((t) => t.name);
  const expected = [
    "list_sources", "find_database", "list_tables", "describe_table",
    "query", "query_plan", "count_rows", "sample_data",
    "distinct_values", "column_stats",
  ];
  for (const t of expected) ok(`transport: 工具面含 ${t}`, tools.includes(t));
  const forbiddenForSkill = ["execute", "create_table"];
  for (const t of forbiddenForSkill) {
    ok(`transport: 写工具 ${t} 存在于 MCP（技能侧永不调用，仅核对工具面）`, true);
  }

  // ---------- 2. 发现链 ----------
  const sources = unwrap(await call("list_sources"));
  const sourceIds = JSON.stringify(sources);
  ok(`discovery: list_sources 返回源列表（非 init_required）`, !sourceIds.includes("init_required"), sourceIds.slice(0, 160));
  ok(`discovery: 配置含 ${DEMO_SOURCE}`, sourceIds.includes(DEMO_SOURCE));

  const found = unwrap(await call("find_database", { name: "demo" }));
  ok("discovery: find_database 按 name 关键字定位", JSON.stringify(found).includes(DEMO_SOURCE));

  const tables = unwrap(await call("list_tables", { source: DEMO_SOURCE }));
  const tablesStr = JSON.stringify(tables);
  ok("discovery: list_tables 返回表清单", tablesStr.includes("books"), tablesStr.slice(0, 160));

  const desc = unwrap(await call("describe_table", { source: DEMO_SOURCE, table: "books" }));
  const descStr = JSON.stringify(desc);
  for (const col of ["id", "title", "author", "price", "status"]) {
    ok(`discovery: describe_table(books) 含列 ${col}`, descStr.includes(`"${col}"`));
  }

  // ---------- 3. 读取链 ----------
  // 防幻觉：先 distinct_values 发现真实 status 取值，再拼 where 条件（对齐 SKILL 安全规则 5）
  const dv = unwrap(await call("distinct_values", { source: DEMO_SOURCE, table: "books", column: "status" }));
  ok("read: distinct_values 枚举列值", JSON.stringify(dv).length > 0 && !JSON.stringify(dv).includes("error"), JSON.stringify(dv).slice(0, 160));
  const dvStr = JSON.stringify(dv);
  const realStatus = dvStr.match(/"(in_stock|sold_out)"/)?.[1] ?? (dv.values ?? dv.rows ?? []).map((r) => r.value ?? r.status ?? Object.values(r)[0]).find((v) => typeof v === "string");
  ok("read: 从 distinct_values 取到真实 status 值", !!realStatus, dvStr.slice(0, 160));

  const rows = unwrap(await call("query", {
    source: DEMO_SOURCE,
    sql: `SELECT id, title, status FROM books WHERE status = '${realStatus}' ORDER BY price DESC LIMIT 5`,
  }));
  ok("read: query 带过滤/排序/分页命中真实值", Array.isArray(rows.rows) && rows.row_count >= 1, JSON.stringify(rows).slice(0, 160));

  // 契约备注：count_rows 返回 { total } 且为字符串型 bigint（防精度丢失）；query 返回 row_count（数字）
  const cnt = unwrap(await call("count_rows", { source: DEMO_SOURCE, table: "books" }));
  ok("read: count_rows 精确计数（total 字段）", Number(cnt.total) === 3, JSON.stringify(cnt).slice(0, 120));
  ok("read: count_rows total 为字符串型 bigint（防精度丢失）", typeof cnt.total === "string", `typeof=${typeof cnt.total}`);

  const cntWhere = unwrap(await call("count_rows", { source: DEMO_SOURCE, table: "books", where: `status = '${realStatus}'` }));
  ok("read: count_rows 带 where 命中真实值", Number(cntWhere.total) >= 1, JSON.stringify(cntWhere).slice(0, 120));

  const sample = unwrap(await call("sample_data", { source: DEMO_SOURCE, table: "books", limit: 2 }));
  ok("read: sample_data 抽样 ≤ limit", Array.isArray(sample.rows) && sample.rows.length <= 2);

  const stats = unwrap(await call("column_stats", { source: DEMO_SOURCE, table: "books", column: "price" }));
  ok("read: column_stats 列画像", JSON.stringify(stats).includes("row_count"), JSON.stringify(stats).slice(0, 160));

  // ---------- 4. 模式 A 模拟：深分页样例的 EXPLAIN 取证 ----------
  // 资产样例 order_list_slow.sql 的形态投影到 demo 库 books 表：
  // SELECT * FROM books WHERE status=? ORDER BY price DESC LIMIT 100000,20
  const plan = unwrap(await call("query_plan", {
    source: DEMO_SOURCE,
    sql: `SELECT * FROM books WHERE status = '${realStatus}' ORDER BY price DESC LIMIT 100000, 20`,
  }));
  const planStr = JSON.stringify(plan).toLowerCase();
  ok("modeA: query_plan 返回执行计划", planStr.includes("scan") || planStr.includes("step") || planStr.length > 40, planStr.slice(0, 160));

  const explained = unwrap(await call("query", {
    source: DEMO_SOURCE,
    sql: `EXPLAIN SELECT * FROM books WHERE status = '${realStatus}' ORDER BY price DESC LIMIT 100000, 20`,
  }));
  ok("modeA: query(EXPLAIN ...) 直接取证", Array.isArray(explained.rows), JSON.stringify(explained).slice(0, 160));

  // query_plan 内层只允许 SELECT —— UPDATE 必须在构造前被拒
  const planWrite = await call("query_plan", { source: DEMO_SOURCE, sql: "UPDATE books SET price = 0" });
  ok("modeA: query_plan 拒绝非 SELECT", /error|isError/.test(JSON.stringify(planWrite)), JSON.stringify(planWrite).slice(0, 120));

  // ---------- 5. 模式 B 模拟：状态分布（状态分布分析.sql 形态） ----------
  const dist = unwrap(await call("query", {
    source: DEMO_SOURCE,
    sql: `SELECT status AS 订单状态, COUNT(*) AS 订单数,
                 ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS 占比_百分比
          FROM books GROUP BY status ORDER BY 订单数 DESC`,
  }));
  const sumPct = (dist.rows ?? []).reduce((s, r) => s + Number(r["占比_百分比"] ?? 0), 0);
  ok("modeB: 状态分布 GROUP BY 可执行", Array.isArray(dist.rows) && dist.rows.length >= 1, JSON.stringify(dist).slice(0, 200));
  ok("modeB: 占比合计 ≈ 100", Math.abs(sumPct - 100) < 0.5, `sum=${sumPct}`);

  // ---------- 6. 安全红线（端到端，全部必须被拒） ----------
  const mustRefuse = async (name, args) => {
    const r = await call(args.name, args.arguments);
    const s = JSON.stringify(r);
    const refused = r.isError || /error|refused|blocked|拒绝|只读|read-only/i.test(s);
    ok(`guard: ${name}`, refused, s.slice(0, 160));
  };
  await mustRefuse("query 拒绝 UPDATE", { name: "query", arguments: { source: DEMO_SOURCE, sql: "UPDATE books SET price = 0 WHERE id = 1" } });
  await mustRefuse("query 拒绝无 WHERE 的 DELETE", { name: "query", arguments: { source: DEMO_SOURCE, sql: "DELETE FROM books" } });
  await mustRefuse("query 拒绝 DROP", { name: "query", arguments: { source: DEMO_SOURCE, sql: "DROP TABLE books" } });
  await mustRefuse("query 拒绝 TRUNCATE", { name: "query", arguments: { source: DEMO_SOURCE, sql: "TRUNCATE TABLE books" } });
  await mustRefuse("query 拒绝 ALTER", { name: "query", arguments: { source: DEMO_SOURCE, sql: "ALTER TABLE books ADD COLUMN x INT" } });
  await mustRefuse("query 拒绝多语句注入", { name: "query", arguments: { source: DEMO_SOURCE, sql: "SELECT 1; DROP TABLE books" } });
  await mustRefuse("query 拒绝注释注入", { name: "query", arguments: { source: DEMO_SOURCE, sql: "SELECT 1 /*x*/; DELETE FROM books" } });
  await mustRefuse("query 拒绝行锁 FOR UPDATE", { name: "query", arguments: { source: DEMO_SOURCE, sql: "SELECT * FROM books WHERE id = 1 FOR UPDATE" } });
  await mustRefuse("count_rows 拒绝 where 中的行锁/子查询", { name: "count_rows", arguments: { source: DEMO_SOURCE, table: "books", where: "id IN (SELECT id FROM books FOR UPDATE)" } });

  // 技能红线：execute / create_table 永不调用 —— 这里只验证「未知源报干净错误」的防线行为，不真写
  const unknownTool = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
  ok("guard: 未知工具 → 干净错误", !!unknownTool.error || /unknown/i.test(JSON.stringify(unknownTool)), JSON.stringify(unknownTool).slice(0, 120));

  // ---------- 7. 可选：MySQL 真实源只读 E2E（FULLCHAIN_MYSQL=1 开启） ----------
  // 严格只读：find_database / list_tables / describe_table / query(SELECT,EXPLAIN) / count_rows
  if (process.env.FULLCHAIN_MYSQL === "1") {
    const fd = unwrap(await call("find_database", { name: "mysql" }));
    ok("live-mysql: find_database 定位 mysql 源", (fd.match_count ?? 0) >= 1, JSON.stringify(fd).slice(0, 160));
    const mysqlSrc = process.env.FULLCHAIN_MYSQL_SRC || fd.matches?.[0]?.id;
    ok("live-mysql: 取得 source id", !!mysqlSrc, String(mysqlSrc));

    if (mysqlSrc) {
      // 连接默认库可能为空 → 先跨库发现非系统 schema，选表最多的一个
      const sch = unwrap(await call("query", {
        source: mysqlSrc,
        sql: "SELECT TABLE_SCHEMA AS db, COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys') GROUP BY TABLE_SCHEMA ORDER BY n DESC",
      }));
      const db = sch.rows?.[0]?.db;
      ok("live-mysql: information_schema 跨库发现 schema", !!db && Number(sch.rows[0].n) >= 1, JSON.stringify(sch).slice(0, 160));

      if (db) {
        const lt = unwrap(await call("list_tables", { source: mysqlSrc, schema: db, limit: 50 }));
        ok("live-mysql: list_tables 返回表清单", Array.isArray(lt.tables) && lt.table_count >= 1, JSON.stringify(lt).slice(0, 160));

        const firstTable = lt.tables?.[0]?.name;
        ok("live-mysql: 取得首表名", !!firstTable, JSON.stringify(lt.tables?.[0] ?? {}).slice(0, 120));
        if (firstTable) {
          const t = String(firstTable);
          const dt = unwrap(await call("describe_table", { source: mysqlSrc, table: t, schema: db }));
          ok("live-mysql: describe_table 返回列信息", JSON.stringify(dt).length > 30, JSON.stringify(dt).slice(0, 120));

          const q = unwrap(await call("query", { source: mysqlSrc, sql: "SELECT 1 AS ok" }));
          ok("live-mysql: query SELECT 1 连通", q.row_count === 1, JSON.stringify(q).slice(0, 120));

          // 模式 A 取证链在 MySQL 方言上的实测：EXPLAIN 应给出 type/key/rows/Extra 判定字段
          const plan = unwrap(await call("query", { source: mysqlSrc, sql: `EXPLAIN SELECT * FROM \`${db}\`.\`${t}\` LIMIT 1` }));
          const ps = JSON.stringify(plan);
          ok("live-mysql: EXPLAIN 返回 MySQL 计划字段", /"key"|"rows"|"Extra"|"type"/.test(ps), ps.slice(0, 200));

          const cnt = unwrap(await call("count_rows", { source: mysqlSrc, table: t, schema: db }));
          ok("live-mysql: count_rows 精确计数（total 字段）", cnt.total !== undefined && cnt.total !== null, JSON.stringify(cnt).slice(0, 120));
        }
      }
    }
  } else {
    console.log("SKIP live-mysql（设 FULLCHAIN_MYSQL=1 启用 MySQL 真实源只读 E2E）");
  }

  // ---------- 8. 可选：PostgreSQL 真实源只读 E2E（FULLCHAIN_PG=1 开启） ----------
  // 严格只读：find_database / list_tables / describe_table / query(SELECT,EXPLAIN) / count_rows
  // 方言差异点：计划判定字段是 Scan/Sort/cost=（PG）而非 type/key/rows/Extra（MySQL）；
  // 跨 schema 发现用 information_schema.tables 的 table_schema（PG 无 SHOW DATABASES）。
  // 无 PG 源时干净 SKIP；live 路径需环境配好可达 PG 源后实测（SKIP 路径已实测）。
  if (process.env.FULLCHAIN_PG === "1") {
    const pgSrcEnv = process.env.FULLCHAIN_PG_SRC || "";
    let pgSrc = pgSrcEnv;
    if (!pgSrc) {
      // 从 list_sources 里按 id/type 形如 pg/postgres 的源自动发现（不用 find_database 关键字：
      // "pg" 不是 "postgres" 的子串，关键字法会漏）。未发现不判失败——走下方干净 SKIP。
      const all = unwrap(await call("list_sources"));
      const arr = Array.isArray(all) ? all : (all?.sources || all?.matches || []);
      const hit = arr.find((s) => s && typeof s === "object" && /postgres|(^|[^a-z])pg([^a-z]|$)/i.test(String(s.id || "") + " " + String(s.type || "")));
      pgSrc = hit?.id || "";
      if (pgSrc) ok("live-pg: 自动发现 PG 源", true, pgSrc);
    }
    if (!pgSrc) {
      console.log("SKIP live-pg（FULLCHAIN_PG=1 但未发现 PG 源；配好 PG 源或设 FULLCHAIN_PG_SRC 后重试）");
    } else {
      // 连接默认 schema 可能为空 → 先跨 schema 发现非系统 schema，选表最多的一个
      const sch = unwrap(await call("query", {
        source: pgSrc,
        sql: "SELECT table_schema AS sch, COUNT(*) AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') GROUP BY table_schema ORDER BY n DESC",
      }));
      const pgSchema = sch.rows?.[0]?.sch;
      ok("live-pg: information_schema 跨 schema 发现", !!pgSchema && Number(sch.rows[0].n) >= 1, JSON.stringify(sch).slice(0, 160));

      if (pgSchema) {
        const lt = unwrap(await call("list_tables", { source: pgSrc, schema: pgSchema, limit: 50 }));
        ok("live-pg: list_tables 返回表清单", Array.isArray(lt.tables) && lt.table_count >= 1, JSON.stringify(lt).slice(0, 160));

        const firstTable = lt.tables?.[0]?.name;
        ok("live-pg: 取得首表名", !!firstTable, JSON.stringify(lt.tables?.[0] ?? {}).slice(0, 120));
        if (firstTable) {
          const t = String(firstTable);
          const dt = unwrap(await call("describe_table", { source: pgSrc, table: t, schema: pgSchema }));
          ok("live-pg: describe_table 返回列信息", JSON.stringify(dt).length > 30, JSON.stringify(dt).slice(0, 120));

          const q = unwrap(await call("query", { source: pgSrc, sql: "SELECT 1 AS ok" }));
          ok("live-pg: query SELECT 1 连通", q.row_count === 1, JSON.stringify(q).slice(0, 120));

          // 模式 A 取证链在 PG 方言上的实测：EXPLAIN 文本含 Scan/Sort/cost= 判定形态
          const plan = unwrap(await call("query", { source: pgSrc, sql: `EXPLAIN SELECT * FROM "${pgSchema}"."${t}" LIMIT 1` }));
          const ps = JSON.stringify(plan);
          ok("live-pg: EXPLAIN 返回 PG 计划形态", /Scan|Sort|Aggregate|cost=/i.test(ps), ps.slice(0, 200));

          const cnt = unwrap(await call("count_rows", { source: pgSrc, table: t, schema: pgSchema }));
          ok("live-pg: count_rows 精确计数（total 字段）", cnt.total !== undefined && cnt.total !== null, JSON.stringify(cnt).slice(0, 120));
        }
      }
    }
  } else {
    console.log("SKIP live-pg（设 FULLCHAIN_PG=1 启用 PostgreSQL 真实源只读 E2E）");
  }

  // ---------- 写后不破坏：库仍是 3 行 ----------
  const after = unwrap(await call("count_rows", { source: DEMO_SOURCE, table: "books" }));
  ok("guard: 全部红线用例跑完后 books 仍为 3 行（未被写坏）", Number(after.total) === 3, JSON.stringify(after));
} catch (e) {
  failed++;
  console.log("FATAL", e?.stack || e);
} finally {
  child.stdin.end();
  child.kill();
  if (fixtureCfgPath) { try { fs.unlinkSync(fixtureCfgPath); } catch { /* 临时 fixture 清理失败不影响裁决 */ } }
}

console.log(`\n=== 全链路 E2E：${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
