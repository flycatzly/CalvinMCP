# playwright-verify-mcp

> Playwright 端到端测试的「验收 / 门禁 / 执行」MCP server + Skill。
> **官方 agent 负责生成用例，这套工具负责验收** —— 什么写法一律不许合、这条用例到底证明了什么、这次失败该算谁头上。

- 🚀 **[部署说明](./部署说明.md)** —— 纯净包、拷贝即部署、最短路径（速查）；完整参考见 [部署说明.详细版](./部署说明.详细版.md)（各客户端注册含 DSH、CI 集成、排障）
- 🧠 **Skill 入口**：[skill/playwright-verify/SKILL.md](./skill/playwright-verify/SKILL.md) —— 边界、工作流、硬规则、输出契约
- 本文档是唯一完整说明：30 秒上手、五条主线完整用法、14 工具速查、全部规则表、命令行/CI、常见问题、自然语言示例

---

## 30 秒上手

```powershell
# 安装（Skill + DSH bundle + 客户端注册）
# 零 npm 依赖 —— 解压/拷贝即可部署，不需要 npm install、不需要联网
node skill\playwright-verify\install.mjs

# 自检
node skill\playwright-verify\scripts\selfcheck.mjs
```

> 执行层可选依赖（`run_verify` / `cli_*` / 智能体线真执行）由被测项目 / 本机自己提供，
> 不是部署步骤 —— 见 [部署说明](./部署说明.md)「可选依赖」。

不装 MCP 客户端也能用（命令行与 MCP 跑同一份判定逻辑）：

```bash
S=skill/playwright-verify/scripts
node $S/check_config.mjs playwright.config.ts           # ① 配置可信吗？（放最前面——它错的时候后面全是白干）
node $S/lint_spec.mjs tests/                            # ② 这批用例能合入吗？（ERROR 必须为 0）
node $S/summarize_report.mjs test-results/report.json   # ③ 跑完回归，失败该谁修？
node $S/selfcheck.mjs                                   # ④ 环境自检（部署后先跑这个）
```

---

## 它解决什么问题

**问题一：规则写在文档里，但文档不会拦住任何人。**
「用例要稳定」「断言要有意义」这类话写一百遍也不会改变任何一次提交。
能改变行为的是「判据 + 反例 + 检查点」，以及最后落地成一条正则。
所以本工具把 20 条硬规则做成了**确定性扫描**，ERROR 以退出码 1 阻断合入。

**问题二：逐条读错误栈，6 条失败要二十分钟，还容易把 3 条同源失败当成 3 个 bug 派给 3 个人。**
所以归因不是模型现场判断，而是一条可复现的规则：同一条错误签名出现多少次、属于哪一类、下一步该谁做什么，全部由脚本给出。
实测：6 条失败聚成 4 个根因签名，工作量直接对上「4 个人去查」。

**问题三：把完整页面状态反复灌进模型，会烧掉大量 Token。**
官方基准里一个标准多步骤会话能冲到 87000+ Token，点一次按钮可能就烧掉几千；
旧状态一直累积，后面的断言、截图、失败定位全被挤掉。
所以执行层坚持**产出落盘**（快照 YAML/Markdown、截图 PNG、Trace 独立文件），Agent 按需去读。同样流程省下四倍多。

**问题四：脚本还没跑通就提交，是这条流程里最容易踩的坑。**
所以生成脚本自带**生成门禁**：语法检查 + lint ERROR 必须为 0 才允许写盘。

---

## 自然语言使用示例

接上 MCP 客户端（DSH / Claude Code / Cursor）后不需要记命令，对 AI 说人话就行。
同一意图有很多种说法，挑顺口的用：

| 场景 | 你可以这样说 | 走哪条线 |
|---|---|---|
| 合入门禁 | 「帮我看看这批用例能不能合入」「tests/ 过一遍规则」「这个 spec 有啥问题」 | `check_config` → `lint_spec` |
| 规则细节 | 「PW002 到底禁什么？」「这条 WARN 怎么关掉」「你们的规则表给我看看」 | `explain_rules` |
| 失败归因 | 「CI 上 6 条失败，帮我看看该谁修」「这几条 timeout 是环境还是用例问题」「和上次比有没有回退」 | `summarize_report` |
| 跑回归 | 「跑一下回归」「验证一下下单流程」「只跑 checkout 这个 spec」「跑完把现场留好」 | `run_verify` |
| 页面探索 | 「帮我看看这个页面有哪些元素」「把这个流程记下来写成脚本」 | `cli_health` → `cli_session` → `generate_scripts` |
| 用例生成 | 「按 POM 生成搜索页的用例草稿」「生成一批登录场景的脚本」 | `generate_scripts` |
| Excel 编排 | 「把这批手工用例表跑起来」「cases/regression.xlsx 帮我变成回归」 | `orchestrate_excel` |
| 智能体线 | 「说个测试目标帮我验一遍：登录加购后购物车应有该商品」「按这个目标跑一遍：下单后订单状态应为待支付」 | `nl_test_goal` |
| 页面巡检 | 「帮我巡检这个页面，有没有死链坏图」「盘点一下这个页面的表单」 | `explore_page` |
| 表格采集 | 「把列表页整表采下来存档」「和上次的采集对比一下有什么变化」 | `collect_table` |
| 团队规范 | 「团队测试规范该写哪些」「帮我检查 AGENTS.md 写得全不全」 | `check_standards` |
| 环境运维 | 「环境自检一下」「执行类工具能用吗」「部署完帮我确认一下」 | `selfcheck` / `cli_health` |

**对话示例：**

**示例一：合入门禁（说一句，拿到可合入结论 + 逐条证据）**

```
你：帮我看看这批用例能不能合入
AI：配置体检：playwright.config.ts 过 CFG001–CFG012（12 项全过）
    用例扫描：tests/ 42 个文件 → ERROR 0 / WARN 3
      WARN · PW001 固定时长等待 ×3
        tests/login.spec.ts:27   page.waitForTimeout(3000)
        tests/cart.spec.ts:44    page.waitForTimeout(1500)
        tests/cart.spec.ts:51    page.waitForTimeout(1500)
    结论：可以合入（ERROR=0）。3 处 WARN 建议换成 waitForResponse / 状态等待，要我列出改法吗？
你：好，列一下
```

**示例二：失败归因（6 条失败压成几个根因，直接派活）**

```
你：CI 上 6 条失败，帮我看看该谁修
AI：6 条失败聚成 3 个根因签名：
      · assertion ×3 —— 订单金额显示 ¥0.00（预期 ¥99.00）→ 派给前端：金额渲染回归
      · locator-strict ×2 —— 页面出现两个「提交」按钮 → 派给前端：按钮重复渲染 + 测试组改用 testid
      · timeout ×1 —— 支付回调 30s 未返回 → 派给后端：支付回调超时
    环境类 0 条，不是环境问题。需要我按负责人拆成三张工单草稿吗？
```

**示例三：Excel 编排（手工用例表直接变回归）**

```
你：把这批手工用例表跑起来
AI：读取 cases/regression.xlsx（18 条用例）→ 17 条映射成功，1 条映射不了（第 12 行「扫码支付」）原样报出
    生成门禁通过（语法 + lint ERROR 0），已落盘 generated/regression.spec.ts
    真跑：17 条 → 16 通过 / 1 失败（金额断言，同上面的 ¥0.00 问题）
    要我接着归因这次失败吗？
```

**示例四：智能体线 + 页面巡检（说个目标，拿到 Pass/Fail + 证据）**

```
你：说个测试目标帮我验一遍：登录后把商品加入购物车，购物车里应看到该商品
AI：目标过守门（无危险动作，目标是测试环境域名）→ LLM 规划 5 步：
      goto 登录页 → fill 账号 → fill 密码 → click 登录 → 加购后 expect_text 商品名
    真跑：5 步全绿，断言实读到商品名原文（不是「看起来对」）
    结论：Pass。证据 4 张截图 + 报告 .playwright-artifacts/reports/nl-*.json（verdict=Pass）
你：帮我巡检一下这个页面有没有死链坏图
AI：explore_page 确定性巡检：链接 32 个 → 死链 1 个（/promo/old → HTTP 404）；
    图片 8 张 → 坏图 1 张（banner-fallback.png naturalWidth=0）。判定：Fail（附清单）
```

（若目标里写了「转账/删除生产数据」这类危险动作，会在**打开浏览器之前**直接拒绝并说明理由；
「测试环境走一遍下单流程」这类带测试上下文的目标正常放行。）

---

## 五条主线

| 线 | 解决什么 | 工具 |
|---|---|---|
| **门禁线** | 这批用例能不能合入 | `check_config` → `lint_spec` |
| **归因线** | 这次失败该谁修 | `summarize_report` |
| **执行线** | 长流程回归怎么跑不烧上下文；分页表格数据采集落盘 | `run_verify` / `cli_health` / `cli_session` / `collect_table` |
| **生成线** | PO 分层脚本、Excel 用例变回归 | `generate_scripts` / `orchestrate_excel` |
| **智能体线** | 说目标不说步骤：自然语言目标变可判定回归；页面巡检 | `nl_test_goal` / `explore_page` |

### 门禁线：这批用例能不能合入

**第 1 步：配置体检**（为什么放最前面：配置错的时候，后面所有结论都是白干）

```
check_config { file: "playwright.config.ts" }
```

基线配置的体检结果应该是 `ERROR 0 / WARN 0 / INFO 0`。两条最关键的 ERROR：

- **没有 `forbidOnly`** —— 一个 `test.only` 就能让整条流水线只跑一条用例却报绿。
- **`timeout` 过长**（> 60 秒）—— 任何失败都会以「超时」的样子出现，你再也分不清是页面慢了还是功能坏了。

实测对照（本仓库自带的反例配置）：

| 配置 | 结果 |
|---|---|
| `demo/configs/playwright.config.baseline.ts` | ERROR 0 / WARN 0 / INFO 0 → PASS |
| `demo/configs/playwright.config.legacy.ts` | ERROR 3 / WARN 5 / INFO 3 → BLOCK |

淘汰配置的 3 条 ERROR：未设 `forbidOnly`、`timeout: 300_000`、`trace: 'off'`。

**第 2 步：用例扫描**

```
lint_spec { target: "tests/" }
```

三份样例集的验收标准（也是本工具的回归测试基线）：

| 样例 | 期望 | 含义 |
|---|---|---|
| `demo/tests/clean.spec.ts` | ERROR 0 / WARN 0 | **合格写法不报** —— 不冤枉人 |
| `demo/tests/messy.spec.ts` | ERROR 6 / WARN 11 | **坏味道全中** |
| `demo/tests/tricky.spec.ts` | ERROR 0 / WARN 0 | **误报陷阱不误报** |

`tricky.spec.ts` 里塞满了「看起来违规但不是」的东西：注释里的假代码、字符串里的假断言、模板串里的花括号、
多行 `await expect`、正则字面量里的花括号。**它必须常驻** —— 门禁的公信力是它唯一的资产，一次冤枉就够把它废掉。

**两个实现细节值得知道**（它们决定了证据可信度）：

1. **脱敏必须等长。** 检测在脱敏文本上跑、证据回原文取，靠的是「每个被屏蔽字符都换成等长空格、换行原样保留」这条不变量。
   如果脱敏改变了长度，就会出现「行号对得上、证据取到别人身上」。
2. **两道工序，不是一道。** 只去注释保留字符串 → 给选择器类规则用（选择器就写在字符串里）；
   再去字符串 → 给「有没有断言、有没有 await」类规则用（否则注释里写的 `expect(` 会被当成真断言）。
   一道脱敏不可能同时满足两类规则 —— 原文的「选择器类规则永远不可能命中」就是这么来的。

**第 3 步：按 ERROR 修，WARN 人工确认**

```bash
node skill/playwright-verify/scripts/lint_spec.mjs tests/            # ERROR 阻断
node skill/playwright-verify/scripts/lint_spec.mjs tests/ --disable PW011   # 确实不需要某条
node skill/playwright-verify/scripts/lint_spec.mjs tests/ --as-error PW011  # 把某条 WARN 提级
node skill/playwright-verify/scripts/lint_spec.mjs tests/ --core-only       # 只跑原文的核心 14 条
```

> **门禁哲学**：只有 WARN 的检查等于没有检查。ERROR 必须让脚本以退出码 1 结束，这样才能挂进 CI。

### 归因线：这次失败该谁修

先确保配置里有 json reporter，否则拿不到结构化失败记录：

```ts
reporter: [
  ['list'],
  ['json', { outputFile: 'test-results/report.json' }],
],
```

然后：

```
summarize_report { file: "test-results/report.json" }
```

输出形态（本仓库真实运行结果）：

```
结果: 通过 2 / 失败 6 / 偶发 1 / 跳过 0，共 9 条，耗时 25.3s

按签名聚类：4 个根因

[3 次 · assertion] regression.spec.ts :: Error: expect(locator).toHaveText(expected) failed
    归因: 待定（产品回归 / 断言写错）　派给: 产品 或 断言
    下一步: 打开 trace 看页面实际状态：若页面确实错了 → 产品回归，派给开发；
            若页面是对的、预期值写错了 → 用例缺陷，修断言。这一步必须人判，不允许自动放宽断言。
    涉及用例: 订单金额等于 99 元 | 订单金额等于 98 元 | 订单金额等于 97 元

[1 次 · locator-strict] … strict mode violation: getByText('…') resolved to 3 elements
[1 次 · timeout] TimeoutError: locator.click: Timeout 3000ms exceeded.
[1 次 · env] page.goto: net::ERR_CONNECTION_REFUSED at <url>

分类汇总:
  断言未成立（assertion）: 3 条失败 / 1 个签名
  定位器命中多个元素（locator-strict）: 1 条失败 / 1 个签名
  操作等待超时（timeout）: 1 条失败 / 1 个签名
  环境不可达（env）: 1 条失败 / 1 个签名

偶发（重试后才通过）: 偶发用例（首次失败，重试通过）
```

