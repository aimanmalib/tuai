import { defineConfig, devices } from '@playwright/test';

// The claim page is built and served by `vite preview`; chain reads go to a fake Electrum server inside each test.
const PORT = 4310;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'webkit-iphone13', use: { ...devices['iPhone 13'] } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
