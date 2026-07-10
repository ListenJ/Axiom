import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { getPromptPool, type AgentRole } from "../../agents/prompt-pool.js";

export function registerPromptTools(registry: ToolRegistry): void {
  registry.add({
    name: "prompt_pool_acquire",
    description: "从连接池获取角色的缓存友好提示词",
    inputSchema: {
      role: z.enum(["main_coding", "code_review", "research", "architecture", "decision", "general_chat", "tool_use", "computer_use"]).describe("角色类型"),
      task_description: z.string().describe("任务描述"),
      context: z.string().optional().describe("上下文信息"),
      user_input: z.string().optional().describe("用户输入"),
    },
    handler: async (args) => {
      const pool = getPromptPool();
      const result = pool.acquire(args.role as AgentRole, {
        task_description: args.task_description as string,
        context: args.context as string,
        user_input: args.user_input as string,
      });
      return {
        role: result.role,
        version: result.version,
        prefixHash: result.prefixHash,
        tokenCount: result.tokenCount,
        cacheControlMarker: result.cacheControlMarker,
        systemPromptLength: result.systemPrompt.length,
        staticPrefixLength: result.staticPrefix.length,
        dynamicSuffixLength: result.dynamicSuffix.length,
      };
    },
  });

  registry.add({
    name: "prompt_pool_metrics",
    description: "获取 Prompt 连接池缓存监控指标",
    inputSchema: {},
    handler: async () => {
      const pool = getPromptPool();
      return pool.getMetrics();
    },
  });

  registry.add({
    name: "prompt_pool_status",
    description: "获取 Prompt 连接池状态",
    inputSchema: {},
    handler: async () => {
      const pool = getPromptPool();
      return pool.getPoolStatus();
    },
  });

  registry.add({
    name: "prompt_pool_roles",
    description: "列出所有角色配置",
    inputSchema: {},
    handler: async () => {
      const pool = getPromptPool();
      return pool.listRoles();
    },
  });

  registry.add({
    name: "prompt_pool_warmup",
    description: "预热 Prompt 连接池缓存",
    inputSchema: {},
    handler: async () => {
      const pool = getPromptPool();
      pool.warmup();
      return { success: true, message: "Cache warmup initiated for all roles" };
    },
  });

  registry.add({
    name: "prompt_pool_evict",
    description: "执行连接池淘汰 (LRU/LFU/TTL 混合策略)",
    inputSchema: {},
    handler: async () => {
      const pool = getPromptPool();
      const evictedCount = pool.evict();
      return { evictedCount, message: `Evicted ${evictedCount} entries` };
    },
  });
}
