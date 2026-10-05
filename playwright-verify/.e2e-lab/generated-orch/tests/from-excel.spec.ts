/**
 * 本文件由 playwright-verify-mcp 的 generate_scripts 生成。
 *
 * 用例层：只放业务路径与断言主张，不放定位细节。
 * 改 UI 只改页面层，本文件不动 —— 这是 PO 分层的收益所在。
 */
import { test, expect } from '@playwright/test';
import { AppPage } from '../pages/AppPage';

test("TC-201", async ({ page }) => {
  // 本用例证明：TC-201：看到 用户菜单
  const appPage = new AppPage(page);
  await appPage.goto();

  await appPage.fillElemYuxvj();
  await appPage.fillElem1aph6();
  await appPage.openElem1yggx();
  await appPage.expectVisibleUserMenu();
});
