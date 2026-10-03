// SQLite 全功能活库验证：最高权限（allowWrites + allowCreateTable），走真实 MCP 调用链
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const here = new URL(".", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const mcpDir = here; // 本脚本位于 mcp/ 目录内（v1.2.0 转正）
const tmp = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "sqlite-validate-"));
const dbFile = path.join(tmp, "shop.db").replace(/\\/g, "/");
const testCfg = path.join(tmp, "config.json");
// 测试期最高权限 + maxAffectedRows=3（低阈值以便验证语义预检拦截）+ 导出白名单目录（v1.3.0）
process.env.DBMCP_EXPORT_DIR = path.join(tmp, "exports");
fs.mkdirSync(process.env.DBMCP_EXPORT_DIR, { recursive: true });
fs.writeFileSync(testCfg, JSON.stringify({
  maxRows: 200, timeoutMs: 30000, allowWrites: false, maxAffectedRows: 3,
  sources: {
    sqlite_shop: {
      type: "sqlite", url: "sqlite://" + dbFile,
      allowWrites: true, allowCreateTable: true, description: "验证用本地库",
    },
  },
}));
process.env.DBMCP_NO_LISTEN = "1";
process.env.DBMCP_CONFIG = testCfg;
const { handleRpc } = await import(new URL("./server.mjs", import.meta.url).href);

let pass = 0, fail = 0;
const call = async (name, args) => {
  const r = await handleRpc({ jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  const text = r.result?.content?.[0]?.text || "";
  return { isError: !!r.result?.isError, data: (() => { try { return JSON.parse(text); } catch { return text; } })(), text };
};
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (detail ? " - " + detail : "")); }
};
const S = "sqlite_shop";

// ① 建表（主表 + 外键子表）
let r = await call("create_table", { source: S, sql: "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, level TEXT DEFAULT 'normal', balance INTEGER)" });
check("create_table customers", !r.isError, r.text.slice(0, 120));
r = await call("create_table", { source: S, sql: "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), amount INTEGER, status TEXT)" });
check("create_table orders (with FK)", !r.isError, r.text.slice(0, 120));
r = await call("create_table", { source: S, sql: "DROP TABLE customers" });
check("create_table: DROP refused (red line)", r.isError, r.text.slice(0, 80));
r = await call("create_table", { source: S, sql: "CREATE TABLE x AS SELECT 1" });
check("create_table: CTAS refused", r.isError, r.text.slice(0, 80));

// ② 结构可见
r = await call("list_tables", { source: S });
check("list_tables sees 2 tables", !r.isError && r.data.tables.length === 2, JSON.stringify(r.data).slice(0, 150));
r = await call("describe_table", { source: S, table: "orders" });
check("describe_table orders: 4 cols + PK", !r.isError && r.data.columns.length === 4 && r.data.primary_key.includes("id"), JSON.stringify(r.data.columns).slice(0, 200));
check("describe_table orders: FK index visible", !r.isError && Array.isArray(r.data.indexes));

// ③ 写入（INSERT ×4，一对多）
r = await call("execute", { source: S, sql: "INSERT INTO customers (id, name, level, balance) VALUES (1, 'Alice', 'vip', 100)" });
check("execute INSERT customers#1 affected=1", !r.isError && r.data.affected_rows === 1, r.text.slice(0, 100));
await call("execute", { source: S, sql: "INSERT INTO customers (id, name, level, balance) VALUES (2, 'Bob', 'normal', 50)" });
await call("execute", { source: S, sql: "INSERT INTO customers (id, name, level, balance) VALUES (3, 'Carol', 'vip', 80)" });
r = await call("execute", { source: S, sql: "INSERT INTO orders (id, customer_id, amount, status) VALUES (100, 1, 30, 'SENT')" });
check("execute INSERT orders#100", !r.isError, r.text.slice(0, 100));
await call("execute", { source: S, sql: "INSERT INTO orders (id, customer_id, amount, status) VALUES (101, 1, 20, 'SENT')" });
await call("execute", { source: S, sql: "INSERT INTO orders (id, customer_id, amount, status) VALUES (102, 2, 50, 'PAID')" });
// FK 约束生效（外键指向不存在的客户 → 应回错）
r = await call("execute", { source: S, sql: "INSERT INTO orders (id, customer_id, amount, status) VALUES (103, 999, 1, 'SENT')" });
check("FK constraint enforced (insert orphan refused)", r.isError, r.text.slice(0, 100));

