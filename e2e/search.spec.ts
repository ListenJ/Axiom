import { test, expect, type Page } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * /search 搜索 Hub 回归测试 —— 按当前「Agent 工作区」前端（frontend/src）重写。
 *
 * 旧规格为何过时（2026-10-21 前版本）：
 *   - 当前 App.tsx 中 /search 是 pages/Search.tsx 的 Hub：PageHeader 标题「搜索」+
 *     4 个标签页（搜索 / 深度研究 / 趋势 / OCR），标签态由 ?tab= 驱动（useSearchParams），
 *     面板实现见 components/search-panels.tsx；旧规格依赖的「打开摘要」等聊天侧元素已不存在。
 *   - 旧夹具 mock 的 GET /search/code 端点在 lib/api.ts 中已不存在：现在一次搜索会请求
 *     /search（vault）、/codegraph/search（代码）、/web-search（全网）三个端点。
 *   - 后端把 /search 注册为 vault 搜索 API，且未列入 src/main.ts 的 SPA_ROUTES 白名单，
 *     直接 page.goto("/search") 得到的是 401 JSON 而非 SPA。因此本规格只走真实入口：
 *     顶栏「文件」菜单 →「搜索」（components/layout/Header.tsx）。
 *
 * 网络纪律：所有输入触发的搜索请求均被 page.route 本地夹具拦截，不触达后端搜索；
 * 非同源请求数断言为 0（不产生任何外部网络）。
 */

const BASE_ORIGIN = "http://localhost:18789";
const SEARCH_PATHS = ["/search", "/codegraph/search", "/web-search"];

interface SearchHit {
  pathname: string;
  q: string | null;
}

/** 监听请求：同源搜索端点记入 hits，非同源请求记入 external（证伪「无外部网络」） */
function trackTraffic(page: Page) {
  const hits: SearchHit[] = [];
  const external: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.origin !== BASE_ORIGIN) {
      external.push(req.url());
      return;
    }
    if (SEARCH_PATHS.includes(url.pathname)) {
      hits.push({ pathname: url.pathname, q: url.searchParams.get("q") });
    }
  });
  return { hits, external };
}

function json(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

/** 用本地夹具接住三个搜索端点（lib/api.ts endpoints.search.*），确保零真实搜索请求 */
async function stubSearch(
  page: Page,
  fixture: { vault: unknown; code: unknown; web: unknown },
) {
  await page.route((url) => url.pathname === "/search", (route) =>
    route.fulfill(json(fixture.vault)),
  );
  await page.route((url) => url.pathname === "/codegraph/search", (route) =>
    route.fulfill(json(fixture.code)),
  );
  await page.route((url) => url.pathname === "/web-search", (route) =>
    route.fulfill(json(fixture.web)),
  );
}

/** 走当前 UI 的真实入口进入搜索 Hub：顶栏「文件」菜单 →「搜索」 */
async function openSearch(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/agents$/);
  await page
    .getByRole("navigation", { name: "系统菜单" })
    .getByRole("button", { name: "文件" })
    .click();
  await page.getByRole("menuitem", { name: "搜索" }).click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByLabel("搜索关键词")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // 动效 off（合法用户偏好，state/useMotionPrefs 持久化项）：Layout 的
  // AnimatePresence mode="wait" 页面过渡会在导航后 ~400ms 重建页面树（前端
  // 已证实的 remount，会丢输入框状态）；off 时静态渲染无此窗口，输入行为
  // 断言不受过渡动画竞态影响。动效路径的专项断言由 animation-layout.spec.ts
  // 覆盖，此处测的是搜索功能行为。
  await page.addInitScript(() => localStorage.setItem("axiom:motion", "off"));
  await injectAuth(page);
});

