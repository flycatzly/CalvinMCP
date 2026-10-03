# 失败归因：从「看错误栈」到「按规则派活」

这个文件回答一个判断题：**这条失败该谁修？修什么？下一步动作是什么？**

这是整套文档里最重要的一篇。因为前面所有规则都在讨论「怎么写得对」，而这一篇讨论的是失败真的发生时——**你能不能把 6 条失败变成 4 个根因，并且每个根因派给对的人**。对应的工具是 `summarize_report`。

---

## 1. 核心论点：归因不该由模型现场判断，而应该是一条可复现的规则

同一条错误签名出现多少次、属于哪一类、下一步该谁做什么，**全部由脚本给出**，不由模型临场发挥。

原因有三条，每条都来自真实代价：

1. **现场判断不可复现。** 同一个报告，今天问一遍说「产品回归」，明天问一遍可能说「用例缺陷」。派活依据不能是概率。
2. **现场判断不可复核。** 规则写在脚本里，人可以读、可以改、可以加签名（`unknown` 类频繁出现就说明规则需要补一条）。模型的临场判断留不下可审计的痕迹。
3. **现场判断慢且贵。** 逐条读错误栈，6 条失败要二十分钟；而且**很容易把 3 条同源失败当成 3 个 bug，分别派给 3 个人**——三个人查同一个根因，还互相以为对方在查别的。

聚类之后只剩 4 个签名，工作量直接对上「4 个人去查」。这就是 `summarize_report` 的产出形态：先给一句话结论（「N 条失败聚成 M 个根因签名」），再给每个签名的归因、归属方与下一步动作，最后才是明细。

**签名必须吃掉变量部分。** 同源失败之间差的只是路径、行号、引号里的值、数字、URL、耗时、`Call log`。签名生成时把这些归一化掉（`'<s>'`、`<n>`、`<url>`、`<loc>`），并且**判定与签名必须吃同一份清洗后的文本**——先做 ANSI 清洗，再判定、再签名，绝不各自再清洗一次。否则会出现「签名看着正常、归因全歪」：判定正则写 `Error: expect\(`，而真实报告里 `Error:` 与 `expect(` 之间夹着一串 ANSI 控制字符，永远匹配不上，于是三条 `toHaveText` 断言失败全被判成 `timeout`。

---

## 2. 类别表（工具输出的类别 id 与中文名）

`summarize_report` 的类别是「测试侧 vs 产品侧」的主体归因：`locator-strict` / `assertion` / `locator-not-found` / `timeout` 四类，外加一个必须单列的 `env`（环境类），以及 `unknown` 兜底。

### `locator-strict` — 定位器命中多个元素 → 测试侧 / 用例缺陷

- **判据**：错误消息里出现 `strict mode violation` 或 `resolved to N elements`。
- **归因**：测试侧，用例缺陷。
- **下一步**：收紧定位器到唯一命中——给 `getByRole` 补 `name`、scope 到具体容器内（如先定位到那一行 `getByRole('row', { name: '订单 A-1024' })` 再取里面的按钮）；若业务语义确实是「就该有 N 个」，明确断言数量（`toHaveCount` / `assertCount`）。
- **不要做的事**：不要用 `.first()` 掩盖——那只是把不稳定藏起来（对应 PW011）。今天取第一个能过，明天列表倒序就会点错元素，而且**可能仍然通过**，产出一个假绿色。

### `assertion` — 断言未成立 → 产品 或 断言 / 待定

- **判据**：消息里出现 `expect(...).toBeXxx() failed`、`toHaveText(expected) failed`、`Expected:` / `Received:`、`Timed out Nms waiting for expect(`、`waiting for expect(locator)`。
- **归因**：产品回归 或 断言写错，**待定**。
- **下一步**：打开 trace 看页面**实际状态**。
  - 页面确实错了（金额就是 ¥109.00，页面也显示 ¥109.00）→ 产品回归，派给开发。
  - 页面是对的、预期值写错了 → 用例缺陷，修断言。
- **硬约束**：**这一步必须人判，不允许自动放宽断言。** 把断言放宽到能过，和修好定位器，在代码上长得几乎一样；自动「修复」会静默删掉回归保护。
- **为什么这条必须单独一类**：它是唯一一条「可能真的是产品坏了」的类别。把它和其他三类混在一起，会导致两种灾难：要么产品回归被当成测试噪音忽略，要么测试问题被当成产品 bug 派给开发，两边都开始不信任报告。

### `locator-not-found` — 定位器找不到元素 → 测试侧 / 用例缺陷

