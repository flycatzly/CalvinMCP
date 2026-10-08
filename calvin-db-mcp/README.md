# calvin-db-mcp

自研 MCP 服务器：**MySQL + PostgreSQL + OceanBase(MySQL模式) + 本地 SQLite** 多库操作，支持 TEST/PRE 等多环境源，为大模型调用与数据验证设计。
stdio 传输 / JSON-RPC 2.0，协议层零框架，仅依赖 `mysql2` 与 `pg` 两个驱动（SQLite 用 Node ≥ 22.5 内置的 `node:sqlite`，零额外依赖）。

**适用场景**：需要查询、核对、操作 MySQL / PostgreSQL / OceanBase(MySQL模式) 数据的任务——覆盖 TEST/PRE/UAT/DEV 环境、按任意库名定位数据源、执行 SQL、查看表结构、建表与增删改。**不适用于**：无 WHERE 条件的全表 UPDATE/DELETE、TRUNCATE 等破坏性操作（安全红线强制拒绝，即使用户明确要求）；首次使用需导入 DBeaver 连接配置(.dbp) 完成初始化。内置安全红线与凭据保护。

> **实测 2026-10-08（V1.6.56，Node v24.15.0）**：selftest `380 passed, 0 failed`（未初始化口径 361，双口径已实测，断言数由自证常量钉住）·
> sqlite-validate `83 passed, 0 failed` · mysql-validate `37 passed, 0 failed` · pg-validate `62 passed, 0 failed`（三库真实库全链路，每步与直连核对；真实 MySQL 8.4.5 / PostgreSQL 17.5 实测 2026-10-07）·
> e2e-validate `46 passed, 0 failed`（真 stdio 全链路）· protocol-validate `24 passed, 0 failed`（协议边界/对抗/取消语义）· realform-validate `43 passed, 0 failed`（真实形态：中文库/表/列 + 边界值 + 导出导入回环 + 红线/注入负例 + 复制粘贴不可见字符/Windows 文件名/CSV 表头/CRLF 保真/截断边界/BLOB 序列化对抗回归）·
> 16 工具经真实库验证（真实 MySQL 8.4.5 + 真实 PostgreSQL 17.5 + SQLite 文件库；操作核对台 realdb-v1617 三库矩阵 68/0：建表/导入/插入/查询/计数/改/删/红线零副作用/导出/删表，每步 MCP 行为 ↔ 直连真实结果一致）。

## 工具列表（16 个）

| 工具 | 说明 | 只读 |
|---|---|---|
| `list_sources` | 列出配置的数据库连接（类型/主机/库名，不返回凭据） | ✓ |
| `list_tables` | 列出表/视图 + 预估行数 + 表注释（`name_like` 过滤、`limit` 默认 500） | ✓ |
| `describe_table` | 列结构（类型/可空/默认值/主键/索引/注释） | ✓ |
| `find_tables_by_column` | 按列名关键字反查表（列名/类型/主键/注释；「知道列名不知道表」的定位利器） | ✓ |
| `fk_relationships` | 外键关系（`表.列 -> 引用表.列`），单表或全 schema——写 JOIN 前先看参照关系 | ✓ |
| `query` | 执行只读 SQL（SELECT/WITH/SHOW/DESC/EXPLAIN） | ✓ |
| `query_plan` | 对单条 SELECT/WITH 执行 EXPLAIN（text/json；不执行语句本身，不支持 ANALYZE） | ✓ |
| `sample_data` | 抽样看表数据（默认 10 行，最多 50，支持 `where` 过滤、`order_by` 升/降序与 `offset` 翻页） | ✓ |
| `server_stats` | 内存观测快照：per-source 计数 + 最近 32 条慢查询（已脱敏；阈值 DBMCP_SLOW_MS 默认 2000ms）+ 聚合报表（错误码分布/慢查询按语句类型） | ✓ |
| `reload_config` | 免重启重载 dbmcp.config.json（多环境切换/导入后刷新；校验失败回滚旧配置，在途查询不被掐断） | ✓ |
| `distinct_values` | 某列取值分布 Top-N（GROUP BY 计数，默认 20 上限 200）+ 精确去重总数，可带 `where` | ✓ |
| `column_stats` | 单列画像一条聚合搞定：行数/非空/去重数/最值/均值，可带 `where`；V1.6.0 起可选 `histogram`（数值等宽桶频数）与 `top_values`（高频值 TopN）——空值率、值域与分布形态速查；均值方言语义：MySQL/SQLite 非数值文本强转 0，PG 类型门控 NULL（v1.6.19 锚定） | ✓ |
| `export_data` | 只读查询结果导出 CSV/JSON 文件（需 `DBMCP_EXPORT_DIR` 白名单目录；防穿越/20MB 上限/原子落盘——临时文件+原子占位，跨进程同名互斥） | 写文件 |
| `import_data` | CSV 导入表（批量写入：MySQL/SQLite 参数化 INSERT、PostgreSQL COPY FROM STDIN；批失败逐行定位坏行；`DBMCP_IMPORT_DIR` 白名单；表头即列名仅裸标识符；万行/20MB 上限） | 写库 |
| `count_rows` | 精确计数（可带 WHERE），用于数据验证/前后对比 | ✓ |
| `execute` | 写操作（默认关闭，见下） | ✗ |
| `create_table` | 建表：单条 CREATE TABLE（需 allowCreateTable=true；禁 DROP/TRUNCATE/数据变更语句） | ✗ |
| `find_database` | 按库名/环境（TEST/PRE/UAT/DEV）检索源；`probe=true` 并行 TCP 探测可达性 | ✓ |

典型工作流（大模型调用规范）：

1. **定位**：`find_database`（按库名/环境，如 TEST/PRE）或 `list_sources` → 选定 source id；
2. **摸结构**：`list_tables` → `describe_table`（列/主键/索引）；只知道列名时用 `find_tables_by_column` 反查表；跨表 JOIN 前用 `fk_relationships` 看外键关系；
3. **读取**：`query`（只读 SQL）/ `sample_data`（抽样）/ `distinct_values`（取值分布）；昂贵查询前用 `query_plan` 看执行计划；`server_stats` 看服务端计数与最近慢查询；
4. **核对**：`count_rows`（前后计数对比、断言总数、查重）+ `distinct_values`（枚举列取值集合比对）；
5. **写入**：`execute`（单条 INSERT/UPDATE/DELETE）→ **写后必须用 `count_rows`/`query` 验证影响行数**；
6. **建表**：`create_table`（单条 CREATE TABLE）→ `describe_table` 验证；
7. 同实例跨库读取可用 `库名.表名` 限定。

写类请求的执行纪律（写前确认 / 写后验证 / 全表操作即拒）见「安全设计」下的**安全红线（Agent 执行纪律）**。需要把数据交给用户或其它工具时用 `export_data` 落盘。

## 快速命令索引（速查）

```powershell
# 安装 / 修复（自动装依赖 + 自检 + 注册）
node install.mjs
# 导入 DBeaver 连接（.dbp；写与建表默认关闭，需要时加 --allow-writes / --allow-create-table）
node install.mjs "C:\path\to\xxx.dbp"
# 本地 SQLite：一键建库 + 注册源（需 Node ≥ 22.5）
node mcp\sqlite-add.mjs "D:\data\shop.db" --allow-writes --allow-create-table
# 只跑自检
node mcp\selftest.mjs
# 只导入连接（--force 覆盖已存在的配置）
node mcp\import-dbeaver.mjs "C:\path\to\xxx.dbp" [--force]
```

## 自然语言使用示例（18 工具速查）

> 把「你这样说」直接说给大模型；「背后调用」是实际触发的工具，「得到什么」是返回结果。
> 模块分类与《部署说明.md》一致，18 个工具各一行；写类操作（`execute` / `create_table` / `import_data`）一律先确认后执行、写后验证。

**A · 定位数据源**

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「看看现在有哪些数据源可用，各是什么类型、什么环境」 | `list_sources` | 全部已配置源清单（类型/主机/库名/环境，不含凭据） |
| 「帮我找一下 TEST 环境里库名带 order 的数据库，顺便探测一下这些主机现在通不通」 | `find_database` | 命中匹配的源 + 各主机 TCP 可达性（probe） |

**B · 摸清结构**

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「ele_admin_api 库里有哪些表？带行数估计和表注释」 | `list_tables` | 表/视图清单 + 预估行数 + 表注释 |
| 「查一下 t_order 的表结构和索引，order_no 上有没有唯一约束？」 | `describe_table` | 列结构：类型/可空/默认值/主键/索引/注释 |
| 「我只记得有个字段叫 order_no——哪些表有这个列？」 | `find_tables_by_column` | 含该列的表清单（列名/类型/主键/注释） |
| 「t_order 和 t_order_item 是怎么通过外键关联的？写 JOIN 前先给我看关系」 | `fk_relationships` | 表.列 → 引用表.列 的外键关系 |

**C · 读取数据**

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「统计 t_order 昨天各状态的数量分布，SQL 先给我确认再执行」 | `query` | 只读 SQL 查询结果（自动 LIMIT，超限标 truncated） |
| 「帮我看看这条查询走不走索引：SELECT * FROM t_order WHERE user_id=1001 ORDER BY create_time DESC LIMIT 20」 | `query_plan` | 该 SELECT 的 EXPLAIN 执行计划（不执行语句本身） |
| 「抽 10 条 t_order 看看数据长什么样，按创建时间倒序；只看 amount 大于 1000 的取 5 条」 | `sample_data` | 真实数据样本（where 过滤 + order_by 升/降序） |

**D · 统计与核对**

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「t_order.status 有哪些取值、各多少条？精确去重总数也给我」 | `distinct_values` | 取值分布 Top-N 计数 + 精确去重总数 |
| 「给 amount 列做个画像：行数/空值/去重数/最值/均值，再看数值分布形态和高频值」 | `column_stats` | 单列画像（可选 histogram 直方图 / top_values 高频值） |
| 「核对一下 t_order 和 t_order_item 昨天的行数对不对得上」 | `count_rows` | 精确行数（可带 WHERE），前后对比与核对 |

**E · 导出结果**

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「把这次查询结果导出成文件交给下游——CSV 还是 JSON 都行，长文本和二进制要保真」 | `export_data` | 结果落盘为 CSV/JSON（需 DBMCP_EXPORT_DIR 白名单目录） |

**F · 导入数据**

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「把 D:/data/new_orders.csv 导入到 t_order——先告诉我目标表、表头和预计行数，我确认后再执行；这次要原子，任何一行失败就整体回滚」 | `import_data` | CSV 批量写入目标表并回报导入行数（atomic 全文件单事务） |

**G · 写入与建表**

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「把 t_order 里 order_no='20261005-001' 的状态改成 2——先给影响行数，我确认后执行，写完再核对影响行数」 | `execute` | 单条 INSERT/UPDATE/DELETE 执行结果与影响行数（带 WHERE；超 maxAffectedRows 即拒） |
| 「在本地测试库建一张 t_demo（id INTEGER PRIMARY KEY, name TEXT），建完给我看一下表结构」 | `create_table` | 单条 CREATE TABLE 建表结果（需 allowCreateTable） |

**H · 运维与热重载**

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「服务有没有异常？给我看看最近有没有慢查询、各数据源有没有报错」 | `server_stats` | 内存快照含 per-source 计数 + 最近 32 条慢查询（已脱敏）+ 错误码分布 |
| 「刚更新了 dbmcp.config.json，重新加载一下连接配置」 | `reload_config` | 配置热重载结果 + 生效的连接清单 |

**工具覆盖清单（18/18）**：`list_sources` ✓ `find_database` ✓ `list_tables` ✓ `describe_table` ✓ `find_tables_by_column` ✓ `fk_relationships` ✓ `query` ✓ `query_plan` ✓ `sample_data` ✓ `distinct_values` ✓ `column_stats` ✓ `count_rows` ✓ `export_data` ✓ `import_data` ✓ `execute` ✓ `create_table` ✓ `server_stats` ✓ `reload_config` ✓

**完整自然语言使用示例（18 工具全覆盖）**见《部署说明.md》「安装完成后：完整自然语言使用示例（18 工具全覆盖）」——按场景分类，含写类操作纪律与红线说明，可直接说给大模型。

**使用注意（数据语义与环境）**：

- **BIGINT/DECIMAL 以字符串返回**（MySQL/PG/SQLite 三库一致）：超过 JS 安全整数（2^53-1）的整数——雪花 ID 普遍如此——以字符串原样返回（如 `"9223372036854775807"`），WHERE 里直接用该字符串（`WHERE id = '9223372036854775807'`），**不要**转成数字（会精度丢失）；
- OceanBase 走 MySQL 模式（协议兼容），其账号需相应建表权限才能 `create_table`；部分源需 VPN/白名单（`find_database` probe 与导入预检会标注不可达主机）；
- `query` 对大表请尽量带条件（自动 LIMIT 默认 200 行）；输出为紧凑 JSON，超长单元格截断并标注；建表主键写 `INTEGER PRIMARY KEY`（SQLite 不要 AUTOINCREMENT，除非明确需要）。

## 首次安装与初始化（Agent 按序执行）

部署包**默认不含** `dbmcp.config.json`（不预置任何连接与凭据）与 `node_modules`。首次使用：

1. 进入部署目录：`cd <部署目录>/calvin-db-mcp`；
2. 运行 `node install.mjs` —— **自动安装依赖**（`npm ci --omit=dev`，需联网；内网可自行加镜像）→ 功能自检；
3. 若输出「尚未初始化」：**向用户索取 DBeaver 导出项目文件(.dbp) 路径**，然后运行
   `node install.mjs "<.dbp>" [--allow-writes] [--allow-create-table]`——
   `.dbp` 三种写法：完整路径 / 同级目录裸文件名 / 通配符 `"*.dbp"`（`*`/`?`，大小写不敏感；多个匹配时拒绝并列候选不猜）。
   导入器自动解包 `.dbp` → 解密 DBeaver 凭据（DBeaver 26 方案，实现已混淆）→ 过滤 MySQL/PG/OceanBase →
   连接串加密为 `enc` 字段写入配置（无明文落盘）→ 连通性预检；
   也可单独跑 `node mcp\import-dbeaver.mjs "<.dbp>"`（只导入连接，`--force` 覆盖已有配置）；
4. 将注册 JSON 写入客户端（见「接入 MCP 客户端」），**重启客户端**；
5. 重跑 `node install.mjs` 确认「已初始化：N 个源」且 selftest `FAIL=0`。

> 用户导出 .dbp 的方法：DBeaver → 文件 → 导出 → 项目 → 勾选「包含连接凭据」。
> `--allow-writes` 放开 execute 写操作、`--allow-create-table` 放开建表（**默认均关闭**；安全红线始终生效）。
> 导入后自检期望 `380 passed, 0 failed`；未初始化时 `361 passed, 0 failed`（SKIP 计入通过）。
> 未初始化时 server 以「未初始化模式」运行：`list_sources` 返回 `init_required` 提示，不泄露任何信息。
> 更多安装细节（手动兜底 / 注册 env / 分场景排错 / 升级卸载）见《部署说明.md》。

## 配置 `dbmcp.config.json`

```json
{
  "maxRows": 200,           // 单次查询返回行数上限（SELECT/WITH 自动包 LIMIT）
  "timeoutMs": 30000,       // 查询/连接超时
  "allowWrites": false,     // 是否允许 execute 写操作（默认 false）
  "maxAffectedRows": 500,   // execute 前按同一 WHERE 预检命中行数上限，超出即拒绝（0 = 关闭预检）
  "sources": {
    "mysql_main": {
      "type": "mysql",
      "enc": "base64(16B IV + AES-128-CBC(url))",   // url 加密存储，见下
      "description": "可选说明"
    },
    "sqlite_local": {                                // v1.2.0 本地 SQLite（url 不含凭据，无需加密）
      "type": "sqlite",
      "url": "sqlite://D:/data/shop.db",             // 文件不存在会被 create_table 前的操作自动创建
      "allowWrites": true,                           // 源级开关：仅该源允许写（测试期可全开）
      "allowCreateTable": true,
      "description": "本地库"
    }
  }
}
```

- **url 加密存储（DBeaver 26 同款格式）**：明文 `mysql://user:pass@host:3306/db` 不落盘，以 `enc` 字段存
  `base64(16字节随机IV + AES-128-CBC密文)`。**如实说明**：`crypt.mjs` 是混淆后的静态密钥实现（无 KDF、
  无口令绑定），enc 是**落盘混淆不是保密边界**——它防的是明文口令进日志/截图/随手拷贝，
  拿到配置文件 + 本仓库的人可以解密；server 启动时自动解密，仅驻内存。
- **enc2 主密钥绑定（V1.5.0）**：设置环境变量 `DBMCP_MASTER_KEY`（≥8 字符）后，新写入的密文为
  `enc2:` 前缀格式（AES-256-GCM + scrypt 派生密钥，认证标签防篡改）；`node crypt-cli.mjs rekey`
  可把旧格式逐源升级（坏密文跳过并报告、整体退出码非零）。如实说明：enc2 在**主密钥足够强且不入仓、
  不随配置文件一起泄露**的前提下才是保密边界——密钥和密文放在一起等于没有加密；旧格式（无前缀）仍可解密（向后兼容）。
- **SQLite 源（V1.2.0）**：`url` 为 `sqlite://<本地文件路径>`（无凭据，不需要加密）。需要 Node ≥ 22.5
  （内置 `node:sqlite`，无 npm 依赖）；用 `node mcp\sqlite-add.mjs <文件.db> [--allow-writes --allow-create-table]`
  一键建库/注册源。SQLite 不支持 `PRAGMA`/`SHOW` 之类的语句直接通过 `query`（元数据用 describe_table 等
  工具获取）；`query_plan` 对 SQLite 输出 `EXPLAIN QUERY PLAN`；INTEGER 超安全整数同样以字符串返回。
- 明文 ↔ 密文互转：`node crypt-cli.mjs encrypt` / `node crypt-cli.mjs decrypt`（维护用，decrypt 会写回明文 url，用完记得再 encrypt）；`node crypt-cli.mjs rekey` 逐源把旧格式 enc 升级为 enc2（需 `DBMCP_MASTER_KEY`）
- 环境变量：`DBMCP_CONFIG` 指向其他配置文件；`DBMCP_EXPORT_DIR`/`DBMCP_IMPORT_DIR`（export/import_data 白名单目录，import 回退 EXPORT_DIR）、`DBMCP_MASTER_KEY`（enc2 主密钥，可选）、`DBMCP_PRETTY`、`DBMCP_MAX_CELL_CHARS`、`DBMCP_NO_LISTEN`——在客户端注册 JSON 的 `"env"` 块里设置，全表见《部署说明.md》

## 接入 MCP 客户端

**Claude Code**（已在本仓库根目录生成 `.mcp.json`）：

```json
{ "mcpServers": { "db": { "command": "node", "args": ["<绝对路径>/mcp-servers/db-mcp/server.mjs"] } } }
```

或命令行：`claude mcp add db -- node D:\Git\sky\za-data-notice\mcp-servers\db-mcp\server.mjs`

**Claude Desktop / Cursor**：把同样的 `mcpServers` 结构写入对应配置文件（`claude_desktop_config.json` / `~/.cursor/mcp.json`）。

## 安全设计（读侧默认只读，写侧默认关闭）

1. **只读守卫（词法级）**：先抹掉字符串字面量/注释/引号标识符再检测——
   `WHERE note='drop table'` 不误伤；`WITH x AS (INSERT...) SELECT`（可写 CTE）、
   `SELECT ... INTO OUTFILE`、`FOR UPDATE/FOR SHARE`、`lo_export` 等均拦截；
   V1.0.1 起同时拦截服务端文件读取/外联函数：`pg_read_file`、`pg_ls_dir`、`pg_stat_file`、
   `pg_execute_server_program`、`dblink`。
2. **单语句限制**：`;` 后再有内容直接拒绝（防多语句注入式拼接）。
3. **自动 LIMIT**：SELECT 与 WITH 统一外层包裹 `LIMIT maxRows+1` 并返回 `truncated` 标记（V1.0.1 修正：旧版给 WITH 直接追加 LIMIT，遇 `... LIMIT 5` 会生成 `LIMIT 5 LIMIT 201` 语法错误）。
4. **超时**：MySQL `timeout` / PG `statement_timeout`，默认 30s。
5. **execute 四重限制 + 安全红线（最高优先级）**：默认关闭；仅单条 INSERT/UPDATE/DELETE；
   **无 WHERE 条件的 UPDATE/DELETE、TRUNCATE TABLE 一律拒绝**——即使用户明确要求全表操作也不执行
   （提示改由 DBA 通过 DBeaver 等人工渠道操作）；DDL 永远拒绝。
   - **(a) 词法层（V1.0.1 泛化，V1.0.3 强化）**：WHERE 必须真正引用至少一个列——旧版只识别 `1=1`/`true` 两种写法，
     现已覆盖 `WHERE 1`、`WHERE 2>1`、`WHERE 'a'='a'`、`WHERE true=true` 等"不引用任何列"的恒真条件；
     V1.0.3 起**任一顶层 OR 分支不引用列也拒绝**（`WHERE status=1 OR 1=1`、`OR true` 等拖库写法）；
     字符串/注释中藏 WHERE 不算数；恒真判定取第一个顶层 WHERE（子查询 WHERE 不参与、不干扰）。
   - **(b) 语义层（V1.0.1 新增）**：执行前用**同一 WHERE** 先做一次 `COUNT(*)`，命中行数超过
     `maxAffectedRows`（默认 500）即拒绝并回报实际行数——词法层之后的纵深防御（括号内/AND 链等语义等价场景）。
     计数因方言/语法差异失败时不阻断（回退到词法守卫），原因写 stderr。
6. **凭据不出网**：`list_sources` 不返回 url 与密码。
7. **不可外发防护**（三层）：
   - **落盘加密**：`dbmcp.config.json` 的 url 以 `enc` 字段加密存储（旧格式 AES-128-CBC / V1.5.0 起可选 enc2: AES-256-GCM 主密钥绑定，见上文说明）——文件里没有明文口令，旁观/日志/截图拿不到凭据（如实限定：旧格式为静态密钥落盘混淆，不是保密边界，拿到配置文件 + 本仓库可解密；enc2 需主密钥不随配置泄露）；
   - **输出清洗**：所有工具响应与报错在统一出口清洗已配置的口令（含 URL 编码变体），即使未来某个工具意外携带 DSN 也发不出去；
   - **启动门禁**：`dbmcp.config.json` 若被 git 跟踪（`git ls-files` 命中）或未被 `.gitignore` 忽略（`git check-ignore` 未命中），服务**拒绝启动**（exit 1），防止凭据随仓库提交/推送外发。非 git 目录不受影响。
8. **输出整形（V1.0.1）**：响应默认紧凑 JSON（实测 200 行结果省约 31% 字符，约 3.2k tokens/次）；单个超长单元格
   （默认 >2000 字符）截断并标注 `… <truncated N chars>`，同时返回 `truncated_cells` 计数，避免一个 TEXT 列吃满上下文。
   可用环境变量 `DBMCP_PRETTY=1`（恢复缩进）与 `DBMCP_MAX_CELL_CHARS`（截断阈值）调整。

> 重要：不要依赖 MCP 层做最终权限边界（参考 DBHub 只读模式被绕过的 CVE-2026-61788）。
> 请给 MCP 配最小权限数据库账号：只读场景用 SELECT-only 账号；写场景只授权目标库表。

### 安全红线（Agent 执行纪律，最高优先级——Agent 与 MCP 双层执行）

机制性限制（无 WHERE / 恒真 WHERE / 影响行数预检 / DDL 拒绝）由 MCP 强制执行，见上文第 5 条；Agent 侧必须遵守：

1. **写前确认**：INSERT/UPDATE/DELETE、建表、CSV 导入——先向用户给出影响行数与条件，经确认后才执行；
2. **写后验证**：写入后必须用 `count_rows`/`query` 验证影响行数与预期一致；
3. **全表操作即拒并转人工**：无 WHERE 的全表 UPDATE/DELETE、TRUNCATE——即使用户明确说「就是要更新/删除全表」也不执行，须告知：出于安全考虑禁止该操作，如有全表需求请通过 DBeaver 等人工渠道由 DBA 执行；
4. **跨环境二次确认**：对 PRE/UAT 等非 TEST 环境的操作，必须先向用户二次确认目标环境；
5. **超限不放水**：预检命中超过 `maxAffectedRows` 被拒时，提示改用更精确条件或由 DBA 人工执行，**不要**为绕过而调大上限；
6. **凭据红线**：任何输出不得包含 url/口令（server 已强制清洗）；`.dbp` 与 `dbmcp.config.json` 均按敏感文件对待，禁止入 git（导入时自动生成 `.gitignore` 保护）。

## 自测

```bash
node selftest.mjs
```
380 项断言（已初始化口径，未初始化 361）：只读守卫（含注释/字符串混淆、可写 CTE、OUTFILE、行锁、`pg_read_file`/`pg_ls_dir`/`dblink`、
管理/破坏性函数黑名单（`pg_terminate_backend`/`set_config`/`pg_sleep`/`SLEEP`/`load_extension`/`dblink_exec` 等）、
CTAS 全形态拦截（含 MySQL 无 AS）、MySQL/PG 方言语义回归）、写守卫（无 WHERE、DDL、多语句、**不引用任何列的 WHERE、恒真 OR 分支**、WHERE 过滤片段顶层尾句注入拒绝（ORDER BY/LIMIT/UNION… 显式报错、括号内子查询放行））、
安全红线（无 WHERE 的 UPDATE/DELETE、TRUNCATE、字符串/注释藏 WHERE、写目标解析与嵌套 WHERE）、外发防护（口令清洗、URL 编码变体、工具输出零口令）、
LIMIT 强制（含 WITH 已带 LIMIT 的回归用例）、format 枚举校验（非法值显式 E_PARAM 不静默兜底、大小写归一、类型混淆拒绝）、export 落盘清洗流式化（scrubToBuffer 字节域与旧字符串链差分恒等、孤立代理回落、退化键跳过语义钉）、export CSV 直出 Buffer（exportToCsvBuffer 两遍预铺与字符串组装差分恒等、scrub 接线恒等、早停边界、孤立代理哨兵与 scrubBuffer 直调语义钉）、export 整链流式写盘（createScrubPipeline 任意切分不变性与 emit 形态恒等、measureCsv/streamCsvLines 三链差分、早停零写盘、writeFileStreamAtomic 原子占位与失败清理语义）、集束写（createBatchWriter 批边界不变性与超大碎片零拷贝直写、flush 尾批幂等、写调用收数）、零物化行格式化（融合计数/直写/scratch vs 行串真源逐字节恒等、逐格哨兵等价、早停边界、种子模糊）、query 侧行集流式（createCsvRowSink 行接收器增量喂入与整链逐字节恒等、eager/惰性表头、哨兵旗/abort 中止、E_LIMIT 零写盘、writeFileStreamAtomic 异步 writeFn 与同步面同语义）、pg 游标批量单一真源（PG_FETCH_BATCH 常量钉：FETCH 语句与退出阈值共用、无裸数字字面量，消字面量漂移静默截断）、JSON 整形与单元格截断、sample_data 的 WHERE/ORDER BY 构造与注入防护、
import 批回退/结果未知分类、COPY FROM STDIN 分方言路由与文本转义保真、导出/导入目录门禁、MCP 协议握手与调用、真实 stdio 子进程回环、
find_database 检索与 TCP 探测、未初始化模式、export 原子落盘与双进程并发、sqlite-add 幂等语义、crypt-cli 加解密往返、
export JSON 保真（长文本/二进制全量落盘）、peekRpcId 坏行恢复请求 id、notifications/cancelled 取消语义（在途登记/形状判别/未知与迟到忽略/取消抑制派发）、getPool 并发首触去重、
错误码分类（E_SAFETY/E_PARAM/E_NOT_FOUND/E_CONFIG/E_LIMIT/E_DB/E_INTERNAL 与重试语义、回环格式兼容、ToolError 显式标签优先于消息模式匹配）、
工具声明收口（16 工具 title/annotations/inputSchema 形状钉、description 全量含 `Example: {json}` 用法示例）、
Unicode 标识符适配（中文表/列名识别与红线列引用检测、注入形态仍拒绝）、
观测面打点（DBMCP_ERR_LOG 可选 NDJSON 审计日志：默认关闭、每调用 1 条可关联记录、错误码/重试态/耗时可统计、脱敏截断、写失败 fail-open、超限滚动总量有界）。无需真实数据库。
已初始化目录预期汇总 `380 passed, 0 failed`（oceanbase 连通性用例在主机不可达时打印 SKIP，仍计入通过）；
未初始化目录预期汇总 `361 passed, 0 failed`（leak-guard 口令检查套件整体 SKIP）。
真实库套件：`sqlite-validate.mjs`（SQLite 真实库 83 项）、`mysql-validate.mjs`（真实 MySQL 全链路 37 项：
全工具面（元数据发现/画像/直方图/TopN/NULL 语义/查询与 EXPLAIN/事务提交回滚/execute 红线/建表/导出导入/原子回滚），stdio JSON-RPC 真客户端链路，探针库 dbmcp_probe_hist 自建自删；
配置缺 mysql 源时打印 SKIP 以退出码 3 结束）与 `pg-validate.mjs`（真实 PostgreSQL 62 项，v1.6.17 起，v1.6.18 扩全工具面、v1.6.19 语义锚定、v1.6.20 直方图/超时锚定、v1.6.21 全 NULL/单行边界锚定、v1.6.22 空表锚定、v1.6.23 事务内 COPY、v1.6.24 取消传导、v1.6.32 行集流式恒等、v1.6.33 批边界完备：
操作矩阵 × 直连双向核对——建表/CSV 导入/插入/查询逐值/计数/更新/删行/红线负例零副作用/BLOB(bytea) 往返/导出核对/DBA 删表 E_NOT_FOUND 确认，每步核对数据库真实状态是否与 MCP 行为一致；
加全工具面钉测——column_stats 画像/直方图/TopN、发现类（list/describe/find/fk）、query/query_plan/count/distinct/sample、CTAS 拒绝、import 原子回滚、事务提交回滚（PG 方言分支真实端到端）；
配置缺 postgres 源时打印 SKIP 以退出码 3 结束）。
链路套件：`e2e-validate.mjs`（全链路 E2E 46 项：真 stdio 子进程 16 工具全调用面——握手/发现/读链/红线负例/format 枚举负例/写 + 公式中和导出与 import 往返/atomic 回滚/export 保真/export 落盘清洗接线）与
`protocol-validate.mjs`（协议边界 24 项：超长行/坏 JSON 回带请求 id、噪声静默、批量数组、id 边界、10 条守卫对抗负例 + notifications/cancelled 取消语义——运行中取消不发响应、排队中取消不执行、未知/迟到取消忽略）。
真实形态套件：`realform-validate.mjs`（真实形态 43 项：真 SQLite 中文库文件名/中文表/中文列 + 边界值——BigInt 精度/超长文本/emoji/换行/NULL/BLOB + 导出导入回环保真（公式中和 strip_neutralization）+ 写面红线 + 注入面负例 + 真实对抗回归——复制粘贴不可见字符（ZWSP 前导可执行且红线不因剥除失效）/Windows 文件名边界（保留设备名拒绝、COM10 不误伤、超长截断保扩展名、大写扩展名不重复追加、尾点归一含 import 寻址）/CSV 表头语义（重名列拒绝防静默丢值、空列名明确报错）/引号内 CRLF 导出导入回环保真/行数截断边界（truncated 语义）/BLOB 序列化（Uint8Array→`<binary N bytes: hex>`，导出确定性 hex），真 stdio 子进程跑真实 `server.mjs`）。
三套件 fixture 自供给（mkdtemp 临时 SQLite 库 + 临时配置 + 导出/导入白名单目录，自建自删，不触碰部署配置与业务库），无需真实数据库；
Node ≥ 22.5，无 node:sqlite 时打印 SKIP 以退出码 3 结束。
> 断言数随版本演进增长，**以 selftest 实际汇总行为准**（`=== N passed, M failed ===`），
> `install.mjs` 也以该行（而非 PASS/FAIL 字样计数）判定自检结果。

