---
name: web-rpa-mcp
description: 当需要把每天重复的一串网页操作（点菜单、填日期、导出报表、粘贴单号、提交）变成可一键或定时复跑的自动化技能时使用——覆盖「演示一遍即生成技能」的录制、可审阅步骤清单、日期与 Excel 单号等变量化、无头回放、结果非空校验与截图留证、页面改版后的定位自愈、Windows 定时与失败告警、多流程串联。也适用于排查已录制技能的回放失败（元素找不到、生成空报表、验证码卡死、重复提交）。不适用于：需要人工验证码/短信码且无人接管的场景，以及任何绕过目标系统权限控制的用途。
---

# web-rpa-mcp — 网页操作录制与回放技能（内置 MCP）

> 内置 MCP 服务器（stdio / JSON-RPC 2.0，44 工具）· 自检 7 套全链路（单元 / 规则 / 协议 / 工具 / 端到端 / 集成 / 覆盖度审计，项数以当日实测为准）· 版本以 `mcp/package.json` 与握手 serverInfo 为准 · 安装见 《README.md》

## 一、它解决什么问题

把「路径每次都一样」的重复网页操作，做成一个会看屏幕、会点按钮的技能：**你做给它看一遍，以后它替你点**。

```
以前                                    现在
打开 A 系统 → 点报表 → 导出            自动打开，自动点
打开 B 系统 → 粘贴 → 提交               自动填，自动交
自己核对两遍                            跑完截图给你看，结果为空直接报警
```

它不是一个宏，而是「录制 + 变量 + 回放 + 结果校验」的闭环。

## 二、能力总览

