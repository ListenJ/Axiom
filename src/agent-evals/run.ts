/**
 * Agent 能力边界评测 CLI
 * 用法: bun run src/agent-evals/run.ts [--family=coding] [--split=train|held-out] [--json] [--dry-run]
 */
import { ALL_AGENT_TASKS, getTasksByFamily, validateTasks, type TaskFamily, type TaskSplit } from "./tasks.js";
import { loadExternalTasks, type ExternalKind } from "./external.js";
import { runTasks, DEFAULT_RERUN_EACH } from "./runner.js";
import { summarize, hasCapabilityFailure } from "./metrics.js";
import type { TaskResult, MetricsSummary } from "./metrics.js";
import { toMarkdown, toJSON } from "./report.js";
import { logger } from "../utils/logger.js";
import { openRegistry, DEFAULT_REGISTRY_PATH } from "./registry.js";
import { autoCheckRegression } from "./run-check.js";
import type { RunMetadata, StoredTaskResult } from "./metrics-types.js";

const args = Bun.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const family = flag("family") as TaskFamily | undefined;
const split = flag("split") as TaskSplit | undefined;
const json = args.includes("--json");
const dryRun = args.includes("--dry-run");
const evolve = args.includes("--evolve");
const injectSkills = args.includes("--inject-skills");
const constraints = args.includes("--constraints");
const rerunEachRaw = Number(flag("rerun-each") ?? String(DEFAULT_RERUN_EACH));
const rerunEach = Number.isFinite(rerunEachRaw) && rerunEachRaw >= 1 ? Math.floor(rerunEachRaw) : DEFAULT_RERUN_EACH;
const externalKind = flag("external") as ExternalKind | undefined;
const externalLimitRaw = Number(flag("limit") ?? "0");
const externalLimit = Number.isFinite(externalLimitRaw) && externalLimitRaw >= 1 ? Math.floor(externalLimitRaw) : undefined;
const rawConcurrency = Number(flag("concurrency") ?? "1");
const requestedConcurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 1;
const modelHint = flag("model");
const provider = flag("provider");
// 缓解：zhipu 免费模型限流（HTTP 429 code 1302）——并发请求易触发限流，强制并发 1
const concurrency = provider === "zhipu" ? 1 : requestedConcurrency;
const directModel = flag("model") ?? flag("direct-model");
const fallbackProvider = flag("fallback-provider");
const fallbackModel = flag("fallback-model");
const noPersist = args.includes("--no-persist"); // 逃生舱：跳过 eval-registry 落盘
const baselineSpec = flag("baseline"); // S5 回归检测显式基准（run_tag 或 id；缺省自动取同作用域历史最优）
const maxDropValue = flag("max-drop") === undefined ? NaN : Number(flag("max-drop"));
const maxDropPp = Number.isFinite(maxDropValue) && maxDropValue >= 0 ? maxDropValue : undefined; // S5 回落阈值 pp
const noCheckRegression = args.includes("--no-check-regression"); // S5 逃生舱：跳过回归自动检测
const cliStartAt = new Date().toISOString();
const trendRaw = Number(flag("trend") ?? "0"); // S3：最近 N 轮通过率/成本趋势（需 registry）
const trendN = Number.isFinite(trendRaw) && trendRaw >= 1 ? Math.floor(trendRaw) : 0;
const compareSpec = flag("compare"); // S3：两轮对比 <refA>..<refB>（run_tag 或 id，需 registry）

