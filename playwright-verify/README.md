# playwright-verify

> Playwright 端到端测试的「验收 / 门禁 / 执行」MCP server + Skill。
> **官方 agent 负责生成用例，这套工具负责验收** —— 什么写法一律不许合、这条用例到底证明了什么、这次失败该算谁头上。

- 🚀 **[部署说明](./部署说明.md)** —— 纯净发布包、拷贝即部署；最短上手、快速命令索引、自然语言使用示例（16 工具全覆盖）与完整部署/发布流程，全在这一份
- 🧠 **Skill 入口**：[skill/playwright-verify/SKILL.md](./skill/playwright-verify/SKILL.md)
- 本文档是唯一完整说明：30 秒上手、五条主线完整用法、16 工具速查、全部规则表、命令行/CI、常见问题、自然语言示例

---

## 30 秒上手

```powershell
# 安装（零 npm 依赖，解压/拷贝即可部署）
node skill\playwright-verify\install.mjs

# 自检
node skill\playwright-verify\scripts\selfcheck.mjs
```

不装 MCP 客户端也能用（命令行与 MCP 跑同一份判定逻辑）：

```bash
S=skill/playwright-verify/scripts
node $S/check_config.mjs playwright.config.ts           # ① 配置可信吗？
node $S/lint_spec.mjs tests/                          # ② 这批用例能合入吗？
node $S/summarize_report.mjs test-results/report.json   # ③ 跑完回归，失败该谁修？
```

---

## 它解决什么问题

**问题一：规则写在文档里，但文档不会拦住任何人。**
能改变行为的是「判据 + 反例 + 检查点」，所以本工具把 20 条硬规则做成了**确定性扫描**，ERROR 以退出码 1 阻断合入。

**问题二：逐条读错误栈，6 条失败要二十分钟，还容易把 3 条同源失败当成 3 个 bug 派给 3 个人。**
归因不是模型现场判断，而是一条可复现的规则：同一条错误签名出现多少次、属于哪一类、下一步该谁做什么，全部由脚本给出。

**问题三：把完整页面状态反复灌进模型，会烧掉大量 Token。**
所以执行层坚持**产出落盘**（快照 YAML/Markdown、截图 PNG、Trace 独立文件），Agent 按需去读。同样流程省下四倍多。

**问题四：脚本还没跑通就提交，是这条流程里最容易踩的坑。**
所以生成脚本自带**生成门禁**：语法检查 + lint ERROR 必须为 0 才允许写盘。

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
- **`timeout` 过长**（> 60 秒）—— 任何失败都会以「超时」的样子出现。

**第 2 步：用例扫描**

```
lint_spec { target: "tests/" }
```

三份样例集的验收标准：

| 样例 | 期望 | 含义 |
|---|---|---|
| `demo/tests/clean.spec.ts` | ERROR 0 / WARN 0 | **合格写法不报** |
| `demo/tests/messy.spec.ts` | ERROR 6 / WARN 11 | **坏味道全中** |
| `demo/tests/tricky.spec.ts` | ERROR 0 / WARN 0 | **误报陷阱不误报** |

**两个实现细节值得知道**：

1. **脱敏必须等长。** 检测在脱敏文本上跑、证据回原文取，靠的是「每个被屏蔽字符都换成等长空格」这条不变量。
2. **两道工序，不是一道。** 只去注释保留字符串 → 给选择器类规则用；再去字符串 → 给「有没有断言、有没有 await」类规则用。

### 归因线：这次失败该谁修

先确保配置里有 json reporter：

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

输出形态：

```
结果: 通过 2 / 失败 6 / 偶发 1 / 跳过 0，共 9 条，耗时 25.3s

按签名聚类：4 个根因

[3 次 · assertion] regression.spec.ts :: expect(locator).toHaveText(expected) failed
    归因: 待定（产品回归 / 断言写错）　派给: 产品 或 断言
    下一步: 打开 trace 看页面实际状态。必须人判，不允许自动放宽断言。

[1 次 · locator-strict] … strict mode violation: getByText('…') resolved to 3 elements
[1 次 · timeout] TimeoutError: locator.click: Timeout 3000ms exceeded.
[1 次 · env] page.goto: net::ERR_CONNECTION_REFUSED at <url>
```

**几个关键口径：**

- **偶发不吃进失败聚类。** 一条「偶发」用例会产生 1 次 failed 重试 + 1 次 passed；若混进聚类，虚增根因数、派活失真。
- **判定顺序从最具体到最泛**：`env` → `locator-strict` → `assertion` → `timeout` → `locator-not-found`。

