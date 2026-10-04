# SQL 事故模式（高频场景参考）
> 版本 v1.4.3 · sql-check-script · 更新记录见 README.md「更新记录」

把常见线上问题抽象成可复用的检测脚本模板。

## 1. 订单列表慢查询（大表全表扫描 + 排序 + 深分页）

- 现象：订单列表接口偶发超时、页面卡死
- 典型风险：select *、where 字段区分度低、order by 字段未命中索引、深分页
- 检测要点：explain 检查 filesort / 全表扫描

## 2. 多表状态一致性（支付成功但订单未支付）

- 现象：支付成功，订单仍显示未支付
- 典型风险：支付流水、订单、库存、优惠券、MQ 消息等多表状态不一致
- 检测要点：跨表关联比对状态，输出异常订单列表与样例

### 一致性比对脚本模板

```sql
-- 支付流水成功但订单未支付
SELECT o.order_no, o.status AS order_status,
       p.status AS pay_status, p.amount
FROM order_info o
JOIN pay_flow p ON o.order_no = p.order_no
WHERE p.status = 'success'
  AND o.status = 'unpaid';
```

输出要包含：

- 支付流水成功 + 订单未支付比对 SQL
- 异常订单列表与样例
- 风险等级 P0/P1
- 巡检报告模板字段
