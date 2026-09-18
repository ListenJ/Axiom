import { test, expect } from "@playwright/test";
import { injectAuth } from "./helpers";

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

test("search page elements are visible", async ({ page }) => {
  await page.goto("/search", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("搜索关键词")).toBeVisible();
  await expect(page.getByLabel("搜索设置")).toBeVisible();
});

test("can search and display results", async ({ page }) => {
  // 新前端调用同源 GET /search?q=... 与 /search/code?q=...，结果须为数组
  await page.route(/\/search\/code\?/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
  await page.route(/\/search\?/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          title: "Test Note",
          type: "note",
          snippet: "Matching result",
          path: "vault/test.md",
        },
      ]),
    });
  });

  await page.goto("/search", { waitUntil: "domcontentloaded" });
  await page.getByLabel("搜索关键词").fill("test");

  // 输入后前端有 250ms 防抖，随后发起请求并渲染结果
  await expect(page.getByText("Test Note").first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/共 \d+ 条结果/)).toBeVisible();
});
