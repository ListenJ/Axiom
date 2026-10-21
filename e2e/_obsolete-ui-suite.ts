/**
 * 过时 UI 规格的统一 skip 声明（2026-10-21）。
 *
 * 背景（实测证据）：前端在 2026-10 重构为「Agent 工作区」形态后，
 * - `App.tsx` 路由中**已无 `/chat`**，根路径重定向 `/agents`；
 * - 旧规格依赖 `#home-input`、`getByLabel('打开摘要')`、`getByRole('button', { name: '视图' })`
 *   等选择器，这些在 `frontend/src` 中已不存在；
 * - 2026-10-21 本地全量跑（已构建前端并入 public/）：**11/12 规格失败**，单文件 14–155s，
 *   总耗时约 17.5 分钟，全部是 30s 测试超时累积 → 不是死锁，是规格与实现脱节。
 *
 * 处置：保留旧规格（不删除）但**显式 skip 并给出理由**，避免「整批静默消失」或
 * 「每次 CI 跑十几分钟全部超时」两种坏结局；重写推进记录见
 * `docs/plans/2026-10-20-delivery-guardrails.md`。新的可执行信号见 `e2e/smoke.spec.ts`。
 */
import { test } from "@playwright/test";

export function skipObsoleteUiSuite(): void {
  test.skip(
    true,
    "UI 重构后过时：当前前端无 /chat 路由与旧选择器（详见 docs/plans/2026-10-20-delivery-guardrails.md §14）；待按当前前端重写",
  );
}
