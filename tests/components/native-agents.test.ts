import { describe, it, expect } from "bun:test";
import { ComponentKernel } from "../../src/components/kernel.js";
import {
  NativeGeneralAgent,
  NativeCodeAgent,
  NativeResearchAgent,
  registerNativeAgents,
  type NativeCodeToolchain,
  type NativeAgentOptions,
} from "../../src/components/native-agents.js";
import type { AgentTask } from "../../src/components/contracts.js";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    type: "general-chat",
    description: "Test task",
    input: {},
    ...overrides,
  };
}

describe("Native Agents", () => {
  it("native-general executes with a fake executor", async () => {
    const agent = new NativeGeneralAgent({
      executor: async () => ({
        content: "hello",
        model: "fake",
        provider: "test",
      }),
    });
    const result = await agent.execute(task());
    expect(result.success).toBe(true);
    expect(result.agentId).toBe("native-general");
    expect(result.data).toMatchObject({ message: "hello" });
  });

  it("native-general degrades clearly without an executor", async () => {
    const agent = new NativeGeneralAgent();
    const result = await agent.execute(task());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Model backend");
  });

  it("native-code uses the Pi toolchain first", async () => {
    const calls: string[] = [];
    const toolchain: NativeCodeToolchain = {
      available: async () => true,
      run: async (type) => {
        calls.push(type);
        return { success: true, data: { code: "const x = 1" } };
      },
    };
    const agent = new NativeCodeAgent({ codeToolchain: toolchain });
    const result = await agent.execute(
      task({ id: "task-code", type: "code-generation", input: { prompt: "write code" } }),
    );
    expect(calls).toEqual(["code-generation"]);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ engine: "pi", code: "const x = 1" });
  });

  it("native-code falls back to the model executor when toolchain is unavailable", async () => {
    const executorCalls: string[] = [];
    const options: NativeAgentOptions = {
      codeToolchain: {
        available: async () => false,
        run: async () => ({ success: false, error: "unavailable" }),
      },
      executor: async (role) => {
        executorCalls.push(role);
        return { content: "fallback", model: "fake", provider: "test" };
      },
    };
    const agent = new NativeCodeAgent(options);
    const result = await agent.execute(
      task({ id: "task-code-2", type: "code-generation", input: { prompt: "write code" } }),
    );
    expect(executorCalls).toContain("code-generation");
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ message: "fallback" });
  });

  it("native-research exposes research capabilities and health", async () => {
    const agent = new NativeResearchAgent();
    expect(agent.id).toBe("native-research");
    expect(agent.capabilities).toContain("research");
    const health = await agent.health();
    expect(health.ready).toBe(true);
    expect(health.optional).toBe(false);
  });

  it("registerNativeAgents registers all three native components", () => {
    const kernel = new ComponentKernel();
    registerNativeAgents(kernel, {});
    const ids = kernel.list().map((component) => component.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "native-general",
        "native-code",
        "native-research",
      ]),
    );
  });
});
