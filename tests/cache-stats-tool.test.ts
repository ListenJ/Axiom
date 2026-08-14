/**
 * cache_stats MCP 工具测试 —— 缓存优化全景面：LLM/搜索/爬虫缓存 + 提示词优化器 + prompt-cache 日聚合
 */
import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import { registerTokenTools } from "../src/mcp/server/token-tools.js";

describe("cache_stats 工具", () => {
  it("注册并可执行，返回缓存/优化器/日聚合形状", async () => {
    const registry = new ToolRegistry();
    registerTokenTools(registry);
    const handlers = registry.buildHttpHandlers();
    const handler = handlers["cache_stats"];
    expect(handler).toBeFunction();

    const result = (await handler({ days: 1 })) as Record<string, unknown>;
    expect(result).toHaveProperty("llmCache");
    expect(result).toHaveProperty("searchCache");
    expect(result).toHaveProperty("crawlCache");
    expect(result).toHaveProperty("promptOptimizer");
    expect(result).toHaveProperty("promptCacheDaily");
    const llm = result.llmCache as Record<string, unknown>;
    expect(typeof llm.hitRate).toBe("number");
    expect(typeof llm.size).toBe("number");
    const daily = result.promptCacheDaily as Array<Record<string, unknown>>;
    expect(Array.isArray(daily)).toBe(true);
    if (daily.length > 0) {
      expect(typeof daily[0].cacheHits).toBe("number");
      expect(typeof daily[0].cacheHitTokens).toBe("number");
    }
  });
});
