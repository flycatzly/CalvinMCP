---
name: playwright-verify
description: |
  Playwright 端到端测试的「验收 / 门禁 / 执行 / 智能体」工具集：配置基线体检、用例静态扫描（20 条规则，ERROR 阻断）、
  失败聚类与四类归因、落盘式执行、PO 分层脚本生成（带生成门禁）、Excel 用例编排、团队规范校验，
  以及自然语言声明式测试（说目标不说步骤：LLM 只做规划，执行与判定走确定性链路，输出 JSON Pass/Fail，
  定位失败走两层自愈、断言绝不自愈）、页面探索巡检（死链/坏图/表单盘点）与分页表格采集（翻页收集 + 两期对比）。
  用于「这批用例能不能合入」「这次失败该谁修」「长流程回归怎么跑不烧上下文」「手工用例表怎么变可执行回归」
  「说个测试目标帮我验一遍」「帮我巡检这个页面有没有死链坏图」「把分页的档案表都采下来和上期对比」这类问题。
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
| 「把这几页的档案表都采下来，和上期对比」 | 采集线：`collect_table` |
| 「采集中断了 / 昨天没采完，从断点接着采」 | 采集线：`collect_table`（`resumeFrom` 断点续采） |

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

用户不会记命令，说人话是常态。下面三个完整对话示范「听到什么 → 调什么 → 怎么答」；更多说法见 README「自然语言使用示例」。

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
| `setup-browser-config` | 浏览器通道配置生成（按平台写 `.playwright/cli.config.json`，Windows 默认 msedge） |
| `cli_health` | CLI 最小闭环验收：能开页面、能拿快照、能截图 |
| `cli_session` | CLI 会话操作，产物一律落盘 |
| `cli_batch` | 多步 CLI 串联执行 |
| `generate_scripts` | PO 分层生成，带生成门禁 |
| `check_standards` | 团队 AGENTS.md 规范校验 |
| `orchestrate_excel` | Excel 手工用例 → 可执行回归 |
| `explain_rules` | 规则表自省（哪条为什么报、怎么关） |
| `selfcheck` | 服务级自检（脱敏不变量、运行器、CLI、Python、LLM） |
| `explore_page` | 页面探索巡检：死链/坏图/表单盘点，确定性判定出 Pass/Fail；表单指纹（formsHash）+ 两期对比（diffAgainst） |
| `nl_test_goal` | 智能体线：自然语言目标 → 受限计划 → 真执行真断言 → JSON verdict（定位失败两层自愈、自愈 LLM 有预算总闸，断言绝不自愈） |
| `collect_table` | 分页表格采集：页码框/下一页翻页、三选止损、两期 diff、断点续采（`resumeFrom`，指纹不符拒续）、rows.json + CSV 只落盘 |

## 版本记录

