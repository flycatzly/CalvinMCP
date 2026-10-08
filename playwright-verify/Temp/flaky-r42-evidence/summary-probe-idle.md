# Phase D 竞态窗口实测 — idle（2026-10-07T14:23:42.393Z）

- 迭代 30（inf/static 交替，负载=idle）
- **stale（press 后首个 eval 仍停旧页）：0/30**
- **empty（press 后首个 eval 表格读空）：0/30**
- evalFailed（结果取不到，不计入 stale/empty）：0/30
- 出错：1（#6:needle: 快照未产出）
- press→首个 eval 延迟 ms：p50=1173 p90=1442 max=1548

## 明细（stale/empty/evalFailed/err 的迭代全列）

- #6 /static stale=false empty=false evalFailed=false h0=undefined h1=undefined n1=undefined err=needle: 快照未产出
