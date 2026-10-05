# 命令参考：73 个 wai_ 工具

本文件是 wechat-ai MCP 服务器的逐条参考。工具名、参数名与默认值以 mcp/server.mjs 为准；参数是一个 JSON 对象，写法示例：

    wai_db_index { "scope": "sessions", "sessionLimit": 80, "perChatLimit": 500 }

统一约定：

- 时间窗参数（下文简称「时间窗」）共六个：hours（数字，默认 24）、days（数字，等价 hours = days*24）、since（如 "2026-08-01" 或 "2026-08-01 09:00"）、until（只给日期时表示当天 23:59:59）、week（布尔，本周）、month（布尔，本月）。同一次调用只给一种口径。
- 数据源参数 source 取值：local（本地索引）、vault:<路径>、sqlite:<路径>、cli:<id>、mock（虚构演示）。缺省时按「显式指定 > 配置指定 > cli > sqlite > vault > local > mock」自动选择。
- 返回均为结构化 JSON。失败时为 ok:false + error；写类工具在未确认前返回预览结果与提示语。
- 所有工具都不会写入、发送或修改微信。

## 一、接入与状态
### wai_home

- 用途：入口总览——数据新鲜度、索引计数、五个入口、信息分流（立即处理/值得关注/仅供存档）。用户问「怎么用」「现在什么情况」时先调用。
- 参数：时间窗（hours / days / since / until / week / month）（默认过去 24 小时）。
- 返回与组合：总览对象，含新鲜度、计数与分流建议。 组合：wai_home → 按分流结果进入 wai_today / wai_brief / wai_group_daily。
### wai_status

- 用途：索引与数据源状态——消息数、会话数、联系人、链接、商机、最后一次索引时间与数据陈旧程度。
- 参数：无。
- 返回与组合：计数指标 + freshness + home 路径 + 当前 reader 设置 + 已配置数据源数量。 组合：任何任务的第一步；随后 wai_sources 看通道，或 wai_db_index 刷新。
### wai_sources

- 用途：列出全部可选只读数据源（本地索引 / 导出目录 / 已解密数据库 / 外部只读 CLI / 演示数据）并标注可用性。
- 参数：probe（布尔，是否实际探测状态）。
- 返回与组合：sources 数组，每项含 id、kind、name、path 或 command、available、detail，probe 为 true 时附 probe 结论。 组合：wai_sources { "probe": true } → wai_access_plan → wai_db_index。
### wai_access_plan

- 用途：接入状态机——告诉你当前卡在哪一层（缺目录/缺密钥/依赖缺失/权限不足/可配置/就绪）以及下一步该做什么。不获取密钥、不解密。
- 参数：databaseRoot（db_storage 目录或账号目录）、keysFile（已有的密钥文件，本项目只读取、不生成）、maxFiles（扫描上限，默认 500）。
- 返回与组合：当前层级、可执行下一步与阻塞原因。 组合：与 references/windows-access.md 的五条通道配合使用。
### wai_compat_check

- 用途：只读通道兼容性检查——status / sessions / timeline 三层冒烟测试。
- 参数：source（数据源 id）、force（布尔，跳过缓存）、maxAgeHours（数字，缓存有效期，默认 6）。
- 返回与组合：ready | degraded | blocked，以及各层测试结果。 组合：换机器、微信版本变化、读取失败时使用；失败后继续用已有索引并标注缺口。
### wai_self_test

- 用途：读取器自检——快照可读性、只读约束、zstandard 解压能力。
- 参数：source（数据源 id）。
- 返回与组合：各项自检结论与失败原因。 组合：wai_compat_check 之后；接入验收时作为只读约束的证明。
### wai_doctor

- 用途：端到端健康诊断——配置文件、数据源、索引、报告目录、隐私门禁逐项检查并给出修复建议。
- 参数：无。
- 返回与组合：stats、freshness、sources、profile、privacy、diagnostics（每项含 level / code / message）与 healthy 布尔。 组合：分享或发布前的体检入口；diagnostics 中 level=error 时必须先处理。
### wai_profile_status

- 用途：个人 Profile 就绪度——本人昵称、重点标签、个人/计划文档是否存在。
- 参数：无。
- 返回与组合：state（ready | partial | needs_context）、owner_aliases、priority_labels、documents、focus_areas、path。 组合：needs_context 时接 wai_profile_init 并按 references/onboarding.md 生成准备清单。
### wai_profile_init

- 用途：个性化初始化——写入本人微信昵称、重点标签、个人说明与当前计划文档路径。文档缺失时生成准备清单（不会假装已经了解用户）。
- 参数：ownerAlias（本人微信昵称）、ownerAliases（多个昵称数组）、personalDoc（个人说明文档路径）、planDoc（当前计划文档路径）、priorityLabel（重点联系人标签）、priorityLabels（多个标签）、force（覆盖已有字段）。
- 返回与组合：profile、status，以及 state 不为 ready 时的 checklist。 组合：wai_wechat_labels（只读列出现有标签作为候选）→ wai_profile_init → wai_profile_status 复核。