// ④ 读与验证
r = await call("count_rows", { source: S, table: "customers" });
check("count_rows customers = 3 (BIGINT as string, 三库一致)", !r.isError && Number(r.data.total) === 3 && typeof r.data.total === "string", r.text.slice(0, 100));
r = await call("query", { source: S, sql: "SELECT c.name, o.amount FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id" });
check("query JOIN 3 rows", !r.isError && r.data.row_count === 3 && r.data.rows[0].name === "Alice", JSON.stringify(r.data.rows).slice(0, 150));
r = await call("sample_data", { source: S, table: "customers", where: "level = 'vip'", order_by: "balance DESC", limit: 5 });
check("sample_data where+order", !r.isError && r.data.row_count === 2 && r.data.rows[0].name === "Alice", JSON.stringify(r.data.rows).slice(0, 150));
r = await call("distinct_values", { source: S, table: "orders", column: "status" });
check("distinct_values status: 2 values, SENT=2 (cnt as string)", !r.isError && Number(r.data.distinct_total) === 2 && r.data.values[0].value === "SENT" && Number(r.data.values[0].cnt) === 2, JSON.stringify(r.data.values));
r = await call("find_tables_by_column", { source: S, column: "amount" });
check("find_tables_by_column amount -> orders", !r.isError && r.data.tables.includes("orders"), JSON.stringify(r.data.tables));
r = await call("fk_relationships", { source: S });
check("fk_relationships: orders.customer_id -> customers.id", !r.isError && r.data.relationships.length === 1 && r.data.relationships[0].includes("orders.customer_id -> customers.id"), JSON.stringify(r.data.relationships));
r = await call("query_plan", { source: S, sql: "SELECT * FROM orders WHERE customer_id = 1" });
check("query_plan (EXPLAIN QUERY PLAN)", !r.isError && /SCAN|SEARCH/.test(JSON.stringify(r.data.plan)), JSON.stringify(r.data.plan).slice(0, 120));

// ⑤ 修改（UPDATE → count 验证 → DELETE → count 验证）
r = await call("execute", { source: S, sql: "UPDATE customers SET balance = 200 WHERE id = 1" });
check("execute UPDATE affected=1", !r.isError && r.data.affected_rows === 1, r.text.slice(0, 100));
r = await call("count_rows", { source: S, table: "customers", where: "balance = 200" });
check("count verify after UPDATE = 1", !r.isError && Number(r.data.total) === 1, r.text.slice(0, 100));
r = await call("execute", { source: S, sql: "DELETE FROM orders WHERE id = 102" });
check("execute DELETE affected=1", !r.isError && r.data.affected_rows === 1, r.text.slice(0, 100));
r = await call("count_rows", { source: S, table: "orders" });
check("count verify after DELETE = 2", !r.isError && Number(r.data.total) === 2, r.text.slice(0, 100));

