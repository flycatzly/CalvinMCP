# Web RPA 控制台（浏览器插件）

把本机 [web-rpa-mcp](../README.md) 的全部 44 个工具装进浏览器：开始/停止录制、回放与预检流程、变量/断言/步骤编辑、串联运行、Windows 定时任务、告警与凭据、持久化登录、运行历史与总览——外加一个能调用任意工具的原始控制台。

```
┌──────────────┐  HTTP (127.0.0.1:8317)  ┌───────────────┐  stdio JSON-RPC  ┌────────────┐
│ 浏览器插件     │ ───────────────────────▶ │ mcp/bridge.mjs │ ───────────────▶ │ mcp/server  │
│ popup.html   │ ◀─────────────────────── │ 本地桥接服务     │ ◀─────────────── │ 44 个工具    │
└──────────────┘                          └───────────────┘                  └────────────┘
```

## 一、安装（两步）

> **插拔式提示**：只做「当前页录制/回放/本地流程管理」可以**不启动桥接**直接用（独立模式，见「三点六」）；桥接服务解锁的是完整 44 工具面（MCP 流程/定时/告警/凭据/串联…）。两步全做 = 依赖模式全功能。

**第 1 步：启动桥接服务**（完整功能需要这个本地进程转发）：

```bash
cd web-rpa-mcp
node mcp/bridge.mjs          # 默认端口 8317；也可 node mcp/bridge.mjs 9000 换端口
# 或 npm run bridge（在 mcp/ 目录内）
```

看到 `web-rpa-mcp 桥接服务 v1.0.0 已启动` 即成功。浏览器打开 <http://127.0.0.1:8317/> 能看到状态说明页；**不装插件也可以直接打开 <http://127.0.0.1:8317/console> 使用网页版控制台**（与插件同一套界面，桥接同时记录调用统计与最近调用清单，`/health` 可查）。

**第 2 步：加载插件**：

1. 打开 Chrome / Edge，地址栏输入 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
4. 工具栏出现图标，点击即打开控制台

插件设置（⚙）里可改桥接地址（默认 `http://127.0.0.1:8317`），改完自动保存并重连。

## 二、功能对照（44 个工具全覆盖）

| 页签 | 功能 | 对应工具 |
|---|---|---|
| 状态 | 桥接/MCP 连接状态、环境自检、无人值守总览 | `/health`、`doctor`、`status_report` |
| 录制 | 开始录制（打开可见浏览器演示）、实时步骤流、结束并保存、取消、片段重录 | `record_start` `record_status` `record_stop` `record_cancel` `record_splice_start` |
| 流程 | 列表、回放（变量/有头/强制运行/总时限）、预检、静态检查、步骤清单、运行历史、最新报告、导出、备份回滚、重命名、删除、串联运行 | `flow_list` `flow_run` `flow_preflight` `flow_lint` `flow_show` `run_history` `run_report` `flow_export` `flow_restore` `flow_rename` `flow_delete` `chain_run` |
| 流程→编辑 | 结构化编辑器：步骤/变量/断言**列表化渲染**（与服务器 stepLabel 同口径），步骤行内 ↑↓ 移动、删除、改（预填该步骤 JSON 的合并 patch），变量/断言行内删除；添加表单保留 | `flow_show(format=json)` `flow_step_move/delete/update` `flow_param_add/remove` `flow_assertion_add/remove` |
| 定时 | 定时任务列表/删除/立即触发，新增（daily/weekly/hourly/minute/once/logon） | `schedule_list` `schedule_add` `schedule_remove` `schedule_run_now` |
| 系统 | 告警配置与测试、凭据增删查、持久化登录（人工登录一次）、配置查看/更新、执行锁查看/释放、历史清理（默认只预演） | `notify_config` `notify_test` `secret_set/list/delete` `profile_login/info/reset` `config_get/set` `lock_status` `lock_release` `runs_prune` |
| 控制台 | 任意工具的原始调用：下拉选工具（带描述）、自动生成必填参数骨架、看返回 JSON | 全部 44 个工具（含未单独做界面的 `flow_import` 等） |

## 三点五、可爱悬浮球（所有网页常驻）

