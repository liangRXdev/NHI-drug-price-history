import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.mjs',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8765',
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',          // 現行價依瀏覽器本地日期判定：固定時區使日期可重現
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/server.mjs',
    url: 'http://127.0.0.1:8765/index.html',
    reuseExistingServer: !process.env.CI,
  },
});
