import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: /(^|\/)(live\.spec\.js|.*\.live\.spec\.js)$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 3,
  reporter: 'list',
  // Times are rendered in the viewer's locale, so the suite pins a timezone:
  // otherwise every departure assertion depends on where CI happens to run.
  // One retry everywhere: a run right after a full build can hit transient
  // loopback socket exhaustion (ERR_NO_BUFFER_SPACE) on Windows that a single
  // retry absorbs without masking a real product failure.
  use: { trace: 'retain-on-failure', timezoneId: 'UTC', locale: 'fr-FR' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm --filter @leroutier/web preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
