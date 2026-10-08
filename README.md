# CalvinMCP

MCP 工具与技能集合仓库。纯净发布口径：零预装依赖（依赖由命令生成），不含 `node_modules` 与 `.` 前缀文件，不含任何凭据。本 git 镜像在此基础上另剔除测试示例文件（demo/sample/示例/演示类素材）与开发机运行残留（`logs`/`runs`/`test-results`/`generated`/`flows` 测试瞬态等），仓库内不含这些文件。

## MCP Skills

| 目录 | 说明 | 版本 |
|---|---|---|
| [calvin-db-mcp/](calvin-db-mcp/) | 多库数据操作 MCP（MySQL / PostgreSQL / OceanBase / SQLite，**18 工具** + 分层安全守卫 + 凭据保护 + 配置热重载；内置完整 Skill 与《部署说明.md》，18 工具自然语言使用示例全覆盖） | **v1.6.56** |
| [sql-check-script/](sql-check-script/) | SQL 全链路质量检测 + 只读数据分析 Skill（依赖同级 calvin-db-mcp v1.6.51+；仅只读，含 E2E 测试、一键验收、`巡检一键.mjs` 闭环、《部署说明.md》全量自然语言示例） | **v1.4.46** |
| [web-rpa-mcp/](web-rpa-mcp/) | 网页 RPA 录制/回放 MCP（**44 工具** + **427 项自检全绿** + 《部署说明.md》；重复网页操作录一遍即生成技能，支持一键/定时复跑、自愈、告警、浏览器插件桥接） | **v1.8.3** |
| [wechat-ai/](wechat-ai/) | 微信个人情报库 + 微信流（Windows 本地只读；MCP 服务器 + **73 个技能工具**：索引/信号检测/商机管线/复联雷达/报告生成/批量采集/隐私门禁） | v1.1.4 |
| [playwright-verify/](playwright-verify/) | Playwright 端到端测试「验收 / 门禁 / 执行」MCP + Skill（**16 工具**：用例验收、失败归因、门禁合入、自然语言测试目标、页面巡检、分页采集、双期对比） | v1.8.17 |

## 自检实测（2026-10-09）

- **calvin-db-mcp**：selftest **`380 passed, 0 failed`**（未初始化口径 361，双口径已实测）· sqlite-validate `83` · mysql-validate `37` · pg-validate `62` · e2e-validate `46` · protocol-validate `24` · realform-validate `43` —— 全部 0 failed（真实 MySQL 8.4.5 / PostgreSQL 17.5；**18 工具**真实库矩阵）
- **sql-check-script**：一键验收 `node tests\run_all.mjs` 末行 `RUN_ALL selftest=… sqlite-val=… mysql-val=… docsync=… config-lint=… inspect=… e2e=… => OK`（数字以当日实测为准；inspect-one 25 用例、config-lint 21 项、docsync 14 项）
- **web-rpa-mcp**：自检 **427 项全绿**（121 单元 + 27 规则 + 30 协议 + 65 工具 + 34 端到端 + 138 集成 + 12 审计）+ 覆盖度自检（**44 工具 / 21 步骤 / 11 断言 / 26 规则 / 10 CLI / 113 工具参数** 全部有测试，40 配置键全部有接线）
- **wechat-ai**：`node verify.mjs` **15 套件 / 587 断言**全绿（0 failed）· selftest `98 passed, 0 failed` · e2e 73/73 工具覆盖 · `scanPrivacy` 发布视角 0 findings
- **playwright-verify**：`verify-all` **13 套件 / 698 断言**全绿（三态判据 mode 1/2/3 = 517/572/669）· hardened-check `98 passed, 0 failed` · 真实浏览器矩阵 4 签名

各包每日实测数字以各包 README 首部「实测」行为准；完整打包与历史验收记录见下文「发布版本」章节。

## 部署

各 skill 目录自包含（README / SKILL / 部署文档）：

- 含 `install.mjs` 的（calvin-db-mcp / web-rpa-mcp / wechat-ai）：进入目录执行 `node install.mjs`，环境检查 → 自检 → 注册 Claude Code / Claude Desktop / Cursor；依赖由 `npm ci --omit=dev` 命令生成（内网可加 `--registry` 镜像）
- 其余（sql-check-script / playwright-verify）：按目录内《部署说明.md》安装；两者零 npm 依赖（playwright-verify 执行类工具的可选依赖由被测项目提供，缺失只影响对应工具并诚实报缺）

完整自然语言使用示例（装好后直接说人话即可）见各包《部署说明.md》「完整自然语言使用示例」——紧随其「快速命令索引（速查）」之后，覆盖各包全部工具。

---

# 发布版本

纯净发布包（剔除开发机残留），解压/拷贝即可部署。五个名称目录并列放置——`install.mjs` 的
全链路 E2E 验收按「同级 `sql-check-script`」自动发现，此布局下开箱即启用部署验证。

## 目录

