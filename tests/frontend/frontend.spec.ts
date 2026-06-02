import { test, expect } from "@playwright/test";

const AUTH_TOKEN = "a9f8a71b54f12e07cc00ad56a17a2d66";

test.describe("OpenClaw Frontend", () => {
  test.beforeEach(async ({ page }) => {
    // Set auth token in localStorage before each test
    await page.addInitScript((token) => {
      localStorage.setItem("apiKey", token);
    }, AUTH_TOKEN);
  });

  test("homepage loads and shows dashboard", async ({ page }) => {
    await page.goto("/");
    // Wait for SPA to mount
    await page.waitForSelector("#pageContent", { timeout: 5000 });
    // Dashboard should be visible by default
    await expect(page.locator("#pageContent")).toContainText("Dashboard");
    await expect(page.locator("#pageContent")).toContainText("Vault");
  });

  test("navigation works for all pages", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#pageContent", { timeout: 5000 });

    const pages = ["chat", "search", "vault", "agents", "code", "settings"];
    for (const pageName of pages) {
      // Click nav item
      await page.click(`.nav-item[data-page="${pageName}"]`);
      // Wait for content to update
      await page.waitForTimeout(300);
      // Check that page content changed
      const content = await page.locator("#pageContent").textContent();
      expect(content?.toLowerCase()).toContain(pageName);
    }
  });

  test("settings page shows API key input", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#pageContent", { timeout: 5000 });
    
    // Navigate to settings
    await page.click(".nav-item[data-page='settings']");
    await page.waitForTimeout(300);
    
    // Check for API key input
    await expect(page.locator("#apiKeyInput")).toBeVisible();
    await expect(page.locator("#wsStatus")).toBeVisible();
  });

  test("theme toggle works", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#pageContent", { timeout: 5000 });
    
    // Navigate to settings
    await page.click(".nav-item[data-page='settings']");
    await page.waitForTimeout(300);
    
    // Test dark mode
    await page.evaluate(() => {
      localStorage.setItem("theme", "dark");
      (window as any).setTheme("dark");
    });
    
    // Check if dark mode is applied
    const isDark = await page.evaluate(() => document.body.classList.contains("dark"));
    expect(isDark).toBe(true);
  });

  test("API keys page loads with auth", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#pageContent", { timeout: 5000 });
    
    // Navigate to settings
    await page.click(".nav-item[data-page='settings']");
    await page.waitForTimeout(300);
    
    // API key manager should be visible
    await expect(page.locator("#apiKeyManager")).toBeVisible();
    
    // Should show provider list
    const providers = ["MiniMax", "DeepSeek", "OpenAI", "Google", "Anthropic", "Moonshot", "01.AI", "XAI", "Cohere"];
    for (const provider of providers) {
      await expect(page.locator("#apiKeyManager")).toContainText(provider);
    }
  });

  test("mobile responsive layout", async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await page.waitForSelector("#pageContent", { timeout: 5000 });
    
    // Bottom nav should be visible on mobile
    await expect(page.locator("#bottomNav")).toBeVisible();
    
    // Sidebar should be hidden or hamburger menu shown
    const sidebar = page.locator("aside");
    const isSidebarVisible = await sidebar.isVisible().catch(() => false);
    
    if (!isSidebarVisible) {
      // Should have hamburger menu
      await expect(page.locator("#menuBtn")).toBeVisible();
    }
  });

  test("WebSocket connection shows status", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#pageContent", { timeout: 5000 });
    
    // Navigate to settings
    await page.click(".nav-item[data-page='settings']");
    await page.waitForTimeout(500);
    
    // WebSocket status should be shown
    await expect(page.locator("#wsStatus")).toBeVisible();
    const wsText = await page.locator("#wsStatus").textContent();
    expect(wsText).toMatch(/已连接|未连接|连接中/);
  });

  test("dashboard shows stats cards", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#pageContent", { timeout: 5000 });
    
    // Dashboard should have stat cards
    const statCards = page.locator(".stat-card");
    await expect(statCards.first()).toBeVisible();
    
    // Should show system info
    await expect(page.locator("#pageContent")).toContainText("系统");
  });

  test("chat interface exists", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#pageContent", { timeout: 5000 });
    
    // Navigate to chat
    await page.click(".nav-item[data-page='chat']");
    await page.waitForTimeout(300);
    
    // Chat input should be visible
    await expect(page.locator("#chatInput")).toBeVisible();
    await expect(page.locator("#sendBtn")).toBeVisible();
  });

  test("search interface exists", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#pageContent", { timeout: 5000 });
    
    // Navigate to search
    await page.click(".nav-item[data-page='search']");
    await page.waitForTimeout(300);
    
    // Search input should be visible
    await expect(page.locator("#searchQuery")).toBeVisible();
  });
});