仿「沉浸式翻译」悬浮窗：一颗可拖拽的猫耳悬浮球贴在每个网页边上（可拖到任意位置、记忆位置），点开快捷面板：**🎬 一键录制当前页**（独立录制窗口自动打开当前网址）、录制中球体粉色脉冲 + 步数角标实时刷新、**⏹ 结束并保存**（生成技能）、**▶ 快速回放**（最近 5 个流程一键无头回放）、**🧊 完整控制台**（新页打开 /console）、**🙈 本页隐藏**（sessionStorage，本页刷新不再出现）。

实现：content script（Shadow DOM 隔离，页面样式进不来也不污染页面；CSSOM 样式不受页面 CSP 限制；DOM 全用 createElement 构建，无 XSS 面、兼容 Trusted Types 严格站）→ MV3 Service Worker 中转（绕开页面 CORS）→ 本地桥接 → MCP。只注入顶层框架，http/https 页面全量生效；控制台页本身不注入（防套娃）。

> 在 chrome://extensions 重载扩展后，刷新任意网页即可看到悬浮球；桥接未启动时球显示「桥接未连接」提醒。

## 三点六、插拔式双模（v1.20.0：不依赖 MCP 也能用）

一套插件、两种运行方式，由插件自动探测桥接健康度切换（状态页「运行模式」横幅 + 悬浮球面板右上角模式徽章）：

| | 依赖 MCP 模式（桥接已连接） | 独立模式（桥接未连接/未启动） |
|---|---|---|
| 悬浮球 🎬 录制 | MCP 录制器（全步骤 DSL、Playwright 回放） | **本地录制**：content 直接捕获当前页 click/input/change（密码框不录） |
| 回放 | MCP 流程回放（44 工具面） | **本地回放**：同页 DOM 操作合成回放 |
| 流程管理 | MCP flows/（含定时/告警/串联） | 浏览器本地存储（chrome.storage，`rpaLocalFlows`） |
| 升级通道 | — | 本地流程可一键「**升级到 MCP**」（映射为 goto+click/fill DSL 并 flow_import） |
| 导出 | flow_export JSON | 本地流程导出 JSON 下载 |

**能力边界（诚实）**：独立模式面向 DOM 操作流程（表单填写/按钮点击/hover 揭层/Enter 按键/页面内交互）；**同源跨页**（a[href] 点击识别为 goto 步，新页面自动续播）已支持，**跨源跳转、下载、弹窗、iframe、定时告警**仍需桥接用 MCP 模式。本地流程只存本机浏览器，不发往任何服务器；支持导出 JSON 与「导入」（本地/MCP 格式均可）。

**验证**：`node verify/standalone.mjs`（10 用例全链路：独立录制/回放、popup 管理、插桥切依赖、升级映射、拔桥回落、跨页回放通道、删除清存储）。

## 三、典型用法

**录一个新技能**：切「录制」→ 填起始网址 → 点「▶ 开始录制」→ 在弹出的浏览器窗口里演示操作 → 回插件看实时步骤 → 点「■ 结束并保存」→ 得到 flowId 与静态检查结果。

**回放**：切「流程」→ 展开某个流程 → 点「▶ 回放」→（可选）填 `{"日期":"2026-10-07"}` → 「▶ 开始回放」。回放可能持续几分钟；**关掉插件窗口不会中断执行**，结果稍后在「运行历史」里看。

**每天自动跑**：切「定时」→ 新增 → 选频率与时刻 → 注册。之后用「状态」页的 `status_report` 每天早上一眼看全部流程。

## 四、安全说明

> **可选 token 鉴权**：桥接启动时设置 `WEBRPA_BRIDGE_TOKEN=令牌` 启用后，插件设置页「访问令牌」填同一值即可；网页版用 `/console?token=令牌` 打开。公网/跨机转发场景建议启用；仅本机使用时可不设。

- 桥接服务**只监听 127.0.0.1**，局域网内其它机器连不上。
- 桥接校验 `Host`（防 DNS rebinding）与 `Origin`（只放行 `chrome-extension://` 和本机同源页面），其它网页来源直接 403；也不返回任何 CORS 放行头，恶意网页拿不到响应。
- 回放/录制/删库是本机强操作：**不要把 8317 端口转发到公网**，也不要给陌生扩展装进同一浏览器。
- 插件不收集任何数据；凭据值只在「系统」页输入一次（`secret_set` AES-256-GCM 加密存盘，任何输出不回显明文）。

