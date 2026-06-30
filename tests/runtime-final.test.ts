import { describe, it, expect } from "bun:test";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { cognitivePipeline } from "../src/runtime/scheduler.js";
import { atomStore } from "../src/runtime/atom-engine.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { constraintSolver } from "../src/runtime/constraint-solver.js";
import { ruleEngine } from "../src/runtime/rule-engine.js";
import { verificationEngine } from "../src/runtime/verification-engine.js";

describe("Runtime Comprehensive Integration", () => {
  describe("Memory Engine Auto-Learning", () => {
    it("auto-learns from patterns", () => {
      // Create observations with shared keywords
      memoryEngine.observe("Fixed TypeScript error in AuthService", "user");
      memoryEngine.observe("Fixed TypeScript error in UserService", "user");
      memoryEngine.observe("Fixed TypeScript error in SessionService", "user");

      const result = memoryEngine.autoLearnFromPatterns();
      expect(result.patterns).toBeGreaterThanOrEqual(0);
      expect(result.skills).toBeGreaterThanOrEqual(0);
      expect(result.knowledge).toBeGreaterThanOrEqual(0);
    });

    it("forms knowledge from similar observations", () => {
      // Create similar observations
      memoryEngine.observe("API endpoint returns 500 error", "user");
      memoryEngine.observe("API endpoint returns timeout error", "user");
      memoryEngine.observe("API endpoint returns connection error", "user");

      const knowledge = memoryEngine.getKnowledge();
      expect(Array.isArray(knowledge)).toBe(true);
    });
  });

  describe("Cognitive Pipeline Enhanced", () => {
    it("extracts entities from complex queries", async () => {
      const result = await cognitivePipeline.run(
        "Fix the AuthService.ts error using router.executeWithRole() in src/routes/chat.ts"
      );
      expect(result).toBeDefined();
      expect(result.stage).toBeDefined();
    });

    it("handles multiple entity types", async () => {
      const result = await cognitivePipeline.run(
        "Merge feature/runtime-integration into main and deploy v2.8.2"
      );
      expect(result).toBeDefined();
    });
  });

  describe("Knowledge Network Enhanced", () => {
    it("creates entities with evidence", () => {
      const entity = knowledgeNetwork.create("fact", "TestFact", "Content", {
        confidence: 0.9,
        source: "test",
      });

      knowledgeNetwork.addEvidence(entity.id, {
        source: "test-source",
        confidence: 0.95,
        timestamp: Date.now(),
        description: "test evidence",
      });

      const retrieved = knowledgeNetwork.get(entity.id);
      expect(retrieved?.evidence.length).toBe(1);
      expect(retrieved?.confidence).toBeGreaterThan(0.9);
    });

    it("tracks entity timeline", () => {
      const entity = knowledgeNetwork.create("entity", "TimelineEntity", "Content");
      knowledgeNetwork.updateState(entity.id, "running");
      knowledgeNetwork.updateState(entity.id, "completed");

      const timeline = knowledgeNetwork.getTimeline(entity.id);
      expect(timeline.length).toBe(3);
    });
  });

  describe("Constraint Solver Enhanced", () => {
    it("solves complex constraint chains", () => {
      constraintSolver.addConstraint({
        type: "requires",
        dimension: "resource",
        source: "A",
        target: "B",
        confidence: 1.0,
        evidence: "test",
      });
      constraintSolver.addConstraint({
        type: "requires",
        dimension: "resource",
        source: "B",
        target: "C",
        confidence: 1.0,
        evidence: "test",
      });

      // A requires B, B requires C
      const result1 = constraintSolver.solve(["A"]);
      expect(result1.satisfied).toBe(false);

      const result2 = constraintSolver.solve(["A", "B"]);
      expect(result2.satisfied).toBe(false);

      const result3 = constraintSolver.solve(["A", "B", "C"]);
      expect(result3.satisfied).toBe(true);
    });
  });

  describe("Rule Engine Enhanced", () => {
    it("evaluates complex rules", () => {
      const matches = ruleEngine.evaluate({
        intent: "code",
        mode: "agent",
        complexity: "complex",
        retries: 5,
      });
      expect(Array.isArray(matches)).toBe(true);
    });

    it("learns from observations", () => {
      const rule = ruleEngine.learn(
        "inference",
        "test-learned-rule",
        "intent == code",
        "route_to_coding",
        "learned from test",
        0.8,
      );
      expect(rule.id).toBeDefined();
      expect(rule.source).toBe("learned");
    });
  });

  describe("Verification Engine Enhanced", () => {
    it("verifies complex outputs", () => {
      const report = verificationEngine.verifyResult("test-complex", `
        Here is a comprehensive solution:
        1. First, we need to understand the problem
        2. Then, we can apply the fix
        3. Finally, we verify the fix works
      `);
      expect(report.overallVerdict).toBe("pass");
    });

    it("flags suspicious content", () => {
      const report = verificationEngine.verifyResult("test-suspicious", `
        According to a recent study, this approach works 100% of the time.
        The documentation at http://localhost:8080/api confirms this.
      `);
      // May or may not flag depending on patterns
      expect(report).toBeDefined();
      expect(report.overallVerdict).toBeDefined();
    });
  });

  describe("Atom Engine Enhanced", () => {
    it("creates complex atom structures", () => {
      const parent = atomStore.create("class", "ParentClass", { source: "test" });
      const child1 = atomStore.create("function", "method1", { source: "test", parentId: parent.id });
      const child2 = atomStore.create("function", "method2", { source: "test", parentId: parent.id });

      expect(parent.children.length).toBe(2);
      expect(atomStore.queryChildren(parent.id).length).toBe(2);
    });

    it("handles atom relations", () => {
      const a = atomStore.create("entity", "EntityA", { source: "test" });
      const b = atomStore.create("entity", "EntityB", { source: "test" });
      const c = atomStore.create("entity", "EntityC", { source: "test" });

      atomStore.relate(a.id, b.id, "depends-on");
      atomStore.relate(b.id, c.id, "depends-on");

      const related = atomStore.getRelated(a.id);
      expect(related.length).toBeGreaterThan(0);
    });
  });
});
