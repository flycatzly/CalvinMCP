# SQL 高危信号（风险识别 Step 1 必读）
> 版本 v1.4.3 · sql-check-script · 更新记录见 README.md「更新记录」

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