## 五、常见问题

**插件显示「未连接」**：桥接服务没起。在仓库目录执行 `node mcp/bridge.mjs`；端口或地址改过的话，在插件 ⚙ 里改桥接地址。

**桥接在但 MCP 未就绪**：MCP 服务器启动失败，看桥接进程的 stderr 日志；在 `mcp/` 目录执行 `npm install` 装依赖后重启桥接。

**点「开始录制」后窗口在哪**：录制由 MCP 服务器用 Playwright 打开一个独立的有头浏览器窗口（不是当前浏览器的标签页）。演示完回插件点「结束并保存」。

**同时开着 ZCode 里的 MCP 会冲突吗**：流程级执行锁会挡住同一流程的并发回放（避免重复提交）；浏览器 profile 被占用时会得到诚实的占用报错，等一下再试即可。建议同一时间只用一边跑重活。

**Edge 可以吗**：可以，`edge://extensions` → 开发者模式 → 加载已解压的扩展程序，步骤相同。

**想改图标**：`extension/icons/make-icons.mjs` 重新生成（纯 Node 无依赖，`node extension/icons/make-icons.mjs`）。

## 六、文件清单

```
extension/
├── manifest.json          MV3 清单（只需 storage 权限 + 127.0.0.1 host 权限）
├── popup.html/css/js      六页签控制台（纯原生 JS，无构建步骤、无第三方库）
├── standalone-core.js     独立模式核心（原生录制/回放/本地流程存储/MCP 升级映射，content 与 popup 共用）
├── content.js             悬浮球（猫耳球 + 面板，双模：依赖 MCP / 独立本地）
├── background.js          SW 中转（悬浮球 fetch → 桥接；token 注入）
├── icons/                 16/32/48/128 图标 + make-icons.mjs 生成器
└── README.md              本文件
mcp/bridge.mjs             本地桥接服务（MCP stdio ↔ HTTP REST，零依赖）
verify/standalone.mjs      双模全功能点验证（10 用例：独立/插拔切换/升级链路，自密封）
verify/ui-ext.mjs          依赖模式 UI 回归（--quick 16 用例）
```

## 更新记录

- **v1.21.2（2026-10-09）**：**真实使用观察轮双修复 + 新用户旅程资产**（verify/journey.mjs **8/0**）。① **本地流程行补 👁 查看步骤**（体感不对称修复）：悬浮球「📁 本地流程」行此前只有 ▶/🗑，MCP 流程行有 👁——补行内展开步骤清单（localStepLabel 渲染 goto/click/fill/hover/press 中文标签）。② **升级流程默认断言**（旅程实锤的阻断缺口）：`toMcpFlow` 升级到 MCP 的流程若无断言会被 L010 静态检查阻断，而悬浮球列表 ▶ 不带 allowLintErrors——升级完的流程无法直接重播；修复=升级时默认注入「url contains 起始域」断言（宽松且有意义），旅程 J6/J7 实证升级→重播全通。③ **新用户插拔旅程资产 verify/journey.mjs**：开箱无桥接（徽章独立）→本地录制→👁查看→本地回放→横幅独立+升级置灰→插桥→横幅依赖→升级到 MCP→悬浮球 MCP 重播（L010 不阻断）→拔桥回落+本地流程仍在，8 环全绿（脚本教训：同名双行按 MCP 行独有 title「无头回放 <id>」精确点中）。④ 回归：all.mjs --quick 全过（sweep 32/ui-ext 16/standalone 15/fullchain 8）；自密封清理 32 项电池残件（自检行曾报 1 项瞬态=末套电池清理时序快照，复核 flows/ 干净）。

