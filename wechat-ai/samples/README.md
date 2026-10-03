# 演示数据与样例

本目录的资料**全部为虚构**，不含任何真实聊天、联系人或凭据。用途：在没有任何微信数据的情况下验证全链路。

## 1. 最快体验：内置演示数据源

不需要本目录，直接：

```text
wai_db_index  { "source": "mock", "scope": "sessions", "sessionLimit": 30, "allowDemo": true }
wai_group_daily { "hours": 72 }
wai_contact_daily { "hours": 72 }
wai_brief { "hours": 72 }
wai_today
```

演示数据覆盖：待回复、待兑现承诺、临近截止、待结算、品牌商单、培训合作、资源引荐、跨群重复链接、
红包加热、低价值娱乐群、长期未联系复联候选 —— 每类信号都有可验证样本。

## 2. sample_chat.txt —— 聊天文本解析样例

格式：`[YYYY-MM-DD HH:mm] 发送者: 内容`，其中 `我` 会被识别为本人。

```text
wai_scan { "target": "D:\\Users\\DeepSeekWeb\\wechat-ai\\samples\\sample_chat.txt" }
wai_db_search { "query": "预算" }
wai_deal_radar { "days": 30 }
```

包含：私聊询价、活动推广、结算请求、群内投放线索、跨群同一链接、红包加热、带预算的招募。

## 3. inbox-demo/demo-entry.json —— Inbox 条目样例

展示 Inbox 条目的完整字段结构（schema `wechat-ai/inbox@1`）。
把文件复制到数据根的 `inbox/new/` 下即可被处理：

```powershell
$home = if ($env:WECHAT_AI_HOME) { $env:WECHAT_AI_HOME } else { "$env:USERPROFILE\.wechat-ai" }
Copy-Item "D:\Users\DeepSeekWeb\wechat-ai\samples\inbox-demo\demo-entry.json" "$home\inbox\new\"
```

然后：

```text
wai_inbox_list { "status": "new" }
wai_inbox_process { "limit": 10 }
```

> 正常用法是用 `wai_inbox_push` 由本机选中的内容自动生成条目，而不是手工造 JSON。这个样例只是为了让字段结构一目了然。

## 4. export-demo/ —— 多群导出样例（可验证跨群链接聚合）

一个群一个文件，适合验证「同一链接出现在多个群」的判定：

```text
wai_scan { "target": "D:\\Users\\DeepSeekWeb\\wechat-ai\\samples\\export-demo" }
wai_signals { "days": 3650 }
wai_db_links { "days": 3650, "minChats": 2 }
wai_group_daily { "hours": 100000 }
```

实测结果：识别 4 个群 / 12 条消息；`https://example.com/campaign-brief` 出现在 2 个群 →
判定为「疑似商单（同一推广链接在 N 个群出现）」；同时检出 4 条品牌商单线索、2 条培训合作线索、3 条待回复。

> 单个文件里的所有消息会被视为同一个会话（会话名取文件内的 `【群名】` 标题或文件名），
> 所以想验证「跨群」必须**一个群一个文件**。

## 5. 自己造导出文件

支持 `.txt .md .log .json .jsonl .ndjson .csv`。几种被自动识别的格式：

```text
[2026-06-30 10:12] 张三: 你好                     ← 标准行格式
【客户群】
[2026-06-30 10:12] 王工: 想看报价                 ← 带群名标题
[{ "chat": "A", "sender": "B", "time": "2026-06-30 10:12", "content": "hi" }]   ← JSON 数组
{ "messages": [ { "chat": "A", "sender": "B", "time": "…", "content": "…" } ] } ← reader 契约
```

把文件或目录交给 `wai_scan`，或用 `wai_config_set` 注册成 vault 数据源后交给 `wai_vault_scan`。
