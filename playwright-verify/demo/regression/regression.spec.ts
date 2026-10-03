/**
 * regression.spec.ts — 可离线复现的演示回归（8 条用例口径：2 通过 / 6 失败 / 1 偶发）
 *
 * 为什么要自己造页面：
 *   用例全部用 page.setContent() 现场造页面，不依赖任何外部服务 —— 离线也能跑。
 *   能离线复现，意味着这套检查可以随 Skill 一起分发，别人拉下来就能验证，不需要先搭一套环境。
 *
 * 失败按签名铺开，用来验证 summarize_report 的聚类与归因：
 *   3 条 toHaveText 断言失败  → assertion（聚成 1 个签名）
 *   1 条 strict mode violation → locator-strict
 *   1 条操作超时              → timeout
 *   1 条环境不可达            → env
 *   合计 6 条失败 → 4 个根因签名
 */
import { test, expect } from '@playwright/test';

const page1 = `<!doctype html><html lang="zh"><body>
  <h1>订单中心</h1>
  <div data-testid="order-amount">¥100.00</div>
  <button role="button">提交</button>
</body></html>`;

const listPage = `<!doctype html><html lang="zh"><body>
  <h1>通知列表</h1>
  <ul><li>验证码</li><li>验证码</li><li>验证码</li></ul>
</body></html>`;

/* ---------------- 通过 ---------------- */

test('页面标题渲染正确', async ({ page }) => {
  await page.setContent(page1);
  await expect(page.getByRole('heading', { name: '订单中心' })).toBeVisible();
});

test('按钮可点击', async ({ page }) => {
  await page.setContent(page1);
  await expect(page.getByRole('button', { name: '提交' })).toBeEnabled();
});

/* ---------------- 断言失败 ×3（同一签名） ---------------- */

test('订单金额等于 99 元', async ({ page }) => {
  await page.setContent(page1);
  await expect(page.getByTestId('order-amount')).toHaveText('¥99.00');
});

test('订单金额等于 98 元', async ({ page }) => {
  await page.setContent(page1);
  await expect(page.getByTestId('order-amount')).toHaveText('¥98.00');
});

test('订单金额等于 97 元', async ({ page }) => {
  await page.setContent(page1);
  await expect(page.getByTestId('order-amount')).toHaveText('¥97.00');
});

/* ---------------- 定位器命中多个元素 ---------------- */

test('列表项断言命中多个元素', async ({ page }) => {
  await page.setContent(listPage);
  // 三个 li 文本相同 → getByText 解析出多个元素 → strict mode violation
  await expect(page.getByText('验证码')).toBeVisible();
});

/* ---------------- 操作等待超时 ---------------- */

test('点击不存在的结算按钮', async ({ page }) => {
  await page.setContent(page1);
  // 元素不存在，操作级超时（actionTimeout 压到 3 秒）先暴露，
  // 而不是被整条用例超时盖住 —— 这样失败信息才能直接指向那一步。
  await page.locator('#checkout-does-not-exist').click();
});

/* ---------------- 环境不可达 ---------------- */

test('访问未启动的服务', async ({ page }) => {
  await page.goto('http://127.0.0.1:59999/health');
});

/* ---------------- 偶发：首次失败、重试通过 ---------------- */

test('偶发用例（首次失败，重试通过）', async ({ page }, testInfo) => {
  await page.setContent(page1);
  // 只在第一次尝试时失败 → Playwright 标记为 flaky，不计入 unexpected。
  // 这是用来验证归因工具「偶发不吃进失败聚类」的钉子。
  if (testInfo.retry === 0) {
    expect.soft('首次尝试失败').toBe('重试后通过');
  }
  await expect(page.getByRole('heading', { name: '订单中心' })).toBeVisible();
});