// ⑥ 安全红线在 sqlite 上依旧生效
r = await call("execute", { source: S, sql: "DELETE FROM orders" });
check("red line: DELETE without WHERE refused", r.isError, r.text.slice(0, 80));
r = await call("execute", { source: S, sql: "UPDATE customers SET balance = 0 WHERE 1=1" });
check("red line: WHERE 1=1 refused", r.isError, r.text.slice(0, 80));
r = await call("execute", { source: S, sql: "UPDATE customers SET balance = 0 WHERE status = 1 OR 1=1" });
check("red line: tautological OR disjunct refused", r.isError, r.text.slice(0, 80));
r = await call("query", { source: S, sql: "DELETE FROM orders" });
check("query tool blocks DELETE", r.isError, r.text.slice(0, 80));
// ⑧ 影响行数预检：先补足 4 行命中（> cap 3）——全部 OR 分支都引用列，确保由语义预检（而非词法红线）拦截
await call("execute", { source: S, sql: "INSERT INTO orders (id, customer_id, amount, status) VALUES (102, 1, 10, 'SENT')" });
await call("execute", { source: S, sql: "INSERT INTO orders (id, customer_id, amount, status) VALUES (103, 2, 10, 'SENT')" });
r = await call("execute", { source: S, sql: "UPDATE orders SET amount = 1 WHERE customer_id = 1 OR customer_id = 2 OR customer_id = 1 OR customer_id = 2" });
check("maxAffectedRows precheck (4 rows > cap 3) refused", r.isError && /超过上限/.test(r.text), r.text.slice(0, 140));
r = await call("count_rows", { source: S, table: "orders" });
check("precheck refused -> nothing changed (still 4)", !r.isError && Number(r.data.total) === 4, r.text.slice(0, 100));

// ⑦ BigInt 精度
r = await call("query", { source: S, sql: "SELECT 9007199254740993 AS big" });
check("BIGINT round-trip exact string", !r.isError && String(r.data.rows[0].big) === "9007199254740993", JSON.stringify(r.data.rows));

// ⑨ v1.3.0 column_stats：列画像
r = await call("column_stats", { source: S, table: "orders", column: "amount" });
check("column_stats orders.amount: 4 rows, 0 null, min=10 max=30", !r.isError
  && Number(r.data.stats.row_count) === 4 && Number(r.data.stats.non_null) === 4
  && Number(r.data.stats.min_value) === 10 && Number(r.data.stats.max_value) === 30, JSON.stringify(r.data.stats));
r = await call("column_stats", { source: S, table: "customers", column: "level", where: "balance > 60" });
check("column_stats with where: distinct levels", !r.isError && Number(r.data.stats.row_count) === 2, JSON.stringify(r.data.stats));
r = await call("column_stats", { source: S, table: "orders", column: "a;b" });
check("column_stats invalid column refused", r.isError, r.text.slice(0, 80));

// ⑩ v1.3.0 export_data：CSV/JSON 导出 + 防穿越 + 白名单
r = await call("export_data", { source: S, sql: "SELECT id, name, balance FROM customers ORDER BY id", format: "csv", filename: "customers.csv" });
check("export_data csv: 3 rows written", !r.isError && r.data.row_count === 3 && fs.existsSync(r.data.file), r.text.slice(0, 100));
if (!r.isError) {
  const content = fs.readFileSync(r.data.file, "utf8");
  check("export csv content: header + Alice row + CRLF", content.startsWith("id,name,balance\r\n") && content.includes("Alice"), JSON.stringify(content.slice(0, 80)));
}
r = await call("export_data", { source: S, sql: "SELECT id, name, level FROM customers ORDER BY id", format: "json", filename: "customers.json" });
check("export_data json: 3 customers, Alice in file (BigInt-safe serialization)", !r.isError && r.data.row_count === 3
  && fs.readFileSync(r.data.file, "utf8").includes("Alice"), r.text.slice(0, 100));
r = await call("export_data", { source: S, sql: "SELECT 1", filename: "again.csv" });
check("export_data first write of again.csv succeeds (覆盖场景构造)", r.isError === false, r.text.slice(0, 80)); // v1.4.1：旧断言恒真（|| true）属假绿，改为真实断言；覆盖拒绝由下一条钉住
r = await call("export_data", { source: S, sql: "SELECT 1 AS x", format: "csv", filename: "customers.csv" });
check("export_data refuses overwrite of existing file", r.isError && /已存在/.test(r.text), r.text.slice(0, 90));
r = await call("export_data", { source: S, sql: "SELECT 1 AS x", format: "csv", filename: "../../evil.csv" });
check("export_data traversal filename cleaned into whitelist", !r.isError
  && r.data.file.replace(/\\/g, "/").includes("/exports/")   // 落点必须仍是白名单目录
  && fs.existsSync(r.data.file), r.data.file);                // 清洗后文件名（.._.._evil.csv）只是普通文件