## 二、采集与索引
### wai_inbox_push

- 用途：把用户在本机选中的微信内容落入 Inbox（微信流核心）。支持直接贴文本、结构化消息数组，或指向已存在的文件。内容只留本机，不会主动读取微信。
- 参数（body 必填）：body（选中的聊天文本）、messages（结构化消息数组 [{sender,ts,content,is_owner}]）、chat（群名或联系人名）、title（标题，默认取群名）、source（来源标记，如 share | manual | file | clipboard）、kind（chat | article | video | file | link | text）、scene（场景 id）、target（转发目标 id）、files（附件路径数组）、force（忽略去重）。
- 返回与组合：id、duplicate（是否判重跳过）、status、entry。 组合：wai_inbox_push → wai_inbox_process → wai_brief；或 wai_inbox_push → wai_deliver 直接投递。
### wai_inbox_list

- 用途：列出 Inbox 条目。
- 参数：status（new | processing | processed | failed，默认 new）。
- 返回与组合：stats（各状态计数）与 items（含 id、file、bytes、mtime、title、kind、source、created_ts）。 组合：处理前先看 new；失败条目用 wai_batch_status 或重推修复。
### wai_inbox_process

- 用途：把 Inbox 中 new 状态的条目解析并写入本地索引（含附件、链接、联系人）。
- 参数：limit（处理条数上限，默认 100）。
- 返回与组合：处理条数、写入索引的消息数与会话数。 组合：wai_inbox_push → wai_inbox_process → wai_db_status 确认新鲜度。
### wai_inbox_maintain

- 用途：清理过期 Inbox 条目。默认只预览，确认后才真正删除。
- 参数：days（保留天数，默认 30）、apply（真正删除）。
- 返回与组合：计划删除清单与数量；apply=false 时附提示语。 组合：与 wai_cleanup 一起做定期维护，先预览后执行。
### wai_scan

- 用途：扫描本机聊天导出文件或目录（txt/md/json/jsonl/csv）并写入索引。适用于用户自己导出的聊天记录。
- 参数（target 必填）：target（文件或目录路径）、out（输出目录）、source（来源标记）。
- 返回与组合：target、files、inserted、perFile 明细。 组合：先 wai_vault_status 看目录概况，再 wai_scan 或 wai_vault_scan 建索引。
### wai_vault_status

- 用途：查看已配置导出目录（vault）状态——文件数、会话数、可读消息数。
- 参数：dirs（临时覆盖导出目录数组）。
- 返回与组合：文件/会话/消息计数与 describe 描述。 组合：wai_vault_status → wai_vault_scan → wai_db_status。
### wai_vault_scan

- 用途：扫描导出目录并写入索引（等价于 wai_scan 指向 vault 目录）。
- 参数：dirs（临时覆盖导出目录数组）、out（输出目录）。
- 返回与组合：dirs、inserted（写入消息数）、sessions（会话数）。 组合：首次接入导出目录时使用；之后用 wai_db_index 做增量刷新。
### wai_db_index

- 用途：从数据源拉取并建立/刷新本地索引。scope=sessions 刷新近期会话；scope=labels 按微信标签；scope=search 按关键词。
- 参数：source、scope（sessions | labels | search | all）、sessionType（private,group | all）、sessionLimit（会话数上限，默认 80）、perChatLimit（每个会话消息上限，默认 500）、keywords（scope=search 时的关键词数组）、label（scope=labels 时的标签）、out（输出目录）、时间窗（hours / days / since / until / week / month）、allowDemo（允许使用虚构演示数据）。
- 返回与组合：数据源、范围与写入统计。 组合：任何「最新/现在」请求之前；涉及重点标签时 scope: labels，涉及具体词时 scope: search。
### wai_db_status

- 用途：索引新鲜度——最新消息时间、距现在多久、上次索引时间。用户问「最新/现在」之前必须先看这个。
- 参数：无。
- 返回与组合：freshness（messages、last_message_ts、last_message_at、data_age_hours、last_index_ts、index_age_hours、fresh、source）与 stats。 组合：wai_db_status → 必要时 wai_db_index → 再执行情报类工具。

## 三、检索
### wai_chat_search

- 用途：在全部已导入微信内容里检索关键词（实时、覆盖全量，不受标签限制），并把命中写入本地索引。
- 参数（query 必填）：query、chat（限定会话）、limit（返回条数，默认 100）、maxTextChars（正文截断，默认 500）、source、out、时间窗（hours / days / since / until / week / month）。
- 返回与组合：source、query、count、inserted、query_meta、messages（最多 80 条）。 组合：别名逐个搜 → wai_topic 聚合；精确取证配合 wai_chat_history。
### wai_db_search

