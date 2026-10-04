# sql-check-script

SQL 全链路质量检测 + 只读数据分析 Skill（结合本地 MCP `calvin-db-mcp`）。

> 版本 v1.4.3 · 仅只读 · 依赖 `calvin-db-mcp`（v1.6.2，同级目录部署）· 更新记录见下文「更新记录」

## 安装

> 完整部署指引见《[部署说明.md](./部署说明.md)》（速查）与《[部署说明.详细版.md](./部署说明.详细版.md)》（详解）。

1. 复制到个人技能目录：

   ```powershell
   Copy-Item -Recurse -Force "<解压目录>\sql-check-script" "$env:USERPROFILE\.agents\skills\sql-check-script"
   ```

2. 安装并初始化 MCP（首次；MCP 侧细节详见 `calvin-db-mcp\部署说明.md`）：

   ```powershell
   cd <解压目录>\calvin-db-mcp
   node install.mjs "C:\path\to\your.dbp"    # 自动生成依赖（npm ci）+ 导入连接 + 自检 + E2E + 自动注册
   ```

3. 重启 MCP 客户端，使 `db` 服务器与技能生效。

## 验证装好了

| 检查 | 通过标准 |
|------|----------|
| 技能被发现 | 客户端技能列表出现 `sql-check-script` |
| MCP 已注册 | 工具列表出现 `list_sources` 等 16 个 `db` 工具 |
| MCP 已初始化 | 调 `list_sources` 返回源列表（非 `init_required`） |
| 依赖自检 | `node mcp\selftest.mjs` → `0 failed`（用例数随版本/源连通性增长，勿以 passed 数为验收线） |
| 全链路 E2E | `node tests\fullchain_test.mjs` → `56 passed, 0 failed`（47 核心 + 9 live-MySQL 可选段，后者需 `FULLCHAIN_MYSQL=1`；PG 段需 `FULLCHAIN_PG=1`，无 PG 源时干净 SKIP） |
| 一键验收 | `node tests\run_all.mjs` → 末行 `RUN_ALL selftest=…/0 e2e=…/0 … => OK`（selftest + E2E 合并裁决；也是安装后快速回归入口） |
| 部署即验证 | `calvin-db-mcp` 的 `node install.mjs` 步骤 5 自动跑核心 E2E（找到 `DBMCP_E2E` 或同级 `sql-check-script` 时；缺 demo fixture 时 E2E 自供给 `../demo.db`，两者皆缺则干净 SKIP） |

## 两种用法（自然语言使用示例）

直接对 AI 说需求即可，无需记命令。更多示例见 `SKILL.md`「快速开始 · 使用示例」。

**模式 A — SQL 质量检测**

```
帮我检查这条 SQL 的风险：SELECT * FROM order_info WHERE status=1 ORDER BY create_time DESC LIMIT 100000,20;
```

```
扫描 D:\proj\order-service 里的 SQL 做全链路质量检测，输出巡检报告
```

```
这条 SQL 要发生产，帮我做全链路质量检测，重点看索引和深分页：SELECT ...
```

```
Mapper 里这几个查询都说很慢，帮我按风险等级排个巡检清单
```

**模式 B — 只读数据分析**

```
分析回归后 orders 表各订单状态的数量分布，看有没有异常堆积
```

```
核对一下 t_order 和 t_order_item 昨天的行数对不对得上
```

```
看看 user_info 里手机号重复的有多少（只要数量和样例 ID，不要明文手机号）
```

```
对比 PRE 和 UAT 的 order_info 状态分布，看发版前后有没有漂移
```

> 模式 B 会先给出 SQL + 一句话解释，**经你确认后**才执行；预计超过 5000 行先 COUNT 再抽样；
> 跨 PRE/UAT 取证前二次确认环境；敏感字段（手机号/身份证/邮箱）脱敏或排除。

**会被拒绝的请求（护栏生效，给替代方案）**

```
帮我把 status=2 的订单批量改成 3      → 拒绝（写操作），输出核对清单与变更 SQL 供人工执行
把 test 表删了重建成新结构            → 拒绝（DROP/DDL），只做只读的结构对照报告
```