r = await call("export_data", { source: S, sql: "SELECT 1 AS x", format: "csv", filename: ".." });
check("export_data '..' + ext becomes ordinary in-whitelist file", !r.isError
  && r.data.file.replace(/\\/g, "/").includes("/exports/") && r.data.file.endsWith("..csv"), r.data.file);
r = await call("export_data", { source: S, sql: "DELETE FROM customers" });
check("export_data refuses write SQL (read-only guard)", r.isError, r.text.slice(0, 80));

// ⑩b v1.4.0 import_data：export→import 闭环（含引号/逗号内容与边界拒绝）
// 建表必须走 create_table（execute 仅允许 DML——本处先被守卫拒绝了一次，正好证明红线）
await call("create_table", { source: S, sql: "CREATE TABLE customers_copy (id INTEGER PRIMARY KEY, name TEXT NOT NULL, level TEXT, balance INTEGER)" });
await call("create_table", { source: S, sql: "CREATE TABLE tricky (id INTEGER PRIMARY KEY, name TEXT)" });
r = await call("export_data", { source: S, sql: "SELECT id, name, level FROM customers ORDER BY id", format: "csv", filename: "to_import.csv", overwrite: true });
check("import prep: exported 3 customers to csv", !r.isError && r.data.row_count === 3, r.text.slice(0, 80));
r = await call("import_data", { source: S, table: "customers_copy", filename: "to_import.csv" });
check("import_data: 3 rows imported", !r.isError && r.data.rows_imported === 3, r.text.slice(0, 110));
r = await call("count_rows", { source: S, table: "customers_copy" });
check("import verified by count_rows = 3", !r.isError && Number(r.data.total) === 3, r.text.slice(0, 80));
r = await call("query", { source: S, sql: "SELECT name FROM customers_copy WHERE id = 1" });
check("import row content correct (Alice)", !r.isError && r.data.rows[0].name === "Alice", JSON.stringify(r.data.rows));
// 引号/逗号内容往返：手动写入带复杂内容的 CSV 再导入
fs.writeFileSync(path.join(process.env.DBMCP_EXPORT_DIR, "tricky.csv"),
  'id,name\r\n10,"Smith, John"\r\n11,"say ""hi"""\r\n');
r = await call("import_data", { source: S, table: "tricky", filename: "tricky.csv" });
check("import_data: quoted comma/escaped quotes parsed", !r.isError && r.data.rows_imported === 2, r.text.slice(0, 100));
r = await call("query", { source: S, sql: "SELECT name FROM tricky WHERE id = 10" });
check("tricky content round-trip exact", !r.isError && r.data.rows[0].name === "Smith, John", JSON.stringify(r.data.rows));
// 边界拒绝：非法表头列名 / 不存在文件 / 行宽不一致
fs.writeFileSync(path.join(process.env.DBMCP_EXPORT_DIR, "badheader.csv"), "id,bad-col;DROP\r\n1,x\r\n");
r = await call("import_data", { source: S, table: "tricky", filename: "badheader.csv" });
check("import_data: malicious header column refused", r.isError && /非法列名/.test(r.text), r.text.slice(0, 90));
r = await call("import_data", { source: S, table: "tricky", filename: "no-such-file.csv" });
check("import_data: missing file refused", r.isError, r.text.slice(0, 80));
fs.writeFileSync(path.join(process.env.DBMCP_EXPORT_DIR, "width.csv"), "id,name\r\n1\r\n");
r = await call("import_data", { source: S, table: "tricky", filename: "width.csv" });
check("import_data: width mismatch aborts", r.isError && /行宽不一致/.test(r.text), r.text.slice(0, 100));

