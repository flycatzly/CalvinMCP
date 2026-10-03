/**
 * tricky.spec.ts — 误报陷阱样例
 *
 * 职责：**证明宁漏不误报**。这份文件里所有「看起来违规」的东西都不是真违规：
 *   - 注释里的假代码（等了 3 秒、用了 XPath、用了 .only）
 *   - 字符串里的假断言名
 *   - 模板串里的花括号
 *   - 多行 await expect
 *   - 正则字面量里的花括号与斜杠
 *   - describe 容器（自己没断言，不该被判「没有断言的用例」）
 *
 * 期望：ERROR 0 / WARN 0。
 * 它必须常驻：门禁的公信力是它唯一的资产，一次冤枉就够把它废掉。
 */
import { test, expect } from '@playwright/test';

// 这条注释里写着 await page.waitForTimeout(9999); 和 page.locator('//div[3]/span[2]')，都不该被当真。
/* 块注释里也有：
   await page.waitForTimeout(5000);
   await page.locator('//html/body/div[1]').click({ force: true });
*/

test.describe('误报陷阱容器', () => {
  test('多行断言与模板串', async ({ page }) => {
    await page.goto('/trap/one');

    const label = '订单状态';
    // 多行 await expect：检测必须跨行仍然认出 await
    await expect(
      page.getByRole('cell', { name: label })
    ).toHaveText('已结算');

    // 模板串里带花括号，并且插值里再嵌一层模板串
    const selectorText = `订单 ${label} ${{ a: 1 }.a} ${`嵌套`}`;
    expect(selectorText).toContain('订单');

    // 字符串里出现断言名与等待函数名，都不是真调用
    const decoy = 'expect(x).toBeVisible() 和 waitForTimeout(1000) 都是字符串内容';
    expect(decoy).toContain('expect');
  });

  test('正则字面量与容器块', async ({ page }) => {
    await page.goto('/trap/two');

    // 正则字面量里的花括号与斜杠，不能把回调体的花括号配平搞乱
    const pathRe = /^\/orders\/\d{4}\/\{id\}$/;
    expect(pathRe.test('/orders/2026/{id}')).toBe(true);

    // 转义引号与反斜杠
    const escaped = 'it\'s a \\ backslash';
    expect(escaped).toContain('backslash');

    await expect(page.getByTestId('trap-two')).toBeVisible();
  });

  test('forEach 生成的多条断言', async ({ page }) => {
    await page.goto('/trap/three');
    for (const name of ['甲', '乙', '丙']) {
      await expect(page.getByRole('listitem', { name })).toBeVisible();
    }
  });
});

test.describe('只有容器的分组', () => {
  test.describe('嵌套容器', () => {
    test.skip(true, 'ISSUE-123 等待接口修复'); // 带理由的跳过：这是被允许的
  });
});
