# web-rpa-mcp — 安装与使用

把重复的网页点击录成技能，之后一键或定时复跑。含内置 MCP 服务器（44 个工具）。

## 一、环境要求

- Windows（定时功能依赖任务计划程序 `schtasks`；录制与回放本身跨平台）
- Node.js >= 18.17（开发机实测 v24）
- 一个可用的浏览器：自带 Chromium、系统 Edge 或 Chrome 任选其一

## 二、安装

```powershell
cd <项目目录>\web-rpa-mcp
node install.mjs
```

安装器会依次完成：
1. 检查 Node 版本
2. 建立 `flows/ runs/ logs/ .work/` 目录，并生成 `.gitignore`（纯净发布包不带 `.` 前缀文件，敏感路径边界由安装器补齐）
3. 生成默认 `web-rpa.config.json`（已存在则跳过）
4. 解析 playwright；缺失时自动 `npm install`（发布包零预装依赖，依赖由此命令生成）
5. 探测可用浏览器并打印实际会用的那个
6. 跑 63 项单元测试（完整 269 项 + 覆盖度自检见"验证"一节）
7. **打印 MCP 注册 JSON**（复制到你的客户端配置）
8. 把 SKILL.md / workflows / references 复制到技能目录

发布包是**纯净分发包**（零预装依赖、不含任何 `.` 前缀文件/目录、不含凭据与生成物）：`mcp/node_modules` 由第 4 步命令生成（也可先 `cd mcp; npm ci` 手工装）。部署完整指引见《部署说明.md》（最短路径）与《部署说明.详细版.md》（配置/安全/排错/升级）。

可选参数：

| 参数 | 作用 |
|---|---|
| `--no-skill` | 不复制到 `~/.claude/skills` 与 `~/.agents/skills` |

## 三、注册 MCP

```json
{
  "mcpServers": {
    "webrpa": {
      "command": "node",
      "args": ["<项目目录>\\web-rpa-mcp\\mcp\\server.mjs"]
    }
  }
}
```

各客户端位置：
- Claude Code：`claude mcp add webrpa -- node "<项目目录>\web-rpa-mcp\mcp\server.mjs"` 或项目 `.mcp.json`
- Claude Desktop：`%APPDATA%\Claude\claude_desktop_config.json`
- Cursor：`~/.cursor/mcp.json`

**注册后必须重启客户端。**

## 四、验证

```powershell
cd <项目目录>\web-rpa-mcp\mcp
node server.mjs --doctor     # 环境自检
node server.mjs --tools      # 列出 44 个工具
node selftest.mjs            # 全链路一键跑：下面 7 套按序执行并给出汇总
node test\unit.mjs           # 63 项单元测试（纯函数/表格各格式/变量/日期偏移/内置变量/参数来源）
node test\rules.mjs          # 27 项静态检查规则（26 条规则逐条构造触发用例）
node test\mcp-protocol.mjs   # 13 项 MCP 协议测试
node test\tools.mjs          # 63 项工具全量实测（44 个工具逐个真实调用）
node test\e2e.mjs            # 32 项端到端测试（会真的开浏览器）
node test\integration.mjs    # 71 项集成测试（全部步骤类型/断言/iframe/hover/串联/凭据/告警/定时/弹窗/锁/留存/profile/CLI）
node test\audit.mjs          # 覆盖度自检：任何"没被测试碰过"的能力都会让它失败
node runner.mjs list         # 已录制的流程
```

日常迭代可只跑一部分：`node selftest.mjs unit e2e` 只跑指定套件；`node test\integration.mjs --group 4,17` 只跑指定组（参数可透传：`node selftest.mjs integration --group 14`）。

端到端测试会启动本地演示站点，真实完成一次「录制 → 生成技能 → 回放 → 自愈 → 空结果拦截」，并覆盖「主录制页被关掉后工作标签页接替」的多标签场景。

## 五、五分钟上手

```
1. doctor                                     确认环境
2. record_start { url: "https://a.example.com" }   打开浏览器
3. （你在浏览器里把日常操作慢一点做一遍）
4. record_stop { name: "订单日报导出" }        生成技能 + 步骤清单
5. flow_lint { flowId: "订单日报导出" }        看有没有要补的
6. flow_run { flowId: "订单日报导出" }         回放
7. schedule_add { flowId: "订单日报导出", at: "09:00" }   定时
8. notify_config { enabled: true, type: "wecom", webhook: "..." }
9. notify_test                                验证告警
```

命令行一键跑：

```powershell
cd <项目目录>\web-rpa-mcp\mcp
node runner.mjs run 订单日报导出 --params 日期=2026-09-30
node runner.mjs run 订单日报导出 --headed          # 需要人工接管验证码时
```

退出码：`0` 成功 / `1` 失败 / `2` 被阻断 / `3` 用法错误。

## 六、配置

`web-rpa.config.json`（合并式覆盖，不需要的字段可以不写）：