- **v1.21.1（2026-10-08）**：**真实使用观察轮双修复**（观察驱动：demo 真实多页表单流实测 + splice 全链路实测）。① **表单提交跨页续播**（独立模式盲区修复）：submit 类按钮（button[type=submit] 且带 form）点击会触发 POST/GET 跨页导航——此前回放中断在导航处；现点击前预存续播状态、新页自动接续，**1.5s 内未导航则自清令牌**（JS 拦截提交的场景防陈旧续播误触发）。实测 demo 登录流：fill 工号/密码 → 点击登录 → POST /login → 302 /report（cookie 鉴权）→ 终态报表 3 行、令牌已消费（standalone P10）。② **popup 片段重录无法从 popup 停止**（P1 UX bug）：startSplice 漏记本会话 id → renderRecordStatus 把自己的 splice 会话判成「外部会话」→ 停止/取消按钮永不出现；修复=成功后 setMyRecSession（对齐 record_start 路径），S32 用例以「停止卡出现」为成功信号实证。③ **观察项（如实记录，未定位到代码点）**：splice 紧凑停止（最后一步落盘后 <1s 停）有间歇性尾步丢失（步骤 2 进 1 出），长沉降（≥2s）稳定复现 4 步正确——S32 已用长沉降对齐；根因排查已排除 autodetectVariables/goto-pair-trim/pushStep（均逐段实测无丢步），列入观察项待真实样本积累。④ **验证**：standalone 15/0（P10 新增）、button-sweep **32/0**（S32 splice 执行闭环新增，含 v1.21.1 停止修复回归）、`node verify/all.mjs --quick` 全部通过（总入口新增失败自动重试一次——时序竞态类套件的兜底）。

- **v1.21.0（2026-10-08）**：**独立模式增强**（候选②落地；standalone 验证扩至 **14/0**，all.mjs --quick 4/4）。① **步骤类型扩容**：录制器新增 **hover**（mouseover 捕获、同元素 1s 去重——菜单揭层场景）与 **press**（Enter/Escape 键事件链，Enter 只在可编辑语境录）；回放器同步支持两类事件链派发。② **跨页链接识别与同源自续播**：录制时 a[href] http(s) 跨页点击识别为 **goto 步**；回放遇 goto——同源跳转把剩余步骤写入 sessionStorage（60s 过期防陈旧），新页面 content script 初始化时 `maybeResume()` 自动接续（实测 stub /page2 fill+click 续播 out2=OK2 一次通过）；跨源链接诚实停止并明示原因（sessionStorage 按 origin 隔离）。③ **本地流程导入**：控制台本地卡片「导入」按钮（filechooser）——本地格式与 MCP 流程 JSON 均可（`toLocalFromMcp` 反向映射 goto/click/fill/hover/press）。④ **MCP↔本地双向映射闭环**：本地→MCP 升级（v1.20.0）+ MCP→本地导入（本轮）。⑤ **验证**：verify/standalone.mjs 10→14 用例（hover/press 录制回放生效、跨页续播、导入）全绿；button-sweep 31/0、ui-ext --quick 16/0、fullchain 8/8、`node verify/all.mjs --quick` 汇总全过。

- **v1.20.1（2026-10-08）**：**全流程实测轮三修复**（ui-ext 完整版 17/0 + verify/fullchain.mjs 8/8 + standalone 10/0 + ui-ext --quick 16/0 全绿）。① **/console 跨端口静默连错桥接（本轮实锤的最重要缺口）**：悬浮球 🩵 打开的控制台页（如 8324/console）localStorage 为空时 BASE 静默回落硬编码 8317——页面「看着连着」（数据同目录读写正常）实际所有调用打到另一个桥接，新旧代码行为分歧（归因字段有/无）全由此起；修复=web 模式下 `127.0.0.1/localhost` 托管时默认 BASE=`location.origin`（v1.9.2「空 localStorage=默认=正确不跳」假设在非默认端口托管场景不成立，本条修正该假设）。② **悬浮球录制轮询抖动容忍**：`startPoll` 单次 `record_status` 失败即永久停轮询并把「自己的录制」误标成外部会话——连续 3 次失败才认定结束。③ **归因判定观测日志**（mcp/lib/player.mjs 一行 L.info，零行为变化，随下次 mcp 发版带出）：失败运行记录归因输入与判定结果，排查「同输入不同判定」类问题的现场数据。验证：verify/fullchain.mjs（新资产：悬浮球录制→重播成功（✅无🩵对照）→失败（❌+🩵）→控制台报告摘要归因→控制台回放归因行→run_report 三面一致→双模拔插）8/8；standalone 10/0；ui-ext --quick 16/0（设置往返零破坏）。