## 独立部署

> 📄 详细部署文档见同目录《[部署说明.md](./部署说明.md)》：系统要求、客户端接入、配置管理、安全机制、故障排查、升级维护。

本目录即完整可部署单元，拷贝到任意目标机器/目录即可运行：

1. 目标机需 Node.js ≥ 18.17，首次部署可访问 npm——**纯净包不含 `node_modules` 与任何 `.` 前缀文件/目录**，依赖由 `install.mjs` 自动执行 `npm ci --omit=dev` 命令生成（内网可加 `--registry` 镜像）；手动部署则在 `mcp\` 下执行同命令后跑 `node selftest.mjs` 验证（详见《部署说明.md》「手动兜底（只有自动失败时才需要）」）
2. 注册到 MCP 客户端（`command` 填目标机 node 路径，`args` 指向本目录的 `server.mjs`）：
   ```json
   { "mcpServers": { "db": { "command": "node", "args": ["<部署目录>/server.mjs"] } } }
   ```
3. 部署后自检：`node install.mjs` 会依次跑 selftest + 全链路 E2E 验收（步骤 5；E2E 随包 `mcp/e2e-validate.mjs` 自带临时 fixture，可 `DBMCP_E2E` 覆盖，技能仓库 `sql-check-script/tests/fullchain_test.mjs` 存在时优先）；手动则 `node selftest.mjs`（380 项断言 FAIL=0 即正常）
4. 配置 `dbmcp.config.json` 已加密（`enc` 字段）。新增/更换连接：
   - 临时把明文 url 写入源（或 `node crypt-cli.mjs decrypt`），改完执行 `node crypt-cli.mjs encrypt` 恢复加密
5. 启动门禁：配置文件在 git 仓库内且未被 ignore / 已被跟踪时，服务拒绝启动
6. 可选观测日志（默认关闭）：设置环境变量 `DBMCP_ERR_LOG=<日志文件路径>` 后，每次工具调用追加一行 NDJSON 审计记录（JSON-RPC 请求 id / 工具名 / 错误码 / 重试态 / 耗时 / 经脱敏截断的 SQL 与错误摘要）；不设置则零行为。总量有界：单文件超限自动滚动为 `<路径>.1`（最近）…`<路径>.N`，`DBMCP_ERR_LOG_MAX_BYTES`（缺省 10MB）与 `DBMCP_ERR_LOG_KEEP`（缺省 3 份）可调，非法值回落缺省。日志含业务元数据（表名/SQL 摘要），请放于受控目录并定期清理；写日志失败不影响工具调用

## 排错速查

| 现象 | 处理 |
|---|---|
| install 提示「尚未初始化」 | 提供 .dbp 路径重跑（同级目录可简写 `"*.dbp"` / 裸文件名，多个匹配时拒绝并列候选），或 `node mcp\import-dbeaver.mjs "<.dbp>"` |
| `list_sources` 返回 `init_required` | 同上，导入后**重启客户端** |
| `Access denied for user` | 账号无该库权限：换最小权限账号 |
| ECONNREFUSED / ETIMEDOUT | 主机不可达：VPN/白名单（`find_database` 的 `probe` 可预检主机连通性） |
| 依赖自动安装失败 | 检查网络/换镜像：`npm ci --omit=dev --registry=https://registry.npmmirror.com` |
| 自测 FAIL | 看 FAIL 行提示；未初始化时 SKIP 属正常 |
| 配置丢失 | 从源仓库或 `Documents\dbmcp-key` 备份恢复加密版配置 |

> 分场景排错（安装/注册/初始化/连接/权限/环境变量/升级回滚）见《部署说明.md》「出问题先看这几条」与「七、问题排查」。

## 版本与文档同步规范

每次更新版本（含版本说明）必须同步落到以下全部位置，漏一处即视为发版未完成：

1. `mcp/package.json` 的 `version` —— **唯一事实源**（`server.mjs` 启动横幅与 selftest 版本一致性断言读它）
2. `mcp/server.mjs` 中 `pkgVersion("x.y.z")` 的 fallback 串
3. 全部文档版本行：`README.md`（实测行）、`部署说明.md`
4. **版本说明**：本页「更新记录」新增条目（**唯一落点**）；`部署说明.md` 的「更新记录」仅保留一行指引指向本页，不复制条目（历史条目不回填、不改写）
5. 发版自检：`node mcp\selftest.mjs` 0 failed；随技能侧（`sql-check-script`）发布时其 `node tests\run_all.mjs` 须全绿

## 更新记录

## 性能面收官固化（V1.6.51）

客户端性能面（读/写/解析/响应组装/内存）已全部定盘或封存。本节为历轮判据与口径的固化索引——**后续任何优化提案先过本节判据库**；逐轮完整背景见下方更新记录对应条目。

### 判据库（勿再试清单，23 条）

**A. 性能优化形态**
1. JS 逐片/逐段 emit 形态打不过原生 C++——V1.6.36 replacer、V1.6.38 E2 emitter（字节门 17/17 全过仍慢 2×，~2 万片 parts.push+join）。
2. 重构发射/组装形态三振——V1.6.36/38/40 同根因；CSV 洁净快路径三数据集全负（−1.4~−7.8%，负 15~37× 地板）。
3. V8 原生写法常已是快路径——V1.6.36 ctc 的 Object.values 改 for-in 反慢 2.6×；**CPU profile 自耗时占比 ≠ 实现慢**，优化终审只认同脚本并排 A/B。
4. 纯去重是正例——V1.6.40 cell 内联（消重复中和正则）clean +4.7%/dirty +5.7% 落地。
5. 符号翻转 cell 不可做永久决策依据——V1.6.39 参数化 named（−10.6%→+16.4% 实为臂序偏置）、V1.6.42 流式 batch（+14.4%→−0.8%）。
6. 流式/写段微常量需双 harness 一致——V1.6.42 sqlite batch dup 臂被 fsync 噪声打爆时以两独立 run 同向同量定盘。
7. yield 粒度 = 取消响应契约——现行每段让出即最优（V1.6.49：取消 ack 中位 80µs/p95 338µs 亚毫秒；N≥64 大面积落解析后）；yield 调度实测 ~2.4µs/次（V1.6.47「5.5ms 地板」误读已修正溶解）。

**B. 驱动/协议**
8. mysql execute 协议切换否决——FLOAT 列 text/binary 语义漂移实锤（`"3.14159"` vs `3.141590118408203`，客户端无法复现服务端显示宽度格式化）+ 增益不达 2× 地板；rowsAsArray 本身 config 级可得（V1.6.39 表述修正存档）；**任何协议切换必须先过含 FLOAT 列的恒等门**。
9. named×FETCH 交互 0.6% 死路（V1.6.42）——FETCH 文本解析被行解码淹没。
10. pg `SET plan_cache_mode=force_custom_plan` 更差（V1.6.41）——auto 模式自优化（5 次 custom 后廉价 generic）；named 参数化点查 −62%/范围查 −35% 机制级，勿 SET。
11. pg Parse 毒化（V1.6.39）——Parse 发送时即记 submittedNamedStatements、服务端拒绝不回滚；错误路径必须清客户端跟踪（submittedNamedStatements+parsedStatements）；**命名绝不复用**（DEALLOCATE 清不掉客户端跟踪，同名不同文直接抛错）。

**C. 安全清洗**
12. 数字口令子串掩码须带全数字守卫（V1.6.43）——`/^^\d+$/` 整格保真先于子串掩，防 `424242` 连坐 `4242420`→`***0`。
13. JSON/CSV 数字语境不对称是格式事实（V1.6.42/43）——JSON 有引号结构（字符串值掩/数字 token 保真），CSV 无（全数字单元保真）；显式钉住防漂移。
14. 清洗假说先探秘密源机制（V1.6.38）——「引号口令漏洗」被 `new URL().password` 恒为百分号编码形态证伪；SECRET_LIST ⊆ T 安全字符。
15. CSV 导出数字口令单元格级处置（V1.6.43）——csvCellDigitMask：全数字单元保真/文本内部掩；doExportData 拆两账（digitKeys 单元格级 + plainKeys 字节域）。

**D. 测量方法**
16. 字节恒等门 ≠ 速度门（V1.6.38）——门全过仍可负优化 2×；两门都要。
17. 分段测量里 batch 段（duration_ms 毫秒分辨率+服务端噪声）同幅摆动时不可归因客户端改动（V1.6.47）。
18. 插桩模板注释勿进多语句替换（`//` 吃掉同行 return→语法崩）；结果恒等门比行数据不比计时值；hrtime.bigint 是纳秒（V1.6.48）。
19. 进程内取消注入须 `trackRpc` 同 stdio 主循环形态（否则 cancelRpc 空转）；取消计时起点=回调触发时刻；继承自早期轮的数字标「待复测」（V1.6.49）。
20. RSS 残差分解关闭法（V1.6.50）——heapTotal 同标；heapUsed/external 全同 + 差值落 `rss−heapUsed−external` 残差 = 堆页足迹/原生缓冲，按决策树关闭而非跨 era 二分。
21. 单轮 dup 臂失效（fsync/GC 噪声打爆）时的裁决顺序：双独立 harness 同向同量 > 单轮地板；跨 run 符号翻转 = 不落地。
22. 探针三件套（V1.6.50）——产品配置源是 enc 密文（crypt2.decryptAny 解密，绝不打印）；探针表结构读 setup 代码（勿凭假设列名）；maxRSS 单位换算勿双重除法。
23. 每轮判据入档三落点——产品代码注释（就近）+ README 更新记录条目 + 本清单；负优化回退必须留「勿再试」判据原文。

### 实测口径总表（2026-10-08，Node v24.15.0）

| 面 | 口径 | 数字 |
|---|---|---|
| 自检 | selftest init/uninit | 372 / 356（0 failed） |
| 六套件 | sqlite/e2e/protocol/mysql/pg/realform | 83 / 48 / 24 / 37 / 62 / 43（0 failed） |
| 导出内存 | 30k 行 CSV maxRSS（sqlite/mysql/pg） | 93.5 / 103.1 / 125.8 MB（pg +4.3% 已归因关闭） |
| 导出内存 | 30k 行 JSON（sqlite） | 96.1 MB（现状基线） |
| 导入批量化 | importBatchSize 封顶（V1.6.46） | 1000→5000；10k CSV e2e mysql 86ms / pg 28ms |
| pg named 预编译 | query 点查 / LIMIT1000 / 参数化范围 | −27.2%（7.3×）/ −12.4% / +21.2%（5.8×） |
| 解析链 | charCodeAt 分派（V1.6.47） | 机制 −17~22%（46×/15× 地板） |
| 读路径 | runOnPool 驱动往返占比（V1.6.48 刷新） | 88-96%（客户端面低于 dup 地板，封存） |
| 取消响应 | import 解析中 cancelRpc ack | 中位 80µs / p95 338µs |

### 探针资产清单（`D:\work\Zcode\DB\_dist\`，探针纪律见 memory-probe-methodology）

| 资产 | 用途 | 状态 |
|---|---|---|
| exportmem_probe.mjs | 30k 导出内存四模式（legacy/new/stream/e2e）+ setup/teardown-mysql|pg | 可复用 |
| exportmem_json_v1645.mjs | JSON 导出现状探针（无历史基线，96.1MB 起点） | 可复用 |
| bench_r1637_prof/ab/prod_ab | runOnPool 剖析 + zipRows 工厂选型/产品 A/B（V1.6.37） | 存档 |
| bench_r1638_mech/prof/scrub | 响应组装剖析 + E2 否决 + 数字口令证伪（V1.6.38） | 存档 |
| bench_r1639_prof/ab | export 残余 + named 预编译（V1.6.39） | 存档 |
| bench_r1640_mech | CSV 发射快路径否决/cell 内联（V1.6.40） | 存档 |
| bench_r1641_mech/prod | named 参数化复核（V1.6.41） | 存档 |
| bench_r1642_prof/batch/verify | 流式定盘 + 数字口令洗烂修复（V1.6.42-43） | 存档 |
| bench_r1644_mech/mech2 | mysql execute 复核（FLOAT 漂移判据）（V1.6.44） | 存档 |
| bench_r1646_mech/mech2/e2e | 写路径批量化（V1.6.46） | 存档 |
| bench_r1647_probe/mech | import 分段剖析 + parseCsv charCodeAt（V1.6.47） | 存档 |
| bench_r1648_prof | 读路径刷新（V1.6.48） | 存档 |
| bench_r1649_probe | yield×取消矩阵（V1.6.49） | 存档 |
| bench_r1650_attr | pg 内存归因（named 排除+残差分解）（V1.6.50） | 存档 |
| backup-16xx/ | 各轮改动前产品文件封存（SEALED 后严禁写入） | 封存 |

### 下一阶段方向（性能面收割完毕后的候选池）

1. **驱动版本升级收益复核**（非排期）——mysql2 3.24.4 / pg 8.23 vs 新版：版本考古（changelog/破坏性变更）先行，无破坏性变更再做机制基准；
2. **功能面扩展候选**——性能面已五面定盘，增量价值转向能力面（如流式查询分页、更多方言、观测面增强）——需求驱动，非本性能线排期。

### V1.6.51（客户端性能面里程碑收官轮：判据库 23 条 + 口径总表 + 探针资产清单成文——见本节上方「性能面收官固化」小节；零产品变更轮）

- 收官轮实质全部固化在上方「## 性能面收官固化（V1.6.51）」小节：判据库四类 23 条（每条附版本出处，后续优化提案先过此库）+ 实测口径总表 + 探针资产清单 + 下一阶段方向。本条目仅作版本索引。
- 实测口径（2026-10-08）：selftest 372/0（未初始化 356/0）· 六套件 83/46/24/37/62/43 全绿。

### V1.6.56（server_stats 增强：错误码分布 + 慢查询按语句类型聚合——有界双聚合常开进快照）

- **背景**：按 V1.6.55 排定方向执行「server_stats 增强：错误码分布 + 慢查询聚合报表」。
- **设计对比**：A server_stats 常开聚合 ✓ 落地（errorCodes Map 上界=classifyError 分类学 ~7 码、slowTypes Map 上界=SQL 动词白名单 ~15 类——天然有界无环增长面）；include_report 参数 ✗（形状跨调用不稳定）；错误环形缓冲 ✗（聚合已覆盖消费需求，环徒增内存）；独立 slow_report 工具 ✗（18 工具面再 +1 收益不匹配）。
- **产品变更**：①observe.mjs：obsRecord 增 errCode 参 + 慢分支按 stmtTypeOf（动词白名单，注释开头归 other）聚入 slowTypes；obsSnapshot 增 report 块（error_codes/slow_by_type 均 count 降序、同 count 插入序）；②pool.mjs：createPoolManager 增 classify 注入参 + runQuery 错误路径传 classify(e).code（分类器注入避 server↔pool 循环 import）；③server.mjs：传 classifyError + server_stats 工具描述更新。
- **回归钉（selftest +1）**：selftest **379→380（360→361）**——report 聚合钉（错误码分布含 UNKNOWN 兜底/慢查询按类型聚合含均值/排序/count 降序同 count 插入序/非慢错误不入慢表/注释开头归 other）；e2e 钉内扩 report 形状断言（计数不增）。钉过程修正自身两处期望笔误（平局排序=插入序；s2 的 400ms 同为慢查询应入 select 聚合）。
- **实测口径（2026-10-08，Node v24.15.0）**：selftest 380/0（未初始化 361/0）· sqlite 83/0 · e2e 48/0 · protocol 24/0 · mysql 37/0 · pg 62/0 · realform 43/0。存档：backup-1656\（改动前 22 文件封存）。
- **下一轮方向**：①config profiles（多环境单文件切换——按需）；②工具面收尾盘点（18 工具能力矩阵复核——按需）；③驱动 minor 例行跟进（随功能轮带走）。
### V1.6.55（配置面：reload_config 免重启热切换落地（17→18 工具）——校验失败回滚、在途查询不被掐断）

- **背景**：按 V1.6.54 排定方向执行「配置面增强：多环境配置热切换」。现状：loadConfig 一次性加载、cfg/SECRET_LIST 模块级 const、池按 sourceId 缓存——改配置须重启。
- **设计对比**：A `reload_config` 显式工具 ✓ 落地（可控可测、Error 契约显式）；B fs.watch 自动重载 ✗（写半截竞态/行为意外/无代理控制面）；C 轮询 ✗（同 B 更差）。多环境形态：本轮=同一 DBMCP_CONFIG 路径重载（DBeaver 导入流免重启即达）；config 内 profiles 记为后续候选。
- **产品变更**：①server.mjs：normalizeCfg/computeChangedSources 纯函数（loadConfig 启动路径字节不变）；cfg/SECRET_LIST 改 let 活绑定；reloadConfig 安全序=读文件→JSON 校验→形态归一→逐源 enc 解密赋 url+type 归一（镜像启动路径；任一失败 E_CONFIG 中止旧配置保持）→就地换血（Object.assign）→重建 SECRET_LIST→markStale；②pool.mjs：markStale + getPool 惰性关闭（stale 池在无在途查询时关旧建新——**busy 不掐**，在途查询在旧连接跑完）；③TOOLS 第 18 项 reload_config（无参=恒从 DBMCP_CONFIG 路径重载，零任意路径读取面；幂等）。
- **实施中抓获真 bug**：reload 初版只做 enc 解密探针未就地赋 url/type——重载后源丢连接信息（E_CONFIG 缺连接信息×7 FAIL 当场暴露）；修复=镜像启动路径 189-212 的解密赋值+类型归一（只作用于 next.sources 新对象）。
- **回归钉（selftest +2）**：selftest **377→379（359→360）**——①reload 纯函数钉（normalizeCfg 形态拒绝/clamp 面【maxAffectedRows=-1→1 显式钉】/init_required + computeChangedSources 新增/删除/改file/enc轮换/零差异）双口径；②reload_config e2e 钉（init 仅：同内容零差异/增源生效+list_sources 反映/坏 JSON→E_CONFIG 且内存态保持上次成功态/复位清 dummy）。既有 17-tools 钉更新为 18；e2e 套件 47→48（+reload_config 同内容零差异调用）。
- **实测口径（2026-10-08，Node v24.15.0）**：selftest 379/0（未初始化 360/0）· sqlite 83/0 · e2e 48/0 · protocol 24/0 · mysql 37/0 · pg 62/0 · realform 43/0。存档：backup-1655\（改动前 22 文件封存）。
- **下一轮方向**：①server_stats 增强候选（错误码分布/慢查询聚合报表——按需）；②config profiles（多环境单文件切换——本轮路径重载已覆盖主流程，profiles 按需）；③驱动 minor 例行跟进（随功能轮带走）。
### V1.6.54（观测面：server_stats 工具落地（16→17 工具）——内存计数 + 慢查询环形缓冲，无文件依赖）

- **背景**：按 V1.6.53 排定方向执行「观测面增强：慢查询分析 + stats 快照」。现状盘点：慢查询日志=stderr 单行（纯函数 slowQueryLine，默认 2s 阈值，工具不可查询）；审计日志=DBMCP_ERR_LOG 文件（opt-in）——缺口=客户端无法查询服务端计数与慢查询历史。
- **设计对比（定盘新工具 + 内存态）**：A 读 stderr/文件面 ✗（stderr 进程外不可读；文件面引入「未启用即空」歧义与路径白名单面）；B 内存环形缓冲 + 新工具 `server_stats` ✓ 落地（observe.mjs 纯函数簇 createObsState/obsRecord/obsSnapshot：常开轻量计数器 per-source {count/errors/slow/total_ms/avg_ms} + 慢查询环形缓冲 cap32，SQL 预览经注入 scrub 脱敏——与 fmtLogLine 同一真相源；fail-open 永不改查询行为；无文件依赖故无「未启用」歧义；未初始化部署返回显式 init_required 提示与 list_sources 同形态）。16→17 工具，readOnly 注解，inputSchema 空对象。
- **产品变更**：observe.mjs +stats 纯函数簇；pool.mjs 四点接线（runQuery 成功/错误、runQueryStream、runCopyIn、withTransaction copyIn）+ 管理器暴露 getObs；server.mjs TOOLS 第 17 项 + callTool case + serverStats handler（init_required 显式提示）。
- **回归钉（selftest +3）**：selftest **374→377（357→359）**——①纯函数钉（计数/错误/慢计数/ring 顺序与 cap32 首尾/scrub 注入/avg）双口径；②e2e 钉（init 仅：计数接线/version 恒等/慢阈值默认 2000/形状）；③部署态钉（双口径：未初始化显式 init_required 提示/已初始化 version+形状）。既有「exactly the 16 documented tools」钉更新为 17（语义变更如实记录）；e2e 套件 16→17 工具计数 + server_stats 调用（46→47 项）。
- **实测口径（2026-10-08，Node v24.15.0）**：selftest 377/0（未初始化 359/0）· sqlite 83/0 · e2e 47/0 · protocol 24/0 · mysql 37/0 · pg 62/0 · realform 43/0。存档：backup-1654\（改动前 22 文件封存）。
- **下一轮方向**：①配置面增强（多环境配置热切换——dbmcp.config.json 变更后无需重启的服务端重载）；②server_stats 增强候选（错误码分布/慢查询聚合报表——按需）；③驱动 minor 例行跟进（随功能轮带走）。
### V1.6.53（功能面：offset 分页——query/sample_data 加 offset 参数（跳过前 N 行取后续页），设计对比否决有状态游标三候选）

- **背景**：按 V1.6.52 排定方向执行「功能面扩展：流式查询分页/游标续读」。现状盘点：query max_rows≤5000 物化、sample_data limit≤50 小页、export 流式已担大批量——缺口=聊天面浏览大表的续页能力。
- **设计对比表（否决三候选的理由入档）**：A sample_data keyset 游标 token（token 内嵌排序键→WHERE 注入面/守卫/类型面，复杂度高）✗；B query scroll 参数（同 A + 任意 SQL 不可控）✗；C read_page 有状态游标新工具（游标注册表+连接钉扎【池 max 2/源】+TTL+取消交互+驱动分歧【pg 真游标/sqlite 语句暂停/mysql 无服务端游标须重扫】——复杂度很高，深翻页真需求出现时复活）✗；**D offset 分页参数 ✓ 落地**（LIMIT/OFFSET 追加，intArg 正整数校验 0..1e6 零注入面，三驱动原生 OFFSET 语义一致，默认 0 行为不变）。D 取舍如实：深翻页 OFFSET 是数据库端重扫——agent 取样场景（页 1~20）够用，深翻页建议稳定 order_by（工具描述已注明）。
- **产品变更**：①guard.mjs enforceLimit 加可选 offset（包裹语句外层 `LIMIT maxRows+1 OFFSET n`；offset=0 旧形状字节不变）；②server.mjs doQuery 加 offset——双层语义（包裹语句 SQL 层 OFFSET、不包裹语句【括号复合/SHOW】执行后 slice 层偏移，包裹判定与 enforceLimit 输出前缀耦合有钉锁定），响应 offset>0 回显；③sampleSql/sampleData 加 offset（`LIMIT n OFFSET m`，0 不追加）；④TOOLS schema query/sample_data 各加 offset 属性（integer 0..1e6）。16 工具数不变（参数增量）。
- **回归钉（selftest +2）**：selftest **372→374（356→357）**——①offset 分页形状钉（sampleSql 缺省/0 字节不变 + 三驱动 OFFSET 形状 + 负值直通 + enforceLimit 外层耦合锁定）双口径；②e2e 分页钉（init 仅：sqlite 25 行临时表——query 三页 0/10/20×10 无重叠无遗漏+offset 回显、sample_data offset 页 11..20、mysql 复合语句不包裹 slice 偏移 21..25；直连建/删表）。实测教训：sqlite prepare 拒裸括号 select（near "("），不包裹分支用 mysql 复合语句实测。
- **实测口径（2026-10-08，Node v24.15.0）**：selftest 374/0（未初始化 357/0）· sqlite 83/0 · e2e 46/0 · protocol 24/0 · mysql 37/0 · pg 62/0 · realform 43/0。存档：backup-1653\（改动前 22 文件封存）。
- **下一轮方向**：①观测面增强（metrics 导出/慢查询分析报告——MCP 客户端可观测性）；②配置面增强（多环境配置热切换）；③驱动 minor 例行跟进（随功能轮带走）。
### V1.6.52（驱动维护性升级：mysql2 3.24.5 / pg 8.23.1 + pg-protocol 1.16.1——diff 逐文件核实零破坏，两处修复落在我们的扩展协议路径；非性能轮）

