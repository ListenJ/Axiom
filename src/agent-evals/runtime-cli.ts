/**
 * Runtime 评测 CLI
 *
 * 用法：
 *   bun run src/agent-evals/runtime-cli.ts                     # 跑全部（train + held-out）
 *   bun run src/agent-evals/runtime-cli.ts --split=held-out     # 只跑留出集（验收）
 *   bun run src/agent-evals/runtime-cli.ts --family=safety      # 只跑安全族
 *   bun run src/agent-evals/runtime-cli.ts --no-save            # 不落盘
 *
 * 产出：
 *   - 控制台指标表
 *   - eval-results/runtime/<runId>.json  （原始 run，供后续过拟合分析）
 *   - eval-results/runtime/<runId>.md    （可读报告）
 *
 * 设计要点（防"同设备过拟合"）：
 *   每次运行都会记录**环境指纹**，并把同 suite 的历史 run 一并喂给
 *   `analyzeOverfitting()`，直接给出"当前结论能不能固化为约束"的判断。
 *   设备相关指标在报告里单独标注，提示不可跨机器比较。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRuntimeEval } from "./runtime-runner.js";
import {
  RUNTIME_METRICS,
  METRIC_BY_KEY,
  analyzeOverfitting,
  type RuntimeEvalRun,
} from "./runtime-metrics.js";
import { logger } from "../utils/logger.js";

const OUT_DIR = "eval-results/runtime";

function parseArgs(argv: string[]): { split?: "train" | "held-out"; family?: "safety" | "search"; save: boolean } {
  const out: { split?: "train" | "held-out"; family?: "safety" | "search"; save: boolean } = { save: true };
  for (const a of argv) {
    if (a.startsWith("--split=")) {
      const v = a.slice(8);
      if (v === "train" || v === "held-out") out.split = v;
    } else if (a.startsWith("--family=")) {
      const v = a.slice(9);
      if (v === "safety" || v === "search") out.family = v;
    } else if (a === "--no-save") out.save = false;
  }
  return out;
}

function fmt(key: string, v: number | null): string {
  if (v === null || v === undefined) return "—";
  const def = METRIC_BY_KEY[key];
  return `${v.toFixed(def?.unit === "%" ? 1 : 3)}${def?.unit ?? ""}`;
}

/** 读取历史 run（同 suite），供过拟合分析 */
function loadHistory(): RuntimeEvalRun[] {
  try {
    return readdirSync(OUT_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(OUT_DIR, f), "utf-8")) as RuntimeEvalRun);
  } catch {
    return [];
  }
}