## 目录结构

```
sql-check-script/
├── SKILL.md                           # 入口：双模式 + 能力边界 + 安全规则
├── README.md                          # 本文档：安装 / 验证 / 用法
├── 部署说明.md                         # 部署速查：3 步部署 + 验收判定 + 速查排障
├── 部署说明.详细版.md                   # 部署详解：环境/纯净边界/步骤/验收口径/护栏/排障/升级卸载
├── tests/
│   ├── fullchain_test.mjs             # 全链路 E2E 测试（56 用例：传输/发现/取证/双模式/红线 + MySQL live + PG 可选段）
│   └── run_all.mjs                    # 一键验收：selftest + E2E 合并裁决（RUN_ALL 机器可读汇总行）
├── workflows/
│   ├── 01_项目SQL探查.md               # 模式 A：扫代码定位 SQL + 调用链
│   ├── sql_check_workflow.md           # 模式 A：八步证据版质量检测
│   └── 02_数据分析工作流.md             # 模式 B：六步只读分析
├── outputs/
│   ├── SQL 检测输出格式.md              # 模式 A 输出格式
│   ├── 巡检报告模板.md                  # 模式 A 交付模板
│   ├── 分析报告模板.md                  # 模式 B 交付模板
│   ├── 示例_订单列表慢查询.md           # 模式 A 合格输出对照
│   └── 示例_状态分布分析.md             # 模式 B 合格输出对照
├── references/
│   ├── sql_input_contract.yaml          # 输入契约
│   ├── 白名单与脱敏配置.yaml             # 护栏配置
│   ├── 风险等级定义.md                  # P0/P1/P2 判定标准
│   ├── sql_risk_signals.md              # 高危信号字典
│   ├── sql_incident_patterns.md         # 事故模式与比对模板
│   ├── 分析模板库.md                    # 模式 B 复用模板
│   ├── calvin-db-mcp工具映射.md             # MCP 工具 → 分析步骤
│   ├── 术语与口径.md                    # 术语统一
│   ├── 验收清单.md                      # 文章技能覆盖矩阵 + 部署自检
│   └── 故障处理.md                      # 现象 → 原因 → 动作
└── assets/sample_sql/
    ├── order_list_slow.sql
    ├── order_join_deep_page.sql
    └── 状态分布分析.sql
```

## 版本与文档同步规范

每次更新版本（含版本说明）必须同步落到**全部**对应文档，漏一处即视为发版未完成：

1. **版本标记行**：本技能全部 `.md` / `.yaml` 文档首部统一标记
   `> 版本 x.y.z · sql-check-script · 更新记录见 README.md「更新记录」`（yaml 为 `#` 注释行）。
   发版后 `grep -r "版本 v"` 应处处一致。
2. **版本说明（更新记录）**：本节上方「更新记录」新增一条（版本号 + 日期 + 变更要点）——
   **版本说明唯一落点**，其余文档的标记行统一指向它，不在各文档重复维护长文。
3. **依赖版本引用**：`SKILL.md` / `README.md` 中引用的 `calvin-db-mcp` 版本随对方发版同步。
4. **发版自检**：`node tests\run_all.mjs` 全绿（0 failed）后版本才可发布/重打发布包。

## 更新记录

- **v1.4.3**：E2E 稳健性与现场卫生——计数断言**去魔法数字**：`count_rows` 精确计数改为「与独立 SQL COUNT 交叉一致」（测工具契约而非 fixture 快照）、「未被写坏」守卫改为「与开跑基线一致」（demo.db 是共享演示资产，`sqlite-add.mjs`/MCP 演示都会合法写它，行数漂移不再误报红；已实测 4 行状态下 47/0 全绿）；新增 **demo fixture 健康断言**（books 为空时 FAIL 文案直接给出恢复指引，不再连环误报）；E2E 临时配置**残留自愈**（进程崩溃/被杀时 finally 不执行，开跑清扫 os.tmpdir() 中 >1h 的 `fullchain-fixture-*.json`，开发机实测已积累残留 2 例且其一含旧版开发机路径）；核心用例 46 → 47，全量口径 55 → 56，相关文档（部署说明/详细版/验收清单/SKILL/README）已同步