### 执行线：长流程回归怎么跑不烧上下文

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
cli_session { subcommand: "click", args: ["e12"], session: "explore" }
cli_session { subcommand: "screenshot", session: "explore" }
cli_session { subcommand: "close", session: "explore" }
```

**证据目录约定：**

```
.playwright-artifacts/
├── snapshots/      快照（markdown，按需读）
├── screenshots/    截图（png，回译时要附给同事）
├── traces/         trace（失败现场）
├── logs/           执行日志
├── reports/        机器可读报告（json）
├── collect/        翻页采集产物（rows.json / CSV / 两期 diff.md）
└── state/          登录态（按账号命名）
```

**分页表格采集（`collect_table`，确定性、不用 LLM）**

档案类页面要整表落档时用它：自动翻页、空页/无新行/页数上限三选止损、首见胜出归并；`rows.json` + UTF-8 BOM CSV 落盘，可指定 `diffAgainst` 做两期对比。长采集中断可断点续采。

### 生成线：PO 分层脚本与 Excel 编排

**不让模型自由写脚本，只让它填空。**

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

**生成门禁**：语法检查 + lint ERROR 0，两者都过才允许写盘。

**Excel 手工用例 → 可执行回归：**

```
orchestrate_excel { input: "cases/regression.xlsx", readOnly: true }   # 先看映射情况
orchestrate_excel { input: "cases/regression.xlsx", write: true }      # 生成脚本
orchestrate_excel { input: "cases/regression.xlsx", run: true }        # 生成并执行
```

**最重要的一条**：**映射不了的步骤不会静默失败，而是原样报在 `unmapped` 里**——宁可不做，也不能猜错。

### 智能体线：说目标不说步骤

```
nl_test_goal {
  goal: "登录后把商品加入购物车，购物车里应看到 \"ITEM-A\"",
  url: "https://app.test.example.com",
  cwd: "D:/work/my-project"
}
```

链路：守门（危险目标/生产地址，**开浏览器前**）→ LLM 产出受限计划（动作白名单：goto/click/fill/press/expect_text/expect_visible/screenshot）→ 真浏览器执行 → 确定性断言 → 报告 JSON 落盘（`.playwright-artifacts/reports/nl-*.json`，`verdict` 字段 Pass/Fail/Blocked 可直接挂 CI 门禁）。

- LLM 不可用？确定性降级骨架 `fallbackPlan`
- 没有任何 expect_* 断言 → `Blocked`：「全绿但什么都没验」不算通过
- 巡检页面用 `explore_page`：死链（HTTP ≥400 → Fail）、坏图（`naturalWidth=0`）、表单盘点（formsHash 指纹），**不用 LLM**

---

## 快速命令索引（速查）

```powershell
# 安装
node skill\playwright-verify\install.mjs

# 自检
node skill\playwright-verify\scripts\selfcheck.mjs

# 三条门禁命令
node skill\playwright-verify\scripts\check_config.mjs playwright.config.ts
node skill\playwright-verify\scripts\lint_spec.mjs tests/
node skill\playwright-verify\scripts\summarize_report.mjs test-results/report.json

# 观测日志
node skill\playwright-verify\scripts\log_summary.mjs $env:PVMCP_LOG

# 全量回归
node mcp\test\verify-all.mjs --with-browser