- **v1.20.0（2026-10-08）**：**插拔式双模（不依赖 MCP 也能用）**——新增 `standalone-core.js`（原生录制器/回放器/本地流程存储/升级映射，content 与 popup 共用经典脚本零构建）：① **悬浮球双模**：面板右上角模式徽章（依赖 MCP/独立模式）；独立模式下「🎬 本地录制当前页」直接在 content 捕获 click/input/change（悬浮球自身与密码框不录、连续输入合并），「⏹ 保存到本地」存 chrome.storage，本地流程行 ▶ 当页回放/🗑 两击删除；② **控制台双模**：状态页「运行模式」横幅（依赖时显示桥接与 MCP 版本；独立时给启动指引）；流程页新增「📁 本地流程」卡片——▶ 回放到当前标签（popup→content 消息通道）、导出 JSON、**升级到 MCP**（toMcpFlow 映射 goto+click/fill DSL → flow_import）、🗑 删除；③ **插拔语义**：桥接健康自动探测切换，本地流程存储跨模式存活，拔桥不丢数据。**验证**：verify/standalone.mjs 10/0（独立录制回放/导出/插桥切依赖/升级映射 goto 起手/拔桥回落/跨页通道/删除清存储）+ ui-ext --quick 16/0 零破坏。**排障实锤并修复 1 个产品 bug**：startLocalRec 误调 refreshLocalSection（应为 renderLocalSection）——独立录制开始后 ⏹ 保存按钮永不渲染（ReferenceError 吞在异步路径）；验证脚本教训：main world 无 chrome.storage（存储核对必须在扩展页上下文）、popup 前台会让 tabs.query 返回 popup 自身、面板徽章先于异步本地区块渲染需等元素存在再点击。

- **v1.9.6（2026-10-08）**：**报告摘要补透出归因/最终页**（观察期续跑实锤的第三个「投影漏字段」缺口）——流程卡「报告」按钮渲染的是中文键摘要（状态/步骤数/错误/报告/截图），风控重定向类失败在摘要里看不到任何线索，得去控制台原始调用才看得见；现摘要条件性补 `归因`（attribution 有值才显示，空值不添噪音）与 `最终页`（finalUrl）。悬浮球真实使用链路走查实证：录制→重播→失败→🩵→控制台报告摘要「归因: 最终 URL（…）偏离…疑似外部真实站风控重定向…」PASS；ui-ext --quick 16/0 零破坏。

- **v1.9.5（2026-10-08）**：**bridgeUrl 归一化（静默失效修复）**——设置输入框与 `?bridge=` 参数此前接受裸端口（"8321"）/host:port 却零校验，原样进 BASE 后所有请求打到 `/8321/api/call` 这类 404，全功能静默失效（观察期 `?bridge=8321` 实锤）；popup.js 与 background.js 各加同款 `normalizeBridgeUrl`（裸端口→`http://127.0.0.1:端口`、其余缺 scheme 补 `http://`），接线五处（URL 参数/storage/localStorage 兜底/设置保存/SW 桥接基址），**存量坏值读取时自愈**。修复后 `?bridge=8321` 直开 /console 全功能可用（观察期走查实证：流程卡加载→回放→归因行渲染 PASS）。

- **v1.9.4（2026-10-08）**：**回放失败归因展示**（配合 MCP v1.8.1 的 report.attribution 新字段）——`renderRunResult` 在「错误」行后新增「归因:」一行（仅失败且报告带 `attribution` 时显示，如「疑似外部真实站风控重定向…」；成功/无归因不显示不添噪音）。ui-ext --quick 16/0 零破坏。

- **v1.9.3（2026-10-08）**：**跨端口自愈死循环修复**（观察期第二轮实锤）——v1.9.2 的跨端口跳转有死循环缺陷：localStorage 按 origin 隔离，8317 页面写的 bridgeUrl 跳到 8318 后新 origin 读不到 → 默认 8317 → 反复横跳。修复=跳转 URL 带 `?bridge=` 参数（与 token 同款机制），目标页 loadSettings 优先读 URL 参数并写入本 origin localStorage，host 收敛终止循环；同时补 **saveSettings 保存后同款自愈**（设置改端口即跳即连接，此前需手动刷新页面）。观察期第二轮验证 5/0：保存即跳转即连接 / 旧链接自愈跳转 / 新用户默认不跳 / token curl 矩阵（403/200/垃圾头 403）/ 扩展配对 token 悬浮球可用；ui-ext --quick 16/0 零破坏。

