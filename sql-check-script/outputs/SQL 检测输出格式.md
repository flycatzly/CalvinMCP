# SQL 检测输出格式（证据版 · 模式 A）
> 版本 v1.4.3 · sql-check-script · 更新记录见 README.md「更新记录」

> 模式 B（数据分析）输出见 `outputs/分析报告模板.md`。

## 必须按顺序输出 8 个小节

1. SQL 风险识别
2. where 条件分析
3. 索引判断
4. 慢查询判断
5. join 风险（无 join 写「不适用」）
6. order by 风险
7. 性能风险（类型/原因/影响/表现/**证据**/风险等级 P0-P2，按 `references/风险等级定义.md` 判定）
8. 优化建议（至少 3 条，须含 EXPLAIN 验证）

## 证据要求（结合 calvin-db-mcp）

- 索引判断：基于 `describe_table` 的真实索引列表，直接给「命中/未命中」结论
- 慢查询 / order by 判断：基于 `EXPLAIN` 的 type/key/rows/Extra 实测
- where 区分度：基于 `count_rows` 分桶占比实测
- 第 7 节「验证方式」列填具体证据（如 `EXPLAIN: type=ALL, rows=5,000,000, Extra=Using filesort`）

## 证据不足时

若 MCP 未就绪 / 表不存在 / EXPLAIN 失败，在第 8 节后追加「待补充信息」清单，所有结论标注「待验证」，禁止猜死根因。

## 禁止

- 无依据断言「必须加索引 xxx」
- 跳过验证方式 / 不附 EXPLAIN 证据
- 把「待验证」写成确定结论

## 合格输出自检

- 风险识别：命中 select *、where 字段区分度、order by、深分页等
- 索引判断：基于真实索引给出命中/未命中，而非空喊「加索引」
- 优化建议：字段精简、游标分页、时间范围过滤等，每条含 EXPLAIN 验证
- ⚠️ 若输出只有「建议加索引」而没有 EXPLAIN 验证方式，说明工作流未执行到位
