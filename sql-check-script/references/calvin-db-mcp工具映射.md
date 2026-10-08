# calvin-db-mcp 工具映射（取证手册）
> 版本 v1.4.46 · sql-check-script · 更新记录见 README.md「更新记录」

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
| `column_stats` | source / table / column / where | 单列画像（stats 六字段：row_count / non_null / distinct_values / min_value / max_value / avg_value） |
| `export_data` | source / sql / filename / format / overwrite / limit | ⚠️ 只读结果导出 CSV/JSON（需服务端 DBMCP_EXPORT_DIR），按需 |
| `execute` | — | ❌ 本 Skill 禁用（写操作，且默认 allowWrites=false 双层拒绝） |
| `create_table` | — | ❌ 本 Skill 禁用（DDL，需 allowCreateTable） |
| `import_data` | — | ❌ 本 Skill 禁用（批量写入） |

## 返回契约（实测，防误用）

| 工具 | 计数字段 | 形态 | 注意 |
|------|----------|------|------|
| `query` | `row_count` | 数字 | 当前返回的可见行数，可能被自动 LIMIT 截断（看 `truncated`） |
| `count_rows` | `total` | **字符串型 bigint** | 防精度丢失（雪花 ID 场景），比对时 `Number(total)` 或原样字符串比较 |
| `distinct_values` | `distinct_total` | 字符串型 bigint | 同上；取值分布在 `values[]`（`value`/`cnt`），不是 `top_values` |
| `find_database` | 参数名是 `name` | — | 不是 `keyword`；大小写不敏感子串匹配；`probe: true` 时命中行带 `reachable` |
| `column_stats` | `stats.row_count` 等 | 计数字段字符串（sqlite 实测） | 六字段在 **`stats` 子对象**（非顶层），键名钉死 **`row_count`/`non_null`/`distinct_values`/`min_value`/`max_value`/`avg_value`**（不是 min/max/avg，误读会取到 undefined）；min/max 文本列按字典序；非数值列 `avg_value` 跨方言分叉——PG 类型门控 `null`（时间列 min/max 为驱动 ISO 形态）、mysql/sqlite 原生 AVG 语义（文本强转 0、时间列可出数字）；`histogram`/`top_values` 是 opt-in 参数才返回（`top_values[].count` 为数字）；histogram 语义——数值列等宽桶（桶界覆盖 [min,max]、值=上界钳入末桶），**非数值列（文本/时间列）→ 空数组**（不炸不脏；2026-10-05 三库实测收口，mysql 时间列曾漏网产出 `20240101000000.00000` 伪数值脏桶，形状门控修复）；数值样文本 mysql/sqlite 强转 GIGO 桶、PG 列级类型门控空数组（dialect-split 与 avg_value 同族） |
| `query_plan` | `plan` 数组 | `plan_format` 标注格式 | sqlite 恒 `text (EXPLAIN QUERY PLAN)`，行含 `id`/`parent`/`detail` 树 |

## 调用规范

