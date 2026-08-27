/**
 * Agent 评测报告 — Markdown / JSON 输出。
 */
import type { MetricsSummary, TaskResult } from "./metrics.js";

export function toMarkdown(summary: MetricsSummary, results: TaskResult[]): string {
  const lines: string[] = [];
  lines.push("# Agent 能力边界评测报告");
  lines.push("");
  lines.push(`- 任务数: ${summary.total} ｜ 通过: ${summary.passed} ｜ 通过率: ${summary.passRate}%`);
  lines.push(`- train 通过率: ${summary.trainRate}% ｜ held-out 通过率: ${summary.heldOutRate}%`);
  lines.push(
    summary.generalizationRatio === null
      ? "- held-out 泛化率: N/A（无 train 数据）"
      : `- held-out 泛化率: ${summary.generalizationRatio}（<1 表示过拟合训练分布）`,
  );
  lines.push(`- 平均延迟: ${summary.avgLatencyMs}ms ｜ 平均输出长度: ${summary.avgOutputLength}`);
  lines.push("");
  lines.push("## 分族结果");
  lines.push("");
  lines.push("| 任务族 | 通过率 | 通过/总数 |");
  lines.push("| --- | --- | --- |");
  for (const [family, m] of Object.entries(summary.byFamily)) {
    lines.push(`| ${family} | ${m.passRate}% | ${m.passed}/${m.total} |`);
  }
  lines.push("");
  lines.push("## 明细");
  lines.push("");
  lines.push("| ID | 族 | split | 通过 | 延迟(ms) | 模型 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    lines.push(`| ${r.taskId} | ${r.family} | ${r.split} | ${r.passed ? "✅" : "❌"} | ${r.latencyMs} | ${r.model} |`);
    if (!r.passed && r.reason) {
      lines.push(`  - 失败原因: ${r.reason}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function toJSON(summary: MetricsSummary, results: TaskResult[]): string {
  return JSON.stringify({ summary, results }, null, 2);
}