- **判据**：消息里出现 `waiting for locator(`、`locator(...).click/fill/check/selectOption/hover/innerText/textContent/inputValue/press/dblclick`、`element is not visible`、`element is not attached`。
- **归因**：测试侧，用例缺陷。
- **下一步**：对照 snapshot 检查元素是否**改名 / 改结构 / 未渲染**。优先改用语义定位器，并确认等待条件写对了（等状态而不是等时间）。
- **典型误判**：这类失败最容易被写成「产品没实现」。但先查清是「元素真的没了」还是「你按旧名字找它」——对照 `snapshot` 一眼可辨。

### `timeout` — 操作等待超时 → 待定

- **判据**：消息里出现 `TimeoutError`、`Timeout Nms exceeded`、`exceeded.`、`Test timeout of Nms exceeded`。
- **归因**：待定。
- **下一步**：**先查定位器还能不能命中**——多数「超时」其实是定位器失效（元素改名后 Playwright 一直等一个不存在的元素，直到超时）。再看 trace 里那一步的实际状态。若定位器没问题而页面确实慢，那才是性能问题。
- **为什么先查定位器**：`TimeoutError: locator.click: Timeout 3000ms exceeded.` 这条消息里同时含 `locator(`。如果判定顺序把 `locator-not-found` 排在 `timeout` 前面，它就会被归成「定位器找不到元素」，把「元素存在但不可点/被遮挡」这个真问题藏掉。

### `env` — 环境不可达 → 环境

- **判据**：消息里出现 `net::ERR_*`、`ERR_CONNECTION_REFUSED`、`ERR_NAME_NOT_RESOLVED`、`ERR_INTERNET_DISCONNECTED`、`ERR_CONNECTION_TIMED_OUT`、`ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、`ECONNRESET`。
- **归因**：环境问题。
- **下一步**：先确认环境再谈用例——服务是否启动、`baseURL` 是否指向正确环境、网络/代理是否可用。
- **硬约束**：**这类失败不要派人去查用例。** 环境没通的时候，用例写得再对也全红，派人查用例等于让一个人去证明一件无法证明的事。

### `unknown` — 未归类 → 人工

- **归因**：待判定。
- **下一步**：按原始报错人工判定；若这类失败频繁出现，说明归因规则需要补一条签名（而不是每次都靠人现场猜）。

---

## 3. 两条与归因直接相关的配置基线

归因的准确性还取决于两项配置。它们属于 `check_config`，但列在这里，因为它们直接决定「你看到的失败是真的还是自己造出来的」。

### CFG005｜`retries` 过多会掩盖真实回归（WARN，人工确认）

- **判据**：`retries` 超过基线上限（> 3）时报 WARN；未设置 `retries` 也报 WARN（不重试时偶发失败会混在真实失败里，无法区分「环境抖动」与「产品回归」）。显式写 `0` 是本地开发常见写法，不算问题。
- **反例**：

```ts
// ✗ CFG005：重试 5 次意味着一条真坏的用例也可能某一轮侥幸通过
export default defineConfig({ retries: 5 });

// ✓ 让重试次数只够吸收抖动，不够掩盖回归
export default defineConfig({ retries: process.env.CI ? 2 : 0 });
```

- **评审检查点**：把 `retries` 改成 0 跑一遍，有多少条变红？这些就是「重试在替你遮」的失败。理想值是 1–3 次。
- **为什么这么定**：重试的用途是区分抖动，不是提高通过率。次数一多，`summarize_report` 里的 `flaky` 会吃掉本该是 `unexpected` 的失败——报告变绿了，回归被漏掉了。而漏掉的回归最终会在生产上出现。

### CFG006｜未设置 `workers` 上限会制造环境抖动（WARN，人工确认）

- **判据**：未设置 `workers` 时报 WARN（无法静态判定时给 INFO）。
- **反例**：

```ts
// ✗ CFG006：不设限时 CI 会按 CPU 核数拉满浏览器进程
export default defineConfig({});