| 能力 | 说明 | 对应工具 |
|---|---|---|
| 录制 | 打开可见浏览器，把人工演示的点击/填写/选择/勾选/按键/跳转/上传/下载/**hover 展开的菜单**记录成步骤 | `record_start` / `record_status` / `record_stop` |
| iframe | 内嵌页面里的元素照常录，自动带上 iframe 选择器链；文字/表格断言默认跨框架扫描 | 录制/回放/断言全链路 |
| 运行总览 | 一眼看全部流程的健康度：最后状态、连续失败次数、是否中断/正在执行、自愈趋势、定时配置 | `status_report` / `lock_status` |
| 无人值守护栏 | 并发锁防重复提交、弹窗不静默、留存自动清理、崩溃可检测、截图脱敏 | `runs_prune` / `lock_release` |
| 登录态复用 | 人工登录一次（扫码/短信/账密都行），登录态存进持久化 profile，之后无人值守直接复用，不用再登 | `profile_login` / `profile_info` / `profile_reset` |
| 步骤清单 | 人类可读的清单，录完先自己看一遍；可删/改/移某一步，不必整段重录 | `flow_show` / `flow_step_delete` / `flow_step_update` / `flow_step_move` |
| 变量 | `${today:YYYYMMDD}` 等内置日期；`excel:文件#列@行` 取 Excel 单号；env/secret/串联取值 | `flow_param_add` / `flow_param_remove` / `record_stop` 自动识别 |
| 回放 | 无头或多窗口执行；可重试；提交类点击不盲目重试（防重复提交） | `flow_run` |
| 结果校验 | 断言 + 「空结果不算成功」兜底；识别「暂无数据」占位行与只有表头的导出文件 | `flow_assertion_add` / `flow_run` |
| 截图取证 | 失败自动截当前屏，结束时整页截图，全部落进运行报告 | `flow_run` 自动 |
| 定时 | 注册 Windows 任务计划，每天定点自动跑，失败即告警 | `schedule_add` / `schedule_list` / `schedule_run_now` |
| 告警 | 企业微信/钉钉/飞书/Slack/通用 Webhook；含失败步骤、校验明细、自愈提示、报告路径 | `notify_config` / `notify_test` |
| 串联 | 取数 → 填表 → 发邮件 一条线跑完，前一步提取值传给后一步 | `chain_run` |
| 浏览器插件控制台 | 可选控制面：网页悬浮球（所有网页常驻，🎬 录当前页/⏹ 结束/🔁 重播/👁 查看步骤/⚙ 管理）+ /console 全窗口网页版（六页签 + live 进度）；走本地桥接调同一批 44 工具，见「五之三」 | `node mcp/bridge.mjs` + `extension/` |

### 超出原始需求的强化（都是踩过的坑换来的）

- **自愈定位符**：每步存 10 种定位策略 + 元素指纹。策略全失效时按指纹打分兜底，命中后把新定位符**回写进流程文件**，下次直接命中。
- **改版预警**：预检与回放都会报告「哪一步降级命中」，页面改版在出空报表之前就暴露。
- **静态检查**：把验证码/短信码/密码明文、缺结果校验、未声明变量、脆弱选择器、硬编码日期、重复提交、下载缺路径、非网页地址、env 参数在定时下取不到等做成 **26 条规则**，阻断级问题**拒绝执行**。
- **敏感步骤拦截**：密码值不落盘；验证码步骤要求改成人工接管，否则报错而不是卡死。
- **浏览器启动自愈**：候选浏览器逐个探测，启动失败的记入缓存自动跳过（实测：本机自带 Chromium 损坏，已自动改用系统 Edge）。
- **凭据加密**：AES-256-GCM 本地密钥文件；报告/日志/告警落盘前**整体脱敏**，敏感值一律替换为 `***`。
- **iframe 原生支持**：注入脚本在所有 frame 中运行，iframe 内元素带链录制；断言默认跨框架扫描。
- **hover 菜单识别**：空闲态基线 + 容器级判定，纯 CSS `:hover` 揭层的下拉菜单也能录进来（实测最容易漏的一类）。
- **内置页拦截**：`edge://` / `chrome://` / `about:` / `devtools://` 不会被录成步骤；万一混进去，静态检查 **L002 阻断执行**。
- **并发锁**：同一流程被定时任务与手工同时触发时，第二次直接跳过并说明原因——避免**重复提交业务数据**。
- **弹窗不再静默失败**：`alert/confirm` 会被记录并按流程意图接受/取消；**没被流程处理的弹窗自动判失败**（confirm 被取消＝操作没生效，却看起来"跑成功了"）。
- **崩溃可检测**：每次执行先写开始标记，收尾再删；被强杀/断电会留下标记，`status_report` 与 `run_history` 会明确报 **interrupted**。
- **留存自动清理**：默认每流程保留最近 50 次且 30 天内，自动清理历史；也可用 `runs_prune` 预演后手工清理。
- **截图脱敏**：截图前把密码框等敏感字段打码，避免证据图里泄露口令。
- **日期偏移**：`${today-7:YYYYMMDD}`、`${today+1}` 等，覆盖"上周同期/昨天"这类报表口径。
- **滚动加载支持**：`scrollTo` 步骤（可重复到页底）用于无限滚动列表；Shadow DOM（开放影子根）实测可录制可回放。
- **登录态持久化**：`profile_login` 打开可见浏览器让人工登录一次，登录态写入持久化 profile；之后所有执行（含定时任务）复用同一用户目录，**需要登录的内部系统终于能无人值守**。profile 同一时间只允许一个执行使用（内部自带全局锁），`profile_reset` 可随时清空。
- **配置可撤销**：`config_set` 里把某项设为 `null` 即"恢复默认"，不会再出现"设过一次就再也改不回去"。
- **无表头格式正确处理**：`.txt` 逐行文本、标量 JSON 数组不再被当成"有表头"而吞掉第一个值（`excel:/csv:/table:` 取值同样受益）。
- **覆盖度自检**：`node test/audit.mjs` 会检查每个工具/步骤/断言/规则/命令是否都有测试，任何"没人用过的能力"都会让它失败（曾借此发现 L061 是永远触发不了的死代码）。
- **浏览器插件控制台**（可选，零 MCP 改动）：悬浮球 + /console 网页版通过本地桥接（`node mcp/bridge.mjs`，默认 127.0.0.1:8317）调用同一批 44 工具；带 token 鉴权（`WEBRPA_BRIDGE_TOKEN`）、录制器被其他会话占用时只观察不干预的防护、回放 live 进度面板。详见「五之三」。

## 三、快速开始（三步）

1. **录**：`record_start { url: "https://a.example.com" }` → 在刚打开的浏览器里慢一点操作一遍（每步停半秒）→ `record_stop { name: "订单日报导出" }`
2. **审**：看 `record_stop` 返回的步骤清单和 lint 结果；有阻断项先修（补断言、把验证码那步换成 `humanHandoff`、声明参数）
3. **跑**：`flow_run { flowId: "订单日报导出" }`；确认稳定后 `schedule_add { flowId: "订单日报导出", at: "09:00" }`

## 四、MCP 工具速查（44 个）

```
record_start  record_status  record_stop  record_splice_start  record_cancel
flow_list  flow_show  flow_lint  flow_rename  flow_delete
flow_param_add  flow_param_remove
flow_assertion_add  flow_assertion_remove
flow_step_delete  flow_step_update  flow_step_move
flow_export  flow_import  flow_restore
flow_run  flow_preflight  run_history  run_report  chain_run
status_report  runs_prune  lock_status  lock_release
schedule_add  schedule_list  schedule_remove  schedule_run_now
notify_config  notify_test
secret_set  secret_list  secret_delete
profile_login  profile_info  profile_reset
config_get  config_set  doctor
```

## 五、使用工作流（Agent 调用规范）

1. **先自检**：`doctor` 确认 playwright 与浏览器可用；首次使用先跑 `install.mjs`。
2. **要登录的系统先建登录态**：如果目标系统需要登录，**先** `profile_login { url, successText }` 让人工登录一次；之后录制与定时执行都会复用这个登录态，流程本身就不必包含登录步骤。
3. **先问清流程**：录之前先和用户核对「哪些步骤路径固定、哪些值是每次变的」（日期/单号/环境），并**明确告知：验证码、短信码、登录态、敏感系统不要录进来**。
4. **录制**：`record_start` 后必须**让用户亲手操作**，不要自己代点（除非用户要求）。用户说操作完了，再 `record_stop`。
5. **审清单**：把 `record_stop` 的步骤清单原文呈现给用户确认——特别是「有没有多点/少点某一步」（文章原话：录的时候手滑点错，AI 会忠实学会错误路径）。
6. **补变量**：把每次会变的值改成参数（`flow_param_add`），能落 Excel 的用 `excel:文件#列@行`。
7. **补校验**：`flow_lint` 若报 L010（缺结果校验），用 `flow_assertion_add` 补。导出类流程必须有「非空」校验。
8. **回放**：先 `flow_preflight` 做非破坏性定位预检，再 `flow_run`。
9. **上线**：`schedule_add` 定时 + `notify_config` 配 Webhook，再 `notify_test` 验证告警链路。
10. **看护**：定期 `run_history` 看自愈次数；自愈次数上升说明页面在改版，该重新录制了。

### 录错了 / 删错了怎么办

- **只错中间几步，不想整条重录**：`record_splice_start { flowId, from, to }` —— 它先把第 1~from-1 步真实重放一遍，把页面带到出错那一步之前的状态；你只把 from~to 步重做一遍，`record_stop` 自动拼回流程（`keepSuffix: false` 可丢掉后面的旧步骤）。中途反悔就 `record_cancel`，原流程一字不动。
- **误删 / 改坏流程**：任何改动（改名、增删参数/断言/步骤）与删除前都会自动留备份（每流程最多 10 份、保留 30 天）。`flow_restore { flowId }` 回滚到最近一次；`flow_restore { flowId, list: true }` 看全部备份；**误删的流程也能用 `flow_restore` 找回**。

## 五之二、无人值守日常（跑起来之后看什么）

上线之后真正要做的只有一件事：**看有没有问题**。

```
status_report                 # 全流程总览：健康/需关注、连续失败、中断、正在执行、自愈趋势
status_report { onlyProblems: true }
```

典型的一天：

1. 早上先看 `status_report`：结论是"全部流程最近一次执行正常"就结束，不用点开任何东西。
2. 有问题的流程 → `run_report { flowId }` 看失败步骤与截图 → 按《workflows/排障与自愈.md》分诊。报告里的 `budgetOverrunMs>0` 表示该次运行越过了 `run.maxDurationMs` 总时限（计时含 profile 锁等待与浏览器启动，越线幅度在收尾开销量级属正常）；`timedOut:true` 才是"被总时限拦停"。`launchMs` 是该次启动耗时（含 profile 锁等待与浏览器启动，未启动无此字段）——越线时它占 `durationMs` 大头=启动慢，远小于越线=步骤慢。
3. 自愈次数持续上升 → 页面在改版，安排重录，不要等它彻底失效。
4. 出现 **interrupted** → 上一次执行是被强杀/断电中断的；确认业务是否只做了一半，必要时人工补做。
5. 提示"正在执行中"但实际没在跑 → `lock_status` 确认持有者，`lock_release` 释放过期锁。
6. 每月 `runs_prune`（默认预演）确认留存规模，需要时加 `dryRun:false` 清理。

配套命令（任务计划之外的手工入口）：

```powershell
node mcp\runner.mjs status --problems     # 总览，有问题时退出码 1（可直接接告警）
node mcp\runner.mjs prune                 # 预演清理
node mcp\runner.mjs prune --apply --logs  # 真正清理运行记录与日志
```

## 五之三、浏览器插件控制台（可选控制面，零 MCP 改动）

不想敲命令/等 Agent 时，用浏览器控制全部 44 个工具：本地零依赖桥接把 MCP 暴露成 HTTP，`extension/` 目录的 MV3 插件（或不装插件直接开 `/console` 网页版）通过它操作。

```powershell
node mcp\bridge.mjs    # 第 1 步：启动本地桥接（默认 127.0.0.1:8317，只监听本机）
# 第 2 步（二选一）：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 extension/ 目录
#                 或：浏览器打开 http://127.0.0.1:8317/console（网页版，全窗口自适应 + 可缩放）
```

- **网页悬浮球**：所有 http/https 页面常驻可拖拽猫耳球——🎬 一键录制当前页 / ⏹ 结束保存 / 🔁 重播刚生成的技能 / 👁 查看步骤（行内 stepLabel 清单）/ ⚙ 管理（重命名/删除）/ ▶ 快速回放最近流程；录制中球体脉冲 + 步数角标。
- **插拔式双模（v1.20.0 起，v1.21.1 增强）**：桥接未连接时自动落**独立模式**（面板模式徽章 + 控制台「运行模式」横幅）——本地录制（content 直接捕获当前页 click/input/change/hover/press，密码框不录；a[href] 跨页点击识别为 goto 步）/ 本地回放（**同源跨页自动续播**：goto 与**表单提交类点击**均预存续播、新页面 content script 接续，submit 场景 1.5s 未导航自清防误触发；跨源诚实停止）/ 本地流程管理、导出与**导入**（本地/MCP 格式均可）；本地流程可一键「升级到 MCP」（映射 goto+click/fill DSL → flow_import）与「从 MCP 导入」（反向映射）形成双向闭环。下载/弹窗/iframe/定时告警仍需桥接。验证：`node verify/standalone.mjs`（15 用例）+ `node verify/ui-ext.mjs --quick`（16 用例）+ 总入口 `node verify/all.mjs --quick`。
- **/console 六页签**：状态（doctor/status_report + **▶ 运行中回放 live 进度**：进行中流程的触发方式/pid/已运行时长/等待人工接管，3s 轮询）/ 录制 / 流程（含结构化编辑器）/ 定时 / 系统 / 控制台（任意工具原始调用）。
- **安全**：桥接只绑 127.0.0.1 + Host/Origin 校验，零 CORS 放行头；可选 token 鉴权（启动 `WEBRPA_BRIDGE_TOKEN=令牌 node mcp/bridge.mjs`，插件设置页或 `/console?token=令牌` 配对）。**不要把 8317 转发到公网**。
- **录制器单例**：全局同时只允许一个录制会话；被其他会话占用时，悬浮球与 /console 录制页**只显示只读提示、不提供结束/取消**（防误结束他人录制）。
- 完整功能与工具对照见仓库 `extension/README.md`（装机副本可能不含 extension/，以仓库为准）。
- **改扩展后回归**：仓库 `verify/ui-ext.mjs`（`node verify/ui-ext.mjs`，约 3-4 分钟；`--quick` 约 2 分钟）覆盖插件 UI 全链路（/console 全页签 + 悬浮球录制/重播/查看/管理/重录表单/右键菜单/拖拽/隐藏/live 进度），需桥接运行中、自动用隔离实例避开录制器占用。
- **全量验证总入口**：`node verify/all.mjs`（`--quick` 跳过 selftest 与 live-fulltest 且 ui-ext 用 --quick）一条命令顺序跑完六套电池——自检 427 项 / MCP 44 工具 68 链路（live-fulltest）/ /console 全按钮清扫（button-sweep，32 用例含安全分级跳过清单与 splice 执行闭环）/ 扩展 UI 回归（**默认完整版 17 含 live 长流程**）/ 双模（standalone 15 用例）/ 点名链条（fullchain 8 用例）；失败自动重试一次（时序竞态类兜底）；**收尾电池残件自密封**（自动清理测试前缀 runs/backups/live-report.json——绝不碰用户与外部流程，防门禁哈希污染）+ 残件自检行；末尾汇总表 + 非零退出码可接告警；顺序执行防跑批互踩。另有 **verify/journey.mjs**（新用户插拔旅程 8 环：开箱独立→本地录制/👁/回放→插桥升级→依赖重播→拔桥回落）单独跑。