// ⑩c v1.4.1 import_data：批量多 VALUES（250 行跨 3 批）+ 批失败回退逐行定位 + 行宽预检文案
await call("create_table", { source: S, sql: "CREATE TABLE imp_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, price INTEGER)" });
const rows250 = Array.from({ length: 250 }, (_, i) => `${i + 1},item${i + 1},${(i + 1) * 10}`);
fs.writeFileSync(path.join(process.env.DBMCP_EXPORT_DIR, "imp_batch.csv"), "id,name,price\r\n" + rows250.join("\r\n") + "\r\n");
r = await call("import_data", { source: S, table: "imp_items", filename: "imp_batch.csv" });
check("import_data: 250 rows via batched multi-VALUES (3 batches)", !r.isError && r.data.rows_imported === 250, r.text.slice(0, 120));
r = await call("count_rows", { source: S, table: "imp_items" });
check("import_data batch verified by count_rows = 250", !r.isError && Number(r.data.total) === 250, r.text.slice(0, 80));
// 批内第 2 行违反 UNIQUE（item1 已存在）→ 批原子未写入 → 回退逐行：第 1 行写入、第 2 行定位报错
fs.writeFileSync(path.join(process.env.DBMCP_EXPORT_DIR, "imp_bad.csv"), "id,name,price\r\n300,newname,1\r\n301,item1,2\r\n302,other,3\r\n");
r = await call("import_data", { source: S, table: "imp_items", filename: "imp_bad.csv" });
check("import_data: batch failure falls back to row-wise, locates row 2", r.isError && /第 2 行导入失败/.test(r.text) && /此前 1 行已写入/.test(r.text), r.text.slice(0, 160));
r = await call("count_rows", { source: S, table: "imp_items" });
check("import_data fallback: exactly 1 row added (251 total)", !r.isError && Number(r.data.total) === 251, r.text.slice(0, 80));
// 行宽预检：任何写入前整批校验，文案必须如实（未写入任何行）
fs.writeFileSync(path.join(process.env.DBMCP_EXPORT_DIR, "imp_wide.csv"), "id,name,price\r\n400,ok,1\r\n401,short\r\n");
r = await call("import_data", { source: S, table: "imp_items", filename: "imp_wide.csv" });
check("import_data: width pre-check aborts before any write, honest message", r.isError && /行宽不一致/.test(r.text) && /第 2 数据行/.test(r.text) && /未写入任何行/.test(r.text), r.text.slice(0, 160));
r = await call("count_rows", { source: S, table: "imp_items" });
check("import_data width abort: no rows written (still 251)", !r.isError && Number(r.data.total) === 251, r.text.slice(0, 80));

// ⑩d v1.5.0: CSV 公式注入中和 + 前导注释写语句（sqlite 读写分流首词解析回归）
r = await call("execute", { source: S, sql: "/* lead */ INSERT INTO tricky (id, name) VALUES (20, '=1+1')" });
check("execute: 前导注释 INSERT 正常执行（读写分流不误判为读）", !r.isError, r.text.slice(0, 100));
r = await call("query", { source: S, sql: "SELECT name FROM tricky WHERE id = 20" });
check("leading-comment insert row stored raw (=1+1 原样入库)", !r.isError && r.data.rows[0].name === "=1+1", JSON.stringify(r.data?.rows));
r = await call("export_data", { source: S, sql: "SELECT name FROM tricky WHERE id = 20", format: "csv", filename: "formula.csv", overwrite: true });
check("export csv: 公式单元格默认中和（' 前缀）", !r.isError && fs.readFileSync(r.data.file, "utf8").includes("'=1+1"), r.text.slice(0, 100));
r = await call("export_data", { source: S, sql: "SELECT name FROM tricky WHERE id = 20", format: "csv", filename: "formula_raw.csv", overwrite: true, raw_formulas: true });
const rawCsv = !r.isError ? fs.readFileSync(r.data.file, "utf8") : "";
check("export csv: raw_formulas=true 关闭中和（原样导出）", !r.isError && rawCsv.includes("=1+1") && !rawCsv.includes("'=1+1"), rawCsv.slice(0, 60));