- **v1.21.0（2026-10-08）**：浏览器插件插拔式双模 —— 面板/悬浮球「⚡ 依赖 MCP / 🔋 独立模式」按钮切换（pv_mode 同键持久化）；独立模式本地能力保留（录制/回放/导出/console），桥依赖面停用+守卫诚实提示零发出。全链路排查修 2 真 bug：配置键分裂（面板 base/token vs 背景 pv_base/pv_token → 统一+旧键迁移）、clientInfo 硬编码 1.9.0 → 读 manifest。bridge-check 42→49、floating-check 100→105、floating-e2e 27→30。CORE 728/783/914，全量 945。
- **v1.20.0（2026-10-08）**：悬浮球导出录制 JSON —— 面板「📤 导出录制」把当前录制转成 generate_scripts 输入载荷（write:false 恒 false）Blob 下载带走（纯本地不走桥），文件名 exportFileName 清洗（保留字符/60 帽/空名与全符号糊回落 recording），整链 try/catch 不掀翻面板。floating-check 92 → 100、floating-e2e 26 → 27。CORE 716/771/899，全量 930。
- **v1.19.0（2026-10-08）**：PW006 修饰断言形态扫尾 —— 正则扩 expect.soft/expect.poll（不 await 同样假通过，与 PW007 认知面恢复对称），requireAsyncSource 闸门头剥离抽 EXPECT_HEAD_RE 单一源，闸门语义不变；对抗语料 +5 钉，lint-check 53 → 58。CORE 708/763/890，全量 921。
- **v1.18.0（2026-10-08）**：崩溃/异常退出现场落盘 —— verify-all 崩溃 close 与挂死双分支经 `crashbundle.js` 立即写 `crash-bundles/<时间戳>_<套件>/`（stdout/stderr 全量 + meta.json 双形态退出码），全绿零产出、写失败不掀翻、自修剪 20、不进收尾清理（全绿不抹证据）；crash-bundles 进 exclude.js 单一源。加固 H30 十六钉；hardened 133 → 149；CORE 703/758/885，全量 916。
- **v1.17.0（2026-10-07）**：录制行内重命名 —— ✎→行内输入（Enter/Esc/空名诚实拒/点行退出），提交走 r41 renameRecording 纯函数落盘（数据保真）。行为钉逮到真产品 bug（appendChild(name) 未声明即用 → 点 ✎ 崩，真浏览器同崩）。floating-check 86 → 92、floating-e2e 25 → 26，咬合 1 组恰中。全量 16 套件 900 断言（+ 矩阵 4 签名）。
- **v1.16.0（2026-10-07）**：悬浮球富渲染 —— pvFactsLine 关键事实一行化（键序前 4 席、数组计数含 0 如实、verdict 不重复、值保真），接进 resultTextOf：【verdict】facts | 正文（截 300）。floating-check 80 → 86，咬合 1 组恰中。全量 16 套件 900 断言（+ 矩阵 4 签名）。
- **v1.15.0（2026-10-07）**：判据基数 serial 解耦 —— verify-all 判据行 find 单取第一个 serial 套件改 `serialAssertions()` 求和（suites.mjs 新导出，与 planWaves serials 同源：多 serial 各占一波全计入），serial 计入按声明匹配不硬编码 deployed-check 文件名；H29 五钉（解耦接线/硬编码回归/单 serial 等价恰 30/多 serial 夹具 7+11=18/planWaves 波序列同源）。hardened 128 → 133；CORE mode 1/2/3 = 675/730/856。
- **v1.14.0（2026-10-07）**：排除口径单一源 —— `mcp/lib/exclude.js`（三集合成 EXCLUDE_DIRS/文件模式/IGNORE_TOP/运行时产物双向豁免 diffManifests），distribute/install/deployed-check 三面派生不写字面量、净树 `nettree.mjs` 脚本化（忠实镜像减排除）、H28 fixture 哨兵七钉（install 沙箱 + nettree 真跑，源文件不误杀/产物不漏排）。hardened 121 → 128；CORE mode 1/2/3 = 670/725/851。
- **v1.13.0（2026-10-07）**：悬浮球录制管理 —— pv_recordings_list 多条列表（前插/容量帽 10 诚实淘汰/自动命名）、面板内联列表（选中/删除/选中态跟随）、旧单槽读取迁移+兼容写入；纯函数核 6 函数不可变更新。floating-check 71 → 80、floating-e2e 22 → 25，咬合 1 组 2 钉。全量 16 套件 893 断言（+ 矩阵 4 签名）。
- **v1.12.0（2026-10-07）**：结构化结果可视化 —— 面板 pvStructuredModel 视图模型（kv/表格/深度帽 3/行帽 20/total 诚实）替代 JSON 倾倒，渲染只走 textContent（XSS 面为零、文本通道不动）；悬浮球 verdict 徽标（【Pass】前置、无值不伪造）。bridge-check 34 → 42、floating-check 69 → 71，1 咬合。全量 16 套件 875 断言（+ 矩阵 4 签名）。
- **v1.11.0（2026-10-07）**：悬浮球端到端转正常驻套件 —— `mcp/test/floating-e2e.mjs` 22 断言（真 msedge+扩展+自起桥+本地靶场三形态：light DOM/开放影子树/关闭影子树，零外网依赖），录制→归一→刷新恢复→回放含深搜→工具快捷→URL 守门→诚实停止→稳定性复跑全钉；修出 keydown key 在事件上（press 真页面录不进）与 Playwright Enter 补发 change 的同值无损归一两个真 bug；floating-check 66 → 69。全量 16 套件 863 断言（+ 矩阵 4 签名）。
- **v1.10.1（2026-10-07）**：成功判定要证据，不只退出码（H26）—— runCli 加证据面
  `judgeRunEvidence`：强制落盘子命令（snapshot/screenshot/pdf）产物必须在场且非空、
  png/pdf 魔数对、快照含 `ref=eN` 标记；CLI 自报 isError 信封（exit 0）判
  CLI_REPORTED_ERROR 不被吞；open/close 等无产物子命令保持退出码契约。判据全用结构事实。
  裸 `process.exit(0)` 的假 CLI 不再骗出「最小闭环通过」假绿（复现台实锤修复前后对照）。
  H26 八钉，hardened-check 107 → 115；负向咬合恰 6 钉红（负向全中、正向不冤枉）、
  sha256 往返一致。全量 16 套件 853 断言（+ 矩阵 4 签名）。