- **背景**：按 V1.6.51 排定方向执行「驱动版本升级收益复核（考古先行）」。现状 mysql2 3.24.4 / pg 8.23.0 / pg-protocol 1.16.0。
- **考古方法**：npm 最新版比对（3.24.5 / 8.23.1）+ changelog/release notes + **tarball 逐文件 diff**（npm pack 新版与本地安装树 diff -rq，离线可证）。
- **可升级性矩阵**：mysql2 3.24.4→3.24.5 = 1 文件（URI IPv6 括号剥离，#4570）——零破坏、我们用 IPv4 无当前收益（防弹）。pg 8.23.0→8.23.1 = 7 文件：①`sync()` 不再误设 `_ending`（**正对我们扩展协议路径【named+unnamed 全走 extended】的潜态缺陷修复**）；②`hasBeenParsed` 改 `!== undefined`（与我们 Parse 毒化自愈的 delete 跟踪更兼容）；③normalizeQueryConfig 克隆不改调用方对象（中性偏正）；④TLS servername/IP、invalid-Date 弃用提示、portal/pipeline 拒绝共享、cert-signatures 注释 typo、native/*（未用）——全部无影响。pg-protocol 1.16.0→1.16.1 = serializer **BIND 参数序列化单遍化**（去临时 paramWriter+拷贝，参数化 wire 路径小幅真优化）+ buffer-writer 仅拷有效字节。
- **定盘与落地**：性能框架下无 ≥2× 收益（不做性能包装）；patch 级 + diff 逐文件核实零破坏 + 两处修复在我们协议路径 → 按**维护性升级**落地（门槛=diff 核实+全链验收+B 类判据复核，全部满足）。升级前驱动版本留档 `backup-1652_drivers_pre.json`（回滚对照）。
- **全链验收（升级后驱动上全绿）**：selftest 372/0（未初始化 356/0）· sqlite 83/0 · e2e 46/0 · protocol 24/0 · mysql 37/0（rowsAsArray 消歧/FLOAT 面复核✓）· pg 62/0（named 毒化自愈钉✓）· realform 43/0——B 类判据（判据库第 8/11 条）经套件复核通过。
- **参考数字（如实：跨会话不可归因，仅防回归佐证）**：升级后 pg named 点查 113.1µs（dup 地板 19.2）/ 参数化范围 158.1µs（30.7）/ 字面量全表 181.0µs（7.0）——与 V1.6.41 时代数字同量级无劣化；BIND 序列化微优化预期不可在产品级噪声上分辨。
- **产品变更**：依赖版本（package.json/lock：mysql2 ^3.24.5 / pg ^8.23.1）+ 版本号；产品代码零改动。回归钉：无新增（EXPECTED_TOTAL 372/356 不变）。
- **实测口径（2026-10-08，Node v24.15.0）**：见上全链验收行。存档：`D:\work\Zcode\DB\_dist\bench_r1652_ref.mjs` / `backup-1652\` / `backup-1652_drivers_pre.json`。
- **下一轮方向**：①**功能面扩展需求盘点**（性能线已收官+维护性升级完成——候选：流式查询分页/更多方言/观测面增强，需明确需求优先级后立项）；②驱动下个 minor 版本跟进（例行，随功能轮带走）；③判据库维护（新判据随轮追加）。
### V1.6.50（pg e2e 内存 +4.3% 归因收官：named 排除、残差定位堆页足迹——按决策树关闭该项，零产品变更轮）

- **背景**：按 V1.6.49 排定方向执行「pg e2e 内存 +4.3% 归因复核」（V1.6.45 观察项转正）。
- **复测确认**：exportmem_probe e2e-pg ×3（V1.6.49 代码）maxRSS 中位 **125.8MB** vs V1.6.45 现状 126.8 vs v1632 基线 121.6——+3.5~4.3% **仍在且跨版本稳定**（V1.6.45→V1.6.49 代码间不变，输出 md5/bytes 全同）；sqlite 面复测 93.5MB 稳定（vs 93.4）——漂移是 **pg 面局部化的**。
- **归因（bench_r1650_attr，named ON/OFF 四臂独立进程 + heapTotal/残差分解）**：①**named 客户端跟踪排除**——ON/OFF rss 差 ≈0.3-0.5MB（噪声内；结构预期：导出走 runQueryStream 游标路径 DECLARE/FETCH 字面量语句，从不触 named 缓存）；②heapUsed（28.3→9.6）/external（6.2）两臂全同；③**+4.2MB 差值落在 rss−heapUsed−external 残差**（V8 堆页足迹+驱动原生缓冲）——无客户端堆增长证据。
- **判定：按决策树关闭该项**——残差定位为分配器/堆页足迹漂移（非客户端分配增长面）；4MB 级残差做跨 era 五备份树二分与收益不成比例；输出恒等+六套件全绿+跨版本稳定佐证无害。
- **产品变更**：无（零代码变更轮；版本号照常推进）。回归钉：无新增（EXPECTED_TOTAL 372/356 不变）；六套件复验防漂移。
- **实测口径（2026-10-08，Node v24.15.0）**：selftest 372/0（未初始化 356/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1650_attr.mjs` / `backup-1650\`（探针表 dbmcp_qstream_probe 已 teardown）。
- **下一轮方向**：①**驱动版本升级收益复核**（非排期）——mysql2 3.24.4 / pg 8.23 现状 vs 新版协议层收益（解码/预编译/内存足迹），版本考古先行；②**客户端性能面里程碑收官轮**（候选）——读/写/解析/响应组装/内存五面均已定盘或封存，可收官轮整理判据库（勿再试清单成文）与文档固化；③（无高占比候选时的默认）收官轮。
### V1.6.49（yield 粒度×取消延迟权衡收官：现行每段让出即最优——取消 ack 亚毫秒，粒度线封存零产品变更轮）

- **背景**：按 V1.6.48 排定方向执行「yield 粒度×取消延迟权衡复核」：源码级临时副本把 readCsvForImport 每段让出改模 N（N=1 现行/16/64/256/∞），17.3MB CSV（30 万行 > 10k 上限→解析完即 E_LIMIT，纯解析相位零写库），取消经产品 cancelRpc 注入（trackRpc 同 stdio 主循环形态），测 cancel 触发→import settle 延迟。
- **解析墙钟（9 遍中位）**：N=1 148.9-159.4ms，N=16/64/256/∞ 差异 0~+7%——本轮 N=64 名义最快（2.4× dup 地板）但上一轮同矩阵 ±0.6% 无效应，**跨 run 不一致，不过双 harness 一致纪律**；yield 调度成本实测 ~2.4µs/次（0-7%/159ms）。
- **取消插队延迟（决定性）**：现行 N=1 形态真实取消**中位 80µs / p95 338µs——亚毫秒**（判定条 50ms 的 1/150；v1.6.24 修复前峰值 109ms 的 1/1360000 量级）；N=16 同样亚毫秒（45/77µs）；N≥64 取消大面积落在解析结束后（N=64 仅 2/15 触发、N=256/∞ 0/15）——粗粒度在契约面劣化而解析收益不可证。E_LIMIT 语义恒等门各 N 档 PASS。
- **判定：现行每段让出形态即最优，yield 粒度线封存**——任何粗粒度 N 以取消契约为代价换不可靠的解析微收益；同时**修正 V1.6.47 误读**：「yield 调度地板 ~5.5ms/10k」不成立（实测 ~2.4µs/次），V1.6.47 下轮候选「吃 yield 地板」溶解。
- **产品变更**：无（零代码变更轮；版本号照常推进）。回归钉：无新增（EXPECTED_TOTAL 372/356 不变）；六套件复验防漂移。
- **实测口径（2026-10-08，Node v24.15.0）**：selftest 372/0（未初始化 356/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1649_probe.mjs` / `backup-1649\`（本轮零 DB 夹具——纯解析相位）。
- **下一轮方向**：①**pg e2e 内存 +4.3% 归因复核**（V1.6.45 观察项转正——若归因到 named 预编译客户端跟踪量，评估 Map 裁剪；若为分配器/页缓存噪声则关闭该项）；②驱动版本升级收益复核（mysql2 3.24.4 / pg 8.23 现状 vs 新版协议层收益——版本考古先行，非排期）；③客户端性能面里程碑总结（读/写/解析/响应组装四面均已定盘或封存——若下轮无更高占比候选，可考虑收官轮整理判据库与文档）。
### V1.6.48（读路径残余复核收官：named 预编译后驱动往返占 88-96%，客户端面已薄零产品变更轮）

- **背景**：按 V1.6.47 排定方向执行「读路径残余复核」——V1.6.37 基线（驱动往返 79.9-109%）在 V1.6.41 named 预编译落地后的刷新测量。
- **刷新方法**：pool.mjs 源码级临时副本（9 锚点 hrtime 标记：checkout/driver×3/prep/zip×3，ns→µs，跑完即删）；三驱动 × 1/100/1000 行，15 交替轮 + dup 臂地板；行数据恒等门 PASS。
- **刷新归因表（15 轮中位 µs；vs V1.6.37 total 基线）**：sq@1000 total 259.9（driver 238.0=91.6%+zip 16.9+glue 5.5）vs 基线 563.8（**−53.9%**）；my@1000 615.5（driver 581.1=94.4%+zip 20.8+glue 6.6）vs 816.3（**−24.6%**）；pg@1000 705.9（driver 622.3=88.2%+zip 23.1+glue 11.7）vs 891.6（**−20.8%**）。低档同向：sq −71.7/−61.8%，my −18.6/−12.8%，pg −3.1/−18.8%——named 预编译+zip 工厂+历轮累计收益全部兑现在总量上。
- **判定：客户端可动手面已薄，收官**——①驱动往返 88-96% 属网络/服务端，产品 JS 不可再压；②客户端残余（zip 4.7-23.1µs+prep+glue 4.2-11.7µs）在 mysql/pg 面**低于或贴着自身 dup 噪声地板**（my@1000 地板 194.6µs vs 客户端面 ~27µs；pg@1000 地板 69.8 vs ~35），sqlite 面绝对值已小（zip 16.9µs 为 V1.6.37 工厂已优化项）——无 ≥2× 地板的可落地项，零产品变更。
- **产品变更**：无（零代码变更轮；版本号照常推进）。回归钉：无新增（EXPECTED_TOTAL 372/356 不变）；六套件复验防漂移。
- **实测口径（2026-10-08，Node v24.15.0）**：selftest 372/0（未初始化 356/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1648_prof.mjs` / `setup_r1648.mjs` / `backup-1648\`。
- **下一轮方向**：①**yield 粒度×取消延迟权衡复核**——import 每行 setImmediate 地板 ~5.5ms/10k 行（V1.6.47 判据：须先量化取消插队延迟契约的可松动面，如每 N 段让出，契约数字先行）；②pg e2e 内存 +4.3% 轻量跟踪（V1.6.45 观察项）；③读路径客户端面正式封存（除非驱动层出现新杠杆，如驱动版本升级带来协议层收益）。
### V1.6.47（import 解析链 charCodeAt 分派落地：机制面 −17~22%（46×/15× 地板），产品级被 yield 调度地板稀释如实报）

- **背景**：按 V1.6.46 排定方向执行「import 解析/值变换段复核」：插桩探针（server.mjs 源码级临时副本，两锚点 hrtime 标记，跑完即删）分段定盘 10k 行端到端。
- **分段归因表（10k 行，5 遍中位 µs；改动前）**：mysql e2e 96.3ms=parse 9.4ms(9.7%)+batch 86.0ms(89.3%)；pg 26.4ms=parse 5.7ms(**21.7%**)+batch 20.0ms；sqlite 17.5ms=parse 5.8ms(**33.2%**)+batch 12.0ms——解析段是驱动无关固定客户端成本（~0.6-0.9µs/行），mysql 面 <15% 无余量、pg/sqlite 面过线。prep≈0；other <2.1%。
- **机制基准（bench_r1647_mech，链复刻无 yield）**：链热点=parseCsv 7.0ms+segmenter 3.5ms+row.map 0.6ms（10k）；**charCodeAt 数值分派**（parseCsv+createCsvSegmenter 双热环，src[i] 逐字符产生 1 字符串的分配+字符串比较 → 数字比较）：差分门 **12/12 恒等**（对抗语料引号/转义/CRLF/BOM/多字节/尾空行 + 真实 10k 全链 valueRows）；链 A/B 10k **−22.0%（46× dup 地板）**、30k −17.2%（15×）→ **落地**。row.map 内联 +0.4-0.8%（低于地板）**不落地**。
- **产品变更（server.mjs）**：parseCsv 与 createCsvSegmenter 的逐字符环改 charCodeAt+QUOTE/COMMA/CR/LF 常量（语义逐字不变，注释含判据）；无新钉（既有 parseCsv V1.6.25 保真钉+六套件盯防），EXPECTED_TOTAL 372/356 不变。
- **产品级复测（如实）**：分段探针三遍——parse 段改动后稳定 ~5.6-6.0ms（改动前 5.7-9.4，mysql 面 9356 为离群值）；e2e mysql −14.2%/pg −9.1%/sqlite −4.9% 但 batch 段同幅波动（服务端噪声 80-86ms 摆动）污染归因。**判读：机制面收益真实且过地板（46×/15×），产品级被每行 yieldEventLoop 调度地板（~5.5ms/10k 行，v1.6.24 取消响应契约刻意每段让出）稀释——e2e 效果 Modest 且本测量粒度下不可干净归因**。
- **观察/判据入档**：①yield 粒度（每行一次 setImmediate）是取消响应契约（v1.6.24：8MB 导入取消插队峰值 109ms→修复），改动需先测取消延迟，勿当免费项；②产品级分段测量里 batch=duration_ms 是毫秒分辨率+服务端噪声，同幅波动时不可归因给客户端改动。
- **实测口径（2026-10-08，Node v24.15.0）**：selftest 372/0（未初始化 356/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1647_{probe,mech}.mjs` / `setup_r1647.mjs` / `backup-1647\`（改动前 22 文件封存）。
- **下一轮方向**：①**读路径残余复核**（V1.6.41 named 预编译后 runOnPool 分段刷新——V1.6.37 基线驱动往返 80%+，named 落地后占比需重测）；②yield 粒度与取消延迟权衡复核（若要吃 yield 地板，须先量化取消插队延迟契约的可松动面）；③pg e2e 内存 +4.3% 轻量跟踪（观察项）。
### V1.6.46（写路径批量化落地：importBatchSize 封顶 1000→5000——mysql 端到端 −22%/pg −20%，批回退语义实测不变）

- **背景**：按 V1.6.45 排定方向执行「写路径批量化复核」：import_data 批 INSERT（mysql/sqlite 多 VALUES）与 pg COPY 两条写路径的批大小敏感面剖析（写段隔离：valueRows 预构建不含 CSV 解析），批回退语义红线（V1.6.24-25）不动。
- **敏感面定盘（bench_r1646，30k 行写段，双独立 run 交替轮 + dup 臂地板）**：批耗时**亚线性**（固定往返开销摊薄）——mysql @5000 +17.4~19.7%（@10000 +26.6% 2.4× 地板，但 pg COPY @10000 平台化 +30.7%≈@5000 的 +32.2% 不取）；pg COPY @5000 **+32.2%（2.8× dup 臂地板 ✓）**；sqlite @5000 +61.2~64.4%（双独立 run 一致；本轮 dup 臂被 fsync 噪声打爆不可用，按「流式微常量需双 harness 一致」纪律以两 run 同向同量定盘）。**产品常量 importBatchSize 封顶 1000→5000**（min(5000, budget/cols)）：窄表 cols≤4(sqlite)/≤10(mysql|pg) 拿满 5000，宽表仍由占位符预算兜底（cols=60 不变 333/833）。
- **产品级 A/B（10k 行 CSV import_data 端到端，同脚本改动前后各 3 遍中位）**：mysql **110.4→86.1ms（−22.0%）**、pg **34.9→27.9ms（−20.1%）**；含解析/值变换/批写全链，方向与机制基准一致。**失败注入双库实测不变**：坏行 @1500（PK 冲突）→「第 1500 行导入失败，整批中止（此前 1499 行已写入）」，imp_t2=1499 行——批回退语义（逐行定位/整批中止/坏批不部分写入）逐字保持。已知代价（如实）：约束错回退逐行定位最坏扫描上界 1000→5000 行（仅错误路径）；取消粒度按批（5000 行批 ~4-37ms，无感）。
- **回归钉**：无新增 check——两处既有 importBatchSize 钉的期望随语义更新（窄表封顶 1000→5000 + cols=5 预算界 4000 显式钉 + cols=0/NaN 兜底 5000；宽表 cols=60 预算界值不变），EXPECTED_TOTAL 372/356 不变。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 372/0（未初始化 356/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1646_{mech,mech2,e2e}.mjs` / `setup_r1646.mjs` / `backup-1646\`（改动前 22 文件封存）。
- **下一轮方向**：①读路径残余复核（V1.6.41 named 预编译后 runOnPool 残余占比刷新——驱动往返仍是 my/pg 大头但客户端面已薄）；②pg e2e 内存 +4.3% 轻量跟踪（V1.6.45 遗留观察项）；③import 解析/值变换段复核（端到端里解析段占比——10k 行 mysql e2e 86ms vs 写段机制 ~80ms 量级，解析段或有余量，先剖析）。
### V1.6.45（大结果集导出内存面复检：三驱动 CSV 面漂移全部 <10% 健康——sqlite −1.1%/mysql +1.5%/pg +4.3%，零产品变更轮）

- **背景**：按 V1.6.44 排定方向执行「大结果集导出内存面复检」：30k 行导出 maxRSS 现状实测（exportmem_probe.mjs 原探针复跑，同 workload 同 marks，每面 3 独立进程取中位）对照 V1.6.29-32 归档基线。
- **内存面漂移矩阵（vs exportmem_after_v1632 归档，maxRSS MB 中位）**：sqlite e2e 现状 **93.4** vs 基线 94.4（**−1.1%**）；mysql e2e **103.1** vs 101.6（**+1.5%**）；pg e2e **126.8** vs 121.6（**+4.3%**——低于 10% 归因线，高于另两面噪声带，如实记录；after_write_gc 的 heapUsed/external 与基线一致，RSS 余量或为命名预编译客户端跟踪/分配器页缓存，未达归因门槛不动产品）。三面 csv_md5（073e6c…）与 bytes（15548017）与基线**全同**——输出恒等伴随内存复检。**判定：内存面健康，无回归，无需处置**。
- **JSON 导出面现状（补充实测，无归档基线——V1.6.29-32 探针只测 CSV 链，如实标注）**：sqlite 30k 行 JSON 导出 maxRSS 中位 **96.1MB**（heapUsed 峰 23.1/external 4.7；载荷 2.5MB 远小于 CSV 15.5MB，RSS 由行集驻留主导与 CSV 面同源）。后续轮若需要 JSON 面基线，以本轮数字为起点。
- **候选 2 封存状态确认（只报告）**：工具面组装复检（normVal walk+clone ~120µs/千行）维持封存——被 V1.6.37 zipRows BigInt 保真钉（row.big === 9007199254740993n）阻断，口径调整（行集预归一化）前不解封。
- **产品变更**：无（零代码变更轮；版本号照常推进）。回归钉：无新增（EXPECTED_TOTAL 372/356 不变）；六套件复验防漂移。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 372/0（未初始化 356/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\exportmem_json_v1645.mjs`（JSON 面现状探针）/ `backup-1645\`；CSV 面复跑用原探针 `exportmem_probe.mjs`（探针自含 setup/teardown，dbmcp_qstream_probe 已清）。
- **下一轮方向**：①工具面组装复检封存状态维持（口径调整提案需先过 zipRows BigInt 保真钉设计评审）；②**写路径批量化复核**——import_data/execute 的批写入路径（批 INSERT/COPY）在大载荷下的耗时与往返次数现状定盘（V1.6.24-25 批回退语义不动，只剖析）；③pg e2e +4.3% 的轻量跟踪（若后续轮 RSS 面再涨，回查 named 预编译客户端跟踪量）。

### V1.6.44（数字口令全链一致性盘点封存 + mysql execute 复核否决入判据：FLOAT 列 text/binary 语义漂移实锤，零产品变更轮）

- **背景**：按 V1.6.43 排定方向执行双线：a) 数字口令全部清洗出口口径盘点；b) mysql2 rowsAsArray 替代可行性复核（V1.6.39 否决判据源码级重审）。
- **线 a 盘点矩阵（代码级逐面 + 既有钉覆盖确认）**：工具响应 JSON（scrub→scrubWith JSON 口径，V1.6.42 钉）/ CSV 导出（csvCellDigitMask 单元格级 + plainKeys 管线，V1.6.43 钉）/ JSON 导出（数字口令存在→scrubWith 字符串链，V1.6.43 接线）/ errorContent（scrub→JSON 口径）/ 审计日志 fmtLogLine（safe()→权威 scrub）/ 慢查询日志（scrub(sql)）/ cancel reason（scrub）/ resolveExportTarget（无 scrub——结构性文件名校验，非秘密清洗面）。**结论：全部秘密清洗出口口径一致（scrubWith JSON 口径或 CSV 单元格级），无缺口，封存**。
- **线 b 源码考古 + 机制基准（bench_r1644，realdb 直连双连接）**：①**源码修正**：mysql2 3.24.4 的 `queryOptions` 末行 `Object.assign(options, overrides)`——per-call/连接级 `rowsAsArray` 可得（V1.6.39「stmt.execute 不支持 rowsAsArray」表述不准确，Statement.execute 确不收 options，但 **Pool/Connection config 级 rowsAsArray 让 binary parser 出数组行**；mysql2 内建 statement 缓存 `connection._statements` 生效实测 8 条目；`execute({timeout})` 超时面实测有效）。②**结果恒等门 6 例 FAIL=1**：FLOAT 列 text 协议=服务端格式化 `"3.14159"`（显示宽度）vs binary=float32 全值 `3.141590118408203`——其余 5 门（重名列消歧/BIGINT/DECIMAL/NULL/BLOB/写 OkPacket）逐字节恒等。③**吞吐 A/B（15 交替轮+dup 臂地板）**：t1000 −15.9%（地板 77.9µs→~1.0×）/ t100 −19.1%（~1.0×）/ 参数化点查 −1.3%（无增益）——增益方向一致但远不达 2× 噪声地板。
- **判定：execute 不落地，判据入档**：①FLOAT 列 text/binary 语义漂移（客户端无法复现服务端显示宽度格式化，typeCast 亦不可行）——除非产品显式接受 FLOAT 语义变更，否则 execute 不可替换 query；②吞吐增益不达 2× 地板（双重否决理由）；③V1.6.39 判据表述修正存档（rowsAsArray 可得性≠可行性，否决依据更新为本轮实测）。
- **产品变更**：无（零代码变更轮；版本号照常推进）。回归钉：无新增（EXPECTED_TOTAL 372/356 不变）；六套件复验防漂移。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 372/0（未初始化 356/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1644_{mech,mech2}.mjs` / `setup_r1644.mjs` / `backup-1644\`。
- **下一轮方向**：①工具面组装复检封存状态复核（normVal walk+clone ~120µs/千行——若允许 zip 期归一化口径调整则解封重议，否则维持封存）；②大结果集导出内存面复检（30k 行导出 maxRSS 现状 vs V1.6.29-31 基线漂移检查）；③mysql execute 否决面的正面记录：若未来 FLOAT 语义可接受（或 mysql2 提供 text 等价格式化），可按本轮基准直接复议。

### V1.6.43（export CSV 数字口令单元格级处置：全数字单元保真/文本内部掩——导出数据损坏面收口；JSON 导出同步切字符串链）

- **背景**：按 V1.6.42 排定方向执行「export CSV 字节域数字口令单元格级处置」：csvCell/scrubBuffer 链触发条件实证 → 单元格级规则定盘 → 四 cell 点接线，scrubBuffer/scrubWith/管线零改动。
- **触发实证（bench_r1643，数字口令入 SECRET_LIST + 导出行含裸数字单元）**：现状导出 `1,424242,token-424242-x,4242420` → `1,***,token-***-x,***0`——裸数字单元被洗烂 + 长数字片段连坐（数据损坏实锤）；含子串文本单元 `token-***-x` 掩是正确泄漏面。
- **规则定盘（csvCellDigitMask 纯函数，6/6 手写期望）**：全数字单元（/^\d+$/）视为数据值/长数字片段整体保真；其余单元含数字口令子串 → 掩为 ***。**显式不对称（防漂移钉住）**：JSON 有引号结构可分（字符串值掩/数字 token 保真，V1.6.42 口径）；CSV 无引号结构可分（文本 "424242" 与数字 424242 渲染同形）→ 按数据保真优先整体保真——「文本单元恰等于口令」的泄漏面在 CSV 是已接受取舍。
- **产品变更**：①新增导出 `csvCellDigitMask`（纯函数）；②四个 cell 点接线（eachCsvLine/exportToCsv/measureCsv/exportToCsvBuffer/createCsvRowSink，均加 digitKeys 可选参数默认空=零行为变化；streamCsvLines 转发 opts）；③doExportData 拆两账（csvDigitKeys 单元格级 + csvPlainKeys 字节域，两账并集=SECRET_LIST）——流式 sink、回落字符串链、measureCsv 计量、导出文件名路径全部同口径；④**JSON 导出面同步修复**：存在数字口令时切 scrubWith 字符串链（V1.6.42 JSON 数字 token 口径），否则字节域快路径不变（scrubToBuffer 无上下文会洗烂导出 JSON 数字 token）。
- **产品级验证**：数字口令夹具端到端——CSV 与手写期望**逐字节一致 PASS**（`1,424242,token-***-x,4242420` + `2,999999,plain-text,0424242`）；JSON 合法 PASS（amt 字符串值掩/big 片段保真/note 掩，与 V1.6.42 钉住口径一致）；无数字口令配置下 export 链字节恒等由六套件（realform 43/e2e 46 重度压 export）+ 既有三链差分钉产品级确认。
- **回归钉（selftest +1 双口径）**：selftest **371→372（355→356）**——csv 数字口令单元格级处置钉（裸值/长片段×2/文本内部/引号格/非口令/空列表手写期望 + JSON-CSV 不对称显式钉 ×3 + 三链 digitKeys 恒等 + 手写期望整文件 + 无 digitKeys 零变化）。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 372/0（未初始化 356/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1643_{mech,verify}.mjs` / `backup-1643\`（改动前 22 文件封存）。
- **下一轮方向**：①mysql prepare-once rowsAsArray 替代复核（V1.6.39 否决判据仍有效，仅按需：mysql2 新版支持/协议层方案）；②工具面响应组装复检（normVal walk+clone ~120µs/千行被 zip 期归一化钉阻断——若未来允许口径调整再议，否则封存）；③数字口令全链一致性复核（scrubBuffer 字节域对自由文本数字口令的非 JSON/CSV 面——如错误消息直洗——现状口径盘点）。

### V1.6.42（数字口令洗烂面取舍：上下文清洗落地——数字 token 保真恢复合法 JSON；流式 batch/named×FETCH 双否决）

- **背景**：按 V1.6.41 排定方向执行双线：a) PG 流式路径定盘（batch 敏感面 + named×游标交互）；b) 数字口令洗烂面取舍（V1.6.38 遗留）。
- **线 a 定盘（t30000 直连 + 同进程双工厂产品级 A/B，15/21 交替轮 + dup 臂地板）**：①named×FETCH 交互 = **0.6%（2.6µs）死路**——FETCH 文本解析成本被行解码完全淹没，勿再试；②batch 敏感面：机制基准 500→5000 总耗时 19.9→13.2ms（batch=2000 理论 −12%），但产品级两轮 A/B **符号翻转**（R=15: +14.4%（1.7× 臂间地板）→ R=21: **−0.8%**）——批间 GC 尖峰（max 3.9~5.8ms）主导方差，按「符号翻转不可做永久决策依据」判据 **batch 2000 不落地**，PG_FETCH_BATCH=1000 保持。流式路径本轮无可落地项（行恒等门 30000 行 PASS、早停复跑门 PASS 留档）。
- **线 b 定盘（触发实证 → 方案 a vs b → a' 上下文收窄）**：现状（方案 b）触发**实锤**——纯数字口令（≥4 位）入 SECRET_LIST 后，whole-T 清洗把响应 JSON 数字 token（`"amt":424242`）洗成 `"amt":***` → **T 非法 JSON**（bench_r1642 实证）；纯方案 a（数字口令退出清洗）响应合法但**泄漏面实测**（文本形态口令原样残留）。定盘 **a'（方案 a + 上下文收窄）**：数字键只清洗非数字-token 语境——数字 token 前缀（跳过空格，兼容 pretty）是 `:` 判定为数据保真保留；字符串字面量/自由文本照掩。已知取舍：「冒号+空格+纯数字」自由文本形态恰等于口令时不被清洗（数据保真优先）；长数字串片段（前后邻数字）不清洗防误伤。
- **产品变更（server.mjs scrubWith）**：新增 DIGIT_KEY_RE + maskDigitKeyContext（数字键上下文扫描）；非数字键 split/join 路径零改动；scrubBuffer/scrubToBuffer（export CSV 字节域）不改——CSV 无数字/字符串语境可分，该面记录为已知（V1.6.43 候选：csvCell 单元格级处置）。
- **产品级验证（端到端 handleRpc）**：同一夹具（数字口令入 SECRET_LIST + 行含同值数字）：修复后 T 合法 JSON=true、amt=424242 保真 PASS（修复前 T 合法 JSON=false）。
- **回归钉（selftest +1 双口径）**：selftest **370→371（354→355）**——数字口令上下文清洗钉（compact/pretty 数字 token 保留 + 字符串字面量掩 + 整值等于口令也掩 + 长数字片段防误伤 ×2 + 已知取舍显式钉 + 自由文本非冒号前缀照掩 + 非口令数字零误伤 + 非数字键行为不漂移）。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 371/0（未初始化 355/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1642_{prof,batch,batch2,verify}.mjs` / `setup_r1642.mjs` / `backup-1642\`（改动前 22 文件封存）。
- **下一轮方向**：①export CSV 字节域数字口令单元格级处置（csvCell 内裸数字单元保真、含子串长文本掩——scrubBuffer 未改的已知面）；②mysql prepare-once rowsAsArray 替代复核（V1.6.39 否决判据仍有效，仅按需）；③工具面响应组装复检（resultContent 链已定盘协议必需，残余=normVal walk+clone ~120µs/千行，被 zip 期归一化钉阻断——若未来允许口径调整再议）。

### V1.6.41（pg 参数化 named 预编译：直连基准推翻 V1.6.39 收窄依据（臂序偏置），作用域扩到参数化——点查 −62%/范围查 −35% 机制级、产品级 +4.9%/+21.2%；无需 force_custom_plan）

- **背景**：按 V1.6.40 排定方向执行「pg 参数化路径 plan_cache_mode 复核先行」：直连基准拆参数化 named 的 custom→generic 切换、force_custom_plan 收益/代价、EXPLAIN 对照（bench_r1641，15 交替轮 + 地板臂）。
- **机制定盘（与 V1.6.39 假设相反）**：①named auto 无 generic-plan 悬崖——点查第 6 次后反而更快（79.5 vs 前 5 次中位 199.2µs）；②稳态三臂：点查 unnamed 152.6 → **named-auto 58.6µs（−62%）**、范围查 140.3 → **90.7µs（−35%）**，地板干净；③force_custom_plan 更差（点查 69.5/范围 135.0µs——每执行付计划生成费）→ **不做 SET，auto 模式即最优**；④V1.6.39 产品级参数化 cell 的「反慢 −10.6%」确认为**臂序偏置**（当时两轮符号翻转 −10.6%→+16.4% 已示 bias），非真实效应——本轮作用域扩展即修正。
- **产品变更（pool.mjs pg 分支）**：named 预编译缓存作用域从字面量扩展到参数化（去掉 values 空判定，值仍走 client.query({name,text,values}) 绑定）；per-client Map/命名单调/128 上限整清/Parse 毒化自愈/setPgPreparedCache 逃生阀全部沿用；Bind 错误（如参数类型不匹配）走同一错误路径自愈（清客户端跟踪 + map，下次重 Parse）。零 SET、零新协议面。
- **产品级 A/B（15 交替轮中位数 + 结果恒等门 6/6 先行）**：参数化范围查 ON 182.8 vs OFF 232.1µs（**+21.2%，5.2× 地板**）、点查 +4.9%（1.4× 地板，正但低于门槛如实报）、handleRpc count_rows +28.3%、sample_data +12.1%；Bind 错误自愈 PASS（bad 参数两次 + 好参数恢复）。行数/字段恒等（不同参数值 × 点查/范围查）。
- **回归钉**：无新增 check（既有 pg 预编译正确性钉扩展为「参数化 named 跨值复用可用」——两次不同参数值的 find_tables_by_column 都走通；名称改 v1.6.41），EXPECTED_TOTAL 370/354 不变。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 370/0（未初始化 354/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1641_{mech,prod}.mjs` / `setup_r1641.mjs` / `backup-1641\`（改动前 22 文件封存）。
- **下一轮方向**：①大结果集流式定盘（PG_FETCH_BATCH×游标×named 交互）；②数字口令洗烂面取舍定夺（V1.6.38 遗留）；③mysql prepare-once 的 rowsAsArray 替代方案复核（仅当需要回收 my 千行收益时；V1.6.39 否决判据仍有效）。

### V1.6.40（export CSV 发射快路径机制基准：行级洁净快路径三数据集全负回退；cell 内联单次中和检测落地 +4.7%/+5.7%）

- **背景**：按 V1.6.39 排定方向执行「export CSV 发射行级洁净快路径机制基准先行」：createCsvRowSink.row 现状 947ns/行（30k 行 28.4ms），逐字段拆解为 4 类正则预检（cell 中和 + csvCell 重复中和 + 引号 + 代理哨兵）×字段数 + 5 次 put（逐段 scratch.write）+ 逐字段 byteLength。候选二臂：①整行洁净快路径（合并正则一次 test + 全行 join 单次 put）；②cell 内联（保持发射结构，仅消 cell/csvCell 的重复中和检测）。
- **机制基准定盘（bench_r1640_mech，30k 行 × clean/mixed/dirty 三数据集，15 交替轮中位 + 字节恒等门先行）**：字节门 5/5 过（三数据集输出逐字节恒等 + E_LIMIT 早停同点 + 惰性列）。①**洁净快路径三数据集全负**：clean −3.2%/mixed −7.8%/dirty −1.4%（负 15.6×/37.3×/19.3× 地板）——每字段一次较重合并正则 + 逐行 parts 数组/join 分配贵过现有逐字段 put，与 V1.6.36/38「重构发射形态打不过现有融合形态」同根因，**回退勿再试**（判据入 createCsvRowSink 注释）。②**cell 内联三数据集全正**：clean +4.7%（4.4× 地板）/dirty +5.7%（5.1×）/mixed +1.5%（0.7×，正但低于门槛；mixed 脏行多省面小）——纯去重机制（消一次重复正则），**落地**；csvCell 本体保留为回落链真源，漂移由既有三链差分钉盯防。
- **产品变更（server.mjs createCsvRowSink.cell）**：csvCell 逻辑内联（单次中和检测：检测+前缀+计数一次完成），发射结构/字节核算/E_LIMIT 边界零改动；端到端 export W_total 46.1→46.0ms（方向一致，会话噪声级；价值在机制去重 + 字节恒等）。
- **回归钉**：行为逐字节恒等（无新语义）——既有 createCsvRowSink 增量 vs 整链差分钉 + 三链差分钉覆盖漂移面，无新增钉，EXPECTED_TOTAL 370/354 不变。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 370/0（未初始化 354/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。基准存档：`D:\work\Zcode\DB\_dist\bench_r1640_mech.mjs` / `backup-1640\`（改动前 22 文件封存）。
- **下一轮方向**：①pg 参数化路径 plan_cache_mode=force_custom_plan 会话复核（named 收益能否安全扩展到参数化语句）；②大结果集流式定盘（PG_FETCH_BATCH×游标×named 交互）；③数字口令洗烂面取舍定夺（V1.6.38 遗留）。

### V1.6.39（mysql/pg 服务端预编译机制基准先行：pg 命名预编译字面量缓存落地——query 工具点查 −27%、LIMIT 1000 行 −12%；mysql 候选否决入判据；export 链残余定盘 CSV 发射占 62%）

- **背景**：按 V1.6.38 排定方向执行双线剖析先行：a) export_data 链 wall 分段减法 + 机制计数器（rows/write_calls/bytes）；b) mysql/pg 驱动段 prepare/execute/fetch 拆分（mysql2 text 协议 vs execute vs prepare-once；pg unnamed extended vs named prepared），单连接直连基准定盘后再选型。
- **剖析 a 定盘（sqlite 30k，CSV 1.79MB，9 轮中位）**：export_data W_total 46.1ms = 取数流 32.1%（14.8ms，493ns/行）+ **CSV 发射（sink）~62%**（28.4ms，947ns/行）+ 落盘/信封 6.4%——残余大头是客户端 CSV 发射本身，且已是 V1.6.31 融合最优形态；行级洁净快路径候选记 V1.6.40。mysql 38.5ms / pg 52.2ms 出口总额交叉核对一致。
- **剖析 b 定盘（t100 单连接直连，15 轮交替中位）**：pg **named prepared 点查 121.0→73.5µs（−39%）**、100 行全表 170.8→133.1µs（−22%）——Parse-skip 是纯收益，决定性候选；mysql prepare-once 全表 188.3→144.1µs（−23%）但**点查反慢 3.8µs**（二进制协议解码开销），且 mysql2 `stmt.execute` 不支持 `rowsAsArray`（重名列消歧语义崩塌）→ **mysql 候选否决入判据**（pool.mjs mysql 分支注释）。
- **产品变更（pool.mjs pg runQuery 分支）**：pg 命名预编译语句缓存，**作用域收窄到字面量 SQL（values 空）**——参数化语句在 pg 5 次执行后从 custom plan 切 generic plan（plan_cache_mode auto），实测点查反慢 −10.6%（负 2.5× 地板，悬崖区如实报）；无参数则计划恒一无切换可能，Parse-skip 纯收益。形态：per-client Map 挂池连接对象（连接销毁随 GC 释放）+ 命名单调不复用 + 128 上限溢出整批 DEALLOCATE + **Parse 毒化自愈**（pg 在 Parse「发送时」记 submittedNamedStatements、服务端拒绝也不回滚——错误路径清客户端跟踪，防同名查询永久 "prepared statement does not exist"）+ `setPgPreparedCache` 逃生阀（同款先例）。
- **产品级 A/B（同脚本交替 15 轮中位数，字节门 4/4 先行；两轮独立运行）**：字面量点查 −27.2%（7.3× 地板）/−12.1%；字面量 LIMIT 1000 行 −12.4%（4.5×）/−2.9%（7.1×）；字面量 100 行 −20.2%（1.3×）/−11.8%（1.2×）；handleRpc 端到端 100 行 −16.4%；参数化 cell 作用域收窄后两臂代码路径相同、delta 符号在两轮间翻转（−10.6% → +16.4%）= 纯臂序偏置，悬崖从产品面根除。毒化自愈 PASS（两次同错误、无 statement 毒化、好查询恢复）、130 条语句触发整清 130/130 PASS。
- **回退项（勿再试入档）**：mysql prepare-once 复用（rowsAsArray 不可得 + 点查反慢 + 集成面大）；pg named 作用域不可扩到参数化语句（generic-plan 悬崖）。
- **回归钉（selftest +1）**：selftest **369→370（354 不变）**——pg 命名预编译缓存正确性钉（字面量缓存命中两次查询 columns+rows 恒等【duration_ms 每次必变须剔除】+ 坏 SQL 两次同错误且无 statement 毒化 + 参数化 unnamed 路径 find_tables_by_column 可用；无 pg 源 SKIP）。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 370/0（未初始化 354/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。剖析与基准存档：`D:\work\Zcode\DB\_dist\bench_r1639_prof.mjs|.txt`（双线剖析）/ `bench_r1639_ab.mjs`（产品级 A/B+毒化+整清）/ `setup_r1639.mjs` / `backup-1639\`（改动前 22 文件封存）。
- **下一轮方向**：①export CSV 发射行级洁净快路径候选（947ns/行机制基准先行，V1.6.31 融合形态之上）；②pg 参数化路径悬崖的会话级 `plan_cache_mode` 复核（SET on checkout 的代价收益）；③大结果集流式路径复核（t30000 cell 两轮波动大，需 PG_FETCH_BATCH 交互定盘）。

### V1.6.38（resultContent 二次 stringify 复核：双份序列化=协议必需；单遍预转义 emitter 负优化 2× 回退；「逐值清洗」假说机制证伪回退）

- **背景**：按 V1.6.37 排定方向执行「resultContent 二次 stringify 复核先行」：对一次 tools/call 的响应组装段做 wall 分段减法 + stringify 调用计数器（rows 序列化 / scrub / 响应体封装各自计时），毫秒级拆解定盘后再选型。
- **剖析定盘（15 轮交替中位，三驱动 × 1/100/1000 行）**：stringify 调用计数器证实**双份序列化存在**——每 tools/call 恰 2 次大 stringify（pass1 内层 `stringify(data)` ≈90KB@千行 + pass2 主循环信封 `JSON.stringify(resp)`；另有 zipRowFactory 缓存键 26B 小调用一次，~2µs 无害）。组装段占比@千行：inner（normVal walk+clone+原生 stringify）18.8–34.7%、envelope（纯原生转义）9.7–19.1%、scrub 4.1–7.6%，合计 sqlite **61.4%**（已超驱动段 38%）、mysql 32.6%、pg 36.1%。**判定**：text 是嵌进信封的 JSON 字符串，pass2 的整体转义为 MCP text 协议必需，非重复劳动可消除；pass1 内 walk+clone ≈120µs/千行是唯一客户端可动手面。
- **选型 A/B（机制微基准 bench_r1638_mech，字节恒等门先行）**：数字格式拷问 42/42 恒等（String(n)≡JSON 格式化）→ **E2 单遍预转义 emitter**（walk 一遍直出双重转义信封，per-string 组合 regex 23ns/串）：对抗矩阵+真实载荷**字节恒等门 17/17 全过**（装箱 BigInt fail-closed 抛错同口径 bail）——但**性能负优化 ~2×**（千行 1101µs vs 冻结链 554µs，负 28.5× 噪声地板）：~2 万片 parts.push+join 打不过原生 C++ stringify，与 V1.6.36 replacer 陷阱同根因 → **回退，勿再试 JS 逐片 emit 形态**（判据入 server.mjs resultContent 注释）。
- **附带候选「normVal 短字符串逐值清洗」机制证伪回退**：假说「含引号/控制符口令在 T 层被转义 → whole-T 出口清洗漏洗」——实测 `secretListFromSources` 走 `new URL()` 解析，`u.password` 恒为百分号编码形态，**裸口令进不了 SECRET_LIST**，编码字符集 ⊆ T 层安全字符 → 漏洗面不存在；开关 A/B 实测字节零差异、纯 +53µs/千行（24× 噪声地板）→ **回退，勿再试**（前提变化才可重试：secretListFromSources 加入 decodeURIComponent 形态时须带开关重测；bench_r1638_scrub.mjs 存档）。
- **发现（未修，报告单列）**：纯数字口令（≥4 位）被 whole-T 清洗会把响应里同值数字洗成 `***` → 非法 JSON（`:1234,` → `:***,`）——洗烂 vs 泄漏的取舍，V1.6.39 候选定夺。
- **产品变更**：server.mjs 仅判据注释（resultContent 剖析结论 + E2/逐值清洗勿再试 + zip 期归一化被 V1.6.37 zipRows BigInt 保真钉阻断的判据），行为零变化。
- **回归钉（selftest +1）**：selftest **368→369（354 不变）**——双份序列化契约钉（wire 双重编码还原数据 + wire 层含 `\"row_count\"` 转义内引号；防未来「单遍序列化/预转义 emitter」重构漂移；部署无 sqlite 源时 SKIP）。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 369/0（未初始化 354/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。剖析与基准存档：`D:\work\Zcode\DB\_dist\bench_r1638_prof.mjs|.txt`（三驱动组装段剖析）/ `bench_r1638_mech.mjs`（E2 机制基准+字节门）/ `bench_r1638_scrub.mjs`（逐值清洗开关 A/B）/ `setup_r1638.mjs`（realdb 夹具）/ `backup-1638\`（改动前 22 文件封存）。
- **下一轮方向**：①导出 CSV 组装残余复核（同法 wall 减法+计数器定盘）；②mysql/pg 服务端预编译（驱动往返仍占 my/pg 千行 60%+，唯一剩余毫秒级杠杆，属驱动行为面需全六套件回归先行）；③数字口令洗烂面取舍定夺（配合 leak-guard 套件）。

