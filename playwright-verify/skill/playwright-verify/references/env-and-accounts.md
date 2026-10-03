# 环境与账号口径外置

这个文件回答一个判断题：**这次验证跑在哪个环境、用哪个账号？这个答案写在哪里？**

答案：环境清单与账号映射写在 Skill 的口径文件里（外置），**不在同事的提问里，也不在生成的脚本里**。对应 `lint_spec` 的 PW101 / PW107，以及 `check_config` 的 CFG010 / CFG012。

---

## 1. 环境清单

环境清单一句话一个环境，写清「怎么连、用什么身份、允许跑什么」。

```yaml
# references 口径（示意结构，落到 Skill 的配置里，不落进用例代码）
environments:
  test:
    baseURL: https://shop.test.example.com     # 由 BASE_URL 注入，不写进用例
    allowed: true                              # 默认允许
    accounts: [u1, u2]                         # 本环境可用的账号别名
  staging:
    baseURL: https://shop.staging.example.com
    allowed: true
    accounts: [u1]
  prod:
    baseURL: https://shop.example.com
    allowed: false                             # 默认禁止；生产验证走独立审批
```

| 环境 | 用途 | 默认是否允许 | 说明 |
| --- | --- | --- | --- |
| `test` | 日常回归、开发自测 | 允许 | 默认环境；数据可随意造 |
| `staging` | 发布前验证、真数据形状 | 允许 | 只读类场景优先放这里；不造脏数据 |
| `prod` | 生产验证 | **禁止** | 必须走独立审批（见第 5 节） |

---

## 2. 账号映射：写清「哪个账号在哪个环境有效」

账号映射的判据是**可用性**，不是密码。

```yaml
accounts:
  u1:
    label: 普通买家（有历史订单）
    valid_in: [test, staging]
    username_env: PW_U1_USERNAME        # 账号名从环境变量读
    password_env: PW_U1_PASSWORD        # 密码只从环境变量读，绝不落文
  u2:
    label: 新注册用户（空购物车）
    valid_in: [test]
    username_env: PW_U2_USERNAME
    password_env: PW_U2_PASSWORD
```

**为什么必须外置（这是这一篇最重要的理由）**：

同事不会告诉你用哪个账号，**他只说「test 环境」**。因为在他的视角里，「test 环境怎么验证」是你的职责，不是他需要提供的信息。如果你把账号口径留在对话里临时确定，会得到三种必然的坏结果：

1. **每次都要重新问一遍**。同一件事重复沟通，同事开始觉得「找你还不如自己点」。
2. **不同的人给出不同的账号**，于是「同一条场景两个人跑出两个结论」，谁也说不清哪个是对的。
3. **账号失效时无人知晓**。u2 在生产环境根本不存在，但如果没人写清 `valid_in`，你会在生产验证时才发现——那时已经发出了真实请求。

所以账号映射由 **Skill 自己查**：读环境清单 → 按 `valid_in` 过滤出本次可用的账号 → 从环境变量取凭据 → 建立登录态并落到 `.playwright-artifacts/state/<账号>.json` 复用。同事只需要说「test 跑一下下单」，剩下的是口径文件的事。

---

## 3. 凭据只从环境变量读取，绝不写死

```ts
// ✓ 只从环境变量读；缺了就明确失败，不要有默认值
const username = process.env.PW_U1_USERNAME;
const password = process.env.PW_U1_PASSWORD;
if (!username || !password) {
  throw new Error('缺少 PW_U1_USERNAME / PW_U1_PASSWORD，请在 CI 密钥或本地 .env 中配置');
}
```

```ts
// ✗ PW101：凭据写死在用例里，命中即 ERROR，阻断提交
const password = 'Passw0rd!2024';
await page.getByLabel('密码').fill('Passw0rd!2024');
```

```yaml
# ✗ 同样禁止：写死在 SKILL.md、AGENTS.md、示例片段里
# password: Passw0rd!2024
```

**PW101｜疑似凭据写死在用例里（ERROR，阻断）**

