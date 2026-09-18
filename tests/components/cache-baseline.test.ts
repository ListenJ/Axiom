import { describe, expect, it } from "bun:test";
import {
  estimateToolResultTokens,
  measureToolSurface,
  summarizeLatencies,
} from "../../src/components/cache-baseline.js";

describe("cache baseline metrics", () => {
  it("measures tool surface deterministically", () => {
    const metrics = measureToolSurface([
      { name: "memory_search", description: "search memory" },
      { name: "web_search", description: "search web" },
    ]);
    expect(metrics.toolCount).toBe(2);
    expect(metrics.serializedBytes).toBeGreaterThan(0);
    expect(metrics.estimatedTokens).toBeGreaterThan(0);
  });

  it("summarizes p50 and p90 latency", () => {
    const summary = summarizeLatencies([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(summary.samples).toBe(10);
    expect(summary.averageMs).toBe(55);
    expect(summary.p50Ms).toBe(50);
    expect(summary.p90Ms).toBe(90);
  });

  it("estimates tool result tokens", () => {
    expect(estimateToolResultTokens("hello world")).toBeGreaterThan(0);
    expect(estimateToolResultTokens("中文测试")).toBeGreaterThan(0);
  });
});