### V1.6.37（runOnPool 路径毫秒级剖析先行：行对象常量键工厂 1000 行 −65.7% + sqlite 数组行 −18.2% + columns 单次；setReturnArrays 流式回归当场钉修）

- **背景**：续「继续优化」轮，按 V1.6.36 排定方向执行「runOnPool 路径毫秒级剖析先行」：对一次 tools/call 的 runOnPool 段先做 wall 分段减法 + CPU profile + 机制计数器三源三角定盘，再按占比选型。归因（15 轮交替中位数）：驱动往返占 runQuery 墙钟 79.9–109%（服务端+协议+解析，产品无法再压）；产品 JS 可动手面只剩行转换（zipRows 73–77µs/1000 行）与 sqlite 调度（3–9µs/查）；CPU profile 614 样本：idle 37.6% / runOnPool self 16.3% / utf8Slice 5.4% / zipRows 内层 2.6% / GC 3.3%。V1.6.36「占比高 ≠ 实现慢」教训直接指导选型：动手项全部先过同脚本并排 A/B 定盘。
- **产品变更**：①zipRows 行对象构建改常量键对象字面量工厂（列名集 → cached `new Function`，键名 JSON.stringify 转义进字符串字面量无注入面、单态 hidden class；缓存 64 超限整清、>512 列逃生阀落逐格循环）：1000 行 54.0→18.5µs（**−65.7%**，88.8× 噪声地板）、100 行 6.9→3.0µs（−56.5%，9.8×）。②`__proto__` 列名整表落 defineProperty 慢路径——旧逐格赋值对 `__proto__` 列静默丢值/换原型（mysql/pg `SELECT 1 AS \`__proto__\`` 可达的真缺陷），与 v1.6.36 normPost 同款处置修死。③sqlite 预编译语句开 `setReturnArrays(true)`（旧 Node 无此 API 自动回落对象行），数组行经 zipRows 出对象行：1000 行 552.8→413µs（−18.2%，3.8× 噪声）；`columns()` 单次复用（驱动调用 3→2/查）。④流式 runQueryStream 三驱动统一走 makeZipRow 单行转换器（与 zipRows 同构）——**当场抓到的真回归**：setReturnArrays 是语句级状态、`iterate()` 同变数组行，v1.6.35「早停后全量再流式」钉打穿（`row.name` 变 undefined）；mysql/pg 流式逐格裸赋值的 `__proto__` 隐患一并收口。
- **产品级 A/B 定盘（同脚本交替 15 轮中位数，字节/结果恒等门先行 + 噪声地板臂）**：sqlite −4.5%/−16.4%/−30.2%（1/100/1000 行，8.3×/17.1×/7.2× 噪声）；mysql −11.1%/−8.0%（100/1000 行，2.8×/2.6×）；pg −8.5%@1000（12.4×）；my@1/pg@1/pg@100 噪声内无回归。
- **回退项（勿再试入档）**：逐格 `i===protoAt` 分支进热循环是负优化（1000 行 +5.7%）——`__proto__` 列整表走慢路径、正常列零分支才对；null 原型行对象 +280µs/1000 行（V1.6.36 已否，勿再试）。
- **回归钉（selftest +4）**：selftest **364→368（350→354）**——zipRows 常量键工厂 vs 冻结旧实现差分钉（常规/重复消歧/空名/数字形名/对抗名（引号/反斜杠/换行/U+2028/孤立代理项）/多类型值（BigInt/NaN/±Inf/undefined）/空结果/600 列逃生阀逐字节恒等 + 键序恒等）+ `__proto__` 手写期望钉（自有属性+值存活/原型不被换/JSON 视图含值/对象值不设原型/与消歧并存）+ 对抗列名+工厂缓存隔离钉（10 形态键值存活 + 交替列名集不串味）+ sqlite 数组行产品路径钉（值类型口径 BigInt/BLOB/键序/空结果带列名/缓存开关两分支同口径/重名前置拒绝不放宽/流式行形状+早停复跑）。
- **实测口径（2026-10-07，Node v24.15.0）**：selftest 368/0（未初始化 354/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。剖析与基准存档：`D:\work\Zcode\DB\_dist\bench_r1637.mjs`（wall/counters/prof 三模式剖析 harness）/ `bench_r1637_ab.mjs|.txt`（选型三臂 G1–G3）/ `bench_r1637_prod_ab.mjs|.txt`（产品级 A/B 九格定盘）/ `bench_r1637_{wall,counters,prof}.txt` / `backup-1637\`（改动前 20 产品文件封存）。**契约零变化**：行键序/重复列消歧 `__N`/renamed/fields 口径与冻结旧实现逐字节恒等（差分钉钉住）、`Error: [E_CODE:retry]` 形态、响应键序全不动；`__proto__` 列「静默丢值/换原型 → 自有属性保值」是缺陷修复非契约变更。
- **下一轮方向（V1.6.38 候选，按剖析占比排序）**：① resultContent 二次 stringify 复核（tools/call 响应组装是否存在双份序列化，占比线 30% 的 stringify 面残余）；② 导出 CSV 组装残余复核（V1.6.32 流式化后拼接面）；③ mysql/pg 服务端预编译（预编译语句复用省往返）——驱动往返占 80%+、产品 JS 微秒层红利已吃完，毫秒级只在往返次数与服务端。

### V1.6.36（工具面毫秒级剖析先行：序列化规范化 walk 1000 行 −13.7% + scrubWith 零命中预筛 21×；countTruncatedCells 负优化实测回退入档）

- **背景**：续「继续优化」轮，按 V1.6.35 排定方向执行「工具面毫秒级剖析先行」：先对一次 tools/call 做毫秒级拆解（wall 分段减法 + CPU profile + 机制计数器归因），再按归因选型实施。剖析归因（1000 行响应工具面自耗时占比）：runOnPool 38.1% / stringify 路径 30%（逐值 replacer 回调的机制成本）/ countTruncatedCells 15.5% / scrubWith 6.3%。
- **优化①（序列化规范化 walk）**：旧 `stringify` 走 JSON.stringify 逐值 replacer 回调——每值一次 JS 调用，该机制成本在 replacer 形态内无法消除；改为「规范化一遍（spec 序 toJSON 预处理 + 叶快路径 + 普通对象复制）+ 原生 JSON.stringify」。旧实现冻结为 `stringifyReplacer` 真源供差分钉对照，两者对任意载荷逐字节恒等。产品级 A/B（49 恒等门全过 + 11 轮交替中位数）：100 行 55.3→46.0µs（−16.8%）、1000 行 948.6→819.1µs（**−13.7%**，10.6× 噪声地板）。门检过程抓获并修复三类 spec 语义缺陷：链式 toJSON 二次调用（副本跳过可调用 `toJSON` 键，保住「只作用一次」）、装箱原始值复制走样（constructor 快筛 + 品牌检验原样交还，`new Number(NaN)`→`null`）、`__proto__` 自有键被赋值吞掉（defineProperty 保键）；pretty 形态曾因 `JSON.stringify(x, pretty?2:undefined)` 把 2 送进 replacer 槽静默失效，改显式 `null` 占位。
- **优化②（scrubWith 零命中预筛）**：旧实现对 SECRET_LIST 逐 key `includes` 全扫，无命中路径纯浪费；改为合并正则一次预筛——零命中 1 扫直返，命中落回旧循环（输出恒等），正则按 list 对象 WeakMap 缓存。同脚本对照（229KB×8 keys）：零命中 **601.1→28.3µs（21×）**、命中 712.3→670.9µs（−5.8%）。
- **回退项（countTruncatedCells 负优化实测否决）**：`Object.values().some()` 改 for-in+hasOwn 零分配版后同脚本对照反而 **慢 2.6×**（43.9 vs 17.1µs@1000 行，噪声 0.2µs）——V8 原生 values+短闭包快于 JS 迭代协议；已回退，代码注释留「勿再试」判据。**教训入档：CPU profile 自耗时占比 ≠ 实现慢（15.5% 占比的函数用 V8 原生写法已是快路径），优化选型终审只认同脚本并排 A/B。**
- **回归钉（selftest +3）**：selftest **361→364（347→350）**——stringify 规范化 walk vs 冻结 stringifyReplacer 差分钉（对抗行集+边界载荷 × 响应/导出/pretty/导出pretty 四模式逐字节恒等 + 根级边界 + 抛出同责）+ 手写期望钉（bigint 串化/截断后缀逐字/二进制预览 3B·9B/导出 hex/装箱 NaN→null/链式 toJSON 只作用一次/toJSON 键非函数保留）+ scrubWith 预筛等价钉（零命中/命中/重叠键双序/元字符不误伤/空键/空表/非串输入与旧循环逐字恒等 + 同表缓存命中不漂移）；ctc 语义边界内扩进「truncated cell counting」钉（零计数漂移：阈值严格大于/同行多长串计 1/数组·嵌套·键名不计/非对象行跳过/继承键不计）。
- **实测口径（2026-10-06，Node v24.15.0）**：selftest 364/0（未初始化 350/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。微基准存档：`D:\work\Zcode\DB\_dist\bench_toolface.mjs`（剖析 harness：wall 分段减法 + CPU profile）/ `bench_ser_v1636.mjs|.txt`（五臂选型 S1–S5）/ `bench_slim_v1636.mjs`（walk 形态四臂，null 原型副本 +280µs 实测否决）/ `bench_prod_ab_v1636.mjs|.txt`（产品级 A/B 定盘，49 门 + 11 轮中位数）/ `diff_pretty_v1636.mjs`（pretty 槽位破案）/ `bench_scrub_v1636.mjs`。**契约零变化**：`stringify` 与冻结 `stringifyReplacer` 对任意载荷逐字节恒等（差分钉钉住）；错误分类、`Error: [E_CODE:retry]` 形态、响应键序、截断/预览/导出口径全不动。
- **下轮方向（排定）**：runOnPool 连接/查询路径（剖析头号 38.1%，池化与驱动往返）；resultContent 外层 JSON-RPC 信封二次 stringify 复核；导出链路 CSV 组装复核。剖析先行纪律不变：先毫秒级拆解 + 机制计数器归因，再选型实施。

### V1.6.35（两项微优化实证定盘：sanitizeSql 嵌套缓存键消命中路径拼接 + sqlite 预编译句柄缓存点查 −13.4%；基准对照组污染事故归因复核一并入档）

- **背景**：续「继续优化」轮。机制基准选型（`bench_optim2.mjs`）→ 实现 → 产品级 A/B 定盘。中途抓获一次**基准对照组污染**事故：备份目录 `backup-1635\` 被后续 `cp *.mjs` 覆盖成新代码，A/B 实为新树 vs 新树，「点查无收益」假阴性差点误判产品（聚合数字对不上账是破案线索）；改用同模块开关 A/B + prepare 计数器机制归因复测定盘（`bench_optim2d.mjs`）。
- **优化①（sanitizeSql 嵌套缓存键）**：v1.6.34 缓存键为 `dialect + mode + sql` 拼接串——命中一次就复制整个 SQL 并重算哈希（Map 以字符串为键的固有成本）；改嵌套 Map（dialect → mode → sql），命中路径零拼接。同脚本旋转等值副本对照（防 JIT 循环不变量外提）：小 ~100B **0.24→0.03µs（−87%）**、中 ~2KB **2.16→0.06µs（−97%）**、大 ~120KB **7.84→2.70µs（−66%）**。上限改按槽位计（32/方言/模式），`setSanitizeCache` 语义不变。
- **优化②（sqlite 预编译句柄缓存）**：`db.prepare` 每次全量编译；按连接缓存 StatementSync（WeakMap、64 条/库超限整清、`setSqliteStmtCache` 逃生阀与基准开关），`setReadBigInts(true)` 装入时设。**产品级同模块开关 A/B 定盘（7 轮交替中位数 + prepare 计数器归因）**：同 SQL 参数化点查 **23.13→20.03µs（−13.4%）**，7 轮区间无重叠（off 22.5–24.6 / on 19.1–21.9），prepare 20000/轮→0/轮；独特 SQL 无命中对照 23.26 vs 23.17µs（**0.4%＝噪音地板**，prepare 3000/轮不变，缺命中零劣化）。原始层分解：逐次编译全价 20.74 vs 缓存句柄 16.58µs（每次省 4.16µs，与产品层 3.1µs 同量级）。复用安全边界实测钉住：中途 break/throw 后 stmt 全量复位、真交错抛 "iterator was invalidated"（响亮不静默脏读）、产品全部同步单 tick 用完（流式早停是收尾丢弃非裸 break）。
- **回归钉（selftest +4）**：selftest **357→361（343→347）**——sanitizeSql 嵌套缓存键钉（命中同对象 / k-m 与方言槽不串 / 掩码与 keepLiterals 语义 / 等长不变量）+ setSanitizeCache 绕过与溢出整清恒等钉 + sqlite 句柄缓存钉 ×2（同 SQL 参数化重绑定 / 超安全整数 BigInt 保真 / 重名前置拒绝在缓存路径不放行 + 早停后全量再流式 / 64 上限轮转正确 / 逃生阀语义等价）。
- **实测口径（2026-10-06，Node v24.15.0）**：selftest 361/0（未初始化 347/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。微基准存档：`D:\work\Zcode\DB\_dist\bench_optim2.mjs`（机制对照）/ `bench_optim2d.mjs|.txt`（产品级开关 A/B + 原始层分解）/ `bench_optim2c.mjs`（prepare 计数器探针）。**基准纪律教训**：备份对照树须在全部修改完成后封存（本轮二次 `cp *.mjs` 污染对照组）；微基准对照一律同模块开关或旋转键防 JIT 常量折叠；结论只采信同脚本同会话侧并排。**契约零变化**：错误分类、`Error: [E_CODE:retry]` 形态、响应键序、脱敏/缓存对外语义全不动（缓存命中与否不改变任何返回值）。
- **不改项（经实测否决）**：A2 候选「stripStatementTail 惰性缓存 semiAt」收益在噪音内（公共路径尾巴仅 ~6 字符切片，`bench_optim2` A2 臂），不引入缓存复杂度；sqlite 重名列前置拒绝文案与行为不变（缓存路径逐字同拒，已入钉）。

### V1.6.34（真实对抗测试抓获四缺陷修复：WHERE 尾句注入静默错数 / 注释尾巴误判多语句 / MySQL 包裹重名列撞列 / LIKE 通配符冒充子串；sanitizeSql 记忆化缓存三档全尺寸反超旧树）

- **背景**：按「实际真实测试 → 修复 bug → 执行优化」闭环跑第二轮对抗实测（真 stdio → 三真实库 + 浏览器实测台），在官方套件之外的边角抓获 4 个产品缺陷，其中 1 个静默错数级（P1）；另有 1 项疑似缺陷经核为逐字钉住的契约，保持原样（见「不改项」）。
- **产品变更**：①**P1 WHERE 尾句注入 → 静默错数（最高危）**：`where` 片段携带顶层尾句（GROUP BY/ORDER BY/LIMIT/OFFSET/FETCH/UNION/INTERSECT/EXCEPT/WINDOW/PROCEDURE）会改变聚合语义——`count_rows` 对 2 行表返回 total=1 这类静默错数；现 `checkWhereFragment` 在括号深度 0 处显式拒绝 E_PARAM（报错点名违规关键字），括号内子查询照常放行，`x_limit`/`limitx` 等标识符边界与字符串字面量不误伤。②**注释尾巴误判多语句**：`SELECT 1; -- done` 曾被当多语句拒绝；现在分号后仅剩注释/空白不算多语句（`--` 尾注 MySQL 要求后随空白、`#` 仅 MySQL、块注释按方言；MySQL 版本注释等可执行注释尾仍算代码照拒，注释夹带第二语句仍拒）；新增 `semiAt` 记录首个可执行分号 + `stripStatementTail` 供 LIMIT 包裹剥尾巴，注释不得漏进包裹语句。③**MySQL LIMIT 包裹路径重名列撞列**：单列查询被包成派生表后同名列在 MySQL 报 ER_DUP_FIELDNAME——现剥尾巴后以裸语句重试一次，重名映射 `__N` 后缀保值（与 PG zipRows、sqlite 派生表 `x:1` 消歧口径一致），用户自有派生表重名则回落别名提示 E_PARAM；`sql_executed` 如实报告实际执行的语句。④**LIKE 通配符冒充子串**：`list_tables`/`find_tables_by_column` 的 name_like/column 名义「子串」实为 LIKE 模式，`%` 一发即误命中全部列——5 处 SQL 站点改字面子串匹配（sqlite `instr(lower…)`、mysql `INSTR(LOWER…)`、pg `strpos(lower…)`），无 ESCAPE 子句的方言差异问题。
- **优化（sanitizeSql 记忆化缓存）**：缺陷②的注释尾巴识别让 sanitizeSql 变为多遍扫描，为此加结果缓存（SQL ≤256KB 参与，Map 上限 32 条超限整清，`setSanitizeCache` 可关）——同脚本四臂对照（old 旧树 / nomemo 新树关缓存 / memo-hot 热缓存 / memo-cold 冷缓存，µs/call）：small ~100B 为 3.46 / 4.36 / 1.61 / 3.01，medium ~2KB 为 30.77 / 42.83 / 9.30 / 22.81，large ~120KB 为 1596.58 / 2386.40 / 152.55 / 941.68——冷缓存（每条键不同、零命中）三档仍全面优于旧树（−13% / −26% / −41%），热缓存 2~10 倍。契约零变化：错误分类、`Error: [E_CODE:retry]` 形态、响应键序全不动。
- **回归钉（selftest +7）**：selftest **350→357（336→343）**——WHERE 顶层子句关键字拒绝形态钉 + 括号子查询/标识符/字面量放行钉 + semiAt 记录与 stripStatementTail 各形态钉 + 注释尾巴放行/可执行注释尾仍拒/注释夹带仍拒钉 + enforceLimit 注释尾巴包裹钉 + findcol mysql INSTR 字面子串形状钉（pg 形状钉同步 ILIKE→strpos(lower…)）。
- **实测口径（2026-10-06，Node v24.15.0）**：selftest 357/0（未初始化 343/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0；另真库缺陷复验 26/26（`_dist/verify_fixes.mjs`：P1×6 / 注释尾巴×6 / 重名列×5 / 子串匹配×6 / 红线×3）+ 对抗电池翻转验证（W4-W9 由静默错数翻为显式拒绝、绕过形态仍拒）+ 浏览器实测台 25 步录制调用对新旧产品回放 25/25 语义一致（`_dist/browser-verify/replay_calls.mjs`）。探针与微基准存档：`D:\work\Zcode\DB\_dist\bench_guard.mjs|.txt` / `verify_fixes.mjs` / `backup-1634\`。
- **不改项（钉住的设计）**：header-only CSV 导入报 E_PARAM「CSV 无数据行」——导入校验的检查顺序与错误文案是逐字钉住的契约（server.mjs 导入校验注释钉），经复核保持原样。

### V1.6.33（pg 游标批量调参定盘 + 调试残留清除：PG_FETCH_BATCH 单一真源消静默截断 bug 类；TRACE 清除后 pg 导出墙钟 242→120ms、终峰 126.1→122.0MB；批量扫描 5 档定盘维持 1000）

- **背景**：按 V1.6.32 排队执行「pg 游标批量调参压 121.6MB 残峰」。残峰归因先行（`pgfetch_sweep_v1633` 同脚本同会话矩阵分解两个效应）：①当前树带 pg 逐批 ×2 / server 逐行 ×30000 共 5 处 TRACE 调试残留（上轮 pg 截断诊断会话遗留，不在 V1.6.32 实测态内）——30k 行导出打 30062 行 stderr，自身先吃掉 ~4MB 终峰与 ~120ms 墙钟；②pg 游标 FETCH 批量与退出阈值是两处各写 `1000` 的字面量，可单独漂移成「满首批即退出、超首批行静默丢弃」（FETCH 大于退出阈值方向的静默截断 bug 类）。
- **产品变更**：①**TRACE 调试残留全数清除**（pool.mjs 逐批 ×2、server.mjs 逐行 onRow / 截断行内 / 尾注）；②**`PG_FETCH_BATCH` 单一真源**——`FETCH FORWARD ${PG_FETCH_BATCH}` 与 `res.rows.length < PG_FETCH_BATCH` 共用常量，字面量漂移截断 bug 类源头消除。**批量调参定盘维持 1000**：250/500/1000/2000/5000 五档同脚本扫描 + 8 枪 tie-break（散度 ±3ms）——减批量是内存换墙钟的线性买卖（N=250 终峰 −2.7MB / 墙钟 +12.5ms，差值 ≈ 纯 FETCH 往返序列化 90 往返 × 0.14ms，网络 RTT 场景按往返数放大；N=500 −1.4MB/+4.5ms；N=2000 两平；N=5000 终峰 +5.3MB 且墙钟 +14ms 两头劣化），1000 为墙钟最优档。**契约零变化**：响应字段与键序、截断语义、错误分类、字节恒等全不动。
- **内存与耗时实测（`pgfetch_sweep_v1633`，30k 行 ~15.5MB CSV 真产品面 export_data，同脚本同会话 ×3 枪，判据 maxRSS）**：TRACE 残留清除效应（N=1000 对照）：pg 终峰 **126.1→122.0MB**、墙钟 **242→120ms**；mysql 墙钟 **216→81ms**、sqlite **227→89ms**（三驱动通杀 ~60% 墙钟，逐行 console.error 是耗时大头）；mysql/sqlite 终峰持平（101.3/103.3 → 101.5/102.1）。批量扫描（净变体，终峰中位 / 墙钟中位）：N=250 118.8MB/135ms、N=500 120.6/127、N=1000 121.8/120、N=2000 122.1/122、N=5000 127.3/135。字节恒等门：全变体 csv_md5 全同（18 轮 + tie-break 24 轮，30000 行 / bytes 15548017 / 公式中和 4243 恒等）、口令泄漏门 PASS。存档 `D:\work\Zcode\DB\_dist\pgfetch_sweep_v1633.mjs|.txt`。
- **回归钉（selftest +1 / pg-validate +3）**：selftest **349→350（335→336）**——PG_FETCH_BATCH 单一真源钉（FETCH 语句/游标退出阈值共用常量、无裸数字字面量、双引用齐全）；pg-validate **59→62**——批边界钉（fixture 从 pool.mjs 源读常量定尺寸、调参后自动跟随：2PB+1 行跨两整批+尾单行流式 CSV 与 JSON 物化逐字节恒等 + PB-1/PB/PB+1 三边界全量不丢不误截 + 源码形真源断言）。
- **实测口径（2026-10-06，Node v24.15.0）**：selftest 350/0（未初始化 336/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 62/0 · e2e 46/0 · protocol 24/0 · realform 43/0。
- **下一批排队**：pg 净态残峰剩余归因与流水线 FETCH 预取（净态 export_done pg 108 vs mysql 88，驱动行集驻留 ~18MB 未拆；预取让消费与取数重叠，或可兼得 N=250 的内存与 N=1000 的墙钟——动早停调度但不动契约）；export JSON 路径流式化经实测证伪（stringify 同步单遍 API 无 RSS 收益）不再重试，两遍合一仍属契约面变更——两者未经明确授权不实施。

### V1.6.32（query 侧行集流式：runQueryStream 三驱动逐行消费直喂 export 落盘链，e2e maxRSS 142.3→79.5MB（−44%）；30k 行导出字节恒等）

- **背景**：V1.6.31 消掉行串物化后，e2e 峰值剩余大头是驱动行集驻留——mysql2/pg 把 30k 行结果整体物化成 rows[]（30k 行实测 ~50MB@142MB 峰）再进格式化，两遍链里 rows[] 全程陪跑。
- **产品变更**：`pool.mjs` 新增 `runQueryStream(sourceId, sql, { onFields, onRow })`——mysql2 `query()` 事件流（fields/result/end）、pg 事务游标（BEGIN → `DECLARE qm_cur NO SCROLL CURSOR FOR` → `FETCH FORWARD 1000` 批量 → CLOSE → COMMIT）、sqlite `stmt.iterate()` 三分支逐行消费；onRow 返回 false 即早停（mysql/sqlite 干耗丢弃尾批，pg 真 CLOSE+COMMIT）；连接生命周期安全——mysql 流中断 destroy 不复用、正常收尾 release，pg 出错 ROLLBACK + release，三分支回调抛错均安全传导；`pgStreamable(sql)` 判定 pg 流式适用面（SELECT/WITH 及括号复合，真实 PG 17.5 验证括号复合/单式/包裹 LIMIT 全可游标消费 5/5；EXPLAIN/SHOW 回落物化链）。`server.mjs` 新增 `createCsvRowSink`（CSV 行接收器：惰性/急切表头、逐格公式中和 + 孤立代理哨兵旗/abort 双形态、字节账与 E_LIMIT 文案同 `eachCsvLine` 口径）与 `exportCsvStreaming`（CSV 导出单遍直通：驱动行流 → 行接收器 → 集束写 → 临时文件，`writeFileStreamAtomic` 支持异步 writeFn——返回 thenable 时消费完成才原子占位，同步面完成与报错语义逐字不变）；`streamCsvLines` 退化为 sink 薄包装（恒等钉真源非同义反复），文件名解析收敛 `resolveExportTarget` 供流式/物化两路共用。**契约零变化**：row_count/truncated/limit 截断语义（第 limit+1 行触发 truncated ≡ 旧 `rows.length > limit` 口径，包不包外层 LIMIT 两形皆等价）、E_LIMIT「组装期早停，未写盘」/E_PARAM「目标文件已存在」/fuse 文案、孤立代理哨兵回落语义（key 哨兵或内容哨兵命中即回落两遍物化链，回落是重查两遍——快照语义同旧两遍链）、响应字段与键序、JSON 导出路径不动；仅错误序在「目标文件已存在 + SQL 同时坏」共现时从 E_DB 先行变为 E_PARAM 先行（快速失败）。两遍合一（消 pass 1）属契约面变更，未经明确授权不实施。
- **微基准（`qstream_micro_v1632`，30k 行同脚本并排对照全部候选+基线）**：mysql 204→101MB、pg 231→159MB、sqlite 196→95MB，三库输出逐字节恒等，耗时无回退；形态定盘（mysql 事件流 / pg 游标批 1000 / sqlite iterate）——回调/数组汇聚层会吃掉收益，以产品形态实测为准。
- **内存与耗时实测（`exportmem_probe` 30k 行 ~15.5MB CSV，同脚本同会话 A/B ×3 枪，判据 maxRSS+duration，检查点 mark）**：export_done 峰值 **e2e 142.3→79.5MB（−44%）、e2e-mysql 145.5→88.1MB（−39%）、e2e-pg 143.7→108.1MB（−25%）**；final maxRSS e2e 157.2→94.4MB、mysql 160.5→101.6MB、pg 157.3→121.6MB；耗时持平或更快（e2e 93→91ms、mysql 117→80ms、pg 150→127ms）。字节恒等门：18 轮 csv_md5 全同、row_count 30000 / truncated false / 公式中和 4243 恒等、口令泄漏门 false。
- **回归钉（selftest +2 / mysql-validate +1 / pg-validate +3）**：selftest **347→349（333→335）**——createCsvRowSink 行接收器钉（增量喂入 vs 整链逐字节恒等 + eager/惰性表头 + 账面口径 + 哨兵旗/abort 中止 + E_LIMIT 零写盘 + 20 轮种子模糊）+ writeFileStreamAtomic 异步 writeFn 钉（thenable 延迟占位 + 失败清理 + EEXIST/overwrite 一致）；mysql-validate **36→37**（CSV 行集流式 vs JSON 物化再格式化逐字节恒等 + limit 截断边界）；pg-validate **56→59**（同行集恒等 + limit=2 截断/恰等不截断/SQL 自带 LIMIT 边界）。
- **实测口径（2026-10-06，Node v24.15.0）**：selftest 349/0（未初始化 335/0）· sqlite-validate 83/0 · mysql-validate 37/0 · pg-validate 59/0 · e2e 46/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。探针与微基准存档：`D:\work\Zcode\DB\_dist\exportmem_before_v1632.txt` / `exportmem_after_v1632.txt` / `qstream_micro_v1632.mjs|.txt` / `qstream_api_v1632.txt` / `pg_paren_check_v1632.mjs`。
- **下一批排队**：export JSON 路径流式化（当前 stringify 整物化）；pg 游标批量调参压 121.6MB 残峰；两遍合一（消 pass 1）仍属契约面变更，未经明确授权不实施。

### V1.6.31（export 行格式化零物化：融合计数/直写/scratch 三热路径消行串物化，e2e 97→91~94ms ≤95 达标；e2e maxRSS 162.9→142.3MB）

- **背景**：V1.6.30 归因修正后排队首位——两遍行格式化各带一次行串 join 物化与整行 UTF-8 二次扫描（30k 行同场微基准：计数遍 15-16.6ms、直写遍 18-24ms，其中 join+度量约占每遍 4ms、写盘形态再占 2-3ms）。
- **产品变更**：`measureCsv` / `exportToCsvBuffer`（pass 2）/ `streamCsvLines` 三处热路径改**融合内联零物化**——逐格 `csvCell` 直发计数/预铺缓冲/可复用 scratch（字节账 = Σ格字节 + 常量分隔符 + 2/行，与行串 byteLength 恒等），不再物化行串；scratch 路径以「UTF-8 字节数 ≤ 3×UTF-16 码元数」保守界免逐格 byteLength，超大格（>21845 码元）回精确核算、超 scratch 整格独立成块直喂（语义同旧超长行路径）；孤立代理哨兵改逐格判定（ANY_SURROGATE 预筛 → LONE_SURROGATE 精判；格间恒有 ","、代理对不跨碎片，逐格 ≡ 逐行判定，语义钉锁等价）；`eachCsvLine` 保留行串物化形态作字符串链真源（`exportToCsv` 回落/保真路径），三链差分钉因此非同义反复、逐字节恒等有判别力；`exportToCsvBuffer` 新增 `off === totalBytes` 内部一致性守卫（不一致抛 E_INTERNAL，防计量/直写漂移导致静默截断）。E_LIMIT/早停文案、响应字段、原子落盘语义零变化。
- **微基准形态留档（`format_micro_v1631` a/b/c/d 四轮，30k 行 ×3 枪）**：csvCellFast（公式首字符正则 → charCodeAt Set + includes 判特殊符）**反而更慢**，弃用（直写形 16.3-16.5 vs 14.7-15.1ms；V8 简单正则赢 includes 组合）；`isWellFormed()` 替代哨兵正则无差（0.3 vs 0.3-0.4ms），弃用；逐格哨兵带 ANY_SUR 预筛不劣化（13.8-15.2 vs 无预筛 14.1-15.3ms）；攒行 frags 数组 + onLine 回调形与 onFrag 回调 sink 形把收益吃光（M/N 15.8-19.6ms、S 15.8-18.4ms、T 22.1-22.8ms）→ 定盘**融合内联**（P 计数 14.1-14.6ms vs 现状 15.1-16.6ms；Q 直写 17-18ms vs 现状 18-24ms，同场对照）；跨脚本绝对值不作判据——早期「G 形计数 11ms」是会话漂移假象，同场对照还原真相（「归因先量机制」续篇：结论必须出自同时段对照）。
- **耗时实测（`exportmem_probe` 30k 行 ~15.5MB，同脚本同会话 A/B，after ×3 枪）**：measure 32→30ms；stream 段 37→36-40ms（持平）；new 两遍链 64→59ms；e2e **97→91 / 94 / 91ms（≤95 目标达成）**。
- **内存实测（同上）**：行串物化 churn 消除的红利——stream maxRSS 123.3→115MB（−8）、new 137.5→129MB（−8）、e2e **162.9→142.3MB（−20.6）**；legacy 字符串链不动（175MB，对照）。
- **字节恒等**：scrubbed 15,547,717 / new 15,549,817 / stream 15,547,717 / e2e 15,548,017 四线全恒等；公式中和 4,243 恒等；写调用 60 恒等。
- **回归钉（selftest +1）**：selftest **346→347（332→333）**——零物化组装差分钉（融合计数/直写/scratch vs 行串真源逐字节恒等 + 逐格哨兵 ≡ 逐行哨兵 + 早停 exact-1 边界与零 write 回调 + 恰等上限放行 + 40 轮种子模糊三链恒等；对抗行含孤立代理在格首/格尾、相邻格伪配对不误合并、合法代理对不误报哨兵、30000 码元超大格精确分支）；e2e/protocol/realform/sqlite/mysql/pg-validate 钉数不变。
- **实测口径（2026-10-05—06，Node v24.15.0）**：selftest 347/0（未初始化 333/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 56/0 · e2e 46/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。探针与微基准存档：`D:\work\Zcode\DB\_dist\exportmem_before_v1631.txt` / `exportmem_after_v1631.txt` / `format_micro_v1631*.mjs|.txt`。
- **下一批排队**：query 侧行集流式（e2e 142MB 峰值剩余大头是驱动行对象驻留，流式消费可再降 maxRSS 并省结果集物化耗时）；两遍合一（消 pass 1，牵动「组装期早停，未写盘」文案契约与哨兵时序——属契约面变更，未经明确授权不实施）。

### V1.6.30（export 落盘集束写：createBatchWriter 把 1856 次 WriteFile 收成 60 次，e2e 导出耗时 −4~5ms；耗时归因修正）

- **背景**：V1.6.29 流式写盘带出 +9ms 耗时差（当时归因「write 系统调用数增加」，排队集束写回收）。本轮按队列实施：streamCsvLines 的 emit 碎片此前逐片 `fs.writeSync` 落盘，30k 行真负载 15.5MB 产出被切成 **1856 片**（均片 ~8KB），逐片落盘放大 WriteFile 次数。
- **产品变更**：新增纯函数 `createBatchWriter(write, batchBytes = 262144)`——`push(b)` 同步消费碎片（拷入复用批缓冲；碎片若是短命视图——streamCsvLines 的 scratch 视图——该契约必须成立），批满经 `write(批视图)` 落出，`flush()` 吐尾批；超大碎片（≥ batchBytes）先冲刷现批再**零拷贝整块直写**（写回调收到同一缓冲对象，自测钉住）。`doExportData` 流式写块接线（`fs.writeSync(fd, b)` 外套集束器）；`streamCsvLines` 与其写契约零改动，`writeFileStreamAtomic` 原子占位、早停文案「组装期早停，未写盘」、`bytes`/`formula_cells_neutralized` 等响应字段、`Error: [E_CODE:retry]` 分类全部零触碰。
- **耗时实测（同脚本同负载 A/B，`_dist/exportmem_probe.mjs`，before/after 各 2 轮）**：写调用 **1856 → 60 次（−31×）**；e2e 产品路径导出 duration **101/104 → 97/99ms（−4~5ms）**；流式链（pass2+清洗+写）41 → 36/39ms；maxRSS 全平（stream 122.4/122.5、e2e 163.1/163.3）；清洗后字节恒等 15,547,717、rpc `bytes` 15,548,017 不变。
- **归因修正（形态留档，判语更正）**：V1.6.29 条目「+9ms 源于 write 系统调用数」实测**只对了 ~2ms**（1856 次 WriteFile ≈ 1.1µs/次）。链计时补测（`_dist/exportmem_v1630_chain_timing.txt`，同脚本）：缓冲链（exportToCsvBuffer 两遍 + scrubBuffer + writeFileSync）**63/63ms**，流式链（streamCsvLines pass2 + 清洗 + 写）**36-38ms**——流式链本身已快 ~25ms，e2e 全链耗时主导项是**两遍行格式化**（每遍 ~25ms）；跨会话 e2e 绝对值（93/94 vs 97/99）不作判据，只认同脚本同会话 A/B。教训：给耗时差归因先量机制（write_calls 计数器），别把整段差值记到单一机制头上。
- **回归钉（selftest +1）**：selftest **345→346（331→332）**——createBatchWriter 集束写钉（批边界 ±1/微片/超大碎片 400 片随机 × 2 批型逐字节恒等 + 超大碎片零拷贝同对象直写 + flush 尾批幂等与续写 + 写调用收数上界）；e2e/protocol/realform/sqlite/mysql/pg-validate 钉数不变。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 346/0（未初始化 332/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 56/0 · e2e 46/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。
- **下一批排队**：零物化行格式化（csvCell 直写 scratch，消行串物化与二次 UTF-8 编码——两遍行格式化是耗时主导，最高收益候选）；query 侧行集流式（rows[] 物化是剩余内存大户，独立归因）。

### V1.6.29（export 整链流式写盘：|k|−1 尾随暂存逐 key 流式 scrub 直写 fd，30k 行产品链峰值 RSS 177.5→162.3MB）

- **背景**：V1.6.28 留档的下一候选「export 整链流式写盘」本轮实施。另有一项工具链发现：`mcp_alltools_test.mjs` 启动时 `fs.rmSync(_dist/mcp-test)` 整目录清理（fixture 卫生，行为保留）会连带删掉存在那里的探针脚本与存档——V1.6.27/V1.6.28 的探针产物均已因此遗失（含上一条目引用的 `_dist/mcp-test/exportmem_after_v1628.txt`；历史条目不改写，损失在此记档）。自本轮起探针脚本与存档一律放 `_dist/` 根；同负载 before 存档 `_dist/exportmem_before_v1629.txt` 复测重建了对照链数据（legacy 175.1/175.5、缓冲链 137.5/137.3、e2e 177.7/177.5，与 V1.6.28 条目记载一致）。
- **产品变更（流式写盘）**：新增 `createScrubPipeline(list)`（流式清洗管线：每 key 一级、尾部 < |k| 字节暂存待定区，跨块边界/跨 UTF-8 多字节序列/跨替换边界匹配不丢，贪心次序与整段扫描一致）、`measureCsv`（pass 1 计量+孤立代理哨兵，抽自 exportToCsvBuffer 单一真相源）、`streamCsvLines(write,…)`（pass 2 逐行格式化 → 管线 → write 回调，返回实写清洗后字节数 = 旧 `scrubbed.length` 口径）、`writeFileStreamAtomic`（流式原子落盘：临时文件 fd 直写 + rename/link 原子占位，失败清理与 EEXIST 显式拒绝同 writeFileAtomic）。`doExportData` CSV 快乐路径改流式直写，`scrubbed` 全量缓冲不再物化（JSON 路径与孤立代理哨兵回落字符串链逐字不变）。**契约兼容**：CSV 文件逐字节不变、`bytes`/`formula_cells_neutralized` 等响应字段逐字不变、早停文案「组装期早停，未写盘」如实（pass 1 先于任何写盘）、文件名/存在性错误序不变、`Error: [E_CODE:retry]` 分类零触碰。
- **形态留档（首版失败，二版返工）**：首版管线用整块 concat 衔接（每级 `Buffer.concat([tail,chunk])` + 输出/汇点再 concat），30k 行实测**反胜为负**——流式链 maxRSS 145.6/145.9 vs 缓冲链 137.1-137.5、真 RPC 产品路径 201.4/200.7 vs 177.5/177.7、耗时 93→122ms：~120MB 临时 concat 分配抖动（GC 压力）压过省下的 15.5MB 驻留。二版改**碎片原生零拷贝**（未匹配间隙直出输入缓冲视图、尾部暂存 ≤|k|-1 字节小拷贝、`streamCsvLines` 可复用 scratch 整块回收）才真实见效；失败数据留档 `_dist/exportmem_after_v1629_v1_concat.txt` 作反面基准。教训：流式化的收益会被分配形态瞬间吃掉，判据必须落在 maxRSS 实测而非「理论上少一份缓冲」。
- **内存实测（同负载 A/B，`_dist/exportmem_probe.mjs` 四模式 ×2 轮，判据 maxRSS）**：30k 行 15.5MB CSV——纯组装+清洗链 **137.1-137.5 → 122.4/122.6MB（−11%）**；真 RPC 产品路径（e2e 模式 sqlite → `export_data` 落盘）**177.5/177.7 → 162.3/162.8MB（−8.5%）**，external 17.2→2.4MB（15.5MB 内容缓冲驻留消除）。清洗后字节三链逐字节一致（15,547,717），rpc `bytes` 15,548,017 与 V1.6.28 逐字不变。耗时 93/94→102/103ms（+9ms：逐片写盘系统调用次数增加，writev 集束写留档后续回收）。
- **回归钉（selftest +2 差分钉）**：selftest **343→345（329→331）**——createScrubPipeline 切分不变性钉（12 组对抗输入 × 10 种字节切分 × 返回/emit 双形态与 scrubWith 逐字节恒等，含单字节 key、短 key、跨行边界 key、flush 尾部语义、退化键直通）+ measureCsv/streamCsvLines 整链恒等钉（流式/Buffer/字符串三链差分 + 早停零写盘文案 + 恰等上限放行 + 哨兵口径一致 + 40 轮种子模糊 + writeFileStreamAtomic 原子占位/覆盖/失败清理语义）；e2e-validate 钉数不变 46（export 落盘清洗接线钉继续护住产品路径落盘内容与 bytes 一致）；protocol/realform/sqlite/mysql/pg-validate 钉数不变。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 345/0（未初始化 331/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 56/0 · e2e 46/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。
- **下一批排队**：writev 集束写（把逐片 writeSync 收成每批一次系统调用，回收 +9ms 耗时差）；零物化行格式化（csvCell 直写 scratch，消行串分配抖动，pass 1/2 同用）；query 侧行集流式（大结果集 rows[] 物化与响应拼装分块化，V1.6.28 留档顺延）。

### V1.6.28（export CSV 组装直出 Buffer：两遍精确预铺消内容串驻留，30k 行导出链峰值 RSS 175→137MB）

- **背景**：V1.6.27 把落盘清洗改为字节域就地压缩后，export 链的残余峰值来自 CSV 组装形态本身——`exportToCsv` 的 `lines[]` 行数组 + `join` 产物两份整表字符串同驻堆上（30k 行 15.5MB CSV：内容串以 UTF-16 驻留 ~31MB + 行数组 ~16MB），随后才转 Buffer 清洗；探针检查点实测 content_ready 阶段 heap 68.9MB、全链峰值 maxRSS 175MB（`_dist/mcp-test/exportmem_after_v1628.txt` legacy 模式）。
- **产品变更（CSV 组装）**：新增共享行发射器 `eachCsvLine`（组装单真相源：逐行格式化 + 逐行字节累计 + maxBytes 早停，早停文案与抛出时机同 v1.5.1 逐字不变）；`exportToCsvBuffer` 两遍精确预铺——pass 1 只计量行字节并打孤立代理哨兵，pass 2 逐行 `buf.write` 直入 `Buffer.allocUnsafe(totalBytes)`、行串即时丢弃，全程不物化整表内容串；`exportToCsv` 字符串版保留为保真真源（回落路径）。逐字节恒等由构造保证（共用发射器）+ 差分钉锁定。**契约兼容**：CSV 输出逐字节不变（CRLF 尾行、公式中和计数、早停边界语义全保留），`formula_cells_neutralized`/`bytes`/`row_count` 等响应字段逐字不变，`Error: [E_CODE:retry]` 分类零触碰。
- **产品变更（scrub 接线）**：从 `scrubToBuffer` 抽出 `scrubBuffer(buf, list)`（字节域入口）；`scrubToBuffer` 退化为字符串薄包装（孤立代理门控 + 转字节 + 委托），对外行为逐字节不变。`doExportData` CSV 分支改走 `exportToCsvBuffer → scrubBuffer`；**孤立代理哨兵**（行内容含孤立代理项，或 SECRET_LIST 键含孤立代理项）触发时回落旧字符串链（`exportToCsv → scrubToBuffer`）——孤立代理物化成字节后与字面 U+FFFD 不可分、字节域口令匹配可能与字符串域分叉，回落保证与旧版逐字节恒等（该形态导出多一趟组装，代价可接受且极罕见）。JSON 分支无逐行结构维持字符串链。凭据清洗契约（scrub/scrubWith/scrubToBuffer/scrubBuffer 对合法输入字节恒等）不变。
- **内存实测（同负载 A/B 对照，`_dist/mcp-test/exportmem_probe.mjs` 三模式 ×2 轮，判据 maxRSS）**：30k 行 15.5MB CSV 全链（组装→清洗→落盘）峰值 maxRSS **175.1/175.8 → 137.1/137.4MB（−22%）**；content_ready 阶段 heap **68.9→43.7MB**（两份整表字符串驻留消除）；清洗后字节两链逐字节一致（15,547,717 = 15,547,717，15.5MB 真实负载上的恒等实证）。真 RPC 产品路径（e2e 模式：30k 行 sqlite → `export_data`）maxRSS 177.3/177.5、`bytes` 与落盘一致、公式中和 4243。注：v1.6.27 原探针脚本与存档本轮发现遗失，legacy 模式为同口径重建（形态一致、绝对值低 ~15MB，原负载行物化更重），故判据取同负载 A/B 对照而非跨探针绝对值。
- **回归钉（selftest +2 差分钉）**：selftest **341→343（327→329）**——exportToCsvBuffer 与字符串组装逐字节恒等钉（对抗行集 + scrub 接线恒等 + 恰等/少 1 字节早停边界 + 60 轮种子模糊含字面 U+FFFD）+ 孤立代理哨兵语义钉（saw_lone_surrogate 置位、合法代理对不误报、回落链恒等、scrubBuffer 直调恒等与退化键跳过）；e2e-validate 钉数不变 46（既有 export 落盘清洗接线钉已覆盖新组装器接线）；protocol/realform/sqlite/mysql/pg-validate 钉数不变。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 343/0（未初始化 329/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 56/0 · e2e 46/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。
- **下一批排队（V1.6.27 留档项顺延）**：query 侧行集流式（大结果集 rows[] 物化与响应拼装分块化）；export 整链流式写盘（带 |k|−1 尾随暂存的逐 key 流式 scrub 写 fd，V1.6.25 留档项，再触碰凭据清洗契约故继续分车）。

### V1.6.27（export 落盘清洗流式化：scrubToBuffer 原地压实替换，30k 行导出峰值 RSS 204→190MB；修复 enumArg 类型混淆绕过）

- **背景**：两件事同车。① V1.6.25 留档的 export 侧 scrub 峰值问题（18.5MB CSV 全链堆峰 113.2MB/RSS 251.5MB）按排期在本轮处置；② 本轮对抗探针（`_dist/mcp-test/bugprobe_v1626.mjs`）在 V1.6.26 的 `enumArg` 上抓到类型混淆 bug——`format: ["json"]` 被 `String(["json"]) === "json"` 静默强转命中、绕过校验照常执行，与「只接受字符串」的声明语义不符（数组/布尔/数字/包装对象均可绕过）。
- **产品变更（bug 修复，参数校验）**：`enumArg` 命中判定收紧为仅字符串参与匹配（`typeof v === "string"` 门），任何非字符串一律 `E_PARAM` 拒绝并列出允许值。合法字符串取值行为逐字节不变；此修复只影响本就应被拒绝的类型混淆输入（V1.6.26 声称拒绝、实际漏拒的面），契约零破坏。
- **产品变更（export 落盘清洗流式化）**：新增 `scrubToBuffer(text, list)` 与内联压实步 `scrubPassInPlace`（server.mjs 纯函数）：逐 key 在 UTF-8 字节域把口令替换为 `***`，同一块 Buffer 上**原地压实**（`***` 恒 3 字节，key ≥3 字节时输出指针永不越过读指针，全程零额外分配；|key|<3 的罕见形态回落片段拼接）。`doExportData` 落盘链改为内容直出 Buffer、计量与写盘只经 Buffer（`content` 提前释放，消除字符串+Buffer 双份常驻）。**清洗契约逐字节不变**：与 `Buffer.from(scrubWith(t, list), "utf8")` 逐字节恒等——对抗矩阵（key 重叠/自重叠/跨替换边界/替换串本身是 key/多字节与代理对/user:pass 变体）+ 种子模糊差分 0 不一致，孤立代理项输入（UTF-8 编码替换成 U+FFFD 会致字节域匹配分叉）自动回落旧字符串链保证退化输入也恒等；明确偏离钉在自测：空 key/非字符串 key 跳过（SECRET_LIST 不会产生）。**形态留档**：初版「输入+输出双缓冲」把堆省下的又还给外部内存（RSS 204→208，无收益），改原地压实才真实见效；与 V1.6.25 留档的「|k|−1 尾随暂存分块」设计不同——原地压实同等有界且更易证恒等，整链分块组装（再消 content 串驻留）留待后续车。before/after 同口径探针留档 `_dist/mcp-test/exportmem_{before,after}_v1627.txt`。
- **内存实测（30k 行/15.8MB CSV，口令命中 30k 次，同机同日 before/after 各 2 轮）**：scrub 链阶段峰值（stages 口径）**maxRSS 204→190MB（−7%）**、写盘后堆 57.6→42.6MB；端到端真实链路（handleRpc `export_data`）**maxRSS 189→186MB**，耗时 102→96ms 无回归。剩余峰值大头是查询结果行集与 CSV 组装（30k 行 rows ~28MB + 内容串），受 20MB 导出上限封顶、非无界；行集流式/分块组装是独立后续车。
- **回归钉（selftest +2 差分钉；e2e +1 接线钉）**：selftest **339→341（325→327）**——scrubToBuffer/scrubWith 逐字节恒等钉（11 组对抗矩阵 + 200 轮种子模糊）+ 孤立代理回落与退化键跳过语义钉；e2e-validate **45→46**——export 落盘清洗接线钉（临时配置注入口令源，导出文件必须已替换且 `bytes` 与落盘字节一致，防「scrubToBuffer 存在但处理器漏接」漂移）；protocol/realform/sqlite/mysql/pg-validate 钉数不变。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 341/0（未初始化 327/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 56/0 · e2e 46/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0；对抗冒烟 19 组 + 2000 轮模糊差分 0 不一致。
- **下一批排队**：export 整链分块组装流式（消内容串驻留，30k 行峰值再降一档）；query 侧行集流式（rows 是剩余大户，独立归因）。

### V1.6.26（format 枚举参数校验收口：非法 format 显式 E_PARAM，不再静默兜底成默认格式）

- **背景**：全工具面实测探针（`_dist/mcp-test/opt_probe.mjs`，2026-10-05）发现两处枚举参数「静默兜底」：`query_plan` 传 `format:"xml"` 不报错、静默返回 `plan_format:"text"`；`export_data` 传 `format:"xml"` 静默导出 CSV。inputSchema 早已声明 `enum`，但服务端未校验——调用方以为拿到了 xml 却得到另一种格式且毫无提示，与 v1.0.2 修掉的「limit 静默夹断」同一类误导。同类探针已证伪的候选项一并留档：`query` 自动 LIMIT 包裹（`_za_mcp_limit` 派生表）**不丢 ORDER BY**（真实 MySQL 4,3,2,1 / 真实 PG 3,2,1 实测保序，`_dist/mcp-test/order_probe2.mjs`），无需改动。
- **产品变更（参数校验）**：新增纯函数 `enumArg(v, name, allowed, dflt)`（与 `intArg` 同设计哲学）：缺失（undefined/null/""）→ 默认值；命中允许值（去首尾空白、大小写不敏感）→ 归一小写；其它 → `Error: [E_PARAM:no-retry] Invalid 'format': … is not one of […].`（列出允许值）。接入 `query_plan.format`（text|json）与 `export_data.format`（csv|json）两个枚举面。**契约兼容**：合法取值行为逐字节不变（`"text"`/`"json"`/`"csv"`/缺省路径同旧）；仅非法取值从「静默兜底」收紧为显式报错（inputSchema 本就禁止该值，合规客户端零影响），并新增宽容归一——`"JSON"`/`" Text "` 旧版被当另一格式兜底、现正确命中。**不变项**：超时分类、幂等语义、写权限门禁、日志脱敏（scrub）、安全红线、`Error: [E_CODE:retry]` 错误契约均零触碰。一处可观测序变化：`query_plan` 同时传坏 format 与坏 SQL 时先报 format 参数错（参数校验先于语句校验；守卫拦截纵深不变）。sqlite 的 `format:"json"` 仍返回 `EXPLAIN QUERY PLAN` 文本树（`plan_format` 如实标注，方言无 FORMAT 选项，语义同旧）。
- **回归钉（selftest +3：拒绝语义/归一+缺省/合法值恒等；e2e +3：真 stdio 接线级）**：selftest **336→339（322→325）**；e2e-validate **42→45**（`query_plan` 拦非法 format、`export_data` 拦非法 format、`JSON` 大小写归一接线钉——防「enumArg 存在但处理器漏接」漂移）；protocol/realform/sqlite/mysql/pg-validate 钉数不变。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 339/0（未初始化 325/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 56/0 · e2e 45/0 · protocol 24/0 · realform 43/0；真库 RPC 探针 8/8（`_dist/mcp-test/enum_probe.mjs`：xml→E_PARAM 且导出零副作用、JSON→json、text/缺省恒等、参数错先于语句错）。
- **下一批排队（V1.6.25 留档项顺延）**：export 侧 scrub 逐 key 流式化（18.5MB 导出峰值 113.2MB→目标有界；触碰凭据清洗契约，需独立回归归因，另行排期）。

### V1.6.25（import 解析内存峰值收口：parseCsv 构建重写消 cons-rope 病理 + 流式 CSV 分段解析，18MB 导入峰值 574→41MB）

- **背景**：V1.6.24 把大导入同步块切到阶段粒度后，残余最大同步块是 `parseCsv` 整文件解析；探针实测发现比预估更糟的病理——旧版 `field += c` 逐字符拼接产生 per-char cons rope（~32B/字符 rope 节点）：18MB CSV 解析驻留 **574.7MB heap（~31× 文件）**、RSS 734MB，且 rope 构建拖累解析本身（270ms）。doImportData 另有 readFileSync 整文件 + rows 2D 数组 + valueRows 三份驻留；export 侧同样整缓冲。
- **探针实测（先实测后断言，`_dist/probe_streammem_{before_v1624,after_v1625}.txt`）**：18MB（万行）夹具峰值 heap **574.7→41MB（14×↓）**、retained 574.1→27.9MB（20×↓）、RSS **734.5→102.4MB（7×↓）**、解析耗时 **270→103ms（2.6×）**；2MB（千行）夹具峰值 65.4→13.2MB。流式化后解析按段让出，取消插队延迟 p50 **17→1.6ms**、max **68→10ms**（10 样本，atomic 8MB 中途取消：0 行落库 + 连接健康 + 不回响应全成立，`_dist/probe_cancella2_after_v1625.txt`）。
- **产品变更（import 解析）**：`parseCsv` 构建重写为「原样 run 切片 + 合成片段 join」（引号开/闭与 `""` 转义是 run 断点）——**语义逐字不变**（20 万随机对抗样本差分 0 不一致 + 既有 CRLF/引号/尾空行/`\N` 保真钉全绿）；新增导出纯步进器 `createCsvSegmenter`（引号态跨块延续、尾部前瞻依赖字符暂缓、空记录跟随后段防尾 pop 误伤）与 `readCsvForImport`（fd 256KB 流式读 + StringDecoder 多字节安全 + BOM 剥除 + 段间 `yieldEventLoop`）——`concat(parseCsv(seg_i)) == parseCsv(whole)` 全偏移 + 随机多切分等价钉锁定。**错误契约逐字不变**：「CSV 为空。」「CSV 首行（表头）为空。」「CSV 表头列名重复…」「CSV 表头含非法列名…」「CSV 无数据行。」行宽/超限文案原样；错误优先级保持旧可观测序（解析期错误先于 splitIdent，行宽错误仍**在 splitIdent 后**抛、超限仍优先于行宽）。`Error: [E_CODE:retry]` 分类、maxAffectedRows 预检、安全红线零变化。
- **性能（万行导入 duration_ms 中位，before/after 同机同日，`_dist/bench_streammem_{before_v1624,after_v1625}.json` 含 atomic 变体）**：吞吐零回归——非 atomic mysql 152→153、pg 29→28、sqlite 59→63（噪声带内，mysql after 1 轮 291ms 为负载噪声）；atomic mysql **143→114**、pg 26→27、sqlite 20→18。
- **产品变更（DBeaver 导入 .dbp 参数简写，同发并行工作线）**：`resolveDbpArg`（`dbeaver-parse.mjs` 纯函数，目录遍历/文件判定注入式）支持三种写法——完整/相对路径（相对先 cwd 再脚本目录回退）、同级目录裸文件名（cwd 找不到回退脚本目录）、通配符 `*.dbp`/`保险-*.dbp`（`*`/`?`，大小写不敏感，目录段可带路径；cmd 引号内通配符不展开、由解析器处理，故 `node install.mjs "*.dbp"` 可用）；`install.mjs` 与 `import-dbeaver.mjs` 同语义共用。零匹配 `no-match`、多匹配 `ambiguous`（列候选）一律显式拒绝——不静默挑一个，与 `--force` 防误覆盖同一条安全口径。
- **回归钉（selftest +6：解析层 3 + .dbp 简写 3）**：parseCsv 构建重写边界钉（引号中途开闭/纯空引号/连续转义/未闭引号收尾）+ csvSegmenter 全偏移单点切分等价 + 随机多切分等价（1-5 字符碎片 2000 组，种子 20261005）+ .dbp 参数解析钉（完整路径/裸名回退/通配符/大小写）+ 拒绝语义钉（零匹配/多匹配/大小写歧义列候选不猜）+ 接线钉（install.mjs 与 import-dbeaver.mjs 均经 resolveDbpArg，防改名漂移；注入式 fixture 不触盘）——selftest **330→336（316→322）**；e2e/protocol/realform/sqlite/mysql/pg-validate 钉数不变（纯解析层 + 初始化 CLI 收口）。
- **export 侧实测定案（排入 V1.6.26）**：18.5MB CSV 全链（组装→scrub→Buffer→原子写）峰值 heap **113.2MB / RSS 251.5MB（~6×）**，受 20MB 导出上限封顶、非无界病理；scrub 逐 key 流式化（|k|−1 尾随暂存）可证逐字节恒等但触碰凭据清洗契约，与本轮 parseCsv 重写分车防回归归因混淆（`_dist/probe_exportmem_before_v1625.txt`）。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 336/0（未初始化 322/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 56/0 · e2e 42/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。

### V1.6.24（COPY 分块发送让出事件循环 + 长导入取消收口：取消传导进 COPY 传输，atomic 随回滚归零）

- **背景**：V1.6.23 事务内 COPY 上线后，`PgCopyInQuery.handleCopyInResponse` 对大 payload（万行级 ~MB）一个同步循环发完全部 64KB 块（8MB ≈128 块），短暂阻塞事件循环；更实质的缺口在取消侧——MCP 取消（v1.6.12 `notifications/cancelled`）此前只释放「等待与响应」，COPY 传输期无让出、取消不传导进工作侧：探针实测中途取消后 10000 行照常落库（「不回滚、不中断」旧边界）。
- **探针实测（先实测后断言，before/after 三组观测；输出入仓 `_dist/probe_copyyield_after_v1624.txt`）**：
  - **A1 并发 ping 画像（8MB 非事务导入）**：导入 442→413ms；48-49 个并发 `count_rows` 全部排到导入结束成批放行（p50 51ms 不变、max 423→409ms）——实证 v1.1.0 串行派发队列是并发调用排队的根因（按到达顺序串行是设计语义，本轮不动）；同步阻塞的真实受害者是**取消快扫插队与定时器**。
  - **A2 取消通知处理延迟（导入中 7 个偏移点插队，量 stderr 出现时刻）**：max **109→68ms**，早段偏移 30ms 点 109→68、70ms 点 86→37——发送分块 + 阶段让出后取消插队窗口变窄，残余峰值由 parseCsv 最大同步块决定（流式解析另立方向）。
  - **B 取消语义（atomic 8MB 导入 +100ms 中途 notifications/cancelled）**：**落库 10000→0 行**（COPY 传输中断 + 事务整体回滚）；被取消请求不回响应（MCP 规范「Not send a response」如实保持）；连接健康（后续查询正常）。
- **产品变更（pg COPY + import）**：`PgCopyInQuery` 改异步泵送 `_pump`——64KB 块间 `setImmediate` 让出（pg `sendCopyFromChunk` 无背压返回值，纯让出、不臆造 drain/flush 语义）；第三参 signal（AbortSignal）取消传导：未发完补 copyFail、done 仍只 settle 一次（`_sentDone`/`_copyClosed` 防双发、`_sawCopyIn` 保证只在服务端 copy-in 态补 fail、CopyInResponse 迟到时兜底补 fail 防连接滞留）——**协议生命周期契约逐字不变**。`signal` 沿 handleRpc→callTool→doImportData→runCopyIn/withTransaction copyIn opts 传导；`doImportData` 读盘/解析/值变换阶段间让出；非 atomic 路径批前/批后/逐行回退三处 `signal?.aborted` 检查——取消中止如实回报「导入已被客户端取消（…此前 N 行已写入）」，**取消优先于 isAmbiguousWriteError 分类、绝不回退逐行重试**；atomic 模式取消→异常→ROLLBACK，「原子导入失败，已全部回滚（未写入任何行）」文案逐字不变。`Error: [E_CODE:retry]` 分类、maxAffectedRows 预检、安全红线零变化。
- **取消语义显式化**：v1.6.12 边界注释如实收口——取消现在**尽力中断 import_data 的 COPY 传输**（atomic 随回滚整体归零、非 atomic 停批界并如实回报已写入行数）；COPY 之外的在执行驱动查询仍不中断（各驱动既有超时上界约束）；串行派发队列语义不变。
- **性能（万行导入 duration_ms 中位，before/after 同机同日）**：吞吐零回归——非 atomic real_pg 27→26ms、real_mysql 236→219ms、real_sqlite 87→87ms；atomic real_pg 26→27ms、real_mysql 144→184ms、real_sqlite 21→21ms（均在机器噪声带内）。10k 行仅 ~10 次块间让出，开销测不出。基准 before/after 入仓 `_dist/bench_copyyield_{before_v1623,after_v1624}.json`（含 atomic 变体，after 盖版本戳 1.6.24）。
- **回归钉（pg-validate +1）**：「import 取消传导：atomic 长导入中途 notifications/cancelled → 不回响应（MCP 规范）+ 0 行落库（COPY 中断随整体回滚）+ 连接健康」——pg 55→**56**，探针表 `pg_probe_cancel` 自建自删（前后 DROP + finally 兜底清单，8MB CSV 夹具随套件临时目录清理）；既有「import: atomic 冲突整体回滚（5 行不变）」与「事务内 COPY 特殊字符逐字节保真 + 失败整体回滚」钉继续全绿；selftest 断言数不变 **330/316**（纯函数零变更）。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 330/0（未初始化 316/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 56/0 · e2e 42/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。

### V1.6.23（import_data PG atomic（事务）路径改 COPY FROM STDIN：事务内 COPY 提速 + 契约逐字不变）

- **背景**：V1.6.21 把 postgres 非事务批路径改成 COPY FROM STDIN（万行 65→28ms）后，atomic（全文件单事务）路径仍走参数化批 INSERT——同一导入引擎两条路径 2×+ 性能差；事务内 COPY 天然原子（批失败随 ROLLBACK 整体消失），与批 INSERT 的事务语义逐字一致，是同族收口的最后一段。
- **产品变更（import atomic）**：`withTransaction` 回调扩第二参 `copyIn(sql, payload)`——pg 分支把 `PgCopyInQuery`（与 runCopyIn 同一封包）钉在事务连接上，BATCH 循环内 `useCopy → copyIn`、否则照旧参数化批 INSERT；mysql/sqlite 传抛错占位（走参数化 INSERT，行为零变化）。**契约逐字不变**：失败文案「原子导入失败，已全部回滚（未写入任何行）」、isAmbiguousWriteError 分类不变（atomic 模式本就不咨询，任一失败→回滚→E_DB 包装）、`Error: [E_CODE:retry]` 分类不破坏；COPY FROM STDIN 为客户端流式灌入、**无需服务端文件读取权限**（权限语义不变）；超时仍由池级 query_timeout 兜底。
- **探针实测（先实测后断言，8 项观测）**：事务内 COPY 成功 8 行 + 特殊字符逐字节往返（引号双写/反斜杠/LF/CRLF/制表/字面量 `\N` 不成 NULL/空串不成 NULL）+ 文件内 PK 冲突失败——错误文案逐字「原子导入失败，已全部回滚（未写入任何行）: …」、E_DB 分类完好、失败后计数 8 不动（整体回滚实证）。
- **性能（万行 atomic 单事务，duration_ms 中位）**：real_pg **62→27ms（2.3×）**（逐轮 [66,62,62] vs [29,27,27]）；real_mysql 117→176ms、real_sqlite 17→20ms——路径未动，先后两轮机器负载噪声波动（V1.6.21 同类现象），仅作参考。基准扩 `DBMCP_BENCH_ATOMIC=1` atomic 轮次（结果带 mode 字段），before/after 入仓 `_dist/bench_atomic_*.json`（after 为版本 1.6.23 复跑）。
- **回归钉（pg-validate +1）**：「import atomic: 事务内 COPY 特殊字符逐字节保真（引号/反斜杠/LF/CRLF/制表/字面量 `\N`/空串）+ 失败整体回滚（E_DB 文案逐字、7 行不变）」——pg 54→**55**，探针表 `pg_probe_txc` 自建自删（前后 DROP + finally 兜底清单）；既有「import: atomic 冲突整体回滚（5 行不变）」钉在 COPY-in-tx 下继续全绿；selftest 断言数不变 **330/316**（纯函数零变更、接线层收口）。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 330/0（未初始化 316/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 55/0 · e2e 42/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。

### V1.6.22（空表（0 行）histogram/stats 边界锚定收尾：产品零变更）

- **背景**：V1.6.21 边界锚定收口「全 NULL 列」与「单行列」后，同族最后一类真实边界——空表（0 行域）——探针已实测但注释明确标注「留待后续轮锚定」，回归钉缺位。0 行域 MIN/MAX=NULL 与全 NULL 列同走 NULL-rng 兜底路径，预期行为一致，但此前从未有真实回归钉盯住。
- **探针复跑（先实测后断言，12 项观测三库逐一对照）**：0 行表 × 数值/文本列 × histogram+top_values / 仅 stats 三种调用形态——histogram `[]`、top_values `[]`、row_count=0 / non_null=0 / distinct_values=0、min/max/avg=NULL，三库逐项一致：不崩、不脏桶、不除零。未抓获产品缺陷（v1.6.20 兜底路径恰好覆盖），产品代码零变更。
- **回归钉（三套件各 +1 同名钉）**：「histogram/stats 空表锚定: 0 行表空数组收口（row_count=0、min/max/avg=NULL 不除零）+ top_values 空数组」——sqlite 82→**83**、mysql 35→**36**、pg 53→**54**；探针表自建自删（mysql 整库 DROP 覆盖、pg 前后双保险 DROP + finally 兜底清单、sqlite 随 tmp 目录清理）。selftest 断言数不变 **330/316**。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 330/0（未初始化 316/0）· sqlite-validate 83/0 · mysql-validate 36/0 · pg-validate 54/0 · e2e 42/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。

### V1.6.21（import_data PG 路径 COPY FROM STDIN 提速 + 基准入仓 `mcp/bench.mjs` + 直方图全 NULL/单行边界锚定 + mysql 时间列脏桶修复）

- **import_data 的 postgres 非事务批路径改用 COPY FROM STDIN（文本格式）**：每批一次网络往返整批灌入，绕过多 VALUES 逐条绑定/解析开销；走 pg 驱动 Submittable 扩展点直发 copyData/copyDone 线协议（`connection.sendCopyFromChunk`/`endCopyFrom`/`sendCopyFail`），零新依赖。文本格式转义逐字节保真（NULL=`\N`、`\`→`\\`、LF/CR/TAB/BS/FF/VT 对应转义、字面量 `\N`→`\\N`、空串=空字段），值内换行（v1.6.13 引号内 CRLF 保真）原样往返；表/列名经 quoteIdent 白名单（splitIdent/表头正则钉死裸标识符），值永不进 SQL 文本。**批失败逐行定位坏行的回退契约逐字不变**：COPY 批语句同样原子失败、不写入，`isAmbiguousWriteError` 分类不变（超时/连接类 → 结果未知中止不回退；约束/数据类 → 回退逐行定位坏行），pg-validate 全绿中「非 atomic 定位第 3 行且保留 2 好行（7 行）」钉继续锚定。mysql/sqlite 与 atomic 路径不动（仍参数化多 VALUES INSERT）。selftest +2 钉（COPY 分方言路由 + 文本转义逐字节保真，双口径 330/316 实测）。工具描述与 INSTRUCTIONS 同步改述真实路径。
- **基准入仓 `mcp/bench.mjs`（可重复、JSON 输出、零明文口令）**：收编 `_dist` 手拼基准脚本——万行非事务导入 × 3 轮取中位，env 可配（DBMCP_BENCH_ROWS/ROUNDS/SOURCES/TABLE/OUT），凭据走配置 `enc` 解密（不读 `_secrets.json`、不落明文），跑完自动清基准表。before/after 对比（同机同日，10k 行 CSV 非 atomic，duration_ms 中位）：

  | 源 | before（批 INSERT） | after | 变化 |
  |---|---|---|---|
  | real_pg | 65ms | **28ms** | **2.3×（COPY）** |
  | real_mysql | 309ms | 167ms | 路径未动（暖机差异） |
  | real_sqlite | 85ms | 59ms | 路径未动（暖机差异） |

  pg 逐轮 before [68,65,63] vs after [30,28,28]——最暖一轮仍 2.3×+，排除缓存因素；mysql/sqlite 代码零改动，其回落是同日冷→暖环境差异（before 内部同样首轮偏慢：mysql [410,309,285]），仅作环境参考。
- **mysql 直方图时间列脏桶修复（⑥b 残洞）**：DATETIME/DATE 隐式转数读数字头（`'2024-01-01 00:00:05'`→20240101000005）曾产出 20240101000000.00000 伪数值桶界，破「非数值列 → 空数组」契约——mysql 减法前按值形状 REGEXP 门控（仅数值形状参与减法），数值样文本照旧放行 GIGO（与 avg 强转 0 同哲学）。配套锚定钉：DATETIME/DATE 空数组收口 + 数字样文本桶保留。
- **直方图全 NULL 列 / 单行列边界锚定（语义钉死，该子任务产品零变更）**：
  - **背景**：V1.6.20 收口文本列与退化分布后，仍有两类真实高频边界未锚定——「一列全是 NULL」与「整表只有一行」。全 NULL 域让 rng CTE 的 MIN/MAX 得 NULL（桶宽退化为 NULL），单行域 hi=lo 走防除零分支；此前只被 where 过滤形态（`where: "v = 7"` 模拟单值域）间接覆盖，真实表形态（row_count>0 且 non_null=0 / 整表 1 行）从未钉住。
  - **探针实测（24 项观测，三库逐项对照，先实测后断言零臆造）**：全 NULL 数值列/文本列 → histogram `[]` 空数组、stats min/max/avg=NULL、row_count=3/non_null=0，三库一致不崩不脏不除零；单行列 v=7 → 单桶 `[7,8)`（hi=lo 宽 1.0 防除零）；附加观察：空表同 NULL-rng 路径（`[]` + row_count=0）。**探针未抓获产品缺陷**——v1.6.20 的类型门控 + NULL 桶号过滤恰好把这两类边界兜住，该锚定子任务产品代码零变更、MCP 契约零变化（时间列残洞另行修复，见上条）。
- **锚定断言（探针实测后钉住）**：sqlite 81→82、mysql 33→35（边界锚定 + 时间列锚定）、pg 52→53——同一断言钉三库：全 NULL 列（数值 + 文本）→ 空数组 + min/max/avg=NULL 不除零 + row_count/non_null 计数正确；单行列 → 单桶 [7,8)×1 + min=max=7。探针表自建自删（mysql 整库 DROP 覆盖、pg 前后双保险 DROP + finally 兜底清单）。selftest +2 → 330/316（COPY 钉）。
- **实测口径（2026-10-05，Node v24.15.0）**：selftest 330/0（未初始化 316/0）· sqlite-validate 82/0 · mysql-validate 35/0 · pg-validate 53/0 · e2e 42/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness 46/0。

### V1.6.20（import 批大小动态化：非事务万行导入 mysql 2.7×/sqlite 7×提速 + 直方图 PG NULL/文本列修复）

- **import 批大小按方言动态定（原硬编码 100 行/条）**：新增纯函数 `importBatchSize(dbType, colCount)`——占位符硬上限（mysql/pg 65535、node:sqlite 编译默认 32766 且 25_000 实测可用）各留裕量（sqlite 20000 / mysql·pg 50000）后按列数均摊，窄表封顶 1000、宽表自动降批。直连实测依据（万行非事务路径）：批 100 时 mysql 672ms / sqlite 607ms（每条多 VALUES 语句一个往返+一次提交），批 1000 mysql 降至 ~108ms、pg 86→60ms 趋平；MCP 层复测（10k 行 CSV 默认非 atomic）：**mysql 672→249ms（2.7×）、sqlite 607→87ms（7×）、pg 118→99ms**；60 列宽表三源降批导入回归通过（sqlite 327/批、pg 819/批）。批失败回退逐行定位坏行的语义不受批大小影响（isAmbiguousWriteError 分类不变）；selftest +2 钉（窄表封顶/宽表退化+非法列数兜底）。
- **直方图两处真实库修复（配套锚定钉）**：PG 的 LEAST 忽略 NULL 参数（`LEAST(NULL, n-1)=n-1` 曾把 NULL 行顶进末桶漏过滤）——histogramStatsSql 桶号表达式对 NULL 短路；文本列直方图在 PG 上 `text-text` 42883 硬错误——类型门控减法仅对数值列生效。三 validate 套件锚定断言（sqlite 78→81、mysql 30→33、pg 48→52 含时间列同族钉 `::text::numeric`；pg 计数含 V1.6.19 文档漂移修正：文档写 46 实际 48，本轮 +4 后实测 52）。
- **查询/执行超时三形态统一 `E_DB:conditional`（真实库超时抓获）**：pg query_timeout 无 code 曾掉 E_INTERNAL 兜底、pg statement_timeout 57014 与 mysql2 PROTOCOL_SEQUENCE_TIMEOUT 曾按驱动码走 E_DB:no-retry——超时属「同参重试必再超、改变范围可成」的条件态，统一收口 `E_DB:conditional`；连接建立超时 ETIMEDOUT 不混类（仍 `E_DB:retryable`）。selftest +2 errcode 钉（连同批大小 +2：本轮 selftest 324→328、未初始化口径 310→314）。
- **实测口径（2026-10-05，Node v24.15.0，双会话并行验证后合并计数）**：selftest 328/0（未初始化 314/0）· sqlite-validate 81/0 · mysql-validate 33/0 · pg-validate 52/0 · e2e 42/0 · protocol 24/0 · realform 43/0；另 46 断言独立全工具真库 harness（spawn→stdio JSON-RPC 逐工具调用 + 8 例红线负例 + 导出导入跨源回环 + DBMCP_ERR_LOG 观测面口令清洗核验）46/0。

### V1.6.19（三库文本列画像语义锚定：avg 方言分歧钉为契约）

- **背景**：V1.6.18 修复 PG 文本列 `column_stats` 后，三方言对「文本列 avg」各给一种答案——MySQL/SQLite 把非数值文本强转 0（`'10','20','x'` → avg=10）、PG 类型门控 → NULL，且此前没有任何测试看住这个分歧。语义一旦被无意「统一化」（例如把 PG 门控照搬到 mysql/sqlite，或反向抹掉门控）即属契约破坏，必须有锚定断言。
- **测试锚定（三套件各 +1，先实测后断言零臆造）**：sqlite-validate 77→78、mysql-validate 29→30、pg-validate 45→46——同一探针列（tag=a50/b30/c20 非数值文本）钉三方言实测语义：row_count 100 / non_null 100 / distinct 3、min/max 字典序 `a`/`c` 三方言一致；avg：sqlite/mysql **0**（非数值强转）、pg **NULL**（类型门控）。
- **工具描述注明语义**：`column_stats` description（server.mjs）与 SKILL/README 工具表补均值方言语义说明——大模型消费侧也能看到这一分歧，不再靠口口相传（selftest 仅钉 `Example: {` 存在，描述文案扩展不改断言数 324/310）。
- **产品代码除描述文案外零变更**，MCP 工具契约兼容。
- **实测环境注记（取证结论，非产品缺陷）**：本轮回归期间真实 MySQL 的 `realdb` 库被外部 GUI 会话删除——binlog 尾笔事务取证为 DBeaver 26.2.1 于 2026-10-05 00:59:14 执行 `DROP SCHEMA \`realdb\``（故此前 `DROP DATABASE` 关键字排查全程无命中）。按 rig bootstrap 重建后 mysql-validate 30/0 复绿。真实库套件再遇 `Unknown database` 先做 binlog 取证再重建，勿先怀疑产品。

### V1.6.18（真实库套件扩全工具面：pg-validate 22→45 项 + 修复 PG 文本列 column_stats 真 bug）

- **背景**：pg-validate 止步于「操作矩阵 × 直连核对」22 项，mysql-validate 的全工具面（画像/直方图/TopN/发现类/EXPLAIN/事务/import 原子性）在真实 PG 上从未端到端执行过——PG 方言分支（information_schema $n 占位符、EXPLAIN (FORMAT JSON)、COUNT(*)::bigint 字符串化、ILIKE 子串、括号复合不包外层 LIMIT）此前只被纯函数单测覆盖。本轮把这些分支全部在真实 PostgreSQL 17.5 上跑通。
- **真 bug 修复（新套件抓获）**：`column_stats` 对文本列在 PG 上整条失败——`columnStatsSql` 无条件 `AVG(col)`，PG 的 `AVG(varchar)` 是 42883 硬错误（MySQL 靠隐式强转侥幸通过、sqlite 静默转 0，故此前漏掉），导致 `top_values` 的主用例（tag 之类低基数文本列）在 PG 完全不可用。修复：PG 分支 avg 类型门控 `AVG(CASE WHEN pg_typeof(col) IN (smallint/integer/bigint/numeric/real/double precision) THEN col::numeric END)`——仅数值类型求均值、文本列 avg=NULL（CASE 短路保证 THEN 的 cast 不在文本行求值）；min/max 文本仍按字典序（契约不变），mysql/sqlite 零变化。selftest colstats 断言补 pg_typeof 门控钉（断言数不变 324/310）。
- **新套件 pg-validate 22→45 项**：新增 23 项全工具面钉测（对标 mysql-validate）——column_stats 画像/直方图（clamp 上限/过滤域/NULL 排除）/TopN（频数降序 + 值升序）/combo、list_tables（ILIKE name_like）/describe_table（列序/主键/pkey 索引）/find_tables_by_column（ILIKE 子串）/fk_relationships（单表 + 全 schema）、count_rows（::bigint total）/distinct_values（稳定次序）/sample_data（order_by 白名单）/query（自动 LIMIT 截断/括号复合 UNION/SHOW server_version）、query_plan（text + json 双格式/EXPLAIN 写语句拒绝）、execute（affected_rows=pg rowCount）/create_table（CTAS E_SAFETY 拒绝且零建表）、import（rows_imported/atomic 整体回滚/非 atomic 定位第 3 行且保留好行）、withTransaction（提交/PK 冲突整体回滚）。甄别非 bug 1 项：`name_like: "hist_"` 只命中 2 表是 SQL LIKE `_` 单字符通配符标准语义（非产品缺陷），套件改用 `probe_hist` 关键字并注明。
- **自测**：pg-validate 45/0（真实 PostgreSQL 17.5）；全量回归 selftest 324/0、sqlite-validate 77/0、mysql-validate 29/0、e2e 42/0、protocol 24/0、realform 43/0；发版门禁通过（mysql/pg 真实库段诚实 SKIP 口径）。

### V1.6.17（真实数据库实测认证：三库操作矩阵直连双向核对 + 新增 pg-validate 真实库套件）

- **背景（用户要求）**：使用真实数据库对每一步实际操作（查表/建表/删表/删数据等）测试，并对比数据库真实操作是否执行。便携部署真实 MySQL 8.4.5 与真实 PostgreSQL 17.5 于 `D:\work\Zcode\DB`（Windows 无 OceanBase 发行版且无 Docker/WSL——该库「待确认/不适用」，其 MySQL 模式语义由真实 MySQL 覆盖）
- **操作核对台 realdb-v1617（三库矩阵 68/0）**：对真实 MySQL / 真实 PostgreSQL / SQLite 文件库各跑 22 步操作矩阵，每步「MCP 工具行为 ↔ 独立直连真实结果」双向核对：预清理 → create_table（直连验证表存在）→ describe_table（结构一致）→ import CSV 3 行（直连计数/取值）→ execute INSERT（直连验证）→ query 逐值一致 → count_rows 一致 → UPDATE 真实改值（20→25）→ DELETE 真实删行 → 6 条红线负例（无 WHERE UPDATE/DELETE、恒真 WHERE、TRUNCATE、DROP、多语句——每条拒绝后直连快照零变化且表仍在）→ BLOB(bytea) 入库与 `<binary N bytes: hex>` 形状 → 导出 JSON/CSV 与直连逐值一致 → DBA 直连删表后 MCP `describe_table` 报 `E_NOT_FOUND`（真实删除确认）。产品行为零例外：所有差异均为测试台自身期望写错（count_rows 键名 `total`、pg `to_regclass` 不存在时返回 1 行 NULL、export 防覆盖契约需 `overwrite:true`），逐项修正测试台后 68/0
- **新套件 pg-validate.mjs（真实 PostgreSQL 22 项）**：操作矩阵 × 直连双向核对沉淀入仓（对标 mysql-validate.mjs：真 stdio 客户端链路、enc 密文原样临时配置、探针表 pg_probe_* 自建自删、无 postgres 源时 SKIP 退出码 3）——填补 mysql/sqlite 均有真库套件而 PG 无的缺口；首发实测 22/0
- **发版门禁**：distribute.mjs 新增「pg-validate 真实库段」步骤（诚实 SKIP 口径同 mysql-validate：退出码 3 判过明示）
- **mysql-validate 首次真实 MySQL 全量实测 29/0**：历史基线（2026-10-03）后首次真库全跑——直方图/TopN/NULL 画像、事务提交与 PK 冲突回滚、导入 atomic 回滚、红线零副作用核对、CTAS 拒绝、探针库自建自删全部真实执行验证
- **自测**：realdb-v1617 68/0；mysql-validate 29/0、pg-validate 22/0、sqlite-validate 77/0；全量回归 selftest 324/0（已初始化口径）+ e2e 42/0 + protocol 24/0 + realform 43/0；发版门禁全绿
- **契约兼容**：产品代码零改动（仅新增测试套件 + 门禁步骤 + 版本回落值）

### V1.6.16（真实对抗测试驱动修复：BLOB/Uint8Array 序列化键值垃圾）

- **方法论**：沿用 V1.6.13 真实对抗测试台方法（独立脚本 adv-v1616、31 项期望行为断言，先写期望后对照实现）——靶区 ①字节/大整数序列化 ②SQL 入口形态 ③CSV Excel 生态 ④参数边界语义 ⑤写路径边界；抓获 1 类真 bug，另甄别 3 类「测试台期望写错、产品按设计语义」不误改
- **真 bug（BLOB 序列化键值垃圾）**：`stringify`/`csvCell` 的字节分支只认 `{type:"Buffer",data:[...]}` 形状（Buffer.prototype.toJSON 产物），而 node:sqlite 的 BLOB 返回 `Uint8Array`（无 toJSON）——JSON 面被序列化成 `{"0":0,"1":1,"2":2,"3":255}` 键值垃圾、CSV 面掉进 `String(v)` 变 `0,1,2,255`（mysql2/pg 的 live Buffer 实例同样漏，旧分支实际只覆盖已 toJSON 的形状）。修复：两处在旧分支前补 `ArrayBuffer.isView()` 分支——响应面 `<binary N bytes: hex…>`（≤8 字节无省略号，沿 v1.0.2 预览口径）、导出面全量 hex、CSV 确定性 hex；契约兼容（旧 `{type:"Buffer"}` 形状行为不变，仅补漏）
- **甄别为非 bug（有据不改）**：① sqlite 整数全字符串化（pool.mjs `setReadBigInts(true)` + bigint→string，防雪花 ID 精度被 JS 篡改，与 mysql bigNumberStrings/pg int8 策略一致，sqlite-validate 既有钉佐证）② `limit` 超 schema 上限 clamp 不拒绝（工具 schema 明示 "Values above the max are clamped to the max"）③ export/import 独立白名单目录（DBMCP_EXPORT_DIR / DBMCP_IMPORT_DIR 分离，回环需文件复制）——三者回改测试台期望，产品零改动
- **回归钉**：selftest +3 项 → **324 项断言**（未初始化 310）：Uint8Array stringify 响应形状/导出全量 hex/csvCell hex；realform-validate +3 项 → **43 项**：真实链路查询 `<binary 4 bytes: 000102ff>` 契约形状（断言无 `{"0"` 键值垃圾）+ 导出 JSON hex + 导出 CSV hex（断言非 `0,1,2,255`）
- **自测**：adv-v1616 31/0（修复后反证复跑）；全量回归实测 2026-10-04 全绿：selftest 未初始化 310/0 + 已初始化 324/0（双口径，门禁内自证行命中）、sqlite-validate 77、e2e-validate 42、protocol-validate 24、realform-validate 43，全部 0 failed；发版门禁通过
- **契约兼容**：字节序列化仅补漏不改既有形状；sqlite 数字字符串化等既定语义零改动

### V1.6.15（发版门禁补已初始化口径：selftest 双口径覆盖 + 防假绿反向断言）

- **背景（漏检根因）**：V1.6.14 抓获的 E_NOT_FOUND 形状钉 bug 属「已初始化部署必现、未初始化侥幸通过」类——发版门禁只跑未初始化口径 selftest，该口径下未知源报 `E_CONFIG` 恰好绕过 `/^E_[A-Z]+$/` 的错误正则。测试台只覆盖一个口径 = 另一口径的缺陷永远漏到用户现场
- **门禁双口径**：`distribute.mjs` 发版门禁在「selftest 守卫/协议自检」后新增「selftest 已初始化口径」步骤——一次性副本内生成 enc 探针配置（sqlite 探针源 + 带口令假 mysql 源，走副本自带 `crypt2.encryptForConfig` 真加密；与 V1.6.14 计数校准探针同形）跑第二遍 selftest，两口径均绿才放行
- **防假绿（反向断言，非恒真）**：步骤不只看 exit 0——输出必须命中「已初始化口径」自证行；探针生成失败时 selftest 会退化跑未初始化口径且 exit 0，此断言把假绿路径封死。实测反证：篡改探针不写配置 → 步骤判红「输出未命中『已初始化口径』自证行——疑未初始化口径假绿」+ 门禁 exit 3 发布包不可交付
- **诚实 SKIP 口径延续**：无 node:sqlite（Node < 22.5）时探针生成 exit 3 → 门禁按既有诚实 SKIP 判过明示（与 mysql-validate 无凭据同语义，不冒充全绿）；探针配置与探针库跑完即删（副本终将整体删除，此为纵深）
- **自测**：断言数不变（307/321）；门禁实测 2026-10-04 全绿（新增步骤「通过（exit 0，自证行命中）」），反证一并实测；全量回归 + 门禁全绿
- **契约兼容**：仅发版工具链（distribute.mjs）变更，产品代码与测试断言零改动

### V1.6.14（自检口径自证：已初始化实测校准 + 抓获 E_NOT_FOUND 形状钉误判）

- **已初始化口径首次实测校准**：temp 副本 + enc 探针配置（sqlite 探针源 + 带口令假 mysql 源，走 `crypt2.encryptForConfig` 真加密）实测 selftest 已初始化口径 → **321 passed, 0 failed**，与此前推导值（307+14，init 块 15 钉 vs else 分支 +1）精确一致；该口径此前自 V1.6.9 起从未实测（历史「312 项」系推算）
- **实测抓获真 bug（已初始化部署必现）**：observe 端到端钉的错误码形状正则 `/^E_[A-Z]+$/` 不接受第二段下划线——`E_NOT_FOUND` 永不匹配，已初始化部署（未知源真实报 E_NOT_FOUND）该钉必挂；未初始化部署报 E_CONFIG 侥幸通过，故从未暴露。改为 7 错误码显式枚举 `/^E_(SAFETY|PARAM|NOT_FOUND|CONFIG|LIMIT|DB|INTERNAL)$/`（与错误分类法契约同源，顺带钉死码名拼写）
- **断言数自证常量（防口径漂移）**：selftest 新增 `EXPECTED_TOTAL = { uninit: 307, init: 321 }` + 汇总前自证检查（不计入断言数，只在不符时 FAIL）——断言增删若不显式同步常量即红，杜绝「文档 298 实测 301」类静默口径漂移（+3 差异成因已不可考古，本版起口径由代码钉死）；反向测试实测：篡改常量 → `FAIL meta` + 退出码 1，非恒真
- **自测**：断言数不变（307/321）；双口径实测 2026-10-04 全绿：未初始化 307/0（自证一致）、已初始化 321/0（自证一致，leak-guard 口令套件带真口令实测过 scrub/URL 编码变体/输出无泄漏/配置无明文 4 钉）；全量回归 + 6 验证器门禁全绿
- **契约兼容**：仅测试代码与文档变更，产品代码零改动（server.mjs 只动版本回落值）

### V1.6.13（真实测试驱动修复：8 类真实形态缺陷）

- **方法论**：沿用 V1.6.8「自测全绿 ≠ 真实形态可用」教训——先搭对抗性真实测试台（57 项、独立脚本、期望行为断言），32 项失败即 bug 目录，修复后 57/57 全绿再折回归钉。全部缺陷均真实形态触发（复制粘贴/Windows 文件名/CSV 往返），纯函数自测未覆盖
- **S1 前导不可见字符剥除**：`callTool` 入口对 sql/where/order_by/table/column/schema/source 7 个字符串键剥前导 Unicode 不可见字符（ZWSP/ZWNJ/ZWJ/soft-hyphen/RTL override/BOM 等 30+ 码位）——聊天/网页/Excel 复制粘贴的 SQL 不再被误判 E_PARAM；只剥前导（字符串字面量内数据不动），红线在剥除后照常判定（前导 ZWSP 的无 WHERE UPDATE 仍拒）
- **S2 parseCsv 引号内 CRLF 保真**：删除全文 `\r\n→\n` 预归一（会把引号内嵌换行压平，导出→导入往返丢真）；改为仅记录分隔符归一（引号外 CRLF/CR→LF），引号内容字节保真
- **S3 Windows 保留设备名拒绝**：`safeExportPath` 拒绝 CON/PRN/AUX/NUL/COM1-9/LPT1-9（含 `NUL.csv` 带扩展名形态）——防写进设备命名空间造出无法处理的文件；COM10/console.csv/NULL.csv 等不误伤；import 侧同一清洗，报错提「保留设备名/被清洗拒绝」防误判文件缺失
- **S4–S6 文件名卫生**：超 120 字符截断保扩展名（旧版把 `.csv` 截成 `.c`）；扩展名判定大小写不敏感（`REPORT.CSV` 不再追加成双扩展）；尾点/尾空格归一（`report2.csv.`→`report2.csv`，import `data1.csv.` 可寻址）；清洗后为空显式 E_PARAM（旧版拼出 `....csv` 垃圾名）
- **S7 CSV 表头语义**：重名列名明确拒绝（实测 sqlite `INSERT INTO t (a,a) VALUES('first','second')` 只存 'first'——重名表头导入静默丢值，属数据完整性缺陷故硬拒并注明「未写入任何行」）；空表头列名报错带提示（期望 N 列（表头含 M 个空列名已被忽略））；全空表头拒绝
- **S8 sqlite 重名结果列前置拒绝**：`runOnPool` sqlite 分支 `stmt.columns()` 预检重名列（`SELECT id AS x, id+1 AS x` 裸路径实测对象行静默折叠丢首值）→ E_PARAM 建议加别名。纵深防御地板：LIMIT 包裹路径当前会自动消歧（x/x:1）保值，但裸路径/未来行为变化有前置闸
- **自测**：selftest +6 项 → **321 项断言**（未初始化 307）：stripLeadingInvis 剥除钉（内部/非字符串零改动）、剥除后红线照常判定钉、parseCsv 引号内 CRLF 保真 + 记录分隔归一钉、保留设备名拒绝（含带扩展名形态）+ 非保留名不误伤钉、超长截断保扩展名 + 尾点归一 + 清洗后为空拒绝钉、sqlite 重名结果列前置拒绝钉（runQuery 真链路）；realform-validate +14 项 → **40 项**：前导 ZWSP SELECT 可执行 + 红线不因剥除失效、保留名 NUL 拒绝 + COM10 不误伤、超长截断保扩展名、大写扩展名不重复追加、尾点归一 + import 尾点寻址、引号内 CRLF 导出→导入回环保真、空表头/重名表头明确报错、行数截断边界（max_rows=2 截断 truncated=true / 恰满不截断）（实测 2026-10-04 全绿：selftest 307/321、sqlite-validate 77、e2e-validate 42、protocol-validate 24、realform-validate 40，全部 0 failed）
- **契约兼容**：全部为「拒绝错误行为」或「放宽误拒」——不改工具 schema、不改成功响应形状；旧行为里唯一被收紧的是重名 CSV 表头（原本静默丢值）与保留设备名/病态文件名（原本生成坏文件），均为缺陷修正非契约变更。sqlite-validate 既有钉 `export_data '..' + ext becomes ordinary file` 期望随 S4 同步更新为显式拒绝（病态名 `".."/". "/"..."` 清洗后为空不再静默拼 `...csv` 垃圾名；断言数 77 不变）

### V1.6.12（notifications/cancelled：MCP 规范取消语义）

- **协议面**：实现 MCP 2025-06-18 Cancellation——`notifications/cancelled`（params: `requestId`, `reason?`）**插队处理**（串行队列会把通知排到长查询之后，永远来不及中断）：运行中请求与 AbortController 竞速，命中即**不发响应**（规范明示 “Not send a response”，不引入 -32800——那是 LSP 习惯）；`initialize` 按规范 MUST NOT 被取消（从不入表，取消天然忽略）
- **排队中请求不执行不响应（写安全）**：报文到达即登记在途表（区分规范要求的「未知 id 忽略」与「排队中可取消」），派发口消费取消标记——被取消的 UPDATE 不会落库，这是比规范最低要求更安全的方向；标记一次性消费，id 复用安全
- **忽略语义（规范 SHOULD ignore）**：未知 id / 已完成（含迟到取消）/ 无效通知（缺 requestId、非标量、带 id 的请求形状）一律忽略；带 id 的 `notifications/cancelled` 按请求分发回 -32601
- **边界如实**：取消释放的是「等待与响应」，已在执行的驱动查询不回滚不中断（mysql2 单查询 timeout / pg statement_timeout / sqlite 同步不可中断为各自上界）——写操作若已开跑仍可能落库，取消不是事务回滚；取消理由过权威 scrub 后出 stderr（规范 SHOULD log reasons）；tools/call 契约零改动（审计日志照常每次 1 条，与取消行按 id 关联）
- **自测**：selftest +6 项 → **312 项断言**（未初始化 298）：isCancelNotification 形状钉、未知/无效取消忽略钉、登记表 abort/严格 id 类型/迟到忽略钉、beginDispatch 一次性消费（id 复用安全）钉、已取消 tools/call 不执行不响应钉、请求形状 -32601 钉；protocol-validate +7 项 → **24 项**：静默 TCP fixture 制造真实挂起请求——运行中取消不发响应且队列立即解放、排队中取消不执行不响应、未知/迟到/无效取消忽略（实测 2026-10-04 全绿：selftest 298/312、sqlite-validate 77、e2e-validate 42、protocol-validate 24、realform-validate 26，全部 0 failed）
### V1.6.11（真实形态测试台转正：realform-validate 随包常驻）

- **测试资产转正**：V1.6.8 打的真实形态测试台（真 SQLite + 真 stdio server + 业务形态中文/边界数据，26 场景）转正为随包常驻套件 `mcp/realform-validate.mjs`（沿用 V1.6.4 套件转正先例与家族契约）：`here` 自定位 mcp 目录、无 node:sqlite 时诚实 SKIP 退出码 3、统一汇总行 `=== realform-validate: N passed, M failed ===`、FAIL 保留现场 + FAILDETAIL、PASS 自建自删（mkdtemp 中文库 `业务库.db` + 临时配置 + 导出/导入目录）
- **场景面**：中文库文件名/中文表/中文列全链路（发现/读/写/建表）+ 边界值（BigInt 精度 9007199254740993、超长文本、emoji/换行、NULL/BLOB）+ 导出导入回环保真（CSV 公式中和与 `strip_neutralization` 原样还原）+ 写面红线（无 WHERE UPDATE / 多语句 / 恒真 WHERE 拒绝）+ 注入面负例（注入表名/恒真 WHERE）
- **接线**：`distribute.mjs` 发版门禁家族验收 5 → **6 验证器**（selftest / sqlite-validate / mysql-validate / e2e-validate / protocol-validate / **realform-validate**），退出码 3 判过明示口径不变——发版必须过真实形态回归
- **自测**：新增 realform-validate 26 项（selftest 断言数不变 → **306 项断言**（未初始化 292））（实测 2026-10-04 全绿：selftest 292/306、sqlite-validate 77、e2e-validate 42、protocol-validate 17、realform-validate 26，全部 0 failed；mysql-validate 29 项真实 MySQL 基线仍为 2026-10-03）

### V1.6.10（观测日志滚动：总量有界）

- **超限滚动**：写入前 stat 当前大小，`size + 行 > 上限` 时滚动——`<路径>.KEEP` 删除、`.N` 顺次后移（`.KEEP-1→.KEEP` … `.1→.2`）、主文件 → `<路径>.1`，再追加新行（Windows rename 目标必须不存在，故从高位往低位挪并先删末端）。上限 `DBMCP_ERR_LOG_MAX_BYTES`（缺省 10MB，合法域 [1024B, 1GB]）、保留份数 `DBMCP_ERR_LOG_KEEP`（缺省 3，合法域 [1, 20]）
- **总量有界不变量**：单行 <2KB（字段截断）+ 每文件 ≤ max(上限, 单行上限) + 保留 ≤ KEEP 份 → 长期运行日志总量有上界，不再有灌盘风险
- **失败边界**：stat/rename/删除任一步失败静默跳过并照常追加（宁可暂时超限也不丢记录），下次调用重试滚动；追加写失败依旧 fail-open——观测面永不改变工具调用行为
- **参数容错**：上限/份数取值为非整数、越界、空串时回落缺省值，不引入新的参数校验错误面（观测配置不是安全控制）

**自测**：selftest +2 项 → **306 项断言**（未初始化 292）：超限滚动钉（.1 生成、总量有界、最新记录在主文件尾、旧记录在 .1、保留外无 .4）+ 保留上限与参数容错钉（KEEP=2 不留 .3、非法值回落缺省仍写盘）（实测 2026-10-04 全绿：selftest 292/306、sqlite-validate 77、e2e-validate 42、protocol-validate 17，全部 0 failed）

### V1.6.9（观测面打点：DBMCP_ERR_LOG 结构化脱敏审计日志）

- **可选观测日志**：环境变量 `DBMCP_ERR_LOG=<日志文件路径>` 开启后，每次 tools/call（含失败与未知工具）恰好追加 1 行 NDJSON 审计记录：`ts`/`id`（JSON-RPC 请求 id，跨调用关联）/`tool`/`is_error`/`code`/`retry`（稳定错误码与重试态）/`duration_ms`/`source`/`table`/`sql_head`/`err_head`——错误率与重试态分布可直接统计（分母=全部行）。**未设置该变量时零行为**（默认完全关闭，不产生任何文件）
- **日志脱敏单一真相源**：全部字符串字段过与工具输出相同的权威 `scrub`（配置口令及 URL 编码变体 → `***`），先整段脱敏再截断（每字段 ≤200 字符，防截断出半个秘密/防超长灌爆）；清洗规则不在日志模块内复制，防规则漂移漏洗
- **fail-open 边界明确**：日志写失败（路径是目录/磁盘满/无权限）静默吞掉，工具调用行为与结果零影响——打点不是安全控制，安全红线照旧 fail-closed；单行 <2KB 追加写，不引入网络/异步/超时面
- **契约零侵入**：打点在 `callTool` 出口单点，tools/call 的 result/error 载荷字段零改动；新模块 `observe.mjs` 零依赖（仅 node:fs）
- **适用边界（如实）**：日志含业务元数据（表名/SQL 摘要），部署方负责存放与清理；多进程并发写同一文件时单行原子性以本地文件系统为准（本服务单进程串行处理请求，常规部署无并发写）

**自测**：selftest +6 项 → **304 项断言**（未初始化 290）：默认关闭零写盘、单行 NDJSON 字段完整、错误行带码/成功行 null、脱敏走权威 scrub + 截断有界、端到端每调用 1 条记录 id 可关联（含字符串 id）、日志写失败 fail-open（实测 2026-10-04 全绿：selftest 290/304、sqlite-validate 77、e2e-validate 42、protocol-validate 17，全部 0 failed）

### V1.6.8（真实测试驱动修复：file 形态源 + Unicode 标识符全链路）

- **真实形态测试**：自建真实测试台（真实 SQLite 业务库 + 真实 stdio 子进程 + 中文表/列名 + 边界数据：大整数 9007199254740993 精度、emoji/CRLF/BLOB、CSV 公式文本），26 个真实场景矩阵（发现/读链/导出导入回环/execute 红线/注入负例）实测抓获 3 个产品 bug 并全部修复——此前自测全绿但真实形态（尤其中文标识符）存在失守面
- **bug① getSource 拒绝 file 形态 SQLite 源**：`{type:"sqlite", file:...}` 形态的源（文档明确支持）因 `if (!s || !s.url)` 被误判 Unknown source，列出却不可用；改为 `url || file` 双形态准入，并分流错误语义（无此源 → E_NOT_FOUND；缺连接信息 → E_CONFIG 指引检查 dbmcp.config.json）
- **bug② splitIdent 纯 ASCII 正则拒绝中文表/列名**：`/^[A-Za-z_][\w$]*$/` 把国内库常态的中文标识符全判 "Invalid identifier '订单表'"（describe/sample/distinct/stats/count 全读链受累）；改 Unicode 感知 `/^[_\p{L}][\p{L}\p{N}$]*$/u`，注入字符（引号/分号/空格等）照旧拒绝
- **bug③ 红线列引用检测漏认中文列（误拒合法写）**：`exprHasColumn` 同根 ASCII 正则把 `WHERE 订单号='D001'` 判成"WHERE 未引用任何列"拒绝合法写入；`extractWriteTarget` 中文写目标解析失败致 maxAffectedRows 预检静默失效。全链路共 6 处同根正则一并 Unicode 化（exprHasColumn、extractWriteTarget、列名校验×2、CSV 表头、order_by）；顺带收紧一处红线盲区：续位字符类补 `_` 后，`my_func(1)` 形态的下划线函数名不再被误计为列引用。端到端钉确认：字面量伪装恒真（`WHERE 'a'='a'`）脱敏后无列引用仍被 E_SAFETY 拒绝，红线不因放宽而松动
- **兼容性**：纯校验正则放宽（ASCII 子集行为不变，新增 Unicode 文字准入），工具契约/消息文本零改动

**自测**：selftest +2 项 → **298 项断言**（未初始化 284）：splitIdent Unicode 钉（接受中文/拒绝注入与三段名）+ 红线列引用 Unicode 钉（中文列识别 + 恒真条件识破 + guardWrite 端到端拒绝）（实测 2026-10-04 全绿：selftest 284/298、sqlite-validate 77、e2e-validate 42、protocol-validate 17，全部 0 failed，另真实形态测试台 26/26；mysql-validate 29 项真实 MySQL 基线仍为 2026-10-03）

### V1.6.7（工具声明收口：全量调用示例 + 契约形状钉）

- **用法示例全覆盖**：16 个工具的 `description` 全量追加 `Example: {json 参数}` 调用示例（与 inputSchema 字段一一对应的真实参数形态；`execute` 示例示范带 WHERE 的红线合规写法，`query` 示例示范显式 LIMIT）——LLM 选工具与填参有具体参照，减少凭空猜参数。纯 description 文本追加，`inputSchema`/`annotations`/调用行为零改动
- **契约形状钉**：selftest 新增 2 项断言——① 16 工具 `title` + `annotations` + `inputSchema`（type=object 且 additionalProperties:false）收口，防声明字段被静默删除；② 全部 description 必须含 `Example: {`，防示例回归丢失。经真 `tools/list` 回环验证（非直接读常量）
- **背景**：`title` 字段此前已 16/16 覆盖（MCP 2025-06-18 规范展示名；2024-11-05 旧客户端按未知字段忽略，向后兼容），本轮缺口实测为「示例缺失 + 无形状保障」

**自测**：selftest +2 项 → **296 项断言**（未初始化 282）：工具声明形状钉 + 示例覆盖钉（实测 2026-10-04 全绿：selftest 282/296、sqlite-validate 77、e2e-validate 42、protocol-validate 17，全部 0 failed；mysql-validate 29 项真实 MySQL 基线仍为 2026-10-03）

### V1.6.6（错误码覆盖深化：全 throw 点显式分类，模式匹配降级兜底）

- **ToolError 显式分类**：guard.mjs 新增 `ToolError` 类（携带 `errCode`/`errRetry` 属性，命名避开驱动 `e.code` 冲突），69 个 throw 点（guard.mjs 27 + server.mjs 40 + pool.mjs 2）全部显式携带错误码与重试态；`classifyError` 首查显式标签，消息模式匹配降级为未标注错误/第三方驱动错误的兜底——错误分类不再依赖报错文案的措辞
- **误分类修正（模式匹配盲区实测抓获）**：5 类真实报错此前不匹配任何模式、被兜底为 `E_INTERNAL`——`'execute' only allows single INSERT/UPDATE/DELETE...` 与 `'create_table' only accepts...`（守卫拒绝 → E_SAFETY）、`第 N 行导入失败，整批中止`（→ E_DB:no-retry）、`Writes are disabled...`（→ E_CONFIG）、自动 LIMIT 派生表重名列（→ E_PARAM）。指标达成：工具路径 `E_INTERNAL` 占比 → 0（仅 guard 内部不变量违例一处保留，属诚实兜底）
- **重试态缺省映射**：`ERR_DEFAULT_RETRY` 按码给缺省重试态（E_LIMIT→conditional，其余 no-retry），调用点仅在语义偏离缺省时显式指定（如批写入结果未知 → E_DB:conditional）
- **兼容性**：69 处仅替换构造器与参数前缀，错误消息文本逐字不变；`Error: [E_CODE:retry] 原文` 格式与全部子串匹配回归钉不变；JSON-RPC 层错误（-32600/-32700/-32601/-32603）不受影响

**自测**：selftest +2 项 → **294 项断言**（未初始化 280）：显式标签优先于模式匹配钉 + 缺省重试态映射钉（实测 2026-10-04 全绿：selftest 280/294、sqlite-validate 77、e2e-validate 42、protocol-validate 17，全部 0 failed；mysql-validate 29 项真实 MySQL 基线仍为 2026-10-03——错误码改造未动消息文本，真实库复跑列入下一轮）

### V1.6.5（错误语义标准化：稳定机器可读错误码）

- **错误码 taxonomy**：工具错误统一携带稳定错误码，格式 `Error: [E_CODE:retry] 原文`。CODE 七类：`E_SAFETY`（守卫/红线拒绝，同参重试必然再拒）、`E_PARAM`（参数/语句形态错误，修正后重试）、`E_NOT_FOUND`（源/表/列/文件不存在）、`E_CONFIG`（部署/配置态：未初始化、权限未开，需运维处理）、`E_LIMIT`（超上限，缩小范围后可重试）、`E_DB`（数据库/驱动错误）、`E_INTERNAL`（未分类兜底）；retry 三态 `retryable | conditional | no-retry`（连接类驱动错误码 retryable，语法/约束类 no-retry）。**错误原文逐字保留在标签之后**——存量客户端按子串匹配错误文案的行为不变（回归钉确认）；`classifyError` 为纯函数可单测，未知错误兜底 `E_INTERNAL:no-retry`（fail-closed，不鼓励盲目重试）
- **动机（MCP 调用方视角）**：LLM 此前无法区分「安全拒绝勿重试」与「瞬时 DB 错误可重试」，会对不可重试错误反复改写重试——烧 token 且无进展；现在可依据错误码 + retry 标签直接决策（重试/改参/停手/找运维）。错误码语义写入 `initialize` 的 `instructions`，客户端握手即可见
- **兼容性**：`isError` 布尔、`content[0].text` 前缀 `Error: ` 与错误原文全部保持；仅在两者之间插入 `[E_CODE:retry]` 标签。JSON-RPC 层错误（-32600/-32700/-32601/-32603）维持 MCP 规范语义不变

**自测**：selftest +11 项 → **292 项断言**（未初始化 278）：7 类错误码分类纯钉 + 连接类/语法类驱动错误重试语义 + fail-closed 兜底 + 回环格式兼容钉（实测 2026-10-04 全绿：selftest 278/292、sqlite-validate 77、e2e-validate 42、protocol-validate 17，全部 0 failed；mysql-validate 29 项真实 MySQL 基线仍为 2026-10-03）

### V1.6.4（测试资产转正：全链路 E2E + 协议边界入仓库测试族）

- **测试资产转正**：v1.6.3 的两套临时套件（全链路 E2E 41 项、协议对抗 17 项）转正为仓库常驻套件 `mcp/e2e-validate.mjs`（**42 项**，新增 export JSON 保真真链路回归）与 `mcp/protocol-validate.mjs`（**17 项**），沿用家族契约（统一汇总行 + 退出码 0/1/3 诚实 SKIP）：fixture 自供给（mkdtemp 临时 SQLite 库 + 临时配置 + 导出/导入白名单目录，自建自删，不触碰部署配置与业务库），无 node:sqlite（Node < 22.5）时诚实 SKIP 退出码 3；自定位 mcp 目录并兼容 `install.mjs` 的 argv[2] 传参；e2e 的版本断言改读 `package.json` 动态比对（消除硬编码版本漂移点）
- **接线**：`distribute.mjs` 发版门禁家族验收 3 → **5 验证器**（selftest / sqlite-validate / mysql-validate / e2e-validate / protocol-validate，退出码 3 判过明示）；`install.mjs` 步骤 5 E2E 解析链改为 `DBMCP_E2E` > 技能仓库 fullchain_test.mjs > **随包 mcp/e2e-validate.mjs**——部署机从此必然执行全链路 E2E，不再因技能仓库未随包而跳过；`mcp/package.json` 新增 `validate:e2e` / `validate:protocol` scripts
- **附带加固**：两套件 rpc 层加 30s 超时（回归挂死 → FAIL 而非套件挂起）；notification 无响应断言由恒真改为「stdout 行数不增」实断言（临时套件原断言恒真，属假绿点）

**自测**：实测 2026-10-04 全绿：selftest 281/267、sqlite-validate 77、e2e-validate 42、protocol-validate 17，全部 0 failed（selftest/sqlite-validate 本轮无代码变更；mysql-validate 29 项真实 MySQL 基线仍为 2026-10-03）

### V1.6.3（导出保真 + 协议错误可关联 + 连接首触去重）

**修复（全链路 E2E 41 项 + 协议对抗 17 项实测抓获）**

- **export JSON 导出保真**：JSON 导出此前复用响应面序列化，长单元格被截断（`<truncated` 标记）、二进制列只留 8 字节 hex 预览——导出文件是数据交付物，静默截断即数据丢失。现导出模式全量落盘（长文本不截断、Buffer 全量 hex），响应面截断行为不变（上下文成本护栏）；selftest 与 sqlite-validate 双钉（3000 字符长文本完整落盘且无截断标记）
- **stdio 错误响应携带请求 id**：超长行（>2MB）拒绝此前回 `id: null`、坏 JSON 静默丢弃，客户端按 id 等待时**永久挂起**（协议对抗实测抓获）。现 `peekRpcId` 从坏行恢复请求 id：超长行回 `-32600`、JSON 解析失败回 `-32700`，均携带可关联 id；非 JSON 噪声行维持静默（stdout 洁净）
- **getPool 并发首触去重**：并发首触同一源会创建两个连接池（SQLite 双 `DatabaseSync` 句柄泄漏、mysql/pg 双池浪费连接数）。现 in-flight 去重（`creating` Map），并发首触返回同一池实例，孤儿连接不再产生

**自测**：selftest +4 项 → **281 项断言**（未初始化 267）+ sqlite-validate +1 项 → **77 项**（实测 2026-10-04 全绿：selftest 281/267、sqlite-validate 77、mysql-validate 29，全部 0 failed；mysql-validate 本轮无代码变更，真实 MySQL 基线仍为 2026-10-03）。另有临时全链路 E2E 41 项（16 工具真 stdio 链路：握手/发现/读链/守卫负例/写导出导入闭环）与协议对抗 17 项（超长行/坏 JSON/批量/id 边界/守卫对抗负例）全绿——两套件转正入仓库测试族为下一步

### V1.6.2（稳定次序修复 + 全工具面真实库钉测 + 文档纪律）

- **行为修复**：`distinct_values` 的 Top-N 高频值并列频数按值升序稳定次序（与 `column_stats` top_values 同契约）——`limit` 截断边界取哪几个值从此可复现；配套 selftest 契约断言（277/263 断言数不变）
- **测试面**：`mysql-validate` 17 → **29 项**，扩展真实 MySQL **全工具面钉测**（list_tables / describe_table / find_tables_by_column / fk_relationships / query / query_plan / count_rows / distinct_values / sample_data / execute / create_table——含红线拒绝零副作用核对）；此前这些工具只在 sqlite-validate 与纯函数契约里验证过，真实 MySQL 的 information_schema 占位符形态、fkSql 三占位符、EXPLAIN FORMAT=JSON 从未端到端执行（实测 2026-10-03 全绿：selftest 277/263、sqlite-validate 76、mysql-validate 29，全部 0 failed）
- **文档纪律**：新增「版本与文档同步规范」——版本唯一事实源 `mcp/package.json`（server 横幅/selftest 一致性断言自动跟随），全部文档版本行、README 更新记录、部署说明短条目按规范同步；`部署说明.md` 回补 V1.6.1 短条目（此前只落 README）；`SKILL.md` 扩写**自然语言使用示例**（数据探查/表结构/分布统计/EXPLAIN/导出/行数核对 + 写类请求确认与全表操作拒绝口径）
- **发布口径**：纯净分发包**零预装依赖**——不含 `node_modules`，也不含任何 `.` 前缀文件/目录（`.gitignore` 等装机导入 `.dbp` 时自动生成）；依赖由 `install.mjs` 的 `npm ci --omit=dev` 命令生成。README 部署自检同步改写（不再承诺免联网），纯净发布包剔除开发机残留，解压/拷贝即可部署

### V1.6.1（真实库全链路实测：三方言缺陷修复 + mysql-validate 套件 + 幂等对齐）

**修复（真实库实测抓获）**

- **export 原子落盘（writeFileAtomic）**：同目录唯一临时文件 + `linkSync` 原子占位（拒覆盖路径跨进程互斥，消除 existsSync+writeFileSync 的 TOCTOU 竞态）/ `renameSync` 原子替换（覆盖路径，读方任一刻都是完整内容）；Windows 并发替换瞬态 EPERM 自动重试（双进程 5 轮实测）；任何失败清理临时文件不留残渣。
- **v1.6.0 直方图三方言缺陷**（此前仅 SQLite 验证，方言差异漏测）：MySQL `CAST(x AS INTEGER)` 是语法错误 → `AS SIGNED`；`ONLY_FULL_GROUP_BY` 下 bucket 边界列必须随 `bucket_index` 进 GROUP BY；PG 的 `MIN` 是聚合函数（双参即语法错误），元素级封顶改 `LEAST`（仅 SQLite 的 `MIN(a,b)` 是标量）。

**测试能力**

- **新套件 mysql-validate.mjs（真实 MySQL 全链路 17 项）**：stdio JSON-RPC 真客户端链路（spawn server → 工具层 → 守卫 → 连接池 → MySQL）覆盖 column_stats 画像/直方图（含 clamp 与 where）/TopN/NULL 排除/参数夹取、withTransaction 提交与冲突回滚（v1.5.3 一次性探针固化）、export_data 落盘核对与拒覆盖/原子替换、import_data 参数化导入与 atomic 整体回滚/逐行定位坏行。探针库 `dbmcp_probe_hist` 自建自删，配置无 mysql 源时 SKIP（退出码 3）。

**幂等语义对齐**

- sqlite-add：同名源冲突校验先于落盘（拒绝时不再留新建空库文件），拒绝文案与 import-dbeaver `--force` 口径一致。
- install.mjs：客户端配置备份仅首次生成（重装不覆盖原始 `.bak`，回滚语义=装前原件）；新增 `--force` 覆盖重导通道（与 import-dbeaver 同语义，默认仍忽略已有配置时传入的 .dbp 防误覆盖）。

**自测**：selftest +5 项 → **277 项断言**（未初始化 263，含 crypt-cli encrypt→rekey→decrypt 真 CLI 往返）+ mysql-validate 新套件 **17 项**（实测 2026-10-03 全绿：selftest 277/263、sqlite-validate 76、mysql-validate 17，全部 0 failed）。

### V1.6.0（四轮审查：column_stats 分布画像 + 安全面复查确认）

**新能力**

- **column_stats 直方图（`histogram: { buckets: N }`）**：数值列等宽桶频数分布——单条 CTE 语句
  （rng 求值域 → buckets 求桶宽 → 逐行算桶号 → 按桶聚合），2-50 桶；NULL 不入桶；值=上界的行
  归入末桶（`LEAST`/`MIN` 方言封顶）；`hi=lo` 时桶宽 1.0 防除零。返回 `bucket_index/bucket_lower/
  bucket_upper/row_count`。实测 sqlite 真实库：0..99 共 100 行 10 桶每桶恰 10 行，配 `where`
  仅计入匹配行（50 行）。
- **column_stats TopN（`top_values: { limit: N }`）**：高频值及计数，频数降序 + 值升序（结果稳定
  可复现），NULL 排除，1-100 名。实测：50/30/20 三值列 Top2 = a:50、b:30。

**审查确认（无改动）**

- 四轮全链路扫描：只读守卫对 CALL/DO/SET/USE/ATTACH/PREPARE/EXECUTE/DISCARD/LISTEN/NOTIFY/
  COPY/VACUUM/EXPLAIN ANALYZE DML 全部拒绝（前缀白名单）；execute 仅 INSERT/UPDATE/DELETE；
  SQLite PRAGMA 白名单拒写类 pragma（journal_mode/writable_schema 等）；RPC 分发串行化
  （queue 逐条 await），单进程内 export/import 无并发竞态——跨进程共享白名单目录属部署边界，
  记录不做。

**自测**：+2 项 → **272 项断言**（未初始化 258）+ sqlite-validate +5 项 → **76 项**（实测 2026-10-03 全绿）。

### V1.5.3（可观测性 + 事务语义：慢查询日志 / export 耗时回报 / import 原子模式）

**新能力**

- **慢查询日志**：语句超过 `DBMCP_SLOW_MS`（默认 2000ms，0 = 关闭）时向 stderr 打一行
  `source + 耗时 + 语句类型 + 截断 160 字符预览`；SQL 先过输出清洗（口令字面量不随日志外溢）。
  实测触发：阈值 1ms 下 sqlite 大查询日志格式与 scrub 均正确。
- **import_data `atomic`（全文件单事务）**：`atomic: true` 时整个文件在一个事务里提交，任一批
  失败整体回滚（明确报"已全部回滚，未写入任何行"）；默认模式维持批原子 + 逐行回退定位坏行
  （保留此前行）。mysql/pg 池有 2 连接，事务语句钉在独占单连接上执行（`getConnection`/`connect`），
  否则 `pool.query` 换连接即事务失效。**实测**：sqlite 真实库 250 行 3 批提交/冲突回滚/非原子对照
  三态语义锁定；MySQL 真实库专用探针库上提交/回滚 6/6 通过（探针库已清理）。
- **export_data 耗时回报**：返回新增 `duration_ms`。

**自测**：+2 项 → **270 项断言**（未初始化 256）+ sqlite-validate +7 项 → **71 项**（实测 2026-10-03 全绿）。

### V1.5.2（遗留 P2 清尾：驱逐不掐忙池 + db 名编码 + 错误映射 + 导入逆变换）

**安全修复 / 加固**

- **连接池驱逐不掐忙池**：池表超 LRU 上限时只关「最旧的空闲池」，有在途查询的池跳过、
  全忙则本轮不驱逐——旧行为无条件关最旧池，超时僵尸查询仍在服务端执行时被逐池关闭，
  在途连接被掐断报错面不可控（`chooseEviction` 纯函数 + runQuery 在途计数）。
- **DBeaver 导入 db 名百分号编码**：源 URL 组装抽为 `buildSourceUrl` 纯函数，user/password/
  database 统一 `encodeURIComponent`——旧版 db 名裸拼，库名含空格/斜杠/问号会破坏 URL 结构
  （pathname 截断、`?` 后内容混入 search）；消费端（mysql2 parseUrl / pg-connection-string /
  server 展示层）均已解码，往返一致。

**正确性修复**

- **旧格式密文错误映射**：legacy 密文损坏时驱动抛裸 OpenSSL 错误（实测
  `error:1C800064:Provider routines::bad decrypt`），`decryptAny` 映射为可诊断的中文说明
  （保留原文片段）；长度检查类既有中文错误保持原样。
- **import_data `strip_neutralization` 逆变换**：export 默认公式中和（`'=1+1`）后导入会带上
  中和撇号——新参数做精确逆变换（仅剥 `'` 后跟公式起始符的单元格，普通前导撇号不动），
  返回 `neutralization_stripped` 计数；默认关闭保持文件原样。往返无损已实测（sqlite 真实库）。
  附带修正：值变换一次性前移，批失败回退逐行不再重复转换。

**自测**：+4 项 → **268 项断言**（未初始化 254）+ sqlite-validate +5 项 → **64 项**（实测 2026-10-03 全绿）。

### V1.5.1（三轮审查：导出早停 + 清洗补洞 + 命令注入面收口）

**安全修复 / 加固**

- **export_data 组装期字节早停**：CSV 逐行累计字节，超过 20MB 上限立即中止并如实报"未写盘"——旧版整表拼完
  再查上限，超限导出会先把内存吃到峰值才拒；JSON 路径无逐行结构保留执行后检查。
- **口令清洗补洞（scrub）**：`user:pass` 结构化形态（连接串泄露最常见形态）无论口令长短一律清洗（含 URL 编码
  变体，替换后保留 `@` 分隔符）；裸口令仍仅 ≥4 字符参与清洗（1-3 字符替换会把正常文本打成筛子）；短口令源
  启动时打印警告提示换强口令。旧行为 1-3 字符口令完全不清洗且无提示。
- **crypt-cli `--config` 缺值 fail-closed**：`--config` 后缺路径时明确报错退出，绝不静默回退默认配置
  （旧行为 rekey 可能改写用户没打算动的配置文件）。
- **PowerShell 命令注入面收口**：DBeaver 导入解包回退的 `Expand-Archive` 路径插值改经 `psSingleQuote`
  （单引号内 `'` 双写）——临时目录/用户名含 `'` 时不再截断单引号注入命令。
- **sqlite-add 打开校验**：`node:sqlite` 打开是懒校验（垃圾文件 open/close 不报错，首次读页才抛
  SQLITE_NOTADB），现 PRAGMA 真读一次页确认是 SQLite 库，打不开给出明确原因且配置不落盘。

**正确性修复**

- **重复列名消歧回归锁定**：sqlite 真实库断言 `SELECT 1 AS id, 2 AS id` 两列值都保留（驱动 `:N` 消歧）。

**自测**：+5 项 → **264 项断言**（未初始化 250）+ sqlite-validate +1 项 → **59 项**（实测 2026-10-03 全绿）。

### V1.5.0（二轮审查：注入面收口 + 密钥绑定 + 数据完整性）

**安全修复 / 加固**

- **crypt2 主密钥绑定（enc2 格式）**：新格式 `enc2:` + base64(salt‖IV‖GCM认证标签‖密文)，AES-256-GCM +
  scrypt（N=16384）派生密钥，绑定环境变量 `DBMCP_MASTER_KEY`（≥8 字符），认证标签防篡改（改一字节即报错）；
  旧格式（无前缀）按前缀分派照常解密（向后兼容）；`crypt-cli rekey [--config <path>]` 逐源升级（坏密文跳过并
  报告、失败即退出码非零，实测子进程走完整链路）；import-dbeaver / crypt-cli encrypt 在有主密钥时直接写 enc2。
- **CSV 公式注入中和（export_data）**：字符串单元格以 `=`/`+`/`-`/`@`/TAB/CR 开头时前置 `'`（OWASP 对策，
  防 Excel/Sheets 打开导出文件即执行公式）；数字/bigint 原样不中和（保数值语义）；`raw_formulas: true` 显式
  关闭；返回 `formula_cells_neutralized` 计数。sqlite 真实库实测：默认导出 `'=1+1`、raw 导出 `=1+1`。
- **quoteIdent 标识符转义**：内嵌反引号/双引号按方言双写（`` ` ``→``` `` ```、`"`→`""`）——旧版盲包裹，
  库内读回的表/列名（fkRelationships 等拼 PRAGMA/SQL 处）含引号即可逃逸出标识符位形成注入，现堵死。

**正确性修复**

- **重复列名消歧**：mysql/pg 改为数组行模式取回后重建行对象，同名列追加 `__N` 后缀（`id`、`id__2`…），
  值不再被驱动对象化时静默折叠；`query` 返回 `renamed_duplicate_columns`（新名→原名映射）。实测口径：
  sqlite 驱动自带 `:N` 消歧（`id`、`id:1`）；mysql 经 query 的自动 LIMIT 派生表对重复列名本就明确报错
  （ER_DUP_FIELDNAME，提示加别名）；消歧兜底覆盖 runQuery 通用调用路径与 pg。
- **前导注释解析修复**：`isReadOnlyPragma` 与 sqlite 读写分流首词判定先剥前导注释——旧版 `/* c */ PRAGMA …`
  被误判非白名单拒绝、`/* lead */ INSERT` 被误判为读（影响行数丢失），实测两路径均修复；MySQL 可执行注释
  （`/*!`、`/*M!`）是代码不是注释，fail-closed。

**自测**：+16 项 → **259 项断言**（未初始化 245）+ sqlite-validate +4 项 → **58 项**（实测 2026-10-03 全绿）。

### V1.4.1（全链路审查修复：安全红线补洞 + 导入批量化 + 门禁假绿修正）

**安全修复（P1，审查实测确认可绕过/可放大）**

- **create_table 漏拦无 AS 的 CTAS**：MySQL 允许 `CREATE TABLE t SELECT * FROM ...`（省略 AS），旧版正则只拦
  `AS SELECT`——实测可绕过 allowWrites 用建表权限整表拷数据。现按"建表语句尾部出现 select/table/values/execute
  或非括号 WITH"拦截；`CREATE TABLE ... LIKE`、`GENERATED ALWAYS AS (表达式)`、MariaDB `WITH SYSTEM VERSIONING`、
  PG `WITH (fillfactor=…)` 存储参数实测不误伤（回归锁定）。
- **只读守卫黑名单补管理/破坏性函数**：`pg_terminate_backend`/`pg_cancel_backend`/`pg_reload_conf`/
  `pg_advisory_lock` 族/`pg_sleep` 族/`set_config`/`lo_create`/`lo_unlink`/`lo_truncate`、MySQL `SLEEP`/`GET_LOCK`/
  `RELEASE_LOCK`/`BENCHMARK`、SQLite `load_extension`、`dblink_exec`/`dblink_connect` 等调用形态一律拦截
  （旧版 `dblink` 词边界漏 `dblink_exec`）；按"函数名 + ("调用形态判定，`sleep_status`/`set_config` 之类同名列不误伤。
- **import_data 批失败回退的重复插入风险**：批失败一律回退逐行的旧策略，在超时/连接中断类错误下可能重复插入
  （mysql2 超时不取消服务端已发出的语句）。现先分类：结果未知类错误（timeout/连接中断/`08*`/`57P01` 等）
  **安全中止、不回退**，回报"可能已写入，请 count_rows 核对"；仅约束/数据类错误才回退逐行定位坏行。
- **import_data 占位符方言**：postgres 扩展协议只认 `$n`，旧版对 PG 源用 `?` 必炸（审查发现，已修复并回归）。
- 行宽预检：任何写入前整批校验行宽，文案如实"未写入任何行"（旧版批内报错会虚报已写入行数）。
- `distinct_values` 守卫掩码方言统一到 `maskDialect`（sqlite 归 PG 语义，旧版按 MySQL 反斜杠语义掩码）。

**导入性能**

- 升级为批量参数化 INSERT（默认 100 行/条多 VALUES 语句，pg 占位符 `$n`），仍全参数化——注入面为零不变；
  批失败逐行定位坏行后中止，已写入行数如实回报。

**install.mjs 加固**

- Claude CLI 注册改手工引号处理：Windows `cmd /c` + shell:true 存在参数注入面（路径含 `&|^()%!"` 等元字符时
  跳过 CLI 注册、提示改用 JSON 合并注册；含空格路径正确加引号）；`--registry=` 真实透传给 npm ci（旧版忽略）；
  坏配置 JSON 不再崩（两处读取均 try/catch）；已存在配置时提示 `.dbp` 将被忽略；导出/导入目录提示按工具对称。

**门禁可信度（假绿修正）**

- sqlite-validate 一条恒真断言（`false || true`）改为真实断言；selftest tools/list 由"13 工具子集"改为
  **16 工具精确集**断言；新增批回退/结果未知分类（12 例）、行宽预检与 250 行 3 批导入真实库测试、
  导出/导入目录门禁测试、crypt 错误路径测试、安装器环境变量契约测试。

**自测**：+30 项 → **243 项断言**（未初始化 229）+ sqlite-validate +6 项 → **54 项**（实测 2026-10-03 全绿）。

### V1.4.0（CSV 导入 + 连接层拆分）

**新工具（16 个）**

- **`import_data`**：CSV → 表，与 export_data 对称。安全边界：
  1) 文件白名单——`DBMCP_IMPORT_DIR`（未设置时回退 `DBMCP_EXPORT_DIR`，都未设置即拒）；
  2) **注入面为零**——参数化 INSERT（本版逐行，V1.4.1 起批量 100 行/条，见上），CSV 单元格永不拼接进 SQL 文本；表头即列名，
     仅接受裸标识符（`bad-col;DROP` 实测被拒）；
  3) 走 `allowWrites` 开关；行宽不一致即整批中止（已写入行数如实回报）；
  4) 容量上限 10000 行 / 20MB；`emptyAsNull` 可把空单元格映射为 NULL；
  5) RFC 4180 解析（引号内逗号/换行/双引号转义），export→import 往返实测内容无损。

