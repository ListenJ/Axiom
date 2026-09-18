import { test, expect } from "@playwright/test";
import { injectAuth } from "./helpers";

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

/**
 * Task 14 H-3: 8 高优先级页面可达性验证
 * 覆盖前端 21 页中仅 8 有 e2e 的缺口，补齐设置/知识库/会话等高优先级页面
 * 路由均在 frontend/src/App.tsx 中注册，SPA_ROUTES 在 src/main.ts 中白名单放行
 */
const CASES: Array<{ path: string; heading: string }> = [
  { path: "/agents", heading: "智能体" },
  { path: "/eval", heading: "模型评估" },
  { path: "/kg", heading: "知识图谱" },
  { path: "/login", heading: "需要身份验证" },
  { path: "/plugins", heading: "插件市场" },
  { path: "/router", heading: "模型路由" },
  { path: "/sessions", heading: "会话管理" },
  { path: "/tokens", heading: "Token 消耗分析" },
];

for (const { path, heading } of CASES) {
  test(`${path} 可达且标题「${heading}」可见`, async ({ page }) => {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    // SPA 路由应返回 200 的 index.html（src/main.ts SPA_ROUTES），未注册路由会 302/重定向到 /
    expect(response?.ok(), `GET ${path} should be 200`).toBeTruthy();
    // 标题为 PageHeader 静态文本，不依赖后端 API，10s 内可见即判定页面已渲染
    await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 10000 });
    // 确认未被通配 * 重定向到 /
    await expect(page).toHaveURL(new RegExp(path.replace("/", "\\/")));
  });
}

test("8 高优先级页可达（循环 page.goto）", async ({ page }) => {
  for (const { path, heading } of CASES) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 10000 });
  }
});
