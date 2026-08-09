import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { getTokenTracker } from "../../router/token-tracker.js";

export function registerTokenTools(registry: ToolRegistry): void {
  registry.add({
    name: "token_stats",
    description: "获取总体 token 使用统计（调用次数、token 消耗、成功率、延迟）",
    exposure: ["external", "safe-external"],
    inputSchema: {
      since: z.number().optional().describe("起始时间戳（毫秒）"),
      until: z.number().optional().describe("结束时间戳（毫秒）"),
    },
    handler: async (args) => {
      const tracker = getTokenTracker();
      const stats = tracker.getOverallStats({
        since: args.since as number | undefined,
        until: args.until as number | undefined,
      });
      return stats;
    },
  });

  registry.add({
    name: "token_stats_by_model",
    description: "按模型统计 token 使用情况",
    inputSchema: {
      since: z.number().optional().describe("起始时间戳（毫秒）"),
      limit: z.number().optional().default(20).describe("返回模型数量"),
    },
    handler: async (args) => {
      const tracker = getTokenTracker();
      const stats = tracker.getStatsByModel({
        since: args.since as number | undefined,
        limit: args.limit as number | undefined,
      });
      return stats;
    },
  });

  registry.add({
    name: "token_stats_by_role",
    description: "按角色统计 token 使用情况",
    inputSchema: {
      since: z.number().optional().describe("起始时间戳（毫秒）"),
      limit: z.number().optional().default(20).describe("返回角色数量"),
    },
    handler: async (args) => {
      const tracker = getTokenTracker();
      const stats = tracker.getStatsByRole({
        since: args.since as number | undefined,
        limit: args.limit as number | undefined,
      });
      return stats;
    },
  });

  registry.add({
    name: "token_daily_stats",
    description: "按天统计 token 使用情况",
    inputSchema: {
      days: z.number().optional().default(7).describe("最近多少天"),
    },
    handler: async (args) => {
      const tracker = getTokenTracker();
      const stats = tracker.getDailyStats(args.days as number | undefined);
      return stats;
    },
  });
}