function showHelp() {
  logger.info(`
Agent 能力边界评测 CLI
用法: bun run src/agent-evals/run.ts [options]
Options:
  --family=<f>      只跑指定任务族 (coding|knowledge|planning|tool-use|memory|self-evolve)
  --split=<s>       只跑指定划分 (train|held-out)
  --external=<k>    运行外部基准 (human-eval|mbpp)，与自建任务集并存
  --limit=N         外部基准只加载前 N 条（默认全部）
  --concurrency=N   并发数 (默认 1)
  --model=<id>      指定模型（默认走 model-router general-chat 角色）
  --provider=<p>    直连 provider（如 zhipu），配合 --model 使用，绕过 model-router
  --fallback-provider=<p>  主 provider 限流/失败时的备用 provider（配合 --fallback-model）
  --fallback-model=<m>     备用模型
  --json            输出 JSON
  --dry-run         预览任务清单
  --evolve          评测→进化闭环：train → held-out baseline → 归纳注册技能 → held-out(注入技能) 对比
  --inject-skills   评测时注入已归纳的 auto-induce-* 技能
  --rerun-each=N    每个任务重跑 N 次取最优（消除单样本波动，默认 2）
  --constraints     附加通用回答约束（完整性/直接性/复杂度标定）
  --no-persist      跳过 eval-registry 落盘（默认落盘 data/eval-registry.db）
  --trend=N         输出最近 N 轮通过率/成本趋势（需 registry，不执行评测）
  --compare=a..b    输出 run_tag(或 id) a 与 b 两轮对比（需 registry，不执行评测）
  --baseline=<ref>  回归检测显式基准 run_tag/id（默认自动取同族同模型同 split 历史最优）
  --max-drop=N      通过率回落阈值 pp（回落超 N 判回归；默认 10）
  --no-check-regression  跳过回归自动检测（默认开启；回归时退出码 2）
  --help            帮助
`);
  process.exit(0);
}

/** 生成唯一 run_tag：本地时间戳 + pid（eval_runs.run_tag UNIQUE 冲突时 retry +1s） */
function makeRunTag(base: string, phase?: string): string {
  const tag = `${base}.${process.pid}${phase ? `::${phase}` : ""}`;
  return tag;
}

/** 当前 HEAD commit SHA（采集失败返回 null，不阻断） */
function currentGitCommit(): string | null {
  try {
    const out = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: process.cwd() }).stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * 评测结果落盘到 eval-registry（失败只 warn，不阻断评测 stdout/exit）。
 * 按 AGENTS 规则：`--no-persist` 逃生舱跳过；落盘失败降级为提示。
 * S5 起返回本轮 runId（落盘成功时；跳过/失败返回 null），供回归自动检测消费。
 */
function persistResults(results: TaskResult[], summary: MetricsSummary, phase?: string): number | null {
  if (noPersist) return null;
  try {
    const registry = openRegistry(DEFAULT_REGISTRY_PATH);
    try {
      const tasks: StoredTaskResult[] = results.map((r) => ({
        taskId: r.taskId,
        family: r.family,
        split: r.split,
        passed: r.passed,
        reason: r.reason,
        latencyMs: r.latencyMs,
        outputLength: r.outputLength,
        model: r.model,
        injectedSkills: r.injectedSkills,
        executionError: r.executionError,
        promptTokens: r.tokenUsage && typeof r.tokenUsage.promptTokens === "number" ? r.tokenUsage.promptTokens : null,
        completionTokens: r.tokenUsage && typeof r.tokenUsage.completionTokens === "number" ? r.tokenUsage.completionTokens : null,
        costUsd: typeof r.costUsd === "number" ? r.costUsd : null,
      }));
      const meta: RunMetadata = {
        runTag: makeRunTag(cliStartAt.replace(/[:.]/g, "-"), phase),
        startedAt: cliStartAt,
        finishedAt: new Date().toISOString(),
        model: directModel ?? modelHint ?? undefined,
        provider: provider ?? undefined,
        familyFilter: family,
        splitFilter: split,
        rerunEach,
        evolvePhase: phase,
        gitCommit: currentGitCommit() ?? undefined,
        srcArgv: Bun.argv.slice(2).join(" "),
        exitCode: hasCapabilityFailure(results) ? 1 : 0,
      };
      try {
        const runId = registry.insertRun(meta, summary);
        registry.insertTaskResults(runId, tasks);
        logger.info(`[EvalRegistry] 已入库 run#${runId} ${meta.runTag}（${tasks.length} 任务, passRate=${summary.passRate}%）`);
        return runId;
      } catch (err) {
        // run_tag 冲突（同一秒两轮）→ 重试一次 +1s
        const retried = registry.insertRun({ ...meta, runTag: `${meta.runTag}+1s` }, summary);
        registry.insertTaskResults(retried, tasks);
        logger.info(`[EvalRegistry] run_tag 冲突重试成功 run#${retried}`);
        return retried;
      }
    } finally {
      registry.close();
    }
  } catch (err) {
    logger.warn(`[EvalRegistry] 结果落盘失败（评测不受影响）: ${(err as Error).message}`);
    return null;
  }
}

