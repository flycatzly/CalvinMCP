---
name: playwright-verify
description: |
  Playwright 端到端测试的「验收 / 门禁 / 执行 / 智能体」工具集：配置基线体检、用例静态扫描（20 条规则，ERROR 阻断）、
  失败聚类与四类归因、落盘式执行、PO 分层脚本生成（带生成门禁）、Excel 用例编排、团队规范校验，
  以及自然语言声明式测试（说目标不说步骤：LLM 只做规划，执行与判定走确定性链路，输出 JSON Pass/Fail）
  与页面探索巡检（死链/坏图/表单盘点）。
  用于「这批用例能不能合入」「这次失败该谁修」「长流程回归怎么跑不烧上下文」「手工用例表怎么变可执行回归」
  「说个测试目标帮我验一遍」「帮我巡检这个页面有没有死链坏图」这类问题。
  明确不负责：生成用例（官方 planner/generator/healer 做得更好）、搭建被测应用、自动修复断言、单元测试、
  纯接口契约测试、需要真机的移动端原生测试。也不自动提交修复 —— 只产出提案与门禁结论，判断必须由人来做。
---

# Playwright 验收门禁 Skill

这个 Skill 管一件事：**当生成已经免费，验收就是剩下唯一值钱的事。**

它不写用例。它回答四个问题：这批用例能不能合入？配置的可信度够不够？这次失败该谁修？长流程回归怎么跑才不烧上下文？

## 触发场景

| 你说的话 | 走哪条线 |
|---|---|
| 「帮我看看这批用例能不能合入」 | 门禁线：`check_config` → `lint_spec` |
| 「CI 上 6 条失败，帮我看看该谁修」 | 归因线：`summarize_report` |
| 「跑一下回归 / 验证一下这个流程」 | 执行线：`run_verify` |
| 「帮我探索这个页面，写下脚本」 | 探索线：`cli_health` → `cli_session` → `generate_scripts` |
| 「把这批手工用例表跑起来」 | 编排线：`orchestrate_excel` |
| 「团队规范怎么定 / 检查一下 AGENTS.md」 | 规范线：`check_standards` |
| 「说个目标帮我验一遍：登录加购后购物车应有该商品」 | 智能体线：`nl_test_goal` |
| 「帮我巡检这个页面，有没有死链坏图」 | 探索巡检：`explore_page` |

## 硬规则（每条都是一句 No，不含「尽量」）

1. **No 裸 XPath、nth-child、CSS 类名定位。** 只用 role / label / testid / text。降级顺序见 `references/locator-strategy.md`。
2. **No 固定时长等待。** 禁止 `waitForTimeout`，等状态、等网络、等轮询条件。见 `references/waiting-and-sync.md`。
3. **No 自动放宽断言。** 把断言放宽到能过，和修好定位器，在代码上长得几乎一样 —— 必须人来判。工具只产出提案。
4. **No 凭据进脚本。** 账号密码只从环境变量读，绝不写死在用例、Skill 或生成的脚本里。
5. **No 生产环境盲跑。** 默认只允许 test / staging，生产验证走独立审批。
6. **No 不验证就写盘。** 生成的脚本必须先过生成门禁（语法 + lint ERROR 0）才允许落盘。
7. **No 静默丢步骤。** 映射不了的步骤必须原样报出来，宁可让人补，也不能猜。
8. **No 把完整页面状态灌进上下文。** 一律落盘到 `.playwright-artifacts/`，按需读文件。
9. **No 碰真实资金与生产数据。** 涉及真实支付、真实用户数据的操作一律不可自动化执行。
10. **No 未加 `await` 的 Playwright 断言。** 参数是 page/locator/getBy\* 时它是异步的，不 await 会「永远通过」。
11. **No 危险目标与越权地址。** 真实资金、破坏性数据、生产操作、对外发送、批量对外 —— 智能体线在打开浏览器之前就硬拦截；生产主机要独立审批（`confirmProd: true`）。见 `references/nl-agent.md`。
12. **No 静默云端。** LLM 规划默认走本地 Ollama（数据不出机）；云端必须显式 `PVMCP_LLM=deepseek`。API key 只从环境变量读。

## 工作流（四步，每步指向具体 reference）

### 第 1 步：定骨架
先确认配置可信 —— **配置错的时候后面全是白干**。
```
check_config  { file: "playwright.config.ts" }
```
没有 `forbidOnly`，`.only` 会带着一条用例进 CI；`timeout` 拉到 300 秒，任何失败都会以「超时」的样子出现，你再也分不清是页面慢了还是功能坏了。详见 `references/evidence-and-traces.md`。

### 第 2 步：写定位与等待
按定位器降级表选，按允许的三种等待写。见 `references/locator-strategy.md`、`references/waiting-and-sync.md`。
要点：级别 1–3（role/label/testid）描述的是用户或开发者承诺的稳定契约，改版时通常被刻意保留；级别 4（text）描述的是内容，会随文案变；级别 5 之后描述的是实现，前端结构一动就全废。

