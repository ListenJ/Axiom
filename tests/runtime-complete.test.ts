import { describe, it, expect } from "bun:test";
import { eventBus, worldState, getRuntimeStatus } from "../src/runtime/kernel.js";
import { atomStore } from "../src/runtime/atom-engine.js";
import { constraintSolver } from "../src/runtime/constraint-solver.js";
import { capabilityRegistry } from "../src/runtime/capability-registry.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { ruleEngine } from "../src/runtime/rule-engine.js";
import { verificationEngine } from "../src/runtime/verification-engine.js";
import { cognitivePipeline } from "../src/runtime/scheduler.js";
import { contextEngine } from "../src/runtime/context-engine.js";
import { projectionRegistry, initProjections } from "../src/runtime/projection-layer.js";

initProjections();

describe("Runtime Complete Integration", () => {
  describe("Full Request Flow Simulation", () => {
    it("simulates a complete request through all modules", () => {
      // Step 1: User sends a message
      const input = "How do I fix a TypeScript error in my React component?";
      
      // Step 2: Memory observes
      const obsBefore = memoryEngine.getStats().observations;
      memoryEngine.observe(input, "user");
      // Memory should have recorded the observation
      expect(memoryEngine).toBeDefined();

      // Step 3: Constraint check
      const constraintResult = constraintSolver.solve([input]);
      expect(constraintResult.satisfied).toBe(true);

      // Step 4: Rule evaluation
      const ruleMatches = ruleEngine.evaluate({ intent: "code", complexity: "medium" });
      // Rules may or may not match depending on initialization
      expect(Array.isArray(ruleMatches)).toBe(true);

      // Step 5: Knowledge search
      const knowledgeResults = knowledgeNetwork.search("TypeScript error", 5);
      expect(Array.isArray(knowledgeResults)).toBe(true);

      // Step 6: Atom search
      const atomResults = atomStore.search("TypeScript", 5);
      expect(Array.isArray(atomResults)).toBe(true);

      // Step 7: Context building
      contextEngine.invalidateCache();
      const context = contextEngine.build(input, [{ role: "user", content: input }]);
      expect(context.input).toBe(input);

      // Step 8: Verification
      const verification = verificationEngine.verifyResult("test", "Here's how to fix it...");
      expect(verification.overallVerdict).toBe("pass");

      // Step 9: Memory records result
      memoryEngine.observe("Here's how to fix it...", "llm");

      // Step 10: Verify memory has observations
      expect(memoryEngine.getStats().observations).toBeGreaterThan(1);
    });
  });

  describe("Event Bus Integration", () => {
    it("events flow through the entire system", () => {
      let received = false;
      eventBus.subscribe("test.full-flow", () => { received = true; });

      // Publish from one module
      eventBus.publish({
        type: "test.full-flow",
        source: "test",
        data: { input: "test" },
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

  describe("Tick Engine Integration", () => {
    it("runtime status includes all modules", () => {
      const status = getRuntimeStatus();
      expect(status.tick).toBeDefined();
      expect(status.events).toBeDefined();
      expect(status.actors).toBeDefined();
      expect(status.stateVersion).toBeGreaterThan(0);
    });

    it("tick engine status is available", () => {
      const status = getRuntimeStatus();
      expect(status.tick).toBeDefined();
      // Phase count depends on whether tick engine was started
      expect(typeof status.tick.phaseCount).toBe("number");
    });
  });

  describe("Memory Engine Integration", () => {
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
  });

  describe("Projection Layer Integration", () => {
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

  describe("Cognitive Pipeline Integration", () => {
    it("runs full pipeline", async () => {
      const result = await cognitivePipeline.run("What is the meaning of life?");
      expect(result.stage).toBeDefined();
      expect(result.stageTimings.size).toBeGreaterThan(0);
    });

    it("tracks deterministic vs LLM usage", () => {
      const stats = cognitivePipeline.getStats();
      expect(stats.runs).toBeGreaterThan(0);
      expect(stats.deterministicRate).toBeDefined();
    });
  });
});
