# Windows 接入：可行路径与边界

本文件回答一个问题：**在 Windows 上，怎么把微信数据接到本项目里，而且不越界。**

## 0. 边界（先看这一节）

| 做的事 | 不做的事 |
| --- | --- |
| 读取用户已经准备好的只读副本 | 不获取密钥、不推导密钥、不扫描进程内存 |
| 读取用户导出的聊天文件 | 不解密数据库、不实现解密算法 |
| 复制附件、建本地索引 | 不注入进程、不 Hook API、不替换或修改 DLL |
| 只读快照，不改原库 | 不写微信数据库、不重启微信、不自动提权、不关闭安全软件 |
| 在用户确认后写本机文件 | 不发送、不回复、不转发、不修改微信标签 |

wai_config_set 能写的内容只有本机配置：数据源（vaults / readers / sqliteSources）、转发目标 patch（targets，按 id 合并）、场景 patch（scenes，按 id 覆盖）、设置项（settings）与默认数据源（reader）。它不能写微信，也不能写任何凭据。

因此本项目**不宣称「Windows 一键接入」**。接入成功与否取决于用户手上有什么可用材料；材料齐了就一定能读，材料没有就走人工通道。

## 1. 五条只读通道

### 1.1 已解密的 db_storage 副本（sqlite/wcdb reader）

| 项 | 说明 |
| --- | --- |
| 适合谁 | 已经有自己解密的数据库副本，想要接近完整的会话、成员与媒体视图 |
| 形态 | 一个 db_storage 目录（或其账号子目录），内含已解密的消息库 |
| 配置 | wai_config_set { "sqliteSources": [{ "id": "main", "path": "D:/wechat/db_storage", "enabled": true }] } |
| 数据源 id | sqlite:<path>，或在 settings.reader 指定默认 |
| 验证 | wai_sources { "probe": true }、wai_compat_check、wai_self_test、wai_reader { "command": "status" } |
| 能力 | 时间线、检索、上下文、群成员、联系人、标签、导出；取决于副本完整性 |
| 边界 | 只读打开、只读快照；不改原库、不写回；副本损坏或未解密时直接报错，不做任何解密尝试 |

### 1.2 导出的聊天文件目录（vault reader）

| 项 | 说明 |
| --- | --- |
| 适合谁 | 用手工导出或第三方导出工具得到 txt / md / json / jsonl / csv |
| 形态 | 一个目录，里面是一批导出文件（每个文件通常是一个会话） |
| 配置 | wai_config_set { "vaults": [{ "id": "exports", "path": "D:/wechat/exports", "enabled": true }] } |
| 数据源 id | vault:<dir>；未配置时回退到默认 vault 目录 |
| 验证 | wai_vault_status（文件数/会话数/可读消息数）→ wai_vault_scan |
| 能力 | 会话列表、时间线、关键词检索、导出；成员/媒体等能力取决于导出内容 |
| 边界 | 只读文件；解析失败按文件报错，不猜测缺失字段 |

### 1.3 本机选中内容走 Inbox（零依赖，最稳）

| 项 | 说明 |
| --- | --- |
| 适合谁 | 所有用户；尤其是没有数据库副本、也不愿意导出全量的人 |
| 形态 | 用户在微信里选中一段聊天 → 复制/分享 → 交给 Agent → wai_inbox_push |
| 配置 | 无需配置 |
| 调用 | wai_inbox_push { "body": "<选中的原文>", "chat": "客户群A", "kind": "chat" } → wai_inbox_process |
| 能力 | 覆盖**用户主动选中的部分**：文本、文章、视频信息、附件路径 |
| 边界 | 不覆盖用户没选的内容；不能用来声称「全量扫描过」；判重依赖内容哈希，force 可绕过 |

### 1.4 外部只读 CLI（cli reader，兼容 rion-wechat-cli 协议）

| 项 | 说明 |
| --- | --- |
| 适合谁 | 已经有自己的只读读取器（本地 CLI），希望复用本项目的语义层 |
| 形态 | 一个可执行命令 + 参数，按约定输出 JSON 信封 { ok, tool, command, data, warnings, protocol } |
| 配置 | wai_config_set { "readers": [{ "id": "rion", "name": "rion-wechat-cli", "command": "D:/tools/wechat-cli.exe", "args": [] }] } |
| 数据源 id | cli:<id> |
| 验证 | wai_compat_check（status / sessions / timeline 三层冒烟）、wai_self_test |
| 能力 | 由 CLI 决定；wai_reader 的 29 个子命令会映射到该 CLI 的对应方法，未实现的方法返回明确说明 |
| 边界 | 本项目只调用它并解析输出，不安装、不打包、不生成密钥；CLI 自身的合规性由用户负责 |

