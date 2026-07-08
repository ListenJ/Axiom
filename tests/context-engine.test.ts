import { describe, it, expect, beforeEach } from "bun:test";
import { contextEngine } from "../src/dre/runtime/context-engine.js";
import { worldState } from "../src/dre/runtime/world-state.js";
import { atomStore } from "../src/dre/runtime/atom-engine.js";

describe("ContextEngine", () => {
  beforeEach(() => {
    contextEngine.invalidateCache();
  });

  describe("build()", () => {
    it("returns a complete RuntimeContext", () => {
      const ctx = contextEngine.build("hello world");
      expect(ctx.input).toBe("hello world");
      expect(ctx.history).toEqual([]);
      expect(Array.isArray(ctx.atoms)).toBe(true);
      expect(Array.isArray(ctx.entities)).toBe(true);
      expect(ctx.workspace).toBeDefined();
      expect(Array.isArray(ctx.goals)).toBe(true);
      expect(Array.isArray(ctx.beliefs)).toBe(true);
      expect(Array.isArray(ctx.tools)).toBe(true);
      expect(ctx.system.uptime).toBeGreaterThanOrEqual(0);
      expect(ctx.system.tickNumber).toBeGreaterThanOrEqual(0);
      expect(ctx.system.stateVersion).toBeGreaterThanOrEqual(0);
      expect(ctx.tokenBudget.available).toBeGreaterThan(0);
    });

    it("includes history when provided", () => {
      const history = [{ role: "user", content: "previous message" }];
      const ctx = contextEngine.build("current message", history);
      expect(ctx.history).toEqual(history);
    });

    it("searches atoms relevant to input", () => {
      atomStore.create("observation", "relevant-atom-test-keyword", { confidence: "certain" });
      const ctx = contextEngine.build("relevant-atom-test-keyword");
      expect(ctx.atoms.some((a) => a.content.includes("relevant-atom-test-keyword"))).toBe(true);
    });

    it("includes entities from atom store", () => {
      atomStore.create("entity", "test-entity-for-context", { confidence: "inferred" });
      const ctx = contextEngine.build("test-entity-for-context");
      expect(ctx.entities.length).toBeGreaterThanOrEqual(1);
    });

    it("reads workspace from world state", () => {
      worldState.set("workspace", { projectPath: "/test/project", openFiles: ["test.ts"] });
      const ctx = contextEngine.build("test");
      expect(ctx.workspace.projectPath).toBe("/test/project");
      expect(ctx.workspace.openFiles).toContain("test.ts");
    });

    it("reads goals from world state", () => {
      worldState.setGoal("goal-1", "Test goal", "active");
      const ctx = contextEngine.build("test");
      expect(ctx.goals.some((g) => g.description === "Test goal")).toBe(true);
    });

    it("reads beliefs from world state", () => {
      worldState.setBelief("belief-1", "Test belief", 0.95);
      const ctx = contextEngine.build("test");
      expect(ctx.beliefs.some((b) => b.statement === "Test belief" && b.confidence === 0.95)).toBe(true);
    });

    it("reads tools from world state", () => {
      worldState.set("tools.search", { description: "Search tool" });
      const ctx = contextEngine.build("test");
      expect(ctx.tools.some((t) => t.name === "search" && t.description === "Search tool")).toBe(true);
    });
  });

  describe("caching", () => {
    it("caches context for 5 seconds", () => {
      const ctx1 = contextEngine.build("cache-test-1");
      const ctx2 = contextEngine.build("cache-test-2");
      // Cache hit — both should share same static fields (only input/history differ)
      expect(ctx2.workspace).toEqual(ctx1.workspace);
      expect(ctx2.system).toEqual(ctx1.system);
    });

    it("reuses cache when available", () => {
      const ctx1 = contextEngine.build("test");
      const ctx2 = contextEngine.build("test2");
      // Cache keeps same non-input data
      expect(ctx2.system.stateVersion).toBe(ctx1.system.stateVersion);
    });
  });

  describe("formatForPrompt()", () => {
    it("formats context into a string with all sections", () => {
      const ctx = contextEngine.build("format test prompt", [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]);
      const output = contextEngine.formatForPrompt(ctx);
      expect(output).toContain("[System:");
      expect(output).toContain("[Input] format test prompt");
      expect(output).toContain("[History]");
      expect(output).toContain("user: hello");
      expect(output).toContain("assistant: hi");
    });

    it("includes project when workspace has it", () => {
      worldState.set("workspace", { projectPath: "/my/project" });
      const ctx = contextEngine.build("test");
      const output = contextEngine.formatForPrompt(ctx);
      expect(output).toContain("[Project: /my/project]");
    });

    it("includes goals when present", () => {
      worldState.setGoal("g1", "Fix the bug", "active");
      const ctx = contextEngine.build("test");
      const output = contextEngine.formatForPrompt(ctx);
      expect(output).toContain("[Goals:");
      expect(output).toContain("Fix the bug");
    });

    it("includes beliefs when present", () => {
      worldState.setBelief("b1", "System is stable", 0.9);
      const ctx = contextEngine.build("test");
      const output = contextEngine.formatForPrompt(ctx);
      expect(output).toContain("[Beliefs:");
      expect(output).toContain("System is stable");
      expect(output).toContain("90%");
    });
  });

  describe("invalidateCache()", () => {
    it("clears cached context", () => {
      contextEngine.build("before");
      expect(contextEngine.getStats().cached).toBe(true);
      contextEngine.invalidateCache();
      expect(contextEngine.getStats().cached).toBe(false);
    });
  });

  describe("getStats()", () => {
    it("returns cache info", () => {
      const stats = contextEngine.getStats();
      expect(typeof stats.cached).toBe("boolean");
      expect(typeof stats.cacheAge).toBe("number");
      expect(typeof stats.cacheHitRate).toBe("number");
      expect(typeof stats.buildCount).toBe("number");
      expect(typeof stats.memoryCount).toBe("number");
    });
  });

  describe("buildRaw()", () => {
    it("returns a valid RuntimeContext without cache", () => {
      contextEngine.invalidateCache();
      const ctx = contextEngine.buildRaw("raw-test-input");
      expect(ctx.input).toBe("raw-test-input");
      expect(Array.isArray(ctx.atoms)).toBe(true);
      expect(ctx.system).toBeDefined();
    });

    it("does not populate cache (subsequent build() still rebuilds)", () => {
      contextEngine.invalidateCache();
      contextEngine.buildRaw("raw-no-cache");
      expect(contextEngine.getStats().cached).toBe(false);

      worldState.setGoal("build-raw-test-goal", "verify rebuild", "active");
      const builtCtx = contextEngine.build("after-raw");
      expect(builtCtx.goals.some((g) => g.description === "verify rebuild")).toBe(true);
    });

    it("reflects fresh world state on each call", () => {
      contextEngine.invalidateCache();
      const ctx1 = contextEngine.buildRaw("fresh-1");
      const version1 = ctx1.system.stateVersion;

      worldState.set("fresh.test", { value: 1 });
      const ctx2 = contextEngine.buildRaw("fresh-2");
      const version2 = ctx2.system.stateVersion;

      expect(version2).toBeGreaterThanOrEqual(version1);
    });
  });
});
