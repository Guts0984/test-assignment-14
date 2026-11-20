import { defineConfig } from '@playwright/test';

/** E2E runs against the full compose stack (nginx, two api copies, worker, web). `pnpm stack:up` starts it. */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 3,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:8080', trace: 'retain-on-failure', locale: 'en-US' },
  projects: [
    { name: 'main', testIgnore: /hold-expiry/, use: { browserName: 'chromium' } },
    // Moves the server clock for the whole stack, so it runs alone, after everything else.
    { name: 'clock', testMatch: /hold-expiry/, dependencies: ['main'], use: { browserName: 'chromium' } },
  ],
});
