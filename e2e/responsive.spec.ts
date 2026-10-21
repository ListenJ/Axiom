import { test, expect } from "@playwright/test";
import { injectAuth } from "./helpers";

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

const sidebar = (page: any) => page.locator('aside[aria-label="主导航"]');

test("desktop shows sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(sidebar(page)).toBeVisible();
});

test("mobile hides sidebar initially", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(sidebar(page)).toHaveClass(/-translate-x-full/);
});

test("mobile hamburger toggles sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.getByLabel("打开菜单").click();
  await expect(sidebar(page)).not.toHaveClass(/-translate-x-full/);

  await page.getByLabel("关闭菜单").click();
  await expect(sidebar(page)).toHaveClass(/-translate-x-full/);
});

test("mobile shows bottom navigation", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('nav[aria-label="底部导航"]')).toBeVisible();
});

test("desktop hides bottom navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('nav[aria-label="底部导航"]')).not.toBeVisible();
});

// 2026-10-21：UI 重构后本规格过时（实测 11/12 规格因等待已不存在的元素而 30s 超时累积）。
// 显式 skip 并保留原文用于重写参考；可执行的新切片见 e2e/smoke.spec.ts。
import { skipObsoleteUiSuite } from "./_obsolete-ui-suite";
skipObsoleteUiSuite();