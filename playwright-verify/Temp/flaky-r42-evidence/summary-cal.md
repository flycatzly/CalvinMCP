# F7 flaky 取证 — cal（2026-10-07T12:53:17.699Z）

- 轮数 1（并发度 1）；总失败实例 0
- 稳定红（全轮失败）：无
- 偶发（部分轮失败）：无
- 每轮耗时：1:88.2s

## 复现率（失败轮/总轮）

- 0/N — 本轮全部 check 绿（复现率 0）

## 签名聚类（summarizeFile）

```json
{
  "error": "no failures — 没有失败实例可聚类"
}
```

## 现场证据（失败轮 collect 产物页账）

### run-01
- http://127.0.0.1:49205/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy3y1q0iruie）
- http://127.0.0.1:49205/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy3y4nkconjh）

## 轮次 FAIL 行全文

