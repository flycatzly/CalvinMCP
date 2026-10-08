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
| 扫描器（三份样例集） | clean 不冤枉 / messy 全中 / tricky 不误报、结构边界、对抗语料（含 r47 修饰断言形态 expect.soft/expect.poll 正反面）与属性化语料（真 lint 跑） | 58 |
| 归因（缺陷 4 回归） | ANSI 清洗幂等、断言不误归超时、6 条压 4 签名、输入校验不静默全零、多报告趋势与有界渲染 | 42 |
| 生成器 | 生成门禁、PO 分层、方法名、占位符、脆弱选择器 | 27 |
| MCP 协议与工具面 | 握手与版本协商、16 工具、annotations 副作用声明、观测日志脱敏聚合、错误码语义、stdin EOF 排空、日志轮转、计划缓存观测 | 116 |
| 浏览器插件本地桥（通道/守门/脱敏） | /rpc 打穿 handleMessage（错误码/通知/批量）、守门（Host/Origin/口令/413）、串行队列、脱敏哨兵、manifest 与面板契约、结构化结果视图模型（kv/表格/深度帽/XSS 面）、面板双模行为面（键统一+迁移/clientInfo manifest 版本/独立模式零 fetch）、历史区富渲染（pvFactsLine 双面同口径/预览行为/保真/空态）、连接失败可执行指引+安装插件引导 | 56 |
| 猫耳悬浮球（录制/回放/中转） | 定位器优先级/敏感双防线/归一/回放查询、Shadow DOM 注入/拖拽/录制/保存/回放守门、SW 中转口令只经请求头、manifest 契约、keydown 录 press、同值无损归一、verdict 徽标、录制管理（多条列表/选中/删除/容量帽/旧槽迁移）、富渲染（pvFactsLine 关键事实一行化）、行内重命名、导出录制 JSON（文件名清洗/载荷 write:false/下载链行为）、插拔式双模（独立/依赖 MCP 切换、本地能力保留、守卫零发出）、面板高度帽防底部按钮出视口 | 106 |
| 悬浮球端到端（真浏览器/本地靶场） | 真扩展+真桥+本地靶场三形态（light DOM/开/闭影子树）、录制/恢复/回放/深搜/诚实停止/工具快捷/导出 JSON/双模切换（断桥不断本地）/URL 守门、控制台整页全流程（指引/重连/真调用/历史预览/回填/双模/可达性）、稳定性复跑、录制管理真浏览器验证、行内重命名 | 37 |
| 规则表一致性 | 规则 id 唯一、文档与规则表不漂移、属性化语料覆盖门 | 37 |
| 加固（静默失效/反转/覆盖/篡改） | 静默失效对抗语料（含 . 前缀存在性钉 3）、浏览器缺失三签名分类与通道自愈契约、零依赖口径只认副本本地（机器级全局不污染判定）、成功判定要证据不只退出码（假 CLI 不得出「已落盘」假绿）、判据基数 serial 解耦（求和与 planWaves 同源）、崩溃/异常退出现场落盘（crashbundle 决策/写盘/自修剪 + verify-all 双分支接线 + bundle 不进收尾清理） | 149 |
| CLI 真实交互与落盘 | Ref 交互、fill/click 生效、产物落盘、PNG 魔数、白名单、通道自愈闭环（活体） | 25 |
| Excel 编排端到端 | 读表 → 映射 → 生成门禁 → 落盘 → 真跑通过 | 20 |
| 参数规范化与产物命名 | 布尔不静默反转、非法值报错、整数参数不静默取整、并发产物不互相覆盖、浏览器通道优先级 | 46 |
| 智能体线（LLM 回环/守门/计划契约/自愈采集纯函数） | stub LLM 真 HTTP 回环、危险目标拒绝、白名单不静默丢弃、自愈语义与预算闸、断点续采、探活预算、计划缓存、表单指纹、步骤参数映射、执行语义收敛、通道环境适配、采集 CSV 公式注入中和、推进检测 sameRows | 149 |
| 智能体线端到端（真浏览器） | LLM 规划→真执行真断言、降级骨架、Fail 语义、巡检、表单指纹两期对比真跑 | 21 |
| 全流程验证（工具链串联+自然语言真跑） | 门禁→执行→归因→生成→智能体线整链真跑、r53 纯重复中间页两击制 | 45 |
| 部署副本验证（须最后跑） | 装完的副本能发现工具、真能调用、与源码逐文件一致（serial 末波） | 30 |
| 真实浏览器回归矩阵 | 2 通过 / 6 失败 / 1 偶发 → 聚成 4 个根因签名（形态验收，`--with-browser` 真跑） | 矩阵 4 签名 |

---

## 目录