test.describe("搜索 Hub（/search，Agent 工作区）", () => {
  test("文件菜单进入 /search：标题「搜索」、四个标签页与搜索输入框可见", async ({ page }) => {
    await openSearch(page);

    // PageHeader（components/ui/PageHeader.tsx）提供 h1 标题
    await expect(page.getByRole("heading", { name: "搜索", level: 1 })).toBeVisible();
    await expect(page.getByText("搜索笔记与代码、深度研究、趋势分析与文字识别。")).toBeVisible();

    // 搜索 Hub 的第一个 tablist（components/ui/Tabs.tsx，role=tablist / role=tab + aria-selected）
    const hub = page.getByRole("tablist").first();
    await expect(hub.getByRole("tab")).toHaveCount(4);
    await expect(hub.getByRole("tab")).toHaveText(["搜索", "深度研究", "趋势", "OCR"]);
    await expect(hub.getByRole("tab", { name: "搜索" })).toHaveAttribute("aria-selected", "true");
    await expect(hub.getByRole("tab", { name: "深度研究" })).toHaveAttribute("aria-selected", "false");

    // 默认搜索面板：aria-label 来自 components/search-panels.tsx 的 Input / 筛选 Button
    const input = page.getByLabel("搜索关键词");
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("placeholder", "搜索关键词…");
    await expect(page.getByRole("button", { name: "搜索设置" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // 渲染崩溃（App.tsx ErrorBoundary）一旦出现即失败
    await expect(page.getByText("页面渲染时发生意外错误")).toHaveCount(0);
  });

  test("输入关键词后值保持，清空输入后回到初始态（纯 UI 断言）", async ({ page }) => {
    // 只断言 UI 状态，不断言任何搜索端点的返回内容；搜索端点统一接住并
    // 返回空态，使面板停留在初始视图，断言不受网络内容影响。
    await stubSearch(page, { vault: [], code: { symbols: [] }, web: { results: [] } });

    await openSearch(page);
    const input = page.getByLabel("搜索关键词");

    // autoFocus 使面板挂载后输入框即获得焦点（components/search-panels.tsx
    // SearchPanel Input autoFocus），作为面板就绪的行为信号（非固定 sleep）。
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "搜索关键词",
    );
    await expect(input).toHaveValue("");

    await input.fill("量子纠缠");
    // 受控 Input：值立即回写且保持（不被 remount 重置）
    await expect(input).toHaveValue("量子纠缠");
    // 焦点仍在输入框上（未被任何重置打断）
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "搜索关键词",
    );
    await expect(input).toHaveValue("量子纠缠");

    // 清空输入：回到初始态（纯 UI，不断言任何网络返回内容）
    await input.fill("");
    await expect(input).toHaveValue("");
    await expect(page.getByText(/共 \d+ 条结果/)).toHaveCount(0);
    await expect(page.getByText("没有匹配结果")).toHaveCount(0);
  });

  test("搜索设置可展开：切到「代码」范围后只请求 /codegraph/search", async ({ page }) => {
    const traffic = trackTraffic(page);
    await stubSearch(page, {
      vault: [{ title: "不应出现的笔记" }],
      code: { symbols: [{ name: "quantum_fn", filePath: "src/quantum.ts" }] },
      web: [{ title: "不应出现的网页" }],
    });

    await openSearch(page);
    const filter = page.getByRole("button", { name: "搜索设置" });
    await expect(filter).toHaveAttribute("aria-expanded", "false");
    await filter.click();
    await expect(filter).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("搜索范围")).toBeVisible();
    for (const name of ["全部", "笔记", "代码", "全网"]) {
      await expect(page.getByRole("button", { name })).toBeVisible();
    }

    await page.getByRole("button", { name: "代码" }).click();
    await page.getByLabel("搜索关键词").fill("quantum_fn");

    // 仅代码端点被请求且其结果被渲染
    await expect(page.getByText("共 1 条结果")).toBeVisible();
    await expect(page.getByText("quantum_fn")).toBeVisible();
    await expect(page.getByText("不应出现的笔记")).toHaveCount(0);

    expect(traffic.hits).toHaveLength(1);
    expect(traffic.hits[0]).toEqual({ pathname: "/codegraph/search", q: "quantum_fn" });
    expect(traffic.external).toEqual([]);
  });

  test("切换标签页更新 URL 与选中态并渲染对应面板，后退按 URL 恢复面板", async ({ page }) => {
    // 趋势/OCR 面板挂载即拉取本地数据；夹具保证内容确定且不依赖后端状态
    await page.route((url) => url.pathname === "/stats/trends", (route) =>
      route.fulfill(
        json({
          days: 7,
          searchTrend: [{ day: "2026-10-19", count: 42 }],
          chatTrend: [],
          modelTrend: [],
          taskTrend: [],
          generatedAt: "2026-10-19T00:00:00Z",
        }),
      ),
    );
    await page.route((url) => url.pathname === "/ocr/status", (route) =>
      route.fulfill(json({ status: "ready", supportedLanguages: ["eng", "chi_sim"] })),
    );

    await openSearch(page);
    const hub = page.getByRole("tablist").first();

    await hub.getByRole("tab", { name: "深度研究" }).click();
    await expect(page).toHaveURL(/\/search\?tab=research$/);
    await expect(hub.getByRole("tab", { name: "深度研究" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("heading", { name: "研究问题" })).toBeVisible();
    await expect(page.getByPlaceholder("输入研究问题")).toBeVisible();
    await expect(page.getByRole("button", { name: "开始研究" })).toBeDisabled();
    await expect(page.getByLabel("搜索关键词")).toHaveCount(0);

    await hub.getByRole("tab", { name: "趋势" }).click();
    await expect(page).toHaveURL(/\/search\?tab=trends$/);
    await expect(page.getByText("搜索、对话、模型调用、任务的趋势统计。")).toBeVisible();
    await expect(page.getByText("总搜索量")).toBeVisible();
    await expect(page.getByText("42", { exact: true })).toBeVisible();

    await hub.getByRole("tab", { name: "OCR" }).click();
    await expect(page).toHaveURL(/\/search\?tab=ocr$/);
    await expect(page.getByRole("heading", { name: "扫描文档" })).toBeVisible();
    await expect(page.getByRole("status", { name: "OCR 就绪" })).toBeVisible();
    await expect(page.getByLabel("文件路径")).toBeVisible();

    // 浏览器后退：URL ?tab=trends 决定面板（useSearchParams 受控），无需重新加载页面
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?tab=trends$/);
    await expect(page.getByText("搜索、对话、模型调用、任务的趋势统计。")).toBeVisible();

    // 回到默认标签：URL 去掉 tab 参数并重新挂载搜索面板
    await hub.getByRole("tab", { name: "搜索" }).click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.getByLabel("搜索关键词")).toHaveValue("");
    await expect(hub.getByRole("tab", { name: "搜索" })).toHaveAttribute("aria-selected", "true");
  });

  test("无匹配时显示空状态，清空输入后结果与计数消失", async ({ page }) => {
    const traffic = trackTraffic(page);
    await stubSearch(page, { vault: [], code: { symbols: [] }, web: { results: [] } });

    await openSearch(page);
    const input = page.getByLabel("搜索关键词");
    // autoFocus 落位 = 搜索面板已挂载完成（行为信号，非固定 sleep）。
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "搜索关键词",
    );
    await input.fill("no-such-result-xyz");

    await expect(input).toHaveValue("no-such-result-xyz");
    await expect(page.getByText("没有匹配结果")).toBeVisible();
    await expect(page.getByText(/共 \d+ 条结果/)).toHaveCount(0);
    expect(traffic.hits).toHaveLength(3);
    expect(traffic.hits.every((h) => h.q === "no-such-result-xyz")).toBe(true);

    // 清空后回到初始态：无空状态、无计数，也不再发起请求
    await input.fill("");
    await expect(input).toHaveValue("");
    await expect(page.getByText("没有匹配结果")).toHaveCount(0);
    await expect(page.getByText(/共 \d+ 条结果/)).toHaveCount(0);
    expect(traffic.hits).toHaveLength(3);
    expect(traffic.external).toEqual([]);
  });
});