- **v1.10.0（2026-10-07）**：猫耳悬浮球 —— `extension/floating.js`（Shadow DOM 隔离、可拖拽猫耳球、录制中脉冲+步数角标、快速面板 🎬/⏹/▶/控制台 + 巡检/采集/生成/NL 快捷）+ `recorder.js` 纯函数核（定位器六级优先级与 canonicalLocator 同口径、敏感双防线含 nameAttr、归一合并/去重/截断、locatorToQuery 非法抛错）；架构 content script → SW 中转（口令只经 x-bridge-token 请求头）→ 桥 → MCP；回放 URL 守门、未找到即停。新套件 floating-check 66 断言（vm 真文件 + stub DOM 真跑，含真机实测 6 处补钉、影子树深搜与代码文本防护），deployed 28 → 30；负向咬合 3 组（5+7+1 红）+ 绿态咬合抓出 nameAttr 真 bug。全量 15 套件 811 断言（+ 矩阵 4 签名）。
- **v1.9.1（2026-10-07）**：零依赖口径只认副本本地 —— `PVMCP_LOCAL_ONLY_DEPS=1` 时可选依赖
  只认 cwd/node_modules，机器级全局（npm i -g / PATH shim）不参与判定；verify-all 三模式
  全程置位，mode 2 预检 / 套件 SKIP / cli_health 诚实报缺全按副本口径。执行契约不变
  （真实用户 @playwright/cli 仍由本机提供）。修掉全局 shim 机器级假设缺口（门禁嵌套 mode 2
  永不可绿、净树诚实报缺被顶替、混合态对账静默跳过）。加固 H25 +3、hardened-check 104 → 107；
  负向咬合 1 组零误伤。全量 14 套件 746 断言（+ 矩阵 4 签名）。
- **v1.9.0（2026-10-07）**：浏览器插件控制台（MV3）+ 本地桥 —— `extension/` 加载已解压扩展后
  点图标开整页控制台，表单由 tools/list 的 inputSchema 现场生成、tools/call 调全部 16 个工具；
  `mcp/bridge.mjs` HTTP ⇄ JSON-RPC 复用 handleMessage（零协议分叉），只绑 127.0.0.1、
  Host 挡 DNS rebinding、网页来源 403、可选口令三态、4MB 413，参数值不进观测日志（哨兵钉住）。
  新套件 bridge-check 34 断言，deployed-check 26 → 28；负向咬合 2 组零误伤。
  全量 14 套件 743 断言（+ 矩阵 4 签名）。
- **v1.8.18（2026-10-06）**：cli_health 浏览器缺失自愈闭环 —— 三签名分类（含缓存被清的真实报错形态，
  daemon 噪声行不干扰）+ 决策矩阵 stale-exec-pin 规则（机器生成物残留 executablePath 钉即按平台重生成，
  手工配置不自动动）+ 重写 channel 式配置重试一次，`autoHeal` 字段如实标注。H13 +4、H24 +3、cli-e2e +4；
  hardened-check 97 → 104、cli-e2e 21 → 25；全量 13 套件 707 断言（+ 矩阵 4 签名）。
  另修自愈执行线三处回归（mode 3 抓出，断言数不变）：收尾 close 移到 executePlan 之后的 finally
  （batch 尾提前关会让自愈 NO_SNAPSHOT）；自愈成功后剩余步骤作废旧批量结果逐步真跑（断言证据
  不比自愈快照旧）；批量步补记 durationMs。负向咬合 5/3/1 红零误伤。
