import { defineConfig, devices } from "@playwright/test";

const port = 3100;

export default defineConfig({
  testDir: "./tests/e2e",
  // Holds the cross-runner cleanup gate; its returned teardown cleans fixtures once, after every worker (run-gate.ts).
  globalSetup: "./tests/support/e2e-global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    // Phone viewport first: the owner works mobile-first (product.md).
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://localhost:${port}`,
    // Auth.js builds redirects from AUTH_URL; point it at the test server (shell env wins over .env.local).
    env: { AUTH_URL: `http://localhost:${port}` },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
