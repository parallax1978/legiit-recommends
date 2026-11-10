import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real application in a browser against the local Supabase stack
 * (database, Auth, Cron, Queues, Vault and the Edge Functions). The only simulated part is the
 * provider: the Edge Functions are pointed at tests/support/fake-openai.ts, which never contacts
 * OpenAI. See README → "Testing".
 */
const port = Number(process.env.E2E_PORT ?? 3000);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The journey waits for real scheduled work (cron every 10 seconds, planner every minute).
  timeout: 12 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run fake-openai -- --port 4010",
      url: "http://127.0.0.1:4010/health",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `npm run build && npm run start -- -p ${port}`,
      url: `${baseURL}/sign-in`,
      reuseExistingServer: true,
      timeout: 600_000,
    },
  ],
});
