import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:18789";
const AUTH_TOKEN = "a9f8a71b54f12e07cc00ad56a17a2d66";

test.describe("OpenClaw Frontend", () => {
  test.beforeEach(async ({ page }) => {
    // Set auth token in localStorage before each test
    await page.goto(BASE_URL);
    await page.evaluate((token) => {
      localStorage.setItem("apiKey", token);
    }, AUTH_TOKEN);
  });

  test("homepage loads correctly", async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page).toHaveTitle(/OpenClaw/);
  });

  test("navigation to Settings works", async ({ page }) => {
    await page.goto(BASE_URL);
    
    // Click on settings nav item
    const settingsNav = page.locator('[data-page="settings"]').first();
    await expect(settingsNav).toBeVisible();
    await settingsNav.click();
    
    // Verify settings page content
    await expect(page.locator("#apiKeyInput")).toBeVisible();
    await expect(page.locator("#wsStatus")).toBeVisible();
  });

  test("theme toggle works", async ({ page }) => {
    await page.goto(BASE_URL);
    
    // Navigate to settings
    const settingsNav = page.locator('[data-page="settings"]').first();
    await settingsNav.click();
    
    // Set dark theme
    await page.evaluate(() => {
      localStorage.setItem("theme", "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: "theme" }));
    });
    
    // Verify dark mode attribute on html element
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("API Keys page loads with auth", async ({ page }) => {
    await page.goto(BASE_URL);
    
    // Navigate to settings
    const settingsNav = page.locator('[data-page="settings"]').first();
    await settingsNav.click();
    
    // Verify API key list is visible (id is apiKeyList not apiKeyManager)
    await expect(page.locator("#apiKeyList")).toBeVisible();
  });

  test("chat page works", async ({ page }) => {
    await page.goto(BASE_URL);
    
    // Navigate to chat
    const chatNav = page.locator('[data-page="chat"]').first();
    await chatNav.click();
    
    // Verify chat elements (id is chatMsgs not chatMessages)
    await expect(page.locator("#chatMsgs")).toBeVisible();
    await expect(page.locator("#chatInput")).toBeVisible();
  });

  test("dashboard shows stats", async ({ page }) => {
    await page.goto(BASE_URL);
    
    // Navigate to dashboard
    const dashboardNav = page.locator('[data-page="dashboard"]').first();
    await dashboardNav.click();
    
    // Verify dashboard content (contains 系统 + 状态, could be 运行中 or 异常)
    await expect(page.locator("#pageContent")).toContainText("系统");
    await expect(page.locator("#pageContent")).toContainText("状态");
  });

  test("all navigation items work", async ({ page }) => {
    await page.goto(BASE_URL);
    
    const pages = ["dashboard", "chat", "search", "vault", "agents", "code", "settings"];
    
    for (const pageName of pages) {
      const nav = page.locator(`[data-page="${pageName}"]`).first();
      await expect(nav).toBeVisible();
      await nav.click();
      
      // Verify page content loaded
      const content = page.locator("#pageContent");
      await expect(content).not.toBeEmpty();
    }
  });
});
