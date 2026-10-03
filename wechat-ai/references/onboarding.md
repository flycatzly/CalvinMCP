# 首次接入与个性化

在三种情况下走这套流程：首次安装、wai_profile_status 返回 needs_context、用户的月度/季度重点明显变化。

## 1. 判断就绪度

调用 wai_profile_status，返回三态之一：

| state | 含义 | 对报告的影响 |
| --- | --- | --- |
| ready | 本人昵称、重点标签、个人与计划文档齐全 | 排序结合个人目标 |
| partial | 部分字段缺失 | 报告可用，缺失维度用默认口径并说明 |
| needs_context | 基本没配置 | 报告仍可生成，但必须提示「排序尚未结合个人目标」 |

Profile 只影响「谁的承诺算我方承诺」「哪些联系人进重点私聊日报」「哪些方向加权」，不会限制检索范围。

## 2. 两份输入文档

优先使用用户已有的本地文档，不要要求写长篇自传：

1. 个人说明 / 人生使用说明书：你是谁、在做什么、擅长什么、不做什么、长期目标与约束。
2. 当前计划 / OKR / 本月重点：本季度最重要的 3 件事与关键合作。

没有文档时，用 wai_profile_init 返回的 checklist（准备清单）向用户要 5–10 条要点即可：

- 一份「个人说明 / 人生使用说明书」：你是谁、在做什么、擅长什么、不做什么。
- 一份「当前计划 / OKR / 本月重点」：本季度最重要的 3 件事与关键合作。
- 2–5 个微信标签名称（示例：客户 / 同行 / 渠道 / 供应商 / 品牌方）。
- 本人微信昵称（用于区分「我」和对方，回复草稿必需）。
- 上述文档的本地路径。

不要假装已经了解用户；缺什么就说什么，并在报告里标注使用了默认口径。

## 3. wai_profile_init 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| ownerAlias | 字符串 | 本人微信昵称（单个） |
| ownerAliases | 字符串数组 | 本人昵称（多个，含常用小号/昵称变体） |
| personalDoc | 字符串 | 个人说明文档的本地路径 |
| planDoc | 字符串 | 当前计划 / OKR 文档的本地路径 |
| priorityLabel | 字符串 | 重点联系人微信标签（单个） |
| priorityLabels | 字符串数组 | 重点联系人标签（多个） |
| force | 布尔 | 覆盖已有字段；不传时只补空缺 |

示例：

    wai_profile_init {
      "ownerAlias": "我的微信名",
      "ownerAliases": ["我的微信名", "我的小号"],
      "personalDoc": "D:/me/个人说明.md",
      "planDoc": "D:/me/本月计划.md",
      "priorityLabels": ["客户", "品牌方"]
    }

调用后返回 profile、status 与 checklist。若 status.state 不是 ready，把 checklist 原样交给用户，不要替用户编造内容。

## 4. 建议 2–5 个微信标签

标签是可选项，但对稳定的私聊覆盖很有帮助。做法：

1. 用 wai_wechat_labels 只读列出现有标签与标签下的联系人，作为候选。
2. 把发现的标签当作**候选**：绝不从名字猜含义并静默写进配置。
3. 结合用户的工作流推荐 2–5 个真正有用的标签，让用户自己在微信里建立或确认，例如客户、同行、渠道、供应商、自媒体网友、品牌方——这些只是示例，不是默认工作流。
4. 用户确认后，再用 wai_profile_init 写入 priorityLabels（必要时分开 commercial / creator / reactivation 用途）。
5. **本项目永不修改微信标签**：不改名、不新增、不删除、不移动联系人。

标签的作用边界：

- 收敛日常联系人扫描范围（wai_db_index 的 scope: labels、wai_contact_daily 的 scope: priority_labels_only）。
- **不约束** wai_chat_search、wai_topic、wai_deal_radar 等全微信查询；精确关键词必须能搜到标签之外的人。

## 5. 与检索、日报的关系

- 未配置重点标签时，wai_wechat_labels 返回全部联系人并提示「建议先配置 2–5 个标签」。
- 群聊日报不受标签影响；私聊日报受影响（scope 决定是否只收录重点标签）。
- 商机管线不受标签限制：标签只影响日常扫描与展示优先级。

## 6. 刷新与变更

