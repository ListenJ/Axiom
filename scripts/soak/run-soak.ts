/**
 * S-A7 全量 soak runner（M4 补 / 执行修订记录第 3 条）
 *
 * 跑 N≥200 轮确定性 soak 会话 + 中断-恢复会话，采集 5 项崩坏指标并出报告：
 *   reports/soak/soak-report-<YYYY-MM-DD>.json — 机器可读全量指标
 *   reports/soak/soak-report-<YYYY-MM-DD>.md  — 人类可读摘要
 *
 * 用法：
 *   bun scripts/soak/run-soak.ts [--rounds 240] [--seed 42] [--budget 3000]
 *                                [--recall-threshold 0.9]
 *                                [--interrupt-before 120] [--interrupt-after 120]
 *
 * 确定性：applyDeterministicEnv 清空 *_API_KEY → ContextManager 摘要/embedding
 * 全走 fallback（零网络零 LLM 成本）；同 seed 同消息序列，报告可复现。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { applyDeterministicEnv } from "./soak-core.js";
import {
  runSoakSession,
  runSoakInterruptRecovery,
  assertBudgetPerRound,
  assertRecallConsistency,
  assertNoDuplicateWrites,
  assertInterruptRecovery,
  type SoakSessionResult,
  type InterruptRecoveryResult,
} from "./soak-core.js";

// ── 参数解析 ──
function argValue(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const rounds = argValue("--rounds", 240);
const seed = argValue("--seed", 42);
const budgetTokens = argValue("--budget", 3000);
const recallThreshold = argValue("--recall-threshold", 0.9);
const interruptBefore = argValue("--interrupt-before", 120);
const interruptAfter = argValue("--interrupt-after", 120);

function gitShortHash(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch (e) {
    console.error("[run-soak] commit hash 获取失败:", e instanceof Error ? e.message : e);
    return "unknown";
  }
}

function p95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(0.95 * (sorted.length - 1))]!;
}

function fmtViolations(vs: { kind: string; detail?: string; [k: string]: unknown }[]): string {
  if (vs.length === 0) return "零违例";
  return vs.map((v) => `${v.kind}${v.detail ? `（${v.detail}）` : ""}`).join("; ");
}

async function main(): Promise<void> {
  applyDeterministicEnv();
  const startAll = Date.now();

  console.log(`[run-soak] 会话腿：${rounds} 轮 seed=${seed} budget=${budgetTokens} ...`);
  const session: SoakSessionResult = await runSoakSession({
    rounds,
    seed,
    budgetTokens,
    recallThreshold,
  });
  console.log(
    `[run-soak] 会话腿完成 ${session.durationMs}ms，压缩 ${session.compressEvents} 次，` +
      `异常 ${session.uncaughtAnomalies.length} 个`
  );

  console.log(`[run-soak] 中断-恢复腿：${interruptBefore}+${interruptAfter} 轮 ...`);
  const interrupt: InterruptRecoveryResult = await runSoakInterruptRecovery({
    roundsBeforeInterrupt: interruptBefore,
    roundsAfterResume: interruptAfter,
    seed,
    budgetTokens,
  });
  console.log(
    `[run-soak] 中断-恢复腿完成 ${interrupt.durationMs}ms，锚词存续 ` +
      `${interrupt.anchorsRecoveredAfterResume}/${interrupt.anchorsPlantedBefore}，` +
      `异常 ${interrupt.uncaughtAnomalies.length} 个`
  );

  // ── 5 项断言 ──
  const budgetViolations = assertBudgetPerRound(session);
  const recallViolations = assertRecallConsistency(session);
  const duplicateViolations = assertNoDuplicateWrites(session);
  const interruptViolations = assertInterruptRecovery(interrupt);
  const anomalyCount = session.uncaughtAnomalies.length + interrupt.uncaughtAnomalies.length;

  const pass =
    budgetViolations.length === 0 &&
    recallViolations.length === 0 &&
    duplicateViolations.length === 0 &&
    interruptViolations.length === 0 &&
    anomalyCount === 0;
  const verdict = pass ? "PASS" : "FAIL";

  // ── 派生统计 ──
  const sortedTokens = [...session.perRoundTokens].sort((a, b) => a - b)!;
  const meanTokens =
    session.perRoundTokens.reduce((s, t) => s + t, 0) / Math.max(1, session.perRoundTokens.length);

  const date = new Date().toISOString().slice(0, 10);
  const meta = {
    task: "S-A7",
    date,
    commit: gitShortHash(),
    seed,
    budgetTokens,
    rounds,
    llmMode: "deterministic-fallback" as const,
    recallThreshold,
    interrupt: { before: interruptBefore, after: interruptAfter },
  };

  const reportJson = {
    meta,
    session,
    interruptRecovery: interrupt,
    derived: {
      meanRoundTokens: Math.round(meanTokens),
      p95RoundTokens: p95(sortedTokens),
      maxRoundTokens: sortedTokens[sortedTokens.length - 1] ?? 0,
    },
    assertions: {
      uncaughtAnomalies: session.uncaughtAnomalies.concat(interrupt.uncaughtAnomalies),
      budgetViolations,
      recallViolations,
      duplicateWriteViolations: duplicateViolations,
      interruptRecoveryViolations: interruptViolations,
    },
    verdict,
    durationMs: Date.now() - startAll,
  };

  // ── Markdown 报告 ──
  const md = `# S-A7 Soak 报告（${date}）

## 结论：**${verdict}**

| 项 | 值 |
|---|---|
| 任务 | S-A7 长会话不崩坏（M4 补） |
| commit | ${meta.commit} |
| 轮数 / 预算 / 种子 | ${rounds} 轮 / ${budgetTokens} tokens / seed=${seed} |
| LLM 模式 | ${meta.llmMode}（零网络、确定性可复现） |
| 中断-恢复腿 | ${interruptBefore}+${interruptAfter} 轮 |
| 总耗时 | ${reportJson.durationMs}ms |

## 5 项崩坏指标

| # | 指标 | 实测 | 判定 |
|---|------|------|------|
| 1 | 零未捕获异常 | 两腿合计 ${anomalyCount} 个 | ${anomalyCount === 0 ? "PASS" : "FAIL"} |
| 2 | 逐轮上下文 ≤ 预算 | max ${reportJson.derived.maxRoundTokens} / p95 ${reportJson.derived.p95RoundTokens} / 均值 ${reportJson.derived.meanRoundTokens}（预算 ${budgetTokens}） | ${budgetViolations.length === 0 ? "PASS" : "FAIL"} |
| 3 | 植入记忆召回一致率 | ${(session.recall.rate * 100).toFixed(1)}%（${session.recall.hits}/${session.recall.planted}，阈值 ${(recallThreshold * 100).toFixed(0)}%） | ${recallViolations.length === 0 ? "PASS" : "FAIL"} |
| 4 | 重复注入零重复写入 | ${session.duplicateWrites.injections} 批次；KG 节点 +${session.duplicateWrites.kgNodeRowsAdded} / KG 边 +${session.duplicateWrites.kgEdgeRowsAdded} / sqlite +${session.duplicateWrites.sqliteRowsAdded} | ${duplicateViolations.length === 0 ? "PASS" : "FAIL"} |
| 5 | 中断-恢复可续 | 锚词存续 ${interrupt.anchorsRecoveredAfterResume}/${interrupt.anchorsPlantedBefore}；恢复后 ${interrupt.perRoundTokensAfterResume.length} 轮全完成，压缩 ${interrupt.compressEventsAfterResume} 次 | ${interruptViolations.length === 0 ? "PASS" : "FAIL"} |

## 会话腿明细

- 压缩/分割事件：${session.compressEvents} 次
- 逐轮 token：均值 ${reportJson.derived.meanRoundTokens} / p95 ${reportJson.derived.p95RoundTokens} / 最大 ${reportJson.derived.maxRoundTokens}（预算 ${budgetTokens}）
- 未捕获异常：${session.uncaughtAnomalies.length === 0 ? "无" : session.uncaughtAnomalies.join("; ")}

## 中断-恢复腿明细

- 中断点：第 ${interrupt.interruptedAtRound} 轮（无收尾直接丢弃运行态，等价进程死亡）
- 持久记忆存续：${interrupt.anchorsRecoveredAfterResume}/${interrupt.anchorsPlantedBefore} 个中断前锚词在重开 db 后精确取回
- 恢复后：${interrupt.perRoundTokensAfterResume.length} 轮全部完成，压缩/分割 ${interrupt.compressEventsAfterResume} 次，未捕获异常 ${interrupt.uncaughtAnomalies.length} 个

## 断言违例明细

${[
  ["预算违例", budgetViolations],
  ["召回违例", recallViolations],
  ["重复写入违例", duplicateViolations],
  ["中断-恢复违例", interruptViolations],
]
  .map(([name, vs]) => `- ${name}：${fmtViolations(vs as never)}`)
  .join("\n")}

## 口径说明

- 恢复口径：ContextManager 进程内记忆不跨进程（架构事实），恢复层为 sqlite-memory（Vault 索引同源）；
  指标验证持久层存活 + 全新实例续跑会话。
- 召回口径：fallback 摘要递归吸收历史决策消息，字符频率向量同分、top-K 排序无判别力，
  故按全量检索验证"记忆不凭空丢失"（存续率）；top-K 排序一致性待 S-A2 真实 embedding 接入后增强。
- 复现：\`bun scripts/soak/run-soak.ts --rounds ${rounds} --seed ${seed} --budget ${budgetTokens}\`
`;

  // ── 落盘 ──
  const outDir = path.join("reports", "soak");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `soak-report-${date}.json`);
  const mdPath = path.join(outDir, `soak-report-${date}.md`);
  writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2) + "\n");
  writeFileSync(mdPath, md);

  console.log(`[run-soak] 报告已写入 ${jsonPath} 与 ${mdPath}`);
  console.log(`[run-soak] 判定：${verdict}`);
  if (!pass) process.exit(1);
}

main();
