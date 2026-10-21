import { test, expect, type Page } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * 导航过渡状态回归（2026-10-22）
 *
 * 背景（E2E 子代理发现、Lead 复现）：`Layout.tsx` 原用
 * `<AnimatePresence mode="wait"><motion.div key={location.pathname}>…<Outlet/></motion.div></AnimatePresence>`。
 * mode="wait" 要求旧页面**退场动画结束后**才挂载新页面，且每次导航整棵子树 remount ——
 * 用户导航后立即输入时，输入落进即将被丢弃的子树，随后被**静默清空**。
 * 修复：改用 `mode="popLayout"`（新页面立即挂载并可交互，退场元素移出布局流做淡出）。
 *
 * 本文件是该缺陷的回归护栏：导航后**立即**输入，等待过渡结束（≥800ms）后值必须仍在。
 * 若有人再把过渡改回“先退场再挂载”或引入延迟挂载，这里会失败。
 */
test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

/** 通过顶栏系统菜单做客户端导航：文件 → 搜索。 */
async function navigateToSearchViaMenu(page: Page): Promise<void> {
  await page.goto("/agents", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "智能体", level: 1 })).toBeVisible({
    timeout: 10000,
  });
  const menu = page.getByRole("navigation", { name: "系统菜单" });
  await menu.getByRole("button", { name: "文件" }).click();
  await page.getByRole("menuitem", { name: "搜索" }).click();
  await expect(page).toHaveURL(/\/search$/);
}

test("导航后立即输入，过渡结束后输入值不被清空", async ({ page }) => {
  await navigateToSearchViaMenu(page);

  const input = page.getByLabel("搜索关键词");
  // 关键：导航完成后**立刻**输入，不给过渡动画留时间
  await input.fill("连接池耗尽");

  // 过渡动画（pageEnter）若仍会 remount，值会在 ~400ms 内被清空
  await page.waitForTimeout(900);

  await expect(input).toBeVisible();
  await expect(input, "导航过渡结束后输入值必须保留（不得 remount 丢弃）").toHaveValue(
    "连接池耗尽",
  );
});

test("连续快速导航：每次落点页面都可立即交互", async ({ page }) => {
  await page.goto("/agents", { waitUntil: "domcontentloaded" });

  const menu = page.getByRole("navigation", { name: "系统菜单" });
  // 文件→搜索，随后立刻再走 文件→代码；两次导航间隔远小于动画时长
  await menu.getByRole("button", { name: "文件" }).click();
  await page.getByRole("menuitem", { name: "搜索" }).click();
  await menu.getByRole("button", { name: "文件" }).click();
  await page.getByRole("menuitem", { name: "代码" }).click();

  await expect(page).toHaveURL(/\/code$/);
  await expect(page.getByRole("heading", { name: "代码", level: 1 })).toBeVisible({
    timeout: 10000,
  });
});
