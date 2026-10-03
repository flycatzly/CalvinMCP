# 步骤 DSL、断言与变量参考

流程定义就是一个 JSON 文件，落在 `flows/<id>.json`，可以直接纳入 git 做版本管理。

## 一、流程对象

```json
{
  "id": "订单日报导出",
  "name": "订单日报导出",
  "version": 1,
  "startUrl": "https://a.example.com/report",
  "params": [
    { "name": "单号", "label": "订单号", "source": "excel:D:/data/orders.xlsx#单号@0", "required": true }
  ],
  "steps": [ /* 见下 */ ],
  "assertions": [ /* 流程级断言，跑完统一执行 */ ],
  "emptyResultOk": false,
  "recording": { "sessionId": "rec-1a2b3c4d", "notes": [] }
}
```

| 字段 | 说明 |
|---|---|
| `startUrl` | 起始地址（`flow_preflight` 与报告里都会用到） |
| `params` | 变量声明，步骤里用 `${名字}` 引用 |
| `steps` | 顺序执行的步骤 |
| `assertions` | 流程级断言，在最后一步之后执行 |
| `emptyResultOk` | 置 true 可豁免「空结果守卫」（该流程确实允许空结果时才用） |

## 二、步骤类型（op）

| op | 字段 | 说明 |
|---|---|---|
| `goto` | `url`, `waitUntil`, `newTab`, `navTimeoutMs` | 打开网址；`newTab:true` 开新标签页 |
| `click` | `locators`, `frame`, `nth`, `button`, `waitForNav`, `expectDownload`, `expectDialog`, `saveAs`, `optional`, `timeoutMs` | 点击；`waitForNav` 等页面加载完；`expectDownload` 等下载；`expectDialog { accept }` 该点击会弹窗并指定接受/取消 |
| `clickAndDownload` | 同 `click` | 语义等价于 `click + expectDownload` |
| `fill` | `locators`, `value`, `clear`, `pressEnter`, `sensitive`, `timeoutMs` | 填值；`clear:true` 先清空 |
| `select` | `locators`, `value` 或 `label` | 下拉选择 |
| `check` | `locators`, `checked` | 勾选；`checked:false` 取消勾选 |
| `press` | `locators`, `key`, `waitForNav` | 按键，默认 Enter |
| `setInputFiles` | `locators`, `path` | 上传文件；**path 必须手工补**（浏览器不允许读取真实路径） |
| `hover` | `locators` | 悬停 |
| `scrollIntoView` | `locators` | 滚动到可见 |
| `waitFor` | `locators` 或 `text`, `state`, `timeoutMs` | 等待元素/文字；`state` 可为 visible/hidden/attached/detached |
| `waitForText` | `text`, `timeoutMs`, `state` | 等待文字出现 |
| `humanHandoff` | `reason`, `timeoutMs`, `resumeWhenText`, `resumeWhenTextGone`, `resumeUrlContains` | 交给人操作（验证码/登录）；无恢复条件时等固定时长后放行 |
| `screenshot` | `name`, `fullPage` | 留证截图 |
| `extract` | `locators`, `as`, `attr`, `multiple` | 取值，供断言或串联使用 |
| `download` | `saveAs`, `optional` | 声明此前的下载产物；可选步骤可跳过 |
| `assert` | 见断言类型 | 内联断言 |
| `chain` | `flow`, `params`, `continueOnError` | 串联执行另一个流程 |
| `sleep` | `ms` | 固定等待（尽量用 `waitFor` 代替） |
| `scrollTo` | `to`("bottom"/"top"), `times`, `waitMs`, 或 `locators` | 滚动页面；`times` 用于无限滚动列表反复触底加载；给了 `locators` 则滚动到该元素 |
| `dialog` | `accept`, `promptText` | 为**下一个动作**设定浏览器弹窗的处理方式；一般不需要手写，录制时自动挂在触发它的 click 上 |

## 三、定位符（locators）

每一步都存**一组**候选定位符，按稳定性排序；回放时依次尝试，全失败才启用指纹自愈。

