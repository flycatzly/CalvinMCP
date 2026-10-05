# web-rpa-mcp — 网页操作录制与回放（内置 MCP）

> 版本 **1.5.10** · 内置 MCP `1.5.10` · **44 个工具** · 自检 **387 项全绿**（107 单元 + 27 规则 + 24 协议 + 65 工具 + 34 端到端 + 130 集成）+ **覆盖度自检**（44 工具 / 21 步骤 / 11 断言 / 26 规则 / 10 CLI 全部有测试，39 配置键全部有接线）

把重复的网页点击**录成技能**，之后一键或定时复跑。它由两层组成：`SKILL.md` 等**技能层**（让客户端/大模型知道「何时用、怎么用、红线是什么」）+ `mcp/` **服务层**（MCP 服务器，stdio / JSON-RPC 2.0，44 工具）。

## 一、它解决什么问题

把「路径每次都一样」的重复网页操作，做成一个会看屏幕、会点按钮的技能：**你做给它看一遍，以后它替你点**。

```
以前                                    现在
打开 A 系统 → 点报表 → 导出            自动打开，自动点
打开 B 系统 → 粘贴 → 提交               自动填，自动交
自己核对两遍                            跑完截图给你看，结果为空直接报警
```

它不是一个宏，而是「录制 + 变量 + 回放 + 结果校验」的闭环：录一遍生成可审阅的步骤清单 → 把每次会变的值（日期/单号）换成变量 → 无头回放并校验结果非空 → 页面改版自动自愈定位 → 失败截图取证并告警。

## 二、能力总览