if (args.includes("--help") || args.includes("-h")) showHelp();

if (!externalKind) {
  const errors = validateTasks();
  if (errors.length > 0) {
    logger.error(`任务定义不合法:
${errors.join("\n")}`);
    process.exit(1);
  }
}

/**
 * 趋势 / 对比视图（S3）：只读 eval-registry，不执行评测。
 * 引用解析：纯数字按 id、其余按 run_tag（对齐 registry.getRun 双形态）。
 */
const runRef = (raw: string): number | string => (/^[0-9]+$/.test(raw) ? Number(raw) : raw);
if (trendN > 0 || compareSpec) {
  const registry = openRegistry(DEFAULT_REGISTRY_PATH);
  try {
    const { trendMarkdown, compareMarkdown } = await import("./report-extras.js");
    if (compareSpec) {
      const m = compareSpec.match(/^(.+)\.\.(.+)$/);
      if (!m) {
        logger.error(`--compare 需要 <refA>..<refB> 格式（run_tag 或 id），收到: ${compareSpec}`);
        process.exit(2);
      }
      const [ra, rb] = [runRef(m[1]), runRef(m[2])];
      if (!registry.getRun(ra) || !registry.getRun(rb)) {
        logger.error(`--compare 引用的轮次不存在（${compareSpec}）`);
        process.exit(2);
      }
      const cmp = registry.compare(ra, rb);
      if (!cmp) {
        logger.error(`--compare 无法对比（轮次缺失）`);
        process.exit(2);
      }
      console.log(compareMarkdown(cmp));
    } else {
      const runs = registry.getTrend({ family, model: directModel ?? modelHint });
      const latest = runs.slice(-trendN);
      console.log(trendMarkdown(latest, { limit: trendN, family }));
    }
  } finally {
    registry.close();
  }
  process.exit(0);
}

const tasks = externalKind
  ? loadExternalTasks(externalKind, { limit: externalLimit })
  : getTasksByFamily(family, split);
if (dryRun) {
  logger.info(`任务清单（${tasks.length}）:`);
  for (const task of tasks) logger.info(`  [${task.split}] ${task.id} ${task.family} - ${task.title}`);
  process.exit(0);
}
if (tasks.length === 0) {
  logger.error("没有匹配的任务（检查 --family/--split）");
  process.exit(1);
}

