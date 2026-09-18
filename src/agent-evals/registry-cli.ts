/**
 * eval-registry 查询 CLI — stats / show / compare / trend / seed-baseline。
 *
 * 镜像 src/eval/eval-cli.ts 的 case 分发；除 seed 外只读 DB。
 * 用法: bun run src/agent-evals/registry-cli.ts <command> [options]
 */
import { openRegistry, DEFAULT_REGISTRY_PATH } from "./registry.js";
import type { RunRow } from "./metrics-types.js";

const args = Bun.argv.slice(2);
const command = args[0];
const flag = (name: string) => {
  const v = args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return v === "" ? undefined : v; // 空值视为未传：避免空串当真过滤条件（--family= 静默空结果）
};

function showHelp() {
  console.log(`
eval-registry 查询 CLI
用法: bun run src/agent-evals/registry-cli.ts <command> [options]

Commands:
  stats [--family=<f>] [--model=<m>] [--limit=N]
       时间降序列出评测轮次（id/时间/模型/族/通过率/train/held）
  show <id|run_tag>
       单轮 summary + 分族表 + 逐条明细
  compare <idA> <idB>
       两轮并排对比（通过率/分族/generalization/延迟）
  check <id> [--baseline=<ref>] [--max-drop=N]
       回归守卫：候选轮 vs 基准轮通过率回落超 N pp（默认 10）→ 回归，exit 1。
       默认基准 = 同族同模型同 split 的历史最高通过率轮次；--baseline 显式指定。
  trend [--family=<f>] [--model=<m>]
       时间升序通过率趋势（markdown 表格）
  seed-baseline --name=X --pass=N --total=M [--family=<f>] --source=<doc> [--date=D] [--model=<m>]
       手工录入历史基线（source 必填，标注来源文档）
`);
}

function pct(n: number | null | undefined): string {
  return n == null ? "N/A" : `${n}%`;
}

