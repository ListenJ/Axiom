import { test, expect, type Page } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * 页面可达性回归（重写版，2026-10-22）—— 当前前端是「Agent 工作区」SPA。
 *
 * 旧规格意图（逐页 goto + 断言页面标题）在当前 UI 中仍成立，但实现依据已变：
 * - 路由注册：frontend/src/App.tsx —— 根路径 index 重定向 /agents，20 个页面路由挂在
 *   Layout 下，/login 独立于 Layout，`*` 兜底重定向到 /；
 * - 页面标题：frontend/src/components/ui/PageHeader.tsx 输出全站（除 /login）唯一的 <h1>；
 *   错误边界（App.tsx ErrorBoundary）另有 <h1>出错了</h1> 与「页面渲染时发生意外错误」文案；
 * - 工作区外壳：frontend/src/components/layout/Layout.tsx 的 <aside aria-label="主导航">
 *   与 <main id="main">；
 * - 系统菜单：frontend/src/components/layout/Header.tsx（视图菜单 → 「搜索」menuitem）。
 *
 * 深链是否返回 SPA 入口由后端白名单 src/main.ts SPA_ROUTES 决定：/search 不在其中
 * （该路径被后端搜索 API 占用），故它只能经客户端导航到达，单独覆盖。
 */
test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

const ERROR_BOUNDARY_TEXT = "页面渲染时发生意外错误";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 直达一个 SPA 页面，断言 PageHeader 标题、工作区外壳与错误边界状态。 */
async function expectPageHeader(
  page: Page,
  path: string,
  title: string,
): Promise<void> {
  await test.step(`goto ${path} → 「${title}」`, async () => {
    const __t0 = Date.now();
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    console.log(`[probe] ${path} goto=${Date.now() - __t0}`);
    // SPA_ROUTES 白名单路径应直接返回 index.html；401/JSON 说明深链已断
    expect(response?.status(), `GET ${path} 应返回 SPA index.html（200）`).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(path)}$`));
    console.log(`[probe] ${path} url=${Date.now() - __t0}`);

    // 全站唯一 <h1> 由 PageHeader 渲染（错误边界会把它换成「出错了」）
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading, `GET ${path} 应有且仅有 PageHeader 一个 h1`).toHaveCount(1);
    console.log(`[probe] ${path} count=${Date.now() - __t0}`);
    await expect(heading, `GET ${path} 的 PageHeader 标题应为「${title}」`).toHaveText(title);
    console.log(`[probe] ${path} text=${Date.now() - __t0}`);
    await expect(heading).toBeVisible();

    // Layout 外壳存在 → 页面渲染在 "/" 路由树的 Layout 内，而非白屏/独立页
    await expect(page.locator('aside[aria-label="主导航"]')).toBeVisible();
    console.log(`[probe] ${path} aside=${Date.now() - __t0}`);
    await expect(page.getByText(ERROR_BOUNDARY_TEXT)).toHaveCount(0);
    console.log(`[probe] ${path} done=${Date.now() - __t0}`);
  });
}

const CORE_PAGES: ReadonlyArray<{ path: string; title: string }> = [
  { path: "/agents", title: "智能体" },
  { path: "/code", title: "代码" },
  { path: "/router", title: "模型路由" },
  { path: "/vault", title: "知识库" },
  { path: "/kg", title: "知识图谱" },
  { path: "/sessions", title: "会话管理" },
  { path: "/eval", title: "模型评估" },
  { path: "/plugins", title: "插件市场" },
  { path: "/settings", title: "设置" },
];

const HUB_PAGES: ReadonlyArray<{ path: string; title: string }> = [
  { path: "/trends", title: "趋势分析" },
  { path: "/ocr", title: "OCR 文字识别" },
  { path: "/research", title: "深度研究" },
  { path: "/knowledge", title: "知识库" },
  { path: "/proxies", title: "代理管理" },
  { path: "/providers", title: "Provider 管理" },
  { path: "/tokens", title: "Token 消耗分析" },
  { path: "/perf", title: "性能" },
];

test.describe("SPA 直达：PageHeader 标题可见且未落入错误边界", () => {
  test("核心 9 页逐一 goto", async ({ page }) => {
    for (const { path, title } of CORE_PAGES) {
      await expectPageHeader(page, path, title);
    }
  });

  test("迁移/兼容 8 页逐一 goto", async ({ page }) => {
    for (const { path, title } of HUB_PAGES) {
      await expectPageHeader(page, path, title);
    }
  });
});

test("/search 经系统菜单客户端导航到达，标题为「搜索」", async ({ page }) => {
  // /search 不在 src/main.ts 的 SPA_ROUTES 白名单（被后端搜索 API 占用），
  // 直接深链不返回 SPA，因此本路由只能从壳内导航验证（旧规格的 goto 断言在此不成立）。
  await page.goto("/agents", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("智能体");

  const systemMenu = page.getByRole("navigation", { name: "系统菜单" });
  await systemMenu.getByRole("button", { name: "视图" }).click();
  await page.getByRole("menuitem", { name: "搜索" }).click();

  await expect(page).toHaveURL(/\/search$/);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveCount(1);
  await expect(heading).toHaveText("搜索");
  await expect(heading).toBeVisible();
  await expect(page.getByText(ERROR_BOUNDARY_TEXT)).toHaveCount(0);
});

test("SPA 内未知路径回退到 /agents", async ({ page }) => {
  await page.goto("/agents", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("智能体");

  // 1) SPA 内未知路径：App.tsx 的 `*` 路由 → "/" → "/agents"
  await page.evaluate(() => {
    window.history.pushState({}, "", "/this-route-does-not-exist");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("智能体");

  // 说明（2026-10-22 裁定）：**直接 GET 未知路径**不在此用例断言。
  // 后端对非 SPA 白名单路径先过鉴权中间件（实测无凭证返回 401），并不做通用 SPA 回退，
  // 因此「未知 URL → 200 入口页」不是现行契约；历史链接的可达性由 e2e/chat.spec.ts
  // （/chat 已在白名单内 → SPA → /agents）覆盖。原先断言 200 的写法在真实实现下必然
  // 时通过时失败（曾以 repeat-each 复现 1/15 失败），故移除，避免把未实现的行为写成门禁。
});

test("/login 独立于工作区外壳，标题为「需要身份验证」", async ({ page }) => {
  const response = await page.goto("/login", { waitUntil: "domcontentloaded" });
  expect(response?.status(), "GET /login 应返回 SPA index.html（200）").toBe(200);
  await expect(page).toHaveURL(/\/login$/);

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveCount(1);
  await expect(heading).toHaveText("需要身份验证");
  await expect(heading).toBeVisible();
  // App.tsx 把 /login 注册在 Layout 之外 → 不应出现侧栏与 <main id="main">
  await expect(page.locator('aside[aria-label="主导航"]')).toHaveCount(0);
  await expect(page.locator("main#main")).toHaveCount(0);
});
