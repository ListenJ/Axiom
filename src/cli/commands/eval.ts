import { getModelEvalService, type ModelEvalResult } from "../../eval/model-eval-service.js";
import { getDynamicModelAssigner } from "../../router/dynamic-model-assigner.js";

function getFlag(name: string, args: string[]): string | undefined {
  const flag = args.find(a => a.startsWith(`--${name}=`));
  return flag?.split("=")[1];
}

export async function handleEvalEval(args: string[]) {
  const service = getModelEvalService();
  const full = args.includes("--full");
  const benchmarks = args.includes("--benchmarks") || args.includes("--bench");
  const json = args.includes("--json");
  const modelFilter = getFlag("models", args)?.split(",");
  const includeBenchmarks = benchmarks || full;

  console.log(`\n🔬 Axiom Model Evaluation Service`);
  console.log(`   Mode: ${full ? "full" : "quick"}`);
  console.log(`   Benchmarks: ${includeBenchmarks ? "enabled" : "disabled"}`);
  console.log(`   Models: ${modelFilter ? modelFilter.join(", ") : "all"}`);
  console.log("");

  let results: ModelEvalResult[];

  if (full) {
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

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    service.close();
    return;
  }

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

  service.close();
}

export async function handleEvalAssign(args: string[]) {
  const assigner = getDynamicModelAssigner();
  const force = args.includes("--force");
  const benchmarks = args.includes("--benchmarks") || args.includes("--bench");
  const json = args.includes("--json");

  console.log("\n🎯 Axiom Dynamic Model Assignment");
  console.log(`   Force refresh: ${force ? "yes" : "no"}`);
  console.log("");

  console.log("📡 Running assignment...");
  const report = await assigner.runAssignment({
    forceRefresh: force,
    includeBenchmarks: benchmarks || force,
  });

  if (json) {
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

export async function handleEvalStats(args: string[]) {
  const service = getModelEvalService();
  const json = args.includes("--json");
  const stats = service.getStats();

  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    service.close();
    return;
  }

  console.log("\n📊 Axiom Model Evaluation Stats");
  console.log(`   Total evaluations: ${stats.totalEvaluations}`);
  console.log(`   Unique models: ${stats.modelsEvaluated}`);
  console.log(`   Last eval: ${stats.lastEvalAt || "never"}`);

  if (stats.topModels.length > 0) {
    console.log("\n🏆 Top Models (last 7 days):");
    for (const m of stats.topModels) {
      console.log(`   ${m.modelId}: ${m.overall}/100`);
    }
  }

  service.close();
}

export async function handleEvalResults(args: string[]) {
  const service = getModelEvalService();
  const json = args.includes("--json");
  const top = Number(getFlag("top", args)) || 20;
  const provider = getFlag("provider", args);

  const results = service.getLatestResults({
    limit: top,
    provider,
    sortBy: "overall",
  });

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    service.close();
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

  service.close();
}

export async function handleEvalTrend(args: string[]) {
  const modelId = args[0];
  if (!modelId) { console.error("Usage: eval:trend <modelId> [--days=30]"); return; }

  const days = Number(getFlag("days", args)) || 30;
  const json = args.includes("--json");
  const service = getModelEvalService();
  const trend = service.getModelTrend(modelId, days);

  if (json) {
    console.log(JSON.stringify(trend, null, 2));
    service.close();
    return;
  }

  console.log(`\n📈 Trend for ${modelId} (last ${days} days):`);
  if (trend.length === 0) {
    console.log("   No data available");
    service.close();
    return;
  }

  for (const point of trend) {
    const bar = "█".repeat(Math.floor(point.overall / 5));
    console.log(`   ${point.date} │ ${String(point.overall).padStart(3)} ${bar}`);
  }

  service.close();
}

export async function handleEvalCommands(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "eval":
      await handleEvalEval(rest);
      break;
    case "assign":
      await handleEvalAssign(rest);
      break;
    case "stats":
      await handleEvalStats(rest);
      break;
    case "results":
      await handleEvalResults(rest);
      break;
    case "trend":
      await handleEvalTrend(rest);
      break;
    default:
      console.log(`\n用法: axiom eval <子命令>\n`);
      console.log(`可用子命令:`);
      console.log(`  eval      Run model evaluation (fetches OpenRouter data + benchmarks)`);
      console.log(`  assign    Run dynamic model assignment`);
      console.log(`  stats     Show evaluation statistics`);
      console.log(`  results   Show latest evaluation results`);
      console.log(`  trend     Show evaluation trend for a model`);
  }
}