- **v1.9.2（2026-10-08）**：**真实使用观察轮**——以用户视角走完 10 环节工作流（进入工作页→面板→录制→生成→查看步骤→重播→管理→右键→控制台→失败场景），**体感 10/10 顺畅**（唯一 💡 经诊断为测试选择器误报：`fname .n` 嵌套是悬浮球结构、/console 是单层 `fname`，卡片实际全部正常渲染）。走查中挖出并修复一个**真缺口**：**网页版 /console 的桥接地址不可配置**——页面无 chrome API 读不到 storage，BASE 永远落回默认 8317，改过桥接端口后网页版全功能连错端口；修复=loadSettings/saveSettings 补 localStorage 兜底（与 rpaToken 同款，saveSettings 拆分 try 防 chrome 缺失连坐）+ init 时检测 `location.host !== BASE.host` 自动跳转到当前桥接的 `/console`（?token= 随跳、host 收敛防循环）。ui-ext --quick 16/0 确认零破坏。

- **v1.9.1（2026-10-07）**：**回放失败快捷报告入口**——悬浮球面板的回放/重播失败时，错误消息下方出现「🩵 打开控制台看报告」按钮（新页打开 /console）——完整报告（截图/步骤明细/断言结果）此前只能自己想起来去控制台，失败现场一行 msg 装不下；成功时不显示（不添噪音）。**回归资产 verify/ui-ext.mjs 完整版 17/0 全过**（含 live 进度长流程用例；修资产脚本的测试顺序依赖 bug——「🙈 隐藏」写入的 sessionStorage 按 origin 存活污染后续用例，live 用例前先清）；--quick 16/0 确认本次改动零破坏。**verify/ 目录随包核实为设计面**（live-fulltest 是门禁家族在副本内跑的步骤，必须随包）；顺带按「探针用完即删」纪律清理历史残留 probe-autobot/probe-profile-reset/dump-schemas 及其产物（曾随包）。

- **v1.9.0（2026-10-07）**：**悬浮球「✂ 重录片段」快捷入口**——⚙ 管理条新增：点开展开 from/to 区间输入（自动拉流程总步数填默认值，from=1、to=总步数）+「开始重录」调 record_splice_start（keepSuffix:true）；提示文案说明「前缀（第 1~from-1 步）会自动重放，页面回到该步之前的真实状态；完成后结束录制即自动拼接回本流程（原定义有备份可回滚）」；成功后走录制中状态（角标/⏹ 拼接），被外部占用时错误透传+转只观察（既有防护不破坏）。**顺带修复产品 P1 bug（真机实锤）**：record_stop 的 splice 拼接成功后工具报 fail——finalizeSplice 返回缺 stepCount/assertions/notes 字段而 handler 统一按全新录制形状读 `r.assertions.length` → 拼接实际成功（文件已保存）却抛 undefined.length 误报失败；补齐三字段后 handler 两分支形状一致（真机验证：拼接成功显示「技能已生成 ✓」，结构=前缀+新片段+后缀，回放 pass）。真机验证 4/4：表单默认值 / 开始重录（splice 会话 from:2 to:3 prefixCount:1）/ ⏹ 拼接成功 / flow_show 结构+回放 pass。

- **v1.8.0（2026-10-07）**：**live 进度升级到步骤级**——/console「运行中」卡片现在显示「第 N/M 步 · 中文操作」（如「第 3/7 步 · 等待」），级联实时刷新。实现（零消费面破坏）：player.mjs 每步开始时把 `{index, total, op}` 刷新进运行标记（与 markWaitingHuman 同款容错，失败不阻断执行；写频率=每步一次 <1KB 小 JSON）；ops.mjs status_report 的 `running` 对象透传 `step`（纯增量字段：无则 null，旧报告/旧消费方不受影响）；popup.js 运行中卡片用 OP_LABEL 中文渲染。真机验证 3/3：长流程（7 步多段 sleep）运行中采样「第2步·等待→第3步·等待」级联 / 结束后空态 / status_report 契约回归（running.step 形状正确）。自检：全量 selftest 复跑（server/lib 有改动）。**注意：悬浮球面板保持 lock_status 轻量速览（流程名/pid 级），步骤级只在 /console 详细视图显示。**

