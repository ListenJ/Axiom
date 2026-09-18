import { defineConfig } from "@playwright/test";

/**
 * 像素基线独立配置（附录 A 契约；T2.1 扩展为 3 浏览器 × 3 视口矩阵）
 *
 * 与既有 playwright.config.mjs（功能 e2e）完全隔离：
 *   - testDir 指向 ./e2e-visual，默认 config 的 ./e2e 不含视觉 spec，
 *     scripts/run-e2e.cjs（readdir e2e/*.spec.ts）也不会误跑基线 → 存量功能用例零影响（验收 4）。
 *   - T1.3 首轮 Desktop Chrome 单视口；T2.1（2026-09-11）按契约附录 A 矩阵扩展为
 *     chromium/firefox/webkit × desktop/tablet/mobile 共 9 组合。
 *   - 命名兼容：desktop-chromium 项目名保持 "chromium"，使 T1.3 的 21 个
 *     *-chromium-win32.png 基线零重生成（快照文件名模板含 {project}）。
 *   - 平台一致性：基线为 win32 产物，CI 门禁 job 须跑 windows runner（跨平台字体渲染
 *     差异远超 ADR-001 容差，linux 基线需另行生成并走 PR 人审更新，勿混用）。
 *
 * 确定性 use（契约 §3.2 前置清单）：固定视口/缩放/时区/语言/配色 + reducedMotion，
 * screenshot:"off" 保证快照仅由 toHaveScreenshot 产生。后端生命周期复用 run-e2e.cjs（不改）。
 * 全部视口统一 deviceScaleFactor:1（不采用 devices 预设的 dpr/touch，杜绝矩阵内缩放差异）。
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
  projects: [
    // desktop 1440×900 / tablet 768×1024 / mobile 390×844（契约附录 A 视口清单）
    // 首列 chromium + desktop 沿用 T1.3 项目名 "chromium" → 既有 21 基线零重生成
    // webkit-desktop 已移除（2026-09-11 T2.1 实测：Windows WebKit 在 1440×900 并发渲染
    // 不稳定——4 worker 下 6 页连拍 2% 差异不自稳，串行 workers=1 则 6/6 通过；
    // 恢复条件：CI 强制 workers=1 或 macOS runner。详见 ADR-002 附录）
    { name: "chromium", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "chromium-tablet", use: { browserName: "chromium", viewport: { width: 768, height: 1024 } } },
    { name: "chromium-mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 } } },
    // firefox/webkit 基线暂不入仓（矩阵全量 88.78MB > ADR-003 的 50MB 阈值；
    // 待 LFS 服务端验证后启用，见 ADR-003b 待办）。本地保留定义以便生成与调试。
    { name: "firefox-desktop", use: { browserName: "firefox", viewport: { width: 1440, height: 900 } } },
    { name: "firefox-tablet", use: { browserName: "firefox", viewport: { width: 768, height: 1024 } } },
    { name: "firefox-mobile", use: { browserName: "firefox", viewport: { width: 390, height: 844 } } },
    { name: "webkit-tablet", use: { browserName: "webkit", viewport: { width: 768, height: 1024 } } },
    { name: "webkit-mobile", use: { browserName: "webkit", viewport: { width: 390, height: 844 } } },
  ],
});