```
playwright-verify/
├── mcp/                        MCP server（零运行时依赖）
│   ├── server.mjs              协议循环 + 16 个工具
│   ├── bridge.mjs              浏览器插件本地桥（HTTP ⇄ JSON-RPC，只回环）
│   ├── lib/                    核心逻辑（唯一判定真相源）
│   ├── py/read_cases.py        Excel 读取（openpyxl 可选）
│   └── test/                   16 套回归 + 一键入口 verify-all
├── extension/                  浏览器插件控制台（MV3，加载已解压的扩展程序）
│   ├── manifest.json           插件清单（网络面只圈 127.0.0.1/localhost）
│   ├── background.js           点图标开控制台整页 + 悬浮器桥中转（口令只经请求头）
│   ├── recorder.js             录制纯函数核（定位器/敏感跳过/归一/回放查询）
│   ├── floating.js             猫耳悬浮球（Shadow DOM，录制/保存/回放/工具快捷）
│   └── panel.html/.css/.js     工具面板（schema 驱动表单，走 /rpc）
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

## 已结案技术挂账

工程账本：低概率异常在证据不足时**不猜测性修复**，而是带着编号挂账、逐轮取证；证据链闭合后在此结案（历史证据档与记忆条目全部保留——结案 ≠ 删除）。后续触发「重开条件」即按新证据重新开案。

### 0xC0000409 崩溃家族（r36 挂账 → r46 结案，2026-10-08）

**现象**：verify-all 波内某套件进程原生 fail-fast（Windows 退出码 3221226505 = 0xC0000409 / STATUS_STACK_BUFFER_OVERRUN），stderr 空、无 FAIL 行——「崩了不是红了」的并行侧变体。历史命中 4 次：r36 ×1（旧 13 进程全并行时代）、r37 ×1（protocol-check，拓扑未记录）、r42 ×1（mode 3 --parallel run-03，nl-agent-check，crashLabel 首次具名）、r43 campaign 受控复现 ×1（W4 三件套靶向，成员退出码 3221226505 落档，崩于 A 段 4 PASS——崩溃点与 r42 的 D12 位置漂移）。

**定量证据（r43 campaign：52 次受控执行 + 1Hz 场景采样）**：重拓扑（浏览器重兄弟同波）1/12；轻拓扑（单跑 0/20、mode 1 并行 0/12）0/32；合成进程风暴（3×headless msedge ≈79 进程 + node 抖动峰值并发）0/8——进程数量本身非充分条件；内存排除（40.5–44GB 富余无相关）；WER 对该 fail-fast 完全不报（HKCU LocalDumps(node.exe) 事前武装仍零 dump / 零事件 / 零 bucket）——故障模块经 WER 不可得；环境嫌疑 frida-helper ×7 常驻 + 历史注入实证（事件日志），44+ 场景采样 0 命中 node 模块面，未链罪。

**定性**：低比率、重拓扑限定（~8% 量级）、原生层 fail-fast；与套件本征逻辑无关（0/20 单跑）；崩溃点在套件内位置漂移。不影响门禁公信力：崩溃具名（crashLabel，加固 H20/H27 钉住）、判据如实拦截、失败保留现场。

**门禁兜底（结案时在位）**：① crashLabel 崩溃码具名；② 崩溃/异常退出/挂死现场自动落盘 `crash-bundles/`（r44 crashbundle.js，加固 H30 十六钉；不进收尾清理清单，全绿不抹证据）；③ runCli 证据面（H26）产物在场/非空/形状三判据。

**重开条件**（任一触发即重新开案）：① `crash-bundles/` 出现新 bundle（现已自动落盘，含全量输出 + 退出码三形态 + 时点）；② 安装 Sysinternals procdump 后父侧包装捕获到故障模块；③ 重拓扑 campaign 复现率显著上升（如 20 跑 ≥3 崩）；④ 操作系统侧出现新留痕（事件日志 Application Error / WER bucket）。

**证据档案**：`Temp/crash-r43-evidence/`（89 文件 1.2M：五相 campaign 日志、场景采样 JSONL、w4-trio-03 抢救快照）、`Temp/flaky-r42-evidence/`（130 文件 779K：run-03 原始日志）、复现台 `Temp/crash-r43.mjs` + `Temp/storm-r43.mjs`（可复跑）。

### F5 历史 paging flake（r39 挂账 → r46 结案，2026-10-08）

**现象**：flow-check 翻页用例偶发 harness 态空结果/stale（r39 实录一次，发生于并行会话中改窗口——nl-agent-e2e 声明预抬连锁 + harness 态污染；r42 查明该次实录标签是 F5 不是 F7）。

**取证（r42 + r45）**：F7 深查 38 真跑 + 90 窗口观测零复现；press→eval 时序主嫌被竞态探针定量排除（中导航读结构性不可达：press→eval 子进程往返 p50 ~1.2s ≫ localhost 导航毫秒级）；探针 2/60 findRefByNeedle「快照未产出」瞬断线索由 r45 探针 v2（runCliImpl 全观测 + 失败即时抢救 + 迟 stat + 重试）150 次复跑零复现，叠加 flow-check 真跑累计观测面 ~0/280——若 3.3% 是真率则 P(0/150)≈0.6%，统计不相容；定性为 r42 当日专属暂态（0xC0000409 战役后机器状态），机制因当时日志被留存帽清空不可考。

**定性**：与并行编辑窗口的 harness 态污染相关的偶发，无可复现缺陷；findRefByNeedle/翻页链路在全部受控观测中无自身缺陷（读码五点核对 + r42 失败同序号位置 ok=true 实证）。

**门禁兜底**：r44 起崩溃/异常退出自动落盘 bundle；探针 v2（`Temp/needle-r45.mjs`）为该族常备取证仪器（失败自动抢救日志 + 迟 stat 区分「没写/写了又消失」+ 重试区分瞬断/持续）。

**重开条件**：① flow-check 在无并行编辑的干净窗口再现 F5 形态失败（bundle / 探针 v2 自动留证）；② needle-r45 探针出现 >0 失败且抢救日志指向具体机制。

**证据档案**：`Temp/flaky-r42-evidence/`（summary-phaseA/B/C、探针 JSON）、`Temp/needle-r45-evidence/`（126 文件 370K：150 条全观测 JSONL + 三份 summary）。

（账本建立：2026-10-08，v1.18.0，r46 结案轮写入；全部数字为机器口径实测值，证据档可复核。）

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

### v1.25.0（2026-10-08）

- **collect_table 推进检测与去重新增解耦（两击制，r52 实测丢数案例修复）**——no-new-rows 止损原把「页面推进了但本页无新键」与「页面没推进」混为一谈，纯重复中间页丢后续页数据（r52 实测页账 [[1,2,2],[2,2,0]]）。修复：server 循环新增推进检测（新纯函数 `sameRows` 逐行比对本页与上一页内容），added===0 时——内容有变（键重复值更新）继续翻页；内容逐行相同计一击，**连续两击**才判真未推进停 no-new-rows（F7 守门原语义一字不改：/static 站点仍 rowCount 5 止损）；maxPages 硬上限兜底。已知边界如实：内容逐字相同且持续推进的站点与「翻页坏了」在表内容面不可分辨——两击即停，多花一跳换 r52 案例可采全。钉：nl-agent-check 147→149（sameRows 纯函数两钉）、flow-check 44→45（/pure 站真跑：纯重复中间页续采到尾页 rowCount 3/scanned 3/no-paging-control；F7 神圣钉保持绿）；Temp/realtest-r52 探针同步升级为修复后断言（4/4，页账 [[1,2,2],[2,2,0],[3,1,1]]）。咬合 bite-r53 拔两击制回红。CORE mode 1/2/3 = 740/795/934（flow-check 是 browser 套件：+1 只进 mode 3，mode 2 零依赖态整套 SKIP 不计）；全量 965 = 934 + 1 + 30。

### v1.24.0（2026-10-08）

- **探索性实测轮（r10 模式）：挖出并修复 CSV 公式注入 + 补齐 collect_table 两条未覆盖真链路**——覆盖面盘点（盘 suites 源码）后确认 collect_table 的 **next 翻页模式与 keyIndex 跨页去重全链零真跑**（pageInput/断点续采/两期对比已由 flow-check 覆盖）；真 stdio+回环靶站实测（Temp/realtest-r52.mjs，4/4）：next 模式 3 页全链 ✓（rowCount 15/pagesScanned 3/末页无下一页诚实停 no-paging-control）、keyIndex 跨页去重 ✓（粘行去重 rowCount 8/page 账 [3,2,3]）、纯重复中间页边界记录（page2 全重复 → 保守停 no-new-rows、page3 不采——stopReason 如实、不猜测性修，r53+ 候选）。**修掉真 bug：collect_table CSV 公式注入**——采集数据源是任意网页=攻击者可控，产物注释自述「Excel 双击开」，而 formatCsv 对 `=`/`+`/`-`/`@`/TAB/CR 开头单元格零中和（同项目 db export_data 早有同款防护=口径不一致）；修复=与 export_data 同口径加 `'` 前缀，真链路验证 `=HYPERLINK` 单元格 → CSV 带前缀不执行。钉：nl-agent-check 145 → 147（四形态中和/TAB+CR+普通不受影响），咬合 Temp/bite-r52 拔中和恰 2 红。CORE mode 1/2/3 = 738/793/931；全量 962 = 931 + 1 + 30。

