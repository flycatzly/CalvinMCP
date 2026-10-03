-- 订单列表联表 + 深分页：大表 join + order by + limit 深分页
SELECT o.*, u.user_name, u.mobile
FROM order_info o
JOIN user_info u ON o.user_id = u.user_id
WHERE o.status = 1
ORDER BY o.create_time DESC
LIMIT 500000, 50;