- 用途：在本地索引里快速检索（已索引范围，速度更快）。支持限定会话与时间。
- 参数（query 必填）：query、chat、limit（默认 30）、out（输出 markdown 路径）、since、until（也可用 hours / days / week / month）。
- 返回与组合：query、count、out（若指定）、rows。 组合：已知内容已索引时用它替代 wai_chat_search；结果不足再升级到 wai_chat_search。
### wai_chat_history

- 用途：读取某个联系人或群在指定时间范围内的聊天原文（支持关键词过滤）。
- 参数（chat 必填）：chat、query（关键词过滤）、limit（默认 200）、source、out、时间窗（hours / days / since / until / week / month）。
- 返回与组合：该会话的原始消息序列与统计。 组合：wai_person / wai_topic 定位之后，用它取原文证据。
### wai_person

- 用途：联系人档案——我和某人聊到哪、还有什么承诺没完成、对方有哪些待回应要求、商业相关时间线。
- 参数（name 必填）：name、refresh（先从数据源刷新该会话）、limit（默认 500）、source、out、时间窗（hours / days / since / until / week / month）。
- 返回与组合：会话概览、承诺、待回应要求、时间线与证据。 组合：wai_person { "name": "某某", "refresh": true } → wai_reply_draft。
### wai_topic

- 用途：主题/产品/项目/事件的来龙去脉——跨群跨人会聚合并按事件时间线去重总结。
- 参数（topic 必填）：topic、keyword（别名或补充关键词数组）、days（回看天数，默认 7）、limitMessages（默认 800）、limitChats（默认 20）、out、时间窗（hours / days / since / until / week / month）。
- 返回与组合：命中的会话与消息、按时间线去重后的脉络、来源会话。 组合：wai_chat_search（别名）→ wai_topic（聚合）→ wai_chat_history（取证）。
### wai_wechat_labels

- 用途：只读列出微信标签及标签下的联系人（不修改微信标签）。
- 参数：label（标签名数组，缺省用 Profile 的重点标签）、source、out。
- 返回与组合：available_labels、requested_labels、contact_count、contacts（最多 500）与提示语。 组合：作为个性化与范围收敛的候选来源；随后 wai_db_index { "scope": "labels", "label": [...] }。
### wai_common_groups

- 用途：判断两个人是否在共同群、是否有交接关系（用成员身份核验，不靠昵称猜测）。
- 参数（a、b 必填）：a、b、groupLimit（扫描群上限，默认 5000）、out、时间窗（hours / days / since / until / week / month）。
- 返回与组合：共同群列表、成员身份核验结论与交接线索。 组合：商机交接存疑时使用；配合 wai_chat_history 看原话。

## 四、情报
### wai_signals

- 用途：原始情报信号提取——待回复 / 待兑现承诺 / 等待对方 / 临近截止 / 待结算 / 商机 / 培训合作 / 资源机会 / 跨群链接 / 低价值群。
- 参数：时间窗（hours / days / since / until / week / month）、source、allowDemo（允许演示数据）。
- 返回与组合：window、coverage、pendingReplies、promises、waiting、deadlines、settlements、brandDeals、trainings、resources、links（rank > 0）、lowValue、sessions（最多 60）。 组合：wai_signals → wai_opportunity_sync（把信号收敛成候选）→ wai_triage。
### wai_today

- 用途：今天先处理什么——合并待回复、逾期承诺、临近截止、待结算与到期商机，按真实紧迫度排序。
- 参数：minPriority（最低优先级 0–5，默认 3）、limit（默认 10）。
- 返回与组合：最多 10 条行动项及其依据。 组合：每日上班第一件事；与 wai_opportunities { "dueOnly": true } 对照。
### wai_new_leads

- 用途：新发现的高优先级线索（待审核候选）。这些只是候选，不等于真实商单。
- 参数：minPriority（默认 4）、limit（默认 20）。
- 返回与组合：候选列表与优先级。 组合：wai_new_leads → wai_triage（pursue / wait / pause / ignore）。
### wai_brief

- 用途：跨报告行动总览（近 N 小时）——待回复、待兑现承诺、推进中机会、待审核候选、重点私聊/群聊、主题变化、附件核验队列。
- 参数：时间窗（hours / days / since / until / week / month）（默认 24 小时）、limitChats（默认 10）、selfName（本人昵称数组）、out（输出目录）。
- 返回与组合：行动总览与重点会话清单，并自动与前一个等长窗口对比。 组合：wai_group_daily + wai_contact_daily + wai_brief → wai_render_bundle。
### wai_group_daily