```json
{
  "locators": [
    { "strategy": "testid", "value": "exportBtn" },
    { "strategy": "role", "value": "button", "name": "导出", "exact": true },
    { "strategy": "text", "value": "导出", "exact": true },
    { "strategy": "css", "value": "#tbl + form > button" }
  ],
  "fingerprint": { "tag": "button", "name": "导出", "text": "导出", "attrs": {}, "classes": [], "path": [] },
  "frame": [ { "strategy": "css", "value": "iframe#report" } ]
}
```

| strategy | 对应 Playwright API | 稳定性 |
|---|---|---|
| `testid` | `getByTestId` | 最高（data-testid / data-test / data-cy / data-qa） |
| `role` | `getByRole(role, {name})` | 高（可访问性语义） |
| `label` | `getByLabel` | 高（表单控件） |
| `placeholder` | `getByPlaceholder` | 中 |
| `name` | `locator('[name=...]')` | 中（表单控件） |
| `text` | `getByText` | 中（文案变了就失效） |
| `alt` / `title` | `getByAltText` / `getByTitle` | 中 |
| `css` | `locator(css)` | 低（`:nth-of-type` / 构建哈希类名尤其脆弱） |
| `xpath` | `locator('xpath=...')` | 最低（仅兜底） |

### 指纹自愈

所有候选定位符失效时，用 `fingerprint` 在同类元素里打分（标签 0.10 / 角色 0.10 / 可访问名 0.25 / 文本 0.15 / 属性 0.15 / 类名 0.10 / 祖先路径 0.08 / 相邻文本 0.07），取最高分且不低于 `run.healMinScore`（默认 0.72）者。命中后：
1. 报告里记一条 `healed`（含置信度与歧义标记）
2. 把新定位符**回写进流程文件**，下次直接命中（`flowSelfPatched: true`）

## 四、断言类型

| kind | 字段 | 通过条件 |
|---|---|---|
| `tableNotEmpty` | `selector`, `min` | **有效数据行** >= min 且页面无空状态提示（占位行如 `<td colspan>暂无数据</td>` 不计入） |
| `listNotEmpty` | `selector`, `min` | 同上，用于列表 |
| `textPresent` | `text`, `exact` | 文字可见 |
| `textAbsent` | `text` | 文字不存在 |
| `elementVisible` | `locators` 或 `selector` | 元素可见 |
| `elementAbsent` | `locators` / `selector` / `text` | 元素数量为 0 |
| `url` | `contains` / `equals` / `regex` | 当前 URL 匹配 |
| `title` | `contains` / `equals` / `regex` | 页面标题匹配 |
| `download` | `minBytes`, `minLines` | 存在下载文件且字节数达标；`minLines` 为**非空文本行数（含表头）**，只对 csv/tsv/txt/json/md 生效。录制时会自动推断成 2（表头 + ≥1 行数据），专门拦「只有表头的空报表」 |
| `extracted` | `as`, `equals` / `matches` | 与 `extract` 取到的值比对；不传 equals/matches 时只要求非空 |
| `noErrorBanner` | — | 没有常见错误提示元素 |
| `emptyResultGuard` | — | 系统自动追加；空结果时判失败 |
| `noUnexpectedDialog` | — | 系统自动追加；出现**流程未处理**的浏览器弹窗时判失败（confirm 被静默取消＝操作没生效）。可用 `run.strictDialogs=false` 降级为提示 |

## 四之二、iframe（内嵌页面）

企业后台大量用 iframe 套页面。本工具在录制与回放两侧都支持：

- **录制**：注入脚本在每个 frame 里都会运行，点在内层页面上的元素会被记录，并自动带上从外层到内层的 iframe 选择器链：
  ```json
  { "op": "click", "locators": [{ "strategy": "testid", "value": "innerBtn" }],
    "frame": [{ "strategy": "css", "value": "#innerFrame" }] }
  ```
- **回放**：先 `frameLocator` 逐层进入，再定位元素。
- **断言**：
  - `textPresent` / `textAbsent` 默认**扫描主页 + 所有子框架**（iframe 里渲染的结果页也能断言到）；
    若断言上写了 `frame`，则只在该框架内查找。
  - `tableNotEmpty` / `listNotEmpty` 跨所有框架统计真实数据行。
  - `elementVisible` / `elementAbsent` 支持 `locators` / `selector` / `text` 三种写法，
    也可用 `frame` 指定框架。