**结构**

- **`pool.mjs` 拆分**：三库连接管理（mysql2/pg 池 + node:sqlite）与 runQuery 读写分流
  迁出 server.mjs（依赖注入 cfg/getSource，可独立加载）；server.mjs 1673 → ~1570 行。

**实测否决的一项设计**

- SHOW 大结果集白名单包裹：活库实测 MySQL 8 **不接受** `SELECT * FROM (SHOW ...)`（全部语法错误），
  包裹方案不可行——维持 SHOW 原样返回 + 执行后截断兜底，并以回归用例锁定「SHOW 不包裹」。

**自测**：+2 项（parseCsv/SHOW 不包裹）：**213 项断言**（未初始化 199）+ sqlite-validate 48 项
（新增 import 闭环 9 项：往返、引号逗号内容、恶意表头、缺文件、行宽中止）。

### V1.3.0（数据画像 + 结果导出：新工具 ×2）

**新工具（15 个）**

- **`column_stats`**：单列画像一条聚合搞定——`row_count` / `non_null` / `distinct_values` /
  `min_value` / `max_value` / `avg_value`（文本列 min/max 为字典序），支持 `where`。
  空值率、值域、基数的速查工具（大表上 `COUNT(DISTINCT)` 全扫，建议配 where）。列名仅接受
  裸标识符；拼装语句整体过只读守卫。V1.6.0 起可选 `histogram: { buckets: N }`（数值列等宽桶
  频数，2-50 桶，NULL 不入桶，值=上界归末桶）与 `top_values: { limit: N }`（高频值 TopN，
  频数降序/值升序稳定次序）——各为一条独立的白名单拼装语句，同样过只读守卫。
