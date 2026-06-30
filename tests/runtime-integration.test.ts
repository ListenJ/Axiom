import { describe, it, expect } from "bun:test";
import { eventBus, worldState, tickEngine, actorRuntime, getRuntimeStatus } from "../src/runtime/kernel.js";
import { atomStore } from "../src/runtime/atom-engine.js";
import { constraintSolver, initConstraints } from "../src/runtime/constraint-solver.js";
import { capabilityRegistry, initCapabilities } from "../src/runtime/capability-registry.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { ruleEngine, initRules } from "../src/runtime/rule-engine.js";
import { agentExecutor } from "../src/runtime/agent-executor.js";
import { verificationEngine } from "../src/runtime/verification-engine.js";
import { scheduler } from "../src/runtime/scheduler.js";
import { contextEngine } from "../src/runtime/context-engine.js";
import { projectionRegistry, initProjections } from "../src/runtime/projection-layer.js";

// Initialize all modules
initConstraints();
initCapabilities();
initRules();
initProjections();

describe("Runtime Integration", () => {
  describe("Full Pipeline: Observation → Memory → Knowledge → Skill", () => {
    it("creates observation and searches for it", () => {
      const obs = memoryEngine.observe("User fixed a bug in auth.ts", "test");
      expect(obs.id).toBeDefined();

      const results = memoryEngine.search("auth.ts");
      expect(results.observations.length).toBeGreaterThan(0);
    });

    it("knowledge network stores entities with evidence", () => {
      const entity = knowledgeNetwork.create("entity", "AuthService", "Handles authentication", {
        confidence: 0.9,
        source: "codebase",
      });

      knowledgeNetwork.addEvidence(entity.id, {
        source: "test",
        confidence: 0.95,
        timestamp: Date.now(),
        description: "Found in auth.ts",
      });

      const retrieved = knowledgeNetwork.get(entity.id);
      expect(retrieved?.evidence.length).toBe(1);
      expect(retrieved?.confidence).toBeGreaterThan(0.9);
    });

    it("constraint solver integrates with agent executor", async () => {
      constraintSolver.addConstraint({
        type: "requires",
        dimension: "resource",
        source: "test_tool",
        target: "test_dep",
        confidence: 1.0,
        evidence: "test",
      });

      const report = await agentExecutor.execute({
        id: "integration-test",
        description: "Test with constraints",
        resources: [],
        constraints: ["test_tool"],
        goal: "test",
        priority: "normal",
        metadata: {},
      });

      // Should fail because test_dep is missing
      expect(report.status).toBe("failed");
    });
  });

  describe("Event Bus Integration", () => {
    it("events flow between modules", async () => {
      let received = false;
      eventBus.subscribe("test.integration", () => { received = true; });

      // Publish from one module
      eventBus.publish({
        type: "test.integration",
        source: "test",
        data: {},
        priority: "normal",
      });

      expect(received).toBe(true);
    });

    it("world state updates trigger events", () => {
      let triggered = false;
      worldState.watch("integration.test", () => { triggered = true; });

      worldState.set("integration.test", "value");
      expect(triggered).toBe(true);
    });
  });

  describe("Scheduler Integration", () => {
    it("submits and processes tasks", () => {
      const task = scheduler.submit({
        name: "integration-task",
        priority: "normal",
        payload: { test: true },
        dependencies: [],
        maxRetries: 1,
      });

      expect(task.id).toBeDefined();
      expect(task.status).toBe("pending");

      const next = scheduler.getNext();
      if (next) {
        expect(next.status).toBe("running");
        scheduler.complete(next.id, { result: "ok" });
      }
    });
  });

  describe("Context Engine Integration", () => {
    it("builds context from world state", () => {
      // Set up world state
      worldState.set("workspace.projectPath", "/test/project");
      worldState.set("goals.main", { description: "Complete task", status: "active" });

      // Invalidate cache to force rebuild
      contextEngine.invalidateCache();

      const ctx = contextEngine.build("test input", [{ role: "user", content: "hello" }]);
      expect(ctx.input).toBe("test input");
      // The context should have the workspace
      expect(ctx.workspace).toBeDefined();
    });

    it("formats context for LLM prompt", () => {
      const ctx = contextEngine.build("analyze code", []);
      const prompt = contextEngine.formatForPrompt(ctx);
      expect(prompt).toContain("analyze code");
    });
  });

  describe("Projection Layer Integration", () => {
    it("has all projections registered", () => {
      const stats = projectionRegistry.getAllStats();
      expect(stats.markdown).toBeDefined();
      expect(stats.sqlite).toBeDefined();
      expect(stats.kg).toBeDefined();
      expect(stats.cache).toBeDefined();
    });

    it("markdown projection generates output", () => {
      const markdown = projectionRegistry.get("markdown");
      expect(markdown).toBeDefined();
    });
  });

  describe("Verification Integration", () => {
    it("verifies full pipeline", async () => {
      const reports = await verificationEngine.verifyFull("integration-full", {
        input: "valid input",
        plan: { steps: [{ id: 1 }], complexity: "simple" },
        execution: { action: "test", success: true, latencyMs: 50 },
        result: "valid result",
      });

      expect(reports.length).toBe(4);
      expect(reports.every((r) => r.overallVerdict === "pass")).toBe(true);
    });
  });

  describe("Runtime Status", () => {
    it("returns complete status", () => {
      const status = getRuntimeStatus();
      expect(status.tick).toBeDefined();
      expect(status.events).toBeDefined();
      expect(status.actors).toBeDefined();
      expect(status.stateVersion).toBeGreaterThan(0);
    });

    it("tracks event bus stats", () => {
      const stats = eventBus.getStats();
      expect(stats.published).toBeGreaterThan(0);
      expect(stats.subscriberCount).toBeGreaterThan(0);
    });
  });
});
