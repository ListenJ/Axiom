import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { getTokenTracker } from "../../router/token-tracker.js";
import { llmCache, searchCache, crawlCache } from "../../utils/cache.js";
import { getPromptOptimizerMetrics } from "../../agents/prompt-optimizer.js";
import {
  isDeepSeekPeak,
  deepSeekRateTier,
  deepSeekInputPrice,
  deepSeekOutputPrice,
  isRateTierSchedulingEnabled,
  getCnyPerUsd,
} from "../../router/rate-tier.js";

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

  registry.add({
    name: "rate_tier_status",
    description: "DeepSeek 峰谷调度状态：当前峰/谷、高峰窗口、V4 实时单价（USD）与 CNY 汇率（成本优化决策用）",
    inputSchema: {},
    handler: async () => {
      const now = new Date();
      return {
        tier: deepSeekRateTier(now),
        isPeak: isDeepSeekPeak(now),
        schedulingEnabled: isRateTierSchedulingEnabled(),
        cnyPerUsd: getCnyPerUsd(),
        peakWindowsUtc: [
          { start: 1, end: 4 },
          { start: 6, end: 10 },
        ],
        deepSeekV4Prices: {
          "deepseek-v4-flash": {
            inputUsd: deepSeekInputPrice("deepseek-v4-flash", now),
            outputUsd: deepSeekOutputPrice("deepseek-v4-flash", now),
          },
          "deepseek-v4-pro": {
            inputUsd: deepSeekInputPrice("deepseek-v4-pro", now),
            outputUsd: deepSeekOutputPrice("deepseek-v4-pro", now),
          },
        },
      };
    },
  });

  registry.add({
    name: "cache_stats",
    description: "缓存优化全景：LLM 响应缓存 / 语义搜索 / 爬虫缓存命中率与规模，提示词优化器命中与闸门指标，以及按日的 prompt-cache token 命中（DeepSeek prompt_cache_hit_tokens）",
    inputSchema: {
      days: z.number().optional().default(7).describe("最近多少天的 prompt-cache 聚合"),
    },
    handler: async (args) => {
      const days = args.days as number | undefined;
      const daily = getTokenTracker().getDailyStats(days ?? 7);
      return {
        llmCache: llmCache.stats(),
        searchCache: searchCache.stats(),
        crawlCache: crawlCache.stats(),
        promptOptimizer: getPromptOptimizerMetrics(),
        promptCacheDaily: daily,
      };
    },
  });
}