function buildReport(
  run: RuntimeEvalRun,
  safety: Awaited<ReturnType<typeof runRuntimeEval>>["safety"],
  search: Awaited<ReturnType<typeof runRuntimeEval>>["search"],
  executionErrors: number,
  analysis: ReturnType<typeof analyzeOverfitting>,
): string {
  const lines: string[] = [];
  lines.push(`# Runtime 评测报告 — ${run.runId}`);
  lines.push("");
  lines.push(`- 题集：\`${run.suiteId}\``);
  lines.push(`- 环境：${run.fingerprint.os} / ${run.fingerprint.cpuModel} ×${run.fingerprint.cpuCount} / ${run.fingerprint.totalMemMb}MB / ${run.fingerprint.runtime}`);
  lines.push(`- 模型配置：${run.fingerprint.models.join(", ") || "(未记录)"}`);
  lines.push(`- **执行失败样本**：${executionErrors} 条（已从指标中剔除；执行失败 ≠ 能力失败）`);
  lines.push("");

  lines.push("## 指标");
  lines.push("");
  lines.push("| 指标 | 值 | 类别 | 设备相关 | 说明 |");
  lines.push("|---|---|---|---|---|");
  for (const def of RUNTIME_METRICS) {
    const v = run.metrics[def.key];
    if (v === undefined) continue;
    lines.push(
      `| ${def.label} | ${fmt(def.key, v ?? null)} | ${def.kind} | ${def.deviceDependent ? "**是**" : "否"} | ${def.desc} |`,
    );
  }
  lines.push("");
  lines.push("> 标注「设备相关 = 是」的指标跨机器不可比，**不得**写入 CI 绝对阈值；跨机请只比相对量。");
  lines.push("");

  lines.push("## 过拟合分析");
  lines.push("");
  lines.push(`**结论**：${analysis.verdict}`);
  lines.push("");
  if (analysis.signals.length > 0) {
    lines.push("| 类型 | 级别 | 明细 |");
    lines.push("|---|---|---|");
    for (const s of analysis.signals) lines.push(`| ${s.kind} | ${s.severity} | ${s.detail} |`);
  } else {
    lines.push("（无信号）");
  }
  lines.push("");

  if (safety.length > 0) {
    lines.push("## safety 逐题");
    lines.push("");
    lines.push("| 题 | 切分 | 命令 | 期望 | 层级 | 审批判定 | 结果 | 正确 | 备注 |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const o of safety) {
      lines.push(
        `| ${o.taskId} | ${o.split} | \`${o.command.slice(0, 40)}\` | ${o.expect} | ${o.level} | ` +
          `${o.approverDecided ? (o.approverApproved ? "approve" : "deny") : "unavailable"} | ` +
          `${o.blocked ? "blocked" : "allowed"} | ${o.correct ? "✅" : "❌"} | ${o.reason.slice(0, 60)} |`,
      );
    }
    lines.push("");
  }

  if (search.length > 0) {
    lines.push("## search 逐题");
    lines.push("");
    lines.push("| 题 | 切分 | 查询 | 结果数 | 域名数 | 命中 | 兜底 | 引擎 |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const o of search) {
      lines.push(
        `| ${o.taskId} | ${o.split} | ${o.query.slice(0, 30)} | ${o.resultCount} | ${o.uniqueDomains} | ` +
          `${o.relevant ? "✅" : "❌"} | ${o.fallbackTriggered ? "是" : "否"} | ${o.enginesUsed.join(",") || "—"} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  logger.info("[RuntimeEval] 开始", args);

  // 记录本次运行用的模型配置 —— 跨配置比对是防过拟合的关键维度之一，
  // 不记录就永远只能得到"全部来自同一套配置"的警告。
  let models: string[] = [];
  try {
    const { listConfiguredModels } = await import("../agents/approver-model.js");
    models = listConfiguredModels().map(
      (m: { provider: string; model: string }) => `${m.provider}/${m.model}`,
    );
  } catch {
    /* 模型配置不可读时不阻断评测 */
  }
  let commit: string | undefined;
  try {
    commit = (
      await import("node:child_process")
    ).execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    /* 非 git 环境 */
  }

  const result = await runRuntimeEval({
    split: args.split,
    family: args.family,
    models,
    commit,
  });

  const history = loadHistory();
  const analysis = analyzeOverfitting([...history, result.run]);

  // 控制台指标表
  console.log("\n=== Runtime 指标 ===");
  for (const def of RUNTIME_METRICS) {
    const v = result.run.metrics[def.key];
    if (v === undefined) continue;
    console.log(
      `  ${def.deviceDependent ? "[设备相关] " : ""}${def.label.padEnd(22)} ${fmt(def.key, v ?? null)}`,
    );
  }
  console.log(`\n  执行失败样本: ${result.executionErrors}`);
  console.log(`\n=== 过拟合分析 ===\n  ${analysis.verdict}`);
  for (const s of analysis.signals) console.log(`  [${s.severity}] ${s.kind}: ${s.detail}`);

  if (args.save) {
    mkdirSync(OUT_DIR, { recursive: true });
    const jsonPath = join(OUT_DIR, `${result.run.runId}.json`);
    const mdPath = join(OUT_DIR, `${result.run.runId}.md`);
    writeFileSync(jsonPath, JSON.stringify(result.run, null, 2), "utf-8");
    writeFileSync(
      mdPath,
      buildReport(result.run, result.safety, result.search, result.executionErrors, analysis),
      "utf-8",
    );
    console.log(`\n已写入:\n  ${jsonPath}\n  ${mdPath}`);
  }

  // 有高风险信号时以非 0 退出，便于 CI 拦截
  if (analysis.blockConstraint) process.exitCode = 1;

  // 显式退出：搜索/审批链路会留下未释放的句柄（连接池、定时器等），
  // 实测报告写完后进程仍不退出（曾挂 11 分钟以上）。此处报告已同步落盘，
  // 直接结束进程，避免调用方（含 CI）被无限期挂住。
  process.exit(analysis.blockConstraint ? 1 : 0);
}

main().catch((e) => {
  logger.error("[RuntimeEval] 失败", e as Error);
  process.exitCode = 1;
});
