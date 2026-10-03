# 断言纪律

这个文件回答一个判断题：**这条用例到底证明了什么？它写出断言了吗？这个断言真的会失败吗？**

没有断言的用例只证明「页面没崩」；没有 `await` 的断言证明「什么都没验证」。两者在报告里都和成功长得一模一样。对应 `lint_spec` 的 PW006 / PW007 / PW008 / PW009。

---

## 1. 断言为什么必须 `await`（PW006）

Playwright 的断言是**异步**的：它内部会在超时窗口内反复重试，直到条件成立或超时。它返回的是一个 Promise。

```ts
// ✗ PW006：断言没 await —— 用例「永远通过」
expect(page.getByText('订单已提交')).toBeVisible();
```

这行代码做了什么？它创建了一个断言 Promise，然后**立刻丢弃了它**。用例不会等它，也不会收到它的失败。测试报告里这一条是绿色，和真正验证通过的结果**一模一样**——这是最危险的写法，因为你在报告里看不出任何异常。

```ts
// ✓ 必须 await：不成立就失败，且失败时给出实际值
await expect(page.getByText('订单已提交')).toBeVisible();
await expect(page).toHaveURL(/\/orders\/\d+\/success/);
await expect(page.getByTestId('order-amount')).toHaveText('¥99.00');
```

### 判据（重要，避免冤枉正常代码）

**只有断言参数是异步来源时，它才是 Promise，才必须 `await`。** 异步来源指：

- `page` / `frame` / `frameLocator` / `context` 直接调用（如 `page.getByRole(...)`）
- 任何 `.locator(...)`、`.getBy*(...)`、`.filter(...)`、`.and(...)`、`.or(...)`、`.first()/.last()/.nth()`、`.waitFor*()`、`.evaluate()`、`.innerText()`、`.inputValue()`

```ts
// ✓ 同步值断言：不 await 是正确的，不该被冤枉
const amount = await page.getByTestId('order-amount').innerText();
expect(amount).toBe('¥99.00');          // amount 已经是 string，同步断言
expect(/^A-\d+$/.test(orderId)).toBe(true);

// ✗ 异步来源，必须 await
expect(page.getByTestId('order-amount')).toHaveText('¥99.00');
```

**为什么这条判据要写准。** 门禁的公信力是它唯一的资产，**一次冤枉就够把门禁废掉**。如果 PW006 把所有不 `await` 的 `expect` 都判成 ERROR，那么每一处正常的同步值断言都会变成红色阻断，团队很快就会学会「关掉这条规则」——于是真正危险的假通过也一起被放过去了。所以 PW006 只在「参数是异步来源」时才成立。

### 规则卡：PW006

- **判据**：`expect(...).toBeXxx(` 形态的 Playwright 断言，所在行没有 `await`，**且**断言参数命中了异步来源模式（`page.`/`frame.`/`context.` 调用，或 `.locator(`/`.getBy*(`/`.filter(` 等异步方法）。命中即 ERROR。
- **反例**：`expect(page.getByText('订单已提交')).toBeVisible();`
- **评审检查点**：这行断言如果永远不成立，用例会红吗？手动把页面改坏、跑一遍——红色就是合格，绿色就是假通过。这是唯一能证明「断言真的在验证」的实验。
- **为什么这么定**：假通过在报告上与真通过不可区分。所有其他规则都在讨论「怎么写得更好」，只有这条在讨论「你写的东西到底有没有生效」。

---

## 2. PW007｜用例内没有任何 `expect` 断言（ERROR，阻断）

- **判据**：一个 `test(...)` 块内（含其调用的页面对象方法，见下）不存在任何 `expect(`。**容器块 `describe` / `test.step` 已排除**。命中即 ERROR。
- **反例**：

```ts
// ✗ PW007：只走了流程，没证明任何事实
test('下单', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByRole('button', { name: '提交订单' }).click();
  await page.waitForResponse((r) => r.url().includes('/api/order'));
});
```

```ts
// ✓ 有明确的业务主张，并有断言支撑
test('下单：金额与状态正确', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByRole('button', { name: '提交订单' }).click();
  await expect(page.getByTestId('order-status')).toHaveText('已提交');
  await expect(page.getByTestId('order-amount')).toHaveText('¥99.00');
});
```

