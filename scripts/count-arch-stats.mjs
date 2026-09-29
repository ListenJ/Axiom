/**
 * 架构基线统计 CLI（逻辑单一事实源：src/testing/arch-stats.ts）
 *
 * 用法：`bun run arch:stats`（或 `bun run scripts/count-arch-stats.mjs`）
 *
 * 输出 §1 可粘贴片段；数值由 tests/unit/docs-consistency.test.ts 与
 * docs/ARCHITECTURE.md §1 做精确相等断言（棘轮：改了 src 就要重跑本命令同步文档）。
 */
import { archStats, archStatsSnippet } from "../src/testing/arch-stats.ts";

const stats = archStats();
console.log(JSON.stringify(stats, null, 2));
console.log(`\n片段：${archStatsSnippet(stats)}`);
