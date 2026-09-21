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
    capability: ["cfg.write"],
    description: "切换执行模式: plan(只读调查) / agent(默认,需审批) / yolo(自动批准)",
    inputSchema: {
      mode: z.enum(["plan", "agent", "yolo"]).describe("目标执行模式"),
      reason: z.string().optional().describe("切换原因"),
    },
    handler: async (args) => {
      const mode = args.mode as ExecutionMode;
      const previous = executionMode.getMode();
      // yolo 会关闭 HITL 审批门：让模型自己切过去等于让它给自己放行（S3 L10）。
      // 因此"放松约束"的方向必须人来确认，收紧方向（plan/agent）不受影响。
      if (mode === "yolo" && previous !== "yolo") {
        const approved = await executionMode.requestApprovalForced("set_mode", {
          mode,
          reason: args.reason as string | undefined,
        });
        if (!approved) {
          return { success: false, error: "切换 yolo 未获批准，保持当前模式", current: previous };
        }
      }
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
    capability: ["internal"],
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
    capability: ["internal"],
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
    capability: ["cfg.write"],
    description: "回退到上一个执行模式",
    inputSchema: {},
    handler: async () => {
      const current = executionMode.getMode();
      const history = executionMode.getModeHistory();
      // 回退目标就是历史里的上一个模式：若它是 yolo，同 set_mode 一样需要确认（S3 L10）
      const pending = history.length > 1 ? history[history.length - 2] : current;
      if (pending === "yolo" && current !== "yolo") {
        const approved = await executionMode.requestApprovalForced("revert_mode", { pending });
        if (!approved) {
          return { success: false, error: "回退目标为 yolo，未获批准，保持当前模式", current };
        }
      }
      const previous = current;
      const reverted = executionMode.revertMode();
      return {
        success: true,
        previous,
        current: reverted,
        constitution: getConstitutionForMode(reverted),
      };
    },
  });
}
