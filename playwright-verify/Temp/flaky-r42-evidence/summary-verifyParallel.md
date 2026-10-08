# Phase C verify-all mode3 整链复现 — verifyParallel（2026-10-07T14:04:48.671Z）

- 轮数 4（--parallel=true）；flow-check 红轮 0/4；其他套件红轮 2/4
- 每轮耗时：1:154s 2:155s 3:173s(exit=1) 4:181s(exit=1)
- 判据行：判据[mode 3]：17/17（887 断言 + 矩阵 4 签名） —— 与《部署说明》§15.3 判据一致 ✅ | 判据[mode 3]：15/17（712 断言 + 矩阵 4 签名） —— 判据不满足 ❌ | 判据[mode 3]：15/17（777 断言 + 矩阵 4 签名） —— 判据不满足 ❌

## flow-check 结果

- run-01: ✓ 全部通过（44 项断言）（93.1s）
- run-02: ✓ 全部通过（44 项断言）（93.7s）
- run-03: ✓ 全部通过（44 项断言）（104.7s）
- run-04: ✓ 全部通过（44 项断言）（111.3s）

## 失败明细（签名源）

### run-03
- ✗ 智能体线（LLM 回环/守门/计划契约/自愈采集纯函数） — 进程崩溃（0xC0000409 fail-fast/STATUS_STACK_BUFFER_OVERRUN，无 FAIL 行）（1.8s）
  - PASS  报告含 CI 判定字段（verdict/steps/problems/source）
  - PASS  报告落盘为 JSON 文件  C:\Users\CalvinZly\AppData\Local\Temp\pv-nl-uk0VJj\.playwright-artifacts\reports\nl-muy6bzwy35vm1.json
  - === D) explore：事实解析与死链坏图判定 ===
  - PASS  parseFactsFile 裸 JSON
  - PASS  parseFactsFile 双层编码 JSON
  - PASS  parseFactsFile 裹杂讯的 JSON
  - PASS  parseFactsFile 垃圾输入 → null
  - PASS  坏图=加载完成且宽度 0；加载中不算  {"total":4,"broken":[{"src":"https://a/broken.png","alt":""}],"skipped":1}
  - PASS  链接分类：去重/跳过非 http/受抽样上限约束  {"probe":[{"href":"https://a/1","text":""}],"skipped":[{"href":"mailto:x@y.z","why":"非 http(s)"},{"href":"javascript:void(0)","why":"非 http(s)"},{"href":"https:
  - PASS  探活：200=ok，404=dead（HTTP ≥400 才算死链）  [{"href":"http://127.0.0.1:63988/ok","text":"ok","status":200,"ok":true,"kind":"ok","latencyMs":3},{"href":"http://127.0.0.1:63988/dead","text":"dead","status":404,"ok":false,"kind":"dead","latencyMs":2}]
  - PASS  网络不可达=unreachable（不是死链）
  - PASS  D12 慢应答主机被单探测超时兜住（unreachable 且不拖成分钟级）  {"href":"http://127.0.0.1:63993/x","text":"s","status":0,"ok":false,"kind":"unreachable","detail":"This operation was aborted","latencyMs":610}
- ✗ 部署副本验证（须最后跑） — 1 项失败（退出码 1）（0.3s）
  - FAIL  部署副本内容与源码一致（改了源码没重装会在这里暴露）  不同 2 个：extension/floating.js, mcp/test/floating-check.mjs
### run-04
- ✗ 猫耳悬浮球（录制/回放/中转） — 2 项失败（退出码 1）（2.3s）
  - FAIL  富渲染：pvFactsLine 顶层标量/一层嵌套/数组计数，上限 4、不含 verdict
  - FAIL  富渲染：仅 verdict/非对象 → 空串（不硬凑不伪造）
- ✗ 部署副本验证（须最后跑） — 1 项失败（退出码 1）（0s）
  - FAIL  部署副本确由本源码安装（否则比对无意义）  部署副本与本源码出身不同（1 个身份文件不一致：skill/playwright-verify/SKILL.md）
