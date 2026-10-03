-- 统计各订单状态的数量，排查回归后是否有异常堆积
-- 字段取自 describe_table(orders)
SELECT
    status AS 订单状态,
    COUNT(*) AS 订单数,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS 占比_百分比
FROM orders
GROUP BY status
ORDER BY 订单数 DESC;
