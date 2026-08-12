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
const concurrency = Number(flag("concurrency") ?? "2");
const modelHint = flag("model");

function showHelp() {
  logger.info(`
Agent 能力边界评测 CLI
用法: bun run src/agent-evals/run.ts [options]
Options:
  --family=<f>      只跑指定任务族 (coding|knowledge|planning|tool-use|memory|self-evolve)
  --split=<s>       只跑指定划分 (train|held-out)
  --concurrency=N   并发数 (默认 2)
  --model=<id>      指定模型（默认走 model-router general-chat 角色）
  --json            输出 JSON
  --dry-run         预览任务清单
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

logger.info(`开始评测 ${tasks.length} 个任务（并发 ${concurrency}）...`);
const results = await runTasks(tasks, { family, split, concurrency, modelHint });
const summary = summarize(results);

const output = json ? toJSON(summary, results) : toMarkdown(summary, results);
if (json) {
  console.log(output);
} else {
  console.log(output);
}

const failed = results.filter((r) => !r.passed).length;
process.exit(failed > 0 ? 1 : 0);