# 卸载
node skill\playwright-verify\install.mjs --uninstall
```

---

## 16 个 MCP 工具

| 工具 | 什么时候用 | isError 语义 |
|---|---|---|
| `check_config` | 配置基线体检（CFG001–CFG012） | 有 ERROR → isError，exitCode 1 |
| `lint_spec` | 合入前扫用例（20 条规则） | 有 ERROR → isError，exitCode 1 |
| `summarize_report` | 回归跑完做失败归因 | 无失败 → 正常；报告不存在 → isError |
| `run_verify` | 执行 Playwright 测试 | 用例失败 → isError，exitCode 1 |
| `setup-browser-config` | 生成适配当前平台的浏览器通道配置（删了 ms-playwright 后重初始化 / 切通道） | 配置生成失败 → isError，`SETUP_FAILED` |
| `cli_health` | 首次接入 CLI 时验收最小闭环 | 任一步失败 → isError |
| `cli_session` | 探索页面、驱动浏览器 | 命令失败 → isError |
| `cli_batch` | 多步 CLI 命令串联（跨步状态累积） | 任一步失败 → isError，`CLI_BATCH_FAIL` |
| `generate_scripts` | 生成 PO 分层脚本 | 门禁不过 → isError |
| `check_standards` | 校验团队 AGENTS.md 测试规范 | 规范缺失不阻断 |
| `orchestrate_excel` | Excel 手工用例变可执行回归 | 编排失败 → isError |
| `explain_rules` | 规则表自省 | 只读 |
| `selfcheck` | 服务级自检 | 必需项失败 → isError |
| `explore_page` | 页面探索巡检：死链/坏图/表单盘点 | 判定有 Fail → isError |
| `nl_test_goal` | 智能体线：自然语言目标 → 判定 | verdict ≠ Pass → isError |
| `collect_table` | 分页表格采集与两期对比 | 零行采集 → isError |

---

## 自然语言使用示例

部署完成后对 AI 助手（DSH / Claude Code / Cursor）直接说人话即可，不需要记命令。

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| **门禁线** | | |
| 「帮我检查一下 playwright.config.ts 可不可信」 | `check_config` | CFG001–CFG012 逐条体检结论，ERROR → 退出码 1 阻断 |
| 「tests/ 目录过一遍规则，能不能合入」 | `lint_spec` | ERROR/WARN 计数 + 回原文的证据行，ERROR=0 才放行 |
| **归因线** | | |
| 「CI 上 6 条失败，帮我看看该谁修」 | `summarize_report` | 根因签名聚类 + 五类归因 + 派活口径（趋势传 `files`） |
| **执行线** | | |
| 「跑一下回归」 | `run_verify` | 落盘式执行结果，日志/截图/trace 进 `.playwright-artifacts/` |
| 「浏览器执行层现在能用吗？验一下」 | `cli_health` | 开页面/快照/截图三步验收结论，失败给人话修法 |
| 「打开测试站首页截个图」 | `cli_session` | 快照/截图/trace 落盘，只回路径与摘要 |
| 「把这个列表页整表采下来存档」 | `collect_table` | 自动翻页采集的 `rows.json` + CSV，可两期对比/断点续采 |
| 「把这串操作按顺序跑一遍：开页面、截图、关掉」 | `cli_batch` | 多步顺序执行 + 跨步状态累积 + 汇总报告 |
| **生成线** | | |
| 「按页面对象模式生成登录+下单的脚本」 | `generate_scripts` | 过生成门禁的 PO 分层脚本（语法 + lint ERROR 0 才写盘） |
| 「把 cases/regression.xlsx 这批手工用例跑起来」 | `orchestrate_excel` | Excel → 步骤映射（映射不了的报 `unmapped` 不猜）→ 可执行回归 |
| **智能体线** | | |
| 「按这个目标验一遍：登录后把商品加入购物车，购物车里应看到 ITEM-A」 | `nl_test_goal` | 守门 → 受限计划 → 真执行真断言 → JSON `verdict` 落盘 |
| 「巡检一下这个页面有没有死链坏图」 | `explore_page` | 死链/坏图/表单盘点清单 + Pass/Fail（确定性判定） |
| **配置体检与自检类** | | |
| 「环境自检一下，执行类工具能用吗」 | `selfcheck` | 必需项/可选项逐项自检报告，缺什么说明白 |
| 「我们的 AGENTS.md 测试规范写得全不全」 | `check_standards` | 四条团队规范逐条对账，缺失列出不阻断 |
| 「PW006 为什么报？怎么关掉某条规则？」 | `explain_rules` | 规则 id/级别/判据/修法逐条解释（只读） |

> 每条话术的展开说明与红线、完整场景速查、三段完整对话示例、16/16 覆盖清单，见 [部署说明.md「完整自然语言使用示例（16 工具全覆盖）」](./部署说明.md#完整自然语言使用示例16-工具全覆盖)。

### 对话示例（简短示范）

```
你：帮我看看这批用例能不能合入
AI：配置体检 12 项全过；tests/ 42 个文件 → ERROR 0 / WARN 3。
    结论：可以合入（ERROR=0）。3 处 WARN 建议换成 waitForResponse，要我列出改法吗？
