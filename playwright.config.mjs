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
  webServer: {
    // 直接启动后端（自托管 public/ 静态产物），本地复用已有实例
    command: "bun run src/main.ts",
    cwd: ".",
    url: "http://127.0.0.1:18789/health",
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      AXIOM_AUTH_TOKEN: process.env.AXIOM_AUTH_TOKEN || "your-secure-random-token-at-least-16-chars",
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