if (evolve && !externalKind) {
  const trainTasks = getTasksByFamily(family, "train");
  const heldOutTasks = getTasksByFamily(family, "held-out");
  logger.info(`[Evolve] 阶段1/3: train ${trainTasks.length} 任务（无技能）...`);
  const trainResults = await runTasks(trainTasks, { family, split: "train", concurrency, modelHint, provider, model: directModel, fallbackProvider, fallbackModel, rerunEach });
  logger.info(`[Evolve] 阶段2/3: held-out baseline ${heldOutTasks.length} 任务（无技能）...`);
  const baselineResults = await runTasks(heldOutTasks, { family, split: "held-out", concurrency, modelHint, provider, model: directModel, fallbackProvider, fallbackModel, rerunEach });
  const { evolveFromResults } = await import("./evolve.js");
  const evolved = evolveFromResults(trainResults, ALL_AGENT_TASKS, family);
  logger.info(`[Evolve] 归纳 ${evolved.inductionCount} 个模式 / 方法论技能 ${evolved.craftedCount} 个 / 注册 ${evolved.created.length} 个技能`);
  logger.info(`[Evolve] 阶段3/3: held-out evolved ${heldOutTasks.length} 任务（注入技能）...`);
  const evolvedResults = await runTasks(heldOutTasks, { family, split: "held-out", concurrency, modelHint, provider, model: directModel, injectSkills: true, constraints, fallbackProvider, fallbackModel, rerunEach });

  // 增益反馈：baseline 记录族基线，evolved 记录技能注入结果（执行错误不计入，能力口径）
  const { getDefaultGainTracker } = await import("./skill-gain.js");
  const gain = getDefaultGainTracker();
  gain.recordFromResults(baselineResults, evolvedResults);
  const gainSummary = gain.listGain(family ?? "coding");
  if (gainSummary.length > 0) {
    logger.info(`[Evolve] 增益概览: ${gainSummary.map((g) => `${g.skillId}=+(${g.gain ?? "?"}pp/${g.samples}次)`).join(", ")}`);
  }

  const baseSummary = summarize(baselineResults);
  const evolSummary = summarize(evolvedResults);
  // 两阶段结果入库（阶段区分 run_tag 派生，便于 baseline/evolved 对比查询）
  persistResults(baselineResults, baseSummary, "baseline");
  persistResults(evolvedResults, evolSummary, "evolved");
  const header = `# 评测→进化闭环对比（held-out）\n\n| 阶段 | 通过率 | 通过/总数 |\n| --- | --- | --- |\n| baseline（无技能） | ${baseSummary.passRate}% | ${baseSummary.passed}/${baseSummary.total} |\n| evolved（注入技能） | ${evolSummary.passRate}% | ${evolSummary.passed}/${evolSummary.total} |\n`;
  console.log(header);
  console.log("## baseline held-out 明细");
  console.log(toMarkdown(baseSummary, baselineResults));
  console.log("## evolved held-out 明细");
  console.log(toMarkdown(evolSummary, evolvedResults));
  process.exit(hasCapabilityFailure([...baselineResults, ...evolvedResults]) ? 1 : 0);
}

if (provider === "zhipu" && requestedConcurrency > 1) {
  logger.warn(`[AgentEval] zhipu 免费模型限流缓解：并发 ${requestedConcurrency} → 1（避免 429 code 1302）`);
}
logger.info(`开始评测 ${tasks.length} 个任务（并发 ${concurrency}）...`);
const results = await runTasks(tasks, { family, split, concurrency, modelHint, provider, model: directModel, injectSkills, constraints, fallbackProvider, fallbackModel, rerunEach });
const summary = summarize(results);
const runId = persistResults(results, summary); // 结果入库（--no-persist 跳过）；返回 runId 供回归检测

// S5 回归自动检测闭环：默认开启，--no-check-regression 逃生舱跳过；判定在 run-check.ts
// （无副作用可测），此处仅消费结果。告警走 warn/stderr（不污染 --json 的 stdout 流）；
// 分级退出码 回归=2 > 能力失败=1 > 正常=0。
let regressed = false;
if (!noCheckRegression) {
  const registry = openRegistry(DEFAULT_REGISTRY_PATH);
  try {
    const outcome = autoCheckRegression(registry, {
      runId,
      baseline: baselineSpec !== undefined ? runRef(baselineSpec) : undefined,
      maxDropPp,
    });
    if (outcome.checked && outcome.regressed) {
      const check = outcome.check!;
      regressed = true;
      logger.warn(
        `[EvalRegistry] ⚠️ 回归检测: 通过率回落 ${check.dropPp}pp（阈值 ${check.maxDropPp}pp）vs 基准 run#${check.baseline.id} ${check.baseline.runTag}（退出码 2）`,
      );
    } else if (outcome.checked) {
      const check = outcome.check!;
      logger.info(`[EvalRegistry] 回归检测: 通过率回落 ${check.dropPp}pp（阈值 ${check.maxDropPp}pp），未判回归`);
    } else if (outcome.skipped === "no-baseline") {
      logger.info("[EvalRegistry] 回归检测跳过: 无可比基准（首次评测或 --baseline 不存在）");
    } else if (outcome.skipped === "no-candidate") {
      logger.warn("[EvalRegistry] 回归检测跳过: 候选轮不存在（--no-persist 或落盘失败）");
    }
  } finally {
    registry.close();
  }
}

const output = json ? toJSON(summary, results) : toMarkdown(summary, results);
if (json) {
  console.log(output);
} else {
  console.log(output);
}

process.exit(regressed ? 2 : hasCapabilityFailure(results) ? 1 : 0);
