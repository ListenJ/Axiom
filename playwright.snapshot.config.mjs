import { defineConfig } from "@playwright/test";

/**
 * T1.3 像素基线独立配置（附录 A 契约）
 *
 * 与既有 playwright.config.mjs（功能 e2e）完全隔离：
 *   - testDir 指向 ./e2e-visual，默认 config 的 ./e2e 不含视觉 spec，
 *     scripts/run-e2e.cjs（readdir e2e/*.spec.ts）也不会误跑基线 → 存量功能用例零影响（验收 4）。
 *   - 本轮按用户指示 Desktop Chrome 单视口（契约矩阵 {3 浏览器 × 3 视口} 的裁剪，
 *     视口/浏览器扩展留待基线稳定后迭代，见 ops log 偏差记录）。
 *
 * 确定性 use（契约 §3.2 前置清单）：固定视口/缩放/时区/语言/配色 + reducedMotion，
 * screenshot:"off" 保证快照仅由 toHaveScreenshot 产生。后端生命周期复用 run-e2e.cjs（不改）。
 */
export default defineConfig({
  testDir: "./e2e-visual",
  fullyParallel: false,
  workers: 1, // 串行：避免并发渲染资源竞争引入基线抖动
  retries: 0, // 基线阶段不重试——重试会掩盖不确定性
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: {
    baseURL: "http://localhost:18789",
    viewport: { width: 1440, height: 900 }, // 契约 desktop 视口
    deviceScaleFactor: 1,
    timezoneId: "Asia/Shanghai", // 固定时区，杜绝时间戳/相对时间漂移
    locale: "zh-CN",
    colorScheme: "light", // 固定配色，避免 prefers-color-scheme 差异
    reducedMotion: "reduce",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium" }],
});