- **v1.8.17（2026-10-06）**：setup-browser-config 同步链补齐 —— 第 16 个工具 `setup-browser-config`
  （按平台生成 `.playwright/cli.config.json` 浏览器通道配置；Windows 默认 msedge）入表时没走同步链
  （工具数钉停在 15、EXPECTED 清单漏项、文档工具表漏行）—— 本轮补齐：deployed-check / nl-agent-check
  工具数钉 15 → 16 且 EXPECTED 补 `setup-browser-config`，README/部署说明/SKILL 工具表与覆盖清单
  全部 16/16（本表顺带补回漏掉的 `cli_batch` 行），install 提示文案同步 16。断言数不变（只改既有断言的期望值与文档计数）。
- **v1.8.16（2026-10-05）**：cli_batch 同步链补齐 —— 工具数钉 14 → 15、EXPECTED 补项、
  文档工具表与覆盖清单 15/15；收拢 r23–r32 修复（goto 去重、同名页面报错、CFG 基线、
  severity 过滤、trace on-first-retry 取空修复、run_verify 附 reportFile）。
  另收敛 executePlan cliBatch 与 runStep 两路径语义：click 参数映射（value 曾被当鼠标键
  第二位置参数、带 value 必炸）+ 结果形状（补 act/target/value，缺 act 时 verdictOf
  误判 Blocked）+ 断言判定（`judgeExpectation` 单一源按快照内容判、失败钉「不放宽」），
  映射/判定收敛为单一源 `stepCliArgs` / `judgeExpectation`。
  另加通道环境适配 `PVMCP_CLI_BROWSER`（Defender 拦缓存新二进制的机器切 msedge，
  仅 open 注入）。nl-agent-check 133 → 145；全量 13 套件 686 → 698 断言。
- **v1.8.15（2026-10-05）**：log_summary 按工具块 —— text 按工具段落改多行块、按调用量
  降序、透出 maxMs 与 cache 三态/命中率；--json 零变化。protocol-check 115 → 116；
  全量 13 套件 686 断言。
- **v1.8.14（2026-10-05）**：安装器镜像式复制 —— 默认安装先清后拷（托管子树/现役 Skill
  目录/bundle，源码删过的文件不留旧账），`--force` = 整目录重置。H23 沙箱真装三钉；
  hardened-check 94 → 97；全量 13 套件 685 断言。
- **v1.8.13（2026-10-05）**：对抗语料属性化生成 —— 每条 lint 规则自带 `samples`（bad/good，
  `adversarialCorpus()` 展开、lint-check 真 lint 跑 40 案）；rules-check 覆盖门：新规则不带
  语料进不了表。lint-check 32 → 53、rules-check 35 → 37；全量 13 套件 682 断言。
- **v1.8.12（2026-10-05）**：explore_page 表单指纹与两期对比 —— facts 补采 `required`；
  报告带 `formsHash`/逐表单 `hash`（字段重排不算漂移）；`diffAgainst` 指上一期 `factsFile`
  出两期对比（字段增删/必填位变化/表单增删，明细有界 + total 诚实，不改 verdict，
  不可读报错 DIFF_TARGET_INVALID）。nl-agent-check 127 → 133、nl-agent-e2e 18 → 21；
  全量 13 套件 659 断言。
- **v1.8.11（2026-10-05）**：趋势 structuredContent 瘦身 —— 全量趋势 JSON 落盘
  `trend-*.json`（与 md 同名，含 sample，CI 对账以落盘为准）；structuredContent 有界化
  （version 2：四列表各截 50 与 md 同一常量、去 sample、`*Total` 诚实计数、`contextTruncated`）；
  format=json text 同口径。130 签名实测 50.9KB → 21.7KB（省 58%）。
  signature-check 37 → 42、nl-agent-check 126 → 127；全量 13 套件 650 断言。
