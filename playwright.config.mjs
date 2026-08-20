import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://localhost:18789",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  // 后端生命周期由 scripts/run-e2e.cjs 统一管理（健康检查 + 必要时自动拉起），
  // 避免 Playwright webServer 在端口被复用时的 EADDRINUSE 抖动。
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