### 第 3 步：过断言纪律
每条用例必须能回答「这条用例证明了什么」。断言必须 await（异步来源时），容器块不参与断言检查。见 `references/assertion-discipline.md`。

### 第 4 步：过门禁
```
lint_spec  { target: "tests/" }        # ERROR 必须清零才能合入
```
ERROR 必须让脚本以退出码 1 结束，这样才能挂进 CI。**只有 WARN 的检查等于没有检查。**

### 跑完之后：归因与派活
```
summarize_report  { file: "test-results/report.json" }
```
把 N 条失败压成 M 个根因签名。派活口径从「一条失败一个人」变成「一个签名一份工作量」。见 `references/flaky-triage.md` —— 这是全套文档里最重要的一篇。

### 智能体线：说目标，不说步骤
```
nl_test_goal  { goal: "登录后把商品加入购物车，购物车里应看到 \"ITEM-A\"", url: "https://app.test.example.com" }
```
LLM 只把目标翻译成受限计划（动作白名单），执行、断言判定、证据落盘走确定性链路 —— **模型编造不了「通过」**。
CI 挂门禁读报告 JSON 的 `verdict` 字段。死链/坏图巡检用 `explore_page`（确定性判定，不用 LLM）。
完整口径（七工具映射、LLM 配置、禁止事项）见 `references/nl-agent.md`。

## 输出契约

交付任何用例或报告时，必须同时给出：

1. **每条用例证明了什么** —— 一句话说明（`generate_scripts` 的 `claims` 字段会强制它）。
2. **门禁结论** —— ERROR / WARN 计数与退出码，不是「看起来不错」。
3. **失败的归因与下一步** —— 类别、派给谁、下一步动作，不是错误栈原文。
4. **证据路径** —— 截图 / trace / 日志的落盘位置，不是「我跑过了」。

## 结果回译（给不写代码的同事）

同事要的是「通过 / 没通过 + 为什么」，不是 `Error: expect(received).toBe(expected)`。按 `references/report-translation.md` 的模板输出「结论 + 证据 + 下一步建议」：

```
已按你的场景跑完 ✅
· 登录 test / 账号 u1：成功
· 下单 SKU_A、加购、去结算：均成功
· 订单金额校验：通过（实读 ¥99.00，预期 ¥99.00）
四步截图已附，需要我接着跑「用优惠券后金额」的对照吗？
```

## 自然语言使用示例

用户不会记命令，说人话是常态。下面三个完整对话示范「听到什么 → 调什么 → 怎么答」；更多说法见使用文档 §12。

**门禁：「帮我看看这批用例能不能合入」**

```
→ check_config { file: "playwright.config.ts" }   # 配置错的时候后面全是白干，先跑它
→ lint_spec { target: "tests/" }
← 答：配置体检 12 项全过；tests/ 42 个文件 → ERROR 0 / WARN 3
      WARN · PW002 固定时长等待 ×3（逐条列 文件:行 + 原文）
      结论：可以合入（ERROR=0）。3 处 WARN 建议换成 waitForResponse，要我列改法吗？
```

**归因：「CI 上 6 条失败，帮我看看该谁修」**

```
→ summarize_report { file: "test-results/report.json" }
← 答：6 条失败聚成 3 个根因签名：assertion ×3（金额显示 ¥0.00，派前端）
      / locator-strict ×2（「提交」按钮重复渲染，派前端 + 测试组改 testid）
      / timeout ×1（支付回调 30s 未返回，派后端）。环境类 0 条。
      按输出契约给：结论 + 证据路径 + 派活口径，不贴错误栈原文。
```

**智能体线：「说个目标帮我验一遍」**

```
用户：说个测试目标帮我验一遍：登录后把商品加入购物车，购物车里应看到该商品
→ nl_test_goal { goal: "登录后把商品加入购物车，购物车里应看到该商品",
                 url: "https://app.test.example.com" }
← 答：Pass。LLM 规划 5 步（goto → fill 账号 → fill 密码 → click 登录 →
      加购后 expect_text 商品名），全部绿；断言实读到商品名原文。
      证据：4 张截图 + 报告 .playwright-artifacts/reports/nl-*.json（verdict=Pass）。
      说「帮我巡检这个页面有没有死链坏图」我走 explore_page（确定性判定）。
```

答的时候遵守「输出契约」四条与「结果回译」模板；跑真实回归前先确认环境是 test / staging。

## 目录结构（渐进披露：看不到就等于不存在）