- **v1.8.10（2026-10-05）**：计划缓存命中率观测 —— `PVMCP_LOG` 的 nl_test_goal 行扩
  `cache=hit|miss|skip` 字段（其余工具不落；值取报告 planCache 单一源）；`log_summary`
  按工具透出三态分布与命中率 `hit/(hit+miss)`（skip 不进分母、只有 skip 时 null）；
  白名单外值进 malformed 不静默猜；无 cache 行输出与旧口径逐字节一致。
  protocol-check 109 → 115、flow-check 41 → 44（真 stdio 双调用实测行格式）；
  全量 13 套件 644 断言。
- **v1.8.9（2026-10-05）**：趋势 md 行截断 —— 多报告趋势四个渲染列表按权重序各截前 50 行
  + 诚实「还有 N 条」计数；结构化数据保全量，md 只截展示不截数据。
  signature-check 31 → 37、nl-agent-check 125 → 126；全量 13 套件 635 断言。
- **v1.8.8（2026-10-05）**：`nl_test_goal` 计划缓存 —— 同指纹（goal/url/provider/model）复用
  LLM 规划、绝不复用执行（命中后仍全量真跑、证据新鲜落盘）；TTL 5 分钟 / 容量 8，
  只缓存成功的 LLM 计划；报告增量字段 `planCache`（hit/miss/skip）可审计。
  nl-agent-check 118 → 125、flow-check 34 → 41；全量 13 套件 628 断言。
- **v1.8.7（2026-10-05）**：`summarize_report` 多报告趋势 —— 传 `files`（N 份报告路径或目录）
  出通过率曲线 + 签名漂移（新签名/消除/持续），趋势表落盘 md 只回摘要；坏报告整体报错
  不静默跳过；readOnlyHint 诚实翻 false。signature-check 27 → 31、nl-agent-check 115 → 118；
  全量 13 套件 614 断言。
- **v1.8.6（2026-10-05）**：同类参数整数化清扫收尾 —— `run_verify.retries/timeoutMs`、
  `cli_session.timeoutMs`、`nl_test_goal.maxSteps` 换 `intArg`（小数参数层拒绝；
  timeoutMs=0.5 曾被放行成 0.5ms 真超时）；`collect_table` 报告补 `pagesTotal`
  （含基准累计页账，pagesScanned 保持本轮语义）。nl-agent-check 111 → 115、
  flow-check 32 → 34；全量 13 套件 607 断言。
- **v1.8.5（2026-10-05）**：`explore_page` 探活预算 —— 慢死主机整段放大（上限 50 条 ≈ 65s
  无反馈）双层预算兜住：单条 `probeTimeoutMs`（默认 5000）+ 整段 `probeBudgetMs`（默认
  20000）；耗尽后剩余链接逐条记不可达 + `budgetExhausted`、报告标注 partial（不静默跳过）；
  `maxLinks` 换 `intArg`（2.5 拒绝）。nl-agent-check 105 → 111；全量 13 套件 601 断言。
- **v1.8.4（2026-10-04）**：观测日志容量上限与轮转（`PVMCP_LOG_MAX_MB`，默认 2MB、0=关闭、
  非法值回退默认并 stderr 提示）—— 超限轮转移 `<file>.1`，`log_summary` 提示轮转前件，
  调用量少一段不再静默；协议套 102 → 109；全量 13 套件 595 断言。
- **v1.8.3（2026-10-04）**：真实测试轮（真 stdio + 真浏览器 11 项实测）抓出 2 个参数语义 bug 修复 ——
  整数参数严格校验（`intArg`）：`keyIndex`/`maxPages` 传小数参数层报「应为整数」，不再静默取整
  跑出误导结果（keyIndex=1.5 曾误报「站点没数据」）；负向咬合抓出测试钉脆断并加固，4/4 具名回红。
  args-check 42 → 46、nl-agent-check 103 → 105；全量 13 套件 588 断言。
