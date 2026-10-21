import { test, expect, Page } from "@playwright/test";
import { injectAuth } from "./helpers";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const sidebar = (page: Page) => page.locator('aside[aria-label="主导航"]');
const bottomNav = (page: Page) => page.getByRole("navigation", { name: "底部导航" });

async function openAtViewport(
  page: Page,
  viewport: { width: number; height: number },
  path = "/agents",
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

test.describe("响应式应用外壳", () => {
  test("桌面端常驻显示侧栏并隐藏底部导航", async ({ page }) => {
    await openAtViewport(page, DESKTOP);

    await expect(sidebar(page)).toBeVisible();
    await expect(sidebar(page)).not.toHaveAttribute("aria-hidden", "true");
    await expect(bottomNav(page)).toBeHidden();
  });

  test("移动端默认隐藏侧栏并显示底部导航", async ({ page }) => {
    await openAtViewport(page, MOBILE);

    await expect(sidebar(page)).toHaveAttribute("aria-hidden", "true");
    await expect(sidebar(page)).toHaveAttribute("inert", "");
    await expect(sidebar(page)).toHaveClass(/-translate-x-full/);
    await expect(bottomNav(page)).toBeVisible();
  });

  test("桌面端关键页面标题可见", async ({ page }) => {
    await openAtViewport(page, DESKTOP, "/agents");
    await expect(page.getByRole("heading", { level: 1, name: "智能体" })).toBeVisible();

    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  });

  test("移动端关键页面标题可见", async ({ page }) => {
    await openAtViewport(page, MOBILE, "/agents");
    await expect(page.getByRole("heading", { level: 1, name: "智能体" })).toBeVisible();

    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
    await expect(bottomNav(page)).toBeVisible();
  });
});