## 五之四、外部真实网站回放规范（实测教训）

对**有风控的外部真实网站**（gitee/企微文档类）回放时，以下四条是真实踩坑换来的：

1. **回放必须 `headed: true`**：无头（headless）浏览器特征会被目标站风控拦截——实测 gitee.com 在 headless 下定位步骤报「定位失败且无指纹可用于自愈」，同一 headed 真实浏览器稳定 pass（8.8s/轮，多轮一致）。内部系统无风控时无头照旧更快。
2. **title/url 断言用页面真实大小写与格式**：断言 `contains` 是大小写敏感的——实测 gitee 仓库页真实标题是 `CalvinMCP: mcp仓库`（与 URL slug `calvin-mcp` 大小写不一致），写错即判失败（断言正确工作，不是产品 bug）。录完先 `run_report` 或浏览器标签确认真实标题再写断言。
3. **`waitFor` 的 text 策略对动态 SPA 不可靠时用 sleep 兜底**：复杂 SPA 渲染的文本节点在不同加载阶段可见性不一致，text 定位可能失败；`sleep`（如 3500ms）等渲染完成是更稳的等待方式。多轮稳定性测试优先 sleep。
4. **点击类交互可能被风控重定向，优先 URL 导航型流程**：实测 gitee 会把 Playwright 可信点击的导航 tab 重定向到首页（JS `a.click()` 与 URL 直接访问均不受影响，探针复现 2/2），失败现场只看「定位失败」会误判为页面改版。外部风控站的回放流程优先用 goto 链导航 + `url` 断言兜底（偏离起始地址即失败）；失败报告的 `attribution` 字段会对此类「最终 URL 偏离 + 含点击步」的失败自动给出「疑似风控重定向」提示。

