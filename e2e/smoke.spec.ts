import { test, expect } from "@playwright/test";

test("page title is correct", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/Axiom/);
});

test("sidebar renders with brand", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const sidebar = page.locator('aside[aria-label="主导航"]');
  await expect(sidebar).toContainText("Axiom", { timeout: 10000 });
  await expect(sidebar.locator("svg").first()).toBeVisible();
});

test("all nav items are visible", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const nav = page.locator('nav[aria-label="主导航列表"]');
  await nav.locator("a").first().waitFor({ timeout: 10000 });
  // 首页与对话已合并：导航不再有独立"首页"入口；按 nav 内链接精确定位
  for (const label of ["对话", "搜索", "代码", "知识", "模型", "系统"]) {
    await expect(nav.locator("a", { hasText: label }).first()).toBeVisible();
  }
});

test("header renders with system menu actions", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // 外壳系统菜单（文件/编辑/视图/帮助）——重构后主题切换与快捷键入口移入菜单
  const menu = page.getByRole("navigation", { name: "系统菜单" });
  await expect(menu).toBeVisible({ timeout: 10000 });
  await expect(menu.getByRole("button", { name: "视图" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "帮助" })).toBeVisible();
  // 视图菜单含"切换主题"
  await menu.getByRole("button", { name: "视图" }).click();
  await expect(page.getByRole("menuitem", { name: "切换主题" })).toBeVisible();
});

test("home page is active by default", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "有什么可以帮助你的？" })
  ).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#home-input")).toBeVisible();
});