- **v1.7.0（2026-10-07）**：**悬浮球右键快捷菜单**——右键球体弹出小菜单（阻止页面原生菜单）：🎬 快速录制当前页（开面板并直接发起录制）/ 🙈 本页隐藏 / ⚙ 设置（新开完整控制台标签）；与左键开面板互补互不干扰（右键 pointerup 不触发面板）；Esc 或点击球外任意处收起（document capture 监听 + Shadow DOM composedPath 判定，不误伤页面脚本）；菜单贴球定位、靠屏幕边缘自动收拢防溢出。真机验证 7/7：右键出菜单 3 项 / Esc 收起 / 点外部收起 / 左键面板不受影响 / 🎬 右键录制→角标→生成技能 / ⚙ 新开控制台标签 / 🙈 隐藏+刷新不复活。

- **v1.6.1（2026-10-07）**：SKILL 收编——SKILL.md 新增「五之三、浏览器插件控制台」（悬浮球/六页签/live 进度/token/录制器占用防护，自包含描述，装机副本 Agent 可读）与「五之四、外部真实网站回放规范」（headed 必开——gitee headless 实测被风控拦截；title 断言用页面真实大小写——实测 `CalvinMCP: mcp仓库`；waitFor text 对动态 SPA 不可靠时 sleep 兜底），能力总览与强化清单同步加行；`install.mjs` 刷新装机副本（C:\Users\CalvinZly\.agents\skills\web-rpa-mcp）。产品代码零改动（仅 SKILL/文档/manifest 版本）。

- **v1.6.0（2026-10-07）**：**回放 live 进度面板**——「弹窗关掉后回放黑箱」的可观测性收口：/console 状态页新增「▶ 运行中回放」卡片（status_report 3s 轮询、离开页签即停），显示进行中流程的名称/触发方式/pid/**已运行时长**（递增）与 **⏸ 等待人工接管**（humanHandoff 窗口含 reason/截止时间）；悬浮球面板新增运行中提示条（lock_status 轻量 3s 轮询，面板打开时启动），显示「▶ 运行中: 流程（trigger · pid）」或「浏览器 profile 被占用」。**诚实粒度**：report.json 收尾才写，运行中没有步骤级明细——显示「进行中/等人工」级是 active marker/锁记录能支持的口径，不假装步骤进度。零 server/lib 改动。真机验证 3/3：/console 状态页（真实外部 splice 锁夹具：「未命名流程 · splice · pid · 已运行 43m54s」完整显示）/ 悬浮球长流程运行中显示（goto+sleep 35s，manual · pid）/ 结束后空态恢复（不留残影）。

- **v1.5.1（2026-10-07）**：**录制页冲突提示（/console 侧对齐悬浮球防护）**——popup.js 录制页轮询 record_status 时若检测到录制会话非本页发起（sessionStorage 存 myRecSession 会话 id 比对），rec-live 区显示只读提示「检测到其他会话正在录制（含片段重录），本页未发起不提供结束/取消」并**隐藏「结束 / 取消」卡片**（防误结束他人录制——与悬浮球 v1.4.0 mySession 同款防护）；record_start 成功记录会话 id，stop/cancel 成功清除；页面刷新后标记丢失→保守按外部会话显示。**全链路检查 13/13**：/console 全页签（布局缩放/doctor/录制页外部会话只观察·真实 splice 夹具/流程页只读/编辑器闭环含上移改 patch 变量断言/定时 secret 往返/控制台调用/设置往返）+ 悬浮球全链路（录制→生成→👁查看→🔁重播/改名/回放/删除/拖拽记忆/隐藏不复活）。manifest 版本补记：v1.5.0（网页版自适应）时漏改 manifest，本轮一并升至 1.5.1。

- **v1.5.0（2026-10-07）**：**/console 网页版自适应布局 + 缩放**——网页版（检测非扩展上下文自动激活，扩展弹窗模式零影响）：铺满浏览器窗口（100vw/100vh，header 吸顶）、主内容区卡片自动多列排布（宽屏 1600px 实测 3 列、窄屏 500px 单列回退，`grid-template-columns: repeat(auto-fill, minmax(420px, 1fr))`）、顶部缩放条（slider 75%-150% + ±步进 + ⛶ 快捷切换 125%/100%，`body.zoom` 实现，localStorage 持久化、刷新保持）。真机验证 6/6：web 模式激活/多列/缩放生效与持久化/按钮切换/窄屏回退/控制台核心功能不受影响。**悬浮球录制/重播多轮稳定性**：隔离实例（8318）下录制→生成→重播两轮全 pass（各 3 步 1s）、👁 步骤渲染正确（打开网址/填入/点击）；storage 切换与恢复正确、残件清理干净。