- **判据**：出现 `password` / `passwd` / `pwd` / `secret` / `token` / `apiKey` / `api_key` / `accessKey` 后跟 `:` 或 `=` 再跟一个长度 ≥3 的字符串字面量。命中即 ERROR。
- **反例**：见上（`password = 'Passw0rd!2024'`）。
- **评审检查点**：这个值能不能进 git 历史？会 → 立刻改成环境变量读取并轮换该凭据。
- **为什么这么定**：写死的凭据会进 git 历史（即使后来删掉，历史里还在），也会在环境切换时静默失效——test 的密码换了，用例挂在一个看起来像「元素找不到」的错误上，排查方向完全错。`generate_scripts` 在生成阶段同样拒绝：占位符形态的值（`{{password}}`、`${PW}`、`<PASSWORD>`）直接拦下，提示改用 `process.env.PW_PASSWORD`。

---

## 4. `baseURL` 交给配置，用例里不出现环境域名

```ts
// playwright.config.ts
export default defineConfig({
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  },
});
```

```ts
// ✓ 用例里只写相对路径，切环境不用改用例
await page.goto('/checkout');
```

```ts
// ✗ PW107：用例内直接访问生产域名（WARN，人工确认）
await page.goto('https://shop.example.com/checkout');
```

**PW107｜用例内直接访问生产域名（WARN，人工确认）**

- **判据**：出现 `goto('http://…prod…')` / `goto('https://…production…')`，或 `goto('https://www.…')`。报 WARN。
- **评审检查点**：这个域名是生产吗？是 → 立刻删掉，改走 `baseURL`；用例里出现的绝对域名会让「切环境」这件事失效，也会绕过生产保护。
- **为什么是 WARN 而不是 ERROR**：静态扫描认不出所有生产域名（自建域名、IP、带端口的内网地址都可能指向生产）。但它必须被看见，因为默认口径是「只允许 test / staging」（CFG012）。

**CFG010｜未设置 `baseURL`（INFO）**：`baseURL` 交给配置后，用例里只写相对路径，切环境不用改用例；同时也能从机制上避免用例里出现生产域名。这是解决 PW107 的**机制手段**，比在用例里做人工检查可靠。

---

## 5. 默认只允许 test / staging；生产验证走独立审批

**默认口径（硬规则）**：

1. 默认只允许在 `test` / `staging` 上跑。生产是 deny-by-default。
2. 生产验证必须**走独立审批**：单独的一次申请、明确的范围（跑哪几条）、明确的窗口，审批通过后才执行。
3. 生产验证期间不写数据、不点提交类按钮前的确认（下单、支付、退款、删除），只做只读校验或显式允许的场景。
4. 环境由 `BASE_URL` 等环境变量注入，CI 上显式校验它不含 `prod`。

```bash
# CI 上的生产保护（示意）：发现生产域名就直接拒绝
case "$BASE_URL" in
  *prod*|*production*|*www.*) echo "拒绝：BASE_URL 指向生产，生产验证需独立审批"; exit 1 ;;
esac
```

**CFG012｜未见环境开关（生产保护）（INFO）**：配置里没有出现 `process.env.BASE_URL` / `PW_BASE_URL` / `TEST_ENV` / `ALLOW_PROD` 这类环境开关时，`check_config` 会提示把可跑环境锁在 test / staging，并在 CI 上显式拒绝生产域名，避免误触真实交易。

**为什么默认要 deny**：误触生产的代价是不对称的——多跑一次 test 只花几分钟，误跑一次生产可能产生真实订单、真实退款、真实通知。所以门禁的默认方向必须是「不允许」，要跑生产就得有人明确说「这次可以」。

---

## 6. 评审检查点

1. **结论里有没有写明环境和账号**（如「test / u1」）？没写 → 同事无法复核，回译不完整（见 `report-translation.md`）。
2. **账号映射里每个账号有没有 `valid_in`**？没有 → 会在不支持的环境上使用它，而失败现象与账号问题无关。
3. **凭据是不是全部来自环境变量**？出现任何字面量密码 → PW101 阻断，且需轮换该凭据。
4. **用例里有没有绝对环境域名**？有 → PW107，改用 `baseURL`。
5. **`baseURL` 是否由环境变量注入**，且 CI 上有生产域名拒绝逻辑（CFG010 / CFG012）？
6. **跑生产是否走了独立审批**？默认答案是「没有审批就不跑」。
7. **登录态是否落到 `.playwright-artifacts/state/`** 并按账号命名（`u1.json`），供多条用例复用？账号口径与状态文件必须一一对应，避免「用 u1 的登录态跑 u2 的场景」这种静默错配。
