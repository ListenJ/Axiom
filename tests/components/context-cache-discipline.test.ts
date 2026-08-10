import { describe, expect, it } from "bun:test";
import {
  buildCacheDiscipline,
  summarizeCacheHits,
} from "../../src/components/context-cache-discipline.js";

describe("ContextCacheDiscipline", () => {
  it("builds a deterministic stable prefix sorted by name", () => {
    const a = buildCacheDiscipline({
      identity: "axiom",
      toolSurface: [
        { name: "web_search", description: "search web" },
        { name: "memory_search", description: "search memory" },
      ],
      skillIds: ["skill-b", "skill-a"],
    });
    const b = buildCacheDiscipline({
      identity: "axiom",
      toolSurface: [
        { name: "memory_search", description: "search memory" },
        { name: "web_search", description: "search web" },
      ],
      skillIds: ["skill-a", "skill-b"],
    });
    expect(a.stableHash).toBe(b.stableHash);
    expect(a.toolCount).toBe(2);
    expect(a.skillCount).toBe(2);
    expect(a.stablePrefixBytes).toBeGreaterThan(0);
    expect(a.stablePrefixTokens).toBeGreaterThan(0);
  });

  it("summarizes cache hit rate", () => {
    expect(summarizeCacheHits(3, 1)).toEqual({ hits: 3, misses: 1, hitRate: 0.75 });
    expect(summarizeCacheHits(0, 0).hitRate).toBe(0);
  });
});