```
playwright-verify/
├── SKILL.md                    入口：边界、工作流、硬规则、输出契约（常驻上下文）
├── references/                 知识层：判定规则，按需加载
│   ├── locator-strategy.md         这个定位器该不该用？降级顺序是什么？
│   ├── waiting-and-sync.md         到底在等什么？等不到算谁的问题？
│   ├── assertion-discipline.md     这条用例证明了什么？断言行不行？
│   ├── test-structure.md           用例边界划得对不对？状态隔离了吗？
│   ├── flaky-triage.md             这次失败是产品回归、用例缺陷还是环境抖动？
│   ├── evidence-and-traces.md      失败现场留了什么证据？够不够定责？
│   ├── cli-mode.md                 CLI 模式怎么用？哪些命令、怎么落盘？
│   ├── po-and-generation.md        页面层与用例层怎么分？生成门禁是什么？
│   ├── report-translation.md       结果怎么回译成人话？
│   ├── env-and-accounts.md         环境与账号口径怎么外置？
│   ├── nl-agent.md                 智能体线：声明式测试、七工具映射、LLM 配置、禁令
│   └── team-standards.md           团队规范怎么写进 AGENTS.md？
├── scripts/                    执行层：确定性检查与包装（机器执行，不进上下文）
│   ├── verify-lib.mjs              定位 mcp/lib 的解析器
│   ├── lint_spec.mjs               用例静态扫描
│   ├── check_config.mjs            配置基线体检
│   ├── summarize_report.mjs        失败聚类与归因
│   ├── run_verify.mjs              执行回归
│   ├── check_standards.mjs         团队规范校验
│   └── selfcheck.mjs               环境自检
└── assets/                     资产层：模板（直接复制进项目）
    ├── playwright.config.ts        配置基线
    ├── test-template.spec.ts       用例骨架
    ├── page-object-template.ts     页面对象骨架
    ├── AGENTS.md                   团队测试规范片段
    └── accounts.example.json       环境与账号映射示例
```

## 边界：它不做什么

- **不生成用例。** 官方 planner / generator / healer 做得更好，我不碰。
- **不替代测试分析。** 它只验证你描述的场景；覆盖该不该有、断言对不对，还是人的事。它不会自己发现「你漏测了退款路径」。
- **不自动改断言。** healer 可以提议修，但必须人来判。
- **不碰真实资金与生产数据。** 涉及真实支付、真实用户数据的操作一律不可自动化执行。智能体线把这条做成代码：危险目标、生产主机在打开浏览器之前就拒绝。
- **LLM 只做规划，不做判定。** 「通过 / 不通过」永远由确定性断言链给出，模型说不算；计划里混入白名单外的动作，整份计划作废而不是挑着执行。
- **不把页面内容送出机。** LLM 默认本地 Ollama；只有显式开云端时目标文本才发给该云端，截图与页面快照永不进 LLM 请求。
- **不适用于**单元测试、纯接口契约测试、需要真机的移动端原生测试。
- **不维护被测应用。** 定位约定是「当前页面结构」的投影，页面重构后 `references/locator-strategy.md` 要同步更新，否则生成质量会悄悄劣化。

## 关键接口速查

| 工具 | 一行说明 |
|---|---|
| `check_config` | 配置基线体检（CFG001–CFG012），放流水线最前面 |
| `lint_spec` | 用例静态扫描（20 条规则），ERROR 阻断 |
| `summarize_report` | 失败聚类 + 四类归因 + 派活口径 |
| `run_verify` | 落盘式执行（输出重定向到文件） |
| `cli_health` | CLI 最小闭环验收：能开页面、能拿快照、能截图 |
| `cli_session` | CLI 会话操作，产物一律落盘 |
| `generate_scripts` | PO 分层生成，带生成门禁 |
| `check_standards` | 团队 AGENTS.md 规范校验 |
| `orchestrate_excel` | Excel 手工用例 → 可执行回归 |
| `explain_rules` | 规则表自省（哪条为什么报、怎么关） |
| `selfcheck` | 服务级自检（脱敏不变量、运行器、CLI、Python、LLM） |
| `explore_page` | 页面探索巡检：死链/坏图/表单盘点，确定性判定出 Pass/Fail |
| `nl_test_goal` | 智能体线：自然语言目标 → 受限计划 → 真执行真断言 → JSON verdict |

## 版本记录

- **v1.1.0（2026-10-03）**：智能体线 —— `nl_test_goal`（说目标不说步骤：LLM 只做规划，
  执行与判定走确定性链路，输出 JSON verdict）+ `explore_page`（死链/坏图/表单盘点巡检），
  工具 11 → 13；合并 LangChain PlayWrightBrowserToolkit 七工具语义（映射见 `references/nl-agent.md`）；
  LLM 本地默认/云端显式开/可关（key 只从环境变量）；守门前置 + 计划白名单 + 无断言=Blocked；
  新增 2 套件（72 + 18 断言），加固 H17。
- **v1.0.0（2026-10-03）**：首发 11 工具 + Skill + 10 套件全量回归（345 断言）+ 真实浏览器矩阵；
  同日加固 H12–H16、CLI 通道配置按目标平台自适应、纯净分发逐文件哈希自校验。
  完整版本说明见 README「版本记录」；**每次版本更新须同步全部文档的版本号与版本说明**
  （规范见 README「版本与文档同步规范」，加固 H16 机械检查同步不缺项）。