## 六、安全红线（最高优先级，强制）

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

## 七、排错速查

| 现象 | 处理 |
|---|---|
| `doctor` 报 playwright 不可用 | 在 `mcp` 目录 `npm install`，或复用同工作区已安装的 playwright（会自动搜索） |
| 所有浏览器启动失败 | `npx playwright install chromium`；或在 `web-rpa.config.json` 设 `browser.channel="msedge"` |
| 回放报「定位失败…指纹自愈也未达标」 | 页面确实改版了：`flow_show` 看是哪一步，`flow_step_delete` 删掉后用 `record_start` 只重录那一段 |
| 回放成功但结果是空的 | 说明还缺「结果非空」校验，`flow_assertion_add` 加 `tableNotEmpty` 或 `download(minLines:2)` |
| 卡在验证码 | 该步前面插 `humanHandoff`，并用 `headed:true` 跑；无头模式会直接报错提示 |
| 日志里出现「自愈」提示 | 页面结构在变，属于预警；`run_history` 看自愈频率，频率高就重录 |
| 定时没跑 | `schedule_list` 看下次运行时间与上次结果；`schedule_run_now` 手工触发验证链路 |
| 告警没收到 | `notify_test` 验证 Webhook；检查 `notify_config` 的 `enabled` 与 `on` |
| 无头模式跑不动需登录的流程 | 用持久化登录态（`profile_login` 建一次；配置键 `browser.persistProfile` / `browser.profileDir`）或改 `headed:true` 由人工接管 |