- **`export_data`**：只读 SELECT 结果导出 CSV / JSON 文件。**写盘安全边界**：
  1) 目录白名单——必须设置 `DBMCP_EXPORT_DIR`（服务端环境变量），未设置即拒绝；
  2) 文件名清洗——路径分隔符等危险字符替换为下划线（`../` 变 `.._`），越界即拒（双保险）；
  3) 覆盖保护与原子落盘——目标已存在需显式 `overwrite: true`；V1.6.1 起落盘走 writeFileAtomic
  （同目录唯一临时文件 + `link` 原子占位 / `rename` 原子替换），跨进程同名互斥、内容无交错，
  Windows 并发替换瞬态 EPERM 自动重试；
  4) 容量上限——20MB；
  5) 内容只读——语句过只读守卫 + 独立行数上限（默认 5000，上限 100000），落盘内容同样过 scrub。
  CSV 按 RFC 4180 转义（引号/逗号/换行），JSON 用统一 `stringify()`（BigInt→字符串、Buffer→hex）。
  **E2E 实测抓到并修复两个 bug**：`safeExportPath` 对 `".."` 的清洗绕过；JSON 分支对 BigInt 的
  序列化崩溃。

**其他**

- SQLite 源级 `wal: true` 选项（多进程同开一个 .db 文件时提升读写并发，会产生 -wal/-shm 边车文件）；
- `install.mjs` SQLite 能力提示（Node ≥ 22.5，非阻断）；
- 自测 +3 项（column_stats 形状/路径防穿越/CSV 转义）+ 活库验证 +11 项：**211 项断言**
  （未初始化 197）+ sqlite-validate 39 项。

