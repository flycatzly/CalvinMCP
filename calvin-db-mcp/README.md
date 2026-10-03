# calvin-db-mcp

自研 MCP 服务器：**MySQL + PostgreSQL + OceanBase(MySQL模式) + 本地 SQLite** 多库操作，支持 TEST/PRE 等多环境源，为大模型调用与数据验证设计。
stdio 传输 / JSON-RPC 2.0，协议层零框架，仅依赖 `mysql2` 与 `pg` 两个驱动（SQLite 用 Node ≥ 22.5 内置的 `node:sqlite`，零额外依赖）。

> **实测 2026-10-03（V1.6.2，Node v24.15.0）**：selftest `277 passed, 0 failed`（未初始化口径 263）·
> sqlite-validate `76 passed, 0 failed` · mysql-validate `29 passed, 0 failed`（真实 MySQL 全工具面：元数据发现/读链/事务/导出导入/建表/红线零副作用）·
> 16 工具经真实库验证（MySQL 真实库 + SQLite demo）。

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
| `sample_data` | 抽样看表数据（默认 10 行，最多 50，支持 `where` 过滤与 `order_by` 升/降序） | ✓ |
| `distinct_values` | 某列取值分布 Top-N（GROUP BY 计数，默认 20 上限 200）+ 精确去重总数，可带 `where` | ✓ |
| `column_stats` | 单列画像一条聚合搞定：行数/非空/去重数/最值/均值，可带 `where`；V1.6.0 起可选 `histogram`（数值等宽桶频数）与 `top_values`（高频值 TopN）——空值率、值域与分布形态速查 | ✓ |
| `export_data` | 只读查询结果导出 CSV/JSON 文件（需 `DBMCP_EXPORT_DIR` 白名单目录；防穿越/20MB 上限/原子落盘——临时文件+原子占位，跨进程同名互斥） | 写文件 |
| `import_data` | CSV 导入表（批量参数化 INSERT，批失败逐行定位坏行；`DBMCP_IMPORT_DIR` 白名单；表头即列名仅裸标识符；万行/20MB 上限） | 写库 |
| `count_rows` | 精确计数（可带 WHERE），用于数据验证/前后对比 | ✓ |
| `execute` | 写操作（默认关闭，见下） | ✗ |
| `create_table` | 建表：单条 CREATE TABLE（需 allowCreateTable=true；禁 DROP/TRUNCATE/数据变更语句） | ✗ |
| `find_database` | 按库名/环境（TEST/PRE/UAT/DEV）检索源；`probe=true` 并行 TCP 探测可达性 | ✓ |

典型大模型工作流：`list_sources → list_tables / describe_table / find_tables_by_column / fk_relationships → query / sample_data / distinct_values / column_stats / count_rows`（昂贵查询前用 `query_plan` 看计划），
写后用 `count_rows` / `query` 验证影响行数；需要把数据交给用户或其它工具时用 `export_data` 落盘。

## 首次初始化：导入 DBeaver 连接配置

部署包**默认不含** `dbmcp.config.json`（不预置任何连接与凭据）。首次使用：

```bash
node import-dbeaver.mjs "C:\Users\<you>\Documents\保险-20260929.dbp"
```

导入器自动解包 `.dbp` → 解密 DBeaver 凭据（DBeaver 26 方案，实现已混淆）→ 过滤 MySQL/PG →
连接串加密为 `enc` 字段写入配置（无明文落盘）→ 连通性预检。
未初始化时 server 以「未初始化模式」运行：`list_sources` 返回 `init_required` 提示。

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
- 环境变量：`DBMCP_CONFIG` 指向其他配置文件；`DBMCP_EXPORT_DIR`/`DBMCP_IMPORT_DIR`（export/import_data 白名单目录，import 回退 EXPORT_DIR）、`DBMCP_MASTER_KEY`（enc2 主密钥，可选）、`DBMCP_PRETTY`、`DBMCP_MAX_CELL_CHARS`、`DBMCP_NO_LISTEN`——在客户端注册 JSON 的 `"env"` 块里设置，全表见《部署说明.详细版.md》

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

## 自测

