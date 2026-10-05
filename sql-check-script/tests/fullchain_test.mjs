#!/usr/bin/env node
/**
 * 全链路 E2E 测试：技能层视角 → calvin-db-mcp（stdio JSON-RPC）→ sqlite_demo（demo.db）
 *
 * 覆盖八段链路（与 SKILL.md 两种模式一一对应）：
 *   1. 传输层   ：initialize 握手 / tools/list 工具面 + 声明契约钉（名称面稳定 / annotations 四元组语义 / inputSchema 裸属性）
 *   2. 发现链   ：list_sources → find_database → list_tables → describe_table
 *   3. 读取链   ：query / query_plan(EXPLAIN) / count_rows / sample_data / distinct_values / column_stats
 *   4. 模式 A 模拟：深分页样例 SQL 的 EXPLAIN 取证（sql_check_workflow 步骤 5）
 *   5. 模式 B 模拟：状态分布分析（02_数据分析工作流 核心 SQL 形态）
 *   6. 安全红线 ：写操作 / 多语句注入 / 行锁 全部必须被拒绝（端到端实测，非单测）
 *   6b-6e 真实面回归铠甲（v1.4.8）：写工具拒绝矩阵 / 对抗注入面 / 标识符与参数语义 / 错误形态与契约实形
 *      —— 真实探针一次性取证的证据固化为永久回归，红线行为漂移必须先撞本段
 *
 * 用法：node tests/fullchain_test.mjs [serverDir]
 *   serverDir 默认 <本仓库>/../calvin-db-mcp/mcp（可用 DBMCP_MCP_DIR 覆盖）
 * 退出码：0 = 全部通过且无诚实 SKIP；1 = 存在失败；3 = 无失败但有诚实 SKIP
 *   （缺 demo fixture / 开了 live 门却没源 / 服务器因缺依赖起不来）—— 未跑的部分明示出来，不冒充全绿。
 *
 * 可选 live 段（v1.4.4 起自动门控，严格只读）：
 *   未设 = 自动：配置里有 mysql 系 / PG 源就跑对应段，没有就诚实 SKIP；
 *   FULLCHAIN_MYSQL=1 / FULLCHAIN_PG=1 强制开（无源时诚实 SKIP）；=0 显式关闭。
 *   FULLCHAIN_MYSQL_SRC / FULLCHAIN_PG_SRC 直接指定 source id（跳过自动发现）。
 *   裁决细分：断言不成立 = FAIL（产品问题）；连接/权限层抛错 = SKIP 带原因（环境没给条件 ≠ 产品失败）。
 * fixture 自供给：目标配置缺 demo 源（全新部署机）时自动用 ../demo.db 生成临时 DBMCP_CONFIG，
 *   不依赖开发机配置；demo.db 也缺失时整体诚实 SKIP（exit 3 + 明示原因）：不误报失败，也不冒充全绿。
 * fixture 隔离：自供给时复制 demo.db 专用副本再连——共享演示资产与本套件双向不干扰。
 * fixture 残留自愈：进程崩溃/被杀时 finally 清理不会执行，os.tmpdir() 会攒下 fullchain-fixture-*.json/.db
 *   残留（实测攒过带开发机旧路径的旧配置）——开跑时顺手清扫 1 小时前的同前缀残留。
 * 计数断言口径：demo.db 是共享演示资产（sqlite-add.mjs / MCP 演示都会合法写它），行数会变 ——
 *   计数断言一律「与独立 SQL COUNT 交叉一致 / 与开跑基线一致」，不锚定魔法数字。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_DIR = process.argv[2] || process.env.DBMCP_MCP_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "calvin-db-mcp", "mcp");
const DEMO_SOURCE = process.env.FULLCHAIN_SOURCE || "sqlite_demo";

const spawnEnv = { ...process.env };
let passed = 0, failed = 0, skippedHonest = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};
// 诚实 SKIP（统一口径，与 mysql-validate 退出码 3 同义）：想跑但环境没给条件 ——
// 计数并明示原因，不计 passed（那叫假绿）也不计 failed（那叫假红）。
const skip = (name, reason) => { skippedHonest++; console.log(`SKIP ${name}（${reason}）`); };
let fixtureCfgPath = null;
let fixtureDbPath = null;
{
  // 残留自愈：清理 >1h 的同前缀陈旧 fixture（进程崩溃/被杀时 finally 不会执行）。
  // 用 mtime 而非「非本次 pid」判定，避免误删并行运行中的其它 E2E 刚生成的 fixture。
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (!/^fullchain-fixture-\d+\.(json|db)$/.test(f)) continue;
      const p = path.join(os.tmpdir(), f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) {
          fs.unlinkSync(p);
          console.log(`FIXTURE 已清扫陈旧残留：${f}`);
        }
      } catch { /* 竞态：别的进程刚好删了/在用，忽略 */ }
    }
  } catch { /* tmpdir 不可读时跳过清扫，不影响主流程 */ }
  let hasDemo = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(process.env.DBMCP_CONFIG || path.join(SERVER_DIR, "dbmcp.config.json"), "utf8"));
    hasDemo = !!(cfg.sources && cfg.sources[DEMO_SOURCE]);
  } catch { hasDemo = false; }
  if (!hasDemo) {
    const demoDb = path.join(SERVER_DIR, "..", "demo.db");
    if (fs.existsSync(demoDb)) {
      // fixture 隔离：demo.db 是共享演示资产（sqlite-add.mjs / MCP 演示都会合法写它）——
      // 复制专用副本再连，双向不干扰：演示中途写库不会让本套件看到行数漂移，
      // 本套件的服务端连接（可能以可写模式打开 sqlite 文件）也不会给共享库留下 journal/checkpoint 痕迹。
      fixtureDbPath = path.join(os.tmpdir(), `fullchain-fixture-${process.pid}.db`);
      fs.copyFileSync(demoDb, fixtureDbPath);
      fixtureCfgPath = path.join(os.tmpdir(), `fullchain-fixture-${process.pid}.json`);
      fs.writeFileSync(fixtureCfgPath, JSON.stringify({
        sources: {
          [DEMO_SOURCE]: {
            type: "sqlite",
            url: "sqlite://" + fixtureDbPath.replace(/\\/g, "/"),
            allowWrites: false,
            allowCreateTable: false,
            description: "fullchain E2E 自供给 fixture（只读，demo.db 专用副本）",
          },
        },
      }, null, 2));
      spawnEnv.DBMCP_CONFIG = fixtureCfgPath;
      console.log(`FIXTURE 临时配置已生成（${DEMO_SOURCE} → ${fixtureDbPath}，demo.db 专用副本），本次运行不依赖既有 dbmcp.config.json`);
    } else {
      skip("全链路 E2E（整体）", `缺 demo fixture：${demoDb} 不存在且配置无 ${DEMO_SOURCE} 源`);
      console.log("\n=== 全链路 E2E：0 passed, 0 failed, 1 诚实SKIP ===");
      process.exit(3);
    }
  }
}

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
let serverStderr = "";
child.stderr.on("data", (d) => { serverStderr += d; process.stderr.write(`[server] ${d}`); });

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

  // ---------- 1b. 声明契约钉（消费者侧，v1.4.7）----------
  // 背景：V1.6.8 发版时 Unicode 标识符正则丢 `_` 的活回归暴露——技能侧对 MCP 声明面没有
  // 任何机器期望，契约变更只能靠运行期撞出来。这里从消费者视角钉住「已发布声明面」：
  // V1.6.7 的形状钉只查 annotations 是对象，四元组语义 / inputSchema 裸属性 / 工具名稳定性
  // 均无保护——补齐的正是这三处。声明或语义变更 = 契约变更，必须显式更新 golden 表过评审，
  // 不允许静默漂移。
  const decls = toolsResp.result?.tools ?? [];
  const ANN_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const CONTRACT_TOOLS = [
    "list_sources", "find_database", "find_tables_by_column", "fk_relationships",
    "list_tables", "describe_table",
    "query", "query_plan", "count_rows", "sample_data", "distinct_values", "column_stats",
    "execute", "create_table", "import_data", "export_data",
  ];
  ok("decl: 工具面恰为 16 个且名称集合稳定（契约兼容钉：消失/改名/超编即 FAIL）",
    decls.length === 16 && CONTRACT_TOOLS.every((n) => tools.includes(n)) && new Set(tools).size === 16,
    `实际 ${decls.length} 个：${tools.join(",")}`);
  const quadBad = decls.filter((t) => {
    const a = t.annotations ?? {};
    return Object.keys(a).length !== 4 || ANN_KEYS.some((k) => typeof a[k] !== "boolean");
  });
  ok("decl: annotations 四元组齐备（readOnlyHint/destructiveHint/idempotentHint/openWorldHint 恰 4 键全布尔）",
    quadBad.length === 0, "违规：" + quadBad.map((t) => t.name).join(","));
  // 逐工具语义 golden 表 = 已发布契约面。角色约定：
  //   11 个只读工具 readOnly:true / destructive:false；
  //   execute 唯一 destructive:true（写语句，技能侧一律禁用）；
  //   create_table / import_data / export_data 非只读但 destructive:false（技能侧一律禁用）；
  //   list_sources 只读本机配置面，唯一 openWorldHint:false。
  const EXPECTED_ANN = {
    list_sources:          { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false },
    find_database:         { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    find_tables_by_column: { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    fk_relationships:      { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    list_tables:           { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    describe_table:        { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    query:                 { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    query_plan:            { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    count_rows:            { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    sample_data:           { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    distinct_values:       { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    column_stats:          { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    execute:               { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true },
    create_table:          { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    import_data:           { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    export_data:           { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  };
  const semBad = decls.filter((t) => {
    const e = EXPECTED_ANN[t.name];
    return !e || ANN_KEYS.some((k) => e[k] !== t.annotations?.[k]);
  });
  ok("decl: annotations 语义与 golden 表逐一对齐（语义变更 = 契约变更，须显式改表）",
    semBad.length === 0, "偏离：" + semBad.map((t) => t.name).join(","));
  const shapeBad = decls.filter((t) => {
    const s = t.inputSchema ?? {};
    if (s.type !== "object" || s.additionalProperties !== false) return true;
    return Object.values(s.properties ?? {}).some((p) => typeof p?.description !== "string" || !p.description.trim());
  });
  ok("decl: inputSchema 全部 type=object + additionalProperties:false + 属性零裸 description",
    shapeBad.length === 0, "违规：" + shapeBad.map((t) => t.name).join(","));

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
  // 计数不锚定魔法数字（demo.db 行数会因演示/自测合法变动）：与独立 SQL COUNT 交叉一致 + 开跑基线。
  const cntViaSql = unwrap(await call("query", { source: DEMO_SOURCE, sql: "SELECT COUNT(*) AS c FROM books" }));
  const baselineCount = Number(cntViaSql.rows?.[0]?.c);
  ok("read: demo fixture 健康（books 非空）", baselineCount >= 1, `SQL COUNT=${baselineCount}（demo.db 被清空/损坏时，从发布包同级 calvin-db-mcp/demo.db 恢复）`);

  const cnt = unwrap(await call("count_rows", { source: DEMO_SOURCE, table: "books" }));
  ok("read: count_rows 精确计数（与 SQL COUNT 交叉一致）",
    Number.isFinite(baselineCount) && Number(cnt.total) === baselineCount,
    `count_rows=${cnt.total} / SQL COUNT=${cntViaSql.rows?.[0]?.c}`);
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
  ok("modeA: query_plan 返回结构化计划（plan/rows 非空）",
    (Array.isArray(plan.plan) && plan.plan.length >= 1) || (Array.isArray(plan.rows) && plan.rows.length >= 1) || /cost/.test(planStr),
    planStr.slice(0, 160));
  ok("modeA: 计划命中表名 books（取证与真实表对齐）", /books/.test(planStr), planStr.slice(0, 160));
  ok("modeA: 计划含访问路径/代价证据（SCAN/SEARCH/INDEX/ROWS/COST/SORT）",
    /(scan|search|index|seq|rows|cost|sort|temp)/i.test(planStr), planStr.slice(0, 160));
  // 深分页专项：ORDER BY 无可用索引 → 计划必须给出排序代价证据（模式 A 慢查询核心信号）。
  // 方言证据形态：SQLite "USE TEMP B-TREE FOR ORDER BY" / MySQL "Using filesort" / PG "Sort" 节点。
  ok("modeA: 深分页计划含排序代价证据（filesort/TEMP B-TREE/Sort）",
    /(filesort|temp b-tree|top-n)/.test(planStr) || /\bsort\b/.test(planStr), planStr.slice(0, 200));

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

  // 空结果集是合法结果：数据分析里 0 行 ≠ 查询失败（常见误报：把空结果当错误重查）
  const empty = unwrap(await call("query", {
    source: DEMO_SOURCE,
    sql: "SELECT id, title FROM books WHERE price > 999999999 ORDER BY id",
  }));
  ok("modeB: 空结果集合法（0 行非错误）", Array.isArray(empty.rows) && empty.rows.length === 0 && empty.row_count === 0, JSON.stringify(empty).slice(0, 160));

  // 多维分组：状态 × 作者交叉分布（数据核对常用形态，NULL 分组跟随底层引擎语义）
  const dim2 = unwrap(await call("query", {
    source: DEMO_SOURCE,
    sql: `SELECT status, author, COUNT(*) AS n FROM books GROUP BY status, author ORDER BY n DESC`,
  }));
  ok("modeB: 多维分组（status × author）可执行且非空",
    Array.isArray(dim2.rows) && dim2.rows.length >= 1 && JSON.stringify(dim2.columns ?? []).includes("author"),
    JSON.stringify(dim2).slice(0, 200));

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

  // ---------- 6b. 真实面回归铠甲 · 写工具拒绝矩阵（v1.4.8，真实探针证据固化）----------
  // 背景：一次性真实探针（40+ 探针）首轮实证红线全守住，但暴露测试盲区——写工具门控、
  // 对抗注入、标识符回归、错误形态此前均无永久回归。这里把探针证据固化：行为漂移先撞本段。
  // 写门形态确定性：fixture 自供给 = 明确只读；用既有配置时读 allowWrites/allowCreateTable，
  // 形态未知或已开启 → 诚实 SKIP（部署方开启写权限是其选择，不能因此判产品失败，更不能真写去测）。
  let writesDisabled = fixtureCfgPath !== null;
  let createDisabled = fixtureCfgPath !== null;
  if (!writesDisabled) {
    try {
      const cfgJson = JSON.parse(fs.readFileSync(process.env.DBMCP_CONFIG || path.join(SERVER_DIR, "dbmcp.config.json"), "utf8"));
      const srcCfg = cfgJson.sources?.[DEMO_SOURCE] ?? {};
      writesDisabled = !(srcCfg.allowWrites ?? cfgJson.allowWrites);
      createDisabled = !(srcCfg.allowCreateTable ?? cfgJson.allowCreateTable);
    } catch { /* 配置不可读 → 形态未知，走诚实 SKIP */ }
  }
  {
    const s = (r) => JSON.stringify(r);
    const writeGates = [
      ["execute(CREATE TABLE) 被写门拒绝", "execute", { source: DEMO_SOURCE, sql: "CREATE TABLE fullchain_probe_t (x)" }, writesDisabled],
      ["execute(INSERT) 被写门拒绝", "execute", { source: DEMO_SOURCE, sql: "INSERT INTO books (id) VALUES (999999999)" }, writesDisabled],
      ["create_table 被建表门拒绝", "create_table", { source: DEMO_SOURCE, sql: "CREATE TABLE fullchain_probe_t (x)" }, createDisabled],
      // import 双层门控（探针 D2 实证）：即使 DBMCP_IMPORT_DIR 已开，写总开关仍二次拦截——writesDisabled 即可断言
      ["import_data 被配置门/写门拒绝（双层门控）", "import_data", { source: DEMO_SOURCE, table: "books", filename: "fullchain_probe.csv" }, writesDisabled],
      // export 门 = 纯环境变量 DBMCP_EXPORT_DIR（服务端白名单，防任意路径写盘）
      ["export_data 无 DBMCP_EXPORT_DIR 被配置门拒绝", "export_data", { source: DEMO_SOURCE, sql: "SELECT id FROM books", filename: "fullchain_probe_export.csv" }, !process.env.DBMCP_EXPORT_DIR],
    ];
    for (const [label, tool, args, deterministic] of writeGates) {
      if (!deterministic) { skip(`guard-write: ${label}`, "写门形态由部署配置决定（allowWrites/环境变量未知或已开启），不可确定性断言，也不真写去测"); continue; }
      const r = await call(tool, args);
      ok(`guard-write: ${label}`, !!r.result?.isError || !!r.error || /E_CONFIG|disabled|未启用|不允许|拒绝/i.test(s(r)), s(r).slice(0, 160));
    }
  }

  // ---------- 6c. 真实面回归铠甲 · 对抗注入面（探针 C 组证据固化）----------
  // 断言口径 = 「拒绝」且错误分类到位（V1.6.5 错误码契约 [E_<类>:<retry>]）：
  // 只读前缀（SELECT/WITH/SHOW/DESCRIBE/EXPLAIN）外一律 E_PARAM；危险函数 E_SAFETY。
  {
    const s = (r) => JSON.stringify(r);
    const injects = [
      ["query 拒绝 ATTACH（只读前缀）", "query", { source: DEMO_SOURCE, sql: "ATTACH DATABASE 'evil.db' AS evil" }, /\[E_PARAM:/],
      ["query 拒绝 PRAGMA（只读前缀）", "query", { source: DEMO_SOURCE, sql: "PRAGMA writable_schema=ON" }, /\[E_PARAM:/],
      ["query 拒绝 load_extension（危险函数）", "query", { source: DEMO_SOURCE, sql: "SELECT load_extension('evil')" }, /\[E_SAFETY:/],
      ["query 拒绝 VALUES 前缀（只读前缀不含 VALUES）", "query", { source: DEMO_SOURCE, sql: "VALUES (1)" }, /\[E_PARAM:/],
      ["count_rows 拒绝 where 多语句注入（;DROP）", "count_rows", { source: DEMO_SOURCE, table: "books", where: "1=1; DROP TABLE books" }, /\[E_PARAM:/],
      ["sample_data 拒绝 order_by 堆叠/注释注入", "sample_data", { source: DEMO_SOURCE, table: "books", order_by: "id DESC; --" }, /\[E_PARAM:/],
      ["sample_data 拒绝 order_by 子查询注入", "sample_data", { source: DEMO_SOURCE, table: "books", order_by: "(SELECT 1)" }, /\[E_PARAM:/],
      ["describe_table 拒绝堆叠注入表名", "describe_table", { source: DEMO_SOURCE, table: "books; DROP TABLE books" }, /\[E_PARAM:/],
      ["describe_table 拒绝路径穿越表名", "describe_table", { source: DEMO_SOURCE, table: "../books" }, /\[E_PARAM:/],
    ];
    for (const [label, tool, args, eClass] of injects) {
      const r = await call(tool, args);
      const t = s(r);
      ok(`guard-inject: ${label}`, (r.result?.isError || !!r.error) && eClass.test(t), t.slice(0, 160));
    }
  }

  // ---------- 6d. 真实面回归铠甲 · 标识符与参数语义（V1.6.8 类回归 + intArg 边界口径）----------
  {
    const s = (r) => JSON.stringify(r);
    // V1.6.8 活回归类：Unicode 标识符正则丢 `_` 致 customers_copy 被拒——合法名不得被标识符层拒
    const legalBad = [];
    for (const tname of ["customers_copy", "订单表"]) {
      const r = await call("describe_table", { source: DEMO_SOURCE, table: tname });
      if (/invalid identifier/i.test(s(r))) legalBad.push(tname);
    }
    ok("armor: 合法标识符（customers_copy/订单表）过标识符层（V1.6.8 类回归装甲）",
      legalBad.length === 0, "被标识符层拒：" + legalBad.join(","));
    const illegalSlipped = [];
    for (const tname of ["1bad", "a-b", "books'--"]) {
      const r = await call("describe_table", { source: DEMO_SOURCE, table: tname });
      if (!/invalid identifier|invalid table name/i.test(s(r))) illegalSlipped.push(tname);
    }
    ok("armor: 非法标识符（1bad/a-b/引号名）被 E_PARAM 标识符层拒",
      illegalSlipped.length === 0, "漏过标识符层：" + illegalSlipped.join(","));
    // intArg 边界语义（v1.4.8 口径钉，见工具映射「数值上限是夹取不是拒绝」）：
    // 下限/非整数 → E_PARAM 拒；超上限 → 静默夹取后成功（selftest/mysql-validate 双钉的设计意图，
    // 消费侧不得把「没报错」当「取到请求条数」——语义变更 = 契约变更，须显式改此处）。
    const limRejects = [];
    for (const v of [0, 1.5]) {
      const r = await call("sample_data", { source: DEMO_SOURCE, table: "books", limit: v });
      if (!(r.result?.isError && /\[E_PARAM:/.test(s(r)))) limRejects.push(String(v));
    }
    ok("armor: limit 下限/非整数拒绝（0、1.5 → E_PARAM）", limRejects.length === 0, "未拒：" + limRejects.join(","));
    const clamp = unwrap(await call("sample_data", { source: DEMO_SOURCE, table: "books", limit: 51 }));
    ok("armor: limit 超上限走夹取语义（51 → 成功且 rows ≤ 50，非拒绝）",
      !!clamp && typeof clamp === "object" && Array.isArray(clamp.rows) && clamp.rows.length <= 50,
      typeof clamp === "string" ? clamp.slice(0, 160) : JSON.stringify(clamp).slice(0, 160));
    // 声明/行为口径钉（v1.4.9）：maximum 是夹取上限不是拒绝阈值——凡声明 maximum 的属性，
    // description 必须带 clamp 语义注记（第 7 轮真实探针逮到的口径差，修复后钉死防回归）。
    const clampNoteMissing = [];
    for (const t of (toolsResp.result?.tools ?? [])) {
      for (const [pname, p] of Object.entries(t.inputSchema?.properties ?? {})) {
        if (p && typeof p.maximum === "number" && !/clamp/i.test(String(p.description ?? ""))) clampNoteMissing.push(`${t.name}.${pname}`);
      }
    }
    ok("armor: maximum 属性声明带 clamp 语义注记（声明/行为口径差防回归）",
      clampNoteMissing.length === 0, "缺注记：" + clampNoteMissing.join(","));
  }

  // ---------- 6e. 真实面回归铠甲 · 错误形态与契约实形（探针 E/F 组证据固化）----------
  {
    const s = (r) => JSON.stringify(r);
    const unknownSrc = await call("query", { source: "nope_source", sql: "SELECT 1" });
    ok("armor: 未知源错误形态 [E_NOT_FOUND:no-retry]（错误分类契约）",
      /\[E_NOT_FOUND:no-retry\]/.test(s(unknownSrc)), s(unknownSrc).slice(0, 160));
    const dvArmor = unwrap(await call("distinct_values", { source: DEMO_SOURCE, table: "books", column: "status" }));
    ok("armor: distinct_values distinct_total 为字符串 bigint（契约字段）",
      typeof dvArmor?.distinct_total === "string", `typeof=${typeof dvArmor?.distinct_total}`);
    const ftc = unwrap(await call("find_tables_by_column", { source: DEMO_SOURCE, column: "author" }));
    ok("armor: find_tables_by_column 按列名反查命中 books",
      typeof ftc === "object" && JSON.stringify(ftc).includes("books"), JSON.stringify(ftc).slice(0, 160));
    const ftcMiss = await call("find_tables_by_column", { source: DEMO_SOURCE });
    ok("armor: find_tables_by_column 缺 column 干净报错（E_PARAM）",
      !!ftcMiss.result?.isError && /\[E_PARAM:/.test(s(ftcMiss)), s(ftcMiss).slice(0, 160));
    const fkr = unwrap(await call("fk_relationships", { source: DEMO_SOURCE, table: "books" }));
    ok("armor: fk_relationships 无外键优雅返回（fk_count 字段在）",
      typeof fkr === "object" && "fk_count" in fkr, JSON.stringify(fkr).slice(0, 160));
    // 错误类矩阵钉（v1.4.11，探针 v3 证据）：驱动/语句级数据库错误统一 [E_DB:<retry>]——
    // create_table DDL 表名标识符口径差（曾落 E_DB 而非 E_PARAM）已销账（v1.4.15 修复：守卫层预校验，
    // 实测 [E_PARAM:no-retry] Invalid identifier）；本套件不钉该行为——默认夹具建表门关闭时
    // E_CONFIG gate-first 先于表名校验，行为面钉在 calvin selftest（纯函数层 3 钉）。
    const dbErrFn = await call("query", { source: DEMO_SOURCE, sql: "SELECT nosuchfunc(1) AS x" });
    ok("armor: query 驱动错误（未定义函数）→ [E_DB:]（错误类矩阵）",
      /\[E_DB:/.test(s(dbErrFn)), s(dbErrFn).slice(0, 160));
    const dbErrSyntax = await call("query", { source: DEMO_SOURCE, sql: "SELECT * FROM" });
    ok("armor: query 语句级错误（语法残缺）→ [E_DB:<retry>] 形态（错误类矩阵）",
      /\[E_DB:(retryable|conditional|no-retry)\]/.test(s(dbErrSyntax)), s(dbErrSyntax).slice(0, 160));
  }

  // ---------- 6f. 真实面回归铠甲 · 契约实形（探针 v5 证据：column_stats/query_plan 字段族）----------
  {
    const cs = unwrap(await call("column_stats", { source: DEMO_SOURCE, table: "books", column: "id" }));
    const statsFields = ["row_count", "non_null", "distinct_values", "min_value", "max_value", "avg_value"];
    ok("armor: column_stats 六字段在 stats 子对象（非顶层，防消费侧取错层）",
      typeof cs === "object" && statsFields.every((f) => f in (cs.stats || {})), JSON.stringify(cs?.stats ?? cs).slice(0, 160));
    const cs2 = unwrap(await call("column_stats", { source: DEMO_SOURCE, table: "books", column: "id", histogram: { buckets: 4 }, top_values: { limit: 3 } }));
    const h0 = cs2?.histogram?.[0] || {}, t0 = cs2?.top_values?.[0] || {};
    ok("armor: histogram 桶界四字段 + top_values(value/count)（opt-in 参数契约）",
      "bucket_index" in h0 && "bucket_lower" in h0 && "bucket_upper" in h0 && "row_count" in h0 && "value" in t0 && "count" in t0,
      JSON.stringify({ h: h0, t: t0 }).slice(0, 160));
    const qp = unwrap(await call("query_plan", { source: DEMO_SOURCE, sql: "SELECT * FROM books WHERE id = 1" }));
    ok("armor: query_plan plan_format 字段 + plan 数组（sqlite=EXPLAIN QUERY PLAN 树）",
      typeof qp?.plan_format === "string" && Array.isArray(qp?.plan), `plan_format=${qp?.plan_format} plan_rows=${qp?.plan?.length}`);

    // 错误类全码铠甲（v1.4.18，探针 v6 证据固化，见故障处理.md §五矩阵表）：报文全码形态
    // `Error: [E_CODE:retry] 消息`、retry 三值域（retryable|conditional|no-retry）、分层归类
    // （词法层→门层→驱动层）。钉全部双态稳定（关门/开门配置下行为一致或二选一），语义变更=契约变更须显式改此处。
    const s = (r) => JSON.stringify(r);
    const errText = (r) => r?.result?.content?.[0]?.text ?? "";
    const lex = await call("query", { source: DEMO_SOURCE, sql: "SELEC 1" });
    ok("armor: query 首词非法撞词法层 → [E_PARAM:no-retry] Read-only tool（分层归类契约）",
      /\[E_PARAM:no-retry\].*Read-only tool/i.test(s(lex)), s(lex).slice(0, 160));
    const noSuch = await call("query", { source: DEMO_SOURCE, sql: "SELECT * FROM no_such_table_xyz" });
    ok("armor: 表不存在走 [E_DB:no-retry] 驱动透传（no such table，非 E_NOT_FOUND）",
      /\[E_DB:no-retry\].*no such table/i.test(s(noSuch)), s(noSuch).slice(0, 160));
    const closedWrite = await call("execute", { source: DEMO_SOURCE, sql: "DELETE FROM books" });
    ok("armor: 写操作必被拒（关门 [E_CONFIG] Writes are disabled / 开门 [E_SAFETY] 红线，双态契约）",
      /\[E_CONFIG:no-retry\].*Writes are disabled|\[E_SAFETY:/i.test(s(closedWrite)), s(closedWrite).slice(0, 160));
    const ctas = await call("create_table", { source: DEMO_SOURCE, sql: "CREATE TABLE copy_x SELECT * FROM books" });
    ok("armor: CTAS 必被拒（关门 [E_CONFIG] gate-first / 开门 [E_SAFETY]，双态契约）",
      /\[E_CONFIG:no-retry\].*建表未启用|\[E_SAFETY:/i.test(s(ctas)), s(ctas).slice(0, 160));
    ok("armor: 错误报文全码格式 Error: [E_CODE:retry]（retry 三值域）",
      /^Error: \[E_[A-Z_]+:(retryable|conditional|no-retry)\] /.test(errText(closedWrite)) &&
      /^Error: \[E_[A-Z_]+:(retryable|conditional|no-retry)\] /.test(errText(lex)),
      (errText(closedWrite) || "").slice(0, 120));
  }

  // ---------- 7. 可选：MySQL 真实源只读 E2E（v1.4.4 自动门控）----------
  // 严格只读：find_database / list_tables / describe_table / query(SELECT,EXPLAIN) / count_rows
  // 门控三级：FULLCHAIN_MYSQL=1 强制开 / =0 强制关 / 未设 = 自动（配置里有 mysql 系源就跑）。
  // 自动门控消除的盲区：装了源却忘开门控 → live 段常年 SKIP 没人发现。
  // 诚实口径细分：断言不成立 = FAIL（产品问题）；rpc/连接层抛错 = SKIP 带原因（环境没给条件 ≠ 产品失败）。
  const findSrc = (list, re) => {
    const arr = Array.isArray(list) ? list : (list?.sources || list?.matches || []);
    return arr.find((s) => s && typeof s === "object" && re.test(String(s.id || "") + " " + String(s.type || "")));
  };
  if (process.env.FULLCHAIN_MYSQL === "0") {
    console.log("SKIP live-mysql（FULLCHAIN_MYSQL=0 显式关闭）");
  } else {
    let mysqlSrc = process.env.FULLCHAIN_MYSQL_SRC || "";
    if (!mysqlSrc) {
      const hit = findSrc(sources, /mysql|mariadb|oceanbase|tidb/i);
      if (hit) {
        mysqlSrc = String(hit.id);
        if (process.env.FULLCHAIN_MYSQL !== "1") console.log(`LIVE-MYSQL 自动门控：发现 mysql 系源 ${mysqlSrc}，启用 live 段（FULLCHAIN_MYSQL=0 显式关闭）`);
      }
    }
    if (!mysqlSrc) {
      if (process.env.FULLCHAIN_MYSQL === "1") {
        skip("live-mysql", "FULLCHAIN_MYSQL=1 但未发现 mysql 源；配好 mysql 源或设 FULLCHAIN_MYSQL_SRC 后重试");
      } else {
        // 自动门控未命中 = 设计默认（≠「想跑没条件」），不计诚实 SKIP —— 与 =0 显式关闭同口径
        console.log("SKIP live-mysql（自动门控未命中：配置无 mysql 系源；FULLCHAIN_MYSQL=1 + FULLCHAIN_MYSQL_SRC=<id> 可强制）");
      }
    } else {
      try {
        ok("live-mysql: 定位 mysql 系源", !!mysqlSrc, String(mysqlSrc));
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
      } catch (e) {
        skip("live-mysql", `已过断言照计，其后中断（连接/权限/环境问题）：${e?.message ?? e}`);
      }
    }
  }

  // ---------- 8. 可选：PostgreSQL 真实源只读 E2E（v1.4.4 自动门控）----------
  // 严格只读：find_database / list_tables / describe_table / query(SELECT,EXPLAIN) / count_rows
  // 方言差异点：计划判定字段是 Scan/Sort/cost=（PG）而非 type/key/rows/Extra（MySQL）；
  // 跨 schema 发现用 information_schema.tables 的 table_schema（PG 无 SHOW DATABASES）。
  // 门控与裁决口径同 MySQL 段：=1 强制开 / =0 强制关 / 未设自动；断言不成立 = FAIL，连接层抛错 = SKIP。
  if (process.env.FULLCHAIN_PG === "0") {
    console.log("SKIP live-pg（FULLCHAIN_PG=0 显式关闭）");
  } else {
    // 从 list_sources 里按 id/type 形如 pg/postgres 的源自动发现（不用 find_database 关键字：
    // "pg" 不是 "postgres" 的子串，关键字法会漏）。未发现不判失败——走下方干净 SKIP。
    let pgSrc = process.env.FULLCHAIN_PG_SRC || "";
    if (!pgSrc) {
      const hit = findSrc(sources, /postgres|(^|[^a-z])pg([^a-z]|$)/i);
      if (hit) {
        pgSrc = String(hit.id);
        if (process.env.FULLCHAIN_PG !== "1") console.log(`LIVE-PG 自动门控：发现 PG 源 ${pgSrc}，启用 live 段（FULLCHAIN_PG=0 显式关闭）`);
      }
    }
    if (!pgSrc) {
      if (process.env.FULLCHAIN_PG === "1") {
        skip("live-pg", "FULLCHAIN_PG=1 但未发现 PG 源；配好 PG 源或设 FULLCHAIN_PG_SRC 后重试");
      } else {
        // 自动门控未命中 = 设计默认（≠「想跑没条件」），不计诚实 SKIP —— 与 =0 显式关闭同口径
        console.log("SKIP live-pg（自动门控未命中：配置无 PG 源；FULLCHAIN_PG=1 + FULLCHAIN_PG_SRC=<id> 可强制）");
      }
    } else {
      try {
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
      } catch (e) {
        skip("live-pg", `已过断言照计，其后中断（连接/权限/环境问题）：${e?.message ?? e}`);
      }
    }
  }

  // ---------- 写后不破坏：行数与开跑基线一致（测「未被写坏」，不是「等于某个数」） ----------
  const after = unwrap(await call("count_rows", { source: DEMO_SOURCE, table: "books" }));
  ok("guard: 全部红线用例跑完后 books 行数与开跑基线一致（未被写坏）", Number(after.total) === baselineCount, `开跑=${baselineCount} / 跑完=${after.total}`);
} catch (e) {
  // 只有「缺模块起不来」算诚实 SKIP（环境没装依赖 ≠ 产品失败）；
  // 其余任何崩溃照旧 FATAL——别让 SKIP 口径变成遮丑布。
  const missingDep = /Cannot find (?:package|module) |ERR_MODULE_NOT_FOUND/.test(serverStderr);
  if (missingDep && passed === 0 && failed === 0) {
    const m = serverStderr.match(/Cannot find (?:package|module) '[^']+'/);
    skip("全链路 E2E（整体）", `calvin-db-mcp 缺依赖服务器起不来（${m ? m[0] : "模块缺失"}）——先在 calvin-db-mcp/mcp 下 npm ci 再跑`);
  } else {
    failed++;
    console.log("FATAL", e?.stack || e);
  }
} finally {
  child.stdin.end();
  child.kill();
  // Windows：kill 后句柄释放有延迟，立即 unlink .db 会 EBUSY/EPERM——
  // 等退出事件（2s 封顶）+ 短重试；仍失败则留给开跑清扫自愈（>1h 残留口径）
  await new Promise((res) => {
    const t = setTimeout(res, 2000);
    child.once("exit", () => { clearTimeout(t); res(); });
  });
  for (const p of [fixtureCfgPath, fixtureDbPath]) {
    if (!p) continue;
    for (let i = 0; i < 5; i++) {
      try { fs.unlinkSync(p); break; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  }
}

console.log(`\n=== 全链路 E2E：${passed} passed, ${failed} failed, ${skippedHonest} 诚实SKIP ===`);
process.exit(failed ? 1 : skippedHonest ? 3 : 0);