| 目录 | 内容 | 版本 |
|------|------|------|
| `calvin-db-mcp\` | MCP 服务本体（server + 安装器 + 自检套件 + README/SKILL/部署说明 三文档；**18 工具** + 分层安全守卫 + 凭据保护 + 配置热重载；**零预装依赖**，`install.mjs` 以 `npm ci` 命令生成） | **v1.6.56** |
| `sql-check-script\` | SQL 质量检测/只读分析 Skill（双模式 + 全链路 E2E + 一键验收 + `巡检一键.mjs` 闭环 + 《部署说明.md》；**零 npm 依赖**，拷入即用） | **v1.4.46** |
| `wechat-ai\` | 微信只读情报 MCP（73 工具 + 安装器 + 15 套件测试 + 《部署说明.md》；零 npm 依赖，拷入即用） | v1.1.4 |
| `playwright-verify\` | Playwright 验收门禁 MCP（16 工具 + Skill + 13 套件全量回归 + 真实浏览器矩阵；**零 npm 依赖**，拷入即用；执行类工具由被测项目提供可选依赖后启用，《部署说明.md》随包） | v1.8.17 |
| `web-rpa-mcp\` | 网页 RPA 录制/回放 MCP（44 工具 + 427 项自检 + 《部署说明.md》；**零预装依赖**，`install.mjs`/`npm ci` 命令生成） | **v1.8.3** |

版本纪律（五包同口径）：每次发版把版本号与版本说明同步到全部对应文档（版本说明落 README「更新记录」/「版本记录」），
缺一处即视为发版未完成；发版前自检全绿才可发布 / 重打包。规范见各包 README「版本与文档同步规范」。

文档口径（2026-10-05 起）：每包部署文档**只有一份《部署说明.md》**——原《部署说明.详细版.md》已全量合并入内
（取最全内容，含全部自然语言使用示例与安装/配置/排障/卸载），详细版不再随包。

## 纯净性（相对开发仓库剔除）

> 本节描述**发布版本 zip 包**口径；**本 git 镜像**额外剔除测试示例文件（`demo\`/`samples\`/`sample_sql\` 目录、
> `demo.db`/`demo.mjs`、`示例_*.md`/`演示-*.json` 等演示素材）与开发机运行残留/机器生成物（`.zcode\`/`.e2e-lab\`/
> `.github\`/`.playwright-cli\`/`test-results\`/`generated\`/`flows\int-*.json`、`mcp\dbmcp.config.json` 凭据等）
> ——仓库内不含这些文件，zip 包按各包自验收需要保留。

- `.git\` — 版本历史不随包
- `mcp\dbmcp.config.json` — **连接凭据（enc 加密态也按敏感文件对待），不随包**；装机时用 `.dbp` 导入
- `mcp-register.example.json` — 机器相关自动生成物（含开发机绝对路径），装机时 `install.mjs` 重新生成
- `*.dbp` / `*.bak-calvin-db-mcp` / `*.log` / `*.tmp` — 凭据包与临时残留

`wechat-ai\` 额外说明（纯净口径，2026-10-03 重打包）：
剔除 `mcp-register.example.json`（机器相关自动生成物，同上规则）与**所有含 `.` 前缀的文件/目录**；
**无 `node_modules\`**（零 npm 依赖、无凭据文件，不需要生成任何依赖）。
保留：`samples\` 样例、`docs\` 演示截图、`verify.mjs` + `mcp\tests\` 自验收套件（自验收依赖），`部署说明.md`（部署文档随包，2026-10-05 起合并原详细版为单份）。

`mcp\` 额外说明（打包口径由 `distribute.mjs` 自校验，81 文件逐个哈希比对 + 排除项泄漏检查）：
剔除 `node_modules\`、**所有含 `.` 前缀的文件/目录**（`.git\`/`.github\`/`.playwright\`/`.playwright-artifacts\`/
`.playwright-cli\` 等运行产物与机器生成物 —— `.playwright\cli.config.json` 为平台相关配置，装机时按平台重新生成）、
`demo\generated*`/`demo\test-results\`/`test-results\`/`dist\` 运行产物、`__pycache__\`/`*.pyc`（Python 字节码内嵌编译时路径，
跨目录比对必误报）、`*.log`/`*.tmp`/探查脚本等临时残留。**accounts.json / .env 按凭据纪律绝不入库**（本包不含）。
零 npm 依赖 —— 不需要 `npm install`、不需要联网；执行类 / CLI 类工具另需被测项目自己提供
`@playwright/test`/`@playwright/cli`（可选依赖，缺失只影响对应工具并诚实报缺）。
保留：`demo\` 离线可复现样例（回归矩阵 / Excel 用例表 / 靶页）、`mcp\test\` 13 套自验收套件（自验收依赖）、
《部署说明.md》（部署文档随包，2026-10-05 起合并原详细版为单份）。

`calvin-db-mcp\` 额外说明（纯净口径，2026-10-03 重打包）：
剔除 `mcp\node_modules\`（**依赖由 `install.mjs` 的 `npm ci --omit=dev` 命令生成**，需联网、可加镜像）、
**所有含 `.` 前缀的文件/目录**（`.git\`、`.gitignore`——装机导入 `.dbp` 时自动生成）、
`mcp\dbmcp.config.json`（连接凭据）、`mcp-register.example.json`（机器相关自动生成物）、
`*.dbp`/`*.bak`/`*.log`/`*.tmp`（凭据包与临时残留）。
保留：`demo.db`（E2E 自供给 fixture，books 演示表 3 行）与 `部署说明.md`（部署文档随包，2026-10-05 起合并原详细版为单份）。

`sql-check-script\` 额外说明（纯净口径，2026-10-03 重打包）：
**零 npm 依赖**（无需 `npm ci`、无需联网），剔除**所有含 `.` 前缀的文件/目录**与开发机路径残留
（含 `tests\fullchain_test.mjs` 默认 server 目录由开发机绝对路径改为同级解析）；无凭据文件（连接凭据走 `calvin-db-mcp` 的 `.dbp` 导入）。
保留：`tests\run_all.mjs` + `tests\fullchain_test.mjs`（验收自依赖同级包与 `demo.db`）、`assets\sample_sql\`、
《部署说明.md》（部署文档随包，2026-10-05 起合并原详细版为单份）。

`web-rpa-mcp\` 额外说明（纯净口径与 `calvin-db-mcp\` 同款，2026-10-03 重打包）：
剔除 `mcp\node_modules\`（**依赖由命令生成**：`install.mjs` 自动 `npm install`，或手工 `cd mcp; npm ci`）、
**所有含 `.` 前缀的文件/目录**（`.gitignore` 改为装机时 `install.mjs` 自动生成）、
`.work\`（**加密密钥/加密凭据/浏览器登录态 profile/定时包装器/流程备份——等同登录凭据，绝不随包**）、
`runs\`（运行报告与截图）、`logs\`（运行/告警/定时日志）、`web-rpa.config.json`（可能含 Webhook 地址）、
`mcp-register.example.json`（机器绝对路径，装机时重新生成）。
保留：`flows\演示-订单日报导出.json`（E2E/集成自供给 fixture，`demo\seed-demo-flow.mjs` 可再生）、
`demo\` 演示站点、`references\` / `workflows\` 技能文档、《部署说明.md》（部署文档随包，2026-10-05 起合并原详细版为单份）。

## 快速部署

```powershell
cd <发布版本>\calvin-db-mcp
node install.mjs "C:\path\to\your.dbp"   # 自动生成依赖（npm ci）+ 导入连接 + selftest + 全链路 E2E + 自动注册
```

无 `.dbp` 时先 `node install.mjs` 看初始化指引，导入后重跑即完成注册与验收。

```powershell
cd <发布版本>\wechat-ai
node install.mjs     # 环境检查 → 自检（98 断言）→ 注册 Claude Code / Claude Desktop / Cursor
```

```powershell
cd <发布版本>\playwright-verify
node skill\playwright-verify\install.mjs   # 拷贝即部署：复制部署副本 + CLI 通道配置适配当前平台 + 注册客户端；不需要 npm install、不需要联网
# 执行类 / CLI 类工具（run_verify / cli_* / nl_test_goal / explore_page）另需被测项目提供 @playwright/test / @playwright/cli
# （可选依赖，不属于部署步骤；缺失只影响对应工具，工具面诚实报缺）
```

```powershell
cd <发布版本>\web-rpa-mcp
node install.mjs     # 建目录 + 生成 .gitignore/默认配置 → 自动装依赖（零预装依赖，首次需联网）→ 自检 → 打印注册 JSON → 装 Skill
```

## 发布包自验收（2026-10-03 实测；V1.6.2 / v1.4.2 重打包后复测）

> 注：本节起为 **2026-10-03 首轮打包验收的历史实测记录**——版本号、断言数字与当日文档口径（部署说明双文档、`mcp\` 旧目录名）按记录原样保留，不回填改写；当前状态见上文「自检实测（2026-10-06）」与「目录」，各轮变更见文末「更新记录」。

**横向验证（2026-10-03）**：四兄弟包（wechat-ai / calvin-db-mcp / web-rpa-mcp / sql-check-script）与 mcp
统一按「一次性副本验收 + 终态哈希终查」口径各复跑一轮 —— 验收只在临时中文路径副本上执行、验后整目录删除，
交付树自始至终不进套件；终态终查：五包交付树前后哈希**逐位不变**、纯净全净（无 `node_modules`、无 `.` 前缀）。
各包复跑结果见各节「横向验证」条目（含一处跨包发现：calvin-db-mcp `install.mjs --dry-run` 落盘）。

**门禁已机械横向铺开（加固 H19，2026-10-03）**：五包的 `distribute.mjs` 收尾**全部**自带
「一次性副本验收 + 终态哈希终查」门禁——发版=跑 `distribute`，不可能忘：
`node distribute.mjs --force`（打包+自校验+门禁）/ `node distribute.mjs --gate-only`（只跑门禁不打包，
源树口径：源树排除名单内残留（`.git`/`.work` 等）记「已知排除项（不随包）」不判红）/
`--no-gate`（显式跳过且留痕）；门禁失败退出码 3、发布包不可交付。验收统一**诚实 SKIP 退出码契约**：
`exit 0` = 全部通过且无 SKIP；`exit 1` = 存在失败；`exit 3` = 无失败但有诚实 SKIP（如 `mysql-validate`
无凭据 SKIP、缺可选依赖的执行层 SKIP）—— 明示记录、判过但不冒充全绿，跳过数单独计数
（「X passed, Y failed, Z 诚实SKIP」）。`git-pub\copy-pure.mjs`（发布版本 → git 仓库同步器）镜像前
逐包先跑同款门禁，门禁不过不写任何仓库文件（不验证不写盘）；镜像做全局换名
（`calvin-db-mcp`→`calvin-db-mcp`，含文件名）+ 装机生成物/凭据过滤 + 逐文件自校验 +
仓库 `.gitignore` 抢救保留（git 基建不随整目录换新被误删）。

### calvin-db-mcp（2026-10-03 实测）

纯净包零预装依赖，先在 `calvin-db-mcp\mcp` 下 `npm ci --omit=dev`（与 `install.mjs` 步骤 2 同命令，26 个纯生产包）再执行三套件：

```
node mcp\selftest.mjs         === 263 passed, 0 failed ===   （未初始化口径；装机导入 .dbp 后为 277）
node mcp\sqlite-validate.mjs  === sqlite-validate: 76 passed, 0 failed ===
node mcp\mysql-validate.mjs   SKIP（包内无凭据配置，退出码 3 属预期）
```

- 三套件 **0 failed** 通过；`mysql-validate` 真实 MySQL 全工具面 **29 项**（配好真实 MySQL 源后 29 passed；开发机实测矩阵 selftest 277/263 · sqlite-validate 76 · mysql-validate 29 全绿）
- 验收后已复原纯净口径（清除 `mcp\node_modules\`），终查包内无 `node_modules`、无任何 `.` 前缀文件/目录（20 文件）
- **横向验证（一次性副本口径）**：三套件在临时副本复跑 `263/0 · 76/0 · SKIP（退出码 3 实测）` 与上一致。**跨包发现并已修**：`install.mjs --dry-run` 原本**没有 dry-run 语义**（未知参数被静默忽略）——试跑会无条件写出 `mcp-register.example.json`，已初始化机器上还会真写 `~/.claude.json` 等用户全局配置（wechat-ai v1.0.1 已修的同款落盘）。已照 wechat-ai 修法补齐真 `--dry-run`（只打印不落盘：跳过依赖安装 / 配置导入 / 自动注册 / 示例配置写出，`REG=dry`），双探针复测零落盘（无依赖副本连 `node_modules` 都不创建）、三套件不回归；修复同步两份仓库源（calvin-db-mcp，保持 CRLF 与改名行差异）。交付树哈希换新基线：20 文件 `93526a9b…`（修复前 `bceb2501…`）
- **发版门禁（H19 横向）**：`node distribute.mjs --force` 收尾自动「一次性副本三套件验收 + 终态哈希终查」；实测门禁通过 ✅（21 文件自校验 + `npm ci` + selftest 263/0 + sqlite-validate 76/0 + mysql-validate 诚实 SKIP（exit 3）判过 + 终态哈希 0 不一致）——`mysql-validate` 退出码 3（无凭据 SKIP）按统一「诚实 SKIP」口径计入判过、明示不冒充全绿

### sql-check-script（2026-10-03 实测，纯净重打包后按部署路径复测）

按部署路径先在 `<发布版本>\calvin-db-mcp\mcp` 下 `npm ci --omit=dev` 生成依赖（本包零 npm 依赖免此步；一键验收依赖同级包），
再在 `<发布版本>\sql-check-script` 下执行 `node tests\run_all.mjs`：

```
RUN_ALL selftest=263/0 e2e=46/0 gates=core => OK
```

- `selftest=263` 为**未初始化口径**（包内无凭据配置，属预期；装机导入 `.dbp` 后为 277）
- `e2e=46` 为全链路核心段，fixture 自动使用同级包内 `demo.db` 自供给，不依赖任何外部配置；红线用例跑完后 books 表仍 3 行（未被写坏）
- live 段（MySQL `FULLCHAIN_MYSQL=1` / PG `FULLCHAIN_PG=1`）需目标环境配好真实源后开启
- 验收后已复原纯净口径（清除 `mcp\node_modules\`），终查两包无 `node_modules`、无任何 `.` 前缀文件/目录、无开发机路径残留（0 命中）
- **横向验证（一次性副本口径）**：与 calvin-db-mcp 按兄弟布局同副本复跑 `RUN_ALL selftest=263/0 e2e=46/0 gates=core => OK` 与上一致；交付树前后哈希不变（27 文件 `0db348d0…`）
- **发版门禁（H19 横向）**：`node distribute.mjs --force` 收尾自动「一次性副本验收（同级拷 calvin-db-mcp 供 run_all 解析）+ 终态哈希终查」；实测门禁通过 ✅（28 文件自校验 + `npm ci --omit=dev` + `tests/run_all.mjs` 全绿 + 终态哈希 0 不一致）

验收线以 **0 failed** 为准，勿以 passed 数为验收线（用例数随版本/源连通性增长）。

### wechat-ai（2026-10-03 实测，v1.0.1 重打包后复测）

在 `<发布版本>\wechat-ai` 下执行 `node verify.mjs`：

```
12 套件全部通过 / 0 failed
核心自检 94 · 微信流 23 · WCDB 49 · 只读数据源 30 · 结构漂移 16 · 内容口径 18+13 · 健壮性 13 · 规模 18 · 端到端 85 = 368 断言（另 MCP stdio 传输全通过）
```

- `scanPrivacy` 发布视角：**0 findings**（扫 74 文件 / 约 1.0 MB）
- `node install.mjs --dry-run`：`INSTALL_STATUS=OK TOOLS=63 PASS=94 FAIL=0 REG=dry`
- 修复自检污染纯净包：`install.mjs --dry-run` 曾无条件写出 `mcp-register.example.json`（违反其「不落盘」约定），改为 `--dry-run` 只打印、真实装机才落盘；自验收后包内不再复现该文件
- 终查纯净口径：包内**无 `node_modules`、无任何 `.` 前缀文件/目录**、无开发机残留（0 命中）
- **横向验证（一次性副本口径）**：`verify.mjs` 12 套件复跑全部通过 / 0 failed；`install.mjs --dry-run` 在副本内零落盘（86 文件与交付树逐一比对无增无减）；交付树前后哈希不变（`2ef1061d…`）
- **发版门禁（H19 横向）**：`node distribute.mjs --force` 收尾自动「一次性副本 verify.mjs + 终态哈希终查」（退出码 0/3 判过）；实测门禁通过 ✅（87 文件自校验 + 12 套件全绿 + 终态哈希 0 不一致）
- 打包时修复自检套件路径 bug：`URL.pathname` 对中文目录名做百分号编码，`发布版本` 路径下 26 条模块断言被静默跳过（仅 68/94）；改用 `fileURLToPath` 后中文/ASCII 路径均 94/94

**版本说明（v1.0.1）**：纯净发布包口径收紧（无 `node_modules`、无 `.` 前缀目录，剔除开发机残留，解压 / 拷贝即可部署）；文档去除「依赖用命令生成」表述（零 npm 依赖，不需要生成任何依赖）；`install.mjs --dry-run` 修复为只打印不落盘（不再写出机器相关示例配置污染纯净包）；部署说明拆分为 `部署说明.md`（速查）+ `部署说明.详细版.md`；文档随包内置「版本记录」与「自然语言使用示例」（README / SKILL / 项目说明 / 部署说明×2 五文档同步，`wechat-ai-docs` 文档包同步），README 承载「版本与文档同步规范」——每次版本更新（`SERVER_VERSION` 唯一源）同步全部文档，缺一处即视为发版未完成。v1.0.0（2026-10-03）为首个发布版本。

### mcp（playwright-verify 的旧目录名；2026-10-03 实测，中文路径下直接执行；v1.2.0 重打包后复测）

打包自校验（`distribute.mjs` 默认开启）：**81 文件逐个哈希与源码一致、无排除项泄漏**。
自验收改在**一次性副本**上执行（中文路径临时目录，验后整目录删除）：产品按约定把证据落盘到
`<cwd>/.playwright-artifacts/`，在交付树内跑验收必然跑脏它（本轮就实测到 3 个证据文件残留后被终查抓出），
因此**交付树自始至终不跑任何套件**，终态终查才成立：包内**无 `node_modules`、无任何 `.` 前缀文件/目录**、
与源码逐文件哈希比对 **0 不一致**（81 文件）。

纯净口径（拷入未装依赖，零 npm 依赖 —— 不需要 `npm install`、不需要联网）：
`node skill\playwright-verify\scripts\selfcheck.mjs` 必需项全部通过
（Playwright 运行器/playwright-cli 按可选项 SKIP，其余工具不受影响）；`verify-all` 双模式实测：

```
不带浏览器 12/12（4 套浏览器套件按设计 SKIP）：
扫描器 14 · 归因 23 · 生成器 27 · 协议与工具面 74 · 规则表 35 · 加固 78（2 项 SKIP）·
智能体线 72 · 部署副本 26 = 349 断言（零依赖可跑）