### V1.2.1（括号复合查询 + SQLite 只读 PRAGMA 白名单）

- **可用性修复**：`(SELECT ...) UNION ...` 等括号开头的复合只读查询不再被一票拒绝
  （旧版 fail-closed；非安全洞）。SQLite 派生表不接受括号开头 compound（实测 near "(" 语法错误），故此类语句不包外层 LIMIT，行数由执行后截断（rows.slice + truncated）兜底；
  括号包裹的 DML 与括号后的写词/外泄通道照常拦截（回归锁定）。
- **SQLite 只读 PRAGMA 白名单**：`query` 对 sqlite 源放行 `table_info/table_list/index_list/
  index_info/foreign_key_list/database_list/schema_version`（只读元数据）；任何会改设置的
  pragma（journal_mode、writable_schema 等）仍被拒。白名单为导出纯函数 `isReadOnlyPragma`（有单测）。
- `npm run validate:sqlite` 脚本；`install.mjs` 增加 SQLite 能力提示（Node ≥ 22.5，非阻断）。
- 自测 +4 项：**208 项断言**（未初始化 194）。

### V1.2.0（SQLite 支持 + 活库全功能验证）

**新数据源类型：本地 SQLite（16 个工具全部可用）**

- 驱动：Node ≥ 22.5 内置 `node:sqlite`（`DatabaseSync`），**零新增 npm 依赖**；不用 SQLite 的部署
  惰性加载，Node ≥ 18.17 兼容不变。
