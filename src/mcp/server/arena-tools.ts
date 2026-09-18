import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { getArenaCollector } from "../../eval/arena-collector.js";

export function registerArenaTools(registry: ToolRegistry): void {
  registry.add({
    name: "arena_collect",
    description: "采集竞技场榜单数据 (LMSYS/OpenCompass/HuggingFace/LLM Stats)",
    inputSchema: {
      source: z.string().optional().describe("指定源名称 (如 'LMSYS Arena')，不指定则采集全部"),
    },
    handler: async (args) => {
      const collector = getArenaCollector();
      if (args.source) {
        const count = await collector.collectSource(args.source as string);
        return { success: true, source: args.source, recordsCollected: count };
      }
      return collector.collectAll();
    },
  });

  registry.add({
    name: "arena_search_models",
    description: "搜索竞技场榜单中的模型 (FTS5 BM25 确定性检索)",
    inputSchema: {
      query: z.string().describe("搜索关键词"),
      limit: z.number().optional().default(20).describe("返回数量"),
    },
    handler: async (args) => {
      const collector = getArenaCollector();
      return collector.searchModels(args.query as string, args.limit as number);
    },
  });

  registry.add({
    name: "arena_get_model_scores",
    description: "获取模型在所有基准上的分数",
    inputSchema: {
      model_name: z.string().describe("模型名称"),
    },
    handler: async (args) => {
      const collector = getArenaCollector();
      return collector.getModelScores(args.model_name as string);
    },
  });

  registry.add({
    name: "arena_benchmark_ranking",
    description: "获取基准上所有模型的排名",
    inputSchema: {
      benchmark: z.string().describe("基准名称 (如 'MMLU', 'HumanEval', 'arena-elo')"),
      limit: z.number().optional().default(50).describe("返回数量"),
    },
    handler: async (args) => {
      const collector = getArenaCollector();
      return collector.getBenchmarkRanking(args.benchmark as string, args.limit as number);
    },
  });

  registry.add({
    name: "arena_composite_ranking",
    description: "获取综合评分排名 (确定性加权公式)",
    inputSchema: {
      limit: z.number().optional().default(50).describe("返回数量"),
    },
    handler: async (args) => {
      const collector = getArenaCollector();
      return collector.getCompositeRanking(args.limit as number);
    },
  });

  registry.add({
    name: "arena_role_recommendation",
    description: "获取角色推荐 (确定性矩阵乘法匹配)",
    inputSchema: {
      role: z.enum(["code-generation", "research", "math", "general-chat", "architecture", "decision", "review", "general-tool"]).describe("角色类型"),
      limit: z.number().optional().default(10).describe("返回数量"),
    },
    handler: async (args) => {
      const collector = getArenaCollector();
      return collector.getRoleRecommendation(args.role as string, args.limit as number);
    },
  });

  registry.add({
    name: "arena_stats",
    description: "获取竞技场榜单统计信息",
    inputSchema: {},
    handler: async () => {
      const collector = getArenaCollector();
      return collector.getStats();
    },
  });

  registry.add({
    name: "arena_sources",
    description: "列出所有可用的榜单数据源",
    inputSchema: {},
    handler: async () => {
      const collector = getArenaCollector();
      return collector.listSources();
    },
  });
}
