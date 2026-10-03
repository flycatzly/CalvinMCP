# Playwright CLI 模式：长流程回归的执行层

这个文件回答一个判断题：**这一步该用 CLI 落盘执行，还是用 MCP 探索？执行结果要不要进上下文？**

`@playwright/cli` 是给 AI 用的命令行执行器。它不是「另一个 Playwright」，而是把**执行结果**从模型上下文里搬出去的那一层。对应 `cli_*` 系列工具（open/snapshot/click/fill/screenshot/trace…），以及 `team-standards.md` 里的 STD002。

---

## 1. 定位：不把庞大 Schema 和可访问性树硬塞模型，而是把结果落盘

CLI 模式的设计取舍只有一句话：**结果落盘，Agent 按需去读。**

- 快照存 YAML / Markdown 文件
- 截图存 PNG 文件
- Trace 存独立文件

Agent 需要「列表里第三条是什么」时，去读那一份快照；不需要的时候，它只是磁盘上的一个文件。这和「把整棵可访问性树回灌进对话」是两种完全不同的成本结构。

### 为什么省 Token（真正贵的不是多写几条用例）

真正贵的不是多写几条用例，而是**把完整页面状态反复灌进模型**：

- 每点一次按钮就回灌一次完整页面状态，旧状态一直累积。上下文里塞满的是**已经过时的页面快照**，后面的断言、截图、失败定位全被挤掉了——长流程最容易在中间「撞墙」，撞墙的原因往往不是模型不会做，而是它已经看不见当前状态。
- 官方基准里，一个标准多步骤会话能冲到 **87000 多 Token**；点一次按钮可能就烧掉几千。
- 换成「快照存 YAML、截图存 PNG、Trace 存独立文件，Agent 按需去读」，同样流程**省下四倍多**，长流程才不容易中途撞墙。

**最小闭环验收**：能开页面、能拿快照、能截图——这三步过了，CLI 就能进测试仓库当执行器。`cli_healthcheck` 就是照这个口径写的，它的结论只有一句：通过 / 未通过（未通过时明确指出是哪一步失败）。

---

## 2. 命令表

下表是常用命令与真实参数的对照。第一列是你在 `cli_*` 工具里用的 `subcommand`，第二列是等价的命令行写法。

| 命令 | 作用 | 命令行形态 | 落盘产物 |
| --- | --- | --- | --- |
| `open <url>` | 打开页面 | `playwright-cli -s=checkout open https://example.com/` | —（`--json` 返回 url） |
| `snapshot` | 拿可访问性快照 | `playwright-cli -s=checkout snapshot --depth=12` | `.playwright-artifacts/snapshots/<session>-<n>.md` |
| `click <ref>` | 点击元素 | `playwright-cli -s=checkout click e8` | — |
| `fill <target> <text>` | 填输入框 | `playwright-cli -s=checkout fill e21 "qa@example.com"` | — |
| `screenshot` | 截图保存本地 | `playwright-cli -s=checkout screenshot` | `.playwright-artifacts/screenshots/<session>-<n>.png` |
| `wait-for <selector>` | 等元素出现 | **真实 CLI 版本里没有这个命令**——见下方替代方案 | — |

### 关于 `wait-for`：真实 CLI 里没有这条命令

`@playwright/cli` 的命令表里**不存在 `wait-for`**。不要写 `playwright-cli wait-for ".order-row"`，它会因为未知子命令而失败（经 `cli_*` 白名单调用时会被直接拒绝：`子命令 xxx 不在白名单内`）。

等元素出现的正确做法是这两条：

```bash
# 替代一：snapshot + 断言 —— 先拿快照，确认目标元素已经出现在快照里（带 ref）
playwright-cli -s=checkout snapshot --depth=12
# 然后按 ref 直接操作；元素不在快照里就说明还没渲染出来，重取一次快照即可

# 替代二：eval —— 需要程序化等待条件时，把判断放进页面里执行
playwright-cli -s=checkout eval "() => !!document.querySelector('[data-testid=order-row]')"
```

在**正式用例**里，等待一律回到 `waiting-and-sync.md` 的三种写法（`expect(...).toBeVisible()` / `waitForResponse` / `expect.poll`）。CLI 模式的定位是**执行与取证**，不是替代用例里的同步逻辑。

