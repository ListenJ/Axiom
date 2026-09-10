import type { Page, Route } from "@playwright/test";

/**
 * 视觉基线专用：确定性 API mock（ADR-001/002 首轮基线）
 *
 * 设计（规则 8 深模块：一个小接口 installVisualMocks，内部消化形状差异）：
 *   - catch-all 拦截，但只对 fetch/xhr 生效；document/script/stylesheet/image/font
 *     一律 route.fallback() 放行到真实后端（SPA 文档与 /assets 必须真实加载）。
 *   - 形状感知：侧栏/页面用 Array.isArray 判定的端点必须返回对应数组键，
 *     否则进 error 态（如 workspaces 缺 workspaces 键 → Sidebar 显示错误面板）。
 *   - 固定值：/health 的 uptime、version 写死，杜绝逐次变化。
 *   - 列表默认空数组 → 渲染确定的"空状态"，天然可复现（首轮基线取空/初始态）。
 */

/** 端点 → 确定性响应体（正则匹配 URL；命中即返回，未命中 fetch/xhr 走 DEFAULT_BODY）。 */
const FIXTURES: Array<{ match: RegExp; body: unknown }> = [
  // Sidebar：health（固定 uptime/version，否则每 30s 轮询变化）
  { match: /\/health(\?|$)/, body: { status: "ok", version: "baseline", uptime: 0 } },
  // Sidebar：workspaces（Array.isArray(w.value?.workspaces) 判定，缺键即 error 态）
  { match: /\/api\/workspaces/, body: { workspaces: [] } },
  // Sidebar + Sessions：memory/sessions
  { match: /\/memory\/sessions/, body: { sessions: [] } },
  // Sessions：memory/usage
  { match: /\/memory\/usage/, body: { usage: [] } },
  // Sessions：memory/conversations
  { match: /\/memory\/conversations/, body: { messages: [] } },
  // Chat：models（.filter(m=>m.enabled)，空数组走默认模型）
  { match: /\/models(\?|$)/, body: { models: [] } },
  // Chat：permissions/mode
  { match: /\/permissions\/mode/, body: { autoAccept: false, highRiskAlwaysConfirmed: true } },
  // Tokens：/api/token-details（页面 data={} truthy 即直读 data.overall.totalTokens，缺子对象即崩）
  {
    match: /\/api\/token-details/,
    body: {
      perModel: [],
      hourlyTrend: [],
      recentCalls: [],
      overall: { totalTokens: 0, totalCalls: 0, promptTokens: 0, completionTokens: 0, avgLatency: 0 },
      cacheStats: { totalCalls: 0, cacheHits: 0, hitRate: 0 },
    },
  },
  // 通用 stats 类（避免 NaN 图表）
  { match: /\/api\/stats|\/vault\/stats|\/kg\/stats|\/eval\/stats/, body: {} },
];

const DEFAULT_BODY: unknown = {};

function resolveBody(url: string): unknown {
  for (const f of FIXTURES) {
    if (f.match.test(url)) return f.body;
  }
  return DEFAULT_BODY;
}

/** 安装确定性 mock：必须在 page.goto 之前调用。 */
export async function installVisualMocks(page: Page): Promise<void> {
  await page.route("**/*", async (route: Route) => {
    const type = route.request().resourceType();
    // 只 mock 数据请求；页面文档与静态资源放行真实后端
    if (type !== "fetch" && type !== "xhr") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(resolveBody(route.request().url())),
    });
  });
}
