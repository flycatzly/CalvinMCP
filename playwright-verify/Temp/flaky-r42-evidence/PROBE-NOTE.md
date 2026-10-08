# Phase D 探针 v1 缺陷与数据抢救记录（r42）

## v1 缺陷（已修，v2 重跑数据为准）

1. **eval 结果取错源**：eval 不在 MUST_REDIRECT（mcp/lib/cli.js:78，只含
   snapshot/screenshot/pdf），不注入 --filename → `artifacts.file` 恒 undefined，
   v1 的 `evalJs` 读 `artifacts.file` 永远取不到结果。
   真实 collect 的口径是**调用方自带 `--filename`**（mcp/server.mjs:980，
   注释 757 明说「eval 不在 MUST_REDIRECT 里」）→ v2 已逐字同款。
2. **null 误判为 empty**：`Number(h1?.n || 0) === 0` 把「取不到结果」判成「表格读空」
   → v1 输出 empty=30/30 全假阳。v2 已把 null 归独立类别 evalFailed，不进 stale/empty。

## 抢救（v1 的真值藏在 CLI 日志里）

- v1 每次 eval 的 stdout 落在 `.playwright-artifacts/logs/cli-probeR42-<i>-eval.out.log`
  （同名后写覆盖，存活块=press 后的 h1）。
- **load 相 30/30 抢救真值：h1 全部 href=page=2、n=5 —— 零 stale、零空表**
  （含 2×CPU 烧瓶负载；press→eval 延迟 ~1.16-1.31s）。
- idle 相日志被 load 相同名会话（probeR42-1..30）覆盖，无法抢救 → v2 重跑补齐。

## 结论口径（供 r43 参考）

press→eval 竞态窗口在 CLI 子进程往返（~1.2s）面前结构性不可达：
localhost 导航完成在毫秒级，eval 执行必在导航完成之后。
v2 的 idle 30 + load 30 是干净口径；v1 摘要（summary-probe-* 首版）作废不引用。
