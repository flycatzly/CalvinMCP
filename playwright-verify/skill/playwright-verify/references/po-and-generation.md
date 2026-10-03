# PO 分层与脚本生成

这个文件回答一个判断题：**这段代码该写在哪一层？生成脚本时，模型有多少自由？**

答案：定位与操作写页面层，业务路径写用例层；模型没有自由，它只做填空。对应工具 `generate_scripts`，以及生成门禁（语法检查 + lint ERROR 为 0 才允许写盘）。

---

## 1. 两层分开存

**页面层**：登录页、商品列表、购物车、结算页各自的**定位与操作**。一个页面一个文件，一个动作一个方法。

```ts
// pages/CheckoutPage.ts —— 页面层：只放「定位与操作」，不放业务路径
import { type Page, expect } from '@playwright/test';

export class CheckoutPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** 打开本页面（相对 baseURL，切环境不用改用例）。 */
  async goto(): Promise<void> {
    await this.page.goto('/checkout');
  }

  /** 填入「收货人」。 */
  async fill收货人(): Promise<void> {
    await this.page.getByLabel('收货人').fill('张三');
  }

  /** 点击「提交订单」。 */
  async open提交订单(): Promise<void> {
    await this.page.getByRole('button', { name: '提交订单' }).click();
  }

  /** 断言「订单金额」文本等于「¥99.00」。 */
  async expect订单金额(): Promise<void> {
    await expect(this.page.getByTestId('order-amount')).toHaveText('¥99.00');
  }
}
```

**用例层**：业务路径，对应**一条能回归的场景**。用例层只调用页面层方法，不出现原始定位器。

```ts
// tests/checkout.spec.ts —— 用例层：只写业务路径
import { test } from '@playwright/test';
import { CheckoutPage } from '../pages/CheckoutPage';

test('下单：SKU_A 加购后金额为 ¥99.00', async ({ page }) => {
  const checkoutPage = new CheckoutPage(page);
  await checkoutPage.goto();
  await checkoutPage.fill收货人();
  await checkoutPage.open提交订单();
  await checkoutPage.expect订单金额();
});
```

**分层的唯一收益来源**：**改 UI 只改页面层，用例层不动。** 按钮改名了 → 只改 `CheckoutPage` 里那一行 `getByRole`，几十条用例一个字都不用动。如果定位器散在用例里，同一个改名要改几十处，而且很容易漏掉一处——漏掉的那一处会在半夜变成一条红色。

分层还顺带解决一个门禁问题：断言落在页面层时，用例体里一个 `expect` 都没有。`lint_spec` 的 PW007 会识别「调用了页面对象方法、且那个方法里有断言」并降级为 WARN 交人确认，而不是把每一条用例都冤枉成「没有断言」（详见 `assertion-discipline.md`）。

---

## 2. 不让模型自由写脚本，只让它填空

**取舍的来历（必须写清，这是这条流程被改成现在这样的原因）**：

早期让模型直接产出完整脚本，它**爱用 `page.click('#btn-3')` 这种脆弱选择器**，UI 一改全崩。模型不是不懂 `getByRole` 更好，而是它可以自由发挥——自由发挥时它选的是「当下能跑通的最短路径」，而不是「三个月后还稳定的写法」。选择器策略写在文档里对它没有约束力，因为它可以越过去。

后来改成：

1. **场景拆解先定好每一步的稳定定位描述**（人来定，或者由结构化输入给出）：每一步写明 `{ kind, role/label/testid/text, ... }`。
2. **脚本生成只是把描述翻译成 Playwright API**：`role → getByRole(role, { name })`、`label → getByLabel`、`testid → getByTestId`、`text → getByText`、`placeholder → getByPlaceholder`、`selector → locator(selector)`。
3. **选择器策略被锁死在 `locator-strategy.md` 里，模型越不过去**：生成阶段直接拒绝裸 XPath 与 `nth-child`，没有「这次特殊，先这么写」的余地。

```ts
// 输入是定位描述（稳定契约），不是选择器字符串
{ act: 'click', locator: { kind: 'role', role: 'button', name: '提交订单' } }

// 生成结果是确定性的，不可能跑偏
await page.getByRole('button', { name: '提交订单' }).click();
```

**这个取舍的代价与收益**：代价是多了一步「场景拆解」，人得先把每一步的定位描述写清楚；收益是生成物**可复现、可 diff、不会随时间漂移**——同一份输入永远产出同一份脚本。用「模型少一点自由」换来「选择器策略一定被执行」，这笔交易是划算的，因为脚本生成失败一次的成本远低于一条脆弱定位在半年后集体失效的成本。

---

## 3. `generate_scripts` 的输入结构

