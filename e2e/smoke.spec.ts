import { test, expect } from "@playwright/test";
import { injectAuth } from "./helpers";

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

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

test("sidebar sections render (新对话 / Git / MCP / 设置)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const sidebar = page.locator('aside[aria-label="主导航"]');
  await expect(sidebar.getByRole("button", { name: "开启新对话" })).toBeVisible();
  await expect(sidebar.getByText("Git 仓库状态")).toBeVisible();
  await expect(sidebar.getByText("MCP · Skill")).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "打开设置" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "键盘快捷键" })).toBeVisible();
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
