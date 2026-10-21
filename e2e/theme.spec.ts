import { test, expect, Page } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * 主题切换回归测试（2026-10-22 按「Agent 工作区」前端重写）。
 *
 * 旧规格（/chat、#home-input 时代）只敢断言 data-theme 与 --bg；重构后主题链路已迁移到
 * 外壳系统菜单，本规格按当前实现逐条核对，断言来自以下源码事实：
 *   - Header.tsx：nav[aria-label="系统菜单"] → button「视图」(aria-expanded) → role=menuitem
 *     「切换主题」，onSelect 调 useApp.toggleTheme()；
 *   - state/useApp.ts：toggleTheme 在 dark/light 间取反，setTheme 写 localStorage['axiom:theme']，
 *     空 localStorage 时 readInitialTheme() 默认 'dark'；
 *   - hooks/useTheme.ts：把解析结果写 documentElement[data-theme]，并更新
 *     meta[name="theme-color"]（dark #0f0f11 / light #f8fafc）；
 *   - styles/index.css：[data-theme='dark'] --bg:#0a0a0a，[data-theme='light'] --bg:#ffffff；
 *   - public/index.html：内联脚本按 localStorage 预置 data-theme，刷新后由 React 接管。
 *
 * 刻意不用 addInitScript 强塞初始主题：空 localStorage 的默认值、菜单切换、刷新恢复
 * 三条路径互相独立，任何一条断了测试都会红。
 */
const THEME_KEY = "axiom:theme";

const readCssVar = (page: Page, name: string): Promise<string> =>
  page.evaluate(
    (varName) => getComputedStyle(document.documentElement).getPropertyValue(varName).trim(),
    name
  );

const readStoredTheme = (page: Page): Promise<string | null> =>
  page.evaluate((key) => localStorage.getItem(key), THEME_KEY);

const root = (page: Page) => page.locator("html");
const themeColorMeta = (page: Page) => page.locator('meta[name="theme-color"]');

/** 走真实外壳菜单：系统菜单 → 视图 → 切换主题 */
async function toggleThemeViaMenu(page: Page): Promise<void> {
  const viewMenuButton = page
    .getByRole("navigation", { name: "系统菜单" })
    .getByRole("button", { name: "视图" });
  await viewMenuButton.click();
  await expect(viewMenuButton).toHaveAttribute("aria-expanded", "true");
  const toggleItem = page.getByRole("menuitem", { name: "切换主题" });
  await expect(toggleItem).toBeVisible();
  await toggleItem.click();
  // Header.tsx 选中后 setOpen(false)：等菜单退场，避免下一次打开菜单的点击被当成「关闭」
  await expect(toggleItem).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

test.describe("主题切换（系统菜单 -> 视图 -> 切换主题）", () => {
  // 串行执行：单测含真实 SPA 加载/重载，并行 4 worker 会互相抢 CPU 与同一后端，
  // 实测并行时两个用例曾逼近/超出 20s 测试超时；串行后每个用例稳定在 5-7s，断言不变。
  test.describe.configure({ mode: "serial" });

  test("默认暗色：data-theme、--bg、theme-color 一致且未写 localStorage", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("navigation", { name: "系统菜单" })).toBeVisible();
    await expect(root(page)).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => readCssVar(page, "--bg")).toBe("#0a0a0a");
    await expect(themeColorMeta(page)).toHaveAttribute("content", "#0f0f11");
    expect(await readStoredTheme(page)).toBeNull();
  });

  test("菜单切换后变浅色：data-theme、--bg、theme-color、localStorage 同步更新", async ({
    page,
  }) => {
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await expect(root(page)).toHaveAttribute("data-theme", "dark");
    await toggleThemeViaMenu(page);
    await expect(root(page)).toHaveAttribute("data-theme", "light");
    await expect.poll(() => readCssVar(page, "--bg")).toBe("#ffffff");
    await expect(themeColorMeta(page)).toHaveAttribute("content", "#f8fafc");
    expect(await readStoredTheme(page)).toBe("light");
  });

  test("连续切换可往返：light -> dark，localStorage 跟随最终主题", async ({ page }) => {
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await toggleThemeViaMenu(page);
    await expect(root(page)).toHaveAttribute("data-theme", "light");
    await toggleThemeViaMenu(page);
    await expect(root(page)).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => readCssVar(page, "--bg")).toBe("#0a0a0a");
    await expect(themeColorMeta(page)).toHaveAttribute("content", "#0f0f11");
    expect(await readStoredTheme(page)).toBe("dark");
  });

  test("刷新后仍保持浅色主题（localStorage 恢复，不回落到默认暗色）", async ({ page }) => {
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await toggleThemeViaMenu(page);
    await expect(root(page)).toHaveAttribute("data-theme", "light");
    expect(await readStoredTheme(page)).toBe("light");

    await page.reload({ waitUntil: "domcontentloaded" });
    // 等外壳挂载（React 已接管），再断言刷新后的最终主题
    await expect(page.getByRole("navigation", { name: "系统菜单" })).toBeVisible();
    await expect(root(page)).toHaveAttribute("data-theme", "light");
    await expect.poll(() => readCssVar(page, "--bg")).toBe("#ffffff");
    await expect(themeColorMeta(page)).toHaveAttribute("content", "#f8fafc");
    expect(await readStoredTheme(page)).toBe("light");
  });
});
