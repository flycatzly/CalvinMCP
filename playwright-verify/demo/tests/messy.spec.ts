/**
 * messy.spec.ts — 坏味道样例
 *
 * 职责：**坏味道全中**。断言的是「该报的都报到了」，不是「报得越多越好」。
 * 注意第 3 条用 test.only( 写成 —— 这正是原文缺陷 1 的埋点：
 * 用 test\s*\( 找用例块会让它整块漏扫，里面堆的 XPath / nth-child / force / networkidle 全部安然过关。
 */
import { test, expect } from '@playwright/test';

test('登录流程', async ({ page }) => {
  await page.goto('https://www.example-shop.com/login');
  await page.waitForTimeout(3000);
  await page.locator('//div[@id="app"]/form/input[1]').fill('u1');
  await page.locator('//div[@id="app"]/form/input[2]').fill('P@ssw0rd123');
});

test('列表页第一条可见', async ({ page }) => {
  test.slow();
  await page.goto('/list');
  const row = page.locator('.css-1x2y3z').first();
  await row.click();
  await expect(row).toBeVisible();
});

test.only('下单主流程', async ({ page }) => {
  await page.goto('/order', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.locator('ul.products > li:nth-child(3)').click();
  await page.locator('button.btn-submit').click({ force: true });
  const amount = await page.locator('.amount').innerText();
  expect(amount).toBe('¥99.00');
  // 下面这行是故意注释掉的假代码，不应被当成真断言：
  // await expect(page.getByText('订单已提交')).toBeVisible();
});

test('支付页渲染', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/pay');
  await page.waitForSelector();
  const visible = await page.locator('#pay-panel').isVisible();
  if (!visible) {
    await page.locator('#pay-panel').click();
  }
  await expect(page.getByTestId('pay-total')).toHaveText('¥99.00');
  // 缺 await 的 Playwright 断言（PW006）：这是最危险的写法 ——
  // 断言不会被计入失败，用例会「永远通过」，而它在报告里长得和成功一模一样。
  expect(page.getByTestId('pay-status')).toHaveText('PAID');
  await page.locator('#pay-panel').first().click({ timeout: 300_000 });
});