```

---

## 20 条 lint 规则表

### 核心 14 条

| id | 级别 | 规则 | 修法要点 |
|---|---|---|---|
| PW001 | ERROR | 固定时长等待 | 等状态 / 等网络 / 等轮询 |
| PW002 | ERROR | `.only` 泄漏 | 删掉 + `forbidOnly: !!process.env.CI` 双保险 |
| PW003 | ERROR | 绝对 XPath | 改用 role / label / testid |
| PW004 | ERROR | `nth-child` / `nth-of-type` | 按第几个子元素定位 = 把 DOM 焊死在用例里 |
| PW005 | ERROR | `force: true` | 先查为什么不可点 |
| PW006 | ERROR | 断言没 `await`（假通过） | **只对异步来源参数报** |
| PW007 | ERROR | 用例内没有任何断言 | 容器块已排除 |
| PW008 | ERROR | 断言降级成 JS 判断 | `if (!await x.isVisible())` → `expect(x).toBeVisible()` |
| PW009 | WARN | 只用 `toHaveCount` 判存在 | 数量断言不校验内容与可见性 |
| PW010 | WARN | CSS 类名 / 结构选择器 | 类名由样式决定，改版即失效 |
| PW011 | WARN | `.first()`/`.last()`/`.nth()` | 位置收敛说明定位器本身不唯一 |
| PW012 | WARN | `networkidle` | 长轮询/心跳/埋点页面上永远等不到 |
| PW013 | WARN | 超时放宽过百秒 | 判据是**求值** > 100000 ms |
| PW014 | WARN | `:visible` 旧写法 | 1.63 起用 `locator.visible()` |

### 补充 6 条

| id | 级别 | 规则 |
|---|---|---|
| PW101 | ERROR | 疑似凭据写死在用例里 |
| PW102 | ERROR | 遗留调试代码（`debugger` / `page.pause()`） |
| PW103 | WARN | 静默的 `test.skip` / `test.fixme` |
| PW104 | WARN | `test.slow()` 放宽超时 |
| PW106 | WARN | 空等待（`waitForSelector()` 无参） |
| PW107 | WARN | 用例内直接访问生产域名 |

> **注**：`PW105` 不存在。任何文档引用 PW105 都是错的。

---

## 12 条配置体检规则表

| id | 级别 | 检查项 | 为什么 |
|---|---|---|---|
| CFG001 | ERROR | `forbidOnly` | 没有它，`.only` 能带着一条用例进 CI 却报绿 |
| CFG002 | ERROR | `timeout` ≤ 60s | 超时一长，所有失败都以「超时」出现 |
| CFG003 | ERROR | `trace` 已开启 | 没有它，失败现场只有一行报错 |
| CFG004 | ERROR | 有 json reporter | 没有它，失败聚类与派活无法自动化 |
| CFG005 | WARN | `retries` 合理（1–3） | 重试过多会把真坏的用例放过 |
| CFG006 | WARN | `workers` 有上限 | 资源争抢会制造与代码无关的失败 |
| CFG007 | WARN | 失败时有 screenshot / video | 回译要附截图才有说服力 |
| CFG008 | ERROR | `actionTimeout` < `timeout` | 否则操作级超时永远不先触发 |
| CFG009 | WARN | `expect.timeout` 不过长 | 容易被误归因成「操作超时」 |
| CFG010 | INFO | `baseURL` 已设置 | 切环境不用改用例 |
| CFG011 | INFO | `testDir` 已限定 | 否则可能跑到不该跑的文件 |
| CFG012 | INFO | 有环境开关（生产保护） | 把可跑环境锁在 test / staging |

---

## 失败归因的五个类别

| 类别 | 中文 | 性质 | 派给谁 | 下一步 |
|---|---|---|---|---|
| `locator-strict` | 定位器命中多个元素 | 用例缺陷 | 测试侧 | 收紧定位器到唯一命中 |
| `assertion` | 断言未成立 | **待定** | 产品 **或** 断言 | 打开 trace 看页面实际状态。必须人判 |
| `locator-not-found` | 定位器找不到元素 | 用例缺陷 | 测试侧 | 对照 snapshot 查元素是否改名 |
| `timeout` | 操作等待超时 | 待定 | 待定 | **先查定位器还能不能命中** |
| `env` | 环境不可达 | 环境问题 | 环境 | 先确认环境再谈用例 |

**派活口径**：一个签名 = 一份工作量，而不是「一条失败 = 一个人」。

---

## 命令行用法

Skill 的 `scripts/` 与 MCP 工具跑的是**同一份判定逻辑**，所以两边结论必然一致。

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

# 失败归因
node $S/summarize_report.mjs test-results/report.json
node $S/summarize_report.mjs test-results/report.json --fail-on-failures

# 执行回归
node $S/run_verify.mjs --cwd . --dry-run
node $S/run_verify.mjs --cwd . --config playwright.config.ts
node $S/run_verify.mjs --cwd . --grep "下单" --retries 2

# 团队规范
node $S/check_standards.mjs
node $S/check_standards.mjs --template

# 自检
node $S/selfcheck.mjs
```

**退出码约定**：`0` 通过 / `1` 门禁阻断 / `2` 用法或环境错误。

---

## 落到 CI 里

```bash
# 跑之前：配置基线是否可信（放最前面）
node skill/playwright-verify/scripts/check_config.mjs playwright.config.ts

# 合入前：用例静态扫描，ERROR 必须为 0
node skill/playwright-verify/scripts/lint_spec.mjs tests/

# 跑之后：失败归因与派活
node skill/playwright-verify/scripts/summarize_report.mjs test-results/report.json
```

对应 GitHub Actions 片段：

```yaml
- name: 配置体检
  run: node skill/playwright-verify/scripts/check_config.mjs playwright.config.ts

- name: 用例静态门禁
  run: node skill/playwright-verify/scripts/lint_spec.mjs tests/

- name: 回归
  run: node skill/playwright-verify/scripts/run_verify.mjs --cwd . --config playwright.config.ts
  continue-on-error: true

- name: 失败归因
  if: always()
  run: node skill/playwright-verify/scripts/summarize_report.mjs test-results/report.json
```

---

## 常见问题

**Q：`lint_spec` 报了 ERROR 但我觉得是误报，怎么办？**
先看证据行 —— 检测在脱敏文本上跑、证据回原文取。如果确认规则不适用于你的项目，用 `--disable PW0xx` 关掉。
**但不要因为「改起来麻烦」而关规则。**

