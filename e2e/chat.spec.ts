import { test, expect } from "@playwright/test";
import { injectAuth } from "./helpers";

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

// 新前端（frontend/，React SPA）首页与 /chat 页均有输入框。
test("can type in home chat input", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const input = page.locator("#home-input");
  await input.fill("Hello Axiom");
  await expect(input).toHaveValue("Hello Axiom");
});

test("can type in chat page input", async ({ page }) => {
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const input = page.getByLabel("消息输入框");
  await input.fill("Hello Axiom");
  await expect(input).toHaveValue("Hello Axiom");
});