- 跨域 iframe 无法读取 DOM，会在录制提醒与预检结果里体现，需要人工确认。

## 四之三、hover 揭层的菜单

不少后台的下拉菜单是纯 CSS `:hover` 揭出来的（`#menu:hover ~ #panel{display:block}`）。
录制器会在**文档就绪时采一次"空闲态可见元素"基线**，
当被点击的元素**本身及其祖先容器都不在基线里**时，说明它整块是被 hover 揭出来的，
于是自动在点击前补一步 `hover`（悬停到最近一次把菜单揭出来的触发元素）。

诊断钩子（页面内可用）：

- `window.__rpa.hoverDecision(el)` — 解释某元素为什么（没）补 hover
- `window.__rpa.rebaselineHover()` — SPA 二次渲染后手工重建基线

## 五、变量

### 内置变量（无需声明）

| 变量 | 输出 |
|---|---|
| `${today}` | `2026-10-03` |
| `${today:YYYYMMDD}` | `20261003` |
| `${today:YYYY年MM月DD日}` | `2026年10月03日` |
| `${yesterday:YYYY-MM-DD}` / `${tomorrow:...}` | 昨天 / 明天 |
| `${now}` | `2026-10-03 09:00:00` |
| `${now:YYYYMMDDHHmmss}` | `20261003090000` |
| `${time}` / `${date}` | 时分秒 / 日期 |
| `${daystart}` / `${dayend}` | 当天 00:00:00 / 23:59:59 |
| `${monthstart}` / `${yeartoday}` | 月初 / 年初 |
| `${today-7:YYYYMMDD}` / `${today+1}` | **日期偏移**：任意日期型变量都可加 `±N` 天（today/now/date/yesterday/tomorrow…），覆盖"上周同期""明天"这类口径 |
| `${timestamp}` | 毫秒时间戳 |
| `${uuid}` | 随机 UUID |
| `${random}` / `${random:8}` | 6 位 / 指定位数随机数字 |
| `${root}` | 项目根目录 |
| `${env:变量名}` | 环境变量 |
| `${osuser}` | 当前系统用户名 |

### 参数来源（flow_param_add 的 source）

| source | 说明 |
|---|---|
| 不写 + 有 default | 常量 |
| `const` / `default` | 取 `default` 值 |
| `env:名字` | 环境变量 |
| `secret:名字` | 加密凭据（`secret_set` 写入） |
| `file:路径` | 文件内容（trim） |
| `excel:路径#列@行` | 表格取值，列支持 名称/A 字母/1 基序号，行支持 `0`、`n`、`*`（整列换行拼接） |
| `csv:` / `table:` / `xlsx:` | 同 `excel:` |

支持的文件格式：`.xlsx .csv .tsv .txt .json`（xlsx 为内置零依赖解析器）。
表头规则：`.xlsx/.csv/.tsv` **默认第一行为表头**；`.txt`（逐行文本）与**标量 JSON 数组**被视为**无表头**，所有行都是数据（列名用 `值` 或列序号引用）；JSON 对象数组用对象的键作为表头。
| `prompt` | 运行时必填，由人提供；缺失则**阻断执行** |
| `flow:流程id:键` | 串联时取上一流程的 `extract` 结果 |

参数值里可以再嵌模板，支持互相引用（例如 `tag` 的默认值为 `T-${d}`）。

## 六、执行报告结构

```json
{
  "flowId": "订单日报导出",
  "stamp": "20261003-090000-123",
  "status": "pass | fail | blocked",
  "trigger": "manual | schedule | cli | chain",
  "durationMs": 958,
  "params": { "单号": "SO100123" },
  "steps": [ { "index": 1, "op": "goto", "status": "pass", "ms": 210, "detail": "...", "healed": null } ],
  "assertions": [ { "kind": "tableNotEmpty", "pass": true, "detail": "共 3 行，有效数据行 3" } ],
  "healed": [ { "step": 7, "from": "css", "to": "heal:fingerprint", "confidence": 1 } ],
  "emptyGuard": { "suspicious": false, "reason": null },
  "screenshots": [ ".../screenshots/99-final.png" ],
  "downloads": [ { "name": "orders.csv", "path": "...", "size": 135 } ],
  "failedStep": null,
  "error": null,
  "reportPath": "runs/订单日报导出/20261003-090000-123/report.json"
}
```

