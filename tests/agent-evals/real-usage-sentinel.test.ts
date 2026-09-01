import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  captureRealUsageTrace,
  evolveFromRealUsage,
  assessTraceHealth,
  clearRealUsageTraces,
} from "../../src/agent-evals/real-usage.js";

/**
 * 数据质量 sentinel — 畸形率拒卷门。
 *
 * 目标：evolve 前评估轨迹文件健康度，畸形率 ≥ 阈值（默认 0.2）时拒卷
 * （refused:"malformed-rate"），不归纳、不删除、不改动轨迹文件。
 * 防损坏/脏数据被误归纳产生垃圾 auto-induce-* skill。
 */

describe("real-usage 数据质量 sentinel", () => {
  const tmpPath = path.join(process.cwd(), ".tmp", "test-real-usage-sentinel.jsonl");

  beforeEach(async () => {
    process.env.REAL_USAGE_PATH = tmpPath;
    await clearRealUsageTraces(tmpPath);
  });

  afterEach(async () => {
    await clearRealUsageTraces(tmpPath);
    delete process.env.REAL_USAGE_PATH;
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  test("assessTraceHealth 正常文件畸形率为 0", async () => {
    await captureRealUsageTrace({ id: "h-1", task: "ok task", success: true } as any, tmpPath);
    await captureRealUsageTrace({ id: "h-2", task: "ok task 2", success: false } as any, tmpPath);
    const health = await assessTraceHealth(tmpPath);
    expect(health.total).toBe(2);
    expect(health.malformed).toBe(0);
    expect(health.malformedRate).toBe(0);
  });

  test("assessTraceHealth 统计畸形行（损坏 JSON + 缺字段）", async () => {
    await captureRealUsageTrace({ id: "g-1", task: "good", success: true } as any, tmpPath);
    // 追加损坏 JSON 行 + 缺 id/task 字段的合法 JSON 行
    fs.appendFileSync(tmpPath, "{ not valid json }\n", "utf8");
    fs.appendFileSync(tmpPath, JSON.stringify({ success: true }) + "\n", "utf8");
    const health = await assessTraceHealth(tmpPath);
    expect(health.total).toBe(3);
    expect(health.malformed).toBe(2);
    expect(health.malformedRate).toBeCloseTo(2 / 3, 5);
  });

  test("畸形率超过阈值时 evolve 拒卷（refused:malformed-rate）", async () => {
    // 1 条合法 + 2 条畸形 → 畸形率 2/3 ≥ 0.2 → 拒卷
    await captureRealUsageTrace({ id: "v-1", task: "valid", success: true } as any, tmpPath);
    fs.appendFileSync(tmpPath, "{ bad }\n", "utf8");
    fs.appendFileSync(tmpPath, "not json either\n", "utf8");
    const result = await evolveFromRealUsage(tmpPath);
    expect(result.refused).toBe("malformed-rate");
    expect(result.inductionCount).toBe(0);
    expect(result.created).toEqual([]);
    expect(result.traceCount).toBe(1); // 合法轨迹数（health.total - malformed）
    expect(result.health).toBeDefined();
    expect(result.health?.malformedRate).toBeCloseTo(2 / 3, 5);
  });

  test("畸形率低于阈值时正常 evolve（不拒卷）", async () => {
    // 5 条合法 + 1 条畸形 → 畸形率 1/6 ≈ 0.167 < 0.2 → 不拒卷
    for (let i = 0; i < 5; i++) {
      await captureRealUsageTrace({ id: `n-${i}`, task: `pattern task ${i}`, success: true } as any, tmpPath);
    }
    fs.appendFileSync(tmpPath, "{ malformed }\n", "utf8");
    const result = await evolveFromRealUsage(tmpPath);
    expect(result.refused).toBeUndefined();
    expect(result.traceCount).toBe(5); // 合法轨迹数
  });

  test("阈值可通过 env 调高（AXIOM_EVOLVE_MAX_MALFORMED_RATE=1 永不拒卷）", async () => {
    process.env.AXIOM_EVOLVE_MAX_MALFORMED_RATE = "1";
    await captureRealUsageTrace({ id: "e-1", task: "valid", success: true } as any, tmpPath);
    fs.appendFileSync(tmpPath, "{ bad }\n", "utf8");
    const result = await evolveFromRealUsage(tmpPath);
    expect(result.refused).toBeUndefined();
    delete process.env.AXIOM_EVOLVE_MAX_MALFORMED_RATE;
  });

  test("阈值可通过 env 调低（=0 时任何畸形都拒卷）", async () => {
    process.env.AXIOM_EVOLVE_MAX_MALFORMED_RATE = "0";
    await captureRealUsageTrace({ id: "z-1", task: "valid", success: true } as any, tmpPath);
    fs.appendFileSync(tmpPath, "{ bad }\n", "utf8");
    const result = await evolveFromRealUsage(tmpPath);
    expect(result.refused).toBe("malformed-rate");
    delete process.env.AXIOM_EVOLVE_MAX_MALFORMED_RATE;
  });

  test("空文件不拒卷且不崩（refused 未定义）", async () => {
    const result = await evolveFromRealUsage(tmpPath);
    expect(result.refused).toBeUndefined();
    expect(result.traceCount).toBe(0);
    expect(result.inductionCount).toBe(0);
  });
});
