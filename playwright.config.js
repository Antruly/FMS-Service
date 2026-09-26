// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// 允许把整套用例指向别的实例（隔离实例、灰度机器），与 spec 11 的写法保持一致。
// 不设 FMS_BASE_URL 时行为与之前完全一样。
const BASE_URL = process.env.FMS_BASE_URL || 'http://127.0.0.1:88';

module.exports = defineConfig({
  testDir: './tests/specs',
  fullyParallel: false,  // Tests need sequential execution (shared state)
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,  // Single worker to avoid parallel DB conflicts
  reporter: [
    ['html', { outputFolder: './tests/reports/html', open: 'never' }],
    ['json', { outputFile: './tests/reports/test-results.json' }],
    ['list']
  ],

  globalSetup: './tests/global-setup.js',
  globalTeardown: './tests/global-teardown.js',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
      },
    },
  ],

  // Increase timeout for comprehensive testing
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
});
