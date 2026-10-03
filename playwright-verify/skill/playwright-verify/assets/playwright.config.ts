/**
 * playwright.config.ts — 配置基线模板（复制进项目后用 check_config 验证应为 ERROR 0 / WARN 0 / INFO 0）
 *
 * 每一条都不是风格偏好，而是「让结论可信」的前提：
 *   forbidOnly     没有它，.only 会带着一条用例进 CI，整条流水线只跑一条却报绿
 *   timeout        太长则所有失败都以「超时」的样子出现，分不清页面慢还是功能坏
 *   trace          没有它，失败现场只有一行报错，三类归因根本无从展开
 *   reporter json  没有它，失败聚类与派活无法自动化
 *   actionTimeout  必须明显短于 timeout，操作级超时才会先暴露、直接指向那个元素
 *
 * ⚠ 需要你替换的：baseURL 的环境变量名、testDir、projects。
 */
import { defineConfig, devices } from '@playwright/test';

// 环境与账号口径全部外置：换项目只换环境变量，主流程一行不动。
// 只允许 test / staging；生产验证走独立审批（见 references/env-and-accounts.md）。
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',

  // 用例超时：按「最慢一条用例的实测值 × 2」定，不要超过 60 秒。
  timeout: 30_000,
  // 断言超时：短一点，让断言失败早报，且不容易被误归因成「操作超时」。
  expect: { timeout: 5_000 },

  // 没有这道保险，一个 test.only 就能让流水线只跑一条用例却报绿。
  forbidOnly: IS_CI,
  // 重试用来识别抖动，不是用来掩盖回归：超过 3 次就会把真坏的用例放过。
  retries: process.env.CI ? 2 : 0,
  // worker 不设上限时，CI 机器会按 CPU 核数拉满浏览器进程，
  // 资源争抢制造出与代码无关的失败 —— 这是「环境抖动」类失败的主要来源。
  workers: process.env.CI ? 2 : undefined,

  // 必须有 json：否则 summarize_report 拿不到结构化失败记录，无法自动聚类。
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/report.json' }],
  ],

  use: {
    baseURL: BASE_URL,
    // 必须短于 timeout：否则操作级超时永远不会先触发，等于没配。
    actionTimeout: 3_000,
    // 失败现场证据：trace 给状态与网络，screenshot 给「对应步骤截图」（回译时要附）。
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // 多端按需加：Playwright 跨 Chromium / Firefox / WebKit，同一套用例平移成本很低。
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