// ⑩e v1.5.1: 重复列名回归——node:sqlite 自带 :N 消歧，两列值都不得丢
r = await call("query", { source: S, sql: "SELECT 1 AS id, 2 AS id" });
const dupRow = !r.isError && r.data.rows[0] ? r.data.rows[0] : null;
const dupVals = dupRow ? Object.values(dupRow).map(String) : [];
check("query: 重复列名两列值都保留（:N 消歧回归）", !r.isError && dupVals.length === 2 && dupVals.includes("1") && dupVals.includes("2"),
  JSON.stringify({ cols: r.data?.columns, row: dupRow }).slice(0, 120));

// ⑩f v1.5.2: export 默认中和 → import_data strip_neutralization 逆变换（往返无损）
await call("create_table", { source: S, sql: "CREATE TABLE rt_check (id INTEGER PRIMARY KEY, name TEXT)" });
r = await call("export_data", { source: S, sql: "SELECT name FROM tricky WHERE id = 20", format: "csv", filename: "rt_neutral.csv", overwrite: true });
check("export prep: 中和后 '=1+1 落盘", !r.isError && fs.readFileSync(r.data.file, "utf8").includes("'=1+1"), r.text.slice(0, 80));
r = await call("import_data", { source: S, table: "rt_check", filename: "rt_neutral.csv", strip_neutralization: true });
check("import strip_neutralization: 1 行导入且剥离计数=1", !r.isError && r.data.rows_imported === 1 && r.data.neutralization_stripped === 1, r.text.slice(0, 120));
r = await call("query", { source: S, sql: "SELECT name FROM rt_check" });
check("往返无损: 库中值 =1+1（非 '=1+1）", !r.isError && r.data.rows[0].name === "=1+1", JSON.stringify(r.data?.rows));
r = await call("import_data", { source: S, table: "rt_check", filename: "rt_neutral.csv" });
check("import 默认不剥离: 原样导入 1 行", !r.isError && r.data.rows_imported === 1, r.text.slice(0, 100));
r = await call("query", { source: S, sql: "SELECT COUNT(*) AS n FROM rt_check WHERE name = '''=1+1'" });
check("默认导入保留中和字面量（'=1+1 原样入库）", !r.isError && Number(r.data.rows[0].n) === 1, r.text.slice(0, 90));

// ⑩g v1.5.3: 可观测性（export duration_ms）+ import_data atomic 全文件单事务
r = await call("export_data", { source: S, sql: "SELECT id, name FROM tricky WHERE id <= 2", format: "csv", filename: "dur.csv", overwrite: true });
check("export_data 返回 duration_ms（耗时回报）", !r.isError && typeof r.data.duration_ms === "number" && r.data.duration_ms >= 0, r.text.slice(0, 90));
await call("create_table", { source: S, sql: "CREATE TABLE tx_check (id INTEGER PRIMARY KEY, name TEXT)" });
const txRows = ["id,name"].concat(Array.from({ length: 250 }, (_, i) => `${i + 1},row${i + 1}`)).join("\r\n") + "\r\n";
fs.writeFileSync(path.join(process.env.DBMCP_EXPORT_DIR, "tx_250.csv"), txRows);
r = await call("import_data", { source: S, table: "tx_check", filename: "tx_250.csv", atomic: true });
check("import atomic: 250 行跨 3 批单事务提交", !r.isError && r.data.rows_imported === 250, r.text.slice(0, 120));
r = await call("query", { source: S, sql: "SELECT COUNT(*) AS n FROM tx_check" });
check("atomic 提交核实: count=250", !r.isError && Number(r.data.rows[0].n) === 250, r.text.slice(0, 80));
const badRows = ["id,name"].concat(Array.from({ length: 149 }, (_, i) => `${1000 + i},ok`), "1000,dup", "1150,tail").join("\r\n") + "\r\n";
fs.writeFileSync(path.join(process.env.DBMCP_EXPORT_DIR, "tx_bad.csv"), badRows);
r = await call("import_data", { source: S, table: "tx_check", filename: "tx_bad.csv", atomic: true });
check("import atomic 冲突: 明确报错且说明已全部回滚", r.isError && /回滚/.test(r.text), r.text.slice(0, 140));
r = await call("query", { source: S, sql: "SELECT COUNT(*) AS n FROM tx_check" });
check("atomic 回滚核实: count 仍 250（无幽灵行）", !r.isError && Number(r.data.rows[0].n) === 250, r.text.slice(0, 80));
r = await call("import_data", { source: S, table: "tx_check", filename: "tx_bad.csv" });
check("非 atomic 对照: 批失败回退逐行定位坏行（报错但保留此前 149 行）", r.isError && /第 150 行导入失败/.test(r.text) && /149 行已写入/.test(r.text), r.text.slice(0, 160));
r = await call("query", { source: S, sql: "SELECT COUNT(*) AS n FROM tx_check" });
check("非 atomic 对照核实: count=399（部分行保留，与 atomic 语义差异锁定）", !r.isError && Number(r.data.rows[0].n) === 399, r.text.slice(0, 80));