- **v1.8.2（2026-10-04）**：`collect_table` 断点续采（`resumeFrom`）—— 带上次 rows.json 从断点页续扫、
  pages 链式归并可再续；基准指纹（url/keyIndex）不符拒绝续采（`COLLECT_STALE`），单页组合
  `COLLECT_RESUME_NOT_APPLICABLE`（打开浏览器前拒）；nl-agent-check 94 → 103、flow-check 27 → 32，
  1 组负向咬合 4 条具名钉回红；全量 13 套件 582 断言。
- **v1.8.1（2026-10-04）**：自愈 LLM 调用预算硬化 —— 二级自愈加整次运行总闸 `healLlmBudget`
  （默认 2、硬上限 10、0=不问 LLM），预算尽如实 `HEAL_LLM_BUDGET_EXHAUSTED`（LLM 零调用、
  不静默降级），报告增量字段 healLlmBudget/healLlmUsed 可审计；nl-agent-check 85 → 94
  （预算钉 +9），2 组负向咬合回退全红；全量 13 套件 568 断言。
- **v1.8.0（2026-10-04）**：两篇文章差异化能力合入 —— 两层定位自愈（快照按名整词匹配 → LLM 从
  ≤40 条元素清单挑 ref，选择题契约；**断言绝不自愈**）、第 14 个工具 `collect_table`（翻页采集/
  两期 diff/CSV 只落盘）、flow-check 全流程验证套件（27 断言）。真实测试抓 5 个真 bug 修复 +
  5 组负向咬合回退全红。工具面 13 → 14，全量 13 套件 559 断言。
- **v1.7.3（2026-10-04）**：对抗语料轮 —— 修掉 7 个规则洞（PW002 链式 .only、PW008 链式接收者、
  PW013 调用形态、PW006 前缀劫持与跨行断言漏报、PW106 有参等待误报、链式修饰容器误判成用例）；
  扫描器套新增 18 条对抗语料钉（9 洞钉 + 9 守卫），14 → 32，全量 12 套件 518 断言。
- **v1.7.2（2026-10-04）**：修复 `summarize_report` 静默全零假绿（坏 JSON/非报告形状现在
  isError + REPORT_ERROR）；签名套 +4、协议套 +2，全量 12 套件 500 断言。
- **v1.7.1（2026-10-04）**：真实测试修复轮 —— 修复 stdin EOF 静默丢调用（close 先排空队列再退出，
  排空钉 40 连发钉住）；修复版本漂移（VERSION 只认仓库根 package.json）；错误码语义化
  （失败出口强制 `errorCode` 短码，日志 `code=` 不再落字面 `isError`）。MCP 协议套 95 → 99，
  全量 12 套件 494 断言。
- **v1.7.0（2026-10-04）**：新增 `log_summary` 命令（消费 `PVMCP_LOG` 观测日志）：调用量（含被拒）、
  成功率、延迟分布、错误分布一页纸，`--json` 可接后续处理；纯函数与 CLI 同一份判定，解析异常行
  不静默丢。protocol-check 新增 8 项；加固 +1（H20 退出取证：崩溃退出保留输出尾部）；
  MCP 协议套 87 → 95，全量 12 套件 490 断言。
- **v1.6.0（2026-10-04）**：观测日志结构化（`PVMCP_LOG`）：每请求一行 `name/ms/outcome/code`，
  三态（ok/error/rejected）全记账，延迟与错误分布可离线聚合；脱敏（参数值/密钥不落盘、哨兵钉住）
  与防注入（`\n` 不拆行）。protocol-check 新增 C 段 7 项；MCP 协议套 80 → 87，全量 12 套件 481 断言。
- **v1.5.0（2026-10-04）**：MCP 工具面补 `annotations` 副作用声明 —— 13 个工具逐个按真实副作用标注
  只读/破坏性/幂等/openWorld 四类 hint（最坏情形定性，判定口径在 server.mjs 注释），`tools/list`
  真实下发，客户端可据此自动放行或要求确认；行为零变化、契约向后兼容。protocol-check 新增 6 项
  （声明完备、精确集合、语义自洽、线上真发）；MCP 协议套 74 → 80，全量 12 套件 474 断言。
