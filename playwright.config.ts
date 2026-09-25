import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:4310',
    browserName: 'chromium',
    launchOptions: process.env.HEXU_TEST_CHROMIUM
      ? { executablePath: process.env.HEXU_TEST_CHROMIUM }
      : {},
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'node scripts/start-e2e.mjs',
    url: 'http://127.0.0.1:4310/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
