/**
 * 过时 UI 规格的 skip 声明（2026-10-22 重写+裁定后）。
 *
 * 背景（实测证据）：前端在 2026-10 重构为「Agent 工作区」形态后，
 * - `App.tsx` 路由中**已无 `/chat`**，根路径重定向 `/agents`；
 * - 旧规格依赖 `#home-input`、`getByLabel('打开摘要')`、`getByRole('button', { name: '视图' })`
 *   等选择器，这些在 `frontend/src` 中已不存在；
 * - 2026-10-21 本地全量跑（已构建前端并入 public/）：**11/12 规格失败**，单文件 14–155s，
 *   总耗时约 17.5 分钟，全部是 30s 测试超时累积 → 不是死锁，是规格与实现脱节。
 *
 * 2026-10-22 裁定（Lead）：9 个规格已按当前实现重写并通过（pages/keyboard/theme/search/
 * settings/responsive/terminal-summary 等）；下列 3 个**保留 skip 且不重写**，理由逐条见调用点：
 *   - animation-layout：动画中间态断言在 CI 上不稳定，可验证行为已由 terminal-summary/responsive 覆盖；
 *   - perf：性能阈值在共享 runner 上抖动大，会制造 flake；性能回归由 `audit:runtime`/Stress Gate 承担；
 *   - frontend-backend-integration：需要真实后端数据形状，脆弱；渲染面由 pages/smoke 覆盖，接口契约由单元测试覆盖。
 * 重写推进记录见 `docs/plans/2026-10-20-delivery-guardrails.md`。
 */
import { test } from "@playwright/test";

export function skipObsoleteUiSuite(reason?: string): void {
  test.skip(
    true,
    reason ??
      "UI 重构后过时：当前前端无 /chat 路由与旧选择器；已裁定保留备查，不重写（见 _obsolete-ui-suite.ts 顶部）",
  );
}
