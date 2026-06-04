/**
 * Model Evaluation CLI — 扩展版 eval-runner
 *
 * Usage:
 *   bun run src/eval/eval-cli.ts eval [--full] [--models=deepseek,kimi] [--benchmarks]
 *   bun run src/eval/eval-cli.ts assign [--force]
 *   bun run src/eval/eval-cli.ts stats
 *   bun run src/eval/eval-cli.ts results [--top=10]
 *   bun run src/eval/eval-cli.ts trend <modelId> [--days=30]
 *
 * 与 eval-runner.ts 的区别:
 *   - eval-runner.ts: 基于本地测试用例 + LLM Judge 的评估
 *   - eval-cli.ts: 基于 OpenRouter API + 网络基准数据的评估
 */

import { getModelEvalService, type ModelEvalResult } from "./model-eval-service.js";
import { getDynamicModelAssigner } from "../router/dynamic-model-assigner.js";

// ===== CLI Args =====
const args = Bun.argv.slice(2);
const command = args[0];

const flags = {
  full: args.includes("--full"),
  benchmarks: args.includes("--benchmarks") || args.includes("--bench"),
  force: args.includes("--force"),
  json: args.includes("--json"),
};

function getFlag(name: string): string | undefined {
  const flag = args.find(a => a.startsWith(`--${name}=`));
  return flag?.split("=")[1];
}

// ===== Commands =====

async function cmdEval() {
  const service = getModelEvalService();
  const modelFilter = getFlag("models")?.split(",");
  const includeBenchmarks = flags.benchmarks || flags.full;

  console.log("\n🔬 OpenClaw Model Evaluation Service");
  console.log(`   Mode: ${flags.full ? "full" : "quick"}`);
  console.log(`   Benchmarks: ${includeBenchmarks ? "enabled" : "disabled"}`);
  console.log(`   Models: ${modelFilter ? modelFilter.join(", ") : "all"}`);
  console.log("");

  let results: ModelEvalResult[];

  if (flags.full) {
    console.log("📡 Running full evaluation (this may take a few minutes)...");
    results = await service.runFullEvaluation({
      models: modelFilter,
      includeBenchmarks,
    });
  } else {
    console.log("⚡ Running quick evaluation...");
    results = await service.quickEvaluation();
  }

  console.log(`\n✅ Evaluated ${results.length} models\n`);

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Table output
  console.log("┌────────────────────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ Model                                      │ Cap │ Spd │ Cost│ Saf │ Ovr │ Free │ Roles            │");
  console.log("├────────────────────────────────────────────────────────────────────────────────────────────┤");

  const sorted = results.sort((a, b) => b.scores.overall - a.scores.overall);
  for (const r of sorted.slice(0, 30)) {
    const name = r.modelId.padEnd(42).slice(0, 42);
    const cap = String(r.scores.capability).padStart(3);
    const spd = String(r.scores.speed).padStart(3);
    const cost = String(r.scores.cost).padStart(3);
    const saf = String(r.scores.safety).padStart(3);
    const ovr = String(r.scores.overall).padStart(3);
    const free = r.metadata.isFree ? " ✓  " : "    ";
    const roles = (r.recommendation?.bestRoles || []).slice(0, 2).join(", ").padEnd(16).slice(0, 16);
    console.log(`│ ${name} │ ${cap} │ ${spd} │ ${cost} │ ${saf} │ ${ovr} │ ${free} │ ${roles} │`);
  }

  console.log("└────────────────────────────────────────────────────────────────────────────────────────────┘");

  // Summary stats
  const stats = service.getStats();
  console.log(`\n📊 Database: ${stats.totalEvaluations} total evaluations, ${stats.modelsEvaluated} unique models`);
  if (stats.lastEvalAt) {
    console.log(`   Last eval: ${stats.lastEvalAt}`);
  }

  if (stats.topModels.length > 0) {
    console.log("\n🏆 Top 5 Models:");
    for (const m of stats.topModels.slice(0, 5)) {
      console.log(`   ${m.modelId}: ${m.overall}/100`);
    }
  }
}

