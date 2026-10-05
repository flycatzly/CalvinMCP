import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './generated/tests',
  timeout: 15000,
  expect: { timeout: 5000 },
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:58523', trace: 'retain-on-failure' },
});