### v1.23.0（2026-10-08）

- **控制台整页真浏览器全流程验证 + 双修复面（安装及可使用收尾）**：控制台（panel.html）此前**零真浏览器覆盖**（只有 vm 钉）——r49 教训「vm 全绿≠真浏览器可达」下这是最大验证缺口。floating-e2e 新增控台全流程段（+7 钉）：桥未起 → 诚实报错且给**可执行启动指引**（修复面 A：裸 "Failed to fetch" 不再是终点，状态行带 `node mcp/bridge.mjs` 起桥命令与独立模式提示）、重连真桥 → 16 工具+状态点绿、lint_spec 真调用 → 「完成，用时」+结构化区显形+**历史行预览非空（r50 面活体）**、历史点击回填、面板双模切独立/切回往返（r49 面活体）、模式钮完全落视口内（可达性显式回潮钉）。修复面 B：install.mjs「下一步」新增插件加载引导（chrome://extensions → 加载已解压 → INSTALL_ROOT/extension 目录 + 起桥命令 + 独立模式可不起桥提示），bridge-check 源码钉锁住（+2：指引 vm 钉 + 安装引导源码钉）。钉：bridge-check 54 → 56、floating-e2e 30 → 37。CORE mode 1/2/3 = 736/791/929；全量 960 = 929 + 1 + 30。

