/**
 * playwright.config.legacy.ts — 反例：一份「能跑但结论不可信」的历史配置
 *
 * 期望体检结果：ERROR 2 / WARN 5 / INFO 3。
 * 两条 ERROR 都不是风格问题，而是「结论会失真」的问题：
 *   - 没有 forbidOnly，.only 随时可能带着一条用例进 CI
 *   - timeout 拉到 300 秒，任何失败都会以「超时」的样子出现
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  timeout: 300_000,
  retries: 5,
  reporter: 'list',
  use: {
    // 没有 baseURL：用例里全是绝对地址，换环境要改用例
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
