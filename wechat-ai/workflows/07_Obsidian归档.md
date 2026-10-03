# 工作流 07：Obsidian 归档

## 适用场景

- 把一段微信内容（商单、项目要点、文章、客户需求）沉淀成 Obsidian 笔记。
- 批量把选中的内容归档，并保留来源会话与链接。
- 需要附件（截图、文件）跟着笔记一起进入 vault。

## 前置条件

- 已有一个 Obsidian vault 目录（本机路径）。
- 可选：在微信流目标里配置 obsidian（vault + folder），这样可以直接用 wai_deliver 投递。

## 步骤

### 1. 单篇写入

    wai_obsidian_write {
      "vault": "D:/Obsidian/MyVault",
      "folder": "微信流",
      "title": "某品牌商单要点",
      "markdown": "## 结论\n- 预算区间：待确认\n- 交付时间：08-05 前初稿\n\n## 待办\n- [ ] 向中间人确认名额",
      "attachments": ["D:/wechat/exports/报价截图.png"],
      "tags": ["微信流", "商单"],
      "chat": "商单群X",
      "url": "https://example.com/brief"
    }

参数说明：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| vault | 是 | Obsidian vault 根目录 |
| markdown | 是 | 笔记正文（Markdown） |
| folder | 否 | 子目录，缺省为「微信流」 |
| title | 否 | 标题，用于文件名与 frontmatter |
| attachments | 否 | 附件路径数组，会被复制进 vault |
| tags | 否 | frontmatter 标签 |
| chat | 否 | 来源会话 |
| url | 否 | 来源链接 |

### 2. 写入语义（务必知道）

- **文件名**：<YYYY-MM-DD> <安全标题>.md，存放在 <vault>/<folder>/。
- **重名处理**：不覆盖已有笔记，同名时追加 -2、-3……（笔记永远只增不改）。
- **附件**：统一复制到 <vault>/<folder>/attachments/；图片用 ![[文件名]] 嵌入，其它文件用 [[文件名]] 链接。
- **frontmatter**：title、created、source（固定为 wechat-ai）、chat、url、tags。
- 说明：写入是「新建笔记」语义，不是「合并进已有笔记」。需要持续更新同一主题时，建议按日期分篇，或自行在 vault 里做索引页。

### 3. 批量归档（走投递）

    wai_deliver { "body": "<内容>", "chat": "商单群X", "target": "obsidian", "dryRun": true }

- 目标 obsidian 由配置决定 vault 与 folder；先 dryRun 看路径。
- 多条内容批量归档用工作流 08 的 wai_batch_*。

### 4. 检查结果

- 打开笔记：标题、frontmatter、正文结构是否正确。
- 附件是否可点：图片应内嵌显示，其它文件应是可点击的 wiki 链接。
- 是否产生重复笔记：同一标题多次写入会出现 -2、-3 后缀，属预期行为。

## 验收标准

- [ ] 笔记文件生成在预期目录，文件名符合 <日期> <标题>.md。
- [ ] frontmatter 含 title / created / source / chat / url / tags。
- [ ] 附件已复制到 attachments 目录，图片内嵌、文件为 wiki 链接。
- [ ] 已有笔记未被覆盖。
- [ ] 笔记内容不含未确认的金额与日期（事实闸门）。

## 常见失败与处理

| 现象 | 处理 |
| --- | --- |
| vault 路径不存在 | 确认路径拼写与盘符；本项目不自动创建 vault 根目录 |
| 附件没进去 | 检查附件路径是否存在、是否为文件；目录会被跳过 |
| 出现 -2、-3 文件 | 正常重名避让；如需合并请在 vault 内手工整理 |
| 中文文件名异常 | 使用安全标题（避免特殊符号），本项目会对标题做安全化处理 |
| 想更新已有笔记 | 本项目不做原地合并；改为新建当日笔记并在索引页链接 |
