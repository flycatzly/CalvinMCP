# 等待与同步

这个文件回答一个判断题：**这行等待是在「等一个条件」，还是在「赌一段时间」？**

Playwright 的自动等待已经处理了绝大多数「元素还没出来」的场景。你手写的每一个 `waitForTimeout` 都是在你比 Playwright 更懂页面时才成立的，而那种情况极少。对应工具 `lint_spec` 的 PW001 / PW012 / PW106，以及 `check_config` 的 CFG008。

---

## 1. 允许的三种写法（只有这三种）

### 写法一：等状态变化

等的是「页面上可观测的状态」，Playwright 会自己在超时窗口内轮询，条件成立立刻返回。

```ts
// 等元素可见 / 等 URL 变化 / 等文本出现
await expect(page.getByRole('heading', { name: '订单已提交' })).toBeVisible();
await expect(page).toHaveURL(/\/orders\/\d+\/success/);
await expect(page.getByTestId('order-status')).toHaveText('已提交');
```

### 写法二：等网络条件

等的是「某个请求真的成功返回了」。把 URL 与成功状态一起写进判据，不要让「请求发出去了」冒充「请求成功了」。

```ts
// 先挂等待，再触发动作 —— 顺序反了会漏掉已经返回的响应
const orderResponse = page.waitForResponse(
  (r) => r.url().includes('/api/order') && r.ok(),
);
await page.getByRole('button', { name: '提交订单' }).click();
await orderResponse;
```

### 写法三：等轮询型条件

当条件不是 DOM 状态、也不是某个确定请求，而是「后端异步任务算完了」这类需要反复查询的结论时，用 `expect.poll`。它是唯一被允许的轮询写法，因为它会重试、有超时、失败时报出最后一次实际值。

```ts
await expect
  .poll(async () => {
    const res = await page.request.get('/api/orders/A-1024/status');
    return (await res.json()).state;
  }, { timeout: 15_000 })
  .toBe('SETTLED');
```

---

## 2. 禁止：`await page.waitForTimeout(3000)`

```ts
// ✗ PW001：固定时长等待，命中即 ERROR
await page.waitForTimeout(3000);
await page.locator('#submit').click();
```

同类写法一并禁止：`sleep(3000)`、`delay(1000)`、`pause(数字)` —— 凡是用固定时长拼出来的等待，都是同一个问题。

**为什么禁止。** `waitForTimeout` 的问题不是「慢」，而是**它把问题藏起来**：

- 环境快十倍时，这 3 秒是白等——用例跑得慢，团队开始抱怨回归要一小时。
- 环境慢十倍时，3 秒照样不够，照样失败——等待并没有换来稳定性。
- 它的失败现场永远是「超时」，永远不会告诉你「在等哪个条件」。所以归因时你只能猜：是接口慢了？是按钮改了？是环境抖了？

它换来的唯一东西是「让今天的红色变绿」，代价是**明天的红色失去可诊断性**。用写法一/二/三替换它时，你写下的其实是「这条用例在等什么」——这行字本身就是失败时的归因线索。

---

## 3. 规则逐条：判据 + 反例 + 评审检查点

### PW001｜固定时长等待（ERROR，阻断）

- **判据**：出现 `waitForTimeout(`，或 `sleep/delay/pause` 后跟数字。命中即 ERROR，`lint_spec` 退出码 1。
- **反例**：见上。
- **评审检查点**：把这一行删掉，用例等的是什么？如果你说不出来，说明这条用例缺少一个明确的等待目标——那就先补等待条件，而不是补等待时长。
- **为什么这么定**：这是唯一一条「写了就等于没写测试」的等待。它让用例的成功率与机器性能绑定，无法在 CI 上给出可复现的结论。

### PW012｜`networkidle` 等待（WARN，人工确认）

- **判据**：定位/等待参数里出现 `'networkidle'` 字符串。报 WARN。
- **反例**：

```ts
// ✗ PW012：在长轮询/心跳/埋点上报的页面上永远等不到
await page.waitForLoadState('networkidle');
await page.goto('/dashboard', { waitUntil: 'networkidle' });
```

- **正确写法**：

```ts
// 等页面可观测的状态
await page.goto('/dashboard');
await expect(page.getByRole('heading', { name: '数据看板' })).toBeVisible();

// 或等那个真正关键的请求
await page.waitForResponse((r) => r.url().includes('/api/dashboard/summary') && r.ok());
```

