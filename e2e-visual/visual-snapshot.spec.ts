import { test, expect, type Page } from "@playwright/test";
import { installVisualMocks } from "./visual-mock";

/**
 * T1.3 像素基线（Desktop Chrome 单视口，ADR-001/002）
 *
 * 范围：全 21 页（ADR-002 表决"全量截图"）。清单为单一事实源（下方 PAGES），
 * 与 App.tsx 路由一一对应；契约附录 A 原引 DEFAULT_AUDIT_PAGES 仅 9 页，
 * 已被 ADR-002 更新为全量，见 ops log 偏差记录。
 *
 * 容差（ADR-001）：threshold 0.2 + maxDiffPixelRatio 0.002，动态区显式 mask。
 * 基线生成：`--update-snapshots` 首跑落 PNG；复跑不带该参数即门禁（二跑零 diff = 验收 2）。
 *
 * 就绪判据：App 的 Suspense fallback 带 aria-label="页面加载中"（App.tsx:32），
 * 等其消失 + networkidle + fonts.ready = 懒加载页面主体稳定渲染，跨页统一。
 */

// ADR-001 容差：抗锯齿起步
const SCREENSHOT_OPTS = {
  animations: "disabled" as const,
  threshold: 0.2,
  maxDiffPixelRatio: 0.002,
};

type PageCase = { path: string; name: string; anchor?: string };

// 单一事实源：21 页（App.tsx 路由 + login）
const PAGES: PageCase[] = [
  { path: "/chat", name: "chat", anchor: "会话题目" },
  { path: "/search", name: "search", anchor: "搜索" },
  { path: "/code", name: "code", anchor: "代码" },
  { path: "/agents", name: "agents", anchor: "智能体" },
  { path: "/router", name: "router", anchor: "模型路由" },
  { path: "/vault", name: "vault", anchor: "知识库" },
  { path: "/kg", name: "kg", anchor: "知识图谱" },
  { path: "/sessions", name: "sessions", anchor: "会话管理" },
  { path: "/eval", name: "eval", anchor: "模型评估" },
  { path: "/plugins", name: "plugins", anchor: "插件市场" },
  { path: "/trends", name: "trends", anchor: "趋势分析" },
  { path: "/ocr", name: "ocr", anchor: "OCR 文字识别" },
  { path: "/research", name: "research", anchor: "深度研究" },
  { path: "/knowledge", name: "knowledge", anchor: "知识库" },
  { path: "/proxies", name: "proxies", anchor: "代理管理" },
  { path: "/providers", name: "providers", anchor: "Provider 管理" },
  { path: "/tokens", name: "tokens", anchor: "Token 消耗分析" },
  { path: "/perf", name: "perf", anchor: "性能" },
  { path: "/git", name: "git" },
  { path: "/settings", name: "settings", anchor: "设置" },
  { path: "/login", name: "login", anchor: "需要身份验证" },
];

async function waitReady(page: Page, anchor?: string): Promise<void> {
  await page.waitForLoadState("networkidle");
  // 只等 App 的 Suspense fallback（专属 aria-label）消失 = 懒加载页面主体挂载。
  // 不能用通用 [aria-busy]：页面级空态（如 Agents 空列表）也带 aria-busy，会常驻。
  await page
    .getByLabel("页面加载中")
    .waitFor({ state: "detached", timeout: 10000 })
    .catch(() => {
      /* 从未出现 fallback（非懒加载页）视为已就绪 */
    });
  // 字体就绪：避免 FOUT 造成的像素抖动（契约 §3.2）
  await page.evaluate(() => document.fonts.ready);
  if (anchor) {
    // anchor 可能是 heading 文本或 aria-label（chat 用输入框标签）
    const byHeading = page.getByRole("heading", { name: anchor });
    const byLabel = page.getByLabel(anchor);
    await expect(byHeading.or(byLabel).first()).toBeVisible({ timeout: 10000 });
  }
}

for (const { path, name, anchor } of PAGES) {
  test(`视觉基线 ${path}`, async ({ page }) => {
    await installVisualMocks(page);
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await waitReady(page, anchor);
    await expect(page).toHaveScreenshot(`${name}.png`, SCREENSHOT_OPTS);
  });
}
