# 天璇驭页 · PagePilot — 网页操作录制与回放（内置 MCP）

> 天璇驭页 · PagePilot · 版本 **1.0.7** · 内置 MCP `1.0.7` · **45 个工具** · 纯净零依赖分发（运行时只用 Node 标准库；playwright 由运行时自动探测，缺失时按需安装）· 浏览器插件控制台（extension/ + 本地桥接）

把重复的网页点击**录成技能**，之后一键或定时复跑。它由两层组成：`SKILL.md` 等**技能层**（让客户端/大模型知道「何时用、怎么用、红线是什么」）+ `mcp/` **服务层**（MCP 服务器，stdio / JSON-RPC 2.0，45 工具）。

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
- **登录态持久化 / 配置可撤销 / 无表头格式**：`config_set` 把某项设为 `null` 即「恢复默认」；`.txt` 逐行文本、标量 JSON 数组不再吞掉第一个值。

## 三、环境要求

- Windows（定时功能依赖任务计划程序 `schtasks`；录制与回放本身跨平台）
- Node.js >= 18.17（开发机实测 v24）
- 一个可用的浏览器：自带 Chromium、系统 Edge 或 Chrome 任选其一

## 四、安装

```powershell
cd <项目目录>\pagepilot-mcp
node install.mjs
```

安装器会依次完成：
1. 检查 Node 版本
2. 建立 `flows/ runs/ logs/ .work/` 目录，并生成 `.gitignore`（纯净发布包不带 `.` 前缀文件，敏感路径边界由安装器补齐）
3. 生成默认 `pagepilot.config.json`（已存在则跳过）
4. 解析 playwright；缺失时自动 `npm install playwright --no-package-lock`（纯净包零声明依赖；也会自动搜索同工作区/DSH profile 里现成的 playwright）
5. 探测可用浏览器并打印实际会用的那个
6. doctor 自检（playwright / 浏览器 / 目录 / 定时与告警状态）
7. **自动注册 MCP 客户端**：Claude Code（CLI / `~/.claude.json`）、Claude Desktop、Cursor、Windsurf、VS Code Copilot——合并式写入不破坏既有条目，原配置首次备份 `*.bak-pagepilot-mcp`，写后回读验证；`--no-register` 跳过
8. **打印 MCP 注册 JSON** 并落盘 `mcp-register.example.json`（其他客户端复制即用）
9. 把 SKILL.md / workflows / references 复制到技能目录

发布包是**纯净分发包**（零预装依赖、不含任何 `.` 前缀文件/目录、不含凭据与生成物、不含 flows/ 测试残件流程）：`mcp/node_modules` 由第 4 步命令生成（也可 `cd mcp; npm install playwright --no-package-lock` 手工装）。部署完整指引见《部署说明.md》（最短路径 / 配置 / 安全 / 排错 / 升级 / 全工具使用示例）。

可选参数：

| 参数 | 作用 |
|---|---|
| `--no-skill` | 不复制到 `~/.claude/skills` 与 `~/.agents/skills` |
| `--no-register` | 跳过自动注册 MCP 客户端（只打印注册 JSON） |

## 五、注册 MCP

```json
{
  "mcpServers": {
    "pagepilot": {
      "command": "node",
      "args": ["<项目目录>\\pagepilot-mcp\\mcp\\server.mjs"]
    }
  }
}
```

各客户端位置：
- Claude Code：`claude mcp add pagepilot -- node "<项目目录>\pagepilot-mcp\mcp\server.mjs"` 或项目 `.mcp.json`
- Claude Desktop：`%APPDATA%\Claude\claude_desktop_config.json`
- Cursor：`~/.cursor/mcp.json`

**注册后必须重启客户端。**

## 六、验证

```powershell
cd <项目目录>\pagepilot-mcp\mcp
node server.mjs --doctor     # 环境自检：Node / playwright / 浏览器 / 目录 / 定时与告警状态
node server.mjs --tools      # 列出 45 个工具
node runner.mjs list         # 已录制的流程
node bridge.mjs              # 启动本地桥接（127.0.0.1:8317，供浏览器插件控制台调用）
```

