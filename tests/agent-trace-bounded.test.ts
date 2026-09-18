/**
 * Agent trace 有界性测试（B3-Medium，docs/reviews/2026-08-29-joint-verification-audit.md §4）
 *
 * 审计症状：agent-trace.ts completeTrace/failTrace 不删 activeTraces 条目 →
 * 长进程内 trace 随任务数无界增长。
 * 修复：完成/失败时将该条目从 activeTraces 删除（结果经返回值交付调用方）。
 */
import { describe, it, expect } from "bun:test";
import {
  startTrace,
  addStep,
  completeTrace,
  failTrace,
  getTrace,
  getAllTraces,
} from "../src/utils/agent-trace.js";

describe("agent-trace 有界（B3-Medium）", () => {
  it("completeTrace 后条目出表（activeTraces 增量归零）", () => {
    const before = getAllTraces().length;
    startTrace("agent-a", "task-t7-complete-1");
    addStep("task-t7-complete-1", { type: "thinking", content: "step" });
    const done = completeTrace("task-t7-complete-1", "ok");
    expect(done?.status).toBe("completed");
    expect(done?.result).toBe("ok");
    expect(done?.steps.length).toBe(1); // 返回值携带完整 trace，调用方语义保持
    expect(getTrace("task-t7-complete-1")).toBeNull(); // 修复前：仍可查到（常驻泄漏）
    expect(getAllTraces().length).toBe(before); // 表内条目增量归零
    expect(getAllTraces().some((t) => t.taskId === "task-t7-complete-1")).toBe(false);
  });

  it("failTrace 后条目出表", () => {
    const before = getAllTraces().length;
    startTrace("agent-a", "task-t7-fail-1");
    const failed = failTrace("task-t7-fail-1", "boom");
    expect(failed?.status).toBe("failed");
    expect(failed?.steps.some((s) => s.type === "error")).toBe(true); // error step 仍在返回值中
    expect(getTrace("task-t7-fail-1")).toBeNull();
    expect(getAllTraces().length).toBe(before);
  });

  it("运行中的 trace 仍可查询（行为保持）", () => {
    startTrace("agent-b", "task-t7-running");
    addStep("task-t7-running", { type: "tool-call", content: "x" });
    expect(getTrace("task-t7-running")?.status).toBe("running");
    expect(getAllTraces().some((t) => t.taskId === "task-t7-running")).toBe(true);
    // 收尾清理，避免影响同文件后续断言
    completeTrace("task-t7-running");
    expect(getTrace("task-t7-running")).toBeNull();
  });
});
