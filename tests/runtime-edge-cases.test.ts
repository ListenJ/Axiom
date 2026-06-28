import { describe, it, expect } from "bun:test";
import { eventBus, worldState } from "../src/runtime/kernel.js";
import { atomStore } from "../src/runtime/atom-engine.js";
import { constraintSolver } from "../src/runtime/constraint-solver.js";
import { capabilityRegistry } from "../src/runtime/capability-registry.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { ruleEngine } from "../src/runtime/rule-engine.js";
import { verificationEngine } from "../src/runtime/verification-engine.js";
import { projectionRegistry, initProjections } from "../src/runtime/projection-layer.js";

initProjections();

describe("Edge Cases", () => {
  describe("Atom Engine", () => {
    it("handles empty content", () => {
      const atom = atomStore.create("entity", "", { source: "test" });
      expect(atom.id).toBeDefined();
      expect(atom.content).toBe("");
    });

    it("handles very long content", () => {
      const longContent = "x".repeat(10000);
      const atom = atomStore.create("document", longContent, { source: "test" });
      expect(atom.content.length).toBe(10000);
    });

    it("handles special characters", () => {
      const special = "Hello <script>alert(1)</script> & 'world' \"test\"";
      const atom = atomStore.create("entity", special, { source: "test" });
      expect(atom.content).toBe(special);
    });

    it("handles concurrent creates", () => {
      const atoms = [];
      for (let i = 0; i < 100; i++) {
        atoms.push(atomStore.create("entity", `ConcurrentEntity${i}`, { source: "test" }));
      }
      expect(atoms.length).toBe(100);
      expect(new Set(atoms.map((a) => a.id)).size).toBe(100); // all unique IDs
    });
  });

  describe("Constraint Solver", () => {
    it("handles empty entity list", () => {
      const result = constraintSolver.solve([]);
      expect(result.satisfied).toBe(true);
    });

    it("handles duplicate constraints", () => {
      const id1 = constraintSolver.addConstraint({
        type: "requires",
        source: "dup",
        target: "target",
        confidence: 1.0,
        evidence: "test",
      });
      const id2 = constraintSolver.addConstraint({
        type: "requires",
        source: "dup",
        target: "target",
        confidence: 1.0,
        evidence: "test",
      });
      // Both should be added (no dedup at constraint level)
      expect(id1.id).not.toBe(id2.id);
    });

    it("handles self-referencing constraints", () => {
      constraintSolver.addConstraint({
        type: "requires",
        source: "self",
        target: "self",
        confidence: 1.0,
        evidence: "test",
      });
      const result = constraintSolver.solve(["self"]);
      expect(result.satisfied).toBe(true); // self-referencing is satisfied if self is present
    });
  });

  describe("Knowledge Network", () => {
    it("handles rapid state changes", () => {
      const entity = knowledgeNetwork.create("entity", "RapidEntity", "Content");
      for (let i = 0; i < 10; i++) {
        knowledgeNetwork.updateState(entity.id, `state_${i}`);
      }
      const timeline = knowledgeNetwork.getTimeline(entity.id);
      expect(timeline.length).toBe(11); // created + 10 state changes
    });

    it("handles entity with many relations", () => {
      const main = knowledgeNetwork.create("entity", "HubEntity", "Content");
      const others = [];
      for (let i = 0; i < 20; i++) {
        others.push(knowledgeNetwork.create("entity", `Spoke${i}`, "Content"));
      }
      // Add constraints to link them
      for (const other of others) {
        knowledgeNetwork.addConstraint(main.id, other.id);
      }
      const retrieved = knowledgeNetwork.get(main.id);
      expect(retrieved?.constraints.length).toBe(20);
    });
  });

  describe("Memory Engine", () => {
    it("handles rapid observations", () => {
      for (let i = 0; i < 50; i++) {
        memoryEngine.observe(`Rapid observation ${i}`, "test");
      }
      const stats = memoryEngine.getStats();
      expect(stats.observations).toBeGreaterThanOrEqual(50);
    });

    it("handles observations with no entities", () => {
      const obs = memoryEngine.observe("Simple greeting hello", "test");
      expect(obs.id).toBeDefined();
    });
  });

  describe("Rule Engine", () => {
    it("handles empty context", () => {
      const matches = ruleEngine.evaluate({});
      expect(Array.isArray(matches)).toBe(true);
    });

    it("handles numeric comparisons", () => {
      ruleEngine.addRule({
        type: "inference",
        name: "numeric-test",
        description: "Test numeric comparison",
        condition: "count > 5",
        action: "do_something",
        priority: 10,
        confidence: 0.9,
        source: "test",
      });

      const matches = ruleEngine.evaluate({ count: 10 });
      expect(matches.some((m) => m.rule.name === "numeric-test" && m.matched)).toBe(true);

      const noMatches = ruleEngine.evaluate({ count: 3 });
      expect(noMatches.some((m) => m.rule.name === "numeric-test" && m.matched)).toBe(false);
    });

    it("handles regex matching", () => {
      ruleEngine.addRule({
        type: "inference",
        name: "regex-test",
        description: "Test regex matching",
        condition: "email matches \\w+@\\w+",
        action: "validate_email",
        priority: 10,
        confidence: 0.9,
        source: "test",
      });

      const matches = ruleEngine.evaluate({ email: "user@example" });
      expect(matches.some((m) => m.rule.name === "regex-test" && m.matched)).toBe(true);
    });
  });

  describe("Verification Engine", () => {
    it("handles null input", () => {
      const report = verificationEngine.verifyInput("null-test", null);
      expect(report.checks.some((c) => c.verdict === "fail")).toBe(true);
    });

    it("handles undefined input", () => {
      const report = verificationEngine.verifyInput("undef-test", undefined);
      expect(report.checks.some((c) => c.verdict === "fail")).toBe(true);
    });

    it("handles very long input", () => {
      const longInput = "x".repeat(200000);
      const report = verificationEngine.verifyInput("long-test", longInput);
      expect(report.checks.some((c) => c.id === "input-length" && c.verdict === "fail")).toBe(true);
    });
  });

  describe("Projection Layer", () => {
    it("syncs all projections", async () => {
      const result = await projectionRegistry.syncAll();
      expect(result.synced).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    it("generates markdown", () => {
      const md = projectionRegistry.get("markdown");
      expect(md).toBeDefined();
    });

    it("generates graph data", () => {
      const kg = projectionRegistry.get("kg");
      expect(kg).toBeDefined();
    });
  });

  describe("Event Bus", () => {
    it("handles rapid events", () => {
      for (let i = 0; i < 100; i++) {
        eventBus.publish({ type: "test.rapid", source: "test", data: { i }, priority: "low" });
      }
      const stats = eventBus.getStats();
      expect(stats.published).toBeGreaterThanOrEqual(100);
    });

    it("handles unsubscribe", () => {
      let count = 0;
      const id = eventBus.subscribe("test.unsub", () => { count++; });
      eventBus.publish({ type: "test.unsub", source: "test", data: {}, priority: "low" });
      expect(count).toBe(1);

      eventBus.unsubscribe(id);
      eventBus.publish({ type: "test.unsub", source: "test", data: {}, priority: "low" });
      expect(count).toBe(1); // should not increase
    });
  });

  describe("World State", () => {
    it("handles nested paths", () => {
      worldState.set("a.b.c.d", "deep");
      expect(worldState.get("a.b.c.d")).toBe("deep");
    });

    it("handles overwriting values", () => {
      worldState.set("overwrite.test", "old");
      worldState.set("overwrite.test", "new");
      expect(worldState.get("overwrite.test")).toBe("new");
    });

    it("handles query with no matches", () => {
      const results = worldState.query("nonexistent.prefix.");
      expect(results.size).toBe(0);
    });
  });
});
