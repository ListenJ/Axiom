/**
 * Orchestrator self-improve 集成测试 — 执行反馈回流自我进化。
 *
 * Contract:
 *   - 构造时注入 selfEvolve（仅需 selfImprove），任务完成后自动调用改进算子：
 *       成功 → feedback.success=true；失败/抛错 → feedback.success=false + error；
 *   - 不注入 engine → 行为与原来完全一致（无额外调用）。
 */
import { describe, test, expect } from "bun:test";
import {
  AgentOrchestrator,
  type AgentInterface,
  type AgentTask,
} from "../../src/agents/orchestrator";
import type { Improvement, ImproveRequest } from "../../src/self-evolve/types.js";

function fakeAgent(behavior: "ok" | "fail" | "throw"): AgentInterface {
  return {
    id: "fake-agent",
    name: "Fake Agent",
    description: "test agent",
    capabilities: ["test-task"],
    execute: async (task: AgentTask) => {
      if (behavior === "throw") throw new Error("agent crashed");
      return {
        taskId: task.id,
        agentId: "fake-agent",
        success: behavior === "ok",
        data: behavior === "ok" ? { ok: true } : undefined,
        error: behavior === "fail" ? "boom" : undefined,
        duration: 1,
      };
    },
    healthCheck: async () => true,
  };
}

function fakeEvolve() {
  const calls: ImproveRequest[] = [];
  const improve = async (req: ImproveRequest): Promise<Improvement> => {
    calls.push(req);
    return { revisedPlan: ["x"], lesson: "", success: req.feedback.success };
  };
  return { improve, calls };
}

const task: AgentTask = {
  id: "task-1",
  type: "test-task",
  description: "Fix MCP timeout",
  input: {},
};

describe("AgentOrchestrator self-improve hook", () => {
  test("successful task reports success feedback", async () => {
    const evolve = fakeEvolve();
    const orchestrator = new AgentOrchestrator({ selfEvolve: { selfImprove: evolve.improve } });
    orchestrator.getRegistry().register(fakeAgent("ok"));

    const result = await orchestrator.executeTask(task);

    expect(result.success).toBe(true);
    expect(evolve.calls).toHaveLength(1);
    expect(evolve.calls[0].task).toBe("Fix MCP timeout");
    expect(evolve.calls[0].feedback.success).toBe(true);
    expect(evolve.calls[0].feedback.error).toBeUndefined();
  });

  test("failed task reports failure feedback with error", async () => {
    const evolve = fakeEvolve();
    const orchestrator = new AgentOrchestrator({ selfEvolve: { selfImprove: evolve.improve } });
    orchestrator.getRegistry().register(fakeAgent("fail"));

    const result = await orchestrator.executeTask(task);

    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
    expect(evolve.calls).toHaveLength(1);
    expect(evolve.calls[0].feedback.success).toBe(false);
    expect(evolve.calls[0].feedback.error).toBe("boom");
  });

  test("thrown agent error reports failure feedback and keeps error result", async () => {
    const evolve = fakeEvolve();
    const orchestrator = new AgentOrchestrator({ selfEvolve: { selfImprove: evolve.improve } });
    orchestrator.getRegistry().register(fakeAgent("throw"));

    const result = await orchestrator.executeTask(task);

    expect(result.success).toBe(false);
    expect(result.error).toContain("agent crashed");
    expect(evolve.calls).toHaveLength(1);
    expect(evolve.calls[0].feedback.success).toBe(false);
    expect(evolve.calls[0].feedback.error).toContain("agent crashed");
  });

  test("without engine, selfImprove is never called", async () => {
    const orchestrator = new AgentOrchestrator();
    orchestrator.getRegistry().register(fakeAgent("ok"));

    const result = await orchestrator.executeTask(task);

    expect(result.success).toBe(true);
  });
});

