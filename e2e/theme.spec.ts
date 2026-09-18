import { test, expect, Page } from "@playwright/test";
import { injectAuth } from "./helpers";

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
  // 固定默认主题为暗色（Playwright 默认 colorScheme 为 light，会干扰断言）
  await page.addInitScript(() => {
    try {
      localStorage.setItem("axiom:theme", "dark");
    } catch (e) {
      /* ignore */
    }
  });
});

const getTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-theme"));

const getBgVar = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
  );

/** 通过外壳系统菜单"视图 → 切换主题"切换主题 */
async function toggleTheme(page: Page) {
  const menu = page.getByRole("navigation", { name: "系统菜单" });
  await menu.getByRole("button", { name: "视图" }).click();
  await page.getByRole("menuitem", { name: "切换主题" }).click();
}

test("default theme is dark", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(await getTheme(page)).toBe("dark");
});

test("theme toggle switches to light via system menu", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await toggleTheme(page);
  await expect.poll(() => getTheme(page)).toBe("light");
});

test("dark theme CSS variables applied", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(await getBgVar(page)).toBe("#0a0a0a");
});

test("light theme CSS variables applied after toggle", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await toggleTheme(page);
  await expect.poll(() => getBgVar(page)).toBe("#ffffff");
});
