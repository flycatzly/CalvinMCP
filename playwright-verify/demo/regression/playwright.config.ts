/**
 * playwright.config.ts — 演示回归专用配置
 *
 * 两个刻意的设计：
 *  1) actionTimeout 压到 3 秒（短于用例超时 15 秒）：让「操作超时」先暴露，
 *     而不是被整条用例超时盖住。这正是配置体检 CFG008 想守住的东西。
 *  2) json reporter 的 outputFile 用 path.resolve(__dirname, ...) 写绝对路径：
 *     Playwright 会把相对路径按**配置文件所在目录**解析（testDir 同理），
 *     写成 './demo/test-results/report.json' 会变成 demo/regression/demo/test-results/…，
 *     报告就不在预期位置了。绝对路径让产物位置可预期，便于 CI 收集。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './',
  timeout: 15_000,
  expect: { timeout: 2_000 },
  retries: 1,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: path.resolve(HERE, '../test-results/report.json') }],
  ],
  use: {
    actionTimeout: 3_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