纯净版不随包附带测试套件（测试属开发期产物）。手工验证路径：`doctor` 确认环境 → `record_start` 录一个流程 → `flow_run` 回放核对；浏览器插件控制台加载 `extension/` 后在悬浮球 / `/console` 直接操作。

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
cd <项目目录>\pagepilot-mcp\mcp
node runner.mjs run 订单日报导出 --params 日期=2026-09-30
node runner.mjs run 订单日报导出 --headed          # 需要人工接管验证码时
```

退出码：`0` 成功 / `1` 失败 / `2` 被阻断 / `3` 用法错误。

## 八、MCP 工具速查（44 个）

> 完整参数与**自然语言使用示例（覆盖全部 45 工具）**见《部署说明.md》；此处列名称与关键参数供速查。`*` 为必填。

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

### 自然语言使用示例（速查）

> 每工具一行，模块分类与《部署说明.md》「自然语言使用示例」一致；**完整场景展开只在《部署说明.md》一处**。

**录制**
| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「A 系统每天要导出订单日报，帮我录下来」 | `record_start` `{url, name}` | 打开可见浏览器，开始录制你的演示 |
| 「现在录到第几步了？有没有敏感值？」 | `record_status` | 已记步骤与敏感值/验证码提醒 |
| 「我操作完了，生成技能」 | `record_stop` `{name}` | 技能 + 可审阅步骤清单 + lint 结果 |
| 「第 5~7 步点错了，只重录这几步」 | `record_splice_start` `{flowId, from, to}` | 只替换出错片段，其余步骤不动 |
| 「不录了，取消」 | `record_cancel` | 丢弃本次录制，原流程一字不动 |

**流程管理**
| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「我都有哪些流程？」 | `flow_list` | 全部流程清单（步骤/参数/断言数） |
| 「『订单日报导出』到底录了什么？」 | `flow_show` `{flowId}` | 完整步骤清单（含变量/断言） |
| 「有没有要补的？」 | `flow_lint` `{flowId}` | 26 条规则静态检查结果 |
| 「改个好认的名字」 | `flow_rename` `{flowId, name}` | 只改显示名，定时与记录不受影响 |
| 「导出一份进 git / 换机器」 | `flow_export` `{flowId}` | 流程定义 JSON（可入库/迁移） |
| 「这是我导出的流程 JSON，导进来」 | `flow_import` `{flow, overwrite}` | 流程在本机恢复可用 |
| 「这个流程不要了，删掉」 | `flow_delete` `{flowId}` | 删除流程与运行记录索引（删前有备份） |
| 「删错了 / 改坏了，找回来」 | `flow_restore` `{flowId, list}` | 回滚到最近备份，误删也能找回 |

**变量与断言**
| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「日期和单号每次变，做成变量；单号从 Excel 取」 | `flow_param_add` `{name, source, default}` | 声明变量，步骤里用 `${名}` 引用 |
| 「『单号』变量不要了」 | `flow_param_remove` `{name}` | 删除变量 |
| 「导出完确认结果不是空的，空了报警」 | `flow_assertion_add` `{kind, min/minBytes}` | 空表/空文件判失败并告警 |
| 「第 1 条断言删掉」 | `flow_assertion_remove` `{index}` | 删除第 n 条断言 |

**步骤编辑**
| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「第 3 步删掉」 | `flow_step_delete` `{index}` | 删除录错的那一步 |
| 「第 6 步标成会下载文件 / 换成变量」 | `flow_step_update` `{index, patch}` | 局部改一步，不整条重录 |
| 「把第 6 步挪到第 2 步前面」 | `flow_step_move` `{from, to}` | 调整步骤顺序 |

**执行与报告**
| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「先确认定位没坏再跑」 | `flow_preflight` `{flowId}` | 非破坏性预检 + 改版预警 |
| 「正式跑一次『订单日报导出』」 | `flow_run` `{flowId, params}` | 回放 + 断言 + 截图证据 |
| 「把『取数→填表→发邮件』串成一条线」 | `chain_run` `{items[]}` | 串联执行，前一步取值传后一步 |
| 「最近跑得怎么样？」 | `run_history` `{flowId, limit}` | 历史执行记录 |
| 「把那次的完整报告给我」 | `run_report` `{flowId, stamp}` | 某次完整报告（默认最新） |
| 「全部流程健康度看下」 | `status_report` `{onlyProblems}` | 全流程健康总览 |
| 「只留最近 30 天，先预演看看」 | `runs_prune` `{keepDays, dryRun}` | 清理预演，确认后才真删 |

**锁 / 定时 / 告警 / 凭据 / 登录态 / 配置**
| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 「说正在执行但没在跑？」 | `lock_status` `{flowId}` | 谁持锁、从何时、是否过期锁 |
| 「锁没释放，强制放掉」 | `lock_release` `{flowId}` | 释放过期锁（先确认没在跑） |
| 「每天早上 9 点自动跑」 | `schedule_add` `{flowId, frequency, at}` | 注册 Windows 定时任务 |
| 「先手工触发一次试试」 | `schedule_run_now` `{flowId}` | 走任务计划立即跑一遍 |
| 「都定了哪些定时？」 | `schedule_list` | 定时任务与系统实际状态 |
| 「这个定时不要了」 | `schedule_remove` `{flowId}` | 删除定时任务 |
| 「跑失败发企业微信群并 @我」 | `notify_config` `{type, webhook, on, mention}` | 告警配置（不传参＝查看） |
| 「发条测试告警试试」 | `notify_test` `{message}` | 验证 Webhook 通不通 |
| 「口令加密存起来，别明文落盘」 | `secret_set` `{name, value}` | AES-256-GCM 加密落盘，不回显 |
| 「存了哪些凭据？」 | `secret_list` | 凭据名称列表（不含值） |
| 「旧凭据删掉」 | `secret_delete` `{name}` | 删除指定凭据 |
| 「这系统要登录，帮我存登录态」 | `profile_login` `{url, successText}` | 人工登录一次，长期复用 |
| 「登录态还在吗？」 | `profile_info` | 目录/体积/上次使用/占用情况 |
| 「换人了，清空登录态」 | `profile_reset` `{confirm:true}` | 清空持久化登录态 |
| 「现在配置是什么？」 | `config_get` | 读全部配置段 |
| 「回放改成有头模式」 | `config_set` `{patch}` | 合并式改配置（`null`＝恢复默认） |
| 「环境有没有问题？」 | `doctor` | 浏览器/依赖/目录/录像/发件箱自检 |

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

`pagepilot.config.json`（合并式覆盖，不需要的字段可以不写）：

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
  "schedule": { "taskPrefix": "PagePilot" }
}
```

