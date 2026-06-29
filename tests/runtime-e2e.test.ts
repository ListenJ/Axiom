import { describe, it, expect } from "bun:test";
import { eventBus, worldState } from "../src/runtime/kernel.js";
import { atomStore } from "../src/runtime/atom-engine.js";
import { constraintSolver, initConstraints } from "../src/runtime/constraint-solver.js";
import { capabilityRegistry, initCapabilities } from "../src/runtime/capability-registry.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { ruleEngine, initRules } from "../src/runtime/rule-engine.js";
import { verificationEngine } from "../src/runtime/verification-engine.js";
import { cognitivePipeline } from "../src/runtime/scheduler.js";
import { contextEngine } from "../src/runtime/context-engine.js";
import { projectionRegistry, initProjections } from "../src/runtime/projection-layer.js";

// Initialize all modules
initConstraints();
initCapabilities();
initRules();
initProjections();

describe("End-to-End Runtime Integration", () => {
  describe("Complete Request Lifecycle", () => {
    it("processes a request through all Runtime modules", () => {
      // 1. User sends message
      const input = "How to fix a TypeScript error in React?";

      // 2. Memory observes
      memoryEngine.observe(input, "user");

      // 3. Constraint check
      const constraintResult = constraintSolver.solve([input]);
      expect(constraintResult.satisfied).toBe(true);

      // 4. Rule evaluation
      const ruleMatches = ruleEngine.evaluate({ intent: "code", complexity: "medium" });
      expect(Array.isArray(ruleMatches)).toBe(true);

      // 5. Knowledge search
      const knResults = knowledgeNetwork.search("TypeScript", 5);
      expect(Array.isArray(knResults)).toBe(true);

      // 6. Atom search
      const atomResults = atomStore.search("React", 5);
      expect(Array.isArray(atomResults)).toBe(true);

      // 7. Context building
      contextEngine.invalidateCache();
      const context = contextEngine.build(input, [{ role: "user", content: input }]);
      expect(context.input).toBe(input);

      // 8. Verification
      const verification = verificationEngine.verifyResult("test", "Here's how to fix it...");
      expect(verification.overallVerdict).toBe("pass");

      // 9. Memory records result
      memoryEngine.observe("Here's how to fix it...", "llm");

      // 10. Verify memory has observations
      expect(memoryEngine.getStats().observations).toBeGreaterThan(0);
    });

    it("handles constraint violations correctly", () => {
      // Add a constraint that will violate
      constraintSolver.addConstraint({
        type: "prohibits",
        source: "plan_mode",
        target: "fs_write",
        confidence: 1.0,
        evidence: "test",
      });

      const result = constraintSolver.solve(["plan_mode", "fs_write"]);
      expect(result.satisfied).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it("handles rule matching correctly", () => {
      // Test code intent
      const codeMatches = ruleEngine.evaluate({ intent: "code" });
      expect(codeMatches.some((m) => m.matched)).toBe(true);

      // Test research intent
      const researchMatches = ruleEngine.evaluate({ intent: "research" });
      expect(researchMatches.some((m) => m.matched)).toBe(true);

      // Test plan mode
      const planMatches = ruleEngine.evaluate({ mode: "plan" });
      expect(planMatches.some((m) => m.matched)).toBe(true);
    });
  });

  describe("Memory Pipeline", () => {
    it("forms episodes from observations", () => {
      // Create observations with shared entities
      memoryEngine.observe("Fixed bug in AuthService.ts", "user");
      memoryEngine.observe("The bug was caused by JWT token expiration", "user");
      memoryEngine.observe("Applied fix by adding token refresh logic", "user");

      const episodes = memoryEngine.getEpisodes();
      expect(episodes.length).toBeGreaterThan(0);
    });

    it("forms skills from patterns", () => {
      const formed = memoryEngine.formSkillsFromPatterns();
      expect(typeof formed).toBe("number");
    });

    it("searches across all memory stages", () => {
      memoryEngine.observe("UniqueSearchTerm98765", "test");
      const results = memoryEngine.search("UniqueSearchTerm98765");
      expect(results.observations.length).toBeGreaterThan(0);
    });
  });

  describe("Knowledge Network", () => {
    it("creates and queries entities", () => {
      const entity = knowledgeNetwork.create("entity", "TestEntity", "Test content");
      expect(entity.id).toBeDefined();
      expect(entity.state.current).toBe("active");

      const results = knowledgeNetwork.queryByKind("entity");
      expect(results.length).toBeGreaterThan(0);
    });

    it("tracks entity state changes", () => {
      const entity = knowledgeNetwork.create("entity", "StatefulEntity", "Content");
      knowledgeNetwork.updateState(entity.id, "running");
      knowledgeNetwork.updateState(entity.id, "completed");

      const timeline = knowledgeNetwork.getTimeline(entity.id);
      expect(timeline.length).toBe(3);
    });

    it("adds evidence to entities", () => {
      const entity = knowledgeNetwork.create("fact", "EvidenceFact", "Content");
      knowledgeNetwork.addEvidence(entity.id, {
        source: "test",
        confidence: 0.9,
        timestamp: Date.now(),
        description: "test evidence",
      });

      const retrieved = knowledgeNetwork.get(entity.id);
      expect(retrieved?.evidence.length).toBe(1);
    });
  });

  describe("Cognitive Pipeline", () => {
    it("runs full pipeline", async () => {
      const result = await cognitivePipeline.run("What is TypeScript?");
      expect(result.stage).toBeDefined();
      expect(result.stageTimings.size).toBeGreaterThan(0);
    });

    it("tracks stats", () => {
      const stats = cognitivePipeline.getStats();
      expect(stats.runs).toBeGreaterThan(0);
    });
  });

  describe("Projection Layer", () => {
    it("syncs all projections", async () => {
      const result = await projectionRegistry.syncAll();
      expect(result.synced).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    it("has all projections registered", () => {
      const stats = projectionRegistry.getAllStats();
      expect(stats.markdown).toBeDefined();
      expect(stats.sqlite).toBeDefined();
      expect(stats.kg).toBeDefined();
      expect(stats.cache).toBeDefined();
    });
  });

  describe("Event Bus", () => {
    it("events flow between modules", () => {
      let received = false;
      eventBus.subscribe("test.e2e", () => { received = true; });
      eventBus.publish({ type: "test.e2e", source: "test", data: {}, priority: "normal" });
      expect(received).toBe(true);
    });

    it("world state updates trigger events", () => {
      let triggered = false;
      worldState.watch("e2e.test", () => { triggered = true; });
      worldState.set("e2e.test", "value");
      expect(triggered).toBe(true);
    });
  });

  describe("Verification", () => {
    it("verifies full pipeline", async () => {
      const reports = await verificationEngine.verifyFull("e2e-full", {
        input: "valid input",
        plan: { steps: [{ id: 1 }], complexity: "simple" },
        execution: { action: "test", success: true, latencyMs: 50 },
        result: "valid result",
      });

      expect(reports.length).toBe(4);
      expect(reports.every((r) => r.overallVerdict === "pass")).toBe(true);
    });

    it("flags fabrication markers", () => {
      const report = verificationEngine.verifyResult("e2e-fabrication", "[FABRICATED] fake data");
      expect(report.issues.some((i) => i.category === "hallucination")).toBe(true);
    });
  });
});