**几个关键口径：**

- **偶发不吃进失败聚类。** 一条「偶发」用例会产生 1 次 failed 重试 + 1 次 passed；
  若混进聚类，同一条用例会同时出现在 clusters 与 flakes 里，既虚增根因数，也让「一个签名派一个人」失真。
- **判定与签名必须吃同一份清洗后的文本。** 这是「断言失败被归成超时」那个缺陷的修法：
  真实错误消息里 `Error:` 与 `expect(` 之间夹着 ANSI 控制字符，判定正则若不清洗就永远匹配不上，
  而签名清洗了、判定没清洗 → 签名看着正常、归因全歪。
- **判定顺序从最具体到最泛**：`env` → `locator-strict` → `assertion` → `timeout` → `locator-not-found`。
  顺序错了会派错团队：一条 `strict mode violation` 的消息里同时含 `expect(...).toBeVisible() failed`，
  如果 `assertion` 排前面，这个「定位器命中多个元素」就会被写成「产品回归」派给开发。

### 执行线：长流程回归怎么跑不烧上下文

两条执行路径，分工明确：

| | 用例 | 说明 |
|---|---|---|
| **`run_verify`** | 跑 Playwright 测试套件 | 输出重定向到文件；跑完配 `summarize_report` 归因 |
| **`cli_session` / `cli_health`** | 探索页面、驱动浏览器 | 产出**一律落盘**，返回值只给路径与摘要 |

先验收最小闭环：

```
cli_health { cwd: "." }
```

**能开页面、能拿快照、能截图** —— 这三步过了，CLI 就能进测试仓库当执行器。

再探索页面：

```
cli_session { subcommand: "open", args: ["https://example.com"], session: "explore" }
cli_session { subcommand: "snapshot", session: "explore" }
# → 快照已落盘：.playwright-artifacts/snapshots/explore-1.md（按需读，不要整棵进上下文）
cli_session { subcommand: "click", args: ["e12"], session: "explore" }
cli_session { subcommand: "screenshot", session: "explore" }
# → 截图已落盘：.playwright-artifacts/screenshots/explore-1.png
cli_session { subcommand: "close", session: "explore" }
```

**为什么必须落盘**：把完整页面状态反复灌进模型，旧状态一直累积，后面的断言、截图、失败定位全被挤掉。

**调试用 `headed: true`，回归默认无头** —— 免得有人把有头窗口带进夜间回归。

**证据目录约定：**

```
.playwright-artifacts/
├── snapshots/      快照（markdown，按需读）
├── screenshots/    截图（png，回译时要附给同事）
├── traces/         trace（失败现场：DOM 快照 + 网络 + 每步）
├── logs/           执行日志（stdout/stderr 重定向产物）
├── reports/        机器可读报告（json）
├── collect/        翻页采集产物（rows.json / CSV / 两期 diff.md）
└── state/          登录态（按账号命名，禁止提交进仓库）
```

**分页表格采集（`collect_table`，确定性、不用 LLM）**

档案类页面要整表落档时用它：自动翻页（页码框输入或「下一页」链接）、空页/无新行/页数上限三选止损，
首见胜出归并（翻页重复行不计数）；`rows.json` + UTF-8 BOM 的 CSV（Excel 双击不乱码）落盘，
可指定 `diffAgainst` 做两期对比（新增/删除/变化/未变 —— 只是对照表，不是失败判定）。
行数据只落盘、绝不回灌上下文；零行采集判 Fail（目标没达成就是没达成）。

**长采集中断可断点续采**：`resumeFrom` 指向上一次的 `rows.json`，已采行先占位、从断点页继续扫
（eval 失败/零新增的页会整段重扫），产出的 pages 链式归并 —— 本次基准可以再当下次的续采基准。
基准带指纹（url + keyIndex），跟本次目标不一致会拒绝续采（`COLLECT_STALE`，宁可从头也不爬错页
污染两期对比）；单页模式没有断点可续（`COLLECT_RESUME_NOT_APPLICABLE`）。
`keyIndex`/`maxPages` 只接受整数（下标/计数没有小数的合法语义）——传小数会在参数层报错，
不会静默取整后跑出误导结果。

### 生成线：PO 分层脚本与 Excel 编排

**不让模型自由写脚本，只让它填空。**
早期让模型直接产出完整脚本，它爱用 `page.click('#btn-3')` 这种脆弱选择器，UI 一改全崩。
现在的做法：先定好每一步的**稳定定位描述**，脚本生成只是把描述翻译成 Playwright API。
选择器策略被锁死，模型越不过去 —— 生成阶段就直接拒绝裸 XPath 与 `nth-child`。

```
generate_scripts {
  spec: "checkout",
  pages: [
    { name: "login", navPath: "/login", steps: [
        { act: "fill", locator: { kind: "label", text: "账号" }, value: "u1" },
        { act: "click", locator: { kind: "role", role: "button", name: "登录" } },
        { act: "assertVisible", locator: { kind: "testid", id: "user-menu" } }
    ]}
  ],
  cases: [
    { title: "登录成功", page: "login", claims: "证明 u1 在 test 环境登录成功", steps: [ … ] }
  ],
  write: true, outDir: "tests-e2e"
}
```

**生成门禁**：语法检查（引擎亲自解析）+ lint ERROR 0，两者都过才允许写盘。
脚本还没跑通就提交，是这条流程里最容易踩的坑。

**支持的步骤动作**（大小写与分隔符不敏感，`assert_visible` = `assertVisible`）：

| 动作 | 含义 |
|---|---|
| `goto` | 导航 |
| `fill` / `click` / `check` / `uncheck` / `select` / `press` / `hover` | 操作 |
| `assertText` / `assertVisible` / `assertCount` | 断言 |
| `waitForResponse` | 等网络条件 |

**支持的定位类型**：`role` / `label` / `testid` / `text` / `placeholder` / `selector`（`selector` 仅在必要时用，且拒绝脆弱写法）。

**一个来自真实用例表的细节**：Excel 里写「看到 用户菜单」时，人知道那是文案还是 testid，机器不知道。
所以规则映射层会**同时给出两个候选**（`byText` + `byTestId`），由生成器按定位器优先级选：

```
testid（开发者承诺的稳定契约）> label > role > placeholder > text（随文案改版变化）> selector
```

这样既不需要在用例表里多填一列，选择标准又仍然统一在定位器策略里。
猜错也不会静默通过 —— 断言会明确报「找不到元素」，人按实际页面改 testid 即可。

**产物结构**：

```
pages/LoginPage.ts      页面层：定位与操作（改 UI 只改这层）
tests/checkout.spec.ts  用例层：业务路径与主张（改 UI 不用动）
```

**交付契约**：每条用例必须给 `claims`（这条用例证明了什么）。不给的话，生成物会明确标注「未声明」——
这条要求逼着写用例的人回到「主张」，实测比任何「请写高质量用例」的嘱咐都管用。

**Excel 手工用例 → 可执行回归：**

```
orchestrate_excel { input: "cases/regression.xlsx", readOnly: true }   # 先看映射情况
orchestrate_excel { input: "cases/regression.xlsx", write: true }      # 生成脚本
orchestrate_excel { input: "cases/regression.xlsx", run: true }        # 生成并执行
```

用例表列名认中英文别名（用例/场景、步骤、预期结果、环境、账号、优先级、前置条件…），
表头可以不在第一行（会扫描前 10 行找最像表头的那一行）。

**最重要的一条**：**映射不了的步骤不会让整条用例静默失败，而是原样报在 `unmapped` 里**。

```
[row 4] 这条故意写得无法映射
  映射出 1 步；无法映射 2 步
    ✓ assertText {"kind":"text","text":"心情"} → 愉快
    ? 无法映射：摸摸鱼
    ? 无法映射：等待系统心情变好
```

自然语言步骤 → 可执行步骤这一步不是万能的。手工用例表里的「步骤」写法千差万别，
纯靠规则匹配必然覆盖不全。所以：**宁可不做，也不能猜错。**

> Excel 读取用运行时的 Python（MCP 本体保持零依赖）。`openpyxl` 可选 —— 缺失时自动用内置 zip+XML 解析兜底；`.csv` 纯 Node 也能读。

**结果回译（给不写代码的同事）**

同事要的是「通过 / 没通过 + 为什么」，不是 `Error: expect(received).toBe(expected)`。
按 `references/report-translation.md` 的模板输出「结论 + 证据 + 下一步建议」：

```
已按你的场景跑完 ✅
· 登录 test / 账号 u1：成功
· 下单 SKU_A、加购、去结算：均成功
· 订单金额校验：通过（实读 ¥99.00，预期 ¥99.00）
四步截图已附，需要我接着跑「用优惠券后金额」的对照吗？
```

最后那句「下一步建议」是对话式入口独有的好处：验证往往不是一次性的，
同事看完结论自然会说「那再跑个优惠券的」，Skill 接着接住，不需要重新排队找人。

### 智能体线：说目标不说步骤

参照 LangChain PlayWrightBrowserToolkit（navigate / click / get_elements / extract_text /
extract_hyperlinks / current_webpage / previous_webpage 七工具）的语义，但分工更保守：
**LLM 只做规划，判定权不在模型手里。**

```
nl_test_goal {
  goal: "登录后把商品加入购物车，购物车里应看到 \"ITEM-A\"",
  url: "https://app.test.example.com",
  cwd: "D:/work/my-project"
}
```

链路：守门（危险目标/生产地址，**开浏览器前**）→ LLM 产出受限计划（动作白名单：
goto/click/fill/press/expect_text/expect_visible/screenshot）→ 计划契约校验（白名单外动作
整份作废，宁可不做不能猜错）→ 真浏览器执行（失败即停）→ 确定性断言 → 报告 JSON 落盘
（`.playwright-artifacts/reports/nl-*.json`，`verdict` 字段 Pass/Fail/Blocked 可直接挂 CI 门禁）。

- LLM 不可用？确定性降级骨架 `fallbackPlan`（goto + 引号断言提取 + 截图），报告标 `source: "fallback"`
- 没有任何 expect_* 断言 → `Blocked`：「全绿但什么都没验」不算通过
- 巡检页面用 `explore_page`：死链（HTTP ≥400 → Fail）、坏图（`naturalWidth=0`）、表单盘点（formsHash 指纹；`diffAgainst` 指上一期 facts 文件即出两期表单对比），**不用 LLM**
- LLM 配置只走环境变量（`PVMCP_LLM` / `OLLAMA_*` / `DEEPSEEK_*`），key 不进参数、磁盘、日志；详见部署说明.详细版 §9.6

---

## 14 个 MCP 工具

安装后工具名形如 `mcp__playwright_verify__<tool>`。

| 工具 | 什么时候用 | isError 语义 |
|---|---|---|
| `check_config` | 配置基线体检（CFG001–CFG012），放流水线最前面 | 有 ERROR → isError，exitCode 1 |
| `lint_spec` | 合入前扫用例（20 条规则，ERROR 阻断） | 有 ERROR → isError，exitCode 1 |
| `summarize_report` | 回归跑完做失败归因（聚类 + 五类归因 + 派活口径；多报告趋势传 `files`） | 无失败 → 正常；报告不存在 → isError |
| `run_verify` | 执行 Playwright 测试（落盘式，输出重定向到文件） | 用例失败 → isError，exitCode 1 |
| `cli_health` | 首次接入 CLI 时验收最小闭环（能开页面、能拿快照、能截图） | 任一步失败 → isError |
| `cli_session` | 探索页面、驱动浏览器（产物一律落盘） | 命令失败 → isError |
| `generate_scripts` | 生成 PO 分层脚本（带生成门禁：语法 + lint ERROR 0 才写盘） | 门禁不过 → isError，拒绝写盘 |
| `check_standards` | 校验团队 AGENTS.md 测试规范 | 规范缺失不阻断（exitCode 0），但列出缺失 |
| `orchestrate_excel` | Excel 手工用例变可执行回归（映射不了的步骤原样报 `unmapped`） | 编排失败 → isError |
| `explain_rules` | 规则表自省：「这条为什么报」「怎么关掉」 | 只读 |
| `selfcheck` | 服务级自检（含 LLM 通道可选项） | 必需项失败 → isError |
| `explore_page` | 页面探索巡检：死链/坏图/表单盘点，确定性判定出 Pass/Fail；表单指纹（formsHash）+ 两期对比（`diffAgainst`：字段新增/删除/必填位变化） | 判定有 Fail → isError |
| `nl_test_goal` | 智能体线：自然语言目标 → LLM 只做规划 → 真执行真断言 → JSON verdict（定位失败走两层自愈、自愈 LLM 有整次运行预算 `healLlmBudget`，断言绝不自愈） | verdict ≠ Pass → isError |
| `collect_table` | 分页表格采集：页码框/下一页两种翻页、空页/无新行/上限止损、两期 diff、断点续采（`resumeFrom` 带基准续扫、指纹不符拒续）、rows.json + CSV 只落盘 | 零行采集 → isError；指纹不符拒续 |

