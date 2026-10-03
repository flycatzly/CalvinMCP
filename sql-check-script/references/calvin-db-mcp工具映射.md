# calvin-db-mcp 工具映射（取证手册）
> 版本 v1.4.2 · sql-check-script · 更新记录见 README.md「更新记录」

calvin-db-mcp v1.6 提供 **16 个工具**：12 个只读分析工具（本 Skill 全部可用）、3 个写类工具（`execute` / `create_table` / `import_data` 一律禁用）、1 个导出工具（`export_data` 仅导出只读查询结果到文件，按需）。

- 模式 A（质量检测）：只读工具全用，核心是 `describe_table` + `query_plan` / `query(EXPLAIN)` + `count_rows`
- 模式 B（数据分析）：用 `list_sources` / `find_database` / `describe_table` / `query` / `sample_data` / `distinct_values` / `count_rows`，不跑 EXPLAIN

## 工具 → 分析用途

| MCP 工具 | 关键参数 | 用于 |
|----------|----------|------|
| `list_sources` | — | 列出全部源，确认已初始化 |
| `find_database` | name / env / probe | 按库名/环境定位 source id（`name` 为大小写不敏感子串） |
| `list_tables` | source / name_like / limit | 找表 + 预估行数 + 注释 |
| `describe_table` | source / table | 真实列 / 主键 / 索引 / 注释（Step 0 核心） |
| `find_tables_by_column` | source / column / schema | 按列名关键字反查表（表结构未知时定位） |
| `fk_relationships` | source / table / schema | 外键关系清单（join 链取证） |
| `query` | source / sql / max_rows | 跑 `EXPLAIN`、只读 SQL（单语句、自动 LIMIT 200） |
| `query_plan` | source / sql | 显式执行计划取证（仅接受 SELECT/WITH，构造前即拒写语句） |
| `count_rows` | source / table / where | 精确行数、单值计数、一致性比对 |
| `sample_data` | source / table / limit / where / order_by | 数据质量、脏数据、最新数据 |
| `distinct_values` | source / table / column / where | 单列 Top-N 取值分布 + 精确 distinct 总数 |
| `column_stats` | source / table / column / where | 单列画像：row_count / non_null / distinct / min / max / avg |
| `export_data` | source / sql / file | ⚠️ 只读结果导出 CSV/JSON（需服务端 DBMCP_EXPORT_DIR），按需 |
| `execute` | — | ❌ 本 Skill 禁用（写操作，且默认 allowWrites=false 双层拒绝） |
| `create_table` | — | ❌ 本 Skill 禁用（DDL，需 allowCreateTable） |
| `import_data` | — | ❌ 本 Skill 禁用（批量写入） |

## 返回契约（实测，防误用）

| 工具 | 计数字段 | 形态 | 注意 |
|------|----------|------|------|
| `query` | `row_count` | 数字 | 当前返回的可见行数，可能被自动 LIMIT 截断（看 `truncated`） |
| `count_rows` | `total` | **字符串型 bigint** | 防精度丢失（雪花 ID 场景），比对时 `Number(total)` 或原样字符串比较 |
| `distinct_values` | `distinct_total` | 字符串型 bigint | 同上 |
| `find_database` | 参数名是 `name` | — | 不是 `keyword`；大小写不敏感子串匹配 |

## 调用规范

1. **source id 贯穿**：先 `find_database` / `list_sources` 拿 source，后续工具都传它
2. **只读**：只用 `query`(EXPLAIN) / `describe_table` / `count_rows` / `sample_data`
3. **BIGINT 是字符串**：雪花 ID 原样用在 WHERE，不要转数字（会精度丢失）
4. **EXPLAIN 无需 LIMIT**：`query` 会自动 LIMIT，但 EXPLAIN 不受影响
5. **跨库**：同实例用 `库名.表名`；跨实例切换 source
6. **环境确认**：PRE/UAT 取证前二次确认目标环境
7. **取不到证据**（init_required / ECONNREFUSED / 表不存在）→ 输出「待补充」，禁止猜根因

## EXPLAIN 取证要点（MySQL）

| 字段 | 判定 |
|------|------|
| `type` | ALL=全表扫描（P1）；index=全索引扫描；ref/eq_ref=命中索引 |
| `key` | 实际用的索引；NULL=没走索引 |
| `rows` | 预估扫描行数，对比 `count_rows` 真实行数 |
| `Extra` | Using filesort=排序风险；Using temporary=临时表；Using index=覆盖索引 |

## 方言适配（MySQL / PostgreSQL / OceanBase）

| 关注点 | MySQL / OceanBase(MySQL) | PostgreSQL |
|--------|--------------------------|------------|
| 执行计划 | `EXPLAIN <sql>` | `EXPLAIN (FORMAT JSON) <sql>` |
| 全表扫描 | `type=ALL` | `Seq Scan` |
| 命中索引 | `type=ref/eq_ref/range`，`key=索引名` | `Index Scan` / `Index Only Scan` |
| 排序风险 | `Extra=Using filesort` | `Sort` 节点 |
| 临时表 | `Extra=Using temporary` | `HashAggregate` / `Materialize` |
| 覆盖索引 | `Extra=Using index` | `Index Only Scan` |
| 时间区间 | `INTERVAL 7 DAY` | `INTERVAL '7 days'` |

> OceanBase 走 MySQL 模式，按 MySQL 列判定。

## 字段区分度取证

**优先用 `distinct_values`**（一次拿到 Top-N 分布 + 精确 distinct 总数，免写 SQL）：

```text
distinct_values(order_info, column="status")   → 取值分布 + distinct_total
```

**列画像用 `column_stats`**（row_count / non_null / distinct / min / max / avg 一次拿全）：

```text
column_stats(order_info, column="user_id")     → 空值率、去重数、极值
```

**完整分布自定义（占比、多列交叉）用 `query` + `GROUP BY`**：

```sql
SELECT status, COUNT(*) AS cnt,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
FROM order_info
GROUP BY status
ORDER BY cnt DESC;
```

**精确单值计数用 `count_rows`**（前后对比、断言总数、查重）：

```text
count_rows(order_info, where="status = 1")   → status=1 精确行数（返回 total 字段）
```

> ⚠️ `count_rows` 一次只接受一个 where 条件，**不要**逐值多次采样来拼分布（既慢又可能不一致）；分布一律走 `GROUP BY`。

判定：某取值占比 > 50% → 该字段区分度低，单独用它过滤价值有限。
