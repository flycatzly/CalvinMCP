SELECT * FROM order_info
WHERE status = 1
ORDER BY create_time DESC
LIMIT 100000, 20;