用 `config_get` / `config_set` 读写，不必手改文件。`config_set` 里把某项设为 `null` 即「恢复默认」。完整字段语义（含 `run.maxDurationMs`/`unattendedMaxDurationMs`/`saveVideo`、`security.redactKeys`/`maskSecrets`、`run.keepVideosPerFlow` 等）见《部署说明.md》「五、配置管理（pagepilot.config.json）」。

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
cd <项目目录>\pagepilot-mcp\mcp
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
pagepilot-mcp/
├── README.md                 本文档（合并项目说明 + 安装/使用/排障/更新记录）
├── install.mjs               安装器：依赖、浏览器探测、自检、注册 JSON、安装技能
├── demo/app.mjs              本地演示站点（端到端验证用）
├── workflows/                录制工作流 / 排障与自愈
├── references/               步骤 DSL 与断言参考 / 坑与护栏
├── flows/                    录制生成的流程定义（技能本体）
├── runs/                     每次执行的报告与截图证据
├── logs/                     运行日志与告警日志
├── 部署说明.md 部署完整指引（含全工具使用示例）
└── mcp/                      MCP 服务器
    ├── server.mjs            45 个工具（stdio JSON-RPC）
    ├── runner.mjs            命令行执行器（任务计划调用）
    ├── lib/                  browser / locators / recorder / player / lint / vars / table / notify / schedule / chain / store / secrets
    ├── bridge.mjs            本地桥接服务（127.0.0.1:8317 HTTP ↔ stdio，供插件控制台调用）
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
| `pagepilot.config.json` | 配置（可能含 Webhook 地址） | 不入 |

