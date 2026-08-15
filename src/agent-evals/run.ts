/**
 * Agent 能力边界评测 CLI
 * 用法: bun run src/agent-evals/run.ts [--family=coding] [--split=train|held-out] [--json] [--dry-run]
 */
import { ALL_AGENT_TASKS, getTasksByFamily, validateTasks, type TaskFamily, type TaskSplit } from "./tasks.js";
import { runTasks } from "./runner.js";
import { summarize } from "./metrics.js";
import { toMarkdown, toJSON } from "./report.js";
import { logger } from "../utils/logger.js";

const args = Bun.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const family = flag("family") as TaskFamily | undefined;
const split = flag("split") as TaskSplit | undefined;
const json = args.includes("--json");
const dryRun = args.includes("--dry-run");
const evolve = args.includes("--evolve");
const injectSkills = args.includes("--inject-skills");
const constraints = args.includes("--constraints");
const rawConcurrency = Number(flag("concurrency") ?? "1");
const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 1;
const modelHint = flag("model");
const provider = flag("provider");
const directModel = flag("model") ?? flag("direct-model");
const fallbackProvider = flag("fallback-provider");
const fallbackModel = flag("fallback-model");

function showHelp() {
  logger.info(`
Agent 能力边界评测 CLI
用法: bun run src/agent-evals/run.ts [options]
Options:
  --family=<f>      只跑指定任务族 (coding|knowledge|planning|tool-use|memory|self-evolve)
  --split=<s>       只跑指定划分 (train|held-out)
  --concurrency=N   并发数 (默认 2)
  --model=<id>      指定模型（默认走 model-router general-chat 角色）
  --provider=<p>    直连 provider（如 zhipu），配合 --model 使用，绕过 model-router
  --fallback-provider=<p>  主 provider 限流/失败时的备用 provider（配合 --fallback-model）
  --fallback-model=<m>     备用模型
  --json            输出 JSON
  --dry-run         预览任务清单
  --evolve          评测→进化闭环：train → held-out baseline → 归纳注册技能 → held-out(注入技能) 对比
  --inject-skills   评测时注入已归纳的 auto-induce-* 技能
  --constraints     附加通用回答约束（完整性/直接性/复杂度标定）
  --help            帮助
`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) showHelp();

const errors = validateTasks();
if (errors.length > 0) {
  logger.error(`任务定义不合法:
${errors.join("\n")}`);
  process.exit(1);
}

const tasks = getTasksByFamily(family, split);
if (dryRun) {
  logger.info(`任务清单（${tasks.length}）:`);
  for (const task of tasks) logger.info(`  [${task.split}] ${task.id} ${task.family} - ${task.title}`);
  process.exit(0);
}
if (tasks.length === 0) {
  logger.error("没有匹配的任务（检查 --family/--split）");
  process.exit(1);
}

if (evolve) {
  const trainTasks = getTasksByFamily(family, "train");
  const heldOutTasks = getTasksByFamily(family, "held-out");
  logger.info(`[Evolve] 阶段1/3: train ${trainTasks.length} 任务（无技能）...`);
  const trainResults = await runTasks(trainTasks, { family, split: "train", concurrency, modelHint, provider, model: directModel, fallbackProvider, fallbackModel });
  logger.info(`[Evolve] 阶段2/3: held-out baseline ${heldOutTasks.length} 任务（无技能）...`);
  const baselineResults = await runTasks(heldOutTasks, { family, split: "held-out", concurrency, modelHint, provider, model: directModel, fallbackProvider, fallbackModel });
  const { evolveFromResults } = await import("./evolve.js");
  const evolved = evolveFromResults(trainResults, ALL_AGENT_TASKS, family);
  logger.info(`[Evolve] 归纳 ${evolved.inductionCount} 个模式 / 方法论技能 ${evolved.craftedCount} 个 / 注册 ${evolved.created.length} 个技能`);
  logger.info(`[Evolve] 阶段3/3: held-out evolved ${heldOutTasks.length} 任务（注入技能）...`);
  const evolvedResults = await runTasks(heldOutTasks, { family, split: "held-out", concurrency, modelHint, provider, model: directModel, injectSkills: true, constraints, fallbackProvider, fallbackModel });

  // 增益反馈：baseline 记录族基线，evolved 记录技能注入结果
  const { getDefaultGainTracker } = await import("./skill-gain.js");
  const gain = getDefaultGainTracker();
  for (const r of baselineResults) gain.recordBaseline(r.family, r.passed);
  for (const r of evolvedResults) {
    for (const skillId of r.injectedSkills ?? []) gain.recordInjection(skillId, r.passed);
  }
  const gainSummary = gain.listGain(family ?? "coding");
  if (gainSummary.length > 0) {
    logger.info(`[Evolve] 增益概览: ${gainSummary.map((g) => `${g.skillId}=+(${g.gain ?? "?"}pp/${g.samples}次)`).join(", ")}`);
  }

  const baseSummary = summarize(baselineResults);
  const evolSummary = summarize(evolvedResults);
  const header = `# 评测→进化闭环对比（held-out）\n\n| 阶段 | 通过率 | 通过/总数 |\n| --- | --- | --- |\n| baseline（无技能） | ${baseSummary.passRate}% | ${baseSummary.passed}/${baseSummary.total} |\n| evolved（注入技能） | ${evolSummary.passRate}% | ${evolSummary.passed}/${evolSummary.total} |\n`;
  console.log(header);
  console.log("## baseline held-out 明细");
  console.log(toMarkdown(baseSummary, baselineResults));
  console.log("## evolved held-out 明细");
  console.log(toMarkdown(evolSummary, evolvedResults));
  process.exit([...baselineResults, ...evolvedResults].some((r) => !r.passed) ? 1 : 0);
}

logger.info(`开始评测 ${tasks.length} 个任务（并发 ${concurrency}）...`);
const results = await runTasks(tasks, { family, split, concurrency, modelHint, provider, model: directModel, injectSkills, constraints, fallbackProvider, fallbackModel });
const summary = summarize(results);

const output = json ? toJSON(summary, results) : toMarkdown(summary, results);
if (json) {
  console.log(output);
} else {
  console.log(output);
}

const failed = results.filter((r) => !r.passed).length;
process.exit(failed > 0 ? 1 : 0);