```jsonc
{
  "spec": "checkout",                    // 用例文件名（不含 .spec.ts）
  "pages": [
    {
      "name": "结算页",
      "navPath": "/checkout",            // 生成 goto()，相对 baseURL
      "steps": [
        { "act": "fill",  "locator": { "kind": "label", "text": "收货人" }, "value": "张三" },
        { "act": "click", "locator": { "kind": "role", "role": "button", "name": "提交订单" } },
        { "act": "assertText", "locator": { "kind": "testid", "id": "order-amount" }, "expect": "¥99.00" }
      ]
    }
  ],
  "cases": [
    {
      "title": "下单：SKU_A 加购后金额为 ¥99.00",
      "page": "结算页",
      "claims": "提交订单后订单金额为 ¥99.00 且状态为已提交",   // 交付契约：这条用例证明了什么
      "steps": [
        { "act": "goto",  "url": "/checkout" },
        { "act": "fill",  "locator": { "kind": "label", "text": "收货人" }, "value": "张三" },
        { "act": "click", "locator": { "kind": "role", "role": "button", "name": "提交订单" } },
        { "act": "assertText", "locator": { "kind": "testid", "id": "order-amount" }, "expect": "¥99.00" }
      ]
    }
  ]
}
```

### 动作类型（`act`）

`goto` / `fill` / `click` / `check` / `uncheck` / `select` / `press` / `hover` / `assertText` / `assertVisible` / `assertCount` / `waitForResponse`

动作名**大小写与分隔符都不敏感**（`assert_visible` / `assertVisible` / `assertvisible` 等价），因为接口不该逼人猜拼写。传了表外的动作会直接报错并列出可用动作。

### 定位类型（`locator.kind`）

`role` / `label` / `testid` / `text` / `placeholder` / `selector`

`role` 可带 `name`（生成 `getByRole(role, { name })`）；`selector` 只允许用于「后端下发的稳定 id」这类场景，且**裸 XPath 与 `nth-child` 在生成阶段就被拒绝**：

```
拒绝生成脆弱选择器：「//div[3]/span[2]」。裸 XPath 与 nth-child 在生成阶段就被禁止（对应硬规则 1）。
```

### 未解析占位符会被拦下

生成前会检查 `value` / `expect` / `url` 里有没有占位符形态：`${PW}`、`{{password}}`、`<PASSWORD>`、以及整行就是 `TODO`/`TBD`/`FIXME`/`XXX` 的值。命中就拒绝生成：

```
第 2 步（fill）的 value 的值「{{password}}」看起来是未解析的占位符。
生成器不会猜你的意图：请把真实值填进来，或改用环境变量读取
（例如 process.env.PW_PASSWORD）——凭据绝不允许写死在脚本里（硬规则 3）。
```

**为什么必须拦**：把占位符当字面量写进脚本，会**静默产出错代码**——跑起来报的是「元素找不到」，而真正的原因是值根本没填。这类错误最难查，因为它把问题指向了完全错误的方向。

---

## 4. 生成门禁：语法检查 + lint ERROR 0 才允许写盘

**脚本还没跑通就提交，是这条流程里最容易踩的坑。** 任务里那句「先自行验证再保存」是测试规范，不是可选项。

`generate_scripts` 在写盘前跑两道门：

1. **语法门禁**：让 JS 引擎亲自解析一遍生成物（只解析、不执行）。lint 是正则层面的检查，它不会发现「括号没闭合」这类问题。
2. **静态门禁**：对生成物跑 `lint_spec`，**ERROR 必须为 0**（同时统计 WARN 供人确认）。

两者都过才允许写入仓库：

```
生成物通过静态门禁（语法 OK / ERROR 0），可以写入仓库
```

任一不过就阻止写盘，并明确给出原因：

```
生成物未通过门禁（语法错误 1 / ERROR 2），已阻止写盘
生成物有 3 个 ERROR，按门禁不写盘。请先修复规则表里列出的问题。
```

**为什么门禁是硬阻断而不是提示**：生成是批量的，一次生成十几个文件。如果允许「先生成、稍后修」，那么「稍后」永远不会到来，仓库里会积累一批从来没跑通过的脚本。它们不是资产，是负资产——它们让后续每一次全量回归都带着一串已知垃圾噪音，真正的失败会被淹没。

**门禁的一个实现要点（评审时值得知道）**：做这件事之前必须先把**本次生成的页面对象**的方法登记好，否则 PW007 会把「断言写在页面层」的合法生成物判成「用例内没有断言」，把正确代码挡住。**一次冤枉就够把门禁废掉**——人一旦发现门禁在拦正常代码，就会开始绕过它。

---

## 5. 评审检查点（这一篇的总检查点）

1. **用例层里有没有出现原始定位器**（`page.locator(...)`、`page.getBy*(...)`）？有 → 分层破了，挪进页面层。
2. **页面层里有没有业务路径**（跨页面的流程、登录后再下单）？有 → 页面层写宽了，业务路径属于用例层。
3. **每个用例有没有 `claims`（它证明了什么）**？没有 → 交付不合规（见 `assertion-discipline.md` 的交付契约）。
4. **定位描述是否都在级别 1–4 内**？出现 `selector` 时，理由必须是「后端下发的稳定 id」。
5. **生成物有没有通过门禁再入库**？`ERROR 0` 是写盘的前提，不是事后补的指标。
