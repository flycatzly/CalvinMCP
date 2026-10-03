# 定位器策略

这个文件回答一个判断题：**这个定位器该不该用？降级顺序是什么？**

只要你在写 Playwright 的 `locator(...)`、`getBy*(...)`、`.first()`，或者评审同事提交的选择器，答案就在这张表里，不需要临场发挥。对应工具 `lint_spec` 的 PW003 / PW004 / PW010 / PW011 四条规则，以及 `generate_scripts` 里对定位描述的翻译逻辑。

---

## 1. 定位器降级表（唯一权威口径）

按稳定性从高到低，只能用表内级别 1–4；级别 5 之后（含表内禁区）一律不得进入用例。

| 级别 | 写法 | 什么时候失效 |
| --- | --- | --- |
| 1 | `getByRole('button', { name })` | 元素没有可访问角色时失效（`div` 假按钮、`role` 被写错、无 `name` 可算） |
| 2 | `getByLabel('邮箱')` | 没有关联 label 时失效（`<label for>` 缺失、placeholder 冒充 label） |
| 3 | `getByTestId('order-submit')` | 前端没加 `data-testid` 时失效 |
| 4 | `getByText('订单已提交')` | 文案随运营改版变化（换一个字、加一个空格、加 emoji 就失配） |
| 禁用 | `.css-1x2y3z`（构建产物类名） | 一次构建就换名字，永远命中不了 |
| 禁用 | `//div[3]/span[2]`（绝对 XPath） | 任何一层结构增删即全废 |
| 禁用 | `:nth-child(n)` 结构定位 | 兄弟节点顺序一变即全废 |

```ts
// 级别 1：可访问角色 + 可访问名字，描述「用户怎么称呼它」
await page.getByRole('button', { name: '提交订单' }).click();

// 级别 2：label 与控件的绑定关系，描述「表单字段的身份」
await page.getByLabel('邮箱').fill('qa@example.com');

// 级别 3：开发者显式承诺的测试契约，描述「前端答应给测试的钩子」
await page.getByTestId('order-submit').click();

// 级别 4：内容本身，描述「页面上写的是什么」
await expect(page.getByText('订单已提交')).toBeVisible();
```

---

## 2. 为什么是这个顺序（比禁令更能说服人的部分）

- **级别 1–3 描述的是「承诺」。** 可访问角色与名字是给用户和屏幕阅读器看的契约，`data-testid` 是前端给测试的显式契约。改版时这些通常被**刻意保留**——改掉它们意味着同时改坏无障碍与测试，成本高、没人愿意干。所以它们稳定。
- **级别 4 描述的是「内容」。** 内容归运营和产品管，今天「订单已提交」明天就是「提交成功，请等待发货」。断言内容不是错，但**用内容当定位锚点**就是把用例的寿命绑在文案排期上。
- **级别 5 之后描述的是「实现」。** 类名由 CSS-in-JS 哈希生成，XPath 与 `nth-child` 记录的是 DOM 的当前位置。前端结构一动，它们全废，而且废得毫无提示：报出来的是「元素找不到」，看起来像环境问题。
- 定位器越靠上，失败时的**归因越干净**：级别 1–3 找不到元素，几乎必然是产品改了契约（真回归）或没按约定加钩子；级别 5 找不到元素，你永远先怀疑自己是不是选错了层级。

这就是 `generate_scripts` 只接受 `role / label / testid / text / placeholder / selector` 这几种定位类型、并在生成阶段直接拒绝裸 XPath 与 `nth-child` 的原因：**策略锁死在文档里，模型越不过去。**

---

## 3. 规则逐条：判据 + 反例 + 评审检查点

### PW003｜绝对 XPath 定位（ERROR，阻断）

- **判据**：`locator()` 的参数以 `//` 或 `xpath=//` 开头（含 `(//` 变体）。命中即 ERROR，`lint_spec` 退出码 1。
- **反例**：

```ts
// ✗ PW003：把 DOM 路径焊死在用例里
await page.locator('//div[3]/span[2]').click();
await page.locator("xpath=//form/div[2]/button").click();
```

- **评审检查点**：这个元素在快照里有没有可访问角色和名字？有 → 用 `getByRole`；有 label → 用 `getByLabel`；什么都没有 → 让前端补 `data-testid`，而不是退回 XPath。
- **为什么这么定**：绝对 XPath 描述的是「第几层第几个」，它不携带任何业务含义。评审时你无法回答「这行代码在验证什么业务事实」，而一条看不懂的定位是没法维护的。

### PW004｜`nth-child` / `nth-of-type` 结构定位（ERROR，阻断）

- **判据**：定位字符串里出现 `nth-child(` 或 `nth-of-type(`。命中即 ERROR。
- **反例**：

```ts
// ✗ PW004：按「第几个兄弟节点」定位
await page.locator('ul > li:nth-child(3)').click();
await page.locator('.row:nth-of-type(2) input').fill('123');
```