---

## 3. 会话隔离、结构化输出与 Ref 编号

### 会话用 `-s=<session>` 隔离

```bash
# 两条流程各自一个会话，互不干扰（多标签、多账号、多环境并行时必用）
playwright-cli -s=checkout open https://shop.test/checkout
playwright-cli -s=admin    open https://shop.test/admin
```

会话名同时决定落盘文件的前缀（`checkout-1.md`、`admin-1.md`），所以**不同流程的证据不会混在一起**。会话名会被清洗（非 `\w.-` 的字符替换为 `_`、截断到 60 字符），避免路径穿越。

### `--json` 拿结构化输出

```bash
playwright-cli -s=checkout --json snapshot
```

需要程序化处理返回值（比如从中取出某个数值做断言）时用 `--json`。`cli_*` 默认透传 `--json`，并把结构化输出一起落到 `.playwright-artifacts/logs/` 下的日志文件里，返回值只给**摘要 + 路径**。

### 快照会给元素分配 Ref 编号

快照里的元素带 `[ref=e8]` 这样的编号：

```yaml
- generic [active] [ref=e1]:
  - heading "订单确认" [level=1] [ref=e2]
  - button "提交订单" [ref=e8]
  - textbox "邮箱" [ref=e21]
```

之后的操作用 Ref 点名即可：

```bash
playwright-cli -s=checkout click e8     # 点「提交订单」
playwright-cli -s=checkout fill e21 "qa@example.com"
```

**这是基于结构解析，不是靠截图认图。** 所以：

- 不用再喂整棵 DOM，一次快照能反复复用——拿到 ref 之后，后续每一步都只是一个短命令加一个编号。
- 编号是**快照时**的页面结构，页面重新渲染后要重取快照再操作；不要跨会话、跨页面复用旧 ref。
- 需要确认元素的隐藏属性（id、class、`data-testid`）时，用 `element-attributes` 的等价手法：`playwright-cli eval "el => el.getAttribute('data-testid')" e8`。
- 快照太大时不要整棵读回来：先 `snapshot --depth=4` 拿骨架，再对某个 ref 取局部快照（`snapshot e34`），或直接搜索快照文件里的文本。这就是「按需去读」的具体操作。

---

## 4. 团队约定

### 调试用 `--headed`，回归默认无头

```bash
# 调试：需要肉眼看页面时显式开有头
playwright-cli -s=debug open https://shop.test/checkout --headed

# 回归：默认无头（不传 --headed）
playwright-cli -s=regression click e8
```

**默认无头是硬约定**，免得有人把有头窗口带进夜间回归——有头模式在无人值守的 CI 上要么起不来，要么拖慢整批、要么留下没人看的窗口。调试完请确认交付的命令行里没有 `--headed`。

### YAML / PNG / Trace 当失败证据进制品库

CLI 产出的三类文件（YAML 快照、PNG 截图、Trace）全部是**失败证据**，随 CI 产物一起归档进制品库：

- 哪一步挂了，打开对应文件就能定位，不用重新跑一遍复现。
- 评审缺陷时直接引用产物路径，不靠口头复述。
- 报告结论里附的截图，就是从 `screenshots/` 里取的那一张（见 `report-translation.md`）。

---

## 5. 什么时候用 CLI、什么时候用 MCP

| 场景 | 用什么 | 理由 |
| --- | --- | --- |
| 探索页面、找元素、确定定位器 | MCP 浏览器工具 | 需要来回试，人工介入多，结果不用长期留 |
| 长流程回归（多步骤、要反复跑） | CLI + Skill，产物落盘 | 把页面状态留在磁盘而不是上下文，省下四倍多 Token |
| 取证（快照/截图/trace） | CLI | 一律落盘，返回值只给路径与摘要 |
| 正式用例执行 | `run_verify`（Playwright test） | 有 report.json 才能聚类归因 |

一句话：**探索用 MCP，回归用 CLI。** 这条约定写进了 `team-standards.md` 的 STD002，`check_standards` 会按关键词校验项目里的 AGENTS.md 有没有覆盖它。
