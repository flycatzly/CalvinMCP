/**
 * 本文件由 playwright-verify-mcp 的 generate_scripts 生成。
 *
 * 页面层：只放「定位与操作」，不放业务路径。
 * 改 UI 只改这一层，用例层不动 —— 这是 PO 分层唯一的收益来源。
 */
import { type Page, expect } from '@playwright/test';


export class AppPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** 打开本页面（相对 baseURL，切环境不用改用例）。 */
  async goto(): Promise<void> {
    await this.page.goto("http://127.0.0.1:58523/");
  }

  /** 填入「账号」。 */
  async fillElemYuxvj(): Promise<void> {
    await this.page.getByLabel('账号').fill("demo_user");
  }

  /** 填入「密码」。 */
  async fillElem1aph6(): Promise<void> {
    await this.page.getByLabel('密码').fill("demo_pass");
  }

  /** 点击「登录」。 */
  async openElem1yggx(): Promise<void> {
    await this.page.getByRole('button', { name: '登录' }).click();
  }

  /** 断言「user-menu」可见。 */
  async expectVisibleUserMenu(): Promise<void> {
    await expect(this.page.getByTestId('user-menu')).toBeVisible();
  }

}
