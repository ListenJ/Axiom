/**
 * Evaluation Reporter — generates JSON and Markdown reports
 */
import type { EvaluatedResponse, JudgeScore } from "./judge.js";
import type { EvalTestCase } from "./test-cases.js";
import { EVAL_DIMENSIONS, getTestCasesByDimension } from "./test-cases.js";

// ===== Types =====

export interface ModelSummary {
  model: string;
  totalTests: number;
  overallScore: number;
  grade: string;
  dimensions: Record<string, { avg: number; passRate: number; count: number }>;
  latency: { avgMs: number; avgTtftMs: number };
  cost: { total: number; avgPerTest: number };
  topStrengths: string[];
  topWeaknesses: string[];
}

export interface EvalReport {
  title: string;
  timestamp: string;
  models: string[];
  testCount: number;
  judgeModel: string;
  results: EvaluatedResponse[];
  summaries: ModelSummary[];
  comparison: {
    bestOverall: { model: string; score: number };
    bestByDimension: Record<string, { model: string; score: number }>;
    fastestModel: { model: string; avgLatency: number };
    cheapestModel: { model: string; totalCost: number };
  };
  recommendations: string[];
}

// ===== Report Generation =====

export function generateReport(
  results: EvaluatedResponse[],
  models: string[],
  judgeModel: string
): EvalReport {
  const summaries = models.map((model) => buildModelSummary(results, model));

  const report: EvalReport = {
    title: "Axiom Agent Model Evaluation Report",
    timestamp: new Date().toISOString(),
    models,
    testCount: results.length,
    judgeModel,
    results,
    summaries,
    comparison: buildComparison(summaries, results),
    recommendations: generateRecommendations(summaries),
  };

  return report;
}

// ===== Model Summary =====

function buildModelSummary(results: EvaluatedResponse[], model: string): ModelSummary {
  const modelResults = results.filter((r) => r.response.model === model);
  const scores = modelResults.map((r) => r.overallScore);
  const avgScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
    : 0;

  // Per-dimension
  const dimensions: Record<string, { avg: number; passRate: number; count: number }> = {};
  for (const dim of EVAL_DIMENSIONS) {
    const dimResults = modelResults.filter((r) => r.testCase.dimension === dim);
    const dimScores = dimResults.map((r) => r.overallScore);
    dimensions[dim] = {
      avg: dimScores.length > 0 ? Math.round(dimScores.reduce((a, b) => a + b, 0) / dimScores.length * 10) / 10 : 0,
      passRate: dimScores.length > 0 ? Math.round(dimScores.filter((s) => s >= 60).length / dimScores.length * 100) : 0,
      count: dimScores.length,
    };
  }

  // Latency
  const latencies = modelResults.map((r) => r.response.latencyMs);
  const ttfts = modelResults.map((r) => r.response.ttftMs);
  const latency = {
    avgMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    avgTtftMs: ttfts.length > 0 ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0,
  };

  // Cost
  const costs = modelResults.map((r) => r.response.cost);
  const totalCost = Math.round(costs.reduce((a, b) => a + b, 0) * 10000) / 10000;
  const cost = {
    total: totalCost,
    avgPerTest: modelResults.length > 0 ? Math.round(totalCost / modelResults.length * 10000) / 10000 : 0,
  };

  // Strengths & Weaknesses
  const strengths = new Map<string, number>();
  const weaknesses = new Map<string, number>();
  for (const r of modelResults) {
    const explain = r.scores[0]?.explanation || "";
    if (r.overallScore >= 70) {
      strengths.set(r.testCase.category, (strengths.get(r.testCase.category) || 0) + 1);
    }
    if (r.overallScore < 60) {
      weaknesses.set(r.testCase.category, (weaknesses.get(r.testCase.category) || 0) + 1);
    }
  }

  return {
    model,
    totalTests: modelResults.length,
    overallScore: avgScore,
    grade: avgScore >= 85 ? "A" : avgScore >= 70 ? "B" : avgScore >= 55 ? "C" : avgScore >= 40 ? "D" : modelResults.every((r) => r.grade === "N/A") ? "N/A" : "F",
    dimensions,
    latency,
    cost,
    topStrengths: [...strengths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k),
    topWeaknesses: [...weaknesses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k),
  };
}

// ===== Comparison =====

function buildComparison(
  summaries: ModelSummary[],
  results: EvaluatedResponse[]
): EvalReport["comparison"] {
  if (summaries.length === 0) {
    return {
      bestOverall: { model: "N/A", score: 0 },
      bestByDimension: {},
      fastestModel: { model: "N/A", avgLatency: 0 },
      cheapestModel: { model: "N/A", totalCost: Infinity },
    };
  }

  const bestOverall = summaries.reduce((best, s) => s.overallScore > best.score ? { model: s.model, score: s.overallScore } : best, { model: "", score: 0 });

  const bestByDimension: Record<string, { model: string; score: number }> = {};
  for (const dim of EVAL_DIMENSIONS) {
    let best: { model: string; score: number } = { model: "N/A", score: 0 };
    for (const s of summaries) {
      const dimScore = s.dimensions[dim]?.avg || 0;
      if (dimScore > best.score) best = { model: s.model, score: dimScore };
    }
    bestByDimension[dim] = best;
  }

  const fastest = summaries.reduce((best, s) => s.latency.avgMs < best.avgLatency && s.latency.avgMs > 0 ? { model: s.model, avgLatency: s.latency.avgMs } : best, { model: summaries[0]?.model || "N/A", avgLatency: Infinity });

  const cheapest = summaries.reduce((best, s) => s.cost.total < best.totalCost ? { model: s.model, totalCost: s.cost.total } : best, { model: summaries[0]?.model || "N/A", totalCost: Infinity });

  return { bestOverall, bestByDimension, fastestModel: fastest, cheapestModel: cheapest };
}