`install.mjs` 装机时会生成 `.gitignore` 保护上述敏感路径（纯净发布包不带任何 `.` 前缀文件，敏感边界由安装器补齐）。

进一步细节：步骤 DSL/断言/变量来源 → `references/步骤DSL与断言参考.md`；踩过的坑与护栏 → `references/坑与护栏.md`；录制与回放完整流程 → `workflows/录制与回放工作流.md`；回放失败定位与修复 → `workflows/排障与自愈.md`；**全 45 工具自然语言使用示例** → 《部署说明.md》。

## 十五、常见问题 / 排错速查

| 现象 | 处理 |
|---|---|
| 录制时浏览器窗口没出现 | `doctor` 看 `browser` 字段。若首选浏览器损坏，启动层会自动降级到下一个候选并把失败的记入缓存；也可手工设 `browser.channel="msedge"` |
| `doctor` 报 playwright 不可用 | 在 `mcp` 目录 `npm install playwright`，或复用同工作区已安装的 playwright（会自动搜索） |
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

## 十六、浏览器插件控制台（extension/）

不想敲命令/等 Agent，也可以在浏览器里点点点控制全部 45 个工具：本地起一个零依赖桥接服务把 MCP 暴露成 HTTP，`extension/` 目录的 MV3 插件（六页签：状态 / 录制 / 流程 / 定时 / 系统 / 控制台）通过它实现开始/停止录制、回放与预检、变量断言步骤编辑、定时任务、告警凭据、持久化登录与运行总览，控制台页还能调用任意工具原始参数。桥接只监听 127.0.0.1 并校验 Host/Origin，跨源网页拿不到任何响应。所有网页常驻一颗**可爱猫耳悬浮球**（拖拽记忆位置；🎬 一键录制当前页 / ⏹ 结束保存 / ▶ 快速回放最近流程；录制中脉冲 + 步数角标）。**插拔式双模（v1.20.0）**：桥接未连接时自动落独立模式——本地录制/回放/流程管理照常可用（存浏览器本地，不依赖 MCP），本地流程可一键「升级到 MCP」；桥接连接即恢复 45 工具全功能（状态页「运行模式」横幅与悬浮球模式徽章实时显示当前模式）。安装与功能对照见《[extension/README.md](extension/README.md)》：

```bash
node mcp/bridge.mjs      # 第 1 步：启动本地桥接（默认 127.0.0.1:8317）
# 第 2 步：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 extension/ 目录
```

## 十七、自然语言使用示例（说目标，不说步骤）

对着 Agent 说人话即可——下面每条都是「用户怎么说 → 会发生什么（覆盖哪些工具）」，覆盖全部 45 个工具与插件全功能。

**录制与生成技能**
- 「帮我把 A 系统导报表的操作录下来」→ 打开可见浏览器，你演示一遍，停止后生成技能（含步骤清单/自动变量化/推断断言/静态检查）：`record_start` → `record_stop`。
- 「现在录到哪一步了？」→ 实时步数与步骤列表：`record_status`。
- 「刚才录错了，别要了」→ 丢弃本次录制：`record_cancel`。
- 「只重录第 3 步，前面的别动」→ 前缀自动重放回真实状态，只重录指定段再拼回原流程（自动备份）：`record_splice_start` → `record_stop`。

