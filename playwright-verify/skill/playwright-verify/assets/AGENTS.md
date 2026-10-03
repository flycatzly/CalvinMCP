# 测试规范（无论做什么任务都要遵守）

以下四条是硬要求，不随任务类型变化。评审时按这四条对照。

## STD001 证据落盘到约定目录

快照、截图、trace、日志、报告一律落到 `.playwright-artifacts/` 的约定子目录，不散在临时路径。

```
.playwright-artifacts/
├── snapshots/      快照（markdown，按需读，不要整棵进上下文）
├── screenshots/    截图（png，回译时要附给同事）
├── traces/         trace（失败现场：DOM 快照 + 网络 + 每步）
├── logs/           执行日志（stdout/stderr 重定向产物）
├── reports/        机器可读报告（json）
└── state/          登录态（按账号命名，禁止提交进仓库）
```

理由：散在临时路径的证据，评审时找不到；进不了制品库，也就等于没有。

## STD002 回归默认走 CLI + Skill，MCP 只留做探索

长流程回归用 `playwright-cli` 落盘执行（快照/截图/trace 写文件，Agent 按需读）；
浏览器 MCP 工具只用于探索与定位，不用于跑完整回归。

理由：把完整页面状态反复灌进模型会烧掉大量 Token（官方基准里一个多步骤会话可到 87000+），
后面的断言与失败定位会被挤掉。换成落盘执行，同样流程省下四倍多。

**调试用 `--headed`，回归默认无头** —— 免得有头窗口被带进夜间回归。

## STD003 脚本必须先验证通过再保存

生成的用例必须先过静态门禁（`lint_spec` ERROR 0）并实际跑通，才允许写入仓库。

```bash
node scripts/check_config.mjs playwright.config.ts   # 跑之前：配置是否可信
node scripts/lint_spec.mjs tests/                    # 合入前：ERROR 必须为 0
node scripts/run_verify.mjs --cwd . --config playwright.config.ts
```

理由：脚本还没跑通就提交，是这条流程里最容易踩的坑。
「先自行验证再保存」是测试规范，不是可选项。

## STD004 快照、截图、脚本都进制品库

CI 产物包含快照、截图、trace 与脚本；评审缺陷时直接引用产物，不靠口头复述。

理由：哪一步挂了，打开对应文件就能定位，不用重新跑一遍复现。

---

## 命令入口

```bash
# 跑之前：配置基线是否可信（放最前面，因为它错的时候后面全是白干）
node scripts/check_config.mjs playwright.config.ts

# 合入前：用例静态扫描，ERROR 必须为 0
node scripts/lint_spec.mjs tests/

# 跑之后：失败归因与派活
node scripts/summarize_report.mjs test-results/report.json

# 团队规范自检（少了哪条会明确列出来）
node scripts/check_standards.mjs
```

## 边界（写清楚，同事才知道什么时候该停手找人）

- 不替代测试分析：工具只验证你描述的场景，覆盖该不该有、断言对不对，还是人的事。
- 断言要人审：自动生成的预期值第一次必须人工核对来源。**猜出来的预期，跑通也是假的。**
- 凭据不进脚本：账号密码走环境变量 / 密钥管理。
- UI 大改仍要维护：定位约定是「当前页面结构」的投影，页面重构后要同步更新。
- 不在生产环境盲跑：默认只允许 test / staging，生产验证走独立审批。
