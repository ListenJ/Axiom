import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { getComponentKernel } from "../../components/kernel.js";

export function registerNativeTools(registry: ToolRegistry): void {
  registry.add({
    name: "native_toolchain_status",
    description:
      "获取 Native Agent 组件工具链状态（token-budget / native-general / native-code / native-research）",
    inputSchema: {},
    handler: async () => {
      const kernel = getComponentKernel();
      const components = await kernel.healthAll();
      return {
        native: true,
        components,
        total: components.length,
        ready: components.filter((component) => component.ready).length,
      };
    },
  });

  registry.add({
    name: "native_agent_execute",
    description: "通过 Native Agent 组件执行任务",
    inputSchema: {
      type: z.string().describe("任务类型（code-generation / research / general-chat）"),
      description: z.string().describe("任务描述"),
      input: z.record(z.unknown()).optional().describe("任务输入"),
    },
    handler: async (args) => {
      const { getAgentOrchestrator } = await import("../../agents/orchestrator.js");
      const orchestrator = getAgentOrchestrator();
      return orchestrator.executeTask({
        id: `native-task-${Date.now()}`,
        type: String(args.type ?? "general-chat"),
        description: String(args.description ?? ""),
        input: (args.input as Record<string, unknown>) ?? {},
      });
    },
  });
}
