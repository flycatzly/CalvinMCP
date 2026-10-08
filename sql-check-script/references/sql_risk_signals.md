# SQL 高危信号（风险识别 Step 1 必读）
> 版本 v1.4.46 · sql-check-script · 更新记录见 README.md「更新记录」

AI 拿到 SQL 后逐条对照此「风险字典」。**默认等级供初判，最终等级以实测证据为准**（见 `风险等级定义.md`）。

| # | 高危信号 | 默认等级 | 验证方式 |
|---|----------|----------|----------|
| 1 | `select *` | P2 | `describe_table` 比对实际所需字段 |
| 2 | 无 where / where 字段无索引 | P1 | EXPLAIN `type=ALL` / `key=NULL` |
| 3 | `like '%关键词%'`（前缀模糊） | P1 | EXPLAIN 扫描行数 |
| 4 | 函数包裹索引字段 `date(create_time)` | P1 | EXPLAIN `key=NULL` |
| 5 | 隐式类型转换（字符串列传数字） | P1 | EXPLAIN `key=NULL` |
| 6 | 深分页 `limit 100000, 20` | P1 | EXPLAIN rows + 响应耗时 |
| 7 | `update` / `delete` 无 where | **P0** | 词法守卫 + `count_rows` 命中行数 |
| 8 | 大表 join 大表且无过滤 | P1 | EXPLAIN 两侧 rows |
| 9 | `group by` 大表 | P2 | EXPLAIN `Extra=Using temporary` |
| 10 | 多表状态不一致 | **P0** | 比对 SQL + `count_rows` |
| 11 | `order by` 未命中索引（大结果集） | P2 | EXPLAIN `Extra=Using filesort` |
| 12 | 无 LIMIT 的列表查询 | P1 | 是否走全表/全索引扫描 |

> 命中信号 ≠ 一定有风险：小表、走索引、rows 很小的情况按 `风险等级定义.md` 的「证据优先」原则降级。

> **方言实测注记（2026-10-05 真库双方言 EXPLAIN，MySQL 8.4.5 / PG 17.5，orders 200 行小表实测）**——表内「验证方式」为 MySQL 字段形态，逐项实测命中；PG 同场景对照形态：

| 场景（信号） | MySQL 实测形态 | PG 实测形态 |
|--------------|---------------|-------------|
| 无索引过滤（#2） | `type=ALL, key=NULL, rows=N, Extra=Using where` | `Seq Scan … Filter` |
| `ORDER BY` 未命中（#11） | `Extra=Using filesort`（连 `Using where;` 形态） | `Sort`（`Sort Key:` 行） |
| `GROUP BY` 无索引列（#9） | `Extra=Using temporary`（实测未并列 filesort） | `HashAggregate`（`Group Key:` 行） |
| 索引点查 / 回表 | `type=const`（PK）/ `type=ref, key=…, Extra 空`（回表） | `Index Scan using … Index Cond`（点查）/ `Bitmap Heap Scan` + `Bitmap Index Scan`（`Recheck Cond`，多行） |
| 覆盖（只取索引列） | `Extra=Using index` | 未观察到 `Index Only Scan`（小表仍 Bitmap/Seq Scan）**待确认** |
| 复合索引免排序 | `type=ref, key=…, Extra=Backward index scan`（8.x 倒序扫描） | `Index Scan Backward using …`（无 `Sort` 节点） |

> 小表判读注意：**命中索引字段 ≠ 一定走索引**（`customer_id = 5` 实测 PG 仍 `Seq Scan`，cost 优化器选择）；PG 计划每行带 `cost=`。判读以实测计划为准（呼应「证据优先」原则）。