- 用途：群聊日报——机器初筛 + 语义编辑素材包（editorial packet）。输出 digest/appendix/CSV/JSON、跨群链接、群聊价值矩阵与编辑包。
- 参数：时间窗（hours / days / since / until / week / month）（默认 24 小时）、groupLimit（群上限，默认 60）、perGroupLimit（每群消息上限，默认 500）、minLinkChats（跨群链接最少群数，默认 2）、exclude（排除群名数组）、out（输出目录）。
- 返回与组合：window、coverage、outDir、files（含 editorialPacket）、editorial（第二遍编辑产物）、groupCount、topGroups。 组合：wai_group_daily → 按 references/group-editorial.md 做第二遍语义编辑 → group_daily_topics.md + group_daily_groups.md → wai_render_bundle。
### wai_contact_daily

- 用途：重点联系人私聊日报（关系推进）——待兑现、待回复、等待对方、留意，并给每个联系人的回复方向。
- 参数：时间窗（hours / days / since / until / week / month）（默认 24 小时）、contacts（限定联系人数组）、selfName（本人昵称数组）、limit（默认 80）、scope（hybrid | priority_labels_only）、out（输出目录）。
- 返回与组合：window、outDir、files、count、rows（最多 30 行明细）。 组合：与 wai_group_daily 分开交付；scope=priority_labels_only 时只收录重点标签联系人。
### wai_reactivation

- 用途：品牌方复联雷达——找出值得重新联系的人，按今天优先看 / 待交接跟进 / 等待区 / 纯佣低优先级 / 我方主动放弃 五档分档，并给出可发话术。上游口径里的「待下一批跟进 / 复购保温」折叠进 今天优先看，「暂缓」即 等待区。
- 参数：时间窗（hours / days / since / until / week / month）（默认回看 365 天）、inactiveDays（沉默阈值天数，默认 21）、label（限定标签数组）、selfName（本人昵称数组）、out、indexFirst（先建索引）。
- 返回与组合：window、outDir、files、bands（各档人数）、immediate、next（带「下一批」信号的会话，即上游「待下一批跟进」）。 组合：wai_reactivation → 未到跟进日期的进等待区 → 与 wai_opportunities 的 followUp 对齐。
### wai_db_links

- 用途：跨群重复链接聚合——每个 URL 只出现一次，列出出现群、发布者和商单概率判断（高概率/疑似/普通）。
- 参数：时间窗（hours / days / since / until / week / month）（默认回看 30 天）、minChats（最少群数，默认 2）、limit（默认 50）、out（输出 markdown 路径）。
- 返回与组合：链接列表，含 norm、chats、senders、first_ts、last_ts、hits、heat、probability、contexts。 组合：群聊日报的「商单雷达链接」区；只出现一次，不按出现群重复粘贴。
### wai_deal_radar

- 用途：微信商单雷达——品牌方/中间人/自媒体博主私聊与群聊里的合作信号、培训咨询项目、资源引荐、待结算清单。
- 参数：时间窗（hours / days / since / until / week / month）（默认 24 小时）、out（输出目录）。
- 返回与组合：商单、培训/项目、资源、待结算分组结果。 组合：wai_deal_radar → wai_opportunity_sync → wai_triage。
### wai_reply_draft

- 用途：回复建议——先判断是否需要回复，再按联系人与已有语气生成一条简短本地草稿（绝不自动发送）。
- 参数（name 必填）：name、limit（默认 120）、styleDays（语气学习天数，默认 30）、minimumChatMessages（学习专属口语所需最少本人消息数，默认 5）、selfName（本人昵称数组）、out（输出目录）。
- 返回与组合：是否需要回复的判断、一条主草稿、判断依据；out 指定时附带 Markdown 产物路径。 组合：wai_person → wai_reply_draft；规则见 references/reply-style.md。

## 五、报告
### wai_render_bundle

- 用途：把一轮报告目录渲染成旗舰交互式 HTML + 分区 Markdown 站点（全局搜索、分区路由、明暗主题、打印、当前分区 Markdown 下载）。
- 参数（reportDir 必填）：reportDir（报告目录）、out（HTML 输出路径）、markdownOut（门户 Markdown 路径）、title（标题）。
- 返回与组合：生成的 HTML、门户 Markdown、分区 Markdown 与产物清单。 组合：wai_group_daily + wai_contact_daily + wai_brief 完成语义编辑之后执行。
### wai_render_html

- 用途：把一份 Markdown 渲染成安全的静态 HTML（白名单净化 + CSP，不依赖 pandoc）。
- 参数：markdown（Markdown 文本）、mdPath（或 Markdown 文件路径）、out（输出 HTML 路径）、title（标题）。
- 返回与组合：out 与字节数；未给 out 时直接返回 HTML 字符串。 组合：单篇 Markdown 需要网页形态时使用；不做净化绕过，也不关闭 CSP。
### wai_report_list

- 用途：列出历次报告目录与产物文件。
- 参数：limit（默认 20）。
- 返回与组合：output 根目录与 runs（每个目录的 name、files、html、mtime）。 组合：生成报告前先看是否已有同窗口产物，避免重复产出。
### wai_cleanup

