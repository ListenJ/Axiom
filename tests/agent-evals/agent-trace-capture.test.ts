/**
 * AgentTrace → RealUsageTrace 映射层（计划切片 A2）
 *
 * 为什么需要它（状态确认结论，计划 §1.9(4)）：`loadRealUsageTraces()` 的收行条件为
 *   `typeof obj.id === "string" && typeof obj.task === "string"`
 * 而 `AgentTrace` 的形状是 { agentName, taskId, startTime, steps, status, result? }，
 * **既无 id 也无 task**。故把 AgentTrace 原样写进该 JSONL，加载时会被**静默跳过**
 * —— 文件里有行、读出来为空，不报错。本测试的第一条用例就是把这个陷阱钉死。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  captureRealUsageTrace,
  captureAgentTrace,
  loadRealUsageTraces,
  clearRealUsageTraces,
} from "../../src/agent-evals/real-usage.js";
import { startTrace, addStep, completeTrace, failTrace } from "../../src/utils/agent-trace.js";

describe("AgentTrace → RealUsage 映射", () => {
  const tmpPath = path.join(process.cwd(), ".tmp", "test-agent-trace-capture.jsonl");

  beforeEach(async () => {
    await clearRealUsageTraces(tmpPath);
  });

  afterEach(async () => {
    await clearRealUsageTraces(tmpPath);
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  test("负向对照：AgentTrace 原样落盘会被 loader 静默跳过（证明映射层不可省）", async () => {
    // 模拟"未做映射就写"的错误做法
    await captureRealUsageTrace(
      { agentName: "a", taskId: "t-raw", startTime: 1, steps: [], status: "completed" } as never,
      tmpPath,
    );
    const loaded = await loadRealUsageTraces(tmpPath);
    expect(loaded.length).toBe(0); // 写了但读不到 —— 这正是要防的陷阱
  });

  test("映射后：completed 轨迹可被 load 回放，id/task/success 正确", async () => {
    startTrace("agent-x", "task-map-1");
    addStep("task-map-1", { type: "thinking", content: "看架构" });
    const trace = completeTrace("task-map-1", "done");
    expect(trace).not.toBeNull();

    await captureAgentTrace(trace!, { filePath: tmpPath, task: "总结项目架构" });

    const loaded = await loadRealUsageTraces(tmpPath);
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.id).toBe("task-map-1");
    expect(loaded[0]?.task).toBe("总结项目架构");
    expect(loaded[0]?.success).toBe(true);
  });

  test("映射后：failed 轨迹 success=false，且不丢错误语义", async () => {
    startTrace("agent-y", "task-map-2");
    const trace = failTrace("task-map-2", "boom");
    expect(trace).not.toBeNull();

    await captureAgentTrace(trace!, { filePath: tmpPath, task: "失败任务" });

    const loaded = await loadRealUsageTraces(tmpPath);
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.success).toBe(false);
  });

  test("映射后：分类用量随轨迹一并落盘并可读回", async () => {
    startTrace("agent-z", "task-map-3");
    const trace = completeTrace("task-map-3", "ok");

    await captureAgentTrace(trace!, {
      filePath: tmpPath,
      task: "带用量的任务",
      tokensByCategory: { main: 1200, embedding: 300 },
      totalTokens: 1500,
    });

    const loaded = await loadRealUsageTraces(tmpPath);
    expect(loaded[0]?.totalTokens).toBe(1500);
    expect(loaded[0]?.tokensByCategory?.embedding).toBe(300);
  });
});

describe("切片 A3c：会话标识贯通", () => {
  const tmpPath = path.join(process.cwd(), ".tmp", "test-agent-trace-session.jsonl");

  afterEach(async () => {
    await clearRealUsageTraces(tmpPath);
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  test("captureAgentTrace 携带 sessionId 时可落盘并读回", async () => {
    startTrace("agent-s", "task-sess-1");
    const trace = completeTrace("task-sess-1", "ok");

    await captureAgentTrace(trace!, { filePath: tmpPath, task: "会话任务", sessionId: "sess-abc" });

    const loaded = await loadRealUsageTraces(tmpPath);
    expect(loaded[0]?.sessionId).toBe("sess-abc");
  });

  test("缺省 sessionId 时不写入该字段（保持独立单元语义）", async () => {
    startTrace("agent-t", "task-sess-2");
    const trace = completeTrace("task-sess-2", "ok");

    await captureAgentTrace(trace!, { filePath: tmpPath, task: "无会话任务" });

    const loaded = await loadRealUsageTraces(tmpPath);
    expect(loaded[0]?.sessionId).toBeUndefined();
  });
});