**Q：为什么 `expect(amount).toBe('¥99.00')` 没被 PW006 报？**
因为它是**同步值断言**，不需要 await。PW006 只对参数是异步来源的断言报错。

**Q：断言写在页面对象方法里，PW007 会报吗？**
不会报 ERROR。工具会跨文件解析页面对象方法，识别出「断言在页面层」这种 PO 分层的正常形态，降级为 WARN 请你人工确认。

**Q：`cli_health` 失败，说缺浏览器？**
报错会直接翻译成人话并给两条修法：装 chromium，或改用本机已有的浏览器通道。

**Q：`run_verify` 说找不到 Playwright？**
它找的是**目标项目**里的 Playwright（`node_modules/@playwright/test/cli.js`），不是本工具自己的。

**Q：`summarize_report` 说报告不存在？**
确认 `playwright.config` 里有 json reporter（`CFG004`），并且用例确实跑过。

**Q：`generate_scripts` 拒绝写盘？**
看 `lint.files[].findings` —— 生成门禁要求语法检查通过 + lint ERROR 为 0。

**Q：工具报「未解析的占位符」？**
你把 `${PW}` / `{{password}}` 当值传进来了。生成器不会猜你的意图：请填真实值，或改用环境变量读取。

---

## 能做 / 禁止做 / 优点

**能做什么**

- 合入门禁：配置体检（CFG001–CFG012）+ 用例静态扫描（20 条规则），ERROR 阻断合入
- 失败归因：N 条失败聚成 M 个根因签名，给出派活口径
- 落盘执行：长回归不烧上下文，截图/trace/日志现场留在 `.playwright-artifacts/`
- 生成与编排：PO 分层脚本（过生成门禁才写盘）、Excel 手工用例 → 可执行回归
- **自然语言声明式测试**：说目标不说步骤（`nl_test_goal`）——LLM 把目标翻译成受限计划，真浏览器执行、真断言判定，输出 JSON `verdict`
- **页面探索巡检**（`explore_page`）：死链/坏图/表单盘点，全部确定性判定
- 环境自检、CLI 会话操作、规则表自省、团队规范校验

**禁止做什么**

- 不自动改断言：断言是验收契约，改断言必须人来判
- 凭据只从环境变量读（`accounts.json` / `.env` 绝不入库、不进日志）
- 默认只允许 test / staging；生产地址要独立审批
- 不碰真实资金与生产数据：转账、支付、删库、生产变更在**打开浏览器之前**就硬拒绝
- LLM 只做规划，不做判定
- 不把页面内容送出机

**优点**

- **判定权不在模型手里**：「通过/不通过」永远由确定性断言链给出
- **零运行时依赖**：手写 stdio JSON-RPC + Node 内置 fetch
- **证据可复核**：每步截图、计划快照、报告 JSON 落盘
- **守门前置**：危险目标与越权地址在开浏览器前拦截

---

## 设计取舍

| 决定 | 理由 |
|---|---|
| **MCP 零依赖** | 手写 stdio JSON-RPC 循环，不装 MCP SDK |
| **产物命名必须唯一** | 并发调用不会算出同一个名字 |
| **子进程输出重定向到文件** | 沙箱下管道捕获不可用；长回归日志不进内存 |
| **产出必须落盘** | 完整页面状态反复灌进模型会烧 Token |
| **脱敏必须等长** | 脱敏改变长度 → 行号对得上、证据取到别人身上 |
| **偶发不吃进失败聚类** | 否则同一条用例同时出现在 clusters 与 flakes |
| **ERROR 必须阻断** | 只有 WARN 的检查等于没有检查 |
| **宁漏不误报** | 门禁的公信力是它唯一的资产 |

---

## 测试套件与断言数

断言数的**唯一真相源是 `mcp/test/suites.mjs` 的声明字段**；本表、《部署说明》§15.3 判据行、
verify-all 判据与 CI 三 job 定义全部机械对账（加固 H16/H22）。合法断言变更的顺序：
改 `mcp/test/suites.mjs` 声明 → 同步本表与《部署说明》§15.3 判据行 → 复跑
`node mcp/test/verify-all.mjs --mode 1|2|3`（判据行自动比对）—— 顺序错了会被门禁拦下。

