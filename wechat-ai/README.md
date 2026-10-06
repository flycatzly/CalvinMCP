# wechat-ai — 微信个人情报库 + 微信流（Windows 本地只读）

把两篇公众号文章里介绍的两个开源项目的能力，重新实现成一个**可在 Windows 上运行的 MCP 服务器 + 大 skill（73 个技能工具）**：

| 上游项目 | 原文 | 本项目实现的部分 |
|---|---|---|
| [freestylefly/WeChatBridge](https://github.com/freestylefly/WeChatBridge)（微信流，macOS SwiftUI） | 《把聊天记录，变成 AI 的知识》 | 平台无关核心：Inbox 协议、会话场景、转发目标、内置技能、Obsidian 笔记、操作历史、批量收集 |
| [Rion-Wu-tech/wechat-intelligence-hub](https://github.com/Rion-Wu-tech/wechat-intelligence-hub)（微信个人情报库，Python） | 《微信聊天变成个人情报库》 | 确定性引擎：索引、信号检测、商机管线、复联雷达、群聊编辑、Markdown/旗舰交互 HTML 报告、隐私门禁；只读 Reader 的 WCDB 数据模型与接入状态机 |

> **一句话定位**：在本机把你的微信记录变成「可检索、可核查、可行动」的个人情报，并把选中的内容按场景送到合适的 Agent 或知识库。**只读、本地、不发送消息。**

---

## 一、能力总览（73 个 MCP 工具）

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

### 7. 微信流：转发与沉淀（14）
`wai_scene_list` `wai_scene_upsert` `wai_scene_match` `wai_target_list` `wai_deliver` `wai_obsidian_write` `wai_skill_list` `wai_skill_run` `wai_history_list` `wai_history_rerun` `wai_batch_create` `wai_batch_status` `wai_batch_stage` `wai_batch_deliver`

### 8. 隐私、配置与只读入口（4）
`wai_privacy_scan` `wai_config_get` `wai_config_set` `wai_reader`

### 9. 聊天记录分析（9，提示词全集 A–I）
`wai_period_report`（A 年度/月度报告） `wai_social_graph`（B 社交关系） `wai_sentiment_trend`（C 情绪趋势） `wai_task_extract`（D 时间任务） `wai_finance`（E 财务记录） `wai_memory`（F 记忆库） `wai_content_analysis`（G 内容分析） `wai_team_review`（H 团队分析） `wai_risk_scan`（I 风控线索）

---

## 二、架构（四层解耦，与上游同构）

```
入口层    MCP 工具（server.mjs，stdio JSON-RPC）+ 技能包（SKILL.md / references / workflows）
   ↓
桥接层    reader/index.mjs —— 统一只读数据源选择与协议适配
   ↓
只读核心  reader/{wcdb,sqlite,vault,cli,local,mock}.mjs —— 不获取密钥、不解密、不注入、不 Hook
   ↓
确定性引擎 signals.mjs / opportunities.mjs / views.mjs / analytics/* / report/* —— 索引、判断、分析、报告、测试
```

### 技术栈

- **运行时**：Node.js ≥ 22.5（实测 24.x），只用 `node:` 内置模块——`node:sqlite`（含 FTS5 / JSON1 / WAL）、`node:zlib`（含 zstd）、`node:crypto`、`node:child_process`。
- **协议**：MCP stdio JSON-RPC 2.0（`protocolVersion 2024-11-05`），工具前缀 `wai_*`；全工具声明 `outputSchema: {type:"object"}`，返回值恒为 record 信封。
- **零 npm 依赖**：不需要 `npm install`，可离线部署。

### 关键设计

- **零运行时依赖**：只用 `node:` 内置模块（`node:sqlite`、`node:zlib`、`node:crypto`、`node:child_process`）。不需要 `npm install`，可离线部署。
- **中文检索用 LIKE，不用 FTS5**：FTS5 的 unicode61 分词器对中文无效（会把整段连续汉字当成一个词），因此中文检索走 `LIKE %词%`；这也让「报价」「商单」这类 2 字词完全可用。
- **确定性优先**：同一条消息的去重键只依赖 `会话|发送者|内容`（不含由「现在」推导出的时间戳），去重稳定；报告排序全部显式指定。
- **HTML 失败关闭**：报告 HTML 必须恰好 1 个内联脚本、必须带 CSP 与 `referrer: no-referrer`，结构异常时**拒绝输出**而不是降级为不安全的页面。
- **群聊价值矩阵用上下文判定**：不用「出现某词就算信号」——否则「保底就 108 个人参与了」会被当成赚钱机会、「如果允许读取之前的商单」会被当成商单。
- **句柄随调用释放，删库可自愈**：每次工具调用结束即释放 SQLite 句柄（Windows 上被打开的 store.db 无法被外部删除），因此随时可手动删除 / 替换 store.db，下次调用自动重建为空库并通过 `notice` 告知；句柄失效（被外部关闭 / 替换）时优先重开健康库，只有确实损坏才备份为 `*.corrupt-*.bak`。

### 核心引擎（确定性规则模块）

- **`signals.mjs`**：待回复、承诺（ACK 不关闭）、截止、结算、跨群链接、可行动类别（商单/培训/项目/活动/招聘/赚钱——上下文判定）、群内日报识别、纯加热识别、娱乐群识别。
- **`opportunities.mjs`**：商机候选构造（系统消息/叙述句不产候选）、阶段与下一步、到期维护、人工分流（wait 必须带跟进日期）。
- **`views.mjs`**：今日行动、首页、联系人日报、主题报告、共同群、复联雷达（下一批/纯佣/交接/暂缓/复购保温/近期已联系）。
- **`report/md.mjs`**：群聊日报、联系人日报、简讯、旗舰 HTML 分区、群聊价值矩阵（分级：重点/雷达观察/关注/低优先级）。
- **`analytics/*.mjs`**（提示词全集 A–I）：期间报告 / 社交关系 / 情绪趋势 / 任务抽取（ICS）/ 财务台账（金额默认打码）/ 记忆卡与问答 / 内容分析（词频/话题/意图/实体/摘要/问答）/ 团队复盘 / 风控线索（needs_review，需人工复核）。统计与抽取全部确定性规则，证据带 `msg_id`、输出脱敏（`maskPii`），LLM 只做解读；提示词骨架见 `references/analysis-prompts.md`。

---

## 三、目录结构

```
wechat-ai/
├── SKILL.md                 # 大 skill 主入口（Agent 必读）
├── README.md                # 本文
├── 部署说明.md               # 部署完整指引（数据源配置、报告产物、排障、卸载、全部使用示例）
├── install.mjs              # 安装器：环境检查 → 自检 → 注册 MCP 客户端
├── verify.mjs               # 一键跑全部测试套件
├── demo.mjs                 # 用虚构数据生成完整日报（演示）
├── references/              # 参考文档（命令参考、分析提示词全集、信号规则、回复风格、群聊编辑、交付、接入、Windows 接入、隐私）
├── workflows/               # 工作流（接入自检、情报日报、联系人追踪、商机雷达、群聊编辑、转发 Agent、Obsidian 归档、批量收集）
├── samples/                 # 样例聊天与演示导出（全部虚构）
├── assets/report.css
└── mcp/
    ├── server.mjs           # MCP 服务器（73 个工具，stdio JSON-RPC 2.0）
    ├── selftest.mjs         # 核心自检
    ├── selftest-wechat-core.mjs  # 微信流核心自检
    ├── e2e.mjs              # 端到端验收（100 步 / 73 工具）
    ├── bench.mjs            # 规模基准（优化前后对照，测量工具不入门禁）
    ├── DESIGN.md            # 内部接口契约
    └── lib/
        ├── paths.mjs util.mjs timewin.mjs duedate.mjs store.mjs config.mjs profile.mjs
        ├── parse.mjs inbox.mjs ingest.mjs signals.mjs opportunities.mjs views.mjs
        ├── analytics/  core.mjs report.mjs content.mjs social.mjs sentiment.mjs tasks.mjs
        │               finance.mjs memory.mjs team.mjs risk.mjs render.mjs
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
cd D:\path\to\wechat-ai
node install.mjs                 # 环境检查 + 自检 + 注册到本地 MCP 客户端
node install.mjs --no-register   # 只检查与自检
node install.mjs --dry-run       # 只打印将要写入的客户端配置
node mcp\server.mjs --list-tools # 查看全部 73 个工具
node mcp\selftest.mjs            # 自检（末尾输出 "=== N passed, M failed ==="）
```

注册后重启 MCP 客户端即可。手工注册的通用配置：

```json
{ "mcpServers": { "wechat-ai": { "command": "node", "args": ["D:\\path\\to\\wechat-ai\\mcp\\server.mjs"] } } }
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

### 自然语言使用示例（速查表 · 9 个模块 · 覆盖全部 73 个工具）

装好之后**直接说人话**就行，不用记工具名（示例中的人名、群名、金额均为虚构）。下面是**紧凑速查表**：与「能力总览」同口径 9 个模块，一工具一行全覆盖。

#### 1. 接入与状态（9）

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 现在整体什么情况？ | `wai_home` | 数据新鲜度、索引计数、五个入口与信息分流总览 |
| 索引和数据源现在什么状态？ | `wai_status` | 消息数、会话数、联系人、最后索引时间与数据陈旧程度 |
| 都有哪些数据源可以用？ | `wai_sources` | 全部候选数据源与可用性 |
| 我的数据卡在哪一步？ | `wai_access_plan` | 接入状态机结论（缺目录 / 缺材料 / 就绪…）+ 下一步 |
| 这个数据源先冒烟测一下 | `wai_compat_check` | status / sessions / timeline 三层测试（ready / degraded / blocked） |
| 工具本身工作正常吗？ | `wai_self_test` | 读取器自检：快照可读、只读约束、zstd 解压 |
| 帮我做一次全面体检 | `wai_doctor` | 配置 / 数据源 / 索引 / 报告目录 / 隐私门禁逐项检查与修复建议 |
| 我的个人档案设置好了吗？ | `wai_profile_status` | 昵称、重点标签、个人 / 计划文档就绪度 |
| 初始化档案：昵称「阿远」，重点标签客户和品牌方 | `wai_profile_init` | 写入本人昵称与重点标签（不覆盖已有设置） |

#### 2. 采集与索引（9）

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 这几条聊天先存下来，群是「客户群-澄明科技」 | `wai_inbox_push` | 选中内容落入 Inbox（只留本机，不读微信） |
| Inbox 里现在堆了些什么？ | `wai_inbox_list` | 按状态（new / processing / processed / failed）列出条目 |
| 把 Inbox 新收的都解析进索引 | `wai_inbox_process` | 条目解析（附件 / 链接 / 联系人）写入本地索引 |
| Inbox 里 30 天前的旧条目清一下（先别真删） | `wai_inbox_maintain` | 过期清理**预览**（确认后才删） |
| D:\wechat_export 的聊天导出扫进来 | `wai_scan` | 扫描 txt / md / json / jsonl / csv 写入索引 |
| 我配置的导出目录里有多少可读内容？ | `wai_vault_status` | 各导出目录的文件数、会话数、消息数 |
| 把所有导出目录重新扫一遍 | `wai_vault_scan` | 全部导出目录扫描入索引（增量、幂等） |
| 把最近一周的会话都索引进来 | `wai_db_index` | 从数据源拉取建 / 刷新索引（可按时间窗 / 会话数） |
| 索引里最新的消息是什么时候的？ | `wai_db_status` | 索引新鲜度：最新消息、距今多久、上次索引时间 |

#### 3. 检索（7）

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 全库搜一下我们聊过 API 对接的事 | `wai_chat_search` | 跨源全文命中（写回索引保留全文） |
| 本地索引里搜「报价单」 | `wai_db_search` | 已索引范围快速检索（可限定会话与时间） |
| 把我和王总上周的聊天原文调出来 | `wai_chat_history` | 时间线原文（可关键词过滤） |
| 我和王总的合作聊到哪了？答应过他什么？ | `wai_person` | 联系人档案：进展、承诺、待回应要求 |
| 「澄明科技内训」这个项目的来龙去脉 | `wai_topic` | 跨群跨人主题时间线（按事件去重合并） |
| 「品牌方」标签下都有谁？ | `wai_wechat_labels` | 只读列出微信标签及标签下联系人 |
| 张三和李四有没有共同群？ | `wai_common_groups` | 按成员身份核验的共同群（不靠昵称猜） |

#### 4. 情报（10）

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 最近一天有哪些原始信号？ | `wai_signals` | 待回复 / 承诺 / 截止 / 结算 / 商机 / 培训 / 跨群链接等信号 |
| 今天有什么要处理的？ | `wai_today` | 最多 10 项行动清单（按真实紧迫度排序） |
| 有没有新冒出来的高优先级线索？ | `wai_new_leads` | 待审核候选线索（候选 ≠ 真实商单） |
| 近一天跨群跨人有什么要跟进的？ | `wai_brief` | 跨报告行动总览 |
| 「AI 内训群」今天聊了什么重点？ | `wai_group_daily` | 群日报：重点话题分层 + 群聊价值矩阵 |
| 重点联系人今天的私聊有什么要回的？ | `wai_contact_daily` | 联系人日报：待兑现、待回复与回复方向 |
| 谁好久没联系、值得问候一下？ | `wai_reactivation` | 复联雷达分档 + 可发话术 |
| 最近哪些链接在群里反复出现？ | `wai_db_links` | 跨群重复链接聚合（出现群、发布者、商单概率） |
| 有没有品牌方 / 中间人的合作信号？ | `wai_deal_radar` | 商单雷达：合作信号、培训咨询、待结算清单 |
| 他刚回了我，怎么回比较合适？ | `wai_reply_draft` | 贴合你历史语气的短草稿（只出草稿，不发送） |

#### 5. 报告（4）

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 把今天的进展整理成日报 | `wai_render_bundle` | 报告目录 → 旗舰交互 HTML + 分区 Markdown 站点 |
| 这份 Markdown 帮我转成安全的 HTML | `wai_render_html` | 白名单净化 + CSP 的静态 HTML（结构异常拒绝输出） |
| 都生成过哪些报告？ | `wai_report_list` | 历次报告目录与产物文件清单 |
| 30 天前的旧报告清一下（先预览） | `wai_cleanup` | 历史输出清理**预览**（确认后才删） |

#### 6. 商机管线（7）

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 现在在跑的商单都有哪些？什么阶段？ | `wai_opportunities` | 商机管线（默认只看正式机会，可只看到期） |
| 最近聊天里有没有新机会？先看看、别写库 | `wai_opportunity_sync` | 候选发现**预览**（dryRun；确认后才写入） |
| 把 3 号商单改成推进中，下周二再跟进 | `wai_opportunity_update` | 更新状态 / 阶段 / 优先级 / 下一步 / 跟进日期 |
| 14 天没动静的候选清理一下（先预览） | `wai_opportunity_maintain` | 过期候选标记**预览**（确认后才标记） |
| 5 号先等着，7 号再跟进 | `wai_triage` | 人工分流：推进 / 等待（必带跟进日期）/ 暂缓 / 忽略 / 成交 / 未成交 |
| 「AI 内训群」那个是真商单，帮我记一下 | `wai_feedback_add` | 持久化纠正（确认 / 假商单 / 忽略 / 低优先级） |
| 之前都做过哪些纠正记录？ | `wai_feedback_list` | 已记录的纠正清单 |

#### 7. 微信流：转发与沉淀（14）

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 都有哪些转发场景？ | `wai_scene_list` | 场景列表（客户群 / 项目群 / 商单群…按场景预设任务） |
| 加一个「竞品调研」场景 | `wai_scene_upsert` | 新增 / 更新场景（匹配关键词、任务提示词、默认目标） |
| 这段内容应该按哪个场景处理？ | `wai_scene_match` | 按群名 / 标题匹配场景，预览发给 Agent 的提示词 |
| 都能投递到哪些目标？ | `wai_target_list` | 转发目标清单（Agent / Obsidian / 剪贴板 / 文件夹 / 自定义） |
| 这几条帮我转给 Codex 处理 | `wai_deliver` | 场景化提示词投递（默认 dryRun 预览） |
| 把这段结论存到我的知识库 | `wai_obsidian_write` | Obsidian 笔记（frontmatter、附件、文件链接） |
| 内置技能都有什么？ | `wai_skill_list` | 内置技能目录（公众号文章提取、视频信息读取） |
| 这篇公众号帮我提取正文 | `wai_skill_run` | 生成结构化提取提示词与外壳（推理交给 Agent） |
| 之前都转发过哪些内容？ | `wai_history_list` | 操作历史（历次转发 / 投递记录） |
| 刚才那条再投一份到 Obsidian | `wai_history_rerun` | 历史记录换目标重投（默认 dryRun 预览） |
| 这 5 条内容一起收集起来 | `wai_batch_create` | 批量登记（pending → staging → ready → delivering → done） |
| 那批内容处理到哪了？ | `wai_batch_status` | 批次状态与逐条进度（失败条目保留原始载荷） |
| 把这批都暂存好、标记可交付 | `wai_batch_stage` | 暂存并标记 ready（原始载荷永不丢弃） |
| 把这批投递出去（先预览） | `wai_batch_deliver` | 投递 ready 条目（默认 dryRun 预览） |

#### 8. 隐私、配置与只读入口（4）

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 发出去之前检查一下隐私 | `wai_privacy_scan` | 发布门禁：真实 ID / 群 ID / 密钥 / 口令命中清单 |
| 现在配置了哪些数据源和场景？ | `wai_config_get` | 读配置（数据源 / 场景 / 目标 / 设置，不含任何凭据） |
| 把 D:\wechat_export 加为导出目录 | `wai_config_set` | 改配置（导出目录 / 只读 CLI / 解密库路径 / 设置项） |
| 直接看下这个库的会话列表 | `wai_reader` | 统一只读 Reader 命令面（status / sessions / timeline / search / sql…） |

#### 9. 聊天记录分析（9，提示词全集 A–I）

| 你这样说 | 背后调用 | 得到什么 |
|---|---|---|
| 帮我出一份今年的聊天年度报告 | `wai_period_report` | 消息量、活跃时段、热词口头禅、关系升温降温 + 5-10 条洞察 |
| 我和谁互动最多？谁总在群里被围着聊？ | `wai_social_graph` | 主动互找排行、回复时差、群核心与桥梁成员（近似） |
| 最近一个月大家情绪怎么样？ | `wai_sentiment_trend` | 情绪日线、压力话题（仅趋势，非医疗诊断） |
| 聊天里说过的事哪些还没办？ | `wai_task_extract` | 任务清单（负责人 / 截止 / 状态）+ 可导出 ICS |
| 上个月转来转去花了多少钱？ | `wai_finance` | 转账 / 红包 / AA 台账（默认金额打码）、月度净额 |
| 去年说的产品定价最后是怎么定的？ | `wai_memory` | 记忆卡检索式问答（只引用命中、附 msg_id） |
| 这些聊天主要在聊什么？高频词和话题帮我看下 | `wai_content_analysis` | 词频 / 话题聚类 / 意图 / 实体 / 摘要 / 问答 |
| 这周团队群里项目推进得怎么样？ | `wai_team_review` | 参与度、决策追溯、任务分配、风险提示（只提示不定性） |
| 聊天里有没有可疑的话术？ | `wai_risk_scan` | 诈骗 / 敏感信息 / 合规线索（needs_review，须人工复核） |

> 说「帮我回复他」只会得到**草稿**——本项目不发送任何消息；所有写操作默认 dryRun 预览，显式确认后才落盘。

**完整场景展开版**（同样的 9 个模块 / 73 个工具，含更细的对话示例与「工具覆盖清单（73/73）」，完整展开只留这一份）见 [部署说明.md](./部署说明.md)「完整使用自然语言示例」——紧随其「快速命令索引（速查）」，安装完即可对照使用。

---

## 五、接入方式（Windows 现实可行的五条路）

本项目**不获取微信密钥、不解密、不注入、不 Hook 微信**。可用数据源：

| 数据源 | 配置 | 能力 |
|---|---|---|
| **已解密数据库**（推荐） | `wai_config_set { "sqliteSources": [{ "id": "pc", "path": "D:\\wechat_decrypted" }] }` | 会话/联系人/标签/消息/群公告/群成员/收藏/朋友圈/HardLink 媒体；支持微信 4.x WCDB 布局（`db_storage` 下 session/contact/message/favorite/sns/hardlink，完整六类解析需显式 `source: "wcdb:path"` 选择；`sqlite:path` 是 3.x MSG + 4.x message/Name2Id 窄实现）与 3.x `MSG` 表 |
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

```powershell
cd D:\path\to\wechat-ai
node verify.mjs            # 全部 15 套件（约 30 秒）
node verify.mjs --quick    # 跳过端到端
node install.mjs           # 安装 + 自检汇总
node demo.mjs --home D:\tmp\wai-demo   # 用虚构数据生成一份完整日报
```

实测结果：

| 套件 | 断言 | 覆盖内容 |
|---|---|---|
| 核心自检 `mcp/selftest.mjs` | **98 passed / 0 failed** | 时间窗、URL 规范化、解析（文本/JSON/群名/附件/链接）、存储（建表/幂等/中文检索/链接聚合/排除名单）、配置与 Profile、Inbox 状态机与去重、采集与索引、情报引擎、HTML 安全、MCP 工具注册与 JSON-RPC 往返 |
| MCP stdio 传输 `mcp/tests/stdio.test.mjs` | 全通过 | 真实子进程走 `initialize / tools/list / tools/call / 未知工具 / ping` |
| 微信流核心 `mcp/selftest-wechat-core.mjs` | **23 passed / 0 failed** | 场景匹配、载荷渲染、投递到 folder/agent/obsidian/clipboard/custom、dryRun、批次状态机与失败重试、操作历史与重发 |
| 报告安全 `mcp/tests/security.test.mjs` | **12 passed** | `safeHref` 拒绝/放行清单、白名单净化、CSP 注入、拒绝异常脚本结构、raw HTML 惰性化、报告落盘脱敏（brief/JSON 字符串值打码、数字保留、回复草稿豁免） |
| WCDB 只读解析 `mcp/tests/wcdb.test.mjs` | **49 passed / 0 failed** | 合成微信 4.x `db_storage`：布局发现、会话、联系人、微信标签（protobuf）、群成员/群公告、消息与发送者解析、群前缀剥离、`kind_name` 映射、**zstd 解压**、收藏、朋友圈、红包/转账/转发、只读约束、`sql` 守卫、降级状态机 |
| 结构漂移 `mcp/tests/schema-drift.test.mjs` | **16 passed / 0 failed** | 列顺序打乱、缺 `sort_timestamp`/`server_id`/`WCDB_CT`/`extra_buffer`、表名大小写、微信 3.x `MSG` 表、NULL/空/非法 UTF-8 正文、缺会话表、**多账号目录**、BOM/CRLF/全角冒号 |
| 内容级口径 `mcp/tests/content.test.mjs` | **18 passed / 0 failed** | 上游测试固定下来的行为：明确非商单压过付费加热、`10万+爆款` 不算粉丝数、社交主页 URL、ACK 不关闭承诺、复联六种状态、联系人日报状态与回复方向、digest 无 `<details>` 且 URL 唯一 |
| 内容级口径·群聊矩阵与机会候选 `mcp/tests/content2.test.mjs` | **13 passed / 0 failed** | 可行动类别（商单/培训/项目/活动/招聘/赚钱）的**上下文判定**、群聊价值矩阵分级（娱乐群/闲聊群不误判为重点）、群内日报与纯加热排除、机会候选（系统消息/叙述句不产候选、报价与加热奖励区分） |
| 其余只读数据源 `mcp/tests/readers.test.mjs` | **41 passed / 0 failed** | `vault`（txt/md/json/jsonl/csv 五种格式 + 缓存）、`cli`（真实子进程）+ `fake_vault_cli` 契约、`local`、`mock` 覆盖全部信号类型；`wcdb:` 源接线（getSource/listSources、状态机与加密库拒绝、工具面 `sql` 错误形状统一） |
| 运维健壮性 `mcp/tests/robustness.test.mjs` | **19 passed / 0 failed** | 空格/中文/emoji/超深数据根、损坏 config/profile/store 自愈、双连接并发写入、重复扫描幂等、1MB 单条正文、时间窗边界、非法参数、opportunity_sync 与 deliver 的 dryRun 零改库 |
| 规模与增量语义 `mcp/tests/scale.test.mjs` | **44 passed / 0 failed** | 增量幂等、`sessionBatchWriter` 分批/批内原子/批间独立、`scanPath` 记账与重扫幂等、取行列面/裸行列面契约与双映射路径等价、耗时上界（防 O(n²) 退化）、话题聚类单遍合并/实体表预筛门+直聚合/sentiment 共享正则/词频×话题共享单遍/summary×type_breakdown 共享分类/选句打分链路扫描侧（正则提级+长度早退）/type_breakdown 单调 hoist/词频枚举热循环（停用边位图预检）/socialGraph 月度桶数值年月键（轮20）/teamReview lazy 建行（轮21）/teamReview 日桶数值键（轮22）的相对耗时 |
| 分析引擎（A–I 九模块）`mcp/tests/analytics.test.mjs` | **47 passed / 0 failed** | 消息分类/分词/分桶/脱敏、A 期间报告、B 社交图、C 情绪趋势（含否定词与共享正则状态锁）、D 任务+ICS、E 财务（默认金额打码）、F 记忆卡+问答、G 内容分析+实体+问答（含话题聚类/实体预筛门/dedupe/词频×话题共享/kinds 共享分类与 type_breakdown 序列化等价语义锁、typeBreakdown 双调 hoist 等价与 A-I 输出 JSON 形态审计锁、bullets 语义金值、词频/话题金值逐位锁、socialGraph 月度桶数值年月与 toISOString 键逐位等价（轮20）、teamReview lazy row 语义锁（轮21）、teamReview 日桶数值键与 toISOString 键逐位等价（轮22））、H 团队复盘、I 风控线索（证据脱敏）、渲染落盘、MCP 接线（repo 外落盘拒绝） |
| 修复回归（BUG-1~6/8）`mcp/tests/regression.test.mjs` | **8 passed / 0 failed** | v1.1.1 七项修复的回归锁：chat_search 全文写回+幂等（maxTextChars 只管展示截断、二次写入 0 插入）、new_leads/feedback_add record 契约、opportunity_update followUp 三路径（组合/单独/clearFollowUp）、群日报下钻摘要候选与 history_list summary 守卫（无 [object Object]）、config_set settings 声明与 3 条拒绝边界、73 工具/schema 基线；全跑隔离 WECHAT_AI_HOME（handleRpc 直调）不碰真实 store |
| 契约面（outputSchema+record 信封）`mcp/tests/contract.test.mjs` | **99 passed / 0 failed** | tools/list 声明面（73 工具、outputSchema 恒 {type:"object"}、inputSchema 形态、无重名）；73 工具空参数信封一次遍历（成功/报错皆可，structuredContent 恒 record、content 文本无 [object Object]）；mock 全量渲染（A–I 分析/日报/简报/复联/Bundle/render_html）后数据根文本产物（.md/.json/.html/.txt/.csv/.ics）全扫描无 [object Object]——pick 双名路径类缺陷（BUG-3 同类）的内容层免疫网 |
| 端到端验收 `mcp/e2e.mjs` | **100 passed / 0 failed** | 73/73 个工具被真实调用（含批次 create→stage→deliver 全链路），含 9 个报告渲染器逐个落盘校验与分析报告落盘 |

> 合计 **15 个套件 / 587 条断言** 全绿（另含 MCP stdio 传输全通过）。

隐私门禁：`wai_privacy_scan` 发布视角 **0 findings**（默认跳过测试夹具）；加 `includeTests: true` 会命中 6 处测试用合成标识 —— 这是预期行为。

## 九、性能与规模

```powershell
node mcp\bench.mjs                          # 20 万条 / 600 会话（每行 3 跑取中位，见下）
node mcp\bench.mjs --runs 1                 # 单跑模式（不取中位）
node mcp\bench.mjs --n 500000 --sessions 1200
```

实测（Windows / Node 24 / 20 万条消息 / 600 会话 / 400 天，每行 3 跑取中位）：

| 路径 | 耗时 |
|---|---|
| 批量写入 20 万条（含会话表） | ~1.9 s |
| 中文关键词检索（常见词，早停） | ~1 ms |
| 检索**不存在的词**（全表扫描，最坏情况） | ~25 ms |
| 24 小时群聊日报（60 群） | ~80 ms |
| 7 天群聊日报 | ~120 ms |
| `analyze` 全历史（400 天 / 20 万条） | ~300 ms |
| 全历史（400 天）复联雷达 | ~235 ms |
| `wai_person` / `wai_today` / `wai_brief` | ≤ 300 ms |

**已做的针对性优化**

1. **增量统计，消除 O(会话数 × 消息数)**：索引是「每个会话调用一次 ingestMessages」，而 `recalcSessionCounts` / `rebuildContactStats` 原本每次都全表重算。现在只重算本次涉及的会话与发送者；并有测试用「哨兵值」证明写入会话 A 不会重算会话 B。
2. **攒批写入**：`ingestMessages` 支持 `deferStats`，`indexFromReader` 按 `chunkSize` 攒批提交（当时默认 20，现 100，见第 16 条）并由 `flushIngestStats` 统一收尾。实测逐会话索引 2 万条：**3155 ms → 1571 ms（2.0×）**。
3. **可重入事务**：`tx()` 在已处于事务中时不再 BEGIN/COMMIT，把一次摄取里的 3 次提交收敛成 1 次（微基准：逐次提交 555 ms vs 单事务 219 ms）。
4. **中文检索用 LIKE 而非 FTS5**：FTS5 的 unicode61 分词器对中文无效；实测全表 LIKE 扫描 20 万行仅约 25 ms，完全可接受。
5. **报告规模受控**：`groupLimit`（默认 60）真正生效，并回报 `groupsTotal` / `groupsTruncated`，避免几百个群把日报撑爆。
6. **prepared 语句缓存**：`store.mjs` 按连接缓存 prepare 结果（WeakMap，句柄 close/重建后自动失效）。逐会话索引 600 会话 / 3 万条：**4219 ms → 2146 ms**。
7. **复联雷达单遍扫描**：6 组正则合并为 `REACTIVATION_ANY_RE` 预筛 + 单遍 48 字符窗口扫描 + 全命中早停。`wai_reactivation` 全历史：**1319 ms → 641 ms**。
8. **承诺兑现检测 O(n²)→O(n)**：`laterDelivered` / `laterAcked` 后缀数组替代逐条向前扫描。`analyze` 24h：**247 ms → 159 ms**。
9. **联系人统计增量维护**：`insertMessages` 按「本次真正落库」的行累加（`applyContactDelta`），不再每次重扫发送者全量历史（该聚合随历史增长，逐会话索引时是 O(n²)，3 万行时实测 600 次 ≈ 700 ms）。`flushIngestStats` 收尾仍精确重算兜底。逐会话索引：**2146 ms → 1833 ms**。
10. **链接权威化**：库行的 links 列在索引期已完整提取，分析路径对空数组不再重跑正文提取正则（`messageLinks` + 不可枚举 `_indexed` 标记；手写消息语义不变）；links 脏数据清理改为一次性迁移。
11. **取数瘦身（按消费字段窄取列）**：node:sqlite 的 `.all()` 行物化成本随列数上升（200k 行实测：5 列 215 ms / 10 列 313 ms，再叠 `rowToMessage` 映射）。复联改走 `messagesRaw`（5 列裸行，跳过映射）：**629 ms → 324 ms**；`analyze` 与 `wai_today` / `wai_deal_radar` 改走 `messagesForAnalyze`（6 列 + links 解析）：**1085 ms → 721 ms**，`wai_today` **261 ms → 179 ms**；窗口取行 `messagesInWindow` 按消费列窄取 10 列（跳过 `session_id/day/attachments/run_id`）：400d 全窗 **787 ms → 577 ms**，受益面是 `wai_group_daily` / `wai_brief` / `wai_signals` / `wai_opportunity_sync` 等分析入口。写入侧 `wai_scan`（scanPath）逐文件一事务改为每 20 文件一事务（宽度后随默认调参为 100，见第 16 条）+ 生成器流式解析：600 文件/3 万条 **692 ms → 127 ms（5.45×）**。同场 POC 否证了两个「看起来该做」的方向并记入本文「优化决策记录」：中文全文索引（LIKE 本就 ~9 ms）与词表扫描器（原生 `includes` 长文本更快）。
12. **真实环境测试修复 + 攒批逻辑收敛**：对真实 `~/.wechat-ai` 跑 53 项只读调用实测，发现并修复 3 个缺陷——`wai_person` 只认会话名（纯发送者查不到，现回退发送者匹配并以 `matched_by` 标注；`wai_reply_draft` 遇纯发送者给出可执行错误指引）、`wai_scan` 对不存在的路径静默返回 0 文件（现报「扫描目标不存在」）、`server.mjs` 被 `import` 时也注册 stdin `end` 处理器并 `process.exit(0)`（宿主事件循环一让出就被误杀，现仅直接运行时启动 stdio 传输）。写入侧把 `indexFromReader` 自带的 flushChunk 收敛为 `sessionBatchWriter`（与 `ingestSessionBatches` / `scanPath` / `wai_vault_scan` 共用同一套攒批+统计收尾），行为等价由测试锁定；bench 无回退（wai_vault_scan 形态 551 ms，单事务对照 383 ms）。
13. **行物化映射瘦身（避开 null 原型行的展开慢路径）**：分解实测发现 `messagesInWindow` 400d 的 604 ms 里映射占 ~266 ms，而大头是 `{...r}` 对 node:sqlite 行的展开——sqlite 行是 null 原型对象，V8 展开走慢路径（20 万行 205 ms，同内容纯 JS 对象整套映射才 41 ms）。`rowToMessage` / `rowToMessageLight` 改逐键拷贝到普通对象（键面/JSON/spread 丢失行为完全不变）后映射成本砍半。第二步把映射残余三件套再收掉：`_indexed` 标记改挂原型（免每行 `defineProperty`）、links/attachments 兜底共享冻结空数组（全库零变更点已审计，冻结使误改快速失败）、`is_owner` 并入拷贝循环——微基准 140→102 ms（-27%）。两步合计：`messagesInWindow` 400d **604→395 ms（-35%）**，24h 87→61 ms；`analyze` 400d **722→568 ms**（取数与窗口共用该映射）、`wai_today` 179→141 ms、`wai_brief` 24h 117→88 ms。写路径不经过该映射，无回退；映射残余 ~75 ms 已近地板（拷贝循环 + links JSON 解析不可省），400d 全窗的下一个地板是 10 列 `.all()` 行物化本身（~300 ms）。
14. **analyze 计算侧微优化（文本判定去重与词表复用三件套）**：先用 `node --cpu-prof` 对合成库做函数级归因（不插桩），20 万条计算侧 267 ms 的热点是逐条文本谓词（日报/纯互动/低价值/可行动 ≈54 ms）、`hits` 词表扫描 ≈49 ms、`isLowValueChat` 全家 ≈41 ms——其中对 90 词商机词表（`OPPORTUNITY_TERMS`）的整段拼接全文重扫 + `名字\n全文` 拼接属纯冗余。三件套：①可行动四判（只依赖文本）按 content 记忆化，同一文本只判一次，内部分步短路与逐条判定完全同序；②`isLowValueChat` 新增可选 `opportunityHits` 参数复用调用方已算的商机 4 组词表命中（那 90 词就是 4 组并集，>0 存在性口径严格等价；不传参数的直接调用不变）；③6 处只看存在性的 `hitCount(...)>0` 换 `hasAny`（`.some()` 首命中即停、不建命中数组）。输出逐项不变（POC 计数对照 + 内容级口径套件锁定）。指标：计算侧 267→182 ms（-31%），bench `analyze` 400d **568→516/520 ms**（两跑稳定；该行含 ~325 ms 取数地板，行级收益被地板摊薄）。注意记忆化收益与语料重复度成正比——bench 合成语料仅 50 个不同文本（重复 4000×）会放大收益，真实语料按 2-3× 重复保守估（详见本文「优化决策记录」）。
15. **真实实测修复 4 处参数/配置契约缺陷 + 参数边界集中校验 + 承诺/截止链路两件套**：对真实 `~/.wechat-ai` 副本跑 100 调用扫描（含对抗变体），实锤 4 个缺陷——①`limit:-5` 直通 SQLite 负 `LIMIT` 成无界查询（一次返回 233 行真实内容）；②空/纯空白 `query` 变 `LIKE %%` 全量返回（与 `wai_person` / `wai_topic` 空值显式报错口径不一致）；③`wai_config_set` 的 `settings` 是 `P.any` 裸 patch：未知键静默落盘、字符串/数组被 spread 展开成 "0","1" 索引垃圾键污染 `config.json`，`targets/scenes` 缺 id 被追加成无主条目；④`days/hours` 负值经 `resolveWindow` 窗口反转变成「未来窗口」却标注「过去 N 小时」（`days:-3` → [now, now+72h]）。修复：`server.mjs` 增加按 `inputSchema` 的集中运行期校验 `checkArgs`（类型 + minimum/maximum + minLength；只校验调用方给出的键、null 视为未给、未知键不拦以免误伤扩展调用），`P.*` 支持 `min/max/minLength` 约束并同步进 inputSchema（32 处 limit/计数属性 `min:0`、必填 `query` `minLength:1`、`hours/days` `min:0`）；`wai_config_set` 工具体校验 settings 形状 + 已知键白名单（`defaultConfig().settings` 键 + `reader`）+ 值必须是标量 + targets/scenes 每项必须带非空 id。同轮计算侧再收两件套：①`extractDueDates` 便宜预筛（必需字符类是所有日期形态的必要条件，1 个字符类测试顶 12 组正则全扫）；②承诺/截止链路 `isAck/isPromise/短承诺/交付证据` 按 content 记忆化 + due 按（文本 × 消息本地日历日）记忆化（`extractDueDates` 相对日期只依赖 ref 的本地 y/m/d，`nextWeekday` 归一到本地零点；UTC 日分桶会跨日串值，不可用）。等价对拍：固定 epoch 语料 + 固定 now，整份 `analyze` 输出 sha256 前后逐位一致，计数全同。指标：计算侧 **180→158 ms（-12%）**，bench `analyze` 400d **516/520→481/509 ms**（均值 -23 ms，与计算侧一致）；契约由 robustness 新增 5 条 + selftest 新增 2 条锁定（dryRun 零改库改用紧贴快照法复验通过）。
16. **真实微信数据契约修复 2 处 + 攒批宽度调参（chunkSize 20→100）**：对真实 `~/.wechat-ai`（微信 4.x `db_storage`，19 个加密库）跑全链路实测（流程 21 项 + Inbox 管线 8 项，库文件快照前后一致），修复 2 个缺陷——①`wcdb.mjs`（六类 `db_storage` 解析实现）此前只在测试可达、工具面选不到：现接进 reader 注册表（`source: "wcdb:path"`，`wai_sources` 可见），`DESIGN.md` 对 sqlite/wcdb 两实现的描述同步纠正，工具面 `sql` 错误形状统一为 `error: string + error_code: string`（reader 内部 `{code,message}` 对象不再穿透）；②`wai_deliver` 的 `dryRun:true` 违反「只预览不落盘」写入 history/delivery 表（现仅真实执行留痕，全表快照契约测试锁定）。同轮单点优化：`sessionBatchWriter` 的 `chunkSize` 默认 20→100（`ingestSessionBatches` / `scanPath` / `indexFromReader` / `wai_vault_scan` 共用），调参 POC（4000 会话/20 万条中位数）20→1246 ms/30 提交、100→637 ms/6 提交、500→519 ms/2 提交、单事务地板 478 ms——100 已近地板且批内驻留内存有界（500 上限保留）；bench wai_vault_scan 形态 **546/578→440/443 ms（-19%，插入 30000 等价）**，单事务对照 377 ms 无回退。真实库只做加密识别与状态上报（needs_access），不解密、不注入、不改动。
17. **analyze 取数链路数组行化（`setReturnArrays`）**：POC 归因（20 万行 × 6 列）显示行物化与逐行映射各占约一半——对象行 `.all()` 物化 210ms + rowToMessage 映射 102ms；Node 23.4+ 的 `StatementSync.setReturnArrays(true)` 让行以数组返回，物化只要 132ms，配合定键拷贝（免逐行 `Object.keys` 分配）与 links `'[]'` 快路径（免 20 万次 `JSON.parse('[]')` + 分配），整链 **311→152ms（-51%）**。落地为 `messagesForAnalyze` 专用：数组行 + `rowFromTuple` 下标映射（列序与 `ANALYZE_COLS` 同源、取数前 `stmt.columns()` 校验，漂移即抛错）；旧 Node（无 `setReturnArrays`）自动回退对象行 + `rowToMessage`，双路径逐行 JSON 等价由测试锁定。等价对拍：固定语料 + 固定 now，`messagesForAnalyze` 行与整份 `analyze` 输出 sha256 改前改后逐位一致。指标：bench `analyze` 400d **481/509→314-395ms（中位 ~328，-34%）**、`wai_today` 141→~87ms、`analyze 24h` ~70ms；写路径无涉（无回退）。**否证记录**：「10 列 `.all()` 行物化是硬地板」不成立——数组行模式把物化直接砍 37%，`messagesInWindow` 已于第 18 条同法跟进、`messagesRaw` 尚余。
18. **窗口取行数组行化（`messagesInWindow` 非 light 路径）**：把数组行模式跟进到窗口取行（10 列消费面）——`WINDOW_COLS` 常量同源拼 SQL + `rowFromWindowTuple` 下标映射 + `stmt.columns()` 列序校验 + 旧 Node 回退对象路径；轻量行（`light:true`，当前无调用方）保持不动。POC（20 万行 × 10 列）：对象行物化 301ms / 数组行 237ms，整链 **408→235ms（-42%）**，双路径逐行 JSON 等价。等价对拍：固定语料下 `messagesInWindow` 非 light/light 行序列与 `analyze` 输出 sha256 改前改后逐位一致。指标：bench `messagesInWindow 400d` **419→241/260ms（-41%）**、24h 59→33/43ms、7d 102→57/60ms；受益工具行 `wai_group_daily 24h` 109→~77ms、7d 168→~116ms、`wai_brief 24h` 80→~58ms；`analyze` / `wai_today` 与写路径无回退。剩余跟进面：`messagesRaw`（复联 5 列裸行，见第 19 条）与轻量行路径。
19. **裸行取数数组行化（`messagesRaw`，复联全历史路径）**：最后一块对象行取数跟进数组行模式——`RAW_COLS` 常量同源拼 SQL + `rowFromRawTuple` 五键直赋 + `stmt.columns()` 列序校验 + 旧 Node 回退裸行；轻量行路径（无调用方）仍留。与前两轮不同：裸行本无旧映射可省，**取数级**收益上限即物化差（POC 20 万行 5 列：对象行 ~220ms / 数组+轻映射 ~185ms，-12~-18%，用 `{}` 而非 `Object.create(null)` 映射再快 5-15%）；**链路级**收益更大——行对象从 null 原型换成普通对象（与 `rowToMessage` 行同型）后，下游 `reactivation()` 逐行属性访问走 V8 快隐藏类路径。同版本 bench A/B（临时回退取基线）：`reactivation 400d` **358→229/240ms（-34%）**、工具行 `wai_reactivation 400d` **347→232/234ms（-33%）**。等价对拍：`messagesRaw` 行序列 + `reactivation` 双参数（`inactiveDays` 21 与 0 全量路径）整份输出 sha256 改前改后逐位一致，轮10/11 四哈希同场回归不变；`is_owner` 保持裸值 0/1 保 JSON 逐位等价（测试锁定键序与双路径 JSON 等价）。

20. **分析入口归因否证 + bench 稳态化（测量基建，无产品代码变更）**：先用 `node:inspector` Profiler 对 `wai_signals` / `wai_deal_radar` 分析入口做函数级归因（零插桩、计时段内采样）——**无 ≥10% 可动作 JS 热点**（`wai_signals` 426ms：SQLite 原生 `all` 24.8%、GC 13.4%、内联映射 10.7%、`analyze` 7.4%，余为分散文本谓词；大头是绑定/GC/已收割过的映射层），单点优化空间见顶，转向测量基建。bench 稳态化：每行 3 跑取中位，极差 >15% 随行输出 `[N 跑 a/b/c]`，`--json` 带 `spreadMs`，`--runs 1` 可退单跑；**跨跑自污染防护**——同进程连跑同一 fn 时，跑 1 的 20 万行垃圾会让跑 2/3 计算行慢 ~2×（机制=GC 压力，`--runs 1` 立即回基线可证），故每次测量前 `global.gc()` 隔离（未带 `--expose-gc` 自动重启自身补上），GC 不计时；写路径行 fn() 自带 `snapshot()` 同起点副本、工具行时间窗毫秒级解析保各跑冷路径、语料写入行单跑。指标：`analyze 400d` 中位 299-302ms、`reactivation 400d` 226-229ms、`wai_reactivation 400d` 226-232ms、整批写入 364-373ms（与单跑基线逐一吻合）；读行跨跑极差 ≤8%，写路径逐会话形态受 fsync 噪声可 ±30%（随行可见）。

21. **长驻进程稳态实测否证 + `entityTable` 正则族预筛与聚合直建**：先量「bench 跨跑污染是否外推到真实工具链路」——server `handleRpc` 内连跑 `wai_signals`（毫秒级错开 until 保冷键）：紧循环 10× 比值 0.85×、GC 隔离 1.08×、1.5s 间隔 1.00×，**不复现 2× 慢化**（垃圾可积 ~1GB 不掉速；活堆 ~552MB 由 `analysisCache` 8 条目 FIFO 封顶、无泄漏），据此否决「analyze 分配削减」分支。转 `entityTable`（内容分析最大单项，200k 行分解：5 组 matchAll ≈313ms、extractDueDates ≈116ms、extractAmounts ≈89ms、push+dedupe ≈169ms）两件事：①正则族预筛门 `keywordGate` 从活正则源串自动派生「必要条件字符类」（各最内层交替组纯字面分支首字符 + 源串首字面量，任一匹配必含其一），门不中即跳过全文扫描、命中仅回退原正则、解析失败 fail-open 直跑（只丢优化不丢正确性）；②聚合直建 dedupe 映射（替代 push 入数组→事后 dedupe），顺带清除从未被读的 `time` 死字段（每 push 一次 `Date`+`toISOString` 纯浪费）。等价对拍：固定语料 + 从活正则源派生的实体全量分支语料（逐关键词覆盖）双语料 `entityTable` / `contentAnalysis` 整份 sha256 改前改后 4/4 逐位一致；测试锁双路径逐项等价 + 门必要条件（关键词必过门/寒暄不过）。同版本 A/B（GC 隔离 3 跑中位）：`entityTable` **739→191ms（-74%）**、`contentAnalysis` **1538→991ms（-36%）**（首轮只加门 -12% 未达 ≥15% 指标，同点收尾聚合直建后达标）；verify 13 套件全绿。

### 优化决策记录（POC 结论，防止重复试错）

上面 21 条是「做了什么」，这里记「试过但否证 / 结论边界」——新优化先查本节，已被否证的方向不要再投：

- **中文全文检索索引：暂缓**。20 万条 / 4MB 正文下 `LIKE %词%` 全表扫描仅 ~9ms；bigram 预分词 FTS5 可到 2ms（4×）但索引膨胀 2.5×（4MB→10MB）且要维护写入路径 + 回填；trigram 对 2 字中文关键词（报价/预算）直接 0 命中。检索入口是 MCP 工具调用（LLM 推理在秒级），9ms 不构成体验瓶颈，不值得付出永久复杂度。
- **词表扫描器（首字索引单遍扫描）：否证回退**。逐字符 JS 循环 ~21ns/char，V8 原生 `String.includes` 长文本快得多：6KB 文本 8 组词表（134 词）旧实现 0.051ms vs 单遍扫描 0.135ms。索引版只在「短文本 + 大词表」占优，而该类调用点都有正则预筛、触发率低。保留最简 `hits()` 实现。
- **行物化是取数瓶颈**：`.all()` 成本随列数上升（200k 行：5 列 215ms / 10 列 313ms）；`stmt.iterate()` 流式反而更慢（262 vs 156ms）；大 `IN(330)` 劣于临时表 JOIN（320 vs 159ms）。结论：按消费字段窄取列，别用流式、别用大 IN 列表。
- **微基准的载体必须与生产一致**：node:sqlite 行是 null 原型对象，`{...r}` 展开走 V8 慢路径（20 万行 205ms，同内容纯 JS 对象整套映射才 41ms）——曾用纯 JS 对象做映射微基准得出「映射只占 28ms、不是瓶颈」的错误结论。对象来源（行对象 vs 普通对象）本身就是自变量。
- **记忆化收益与语料重复度成正比，盈亏平衡 ~1.5× 重复度**：bench 合成语料只有 50 个不同文本（重复 4000×）会把收益放大约 20 倍；真实语料按寒暄/套话/转发的结构性重复保守估 2-3×。全不同文本时缓存开销 ~+19ms/20 万条（由调用生命周期封顶）。文本谓词记忆化前提：谓词纯依赖文本（无会话/时间上下文），分步短路顺序与逐条判定一致。
- **参数边界要走 schema 集中校验，别指望 P/S 声明本身**：`P.*` 原是纯描述符（无运行期校验），穿透出 4 类缺陷（负 limit 无界、空 query 全量、`settings` 裸 patch 污染 config.json、负时间窗变未来窗）。修复形态：约束同步进 inputSchema + handler 入口 `checkArgs`——**只校验调用方给出的键**（null 视为未给）、**未知键不拦**（避免误伤扩展调用）、错误语义不漂移；`wai_config_set` 的 settings 是开放形状必须工具体白名单校验。
- **dryRun 契约面是「全部写」而非「业务写」**：`wai_deliver dryRun:true` 曾写 history/delivery 两张留痕表。「只预览不落盘」必须按**全表快照**验证（紧贴调用两侧，跨过其它写入会误报），只查业务表会漏。任何新增写路径都要过这个快照口径。
- **等价对拍法（推荐复用）**：固定 epoch 生成语料 + 固定 now 分析，对整份输出取 sha256 前后逐位比对，比逐项计数更强。对拍要防弱信号——输出 0 行时补一个全量判定路径再哈希，否则行消费差异测不出来。A/B 基线用**同版本临时回退**现取，别拿旧报告数字当基线（bench 行定义会演进）。
- **预筛门收益由命中率决定，`matchAll` 提取上赢、`.test()` 循环上必输**：必要条件预筛门在全局扫描提取上实测大赚（extractDueDates 顶掉 12 组正则、entityTable -74%），但 test 本身就是扫描、门只是又一层扫描——extractAmounts 门 1.04、intentDistribution union 门 1.636 / per-rule 门 1.414、选句关键词门命中率 90.9% 全负收益。上门前先量命中率，命中率高即负收益；解析失败 fail-open（只丢优化不丢正确性）。
- **bench 跨跑自污染**：同进程连跑同一 fn，跑 1 的 20 万行垃圾让跑 2/3 计算行慢 ~2×（机制 = GC 压力，`--runs 1` 立即回基线可证）——「3 跑取中位」必须跑间 `global.gc()` 隔离，否则中位数系统性虚高 2×。判断污染看「计算行 vs 取数行」分化，别误判为机器漂移。长驻进程实测不复现该慢化（工具链路不受影响），bench 污染是测量语境产物、不外推。
- **两段式聚合的中间对象字段要逐个问「第二段读没读」**：entityTable 聚合直建顺带清掉的 `time` 死字段（Date+toISOString 每 push 一次、dedupe 从未读取）就是典型。单点指标未达时先在同一函数内找伴生分配，别急着换点。
- **输出形态审计族**：进 JSON 链路的聚合产物必须普通对象/数组——`Map`/`Set`/`Date`/`BigInt` 都会被 `JSON.stringify` 静默丢（F4：`countBy` 返回 Map 时 `type_breakdown` 序列化成 `{}`，MCP textResult 与 content.json 静默丢数据）。新聚合字段一律过 JSON 往返锁。
- **相对耗时门禁的测量形态坑**：单跑顺序对测有一次性预热成本偏向先测侧（比值摆 0.84-0.98，真实 0.71）——门禁用交错 3 跑取各侧最小；**原语级优化落地后必须复测所有依赖该原语的相对门禁**（原语提速会压缩共享类门禁的比值优势，曾致轮17 门禁单跑挂门、交错复测仍绿）。
- **数值日/月桶打包步长必须 384/32**（`mo*32+d ∈ [1,383]` 配年步 384）：372/31 会在 mo=11,d=31 达步长整数倍致负年解包错位、373/31 解包 rem 越界；解包全用 `Math.floor`（对负年正确）。ISO 扩展年（>9999）输出 `±YYYYYY` 会被 `slice` 截断——月键 7 字符、日键 10 字符 `±YYYYYY-MM`，回译分支必须同款截断；truthy 非法时间须同款抛 RangeError（`key!==key` NaN 检测），falsy ts（含 0/NaN/null）走「未知」桶的旧语义保留。`Date.UTC(y,…)` 把 0-999 年映射成 1900+y，负年/小年必须 `new Date(0)+setUTCFullYear` 构造。
- **POC 语料纪律**：必须带唯一尾缀（防词表混叠——仅 12 种消息的混叠语料会把共享单遍收益虚增到 1.9×）；短串语料会把「随消息长度增长」的收益误判成零（共享单遍短串 1.00 vs 长消息 0.75）——必须带长消息档再下结论；测惰性建行收益前先量规则命中密度（=行消费率），语料尾缀必须规则中性（含「需求」会让 NEED_RE 100% 命中、惰性无收益）。
- **真实微信数据的测试红线**：真实 wxid/会话名一律不得进仓库目录（`wai_privacy_scan` 会让 verify 全红——门禁正确行为，探针放仓库外）；测试输出只留数字/布尔；`~/.wechat-ai` 的 store.db 是 mock+scan 产物、不是真实微信内容，别当真实语料证据（真实 4.x 库全加密：只识别、报 `needs_access`，不解密不改动）。机器消费一律取 `structuredContent`（`textResult` 包 summary + fenced json），别解析 text。

> 说明：`node mcp/bench.mjs` 是**测量工具**，不参与门禁；规模回归由 `mcp/tests/scale.test.mjs` 的确定性断言（增量语义 + 耗时上界）守住。

---

## 十、致谢与许可

本项目的**设计与规则口径**来自上述两个开源项目，代码为独立重写——仅对齐其公开接口与数据模型，并复用其发布文档中描述的行为口径：

- WeChatBridge（微信流）—— AGPL-3.0，作者 freestylefly；
- wechat-intelligence-hub（微信个人情报库）—— AGPL-3.0 + 商业授权，作者 Rion Wu。

若你要再分发本项目，请自行确认与上游许可的兼容性，并保留本节的来源说明。本项目不含任何上游代码副本，也不含任何真实聊天、联系人、密钥或报告。

---

## 十一、版本记录

### v1.1.4（2026-10-05）

- **文档重组（去重 + 单源化）**：
  - `项目说明.md` 全部内容并入 README（相同部分去重后重新生成：技术栈、关键设计补「群聊价值矩阵上下文判定」「句柄随调用释放，删库可自愈」2 条、核心引擎（确定性规则模块）、优化决策记录（POC 结论）、目录结构补 `verify.mjs` / `demo.mjs` / `samples/`、致谢与许可补行为口径句）；`项目说明.md` 随之**删除**（内容已全部并入 README，不再保留存根）
  - 自然语言使用示例收敛为**一份**：`部署说明.详细版.md`「完整使用自然语言示例」——按使用场景分 8 个模块（体检建档 / 数据入库 / 找出来 / 每天先看 / 商机跟进 / 转发沉淀 / 报告与分析 / 发布前隐私）、覆盖全部 73 个工具、一工具一场景，置于「快速命令索引（速查）」之后（安装完即可对照）；README / `部署说明.md` / SKILL.md 的示例副本改为指针（重复只留一份）
  - 版本记录收敛为**一份**（README「版本记录」）：SKILL.md / `部署说明.md` / `部署说明.详细版.md` 的版本表改为指针；「版本与文档同步规范」改写为单源口径（版本号唯一来源 `SERVER_VERSION` → 版本记录唯一在 README → 示例唯一在详细版）
- 版本号 1.1.4：文档口径版本，代码无行为变更（`SERVER_VERSION` 随文档发版同步，v1.0.1 先例）

### v1.1.3（2026-10-05）

- **契约面加固**（outputSchema + record 信封 + pick 双名排查）：
  - 全工具声明 `outputSchema: {type:"object"}`（`toolList()` 中心注入，只声明 type 不锁字段——字段集随工具演化，锁死反而制造契约违规）；错误信封 `{ok:false,error}` 本就是 record，成功/失败路径均满足声明
  - 新增 `mcp/tests/contract.test.mjs`「契约面（outputSchema+record 信封）」套件（99 用例）：tools/list 声明面、**73 工具空参数信封一次遍历**（不依赖逐工具参数知识，BUG-2/4 裸数组/裸数字类缺陷的类级免疫网）、mock 全量渲染后数据根文本产物全扫描无 `[object Object]`
  - **修复 renderHome 与 homeState 形状脱节**（内容层扫描活捉）：home.md「最新索引」行曾把 freshness 对象拼成 `[object Object]`——现按现行形状下钻（`freshnessLabel`/`counts`/`triage`），兼容旧扁平形状，并把 `note` 提示带上页面
  - pick 双名静态审计收官：唯一首键为对象的多键 pick 是「摘要候选」（BUG-3 已修已钉）；「时间段/结束时间」双名生产方两键同写同一字符串，安全；`objPick(session, ["actionable"])` 传数组当键的隐式 toString 依赖一并卫生修正
- 验证：15 套件全绿（0 失败 / 0 诚实 SKIP）、e2e 73/73 工具覆盖（随版附带并发方 teamReview lazy 建行轮21，scale/analytics 各 +1 用例）

### v1.1.2（2026-10-05）

- **回归资产化**：新增 `mcp/tests/regression.test.mjs`（「修复回归（BUG-1~6/8）」套件，8 用例）并挂入 `verify.mjs`——v1.1.1 修掉的 7 项缺陷逐项钉进回归网：
  - `wai_chat_search` 全文写回 + 幂等（`maxTextChars` 只管展示截断；同 id 二次写入 0 插入、索引保留完整 URL）
  - `wai_new_leads` 返回 `{count, rows}`、`wai_feedback_add` 返回 `{saved, id}`（record 契约，不再裸数组/裸数字）
  - `wai_opportunity_update` 的 followUp 三路径：组合更新 / 单独更新 / `clearFollowUp` 清空
  - 群日报「已有结论或分歧」下钻「摘要候选」与 `wai_history_list` summary 字符串守卫（不再 `[object Object]`）
  - `wai_config_set` settings 声明 `type: object` + 3 条边界（字符串/数组/null 拒绝路径）
  - 基线：73 工具、settings schema 形态
- 全部用例跑在隔离 `WECHAT_AI_HOME` 上（`handleRpc` 直调 + import 缓存击穿），不碰真实 store
- 验证：14 套件全绿（0 失败 / 0 诚实 SKIP）、e2e 73/73 工具覆盖

### v1.1.1（2026-10-05）

- 修复 2026-10-05 全流程实测台账 7 项缺陷：
  - `wai_chat_search` 写回索引改为**全文落库**，`maxTextChars` 只控制展示截断（截断正文曾以不同去重键重复落库、污染 memory/团队分析下游）
  - `wai_new_leads` 返回 `{count, rows}`、`wai_feedback_add` 返回 `{saved, id}`：裸数组/裸数字违反 MCP `structuredContent` record 契约，严格客户端下工具不可用
  - 响应信封兜底：非 record 结果统一包 `{result}`；`summary` 仅接受字符串（`wai_history_list` content 首行不再出现 `[object Object]`）
  - `wai_opportunity_update` 消费 `followUp` 参数（此前只认内部名 `nextFollowUp`：与 note 同给被静默丢弃、单独给误报「至少提供一项」）
  - 群日报 `group_daily_groups.md`「已有结论或分歧」先下钻「摘要候选」对象再取关键发言（不再 `[object Object]`）
  - `wai_config_set` 的 `settings` 参数声明 `type: object`（严格客户端此前按 string 送达被拒）
- `部署说明.md` 安装成功行口径更新（`TOOLS=73` + 诚实SKIP 段），消除 72/73 文档漂移
- 验证：13 套件全绿（0 失败 / 0 诚实 SKIP）、e2e 73/73 工具覆盖、隔离 home 冒烟 8/8（BUG-1~6/8 逐项按复现路径验证）

### v1.1.0（2026-10-04）

- 新增**聊天记录分析引擎**（提示词全集 A–I，9 个工具 + `lib/analytics/` 11 个模块）：
  `wai_period_report` 年度/月度报告、`wai_social_graph` 社交关系、`wai_sentiment_trend` 情绪趋势（非医疗诊断）、
  `wai_task_extract` 时间任务（含 ICS）、`wai_finance` 财务记录（默认金额打码）、`wai_memory` 记忆库、
  `wai_content_analysis` 内容分析（实体/摘要/问答）、`wai_team_review` 团队复盘、`wai_risk_scan` 风控线索（需人工复核）
- 确定性规则引擎 + 证据引用（`msg_id`）+ 不臆测口径；全部输出经 `maskPii` 脱敏；报告可选落盘（md+json，拒绝写入仓库内）
- 新增 `references/analysis-prompts.md`：A–J 模块提示词手册（含数据产品提示词、分块处理、合规底线）
- 验证：13 套件 / 474 断言全绿；e2e 100 passed，**73/73 工具全覆盖**

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

**单源口径：版本记录只写在 README「版本记录」，自然语言使用示例的完整场景展开唯一一份在 `部署说明.md`「完整使用自然语言示例」（README 只放同口径紧凑速查表）。**每次更新版本按下表同步，缺号以本节为准：

| 同步到 | 放什么 |
|---|---|
| `mcp/server.mjs` 的 `SERVER_VERSION` | 版本号唯一来源（不另存副本） |
| README「版本记录」 | 完整版本说明（**唯一一份**，新增一节 `### vX.Y.Z（日期）`） |
| `部署说明.md`「完整使用自然语言示例」 | 自然语言示例**完整展开唯一一份**（按 9 个使用场景模块分类 · 覆盖全部工具，一工具一场景 + 工具覆盖清单 73/73）；README「自然语言使用示例」只放**紧凑速查表**（同 9 模块口径，一工具一行）；工具面变化时两处同步补齐 |
| 文档包 `wechat-ai-docs` | 对应文档同步拷贝（README → `快速上手.md`） |
| 发布包 `发布版本\wechat-ai\` | 按纯净口径重打包（无 `node_modules`、无 `.` 前缀目录、剔除开发机残留）+ 包内自验收 |
| 发布包 `README.md` | 发版条目（版本、纯净性、自验收实测） |

其它文档（SKILL.md 等）不再复制这两节，只保留指向唯一来源的指针；新增面向使用者的文档同样只放指针。