// ⑩h v1.6.0: column_stats 直方图 + TopN（0..99 共 100 行，tag 分布 50/30/20）
await call("create_table", { source: S, sql: "CREATE TABLE hist_check (id INTEGER PRIMARY KEY, v INTEGER, tag TEXT)" });
const histCsv = ["id,v,tag"].concat(Array.from({ length: 100 }, (_, i) => `${i + 1},${i},${i < 50 ? "a" : i < 80 ? "b" : "c"}`)).join("\r\n") + "\r\n";
fs.writeFileSync(path.join(process.env.DBMCP_EXPORT_DIR, "hist.csv"), histCsv);
r = await call("import_data", { source: S, table: "hist_check", filename: "hist.csv" });
check("hist prep: 100 行导入", !r.isError && r.data.rows_imported === 100, r.text.slice(0, 100));
r = await call("column_stats", { source: S, table: "hist_check", column: "v", histogram: { buckets: 10 } });
const hg = !r.isError && r.data.histogram ? r.data.histogram : [];
const hgSum = hg.reduce((a, b) => a + Number(b.row_count), 0);
const hgMono = hg.every((b, i) => i === 0 || Number(b.bucket_lower) >= Number(hg[i - 1].bucket_lower));
check("histogram: 10 桶、桶频合计 100、桶界单调", !r.isError && hg.length === 10 && hgSum === 100 && hgMono,
  JSON.stringify({ n: hg.length, sum: hgSum }).slice(0, 80));
check("histogram: 桶频均匀（每桶 10 行，0..99 等宽）", hg.length === 10 && hg.every((b) => Number(b.row_count) === 10), JSON.stringify(hg.map((b) => b.row_count)));
r = await call("column_stats", { source: S, table: "hist_check", column: "tag", top_values: { limit: 2 } });
const tv = !r.isError && r.data.top_values ? r.data.top_values : [];
check("top_values: 前 2 名 a=50、b=30（频数降序）", !r.isError && tv.length === 2 && tv[0].value === "a" && Number(tv[0].count) === 50 && tv[1].value === "b" && Number(tv[1].count) === 30,
  JSON.stringify(tv));
r = await call("column_stats", { source: S, table: "hist_check", column: "v", histogram: { buckets: 10 }, where: "tag = 'a'" });
const hgW = !r.isError && r.data.histogram ? r.data.histogram : [];
const hgWSum = hgW.reduce((a, b) => a + Number(b.row_count), 0);
check("histogram + where: 仅 a 行入桶（合计 50）", !r.isError && hgWSum === 50, r.text.slice(0, 120));

// ⑪ 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ }
console.log(`\n=== sqlite-validate: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
