import { test, expect } from "@playwright/test";
import { injectAuth } from "./helpers";

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

test("perf page renders cards", async ({ page }) => {
  await page.goto("/perf", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "性能" })
  ).toBeVisible();
  for (const label of ["CPU", "内存", "RPS", "P95"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "原生模块" })).toBeVisible();
});