- 用途：清理历史输出与原始中间产物。默认只预览，确认后才删除。
- 参数：root（根目录，默认输出目录）、rawDays（原始文件保留天数，默认 7）、reportDays（报告保留天数，默认 30）、apply（真正删除）。
- 返回与组合：root、apply、count、items（最多 200）与提示语。 组合：定期维护；apply 前先人工过一遍 items。

## 六、商机管线
### wai_opportunities

- 用途：商机管线——默认只看正式机会；includeCandidates 才显示未人工确认的候选；dueOnly 只看到期跟进。
- 参数：status（new | active | waiting | paused | won | lost | ignored | stale | archived）、stage（阶段）、chat（限定会话）、dueOnly、includeClosed、includeCandidates、minPriority（默认 3）、limit（默认 50）、out。
- 返回与组合：count 与 opportunities 列表。 组合：唯一持久状态源；回答「合作进度」时以它为准，用日报做证据补充。
### wai_opportunity_sync

- 用途：从当前时间窗的聊天里发现候选并同步进商机库（去重、加固、状态单调推进）。默认 dryRun 预览。
- 参数：时间窗（hours / days / since / until / week / month）（默认 24 小时）、chat（限定会话）、dryRun（只预览，默认 true）、exclude（排除群名数组）。
- 返回与组合：window、candidates（发现候选数）、同步结果（新增/加固/跳过）。 组合：wai_signals → wai_opportunity_sync（预览）→ 用户确认 → dryRun:false。
### wai_opportunity_update

- 用途：更新商机状态/阶段/优先级/下一步/跟进日期（人工确认后写入，后续扫描不会覆盖）。
- 参数（id 必填）：id、stage、status、priority（0–5）、nextAction、followUp（YYYY-MM-DD）、clearFollowUp（清空跟进日期）、note、unlockStage、unlockPriority、unlockNextAction。
- 返回与组合：更新后的商机记录。 组合：批量调整用 wai_opportunities 找 id → wai_opportunity_update 逐条写。
### wai_opportunity_maintain

- 用途：清理长期没有新证据的候选（默认 14 天）。默认只预览；apply=true 才真正标记过期。
- 参数：staleDays（默认 14）、apply（真正标记）。
- 返回与组合：count、applied、items（最多 100）与提示语。 组合：每周一次；过期只改状态，原始证据不删除。
### wai_triage

- 用途：人工分流商机。
- 参数（id、decision 必填）：id、decision（pursue | wait | pause | ignore | won | lost）、stage、priority、nextAction、followUp（YYYY-MM-DD）、note。
- 返回与组合：分流后的状态、阶段与写入的纠正记录。 组合：pursue → active；wait → waiting（**必须给 followUp**）；ignore/won/lost 同时持久化纠正。
### wai_feedback_add

- 用途：持久化用户纠正——confirmed 确认 / false_positive 假商单 / ignore 忽略 / low_priority 低优先级。用于避免同类误报反复出现。
- 参数（targetType、target、verdict 必填）：targetType（chat | opportunity | message | link）、target（群名/商机 key/商机 id/链接）、verdict（confirmed | false_positive | ignore | low_priority）、note。
- 返回与组合：写入的纠正记录。 组合：用户说「这是假商单/无关群」时立即调用，不要只在对话里记住。
### wai_feedback_list

- 用途：查看已记录的纠正。
- 参数：targetType（类型过滤）、limit（默认 50）。
- 返回与组合：rows 纠正列表。 组合：判断某条候选为何被降权时使用。

## 七、隐私与配置
### wai_privacy_scan

- 用途：隐私门禁——扫描包目录/输出目录里是否残留真实微信 ID、群 ID、私钥、口令。发布或分享前必须跑。
- 参数：root（扫描根目录，默认包目录）。
- 返回与组合：扫描结论与发现项；不通过时附处理清单。 组合：打包、提交、分享报告之前的最后一步；详见 references/privacy.md。
### wai_config_get

- 用途：读取配置（数据源 / 场景 / 转发目标 / 设置；不含任何凭据）。
- 参数：无。
- 返回与组合：config 路径与完整配置对象。 组合：修改前先读；确认现有 vaults / readers / sqliteSources / scenes / targets。
### wai_config_set

- 用途：修改配置——新增导出目录 / 外部只读 CLI / 已解密数据库路径 / 设置项。
- 参数：vaults（[{id,path,enabled}]，追加）、readers（[{id,name,command,args}]，追加）、sqliteSources（[{id,path,enabled}]，追加）、settings（设置项 patch，浅合并）、targets（转发目标 patch，按 id 合并，可用于给 folder 目标补 path 或启用 obsidian）、scenes（场景 patch，按 id 覆盖）、reader（指定默认数据源 id，或 auto）。
- 返回与组合：saved 与更新后的配置；同时清除数据源缓存。 组合：wai_config_set（新增通道）→ wai_sources { "probe": true } → wai_db_index。

## 八、微信流转发
### wai_scene_list