async function cmdAssign() {
  const assigner = getDynamicModelAssigner();

  console.log("\n🎯 OpenClaw Dynamic Model Assignment");
  console.log(`   Force refresh: ${flags.force ? "yes" : "no"}`);
  console.log("");

  console.log("📡 Running assignment...");
  const report = await assigner.runAssignment({
    forceRefresh: flags.force,
    includeBenchmarks: flags.benchmarks || flags.force,
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n✅ Assignment complete`);
  console.log(`   Evaluated: ${report.evaluatedModels} models`);
  console.log(`   Assigned: ${report.assignedModels} models`);
  console.log(`   Unassigned: ${report.unassignedModels.length} models`);

  if (report.newAssignments.length > 0) {
    console.log("\n📋 New Assignments:");
    for (const a of report.newAssignments.slice(0, 15)) {
      const name = a.modelId.slice(0, 45).padEnd(45);
      const score = String(a.evalScore).padStart(3);
      const pri = String(a.priority).padStart(2);
      const roles = a.assignedRoles.join(", ").slice(0, 30);
      console.log(`   [P${pri}] ${name} (${score}/100) → ${roles}`);
    }
  }

  if (report.updatedPriorities.length > 0) {
    console.log("\n🔄 Updated Priorities:");
    for (const u of report.updatedPriorities) {
      console.log(`   ${u.modelId}: ${u.oldPriority} → ${u.newPriority}`);
    }
  }

  if (report.recommendations.length > 0) {
    console.log("\n💡 Recommendations:");
    for (const rec of report.recommendations) {
      console.log(`   ${rec}`);
    }
  }
}

async function cmdStats() {
  const service = getModelEvalService();
  const stats = service.getStats();

  if (flags.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log("\n📊 OpenClaw Model Evaluation Stats");
  console.log(`   Total evaluations: ${stats.totalEvaluations}`);
  console.log(`   Unique models: ${stats.modelsEvaluated}`);
  console.log(`   Last eval: ${stats.lastEvalAt || "never"}`);

  if (stats.topModels.length > 0) {
    console.log("\n🏆 Top Models (last 7 days):");
    for (const m of stats.topModels) {
      console.log(`   ${m.modelId}: ${m.overall}/100`);
    }
  }
}

async function cmdResults() {
  const service = getModelEvalService();
  const top = Number(getFlag("top")) || 20;
  const provider = getFlag("provider");

  const results = service.getLatestResults({
    limit: top,
    provider,
    sortBy: "overall",
  });

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(`\n📋 Latest Evaluation Results (top ${top}):`);
  for (const r of results) {
    const name = r.modelId.slice(0, 50).padEnd(50);
    const ovr = String(r.scores.overall).padStart(3);
    const cap = String(r.scores.capability).padStart(3);
    const free = r.metadata.isFree ? "free" : "paid";
    const ctx = `${Math.round(r.metadata.contextWindow / 1000)}K`.padStart(4);
    console.log(`   [${ovr}] ${name} cap:${cap} ${free} ${ctx}ctx`);
  }
}

async function cmdTrend() {
  const modelId = args[1];
  if (!modelId) {
    console.error("Usage: eval-cli.ts trend <modelId> [--days=30]");
    process.exit(1);
  }

  const days = Number(getFlag("days")) || 30;
  const service = getModelEvalService();
  const trend = service.getModelTrend(modelId, days);

  if (flags.json) {
    console.log(JSON.stringify(trend, null, 2));
    return;
  }

  console.log(`\n📈 Trend for ${modelId} (last ${days} days):`);
  if (trend.length === 0) {
    console.log("   No data available");
    return;
  }

  for (const point of trend) {
    const bar = "█".repeat(Math.floor(point.overall / 5));
    console.log(`   ${point.date} │ ${String(point.overall).padStart(3)} ${bar}`);
  }
}

// ===== Help =====

function showHelp() {
  console.log(`
OpenClaw Model Evaluation CLI
=============================

Commands:
  eval       Run model evaluation (fetches OpenRouter data + benchmarks)
  assign     Run dynamic model assignment
  stats      Show evaluation statistics
  results    Show latest evaluation results
  trend      Show evaluation trend for a model

Flags:
  --full              Run full evaluation with web benchmarks
  --benchmarks        Include benchmark search (with eval or assign)
  --force             Force refresh (re-fetch all data)
  --models=a,b        Only evaluate specific models
  --top=N             Show top N results (default: 20)
  --days=N            Trend/timespan in days (default: 30)
  --provider=X        Filter by provider
  --json              Output as JSON

Examples:
  bun run src/eval/eval-cli.ts eval --full --benchmarks
  bun run src/eval/eval-cli.ts eval --models=deepseek,kimi --bench
  bun run src/eval/eval-cli.ts assign --force
  bun run src/eval/eval-cli.ts stats
  bun run src/eval/eval-cli.ts results --top=10 --json
  bun run src/eval/eval-cli.ts trend deepseek/deepseek-chat-v3-0324:free
`);
}

// ===== Main =====

async function main() {
  switch (command) {
    case "eval":
      await cmdEval();
      break;
    case "assign":
      await cmdAssign();
      break;
    case "stats":
      await cmdStats();
      break;
    case "results":
      await cmdResults();
      break;
    case "trend":
      await cmdTrend();
      break;
    default:
      showHelp();
      break;
  }

  // Clean up
  getModelEvalService().close();
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err.message);
  process.exit(1);
});