**流程管理与编辑**
- 「我有哪些流程？各多少步？」→ 流程清单与元信息：`flow_list`。
- 「把『订单日报』的步骤给我念一遍」→ 人类可读步骤清单：`flow_show`。
- 「这个流程能跑吗？先检查下」→ 预检定位符（不点任何东西）+ 静态检查：`flow_preflight`、`flow_lint`。
- 「重命名成『每日订单』」→ `flow_rename`；「删掉旧的测试流程」→ `flow_delete`。
- 「报表日期做成变量，今天默认取当天」→「单号从 Excel 第二列取」→ 参数化：`flow_param_add`；「这个变量不要了」→ `flow_param_remove`。
- 「跑完必须有数据，空表算失败」→ 结果校验断言：`flow_assertion_add`；「把那条断言删了」→ `flow_assertion_remove`。
- 「第 5 步没用，删掉」「把第 3 步的值改成 SO-1001」「第 2 步挪到第 4 步后面」→ 步骤级编辑：`flow_step_delete`、`flow_step_update`、`flow_step_move`。
- 「把『订单日报』导出成 JSON 发我」/「导出的这份导回去」→ `flow_export` / `flow_import`。
- 「刚才改坏了，回滚到上一版」→ 自动备份一键回滚：`flow_restore`。

**执行与证据**
- 「跑一下『订单日报』，日期用上周三」→ 自动回放（自愈定位/截图留证/空结果守卫/防重复提交）：`flow_run`。
- 「昨天跑的那次为什么失败了？」→ 运行历史与完整报告（失败步骤/截图/自愈记录/风控重定向归因）：`run_history`、`run_report`。
- 「日报和周报连着跑完，周报失败不影响后面」→ 多流程串联一条线：`chain_run`。
- 「跑完的旧记录清理一下，只留最近 20 次」→ `runs_prune`（默认只预演，确认后才真删）。

**无人值守（定时与告警）**
- 「每天早上 9 点自动跑订单日报，失败了钉钉通知我」→ 注册定时任务+配告警 Webhook+发测试消息验证链路：`schedule_add`、`notify_config`、`notify_test`。
- 「最近定时任务都正常吗？下次什么时候跑？」→ `schedule_list`；「手动触发一次」→ `schedule_run_now`；「先别跑了」→ `schedule_remove`。
- 「现在机器上有没有流程在跑？会不会重复提交？」→ 运行总览/并发锁：`status_report`、`lock_status`；「那个卡死的锁放掉」→ `lock_release`。

**凭据与环境**
- 「数据库密码别明文存」→ 加密保存凭据，运行时以 `${名字}` 引用：`secret_set`；「有哪些凭据/删掉过期的」→ `secret_list`、`secret_delete`。
- 「这个系统要扫码登录，帮我把登录态存下来」→ 打开浏览器人工登录一次，之后无人值守复用：`profile_login`；「登录态还在吗」→ `profile_info`；「换个账号重登」→ `profile_reset`。
- 「看看本机环境缺什么/配置现在是什么/把总时限改成 10 分钟」→ `doctor`、`config_get`、`config_set`。

**浏览器插件（悬浮球/控制台）**
- 装好插件后不敲命令：所有网页右下角猫耳球——「🎬 录当前页」演示一遍→「⏹ 结束保存」→「🔁 重播」；「👁」看步骤、「⚙」改名/删除、「✂ 重录片段」只重录错的那段；右键球体=快速录制/隐藏/开控制台。
- 不启桥接也能用（独立模式）：本地录制回放存浏览器本地；连上桥接一键「升级到 MCP」获得 44 工具全功能；断开即回落，本地流程不丢。
- /console 六页签点按钮等价调用全部工具；控制台页可带参调用任意工具原始参数。

## 更新记录

