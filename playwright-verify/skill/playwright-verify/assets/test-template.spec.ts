/**
 * test-template.spec.ts — 用例骨架（复制后改）
 *
 * 骨架已经把门禁要求内建进去，所以照着写不会踩坑：
 *   · 定位只用 role / label / testid（不用裸 XPath、nth-child、CSS 类名）
 *   · 等待等状态或等网络，不等时间
 *   · 断言都 await，且每条用例至少有一条断言
 *   · 每条用例开头写明「本用例证明什么」
 *
 * 写完用：node scripts/lint_spec.mjs tests/
 */
import { test, expect } from '@playwright/test';
// PO 分层时改成从页面层导入（见 page-object-template.ts）：
// import { LoginPage } from '../pages/LoginPage';

test.describe('模块名', () => {
  test.beforeEach(async ({ page }) => {
    // 只做「回到起点」，不放业务断言（否则失败会指向 beforeEach，掩盖真正的用例问题）。
    await page.goto('/');
  });

  test('场景名：一句话说清业务动作与预期', async ({ page }) => {
    // 本用例证明：<填写「这条用例证明了什么」—— 交付契约要求的一句话>

    // 1) 定位用语义定位器（稳定契约）：role > label > testid > text
    await page.getByLabel('账号').fill(process.env.PW_USER ?? 'u1');
    await page.getByRole('button', { name: '登录' }).click();

    // 2) 等「状态」而不是等时间：环境快十倍不会白等，慢十倍也不会莫名失败
    await expect(page.getByTestId('user-menu')).toBeVisible();

    // 3) 断言必须 await：参数是 async 来源时它返回 Promise，
    //    不 await 就不会被计入失败，用例会「永远通过」——最危险的写法。
    await expect(page.getByTestId('order-amount')).toHaveText('¥99.00');
  });

  test('需要等的网络条件：等响应而不是等 networkidle', async ({ page }) => {
    // 本用例证明：提交订单后后端返回结算成功
    const responsePromise = page.waitForResponse((r) => r.url().includes('/api/order') && r.ok());
    await page.getByRole('button', { name: '提交订单' }).click();
    await responsePromise;

    // 轮询型条件用 expect.poll，而不是 sleep 之后再断言
    await expect.poll(async () => {
      const res = await page.request.get('/api/order/A1001');
      return (await res.json()).status;
    }, { timeout: 15_000 }).toBe('SETTLED');
  });
});

/*
 * 门禁会拦下的写法（别写，写了也会挡住合入）：
 *   await page.waitForTimeout(3000);                     // PW001 固定时长等待
 *   test.only('...', ...)                                // PW002 .only 泄漏
 *   page.locator('//div[@id="app"]/form/input[1]')        // PW003 绝对 XPath
 *   page.locator('ul > li:nth-child(3)')                  // PW004 nth-child 结构定位
 *   locator.click({ force: true })                        // PW005 绕过可操作性检查
 *   expect(page.getByText('x')).toBeVisible();            // PW006 缺 await（假通过）
 *   test('x', async () => { await page.goto('/'); })      // PW007 用例内没有断言
 *   if (!await x.isVisible()) { ... }                     // PW008 断言降级成 JS 判断
 *   page.locator('.css-1x2y3z')                           // PW010 CSS 类名定位
 *   page.getByText('验证码').first()                       // PW011 位置收敛（定位器缺陷）
 *   page.goto('/x', { waitUntil: 'networkidle' })          // PW012 networkidle
 */
