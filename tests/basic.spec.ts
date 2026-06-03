import { test, expect } from "@playwright/test";

test("basic test", async ({ page }) => {
  await page.goto("http://localhost:18789");
  await expect(page).toHaveTitle(/OpenClaw/);
});