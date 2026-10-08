# F7 flaky 取证 — phaseA（2026-10-07T13:22:42.904Z）

- 轮数 20（并发度 1）；总失败实例 0
- 稳定红（全轮失败）：无
- 偶发（部分轮失败）：无
- 每轮耗时：1:85.3s 2:85.2s 3:85.1s 4:85.9s 5:85.0s 6:85.8s 7:86.1s 8:86.1s 9:86.8s 10:87.0s 11:86.3s 12:86.6s 13:86.5s 14:88.1s 15:86.8s 16:86.5s 17:87.2s 18:88.2s 19:86.6s 20:87.0s

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
- http://127.0.0.1:59220/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy40p06yq1bf）
- http://127.0.0.1:59220/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy40rxctpgpo）
### run-02
- http://127.0.0.1:65204/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy42j24zsr8n）
- http://127.0.0.1:65204/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy42m15z0he4）
### run-03
- http://127.0.0.1:53513/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy44cv3wprvj）
- http://127.0.0.1:53513/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy44frznov7a）
### run-04
- http://127.0.0.1:58523/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy466omfgjpp）
- http://127.0.0.1:58523/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy469nwi2120）
### run-05
- http://127.0.0.1:64972/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy480ovf1fzr）
- http://127.0.0.1:64972/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy483lqjhpob）
### run-06
- http://127.0.0.1:62927/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy49uiv3shlr）
- http://127.0.0.1:62927/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy49xgp4j8e7）
### run-07
- http://127.0.0.1:64020/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4boz0xqznw）
- http://127.0.0.1:64020/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4brzsvoofi）
### run-08
- http://127.0.0.1:63930/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4djd262ltj）
- http://127.0.0.1:63930/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4dmdfmuk2f）
### run-09
- http://127.0.0.1:53751/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4fe3uiaasy）
- http://127.0.0.1:53751/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4fh6jdlrfo）
### run-10
- http://127.0.0.1:57278/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4h95ehr5q0）
- http://127.0.0.1:57278/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4hc4qkmvkz）
### run-11
- http://127.0.0.1:60041/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4j3tessgtg）
- http://127.0.0.1:60041/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4j6t2b9pgs）
### run-12
- http://127.0.0.1:55827/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4kyjf8unm0）
- http://127.0.0.1:55827/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4l1hecz2k3）
### run-13
- http://127.0.0.1:49203/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4mt7vywzqm）
- http://127.0.0.1:49203/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4mw8ioqr6x）
### run-14
- http://127.0.0.1:55855/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4oouaqi54z）
- http://127.0.0.1:55855/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4orttinhrf）
### run-15
- http://127.0.0.1:49586/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4qk4gq3bs1）
- http://127.0.0.1:49586/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4qn4hpmtxy）
### run-16
- http://127.0.0.1:51363/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4sezkcjlh6）
- http://127.0.0.1:51363/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4shzvtvquv）
### run-17
- http://127.0.0.1:65251/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4u9yxo5z1u）
- http://127.0.0.1:65251/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4ud0jx0iv6）
### run-18
- http://127.0.0.1:52745/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4w6034yicj）
- http://127.0.0.1:52745/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4w91nkvf19）
### run-19
- http://127.0.0.1:56744/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4y17k9dtmx）
- http://127.0.0.1:56744/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4y47pzbtf5）
### run-20
- http://127.0.0.1:49689/static?page=1 → stop=no-new-rows pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":0}]（collect-flowC3-muy4zwaomwd2j）
- http://127.0.0.1:49689/inf?page=1 → stop=max-pages pages=[{"page":1,"rowCount":5,"added":5},{"page":2,"rowCount":5,"added":5},{"page":3,"rowCount":5,"added":5}]（collect-flowC4-muy4zz9shep2m）

## 轮次 FAIL 行全文