## 八、目录结构

```
web-rpa-mcp/
├── SKILL.md                  本文档
├── README.md                 安装 / 验证 / 用法 / 排障
├── install.mjs               安装器：依赖、浏览器探测、自检、注册 JSON、安装技能
├── demo/app.mjs              本地演示站点（端到端验证用）
├── flows/                    录制生成的流程定义（技能本体）
├── runs/                     每次执行的报告与截图证据
├── logs/                     运行日志与告警日志
├── workflows/                录制工作流 / 排障与自愈
├── references/               步骤 DSL 与断言参考 / 坑与护栏
└── mcp/                      MCP 服务器
    ├── server.mjs            44 个工具（stdio JSON-RPC）
    ├── runner.mjs            命令行执行器（任务计划调用）
    ├── lib/                  browser / locators / recorder / player / lint / vars / table / notify / schedule / chain / store / secrets
    ├── page-script.js        注入页面的录制与定位辅助脚本
    └── test/                 unit / rules / mcp-protocol / tools / e2e / integration / audit 七套自检
```

进一步细节：
- 步骤 DSL、断言类型、变量来源 → `references/步骤DSL与断言参考.md`
- 踩过的坑与对应护栏 → `references/坑与护栏.md`
- 录制与回放的完整操作流程 → `workflows/录制与回放工作流.md`
- 回放失败的定位与修复 → `workflows/排障与自愈.md`
