import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import {
  executionMode,
  TOOL_CLASSIFICATIONS,
  type ExecutionMode,
} from "../../agents/execution-mode.js";
import { getConstitutionForMode } from "../../agents/constitution.js";

export function registerModeTools(registry: ToolRegistry): void {
  registry.add({
    name: "set_mode",
    description: "切换执行模式: plan(只读调查) / agent(默认,需审批) / yolo(自动批准)",
    inputSchema: {
      mode: z.enum(["plan", "agent", "yolo"]).describe("目标执行模式"),
      reason: z.string().optional().describe("切换原因"),
    },
    handler: async (args) => {
      const mode = args.mode as ExecutionMode;
      const previous = executionMode.getMode();
      executionMode.setMode(mode);
      return {
        success: true,
        previous,
        current: mode,
        reason: args.reason as string | undefined,
        config: executionMode.getConfig(),
        constitution: getConstitutionForMode(mode),
      };
    },
  });

  registry.add({
    name: "get_mode",
    description: "获取当前执行模式和宪法",
    inputSchema: {},
    handler: async () => {
      const mode = executionMode.getMode();
      return {
        mode,
        config: executionMode.getConfig(),
        constitution: getConstitutionForMode(mode),
        history: executionMode.getModeHistory(),
      };
    },
  });

  registry.add({
    name: "list_mode_tools",
    description: "列出当前模式下允许使用的工具",
    inputSchema: {
      category: z.string().optional().describe("按分类过滤"),
      risk: z.enum(["safe", "caution", "destructive"]).optional().describe("按风险等级过滤"),
    },
    handler: async (args) => {
      const tools = executionMode.getAllowedTools();
      let filtered = tools;
      if (args.category) {
        filtered = filtered.filter((t) => t.category === args.category);
      }
      if (args.risk) {
        filtered = filtered.filter((t) => t.risk === args.risk);
      }
      return {
        mode: executionMode.getMode(),
        total: TOOL_CLASSIFICATIONS.length,
        allowed: tools.length,
        filtered: filtered.length,
        tools: filtered.map((t) => ({
          name: t.name,
          risk: t.risk,
          category: t.category,
          description: t.description,
        })),
      };
    },
  });

  registry.add({
    name: "revert_mode",
    description: "回退到上一个执行模式",
    inputSchema: {},
    handler: async () => {
      const previous = executionMode.getMode();
      const current = executionMode.revertMode();
      return {
        success: true,
        previous,
        current,
        constitution: getConstitutionForMode(current),
      };
    },
  });
}