- 新的月度计划取代旧计划时：更新 personalDoc / planDoc 路径并用 force 重新初始化。
- 用户换工作、换方向、换主账号时：优先更新 ownerAliases，否则「我」和「对方」会判错，回复草稿会失去意义。
- 每次复合日报都应在覆盖范围里写清个性化状态（ready 还是使用默认口径）。

## 7. 验收标准

- [ ] wai_profile_status 返回 ready 或明确说明为什么不是。
- [ ] 本人昵称能正确识别（抽查一条本人发言与一条对方发言）。
- [ ] 重点标签只读列出、由用户确认，微信标签未被修改。
- [ ] 报告里说明了排序是否结合个人目标。

## 8. 没有真实数据源时怎么开始

1. 用演示数据跑通全链路：wai_db_index { "allowDemo": true }，报告里必须标注「演示数据、虚构内容」。
2. 同时接入最稳的人工通道：让用户在本机选中一段真实聊天，用 wai_inbox_push 落入 Inbox，再 wai_inbox_process 建索引；这条路径零依赖、不需要任何密钥。
3. 有导出目录或已解密副本时，按 references/windows-access.md 配置 vaults 或 sqliteSources，再 wai_db_index。
4. 在 Profile 就绪之前，报告先用公开默认维度（AI、赚钱、培训、商单、出海、产品、Web3、自媒体运营与增长、合作、B 端 AI 赋能），并注明「排序未结合个人目标」。

## 9. 个性化字段清单

Profile 中与情报质量直接相关的字段：

| 字段 | 作用 | 谁在用 |
| --- | --- | --- |
| owner_aliases | 区分「我」和对方 | 所有信号、回复草稿、待兑现承诺 |
| labels.priority | 重点联系人标签 | wai_contact_daily、wai_wechat_labels |
| labels.commercial / creator / reactivation | 商业、创作者、复联分类 | 复联雷达与商机排序 |
| contact_daily.scope | hybrid 或 priority_labels_only | 重点联系人日报收录范围 |
| reply_style.history_days | 语气学习回看天数（默认 30） | wai_reply_draft 的 styleDays 缺省值 |
| reply_style.minimum_chat_messages | 采用当前会话口语所需的本人消息数（默认 5） | 回复草稿的语气模仿 |
| intelligence_priorities.focus_areas | 加权方向 | 排序与筛选矩阵 |
| intelligence_priorities.priority_keywords / deprioritize_keywords | 关键词加权与降权 | 排序 |
| intelligence_priorities.custom_topics | 自定义主题（主题=关键词1,关键词2） | wai_topic 的默认别名 |
| project_chat_terms | 交付群/项目群识别词 | 群聊价值矩阵与商机判定 |
| context.personal_documents / current_plan_documents | 个人说明与当前计划路径 | 排序与编辑判断 |

## 10. 一次完整接入的调用顺序

    wai_status
    wai_sources { "probe": true }
    wai_access_plan { "databaseRoot": "D:/wechat/db_storage" }
    wai_config_set { "sqliteSources": [{ "id": "main", "path": "D:/wechat/db_storage", "enabled": true }] }
    wai_db_index { "scope": "sessions", "sessionLimit": 80, "perChatLimit": 500 }
    wai_db_status
    wai_wechat_labels { }
    wai_profile_init { "ownerAlias": "我的微信名", "priorityLabels": ["客户", "品牌方"] }
    wai_doctor
    wai_privacy_scan { }

每一步都能独立验收：通道可用、索引有消息、昵称能识别、诊断无 error、隐私扫描通过。

## 11. 常见问题

| 问题 | 回答 |
| --- | --- |
| 必须配置 Profile 才能用吗 | 不是。没有 Profile 也能出报告，只是排序用默认口径，回复草稿语气保持中性 |
| 标签必须建吗 | 不必需，但强烈建议 2–5 个；它只影响日常私聊覆盖与优先级，不影响全微信检索 |
| 用户不肯给个人文档怎么办 | 用准备清单要 5–10 条要点即可，不要索取简历或长篇自传 |
| 换电脑后要重做吗 | 需要重新配置数据源路径与 Profile；本机数据不会自动同步 |
| 可以导入上游 Profile 吗 | 本项目 Profile 与上游 v2 结构对齐，可互相导入；导入后重新 wai_profile_status 复核 |