**通用约定**：所有工具都返回「给人看的文本 + 结构化数据」；所有失败都返回 `isError: true` 并说明原因，
**绝不静默成功**。长产物一律给路径，不给全文。

---

## 20 条 lint 规则表

### 核心 14 条（还原原文规则）

| id | 级别 | 规则 | 修法要点 |
|---|---|---|---|
| PW001 | ERROR | 固定时长等待 | 等状态 / 等网络 / 等轮询。`waitForTimeout` 不是慢，是把问题藏起来 |
| PW002 | ERROR | `.only` 泄漏 | 删掉 + `forbidOnly: !!process.env.CI` 双保险 |
| PW003 | ERROR | 绝对 XPath | 改用 role / label / testid |
| PW004 | ERROR | `nth-child` / `nth-of-type` | 按第几个子元素定位 = 把 DOM 焊死在用例里 |
| PW005 | ERROR | `force: true` | 先查为什么不可点（被遮挡 / 动画未完成） |
| PW006 | ERROR | 断言没 `await`（假通过） | **只对异步来源参数报**：`expect(amount).toBe()` 是同步断言，不 await 是对的 |
| PW007 | ERROR | 用例内没有任何断言 | 容器块已排除；断言在页面层方法里时降级为 WARN 交人确认 |
| PW008 | ERROR | 断言降级成 JS 判断 | `if (!await x.isVisible())` → `expect(x).toBeVisible()` |
| PW009 | WARN | 只用 `toHaveCount` 判存在 | 数量断言不校验内容与可见性 |
| PW010 | WARN | CSS 类名 / 结构选择器 | 类名与 `>` 由样式决定，改版即失效 |
| PW011 | WARN | `.first()`/`.last()`/`.nth()` | 位置收敛说明定位器本身不唯一 —— 根因是定位器缺陷 |
| PW012 | WARN | `networkidle` | 长轮询 / 心跳 / 埋点页面上永远等不到 |
| PW013 | WARN | 超时放宽过百秒 | 判据是**求值** > 100000 ms，不是「看起来数字很长」（否则 `15_000` 会被误报） |
| PW014 | WARN | `:visible` 旧写法 | 1.63 起用 `locator.visible()` |

### 补充 6 条（对齐三篇文章的硬约束）

| id | 级别 | 规则 |
|---|---|---|
| PW101 | ERROR | 疑似凭据写死在用例里（账号密码只允许从环境变量读） |
| PW102 | ERROR | 遗留调试代码（`debugger` / `page.pause()`） |
| PW103 | WARN | 静默的 `test.skip` / `test.fixme`（跳过必须带理由和跟踪单号） |
| PW104 | WARN | `test.slow()` 放宽超时 |
| PW106 | WARN | 空等待（`waitForSelector()` 无参） |
| PW107 | WARN | 用例内直接访问生产域名 |

> **注**：`PW105` 不存在（已废弃）。任何文档、注释、PR 里引用 PW105 都是错的 ——
> 引用不存在的规则号会让工具输出与人读的结论对不上。
> 完整性由 `mcp/test/rules-check.mjs` 守住。

---

## 12 条配置体检规则表

| id | 级别 | 检查项 | 为什么 |
|---|---|---|---|
| CFG001 | ERROR | `forbidOnly` | 没有它，`.only` 能带着一条用例进 CI 却报绿 |
| CFG002 | ERROR | `timeout` ≤ 60s | 超时一长，所有失败都以「超时」出现 |
| CFG003 | ERROR | `trace` 已开启 | 没有它，失败现场只有一行报错，三类归因无从展开 |
| CFG004 | ERROR | 有 json reporter | 没有它，失败聚类与派活无法自动化 |
| CFG005 | WARN | `retries` 合理（1–3） | 重试过多会把真坏的用例放过 |
| CFG006 | WARN | `workers` 有上限 | 资源争抢会制造与代码无关的失败 |
| CFG007 | WARN | 失败时有 screenshot / video | 回译要附截图才有说服力 |
| CFG008 | ERROR | `actionTimeout` < `timeout` | 否则操作级超时永远不先触发，等于没配 |
| CFG009 | WARN | `expect.timeout` 不过长 | 长断言超时容易被误归因成「操作超时」 |
| CFG010 | INFO | `baseURL` 已设置 | 切环境不用改用例，也避免用例里出现环境域名 |
| CFG011 | INFO | `testDir` 已限定 | 否则扫描器与运行器可能跑到不该跑的文件 |
| CFG012 | INFO | 有环境开关（生产保护） | 把可跑环境锁在 test / staging |

**判据不明时降级为 INFO 交人确认。** 配置文件里的值可以是表达式（`!!process.env.CI`），
本工具不做符号求值：能静态判定的判 ERROR/WARN，判不了的降级成 INFO 并说明「需要人确认」——
**绝不因为算不出来就误报。**

---

## 失败归因的五个类别

| 类别 | 中文 | 性质 | 派给谁 | 下一步 |
|---|---|---|---|---|
| `locator-strict` | 定位器命中多个元素 | 用例缺陷 | 测试侧 | 收紧定位器到唯一命中；**不要用 `.first()` 掩盖** |
| `assertion` | 断言未成立 | **待定**（产品回归 / 断言写错） | 产品 **或** 断言 | 打开 trace 看页面实际状态。**必须人判，不允许自动放宽断言** |
| `locator-not-found` | 定位器找不到元素 | 用例缺陷 | 测试侧 | 对照 snapshot 查元素是否改名 / 改结构 / 未渲染 |
| `timeout` | 操作等待超时 | 待定 | 待定 | **先查定位器还能不能命中**（多数「超时」其实是定位器失效） |
| `env` | 环境不可达 | 环境问题 | 环境 | 先确认环境再谈用例，**这类失败不要派人去查用例** |
| `unknown` | 未归类 | 待判定 | 人工 | 若频繁出现，说明归因规则需要补一条签名 |

**派活口径**：一个签名 = 一份工作量，而不是「一条失败 = 一个人」。

---

## 命令行用法（不依赖 MCP 客户端）

Skill 的 `scripts/` 与 MCP 工具跑的是**同一份判定逻辑**，所以两边结论必然一致。
单独用 `scripts/` 时，它会自己向上找到 `mcp/lib`（也可以用 `PVMCP_HOME` 显式指定）。

```bash
S=skill/playwright-verify/scripts

# 配置体检（ERROR → 退出码 1）
node $S/check_config.mjs playwright.config.ts
node $S/check_config.mjs playwright.config.ts --json

# 用例扫描（ERROR → 退出码 1）
node $S/lint_spec.mjs tests/
node $S/lint_spec.mjs tests/ --json
node $S/lint_spec.mjs tests/ --core-only
node $S/lint_spec.mjs tests/ --disable PW011,PW014
node $S/lint_spec.mjs tests/ --as-error PW011        # WARN 提级为 ERROR

# 失败归因（默认退出码 0 —— 它挂在失败任务里做归因，不该自己再报失败）
node $S/summarize_report.mjs test-results/report.json
node $S/summarize_report.mjs test-results/report.json --fail-on-failures   # 需要阻断时显式开启

# 执行回归
node $S/run_verify.mjs --cwd . --dry-run                              # 只做环境自检
node $S/run_verify.mjs --cwd . --config playwright.config.ts
node $S/run_verify.mjs --cwd . --grep "下单" --retries 2
node $S/run_verify.mjs --cwd . --config playwright.config.ts --then-summarize

# 团队规范
node $S/check_standards.mjs                 # 校验 cwd 下的 AGENTS.md
node $S/check_standards.mjs --template      # 打印可粘贴的规范片段

# 自检
node $S/selfcheck.mjs
```

**退出码约定**：`0` 通过 / `1` 门禁阻断 / `2` 用法或环境错误。

---

## 落到 CI 里

三个脚本在流水线里的分工（它们不是一个东西）：

```bash
# 跑之前：配置基线是否可信（放最前面，因为它错的时候后面全是白干）
node skill/playwright-verify/scripts/check_config.mjs playwright.config.ts

# 合入前：用例静态扫描，ERROR 必须为 0
node skill/playwright-verify/scripts/lint_spec.mjs tests/

# 跑之后：失败归因与派活（产物直接当工单附件）
node skill/playwright-verify/scripts/summarize_report.mjs test-results/report.json
```

对应 GitHub Actions 片段：

```yaml
- name: 配置体检（最快失败）
  run: node skill/playwright-verify/scripts/check_config.mjs playwright.config.ts

- name: 用例静态门禁
  run: node skill/playwright-verify/scripts/lint_spec.mjs tests/

- name: 回归
  run: node skill/playwright-verify/scripts/run_verify.mjs --cwd . --config playwright.config.ts
  continue-on-error: true

- name: 失败归因
  if: always()
  run: node skill/playwright-verify/scripts/summarize_report.mjs test-results/report.json

- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: playwright-evidence
    path: |
      .playwright-artifacts/
      test-results/
```

**CI 上还要加两道保险**（已由 `check_config` 守住）：

- `forbidOnly: !!process.env.CI` —— 防止 `.only` 带着一条用例进 CI。
- `retries: process.env.CI ? 2 : 0` + `workers` 上限 —— 识别抖动、避免资源争抢制造的假失败。

**跨机器的一致性提醒**：`.playwright/cli.config.json` 要跟仓库一起提交。
不带它，源码目录与安装目录可能落到**不同的默认浏览器通道**（实测出现过「源码目录用 msedge、安装目录找 chrome」），
于是出现「这里能跑、装完就不能跑」这种最难查的问题。
`install.mjs` 装到新机器时会自动把这份配置适配到目标平台（跨平台时重新生成），提交它主要为了源码目录侧的一致。

---

## 常见问题

**Q：`lint_spec` 报了 ERROR 但我觉得是误报，怎么办？**
先看证据行 —— 检测在脱敏文本上跑、证据回原文取，所以证据一定是你文件里的真实那一行。
如果确认规则不适用于你的项目，用 `--disable PW0xx` 关掉，并在注释里写明原因。
**但不要因为「改起来麻烦」而关规则** —— 关掉的是保护，不是告警。

**Q：为什么 `expect(amount).toBe('¥99.00')` 没被 PW006 报「缺 await」？**
因为它是**同步值断言**，不需要 await。PW006 只对参数是异步来源（`page` / `locator` / `getBy*`）的断言报错。
这个判据是为了避免冤枉正常代码 —— 一次冤枉就够把门禁废掉。

**Q：断言写在页面对象方法里，PW007 会报「用例内没有断言」吗？**
不会报 ERROR。工具会跨文件解析页面对象方法，识别出「断言在页面层」这种 PO 分层的正常形态，
降级为 WARN 请你人工确认覆盖是否足够。仍保留 WARN，是因为这是跨文件推断，人扫一眼比正则可靠。

**Q：`check_config` 说 `forbidOnly` 无法静态判定？**
如果你写的是 `forbidOnly: !!process.env.CI`（推荐写法），它会被认可、不产生任何噪音。
只有既不是 `true`/`false` 又没看到 `process.env.CI` 时才会提示。

**Q：`cli_health` 失败，说缺浏览器？**
报错会直接翻译成人话并给两条修法：

```
1) 装它：npx playwright install chromium
2) 或改用本机已有的浏览器通道：编辑 .playwright/cli.config.json，
   把 browser.browserName 设为 "chromium" 且 launchOptions.channel 设为 "msedge"
```

**Q：`orchestrate_excel` 说找不到 Python？**
Excel 读取用 Python 3.9+ 即可（`openpyxl` 可选，缺失时走内置解析）。装了 DSH 运行时的环境自带它。
没有 Python 时把用例表另存为 `.csv`，纯 Node 也能读。

**Q：Excel 里写了「打开 /login」，生成的脚本会 goto 到哪里？**
会用**用例表里「打开 …」的那个地址**，并且结果里会说明来源：

```
导航目标：/login（来自用例表的「打开 …」步骤）
```

只有在用例表完全没有导航步骤时，才回落到工具参数 `navPath` 的默认值。

**Q：`run_verify` 说找不到 Playwright？**
它找的是**目标项目**里的 Playwright（`node_modules/@playwright/test/cli.js`），不是本工具自己的。
这是刻意的：用被测项目自己的版本跑，避免版本错配。
按提示在被测项目里执行 `npm i -D @playwright/test && npx playwright install chromium` 即可。

**Q：`summarize_report` 说报告不存在？**
确认 `playwright.config` 里有 json reporter（`CFG004`），并且用例确实跑过。
没有 json 报告就只能解析文本，稳定性会明显下降。

**Q：`generate_scripts` 拒绝写盘？**
看 `lint.files[].findings` —— 生成门禁要求语法检查通过 + lint ERROR 为 0。
最常见的原因是：用例里没有任何断言（门禁会要求你补 `claims` 与断言）。

**Q：工具报「未解析的占位符」？**
你把 `${PW}` / `{{password}}` / `<PASSWORD>` 这样的占位符当值传进来了。
生成器不会猜你的意图：请填真实值，或改用环境变量读取（`process.env.PW_PASSWORD`）——
凭据绝不允许写死在脚本里。

---

## 能做 / 禁止做 / 优点

**能做什么**

