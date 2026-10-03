# wechat-ai — 微信个人情报库 + 微信流（Windows 本地只读）

把两篇公众号文章里介绍的两个开源项目的能力，重新实现成一个**可在 Windows 上运行的 MCP 服务器 + 大 skill（63 个技能工具）**：

| 上游项目 | 原文 | 本项目实现的部分 |
|---|---|---|
| [freestylefly/WeChatBridge](https://github.com/freestylefly/WeChatBridge)（微信流，macOS SwiftUI） | 《把聊天记录，变成 AI 的知识》 | 平台无关核心：Inbox 协议、会话场景、转发目标、内置技能、Obsidian 笔记、操作历史、批量收集 |
| [Rion-Wu-tech/wechat-intelligence-hub](https://github.com/Rion-Wu-tech/wechat-intelligence-hub)（微信个人情报库，Python） | 《微信聊天变成个人情报库》 | 确定性引擎：索引、信号检测、商机管线、复联雷达、群聊编辑、Markdown/旗舰交互 HTML 报告、隐私门禁；只读 Reader 的 WCDB 数据模型与接入状态机 |

> **一句话定位**：在本机把你的微信记录变成「可检索、可核查、可行动」的个人情报，并把选中的内容按场景送到合适的 Agent 或知识库。**只读、本地、不发送消息。**

---

## 一、能力总览（63 个 MCP 工具）

### 1. 接入与状态（9）
`wai_home` `wai_status` `wai_sources` `wai_access_plan` `wai_compat_check` `wai_self_test` `wai_doctor` `wai_profile_status` `wai_profile_init`

### 2. 采集与索引（9）
`wai_inbox_push` `wai_inbox_list` `wai_inbox_process` `wai_inbox_maintain` `wai_scan` `wai_vault_status` `wai_vault_scan` `wai_db_index` `wai_db_status`

### 3. 检索（7）
`wai_chat_search` `wai_db_search` `wai_chat_history` `wai_person` `wai_topic` `wai_wechat_labels` `wai_common_groups`

### 4. 情报（10）
`wai_signals` `wai_today` `wai_new_leads` `wai_brief` `wai_group_daily` `wai_contact_daily` `wai_reactivation` `wai_db_links` `wai_deal_radar` `wai_reply_draft`

### 5. 报告（4）
`wai_render_bundle` `wai_render_html` `wai_report_list` `wai_cleanup`

### 6. 商机管线（7）
`wai_opportunities` `wai_opportunity_sync` `wai_opportunity_update` `wai_opportunity_maintain` `wai_triage` `wai_feedback_add` `wai_feedback_list`

### 7. 微信流：转发与沉淀（13）
`wai_scene_list` `wai_scene_upsert` `wai_scene_match` `wai_target_list` `wai_deliver` `wai_obsidian_write` `wai_skill_list` `wai_skill_run` `wai_history_list` `wai_history_rerun` `wai_batch_create` `wai_batch_status` `wai_batch_deliver`

### 8. 隐私、配置与只读入口（4）
`wai_privacy_scan` `wai_config_get` `wai_config_set` `wai_reader`

---

## 二、架构（四层解耦，与上游同构）

```
入口层    MCP 工具（server.mjs，stdio JSON-RPC）+ 技能包（SKILL.md / references / workflows）
   ↓
桥接层    reader/index.mjs —— 统一只读数据源选择与协议适配
   ↓
只读核心  reader/{wcdb,sqlite,vault,cli,local,mock}.mjs —— 不获取密钥、不解密、不注入、不 Hook
   ↓
确定性引擎 signals.mjs / opportunities.mjs / views.mjs / report/* —— 索引、判断、报告、测试
```

### 关键设计

- **零运行时依赖**：只用 `node:` 内置模块（`node:sqlite`、`node:zlib`、`node:crypto`、`node:child_process`）。不需要 `npm install`，可离线部署。
- **中文检索用 LIKE，不用 FTS5**：FTS5 的 unicode61 分词器对中文无效（会把整段连续汉字当成一个词），因此中文检索走 `LIKE %词%`；这也让「报价」「商单」这类 2 字词完全可用。
- **确定性优先**：同一条消息的去重键只依赖 `会话|发送者|内容`（不含由「现在」推导出的时间戳），去重稳定；报告排序全部显式指定。
- **HTML 失败关闭**：报告 HTML 必须恰好 1 个内联脚本、必须带 CSP 与 `referrer: no-referrer`，结构异常时**拒绝输出**而不是降级为不安全的页面。

---

## 三、目录结构

```
wechat-ai/
├── SKILL.md                 # 大 skill 主入口（Agent 必读）
├── README.md                # 本文
├── 部署说明.md               # 部署速查（3 步 + 命令索引）
├── 部署说明.详细版.md         # 部署详细版（数据源配置、报告产物、排障、卸载）
├── install.mjs              # 安装器：环境检查 → 自检 → 注册 MCP 客户端
├── references/              # 参考文档（命令参考、信号规则、回复风格、群聊编辑、交付、接入、Windows 接入、隐私）
├── workflows/               # 工作流（接入自检、情报日报、联系人追踪、商机雷达、群聊编辑、转发 Agent、Obsidian 归档、批量收集）
├── assets/report.css
└── mcp/
    ├── server.mjs           # MCP 服务器（63 个工具，stdio JSON-RPC 2.0）
    ├── selftest.mjs         # 断言自检
    ├── DESIGN.md            # 内部接口契约
    └── lib/
        ├── paths.mjs util.mjs timewin.mjs duedate.mjs store.mjs config.mjs profile.mjs
        ├── parse.mjs inbox.mjs ingest.mjs signals.mjs opportunities.mjs views.mjs
        ├── replystyle.mjs security.mjs access.mjs
        ├── reader/  common.mjs index.mjs local.mjs vault.mjs cli.mjs sqlite.mjs wcdb.mjs mock.mjs
        ├── report/  security.mjs md.mjs html.mjs bundle.mjs
        └── wechat/  scenes.mjs targets.mjs clipboard.mjs obsidian.mjs skills-catalog.mjs history.mjs batch.mjs
```

数据根默认 `~/.wechat-ai`（可用环境变量 `WECHAT_AI_HOME` 覆盖）：

```
~/.wechat-ai/
├── config.json      # 数据源 / 场景 / 转发目标 / 设置（不含任何凭据）
├── profile.json     # 个人 Profile（本人昵称、重点标签、个人与计划文档路径）
├── store.db         # 本地索引（SQLite WAL）
├── inbox/           # 微信流 Inbox：new → processing → processed | failed
├── vault/           # 默认导出目录
├── output/          # 报告目录 output/<kind>-<时间戳>/
└── cache/           # 解析缓存与兼容性报告
```

---

## 四、快速开始

纯净发布包（`发布版本\wechat-ai\`，剔除开发机残留）**解压 / 拷贝即可部署**：零 npm 依赖，无 `node_modules\`、无 `.` 前缀目录，不需要生成任何依赖。

```powershell
cd D:\Users\DeepSeekWeb\wechat-ai
node install.mjs                 # 环境检查 + 自检 + 注册到本地 MCP 客户端
node install.mjs --no-register   # 只检查与自检
node install.mjs --dry-run       # 只打印将要写入的客户端配置
node mcp\server.mjs --list-tools # 查看全部 63 个工具
node mcp\selftest.mjs            # 自检（末尾输出 "=== N passed, M failed ==="）
```

注册后重启 MCP 客户端即可。手工注册的通用配置：

```json
{ "mcpServers": { "wechat-ai": { "command": "node", "args": ["D:\\Users\\DeepSeekWeb\\wechat-ai\\mcp\\server.mjs"] } } }
```

### 第一次使用（3 步）

1. `wai_status` / `wai_sources` —— 看有没有可用数据源；
2. 没有就按 `references/windows-access.md` 配一个（见下节），或先跑演示数据：`wai_db_index { "source": "mock" }`；
3. `wai_profile_init` 写入本人昵称与 2–5 个重点标签（例：客户 / 同行 / 渠道 / 品牌方）→ `wai_db_index` → `wai_today`。

之后常用入口：

| 想要 | 调用 |
|---|---|
| 过去 24 小时发生了什么 | `wai_group_daily` + `wai_contact_daily` + `wai_brief` |
| 生成完整日报（Markdown + 交互 HTML） | 上面三个 → `wai_render_bundle` |
| 今天先处理什么 | `wai_today` |
| 我和某人聊到哪、答应过什么 | `wai_person` |
| 某人刚回复，我该怎么回 | `wai_reply_draft` |
| 某产品/项目的来龙去脉 | `wai_topic` |
| 有没有新的商单/培训机会 | `wai_signals` + `wai_opportunity_sync` |
| 谁值得重新联系 | `wai_reactivation` |
| 把这段内容发给 Codex / 存到 Obsidian | `wai_inbox_push` → `wai_scene_match` → `wai_deliver` |

### 自然语言使用示例

装好之后**直接说人话**就行，不用记工具名（示例中的人名、群名、金额均为虚构）：

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 今天有什么要处理的？ | `wai_today` | 最多 10 项行动清单：待回复、逾期承诺、临近截止、待结算 |
| 昨天说要报价的那个客户回消息了吗？ | `wai_person` | 聊天进展、承诺清单与下一步 |
| 我和王总的合作聊到哪了？我答应过他什么？ | `wai_person` | 承诺、待回应要求、商业时间线（逾期项单独标出） |
| 帮我看看「AI 内训群」今天聊了什么重点 | `wai_group_daily` | 群日报：重点话题分层，闲聊与纯加热不混入 |
| 上个月说预算 3000 的内训机会现在什么状态？ | `wai_opportunities` | 商机阶段、下一步与到期提醒 |
| 谁好久没联系、值得问候一下？ | `wai_reactivation` | 复联雷达分档（下一批 / 复购保温 / 暂缓…） |
| 他刚回了我，怎么回比较合适？ | `wai_person` → `wai_reply_draft` | 贴合你历史语气的短草稿 |
| 搜一下我们聊过 API 对接的事 | `wai_chat_search` | 命中消息 [会话｜时间｜发言人] |
| 把今天的进展整理成日报 | `wai_group_daily` + `wai_contact_daily` + `wai_brief` → `wai_render_bundle` | Markdown + 交互 HTML 双产物 |
| 这几条帮我转给 Codex 处理 | `wai_inbox_push` → `wai_scene_match` → `wai_deliver` | 场景化提示词与投递预览（默认 dryRun） |
| 把这段结论存到我的知识库 | `wai_obsidian_write` | frontmatter 笔记预览，确认后才落盘 |
| 发出去之前检查一下隐私 | `wai_privacy_scan` | 发布门禁：敏感命中清单与处理建议 |

> 说「帮我回复他」只会得到**草稿**——本项目不发送任何消息；所有写操作默认 dryRun 预览，显式确认后才落盘。

---

## 五、接入方式（Windows 现实可行的五条路）

本项目**不获取微信密钥、不解密、不注入、不 Hook 微信**。可用数据源：

| 数据源 | 配置 | 能力 |
|---|---|---|
| **已解密数据库**（推荐） | `wai_config_set { "sqliteSources": [{ "id": "pc", "path": "D:\\wechat_decrypted" }] }` | 会话/联系人/标签/消息/群公告/群成员/收藏/朋友圈/HardLink 媒体；支持微信 4.x WCDB 布局（`db_storage` 下 session/contact/message/favorite/sns/hardlink）与 3.x `MSG` 表 |
| **导出目录** | `wai_config_set { "vaults": [{ "id": "v1", "path": "D:\\wechat_export" }] }` | 扫描 txt/md/json/jsonl/csv；自动识别 `[时间] 发送者: 内容`、`【群名】`、JSON 数组等格式 |
| **微信流 Inbox**（手动选择） | `wai_inbox_push { "body": "……", "chat": "客户群" }` | 完全不需要任何数据库权限；与微信流同构：选中的内容 → Inbox → 加工 → 投递 |
| **外部只读 CLI** | `wai_config_set { "readers": [{ "id": "rion", "command": "python", "args": ["…\\rion_wechat_reader.py"] }] }` | 兼容 `rion-wechat-cli` 协议（version/status/sessions/resolve-chat/timeline/search/members/sql）与 `fake_vault_cli` 契约（status/new-messages/search） |
| **演示数据**（虚构） | `wai_db_index { "source": "mock" }` | 零数据验证全链路；完全虚构，不含任何真实聊天 |

`wai_access_plan` 会告诉你当前卡在哪一层（缺目录 / 缺材料 / 依赖缺失 / 权限不足 / 可配置 / 就绪）以及下一步；`wai_compat_check` 做 status / sessions / timeline 三层冒烟测试。

---

## 六、与上游的关系与已知差异（诚实说明）

**完整实现**：情报引擎的全部信号规则与打分口径、商机管线的单调推进与去重、复联雷达的状态分档与话术、群聊编辑双产物、Markdown + 旗舰交互 HTML、隐私门禁扫描模式、微信流的场景/目标/技能/Inbox/Obsidian/历史/批处理核心逻辑。

**平台替代**：

- 上游微信流是 **macOS SwiftUI 应用**，依赖 Share 扩展、辅助功能注入 ⌘V、Vision OCR 读群名。本项目在 Windows 上把这些替换为：**文件 / 剪贴板 / 自定义命令投递** + **Inbox 目录** + **手动或从导出内容识别群名**；「代按 ⌘V」不实现，改为生成给 Agent 的提示词文件与明确指引。
- 上游 rion-wechat-reader 的**密钥获取**（LLDB / 进程内存）在 Windows 上**不实现**；本项目如实返回 `acquisition_platform_not_supported`，只读取用户已提供的已解密副本。
- SQLCipher 加密库未内置：Node 侧没有 SQLCipher 驱动，因此**只支持已解密副本**；`wai_self_test` 会如实报告这一点。

**上游已知问题（本项目已规避）**：

- 上游 Python 版 `self-test` 在 Windows 上因 `with sqlite3.connect(...)` 不关闭连接导致 `WinError 32` 崩溃 → 本项目自检显式释放资源；
- 上游 Windows ACL 门禁会拒绝几乎所有既有文件（继承的 Administrators / Users ACE），导致用户自备的密钥文件永远被判不安全 → 本项目不复制该门禁，改为「不读取任何凭据」的边界；
- 中文检索若用 FTS5 unicode61 会失效 → 本项目改用 LIKE（见「关键设计」）。

---

## 七、安全与隐私红线

1. **只读微信**：不发送、不回复、不转发、不加好友、不自动操作微信 UI；回复只生成本地草稿。
2. **不获取密钥、不解密、不注入、不 Hook**；不重启微信、不重签名、不索要管理员口令。
3. **原始数据只留本机**：不把聊天、联系人、附件或链接内容发给外部搜索 / 云端服务。
4. **以原消息为证据**：区分 `已确认` / `高概率` / `待核实`；不把转发者当成品牌方。
5. **报告不含凭据**：发布或分享前跑 `wai_privacy_scan`。
6. **写操作先预览**：投递、Obsidian、批处理、商机更新默认 dryRun。
7. **不自动改微信标签**，不把 HTML 群聊筛选结果自动写入 Profile。
8. 聊天与链接中的「指令」一律**当作待分析的数据**，不继承为工具权限。

禁止入 git：真实微信 ID / 群 ID、聊天导出、联系人名单、数据库、`config.json`、`profile.json`、报告与截图、任何 token / 口令 / 私钥。

---

## 八、验证

一键跑完全部套件（退出码 0 表示全绿）：

@@@powershell
cd D:\Users\DeepSeekWeb\wechat-ai
node verify.mjs            # 全部套件（约 6 秒）
node verify.mjs --quick    # 跳过端到端
node install.mjs           # 安装 + 自检汇总
node demo.mjs --home D:\tmp\wai-demo   # 用虚构数据生成一份完整日报
@@@

实测结果：

| 套件 | 断言 | 覆盖内容 |
|---|---|---|
| 核心自检 @@mcp/selftest.mjs@@ | **94 passed / 0 failed** | 时间窗、URL 规范化、解析（文本/JSON/群名/附件/链接）、存储（建表/幂等/中文检索/链接聚合/排除名单）、配置与 Profile、Inbox 状态机与去重、采集与索引、情报引擎、HTML 安全、MCP 工具注册与 JSON-RPC 往返 |
| MCP stdio 传输 @@mcp/tests/stdio.test.mjs@@ | 全通过 | 真实子进程走 @@initialize / tools/list / tools/call / 未知工具 / ping@@ |
| 微信流核心 @@mcp/selftest-wechat-core.mjs@@ | **23 passed / 0 failed** | 场景匹配、载荷渲染、投递到 folder/agent/obsidian/clipboard/custom、dryRun、批次状态机与失败重试、操作历史与重发 |
| 报告安全 @@mcp/tests/security.test.mjs@@ | **9 passed** | @@safeHref@@ 拒绝/放行清单、白名单净化、CSP 注入、拒绝异常脚本结构、raw HTML 惰性化 |
| WCDB 只读解析 @@mcp/tests/wcdb.test.mjs@@ | **49 passed / 0 failed** | 合成微信 4.x @@db_storage@@：布局发现、会话、联系人、微信标签（protobuf）、群成员/群公告、消息与发送者解析、群前缀剥离、@@kind_name@@ 映射、**zstd 解压**、收藏、朋友圈、红包/转账/转发、只读约束、@@sql@@ 守卫、降级状态机 |
| 结构漂移 @@mcp/tests/schema-drift.test.mjs@@ | **16 passed / 0 failed** | 列顺序打乱、缺 @@sort_timestamp@@/@@server_id@@/@@WCDB_CT@@/@@extra_buffer@@、表名大小写、微信 3.x @@MSG@@ 表、NULL/空/非法 UTF-8 正文、缺会话表、**多账号目录**、BOM/CRLF/全角冒号 |
| 内容级口径 @@mcp/tests/content.test.mjs@@ | **18 passed / 0 failed** | 上游测试固定下来的行为：明确非商单压过付费加热、@@10万+爆款@@ 不算粉丝数、社交主页 URL、ACK 不关闭承诺、复联六种状态、联系人日报状态与回复方向、digest 无 @@<details>@@ 且 URL 唯一 |
| 内容级口径·群聊矩阵与机会候选 @@mcp/tests/content2.test.mjs@@ | **13 passed / 0 failed** | 可行动类别（商单/培训/项目/活动/招聘/赚钱）的**上下文判定**、群聊价值矩阵分级（娱乐群/闲聊群不误判为重点）、群内日报与纯加热排除、机会候选（系统消息/叙述句不产候选、报价与加热奖励区分） |
| 其余只读数据源 @@mcp/tests/readers.test.mjs@@ | **30 passed / 0 failed** | @@vault@@（txt/md/json/jsonl/csv 五种格式 + 缓存）、@@cli@@（真实子进程）+ @@fake_vault_cli@@ 契约、@@local@@、@@mock@@ 覆盖全部信号类型 |
| 运维健壮性 @@mcp/tests/robustness.test.mjs@@ | **13 passed / 0 failed** | 空格/中文/emoji/超深数据根、损坏 config/profile/store 自愈、双连接并发写入、重复扫描幂等、1MB 单条正文、时间窗边界、非法参数 |
| 端到端验收 @@mcp/e2e.mjs@@ | **85 passed / 0 failed** | 63/63 个工具被真实调用，含 9 个报告渲染器逐个落盘校验 |

> 合计 **12 个套件 / 368 条断言** 全绿（另含 MCP stdio 传输全通过）。

隐私门禁：@@wai_privacy_scan@@ 发布视角 **0 findings**（默认跳过测试夹具）；加 @@includeTests: true@@ 会命中 6 处测试用合成标识 —— 这是预期行为。

## 九、性能与规模

@@@powershell
node mcp\bench.mjs                          # 20 万条 / 600 会话
node mcp\bench.mjs --n 500000 --sessions 1200
@@@

实测（Windows / Node 24 / 20 万条消息 / 600 会话 / 400 天）：

| 路径 | 耗时 |
|---|---|
| 批量写入 20 万条（含会话表） | ~2.4 s |
| 中文关键词检索（常见词，早停） | ~1 ms |
| 检索**不存在的词**（全表扫描，最坏情况） | ~30 ms |
| 24 小时群聊日报（60 群） | ~180 ms |
| 7 天群聊日报 | ~280 ms |
| 全历史（400 天）复联雷达 | ~640 ms |
| @@wai_person@@ / @@wai_today@@ / @@wai_brief@@ | ≤ 300 ms |

**已做的针对性优化**

1. **增量统计，消除 O(会话数 × 消息数)**：索引是「每个会话调用一次 ingestMessages」，而 @@recalcSessionCounts@@ / @@rebuildContactStats@@ 原本每次都全表重算。现在只重算本次涉及的会话与发送者；并有测试用「哨兵值」证明写入会话 A 不会重算会话 B。
2. **攒批写入**：@@ingestMessages@@ 支持 @@deferStats@@，@@indexFromReader@@ 每 20 个会话提交一次并由 @@flushIngestStats@@ 统一收尾。实测逐会话索引 2 万条：**3155 ms → 1571 ms（2.0×）**。
3. **可重入事务**：@@tx()@@ 在已处于事务中时不再 BEGIN/COMMIT，把一次摄取里的 3 次提交收敛成 1 次（微基准：逐次提交 555 ms vs 单事务 219 ms）。
4. **中文检索用 LIKE 而非 FTS5**：FTS5 的 unicode61 分词器对中文无效；实测全表 LIKE 扫描 20 万行仅约 25 ms，完全可接受。
5. **报告规模受控**：@@groupLimit@@（默认 60）真正生效，并回报 @@groupsTotal@@ / @@groupsTruncated@@，避免几百个群把日报撑爆。
6. **prepared 语句缓存**：@@store.mjs@@ 按连接缓存 prepare 结果（WeakMap，句柄 close/重建后自动失效）。逐会话索引 600 会话 / 3 万条：**4219 ms → 2146 ms**。
7. **复联雷达单遍扫描**：6 组正则合并为 @@REACTIVATION_ANY_RE@@ 预筛 + 单遍 48 字符窗口扫描 + 全命中早停，配合 @@messagesInWindow(light)@@ 轻量行（免解析 links/attachments JSON）。@@wai_reactivation@@ 全历史：**1319 ms → 641 ms**。
8. **承诺兑现检测 O(n²)→O(n)**：@@laterDelivered@@ / @@laterAcked@@ 后缀数组替代逐条向前扫描。@@analyze@@ 24h：**247 ms → 159 ms**。
9. **联系人统计增量维护**：@@insertMessages@@ 按「本次真正落库」的行累加（@@applyContactDelta@@），不再每次重扫发送者全量历史（该聚合随历史增长，逐会话索引时是 O(n²)，3 万行时实测 600 次 ≈ 700 ms）。@@flushIngestStats@@ 收尾仍精确重算兜底。逐会话索引：**2146 ms → 1833 ms**。
10. **链接权威化**：库行的 links 列在索引期已完整提取，分析路径对空数组不再重跑正文提取正则（@@messageLinks@@ + 不可枚举 @@_indexed@@ 标记；手写消息语义不变）；links 脏数据清理改为一次性迁移。

> 说明：@@node mcp/bench.mjs@@ 是**测量工具**，不参与门禁；规模回归由 @@mcp/tests/scale.test.mjs@@ 的确定性断言（增量语义 + 耗时上界）守住。

---

## 十、致谢与许可

本项目的**设计与规则口径**来自上述两个开源项目，代码为独立重写：

- WeChatBridge（微信流）—— AGPL-3.0，作者 freestylefly；
- wechat-intelligence-hub（微信个人情报库）—— AGPL-3.0 + 商业授权，作者 Rion Wu。

若你要再分发本项目，请自行确认与上游许可的兼容性，并保留本节的来源说明。本项目不含任何上游代码副本，也不含任何真实聊天、联系人、密钥或报告。

---

## 十一、版本记录

### v1.0.1（2026-10-03）

- 纯净发布包口径收紧：**无 `node_modules\`、无 `.` 前缀目录**（零 npm 依赖，解压 / 拷贝即可部署）
- 部署说明拆分为速查版 `部署说明.md`（3 步 + 命令索引）与 `部署说明.详细版.md`（数据源配置 / 报告产物 / 排障 / 卸载 / 安全边界）
- 对齐五包「版本与文档同步规范」：各文档「版本记录」+「自然语言使用示例」两节齐全，README 承载同步规范

### v1.0.0（2026-10-03）

- 首个发布版本：63 个只读工具全量（只读红线，无发送 / 密钥 / 解密 / 注入）
- 12 套件 / 368 断言全绿；句柄随调用释放 + store.db 删库自愈
- 性能优化：按连接语句缓存、复联雷达单遍扫描、承诺检测 O(n)、wai_today / 群日报约 -20%~-35%
- 自检与安装在中文路径下正常（fileURLToPath）；隐私门禁发布视角 0 findings

### 版本与文档同步规范

**每次更新版本，必须把「版本号 + 版本说明」同步到全部对应文档，缺一处即视为发版未完成：**

| 同步到 | 放什么 |
|---|---|
| `mcp/server.mjs` 的 `SERVER_VERSION` | 版本号唯一来源（不另存副本） |
| README「版本记录」 | 完整版本说明（新增一节 `### vX.Y.Z（日期）`） |
| `SKILL.md`「版本记录」 | 同版本号 + 版本说明（可精简，不得缺号） |
| `项目说明.md`「版本记录」 | 同上 |
| `部署说明.md` / `部署说明.详细版.md`「版本记录」 | 同上 |
| 文档包 `wechat-ai-docs` | 对应文档同步拷贝（README → `快速上手.md`） |
| 发布包 `发布版本\wechat-ai\` | 按纯净口径重打包（无 `node_modules`、无 `.` 前缀目录、剔除开发机残留）+ 包内自验收 |
| 发布包 `发布说明.md` | 发版条目（版本、纯净性、自验收实测） |

新增面向使用者的文档（SKILL / 部署说明 一类），同样要带「版本记录」与「自然语言使用示例」两节。