- 源配置：`{ "type": "sqlite", "url": "sqlite://D:/data/x.db" }`（本地文件无凭据，无需加密）；
  一键建库/注册：`node mcp\sqlite-add.mjs <文件.db> [--allow-writes] [--allow-create-table] [--force]`
  （文件不存在自动创建；测试期最高权限 = 两个开关全开，安全红线不受开关影响始终生效）。
- 全工具适配：list_tables（sqlite_master）/ describe_table（PRAGMA table_info/index_list/index_info，
  approx_rows 为精确 COUNT）/ find_tables_by_column（遍历 + JS 大小写不敏感匹配）/
  fk_relationships（PRAGMA foreign_key_list）/ query_plan（`EXPLAIN QUERY PLAN`）/
  distinct_values / count_rows / sample_data / execute（影响行数取 `run().changes`）。
- 一致性细节：INTEGER 超安全整数经 `setReadBigInts(true)` 以字符串返回（与 mysql bigNumberStrings /
  pg int8 三库对齐）；SQLite 字符串无反斜杠转义，词法掩码按 PG 语义处理（`'a\'; DROP…'` 拆串写法
  在 SQLite 上同样被拦）；`busy_timeout` 对齐 timeoutMs；多语句在 prepare 层仅执行首条（第二条被忽略），
  词法守卫仍先行明确拒绝。
- 安全行为实测（sqlite-validate.mjs，28 项断言全绿）：建表/DROP 拒绝/CTAS 拒绝、外键强制
  （孤儿插入报错）、INSERT/UPDATE/DELETE 影响行数、写后 count 验证、JOIN、红线
  （无 WHERE 的 DELETE、WHERE 1=1、恒真 OR 分支、query 工具拒写、影响行数预检 4 行 > cap 拒绝且零副作用）。
- 自测 +4 项（路径解析/方言映射/SQL 形状）：204 项断言（V1.2.0 时点：未初始化 190，已初始化 204）。

### V1.1.1（结构拆分 + 双方言测试矩阵 + 外键发现）

**新工具（13 个）**

- **`fk_relationships`**：外键关系发现（`表.列 -> 引用表.列`），单表过滤或全 schema 列举
  （默认 200、上限 1000），返回可读的 join 提示列表——写跨表 JOIN 前先看参照完整性
  （MySQL `KEY_COLUMN_USAGE` / PG 三表 join，参数化查询）。

**结构（可审计性）**

- **`guard.mjs` 拆分**：SQL 安全核心（词法掩码 / 只读与写守卫 / 恒真 WHERE 判定 / 写目标解析 /
  enforceLimit / createTable 守卫）从 server.mjs 迁出为**纯函数、零依赖**的独立模块，可独立审计；
  server.mjs 导入自用并重导出，对外 API 面不变（重导出与 guard.mjs 本体的同一性有断言锁定）。
- **`dbeaver-parse.mjs` 拆分**：JDBC URL 解析（内嵌凭据/百分号解码）、环境词元映射、source id
  清洗抽为纯函数并接线回 import-dbeaver.mjs——导入器逻辑首次获得 fixture 单测覆盖。
- `sampleSql` / `countRows` 的 where 校验去重为 `guard.checkWhereFragment`（与 distinct_values 共用）。

**测试**

- **守卫双方言矩阵**：10 组 payload ×（MySQL/PG 期望）表格驱动，锁定词法层契约——
  防「修 A 方言破 B 方言」（dollar-quote 标签修复时曾出过此类中间态 fail-open）；
- DBeaver 解析 fixtures（URL 四形态、环境十组词元、ID 清洗）与 fk 构造用例。
- 自测 182 → **200 项断言**（未初始化 168 → 186）。

### V1.1.0（功能扩展：发现与分析工具 ×3 + stdio 加固）

**新工具（12 个）**

- **`find_tables_by_column`**：按列名关键字（子串、大小写不敏感）反查包含该列的表，返回列名/类型/
  是否主键/注释与去重表名列表——「知道 `order_no` 但不知道在哪张表」的定位利器
  （MySQL `information_schema.COLUMNS` / PG `pg_attribute` 双实现，参数化查询）；
- **`query_plan`**：对单条 SELECT/WITH 执行 `EXPLAIN`（`format: text|json`），**不执行语句本身**
  （不支持 ANALYZE）。内层语句先过只读守卫（拦 `FOR UPDATE`/`INTO OUTFILE` 等），EXPLAIN 整句
  再过一次（纵深防御）；跑昂贵查询前先看索引与行数估算；
- **`distinct_values`**：某列取值分布 Top-N（`GROUP BY + COUNT ... ORDER BY cnt DESC`，默认 20、
  上限 200）+ 精确去重总数（两查并行），支持 `where` 过滤。枚举/状态列理解与数据核对的利器
  （对比观测值集合 vs 预期集合）。列名仅接受裸标识符（防注入）；拼装语句整体过只读守卫
  （与 count_rows 同标准，`where` 塞行锁写法在此被拦）。

**stdio 加固**

- 请求处理**串行化**：响应严格按请求到达顺序写出（旧版 async 回调并发，响应可能乱序，
  与「MCP 调用是串行的」设计假设不符）；
- 单行长度上限（2MB）：超长 JSON 行回 `-32600` 后丢弃，防内存放大；
- 写出带 flush 回调，缓解大响应的 stdout 背压。

**自测**：新增 12 项（新工具 SQL 构造/守卫行为/真实调用链），182 项断言（未初始化 168 项）。

### V1.0.3（守卫方言感知：两族掩码绕过修复）

**🔴 守卫绕过修复（两族「掩码语义 ≠ 数据库语义」的盲区，均在守卫层实测复现）**

- **注释族（MySQL 方向）**：
  - `--` 后必须跟 ASCII 空白/控制字符才是注释——`SELECT 1--1 INTO OUTFILE '...'` 中 `1--1`
    实为 `1-(-1)`，旧版把 `1 INTO OUTFILE` 当注释抹掉而放行（服务器文件写入通道）；
  - JS `\s` 覆盖 NBSP/全角空格/行分隔符，用它判断会重新制造"多抹"，改按 `[\x00-\x20\x7f]` 判定；
  - MySQL/MariaDB **可执行注释**（`/*!...*/`、`/*M!...*/`）是代码而非注释，一律拒绝
    （优化器提示 `/*+ ... */` 不受影响）；
  - `#` 仅 MySQL 是注释（PG 中是运算符，不再误抹）。
- **字符串族（PG 方向）**：
  - PG（`standard_conforming_strings=on`，9.1 起默认）普通 `'...'` 内反斜杠是**字面量**，字符串比
    MySQL 转义语义早一个引号结束——`'a\'; DROP TABLE t -- '` 这类写法的 `; DROP` 被旧版误判在
    字符串内而放行，且旧版 PG 走简单查询协议时多语句会真实执行（已实测守卫层放行）。现仅
    `E'...'` / `U&'...'` 转义串内反斜杠作转义；`"..."` 定界标识符不再按反斜杠转义；
  - **驱动层纵深**：PG 分支强制 `queryMode: "extended"`（扩展查询协议，天然单语句）——旧版
    `values` 为空数组时 pg 走简单查询协议，多语句可真实执行；MySQL 侧 `multipleStatements: false` 兜底不变。
- 守卫链路全量**方言透传**：`query` / `execute` / `sample_data` / `count_rows` / `create_table` /
  影响行数预检全部按源类型选择掩码语义（`mysql` / `postgres`）。

**🔴 其他安全 / 正确性**

- `count_rows` 拼装后的语句补过只读守卫：`where` 里塞 `FOR UPDATE` / `LOCK IN SHARE MODE`
  会拿到行锁并阻塞写事务（`sample_data` 原本就有这层，`count_rows` 漏了）；COUNT 构造抽成
  可单测的纯函数 `countSql`。
- `create_table`：拒绝 CTAS（`CREATE TABLE ... AS SELECT` 写数据，绕开 `allowWrites` 开关）；
  执行改用**原文**（旧版执行脱敏文本，任何带 `COMMENT 'x'` / `DEFAULT 'x'` / `` `db`.`t` `` 的
  DDL 必然语法错误）；表名提取先抹注释（旧正则遇注释退化成 `(unknown)`、遇库名限定只取到 `db`）。
- **dollar-quote 等长不变量修复**：旧版把「绝对结束下标」当增量用，含 `$$` 的语句掩码输出比
  输入长（实测 47 字符掩出 63 字符），`extractWriteTarget` 回切原文错位 → 影响行数预检的
  WHERE 片段可能取错。
- **dollar-quote 标签字符集（复核轮）**：标签按 PG scan.l 的 `dolqdelim` 规则识别（字母/下划线开头、
  仅字母/数字/下划线）——旧正则不认 `$tag1$`（合法语句被误报 multi-statement）；中间形态（标签续写类
  含 `$`）会贪婪吞掉 `$t1$x$t1$` 整段 opener、把真实第二语句掩进字符串（fail-open），一并规避，
  5 项边界（嵌套 `$$`、位置参数 `$1$`、串后真实 DROP 等）实测正确。
- **嵌套 WHERE 与恒真 OR 分支（复核轮新增）**：
  - `extractWhereClause` 改取第一个**顶层**（括号深度 0）WHERE——旧版取「最后一个 WHERE」，
    `WHERE 1=1 OR id IN (SELECT … WHERE u.x=1)` 的预检 COUNT 拿到子查询片段（目标表上报
    Unknown column）→ 预检失败回退词法 → 整条链放行（实测复现）；
  - 词法层新增**OR 分支判定**：任一顶层 OR 分支不引用列（`WHERE status=1 OR 1=1`、`OR true`）
    即拒绝——文档原将此类写法划归语义预检拦截，现前置到词法层，语义预检退为纵深防御；
    括号内 OR、字符串里的 "or"、AND 链中的恒真子项（`a=1 AND 1=1`，不扩大结果集）均不误伤。
- `enforceLimit` 对异常语句（可执行注释/多语句）显式报错，不再抛
  `Cannot read properties of undefined`。

**协议 / 体验 / 维护**

- `initialize` 按规范回「服务端支持的版本」（2024-11-05 / 2025-06-18），未知版本不再被原样回显确认；
- 自动 LIMIT 包裹撞 MySQL 派生表重名列（`ER_DUP_FIELDNAME`）时，提示为重名列加别名而非透传原生错误；
- 导入器环境识别按**词元**匹配（DBeaver 文件夹 "latest" 不再误判为 TEST 环境）；
- 影响行数预检的非原子性（TOCTOU：计数与执行是两次往返）在代码注释中如实标注；
- `VERSION` 改以 package.json 为单一真相源（文件缺失时回退硬编码值），消除三处手改漂移；
- `install.mjs` 解析 selftest 机器可读汇总行（旧版数 PASS/FAIL 字样，报错文本可干扰计数）；
- `crypt-cli.mjs decrypt --stdout`：解密结果仅打印不落盘（维护时明文 url 不再持久化）；
- `scrub()` 增加 includes 预判（口令未出现时不再反复重建字符串）。

**自测**：120 → **170 项断言**（未初始化 109 → 158），新增两族方言绕过回归（含完整可利用 payload）、
`count_rows` 行锁、CTAS 全形态、dollar-quote 等长性、`pg` 驱动 `queryMode` 协议回归
（pg 升级若影响扩展协议强制会先于真实库暴露）、协议版本回退等。

### V1.0.2（导入器凭据卫生）

**🔴 安全 / 卫生**
- **修复导入器临时目录从不清理**：`import-dbeaver.mjs` 把 `.dbp` 解包到系统临时目录后从不删除，
  每次导入都会在 `%TEMP%` 永久留下一份含 `credentials-config.json`、`data-sources.json` 的目录
  （实测本机累积 16 个目录、50 个凭据文件、11.7MB）。现于正常结束、异常退出、`SIGINT`/`SIGTERM` 时均保证删除。
- 临时目录基址改用 `os.tmpdir()`：旧版 `(TEMP || TMP || ".")` 在环境变量缺失时会把凭据解包到**当前目录**。



**🔴 全链路测试新发现（stdio 协议 / 双库实测）**
- **JSON-RPC 通知违规回复**：无 id 的已知方法请求（如通知形式的 `tools/list`）会收到一条没有 id 的响应，
  违反 JSON-RPC 2.0「通知不得回复」。现任何无 id 请求一律不回复。
- **批量请求被静默丢弃**：旧式客户端发 JSON-RPC 批量数组时，服务器直接丢弃且无任何响应（客户端永久挂起）。
  现回单条 `-32600`（MCP 2025-06-18 已移除批量支持，但静默丢弃比报错更糟）。
- **🔴 MySQL BIGINT 精度被静默篡改**：超过 JS `Number.MAX_SAFE_INTEGER` 的整数（雪花 ID 普遍如此）
  被 JS 浮点截断——实测 `9223372036854775807` 返回成 `9223372036854776000`。模型拿到错 id 再用于 WHERE
  会操作错行。MySQL 池现开启 `bigNumberStrings`，BIGINT/DECIMAL 一律返回精确字符串（与 PG 的 int8 行为对齐）。
- **导入器丢弃 URL 内嵌凭据**：DBeaver 的 `configurationType=URL` 若写成 `jdbc:mysql://user:pass@host:port/db`，
  旧版正则整体失配 → host/database 全空、凭据静默丢失，生成 `mysql://:@:3306/` 这种废连接串。
  现支持可选 `user:pass@` 前缀（命名分组解析），凭据优先取 DBeaver 凭据库、URL 内嵌作兜底。

**体验**
- 二进制单元格从 `<binary 4 bytes>` 变为 `<binary 4 bytes: deadbeef>`（前 8 字节十六进制预览），
  BINARY(16) 主键/UUID 场景下可以辨认行了。
**🔴 守卫绕过（本轮对抗性测试发现，均已在真实库/真实 SQL 上复现）**
- **函数名被当成列引用**：`whereHasColumn` 原先把任何「非关键字标识符」都算作列，于是
  `WHERE length('ab')=2`、`WHERE upper('x')='X'`、`WHERE COALESCE(NULL,1)=1`、`WHERE EXISTS (SELECT 1)`
  这类**不引用任何列**的恒真条件被判为合法，可直接全表更新/删除。现规则：标识符后紧跟 `(` 者为函数名，
  其本身不计为列；函数实参中的裸标识符（如 `length(name)` 的 `name`）仍照常计为列。
  同时补齐子查询关键字（`select`/`from`/`join`…），此前 `WHERE EXISTS (SELECT 1)` 里的 `select` 也被当成列。
- **`LOCK IN SHARE MODE` 未被拦截**：该 MySQL 共享锁语法与 `FOR SHARE` 同类（阻塞写事务），
  旧版只拦 `FOR SHARE`。现已一并拒绝。

**🔴 生成 SQL 语法错误**
- **末尾行注释吞掉包裹括号**：自动 LIMIT 的外层包裹原为单行拼接，若 SQL 以 `--` 或 `#` 注释结尾，
  注释会把右括号一起吃掉，生成 `You have an error in your SQL syntax`（已在真实 MySQL 上复现）。
  收尾括号现独占一行，行注释被换行终止。

**参数校验**
- 用户传入的 `limit` / `max_rows` 非法值原先被**静默夹成 1**（`limit=-5`、`limit=0`、`limit="abc"`
  都只返回 1 条，且无任何提示，比报错更容易误导）。现改为明确报错；缺失用默认值、超大值仍夹到上限。
**维护**
- `install.mjs` 的 Node 版本判断真正匹配 `engines: >=18.17`（旧版只比主版本，18.0～18.16 被误放行）。
- `package-lock.json` 根包版本与 `package.json` 对齐（此前停留在 1.0.0）。
### V1.0.1（安全与成本优化）

**安全（重要）**
- 🔴 **修复安全红线绕过**：旧版只识别 `WHERE 1=1` / `WHERE true` 两种恒真写法，`WHERE 1`、`WHERE 2>1`、
  `WHERE 'a'='a'`、`WHERE true=true` 等**可直接全表删除/覆盖**。现改为「WHERE 必须引用至少一个列」的泛化判定。
- 🔴 **新增语义级预检**：execute 前用同一 WHERE 先 `COUNT(*)`，超过 `maxAffectedRows`（默认 500）即拒绝并回报命中行数，
  拦住词法层无法判定的写法（如 `WHERE id IS NOT NULL OR 1=1`）。
- 只读守卫扩展：拦截 `pg_read_file`、`pg_read_binary_file`、`pg_ls_dir`、`pg_stat_file`、`pg_execute_server_program`、`dblink`。
- 导入器不再覆盖已有 `.gitignore`（旧版会抹掉 `node_modules/` 等条目）；`allowCreateTable` 默认关闭，
  需显式 `--allow-create-table`（与 `allowWrites` 口径一致）。

**正确性**
- 🔴 **修复 `WITH ... LIMIT n` 语法错误**：旧版给 WITH 直接追加 LIMIT，生成 `... LIMIT 5 LIMIT 201`；现统一外层包裹。
- 修复 stdio 内部异常不回响应导致客户端永久挂起（现回 `-32603`）。
- `find_database` 的 `probe` 参数从"只在 schema 里"变为真正实现（并行 TCP 探测）。

**功能补齐（真实库验证驱动）**
- `sample_data` 新增 `where` 过滤，与 `count_rows` 共用同一套 WHERE 校验（多语句/写词拦截）。
- `sample_data` 的 `order_by` 现接受 `"column DESC"`：旧版只接受裸列名，传 `created_at DESC`（"看最新几条"这一最高频用法）
  会抛 `Invalid identifier`；方向经严格白名单校验，注入写法被拒。

**性能 / 大模型上下文成本**
- 响应默认紧凑 JSON：200 行结果实测省 31% 字符（约 3.2k tokens/次）；`DBMCP_PRETTY=1` 可恢复缩进。
- 超长单元格截断（默认 2000 字符）+ `truncated_cells` 计数，避免单列 TEXT 吃满上下文。
- `describe_table` 元数据查询并行化（MySQL 3 条 / PG 4 条），跨网 RTT 80ms 时约 320ms → 80ms。
- `list_tables` 增加 `name_like` / `limit`（默认 500）与 `truncated` 标记。
- 连接池收敛：每源 4 → 2 连接，池表加 LRU 上限 8（最坏 164 → 16 连接）。

**内部/结构**
- 新增 `tableRef()` 统一表引用构造（消除 MySQL/PG 分支重复与死代码三元）。
- source 类型归一化移到加载期，工具调用期不再改写共享配置对象。
- `create_table` 执行使用校验后的文本（此前丢弃守卫返回值）。
- 自测 54 → 89 项断言（新增红线绕过回归、WITH+LIMIT 回归、JSON 整形、写目标解析、probe、sample_data 构造等）。

### V1.0.0
- 初始版本：9 个工具（MySQL/PostgreSQL/OceanBase 只读 + 受控写入）、配置落盘加密、输出清洗、git 启动门禁。