| 套件 | 验证什么 | 断言数 |
|---|---|---|
| 扫描器（三份样例集） | clean 不冤枉 / messy 全中 / tricky 不误报、结构边界、对抗语料与属性化语料（真 lint 跑） | 53 |
| 归因（缺陷 4 回归） | ANSI 清洗幂等、断言不误归超时、6 条压 4 签名、输入校验不静默全零、多报告趋势与有界渲染 | 42 |
| 生成器 | 生成门禁、PO 分层、方法名、占位符、脆弱选择器 | 27 |
| MCP 协议与工具面 | 握手与版本协商、16 工具、annotations 副作用声明、观测日志脱敏聚合、错误码语义、stdin EOF 排空、日志轮转、计划缓存观测 | 116 |
| 规则表一致性 | 规则 id 唯一、文档与规则表不漂移、属性化语料覆盖门 | 37 |
| 加固（静默失效/反转/覆盖/篡改） | 静默失效对抗语料（含 . 前缀存在性钉 3） | 97 |
| CLI 真实交互与落盘 | Ref 交互、fill/click 生效、产物落盘、PNG 魔数、白名单 | 21 |
| Excel 编排端到端 | 读表 → 映射 → 生成门禁 → 落盘 → 真跑通过 | 20 |
| 参数规范化与产物命名 | 布尔不静默反转、非法值报错、整数参数不静默取整、并发产物不互相覆盖、浏览器通道优先级 | 46 |
| 智能体线（LLM 回环/守门/计划契约/自愈采集纯函数） | stub LLM 真 HTTP 回环、危险目标拒绝、白名单不静默丢弃、自愈语义与预算闸、断点续采、探活预算、计划缓存、表单指纹、步骤参数映射、执行语义收敛、通道环境适配 | 145 |
| 智能体线端到端（真浏览器） | LLM 规划→真执行真断言、降级骨架、Fail 语义、巡检、表单指纹两期对比真跑 | 21 |
| 全流程验证（工具链串联+自然语言真跑） | 门禁→执行→归因→生成→智能体线整链真跑 | 44 |
| 部署副本验证（须最后跑） | 装完的副本能发现工具、真能调用、与源码逐文件一致（serial 末波） | 26 |
| 真实浏览器回归矩阵 | 2 通过 / 6 失败 / 1 偶发 → 聚成 4 个根因签名（形态验收，`--with-browser` 真跑） | 矩阵 4 签名 |

---

## 目录

```
playwright-verify/
├── mcp/                        MCP server（零运行时依赖）
│   ├── server.mjs              协议循环 + 16 个工具
│   ├── lib/                    核心逻辑（唯一判定真相源）
│   ├── py/read_cases.py        Excel 读取（openpyxl 可选）
│   └── test/                   13 套回归 + 一键入口 verify-all
├── skill/playwright-verify/    Skill
│   ├── SKILL.md                入口
│   ├── references/             12 篇知识层
│   ├── scripts/                8 个命令行包装
│   └── install.mjs             安装器
├── demo/                       样例集与可离线复现的演示
│   ├── tests/                  clean / messy / tricky
│   ├── configs/                baseline / legacy
│   ├── cases/                  Excel 编排样例
│   └── site/                   演练页
├── README.md                   本文档（唯一完整说明）
└── 部署说明.md                 部署完整参考（最短上手 + 完整部署 + 发布流程）
```

---

## 边界

- **不生成用例。** 官方 planner / generator / healer 做得更好，本工具不碰。
- **不替代测试分析。** 它只验证你描述的场景，覆盖该不该有、断言对不对，还是人的事。
- **不自动改断言。** healer 可以提议修，但「把断言放宽到能过」和「修好定位器」必须人来判。
- **不碰真实资金与生产数据。** 危险目标在打开浏览器之前就拒绝。
- **LLM 只做规划，不做判定。** 「通过/不通过」永远由确定性断言链给出。
- **不把页面内容送出机。** LLM 默认本地 Ollama；截图与页面快照永不进 LLM 请求。
- **不适用于**单元测试、纯接口契约测试、需要真机的移动端原生测试。

---

## 附：知识层文档索引

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
| `nl-agent.md` | 智能体线怎么用？LLM 怎么配？禁止做什么？ |
| `team-standards.md` | 团队规范怎么写进 AGENTS.md？ |

---

## 版本与文档同步规范

版本号唯一源是根 `package.json`（`server.mjs` 运行时读它，不另存副本）。每次版本更新须同步
**三份文档**的版本号与版本说明：README（本文）「版本记录」、[部署说明.md](./部署说明.md)「版本记录」、
[SKILL.md](./skill/playwright-verify/SKILL.md)「版本记录」——每份的版本记录首条必须是当前版本、
不写超前版本号，**缺一处即视为发版未完成**。

- 版本号 / 版本记录 / 「自然语言使用示例」/ 《部署说明》§15.3 核心判据数：加固 H16 机械对账；
- 断言数（README 套件表、§15.3 判据行、verify-all 判据、CI 三 job 定义）：加固 H22 对
  `mcp/test/suites.mjs` 声明逐套对账；
- 发版门禁（`distribute` 收尾一次性副本验收 + 终态哈希终查）：加固 H19 钉住。

---

## 版本记录

### v1.8.17（2026-10-06）