- 用途：列出「微信流」场景——按聊天场景预设任务（客户群、项目群、商单群…），转发时自动套用。
- 参数：无。
- 返回与组合：scenes 列表（id、name、match、priority、task、targets、enabled）。 组合：先看场景，再决定 wai_scene_upsert 是否要新增。
### wai_scene_upsert

- 用途：新增或更新一个场景（名称、匹配关键词、任务提示词、默认转发目标、开关）。
- 参数（name 必填）：id（更新时必填）、name、match（群名匹配关键词数组）、priority（越大越优先）、task（给 Agent 的任务提示词）、targets（默认转发目标 id 数组）、enabled。
- 返回与组合：更新后的场景。 组合：wai_scene_upsert → wai_scene_match（预览提示词）→ wai_deliver。
### wai_scene_match

- 用途：按群名/标题匹配场景，并预览将要发给 Agent 的完整提示词。
- 参数（title 必填）：title（群名或标题）、body（待转发内容，可选，用于预览）。
- 返回与组合：命中的 scene 与 preview 提示词。 组合：投递前的固定动作；确认场景没选错再投。
### wai_target_list

- 用途：列出全部转发目标（Agent / Obsidian / 剪贴板 / 文件夹 / 自定义）及其配置状态。
- 参数：无。
- 返回与组合：targets 列表（id、name、kind、配置完整性与 enabled）。 组合：投递前确认目标可用（如 Obsidian 是否配置了 vault）。
### wai_deliver

- 用途：把选中的微信内容投递到指定目标——写成 Agent 提示词文件、写入 Obsidian、复制到剪贴板、存到文件夹，或交给自定义命令。默认 dryRun 只预览不落盘。
- 参数（body 必填）：body、messages、chat、title、scene（缺省自动匹配）、target（单个目标 id）、targets（多个目标 id 数组）、out（输出目录）、dryRun（只预览）。
- 返回与组合：dryRun、scene、targets、每个目标的投递结果、available 目标清单。 组合：wai_inbox_push → wai_scene_match → wai_deliver { "dryRun": true } → 确认后 dryRun:false。
### wai_obsidian_write

- 用途：把内容写成 Obsidian 笔记（含 frontmatter、附件复制、图片嵌入 ![[...]]、文件链接 [[...]]）。
- 参数（vault、markdown 必填）：vault（Obsidian vault 路径）、folder（子目录）、title、markdown、attachments（附件路径数组）、tags、chat（来源会话）、url（来源链接）。
- 返回与组合：path、attachmentPaths、note、fileName、bytes、frontmatter、attachments。 组合：单独归档用本工具；批量归档走 wai_deliver 的 obsidian 目标，规则见 workflows/07。
### wai_skill_list

- 用途：列出内置技能（微信流技能目录）：公众号文章提取、视频信息读取。
- 参数：无。
- 返回与组合：skills 列表（id 与名称）。 组合：投递前确认技能 id；再 wai_skill_run。
### wai_skill_run

- 用途：对选中内容套用内置技能——生成结构化提示词与外壳（真正的推理交给调用方 Agent；不做 OCR/ASR，也不假装已解析）。
- 参数（skill、content 必填）：skill（wechat-article-extract | video-information-reading）、content（内容原文）、chat（来源会话）、title、out（输出目录）。
- 返回与组合：技能提示词、外壳与产物路径；未知技能返回错误与可用 id。 组合：wai_inbox_push（选中内容）→ wai_skill_run → 把提示词交给目标 Agent。
### wai_history_list

- 用途：查看操作记录（历次转发/投递），可用于把之前选过的内容再次发给其他 Agent。
- 参数：limit（默认 50）、action（动作过滤）、target（目标过滤）。
- 返回与组合：summary（按动作统计）与 rows（id、at、action、target、title、chars、ok、files）。 组合：wai_history_list → wai_history_rerun。
### wai_history_rerun

- 用途：把某条历史记录再次投递到另一个目标（换一个 Agent 或写到 Obsidian）。
- 参数（id、target 必填）：id（历史记录 id）、target（新目标 id）。
- 返回与组合：新的投递结果（action 为 rerun）。 组合：同一段内容分别给 Codex 与 Obsidian 时使用，不需要重新抓取内容。
### wai_batch_create

- 用途：批量采集——把多条选中内容作为一批登记，进入 pending → staging → ready → delivering → done 状态机。
- 参数（items 必填）：items（[{title,chat,body}] 数组）、source（来源）、scene（场景）、target（目标）。
- 返回与组合：批次 id、条目数与初始状态。 组合：wai_batch_create → wai_batch_stage → wai_batch_deliver。
### wai_batch_status

- 用途：查看批次状态与逐条进度；失败的条目会保留原始载荷。
- 参数：id（批次 id，缺省列出全部批次）。
- 返回与组合：单批时给出状态与逐条进度；不给 id 时返回 batches 列表。 组合：投递后复查；失败条目用 wai_batch_stage 重新暂存。
### wai_batch_stage

