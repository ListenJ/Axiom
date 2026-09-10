/**
 * Agent 评测报告 — Markdown / JSON 输出。
 */
import type { MetricsSummary, TaskResult } from "./metrics.js";
import { clusterFailures } from "./report-extras.js";

export function toMarkdown(summary: MetricsSummary, results: TaskResult[]): string {
  const lines: string[] = [];
  lines.push("# Agent 能力边界评测报告");
  lines.push("");
  const errNote = summary.executionErrors > 0 ? ` ｜ 执行错误: ${summary.executionErrors}（不计入通过率分母）` : "";
  lines.push(`- 任务数: ${summary.total} ｜ 通过: ${summary.passed} ｜ 通过率: ${summary.passRate}%${errNote}`);
  lines.push(`- train 通过率: ${summary.trainRate}% ｜ held-out 通过率: ${summary.heldOutRate}%`);
  lines.push(
    summary.generalizationRatio === null
      ? "- held-out 泛化率: N/A（无 train 数据）"
      : `- held-out 泛化率: ${summary.generalizationRatio}（<1 表示过拟合训练分布）`,
  );
  // 分位为 null（样本 <3 无统计意义）时显示 "-"，不写 ms；保持「- 平均延迟:」前缀不变，不拆行。
  const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${v}ms`);
  lines.push(
    `- 平均延迟: ${summary.avgLatencyMs}ms ｜ p50: ${fmtPct(summary.latencyP50)} ｜ p95: ${fmtPct(summary.latencyP95)} ｜ p99: ${fmtPct(summary.latencyP99)} ｜ 平均输出长度: ${summary.avgOutputLength}`,
  );
  // P0-A 缓存命中段：仅当本轮有 provider 缓存命中数据时输出（保持无数据轮次输出形态不变）。
  if (summary.totalCacheHitTokens !== null) {
    lines.push(`- 缓存命中: ${summary.totalCacheHitTokens} tokens ｜ 平均 ${summary.avgCacheHitTokens}/调用`);
  }
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
  lines.push("| ID | 族 | split | 通过 | 延迟(ms) | 模型 | 备注 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const status = r.executionError ? "⚠️" : r.passed ? "✅" : "❌";
    const note = r.executionError ? "执行错误" : "";
    lines.push(`| ${r.taskId} | ${r.family} | ${r.split} | ${status} | ${r.latencyMs} | ${r.model} | ${note} |`);
    if (r.executionError && r.reason) {
      lines.push(`  - 执行错误: ${r.reason}`);
    } else if (!r.passed && r.reason) {
      lines.push(`  - 失败原因: ${r.reason}`);
    }
  }
  // S5 失败聚类段：仅在有失败轮次时输出（全绿轮次省略段，输出逐字节不变）。
  const clusters = clusterFailures(results);
  if (clusters.length > 0) {
    lines.push("## 失败聚类");
    lines.push("");
    lines.push("| 桶 | 数量 | 代表样例 |");
    lines.push("| --- | --- | --- |");
    for (const c of clusters) {
      lines.push(`| ${c.bucket} | ${c.count} | ${c.samples.join("；")} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function toJSON(summary: MetricsSummary, results: TaskResult[]): string {
  return JSON.stringify({ summary, results, failures: clusterFailures(results) }, null, 2);
}