// ===== Recommendations =====

function generateRecommendations(summaries: ModelSummary[]): string[] {
  const recs: string[] = [];

  // Best model per role
  for (const s of summaries) {
    if (s.grade === "A") {
      recs.push(`✅ ${s.model}: Overall A-grade (${s.overallScore}/100) — suitable for general tasks`);
    }
    for (const [dim, data] of Object.entries(s.dimensions)) {
      if (data.avg >= 85 && data.count >= 3) {
        const existing = recs.findIndex((r) => r.includes(dim));
        if (existing === -1) {
          recs.push(`🎯 ${s.model} excels at ${dim} (avg ${data.avg}) — recommend for ${dim}-heavy workflows`);
        }
      }
    }
  }

  // Speed recommendations
  const fastest = summaries.sort((a, b) => a.latency.avgMs - b.latency.avgMs)[0];
  if (fastest && fastest.latency.avgMs > 0) {
    recs.push(`⚡ ${fastest.model} is fastest (avg ${fastest.latency.avgMs}ms) — use for latency-sensitive tasks`);
  }

  // Cost recommendations
  const cheapest = summaries.sort((a, b) => a.cost.total - b.cost.total)[0];
  if (cheapest && cheapest.cost.total < 0.01) {
    recs.push(`💰 ${cheapest.model} is cheapest ($${cheapest.cost.total}) — use for high-volume tasks`);
  }

  // Weakness warnings
  for (const s of summaries) {
    if (s.grade === "F") {
      recs.push(`⚠️ ${s.model}: Overall F-grade (${s.overallScore}/100) — not recommended for production`);
    }
    const weakDims = Object.entries(s.dimensions).filter(([, d]) => d.passRate < 50 && d.count >= 3);
    for (const [dim] of weakDims) {
      recs.push(`⚠️ ${s.model} struggles with ${dim} (${s.dimensions[dim].passRate}% pass rate)`);
    }
  }

  return recs;
}

// ===== Markdown Export =====

export function toMarkdown(report: EvalReport): string {
  const lines: string[] = [
    `# ${report.title}`,
    "",
    `**Generated**: ${report.timestamp}`,
    `**Judge Model**: ${report.judgeModel}`,
    `**Models Evaluated**: ${report.models.join(", ")}`,
    `**Test Cases**: ${report.testCount} total (${EVAL_DIMENSIONS.map((d) => `${d}: ${getTestCasesByDimension(d).length}`).join(", ")})`,
    "",
    "---",
    "",
    "## 📊 Overall Rankings",
    "",
    "| Model | Score | Grade | Latency (avg) | TTFT (avg) | Cost | Pass Rate |",
    "|-------|-------|-------|---------------|------------|------|-----------|",
    ...report.summaries.map((s) => {
      const passTests = report.results.filter((r) => r.response.model === s.model && r.overallScore >= 60).length;
      return `| ${s.model} | ${s.overallScore} | ${s.grade} | ${s.latency.avgMs}ms | ${s.latency.avgTtftMs}ms | $${s.cost.total.toFixed(4)} | ${passTests}/${s.totalTests} (${s.totalTests > 0 ? Math.round(passTests / s.totalTests * 100) : 0}%) |`;
    }),
    "",
    "## 📈 Dimension Scores",
    "",
    "| Model | Capability | Safety | Performance | Robustness |",
    "|-------|-----------|--------|-------------|------------|",
    ...report.summaries.map((s) =>
      `| ${s.model} | ${s.dimensions.capability?.avg || "-"} (${s.dimensions.capability?.passRate || 0}%) | ${s.dimensions.safety?.avg || "-"} (${s.dimensions.safety?.passRate || 0}%) | ${s.dimensions.performance?.avg || "-"} (${s.dimensions.performance?.passRate || 0}%) | ${s.dimensions.robustness?.avg || "-"} (${s.dimensions.robustness?.passRate || 0}%) |`
    ),
    "",
    "## 🏆 Comparison",
    "",
    `- **Best Overall**: ${report.comparison.bestOverall.model} (${report.comparison.bestOverall.score})`,
    `- **Fastest**: ${report.comparison.fastestModel.model} (${report.comparison.fastestModel.avgLatency}ms avg)`,
    `- **Cheapest**: ${report.comparison.cheapestModel.model} ($${report.comparison.cheapestModel.totalCost.toFixed(4)})`,
    ...EVAL_DIMENSIONS.map((d) => `- **Best ${d}**: ${report.comparison.bestByDimension[d]?.model || "N/A"} (${report.comparison.bestByDimension[d]?.score || 0})`),
    "",
    "## 📋 Detailed Results",
    "",
  ];

  // Per-model details
  for (const model of report.models) {
    const modelResults = report.results.filter((r) => r.response.model === model);
    lines.push(`### ${model}`);
    lines.push("");
    lines.push("| ID | Dimension | Category | Score | Grade | Latency | Tokens | Cost |");
    lines.push("|----|-----------|----------|-------|-------|---------|--------|------|");
    for (const r of modelResults) {
      lines.push(
        `| ${r.testCase.id} | ${r.testCase.dimension} | ${r.testCase.category} | ${r.overallScore} | ${r.grade} | ${r.response.latencyMs}ms | ${r.response.tokensUsed} | $${r.response.cost.toFixed(6)} |`
      );
    }
    lines.push("");
  }

  // Recommendations
  lines.push("## 💡 Recommendations");
  lines.push("");
  for (const rec of report.recommendations) {
    lines.push(`- ${rec}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ===== JSON Export =====

export function toJSON(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}
