import { z } from "zod";
import type { RecoverableOutputStore } from "../../components/recoverable-output.js";
import type { ToolRegistry } from "../tool-registry.js";

export function registerRecoverableOutputTools(
  registry: ToolRegistry,
  store: RecoverableOutputStore,
): void {
  registry.add({
    name: "read_tool_result",
    description: "读取被 RecoverableToolOutput 外置的大工具结果",
    exposure: ["external", "safe-external"],
    format: "text",
    inputSchema: {
      toolId: z.string().describe("外置结果 ID"),
    },
    handler: async (args) => {
      const entry = store.read(args.toolId as string);
      if (!entry) {
        return JSON.stringify({
          error: true,
          message: `Recoverable output ${String(args.toolId)} not found or expired`,
        });
      }
      return entry.text;
    },
  });

  registry.add({
    name: "recoverable_output_stats",
    description: "查看外置大结果存储统计",
    exposure: ["external", "safe-external"],
    inputSchema: {},
    handler: async () => store.stats(),
  });
}