- **v1.0.7（2026-10-11）**：**`schedule_remove` 收尾清理补齐 + 桥接版本显示对齐**——① 删除定时任务此前只删 schtasks 任务与索引，`.work/sched/` 下的 `.cmd` 包装器与 `.params.json` 参数文件成为死文件跨轮累积（一轮实测即残留）；现随任务删除一并清理（尽力而为，不影响删除结果与返回形状）。② `bridge.mjs` 桥接版本号原为硬编码 `1.0.0`（/health 与控制台「桥接版本」显示与主版本脱节），现改为读取自身 `mcp/package.json`（读取失败回退不阻断启动），此后随发版自动对齐。**契约兼容：无任何参数/返回结构变化**，仅磁盘残留面与显示面收口。验证：round10 28/28（F8d 断言 wrapperGone 钉死）+ 新增 sweep-console **37/37**（/console 六页签按钮级遍历：缩放/设置、健康/doctor/总览、UI 起录→取消、卡片 9 钮逐个真跑、chain UI 真跑、定时 UI 注册→立即运行→删除全链、notify/凭据/profile/config/锁/prune、任意工具原始调用）+ 全套十 driver **189 项断言全绿**（round10：9 个零 API 覆盖工具清零 + 断言边界 + 悬浮球 ✂ 重录片段真窗 UI 全链闭环，45 工具 API 覆盖缺口清零）。
- **v1.0.6（2026-10-11）**：**`browser.debugPort` 配置（纯增量）+ CDP 测试通道**——① 新增配置键 `browser.debugPort`（默认 0=关闭，行为与旧版逐字节一致）：>0 时浏览器以 `--remote-debugging-port=<N>` 启动（持久化与非持久化两条 launch 路径均透传），外部工具可 `chromium.connectOverCDP` 连入录制/回放窗；用途=本机测试场景往录制窗合成事件（例如自动化验证「片段重录」时驱动真人演示环节），仅建议临时开启。② 测试侧借此补全 record_splice_start 全链路最后缺口：CDP 连入录制窗 → 合成 fill（REDONE）→ stepCount=1 → record_stop 拼接（prefix1+seg1+suffix3）→ 回放 pass → extract 取到新值——**splice 九环首次 100% 闭环**。③ notify 补验 mention 追加（slack text 末尾）与死端口+timeoutMs 入箱→恢复补发。**契约兼容：纯增量**（新配置键、默认关闭；无任何既有行为变化）。验证：round9 13/13（CDP 全链 9 + notify 3 + 配置生效 1）+ 全套八 driver **124 项断言全绿**。另修测试驱动层系统性 bug：桥接 `/api/call` 响应无 isError 字段（只有顶层 ok），3 个测试 driver 的 helper 恒 false 已修（产品侧 stdio 层 fail() 的 isError:true 契约一直正确，仅桥接 HTTP 层转换形状）。
- **v1.0.5（2026-10-11）**：**四轮全流程真实测试驱动收敛（77 项断言全绿）+ 7 处产品修复**——测试面首次贯通 桥接 HTTP → /console 网页版 → 浏览器插件+悬浮球 → MCP 45 工具 全链路（真实浏览器加载未打包扩展验证）。① **录制不再丢字段**（page-script）：输入防抖共享一个挂起槽，自动填充/密码管理器在 700ms 窗内连续填多字段时除最后一个外全部静默丢弃（实测同一时刻填 A、B 两框只录到 B）——换字段先提交上一个挂起输入，同字段连续输入仍合并；② **未知步骤类型静态拦截**（lint 新增 L003）：手写/LLM 生成的流程把 op 打错（fills/uncheck/clic）此前要到回放运行时才爆、浪费整次浏览器启动，现在 flow_lint 直接拦下并给最接近的合法 op 纠错建议（「是不是想写 fill？」），flow_run 在启动浏览器前 blocked；③ flow_step_insert 入口校验 op（打错名字插入时即拒）；④ 运行时未知 op 报错补合法步骤指引（allowLintErrors 强跑路径兜底）；⑤ **登录/SSO 判定只测路径不测查询串**：业务页带 ?from=login / ?sso=0 这类参数不再误触发起始页预警/误入归因登录分支（起始页预警、中段预警、失败归因三处同口径）；⑥ **主录制页中段被动跳登录页预警补齐**（recorder onNavigate）：会话过期 SSO re-auth 最典型的路径此前只有「别的标签页/iframe 跳登录页」才预警，主页面跳转反而没有——现在 notes 一次性提示「此前录的业务步骤可能失效，建议 profile_login」。验证：回放核心 14 + 录制链路 9 + 弹窗/变量/chain/预警 10 + 全栈桥接/网页版/扩展悬浮球 25 + 深度工具/管理面板/编辑器/token 19 = **77 项断言全绿**；工具计数同步 44→45（v1.0.4 新增 flow_step_insert 后未同步的陈旧口径一并修正）。
- **v1.0.4（2026-10-09）**：**悬浮框（悬浮球）实测修复 + 快捷操作增强**——① 排版修复：零高 fixed wrap 使下半屏面板整块飞出视口，改铺满视口 + pointer-events 穿透 + 按面板实际高度上开/下开；② 独立模式定位引擎重写：多候选按稳定性排序、录制时实测唯一性（testid/id/name/aria/底锚定短路径），告别深 :nth-child 脆路径；③ 回放强化：多候选逐试 + 文本兜底 + 短重试等 SPA 重渲染，失效 hover 自动跳过，报错完整列出已试定位符（不再截成 60 字符假选择器）；④ 录制会话跨页认领（chrome.storage 扩展级标记，任意页面可结束/取消/重播自己的录制）+ 被外部占用时的「接管结束并保存 / 接管废弃」二次确认接管；⑤ 录制丢步实时反馈（密码框/无定位符）与离开页面草稿救援；⑥ **右键悬浮球快捷操作**（录制中免开面板直达 结束保存/废弃）与面板顶部快捷操作区。验证：Playwright 加载真实扩展 37/37 断言（本地 25 + MCP 12，含排版矩阵 6 位置、占用接管双路径）。
- **v1.0.3（2026-10-09）**：合并开发线 v1.8.3 全部功能。① **浏览器插件控制台（`extension/`）**——MV3 插件零构建零第三方库：网页悬浮球（录当前页/结束/重播/查看步骤/重录片段/管理）+ `/console` 网页版六页签（状态含 live 进度 / 录制 / 流程结构化编辑器 / 定时 / 系统 / 控制台）；② **本地桥接服务（`mcp/bridge.mjs`）**——把 stdio MCP 暴露为 127.0.0.1:8317 HTTP（`/health` `/tools` `/api/call`，Host/Origin 校验 + 可选 `PAGEPILOT_BRIDGE_TOKEN` 鉴权），`node mcp/bridge.mjs` 启动；③ 全模块演进——失败归因 `attribution`、`finalUrl`/`finalTitle` 透出、工具整数入参收口、profile 争用诚实化、flows 白名单定案（真实流程永不随包）等；④ 配置文件更名 `pagepilot.config.json`；⑤ 纯净包 41 文件（extension/ 全量随包）。
- **v1.0.2（2026-10-08）**：**安装器自动注册 MCP 客户端并写后验证**——覆盖 Claude Code（CLI / `~/.claude.json`）、Claude Desktop、Cursor、Windsurf、VS Code (Copilot MCP)；合并式写入不破坏既有条目，原配置首次备份 `*.bak-pagepilot-mcp`（重装不覆盖原始备份），写后回读确认注册键（状态行 `REG=auto`）；FAQ 增补「没注册上」排错行。
- **v1.0.1（2026-10-08）**：品牌落定与技能化——发布线更名 **天璇驭页 · PagePilot**（包名 `pagepilot-mcp`，MCP 注册键 `pagepilot`，发布物 `pagepilot-mcp_vX.Y.Z.zip`）；新增 **SKILL.md 技能入口**（44 工具分组表 / 使用工作流 / 安全红线 / 排错速查），装机时随 workflows/references 一并复制到技能目录；空目录（flows/ 等）不随包。
- **v1.0.0（2026-10-08）**：初始纯净版本——44 个 MCP 工具（录制/回放/自愈定位/断言/截图证据/凭据加密/定时/告警/并发锁/多流程串联）；**纯净化**——移除测试套件与验证现场目录、零 npm 依赖声明（playwright 运行时自动探测、缺失按需安装）、安装器 doctor 自检、发版口径改为「纯净拷贝 + 逐文件哈希自校验 + 纯净复扫」。
