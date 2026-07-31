/**
 * 运行时审查 CLI — 资源有界性/内存泄漏/会话流清理/冗余兜底 14 项检查
 *
 * 用法：bun run audit:runtime
 * 退出码：fail=1；pass/warn=0
 */
import { runRuntimeAudit } from "../src/core/runtime-audit.js";

const report = await runRuntimeAudit();

console.log(`[audit:runtime] overall=${report.overall} (${new Date(report.timestamp).toISOString()})`);
for (const line of report.summary) console.log(`  ${line}`);
if (report.recommendations.length > 0) {
  console.log("recommendations:");
  for (const r of report.recommendations) console.log(`  - ${r}`);
}
process.exit(report.overall === "fail" ? 1 : 0);