# F7 flaky 取证 — phaseB（2026-10-07T13:39:35.691Z）

- 轮数 10（并发度 1，兄弟套件 mcp/test/nl-agent-e2e.mjs）；总失败实例 0
- 稳定红（全轮失败）：无
- 偶发（部分轮失败）：无
- 每轮耗时：1:88.7s 2:88.6s 3:88.9s 4:89.7s 5:90.4s 6:89.3s 7:89.8s 8:89.3s 9:89.9s 10:90.6s

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
- http://127.0.0.1:60327/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy54b6v7u7ox）
- http://127.0.0.1:60327/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy54e9d78t83）
### run-02
- http://127.0.0.1:54608/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy567m6545lw）
- http://127.0.0.1:54608/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy56apoaqlyn）
### run-03
- http://127.0.0.1:60178/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy584akl9bwa）
- http://127.0.0.1:60178/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy587bhw83k7）
### run-04
- http://127.0.0.1:64707/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy5a1c538ocz）
- http://127.0.0.1:64707/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy5a4dgbix05）
### run-05
- http://127.0.0.1:59040/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy5byz5wasb1）
- http://127.0.0.1:59040/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy5c2177r30l）
### run-06
- http://127.0.0.1:51054/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy5dw51bii3l）
- http://127.0.0.1:51054/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy5dz5g9gr7m）
### run-07
- http://127.0.0.1:59208/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy5ftgsgt1vi）
- http://127.0.0.1:59208/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy5fwhnkn39o）
### run-08
- http://127.0.0.1:50769/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy5hqaxnmd5q）
- http://127.0.0.1:50769/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy5htbys4qhp）
### run-09
- http://127.0.0.1:63435/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy5jniuekrxk）
- http://127.0.0.1:63435/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy5jqnkw7cpj）
### run-10
- http://127.0.0.1:50217/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy5ll3lslxkw）
- http://127.0.0.1:50217/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy5lo54444h7）

## 轮次 FAIL 行全文

