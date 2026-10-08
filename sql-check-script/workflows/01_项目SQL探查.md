# 项目 SQL 探查（全链路起点）
> 版本 v1.4.46 · sql-check-script · 更新记录见 README.md「更新记录」

目标：把项目里「散落」的 SQL 全部找出来，并标注每条 SQL 的**调用链与涉及表**，作为后续全链路分析的输入。

## 输入

- 项目根目录路径（如 `D:\<项目>`）
- 数据库名 / 环境（可选，用于从库反查）

## Step 1 扫 SQL 落点

按技术栈用 glob / grep 扫描：

| 技术栈 | SQL 落点 | 扫描模式 |
|--------|----------|----------|
| MyBatis | `*Mapper.xml`、`@Select/@Update/@Insert/@Delete` | `**/*Mapper.xml`、`@Select\|@Update\|@Insert\|@Delete` |
| JPA/Hibernate | `@Query`、`@NamedQuery`、`nativeQuery` | `@Query\|@NamedQuery\|nativeQuery` |
| Spring JDBC | `JdbcTemplate`、`NamedParameterJdbcTemplate` | `JdbcTemplate\|NamedParameterJdbcTemplate` |
| Go | `db.Query/Exec/Raw`、gorm `Raw` | `\.Query\(|\.Exec\(|\.Raw\(` |
| Python | `execute(`、SQLAlchemy `text(` | `execute\(|text\(` |
| 迁移脚本 | `.sql`（Flyway / Liquibase） | `**/*.sql` |
| 数据源配置 | datasource url | `jdbc:|datasource|url:` |

## Step 2 建 SQL 清单

每条 SQL 记录以下字段：

- 文件路径:行号
- 原始 SQL（参数脱敏为 `?` 或示例值）
- 调用链（Controller → Service → Mapper/DAO → SQL）
- 涉及表
- 业务场景 / 接口名
- 数据源（库名 / 环境）

## Step 3 反查补齐（可选）

用 calvin-db-mcp `list_tables`（可 `name_like` 过滤）列库中表，反查哪些 SQL 命中了高频 / 大表，补齐清单；用 `describe_table` 给大表标预估行数。

## 产出：SQL 清单表

| 序号 | 文件:行 | SQL（脱敏） | 调用链 | 涉及表 | 数据源 | 风险初判 |
|------|---------|-------------|--------|--------|--------|----------|

> 风险初判只标「命中 risk_signals 的哪几条」，不下最终结论；最终结论在八步分析后给出。

## 落盘

SQL 清单存为 `outputs/SQL清单_<项目名>_<日期>.md`，作为八步分析与巡检报告的输入。