- **setup-browser-config 同步链补齐**：第 16 个工具 `setup-browser-config`（运行 setup-cli-config.mjs，
  按平台生成 `.playwright/cli.config.json` 浏览器通道配置；Windows 默认 msedge，`PVMCP_BROWSER_CHANNEL`
  可显式指定通道）入表时没走同步链（工具数钉停在 15、EXPECTED 清单漏项、文档工具表漏行）—— 本轮补齐：
  deployed-check / nl-agent-check 工具数钉 15 → 16 且 EXPECTED 补 `setup-browser-config`，
  README/部署说明/SKILL 工具表与覆盖清单全部 16/16。断言数不变（只改既有断言的期望值与文档计数）。

### v1.8.16（2026-10-05）

- **cli_batch 同步链补齐**：第 15 个工具 `cli_batch` 入表时没走同步链（工具数钉停在 14、
  EXPECTED 清单漏项、文档工具表漏行）—— 本轮补齐：deployed-check / nl-agent-check 工具数钉
  14 → 15 且 EXPECTED 补 `cli_batch`，README/部署说明/install 文案与工具覆盖清单全部 15/15。
- **r23–r32 修复收拢**（此前版本记录漏记）：`generate_scripts` goto 去重、同名页面 name 直接
  报错；`check_config` CFG001/CFG007 基线修复；claims 长文换行；`lint_spec` 增 `severity`
  过滤（CI 用 ERROR 口径、评审用 WARN）；`summarize_report` trace 提取修 `on-first-retry`
  取空（扫全部失败结果）+ 短链保留文件名；`run_verify` 附 `reportFile` 直接衔接
  `summarize_report`（钉值修正不动断言数）。
- **nl_test_goal click 参数映射修复（真浏览器矩阵抓到）**：`click` 的 CLI 第二位置参数是
  鼠标键（left|right|middle），cliBatch 路径却把 `step.value` 当 button 传出去 —— 带 value
  的 click 步每次必炸在 button 参数上；runStep 与 cliBatch 两份映射收敛为单一源
  `stepCliArgs`（click 只传 target、fill 双参、press 按键取 value、未知动作空数组）。
- **executePlan cliBatch 语义收敛（同族第二处，真矩阵暴露）**：结果不带 `act` →
  `verdictOf` 找不到断言步、全链误判 Blocked；expect_* 只看 snapshot 命令成败、
  不看快照内容 → 断言永远「成立」。结果形状（act/target/value）与断言判定
  （`judgeExpectation` 单一源、失败文案钉「断言不成立，不放宽」）与 runStep 完全同源。
  另加浏览器通道环境适配 `PVMCP_CLI_BROWSER`（部分机器 Defender 拦 ms-playwright 缓存
  新下载的 chromium 二进制，设 msedge 即走系统自带通道；仅会话创建点 open 注入，
  环境不设零变化）。nl-agent-check 133 → 145（映射 +5、语义收敛 +5、通道 +2）；
  全量 13 套件 686 → 698 断言。

### v1.8.15（2026-10-05）

- **log_summary 按工具块（权重序 + maxMs 透出）**：多行块、按调用量降序、透出 maxMs 与
  cache 命中率。protocol-check 115 → 116；全量 13 套件 686 断言。

### v1.8.14（2026-10-05）

- **安装器镜像式复制**：默认安装先清后拷（源码删过的文件不留旧账），`--force` = 整目录重置。
  H23 沙箱真装三钉；hardened-check 94 → 97；全量 13 套件 685 断言。

### v1.8.13（2026-10-05）

- **对抗语料属性化生成**：每条 lint 规则自带 bad/good 样例（真 lint 跑 40 案）；
  lint-check 32 → 53、rules-check 35 → 37；全量 13 套件 682 断言。

### v1.8.12（2026-10-05）

- **explore_page 表单指纹与两期对比**：facts 补采 `required`；`formsHash`/逐表单 `hash` 指纹；
  `diffAgainst` 两期对比（字段增删/必填位变化/表单增删，不改 verdict）。nl-agent-check 127 → 133，
  nl-agent-e2e 18 → 21；全量 13 套件 659 断言。

### v1.8.11（2026-10-05）

- **趋势 structuredContent 瘦身**：全量趋势 JSON 落盘 `trend-*.json`；structuredContent 有界化
  （四列表各截 50 行 + 诚实计数）；130 签名实测 50.9KB → 21.7KB。signature-check 37 → 42；
  全量 13 套件 650 断言。

### v1.8.10（2026-10-05）

- **计划缓存命中率观测**：`PVMCP_LOG` 的 nl_test_goal 行扩 `cache=hit|miss|skip` 字段，
  `log_summary` 按工具透出三态分布与命中率。protocol-check 109 → 115；全量 13 套件 644 断言。

### v1.8.9（2026-10-05）

- **趋势 md 行截断**：多报告趋势四个渲染列表按权重序各截前 50 行 + 诚实计数；
  结构化数据保全量。signature-check 31 → 37；全量 13 套件 635 断言。

