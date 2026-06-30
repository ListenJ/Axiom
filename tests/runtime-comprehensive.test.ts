import { describe, it, expect } from "bun:test";
import { eventBus, worldState, getRuntimeStatus } from "../src/runtime/kernel.js";
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

describe("Runtime Comprehensive Tests", () => {
  describe("Module Initialization", () => {
    it("all modules are initialized", () => {
      expect(atomStore).toBeDefined();
      expect(constraintSolver).toBeDefined();
      expect(capabilityRegistry).toBeDefined();
      expect(knowledgeNetwork).toBeDefined();
      expect(memoryEngine).toBeDefined();
      expect(ruleEngine).toBeDefined();
      expect(verificationEngine).toBeDefined();
      expect(cognitivePipeline).toBeDefined();
      expect(contextEngine).toBeDefined();
      expect(projectionRegistry).toBeDefined();
    });

    it("constraint solver has predefined constraints", () => {
      const stats = constraintSolver.getStats();
      expect(stats.total).toBeGreaterThan(0);
    });

    it("capability registry has capabilities", () => {
      const stats = capabilityRegistry.getStats();
      expect(stats.capabilities).toBeGreaterThan(0);
    });

    it("rule engine has rules", () => {
      const stats = ruleEngine.getStats();
      expect(stats.total).toBeGreaterThan(0);
    });
  });

  describe("Atom Engine", () => {
    it("creates and queries atoms", () => {
      const atom = atomStore.create("entity", "TestAtom", { source: "test" });
      expect(atom.id).toBeDefined();
      expect(atom.kind).toBe("entity");

      const results = atomStore.search("TestAtom", 5);
      expect(results.length).toBeGreaterThan(0);
    });

    it("handles multiple atom kinds", () => {
      atomStore.create("function", "testFunc", { source: "test" });
      atomStore.create("class", "TestClass", { source: "test" });
      atomStore.create("fact", "TestFact", { source: "test" });

      const funcs = atomStore.queryByKind("function");
      const classes = atomStore.queryByKind("class");
      const facts = atomStore.queryByKind("fact");

      expect(funcs.length).toBeGreaterThan(0);
      expect(classes.length).toBeGreaterThan(0);
      expect(facts.length).toBeGreaterThan(0);
    });

    it("creates relations between atoms", () => {
      const a = atomStore.create("entity", "EntityA", { source: "test" });
      const b = atomStore.create("entity", "EntityB", { source: "test" });
      const ok = atomStore.relate(a.id, b.id, "related-to");
      expect(ok).toBe(true);

      const related = atomStore.getRelated(a.id);
      expect(related.some((r) => r.id === b.id)).toBe(true);
    });
  });

  describe("Constraint Solver", () => {
    it("solves constraints correctly", () => {
      constraintSolver.addConstraint({
        type: "requires",
        dimension: "resource",
        source: "tool_a",
        target: "dependency_b",
        confidence: 1.0,
        evidence: "test",
      });

      // Missing dependency
      const result1 = constraintSolver.solve(["tool_a"]);
      expect(result1.satisfied).toBe(false);

      // Has dependency
      const result2 = constraintSolver.solve(["tool_a", "dependency_b"]);
      expect(result2.satisfied).toBe(true);
    });

    it("detects prohibited combinations", () => {
      constraintSolver.addConstraint({
        type: "prohibits",
        dimension: "policy",
        source: "plan_mode",
        target: "fs_write",
        confidence: 1.0,
        evidence: "test",
      });

      const result = constraintSolver.solve(["plan_mode", "fs_write"]);
      expect(result.satisfied).toBe(false);
      expect(result.violations.some((v) => v.constraint.type === "prohibits")).toBe(true);
    });

    it("learns new constraints", () => {
      const constraint = constraintSolver.learn("tool_b", "requires", "tool_c", "test evidence", 0.9);
      expect(constraint.id).toBeDefined();
      expect(constraint.type).toBe("requires");
    });
  });

  describe("Knowledge Network", () => {
    it("creates entities with state", () => {
      const entity = knowledgeNetwork.create("entity", "StatefulEntity", "Content", { state: "active" });
      expect(entity.state.current).toBe("active");

      knowledgeNetwork.updateState(entity.id, "running");
      expect(knowledgeNetwork.get(entity.id)?.state.current).toBe("running");
    });

    it("adds evidence and tracks confidence", () => {
      const entity = knowledgeNetwork.create("fact", "EvidenceFact", "Content");
      knowledgeNetwork.addEvidence(entity.id, {
        source: "test",
        confidence: 0.9,
        timestamp: Date.now(),
        description: "test evidence",
      });

      const retrieved = knowledgeNetwork.get(entity.id);
      expect(retrieved?.evidence.length).toBe(1);
      expect(retrieved?.confidence).toBeGreaterThan(0.8);
    });

    it("queries by kind and state", () => {
      knowledgeNetwork.create("concept", "TestConcept", "Content", { state: "active" });
      const byKind = knowledgeNetwork.queryByKind("concept");
      const byState = knowledgeNetwork.queryByState("active");
      expect(byKind.length).toBeGreaterThan(0);
      expect(byState.length).toBeGreaterThan(0);
    });
  });

  describe("Memory Engine", () => {
    it("records observations", () => {
      const obs = memoryEngine.observe("Test observation", "test");
      expect(obs.id).toBeDefined();
      expect(obs.content).toBe("Test observation");
    });

    it("searches across memory stages", () => {
      memoryEngine.observe("UniqueSearchTerm112233", "test");
      const results = memoryEngine.search("UniqueSearchTerm112233");
      expect(results.observations.length).toBeGreaterThan(0);
    });

    it("gets current episode", () => {
      const episode = memoryEngine.getCurrentEpisode();
      // May or may not exist depending on observations
      expect(episode === null || typeof episode.id === "string").toBe(true);
    });
  });

  describe("Rule Engine", () => {
    it("evaluates rules against context", () => {
      const matches = ruleEngine.evaluate({ intent: "code" });
      expect(Array.isArray(matches)).toBe(true);
    });

    it("learns new rules", () => {
      const rule = ruleEngine.learn("inference", "test-rule", "intent == test", "do_something", "test evidence", 0.8);
      expect(rule.id).toBeDefined();
      expect(rule.source).toBe("learned");
    });

    it("lists rules by type", () => {
      const inferenceRules = ruleEngine.listByType("inference");
      expect(inferenceRules.length).toBeGreaterThan(0);
    });
  });

  describe("Verification Engine", () => {
    it("verifies input", () => {
      const report = verificationEngine.verifyInput("test-input", "valid input");
      expect(report.overallVerdict).toBe("pass");
    });

    it("flags empty input", () => {
      const report = verificationEngine.verifyInput("test-empty", "");
      expect(report.checks.some((c) => c.verdict === "fail")).toBe(true);
    });

    it("verifies result", () => {
      const report = verificationEngine.verifyResult("test-result", "valid result");
      expect(report.overallVerdict).toBe("pass");
    });

    it("flags fabrication", () => {
      const report = verificationEngine.verifyResult("test-fabrication", "[FABRICATED] fake");
      expect(report.issues.some((i) => i.category === "hallucination")).toBe(true);
    });

    it("full verification pipeline", async () => {
      const reports = await verificationEngine.verifyFull("test-full", {
        input: "valid",
        execution: { action: "test", success: true, latencyMs: 50 },
        result: "valid",
      });
      expect(reports.length).toBeGreaterThan(0);
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

  describe("Context Engine", () => {
    it("builds context from world state", () => {
      worldState.set("workspace.projectPath", "/test/project");
      contextEngine.invalidateCache();
      const ctx = contextEngine.build("test input", []);
      expect(ctx.input).toBe("test input");
    });

    it("formats context for prompt", () => {
      const ctx = contextEngine.build("test", [{ role: "user", content: "hello" }]);
      const prompt = contextEngine.formatForPrompt(ctx);
      expect(prompt).toContain("test");
    });
  });

  describe("Projection Layer", () => {
    it("syncs all projections", async () => {
      const result = await projectionRegistry.syncAll();
      expect(result.synced).toBeGreaterThan(0);
    });

    it("has all projections registered", () => {
      const stats = projectionRegistry.getAllStats();
      expect(stats.markdown).toBeDefined();
      expect(stats.sqlite).toBeDefined();
      expect(stats.kg).toBeDefined();
      expect(stats.cache).toBeDefined();
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
  });
});