- **v1.4.0（2026-10-04）**：断言数单一源与 CI 口径机械对账（加固 H22）：逐套件断言数声明收进
  `mcp/test/suites.mjs`（assertions / 零依赖态部分数 / . 前缀钉，coreCounts 派生核心数），
  verify-all 逐套对账（实跑 ≠ 声明即失败，日常态也拦）；README 套件表、§15.3 判据行、
  CI 三 job 定义全部机械对账；CI 加固（手动触发 + zero-dep 跨 Node 20/22/24 矩阵）。
  加固 H22 新增 5 项（基座 89 → 93、存在性钉 2 → 3）；全量 12 套件 468 断言。
- **v1.3.0（2026-10-04）**：全链路并行安全与通道优先级钉死（加固 H21）：套件表与波次规划抽出
  `mcp/test/suites.mjs`（`planWaves`：非 serial 套件一波内并发、serial 套件各占独立末波，
  部署副本整树比对独占最后跑），`--parallel` 四处踩踏点逐一封钉（会话名/产物名时间戳唯一、
  `demo/generated-*` 三层排除、收尾 `kill-all` 防 rmSync EPERM）；浏览器通道优先级实证钉住
  （显式 `--browser` > 配置文件 `channel` > CLI 默认，args-check 新增 2 条机器无关探针）；
  `.gitattributes`/`.gitignore` 入库；GitHub Actions 三段 CI（零依赖态 + 双平台全量 + 发版门禁）；
  H16 扩为 7 检（五份文档首条版本、§15.3-CORE 机械对账）、H21 新增 5 检；全量 12 套件 463 断言。
- **v1.2.1（2026-10-04）**：CLI 失败摘要诊断质量（加固 H20）：根因行优先于堆栈噪声（daemon 崩溃时
  不再只报 `daemonPid`），浏览器通道缺失直接附修法；源码树 CLI 通道配置自愈：
  `verify-all --with-browser` 前置生成 `.playwright/cli.config.json`（与 setup-cli-config / install
  共用同一决策矩阵，手工配置不覆盖）；`selfcheck` 新增「CLI 浏览器通道配置」点名；全量 12 套件 454 断言。
- **v1.2.0（2026-10-03）**：纯净发布包口径收紧（无 `node_modules`、无 `.` 前缀文件/目录，解压/拷贝即可部署，
  零 npm 依赖，文档全量改为「拷贝即部署」口径）；部署文档拆分为《部署说明.md》+《部署说明.详细版.md》；
  加固 H18 实跑 `distribute` 验纯净产物；纯净包实测补三处（加固 H10/H14 对 `.` 前缀文件改存在性守卫、
  `run_verify` 守门前置、缺可选依赖诚实 SKIP 不做假绿假红）；发布流程补强（部署说明.详细版 §15）：验收跑一次性副本、
  交付树不被证据落盘跑脏，`verify-all` 全绿清理产物目录 / 失败保留现场（`--keep-artifacts` 强制保留）；
  发版门禁（加固 H19）：`distribute` 收尾自动「一次性副本 verify-all --mode 2 + 终态哈希终查」，发版不可能忘；
  `verify-all --mode 1|2|3` 一条命令复跑三态判据；全量 12 套件 450 断言。
- **v1.1.0（2026-10-03）**：智能体线 —— `nl_test_goal`（说目标不说步骤：LLM 只做规划，
  执行与判定走确定性链路，输出 JSON verdict）+ `explore_page`（死链/坏图/表单盘点巡检），
  工具 11 → 13；合并 LangChain PlayWrightBrowserToolkit 七工具语义（映射见 `references/nl-agent.md`）；
  LLM 本地默认/云端显式开/可关（key 只从环境变量）；守门前置 + 计划白名单 + 无断言=Blocked；
  新增 2 套件（72 + 18 断言），加固 H17。
- **v1.0.0（2026-10-03）**：首发 11 工具 + Skill + 10 套件全量回归（345 断言）+ 真实浏览器矩阵；
  同日加固 H12–H16、CLI 通道配置按目标平台自适应、纯净分发逐文件哈希自校验。
  完整版本说明见 README「版本记录」；**每次版本更新须同步全部文档的版本号与版本说明**
  （规范见 README「版本与文档同步规范」，加固 H16 机械检查同步不缺项）。
