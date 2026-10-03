# 智能体线：自然语言声明式测试（nl-agent）

> 回答的判断题：**「说目标、不说步骤」的测试该怎么落地？LLM 在链路里的边界在哪？什么坚决不能让它做？**

来源：《36岁测试大佬用 Langchain＋Playwright 构建的智能测试 Agent》一文的方法论，
经本项目重实现并入 playwright-verify（文中未提供 git 仓库；参照源码是 LangChain 的
PlayWrightBrowserToolkit，已下载到 `scratch/langchain-ref`（langchain 仓库稀疏检出）与
`scratch/lc-pkg`（langchain-community 0.4.2 sdist））。

## 1. 核心思想：声明式测试

传统脚本是**命令式**的：先点哪、再填哪、断言什么，全部写死。声明式只给目标：

> 「登录后把商品加入购物车，购物车里应看到该商品」

由规划器把目标拆成最小可判定的步骤清单，再逐条执行。目标会变、实现会变，
但「期望什么」是稳定的 —— 声明式测试让用例跟着期望走，而不是跟着按钮的 XPath 走。

## 2. 本实现的分工（与文章的差异，刻意的）

| 环节 | 文章（LangChain Agent） | 本实现（playwright-verify） | 为什么改 |
|---|---|---|---|
| 规划 | LLM 自由发挥（create_agent ReAct 循环） | LLM 只输出**受限 JSON 计划**（动作白名单） | 自由循环会编步骤；白名单外一律拒绝 |
| 执行 | LLM 自选工具逐步驱动 | 本服务执行器映射 playwright-cli 会话动作 | 执行可复现、证据必落盘 |
| 断言 | 靠 system prompt 自觉 | `expect_text` / `expect_visible` 显式进计划 | 「断言对不对」必须人能读懂 |
| 判定 | LLM 自述结论 | 确定性 `verdictOf`：Pass/Fail/Blocked | **模型编造不了「通过」** |
| 证据 | 对话流 | `.playwright-artifacts/` 落盘，返回路径与摘要 | 省 Token，且失败现场可归档 |

一句话：**LLM 只做规划，判定权不在模型手里。**

## 3. LangChain 七工具 → 本项目映射

文章用 `PlayWrightBrowserToolkit.from_browser()` 挂 7 个浏览器工具。对照表：

| LangChain 工具 | 语义 | 本项目对应 |
|---|---|---|
| `navigate_browser` | 打开 URL（仅 http/https） | `nl_test_goal` 的 goto 步 / `cli_session` 的 open/goto |
| `click_element` | 点击选择器元素 | `nl_test_goal` 的 click 步 / `cli_session` click |
| `get_elements` | 取匹配元素属性 | `explore_page` 的链接/图片/表单盘点 / `cli_session` find |
| `extract_text` | 提取整页文本 | `cli_session` snapshot（落盘后按需读，不回灌上下文） |
| `extract_hyperlinks` | 提取全部链接 | `explore_page` links（含死链探活） |
| `current_webpage` | 当前 URL | 计划报告里的 url 字段 / `cli_session` 返回值 |
| `previous_webpage` | 回退 | `cli_session` go-back |

文章「下一步行动建议」的三件事也都有落点：

| 文章建议 | 本项目落点 |
|---|---|
| 自定义工具（如 `login_to_system`） | 登录不进工具：凭据只从环境变量读，登录步骤写成计划里的 fill/click（见 §6） |
| JSON Pass/Fail 断言集成 CI | `nl_test_goal` 报告 `verdict` 字段（Pass/Fail/Blocked）+ 退出码语义 |
| 探索性测试（死链/坏图） | `explore_page`（确定性判定，不用 LLM） |

## 4. 使用形态

```
nl_test_goal {
  goal: "登录后把商品加入购物车，购物车里应看到 \"ITEM-A\"",
  url: "https://app.test.example.com",
  llm: "auto"          // auto=按环境配置走 LLM；off=确定性骨架
}
```

