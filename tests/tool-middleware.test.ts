import { describe, it, expect, beforeEach } from "bun:test";
import { wrapWithMiddleware, getToolMetrics, getAllMetrics } from "../src/mcp/tool-middleware.js";
import type { ToolDef } from "../src/mcp/tool-registry.js";

describe("Tool Middleware", () => {
  beforeEach(() => {
    // Metrics persist across tests, that's OK for this suite
  });

  it("wraps a tool with middleware", () => {
    const tool: ToolDef = {
      name: "test-tool",
      description: "A test tool",
      inputSchema: { type: "object" },
      handler: async () => ({ result: "ok" }),
    };

    const wrapped = wrapWithMiddleware(tool);
    expect(wrapped.name).toBe("test-tool");
    expect(typeof wrapped.handler).toBe("function");
  });

  it("executes handler and records metrics", async () => {
    const tool: ToolDef = {
      name: "metrics-test",
      description: "Test metrics",
      inputSchema: { type: "object" },
      handler: async () => ({ result: "ok" }),
    };

    const wrapped = wrapWithMiddleware(tool);
    const result = await wrapped.handler({});

    expect(result).toEqual({ result: "ok" });

    const metrics = getToolMetrics("metrics-test");
    expect(metrics).toBeDefined();
    expect(metrics!.calls).toBeGreaterThanOrEqual(1);
    expect(metrics!.successes).toBeGreaterThanOrEqual(1);
  });

  it("blocks calls with invalid args", async () => {
    const tool: ToolDef = {
      name: "invalid-args-test",
      description: "Test invalid args",
      inputSchema: { type: "object" },
      handler: async () => ({ result: "ok" }),
    };

    const wrapped = wrapWithMiddleware(tool);
    // Pass null args — should be blocked by validation middleware
    const result = await wrapped.handler(null as any);

    expect(result).toHaveProperty("error");
  });

  it("caches results for identical calls", async () => {
    let callCount = 0;
    const tool: ToolDef = {
      name: "cache-test",
      description: "Test caching",
      inputSchema: { type: "object" },
      handler: async () => {
        callCount++;
        return { count: callCount };
      },
    };

    const wrapped = wrapWithMiddleware(tool);

    // First call
    const result1 = await wrapped.handler({ key: "value" });
    expect(result1).toEqual({ count: 1 });

    // Second call with same args — should return cached
    const result2 = await wrapped.handler({ key: "value" });
    expect(result2).toEqual({ count: 1 }); // Same result, handler not called again

    // Third call with different args
    const result3 = await wrapped.handler({ key: "other" });
    expect(result3).toEqual({ count: 2 }); // Handler called again
  });

  it("records failures on handler errors", async () => {
    const tool: ToolDef = {
      name: "error-test",
      description: "Test error handling",
      inputSchema: { type: "object" },
      handler: async () => {
        throw new Error("Test error");
      },
    };

    const wrapped = wrapWithMiddleware(tool);

    try {
      await wrapped.handler({});
    } catch {
      // Expected
    }

    const metrics = getToolMetrics("error-test");
    expect(metrics).toBeDefined();
    expect(metrics!.failures).toBeGreaterThanOrEqual(1);
  });
});
