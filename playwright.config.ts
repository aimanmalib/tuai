import { defineConfig, devices } from '@playwright/test';

// Two modes. By default the claim page is built and served by `vite preview`, and chain reads go to a fake Electrum
// server inside each test. With E2E_BASE_URL set, only the read-only live checks run, against that deployed URL.
const PORT = 4310;
const live = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: live ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: live ?? `http://127.0.0.1:${PORT}` },
  ...(live
    ? { testMatch: 'live.spec.ts' }
    : {
        testIgnore: 'live.spec.ts',
        webServer: {
          command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
          url: `http://127.0.0.1:${PORT}/`,
          timeout: 120_000,
          reuseExistingServer: false,
        },
      }),
  projects: [
    { name: 'webkit-iphone13', use: { ...devices['iPhone 13'] } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
