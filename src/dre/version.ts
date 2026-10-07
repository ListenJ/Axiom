/**
 * DRE 子系统版本——单一来源。
 *
 * 放在叶子模块（不 import 任何 DRE 子模块）的原因：`engine.ts` 的 `healthCheck()`
 * 需要引用它，而 `index.ts`（barrel）又导出 `engine`；若常量留在 `index.ts`，
 * `engine → index → engine` 会构成循环导入（被 architecture-integrity 门禁判红）。
 */
export const DRE_VERSION = "3.1.0";
