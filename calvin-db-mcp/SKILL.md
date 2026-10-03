---
name: calvin-db-mcp
description: 适用于需要查询、核对、操作 MySQL / PostgreSQL / OceanBase(MySQL模式) 数据库数据的任务——覆盖 TEST/PRE/UAT/DEV 环境、按任意库名定位数据源、执行 SQL、查看表结构、建表与增删改。不适用于：无 WHERE 条件的全表 UPDATE/DELETE、TRUNCATE 等破坏性操作（强制拒绝，即使用户要求）；首次使用需运行 install.mjs 安装内部 MCP 并导入 DBeaver 连接配置(.dbp) 完成初始化。内置安全红线与凭据保护。
---

# calvin-db-mcp — 多库数据操作技能（内置 MCP）

> **版本 V1.6.2** · 内置 MCP `1.6.2` · 自检 277 项断言（未初始化 263 项）· 安装见《部署说明.md》· 更新记录见 README.md「更新记录」

## 一、功能介绍

本技能内置一个完整的 MCP 服务器（`mcp/server.mjs`，stdio/JSON-RPC），为大模型提供跨 **MySQL / PostgreSQL / OceanBase(MySQL 模式)** 的数据操作与验证能力，覆盖 TEST / PRE / UAT / DEV 等环境数据源（取决于导入的 DBeaver 项目）。

### 16 个工具

| 工具 | 用途 | 只读 |
|---|---|---|
| `list_sources` | 列出全部数据源（类型/环境/主机/库名；**不含凭据**） | ✓ |
| `find_database` | 按库名/关键字/环境检索源；`probe: true` 并行 TCP 探测可达性 | ✓ |
| `list_tables` | 列出表/视图 + 预估行数 + 注释（`name_like` 过滤、`limit` 默认 500、返回 `truncated`）| ✓ |
| `describe_table` | 列结构（类型/可空/默认值/主键/索引/注释） | ✓ |
| `find_tables_by_column` | 按列名关键字反查表（列名/类型/主键/注释）——「知道列名不知道表」时用 | ✓ |
| `fk_relationships` | 外键关系（`表.列 -> 引用表.列`，单表或全 schema）——写 JOIN 前看参照关系 | ✓ |
| `query` | 执行只读 SQL（SELECT/WITH/SHOW/DESC/EXPLAIN；单语句、自动 LIMIT、超时；含 `WITH ... LIMIT n`）| ✓ |
| `query_plan` | 对单条 SELECT/WITH 执行 EXPLAIN（text/json；不执行语句本身）| ✓ |
| `sample_data` | 抽样查看真实数据（≤50 行；支持 `where` 过滤、`order_by: "col DESC"` 看最新数据）| ✓ |
| `distinct_values` | 某列取值分布 Top-N + 精确去重总数（可带 where）——枚举/状态列核对利器 | ✓ |
| `column_stats` | 单列画像：行数/非空/去重数/最值/均值（可带 where）——空值率与值域速查 | ✓ |
| `export_data` | 只读查询结果导出 CSV/JSON 文件（需服务端 `DBMCP_EXPORT_DIR`；防穿越/20MB 上限） | 写文件 |
| `import_data` | CSV 导入表（批量参数化 INSERT，批失败逐行定位坏行；`DBMCP_IMPORT_DIR` 白名单（回退 `DBMCP_EXPORT_DIR`）；表头即列名；万行/20MB 上限） | 写库 |
| `count_rows` | 精确计数（可带 WHERE）——数据核对/前后对比核心工具 | ✓ |
| `create_table` | 单条 CREATE TABLE（需 `allowCreateTable=true`；**默认关闭**） | ✗ |
| `execute` | 单条 INSERT/UPDATE/DELETE（需 `allowWrites=true`；**必须带 WHERE**，且命中行数受 `maxAffectedRows` 预检） | ✗ |

### 安全设计（大模型可放心使用的原因）