- 合入门禁：配置体检（CFG001–CFG012）+ 用例静态扫描（20 条规则），ERROR 阻断合入
- 失败归因：N 条失败聚成 M 个根因签名（assertion / locator-strict / timeout / env…），给出派活口径
- 落盘执行：长回归不烧上下文，截图/trace/日志现场留在 `.playwright-artifacts/`
- 生成与编排：PO 分层脚本（过生成门禁才写盘）、Excel 手工用例 → 可执行回归
- **自然语言声明式测试**：说目标不说步骤（`nl_test_goal`）——LLM 把目标翻译成受限计划，真浏览器执行、真断言判定，输出 JSON `verdict` 可直接挂 CI
- **页面探索巡检**（`explore_page`）：死链（HTTP ≥400 判 Fail）、坏图（`naturalWidth=0`）、表单盘点（含 formsHash 指纹与两期对比），全部确定性判定
- 环境自检、CLI 会话操作、规则表自省、团队规范校验

**禁止做什么（守门是代码，不是口号）**

- 不自动改断言：断言是验收契约，改断言必须人来判
- 凭据只从环境变量读（`accounts.json` / `.env` 绝不入库、不进日志、不进 LLM 请求）
- 默认只允许 test / staging；生产地址要独立审批（`confirmProd: true` 留痕）
- 不碰真实资金与生产数据：转账、支付、删库、生产变更、群发、批量注册 —— **打开浏览器之前就硬拒绝**
- LLM 只做规划，不做判定：计划混入白名单外动作整份作废；没有断言的执行判 Blocked，不给「全绿但什么都没验」
- 不把页面内容送出机：LLM 默认本地 Ollama；截图与页面快照永不进 LLM 请求

**优点**

- **判定权不在模型手里**：「通过/不通过」永远由确定性断言链给出，模型编造不了结论
- **零运行时依赖**：手写 stdio JSON-RPC + Node 内置 fetch，装完即用、全树可审计
- **证据可复核**：每步截图、计划快照、报告 JSON 落盘，Pass/Fail 都能回看依据
- **守门前置**：危险目标与越权地址在开浏览器前拦截，不消耗任何执行资源
- **全链路真测**：13 套件 + 真实浏览器矩阵全部实跑（非声明），加固 H1–H23 专钉「不报错但结论错」

---

## 设计取舍（为什么这么做）

| 决定 | 理由 |
|---|---|
| **MCP 零依赖** | 手写 stdio JSON-RPC 循环，不装 MCP SDK。协议只有三个动作，手写更好审计，也不会因 SDK 升级改行为 |
| **参数严格解析，非法值报错** | MCP 客户端会把布尔序列化成字符串，而 `"false"` 在 JS 里是**真值**，`!!args.run` 会让「别跑」变成「真跑」。所以统一走 `boolArg`，非法值直接抛错而非静默取真/假 |
| **产物命名必须唯一** | 只按「扫目录算序号」命名时，两个并发调用会算出同一个名字，后写的覆盖前一次的证据 —— 失败现场是最不该丢的东西 |
| **子进程输出重定向到文件，不用管道** | 沙箱下管道捕获不可用；而且长回归日志本来也不该进内存 |
| **产出必须落盘** | 把完整页面状态反复灌进模型会烧掉大量 Token（官方基准 87000+），后面的断言与失败定位会被挤掉 |
| **脱敏必须等长** | 检测在脱敏文本上跑、证据回原文取，靠这条不变量。脱敏改变长度 → 行号对得上、证据取到别人身上 |
| **两道脱敏工序** | 只去注释保留字符串（选择器类规则用）→ 再去字符串（断言/await 类规则用）。一道脱敏不可能同时满足两类规则 |
| **判定与签名吃同一份清洗文本** | 「断言失败被归成超时」的根因就是判定没清 ANSI、签名清了 |
| **偶发不吃进失败聚类** | 否则同一条用例同时出现在 clusters 与 flakes，虚增根因数、派活失真 |
| **ERROR 必须阻断（退出码 1）** | 只有 WARN 的检查等于没有检查 |
| **宁漏不误报** | 门禁的公信力是它唯一的资产，一次冤枉就够把它废掉。`tricky.spec.ts` 就是为此常驻 |
| **生成门禁：语法 + lint ERROR 0 才写盘** | 「脚本还没跑通就提交」是这条流程里最容易踩的坑 |
| **映射不了的步骤原样报出** | 自然语言步骤映射不是万能的：宁可不做，也不能猜错 |

---

## 验证

```bash
node mcp/test/verify-all.mjs                 # 串行（默认，保证确定性），13 套
node mcp/test/verify-all.mjs --with-browser  # 含真实浏览器（约 1.5 分钟，含全流程验证，实测 97s）
```

覆盖（全部为真实执行，非声明）：

| 套件 | 验证什么 | 断言数 |
|---|---|---|
| 扫描器 | 三份样例集 + 11 项结构/词法边界 + 18 条对抗语料（误报/漏报边界回归）+ 属性化语料 20 规则 × bad+good（真 lint 跑）+ 覆盖门 | 53 |
| 归因 | ANSI 清洗幂等、断言不被误归成超时、6 条失败压成 4 个签名、输入校验不静默全零、多报告趋势（通过率曲线/签名漂移三分法/计数矩阵含簇内多条/md 落盘形态）、趋势 md 行截断（每列表 ≤50 行/诚实「还有 N 条」计数/结构化数据保全量/小趋势形态零变化）、趋势上下文有界（slim 截 50 与 md 同一常量/total 诚实/回灌面 ≤ 全量一半/行内保真/纯函数不突变/未超上限透传） | 42 |
| 生成器 | 门禁、PO 分层、方法名 ASCII 唯一、占位符拒绝、脆弱选择器拒绝 | 27 |
| MCP 协议 | 握手、版本协商、14 个工具、annotations 副作用声明、观测日志脱敏与聚合消费、错误码语义、stdin EOF 排空、报告输入校验、真实 stdio 冒烟、日志容量上限与轮转（PVMCP_LOG_MAX_MB）、计划缓存观测（cache= 字段三态与命中率）、按工具块渲染（权重序/maxMs 透出） | 116 |
| 规则一致性 | 规则 id 唯一、文档与实际规则表不漂移、PW105 不被实现、属性化语料覆盖门（每规则必须带 bad/good） | 37 |
| **加固（静默失效/反转/覆盖/篡改）** | **H1–H23：不报错但结论错的那一类** | 97 |
| CLI 真实交互 | Ref 交互、fill/click 真的生效、产物落盘、PNG 魔数、白名单拒绝 | 21 |
| Excel 编排端到端 | 读表（含无 openpyxl 兜底）→ 映射 → 生成门禁 → 落盘 → 真跑通过（2 passed） | 20 |
| 参数规范化与产物命名 | `"false"` 必须解析成 false、非法值报错、整数参数不静默取整、并发产物不互相覆盖、浏览器通道优先级（`--browser` > 配置文件） | 46 |
| **智能体线（LLM 回环/守门/计划契约/自愈采集纯函数）** | **stub LLM 真 HTTP 回环、危险目标拒绝、白名单不静默丢弃、无断言=Blocked、死链坏图判定、自愈语义提取与选择题边界、翻页归并与两期对比、自愈 LLM 预算闸门（总闸/短路/穿线/用量）、断点续采计划（指纹闸/断点页/种子归并/工具守门）、整数参数工具面（keyIndex/maxPages/probeTimeoutMs/maxLinks/retries/timeoutMs×2/maxSteps 拒小数）、探活预算闸门（慢死主机单探测超时/整段总预算/耗尽诚实 partial）、多报告趋势工具面（files 互斥/坏成员不静默跳过/md 落盘只回摘要）、计划缓存纯函数（指纹四元组任一变即失效/TTL 到期即淘汰/容量 FIFO/报告增量字段缺省兼容）、趋势 md 截断工具面（签名爆炸 md 有界/诚实计数行）、趋势上下文有界工具面（structuredContent 截 50+total/落盘 JSON 回读 65 条全量含 sample/format=json text 同口径）、表单指纹与两期对比纯函数（formHash 重排不敏感/敏感四变体/整页指纹/diffForms 三分检出/无变更全零/明细有界 total 诚实）** | 133 |
| **智能体线端到端（真浏览器）** | **LLM 规划→goto/fill/click/断言/截图真执行、降级骨架、Fail 不放宽、巡检 Fail/Pass、表单指纹两期对比真跑（formsHash 变化/三分检出/diffAgainst 不可读诚实报错）** | 21 |
| **全流程验证（工具链串联+自然语言真跑）** | **lint 门禁→自然语言真执行（两层自愈真回环）→翻页采集两期对比与断点续采（pagesScanned 本轮/pagesTotal 累计两口径）→巡检归因；断言绝不自愈、行数据只落盘、日志脱敏哨兵；计划缓存活体（同指纹命中 LLM 桩零新增请求且 tier-1 自愈照常/goal·url 变更现场重规划/llm=off skip/落盘报告 planCache 可审计）；计划缓存观测真 stdio 双调用（miss→hit→skip 三态落行、其余工具不落 cache= 字段）** | 44 |
| 部署副本 | 装完的副本能发现工具、真能调用、与源码逐文件哈希一致 + CLI 配置适配当前平台 | 26 |
| 真实浏览器回归 | 2 通过 / 6 失败 / 1 偶发 → 4 个根因签名 | 矩阵核对 |

> 「部署副本」这套专门防「改了源码忘了重装」——实测抓到过多次文件漂移。
> 表中「断言数」与 `mcp/test/suites.mjs` 的声明是**同一个数（数字单一源）**：改断言不同步声明，
> verify-all 逐套对账直接拦下（加固 H22）；加固行是基座数，源码树常驻的三条**存在性钉**
> （`.gitattributes` / `.gitignore` / `.github/workflows/ci.yml`，H10/H14/H22）在位才生效、
> 纯净包里诚实 SKIP 不计数，源码树跑出 94+3。每套都有**挂死守卫**：某套进入死循环会被强杀并报出，
> 不会拖住整条流水线（实测踩过一次死循环，所以这道守卫是必需品，不是保险起见）。

### 加固套件（H1–H23）钉的是什么

这批用例来自一次**对抗性审计**，专钉「不报错、但结论或行为是错的」——比崩溃危险得多：