### v1.8.8（2026-10-05）

- **`nl_test_goal` 计划缓存**：同指纹复用 LLM 规划、绝不复用执行；TTL 5 分钟 / 容量 8；
  报告增量字段 `planCache`。nl-agent-check 118 → 125；全量 13 套件 628 断言。

### v1.8.7（2026-10-05）

- **`summarize_report` 多报告趋势**：传 `files` 出通过率曲线 + 签名漂移三分法；
  趋势表落盘 md 只回摘要。signature-check 27 → 31；全量 13 套件 614 断言。

### v1.8.6（2026-10-05）

- **同类参数整数化清扫**：keyIndex/maxPages 非整数参数层报错（keyIndex=1.5 曾静默零行）；
  `collect_table` 报告补 `pagesTotal`。nl-agent-check 111 → 115；全量 13 套件 607 断言。

### v1.8.5（2026-10-05）

- **`explore_page` 探活预算**：双层预算兜住慢死主机（单条 5s + 整段 20s）；
  耗尽后剩余链接记 partial。nl-agent-check 105 → 111；全量 13 套件 601 断言。

### v1.8.4（2026-10-05）

- **观测日志容量上限与轮转**（`PVMCP_LOG_MAX_MB`，默认 2MB、0=关闭）。protocol-check 102 → 109；
  全量 13 套件 595 断言。

### v1.8.3（2026-10-05）

- **整数参数严格校验**：keyIndex/maxPages 非整数参数层报「应为整数」（TOOL_EXCEPTION）。
  args-check 42 → 46；全量 13 套件 588 断言。

### v1.8.2（2026-10-05）

- **`collect_table` 断点续采**：带上次 rows.json 从断点页续扫，基准指纹不符拒绝续采。
  nl-agent-check 94 → 103；全量 13 套件 582 断言。

### v1.8.1（2026-10-05）

- **自愈 LLM 调用预算硬化**：二级自愈加整次运行总闸 `healLlmBudget`（默认 2、硬上限 10）。
  nl-agent-check 85 → 94；全量 13 套件 568 断言。

### v1.8.0（2026-10-04）

- **两层定位自愈**：快照按名 + LLM 挑清单内 ref，断言绝不自愈；新增第 14 个工具 `collect_table`。
  智能体线套 72 → 85；全量 13 套件 559 断言。

### v1.7.3（2026-10-04）

- **对抗语料轮**：修掉 7 个规则洞（PW002 链式 .only / PW008 链式接收者 / PW013 调用形态等）。
  扫描器套 14 → 32；全量 12 套件 518 断言。

### v1.7.2（2026-10-04）

- 修复 `summarize_report` 静默全零假绿 —— 不可解析输入明确 `isError + REPORT_ERROR`。
  归因套 23 → 27；全量 12 套件 500 断言。

### v1.7.1（2026-10-04）

- 修复 stdin EOF 静默丢调用（close 先排空队列再退出）；修复版本漂移；错误码语义化。
  MCP 协议套 95 → 99；全量 12 套件 494 断言。

### v1.7.0（2026-10-04）

- 新增 `log_summary` 命令（`PVMCP_LOG` 日志 → 调用量/成功率/延迟分布一页摘要）。
  protocol-check 新增 8 项；全量 12 套件 490 断言。

### v1.6.0（2026-10-04）

- **观测日志结构化**（`PVMCP_LOG` 每请求一行 `name/ms/outcome/code`）。protocol-check 新增 7 项；
  全量 12 套件 481 断言。

### v1.5.0（2026-10-04）

- **MCP 工具面补 `annotations` 副作用声明**（readOnly/destructive/idempotent/openWorld 四类 hint）。
  全量 12 套件 474 断言。

### v1.4.0（2026-10-04）

- **断言数单一源**（`mcp/test/suites.mjs`），verify-all 逐套对账。全量 12 套件 468 断言。

### v1.3.0（2026-10-04）

- **并行安全化**（`--parallel` 波内并发、波间串行）。全量 12 套件 463 断言。

### v1.2.1（2026-10-04）

- **CLI 失败摘要诊断质量**（根因行优先于堆栈噪声）。全量 12 套件 454 断言。

### v1.2.0（2026-10-03）

- **纯净发布包口径收紧**（无 `node_modules`、无 `.` 前缀文件，解压/拷贝即可部署）。
  部署说明拆分为速查版 + 详细版。全量 12 套件 450 断言。

### v1.1.0（2026-10-03）

- **智能体线**（`nl_test_goal` + `explore_page`，工具 11 → 13）、守门前置、LLM 环境变量。
  全量 12 套件 444 断言。

### v1.0.0（2026-10-03）

- 首发：MCP 验收门禁（11 工具）+ Skill + 10 套件全量回归（345 断言）+ 真实浏览器矩阵。