- 配置落盘加密：连接串以 `enc` 字段加密存储（AES-128-CBC，DBeaver 26 同款格式），文件里无明文口令；
- 输出清洗：任何工具响应/报错统一清洗口令；
- 只读守卫：词法级防护（可写 CTE、INTO OUTFILE、行锁、`pg_read_file`/`pg_ls_dir`/`dblink` 全拦截）；
- 方言感知掩码（V1.0.3）：注释与字符串转义按源类型的真实语义处理——MySQL 的 `--` 空白规则与可执行注释
  （`/*!`/`/*M!` 开头是代码）、PG 的反斜杠字面量（`'a\'; DROP…'` 类拆串混淆）全部拦截；
  PG 侧另由驱动层扩展协议强制单语句，与掩码层构成纵深；
- 启动门禁：配置文件被 git 跟踪或未被 ignore 时拒绝启动；
- 未初始化安全：无配置时 server 正常启动并返回 init_required 引导，不泄露任何信息。

## 二、目录结构（**纯净包不含 node_modules 与任何 . 前缀文件/目录，不预置凭据**）

```text
calvin-db-mcp/
├── SKILL.md            # 本文档
├── README.md           # 项目总览 + 实测结果 + 更新记录
├── install.mjs         # 安装器：首次运行自动 npm ci 安装依赖 + 初始化 + 自检
├── 部署说明.md          # 部署与故障排查文档
├── 部署说明.详细版.md    # 全量部署细节（含环境变量表与注册 env 写法）
└── mcp/                # MCP 服务器（源码 + lock，依赖由 install 自动安装）
    ├── server.mjs / guard.mjs(SQL安全核心) / pool.mjs(连接层) / dbeaver-parse.mjs(导入器纯函数) / crypt.mjs(混淆) / crypt2.mjs(enc2 主密钥绑定) / crypt-cli.mjs / import-dbeaver.mjs
    ├── selftest.mjs（自检 277 项断言）/ sqlite-validate.mjs（SQLite 真实库验证 76 项）/ mysql-validate.mjs（真实 MySQL 全链路 29 项）/ sqlite-add.mjs（SQLite 建库注册）
    ├── package.json / package-lock.json
    ├── node_modules/   # npm ci 命令生成（纯净包不含；install.mjs 步骤 2 自动执行）
    ├── dbmcp.config.json  # 初始化导入后生成（enc 加密，勿入 git）
    └── .gitignore         # 装机导入时自动生成（纯净包不含 . 前缀文件；保护 dbmcp.config.json 不入 git）
```

## 三、首次安装（Agent 必须按序执行）

1. 进入技能目录：`cd <技能目录>/calvin-db-mcp`；
2. 运行 `node install.mjs` —— **自动安装依赖**（npm ci --omit=dev，需联网；内网可自行加镜像）→ 功能自检；
3. 若输出「尚未初始化」：**向用户索取 DBeaver 导出项目文件(.dbp) 路径**，然后运行：
   `node install.mjs "<.dbp 完整路径>" [--allow-writes] [--allow-create-table]`（自动解密凭据、过滤 MySQL/PG/OceanBase、加密生成配置、连通性预检）；
4. 将 step 5 输出的注册 JSON 写入客户端（或 `claude mcp add db -- node <技能目录>\mcp\server.mjs`），**重启客户端**；
5. 重跑 `node install.mjs` 确认「已初始化：N 个源」且 selftest FAIL=0。

> 用户导出 .dbp 的方法：DBeaver → 文件 → 导出 → 项目 → 勾选「包含连接凭据」。
> `--allow-writes` 放开 execute 写操作、`--allow-create-table` 放开建表（**默认均关闭**，与 `allowWrites`/`allowCreateTable` 对应；安全红线始终生效）。
> 导入后自检期望 `277 passed, 0 failed`；未初始化时 `263 passed, 0 failed`（SKIP 计入通过）。

## 四、MCP 客户端注册

```json
{ "mcpServers": { "db": { "command": "node", "args": ["<技能目录>\\mcp\\server.mjs"] } } }
```

- Claude Code：项目根 `.mcp.json` 或 `claude mcp add db -- node <技能目录>\mcp\server.mjs`；
- Claude Desktop：`%APPDATA%\Claude\claude_desktop_config.json`；
- Cursor：`~/.cursor/mcp.json`；
- 注册后必须重启客户端。

## 五、使用工作流（大模型调用规范）

