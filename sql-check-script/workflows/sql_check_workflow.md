# SQL 八步分析工作流（证据版）
> 版本 v1.4.3 · sql-check-script · 更新记录见 README.md「更新记录」

每条 SQL 按此执行，**禁止跳步**。证据来自 calvin-db-mcp；取不到证据就标注「待补充」，禁止猜根因。

## 执行前加载

- `references/sql_input_contract.yaml`（补全 project_path / sql / datasource / source）
- `references/sql_risk_signals.md`
- `references/calvin-db-mcp工具映射.md`
- `references/风险等级定义.md`
- `outputs/SQL 检测输出格式.md`

## Step 0 取证（用 MCP，每条必做）

1. **定位 source**：`find_database`（库名/环境）或 `list_sources` 拿到 source id
2. **结构**：`describe_table` 取真实列 / 主键 / 索引 / 注释 / 预估行数
3. **执行计划**：`query` 跑 `EXPLAIN <sql>` 取真实 type / key / rows / Extra
4. **数据量 / 区分度**：`query` + `GROUP BY` 取 WHERE 字段取值分布；`count_rows` 取总行数与精确单值计数
5. **质量**：`sample_data` 抽查脏数据 / 异常值 / 缺失值（敏感列按白名单配置脱敏后展示）

## Step 1 SQL 风险识别

对照 `sql_risk_signals.md` 列出命中项（select *、深分页等），每条标注证据来源（EXPLAIN / describe_table / count_rows）。

## Step 2 where 条件分析

- 是否有 where？能否缩小扫描范围？
- 字段区分度：用 `count_rows` 实测各取值占比（如 status=1 占多少），而非猜
- 函数 / 隐式转换 / or / 前缀模糊

## Step 3 索引判断

- 用 `describe_table` 的真实索引列表判断命中 / 未命中（不再写「建议验证」，直接给结论）
- where / join / order by 字段是否与索引左前缀一致

## Step 4 慢查询判断

- 用 EXPLAIN 的 `rows` 估扫描行数，对比 `count_rows` 真实数据量
- 返回字段过多、锁等待可能

## Step 5 join 风险

- 关联字段两侧索引（describe_table）、先过滤再 join、大表 join 成本（EXPLAIN）

## Step 6 order by 风险

- EXPLAIN `Extra` 是否 `Using filesort`；排序前数据量（count_rows）

## Step 7 性能风险输出（每行附证据）

风险等级按 `references/风险等级定义.md` 判定（**禁止自定义**）：

| 风险类型 | 风险原因 | 影响范围 | 可能表现 | 验证方式（证据） | 风险等级 |
|----------|----------|----------|----------|------------------|----------|

## Step 8 优化建议

至少 3 条，每条说明「改哪里 + 查哪里 + 验证哪里」，验证用 EXPLAIN 前后对比。

## 批量处理策略（项目级巡检）

项目常有大量 SQL，**不必每条都做完整八步**：

1. **初判分级**（用 `01_项目SQL探查.md` 的风险初判）：只把命中风险信号的入队
2. **P0/P1 候选**：做**完整八步** + EXPLAIN 取证
3. **P2 候选**：只做静态信号检查 + 抽样 EXPLAIN 验证
4. **覆盖度**：单次巡检覆盖「全部 P0/P1 + 抽样 30% 的 P2」

## 索引建议的输出边界

本 Skill **只读，不执行任何 DDL**。索引建议以 SQL 形式输出，交由 DBA 执行：

```sql
-- 建议（需 DBA 评估后执行；本 Skill 不执行 DDL）
ALTER TABLE order_info ADD INDEX idx_status_create_time (status, create_time);
```

输出时必须注明：

- 写「**建议**」而非「必须」（避免无依据断言）
- 附 EXPLAIN 前后对比预期（如改后 `key=idx_status_create_time`、无 filesort）
- 标注执行风险（大表加索引需评估锁表 / 在线 DDL）

## 证据不足时

MCP 未就绪（init_required）/ 表不存在 / EXPLAIN 失败：输出「待补充信息」清单，结论标注「待验证」，禁止猜根因。
