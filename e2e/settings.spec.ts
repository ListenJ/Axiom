import { test, expect } from "@playwright/test";

test("settings page renders", async ({ page }) => {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "设置" })
  ).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "主题切换" })).toBeVisible();
});

test("theme buttons exist", async ({ page }) => {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("radio", { name: "深色主题" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "浅色主题" })).toBeVisible();
});

test("switching theme radio updates data-theme", async ({ page }) => {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await page.getByRole("radio", { name: "浅色主题" }).click();
  const theme = await page.evaluate(() =>
    document.documentElement.getAttribute("data-theme")
  );
  expect(theme).toBe("light");
});

test("toggling a behavior switch shows toast", async ({ page }) => {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  // 对话与行为面板默认折叠（Collapsible 化后），先展开再操作开关
  const trigger = page.getByRole("button", { name: /对话与行为/ });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await page.getByRole("switch", { name: "切换 桌面通知" }).click();
  await expect(page.getByText(/桌面通知已(开启|关闭)/)).toBeVisible({
    timeout: 3000,
  });
});
