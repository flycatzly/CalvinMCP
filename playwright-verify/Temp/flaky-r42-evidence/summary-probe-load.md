# Phase D 竞态窗口实测 — load（2026-10-07T14:26:22.108Z）

- 迭代 30（inf/static 交替，负载=2×CPU 烧瓶）
- **stale（press 后首个 eval 仍停旧页）：0/30**
- **empty（press 后首个 eval 表格读空）：0/30**
- evalFailed（结果取不到，不计入 stale/empty）：0/30
- 出错：1（#19:needle: 快照未产出）
- press→首个 eval 延迟 ms：p50=1192 p90=1466 max=1610

## 明细（stale/empty/evalFailed/err 的迭代全列）

- #19 /inf stale=false empty=false evalFailed=false h0=undefined h1=undefined n1=undefined err=needle: 快照未产出
