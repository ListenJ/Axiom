import { test, expect, type Page } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * 键盘快捷键回归 —— 2026-10-21 按「Agent 工作区」SPA（frontend/src）重写。
 *
 * 依据（实现即规格，均按当前源码核对）：
 * - 分发：frontend/src/hooks/useGlobalHotkeys.ts —— document 级 keydown；
 *   输入框/可编辑元素聚焦时停用；Esc 按 帮助 → 右侧工具台 → 失焦 的优先级关闭；
 * - 注册表：frontend/src/lib/shortcuts.ts —— `/` 与 Ctrl/Cmd+K 跳 /search、`?` 开帮助、
 *   Shift+T 切主题、Esc 关闭；
 * - 导航快捷键：frontend/src/lib/nav.ts（NAV_SHORTCUTS 由 VISIBLE_NAV_ITEMS 派生）；
 * - 帮助弹窗：frontend/src/components/ui/HelpModal.tsx —— role="dialog" aria-label="键盘快捷键"；
 * - 路由与标题：frontend/src/App.tsx（根路径重定向 /agents）、components/ui/PageHeader.tsx（h1）。
 */

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

/** 打开工作区首页（/ → /agents），确认 Layout 已挂载（useGlobalHotkeys 监听器已注册）。 */
async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/agents$/);
  await expect(
    page.getByRole("heading", { name: "智能体", level: 1 })
  ).toBeVisible({ timeout: 10000 });
  // 外壳系统菜单出现即说明 Layout/Header 已渲染、全局监听器已挂载
  await expect(
    page.getByRole("navigation", { name: "系统菜单" })
  ).toBeVisible();
}

test("? 打开键盘快捷键弹窗（清单来自快捷键注册表），Esc 关闭", async ({
  page,
}) => {
  await openWorkspace(page);

  const dialog = page.getByRole("dialog", { name: "键盘快捷键" });
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press("?");
  await expect(dialog).toBeVisible();

  // 分组来自 HelpModal 的 CATEGORY_META（导航 / 全局）
  await expect(dialog.getByText("导航", { exact: true })).toBeVisible();
  await expect(dialog.getByText("全局", { exact: true })).toBeVisible();
  // 全局快捷键内容来自 lib/shortcuts.ts
  await expect(dialog.getByText("切换深色 / 浅色主题")).toBeVisible();
  await expect(dialog.locator("kbd", { hasText: "Shift+T" })).toBeVisible();
  await expect(dialog.locator("kbd", { hasText: "Ctrl+`" })).toBeVisible();
  // 导航快捷键内容由 lib/nav.ts 派生：2 → /search 的「打开 搜索」
  await expect(dialog.getByText("打开 搜索")).toBeVisible();

  // Esc 关闭弹窗（useGlobalHotkeys 的 escape 分支 / useFocusTrap 的 onEscape）
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("/ 与 Ctrl+K 都跳转到搜索页", async ({ page }) => {
  await openWorkspace(page);

  await page.keyboard.press("/");
  await expect(page).toHaveURL(/\/search$/);
  await expect(
    page.getByRole("heading", { name: "搜索", level: 1 })
  ).toBeVisible({ timeout: 10000 });
  // "聚焦搜索"：SearchPanel 的输入框带 autoFocus（components/search-panels.tsx）
  await expect(page.getByLabel("搜索关键词")).toBeVisible();
  await expect(page.getByLabel("搜索关键词")).toBeFocused();

  // 从非搜索页按 Ctrl+K，验证发生真实路由切换（而不是已在 /search 上原地不动）
  await page.goto("/code", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "代码", level: 1 })
  ).toBeVisible({ timeout: 10000 });
  await page.keyboard.press("Control+k");
  await expect(page).toHaveURL(/\/search$/);
  await expect(
    page.getByRole("heading", { name: "搜索", level: 1 })
  ).toBeVisible({ timeout: 10000 });
});

test("数字快捷键按 nav.ts 跳转到对应路由", async ({ page }) => {
  await openWorkspace(page);

  // nav.ts 的 shortcut → path 映射；每步断言 URL 与 PageHeader 的 h1 标题
  // 注：'1' 对应 /chat 已从 App.tsx 移除，经通配路由 * 重定向回 /agents（工作区首页）
  const cases: Array<{ key: string; url: RegExp; heading: string }> = [
    { key: "3", url: /\/code$/, heading: "代码" },
    { key: "4", url: /\/vault$/, heading: "知识库" },
    { key: "6", url: /\/settings$/, heading: "设置" },
    { key: "1", url: /\/agents$/, heading: "智能体" },
  ];
  for (const c of cases) {
    await page.keyboard.press(c.key);
    await expect(page).toHaveURL(c.url);
    await expect(
      page.getByRole("heading", { name: c.heading, level: 1 })
    ).toBeVisible({ timeout: 10000 });
  }
});

test("Shift+T 切换主题并持久化到 localStorage axiom:theme", async ({
  page,
}) => {
  await openWorkspace(page);

  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.keyboard.press("Shift+T");
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("axiom:theme")))
    .toBe("light");

  // 再按一次回到暗色，确认是双向 toggle 而非单向开关
  await page.keyboard.press("Shift+T");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("axiom:theme")))
    .toBe("dark");
});