- 用途：暂存批次条目并标记可交付（→ staging → ready）：原始载荷写进 items/<index>.json 永不丢弃。
- 参数（id 必填）：id、index（条目序号，省略=全部未交付条目）、text（条目正文，仅单条 index 时可用）、file（附件路径，仅单条 index 时可用）、ready（暂存后标记 ready，默认 true）。
- 返回与组合：staged/ready/skipped 计数与逐条 details、批次计数。 组合：wai_batch_create → wai_batch_stage → wai_batch_deliver；失败条目重新 stage 即重试；ready:false 只暂存，人工核对后再 stage 一次标记。
### wai_batch_deliver

- 用途：投递整个批次的 ready 条目；未暂存/失败条目先用 wai_batch_stage 处理（重试=重新暂存）。
- 参数（id 必填）：id、target（目标 id）、dryRun（只预览）。
- 返回与组合：批次投递结果与每条终态。 组合：先 dryRun 预览，再正式投递；部分失败时用 wai_batch_stage 重暂存失败条目再投。

## 九、只读 Reader 入口
### wai_reader

- 用途：统一的只读微信读取器命令入口（对应 rion-wechat-cli 的命令面）。只读快照、不修改原始数据库、不获取密钥、不注入、不 Hook。
- 参数（command 必填）：command（version | status | self-test | doctor | access-plan | tools | schema | sessions | contacts | resolve-chat | timeline | history | context | search | search-context | unread | stats | members | announcements | favorites | sns-feed | sns-search | media | transfers | red-packets | forward-history | export | sql | agent）、source、chat、query、keyword、limit、offset、order（asc | desc）、since、before、type（text/image/file/voice…）、localId、format（jsonl | markdown | html）、subdir（SQL 子库 session | contact | message | favorite | sns | hardlink）、file（SQL 文件名）。
- 返回：对应子命令的数据载荷 + source 标识；未知子命令返回错误与可用列表。
- 常见子命令：resolve-chat（按名字核验会话）、timeline（按会话读时间线）、context（按 localId 读上下文）、search（检索）、members（群成员）、export（导出）、sql（只读查询）。
- 组合：wai_reader { "command": "status" } 判断通道是否 ready → 再进入语义工具。

## 十、聊天记录分析

对应「微信聊天记录分析提示词全集」A–I 模块（提示词骨架见 references/analysis-prompts.md）。九个工具共用时间窗参数（hours / days / since / until / week / month，默认 30 天）与 source、allowDemo、out（输出目录：写出 `<kind>_report.md` + `<kind>.json`，落盘前脱敏，拒绝写入仓库内）。全部只读分析：不发送消息、不改微信；证据带 msg_id 且脱敏（手机号/身份证/卡号/验证码打码）；不做医疗/法律/投资定性。

### wai_period_report

- 用途：A 年度/月度聊天报告——消息量与类型分布、活跃时段（小时/星期/日/月）、Top 联系人与群、关键词/口头禅/表情、消息长度、回复间隔、连续聊天天数与最长静默、关系升温降温、5-10 条洞察。
- 参数：top（排行条数，默认 20）、时间窗、source、allowDemo、out。
- 返回与组合：period、total_messages、type_breakdown、active_hours/weekdays、top_contacts/groups、keywords、catchphrases、emojis、reply_interval、activity、relationship_trend、insights、caliber。 组合：年度报告用 days: 365；配合 wai_social_graph / wai_sentiment_trend 补充关系与氛围解读。

### wai_social_graph

- 用途：B 社交关系——谁主动联系我最多 / 我主动联系谁最多、回复间隔（中位）、双向互动比例、关系升温降温、群内核心与边缘成员、跨群桥梁（近似）、同群共现聚类、互动模式线索（只描述不评判）。
- 参数：top（默认 15）、gapHours（对话段切分间隔小时，默认 4）、时间窗、source、allowDemo、out。
- 返回与组合：overview、who_contacts_me_most、who_i_contact_most、reply_time、bidirectional、relationship_change、group_network、bridge_members、clusters、interaction_notes、caliber。 组合：wai_person 看单人细节；不做道德评判、不下「谁疏远你」的定性结论。

### wai_sentiment_trend

- 用途：C 情绪与心理趋势——积极/中性/消极比例、每日情绪得分、波动最大的日子、压力源话题、冲突/安慰词、夜间负面、需要关注的时段。文本情绪线索，**不是心理或医疗诊断**。
- 参数：时间窗、source、allowDemo、out。
- 返回与组合：daily_sentiment、positive/negative/neutral_ratio、avg_score、volatility_periods、stress_topics、conflict_words、comfort_words、night_negative_messages、high_risk_periods、limitations。 组合：深夜低落消息配合 wai_task_extract 看是否有积压事项；引用原文只保留脱敏短引。

### wai_task_extract