- **v1.4.0（2026-10-07）**：**悬浮球「查看步骤 + 重播 + 管理」**——流程行新增 👁（行内展开步骤清单，与编辑器同款 stepLabel 中文摘要，含断言/变量行）与 ⚙（行内管理条：重命名输入框 + ✓保存 + 🗑 删除两击确认，有备份可回滚）；录制结束后出现「🔁 重播刚生成的技能」一键回放（带 allowLintErrors：刚录制的流程用户已确认步骤，简单页面常推断不出断言不应被 L010 阻断；常规流程列表的 ▶ 仍守静态检查）。**安全边界**：录制器被其他会话占用时，面板显示只读提示「检测到其他会话正在录制」，不再提供 ⏹/✕ 干预按钮（防止误结束他人的录制会话——gitee 实测轮实锤过的风险）；record_start 被拒时错误原文透传并转为只观察模式。真机验证 6/6：👁 步骤渲染 / ⚙ 重命名（服务端确认）/ ⚙ 两击删除 / 隔离桥接实例（8318 独立 MCP 进程）下录制→生成→重播全链路 pass / storage 切换与恢复 / 外部会话只观察（真实 splice 会话场景）。

- **v1.3.0（2026-10-07）**：**桥接可选 token 鉴权**——桥接启动时设置 `WEBRPA_BRIDGE_TOKEN=令牌` 后，/health /tools /api/call 必须带有效凭证（`X-RPA-Token` 头，或网页版 `?token=` URL 参数），不匹配 403 并提示配置方法（悬浮球面板也会透传该指引）；未设置时行为逐字节不变（向后兼容）。扩展侧：popup 设置页新增「访问令牌」输入框（chrome.storage 存 rpaToken），popup.js 与悬浮球（background.js 统一注入）调用统一带头；网页版 `/console?token=令牌` 自动记入 localStorage。验证：无 token 全端点回归 + 真机 6/6；token 模式 curl 矩阵 11/11 + 真机 6/6（负向 403 指引可读 / popup 页写 storage 配对 / 悬浮球带 token 回放与录制全链路 / /console 双场景）。

- **v1.2.0（2026-10-07）**：**可爱悬浮球**——所有 http/https 网页常驻一颗可拖拽的猫耳悬浮球（仿沉浸式翻译悬浮窗：贴边拖拽、位置记忆、录制中粉色脉冲 + 步数角标），点开快捷面板：🎬 一键录制当前页 / ⏹ 结束并保存 / ▶ 快速回放最近流程 / 🧊 完整控制台 / 🙈 本页隐藏。实现：content.js（Shadow DOM 隔离 + CSSOM 样式 + 纯 DOM 构建）→ background.js（MV3 Service Worker 中转，绕开页面 CORS 与 Trusted Types）→ 桥接 → MCP。真实 Chromium 验证 6/6：注入 / SW→桥接状态与流程列表 / 真回放 pass / ?auto=1 合成录制生成 3 步技能（桥接侧落盘确认）/ 角标步数 / 隐藏后刷新不复活。

- **v1.1.0（2026-10-07）**：流程编辑器结构化——「变量/断言/步骤」从手填序号的静态表单改为列表化渲染（`flow_show format=json` 拉取，与服务器 `stepLabel` 同口径的一句话摘要）：步骤行内 ↑/↓ 移动、删除（带确认）、改（预填该步骤 JSON 的合并 patch 编辑器）；变量/断言行内删除；每次操作后编辑器与卡片元信息同源刷新；添加表单保留。
- **v1.0.0（2026-10-07）**：首版——六页签控制台 + /console 网页版兜底。