### 1.5 演示数据（mock）

| 项 | 说明 |
| --- | --- |
| 适合谁 | 零数据验证全链路、演示、回归 |
| 配置 | 无需配置；wai_db_index { "allowDemo": true } 或 source: "mock" |
| 能力 | 虚构的会话、消息、链接与商机，用于跑通流程 |
| 边界 | **所有产物必须标注「演示数据、虚构内容」**，不得当作真实情报汇报 |

## 2. 接入状态机

wai_access_plan 会把当前状态归到一层，并给下一步：

| 层级 | 含义 | 下一步 |
| --- | --- | --- |
| 缺目录 | 没有可读的数据源路径 | 让用户提供导出目录或已解密副本路径 |
| 缺密钥 | 材料是加密库且没有可读副本 | **不是本项目要解决的问题**：让用户自己准备已解密副本，或改走 Inbox |
| 依赖缺失 | 外部 CLI 或运行时依赖不可用 | 修依赖或换通道 |
| 权限不足 | 路径存在但当前用户读不到 | 修 ACL/权限后重试 |
| 可配置 | 材料齐全，尚未写入配置 | wai_config_set 后 wai_db_index |
| 就绪 | 能读到消息 | 进入 Profile 与日报 |

## 3. 数据源选择顺序

未显式指定 source 时，按以下顺序选择：显式指定 > 配置指定的 settings.reader > cli:<id> > sqlite:<path> > vault > local（本地索引）> mock（仅在 allowDemo 时）。

判断通道是否真的可用要用 wai_compat_check 或 wai_reader 的 status，不要只看配置里有没有写路径。

## 4. 能力矩阵

| 能力 | sqlite/wcdb | vault | Inbox | cli |
| --- | --- | --- | --- | --- |
| 时间线 timeline | 有 | 有 | 用户选中部分 | 取决于 CLI |
| 关键词检索 search | 有 | 有 | 有（索引内） | 取决于 CLI |
| 上下文 context | 有 | 部分 | 无 | 取决于 CLI |
| 群成员 members | 有 | 通常无 | 无 | 取决于 CLI |
| 联系人 / 标签 | 有 | 通常无 | 无 | 取决于 CLI |
| 媒体与附件 | 有（媒体文件本体需另行准备） | 取决于导出 | 仅路径 | 取决于 CLI |
| 收藏 / 朋友圈 | 有（若副本含对应库） | 通常无 | 无 | 取决于 CLI |
| 只读快照 | 是 | 是 | 是 | 由 CLI 决定 |

## 5. 失败排查顺序

1. 先看 wai_doctor 的 diagnostics：empty_index、stale_data、no_source、privacy_scan_failed 等都有明确修复建议。
2. 路径问题：确认路径存在、大小写与中文路径正确、当前用户有读权限。
3. 格式问题：确认导出文件能被解析；不要因为一个文件失败就重做整套接入。
4. 通道问题：wai_compat_check 看是 status、sessions 还是 timeline 层失败。
5. 版本/环境问题：换机器或微信升级后重现的失败，先降级到已有索引继续工作，并说明缺口。
6. **禁止的捷径**：不重装整套、不覆盖旧配置、不扫描其他账号、不自动重取材料、不盲目重试同一个失败调用。

## 6. 权限与安全

- 只读打开用户提供的副本；如果实现会写临时文件，写在项目自己的目录里，不写回用户的数据库目录。
- 报告与索引都属于敏感数据：输出目录不应放在会被同步或提交的仓库目录内（settings.privacy.blockInsideRepo）。
- 分享产物前跑 wai_privacy_scan。
- 排查日志只记录状态、计数与耗时，不记录聊天原文、密钥候选或内存内容。

## 7. 验收标准

- [ ] wai_sources { "probe": true } 中至少有一个非 mock 的可用数据源。
- [ ] wai_compat_check 返回 ready（或明确说明 degraded 的原因与影响范围）。
- [ ] wai_db_status 显示索引里有真实消息，且数据年龄已知。
- [ ] 抽检 1–2 个已知会话：消息内容与微信里看到的一致。
- [ ] wai_doctor 无 level=error 的条目。
