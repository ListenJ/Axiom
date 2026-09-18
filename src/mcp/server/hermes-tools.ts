import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { deepResearch, checkHermes } from "../../agents/hermes-agent.js";

export function registerHermesTools(registry: ToolRegistry): void {
  registry.add({
    name: "project_research",
    description: "使用 Hermes Agent 进行深度研究",
    inputSchema: {
      topic: z.string().describe("研究主题"),
      cwd: z.string().optional().describe("工作目录"),
    },
    handler: async (args) => {
      const result = await deepResearch(args.topic as string, args.cwd as string);
      return { success: result.success, output: result.stdout, errors: result.stderr };
    },
  });

  registry.add({
    name: "hermes_status",
    description: "检查 Hermes Agent 安装状态",
    inputSchema: {},
    handler: async () => {
      const available = await checkHermes();
      return { installed: available, installGuide: available ? "Hermes is ready" : "Run: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash" };
    },
  });
}