- **v1.4.2**：文档纪律与使用示例——新增「版本与文档同步规范」（版本标记行全量对齐 18 处文档、版本说明统一落点 README 更新记录、依赖版本引用同步、发版自检）；`SKILL.md`/`README.md` 扩写**自然语言使用示例**（模式 A/B 各 4 例 + 护栏拒绝示例 + 追问细化示例）；calvin-db-mcp 同步 v1.6.2（同口径文档纪律 + 使用示例，另含 distinct_values 并列频数稳定次序修复与 mysql-validate 全工具面钉测）；**发布口径**：纯净分发包零 npm 依赖——无 `node_modules`、无 `.` 前缀文件/目录、无开发机路径残留（`fullchain_test.mjs` 默认 server 目录改为同级解析），解压/拷贝即可部署（MCP 侧依赖由 `npm ci` 命令生成）；新增随包《部署说明.md》《部署说明.详细版.md》

- **v1.4.1**：部署即验证——新增 `tests/run_all.mjs` 一键验收（selftest + E2E 合并裁决，`RUN_ALL … => OK|FAIL` 机器可读）；`calvin-db-mcp` 的 `install.mjs` 新增步骤 5 装完自动跑核心 E2E（剥离 `FULLCHAIN_*` live 门控防部署机误判）；E2E fixture 自供给（目标配置缺 demo 源时用 `../demo.db` 生成临时 `DBMCP_CONFIG`，部署机免开发配置即可跑，双缺时干净 SKIP）；E2E 扩 PostgreSQL 方言段（`FULLCHAIN_PG=1` 门控：information_schema 跨 schema 发现 + PG 计划形态 Scan/cost= 取证，无 PG 源干净 SKIP——live 路径待配 PG 源后实测）
- **v1.4**：全链路实测与文档对齐——新增 `tests/fullchain_test.mjs`（46 用例 E2E：传输/发现/取证/双模式/红线守卫/数据完整性）；MCP 工具面由 9 → 16 个对齐 calvin-db-mcp v1.6（补 `query_plan`、`distinct_values`、`column_stats`、`find_tables_by_column`、`fk_relationships`、`export_data`/`import_data` 禁用说明）；新增返回契约备注（`count_rows.total` 字符串型 bigint vs `query.row_count` 数字、`find_database` 参数为 `name`）；区分度取证纳入 `distinct_values`/`column_stats`；验收基线改为「0 failed 为通过标准」；**根治 selftest 偶发 flaky 三根因**（4 处 `checkAsync` 未 await 导致结果丢失/竞态、`writeFileAtomic` 并发 rename 缺 Windows EPERM 重试、crypt 篡改用例 CBC 前提错误——末块密文翻转有 ~1/256 概率合法 padding，改 IV 翻转确定性断言，实测 500/500）；E2E 扩 MySQL 真实源只读段（`FULLCHAIN_MYSQL=1` 门控，information_schema 跨库发现 + EXPLAIN 方言取证）
- **v1.3**：补全文章要求的「角色设定」并让 description 明写「不执行写操作」；新增 `验收清单.md`（27 项覆盖矩阵 + 部署自检）、`故障处理.md`（现象→原因→动作）、`术语与口径.md`；分析模板库扩充多库对比、接口前后对比、日志排查三个场景
- **v1.2**：新增模式 B 合格输出示例、数据质量检查规则、脱敏 SQL 写法、批量巡检策略、索引建议边界、证据优先原则、追问清单；高危信号增强为带等级/验证方式的表格
- **v1.1**：新增风险等级定义、README 安装验证、方言适配、区分度取证修正、只读账号要求、输出落盘约定
- **v1.0**：合并两篇文章功能，形成双模式（质量检测 + 只读分析）