| # | 钉的问题 |
|---|---|
| H1 | **规则静默失效**：PW001 曾漏掉 `page.waitForTimeout(...)`（最常见写法），而 ERROR 总数被别的规则填满，看起来正常 |
| H2 | 只断言总数抓不到「某条规则已死」——必须**按规则 id** 断言命中 |
| H3 | 生成器**静默篡改测试数据**：整份文件正则替换会把字符串里的 `page.getByText(...)` 改成 `this.page.getByText(...)` |
| H4 | 模板串插值状态机不对称 → 整个文件被当字符串，**用例数静默归零**却全绿 |
| H5 | `writeGenerated` 静默覆盖人手写过的文件（现在默认拒绝并列出冲突） |
| H6 | 落盘约束可被 `--filename=` 绕过（`--flag=value` 形式躲过 `includes` 检查） |
| H7 | 函数式 `defineConfig` 被误判成配置错误而**阻断健康流水线** |
| H8 | 单行断言失败（无 `Expected:`）因正则 `expect\([^)]*\)` 接不上 `toBeVisible()` 而被归成 `unknown` |
| H9 | 参数契约：schema 字段缺 description 会让模型靠猜；`PVMCP_CWD` 回落必须安全 |
| H10 | 换行符 CRLF 静默破坏 shebang 与全树哈希比对（`* text=auto eol=lf` 是必需品） |
| H11 | **环境失败漏成 `unknown`**：缺浏览器 9 条全挂在 `browserType.launch`，却被归成「人工判定」推给人（H8 的镜像问题） |
| H12 | **噪声挤掉失败原因**：Playwright worker 强加 `FORCE_COLOR=1` 触发的 Node 警告刷屏 stderr，把真正的错误挤出「只看尾部几行」的诊断窗口 |
| H13 | **安装决策矩阵漂移**：CLI 通道配置的「保留/重生成/显式优先」逐分支钉住，`buildCliConfig` 字节确定（全树哈希比对的前提）|
| H14 | **字节码污染一致性比对**：`__pycache__`/*.pyc 内嵌编译时路径，跨目录重编译必不一致；入库/复制/分发/比对四层排除缺一即误报漂移 |
| H15 | **URL.pathname 解析路径**：中文/空格路径被百分号编码后静默指错位置（发包实测真实发生）；源码一律 `fileURLToPath` |
| H16 | **版本/文档漂移**：版本号只认 `package.json`，四份文档（README/部署说明/部署说明.详细版/SKILL）的版本记录与自然语言使用示例缺一即发版未完成；**每份**文档版本记录首条=当前版本、不写超前版本号；§15.3 核心判据数与 `suites.mjs` 的 coreCounts 机械对账 —— 机器钉住，不靠人记 |
| H17 | **智能体线守门静默失效**：源码无 key 字面量、凭据只走 `DEEPSEEK_API_KEY` 环境变量通道、危险目标表非空且真拒（破坏性/生产/真实资金）、白名单外动作整份计划作废、无断言=Blocked（防「全绿但什么都没验」）；H6 另钉**守门先于能力检查**（顺序反转只在纯净包暴露，实测踩过） |
| H18 | **纯净发布包口径静默失守**：实跑 `distribute` 验产物本身 —— 无 `node_modules`、无 `.` 前缀内容（剔除开发机残留，解压/拷贝即部署）；排除规则写对但没生效属静默失效，静态检查看不见 |
| H19 | **发版门禁静默失效**：distribute 收尾自动「一次性副本 verify-all --mode 2 + 终态哈希终查」，门禁接线在位、机械链路真走、`--no-gate` 显式跳过且留痕 —— 流程靠人记就会忘，门禁长在 distribute 收尾，发版不可能忘 |
| H20 | **CLI 失败根因被堆栈噪声淹没**：daemon 崩溃时真实根因（如 `Chromium distribution 'chrome' is not found`）在 stderr 中段，尾部只剩 `daemonPid` —— 旧摘要按尾部取值等于「报了失败没报原因」；现在优先提取 PlaywrightError 根因行，已知浏览器缺失模式直接附修法 |
| H21 | **并行调度与收尾静默回归**：部署副本验证必须独占末波（并发写入=假漂移）、套件收尾只关自己的会话（close-all 会连并发兄弟会话一起杀）、harness 收尾 kill-all 收割孤儿浏览器（防 rmSync EPERM 回潮）、临时生成目录三处排除 —— 被「优化」掉的症状全是偶发假失败，机械钉住 |
| H22 | **断言数/CI 定义漂移**：断言数只认 `suites.mjs` 声明（assertions / 零依赖态部分数 / . 前缀钉），README 套件表、§15.3 判据行、verify-all 逐套对账、CI 三 job 定义全部机械对账 —— 数字各抄一份时漂移是静默的：读者拿错数、「一致 ✅」变成空话、CI 三态验收悄悄缩水 |
| H23 | **安装器合并式复制留旧账**：源码删掉的文件在部署副本静默残留（deployed-check 抓得住但默认安装自愈不了），现役 Skill 目录更在**任何门之外**；镜像式先清后拷（托管子树/Skill 目录/bundle）+ `--force` 整目录重置、用户杂散文件不动 —— 沙箱真装钉住，清不清理不再是「装的时候看起来正常」 |

### 并行怎么用（波内并发、波间串行；串行仍是默认）

早期版本直接 `Promise.all` 全部套件，三轮实测 **4/10、8/10、9/10** —— 会**假失败**。
四个踩踏点逐个钉死后并行才敢开：会话名带时间戳（不再抢同一浏览器会话）、产物名
时间戳+随机码（不再互相覆盖现场）、生成物目录进三处排除表（不再读写互踩）、
部署副本验证**独占末波**（整树比对不容任何并发写入）；收尾统一 `kill-all` 收割孤儿
浏览器（残留句柄会让 distribute 的 rmSync 报 EPERM，实测踩过）。调度结构由加固 H21 机械钉住。

`--parallel` 的语义是「波内并发、波间串行」。**串行仍是默认**：并发缩短的是墙钟时间，
串行换的是零意外 —— 一个会假失败的门禁，比一个慢的门禁危险得多，人一旦被冤枉过，
就会开始忽略它。需要快跑一轮时显式加 `--parallel`。

---

## 目录

```
playwright-verify-mcp/
├── mcp/                        MCP server（零运行时依赖）
│   ├── server.mjs              协议循环 + 14 个工具
│   ├── lib/                    核心逻辑（唯一判定真相源）
│   │   ├── tokenizer.js        等长脱敏（缺陷 2/3 的修法）
│   │   ├── testblocks.js       用例块 / 容器块分离（缺陷 1 的修法）
│   │   ├── lint.js             20 条规则 + PO 跨文件解析
│   │   ├── configcheck.js      CFG001–CFG012
│   │   ├── signature.js        ANSI 清洗 + 签名聚类 + 归因（缺陷 4 的修法）
│   │   ├── runner.js           执行层（输出重定向到文件）
│   │   ├── cli.js              playwright-cli 落盘模式
│   │   ├── generate.js         PO 分层生成 + 生成门禁
│   │   ├── standards.js        团队规范校验
│   │   ├── orchestrate.js      Excel → 回归编排
│   │   ├── configobj.js        配置对象解析
│   │   ├── llmclient.js        LLM 接入（Ollama 默认 / DeepSeek 显式，key 只从 env）
│   │   ├── nlplan.js           目标 → 受限计划（动作白名单 + 契约校验 + 降级骨架）
│   │   ├── agent.js            守门 + 确定性执行/断言/报告（判定权不在模型手里）
│   │   ├── explore.js          死链/坏图/表单盘点（确定性判定）
│   │   ├── heal.js             两层定位自愈（快照按名 + LLM 挑选；断言绝不自愈）
│   │   ├── collect.js          翻页采集（归并/两期对比/CSV 落盘）
│   │   └── args.js             MCP 参数严格解析（布尔不静默反转）
│   ├── py/read_cases.py        Excel 读取（openpyxl 可选，缺时用内置 zip+XML 解析）
│   └── test/                   13 套回归 + 一键入口 verify-all
├── skill/playwright-verify/    Skill
│   ├── SKILL.md                入口
│   ├── references/             12 篇知识层
│   ├── scripts/                8 个命令行包装
│   ├── assets/                 5 个模板
│   └── install.mjs             安装器
├── demo/                       样例集与可离线复现的演示
│   ├── tests/                  clean / messy / tricky
│   ├── configs/                baseline / legacy
│   ├── cases/                  Excel 编排样例（regression.xlsx / e2e.xlsx）
│   ├── site/index.html         演练页（带 aria-label 与 data-testid）
│   └── regression/             8 条用例的演示回归（自造页面，离线可跑）
├── README.md                   本文档（唯一完整说明）
├── 部署说明.md                部署速查（纯净包、拷贝即部署）
└── 部署说明.详细版.md         部署完整参考（DSH / CI / 配置 / 排障 / 全工具自然语言示例）
```

---

## 边界

- **不生成用例。** 官方 planner / generator / healer 做得更好，本工具不碰。
- **不替代测试分析。** 它只验证你描述的场景；覆盖该不该有、断言对不对，还是人的事。
  它不会自己发现「你漏测了退款路径」。
- **不自动改断言。** healer 可以提议修，但「把断言放宽到能过」和「修好定位器」在代码上长得几乎一样，必须人来判。
- **不碰真实资金与生产数据。** 涉及真实支付、真实用户数据的操作一律不可自动化执行。
  智能体线把这条做成代码：危险目标（真实资金/破坏性数据/生产变更/对外发送/批量对外）与
  生产主机在**打开浏览器之前**就拒绝；测试上下文（测试/staging/演练/沙箱）豁免误伤。
- **LLM 只做规划，不做判定。** 「通过/不通过」永远由确定性断言链给出；计划里混入白名单外
  动作整份作废而不是挑着执行；没有断言的执行判 Blocked。模型编造不了结论。
- **不把页面内容送出机。** LLM 默认本地 Ollama；只有显式开云端时目标文本才发给该云端，
  截图与页面快照永不进 LLM 请求。
- **不适用于**单元测试、纯接口契约测试、需要真机的移动端原生测试。
- **不维护被测应用。** 定位约定是「当前页面结构」的投影，页面重构后
  `references/locator-strategy.md` 要同步更新，否则生成质量会悄悄劣化。
- **默认只允许 test / staging。** 生产验证要走独立审批。

**硬规则**：不自动改断言；凭据只从环境变量读；默认只允许 test/staging，生产走独立审批；
不碰真实资金与生产数据；不验证不写盘。

边界不是免责声明，是让「同事敢自己用」的前提 —— 边界清晰，他才知道什么时候该停手找人。

---

## 附：知识层文档索引（`skill/playwright-verify/references/`）

| 文件 | 回答的判断题 |
|---|---|
| `locator-strategy.md` | 这个定位器该不该用？降级顺序是什么？ |
| `waiting-and-sync.md` | 到底在等什么？等不到算谁的问题？ |
| `assertion-discipline.md` | 这条用例证明了什么？断言行不行？ |
| `test-structure.md` | 用例边界划得对不对？状态隔离了吗？ |
| `flaky-triage.md` | 这次失败是产品回归、用例缺陷还是环境抖动？ |
| `evidence-and-traces.md` | 失败现场留了什么证据？够不够定责？ |
| `cli-mode.md` | CLI 模式怎么用？哪些命令、怎么落盘？ |
| `po-and-generation.md` | 页面层与用例层怎么分？生成门禁是什么？ |
| `report-translation.md` | 结果怎么回译成人话？ |
| `env-and-accounts.md` | 环境与账号口径怎么外置？ |
| `nl-agent.md` | 智能体线：声明式测试怎么用？七工具怎么映射？LLM 怎么配？禁止做什么？ |
| `team-standards.md` | 团队规范怎么写进 AGENTS.md？ |

---

## 版本记录

### v1.8.15（2026-10-05）

- **log_summary 按工具块（权重序 + maxMs 透出）**：诊断（`Temp\pv-diag-r22.mjs` 真 stdio
  造混合流量日志 → 真 CLI 消费）**证伪了本轮原命题**——text 的「按工具」段落 v1.7.0 起就有、
  `--json` 的 byTool 早已全量（含 maxMs/cache），「缺按工具段落」不成立。真日志暴露的
  真实小缺口：① `maxMs` 每工具采集了却从不渲染（「哪个工具最慢」一页内答不了，全局分位数
  不具名）；② 多工具挤一行、按插入序（调用量大的工具不靠前）。修法（渲染层最小改动，
  `--json` 零变化、纯函数与 CLI 同一份判定天然成立）：按工具改**多行块**，按调用量降序
  （并列按名字稳定序），每行 `· 工具 共 N ok/error/rejected max Xms [cache 三态与命中率]`；
  max 含 rejected 的 ms=0（0 只会拉低，具名最慢值仍是真实执行上界）；工具数受 14 上限约束
  无需截断。真 CLI 取证：`· nl_test_goal 共 2 error 2 max 1032ms cache hit 0/miss 2/…`
  —— 具名最慢工具一页可见。
- **钉侧补强**：权重序钉原夹具插入序恰好等于权重序（咬不红）——补专用夹具
  （低频工具 aaa_first 先插入，插入序 ≠ 权重序），咬合验证排序真被验到。
- **protocol-check 115 → 116**（形状逐字节钉更新 + 权重序/maxMs 透出钉）；负向咬合
  （排序回退插入序 / max 段拔除）2 钉具名回红、4 钉保持绿，sha256 字节级还原
  （logsummary=1732cdd8fbc8b5d6）。核心断言 504/559/656 → **505/560/657**；
  全量 **13 套件共 686 断言**（含存在性钉 3、部署段 26）。

### v1.8.14（2026-10-05）

- **安装器镜像式复制（--prune 语义默认生效）**：诊断（`Temp\pv-diag-r21.mjs` 真机）证实
  残留机制成立——install 默认对 `mcp/skill/demo` 三子树是**合并式覆盖**（仅 --force 才整删），
  源码删掉的文件会在部署副本留旧账且默认安装零清理（人造残留实验：两处假陈旧文件
  全部幸存）；deployed-check 能抓 INSTALL_ROOT 残留但**自愈不了**（要红到有人手动删），
  而现役 Skill 目录 `~/.agents/skills/playwright-verify` **不在任何门内**，残留永远不可见。
  注册项（单 key 覆盖 + 单份备份）与 dsh-bundle（固定 2 文件）盘点无堆积。
  修法：默认安装改**镜像式**——三子树 + 现役 Skill 目录 + bundle 先清后拷（源码删过的
  文件不留旧账，用户杂散根文件不动）；`--force` 升级为整目录重置（node_modules/配置/
  bundle/杂散文件一并重来）。
- **H23 沙箱真装三钉**（hardened-check 94+3=97）：USERPROFILE/HOME 重定向临时目录真跑
  install——默认安装成功且两处陈旧残留被清、用户杂散根文件不动；--force 重置后杂散清、
  node_modules 重拷。负向咬合（子树清理回退 / force 重置拔除）2 钉具名回红、4 钉保持绿，
  sha256 字节级还原（install=d9788c4eacc8af12）。
- 核心断言 501/556/653 → **504/559/656**；全量 **13 套件共 685 断言**（含存在性钉 3、部署段 26）。

### v1.8.13（2026-10-05）

- **对抗语料属性化生成**：诊断对账——20 条规则里只有 6 条（PW002/006/007/008/013/106）有
  手写专属对抗语料，**14 条无边界回归**；手写清单只会给「咬过人的规则」配语料，新规则
  落地没人记得补，而「改一次正则悄悄放宽/收紧、总数看起来正常」正是 PW001 的教训。
  修法（单一源两处消费）：
  1) 每条规则自带 `samples: {bad, good, raw?}` 属性（`RULE_SAMPLES` 紧贴规则表，附加循环
     挂到规则对象上）；`raw: true` 按完整文件处理（PW007 块级规则不能包进标准用例体）；
  2) `adversarialCorpus()` 展开：每规则出 bad（expectIds=[自己]）与 good（forbidIds=[自己]）两案；
  3) lint-check 新段**真 lint 跑**：40 案 bad 全命中自己 / good 全不冤枉（一次写对零返工），
     每规则聚合一钉 + 覆盖门共 +21；rules-check 结构层覆盖门 + 展开数对账共 +2 ——
     **新规则不带语料进不了表**。
  手写 18 案（实证洞钉）保持原样——两类语料互补：手写钉历史洞、属性化保未来覆盖。
- **负向咬合**（`Temp\pv-bites-r20.mjs`）：锚 A（拔 PW011 samples → 覆盖门/展开数/该规则行
  4 钉红，他规则不连坐）；锚 B（good 案映射错拿 bad 样例 → 抽查 5 规则全红——生成映射错
  整网兜住）。5 钉具名回红、5 钉保持绿，sha256 字节级还原。**咬合方法论**：首个锚
  （raw 属性失效）经实测证伪——块级解析器把嵌套 test 块算得准，包装并不掩盖 PW007 判据；
  前提被证伪即换真承重锚，不硬凑红。
- lint-check 32 → **53**、rules-check 35 → **37**；核心断言 478/533/630 → **501/556/653**；
  全量 **13 套件共 682 断言**（含存在性钉 3、部署段 26）。

### v1.8.12（2026-10-05）

- **explore_page 表单指纹与两期对比**：诊断 `Temp\pv-diag-r19.mjs`（真 stdio + 回环靶站 v1→v2
  表单变更）取证三项缺口——`required` 根本不采（必填位变化**不可检测**）、报告 inputs 截前 10
  （12 字段表单实测丢 2 个字段）、两期零信号（无 hash 无 diff，两期 verdict 都是 Pass）。修法：
  1) facts 采集补 `required`（`FACTS_EVAL_FN` additive）；
  2) 表单指纹：`formHash`（字段按 name/type/required 排序进哈希——**重排不算漂移**；
     加/删字段、改类型、必填位翻转、action 变都变）+ `formsSummary` 整页 formsHash；
     hash 从**全量** facts 算，不吃报告的 10-input 截断；
  3) 两期对比：`diffAgainst`（上一期报告 `factsFile` 指向的 facts-*.json）→ `diffForms`
     检出字段新增/删除、必填位变化（required 布尔翻转）、表单级增删，明细各类截 20 条 +
     `*Total` 诚实计数；**对比是信息不是质检，不改 verdict**（可能是有意改版）；
     diffAgainst 不可读 → `DIFF_TARGET_INVALID` 诚实报错，绝不静默当「无对比」。
  报告增量字段：`factsFile`（本 facts 指针）/ `formsHash` / 逐表单 `hash` / `formsDiff`。
- **钉侧抓出真 bug**：diffForms 初版 `*Total` 取截后数组长度（25 条新增报成 20/20）——
  「静默少计数」类缺陷，改为独立计数器（钉先红后修）。
- **nl-agent-check 127 → 133**（formHash 稳定+重排不敏感/敏感四变体/整页指纹/三分检出/
  无变更全零/明细有界 total 诚实）、**nl-agent-e2e 18 → 21**（真靶站两期真跑：指纹落报告/
  formsHash 变化+三分检出+verdict 不翻 Fail/diffAgainst 不可读诚实报错）；负向咬合
  （必填检测短路 / formsDiff 不进报告）3 钉具名回红、10 钉保持绿，sha256 字节级还原。
  核心断言 472/527/621 → **478/533/630**；全量 **13 套件共 659 断言**（含存在性钉 3、部署段 26）。

### v1.8.11（2026-10-05）

- **趋势 structuredContent 瘦身（全量落盘 + 上下文有界）**：多报告趋势的 structuredContent
  是回灌模型的负载，签名爆炸时随签名数线性膨胀（诊断 `Temp\pv-diag-r18.mjs`：130 签名 × 5 份
  = **50.9KB**，其中 sample 证据文本 7.8KB、三分法列表 20.7KB），与「长产物一律落盘不灌上下文」
  红线相悖。修法三件套：
  1) **全量趋势 JSON 落盘 `trend-*.json`**（与 md 同名同目录，version 1 原形、含 sample）——
     CI 对账与 join-back 以落盘为准，一行不缺；
  2) **structuredContent 有界化**（`slimTrendForContext` 纯函数，version 2 如实标记形状变更）：
     四个列表（序列/新/消除/持续）各截前 `TREND_MD_MAX_ROWS` 条（与 md 同一常量单一源），
     条目去 sample（全量在落盘 JSON），签名串/计数矩阵逐字段不动；每列表带
     `*Total` 诚实计数 + `contextTruncated` 标记；
  3) **text 通道同口径**：format=json 也回有界对象；默认 text 给 headline + md/JSON 双文件指针。
  实测 130 签名场景 50.9KB → **21.7KB（42%，省 58%）**，且签名数再涨回灌面仍有界（≤50 行/列表）；
  md 截断注语同步改指「趋势落盘的同名 JSON 文件」。
- **signature-check 37 → 42**（有界口径/回灌面 ≤ 全量一半/行内保真/纯函数不突变输入/未超上限
  透传）、**nl-agent-check 126 → 127**（structuredContent 截 50+total、落盘 JSON 回读 65 条全量
  含 sample、format=json text 同口径）；负向咬合（cap 透传 → 纯函数 2+工具面 2 钉红 / 拔落盘行
  → 工具面 2 钉红）6 钉具名回红、8 钉保持绿，sha256 字节级还原。
  核心断言 466/521/615 → **472/527/621**；全量 **13 套件共 650 断言**（含存在性钉 3、部署段 26）。

### v1.8.10（2026-10-05）

- **计划缓存命中率观测**：`PVMCP_LOG` 的 tools/call 行为 `nl_test_goal` 扩 `cache=hit|miss|skip`
  字段（值取报告 planCache 单一源、`PLAN_CACHE_STATES` 白名单；其余工具与无报告的错误路径不落字段
  ——「字段可选」是解析口径的一部分，缺字段 ≠ 命中率 0%）。`log_summary` 按工具透出三态分布
  与命中率 `hit/(hit+miss)`（skip 是「没查」llm=off，不进分母；只有 skip 时 null，不拿 0% 充数）；
  白名单外的值（cache=banana）整行进 malformed —— 与 ms=oops 同口径，不静默猜值。
  无 cache 行的日志输出与旧口径**逐字节一致**（形状兼容）。诊断 `Temp\pv-diag-r17.mjs` 真 stdio
  双调用实测：v1.8.9 行格式 0/3 条带 cache，命中率此前在日志面完全不可见。
- **protocol-check 109 → 115**（字段可选/三态计数+命中率口径/仅 skip → null/白名单外进
  malformed/formatText 逐字节兼容/CLI 与纯函数同一份判定）、**flow-check 41 → 44**（真 stdio
  双调用实测行格式：首调 miss、重放 hit、llm=off skip、其余工具不落字段）；负向咬合
  （写侧去字段 → F11 三钉红 / 解析侧不解析 → C 段四钉红）7 钉具名回红、7 钉保持绿，
  sha256 字节级还原。核心断言 460/515/606 → **466/521/615**；全量 **13 套件共 644 断言**
  （含存在性钉 3、部署段 26）。

### v1.8.9（2026-10-05）

- **趋势 md 行截断**：`summarize_report` 多报告趋势在签名爆炸时（实测 130 签名 × 5 份报告 =
  md 27.8KB / 282 行，52 份周趋势轻松破 50KB）对四个渲染列表（新签名/消除/持续/签名计数序列）
  按**权重序**各截前 `TREND_MD_MAX_ROWS=50` 行，尾部附诚实计数行「…（该列表还有 N 条未展示，
  共 X 条；完整数据在趋势 JSON 的同名字段 —— md 只截展示不截数据）」。
  **结构化数据零截断**：signatureSeries 与三分法数组保全量 —— 计数矩阵是 CI 对账依据，
  阅读层的体力活不能让数据缺行。诊断脚本 `Temp\pv-diag-r16.mjs`（含 signature() 归一化把
  100 条 `toHaveText('签名Sxxx')` 合并成 1 个签名的活证据 —— 参数化断言在趋势里本来就是一根）。
- **signature-check 31 → 37**（常数钉/数据保全量/行数上界/诚实计数/权重序/小趋势形态零变化）、
  **nl-agent-check 125 → 126**（工具面：真实文件 → md 落盘含计数行、结构化 65 全量）；
  负向咬合（禁用 capMdRows 截断）3 钉具名回红、5 钉保持绿，sha256 字节级还原。
  核心断言 453/508/599 → **460/515/606**；全量 **13 套件共 635 断言**（含存在性钉 3、部署段 26）。

### v1.8.8（2026-10-05）

- **`nl_test_goal` 计划缓存**：同指纹（goal/url/provider/model）复用 LLM 规划、**绝不复用执行** ——
  命中后 executePlan 仍全量真跑、真断言、证据新鲜落盘。失效口径宁严勿宽：四元组任一变即失效；
  TTL 5 分钟 / 容量 8（FIFO 淘汰）；只缓存**成功的 LLM 计划**（fallback 骨架与不合法计划不缓存，
  下一次必须重试规划而不是吃到降级产物）。新 `lib/plancache.js` 纯函数（时钟可注入）；
  报告增量字段 `planCache`（hit/miss/skip）+ planNote 命中标注，CI 可审计。
- **真浏览器活体钉**：同指纹重放 LLM 桩零新增请求、tier-1 自愈照常发生（执行真跑了）；
  goal/url 变更现场重规划（桩恰好 +1）；llm=off → skip 不吃缓存。
- **nl-agent-check 118 → 125**（指纹四元组任一变即失效/TTL 到期即淘汰/容量 FIFO/报告字段缺省兼容）、
  **flow-check 34 → 41**（活体 +7）；负向咬合（禁用缓存查表）1 钉具名回红、5 钉保持绿，
  sha256 字节级还原；真 stdio 双调用实测（首调 miss 4.6s / 重放 hit 桩零新增 / 换 goal miss）。
  核心断言 446/501/585 → **453/508/599**；全量 **13 套件共 628 断言**（含存在性钉 3、部署段 26）。

### v1.8.7（2026-10-05）

- **`summarize_report` 多报告趋势（files）**：传 N 份报告路径（或目录，目录按 mtime 升序取
  `*.json`）做跨份对比 —— 通过率曲线 + 签名漂移三分法：**新签名**（末份新出现=回归信号）/
  **消除**（末份已无=修复成效）/ **持续**（存量，附 prev→last 计数）。签名沿用单报告同一
  `signature()`（单一源，另造一套必然口径漂移）；趋势表落盘 md（`trend-*.md`）只回摘要与
  路径，不把整张表灌进上下文。诚实口径：任一报告不可解析即整体 REPORT_ERROR 指名道姓 ——
  跳过坏报告再出趋势，「这周失败变少」可能只是「这周少读了一份」。**契约修正**：
  因趋势会落盘 md，readOnlyHint 诚实翻 false（protocol-check 只读集合六→五）。
- **钉先抓出实现真 bug**：计数矩阵初版写 `counts[i]++`，同一签名同份报告聚的多条失败只记 1
  （持续签名 prev→last 全失真）—— 趋势钉红了之后才修成 `+= c.count`。
- **signature-check 27 → 31**（趋势纯函数钉 +4）、**nl-agent-check 115 → 118**（E 工具面钉 +3）；
  负向咬合（计数矩阵闸失灵 `+= c.count`→`+= 1`）1 钉具名回红、5 钉保持绿，sha256 字节级还原。
  核心断言 439/494/578 → **446/501/585**；全量 **13 套件共 614 断言**（含存在性钉 3、部署段 26）。

### v1.8.6（2026-10-05）

- **同类参数整数化清扫（收尾）**：`run_verify.retries`、`run_verify.timeoutMs`、
  `cli_session.timeoutMs`、`nl_test_goal.maxSteps` 换 `intArg` —— 重试次数/毫秒超时/步数上限
  都没有小数合法语义；此前的洞是实打实的：`timeoutMs=0.5` 会被 `|| 默认值` 放行成 **0.5ms
  的真超时**（truthy 浮点），`maxSteps=2.5` 被硬夹后当 2.5 步上限用。`retries` 钉还验了
  **参数闸先于目录存在性检查**（否则「参数非法」被报成 NOT_FOUND 误导修复方向）。
  `healLlmBudget` 的 3.9→3 截断是设计行为（预算口径「最多调 N 次」，有钉）不动，
  注释里写明与 count/超时类「取整即失效」的区别。
- **`collect_table` 报告补 `pagesTotal`（顺手疵，两轮顺延后落地）**：续采时
  `pagesScanned` 只算本轮（从断点页起扫），读者会把「翻页 2 页」误当总量；现在并存
  `pagesScanned`（本轮）与 `pagesTotal`（含基准累计，与 rows.json 页账同口径），摘要行
  续采时明示「翻页 N 页，累计 M 页」。
- **nl-agent-check 111 → 115**（E 整数钉 +4）、**flow-check 32 → 34**（F7b 累计页账钉 +2，
  真浏览器续采实测 scanned=2/total=4）；负向咬合双阶段（整数闸失灵 4/4 具名回红、
  累计页账闸失灵 1 钉回红 + 非续采对照钉保持绿），sha256 字节级还原 ×2。
  核心断言 435/490/572 → **439/494/578**；全量 **13 套件共 607 断言**（含存在性钉 3、部署段 26）。

### v1.8.5（2026-10-05）

- **`explore_page` 探活预算（慢死主机不再拖垮整轮巡检）**：真实取证（回环「接受连接但永不响应」
  靶机 + 非路由黑洞地址）确认单探测 5s 超时有效，但无总预算时按条数线性放大 —— 抽样上限 50
  × 并发 4 × 5s ≈ 65 秒无反馈。现在双层预算：单条 `probeTimeoutMs`（默认 5000，500–30000）、
  整段 `probeBudgetMs`（默认 20000，2000–120000）；在飞探测把超时帽到剩余预算，排队条目
  不再发起但**也不静默消失** —— 逐条记不可达 + `budgetExhausted` 标记，报告 `links.partial`
  落 partialCount/partialReason，摘要明示「这是 partial 结果，不是探过没问题」。顺手并入同类
  参数清扫：`maxLinks` 换 `intArg`（2.5 不再静默当 2 或 3 条用）。
- **nl-agent-check 105 → 111**（D12 探活预算钉 +4：慢死主机单探测兜住/耗尽诚实 partial/
  wall clock 有界/未耗尽不凭空出现标记；E 工具面钉 +2：probeTimeoutMs/maxLinks 拒小数）；
  负向咬合（禁用预算闸）1 钉具名回红、5 钉保持绿（含反向对照），sha256 字节级还原。
  核心断言 429/484/566 → **435/490/572**；全量 **13 套件共 601 断言**（含存在性钉 3、部署段 26）。

### v1.8.4（2026-10-04）

- **观测日志容量上限与轮转（`PVMCP_LOG_MAX_MB`）**：长跑 server 的日志一请求一行只增不减，
  无上限会把磁盘和 `log_summary` 的读取一起拖垮。默认 2MB、超限轮转（当前文件移 `<file>.1`、
  新日志从轮转标记行起，前一段数据不丢）；`0`=关闭轮转（外挂轮转方案的留口）；非法值回退默认
  并向 stderr 提示一次。`log_summary` 对轮转前件给出提示（text 一行说明 / `--json` 增量字段
  `rotatedPrev`，形状兼容）——「调用量比预期少」不再是静默错觉；聚合端天然容忍标记行
  （进 otherLines，不混调用量与错误分布）。
- **协议套 102 → 109**（C3 轮转钉 +7：默认轮转/标记容忍/0 关闭/旋钮控阈值/垃圾回退/汇总提示两形态）；
  钉先抓出 log_summary 顶层 `return` 真语法错误（exit 1）后修；负向咬合（禁用轮转）6/6 具名回红
  （`MAX_MB=0` 按设计保持绿），sha256 字节级还原。全量 **13 套件共 595 断言**（含存在性钉 3、部署段 26）。

### v1.8.3（2026-10-04）

真实测试轮（真 stdio MCP 进程 + 真浏览器 + 回环靶站，续采路径 11 项全过）抓出 2 个参数语义 bug 并修复：

- **整数参数严格校验（args.js 新增 `intArg`）**：`keyIndex=1.5` 曾让每行都取不到键 → 静默零行 →
  误报 `COLLECT_EMPTY`「站点没数据」（把调用方笔误怪给目标，误导性根因）；`maxPages=2.5` 被循环
  当 3 页用（浮点静默向上）。下标/计数没有小数的合法语义 —— 现在 `keyIndex`/`maxPages` 非整数
  一律参数层报错「应为整数」（TOOL_EXCEPTION，打开浏览器之前拦下）。不与预算口径混淆：
  `healLlmBudget` 的 3.9→3 截断是设计行为（有钉），下标/计数的取整是失效（有钉禁）。
- **负向咬合抓出测试钉脆断并加固**：回退整数闸验红时，maxPages 钉先解 `.message.includes`
  （message 缺席抛 TypeError → 套件崩溃、FAIL 行没打出来 = 「崩了不是红了」）——钉改为先比
  error 短码、message 取空串兜底，重咬合 4/4 按名回红、sha256 字节级还原。
- **args-check 42 → 46**（intArg 钉 +4）、**nl-agent-check 103 → 105**（工具面钉 +2）。
  全量 **13 套件共 588 断言**（含存在性钉 3、部署段 26）。

### v1.8.2（2026-10-04）

- **`collect_table` 断点续采（resumeFrom）**：长采集（上百页）中断后带上次 rows.json 续扫 ——
  已采行先占位（首见胜出，重扫页同键行不覆盖基准），从「最后一个产出过新行的页 +1」续采
  （eval 失败/零新增页整段重扫），翻页导航到不了断点页如实失败（`COLLECT_RESUME_NAV_FAILED`，
  绝不把第 1 页当断点页）。续采基准带指纹（url + keyIndex），不一致拒绝续采（`COLLECT_STALE`）——
  爬错页会把别的表的行混进基准、污染两期对比，宁可让人从头来；基准不可解析/缺字段
  `COLLECT_RESUME_UNREADABLE`；与单页模式组合 `COLLECT_RESUME_NOT_APPLICABLE`（都在打开浏览器前拒）。
  rows.json 的 pages 链式归并（基准页 + 新页），本次基准可再作下次续采基准。
- **nl-agent-check 94 → 103**（续采计划钉 +9：指纹闸/断点页计算/种子归并/工具守门）；
  **flow-check 27 → 32**（续采真跑钉 +5：断点→补齐全量/链式接续/两条拒绝语义）。
  1 组负向咬合（回退指纹闸）4 条具名钉如约回红。全量 **13 套件共 582 断言**（含存在性钉 3、部署段 26）。

### v1.8.1（2026-10-04）

- **自愈 LLM 调用预算硬化**：二级自愈（llm-pick）加整次运行总闸 `healLlmBudget`
  （nl_test_goal 参数，默认 2、硬上限 10、0=只用确定性快照自愈）—— 自愈成功后执行继续，
  没有总闸的话每步都能烧一次 LLM，事件驱动不等于不设防。预算尽如实失败
  （`HEAL_LLM_BUDGET_EXHAUSTED`，LLM 零调用、不静默降级）；报告增量字段
  `healLlmBudget`/`healLlmUsed` 可审计。
- **nl-agent-check 85 → 94**（预算钉 +9：总闸/耗尽短路零调用/跨步共享/穿线/报告用量）；
  2 组负向咬合回退按名验红。全量 **13 套件共 568 断言**（含存在性钉 3、部署段 26）。

### v1.8.0（2026-10-04）

两篇文章差异化能力合入：智能体线补「两层定位自愈」，新增「翻页采集 + 两期对比」工具，
并落一套全流程验证（工具链真串 + 自然语言真跑）。同功能已有工具合并不重建：声明式目标归
`nl_test_goal`、死链巡检归 `explore_page`、证据落盘归既有约定、失败归因归 `summarize_report`。

- **两层定位自愈（heal.js）**：click/fill 定位类失败自动修 —— ①快照按可见名整词匹配（角色优先）；
  ②名匹配不中时 LLM 从 ≤40 条元素清单里挑 ref（选择题不是填空题，清单外 ref 一律拒）。
  **断言绝不自愈**：expect_* 不进自愈门 —— 自愈只解决「怎么找到它」，不改变「判定什么」。
  自愈来源（snapshot-ref / llm-pick）进报告 `via` 字段，`healedCount` 对账。
- **`collect_table`（collect.js，第 14 个工具）**：确定性翻页采集 —— 页码框/下一页两种翻页、
  空页/无新行/上限三选止损（上限 100 页硬顶）、首见胜出归并；rows.json + UTF-8 BOM CSV 落盘，
  两期 diff（新增/删除/变化/未变，只对照不判失败）；行数据只落盘不回灌上下文。
- **flow-check 全流程验证（27 断言）**：lint 门禁 → 自然语言目标真执行（两层自愈真回环、
  stub LLM 真 HTTP）→ 翻页采集/两期对比 → 巡检归因；含断言不自愈、生产硬拦截、日志脱敏哨兵。
- **真实测试抓出 5 个真 bug 并修复**（每个配行为钉 + 负向咬合回退验红，5/5 如约变红）：
  ①自愈失败正则漏 CLI 真实句式 `does not match any elements`（自愈根本不会启动）；
  ②中文 `#id` 提不出语义词（`\w` 不含 CJK）→ 自愈直接放弃；③JSON envelope 根因被
  extractRootCause 吞掉；④runCli 早退失败只给 message 不给 summary → 步骤 detail 空（失败没原因）；
  ⑤自愈 `via` 字段没透传到报告（分层来源看不见）。
- **nl-agent-check 72 → 85**（自愈/采集纯函数钉 +13）；MCP 工具面 13 → 14。
  全量 **13 套件共 559 断言**（含存在性钉 3、部署段 26）。

### v1.7.3（2026-10-04）

对抗语料轮：为规则判据补上误报/漏报的边界回归保护，并修掉对抗探针实证的 7 个洞
（6 漏报 + 1 误报，归并 6 个根因）。判据再对，没有回归钉也挡不住下一次手滑。

- **PW002** 链式 .only：`test.describe.only(` / `test.describe.serial.only(` 曾整体漏报
  （describe 前面是点号，被前缀类挡住，两条旧分支一条都匹配不上）；`mytest.only(` 仍不冤枉。
- **PW008** 链式接收者：`!await page.locator('#x').isVisible()` 与 `!(await …)` 括号形态
  曾漏报（旧正则不跨调用后缀）；`!await panel.isVisible()` 原形态不受影响。
- **PW013** 调用形态：`test.setTimeout(300_000)` 曾漏报（只认 `timeout:`/`timeout=` 选项写法）；
  `clearTimeout(`/`resetTimeout(` 不冤枉，阈值仍按「求值 > 100s」把关。
- **PW106** 误报消除：`waitForSelector('.x')` 有参等待曾被冤枉 —— 去字符串文本把实参抹成空括号，
  空参判据必须看保留字符串的原文（与 PW103 跳过理由同一课）。
- **PW006** 语句级化：await 判定从行级改语句级 —— `await page.goto(); expect(…)` 的前缀劫持与
  prettier 折行的跨行断言（旧正则连匹配都匹配不上）双双漏报；`const p = expect(…); await p;`
  变量接走形态不再被冤枉。
- **块判定**：kind 只看首段修饰符 —— `test.describe.serial.only` 曾被误判成用例，空容器误报 PW007。
- **对抗语料**：扫描器套新增 18 钉（9 实证洞钉 + 9 边界守卫）；6 组负向咬合逐修复回退验红再恢复。
- 扫描器套 14 → 32；全量 12 套件共 **518 断言**（含存在性钉 3、部署段 26）。

### v1.7.2（2026-10-04）

修复「不报错但结论错」：`summarize_report` 对不可解析/不像报告的输入曾静默返回全零空报告
（`isError=false`、`totals` 全 0 —— 调用方会把「解析失败」当成「没有失败」，是假绿制造机）。

- **输入校验**：`summarize()` 现在先解析字符串再验形状——不可解析 JSON、非 JSON 对象、
  缺 `suites`/`stats` 标记一律返回 `.error`（与 `summarizeFile` 同一错误通道），
  工具面自动 `isError + errorCode=REPORT_ERROR`（CLI exit 2），失败必须以 isError 表达。
- **行为钉**：签名套 +4（解析失败报错、形状缺失报错、合法字符串真解析、最小空报告不误伤）、
  协议套 +2（坏 JSON/坏形状工具面必须 isError+REPORT_ERROR）；负向咬合 5 实现钉回退全红。
- 归因套 23 → 27、MCP 协议套 99 → 101；全量 12 套件共 **500 断言**（含存在性钉 3、部署段 26）。

### v1.7.1（2026-10-04）

真实测试驱动的修复轮（真会话 + 真日志 + log_summary 真消费，四 bug 修复全部带行为钉与负向咬合）：

- **修复 stdin EOF 静默丢调用（最重）**：批量客户端一口气发完 N 个调用随即关 stdin 时，
  close 事件先于串行队列排空到达，旧实现直接 `process.exit(0)` —— 队尾调用被静默吞掉
  （真实测试实测 15 进 5 出，无响应也无日志）。现在 close 先排空队列、刷完 stdout 再退出；
  protocol-check 新增排空钉（40 连发 + 假 runner 制造确定性异步缝隙，全量应答才过）。
- **修复版本漂移**：VERSION 旧读 `mcp/package.json`（陈旧 1.0.0，与根 package.json 漂移），
  现只认仓库根 `package.json`（与 H16 唯一源同源）；拔除零消费者的 `mcp/package.json`（84 → 83 文件）；
  版本钉从永真表达式改为与根 package.json 逐字比对。
- **错误码语义化（观察面闭环）**：失败出口强制 `structuredContent.errorCode` 语义短码
  （显式传入 > structured.error 短码形态 > `UNCLASSIFIED` 耻辱码），日志 `code=` 同步取短码 ——
  旧实现裸报告类失败（门禁不过、报告解析失败等）全落字面 `isError`，log_summary 错误分布挤成一个噪声桶；
  12 个裸报告 fail 站点补显式码（`CONFIG_BLOCK`/`LINT_BLOCK`/`REPORT_ERROR`/`RUN_FAILED`/`GOAL_FAIL` 等）。
- MCP 协议套 95 → 99（排空钉 1、错误码钉 3）；全量 12 套件共 **494 断言**（含存在性钉 3、部署段 26）。

### v1.7.0（2026-10-04）

- **观测消费面（log_summary）**：读 `PVMCP_LOG` 出一页度量摘要——调用量（三态含 rejected）、
  成功率、延迟分布（nearest-rank P50/P95/P99，样本不含 rejected——ms=0 是构造值会拉假分位数）、
  错误分布（按 code 聚）。纯函数 `mcp/lib/logsummary.js` + CLI `scripts/log_summary.mjs [--json]`，
  MCP/CLI 同一份判定逻辑；解析异常行**绝不静默丢弃**（计数 + 原文留样——丢一行就是调用量少一个）。
  protocol-check 新增 8 项（口径、分位数精确、malformed 不静默、CLI 与纯函数对数）。
- MCP 协议套 87 → 95；加固套 +1（H20 退出取证：无 FAIL 行的崩溃退出保留输出尾部，stderr 根因不丢）；
  全量 12 套件共 **490 断言**（含存在性钉 3、部署段 26）。

### v1.6.0（2026-10-04）

- **观测日志结构化（PVMCP_LOG）**：每请求一行、定长字段 `name / ms / outcome / code`，
  ok/error/rejected 三态全记账（协议级拒绝 -32602 也记，调用量不漏被拒请求），离线即可聚合
  调用量、成功率、延迟分布（P95/P99 由 ms 算）、错误分布（按 code 聚）。脱敏红线：参数值/
  结果文本/密钥一律不进日志（哨兵测试钉住）；客户端可控值过清洗（空白折叠、超长截断），
  `\n` 注入不拆行（一事件一行）。protocol-check 新增 C 段 7 项（三态记账、结构可解析、
  哨兵脱敏、注入不拆行、ms 可解析）。
- MCP 协议套 80 → 87；全量 12 套件共 **481 断言**（含存在性钉 3、部署段 26）。

### v1.5.0（2026-10-04）

- **MCP 工具面补 `annotations` 副作用声明**：13 个工具逐个按**真实副作用**标注
  `readOnlyHint / destructiveHint / idempotentHint / openWorldHint`（最坏情形定性——能覆盖人手写过的
  内容、驱动真实页面点击、执行项目测试代码即 destructive；判定口径写在 server.mjs 注释里），
  并在 `tools/list` 真实下发——客户端可据此决定自动放行还是要求确认，行为零变化、
  契约向后兼容（旧客户端忽略未知字段）。protocol-check 新增 6 项机械钉住：13/13 带声明且四 hint 全布尔、
  只读六/破坏性五/openWorld 五**精确集合**、语义自洽（readOnly ⇒ 非破坏且幂等）、
  `tools/list` 线上真发（只写在 TOOLS 里不接线 = 等于没声明）。
- MCP 协议套 74 → 80；全量 12 套件共 **474 断言**（含存在性钉 3、部署段 26）。

### v1.4.0（2026-10-04）

- **断言数单一源（加固 H22）**：逐套件断言数声明收进 `mcp/test/suites.mjs`
  （`assertions` 基座数 / `assertionsNoDep` 零依赖态部分数 / `dotPins` . 前缀钉；`coreCounts`
  派生三模式核心数），verify-all **逐套对账** —— 实跑 PASS 数 ≠ 声明即失败，日常无 `--mode`
  态同样拦；README 套件表、§15.3 判据行、CI 三 job 定义全部机械对账（H16 对账源同步改为
  suites.mjs）。断言合法变更路径变成「改 suites.mjs 声明 → 机器指出文档待改处」。
- **CI 口径加固**：手动触发（`workflow_dispatch`）、zero-dep job 跨 Node 20/22/24 矩阵
  （开发机 24、CI 22，运行时漂移只有真跑才现形）；H22 盯住三 job 定义（零依赖裸跑不许混进
  `npm ci`、full 双平台双装浏览器、门禁 needs 双 job）。
- 加固 H22 新增 5 项（基座 89 → 93、存在性钉 2 → 3）；全量 12 套件共 **468 断言**（含存在性钉 3、部署段 26）。

### v1.3.0（2026-10-04）

- **并行安全化**：`--parallel` 从「会假失败的开关」变成「波内并发、波间串行」——
  会话名/产物名构造即唯一、生成物目录三处排除（分发/整树比对/收尾清理）、
  部署副本验证独占末波（planWaves 对真实套件清单做行为断言）、套件收尾只关自己的会话
  （close-all 会连并发兄弟会话一起杀）、verify-all 收尾统一 kill-all 收割孤儿浏览器
  （残留句柄曾让 distribute 的 rmSync 报 EPERM）；调度结构由加固 H21 机械钉住。
- **浏览器通道优先级实测钉住**：显式 `--browser` > `.playwright/cli.config.json` 的 channel >
  CLI 默认 chromium —— args-check D 节探针（配置指假通道，看失败点名谁；机器无关断言）；
  语义与修法写进 cli-mode.md（`--config` 每次调用生效、配置缺失通道报错点名不静默换、
  `PVMCP_BROWSER_CHANNEL` 只影响生成配置不参与执行）。
- **H16 升级**：五份文档版本记录**首条**都是当前版本、不写超前版本号（只查 README 不够——
  实测常态是「README 更新了、另外四份忘了」）；§15.3 核心判据数与 verify-all 的 CORE
  机械对账，改断言忘改判据行会被拦下。
- **仓库基础设施**：`.gitattributes`（LF 钉）、`.gitignore`（字节码/产物四层排除的入库层）、
  `.github/workflows/ci.yml`（三态判据全跑：zero-dep mode 1/2、full mode 3 双平台
  ubuntu+windows、发版门禁）—— H10/H14 的两条钉从「纯净包里诚实 SKIP」变为源码树常驻生效。
- 加固 H21 新增 5 项、H16 增至 7 项、args-check 增通道优先级 2 项；全量 12 套件共 **463 断言**
  （含 . 前缀钉 2、部署段 26）+ 真实浏览器矩阵（2 通过 / 6 失败 / 1 偶发 → 4 签名）。
- **CLI 通道探针实测补一处**：`--config` 对已预热 daemon 的每次调用都生效（探针最初担心
  daemon 缓存配置，实测确认不受影响，探针因此不用隔离 cwd）。

### v1.2.1（2026-10-04）

- **CLI 失败摘要诊断质量**（加固 **H20**）：daemon 起不来时（如机器无 Chrome），真实根因
  `Chromium distribution 'chrome' is not found` 写在 stderr 中段、后面跟几十行堆栈，旧摘要按
  「尾部 3 行」取值只剩 `daemonPid` —— 门禁报了失败却没报原因，派活口径失真。现在
  `extractRootCause` 优先提取 PlaywrightError 根因行，命中已知浏览器缺失模式时直接附修法
  （`setup-cli-config.mjs` 按本机生成通道 / `npx playwright install <channel>` 二选一）
- **源码树 CLI 通道配置自愈**：`.playwright/cli.config.json` 是装机基础设施（distribute 一律排除、
  install.mjs 只给部署目录生成）—— 源码树没人负责，clone 后第一次 `--with-browser` 会 5 套连锁
  以 daemonPid 失败（CLI 回退默认通道找 chrome）。现在 `verify-all --with-browser`（CLI 就位时）
  前置按同一决策源自愈（`cli-config.mjs` 矩阵，手工配置不覆盖）；`selfcheck` 新增
  「CLI 浏览器通道配置」点名（缺失/跨平台时给出 setup 命令，可选级不拦截）
- 全量 12 套件共 **454 断言** + 真实浏览器矩阵（2 通过 / 6 失败 / 1 偶发 → 4 签名）；加固 H1–H20

### v1.2.0（2026-10-03）

- **纯净发布包口径收紧**：无 `node_modules`、无任何 `.` 前缀文件/目录（剔除开发机残留），
  解压 / 拷贝即可部署；零 npm 依赖 —— 不需要 `npm install`、不需要联网、不需要生成任何依赖，
  文档全量改为零依赖「拷贝即部署」口径（可选依赖由被测项目 / 本机自己提供，不算部署步骤）
- 部署文档拆分为 [部署说明](./部署说明.md)（速查）+ [部署说明.详细版](./部署说明.详细版.md)（完整参考），
  对齐发布目录各包「版本与文档同步规范」（「版本记录」+「自然语言使用示例」两节齐全）
- 加固 **H18**：实跑 `distribute` 验纯净产物本身（无 `node_modules` / 无 `.` 前缀内容）——
  排除规则写对但没生效属静默失效，静态检查看不见
- `deployed-check` 全树哈希比对忽略 `.` 前缀机器基础设施（`.gitignore`/`.github`/`.playwright` 等）：
  纯净分发版不含它们、安装副本可能装自开发树，纳入比对只会假报漂移；`cli.config.json` 仍走平台语义校验
- 纯净包实测补三处（零依赖环境才暴露）：加固 H10/H14 对 `.` 前缀文件改存在性守卫（缺失时诚实 SKIP，
  该钉在源码树验证）；`run_verify` 守门前置（参数校验先于能力检查 —— 零依赖机器上非法 `execution`
  不再被误报成「找不到 Playwright」）；执行层套件与真实浏览器矩阵缺可选依赖时诚实 SKIP
  （纯净包口径，SKIP 计入汇总 —— 不做假绿也不做假红）
- 发布流程补强（[部署说明.详细版 §15 发布流程](./部署说明.详细版.md)）：验收一律跑在**一次性副本**上 ——
  产品「证据一律落盘」的约定会把交付树跑脏（发版实测抓到过残留），交付树纯净靠「不进去跑」保证；
  `verify-all` 新增收尾开关：全绿自动清理产物目录、失败保留现场、`--keep-artifacts` 强制保留
- 发版门禁（加固 H19）：`distribute` 收尾自动「一次性副本 verify-all --mode 2 + 终态哈希终查」——发版不可能忘
  （[部署说明.详细版 §15 发布流程](./部署说明.详细版.md)），门禁失败退出码 3（发布包不可交付）；
  `verify-all --mode 1|2|3` 一条命令复跑 §15.3 三态判据（状态不对预检拦下，不白跑不假绿）
- 全量 12 套件共 **450 断言** + 真实浏览器矩阵（2 通过 / 6 失败 / 1 偶发 → 4 签名）

### v1.1.0（2026-10-03）

- **智能体线（参照 LangChain PlayWrightBrowserToolkit 七工具语义，源码已下载核对）**：
  新增 `nl_test_goal` —— 自然语言目标 → LLM 只做规划（受限动作白名单）→ 确定性执行与断言 →
  JSON Pass/Fail 报告（`verdict` 字段可挂 CI）；新增 `explore_page` —— 死链/坏图/表单盘点巡检，
  判定全部确定性（坏图 `naturalWidth=0`、死链 HTTP ≥400、网络不可达只警告）。工具 11 → 13
- LLM 接入 `llmclient.js`：Ollama 本地默认（数据不出机）/ DeepSeek 显式 `PVMCP_LLM=deepseek` / 可关；
  key 只从 `DEEPSEEK_API_KEY` 环境变量读，全程掩码，不进参数、磁盘、日志
- 守门前置：危险目标（真实资金/破坏性数据/生产/对外发送/批量对外）与生产主机在**打开浏览器之前**硬拦截；
  测试上下文（测试/staging/演练/沙箱）豁免误伤；计划白名单外动作整份作废；无断言 = Blocked
- 降级骨架 `fallbackPlan`：LLM 不可用时确定性产出（goto + 引号断言提取 + 截图），来源标记 `fallback`
- 新增 2 套件：智能体线（LLM 真 HTTP 回环/守门/计划契约，72 断言）+ 端到端真浏览器（18 断言）；
  全量 12 套件共 444 断言 + 真实浏览器矩阵（2 通过 / 6 失败 / 1 偶发 → 4 签名）；加固新增 **H17**（智能体线守门不静默失效）
- Skill 合并：SKILL.md 智能体线工作流/硬规则 No11–12/边界，`references/nl-agent.md`（七工具映射、LLM 配置、禁令、优点）
- 文档同步：README / 使用文档 / 部署文档 / SKILL.md 均补智能体线功能、能做/禁做/优点、自然语言示例（H16 机器检查）

### v1.0.0（2026-10-03）

- 首发：MCP 验收门禁（11 工具）+ Skill + 10 套件全量回归（345 断言）+ 真实浏览器矩阵
  （2 通过 / 6 失败 / 1 偶发 → 4 个根因签名，演示缺陷归因）
- 同日发版加固：H12 噪声不挤掉失败原因 / H13 安装决策矩阵 / H14 字节码四层排除 /
  H15 路径解析禁用 URL 的 pathname（发布目录中文路径实测抓出并修复）/ H16 版本与文档同步机器钉住
- CLI 通道配置按目标平台自适应（PVMCP_BROWSER_CHANNEL 显式优先，手工配置保留，跨平台重生成）
- 纯净分发 `distribute.mjs`：77 文件逐个哈希自校验 + 排除项泄漏检查（`--no-verify` 才跳过）

### 版本与文档同步规范

**每次更新版本，必须把「版本号 + 版本说明」同步到全部对应文档，缺一处即视为发版未完成：**

| 同步到 | 放什么 |
|---|---|
| `package.json` | 版本号唯一来源（server 运行时读它，不另存副本） |
| README「版本记录」 | 完整版本说明（新增一节 `### vX.Y.Z（日期）`） |
| [使用文档](./使用文档.md)「版本记录」 | 同一版本号 + 版本说明（可精简，不得缺号） |
| [部署说明](./部署说明.md)「版本记录」 | 同上 |
| [部署说明.详细版](./部署说明.详细版.md)「版本记录」 | 同上 |
| [SKILL.md](./skill/playwright-verify/SKILL.md)「版本记录」 | 同上 |
| 发布目录 `README.md` | 发版条目（版本、纯净性、自验收实测） |

新增文档若面向使用者（README / 使用文档 / 部署说明 / SKILL 一类），同样要带「版本记录」与
「自然语言使用示例」两节。加固 **H16** 会机械检查版本号在五份文档间不漂移、两节都在位——
纪律靠人记，回归靠机器钉。
