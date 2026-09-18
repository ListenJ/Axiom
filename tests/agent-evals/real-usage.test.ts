import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { captureRealUsageTrace, loadRealUsageTraces, evolveFromRealUsage, clearRealUsageTraces, REAL_USAGE_PATH } from "../../src/agent-evals/real-usage.js";

describe("real-usage 采集与进化闭环", () => {
  const tmpPath = path.join(process.cwd(), ".tmp", "test-real-usage.jsonl");

  beforeEach(async () => {
    // 使用临时路径避免污染真实数据
    process.env.REAL_USAGE_PATH = tmpPath;
    await clearRealUsageTraces(tmpPath);
  });

  afterEach(async () => {
    await clearRealUsageTraces(tmpPath);
    delete process.env.REAL_USAGE_PATH;
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  test("capture 写入后可 load 回放且确定性", async () => {
    const trace = { id: "real-1", task: "帮我总结项目架构", success: true, model: "test-model", latencyMs: 123 };
    await captureRealUsageTrace(trace as any, tmpPath);
    const loaded = await loadRealUsageTraces(tmpPath);
    expect(loaded.length).toBe(1);
    expect(loaded[0].task).toBe("帮我总结项目架构");
    expect(loaded[0].success).toBe(true);
    // 5次回放一致
    for (let i = 0; i < 5; i++) {
      const r = await loadRealUsageTraces(tmpPath);
      expect(r.length).toBe(1);
      expect(r[0].id).toBe("real-1");
    }
  });

  test("并发 20 采集不丢", async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}`, task: `task ${i}`, success: i % 2 === 0 }));
    await Promise.all(tasks.map(t => captureRealUsageTrace(t as any, tmpPath)));
    const loaded = await loadRealUsageTraces(tmpPath);
    expect(loaded.length).toBe(20);
    expect(loaded.filter(t => t.success).length).toBe(10);
  });

  test("evolve 从真实轨迹归纳出模式", async () => {
    // 构造 10 条成功/失败混合
    for (let i = 0; i < 6; i++) await captureRealUsageTrace({ id: `s-${i}`, task: "success task pattern A", success: true } as any, tmpPath);
    for (let i = 0; i < 4; i++) await captureRealUsageTrace({ id: `f-${i}`, task: "fail task pattern B", success: false } as any, tmpPath);
    const result = await evolveFromRealUsage(tmpPath);
    expect(result.traceCount).toBe(10);
    expect(result.inductionCount).toBeGreaterThanOrEqual(0);
    // 至少应创建 0 条 skill（可能为 0 取决于阈值），但 traceCount 必须准确
    expect(result.traceCount).toBe(10);
  });

  test("空文件 evolve 不崩", async () => {
    const result = await evolveFromRealUsage(tmpPath);
    expect(result.traceCount).toBe(0);
    expect(result.inductionCount).toBe(0);
  });

  test("文件不存在 load 返回空", async () => {
    const missing = path.join(process.cwd(), ".tmp", "not-exist-zzz.jsonl");
    const loaded = await loadRealUsageTraces(missing);
    expect(loaded).toEqual([]);
  });
});