### v1.22.0（2026-10-08）

- **面板历史区富渲染（挂账三轮收账）**：pushHistory 推入时算好预览行 `【verdict】+ 关键事实`（pvResultPreview 纯函数），历史行渲染第四段 `.h-preview`（textContent only，CSS 单行省略防撑爆行布局）。pvFactsLine 在 panel.js 本地复刻悬浮球 r42 同口径实现（键序前 4 席/数组计数含 0 如实/verdict 剔除出 facts/值保真/非对象空串），**无共享模块的复制实现由 bridge-check 双面钉锁死**（同一组 battery 7 输入两边逐一同输出——防静默漂移）。renderHistory 顺势升级为全 createElement + textContent（模板 innerHTML 退场，`ul.textContent=''` 清空——历史行渲染路径零 innerHTML，XSS 面为零；钉按「去注释后」匹配防注释禁词误伤）。钉：bridge-check 49 → 54（双面同口径/口径边界/历史行预览行为/恶意载荷保真+零 innerHTML/空态四段不塌）。CORE mode 1/2/3 = 734/789/920；全量 951 = 920 + 1 + 30。

### v1.21.0（2026-10-08）

- **浏览器插件插拔式双模（独立/依赖 MCP，按钮切换）**：面板与悬浮球各加「⚡ 依赖 MCP / 🔋 独立模式」切换按钮，模式持久化 `pv_mode`（两侧同键）。独立模式=不依赖桥仍可用的本地能力面：悬浮球录制/回放/导出 JSON/console 开控制台照常；桥依赖按钮（巡检/采集/生成/NL）停用 + 分支守卫诚实提示 + bridgeCall 第二层兜底（零 pv-bridge 发出）；面板工具面停用、本地说明显形、runTool 守卫。依赖模式=原全 16 工具面（默认，旧行为零漂移）。**全链路排查修掉 2 个真 bug**：① 配置键分裂——面板存 `base`/`token`、背景/悬浮球读 `pv_base`/`pv_token`，面板改了桥地址悬浮球永远看不见；统一 pv_base/pv_token + 首载旧键迁移（老配置不丢）。② 面板 initialize clientInfo 版本硬编码 '1.9.0' → 改读 `chrome.runtime.getManifest().version`（版本单一源）。钉：bridge-check 42 → 49（面板 vm 行为面 7：默认 mcp 形态/键统一/clientInfo manifest 版本/切 local 零 fetch/runTool 守卫/模式往返/旧键迁移+local 恢复）、floating-check 100 → 105（双模五钉：默认零漂移/切独立形态/守卫零发出逐分支/切回往返/持久化恢复）、floating-e2e 27 → 30（真浏览器：切独立橙点+生成停用+导出保留、断桥不断本地导出、切回探活往返）。开发期修钉三处（stub 类名后缀找点、logLine 覆盖语义、applyMode silent 判定）。CORE mode 1/2/3 = 728/783/914；全量 945 = 914 + 1 + 30。

### v1.20.0（2026-10-08）

- **悬浮球导出录制为 generate_scripts 输入 JSON（一键带走）**：面板新增「📤 导出录制 JSON」按钮——当前选中录制经 `stepsToGenerateInput`（write:false / overwrite 恒 false 语义）转成 generate_scripts 输入载荷，`JSON.stringify` 后以 Blob 下载到浏览器下载目录，纯本地不走桥不写盘，用户直接带进自己项目的生成流；文件名走新纯函数 `exportFileName`（Windows 保留字符/路径分隔符换 _、空白压 -、60 字符帽、空名与全符号糊回落 recording、stamp 注入防同名覆盖）；整链 try/catch（导出是增强面，异常只进日志绝不掀翻面板），revokeObjectURL 定时回收。钉：floating-check 92 → 100（纯函数 3 + vm 行为 5，stub 补 Blob/URL/timer/remove 观测面——按真实 DOM 面给桩，缺方法会把产品行为误判成「崩了」）、floating-e2e 26 → 27（真浏览器下载触发 + 日志回执口径）。开发期钉逮到产品判断一处：`???` 类全符号名洗成 `___` 不该当文件名（不携带命名信息）——回落 recording。CORE mode 1/2/3 = 716/771/899；全量 930 = 899 + 1 + 30。

### v1.19.0（2026-10-08）

