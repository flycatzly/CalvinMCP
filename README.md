# CalvinMCP

MCP 工具与技能集合仓库。纯净发布口径：零预装依赖（依赖由命令生成），不含 `node_modules` 与 `.` 前缀文件，不含任何凭据。

## MCP Skills

| 目录 | 说明 | 版本 |
|---|---|---|
| [calvin-db-mcp/](calvin-db-mcp/) | 多库数据操作 MCP（MySQL / PostgreSQL / OceanBase / SQLite，16 工具 + 分层安全守卫，内置完整 Skill 与部署双文档） | v1.6.2 |
| [sql-check-script/](sql-check-script/) | SQL 全链路质量检测 + 只读数据分析 Skill（依赖同级 calvin-db-mcp，仅只读，含 E2E 测试与部署双文档） | v1.4.2 |
| [web-rpa-mcp/](web-rpa-mcp/) | 网页 RPA 录制/回放 MCP（44 工具 + 269 项自检 + 部署说明双文档；重复网页操作录一遍即生成技能，支持一键/定时复跑） | v1.3.0 |
| [wechat-ai/](wechat-ai/) | 微信个人情报库 + 微信流（Windows 本地只读；MCP 服务器 + 63 个技能工具：索引/信号检测/商机管线/复联雷达/报告生成） | v1.0.1 |
| [playwright-verify/](playwright-verify/) | Playwright 端到端测试「验收 / 门禁 / 执行」MCP + Skill（13 工具：用例验收、失败归因、门禁合入、自然语言测试目标） | v1.1.0 |

## 自检实测（2026-10-03）

- **calvin-db-mcp**：selftest `277 passed`（未初始化口径 263）· sqlite-validate `76 passed` · mysql-validate `29 passed`（真实 MySQL 全工具面）—— 全部 0 failed
- **sql-check-script**：`RUN_ALL selftest=263/0 e2e=46/0 => OK`
- **web-rpa-mcp**：269 项自检 0 failed
- **wechat-ai**：12 套件全部通过（0 failed），`scanPrivacy` 发布视角 0 findings
- **playwright-verify**：12 套件 444 断言（含智能体线 72）+ 真实浏览器矩阵

完整打包与验收记录见 [发布说明.md](发布说明.md)。

## 部署

各 skill 目录自包含（README / SKILL / 部署文档）：

- 含 `install.mjs` 的（calvin-db-mcp / web-rpa-mcp / wechat-ai）：进入目录执行 `node install.mjs`，环境检查 → 自检 → 注册 Claude Code / Claude Desktop / Cursor；依赖由 `npm ci --omit=dev` 命令生成（内网可加 `--registry` 镜像）
- 其余（sql-check-script / playwright-verify）：按目录内部署文档安装；playwright-verify 使用前需 `npm ci`