function fmtDate(iso: string): string {
  // ISO UTC → 本地日期时间（截到分钟）
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function printStats() {
  const reg = openRegistry(DEFAULT_REGISTRY_PATH);
  try {
    const runs = reg.listRuns({ family: flag("family"), model: flag("model"), limit: Number(flag("limit") ?? "0") || undefined });
    if (runs.length === 0) {
      console.log("（无评测记录）");
      return;
    }
    console.log("| id | 时间 | 模型 | 族 | split | 通过率 | train | held | 执行错误 | 来源 |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of runs) {
      const src = r.srcDoc ? "manual" : (r.evolvePhase ?? "run");
      console.log(
        `| ${r.id} | ${fmtDate(r.startedAt)} | ${r.model ?? "-"} | ${r.familyFilter ?? "all"} | ${r.splitFilter ?? "-"} | ${pct(r.summaryPassRate)} | ${pct(r.summaryTrainRate)} | ${pct(r.summaryHeldOutRate)} | ${r.summaryExecutionErrors > 0 ? `⚠️${r.summaryExecutionErrors}` : "-"} | ${src} |`,
      );
    }
  } finally {
    reg.close();
  }
}

function printShow(ref: string) {
  const reg = openRegistry(DEFAULT_REGISTRY_PATH);
  try {
    const run = reg.getRun(Number.isFinite(Number(ref)) ? Number(ref) : ref);
    if (!run) {
      console.error(`找不到 run: ${ref}`);
      process.exit(1);
    }
    console.log(`# Run ${run.id} — ${run.runTag}`);
    console.log(`- 时间: ${fmtDate(run.startedAt)} ～ ${run.finishedAt ? fmtDate(run.finishedAt) : "N/A"}`);
    console.log(`- 模型: ${run.model ?? "-"} ｜ provider: ${run.provider ?? "-"}`);
    console.log(`- family: ${run.familyFilter ?? "all"} ｜ split: ${run.splitFilter ?? "-"} ｜ rerunEach: ${run.rerunEach}`);
    console.log(`- evolve 阶段: ${run.evolvePhase ?? "普通"} ｜ git_commit: ${run.gitCommit ?? "-"}`);
    if (run.srcDoc) console.log(`- 来源文档(manual): ${run.srcDoc}`);
    if (run.srcArgv) console.log(`- 命令: ${run.srcArgv}`);
    console.log("");
    const errNote = run.summaryExecutionErrors > 0 ? ` ｜ 执行错误: ⚠️${run.summaryExecutionErrors}（不计入通过率分母）` : "";
    console.log(`## 汇总: ${run.summaryPassed}/${run.summaryTotal} = ${pct(run.summaryPassRate)}${errNote}`);
    console.log(`train ${pct(run.summaryTrainRate)} ｜ held-out ${pct(run.summaryHeldOutRate)} ｜ 泛化 ${run.summaryGeneralization ?? "N/A"} ｜ 平均延迟 ${run.summaryAvgLatencyMs}ms`);
    const fams = Object.entries(run.summaryByFamily);
    if (fams.length > 0) {
      console.log("");
      console.log("| 任务族 | 通过率 | 通过/总数 |");
      console.log("| --- | --- | --- |");
      for (const [family, m] of fams.sort()) {
        console.log(`| ${family} | ${m.passRate}% | ${m.passed}/${m.total} |`);
      }
    }
    const tasks = reg.getTasks(run.id);
    if (tasks.length > 0) {
      console.log("");
      console.log("| ID | 族 | split | 通过 | 延迟(ms) | 模型 | 备注 |");
      console.log("| --- | --- | --- | --- | --- | --- | --- |");
      for (const t of tasks) {
        const status = t.executionError ? "⚠️" : t.passed ? "✅" : "❌";
        const note = t.executionError ? "执行错误" : "";
        console.log(`| ${t.taskId} | ${t.family} | ${t.split} | ${status} | ${t.latencyMs} | ${t.model ?? "-"} | ${note} |`);
        if (t.executionError && t.reason) console.log(`  - 执行错误: ${t.reason}`);
        else if (!t.passed && t.reason) console.log(`  - 失败原因: ${t.reason}`);
      }
    }
  } finally {
    reg.close();
  }
}

function printCompare(refA: string, refB: string) {
  const reg = openRegistry(DEFAULT_REGISTRY_PATH);
  try {
    const id = (ref: string) => (Number.isFinite(Number(ref)) ? Number(ref) : ref);
    const cmp = reg.compare(id(refA), id(refB));
    if (!cmp) {
      console.error(`compare 失败: ${refA} 或 ${refB} 不存在`);
      process.exit(1);
    }
    console.log(`# compare ${cmp.a.id}(${cmp.a.runTag}) vs ${cmp.b.id}(${cmp.b.runTag})`);
    console.log("");
    console.log("| 指标 | A | B | Δ(B-A) |");
    console.log("| --- | --- | --- | --- |");
    console.log(`| 通过率 | ${pct(cmp.a.summaryPassRate)} | ${pct(cmp.b.summaryPassRate)} | ${cmp.summaryDiff.passRate >= 0 ? "+" : ""}${cmp.summaryDiff.passRate}pp |`);
    console.log(`| 总数 | ${cmp.a.summaryTotal} | ${cmp.b.summaryTotal} | ${cmp.summaryDiff.totalDiff >= 0 ? "+" : ""}${cmp.summaryDiff.totalDiff} |`);
    console.log(`| 泛化率 | ${cmp.a.summaryGeneralization ?? "N/A"} | ${cmp.b.summaryGeneralization ?? "N/A"} | ${cmp.summaryDiff.generalizationDiff ?? "N/A"} |`);
    console.log(`| 平均延迟 | ${cmp.a.summaryAvgLatencyMs}ms | ${cmp.b.summaryAvgLatencyMs}ms | ${cmp.summaryDiff.avgLatencyDiff >= 0 ? "+" : ""}${cmp.summaryDiff.avgLatencyDiff}ms |`);
    console.log("");
    if (cmp.familyDiffs.length > 0) {
      console.log("| 任务族 | A | B | Δ |");
      console.log("| --- | --- | --- | --- |");
      for (const f of cmp.familyDiffs) {
        const a = f.a ? `${f.a.passRate}% (${f.a.passed}/${f.a.total})` : "-";
        const b = f.b ? `${f.b.passRate}% (${f.b.passed}/${f.b.total})` : "-";
        const d = f.passRateDiff == null ? "N/A" : `${f.passRateDiff >= 0 ? "+" : ""}${f.passRateDiff}pp`;
        console.log(`| ${f.family} | ${a} | ${b} | ${d} |`);
      }
    }
  } finally {
    reg.close();
  }
}

function printCheck(ref: string) {
  const reg = openRegistry(DEFAULT_REGISTRY_PATH);
  try {
    // 数字形态的 ref（如 `4`）按 id 解析，否则按 run_tag（与 printCompare 同惯例）
    const toId = (x: string): string | number => (Number.isFinite(Number(x)) ? Number(x) : x);
    const toOptionalId = (x: string | undefined): string | number | undefined =>
      x !== undefined ? toId(x) : undefined;
    const maxDropRaw = Number(flag("max-drop") ?? "10");
    const maxDrop = Number.isFinite(maxDropRaw) && maxDropRaw >= 0 ? maxDropRaw : 10;
    const candRef = toId(ref);
    const chk = reg.checkRegression(candRef, { baseline: toOptionalId(flag("baseline")), maxDropPp: maxDrop });
    if (!chk) {
      if (!reg.getRun(candRef)) {
        console.error(`找不到 run: ${ref}`);
        process.exit(1);
      }
      console.error(`无可比基准（同族同模型同 split 的历史轮次）；用 --baseline=<id|tag> 显式指定`);
      process.exit(1);
    }
    const { candidate, baseline } = chk;
    const deltaPp = -chk.dropPp; // Δ = 候选 − 基准（dropPp = 基准 − 候选）
    const fmtDelta = (x: number) => `${x > 0 ? "+" : ""}${x}pp`;
    console.log(`# check ${candidate.id}(${candidate.runTag}) vs 基准 ${baseline.id}(${baseline.runTag})`);
    console.log(`- 作用域: family=${candidate.familyFilter ?? "all"} ｜ model=${candidate.model ?? "-"} ｜ split=${candidate.splitFilter ?? "-"}`);
    console.log("");
    console.log("| 指标 | 基准 | 候选 | Δ(候选−基准) |");
    console.log("| --- | --- | --- | --- |");
    console.log(`| 通过率 | ${pct(baseline.summaryPassRate)} | ${pct(candidate.summaryPassRate)} | ${fmtDelta(deltaPp)} |`);
    console.log(`| 执行错误 | ${baseline.summaryExecutionErrors} | ${candidate.summaryExecutionErrors} | - |`);
    if (chk.familyDiffs.length > 0) {
      console.log("");
      console.log("| 任务族 | 基准 | 候选 | Δ |");
      console.log("| --- | --- | --- | --- |");
      for (const f of chk.familyDiffs) {
        const a = f.baselineRate == null ? "-" : `${f.baselineRate}%`;
        const b = f.candidateRate == null ? "-" : `${f.candidateRate}%`;
        const d = f.diffPp == null ? "N/A" : fmtDelta(f.diffPp);
        console.log(`| ${f.family} | ${a} | ${b} | ${d} |`);
      }
    }
    console.log("");
    if (chk.regressed) {
      console.log(`⚠️ 回归！通过率回落 ${chk.dropPp}pp > 阈值 ${chk.maxDropPp}pp（候选 ${pct(candidate.summaryPassRate)} vs 基准 ${pct(baseline.summaryPassRate)}）`);
    } else if (chk.dropPp > 0) {
      console.log(`✅ 未回归（回落 ${chk.dropPp}pp ≤ 阈值 ${chk.maxDropPp}pp）`);
    } else {
      console.log(`✅ 未回归（候选高于基准 ${-chk.dropPp}pp，无回落）`);
    }
    process.exit(chk.regressed ? 1 : 0);
  } finally {
    reg.close();
  }
}

function printTrend() {
  const reg = openRegistry(DEFAULT_REGISTRY_PATH);
  try {
    const runs = reg.getTrend({ family: flag("family"), model: flag("model") });
    if (runs.length === 0) {
      console.log("（无评测记录）");
      return;
    }
    console.log("| 时间 | id | 模型 | 族 | 通过率 | 来源 |");
    console.log("| --- | --- | --- | --- | --- | --- |");
    for (const r of runs) {
      console.log(`| ${fmtDate(r.startedAt)} | ${r.id} | ${r.model ?? "-"} | ${r.familyFilter ?? "all"} | ${pct(r.summaryPassRate)} | ${r.srcDoc ? "manual" : r.evolvePhase ?? "run"} |`);
    }
  } finally {
    reg.close();
  }
}

function cmdSeed() {
  const name = flag("name");
  const passRaw = Number(flag("pass") ?? "NaN");
  const totalRaw = Number(flag("total") ?? "NaN");
  const source = flag("source");
  if (!name || !source || !Number.isFinite(passRaw) || !Number.isFinite(totalRaw) || passRaw < 0 || totalRaw <= 0 || passRaw > totalRaw) {
    console.error("seed-baseline 需要: --name=X --pass=N --total=M --source=<doc> [--family=<f>] [--date=D] [--model=<m>]");
    process.exit(1);
  }
  const reg = openRegistry(DEFAULT_REGISTRY_PATH);
  try {
    const id = reg.seedBaseline({
      name,
      pass: Math.floor(passRaw),
      total: Math.floor(totalRaw),
      family: flag("family"),
      sourceDoc: source,
      date: flag("date"),
      model: flag("model"),
    });
    console.log(`已入库 manual baseline #${id}: ${name}（${passRaw}/${totalRaw} = ${((passRaw / totalRaw) * 100).toFixed(1)}%）`);
  } finally {
    reg.close();
  }
}

async function main() {
  switch (command) {
    case "stats":
      printStats();
      break;
    case "show":
      if (!args[1]) { showHelp(); process.exit(1); }
      printShow(args[1]);
      break;
    case "compare":
      if (!args[1] || !args[2]) { showHelp(); process.exit(1); }
      printCompare(args[1], args[2]);
      break;
    case "check":
      if (!args[1]) { showHelp(); process.exit(1); }
      printCheck(args[1]);
      break;
    case "trend":
      printTrend();
      break;
    case "seed-baseline":
      cmdSeed();
      break;
    default:
      showHelp();
      break;
  }
}

main().catch((err) => {
  console.error(`\n❌ Fatal: ${(err as Error).message}`);
  process.exit(1);
});
