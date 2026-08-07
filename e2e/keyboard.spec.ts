import { test, expect } from "@playwright/test";

function dispatchKey(page: any, key: string, shift = false) {
  return page.evaluate(
    ({ k, s }: { k: string; s: boolean }) => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, shiftKey: s, bubbles: true })
      );
    },
    { k: key, s: shift }
  );
}

test("? opens keyboard help modal", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await dispatchKey(page, "?");
  await expect(
    page.getByRole("dialog", { name: "键盘快捷键" })
  ).toBeVisible();
});

test("1-6 switches pages (首页与对话合并后)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const map: Record<string, string> = {
    "1": "/chat",
    "2": "/search",
    "3": "/code",
    "4": "/vault",
    "5": "/providers",
    "6": "/settings",
  };
  for (const [key, path] of Object.entries(map)) {
    await dispatchKey(page, key);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
});

test("/ navigates to search page", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await dispatchKey(page, "/");
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByLabel("搜索关键词")).toBeVisible();
});

test("Shift+T toggles theme", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const before = await page.evaluate(() =>
    document.documentElement.getAttribute("data-theme")
  );
  await dispatchKey(page, "T", true);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.getAttribute("data-theme"))
    )
    .not.toBe(before);
});