```bash
node selftest.mjs
```
277 项断言（已初始化口径，未初始化 263）：只读守卫（含注释/字符串混淆、可写 CTE、OUTFILE、行锁、`pg_read_file`/`pg_ls_dir`/`dblink`、
管理/破坏性函数黑名单（`pg_terminate_backend`/`set_config`/`pg_sleep`/`SLEEP`/`load_extension`/`dblink_exec` 等）、
CTAS 全形态拦截（含 MySQL 无 AS）、MySQL/PG 方言语义回归）、写守卫（无 WHERE、DDL、多语句、**不引用任何列的 WHERE、恒真 OR 分支**）、
安全红线（无 WHERE 的 UPDATE/DELETE、TRUNCATE、字符串/注释藏 WHERE、写目标解析与嵌套 WHERE）、外发防护（口令清洗、URL 编码变体、工具输出零口令）、
LIMIT 强制（含 WITH 已带 LIMIT 的回归用例）、JSON 整形与单元格截断、sample_data 的 WHERE/ORDER BY 构造与注入防护、
import 批回退/结果未知分类、导出/导入目录门禁、MCP 协议握手与调用、真实 stdio 子进程回环、
find_database 检索与 TCP 探测、未初始化模式、export 原子落盘与双进程并发、sqlite-add 幂等语义、crypt-cli 加解密往返。无需真实数据库。
已初始化目录预期汇总 `277 passed, 0 failed`（oceanbase 连通性用例在主机不可达时打印 SKIP，仍计入通过）；
未初始化目录预期汇总 `263 passed, 0 failed`（leak-guard 口令检查套件整体 SKIP）。
真实库套件：`sqlite-validate.mjs`（SQLite 真实库 76 项）与 `mysql-validate.mjs`（真实 MySQL 全链路 29 项：
全工具面（元数据发现/画像/直方图/TopN/NULL 语义/查询与 EXPLAIN/事务提交回滚/execute 红线/建表/导出导入/原子回滚），stdio JSON-RPC 真客户端链路，探针库 dbmcp_probe_hist 自建自删；
配置缺 mysql 源时打印 SKIP 以退出码 3 结束）。
> 断言数随版本演进增长，**以 selftest 实际汇总行为准**（`=== N passed, M failed ===`），
> `install.mjs` 也以该行（而非 PASS/FAIL 字样计数）判定自检结果。

## 独立部署

> 📄 详细部署文档见同目录《[部署说明.md](./部署说明.md)》：系统要求、客户端接入、配置管理、安全机制、故障排查、升级维护。

本目录即完整可部署单元，拷贝到任意目标机器/目录即可运行：

1. 目标机需 Node.js ≥ 18.17，首次部署可访问 npm——**纯净包不含 `node_modules` 与任何 `.` 前缀文件/目录**，依赖由 `install.mjs` 自动执行 `npm ci --omit=dev` 命令生成（内网可加 `--registry` 镜像）；手动部署则在 `mcp\` 下执行同命令后跑 `node selftest.mjs` 验证（详见《部署说明.md》§十）
2. 注册到 MCP 客户端（`command` 填目标机 node 路径，`args` 指向本目录的 `server.mjs`）：
   ```json
   { "mcpServers": { "db": { "command": "node", "args": ["<部署目录>/server.mjs"] } } }
   ```
3. 部署后自检：`node install.mjs` 会依次跑 selftest + 全链路 E2E 验收（步骤 5；E2E 在技能仓库 `sql-check-script/tests` 或 `DBMCP_E2E` 指定时启用，缺 demo fixture 自动用 `demo.db` 自供给）；手动则 `node selftest.mjs`（277 项断言 FAIL=0 即正常）
4. 配置 `dbmcp.config.json` 已加密（`enc` 字段）。新增/更换连接：
   - 临时把明文 url 写入源（或 `node crypt-cli.mjs decrypt`），改完执行 `node crypt-cli.mjs encrypt` 恢复加密
5. 启动门禁：配置文件在 git 仓库内且未被 ignore / 已被跟踪时，服务拒绝启动

## 版本与文档同步规范

每次更新版本（含版本说明）必须同步落到以下全部位置，漏一处即视为发版未完成：

1. `mcp/package.json` 的 `version` —— **唯一事实源**（`server.mjs` 启动横幅与 selftest 版本一致性断言读它）
2. `mcp/server.mjs` 中 `pkgVersion("x.y.z")` 的 fallback 串
3. 全部文档版本行：`README.md`（实测行）、`SKILL.md`、`部署说明.md`、`部署说明.详细版.md`
4. **版本说明**：本页「更新记录」新增条目（**唯一落点**）；`部署说明.md`「更新记录」留短条目并注明「完整条目见 README『更新记录』」
5. 发版自检：`node mcp\selftest.mjs` 0 failed；随技能侧（`sql-check-script`）发布时其 `node tests\run_all.mjs` 须全绿

## 更新记录

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