1. **source id 贯穿**：先 `find_database` / `list_sources` 拿 source，后续工具都传它
2. **只读**：只用 `query`(EXPLAIN) / `describe_table` / `count_rows` / `sample_data`
3. **BIGINT 是字符串**：雪花 ID 原样用在 WHERE，不要转数字（会精度丢失）
4. **EXPLAIN 无需 LIMIT**：`query` 会自动 LIMIT，但 EXPLAIN 不受影响
5. **跨库**：同实例用 `库名.表名`；跨实例切换 source
6. **环境确认**：PRE/UAT 取证前二次确认目标环境
7. **取不到证据**（init_required / ECONNREFUSED / 表不存在）→ 输出「待补充」，禁止猜根因
8. **timeoutMs 是配置级全局**（`dbmcp.config.json` 顶层，缺省 30000ms、夹取 1000..600000），非逐调用参数——查询/执行超时统一 `[E_DB:conditional]`（2026-10-05 真实触发实录：MySQL `Query inactivity timeout (PROTOCOL_SEQUENCE_TIMEOUT)` / PG `Query read timeout`）：同参重试必再超时，收窄范围/加过滤再试、写路径用 `count_rows` 核对；连接建立超时 `ETIMEDOUT` 不在此列（仍 `[E_DB:retryable]`）。mysql2 超时只中断客户端等待、服务端语句继续跑（重查询留意实例负载）；PG `statement_timeout` 服务端真撤语句；sqlite 无查询级超时（busy_timeout 只管写等待）
8. **数值上限是夹取不是拒绝**（v1.4.8 实测口径）：`limit` / `max_rows` 等整数参数低于下限（如 0）或非整数（如 1.5）会报 `E_PARAM` 拒绝，但**超过 `maximum` 不报错，静默夹取到上限**（如 `sample_data.limit` 传 51 → 按 50 执行）。`inputSchema` 的 `maximum` 是夹取上限而非拒绝阈值；纯数字字符串会被接受。消费侧不要把「没报错」当「取到了请求条数」，比对行数以实际 `rows.length` / `row_count` 为准。
9. **`create_table` DDL 表名标识符口径已对齐**（v1.4.11 发现、v1.4.15 修复实测）：曾有口径差——`import_data.table` 传非法标识符（如 `1bad`）被标识符层拒（`[E_PARAM] Invalid identifier ...`），而 `create_table` 的 DDL 表名原样透传数据库解析器（`CREATE TABLE 1bad (x)` 落 `[E_DB:no-retry] unrecognized token`，错误类误导）。已在守卫层补 DDL 表名标识符预校验（与 import 同正则同文案），现两工具同口径：`CREATE TABLE 1bad (x)` → `[E_PARAM:no-retry] Invalid identifier '1bad'. Pass plain names; use the schema parameter instead of qualified names.`（中文表名/合法限定名/IF NOT EXISTS 仍放行；安全红线优先——带危险关键字的非法表名仍按 E_SAFETY 拒；建表门关闭时 E_CONFIG 先于表名校验，gate-first 不变）。修复工件在 calvin-db-mcp 工作树（guard.mjs + selftest 3 钉，301/0），版本号/changelog 随对方发版会话记账。
10. **filename 路径清洗与文件上限**（v1.4.11 实测）：`import_data` / `export_data` 的 `filename` 含 `../` 等路径成分会被服务端清洗——import 是**拒绝**（`[E_NOT_FOUND] 导入文件不存在（或文件名被清洗拒绝）`），export 是**清洗改名**（`../x.csv` → `.._x.csv`，仍落 `DBMCP_EXPORT_DIR` 内不穿越，与 import 拒绝形态不同但同样安全）。文件/行数超上限报 `[E_LIMIT:conditional]`（import 数据行 >10000 或文件 >20MB；export 内容 >20MB **组装期早停、未写盘**——v1.4.13 实测不落残片），按提示改小范围后重试。语句级数据库错误（语法/未定义函数等）统一 `[E_DB:no-retry]`（驱动错误码透传），不是参数问题。
11. **import_data 失败语义两档**（v1.4.13 实测）：默认（`atomic` 缺省）失败**中止不回滚**——`[E_DB] 第 N 行导入失败，整批中止（此前 X 行已写入——如需清场请用 execute 按条件删除）`，残留行如实披露；`atomic: true` 才走回滚档——`[E_DB] 原子导入失败，已全部回滚（未写入任何行）`（count 不变实证）。批量导入按需显式传 `atomic: true`；默认档失败后按文案指引清场或重导，不要假设「失败=没写入」。
12. **import_data 参数语义**（v1.4.14 实测）：import 是**纯 INSERT，不预清目标表**——同主键重导直接撞 `UNIQUE constraint`，重导前先按条件清行或换 id；工具**没有 `overwrite` 参数**（那是 `export_data` 的，传了也不生效），别把它套到导入上。`emptyAsNull: true` 把 CSV 空串单元格映射为 NULL（缺省保留空串）；`strip_neutralization: true` 逆中和——剥掉 `` `'=+@-TAB/CR` `` 值的前导单引号（export 默认公式中和的精确逆变换，往返无损），返回体带 `neutralization_stripped` 计数。`schema` 参数 SQLite 下按 `"schema"."table"` 两段引用生效（`main` 合法）。
13. **加密配置面**（v1.4.14 实测）：配置里 url 可存密文字段 `enc`（`enc2:` = AES-256-GCM + scrypt，需 `DBMCP_MASTER_KEY` ≥8 字符；旧 `enc:` 格式兼容解密，无需主密钥）。**解密失败是启动期 fail-fast（拒启）不是工具级报错**——server stderr 提示 `source '<id>' 的 enc 解密失败: …`，工具侧无任何响应（排障看服务端日志，不是工具返回）。错误主密钥/篡改密文/无主密钥/长度不足四种形态文案分别为「DBMCP_MASTER_KEY 不匹配或密文被篡改」（错钥与篡改合并报，GCM 认证不区分）/「DBMCP_MASTER_KEY 未设置（或少于 8 字符）…」/「密文长度不足或非法（enc2）」，均 fail-closed 不落半解密数据。
14. **错误码反查总索引**：报错全码形态 `Error: [E_CODE:retry] 消息`（retry 三值域 `retryable|conditional|no-retry`）与错误类矩阵（触发条件/实测文案/重试语义/排障方向）见 `故障处理.md`「五、错误类矩阵实测表」。
15. **引号标识符调用形态同黑名单语义**（v1.4.28 修复，adv26 探针 39 项实证）：黑名单函数名写成引号标识符调用与裸名**同拦**——反引号 `` `sleep`(5) ``、双引号 `"pg_sleep"(5)`、`U&"pg_sleep"(5)`、schema 限定 `pg_catalog."pg_sleep"(5)` / `` `mysql`.`sleep`(1) ``、注释隔开 `` `sleep`/*c*/(5) ``、复合 `("pg_sleep")(30)` 均 `[E_SAFETY]` 拒；引号**列名引用**（闭引号后无左括号）是合法只读查询**不误伤**。修复前掩码把引号标识符整体抹掉、黑名单对守卫不可见（`sleep`/`benchmark` 真实执行、`load_file`/`pg_read_file`/`lo_export`/`dblink` 触达驱动层，query / count_rows where 片段 / query_plan / export_data 四通道穿透，adv26 真实库 29 处违例实锤）；现 `sanitizeSql` 记录引号跨度 +「闭引号后接左括号」调用形态判定（空白/注释容让），`guardReadOnly` 与 `checkWhereFragment` 双守卫点按名复核黑名单（报文带 `(quoted function name)` 标记，错误类矩阵见 `故障处理.md`）。消费侧拼接用户 SQL 仍按黑名单口径做语义审查，勿依赖守卫单一兜底。

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

**列画像用 `column_stats`**（stats 六字段一次拿全：row_count / non_null / distinct_values / min_value / max_value / avg_value）：

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
