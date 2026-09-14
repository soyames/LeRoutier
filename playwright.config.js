import { defineConfig, devices } from '@playwright/test';

const apps = ['passenger-web', 'driver-web', 'ops-web'];

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: '**/live.spec.js',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 3,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: apps.map((app, index) => ({
    command: `pnpm --filter @leroutier/${app} preview --host 127.0.0.1 --port ${4173 + index} --strictPort`,
    url: `http://127.0.0.1:${4173 + index}`,
    reuseExistingServer: false,
  })),
});