| 能力 | 说明 | 对应工具 |
|---|---|---|
| 录制 | 打开可见浏览器，把人工演示的点击/填写/选择/勾选/按键/跳转/上传/下载/**hover 展开的菜单**记录成步骤 | `record_start` / `record_status` / `record_stop` |
| iframe | 内嵌页面里的元素照常录，自动带上 iframe 选择器链；文字/表格断言默认跨框架扫描 | 录制/回放/断言全链路 |
| 运行总览 | 一眼看全部流程的健康度：最后状态、连续失败次数、是否中断/正在执行、自愈趋势、定时配置 | `status_report` / `lock_status` |
| 无人值守护栏 | 并发锁防重复提交、弹窗不静默、留存自动清理、崩溃可检测、截图脱敏 | `runs_prune` / `lock_release` |
| 登录态复用 | 人工登录一次（扫码/短信/账密都行），登录态存进持久化 profile，之后无人值守直接复用 | `profile_login` / `profile_info` / `profile_reset` |
| 步骤清单 | 人类可读的清单，录完先自己看一遍；可删/改/移某一步，不必整段重录 | `flow_show` / `flow_step_delete` / `flow_step_update` / `flow_step_move` |
| 变量 | `${today:YYYYMMDD}` 等内置日期；`excel:文件#列@行` 取 Excel 单号；env/secret/串联取值 | `flow_param_add` / `flow_param_remove` / `record_stop` 自动识别 |
| 回放 | 无头或多窗口执行；可重试；提交类点击不盲目重试（防重复提交） | `flow_run` |
| 结果校验 | 断言 + 「空结果不算成功」兜底；识别「暂无数据」占位行与只有表头的导出文件 | `flow_assertion_add` / `flow_run` |
| 截图取证 | 失败自动截当前屏，结束时整页截图，全部落进运行报告 | `flow_run` 自动 |
| 定时 | 注册 Windows 任务计划，每天定点自动跑，失败即告警 | `schedule_add` / `schedule_list` / `schedule_run_now` |
| 告警 | 企业微信/钉钉/飞书/Slack/通用 Webhook；含失败步骤、校验明细、自愈提示、报告路径 | `notify_config` / `notify_test` |
| 串联 | 取数 → 填表 → 发邮件 一条线跑完，前一步提取值传给后一步 | `chain_run` |

### 关键强化（都是踩过的坑换来的护栏）

- **自愈定位符**：每步存 10 种定位策略 + 元素指纹。策略全失效时按指纹打分兜底，命中后把新定位符**回写进流程文件**，下次直接命中。
- **改版预警**：预检与回放都会报告「哪一步降级命中」，页面改版在出空报表之前就暴露。
- **静态检查（26 条规则）**：验证码/短信码/密码明文、缺结果校验、未声明变量、脆弱选择器、硬编码日期、重复提交、下载缺路径、非网页地址、env 参数在定时下取不到等，阻断级问题**拒绝执行**。
- **敏感步骤拦截**：密码值不落盘；验证码步骤要求改成人工接管，否则报错而不是卡死。
- **浏览器启动自愈**：候选浏览器逐个探测，启动失败的记入缓存自动跳过。
- **凭据加密**：AES-256-GCM 本地密钥文件；报告/日志/告警落盘前**整体脱敏**，敏感值一律 `***`。`security.redactKeys` 按键名兜底（没标 secret 的 password 类参数也会被清掉），`security.maskSecrets` 是参数/日志脱敏总开关；secret 凭据值与 webhook 回显永远打码。
- **iframe 原生 / hover 菜单识别 / 内置页拦截 / Shadow DOM**：注入脚本在所有 frame 运行；空闲态基线 + 容器级判定，纯 CSS `:hover` 揭层的下拉菜单也能录进来；`edge://` / `chrome://` 等内置页不录（混入则静态检查 **L002 阻断**）；开放影子根实测可录可放。
- **并发锁**：同一流程被定时任务与手工同时触发时，第二次直接跳过并说明原因——避免**重复提交业务数据**。
- **弹窗不再静默 / 崩溃可检测 / 留存自动清理**：未被流程处理的弹窗自动判失败；被强杀/断电留标记报 **interrupted**；默认每流程保留最近 50 次且 30 天内。
- **截图脱敏 / 日期偏移 / 滚动加载**：截图前给密码框等敏感字段打码；`${today-7:YYYYMMDD}`、`${today+1}` 覆盖「上周同期/昨天」口径；`scrollTo` 步骤处理无限滚动列表。
- **登录态持久化 / 配置可撤销 / 无表头格式 / 覆盖度自检**：`config_set` 把某项设为 `null` 即「恢复默认」；`.txt` 逐行文本、标量 JSON 数组不再吞掉第一个值；`node test/audit.mjs` 让任何「没人用过的能力」都过不了自检。

## 三、环境要求

- Windows（定时功能依赖任务计划程序 `schtasks`；录制与回放本身跨平台）
- Node.js >= 18.17（开发机实测 v24）
- 一个可用的浏览器：自带 Chromium、系统 Edge 或 Chrome 任选其一

## 四、安装

```powershell
cd <项目目录>\web-rpa-mcp
node install.mjs
```

安装器会依次完成：
1. 检查 Node 版本
2. 建立 `flows/ runs/ logs/ .work/` 目录，并生成 `.gitignore`（纯净发布包不带 `.` 前缀文件，敏感路径边界由安装器补齐）
3. 生成默认 `web-rpa.config.json`（已存在则跳过）
4. 解析 playwright；缺失时自动 `npm install`（发布包零预装依赖，依赖由此命令生成）
5. 探测可用浏览器并打印实际会用的那个
6. 跑 107 项单元测试（完整 387 项 + 覆盖度自检见「验证」一节）
7. **打印 MCP 注册 JSON**（复制到你的客户端配置）
8. 把 workflows / references 复制到技能目录

发布包是**纯净分发包**（零预装依赖、不含任何 `.` 前缀文件/目录、不含凭据与生成物）：`mcp/node_modules` 由第 4 步命令生成（也可先 `cd mcp; npm ci` 手工装）。部署完整指引见《部署说明.md》（最短路径）与《部署说明.详细版.md》（配置/安全/排错/升级/全工具使用示例）。

可选参数：

| 参数 | 作用 |
|---|---|
| `--no-skill` | 不复制到 `~/.claude/skills` 与 `~/.agents/skills` |

## 五、注册 MCP

```json
{
  "mcpServers": {
    "webrpa": {
      "command": "node",
      "args": ["<项目目录>\\web-rpa-mcp\\mcp\\server.mjs"]
    }
  }
}
```

各客户端位置：
- Claude Code：`claude mcp add webrpa -- node "<项目目录>\web-rpa-mcp\mcp\server.mjs"` 或项目 `.mcp.json`
- Claude Desktop：`%APPDATA%\Claude\claude_desktop_config.json`
- Cursor：`~/.cursor/mcp.json`

**注册后必须重启客户端。**

## 六、验证

```powershell
cd <项目目录>\web-rpa-mcp\mcp
node server.mjs --doctor     # 环境自检
node server.mjs --tools      # 列出 44 个工具
node selftest.mjs            # 全链路一键跑：下面 7 套按序执行并给出汇总
node test\unit.mjs           # 107 项单元测试（纯函数/表格各格式/变量/日期偏移/内置变量/参数来源/定时校验/定时预期/预算解析/入参校验）
node test\rules.mjs          # 27 项静态检查规则（26 条规则逐条构造触发用例）
node test\mcp-protocol.mjs   # 24 项 MCP 协议测试
node test\tools.mjs          # 65 项工具全量实测（44 个工具逐个真实调用）
node test\e2e.mjs            # 34 项端到端测试（会真的开浏览器）
node test\integration.mjs    # 130 项集成测试（全部步骤类型/断言/iframe/hover/串联/凭据/告警/定时/弹窗/锁/留存/profile/CLI/总超时/录像/告警重试/chain超时继承/发件箱/录像留存）
node test\audit.mjs          # 覆盖度自检：任何"没被测试碰过"的能力都会让它失败
node runner.mjs list         # 已录制的流程
```

日常迭代可只跑一部分：`node selftest.mjs unit e2e` 只跑指定套件；`node test\integration.mjs --group 4,17` 只跑指定组（参数可透传：`node selftest.mjs integration --group 14`）。

端到端测试会启动本地演示站点，真实完成一次「录制 → 生成技能 → 回放 → 自愈 → 空结果拦截」，并覆盖「主录制页被关掉后工作标签页接替」的多标签场景。

## 七、快速开始（五分钟上手）

```
1. doctor                                          确认环境
2. record_start { url: "https://a.example.com" }   打开浏览器
3. （你在浏览器里把日常操作慢一点做一遍，每步停半秒）
4. record_stop { name: "订单日报导出" }            生成技能 + 步骤清单
5. flow_lint { flowId: "订单日报导出" }            看有没有要补的
6. flow_run { flowId: "订单日报导出" }             回放
7. schedule_add { flowId: "订单日报导出", at: "09:00" }   定时
8. notify_config { enabled: true, type: "wecom", webhook: "..." }
9. notify_test                                     验证告警
```

三步核心心智：**录**（`record_start` → 演示 → `record_stop`）→ **审**（看步骤清单与 lint，有阻断项先修）→ **跑**（`flow_run`，稳定后 `schedule_add`）。

命令行一键跑：

```powershell
cd <项目目录>\web-rpa-mcp\mcp
node runner.mjs run 订单日报导出 --params 日期=2026-09-30
node runner.mjs run 订单日报导出 --headed          # 需要人工接管验证码时
```

退出码：`0` 成功 / `1` 失败 / `2` 被阻断 / `3` 用法错误。

## 八、MCP 工具速查（44 个）

> 完整参数与**自然语言使用示例（覆盖全部 44 工具）**见《部署说明.详细版.md》；此处列名称与关键参数供速查。`*` 为必填。

**录制**（录制现场 → 生成技能）
| 工具 | 作用 | 关键参数 |
|---|---|---|
| `record_start` | 打开可见浏览器，开始录制人工演示 | `url`, `name`, `viewport{width,height}` |
| `record_status` | 查看当前录制会话已记步骤与提醒 | — |
| `record_stop` | 结束并生成技能（清单/日期变量化/推断断言/静态检查） | `name`, `save`, `inferAssertions`, `keepBrowserOpen` |
| `record_splice_start` | 只重录「录错的那一段」 | `flowId*`, `from*`, `to`, `keepSuffix`, `params`, `headed` |
| `record_cancel` | 取消录制，丢弃已记步骤 | — |

**流程管理**
| 工具 | 作用 | 关键参数 |
|---|---|---|
| `flow_list` | 列出全部已录制流程 | — |
| `flow_show` | 查看完整步骤清单（含变量/断言） | `flowId*`, `format`(markdown/json) |
| `flow_lint` | 静态检查（26 条规则） | `flowId*` |
| `flow_rename` | 重命名（只改显示名，id 不变） | `flowId*`, `name` |
| `flow_delete` | 删除流程及其运行记录索引 | `flowId*` |
| `flow_export` / `flow_import` | 导出/导入流程定义 JSON | `flowId*` / `flow*`, `overwrite` |
| `flow_restore` | 回滚到备份（误删可找回） | `flowId*`, `which`, `list` |

**变量与断言**
| 工具 | 作用 | 关键参数 |
|---|---|---|
| `flow_param_add` | 声明变量 | `flowId*`, `name*`, `label`, `source`, `default`, `required`, `secret` |
| `flow_param_remove` | 删除变量 | `flowId*`, `name*` |
| `flow_assertion_add` | 加结果校验断言 | `flowId*`, `kind*`, `text`, `selector`, `min`, `contains`, `equals`, `regex`, `as`, `minBytes`, `locators` |
| `flow_assertion_remove` | 删除第 n 条断言 | `flowId*`, `index*` |

`flow_param_add` 的 `source`：`const` / `env:NAME` / `secret:NAME` / `excel:<文件>#<列>[@行|*]` / `csv:…` / `flow:<流程id>:<键>` / `prompt`。
`flow_assertion_add` 的 `kind`：`tableNotEmpty / listNotEmpty / textPresent / textAbsent / elementVisible / elementAbsent / url / title / download / extracted / noErrorBanner`。

**步骤编辑**
| 工具 | 作用 | 关键参数 |
|---|---|---|
| `flow_step_delete` | 删除某一步骤 | `flowId*`, `index*` |
| `flow_step_update` | 局部修改一步（换变量/补上传路径/标 expectDownload） | `flowId*`, `index*`, `patch` |
| `flow_step_move` | 调整步骤顺序 | `flowId*`, `from*`, `to*` |

**执行与报告**
| 工具 | 作用 | 关键参数 |
|---|---|---|
| `flow_preflight` | 非破坏性定位预检 | `flowId*`, `headed` |
| `flow_run` | 回放（自愈/断言/截图/告警） | `flowId*`, `params`, `headed`, `allowLintErrors`, `learn`, `evidenceOn`, `maxDurationMs`, `saveVideo`, `videoOn`, `trigger` |
| `chain_run` | 多流程串联 | `items*[{flow*, params, continueOnError}]`, `headed`, `notify`, `maxDurationMs` |
| `run_history` | 历史执行记录 | `flowId*`, `limit` |
| `run_report` | 某次执行完整报告 | `flowId*`, `stamp`(默认 latest) |
| `status_report` | 全流程健康总览 | `onlyProblems` |
| `runs_prune` | 按留存清理历史 | `flowId`, `keepCount`, `keepDays`, `keepVideos`, `dryRun`, `logs` |

**锁 / 定时 / 告警 / 凭据 / 登录态 / 配置**
| 工具 | 作用 | 关键参数 |
|---|---|---|
| `lock_status` / `lock_release` | 查看/强制释放执行锁 | `flowId` / `flowId*` |
| `schedule_add` | 注册 Windows 定时任务 | `flowId*`, `frequency`(daily/weekly/hourly/minute/once/logon), `at`, `days`, `everyMinutes`, `everyHours`, `date`, `params`, `headed` |
| `schedule_list` / `schedule_remove` / `schedule_run_now` | 列/删/立即触发定时 | `flowId*`(后两者) |
| `notify_config` / `notify_test` | 配置/测试告警 | `enabled`, `type`(wecom/dingtalk/feishu/slack/generic), `webhook`, `on`(failure/success/healed/all), `mention` / `message` |
| `secret_set` / `secret_list` / `secret_delete` | 增/列/删加密凭据 | `name*`, `value*` / — / `name*` |
| `profile_login` / `profile_info` / `profile_reset` | 建/看/清登录态 | `url*`, `successText`, `successUrlContains`, `timeoutMs` / — / `confirm*` |
| `config_get` / `config_set` / `doctor` | 读/写配置/环境自检 | — / `patch*` / — |

## 九、使用工作流（Agent 调用规范）

1. **先自检**：`doctor` 确认 playwright 与浏览器可用；首次使用先跑 `install.mjs`。
2. **要登录的系统先建登录态**：目标系统需登录则**先** `profile_login { url, successText }` 让人工登录一次；之后录制与定时都复用登录态，流程本身不必含登录步骤。
3. **先问清流程**：录之前和用户核对「哪些步骤路径固定、哪些值每次变」（日期/单号/环境），并**明确告知：验证码、短信码、登录态、敏感系统不要录进来**。
4. **录制**：`record_start` 后必须**让用户亲手操作**，不要自己代点（除非用户要求）。用户说操作完了，再 `record_stop`。
5. **审清单**：把 `record_stop` 的步骤清单原文呈现给用户确认——特别是「有没有多点/少点某一步」（录的时候手滑点错，AI 会忠实学会错误路径）。
6. **补变量**：把每次会变的值改成参数（`flow_param_add`），能落 Excel 的用 `excel:文件#列@行`。
7. **补校验**：`flow_lint` 若报 L010（缺结果校验），用 `flow_assertion_add` 补。导出类流程必须有「非空」校验。
8. **回放**：先 `flow_preflight` 做非破坏性定位预检，再 `flow_run`。
9. **上线**：`schedule_add` 定时 + `notify_config` 配 Webhook，再 `notify_test` 验证告警链路。
10. **看护**：定期 `run_history` 看自愈次数；自愈次数上升说明页面在改版，该重新录制了。

### 录错了 / 删错了怎么办

- **只错中间几步，不想整条重录**：`record_splice_start { flowId, from, to }` —— 先把第 1~from-1 步真实重放一遍，把页面带到出错那一步之前；你只把 from~to 步重做一遍，`record_stop` 自动拼回流程（`keepSuffix: false` 可丢掉后面的旧步骤）。中途反悔就 `record_cancel`，原流程一字不动。
- **误删 / 改坏流程**：任何改动（改名、增删参数/断言/步骤）与删除前都会自动留备份（每流程最多 10 份、保留 30 天）。`flow_restore { flowId }` 回滚到最近一次；`flow_restore { flowId, list: true }` 看全部备份；**误删的流程也能用 `flow_restore` 找回**。

## 十、配置

`web-rpa.config.json`（合并式覆盖，不需要的字段可以不写）：

```json
{
  "browser": {
    "mode": "auto",
    "channel": null,
    "executablePath": null,
    "headless": true,
    "viewport": { "width": 1440, "height": 900 },
    "locale": "zh-CN",
    "timezoneId": "Asia/Shanghai"
  },
  "run": {
    "stepTimeoutMs": 15000,
    "navTimeoutMs": 45000,
    "retries": 1,
    "saveEvidence": true,
    "evidenceOn": "always",
    "humanHandoffTimeoutMs": 180000,
    "emptyResultGuard": true,
    "healMinScore": 0.72,
    "strictDialogs": true,
    "keepRunsPerFlow": 50,
    "keepRunDays": 30
  },
  "security": {
    "maskFieldsInScreenshots": true
  },
  "notify": {
    "enabled": false,
    "type": "generic",
    "webhook": "",
    "on": ["failure", "healed"]
  },
  "schedule": { "taskPrefix": "WebRPA" }
}
```

用 `config_get` / `config_set` 读写，不必手改文件。`config_set` 里把某项设为 `null` 即「恢复默认」。完整字段语义（含 `run.maxDurationMs`/`unattendedMaxDurationMs`/`saveVideo`、`security.redactKeys`/`maskSecrets`、`run.keepVideosPerFlow` 等）见《部署说明.详细版.md》第五节。

## 十一、需要登录的系统（登录态复用）

面向「要登录才能用」的内部系统，做法是**人工登录一次、之后长期复用**：

```
profile_login { url: "https://a.example.com/login", successText: "工作台" }
```

它会打开一个可见浏览器让你登录（扫码/短信/账号密码都行），检测到 `successText` 或 `successUrlContains` 就把登录态写进持久化 profile，并自动开启 `browser.persistProfile`。之后**录制和定时执行都复用这个登录态**，流程里就不必包含登录步骤。

- `profile_info` 查看目录/体积/上次使用时间/是否被占用
- `profile_reset { confirm: true }` 清空登录态（换人换账号、或怀疑串号时用）
- 同一时间只允许一个执行使用该 profile（内部有全局锁，冲突时会明确报「正在被占用」）
- profile 目录 `.work/profile/` 已被 `.gitignore` 屏蔽（装机时生成）——**它等同于一份登录凭据，不要外传**

## 十二、无人值守日常

上线后只需要看「有没有问题」：

```powershell
cd <项目目录>\web-rpa-mcp\mcp
node runner.mjs status --problems     # 全流程总览；有问题时退出码 1（可直接接告警）
node runner.mjs prune                 # 预演清理历史运行记录
node runner.mjs prune --apply --logs  # 真正清理运行记录与过期日志
```

对应 MCP 工具：`status_report` / `runs_prune` / `lock_status` / `lock_release`。

> `runner status` **在「有问题」时返回退出码 1**（全部正常才返回 0），可直接接告警；
> `runner prune` 默认只预演，加 `--apply` 才真正删除。

典型的一天：早上先看 `status_report`，结论是「全部流程最近一次执行正常」就结束；有问题的流程 → `run_report { flowId }` 看失败步骤与截图 → 按《workflows/排障与自愈.md》分诊；自愈次数持续上升 → 页面在改版，安排重录；出现 **interrupted** → 上次执行被强杀/断电，确认业务是否只做了一半，必要时人工补做；提示「正在执行中」但实际没在跑 → `lock_status` 确认持有者、`lock_release` 释放过期锁；每月 `runs_prune`（默认预演）确认留存规模，需要时加 `dryRun:false` 清理。

看总览时的三种典型结论：

| 看到 | 含义 | 处理 |
|---|---|---|
| "全部流程最近一次执行正常" | 没事 | 关掉 |
| `interrupted` | 上一次执行被强杀/断电，没正常收尾 | 确认业务是否只做了一半，必要时人工补做 |
| "正在执行中" 但实际没在跑 | 锁没释放（进程被强杀） | `lock_status` 确认后 `lock_release` |

## 十三、安全红线（最高优先级，强制）

1. **不录验证码/短信码/滑块**：录到会直接判为阻断级问题。改为在流程里插入 `humanHandoff` 步骤，让人来点。
2. **不录登录态与敏感系统**：涉及权限、资金、生产库的操作一律留给人工。
3. **密码不明文落盘**：用 `secret_set` 存凭据，步骤值写 `${名字}` 并标 `sensitive: true`。
4. **破坏性操作必须确认**：删除/清空/作废类点击，静态检查会告警，执行前必须向用户二次确认。
5. **写操作防重复**：提交类点击默认不重试；同一步骤连续两次提交会被拦截告警。
6. **结果为空不算成功**：任何「空表/空列表/只有表头的导出」都判失败，除非流程显式设置 `emptyResultOk: true`。
7. **定时任务同样受上述约束**：定时跑的是同一个流程定义，阻断项不会因为无人值守而被跳过（除非显式 `allowLintErrors`）。
8. **同一流程不允许并发执行**：第二次触发会被锁挡住并记录原因，防止重复提交。
9. **profile 里存着登录态**：它是敏感文件（`.work/profile/`，已被安装器生成的 `.gitignore` 屏蔽）。不要拷给别人、不要提交；换人/换账号时用 `profile_reset` 清空。
10. **截图默认给敏感字段打码**（`security.maskFieldsInScreenshots`，默认开启）；如需原始证据图可显式关闭，但要清楚这意味着口令可能出现在图片里。

## 十四、目录与数据

```
web-rpa-mcp/
├── README.md                 本文档（合并项目说明 + 安装/使用/排障/更新记录）
├── install.mjs               安装器：依赖、浏览器探测、自检、注册 JSON、安装技能
├── demo/app.mjs              本地演示站点（端到端验证用）
├── workflows/                录制工作流 / 排障与自愈
├── references/               步骤 DSL 与断言参考 / 坑与护栏
├── flows/                    录制生成的流程定义（技能本体）
├── runs/                     每次执行的报告与截图证据
├── logs/                     运行日志与告警日志
├── 部署说明.md / 部署说明.详细版.md   部署（简明 / 完整 + 全工具使用示例）
└── mcp/                      MCP 服务器
    ├── server.mjs            44 个工具（stdio JSON-RPC）
    ├── runner.mjs            命令行执行器（任务计划调用）
    ├── selftest.mjs          全链路自检聚合器（7 套）
    ├── lib/                  browser / locators / recorder / player / lint / vars / table / notify / schedule / chain / store / secrets
    ├── page-script.js        注入页面的录制与定位辅助脚本
    └── test/                 unit / rules / mcp-protocol / tools / e2e / integration / audit
```

路径与 git 边界：

| 路径 | 内容 | 是否入 git |
|---|---|---|
| `flows/*.json` | 流程定义（技能本体，可版本管理） | 建议入 |
| `runs/` | 每次执行的报告与截图 | 不入 |
| `logs/` | 运行日志、告警日志、定时任务输出 | 不入 |
| `.work/` | 凭据密钥、加密凭据、浏览器故障缓存、定时包装器、登录态 profile | **绝对不入** |
| `web-rpa.config.json` | 配置（可能含 Webhook 地址） | 不入 |

`install.mjs` 装机时会生成 `.gitignore` 保护上述敏感路径（纯净发布包不带任何 `.` 前缀文件，敏感边界由安装器补齐）。

进一步细节：步骤 DSL/断言/变量来源 → `references/步骤DSL与断言参考.md`；踩过的坑与护栏 → `references/坑与护栏.md`；录制与回放完整流程 → `workflows/录制与回放工作流.md`；回放失败定位与修复 → `workflows/排障与自愈.md`；**全 44 工具自然语言使用示例** → 《部署说明.详细版.md》。

## 十五、常见问题 / 排错速查

| 现象 | 处理 |
|---|---|
| 录制时浏览器窗口没出现 | `doctor` 看 `browser` 字段。若首选浏览器损坏，启动层会自动降级到下一个候选并把失败的记入缓存；也可手工设 `browser.channel="msedge"` |
| `doctor` 报 playwright 不可用 | 在 `mcp` 目录 `npm install`，或复用同工作区已安装的 playwright（会自动搜索） |
| 一定要下载 Chromium 吗 | 不必。系统装了 Edge 或 Chrome 就能用（`browser.mode="auto"` 会自动挑）。Chromium 损坏时 `npx playwright install chromium` 重装 |
| 回放报「定位失败…指纹自愈也未达标」 | 页面确实改版了：`flow_show` 看是哪一步，`flow_step_delete` 删掉后用 `record_start` 只重录那一段 |
| 回放成功但结果是空的 | 还缺「结果非空」校验，`flow_assertion_add` 加 `tableNotEmpty` 或 `download(minBytes)` |
| 卡在验证码 | 该步前面插 `humanHandoff`，并用 `headed:true` 跑；无头模式会直接报错提示 |
| 日志里出现「自愈」提示 | 页面结构在变，属于预警；`run_history` 看自愈频率，频率高就重录 |
| 定时任务跑起来黑窗口一闪而过 | 任务计划调用 `.work/sched/<flowId>.cmd` 包装器，输出重定向到 `logs/schedule-<flowId>.log`。看那个日志，或 `schedule_run_now` 手工触发后 `run_history` 查结果 |
| 报「正在执行中」但没在跑 | 进程被强杀锁没释放：`lock_status` 确认后 `lock_release` |
| 能录需要登录的系统吗 | 可以，但登录态本身不要录（第二次跑会失效）。用 `profile_login` 建持久化登录态后录制/定时复用，或对登录超时用 `humanHandoff` |
| 告警没收到 / 告警能发到哪 | `notify_test` 验证 Webhook；检查 `notify_config` 的 `enabled` 与 `on`。支持企业微信/钉钉/飞书/Slack 机器人 Webhook 或任意接受 POST JSON 的地址 |
| 录错了 / 删错了 | 任何改动/删除前自动有备份：`flow_restore { flowId }` 回滚，**误删也能找回**（`flow_restore { flowId, list: true }` 列备份） |

> 真实卡住时发这三样最快定位：`node install.mjs` 完整输出、`node mcp\server.mjs --doctor` 输出、报错原文（**截图/日志注意脱敏**）。

## 更新记录

- **v1.5.10（2026-10-05）**：真实探针验证 MCP 结果结构化透出——`structuredContent` 纯增量（契约兼容）+ `outputSchema` 标「待确认」按最小化改动延后。① **`structuredContent` 纯增量透出结构化数据**：`ok()` 成功结果新增 `structuredContent` 真字段（=此前只序列化进 `content[0].text` 的同一份结构化 data），客户端（含只认结构化结果的）不必再从文本抠 JSON；`content` 文本回退**原样保留**（老客户端只读 text 零影响），`isError:false` 形状不变。② **`isError:true` 形状逐字节不变**：失败 `fail()` 不带 `structuredContent`，仍恰为 `{content, isError}`——按 `isError` 分流的客户端零影响。③ **`outputSchema`（tools/list 增 per-tool JSON Schema）标「待确认」延后**：客户端跨协议版（2024-11-05 / 2025-03-26 / 2025-06-18）如何消费不可实测确认，且 44 工具逐个精确 schema 有「臆造字段」红线风险，按「最小化改动 + 不臆造」延后，待客户端兼容面确认后再评估。**契约兼容结论：纯增量**（工具名/参数名/返回结构/isError:true 形状全不变，仅成功结果多一真字段）。自检 387 项全绿（107 单元 + 27 规则 + 24 协议 + 65 工具 + 34 端到端 + 130 集成；新增 2 项协议回归 = structuredContent 增量一致 + isError:true 形状不变）。
- **v1.5.9（2026-10-05）**：真实探针修复一处「误报连续失败」缺陷 + statusReport totalRuns 真值优化。① **连续失败不再把未定论/崩溃的运行计为失败**（误报故障类）：`status_report` 的 `consecutiveFailures` 此前把 `running`（进行中、尚未定论）与 `interrupted`（崩溃，已由 item.interrupted 单列）也当一次失败累加——真实探针实锤：上一次已完成是 pass、当前这次还在跑时报 `consecutiveFailures:1`（应 0，会误触发"连续失败 N 次"告警）；2 次真失败 + 1 次崩溃时报 3（应 2，崩溃被重复计数）。现在连续失败只数「已定论的失败」（fail/blocked），pass 即止，`running`/`interrupted` 既不计失败也不打断计数。② **totalRuns 是真实运行总数**：此前用 `listRuns(100).length` 当 totalRuns，运行超 100 次恒报 100（少报）；现在单遍枚举同时给出窗口摘要与真实总数（新增 `listRunsEx`），totalRuns 不再被 100 条摘要窗口封顶。③ `status_report` 工具描述同步更新，明确 totalRuns=真实总数、consecutiveFailures 只数已定论失败，供 agent 调用时正确解读字段。自检 385 项全绿（107 单元 + 27 规则 + 22 协议 + 65 工具 + 34 端到端 + 130 集成；新增 3 项集成 = 2 连续失败语义 + 1 totalRuns 真值）。
- **v1.5.8（2026-10-05）**：两轮收口合并发布——告警链路可信性 + 真实本地浏览器全流程实测（44 工具端到端全调用）暴露问题的修复。**告警链路可信性收口**——真实探针实锤 5 处"失败链路最后一环说谎/失踪"（含**误报成功类**：webhook 拒绝谎报送达）。① **4xx 不再谎报"已发送"**：webhook 回 4xx（429 按限流重试不变）此前直接落"告警已发送"分支返回 sent:true，notify_test 给用户显示 ✅（配错 webhook 也被骗过）；现在如实 sent:false + error 点名 HTTP 码 + permanent:true，不重试、不入箱——"4xx 不入箱"的原有意图真正生效（此前是不可达死代码）。② **发件箱毒条目不死堵箱**：补发（flushOutbox）遇永久拒绝（4xx）的条目移出发件箱并记 alerts.log dead-letter 留痕，后续积压继续补发；此前毒条目会被当"发送成功"静默丢弃（告警无声消失）。③ **发件箱滞留可见 + >24h 点名**：新增 outboxInfo()（条数/最旧一条年龄），status_report summary 增 notifyOutbox / notifyOutboxOldestAgeHours、problems 点名（最旧 ≥24h 判 error，否则 warn），doctor 同口径带年龄——积压=告警链路断了，此前无人值守视图完全看不见。④ **发件箱坏文件不灭迹**：JSON 损坏先改名 .corrupt-<ts> 保留证据再当空箱（此前被下一次入队覆盖写灭迹）；超上限 20 条丢最旧时记 warn 留痕。⑤ 补发循环内发送失败不再重复入箱（noQueue，防双写）。**真实实测修复**——⑥ **runs_prune 显式单维度语义修复（真实缺陷）**：显式只传 keepCount 或 keepDays 之一时，另一维度此前会被配置值（run.keepRunsPerFlow/keepRunDays）并进 AND 双约束——`runs_prune {keepCount:1}` 在配置 keepRunDays=30 下"超次数但未超 30 天"一条不删、静默空跑（实测 kept=4/4）；现在显式只给一个维度时另一维度按 0（不限）参与判定：只传 keepCount=保留最新 N 次删其余、只传 keepDays=保留 N 天内删其余、两者都传=AND 规则不变、都不传=按配置双约束，工具描述与 keepCount/keepDays 参数描述同步写明四种组合；新增集成用例钉死三相语义（单传 keepCount 不被配置 keepDays 稀释、单传 keepDays 对称成立、双参数 AND 规则不变）。⑦ **profile_info 提示语诚实化**：persistProfile 已开启但登录态目录为空时，此前笼统提示"已开启"（照着做回放必失败）；现在明确"已开启，但登录态目录还没有内容：先用 profile_login 人工登录一次"。自检 382 项全绿（107 单元 + 27 规则 + 22 协议 + 65 工具 + 34 端到端 + 127 集成；新增 6 项集成用例 = 5 告警链路 + 1 prune 单维度语义，另修正 1 项把"4xx 谎报送达"钉成预期的错误断言）；真实本地浏览器全链路实测 68 项用例（录制→回放→自愈→证据→定时→告警→留存→profile）全绿。

- **v1.5.7（2026-10-04）**：运行记录索引化——status_report / list_runs 的"每次总览读 N 份 report.json"变成"一次读索引"，纯性能优化，语义逐字段不变。① runs/<flowId>/index.json 作为 report.json 的**投影缓存**（{version:1, updated, runs:[摘要]}，摘要=stamp/status/startedAt/durationMs/trigger/healedCount/failedStep/error 八字段；证据源永远是报告本身，索引只决定快慢）：saveRun 落报告时同步 upsert 摘要（同 stamp 幂等覆盖、按 stamp 升序存），读侧一次 readJson 拿全部摘要；索引读写失败一律静默降级——写失败下次读时重建，绝不影响运行证据。② **自愈两集合差**：目录里有 report.json 却不在索引（存量升级/外部直写）、索引条目却没有对应目录（外部删除）、索引损坏（version 不符/非数组/坏 JSON）三种情况都整段扫描重建；fixture 直写 report.json 不经 saveRun 也必被看见（测试钉死）。③ 性能实锤（400 次运行 fixture、单报告约 3KB）：listRuns(limit=100) 5.5ms→0.7ms（7.9×）、listRuns(limit=20) 1.3ms→0.6ms、status_report 中断标记扫描 23.2ms→1.5ms（15.5×，已完结目录跳过不再逐个 stat/读 marker）；**语义快照 2767 字节逐字节一致**（判别式：stamp 倒序、中断记录按 stamp 交错排、limit 早停、无 pid marker→interrupted 全部不变）。④ pruneRuns 裁剪同步清索引条目（dryRun 不动索引），不留幽灵条目。已知边缘（可接受、有逃生口）：外部手改 report.json 后索引摘要陈旧至下次重建，删 index.json 即强制重建。自检 376 项全绿（107 单元 + 27 规则 + 22 协议 + 65 工具 + 34 端到端 + 121 集成；新增 4 项 = 运行索引同步落盘/自愈重建/裁剪清索引/中断交错排序集成用例）。

- **v1.5.6（2026-10-04）**：测试覆盖门禁 + 两处"永久挂死/静默丢录制"产品缺陷修复。① **覆盖度自检新增两组永久门禁**：「工具参数（inputSchema）」112 项、「配置键（DEFAULT_CONFIG）」39 项必须都有测试提及（词边界匹配全部测试源码；阴性验证：测试补齐前 FAIL 并点名清单）——为此前零提及的 **8 个工具参数 + 15 个配置键**逐项补真实断言（按语义最小化，不堆凑数断言）。口径说明：第 5 轮探针报 9 参数 / 18 键，本轮以门禁口径逐项核对后实测 8 / 15，以本轮为准。② **runFlow 永久挂死修复**：goto 超时后的失败收尾（截图/打码/取标题）调用 `page.evaluate`/`page.title` 这类**没有超时参数**的原语，页面卡在永不完成的导航上时会无限等（goto 超时只中止等待方，请求本身还挂在浏览器里），流程锁与 running 标记被永久占住、同流程再也跑不了；现在凡无超时参数的等待一律 `withTimeout` 有界化（超时按"没做到"降级返回：打码 3s/2s、截图 8s、标题 5s），失败收尾必在秒级返回。③ **录制器两处缺陷**：`window.__rpa.flush` 从未导出（record_stop/暂停录制的调用方静默 no-op），**停止前 700ms 防抖窗口内的填入被静默丢弃**；现在 flush 随停止提交，且 stopRecording 先提交挂起事件、再断开会话指针（事件只认活动会话，顺序不对照样丢）。目标解析到 `<html>` 的点击一个定位符都生成不出来，此前会录成「点击 (无定位符)」，回放被 L040 阻断并连坐全部步骤；现在零定位符事件不录（不是有效交互，回放必点不着）。④ 测试修复：G11 密码框选择器（demo 只有 `#pwd`）+ 录制会话失败必须释放（全局单例，泄漏会连坐后续全部录制用例）、G17 备份残件污染计数（deleteFlow 不删备份，先清残件再计数）。⑤ **TOOL_ERROR 错误回包路径脱敏（日志脱敏红线）**：工具异常的 message 与 stack 帧此前把本地安装绝对路径（`file:///D:/work/MCP/web-rpa-mcp/mcp/...`）原样回传给外部 MCP 客户端，暴露用户名与目录布局；新增 `redactPath`（包内路径保留 `mcp/` 之后相对段如 `lib/store.mjs`、其余只留文件名、`:行:列` 原样保留），TOOL_ERROR 回包、-32603 内部错误与 runner stderr（定时任务落盘日志）统一走它，回包形状不变（`{tool, code, stack}` 仍为 4 行帧）。自检 372 项全绿（107 单元 + 27 规则 + 22 协议 + 65 工具 + 34 端到端 + 117 集成；新增 29 项 = 23 参数/配置键断言 + 2 录制器回归 + 3 redactPath 单测 + 1 协议泄漏回归）。

- **v1.5.5（2026-10-04）**：配置可信性收口。真实探针实锤 3 个**死配置键**（只定义、从未被任何生产代码读取——配置里改了没有任何效果，比没有这个配置更坏）：`security.maskSecrets`、`security.redactKeys`、`run.blockSensitiveAutofill`。修复：① **`security.redactKeys` 键名脱敏接线**——参数/报告/日志/告警里命中名单的键（默认 password/passwd/pwd/token/secret/otp/captcha/code/signature/authorization，不分大小写精确匹配）值一律替换为 `***`，原值并入全文清除名单（步骤 URL/明细/告警文案同口径）；此前**没标 secret:true 的「password」类参数会明文进报告**。键名脱敏不改写 `extracted` 数据通道（`flow:` 链式取值按名查这里，回归 G7 实锤：改了会把 `***` 传给下一个流程），secret 凭据值例外——出现在 `extracted` 里也全文清除（红线）。② **`security.maskSecrets` 成为真正的脱敏总开关**（文档此前承诺"掩码参数/日志"但开关是死的）：设 `false` 只放开参数值与日志脱敏便于调试，**secret 凭据值与 webhook 回显永远打码，不受开关影响**。③ 移除死键 `run.blockSensitiveAutofill`（语义从未定义、文档从未承诺，按"不臆造行为"下线；如需运行时敏感填充拦截，明确语义后可加回）。覆盖度自检新增「配置接线（防死配置键）」组：DEFAULT_CONFIG 39 个键必须被生产代码读取（阴性验证：临时塞入死键即 FAIL），死开关从此过不了自检。自检 343 项全绿（103 单元 + 27 规则 + 21 协议 + 63 工具 + 32 端到端 + 97 集成；新增 5 单元 + 5 集成）。

- **v1.5.4（2026-10-04）**：运行状态可观测性收口。真实探针发现两类误报/不可见：① **进行中的运行被误报"中断"**——running 标记（有开始标记、报告未落）此前不判 pid 活性，任何执行中的运行都会被 `status_report` 标 `interrupted` 并报 error 级"进程可能被强杀或断电"、`run_history` 显示"进程中断"，连 `running` 都是 null；现在按标记里的 pid 判活/死（`core.pidAlive`）：**活着 = running（进行中），死了才是 interrupted（真中断）**。② **等待人工接管不可见**——`humanHandoff` 等待窗口（默认最长 3 分钟）期间总览只能看到"一场卡住的运行"，与页面卡死无法区分；现在等待期间把 `waitingHuman:{reason, startedAt, until}` 写进运行标记（接管结束即清除），`status_report` 的 item/problems（warn 级"正在等待人工接管：…"）、`summary.waitingHuman` 计数与 `run_history` 行都会透出。契约兼容（仅新增字段；`interrupted` 语义从"有标记无报告"修正为"有标记无报告且进程已死"）。自检 333 项全绿（新增 2 项集成：活 marker 活/死判别、真实接管窗口轮询）。
- **v1.5.3（2026-10-04）**：路径穿越防护（安全修复）。流程 id 与运行时间戳会拼进 `flows/`、`runs/`、`.work/locks/`、`.work/sched/` 下的文件路径，此前无任何消毒——真实探针实测 `flow_show('../web-rpa.config')` 能读出 `flows/` 之外的任意 `.json`（**含告警 webhook 配置**），`flow_save`/`flow_delete` 同理可覆盖/删除任意 `.json`，`runs_prune`/`run_history` 传穿越 id 会越出 runs 目录误动文件。现在：**`assertSafeId` 安全闸**（core）——id 需 1–128 字符，拒绝路径分隔符、Windows 非法字符 `:*?"<>|`、控制符、含 `..`、点号开头、点/空格收尾；**全部路径拼接点双闸收口**（store 的 `flowPath`/`runsFlowRoot`/`runDir`，ops 的 `runningMarkerPath`/`lockFile`/`interruptedRun`/`pruneRuns`，player 运行目录，schedule 的 `wrapperPath`/`paramsPath`/日志名）——字符规则之外再复核结果确实落在目标目录内；**入口 schema 加 `pattern`**（所有 flowId 参数、`run_report` 的 `stamp`、`runs_prune`/`lock_status` 的可选 flowId）并让 `validateArgs` 支持 pattern 校验，非法 id 在 `tools/call` 入口即报 `INVALID_ARGUMENT` 点名参数，绝不落到文件系统。中文 id、`a.b`、`latest` 等合法 id 不受影响。自检 331 项全绿（新增 13 项：单元 +9、协议 +4，含"响应不含 webhook"防泄露断言）。
- **v1.5.2（2026-10-04）**：超时判定确定性收口。**成功路径同样做收尾判定**：步骤执行成功后、断言完成后若已越过 `maxDurationMs` 总时限，一律按 `RUN_TIMEOUT` 优雅收尾（截图+报告+告警+释放锁）——修复"最后一步把运行推过预算后整场仍报 pass"的静默误报（看门狗原先只在"开新步骤前"和"步骤失败后"判定，成功压线没有判定，这是比失败更恶性的误报成功）；**未裁剪的等待收口**：`humanHandoff` 无恢复条件的固定放行（原先固定睡满 3s 不管总时限）与 `scrollTo` 的滚动间隔（原先 times×waitMs 完全不受总时限约束）现在与 `sleep` 步骤同口径——被总时限裁剪即判超时，不赌定时器精度；`humanHandoff` 轮询按自身截止点醒来（不再最多滞后 1s）。所有超时判定基于墙钟比较。自检 318 项全绿（新增 2 项集成：scrollTo 越线、人工接管固定放行越线）。
- **v1.5.1（2026-10-04）**：MCP 契约加固。**工具入参统一校验**（44 个工具在 `tools/call` 入口按各自 inputSchema 验收：类型/枚举/数值范围/必填/嵌套结构，错参数返回 `INVALID_ARGUMENT` 并点名参数路径（如 `items[1].flow`），不再流进 handler 被宽松真值判断悄悄改变安全语义）；**标量兼容转换**（LLM 客户端常把数字/布尔发成字符串，`"5000"`→5000、`"false"`→false，转换提高调用成功率，转不动才报错）；**schema 加固**（`flow_run`/`chain_run` 的 `maxDurationMs` 与 `runs_prune` 的 `keepCount`/`keepDays`/`keepVideos` 加 `minimum: 0`，`chain_run.items` 补全元素结构与 `flow` 必填声明，LLM 照 schema 写参数不再跑偏）；**语义反转修复**：此前 `headed:'false'`/`dryRun:'false'` 会被真值判断当成 true（弹出真浏览器/误删运行记录）、`maxDurationMs:-1` 被当"不限时"静默废掉看门狗——现在入口直接拦截报错；工具异常统一 `TOOL_ERROR` 编码入 fail 载荷，`isError:true` 契约不变（只把 schema 既有声明变成真验收，字符串数字/布尔属放宽兼容，无破坏性变更）。自检 316 项全绿（新增 13 项：单元 +9、协议 +4）。
- **v1.5.0（2026-10-04）**：无人值守加固二轮。**chain 子流程继承父流程剩余总时长**（父看门狗从此能拦住在子流程里跑飞的时间；`chain_run` 新增 `maxDurationMs` 整条串联总时限，用尽后剩余流程标记未执行不误跑）；**无人值守默认总超时** `run.unattendedMaxDurationMs`（默认 2 小时：定时任务未配总超时自动封顶，防卡死占锁拖到天亮；⚠️ 行为变化——超 2 小时的定时长任务请显式传 `maxDurationMs=0` 或调大该值；预算优先级：显式参数 > `run.maxDurationMs` > 无人值守兜底）；**告警发件箱**（发送彻底失败——网络断/5xx——落 `.work/notify-outbox.json` 留 20 条，网络恢复后下次任何告警发送前按序自动补发，不再静默丢告警；4xx 配置类错误不入队）；`doctor` 新增**录像能力探测**（Playwright 自带 ffmpeg 有无/路径）并提示未配总超时与积压发件箱；`runs_prune` 新增 **keepVideos 录像留存**（默认每流程只留最近 20 段 webm，按 mtime 留新删旧，只动录像不碰报告截图）；chain 步骤的 allowLintErrors 口径级联到子流程；**超时判定确定性修复**（睡眠被总时限裁剪即判定超时——Windows 定时器会提前几毫秒醒，修复"明明裁剪过等待的运行偶尔误报成功"）。自检 303 项全绿（新增 13 项：单元 +7、集成 +6）。
- **v1.4.0（2026-10-04）**：无人值守加固。新增**运行级总超时看门狗** `run.maxDurationMs`（默认 0=不限；到期优雅收尾：留证截图+报告+告警+释放锁，步骤等待/重试/人工接管窗口都被总时限收紧，`flow_run` 可按次传 `maxDurationMs`）；新增**失败录像证据** `run.saveVideo` + `run.videoOn`（Playwright 录像，失败保留 webm、成功默认删除省空间，缺录像能力自动降级并注明，含敏感输入的流程自动跳过录像防泄密，报告/CLI/告警/`flow_run` 均带录像清单）；**告警发送自动重试**（网络抖动/5xx/429 退避重试 2 次，4xx 不重试，失败也落 alerts.log）；`status_report` 定时预期按频率精算（分钟/小时/日/周/月各按自身间隔判"该跑没跑"，once/logon 不再误报）；持久化 profile 启动失败不再污染浏览器启动失败缓存（不再连累普通回放 7 天）；`run_history`/`status_report` 大运行目录早停（只读最新 N 条）。自检 290 项全绿（新增 15 项：单元 +5、集成 +10）。
- **v1.3.1（2026-10-04）**：全链路检查后的健壮性优化。并发锁改为独占创建（消除"定时任务与手工运行同一毫秒撞车仍可能双双拿到锁"的竞态窗口，这是防重复提交的核心保证）；`installHelpers` 幂等化（`goto newTab` 不再向整个浏览器上下文堆积重复注入脚本）；自愈定位符回写流程文件前自动备份（补齐"任何改动前自动备份"的承诺，误回写可 `flow_restore` 回滚）；`newContext` 失败时回收已启动的浏览器进程（防泄漏）；`schedule_add` 对 `once` 任务做时刻已过/格式预检（不再报难懂的 schtasks 系统错误）；`doctor` 显示"启动失败被缓存跳过"的浏览器及清除方法。自检 275 项全绿。
- **v1.3.0（2026-10-03）**：44 个 MCP 工具全量实测；新增片段重录 `record_splice_start` 与备份回滚 `flow_restore`（任何改动/删除前自动备份，误删可找回；备份每流程留 10 份、30 天）；录制器多标签修复（主录制页误判、主页面关闭后标签页接替、副标签跳转不误记新标签、尾部 goto 不再误删）；空结果守卫与自愈实测通过；自检 269 项全绿（`node selftest.mjs` 一键跑，支持按套件/按组过滤）；发布口径改为纯净分发包零预装依赖（无 `node_modules`、无 `.` 前缀文件/目录，依赖由命令生成，`.gitignore` 装机时生成），新增《部署说明.md》《部署说明.详细版.md》。