## 七、静态检查规则

| 编号 | 级别 | 含义 |
|---|---|---|
| L000 | 阻断 | 流程没有任何步骤 |
| L001 | 阻断 | 缺少起始地址且首步不是 goto |
| L002 | 阻断 | goto 指向的不是网页地址（edge:// chrome:// about: devtools:// 等浏览器内置页） |
| L010 | 阻断 | 没有任何结果校验（可用 `emptyResultOk`/断言解决） |
| L020 | 阻断 | 页面存在验证码却没有人工作接管步骤 |
| L021 | 阻断 | 录到了短信/动态验证码输入 |
| L022 | 警告 | 密码以明文写在流程里 |
| L030 | 阻断 | 引用了未声明的变量 |
| L031 | 警告 | 必填参数既无默认值也无来源 |
| L040 | 阻断 | 步骤缺少定位符 |
| L041 | 警告 | 只有 text/css/xpath，缺稳定定位策略 |
| L042 | 警告 | CSS 含构建产物随机类名 |
| L043 | 提示 | XPath 依赖位置序号 |
| L050 | 警告 | 日期写死了 |
| L060 | 警告 | 提交类点击后面没有等待/校验 |
| L061 | 警告 | 连续两次点击同一个提交按钮（可能重复提交） |
| L070 | 警告 | 点击了疑似破坏性操作 |
| L080 | 警告 | 下载步骤没有保存路径 |
| L081 | 提示 | 点击会触发下载，建议指定 saveAs |
| L090 | 警告 | 填入空值 |
| L091 | 阻断 | 上传文件步骤缺少本地路径 |
| L023 | 警告 | 参数来源是 `env:`——任务计划程序下的环境变量可能与手工执行不同 |
| L025 | 提示 | 该点击会弹出浏览器弹窗，提醒确认"接受/取消"的语义是否与业务一致 |
| L100 | 阻断 | 未知断言类型 |
| L110 | 警告 | 流程会导出/取数但没有「结果非空」校验 |
| L120 | 提示 | 没有显式截图步骤（回放会自动补末尾截图） |

阻断级问题会让 `flow_run` **拒绝执行**（除非显式 `allowLintErrors: true`）。

## 八、留存与并发（无人值守相关）

| 配置 / 机制 | 默认 | 说明 |
|---|---|---|
| `run.keepRunsPerFlow` | 50 | 每流程最多保留多少次运行记录；收尾时自动清理 |
| `run.keepRunDays` | 30 | 运行记录最多保留多少天 |
| 两者同时生效时 | — | 保留最新 50 次；**超出部分还需"超过 30 天"才删**（不失控也不误删近期） |
| 只设次数（keepRunDays=0） | — | 保留最新 N 次，其余全删 |
| 只设天龄（keepRunsPerFlow=0） | — | 保留 N 天内，其余全删 |
| `run.strictDialogs` | true | 出现未处理弹窗时判失败 |
| `security.maskFieldsInScreenshots` | true | 截图前给 `input[type=password]` / `[data-rpa-mask]` 打码 |
| 并发锁 | 自动 | 锁文件在 `.work/locks/<flowId>.lock`，含 pid；超过 6 小时或进程已死视为过期并自动清理 |
| 中断标记 | 自动 | 执行开始写 `runs/<flowId>/<stamp>/running.json`，正常收尾删除；残留即 `interrupted` |
| `browser.persistProfile` | false | 复用持久化用户目录（`profile_login` 会自动开启）；登录一次长期复用 |
| `browser.profileDir` | `.work/profile` | profile 目录位置 |
| profile 全局锁 | 自动 | 同一时间只允许一个执行使用该 profile（`.work/locks/__profile__.lock`） |

**配置撤销**：`config_set` 里把某项设为 `null` 表示"删除该键、恢复默认"
（例如 `{"browser":{"channel":null}}` 即回到自动选择浏览器）。
不这样处理的话，像 `channel` / `userAgent` / `webhook` 一旦设置就再也改不回去。