- 计划动作白名单：`goto / click / fill / press / expect_text / expect_visible / screenshot`。
- 白名单外的动作**拒绝并列出**（宁可不做，不能猜错），计划整体作废交回人确认。
- LLM 不可用时降级为确定性骨架（goto + 目标引号断言 + 截图），报告里 `source: fallback` 如实标注。
- CI 挂门禁：读报告 JSON 的 `verdict` 字段；`Pass` 才放行。

```
explore_page { url: "https://app.test.example.com", maxLinks: 20 }
```

- 死链 = HTTP 4xx/5xx；网络不可达只警告不进 Fail（离线环境下外链必然不可达，把环境问题算成页面问题是假警报）。
- 坏图 = 加载完成但 `naturalWidth` 为 0；加载中的图不算。

## 5. LLM 配置（凭据只从环境变量，默认本地）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PVMCP_LLM` | `ollama` | `ollama`（本地，数据不出机）/ `deepseek`（云端，显式开启）/ `off` |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | 本地 Ollama 服务 |
| `OLLAMA_MODEL` | `qwen3` | 文章实测模型 |
| `DEEPSEEK_API_KEY` | （无） | 云端必需；**只从环境变量读，绝不接受传参、不落盘、不进日志** |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | `https://api.deepseek.com` / `deepseek-chat` | 云端端点与模型 |
| `PVMCP_LLM_TIMEOUT_MS` | `60000` | 规划请求超时 |

隐私边界：页面事实会送进 LLM 做规划。默认本地 Ollama 就是让这条边界不需要审批；
切云端是**显式动作**（`PVMCP_LLM=deepseek`），切之前想清楚页面内容出不出机。

## 6. 禁止做什么（守门是代码，不是口号）

以下在**打开浏览器之前**就会被拒绝（`GOAL_REFUSED` / `TARGET_REFUSED`）：

1. **真实资金**：真实支付、转账、汇款、充值 —— 一律不可自动化。
   资金类动词（转账/支付/下单…）只在明确测试语境（测试/演练/沙箱/测试数据）下放行。
2. **破坏性数据操作**：删除、清空、drop、truncate、rm -rf —— 不做。
3. **生产数据与生产环境**：默认只允许 test / staging；生产主机必须显式 `confirmProd: true`
   （独立审批的留痕参数），生产数据操作连审批口径都不给。
4. **对外发送**：群发邮件/短信/消息 —— 不做（测试环境的模拟通知除外）。
5. **批量对外**：批量注册/下单/发帖、全站抓取 —— 这是滥用面，不是测试面。
6. **非 http/https**：`file://`、`javascript:` 等协议一律不放行。
7. **不自动改断言**：`expect_*` 只判定成立与否；不成立就 Fail，「放宽到能过」不是选项。

## 7. 自定义工具的方向（文章建议的正确定位）

文章建议把 `login_to_system` 做成自定义工具。本项目的口径：
**登录不做工具，做计划步骤**。理由：工具一旦内建登录，凭据就会长期驻留在工具实现里；
而计划步骤里的 fill/click 走环境变量取值（`$ACCOUNT` 由宿主注入），凭据不进脚本、不进日志。
见 `env-and-accounts.md`。

如果确实要扩展自定义动作，约束与白名单一致：动作要进 `mcp/lib/nlplan.js` 的 `ACTS` 表，
参数要求显式声明，缺参拒绝 —— 没有「自由 eval」这条路。

## 8. 优点（为什么值得用这条线）

- **目标稳定**：需求改文案不改期望，声明式用例跟着期望走，维护面小一个量级。
- **模型编造不了「通过」**：判定是确定性代码，LLM 只出计划。
- **失败可归因**：每步证据落盘（快照/截图/报告 JSON），失败现场能定责。
- **隐私默认合规**：本地 LLM 是默认值，云端是显式动作。
- **守门前置**：危险目标与越权地址在动浏览器之前就被拦，不需要事后审计。

## 9. 何时**不**用智能体线

- 已经有稳定脚本的回归：直接 `run_verify`，不要让 LLM 重新规划一遍。
- 覆盖分析、断言该不该改：这是人的判断，见 `assertion-discipline.md`。
- 精确性能测量、接口契约：声明式浏览器测试不擅长，别硬用。