- **PW006 修饰断言形态扫尾（expect.soft / expect.poll 覆盖）**：PW006（断言缺 await=假通过）正则从只匹配裸 `expect(` 扩为 `expect(?:\.\s*(?:soft|poll))?`——`expect.soft(page...).toBeVisible()` / `expect.poll(() => page...).toHaveText()` 不再整体漏报（soft/poll 不 await 同样假通过），与 PW007 断言存在性（早已含 soft|poll|configure）的认知面恢复对称；requireAsyncSource 闸门的 expect 头剥离抽成单一源 `EXPECT_HEAD_RE`（旧式只剥裸 expect(，对 `.soft(` 剥不掉会让 inner 取段错位、闸门判据不可信），行级/语句级两处同份；闸门语义不变（仅异步来源参数才判，同步值 soft/poll 不冤枉，fix 文案同步声明）。对抗语料 +5 钉（soft/poll 缺 await 命中 ×2 + await soft/poll 不冤枉 ×2 + soft 同步值闸门不冤枉 ×1）；lint-check 53 → 58。r6 时代遗留候选至此清账。CORE mode 1/2/3 = 708/763/890；全量 921 = 890 + 1 + 30。

### v1.18.0（2026-10-08）

- **崩溃/异常退出现场落盘（crash bundle）**：verify-all 在套件崩溃/异常退出（无 FAIL 行）与挂死分支，立即把全量 stdout/stderr + 退出码（有符号/无符号/hex 双形态）+ 时点写入 `crash-bundles/<时间戳>_<套件>/`（stdout.log / stderr.log / meta.json）；全绿零产出零噪音，写失败只告警不掀翻判定；bundle 自修剪保留最近 20 个，且**不进** verify-all 收尾清理清单——下一次全绿运行不抹掉上一次的崩溃证据（r42 留存帽教训）。新库 `mcp/lib/crashbundle.js`（shouldBundle 决策 / writeCrashBundle 写盘 / pruneBundles 自修剪，纯函数可钉），`crash-bundles` 进 `mcp/lib/exclude.js` ARTIFACT_DIRS 单一源（分发/整树比对/安装复制/净树五面自动排除）。加固 H30 十六钉；hardened 133 → 149。动机：r43 取证 campaign 实证「现场不落盘 = 不可分析」——0xC0000409 靠复现台即时落盘才定住成员退出码与崩溃点；mode1 sanity 首跑瞬断因输出被吞永久不可分类。CORE mode 1/2/3 = 703/758/885；全量 916 = 885 + 1 + 30。

### v1.17.0（2026-10-07）

- **录制行内重命名（管理闭环最后一块）**：列表行 ✎ 按钮 → 行内输入框（Enter 提交 /
  Esc 取消 / 空名由纯函数拒绝并日志如实「名称不能为空（未改动）」/ 重命名中点行退出），
  提交走 r41 就位的 renameRecording 纯函数 + persistRecordings 落盘（steps/url 原样保真）。
  钉：floating-check 86 → 92（五态行为钉 + 数据保真回归）、floating-e2e 25 → 26（真浏览器
  行内改名 → storage 名字更新），咬合 1 组恰中（绕过纯函数直接赋值 → 空名钉红）。
  **行为钉逮到真产品 bug**：行渲染补丁遗留 `appendChild(name)`（name 仅在非重命名分支声明）
  ——点 ✎ 即 TypeError（真浏览器同样会崩），删冗余行修复；钉侧同步修两类自身错位（行全量
  重建后必须重取引用、录制名是自动命名不是步骤目标文案）。全量 16 套件 900 断言（+ 矩阵 4 签名）。

### v1.16.0（2026-10-07）

- **悬浮球富渲染（verdict + 关键事实一行化）**：`pvFactsLine` 纯函数（键序前 4 席：
  顶层标量/一层嵌套标量/数组计数含 0 如实，verdict 不重复、非对象不硬凑、键值原样保真）
  接进 resultTextOf —— 日志一段看全「【verdict】facts | 正文（截 300 保紧凑）」；无结构化时
  零前缀原样。钉：floating-check 80 → 86（纯函数 3 + 真行为 3），咬合 1 组恰中（拔事实行 →
  行为钉红）。vm 测立即 init 页面脚本的全忍让 DOM 存根再添一例（createElement 需带
  setAttribute/attachShadow，早夭会把纯函数钉误伤成红——异常须兜成 null 让钉干净红）。
  全量 16 套件 900 断言（+ 矩阵 4 签名）。

### v1.15.0（2026-10-07）

- **判据基数 serial 解耦（r41）**：verify-all 判据行原先从 SUITES 里 find 第一个 serial 套件取
  assertions 当 serial 段基数 —— 现拓扑只有 deployed-check（30）时数值碰巧对；planWaves 早已支持
  多 serial 各独占一波全都会跑，一旦再加 serial 套件，实跑 total 计入全部跑了的 serial，期望值
  却只算第一个 → 判据行自己假红。改为 `serialAssertions()`（suites.mjs 新导出，与 planWaves 的
  serials 同源求和），计入面同步解耦：跑了的 serial 按声明（serial: true）匹配、不硬编码
  deployed-check 文件名。H29 五钉：解耦接线（find 单取回归即红）、硬编码回归、单 serial 拓扑
  等价（恰 30）、多 serial 夹具求和（7+11=18，find 单取只剩 7）、与 planWaves serial 波序列
  同源一致。hardened 128 → 133；CORE mode 1/2/3 = 675/730/856。

### v1.14.0（2026-10-07）

- **排除口径单一源（r40）**：五面各写排除清单的手工差集会静默假红（r38 净树多排 demo 与
  package-lock.json → 4 套假红蒸发 290 断言；r40 诊断又抓出 deployed-check 漏 generated-booltest、
  install 漏 generated 系、缺失面零豁免三处差集）。新增 `mcp/lib/exclude.js` 唯一源：三集合成
  EXCLUDE_DIRS（依赖/产物/试验场）、EXCLUDE_FILE_RES 文件模式、IGNORE_TOP、EXPECTED_DEPLOY_EXTRA
  与 diffManifests 纯函数（运行时产物双向豁免：源侧产物缺失不报丢、副本侧产物不多余、真源文件
  漂移照抓）。distribute / install / deployed-check 三面 import 派生不再写字面量，差集理由显式
  声明在 exclude.js 头注（EXCLUDE_FILE_RES 仅 distribute、IGNORE_TOP 仅 deployed-check、. 前缀
  策略三面不同、verify-all ARTIFACT_DIRS 路径清单形态不同独立维护）。
- **净树脚本化**：新增 `skill/playwright-verify/scripts/nettree.mjs`（纯 Node 复制忠实镜像减排除，
  . 前缀保留除 .git —— 与 distribute 发布口径刻意不同），r38 robocopy 手工口径退场。
- **H28 fixture 哨兵七钉**：排除面不变量×2（三集合并集无重复/不含源文件类）、diffManifests 双向
  豁免三组夹具、install 沙箱哨兵×2（H23 同构 USERPROFILE 重定向真跑）与 nettree 净树哨兵×2 ——
  源文件哨兵（demo 样例/lock/xlsx/extension）必须存活、产物哨兵（node_modules/generated-booltest/
  test-results/Temp/.git）必须排除，两个方向都钉死。H14/H21 排除钉同步改「单一源条目 + 接线」
  口径。hardened 121 → 128；CORE mode 1/2/3 = 670/725/851。

### v1.13.0（2026-10-07）

- **悬浮球录制管理（单槽升级为多条列表）**：`pv_recordings_list` 多条录制（前插新序、
  容量帽 10 诚实淘汰最旧并在日志如实计数）、面板内联列表（选中高亮/点选切换/✕ 删除，
  选中态删除后自动跟随）、自动命名（时钟）、旧单槽 `pv_recordings` 读取迁移（老数据不丢）
  + 兼容写入（最新一条，旧读取方不受损）。纯函数核：makeRecording/addRecording/renameRecording/
  deleteRecording/migrateLegacyRecordings/findRecording（不可变更新、空名拒绝、未命中 id 诚实
  不动）。钉：floating-check 71 → 80（纯函数 4 + 胶水 5——列表 UI/选中回放/删除同步/容量帽/
  旧槽迁移）、floating-e2e 22 → 25（真浏览器：清态起测连录两条/删较早一条/剩余回放）；
  咬合 1 组 2 钉恰中（拔容量帽）。开发期又逮两个「桩与真实」错位：textContent= 真 DOM 会
  清子节点（桩不清理→行累积）、e2e 管理钉必须清 storage+重 goto 起测（三轮循环已在 storage
  累积）。全量 16 套件 893 断言（+ 矩阵 4 签名）。

### v1.12.0（2026-10-07）

- **结构化结果可视化（面板 kv/表格渲染 + 悬浮球 verdict 徽标）**：面板结构化区从「整块
  JSON 倾倒」升级为**视图模型渲染** —— `pvStructuredModel` 纯函数产 {kv/table/line} 节点
  （对象数组→列并集表格、行帽 20 + total 诚实计数、深度帽 3 防无限递归、空数组诚实空态），
  渲染只走 DOM API 的 textContent 赋值 —— 工具数据不经 innerHTML，XSS 面为零；文本通道
  （原样呈现含 isError）一字未动，可视化是呈现层不是数据改写。悬浮球日志加 verdict 徽标
  （【Pass】前置一眼可见，无 verdict 不伪造）。钉：bridge-check 34 → 42（vm 加载面板脚本
  + 视图模型行为钉 + renderResult 行为钉 + XSS 面钉）、floating-check 69 → 71（徽标有/无两态），
  1 咬合恰中（拔徽标逻辑→钉红）。全量 16 套件 875 断言（+ 矩阵 4 签名）。

### v1.11.0（2026-10-07）

- **悬浮球端到端转正为常驻浏览器套件（本地靶场，零外网依赖）**：`mcp/test/floating-e2e.mjs`
  22 断言 —— 真 msedge 加载扩展 + 自起桥（tools/list=16 新鲜度验证）+ 本地靶场页覆盖三类
  真实页面形态（light DOM / 开放影子树 / 关闭影子树），把真机战役的 54/54 验证固化成回归门：
  录制 4 原始步含口令跳过 → 归一 3 步 → 刷新恢复 → 回放 3 ✓（含开放影子树深搜）→ 工具快捷
  三件套走真桥 → URL 守门 → 关闭影子树录宿主不假装穿透 → 目标消失诚实停止 → R2 稳定性复跑
  → 扩展侧零 error。顺带修出两个真 bug：keydown 的 key 在**事件**上不在元素上（读 el.key 恒空
  → press 步骤真实页面永远录不进，stub 事件不带 key 的盲区）；Playwright press(Enter) 会补发
  change 事件 → 同定位器同值 fill 跨 press 无损归一（值不同绝不吞）。floating-check 66 → 69。
  全量 16 套件 863 断言（+ 矩阵 4 签名）。

### v1.10.1（2026-10-07）

- **成功判定要证据，不只退出码（H26）**：runCli 旧判定只看退出码 + 超时，而「快照已落盘：
  <路径>」摘要只引用**声明路径**、从不验文件在场 —— 裸 `process.exit(0)` 的假 CLI 能骗出
  「CLI 最小闭环通过」的整套假绿（r37 复现台实锤：ok:true 而产物文件根本不存在）。修法加
  证据面 `judgeRunEvidence`：强制落盘子命令（snapshot/screenshot/pdf）必须产物在场且非空、
  png/pdf 魔数对得上、快照含 `ref=eN` 标记（快照的产出物就是 ref —— cli_session 的 fill/click
  只收 ref，没有 ref 的快照等于这步没干活）；CLI 自报 isError 信封（exit 0）判
  CLI_REPORTED_ERROR 不被吞；open/close 等无产物子命令保持退出码契约（没有客观证据可查，
  硬造证据只会误红）。判据全用结构事实、刻意不用措辞匹配（措辞一改就误红）。
  新增 H26 八钉（裸 exit(0) 无产物 / 空文件 / 假快照无 ref / 真快照过 / 假截图缺魔数 /
  真截图过 / 自报信封 / 最小闭环标题面），hardened-check 107 → 115。负向咬合 1 组：
  判定回退成只看退出码 → 恰 6 钉红（六条负向全中、两条正向不冤枉），sha256 往返一致。
  全量 16 套件 853 断言（+ 矩阵 4 签名）。
- **r38 全链路审计轮（2026-10-07）**：8 连跑复现 campaign（0 崩溃复现）+ 调度事实核对（默认严格串行，
  「并行波」旧口径纠正）；录制质量防护 —— looksLikeCode 窄口径（花括号/!important/声明语句）拦下
  CSS/代码文本当文本定位器（真机实测过的垃圾定位器类），代码文本降级 selector、普通说明文不误伤，
  +3 钉 1 咬合；planWaves 并发帽（MAX_WAVE）与 0xC0000409 崩溃签名命名（crashLabel）由并行会话同期落地。

### v1.10.0（2026-10-07）

- **猫耳悬浮球：所有网页常驻一颗可拖拽的猫耳球，点开快捷面板 —— 🎬 一键录制当前页 /
  ⏹ 结束保存 / ▶ 快速回放 / 打开完整控制台**，录制中球体脉冲 + 步数角标（形态参考
  沉浸式翻译的悬浮球）。`extension/floating.js` 内容脚本 Shadow DOM 隔离（页面 CSS 污染
  不了它，它的样式也绝不漏进页面）；`extension/recorder.js` 纯函数核：定位器六级优先级
  与 generate.js 的 canonicalLocator 同一口径（testid > label > role > placeholder > text >
  selector，绝不产 XPath/nth-child）、敏感字段双防线（type=password/cc-* + 名称模式含
  nameAttr —— 凭据录制期即跳过，钉出过真 bug：纯核只读可访问名、胶水喂的是表单字段名）、
  归一（同字段连续 fill 合并/连点去重/上限 200）、回放查询 locatorToQuery（非法 kind 抛错，
  绝不猜元素接着点）。回放是内容脚本内轻量执行：URL 不符诚实拒绝、元素未找到立即停、
  逐条打 ✓/✗ 日志。架构：content script → MV3 Service Worker 中转（background.js，绕开
  页面 CORS）→ 桥 /rpc → MCP；口令只存扩展 storage、只经 x-bridge-token 请求头出站。
  面板工具快捷：录制生成脚本（generate_scripts，键集恰在 schema 白名单、write 默认 false、
  overwrite 恒 false）/页面巡检/表格采集/NL 测试（当前页 URL 自动带上）。
- **接入发版链**：manifest content_scripts 只圈 http/https 网页（host_permissions 仍恰好
  2 条本机、permissions 仍只有 storage —— 网络面不扩权）；deployed-check 28 → 30；
  新套件「猫耳悬浮球（录制/回放/中转）」66 断言（vm 加载真文件 + stub DOM 真跑交互链 +
  真 background.js 中转 + manifest 契约）。负向咬合 3 组：定位器优先级反转 → 5 钉红 +
  1 连带（弱定位仍「找到」元素，恰反证优先级的精度价值）；敏感跳过失效 → 7 钉红；
  中转丢口令头 → 1 钉红；写钉过程中绿态咬合先抓出 nameAttr 口径错位真 bug；真机实测前再补 3 钉并修两处（长文本定位不截断、回放 text 候选集扩标题并整段兜底）；真机全链实测（真 Edge + 真桥 + Gitee 仓库页 ×3 轮）又抓出并修复 3 处：拖拽只动了空壳 host 而非视口固定的球体、捕获取 e.target 被影子树重定向录出垃圾文本（改取 composedPath 首元素）、刷新恢复态不解禁回放/生成按钮；真机三轮迭代再补：回放查询升级为穿透开放影子树的深搜（Gitee 仓库头部组件场景，深度上限 4）+1 钉。
  全量 15 套件 811 断言（+ 矩阵 4 签名）。

### v1.9.1（2026-10-07）

- **零依赖口径只认副本本地（判定面与执行面分家）**：`PVMCP_LOCAL_ONLY_DEPS=1` 时
  resolveCliRunner 只认 cwd/node_modules，机器级全局（npm i -g / PATH shim）一律不认；
  verify-all 三模式全程置位 —— mode 2 预检、套件 SKIP、cli_health「诚实报缺」全部按副本口径。
  执行契约原样：真实用户不设开关，@playwright/cli 仍由本机提供（npm i -g 装法不变）。
  修掉的是全局 shim 机器级假设缺口（实测三面：发版门禁嵌套 mode 2 在装了全局 shim 的机器上
  永不可绿、净树 cli_health 被坏全局顶替成「超时无响应」、逐套件对账在混合态下静默跳过）。
  新增加固 H25 三条（开关生效 / 诚实报缺不被顶替 / 默认兜底向后兼容），hardened-check 104 → 107。
  负向咬合 1 组恰中预测钉、sha256 往返一致。全量 14 套件 746 断言（+ 矩阵 4 签名）。

### v1.9.0（2026-10-07）

- **浏览器插件控制台（MV3）+ 本地桥：从浏览器里调全部 16 个 MCP 工具**：`extension/`
  （manifest / background / panel）以「加载已解压的扩展程序」装上，点图标开整页控制台 ——
  工具表单由 `tools/list` 的 inputSchema 现场生成（enum→下拉、布尔→勾选、数字→数字框、
  数组/对象→JSON 文本域），提交走 `tools/call`，历史可回填重跑；无第二份工具清单、无构建链，
  manifest 只圈 `127.0.0.1/localhost` 且 version 与 package.json 同步钉住。`mcp/bridge.mjs`
  做 HTTP ⇄ JSON-RPC 本地桥：POST /rpc **复用同一个 handleMessage**（与 stdio 零协议分叉，
  不存在两份实现悄悄漂移），串行队列保共享产物目录不互踩，GET /health 探活免口令。
- **守门与脱敏**：只绑 127.0.0.1；Host 头非本机名 403（挡 DNS rebinding）；带 Origin 时
  只放行扩展来源、网页来源 403；可选口令 `PVMCP_BRIDGE_TOKEN`（x-bridge-token，常量时间
  比较，401 三态）；请求体 4MB 上限 413（排空收尾，不炸连接）。观测日志只记
  method/route/状态/耗时/工具名 —— 参数值与结果文本一律不进日志（哨兵钉住）。
- **接入发版链**：install/distribute 复制集纳入 extension/，deployed-check 26 → 28
  （含浏览器插件桥与控制台）；新套件「浏览器插件本地桥（通道/守门/脱敏）」34 断言
  （/rpc 打穿错误码/通知 204/批量 id 对应/405/404、守门十态、413、串行并发不失位、
  CLI 真启动脱敏哨兵、manifest 与面板契约）。负向咬合 2 组恰中预测钉、零误伤、
  sha256 往返一致。全量 14 套件 743 断言（+ 矩阵 4 签名）。

### v1.8.18（2026-10-06）

- **cli_health 浏览器缺失自愈闭环**：缓存被清后 open 报「Browser "X" is not installed」这类环境缺失，
  以前只能拿着提示手工修。现在 `cli_health` 自动闭环：三签名分类（distribution-not-found /
  browser-not-installed / executable-missing，daemon 噪声行不干扰）→ 决策矩阵新增 2b 规则
  （机器生成配置残留 executablePath 钉即按平台重生成 —— 顶层钉是死字段假钉、launchOptions 钉顶掉 channel，
  正是「channel:msedge 没被加载」的实测根因）→ 重写为 channel 式配置 → 重试一次，
  全程 `autoHeal` 字段如实标注（手工配置是显式意图，不自动重写）。H13 +4、H24 +3、cli-e2e +4
  （活体自愈：陈旧钉+空缓存 → 重写后重试 4 步全绿）；hardened-check 97 → 104、cli-e2e 21 → 25；
  全量 13 套件 707 断言（+ 矩阵 4 签名）。
- **自愈执行线三处回归修复（mode 3 实测抓出，断言数不变）**：① 收尾关 session 的时机 ——
  上轮僵尸修复把 close 放进 cliBatch 尾部，而 executePlan 的自愈门在 batch 返回后才检视失败步，
  会话提前关掉让自愈永远拿到「browser not open」（NO_SNAPSHOT）；close 移到 executePlan 之后的
  finally（运行结束含自愈才关，僵尸修复意图不变）。② 自愈后的陈旧批量结果 —— cliBatch 全步先跑
  后检视，自愈真点上按钮后，后续步骤的批量结果是对「没点上」的旧页面算的（断言证据比自愈快照还旧）；
  自愈成功后剩余步骤作废、逐步真跑（与模式二同源 exec），断言照常按快照判定、不放宽。
  ③ 批量步缺执行耗时 —— 批量执行器结果补记 durationMs（报告「每步有执行耗时」口径来源）。
  负向咬合 5/3/1 红恰中预测钉、零误伤，sha256 往返一致。

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
