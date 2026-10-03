# 工作流 06：转发到 Agent

## 适用场景

- 用户在微信里选中一段内容，想交给某个 Agent（Codex、Claude Code、DeepSeek Harness 等）继续处理。
- 想按场景（客户群、项目群、商单群）自动套用任务提示词。
- 想把之前投递过的内容换一个目标重投。

## 前置条件

- 知道目标 id（可用 wai_target_list 查看）。
- 场景已存在或可新建（wai_scene_list / wai_scene_upsert）。
- 全程不涉及任何微信写操作：投递只是把内容写成文件或交给本机应用。

## 步骤

### 1. 内容入 Inbox

    wai_inbox_push {
      "body": "<在微信里选中的原文>",
      "chat": "商单群X",
      "title": "商单群X 08-01 片段",
      "source": "clipboard",
      "kind": "chat"
    }

- 也支持 messages 数组（结构化 [{sender,ts,content,is_owner}]）或 files（附件路径）。
- 判重：同一内容重复推送会返回 duplicate 并跳过；确实要重推时加 force: true。
- wai_inbox_list { "status": "new" } 可以确认入队情况。

### 2. 匹配场景并预览提示词

    wai_scene_match { "title": "商单群X", "body": "<同一段内容>" }

返回命中的场景与将要发给 Agent 的完整提示词（preview）。**先看提示词再投**，确认任务描述与目标都正确。

默认场景：deal（商单群）、customer（客户群）、project（项目群）、knowledge（知识/文章）、default（通用）。

需要调整时：

    wai_scene_upsert { "id": "deal", "name": "商单群", "match": ["商单", "投放", "brief"], "priority": 90, "task": "判断是否真实商单：找需求方、预算、排期与交付要求；区分品牌方/中间人/加热者。", "targets": ["codex", "obsidian"], "enabled": true }

### 3. 预览投递（dryRun）

    wai_deliver { "body": "<内容>", "chat": "商单群X", "targets": ["codex", "obsidian"], "dryRun": true }

返回每个目标将要写入的路径、使用的场景与提示词摘要。**默认就是预览**，不落盘。

### 4. 正式投递

    wai_deliver { "body": "<内容>", "chat": "商单群X", "target": "codex", "dryRun": false }

目标 id 取值：codex | claude-code | deepseek-harness | workbuddy | doubao | qwen-work | wesight | obsidian | clipboard | folder | custom。

### 5. 各目标的差异

| 目标 | 落点 | 注意 |
| --- | --- | --- |
| Agent（codex / claude-code / deepseek-harness / workbuddy） | 本机提示词文件（promptFile 模板） | 提示词里包含场景任务与素材；不包含任何发送回微信的能力 |
| Agent 桌面应用（doubao / qwen-work / wesight） | 提示词文件 + 应用唤起 | 应用未安装时投递会失败，改用提示词文件 |
| obsidian | 指定 vault 与子目录 | 需要先配置 vault；附件会复制并生成嵌入链接 |
| clipboard | 系统剪贴板 | 适合立刻粘贴到任意位置 |
| folder | 指定目录 | 需要先配置目录路径 |
| custom | 用户配置的命令 | 命令由用户提供，本项目只调用 |

### 6. 复用历史投递

    wai_history_list { "limit": 20, "target": "codex" }
    wai_history_rerun { "id": "h_20260801_1015_ab12", "target": "obsidian" }

不需要重新抓取内容：历史记录里保存了原始载荷。

### 7. 批量场景

多条内容一起处理时用工作流 08（wai_batch_*）。

## 验收标准

- [ ] 场景匹配正确，预览提示词里任务描述与用户意图一致。
- [ ] 投递前经过 dryRun 预览；落盘路径在预期目录内。
- [ ] 提示词文件内容只包含素材与任务，不含任何「发送微信」的指令。
- [ ] 用户在微信里的原始内容未被修改（Inbox 只是副本）。
- [ ] 失败目标有明确说明，其余目标不受影响。

## 常见失败与处理

| 现象 | 处理 |
| --- | --- |
| 场景没匹配上，落到 default | 用 wai_scene_upsert 补 match 关键词或指定 scene 参数 |
| obsidian 目标不可用 | 先配置 vault（wai_config_set 或目标自身配置），或改用 folder |
| 目标 Agent 未安装 | 只投提示词文件，让用户手动打开；不要假装已唤起 |
| 内容太长 | 拆分投递或只投关键片段；提示词里说明「已截断」 |
| 重复推送 | 判重机制会跳过；确认后加 force: true |
