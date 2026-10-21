import { test, expect } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * 聊天入口回归（2026-10-22 重写）
 *
 * 旧版测的是 `/chat` 页上的输入框（`#home-input`、`getByLabel("消息输入框")`）。
 * 但当前前端已把 Chat 页移除（frontend/src/App.tsx 注释「首页即 Agent 工作区（Chat 页已移除）」），
 * 导航与快捷键里的对话入口统一走 `/agents`。
 *
 * 这里保留的是**仍成立且值得回归**的部分：`/chat` 这个历史路径不能被当成 404/白屏，
 * 必须经由 SPA 通配路由回退到工作区。它保护的是「删除页面后旧链接仍可达」这一行为。
 */
test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

test("历史 /chat 路径回退到 Agent 工作区（不是白屏/404）", async ({ page }) => {
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { name: "智能体" })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText("页面渲染时发生意外错误")).toHaveCount(0);
});

test("对话入口的规范落点是 /agents（可直接访问）", async ({ page }) => {
  await page.goto("/agents", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { name: "智能体" })).toBeVisible({
    timeout: 10000,
  });
});
