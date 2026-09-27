import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the real stack: Next.js (3000) -> Express API (4000) -> Postgres/Redis/ES
 * -> BullMQ worker -> Ethereal SMTP. Start the backend (API + worker) first.
 * Google login itself can't be automated, so global-setup signs a session for a
 * dedicated e2e user with the backend's SESSION_SECRET (see e2e/global-setup.ts).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3000',
    storageState: 'e2e/.auth/state.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
