/**
 * 确定性复现跑批 — 规则 13.5 / docs/LIMITATIONS.md §5.5 第 2 条
 *
 * 规则 13.5 要求：声称"确定性"的模块，同一输入须在 **N ≥ 5 次独立进程**（跨进程，
 * 而非同进程内循环）中比对输出是否逐字段一致。
 *
 * 本测试驱动 `scripts/determinism-repro.ts`：固定输入 → 规范序列化（丢弃已披露的易变耗时字段）
 * → sha256。断言 5 次独立进程的 hash 必须**完全相同**。
 *
 * 覆盖范围（不夸大）：只覆盖 `DeterministicRetrievalEngine.retrieve()` /
 * `retrieveWithPaths()` 在**注入固定依赖**下的语义结果与顺序。
 * 不含：真实 SQLite 后端、LLM 分支、跨机器/locale/ICU 差异、并发。
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";

const RUNS = 5; // 规则 13.5 的下限

function runOnce(): string {
  const proc = spawnSync("bun", ["run", "scripts/determinism-repro.ts"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NODE_ENV: "test" },
  });
  if (proc.status !== 0) {
    throw new Error(`determinism-repro 退出码 ${proc.status}\nstderr:\n${proc.stderr}`);
  }
  const line = proc.stdout.split("\n").find((l) => l.startsWith("DETERMINISM_HASH="));
  if (!line) throw new Error(`未找到 DETERMINISM_HASH 行；stdout=\n${proc.stdout}`);
  return line.slice("DETERMINISM_HASH=".length).trim();
}

describe("确定性复现 — 跨进程同输入同输出（N≥5）", () => {
  test(`${RUNS} 个独立进程输出同一 hash`, () => {
    const hashes: string[] = [];
    for (let i = 0; i < RUNS; i++) hashes.push(runOnce());

    const distinct = [...new Set(hashes)];
    if (distinct.length !== 1) {
      console.log("[determinism-repro] 各进程 hash：\n" + hashes.map((h, i) => `  #${i + 1} ${h}`).join("\n"));
    }
    expect(distinct.length, `期望全部 ${RUNS} 次进程 hash 一致，实际 ${distinct.length} 个不同值`).toBe(1);
    expect(distinct[0]).toMatch(/^[0-9a-f]{64}$/);
    // 预算（2026-10-19）：本用例循环 5 次、每次子进程预算 60s，最坏 300s；
    // 原 120s 会被单次变慢击穿。取 5×60s + 100s 余量。
  }, 400_000);
});
