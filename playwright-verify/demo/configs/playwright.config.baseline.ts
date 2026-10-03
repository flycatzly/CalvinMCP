/**
 * playwright.config.ts — 配置基线
 *
 * 期望体检结果：ERROR 0 / WARN 0 / INFO 0。
 * 这份配置的每一条都不是风格偏好，而是「让结论可信」的前提：
 *   - forbidOnly    没有它，.only 会带着一条用例进 CI
 *   - timeout       太长则所有失败都以「超时」的样子出现
 *   - trace         没有它，失败现场只有一行报错，三类归因无从展开
 *   - reporter json 没有它，失败聚类与派活无法自动化
 *   - actionTimeout 必须短于 timeout，操作级超时才会先暴露
 */
import { defineConfig, devices } from '@playwright/test';

// 环境与账号口径全部外置：换项目只换环境变量与 references，主流程一行不动。
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/report.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 3_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
