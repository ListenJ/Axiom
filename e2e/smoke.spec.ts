import { test, expect } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * 当前前端（frontend/ React SPA）冒烟测试 —— 2026-10-21 重写。
 *
 * 为什么重写：前端已重构为「Agent 工作区」形态（App.tsx 注释明确「Chat 页已移除」，
 * 根路径重定向 `/agents`），旧冒烟里的 `#home-input`、「有什么可以帮助你的？」、
 * 「开启新对话」等元素已不存在。本次按**当前实现**逐条核对后重写：
 *   - 侧栏：`aside[aria-label="主导航"]`，含品牌按钮 `aria-label="返回工作区"`、
 *     `aria-label="打开设置"`、`aria-label="键盘快捷键"`（Sidebar.tsx）；
 *   - 顶栏：`nav[aria-label="系统菜单"]` 四个菜单按钮（文件/编辑/视图/帮助），
 *     视图菜单内 `role="menuitem"` 含「切换主题」（Header.tsx）；
 *   - 路由：`/` → `/agents`（App.tsx index redirect），页面标题由 PageHeader 的 `<h1>` 提供。
 *
 * 其余 11 个旧规格已显式 skip（见 `_obsolete-ui-suite.ts`），待按当前前端重写；
 * 本文件是可执行的第一节切片。
 */
test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

test.describe("当前前端冒烟（v4 Agent 工作区）", () => {
  test("页面标题包含 Axiom", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/Axiom/);
  });

  test("侧栏渲染品牌与工作区入口", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const sidebar = page.locator('aside[aria-label="主导航"]');
    await expect(sidebar).toContainText("Axiom", { timeout: 10000 });
    await expect(sidebar.getByRole("button", { name: "返回工作区" })).toBeVisible();
  });

  test("侧栏动作按钮可用（设置 / 快捷键）", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const sidebar = page.locator('aside[aria-label="主导航"]');
    await expect(sidebar.getByRole("button", { name: "打开设置" })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "键盘快捷键" })).toBeVisible();
  });

  test("顶栏系统菜单可展开且含「切换主题」", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const menu = page.getByRole("navigation", { name: "系统菜单" });
    await expect(menu).toBeVisible({ timeout: 10000 });
    for (const name of ["文件", "编辑", "视图", "帮助"]) {
      await expect(menu.getByRole("button", { name })).toBeVisible();
    }
    await menu.getByRole("button", { name: "视图" }).click();
    await expect(page.getByRole("menuitem", { name: "切换主题" })).toBeVisible();
  });

  test("根路径重定向到 /agents 并渲染智能体页标题", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole("heading", { name: "智能体" })).toBeVisible({
      timeout: 10000,
    });
    // 错误边界文案（App.tsx ErrorBoundary）一旦出现即说明页面渲染崩溃
    await expect(page.getByText("页面渲染时发生意外错误")).toHaveCount(0);
  });
});