- **评审检查点**：如果这里是「列表里的第三条订单」，那真正的定位依据是订单号或商品名，不是位置。位置只是数据的偶然属性，用位置定位等于把「列表中数据的顺序」写成了用例前提。
- **为什么这么定**：`nth-child` 在页面上不承载语义，它只是渲染顺序。增删一个营销 banner、调一次排序规则，用例就红，而业务其实完全正确——这类红色警报会消耗掉团队对回归结果的信任。

### PW010｜CSS 类名或结构选择器（WARN，人工确认）

- **判据**：`locator()` 参数里出现类名（`.foo`）或子代结构符（`>` 接标签名）。报 WARN，不阻断。
- **反例**：

```ts
// ✗ PW010：类名是样式实现，`>` 是布局实现
await page.locator('.btn-primary.css-1x2y3z').click();
await page.locator('#main > div > form button').click();
```

- **评审检查点**：这个类名是构建产物哈希吗（`.css-1x2y3z` 这种）？是 → 必须换掉。是团队手写的语义类（`.order-submit`）→ 在注释里写明「这个类名是团队约定、被视作公共契约」，可以放行。
- **为什么是 WARN 而不是 ERROR**：手写语义类名在部分团队里确实是稳定契约（等同于弱化的 testid）。一刀切 ERROR 会逼着正常代码绕路，而**一次冤枉就够把门禁的公信力废掉**。所以这里交给人确认，不阻断流水线。

### PW011｜`.first()` / `.last()` / `.nth()` 位置收敛（WARN，人工确认）

- **判据**：出现 `.first()`、`.last()`、`.nth(...)`。报 WARN。
- **反例**：

```ts
// ✗ PW011：多匹配就取第一个，把定位器缺陷藏起来
await page.getByRole('button', { name: '删除' }).first().click();

// ✓ 收紧到唯一命中：scope 到那一行，再按名字点名
await page.getByRole('row', { name: '订单 A-1024' })
  .getByRole('button', { name: '删除' })
  .click();
```

- **评审检查点（这条最重要）**：出现位置收敛，说明**定位器本身不唯一**。请先回答「为什么会有多个匹配」——是页面上真有多行同类按钮（那就要 scope 到具体那一行），还是选择器写宽了（那就加 `name`）。回答了这个问题，`.first()` 通常自动消失。
- **为什么这么定**：`.first()` 只是把不确定性推迟到「顺序」上。顺序今天对，明天产品把列表倒序、加一条置顶公告，用例就点错元素——而且它**可能仍然通过**（点到了别的删除按钮，页面也确实变了），于是产出的是一个假绿色。根因是定位器缺陷，不是「多匹配就取第一个」能解决的。确需收敛时，必须在注释里写清「为什么这里的顺序稳定」。
- 相关的收紧手法还有一条：如果业务语义确实是「页面上就该有 3 条」，那就用 `assertCount` / `toHaveCount(3)` 把数量**明确断言**出来，而不是用 `.first()` 把多余匹配咽下去。

### PW005｜`force: true` 绕过可操作性检查（ERROR，阻断）

- **判据**：出现 `force: true`。命中即 ERROR。
- **反例**：

```ts
// ✗ PW005：跳过可见性/稳定性等待，把「元素不可点」掩盖成一次侥幸成功
await page.getByRole('button', { name: '提交订单' }).click({ force: true });

// ✓ 先查为什么不可点：被遮挡就等遮挡物消失，动画未完成就等状态稳定
await expect(page.getByTestId('loading-mask')).toBeHidden();
await page.getByRole('button', { name: '提交订单' }).click();
```

- **评审检查点**：这个元素**为什么**点不动？答「被一个还没消失的遮罩挡住了」→ 那就等遮罩消失；答「动画没跑完」→ 那就等元素稳定；答不出来 → 说明你还没定位到真正的问题，`force` 只是把它藏起来。
- **为什么这么定**：`force: true` 跳过的是 Playwright 为你做的可操作性检查（可见、稳定、能接收事件、未被遮挡）。这四项检查正是「用户能不能点到它」的判据——绕过它们，用例就不再模拟用户，而是模拟一段 JavaScript。它今天侥幸过了，明天会以**更难查的形态**失败（点到了错误的元素、或者什么也没发生但用例是绿的）。

### PW014｜`:visible` 旧写法（WARN，人工确认）

- **判据**：定位字符串里出现 `:visible`。报 WARN。
- **反例**：

```ts
// ✗ PW014：旧伪类写法，在新版本上行为不一致
await page.locator('button:visible').click();

// ✓ 用 locator.visible()（Playwright 1.63 起取代 :visible 伪类）
await page.locator('button').filter({ visible: true }).click();
```

- **评审检查点**：项目里的 Playwright 版本是多少？≥1.63 → 换成 `visible()` 系列写法，旧伪类在新版本上行为不一致，会产出「本地能过、CI 挂了」这类最难归因的差异。
- **为什么是 WARN 而不是 ERROR**：旧写法在部分版本与场景下仍然可用，静态扫描无法确知运行版本。但它必须被看见——版本升级时它会静默改变语义，而语义变化型的失败恰恰是最贵的。
