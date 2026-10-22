import { defineConfig } from "@playwright/test";

const port = process.env.LAYA_E2E_PORT ?? "8081";
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
  throw new Error("LAYA_E2E_PORT must be a port between 1024 and 65535.");

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/setup.ts",
  fullyParallel: false,
  workers: 4,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "ui",
      testMatch: ["ui.spec.ts", "journey.spec.ts", "history.spec.ts", "product-scope.spec.ts", "product-data.spec.ts"],
      fullyParallel: true,
    },
    { name: "laya", testMatch: "laya.spec.ts", timeout: 180_000, workers: 1 },
  ],
});
