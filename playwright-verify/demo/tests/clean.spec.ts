/**
 * clean.spec.ts — 合格样例
 *
 * 职责：**证明门禁不冤枉人**。
 * 合格写法必须零 ERROR、零 WARN；这里每报出一条，都是规则误报。
 */
import { test, expect } from '@playwright/test';

test.describe('通知设置', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings/notifications');
    await expect(page.getByRole('heading', { name: '通知设置' })).toBeVisible();
  });

  test('保存开关后提示成功', async ({ page }) => {
    const saveButton = page.getByRole('button', { name: '保存' });
    await saveButton.click();
    await expect(page.getByRole('status', { name: '保存成功' })).toBeVisible();
  });

  test('校验邮箱格式不合法时的错误提示', async ({ page }) => {
    await page.getByLabel('接收邮箱').fill('not-an-email');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('邮箱格式不正确')).toBeVisible();
  });
});

test.describe('订单', () => {
  test('提交订单后状态变为已结算', async ({ page, request }) => {
    await page.goto('/orders/new');
    await page.getByTestId('order-submit').click();

    await expect(page.getByText('订单已提交')).toBeVisible();
    await page.waitForResponse((r) => r.url().includes('/api/order') && r.ok());

    await expect.poll(async () => {
      const res = await request.get('/api/order/A1001');
      return (await res.json()).status;
    }, { timeout: 15_000 }).toBe('SETTLED');
  });
});
