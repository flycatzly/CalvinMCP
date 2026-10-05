/**
 * 本文件由 playwright-verify-mcp 的 generate_scripts 生成。
 *
 * 用例层：只放业务路径与断言主张，不放定位细节。
 * 改 UI 只改页面层，本文件不动 —— 这是 PO 分层的收益所在。
 */
import { test, expect } from '@playwright/test';
import { DemoStationPage } from '../pages/DemoStationPage';

test("登录后出现用户菜单", async ({ page }) => {
  // 本用例证明：证明提交登录后用户菜单对用户可见（可见性契约）
  const demoStationPage = new DemoStationPage(page);
  await demoStationPage.goto();

  await demoStationPage.fillElemYuxvj();
  await demoStationPage.fillElem1aph6();
  await demoStationPage.openLoginSubmit();
  await expect(page.getByTestId('user-menu')).toBeVisible();
});
