/**
 * page-object-template.ts — 页面对象骨架（复制后改）
 *
 * 页面层只放「定位与操作」，不放业务路径与业务断言的理由：
 *   改 UI 只改这一层，用例层不动 —— 这是 PO 分层唯一的收益来源。
 *
 * 注意：assert* 这类「结构可见性」断言可以放页面层（它是页面契约的一部分），
 * 但「业务结论」的断言（金额是不是 99 元）留在用例层，或者用 claims 写清楚。
 *
 * 生成器：generate_scripts 会按这个结构生成页面层与用例层，并带生成门禁
 * （语法检查 + lint ERROR 0 才允许写盘）。
 */
import { type Page, expect } from '@playwright/test';

export class ExamplePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** 打开本页面：用相对路径，切环境只换 baseURL，用例一行不动。 */
  async goto(): Promise<void> {
    await this.page.goto('/example');
  }

  /** 操作命名用「动作 + 元素语义」，不要用「第几个」。 */
  async fillAccount(value: string): Promise<void> {
    // 稳定契约优先：role > label > testid > text；不用裸 XPath / nth-child / CSS 类名
    await this.page.getByLabel('账号').fill(value);
  }

  async submit(): Promise<void> {
    await this.page.getByRole('button', { name: '提交' }).click();
  }

  /** 结构可见性断言放在页面层是可以的：它描述页面契约，不是业务结论。 */
  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: '示例页面' })).toBeVisible();
  }

  /** 等网络条件时，把「在等什么」写进方法名与注释里。 */
  async waitForSubmitResponse(): Promise<void> {
    await this.page.waitForResponse((r) => r.url().includes('/api/example') && r.ok());
  }

  /**
   * 涉及凭据时只从环境变量读，绝不写死：
   *   const password = process.env.PW_PASSWORD;
   *   if (!password) throw new Error('缺少 PW_PASSWORD 环境变量');
   * 缺了环境变量要明确失败，而不是回退到某个默认密码 —— 那样会在错误的账号上跑出「通过」。
   */
}