1. **定位**：`find_database`（按库名/环境，如 TEST/PRE）或 `list_sources` → 选定 source id；
2. **摸结构**：`list_tables` → `describe_table`（列/主键/索引）；只知道列名时用 `find_tables_by_column` 反查表；跨表 JOIN 前用 `fk_relationships` 看外键关系；
3. **读取**：`query`（只读 SQL）/ `sample_data`（抽样）/ `distinct_values`（取值分布）；昂贵查询前用 `query_plan` 看执行计划；
4. **核对**：`count_rows`（前后计数对比、断言总数、查重）+ `distinct_values`（枚举列取值集合比对）；
5. **写入**：`execute`（单条 INSERT/UPDATE/DELETE）→ **写后必须用 `count_rows`/`query` 验证影响行数**；
6. **建表**：`create_table`（单条 CREATE TABLE）→ `describe_table` 验证；
7. 同实例跨库读取可用 `库名.表名` 限定。

### 使用示例（自然语言）

```
看看 TEST 环境有哪些数据源，ele_admin_api 库里有哪些表
```

```
查一下 t_order 的表结构和索引，order_no 上有没有唯一约束？
```

```
统计 t_order 昨天各状态的数量分布（SQL 先给我确认再执行）
```

```
帮我看看这条查询走不走索引：SELECT * FROM t_order WHERE user_id=1001 ORDER BY create_time DESC LIMIT 20
```

```
把这次查询结果导出成 CSV（服务端开了 DBMCP_EXPORT_DIR 才行）
```

```
核对一下 t_order 和 t_order_item 的行数对不对得上，昨天的
```

> 写类请求（INSERT/UPDATE/DELETE、建表、CSV 导入）先给影响行数与条件、经用户确认后才执行，写后必须 `count_rows` 验证；
> **无 WHERE 的全表 UPDATE/DELETE、TRUNCATE 一律拒绝**（见「六、安全红线」，即使用户明确要求）。

## 六、安全红线（最高优先级，强制——Agent 与 MCP 双层执行）

1. **无 WHERE 条件的 UPDATE / DELETE：一律拒绝执行**（会导致全表数据被覆盖/清空）。即使用户明确说「我就是要更新/删除全表」，也不得执行；必须告知用户：出于安全考虑本技能禁止该操作，如确有全表需求请通过 DBeaver 等人工渠道由 DBA 执行；
2. **TRUNCATE TABLE：一律拒绝**（等同于无条件清空全表），处理方式同上；
3. **不引用真实列的 WHERE 一律拒绝**（等同无 WHERE）：`WHERE 1=1`、`WHERE true`、`WHERE 1`、`WHERE 2>1`、
   `WHERE 'a'='a'`、`WHERE true=true` 等写法都拒绝。判定标准是「WHERE 是否引用了至少一个列」，而非穷举字面量。
   V1.0.2 起，**函数名与子查询关键字不算列**：`WHERE length('ab')=2`、`WHERE upper('x')='X'`、
   `WHERE COALESCE(NULL,1)=1`、`WHERE EXISTS (SELECT 1)` 同样拒绝（旧版会把 `length`/`EXISTS`/`select`
   误判成列而放行）；含真实列的函数调用（如 `WHERE length(name)=2`）仍正常允许；
   V1.0.3 起，**恒真 OR 分支同样拒绝**：`WHERE status=1 OR 1=1`、`OR true` 等任一顶层 OR 分支
   不引用列即等同全表操作（旧版依赖影响行数预检兜底，现词法层前置拦截）；
4. **字符串/注释中藏 WHERE 不算数**：守卫为词法级检查，已防绕过；
5. **影响行数预检（V1.0.1 新增）**：写操作执行前用**同一 WHERE** 先 `COUNT(*)`，命中行数超过 `maxAffectedRows`
   （默认 500；设为 `0` 表示关闭预检）即拒绝并回报实际行数——词法层之后的纵深防御
   （V1.0.3 起 `OR 1=1` 类写法已在词法层拦截，预检主要兜底括号内/AND 链等语义等价场景）。
   批量变更超限时应提示用户改用更精确的条件或由 DBA 人工执行，**不要**为绕过而调大上限；
