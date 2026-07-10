import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { getAgentOrchestrator, type AgentTask } from "../../agents/orchestrator.js";

export function registerOrchestratorTools(registry: ToolRegistry): void {
  registry.add({
    name: "orchestrator_execute_task",
    description: "执行单个 Agent 任务",
    inputSchema: {
      type: z.string().describe("任务类型 (如 code-generation, research, analysis)"),
      description: z.string().describe("任务描述"),
      input: z.record(z.unknown()).optional().describe("任务输入"),
      context: z.record(z.unknown()).optional().describe("任务上下文"),
      priority: z.number().optional().default(5).describe("优先级 (1-10)"),
      timeout: z.number().optional().describe("超时时间 (ms)"),
    },
    handler: async (args) => {
      const orchestrator = getAgentOrchestrator();
      const task: AgentTask = {
        id: `task-${Date.now()}`,
        type: args.type as string,
        description: args.description as string,
        input: (args.input as Record<string, unknown>) || {},
        context: args.context as Record<string, unknown>,
        priority: args.priority as number,
        timeout: args.timeout as number,
      };
      return orchestrator.executeTask(task);
    },
  });

  registry.add({
    name: "orchestrator_execute_plan",
    description: "执行编排计划 (串行/并行/DAG)",
    inputSchema: {
      name: z.string().describe("计划名称"),
      mode: z.enum(["sequential", "parallel", "dag"]).describe("执行模式"),
      steps: z.array(z.object({
        name: z.string(),
        agentId: z.string().optional(),
        taskType: z.string(),
        taskDescription: z.string(),
        dependsOn: z.array(z.string()).optional(),
        requireConfirmation: z.boolean().optional(),
      })).describe("执行步骤"),
    },
    handler: async (args) => {
      const orchestrator = getAgentOrchestrator();
      const planId = `plan-${Date.now()}`;

      const steps = (args.steps as Array<{
        name: string;
        agentId?: string;
        taskType: string;
        taskDescription: string;
        dependsOn?: string[];
        requireConfirmation?: boolean;
      }>).map((step, index) => ({
        id: `${planId}-step-${index}`,
        name: step.name,
        agentId: step.agentId || "internal",
        task: {
          id: `${planId}-task-${index}`,
          type: step.taskType,
          description: step.taskDescription,
          input: {},
        },
        dependsOn: step.dependsOn,
        requireConfirmation: step.requireConfirmation,
      }));

      const plan = {
        id: planId,
        name: args.name as string,
        steps,
        mode: args.mode as "sequential" | "parallel" | "dag",
      };

      const result = await orchestrator.executePlan(plan);
      return {
        planId: result.planId,
        success: result.success,
        totalDuration: result.totalDuration,
        errors: result.errors,
        stepResults: Object.fromEntries(result.stepResults),
      };
    },
  });

  registry.add({
    name: "orchestrator_list_agents",
    description: "列出所有注册的 Agent",
    inputSchema: {},
    handler: async () => {
      const orchestrator = getAgentOrchestrator();
      const agents = orchestrator.getRegistry().list();
      return agents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        capabilities: a.capabilities,
      }));
    },
  });

  registry.add({
    name: "orchestrator_health_check",
    description: "检查所有 Agent 健康状态",
    inputSchema: {},
    handler: async () => {
      const orchestrator = getAgentOrchestrator();
      const health = await orchestrator.getRegistry().healthCheckAll();
      return Object.fromEntries(health);
    },
  });

  registry.add({
    name: "orchestrator_status",
    description: "获取编排器状态",
    inputSchema: {},
    handler: async () => {
      const orchestrator = getAgentOrchestrator();
      return orchestrator.getStatus();
    },
  });
}
