# 证据链与 trace 采集

这个文件回答一个判断题：**失败现场留下了哪些证据？没有证据的时候，我凭什么下归因？**

`flaky-triage.md` 里的每一步「打开 trace 看页面实际状态」「对照 snapshot 检查元素」都以前提条件成立为基础：**trace 得先被录下来**。没有证据链，归因只能靠猜。对应 `check_config` 的 CFG003 / CFG004 / CFG007，以及 `cli_*` 工具的落盘约定。

---

## 1. CFG003｜trace 未开启（ERROR，阻断）

- **判据**：`use.trace` 未设置，或取值是 `off`。`check_config` 报 ERROR。
- **反例**：

```ts
// ✗ CFG003：失败现场只有一行报错
export default defineConfig({
  use: {},
});
```

```ts
// ✓ 推荐写法：只在第一次重试时录 trace，成本与证据兼得
export default defineConfig({
  retries: process.env.CI ? 2 : 0,
  use: { trace: 'on-first-retry' },
});
```

- **评审检查点**：随便挑一条最近失败的用例，回答「它当时页面长什么样、发了哪些请求、是哪一步崩的」。答不出来 → 证据链是断的，先把 trace 开起来再谈别的。
- **为什么这是 ERROR**：`trace: off` 或未设置时，失败现场只有一行报错——**没有 DOM 快照、没有网络记录、没有每一步的截图**。于是 `flaky-triage.md` 里的三类归因根本无从展开：

  | 归因动作 | 需要的证据 | trace 关着时 |
  | --- | --- | --- |
  | 判断是产品回归还是断言写错 | 失败时刻的页面实际状态 | 只能猜 |
  | 判断定位器是否失效 | DOM 快照里元素还在不在 | 只能猜 |
  | 判断超时是慢还是坏 | 每步耗时与请求瀑布 | 只能猜 |

  归因全部退化成「靠猜」时，再准的门禁也没有意义——你会得到一堆红色和一句「不知道哪里坏了」。
- **取值口径**：`'on-first-retry'`（推荐）、`'retain-on-failure'`、`'on-all-retries'` 都达标。`trace: 'on'` / `'always'` 会给**每条**用例都录 trace，CI 时间和磁盘占用显著上升，`check_config` 会报 WARN CFG003 提示改成 `'on-first-retry'` 或 `'retain-on-failure'`。

---

## 2. CFG007｜失败时没有 screenshot / video 证据（WARN，人工确认）

- **判据**：`use.screenshot` 与 `use.video` 都没设置。`check_config` 报 WARN。
- **反例**：

```ts
// ✗ CFG007：结论有了，但没有能给人看的证据
export default defineConfig({ use: { trace: 'on-first-retry' } });
```

```ts
// ✓ 失败时自动留图与录像
export default defineConfig({
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
```

- **评审检查点**：结果回译要附「对应步骤截图」才有说服力（见 `report-translation.md`）。如果这次交付的结论文档里一张图都没有，同事看完仍会来找人确认，封装就白做了。
- **为什么是 WARN 而不是 ERROR**：trace 已经能重建现场，screenshot/video 是**给人看的**那一层。技术上门禁可以放行，但交付质量上它是硬缺口。
- **反向也要看**：`screenshot: 'on'` 是每条用例都截图，会显著拖慢 CI，`check_config` 报 WARN CFG007 提示改为 `'only-on-failure'`。证据要「失败时必有」，不是「每次都有」。

---

## 3. CFG004｜report 需要 json reporter 才能自动聚类（ERROR，阻断）

- **判据**：没有配置 `reporter`（缺省只有给人看的 `list`），报 ERROR；配了 reporter 但里面没有 `json`，报 WARN。
- **反例**：

```ts
// ✗ CFG004：默认 list reporter 只给人看，机器读不了
export default defineConfig({});
```

```ts
// ✓ 机器可读的产物是聚类与派活的前提
export default defineConfig({
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/report.json' }],
  ],
});
```

- **评审检查点**：`test-results/report.json` 是否存在、是否被 CI 归档？`summarize_report` 的输入就是它。
- **为什么这是 ERROR**：没有 json reporter，`summarize_report` 拿不到结构化失败记录，只能去解析文本输出——稳定性下降，「按签名聚类再派活」这一步就无法自动化。而这一步正是整套方法论的核心产出（见 `flaky-triage.md` 第 1 节）。报告不可机器消费，等于归因回到人工逐条读栈。

---

## 4. 产出必须落盘：证据目录约定

所有证据落到约定目录，不散在临时路径。散在临时路径的证据，评审时找不到；进不了制品库，也就等于没有。

```
.playwright-artifacts/
├── snapshots/      # 可访问性快照（Markdown / YAML，`cli_snapshot` 产出）
├── screenshots/    # 截图与 PDF（PNG / PDF，`cli_screenshot` 产出）
├── traces/         # trace 文件（`cli_trace_*` 与 Playwright trace 落点）
├── logs/           # CLI 与测试进程的 stdout/stderr 日志
├── reports/        # 汇总给人的报告产物
└── state/          # 登录态等可复用状态（storageState，如 u1.json）
```

约定背后的四条理由：

1. **不再灌进上下文。** `cli_*` 系列一律落盘，返回值只给路径与摘要。`snapshot` 会自动写进 `snapshots/<session>-<n>.md` 并带 `--depth` 限制；`screenshot` 写进 `screenshots/<session>-<n>.png`。想看内容时按需读那一个文件，而不是把整棵可访问性树塞回对话。
2. **顺序可查。** 同一会话的产物按序号命名（`<session>-1`、`<session>-2`），而不是靠时间戳猜顺序——失败发生在那一步，看编号就知道。
3. **可直接当工单附件。** 落盘文件天然可归档、可 diff、可挂进 PR。
4. **状态可复用。** 登录态存 `state/u1.json`，几十条用例共享一份，不必每条用例都真的走一遍登录 UI。

同样的落地在 CI 侧：`run_verify` 把 Playwright 的 stdout/stderr **重定向到文件**（默认 `test-results/logs/playwright-test.out.log` 与 `.err.log`），而不是用管道。收益不止是绕过沙箱对管道的限制：长回归的日志不会撑爆内存，产物天然落盘可归档。

---

## 5. 证据链清单（交付前逐项对照）

| 证据 | 落点 | 谁产出 | 缺了会怎样 |
| --- | --- | --- | --- |
| 失败现场（DOM/网络/每步截图） | `.playwright-artifacts/traces/` | `trace: 'on-first-retry'` | 归因只能靠猜（CFG003） |
| 失败截图 | `.playwright-artifacts/screenshots/` | `screenshot: 'only-on-failure'` | 结论没人信，同事仍来问（CFG007） |
| 结构化失败记录 | `test-results/report.json` | `['json', { outputFile }]` | 无法聚类派活（CFG004） |
| 执行日志 | `test-results/logs/*.out.log`、`*.err.log` | `run_verify` | 超时/崩溃原因丢失 |
| 页面快照 | `.playwright-artifacts/snapshots/` | `cli_snapshot` | 无法对照元素是否改名/改结构 |
| 登录态 | `.playwright-artifacts/state/` | `cli_state_save` | 隔离性与速度都受损 |

**评审检查点（这一篇的总检查点）**：任意挑一条失败的用例，必须能同时指出它的 trace 文件、截图文件与报告条目。三者缺一，这次交付的证据链就不完整。