// ✓ CI 上明确上限，资源争抢带来的失败就消失了
export default defineConfig({ workers: process.env.CI ? 2 : undefined });
```

- **评审检查点**：这批失败是不是集中在高并发时段、且签名五花八门（同一批用例里既有超时又有元素找不到）？是 → 先怀疑资源争抢，而不是先怀疑代码。
- **为什么这么定**：worker 数不设限时，CI 机器上会按 CPU 核数拉满浏览器进程，资源争抢制造出与代码无关的失败——**这正是 `env` 类与「偶发」类失败的主要来源**。不设上限的后果是归因报告里混进一批永远复现不了的失败，它们会持续消耗团队对红色结果的注意力。

---

## 4. 判定顺序：从最具体到最泛（顺序即优先级）

```
env  →  locator-strict  →  assertion  →  timeout  →  locator-not-found  →  unknown
```

这个顺序不是风格选择，每一条位置都有具体理由：

- **`env` 最先。** `net::ERR_` 是唯一能立刻定性「环境不可达」的信号，绝不能被别的规则吃掉。一旦被吃掉，你会派人去查一个根本没跑起来的用例。
- **`locator-strict` 排在 `assertion` 之前。** 一条 strict mode violation 往往是这样抛出来的：

  ```
  Error: expect(locator).toBeVisible() failed
  Locator: getByText('<s>')
  Error: strict mode violation: … resolved to 3 elements
  ```

  **如果 `assertion` 排在 `locator-strict` 前面**，这条「定位器命中多个元素」会被归成「断言未成立」。后果很具体：真正该修的**定位器缺陷被写成「产品回归」，派给了错的团队**——开发收到一个「页面显示不对」的工单，而页面其实完全正确，只是匹配到了 3 个元素。
- **`assertion` 排在 `timeout` 之前。** 断言失败的消息里常带 `waiting for` / `Timed out Nms waiting for expect(`，不先拦就会被 `timeout` 抢走。
- **`timeout` 排在 `locator-not-found` 之前。** 理由见上：`TimeoutError: locator.click: ...` 同时含 `locator(`，顺序反了就会误归。
- **`locator-not-found` 最后收拢**所有剩余的定位器相关报错。

**一句话记忆：越具体的信号越先判定。** 泛的信号（timeout、locator）覆盖面大，放在前面会把具体的信号吞掉。

---

## 5. 工具输出怎么读（读一遍即完成派活）

```bash
# 跑完回归后：把 JSON 报告变成归因与派活单
node mcp/bin/summarize_report.mjs test-results/report.json
```

```
summarize_report  test-results/report.json
结果: 通过 12 / 失败 6 / 偶发 1 / 跳过 0，共 19 条，耗时 48.2s

按签名聚类：4 个根因

[3 次 · locator-strict] tests/checkout.spec.ts :: Error: strict mode violation: getByText('<s>') …
    归因: 用例缺陷　派给: 测试侧
    下一步: 收紧定位器到唯一命中（加 getByRole 的 name、scope 到容器内）…
    涉及用例: 下单金额正确 | 优惠券折扣 | 订单列表筛选

…

分类汇总:
  定位器命中多个元素（locator-strict）: 3 条失败 / 1 个签名
  断言未成立（assertion）: 2 条失败 / 2 个签名
  环境不可达（env）: 1 条失败 / 1 个签名
```

读法就是派活口径：

- **一行一个根因**，不是一条失败一个人。「3 条失败同源，派 1 人按此签名查」——工作量对齐的是签名数，不是失败数。
- **类别决定归属方**：`locator-strict` / `locator-not-found` → 测试侧；`assertion` → 人判后决定产品还是测试；`timeout` → 待定，先查定位器；`env` → 环境。
- **偶发单独列，不混进失败。** 一条偶发用例会产生「1 次 failed 重试 + 1 次 passed」，混进聚类会同时出现在 `clusters` 和 `flakes` 里，既虚增根因数（6 条失败聚成 4 个签名会变成 5 个），也让「一个签名派一个人」的口径失真。所以 headline 里的失败数用报告的权威口径 `stats.unexpected`，偶发按「环境抖动」单独处理。
- **`unknown` 频繁出现是规则缺口**，不是「今天运气不好」。补一条签名，下一次就自动归好类。

---

## 6. 评审检查点（归因这一步）

1. **失败数**是否用的是报告权威口径，而不是聚类条数？（后者会把偶发也算成失败。）
2. **`assertion` 类**是否有人真的打开 trace 看过页面实际状态？没看就不许决定「修断言」。
3. **`timeout` 类**是否先排除了定位器失效？直接判定「性能问题」是最常见的偷懒。
4. **`env` 类**是否被从用例工单里剔除了？
5. **同一签名下的多条失败**是否只派了一个人？
6. **`unknown` 类**是否已经变成一条新的签名规则？

---

## 7. 为什么这一篇最重要

因为前面七篇是「避免写出坏用例」，而这一篇决定了**坏用例真的失败之后，团队能不能在十分钟内把活派对**。没有它，你会得到：6 条失败逐条读栈二十分钟、3 条同源失败当成 3 个 bug、定位器缺陷派给开发、环境问题派人查用例、断言被自动放宽到能过。这些都是「有测试但没有验收」的典型症状——测试在跑，门禁在响，但没人知道该动哪一行代码。
