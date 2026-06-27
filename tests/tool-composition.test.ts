import { describe, it, expect, beforeEach } from "bun:test";
import { compositionEngine } from "../src/mcp/tool-composition.js";

describe("Tool Composition", () => {
  let executed: string[] = [];

  beforeEach(() => {
    executed = [];
    // Set up a mock executor
    compositionEngine.setExecutor(async (toolName: string, args: Record<string, unknown>) => {
      executed.push(toolName);
      return { tool: toolName, input: args.input, success: true };
    });
  });

  it("creates and executes a sequential pipeline", async () => {
    compositionEngine.createSequential("test-seq", "Test Sequential", [
      { tool: "step1" },
      { tool: "step2" },
      { tool: "step3" },
    ]);

    const result = await compositionEngine.execute("test-seq", { data: "initial" });

    expect(result.success).toBe(true);
    expect(result.steps.length).toBe(3);
    expect(executed).toEqual(["step1", "step2", "step3"]);
    expect(result.finalResult).toBeDefined();
  });

  it("creates and executes a parallel pipeline", async () => {
    compositionEngine.createParallel("test-par", "Test Parallel", [
      { tool: "a" },
      { tool: "b" },
      { tool: "c" },
    ]);

    const result = await compositionEngine.execute("test-par");

    expect(result.success).toBe(true);
    expect(result.steps.length).toBe(3);
    expect(result.finalResult).toBeInstanceOf(Array);
  });

  it("handles step failures", async () => {
    compositionEngine.setExecutor(async (toolName: string) => {
      if (toolName === "fail-step") {
        throw new Error("Step failed");
      }
      return { success: true };
    });

    compositionEngine.createSequential("test-fail", "Test Fail", [
      { tool: "ok-step" },
      { tool: "fail-step" },
      { tool: "never-run" },
    ]);

    const result = await compositionEngine.execute("test-fail");

    expect(result.success).toBe(false);
    expect(result.steps.length).toBe(2); // Third step never ran
    expect(result.steps[1].success).toBe(false);
    expect(result.steps[1].error).toBe("Step failed");
  });

  it("skips failed steps with onError=skip", async () => {
    compositionEngine.setExecutor(async (toolName: string) => {
      if (toolName === "fail-step") {
        throw new Error("Step failed");
      }
      return { success: true };
    });

    compositionEngine.createSequential("test-skip", "Test Skip", [
      { tool: "ok-step" },
      { tool: "fail-step" },
      { tool: "should-run" },
    ]);

    // Manually set onError for the second step
    const pipeline = compositionEngine.listPipelines().find((p) => p.id === "test-skip");
    if (pipeline) {
      pipeline.steps[1].onError = "skip";
    }

    const result = await compositionEngine.execute("test-skip");

    expect(result.success).toBe(false); // Still false because a step failed
    expect(result.steps.length).toBe(3); // All steps ran
    expect(result.steps[2].success).toBe(true); // Third step ran
  });

  it("returns error for non-existent pipeline", async () => {
    const result = await compositionEngine.execute("non-existent");
    expect(result.success).toBe(false);
  });

  it("lists registered pipelines", () => {
    compositionEngine.createSequential("p1", "Pipeline 1", [{ tool: "a" }]);
    compositionEngine.createParallel("p2", "Pipeline 2", [{ tool: "b" }]);

    const pipelines = compositionEngine.listPipelines();
    expect(pipelines.length).toBeGreaterThanOrEqual(2);
  });

  it("removes pipelines", () => {
    compositionEngine.createSequential("removable", "Removable", [{ tool: "a" }]);
    expect(compositionEngine.listPipelines().some((p) => p.id === "removable")).toBe(true);

    compositionEngine.removePipeline("removable");
    expect(compositionEngine.listPipelines().some((p) => p.id === "removable")).toBe(false);
  });
});
