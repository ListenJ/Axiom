/**
 * MiniMax MCP 工具测试
 * 测试网络搜索和图像识别功能
 */
import { describe, it, expect, afterAll, beforeAll, mock } from "bun:test";
import * as realProxyFetch from "../src/utils/proxy-fetch.js";

// 模块 mock 泄漏防线（口径同 tests/consciousness.test.ts:194-207）：快照须在
// 任何 mock.module 之前求值（mock.module 原地改写命名空间）。
const REAL_PROXY_FETCH = { ...realProxyFetch };
afterAll(() => {
  mock.module("../src/utils/proxy-fetch.js", () => REAL_PROXY_FETCH);
});

// Mock the network boundary (proxyFetch) before the tool module is imported so
// tests stay deterministic and never hit api.minimax.io.
mock.module("../src/utils/proxy-fetch.js", () => ({
  proxyFetch: mock(async (_url: string, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        data: {
          results: [
            {
              title: "Mocked MiniMax result",
              link: "https://example.com/mock",
              snippet: "Mocked snippet for offline test",
              displayedUrl: "example.com",
            },
          ],
          totalResults: 1,
          description: "Mocked MiniMax image description",
          objects: ["object-1"],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }),
}));

import {
  minimaxWebSearch,
  minimaxImageUnderstand,
  checkMiniMaxHealth,
  getMiniMaxInfo,
} from "../src/mcp/tools/minimax.js";

// 跳过测试如果没有配置 MINIMAX_API_KEY
// 2026-10-19 修复：原条件 `hasTokenPlan = process.env.MINIMAX_BASE_URL?.includes("minimax.io") || true`
// 中的 `|| true` 使条件**恒真**（死代码），注释声称的 Token Plan 前置条件从未被检查。
// Token Plan 订阅无法从环境变量判定，故门控只按 API key 判定；需要订阅的用例（网络搜索/图像识别）
// 由外部 API 返回错误来暴露，不再用恒真条件伪装成"已检查"。
const hasApiKey = !!process.env.MINIMAX_API_KEY;
const describeIf = hasApiKey ? describe : describe.skip;

describeIf("MiniMax Tools", () => {
  beforeAll(() => {
    console.log("MiniMax API Key:", hasApiKey ? "已配置" : "未配置");
  });

  describe("minimaxWebSearch", () => {
    it("should search the web or gracefully handle no Token Plan", async () => {
      const result = await minimaxWebSearch("Axiom AI Agent");
      expect(result).toBeDefined();
      expect(result).toHaveProperty("success");
      expect(result.query).toBe("Axiom AI Agent");
      expect(Array.isArray(result.results)).toBe(true);
      // 如果成功，验证结果结构
      if (result.success && result.results.length > 0) {
        expect(result.results[0]).toHaveProperty("title");
        expect(result.results[0]).toHaveProperty("link");
        expect(result.results[0]).toHaveProperty("snippet");
      }
    }, 30000);

    it("should handle Chinese search or gracefully handle no Token Plan", async () => {
      const result = await minimaxWebSearch("人工智能发展趋势");
      expect(result).toBeDefined();
      expect(result).toHaveProperty("success");
      expect(Array.isArray(result.results)).toBe(true);
    }, 30000);
  });

  describe("minimaxImageUnderstand", () => {
    it("should understand an image from URL or gracefully handle no Token Plan", async () => {
      // 使用一个公开的测试图片
      const testImageUrl =
        "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/300px-PNG_transparency_demonstration_1.png";
      const result = await minimaxImageUnderstand(testImageUrl, {
        prompt: "描述这张图片的内容",
      });
      expect(result).toBeDefined();
      // 即使API返回错误（如无Token Plan），结构也应该正确
      expect(result).toHaveProperty("success");
      if (result.success) {
        expect(result).toHaveProperty("result");
      }
    }, 30000);
  });

  describe("checkMiniMaxHealth", () => {
    it("should check API health (may fail without Token Plan)", async () => {
      const health = await checkMiniMaxHealth();
      expect(health).toBeDefined();
      expect(health).toHaveProperty("ok");
      expect(health).toHaveProperty("latency");
      expect(typeof health.latency).toBe("number");
      // 如果没有 Token Plan，ok 可能为 false，这是预期的
      if (!health.ok) {
        expect(health.error).toBeDefined();
      }
    }, 30000);
  });

  describe("getMiniMaxInfo", () => {
    it("should return config info", () => {
      const info = getMiniMaxInfo();
      expect(info).toBeDefined();
      expect(info).toHaveProperty("configured");
      expect(info).toHaveProperty("baseUrl");
      expect(info).toHaveProperty("hasTokenPlan");
      expect(typeof info.configured).toBe("boolean");
    });
  });
});

describe("MiniMax Tools (without API key)", () => {
  it("getMiniMaxInfo should return unconfigured when no key", () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;

    const info = getMiniMaxInfo();
    expect(info.configured).toBe(false);
    expect(info.hasTokenPlan).toBe(false);

    if (originalKey) {
      process.env.MINIMAX_API_KEY = originalKey;
    }
  });
});