```json
{
  "browser": {
    "mode": "auto",
    "channel": null,
    "executablePath": null,
    "headless": true,
    "viewport": { "width": 1440, "height": 900 },
    "locale": "zh-CN",
    "timezoneId": "Asia/Shanghai"
  },
  "run": {
    "stepTimeoutMs": 15000,
    "navTimeoutMs": 45000,
    "retries": 1,
    "saveEvidence": true,
    "evidenceOn": "always",
    "humanHandoffTimeoutMs": 180000,
    "emptyResultGuard": true,
    "healMinScore": 0.72,
    "strictDialogs": true,
    "keepRunsPerFlow": 50,
    "keepRunDays": 30
  },
  "security": {
    "maskFieldsInScreenshots": true
  },
  "notify": {
    "enabled": false,
    "type": "generic",
    "webhook": "",
    "on": ["failure", "healed"]
  },
  "schedule": { "taskPrefix": "WebRPA" }
}
```

用 `config_get` / `config_set` 读写，不必手改文件。

## 六之一、需要登录的系统（登录态复用）

面向"要登录才能用"的内部系统，做法是**人工登录一次、之后长期复用**：

```
profile_login { url: "https://a.example.com/login", successText: "工作台" }
```

它会打开一个可见浏览器让你登录（扫码/短信/账号密码都行），检测到 `successText` 或
`successUrlContains` 就把登录态写进持久化 profile，并自动开启 `browser.persistProfile`。
之后**录制和定时执行都复用这个登录态**，流程里就不必包含登录步骤。

- `profile_info` 查看目录/体积/上次使用时间/是否被占用
- `profile_reset { confirm: true }` 清空登录态（换人换账号、或怀疑串号时用）
- 同一时间只允许一个执行使用该 profile（内部有全局锁，冲突时会明确报"正在被占用"）
- profile 目录 `.work/profile/` 已被 `.gitignore` 屏蔽（装机时生成）——**它等同于一份登录凭据，不要外传**

## 六之二、无人值守日常

上线后只需要看"有没有问题"：

```powershell
cd <项目目录>\web-rpa-mcp\mcp
node runner.mjs status --problems     # 全流程总览；有问题时退出码 1（可直接接告警）
node runner.mjs prune                 # 预演清理历史运行记录
node runner.mjs prune --apply --logs  # 真正清理运行记录与过期日志
```

对应 MCP 工具：`status_report` / `runs_prune` / `lock_status` / `lock_release`。

> `runner status` **在"有问题"时返回退出码 1**（全部正常才返回 0），可以直接接告警；
> `runner prune` 默认只预演，加 `--apply` 才真正删除。

看总览时的三种典型结论：

| 看到 | 含义 | 处理 |
|---|---|---|
| "全部流程最近一次执行正常" | 没事 | 关掉 |
| `interrupted` | 上一次执行被强杀/断电，没正常收尾 | 确认业务是否只做了一半，必要时人工补做 |
| "正在执行中" 但实际没在跑 | 锁没释放（进程被强杀） | `lock_status` 确认后 `lock_release` |

## 七、目录与数据

| 路径 | 内容 | 是否入 git |
|---|---|---|
| `flows/*.json` | 流程定义（技能本体，可版本管理） | 建议入 |
| `runs/` | 每次执行的报告与截图 | 不入 |
| `logs/` | 运行日志、告警日志、定时任务输出 | 不入 |
| `.work/` | 凭据密钥、加密凭据、浏览器故障缓存、定时包装器 | **绝对不入** |
| `web-rpa.config.json` | 配置（可能含 Webhook 地址） | 不入 |

`install.mjs` 装机时会生成 `.gitignore` 保护上述敏感路径（纯净发布包不带任何 `.` 前缀文件，敏感边界由安装器补齐）。

## 八、常见问题

**Q：录制时浏览器窗口没出现？**
A：`doctor` 看 `browser` 字段。若首选浏览器损坏，启动层会自动降级到下一个候选并把失败的记入缓存；也可手工设 `browser.channel="msedge"`。

**Q：一定要下载 Chromium 吗？**
A：不必。系统装了 Edge 或 Chrome 就能用（`browser.mode="auto"` 会自动挑）。Chromium 损坏时执行 `npx playwright install chromium` 重装即可。

**Q：定时任务跑起来是黑窗口一闪而过？**
A：任务计划调用的是 `.work/sched/<flowId>.cmd` 包装器，输出重定向到 `logs/schedule-<flowId>.log`。看那个日志，或用 `schedule_run_now` 手工触发后 `run_history` 查结果。

**Q：能录需要登录的系统吗？**
A：可以，但登录态本身不要录（第二次跑会失效）。做法：录流程时跳过登录，用已登录的持久化 profile 启动（`browser.mode="custom"` + `executablePath` + 持久化 userDataDir），或对登录超时用 `humanHandoff`。

**Q：告警能发到哪？**
A：企业微信、钉钉、飞书、Slack 机器人 Webhook，或任意接受 POST JSON 的地址。`notify_config` 配好后用 `notify_test` 验证。

## 更新记录

- **v1.3.0（2026-10-03）**：44 个 MCP 工具全量实测；新增片段重录 `record_splice_start` 与备份回滚 `flow_restore`（任何改动/删除前自动备份，误删可找回；备份每流程留 10 份、30 天）；录制器多标签修复（主录制页误判、主页面关闭后标签页接替、副标签跳转不误记新标签、尾部 goto 不再误删）；空结果守卫与自愈实测通过；自检 269 项全绿（`node selftest.mjs` 一键跑，支持按套件/按组过滤）；发布口径改为纯净分发包零预装依赖（无 `node_modules`、无 `.` 前缀文件/目录，依赖由命令生成，`.gitignore` 装机时生成），新增《部署说明.md》《部署说明.详细版.md》。