--with-browser 13/13（缺可选依赖的执行层诚实 SKIP，不做假红）：
CLI 真实交互 / 智能体线端到端 整套 SKIP（缺 @playwright/cli）、真实浏览器矩阵 SKIP（缺 @playwright/test）；
Excel 编排 17（1 项 SKIP）· 参数规范化 34（2 项 SKIP）= 400 断言（零依赖段照常验收）
```

装齐可选依赖后在一次性副本上实测（验收动作、非部署步骤：`npm ci` 装可选依赖 + `setup-cli-config.mjs`
生成 `.playwright\cli.config.json`（与 `install.mjs` 同源的装机动作，机器相关配置不随包））：
`node mcp\test\verify-all.mjs --with-browser` **13/13 全部通过（52.8s）**：

```
扫描器 14 · 归因 23 · 生成器 27 · 协议与工具面 74 · 规则表 35 · 加固 78（2 项 SKIP：. 前缀钉在源码树验证）·
CLI 真实交互 21 · Excel 编排 20 · 参数规范化 40 · 智能体线 72 · 智能体线端到端 18 · 部署副本 26 = 448 断言
真实浏览器矩阵：2 通过 / 6 失败 / 1 偶发 → 4 个根因签名（assertion:3 locator-strict:1 timeout:1 env:1）
```

未生成 `.playwright\cli.config.json` 时 CLI 类工具按环境失败**诚实报缺**（`Chromium distribution ... not found`
+ 修法提示），不误报成产品缺陷 —— 这正是环境归因（H11）的口径。开发树（同源码、装齐可选依赖）复归
**13/13（450 断言，加固 80 全数在源码树执行）+ 矩阵 4 签名（52.7s）**。

`verify-all` 收尾开关（**证据目录只在失败时保留**）同轮在一次性副本上五态实测，副本即上述重打包产物
（H19 门禁版重发后五态逐项复测一致）：
R1 模式1 全绿（12/12，1.7s）→ 自动清理 `.playwright-artifacts`，包内文件数回 81；
R2 模式2 零依赖全绿（13/13，2.3s）→ 清理 `.playwright-artifacts` + `demo/generated-e2e`；
R3 装齐依赖全量全绿（13/13，52.8s + 矩阵 4 签名）→ 五类产物目录全清，**整树 diff（含 `node_modules` 与
`.playwright` 机器配置）为空**；R4 全绿 + `--keep-artifacts` → 产物保留；
R5 受控失败（临时改名 `demo/tests/clean.spec.ts`，9/12 通过 3 套失败）→ 现场保留。
Windows 句柄占用 `rmSync` EPERM 自动重试一次再报剩余；旁证：部署副本哈希漂移触发的意外红同样保留现场。
`verify-all --mode 1|2|3`（§15.3 判据行**一条命令复跑三态**）：每态不只跑命令还**校验状态**
（mode 2 零依赖态、mode 3 全量态，状态不对预检拦下给修法，不许 mode 3 在零依赖机器上静默退化成
mode 2 还报绿）——mode 1 = 12/12（349 断言）、mode 2 = 13/13（400 断言 + 诚实 SKIP）、
mode 3 = 13/13（448 断言 + 矩阵 4 签名），判据行自动比对；发版门禁嵌套 `--mode 2`。
发布流程（**验收跑一次性副本 + 终态哈希终查**）已成文于《部署说明.详细版.md》**§15 发布流程（发版者）**，
`§7.2` 同步收尾约定 —— 发版者按章节执行即可，不再重蹈「验收跑脏交付树」覆辙；并已**升格为机械门禁**
（加固 H19）：`distribute` 收尾自动「一次性副本 verify-all + 终态哈希终查」，门禁失败退出码 3、发布包不可交付
—— 发版不可能忘。本轮重发实测门禁通过 ✅（81 文件自校验 + 副本 verify-all 12/12 全绿 + 终态哈希终查 0 不一致；
显式跳过走 `--no-gate` 且留痕）。

**版本说明（v1.2.0）**：纯净发布包口径收紧 —— 无 `node_modules`、无任何 `.` 前缀文件/目录（剔除开发机残留），
解压 / 拷贝即可部署；零 npm 依赖（不需要 `npm install`、不需要联网、不需要生成任何依赖，可选依赖由被测项目 / 本机提供）；
文档去除「依赖用命令生成」表述，全量改为零依赖「拷贝即部署」口径；部署文档拆分为《部署说明.md》（速查）
+《部署说明.详细版.md》（完整参考）；五文档随包内置「版本记录」与「自然语言使用示例」（README / 使用文档 /
部署说明 / 部署说明.详细版 / SKILL），加固 H16 机械检查不缺项、H18 实跑 `distribute` 验纯净产物本身、
H19 把「验收跑一次性副本」升格为发版门禁（`distribute` 收尾自动副本 verify-all + 终态哈希终查，发版不可能忘）。
包内含 v1.1.0 智能体线（`nl_test_goal` 自然语言目标 → LLM 只做规划 → 真执行真断言 → JSON verdict；
`explore_page` 死链/坏图/表单盘点，确定性判定；工具 11 → 13；key 只从环境变量）。

纯净包复测抓出并修复三个真实缺陷（均只有「零依赖纯净包」才暴露）：
1. **加固 H10/H14 硬读 `.` 前缀文件**：`.gitattributes`/`.gitignore` 直接读文件 —— 纯净包按口径不含 `.`
   前缀文件，套件误报「缺失」。已改为存在性守卫（缺失时**诚实 SKIP** 并注明该钉在源码树验证）：
   源码树 80 断言全数照跑，包内 78 + 2 SKIP；
2. **`run_verify` 守门顺序缺陷**：参数校验发生在「Playwright 装没装」能力检查之后 —— 零依赖机器上
   非法 `execution` 被误报成「找不到 Playwright」，把调用方引向装依赖的错误修复方向。已改为**守门前置**
   （参数校验先于能力检查，环境无关），args-check「非法 execution 值」钉零依赖直跑即验，防回归；
3. **执行层缺可选依赖红脸**：CLI 真实交互 / 智能体线端到端 / 真实浏览器矩阵等执行层套件在缺
   `@playwright/cli`/`@playwright/test` 时直接红脸，与纯净包口径（可选依赖由被测项目提供）相悖。
   已改为**三级诚实 SKIP**（整套 / 段内 / 矩阵级），SKIP 计入汇总（「全部通过（N 项断言，M 项 SKIP）」）
   —— 不做假绿也不做假红。

（v1.1.0 重打包复测另修复两个多轮跑才暴露的缺陷：`--filename` 越权守门先于能力检查的顺序钉、
`nl-agent-e2e` 泄漏浏览器会话致打包 `rmSync` EPERM 的 `close-all` 收尾。）

- 浏览器矩阵的「失败」是**被测 demo 的故意缺陷**（签名与开发机基线逐项一致），门禁判据是签名聚合正确，不是全通过
- 本包在中文路径（`发布版本\`）下实测通过——打包前修复了 URL 取 pathname 的百分号编码 bug
  （`发布版本`→`%E5%8F%91%E5%B8%83%E7%89%88%E6%9C%AC`，与 wechat-ai 同类），并以加固 H15 钉死不复发
- 部署副本验证（全树哈希比对 + CLI 配置平台适配语义校验）在本目录布局下 26 项全过
- 文档随包内置「版本记录」与「自然语言使用示例」（README / 使用文档 / 部署说明 / 部署说明.详细版 / SKILL
  五文档同步，加固 H16 机械检查版本号与两节内容不缺项；版本号唯一源 package.json）
- 智能体线边界：LLM 只做规划不做判定；默认本地 Ollama（页面内容不出机），云端须显式开；
  截图与页面快照永不进 LLM 请求；真实资金/破坏性数据/生产/对外发送/批量对外一律开浏览器前拒绝

### web-rpa-mcp（2026-10-03 实测，中文路径发布目录内直接执行）

纯净包零预装依赖，按部署路径先 `cd mcp` 执行 `npm ci --no-audit --no-fund` 命令生成依赖（playwright + playwright-core），
再跑 `node install.mjs --no-skill`（实测：自动生成 `.gitignore`、写默认配置、探测浏览器）与 `node selftest.mjs`：

```
7 套全绿，269 passed / 0 failed（EXIT=0）
unit 63 · rules 27 · mcp-protocol 13 · tools 63 · e2e 32 · integration 71 = 269（audit 覆盖度自检另过）
```

- 真实全链路：录制 → 生成技能 → 回放 → 自愈 → 空结果拦截，含多标签接替场景；44 个 MCP 工具逐个真实调用
- **发布包首跑口径已核验**：全新机器无历史运行记录时自检不误报（演示流程断言按 `totalRuns` 放行），装机后即可直接跑
- 终查包内无 `node_modules`、无任何 `.` 前缀文件/目录（10 项顶层内容，616 KB）。原「验收后手工复原纯净口径」步骤**已删除**——一次性副本口径下验收只在临时副本上跑，`mcp\node_modules\`、`.gitignore`、`web-rpa.config.json`、`.work\`、`runs\`、`logs\` 等生成物随副本一并删除，交付树不需要任何清理动作
- **装机生成物残留定案（2026-10-03）**：交付树里发现过 `web-rpa.config.json` 残留（装机时 `install.mjs`
  「已存在则跳过」生成的默认配置，可能含 Webhook 地址）——已删，并在四家 `distribute.mjs` 与 `copy-pure.mjs`
  的过滤名单机械兜底（`web-rpa.config.json`/`dbmcp.config.json`/`mcp-register.example.json`/`accounts.json`
  一律不随包）。**无 config 复测门禁全绿**：`distribute.mjs --force` 41 文件自校验通过 + 副本内
  `npm ci`/selftest/tools 52 用例/integration 四项全过
  + 终态哈希终查 0 不一致 —— 「装机生成、不随包」契约成立（无配置时验收套件照常全绿）
- **发版门禁（H19 横向）**：`node distribute.mjs --force` 收尾自动「一次性副本验收 + 终态哈希终查」
  （selftest 状态机 / tools 工具面 52 用例 / integration 全链路，退出码 0/3 判过、3 记诚实 SKIP）；
  实测门禁通过 ✅（41 文件自校验 + 四步验收全绿 + 终态哈希 0 不一致）
- **横向验证（一次性副本口径）**：临时副本内 `npm ci`（2 包）+ `install.mjs --no-skill`（写入仅限包内；全局技能安装按旗标跳过，注册只打印）+ `selftest.mjs` 复跑 **7 套全绿 269/0**（unit 63 · rules 27 · mcp-protocol 13 · tools 63 · e2e 32 · integration 71）；上述生成物只出现在副本、验后随副本删除，交付树前后哈希不变（40 文件 `4636351d…`）——一次性副本口径免去「验收后手工复原」这一步
- 版本说明（v1.3.0）落 README「更新记录」与《部署说明.md》/《部署说明.详细版.md》「版本记录」，SKILL.md 同步 269 项计数与 44 工具口径

---

## 更新记录

- **2026-10-09（第 2 次推送）**：根 README 数据刷新至本轮实测——①MCP Skills 表版本号刷到本轮实测（calvin-db-mcp **v1.6.56** / sql-check-script **v1.4.46** / web-rpa-mcp **v1.8.3** / playwright-verify v1.8.17 / wechat-ai v1.1.4 不变）；②工具数刷新（calvin-db-mcp 16 → **18**，含新增 `server_stats` + `reload_config`；web-rpa-mcp 44 不变；playwright-verify 16 不变；wechat-ai 73 不变；sql-check-script 34 项能力不变）；③自检实测数字刷到本轮实测（calvin selftest **380/0**（未初始化口径 361）/ pg-validate **62**（旧 59）；web-rpa 自检 **427/0**（旧 418），单元 121 / 规则 27 / 协议 30 / 工具 65 / 端到端 34 / 集成 138 / 审计 12，覆盖度增加「113 工具参数」口径；sql-check-script 增加 `inspect=` 字段与 25 用例；其他包数字不变）；④目录表与 Skills 表同步；⑤`纯净版本推送-git提示词.md` 同步更新（保留 vs 清空边界明确、API 二次确认流程、「远端看起来仍是旧提交」排障）。
- **2026-10-09（第 1 次推送）**：纯净口径全面收紧 + README 补全——按"严禁：保留 verify-all/selftest 入口"口径，剔除全部**演示/未命名/示例/运行残留/开发自检代码**：①`web-rpa-mcp/flows/` 整体清空（演示 flow `演示-订单日报导出.json`、未命名 flow `未命名流程-*.json`、测试瞬态 `e2e-*.json` / `int-*.json` 全部剔除）；②`web-rpa-mcp/verify/` 目录清空（10 个开发自检脚本 `all.mjs` / `autobot-site.mjs` / `button-sweep.mjs` / `fullchain.mjs` / `gate-preflight.mjs` / `journey.mjs` / `live-fulltest.mjs` / `splice-drop-probe.mjs` / `standalone.mjs` / `ui-ext.mjs`）；③`playwright-verify/mcp/py/` 清空（Python 测试脚本 `read_cases.py` / `validate_ci.py`）；④运行残留：`web-rpa-mcp/logs/` / `runs/` / `playwright-verify/Temp/` / `calvin-db-mcp/export/` 全部清；⑤演示目录：`web-rpa-mcp/demo/` / `wechat-ai/samples/` / `playwright-verify/demo/` / `playwright-verify/generated/` 全部清；⑥**发布入口脚本全部保留**：`selftest.mjs` / `verify.mjs` / `bench.mjs` / `e2e.mjs` / `verify-all.mjs` / `*-validate.mjs` / `*-check.mjs` / `*-test.mjs` / `fixtures/` 等部署说明里明引为"安装后自检/回归/验证"入口的脚本原样保留；⑦`sync-push.sh` 排除规则重写（演示/未命名/示例/运行残留目录 + 单文件模式 + 保留 vs 清空边界明确）；⑧calvin-db-mcp README 补全 18 工具自然语言使用示例（H·运维：`server_stats` + `reload_config` 两行新增；标题与覆盖清单 16→18 同步）。推送链：CalvinMCP `2e8b6b3 → 96b132a`、calvin-mcp `d3d6c21 → 809bf33`。
- **2026-10-06**：版本与数字刷新 + 纯净口径补漏——①版本刷新：calvin-db-mcp v1.6.32 / web-rpa-mcp v1.5.19 / playwright-verify v1.8.17（sql-check-script v1.4.28、wechat-ai v1.1.4 不变）；②自检实测刷新至 2026-10-06：calvin selftest 349/0（未初始化口径 335）+ 六套件全绿（sqlite 83 / mysql 37 / pg 59 / e2e 46 / protocol 24 / realform 43）、web-rpa 自检 418 项全绿 + 覆盖度自检（44 工具 / 21 步骤 / 11 断言 / 26 规则 / 10 CLI 全部有测试，40 配置键全部有接线）、playwright verify-all 13 套件 698 断言（三态判据 517/572/669）+ hardened-check 98/0 + 真实浏览器矩阵 4 签名；③playwright-verify 第 16 个工具 `setup-browser-config` 同步链补齐（工具数 14/15 → 16：测试钉、EXPECTED 清单、README/部署说明/SKILL 工具表与覆盖清单、install 提示文案全对齐，断言数不变）；④**纯净口径补漏**：git 镜像补剔开发机运行残留（`.zcode\`/`.e2e-lab\`/`.github\`/`.playwright-cli\`/`test-results\`/`generated\`/`flows\int-*.json`）、凭据与机器配置（`mcp\dbmcp.config.json` 及其孤儿示例模板）与残留点前缀文件（`web-rpa-mcp\.gitignore`、calvin-mcp 仓初始 `.gitignore`/`.gitee\`）——仓库树全净（无 `.` 前缀文件、无凭据、无运行残留、无测试示例文件）。
- **2026-10-05**：文档重构 + 两仓 README 随推送维护机制——①五包《部署说明.详细版.md》**全量合并进《部署说明.md》并删除详细版**（取最全内容，含全部自然语言使用示例与安装/配置/排障/卸载；完整示例紧随「快速命令索引（速查）」），全包引用（README / SKILL / 测试断言 / 安装器 / CI 注释）同步改指单文档，历史条目按纪律不回填；②五包 README 自然语言速查表重生成（calvin-db-mcp 16 工具 / sql-check-script 34 项能力 / web-rpa-mcp 44 工具 / wechat-ai 73 工具 9 模块 / playwright-verify 14 工具）；③版本刷新：calvin-db-mcp v1.6.25 / sql-check-script v1.4.28 / web-rpa-mcp v1.5.10 / wechat-ai v1.1.4 / playwright-verify v1.8.15；④**本 README 纳入推送流程**：每次纯净版本推送按当轮更新内容刷新两仓根 README（本文件），与代码同提交推送。
- **2026-10-03**：首个发布版本（五包）打包与一次性副本验收全绿——各包实测记录见上文「发布包自验收」各节（文档口径为当日：部署说明双文档、playwright 包旧目录名 `mcp\`）。