- 用途：D 时间与任务管理——抽取待办/约定/会议/提醒/生日/缴费/行程，给负责人（我答应别人 / 别人答应我）、截止、状态（待确认|已确认|已完成|逾期）、来源 msg_id 与置信度；可生成 ICS 日历片段。
- 参数：includeIcs（是否附 ICS，默认 true）、时间窗、source、allowDemo、out。
- 返回与组合：tasks、stats、ics。 组合：模糊时间标「需确认」，不臆造截止日；ICS 由用户导入自己的日历，服务器不做任何日历写入。

### wai_finance

- 用途：E 财务与消费记录——抽取转账/红包/AA/收付款/购物/账单流水，月度收支与净额、消费类别、高频交易对象、异常线索（大额/高频/未还）。**默认金额脱敏为区间**（showAmounts 才给精确值）；不提供任何投资/借贷/理财建议。
- 参数：showAmounts（默认 false）、时间窗、source、allowDemo、out。
- 返回与组合：entries、monthly、totals、top_counterparties、categories、suspicious。 组合：异常线索只是线索（needs_review），大额/未还项建议人工核实原消息（wai_chat_history）。

### wai_memory

- 用途：F 个人记忆与知识库——把重要事件/决策/经验/文件/照片/地点/链接整理成知识卡片与时间线（附 source_msg_ids）；给 query 时做检索式记忆问答（只引用命中，不编造）。
- 参数：query（记忆问答查询，可选）、maxCards（卡片上限，默认 60）、时间窗、source、allowDemo、out。
- 返回与组合：cards、timeline、stats、search_hint、answer（给 query 时）。 组合：先 wai_memory 建卡，之后「我们之前说的 XX」类问题用 query 直接问；查不到就说没找到，不臆测。

### wai_content_analysis

- 用途：G 内容分析——词频/口头禅/表情、话题聚类、意图识别（询问/约定/请求/抱怨/通知/安慰/冲突/确认/感谢/承诺）、实体抽取（时间/地点/人物/金额/组织/事件）、抽取式摘要、检索问答（给 query，附 msg_id）。
- 参数：top（词频条数，默认 20）、query（检索问答查询，可选）、时间窗、source、allowDemo、out。
- 返回与组合：lexical、topics、intents、entities、summary、qa（给 query 时）。 组合：wai_chat_search 定位 → wai_content_analysis 归纳 → wai_chat_history 取原文；摘要只用原文抽取，不生成原文没有的结论。

### wai_team_review

- 用途：H 工作/团队分析——沟通复盘（参与度/回复节奏）、决策追溯（谁在何时定了什么）、任务分配（负责人/截止/状态）、风险提醒（延期/阻塞/冲突/信息缺失）、客服质检线索、客户需求与异议、FAQ。企业场景需合规会话存档并告知员工；风险只提示不定性。
- 参数：project（项目名称，可选）、时间窗、source、allowDemo、out。
- 返回与组合：activity、decisions、assignments、risks、service_qc、sales、faq、scope_note。 组合：与 wai_task_extract 对齐分工与截止；与 wai_opportunity_sync 对齐客户需求线索（商机以商机管线为准）。

### wai_risk_scan

- 用途：I 安全/风控——诈骗话术（高回报/冒充/垫付/钓鱼）、敏感信息泄露（身份证/银行卡/手机号/验证码/密码/住址）、合规风险（收益承诺/回扣/内幕）、异常行为（线下转账/短链/删记录/频繁转账/深夜资金）。**只输出线索且 needs_review=true，必须人工复核**；未获数据主体授权不得运行。
- 参数：goal（风控目标过滤，如 诈骗 / 合规 / 敏感信息泄露 / 异常，可选）、时间窗、source、allowDemo、out。
- 返回与组合：risks（risk_id/type/level/evidence_msg_ids/脱敏 evidence_text/suggested_action/needs_review）、aggregates、stats、disclaimer。 组合：发布前另跑 wai_privacy_scan 做产物级门禁；线索不是违法/诈骗认定，标记误报后人工处置。

## 附：默认值与阈值

| 设置 | 默认 | 影响 |
| --- | --- | --- |
| settings.defaultHours | 24 | 未给时间时的窗口 |
| settings.maxImmediateActions | 10 | wai_today 的行动上限 |
| settings.candidateStaleDays | 14 | 候选过期天数 |
| settings.reactivationInactiveDays | 21 | 复联沉默阈值 |
| settings.replyHistoryDays | 30 | 语气学习回看天数 |
| settings.minimumChatMessages | 5 | 采用当前会话口语所需本人消息数 |
| settings.batchMaxItems | 100 | 单批条目上限 |
| settings.autoPurgeInboxDays | 30 | Inbox 自动清理天数 |
| settings.reader | auto | 默认数据源选择策略 |
| privacy.redactOutputs | true | 输出脱敏 |
| privacy.blockInsideRepo | true | 阻止把敏感产物写进仓库目录 |