6. **execute 默认关闭**（`allowWrites=false`），开启后红线依然生效且无任何覆盖开关；
7. **DDL 仅允许 CREATE TABLE**（需 `allowCreateTable=true`，默认关闭）；DROP/ALTER/TRUNCATE 及管理语句一律拒绝；
8. **写入前必须向用户确认目标表与条件；写入后必须用 `count_rows`/`query` 验证影响行数**；
9. **跨环境操作（尤其 PRE/UAT）必须先向用户二次确认目标环境**；
10. 凭据保护：任何输出不得包含 url/口令（server 已强制清洗）；`.dbp` 与 `dbmcp.config.json` 均按敏感文件对待，禁止入 git（导入时自动生成 .gitignore 保护）；

## 七、注意事项

- **BIGINT/DECIMAL 以字符串返回**（MySQL/PG/SQLite 三库一致）：超过 JS 安全整数（2^53-1）的整数——雪花 ID 普遍如此——会以字符串原样返回（如 `"9223372036854775807"`）。在 WHERE 里直接用该字符串即可（`WHERE id = '9223372036854775807'`），**不要**把它转成数字再传（会精度丢失）；
- **本地 SQLite（V1.2.0）**：`node mcp\sqlite-add.mjs <D:/path/x.db> [--allow-writes --allow-create-table]` 一键建库并注册源（需 Node ≥ 22.5 内置 node:sqlite，零 npm 依赖）。SQLite 无 `SHOW`/`PRAGMA` 直接查询（元数据走 describe_table/find_tables_by_column/fk_relationships）；`query_plan` 输出 `EXPLAIN QUERY PLAN`；建表主键写 `INTEGER PRIMARY KEY`（不要 AUTOINCREMENT，除非明确需要）；文件路径中的反斜杠在 url 里写成正斜杠（`sqlite://D:/data/x.db`）；
- 数据库账号遵循**最小权限**：只读场景用 SELECT-only 账号；MCP 层防护不是最终权限边界；
- OceanBase 走 MySQL 模式（协议兼容）；其账号需相应建表权限才能 `create_table`；
- 部分源需 VPN/白名单（`find_database` probe 与导入预检会标注不可达主机）；
- 同一 MySQL 实例内可用 `库名.表名` 跨库读取；跨实例需切换 source；
- `query` 对大表请尽量带条件，自动 LIMIT 默认 200 行；输出为紧凑 JSON，超长单元格会截断并标注；
- 配置项 `maxRows` / `maxAffectedRows` / `allowWrites` / `allowCreateTable` 位于 `mcp/dbmcp.config.json`，默认 200 / 500 / false / false；
- `export_data` / `import_data` 需在 **MCP 服务进程的环境**设置 `DBMCP_EXPORT_DIR` / `DBMCP_IMPORT_DIR`（import 未设置时回退 EXPORT_DIR）——写法是在客户端注册 JSON 的 `"env"` 块里加，示例见《部署说明.详细版.md》环境变量表。
- `DBMCP_MASTER_KEY`（可选，≥8 字符）：设置后密文升级为 enc2（AES-256-GCM 主密钥绑定，`crypt-cli.mjs rekey` 逐源升级）；CSV 导出默认做公式注入中和（`raw_formulas: true` 可关）。

## 八、排错速查

| 现象 | 处理 |
|---|---|
| install 提示「尚未初始化」 | 提供用户 .dbp 路径重跑，或 `node mcp/import-dbeaver.mjs <.dbp>` |
| `list_sources` 返回 init_required | 同上，导入后重启客户端 |
| `Access denied for user` | 账号无该库权限：换最小权限账号 |
| ECONNREFUSED/ETIMEDOUT | 主机不可达：VPN/白名单 |
| 依赖自动安装失败 | 检查网络/换镜像：`npm ci --omit=dev --registry=https://registry.npmmirror.com` |
| 自测 FAIL | 看 FAIL 行提示；未初始化时 SKIP 属正常 |
| 配置丢失 | 从源仓库或 `Documents\dbmcp-key` 备份恢复加密版配置 |

详细部署与安全设计：见《部署说明.md》。