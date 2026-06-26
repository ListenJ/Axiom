/**
 * 多 Agent 编排器测试
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  AgentOrchestrator,
  InternalAgent,
  CodeAgent,
  ResearchAgent,
  type AgentTask,
} from "../src/agents/orchestrator";

describe("AgentOrchestrator", () => {
  let orchestrator: AgentOrchestrator;

  beforeAll(() => {
    orchestrator = new AgentOrchestrator();
    orchestrator.getRegistry().register(new InternalAgent());
    orchestrator.getRegistry().register(new CodeAgent());
    orchestrator.getRegistry().register(new ResearchAgent());
  });

  describe("Agent Registry", () => {
    test("list registered agents", () => {
      const agents = orchestrator.getRegistry().list();
      expect(agents.length).toBe(3);
      expect(agents.map((a) => a.id)).toContain("internal");
      expect(agents.map((a) => a.id)).toContain("opencode");
      expect(agents.map((a) => a.id)).toContain("hermes");
    });

    test("get agent by id", () => {
      const agent = orchestrator.getRegistry().get("internal");
      expect(agent).toBeDefined();
      expect(agent?.name).toBe("Internal Agent");
    });

    test("find agents by capability", () => {
      const codeAgents = orchestrator.getRegistry().findByCapability("code-generation");
      expect(codeAgents.length).toBeGreaterThanOrEqual(1);
      expect(codeAgents[0].id).toBe("opencode");

      const researchAgents = orchestrator.getRegistry().findByCapability("research");
      expect(researchAgents.length).toBeGreaterThanOrEqual(1);
      expect(researchAgents[0].id).toBe("hermes");
    });

    test("register and unregister agent", () => {
      const customAgent = new InternalAgent();
      customAgent.id = "custom";
      customAgent.name = "Custom Agent";

      orchestrator.getRegistry().register(customAgent);
      expect(orchestrator.getRegistry().get("custom")).toBeDefined();

      orchestrator.getRegistry().unregister("custom");
      expect(orchestrator.getRegistry().get("custom")).toBeUndefined();
    });
  });

  describe("Task Execution", () => {
    test("execute single task", async () => {
      const task: AgentTask = {
        id: "task-1",
        type: "general",
        description: "Test task",
        input: { query: "Hello" },
      };

      const result = await orchestrator.executeTask(task);
      expect(result.taskId).toBe("task-1");
      expect(result.success).toBe(true);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    test("execute task with no matching agent", async () => {
      const task: AgentTask = {
        id: "task-none",
        type: "nonexistent-type",
        description: "Task with no matching agent",
        input: {},
      };

      const result = await orchestrator.executeTask(task);
      // Should fall back to general agent
      expect(result.success).toBe(true);
    });
  });

  describe("Plan Execution", () => {
    test("execute sequential plan", async () => {
      const plan = {
        id: "plan-seq",
        name: "Sequential Plan",
        mode: "sequential" as const,
        steps: [
          {
            id: "step-1",
            name: "Step 1",
            agentId: "internal",
            task: {
              id: "task-1",
              type: "general",
              description: "First step",
              input: {},
            },
          },
          {
            id: "step-2",
            name: "Step 2",
            agentId: "internal",
            task: {
              id: "task-2",
              type: "general",
              description: "Second step",
              input: {},
            },
          },
        ],
      };

      const result = await orchestrator.executePlan(plan);
      expect(result.planId).toBe("plan-seq");
      expect(result.success).toBe(true);
      expect(result.stepResults.size).toBe(2);
    });

    test("execute parallel plan", async () => {
      const plan = {
        id: "plan-par",
        name: "Parallel Plan",
        mode: "parallel" as const,
        steps: [
          {
            id: "step-a",
            name: "Step A",
            agentId: "internal",
            task: {
              id: "task-a",
              type: "general",
              description: "Parallel step A",
              input: {},
            },
          },
          {
            id: "step-b",
            name: "Step B",
            agentId: "opencode",
            task: {
              id: "task-b",
              type: "code-generation",
              description: "Parallel step B",
              input: {},
            },
          },
        ],
      };

      const result = await orchestrator.executePlan(plan);
      expect(result.success).toBe(true);
      expect(result.stepResults.size).toBe(2);
    });

    test("execute DAG plan", async () => {
      const plan = {
        id: "plan-dag",
        name: "DAG Plan",
        mode: "dag" as const,
        steps: [
          {
            id: "dag-1",
            name: "Step 1",
            agentId: "internal",
            task: {
              id: "dag-task-1",
              type: "general",
              description: "First step",
              input: {},
            },
          },
          {
            id: "dag-2",
            name: "Step 2",
            agentId: "internal",
            task: {
              id: "dag-task-2",
              type: "general",
              description: "Second step",
              input: {},
            },
            dependsOn: ["dag-1"],
          },
          {
            id: "dag-3",
            name: "Step 3",
            agentId: "internal",
            task: {
              id: "dag-task-3",
              type: "general",
              description: "Third step",
              input: {},
            },
            dependsOn: ["dag-1"],
          },
        ],
      };

      const result = await orchestrator.executePlan(plan);
      expect(result.success).toBe(true);
      expect(result.stepResults.size).toBe(3);
    });
  });

  describe("Health Check", () => {
    test("health check all agents", async () => {
      const health = await orchestrator.getRegistry().healthCheckAll();
      expect(health.size).toBe(3);
      expect(health.get("internal")).toBe(true);
      expect(health.get("opencode")).toBe(true);
      expect(health.get("hermes")).toBe(true);
    });

    test("get orchestrator status", () => {
      const status = orchestrator.getStatus();
      expect(status.registeredAgents).toBe(3);
    });
  });
});

describe("Built-in Agents", () => {
  test("InternalAgent capabilities", () => {
    const agent = new InternalAgent();
    expect(agent.id).toBe("internal");
    expect(agent.capabilities).toContain("general");
    expect(agent.capabilities).toContain("general-chat");
  });

  test("CodeAgent capabilities", () => {
    const agent = new CodeAgent();
    expect(agent.id).toBe("opencode");
    expect(agent.capabilities).toContain("code-generation");
    expect(agent.capabilities).toContain("code-review");
  });

  test("ResearchAgent capabilities", () => {
    const agent = new ResearchAgent();
    expect(agent.id).toBe("hermes");
    expect(agent.capabilities).toContain("research");
    expect(agent.capabilities).toContain("deep-research");
  });

  test("agent health check", async () => {
    const agent = new InternalAgent();
    const healthy = await agent.healthCheck();
    expect(healthy).toBe(true);
  });

  test("agent execute task", async () => {
    const agent = new InternalAgent();
    const task: AgentTask = {
      id: "test-task",
      type: "general",
      description: "Test",
      input: {},
    };

    const result = await agent.execute(task);
    expect(result.success).toBe(true);
    expect(result.agentId).toBe("internal");
  });
});