- **评审检查点**：这条用例失败时，你能说出「什么业务事实被证伪了」吗？说不出来 → 它要么补断言，要么降级成 `beforeEach` 里的 setup。
- **为什么排除 `describe` / `test.step`**：**容器当然没有断言，它只是分组。** 如果不排除，每个 `describe` 都会被判成「没有断言」而误报，一个文件里可能一次冤枉十几处。这是「宁漏不误报」原则的直接应用。
- **为什么还要跨文件看页面对象**：当团队采用 PO 分层，断言写在页面层方法里、用例层只写业务路径时，用例体里一个 `expect` 都没有。此时规则的原文判据会冤枉**每一条**用例。`lint_spec` 的做法是：识别「调用了页面对象方法、且那个方法里有断言」，把它降级为 WARN 交人确认，而不是 ERROR 阻断。降级而不是放过的理由：这条链路是跨文件推断，人扫一眼比正则可靠，但也不要悄悄放过。

---

## 3. PW008｜把 Playwright 断言降级成 JS 判断（ERROR，阻断）

- **判据**：出现 `if (!await x.isVisible())`、`if (!await x.isEnabled())` 这类把 `is*()` 布尔方法当真假判断的写法（`isVisible` / `isHidden` / `isEnabled` / `isDisabled` / `isChecked` / `isEditable`）。命中即 ERROR。
- **反例**：

```ts
// ✗ PW008：不成立时静默通过，报告里没有任何失败证据
if (!(await page.getByTestId('banner').isVisible())) {
  await page.getByRole('button', { name: '关闭' }).click();
}
```

```ts
// ✓ 让断言去失败、去重试、去输出实际值
await expect(page.getByTestId('banner')).toBeHidden();
// 或：确实要分支时，分支条件本身也要有可归因的失败路径
```

- **评审检查点**：`isVisible()` 返回 `true/false`，它**不会失败**。请自问：如果元素状态和你的预期相反，这条用例会给出什么证据？答案通常是「什么也不给」——它只是悄悄走了另一条分支。
- **为什么这么定**：`expect(...).toBeVisible()` 与 `isVisible()` 的区别不只是语法糖。前者会重试（对抗时序抖动）、会在失败时打印实际状态、会被 `summarize_report` 归到 `assertion` 类；后者什么都不留。用后者就是主动放弃了失败现场。

---

## 4. PW009｜只用 `toHaveCount` 判存在（WARN，人工确认）

- **判据**：出现 `.toHaveCount(`。报 WARN。
- **反例**：

```ts
// ✗ PW009：只数数量，不校验内容与可见性
await expect(page.getByTestId('order-row')).toHaveCount(1);
```

```ts
// ✓ 断言「这条记录出现在列表里」这个真实主张
await expect(page.getByRole('row', { name: '订单 A-1024' })).toBeVisible();
await expect(page.getByTestId('order-amount')).toHaveText('¥99.00');
```

- **评审检查点**：断言数量时，你真正想证明的是「有 1 条」还是「A-1024 出现在列表里」？若是后者，数量断言是**脆弱且弱**的：数据一旦多出一条，用例红；而如果页面渲染出一条错误数据，数量仍然是 1，用例绿。
- **为什么是 WARN 而不是 ERROR**：数量本身有时就是业务主张（「购物车里只有 1 件商品」）。静态扫描分不清「数量即主张」与「数量冒充存在性」，所以交人确认。

---

## 5. 关于规则编号：PW105 不存在

规则表里没有 PW105，它已废弃。**任何文档、注释、PR 描述里引用 PW105 都是错的**——引用一个不存在的规则号，会让工具输出与人读的结论对不上，排查时会浪费掉一整轮沟通。断言相关的规则就是上面的 PW006 / PW007 / PW008 / PW009 四条，没有第五条。

---

## 6. 交付契约：每条用例必须有一句「它证明了什么」

交付用例时，必须同时给出每条用例的一句话说明，写清它**主张**的业务事实。

```ts
test('用优惠券后订单金额按折后价计算', async ({ page }) => {
  // 主张：使用 COUPON10 后，订单金额从 ¥99.00 变为 ¥89.10，且页面显示折后价
  await expect(page.getByTestId('order-amount')).toHaveText('¥89.10');
});
```

`generate_scripts` 的输入结构里有一个 `claims` 字段，就是这个契约的落地位置；没写时生成物会带上「（未声明 —— 交付时必须补上「这条用例证明了什么」）」的占位提示，而不是让你悄悄跳过。

**为什么这条要求是硬的。** 它逼着写用例的人回到「主张」：

- 写不出主张 → 这条用例本来就不该存在（它是探索脚本，不是回归用例）。
- 主张写得出来但断言没覆盖它 → 立刻暴露「用例名字在骗人」。
- 主张与断言一一对应 → 失败时不需要解读错误栈，直接知道哪条业务事实破了。

报告里的 `Error: expect(received).toBe(expected)` 对同事毫无意义；「他主张优惠券会打折，实测没打」才是可以派活的信息。回译（见 `report-translation.md`）之所以能写出一句人话，前提就是这里有一句主张可回译。