- **评审检查点**：这个页面上有没有定时轮询、WebSocket 心跳、埋点定时上报？有 → `networkidle` 永远等不到（网络永远不会「空闲 500ms」），这不是慢，是逻辑上不可能成立。没有 → 确认清楚它等的到底是哪个请求，并改成等那个请求。
- **为什么是 WARN 而不是 ERROR**：静态扫描无法知道目标页面有没有长连接。有些静态页面上 `networkidle` 确实能成立，一刀切 ERROR 会冤枉它。但**官方已把 `networkidle` 标记为不推荐**，所以它必须被看见、必须被人确认，不能悄悄留在代码里。

### PW106｜空等待：`waitForSelector()` / `waitForLoadState()` 无参（WARN，人工确认）

- **判据**：出现 `waitForSelector()`、`waitForLoadState()`、`waitForFunction()` 空参调用。报 WARN。
- **反例**：

```ts
// ✗ PW106：等的是默认条件，不是你要等的那个条件
await page.waitForSelector();
await page.waitForLoadState();

// ✓ 显式写出等待目标，失败归因才有依据
await page.waitForSelector('[data-testid="order-row"]', { state: 'visible' });
await page.waitForLoadState('domcontentloaded');
```

- **评审检查点**：这行无参调用去掉之后，用例会不会失败？不会 → 它是噪音，删掉。会 → 把真正在等的条件写出来。
- **为什么这么定**：无参调用只是「等默认条件」，它是作者没想清楚在等什么时的占位符。留着它的直接后果是失败信息里看不出等待目标，归因阶段只能靠猜——这正是我们要从等待里拿到的东西。

### CFG008｜`actionTimeout` 必须短于用例 `timeout`（ERROR，阻断）

- **判据**：配置里 `use.actionTimeout >= timeout`。`check_config` 报 ERROR。
- **反例**：

```ts
// ✗ CFG008：actionTimeout 30s >= timeout 30s，操作级超时永远不会先触发
export default defineConfig({
  timeout: 30_000,
  use: { actionTimeout: 30_000 },
});

// ✓ 操作级超时明显更短，先暴露、且直接指向那个元素
export default defineConfig({
  timeout: 30_000,
  use: { actionTimeout: 3_000 },
});
```

- **评审检查点**：`actionTimeout` 缺省为 `0`（不单独限时）。所以第一步是查它有没有被设置（未设置 `check_config` 会报 WARN CFG008）。设了以后，必须确认它比 `timeout` 小——否则等于没配。建议量级差十倍（3s vs 30s）。
- **为什么这么定**：操作级超时和用例级超时是两种完全不同的失败信息。前者说「**这个元素**点不动」，后者说「**整条用例**超时了」。当前者永远不会先触发时，你丢掉的是归因的第一手线索：所有失败都变成「用例超时」，`summarize_report` 只能把它们归到 `timeout` 类，然后你还得人工去猜是哪里卡住了。

### PW013｜把超时放宽到 100 秒以上（WARN，人工确认）

- **判据**：`timeout: 数字` 形态，且**求值后的毫秒数 > 100000**（不是「看起来数字很长」）。报 WARN。
- **反例**：

```ts
// ✗ PW013：放宽超时不是修复，是把「功能坏了」拖延成「跑得很慢」
await page.getByTestId('order-row').waitFor({ timeout: 120_000 });

// ✓ 先定位真正的等待条件，再按实测值定超时
await expect(page.getByTestId('order-row')).toBeVisible({ timeout: 15_000 });
```

- **评审检查点**：这条用例原本为什么超时？如果原因是「页面/接口变慢了」，超时值不是修复方案，它只是让你晚 90 秒才看到红色。超长超时会让所有失败都以「超时」的形式出现，你再也分不清是页面慢了还是功能坏了。
- **为什么判据是「求值 > 100000」而不是数位数**：正则数位数会把合法的 `15_000` 从 `_000` 处截出匹配而误报。**一次冤枉就够把门禁废掉**，所以这条规则必须求值后再判定，而不是看字符串长度。相关的配置侧规则是 CFG002（用例 `timeout` 过长，ERROR）与 CFG009（`expect.timeout` 偏长，WARN）——它们管的是全局基线，PW013 管的是单行写法，两者一起把「超时被当成修复手段」这条路堵住。
