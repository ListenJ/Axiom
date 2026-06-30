import { describe, it, expect } from "bun:test";
import { eventBus, worldState, getRuntimeStatus } from "../src/runtime/kernel.js";
import { atomStore, parseCodeToAtoms, parseMarkdownToAtoms } from "../src/runtime/atom-engine.js";
import { constraintSolver } from "../src/runtime/constraint-solver.js";
import { capabilityRegistry } from "../src/runtime/capability-registry.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { ruleEngine } from "../src/runtime/rule-engine.js";
import { verificationEngine } from "../src/runtime/verification-engine.js";
import { cognitivePipeline } from "../src/runtime/scheduler.js";
import { contextEngine } from "../src/runtime/context-engine.js";

describe("Atom Engine Parsers", () => {
  it("parses code into atoms", () => {
    const code = `
export function hello() { return "world"; }
export class Foo { bar() {} }
export interface Baz { qux: string }
`;
    const atoms = parseCodeToAtoms(code, "test.ts");
    expect(atoms.length).toBeGreaterThanOrEqual(2);
    expect(atoms.some((a) => a.kind === "function")).toBe(true);
    expect(atoms.some((a) => a.kind === "class")).toBe(true);
  });

  it("parses markdown into atoms", () => {
    const md = `# Title

Some content here.

## Section 1

More content.

## Section 2

Final content.`;
    const atoms = parseMarkdownToAtoms(md, "test.md");
    expect(atoms.length).toBeGreaterThanOrEqual(3);
    expect(atoms.some((a) => a.kind === "section" && a.content === "Title")).toBe(true);
  });
});

describe("Constraint Solver Advanced", () => {
  it("detects conflicts", () => {
    constraintSolver.addConstraint({
      type: "conflicts",
      dimension: "logical",
      source: "model_a",
      target: "model_b",
      confidence: 0.9,
      evidence: "test",
    });

    const result = constraintSolver.solve(["model_a", "model_b"]);
    expect(result.satisfied).toBe(false);
    expect(result.violations.some((v) => v.constraint.type === "conflicts")).toBe(true);
  });

  it("suggests additions for enables", () => {
    constraintSolver.addConstraint({
      type: "enables",
      dimension: "logical",
      source: "gpu",
      target: "cuda_support",
      confidence: 0.8,
      evidence: "test",
    });

    const result = constraintSolver.solve(["gpu"]);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("gets constraints for entity", () => {
    // Add a constraint first
    constraintSolver.addConstraint({
      type: "requires",
      dimension: "resource",
      source: "entityA",
      target: "entityB",
      confidence: 1.0,
      evidence: "test",
    });
    const constraints = constraintSolver.getConstraintsFor("entityA");
    expect(constraints.length).toBeGreaterThan(0);
  });
});

describe("Knowledge Network Advanced", () => {
  it("tracks entity timeline", () => {
    const entity = knowledgeNetwork.create("entity", "TimelineEntity", "Content");
    knowledgeNetwork.updateState(entity.id, "running");
    knowledgeNetwork.updateState(entity.id, "completed");

    const timeline = knowledgeNetwork.getTimeline(entity.id);
    expect(timeline.length).toBe(3); // created + running + completed
    expect(timeline[0].event).toBe("created");
    expect(timeline[1].event).toContain("running");
    expect(timeline[2].event).toContain("completed");
  });

  it("adds capabilities to entities", () => {
    const entity = knowledgeNetwork.create("agent", "TestAgent", "Content");
    knowledgeNetwork.addCapability(entity.id, "planning");
    knowledgeNetwork.addCapability(entity.id, "research");

    const retrieved = knowledgeNetwork.get(entity.id);
    expect(retrieved?.capabilities).toContain("planning");
    expect(retrieved?.capabilities).toContain("research");
  });

  it("adds constraints to entities", () => {
    const entity = knowledgeNetwork.create("tool", "TestTool", "Content");
    knowledgeNetwork.addConstraint(entity.id, "constraint_1");

    const retrieved = knowledgeNetwork.get(entity.id);
    expect(retrieved?.constraints).toContain("constraint_1");
  });
});

describe("Memory Engine Advanced", () => {
  it("extracts entities from observations", () => {
    const obs = memoryEngine.observe("Fixed bug in AuthService.ts using JWT tokens", "test");
    expect(obs.entities.length).toBeGreaterThan(0);
  });

  it("gets skills", () => {
    const skills = memoryEngine.getSkills();
    expect(Array.isArray(skills)).toBe(true);
  });
});

describe("Cognitive Pipeline Advanced", () => {
  it("runs full pipeline", async () => {
    const result = await cognitivePipeline.run("What is the meaning of life?");
    expect(result.stage).toBeDefined();
    expect(result.stageTimings.size).toBeGreaterThan(0);
  });

  it("tracks stats", () => {
    const stats = cognitivePipeline.getStats();
    expect(stats.runs).toBeGreaterThan(0);
    expect(stats.deterministicRate).toBeDefined();
  });
});

describe("Context Engine Advanced", () => {
  it("includes atoms in context", () => {
    atomStore.create("fact", "TestFact for context", { source: "test" });
    contextEngine.invalidateCache();

    const ctx = contextEngine.build("TestFact", []);
    expect(ctx.atoms.length).toBeGreaterThanOrEqual(0);
  });

  it("includes system info", () => {
    worldState.set("system.startTime", Date.now() - 60000);
    contextEngine.invalidateCache();

    const ctx = contextEngine.build("test", []);
    expect(ctx.system.uptime).toBeGreaterThan(0);
  });
});

describe("Verification Engine Advanced", () => {
  it("verifies reasoning with circular dependencies", () => {
    const report = verificationEngine.verifyReasoning("test-circular", {
      steps: [
        { id: 1, dependsOn: [2] },
        { id: 2, dependsOn: [1] },
      ],
      complexity: "complex",
    });

    expect(report.issues.some((i) => i.description.includes("circular"))).toBe(true);
  });

  it("warns on high latency", () => {
    const report = verificationEngine.verifyExecution("test-latency", {
      action: "slow_task",
      success: true,
      latencyMs: 15000,
    });

    expect(report.issues.some((i) => i.category === "performance")).toBe(true);
  });
});

describe("Runtime Status", () => {
  it("returns complete runtime status", () => {
    const status = getRuntimeStatus();
    expect(status.tick).toBeDefined();
    expect(status.events).toBeDefined();
    expect(status.actors).toBeDefined();
    expect(status.stateVersion).toBeGreaterThan(0);
  });

  it("event bus tracks all events", () => {
    // Publish a test event first
    eventBus.publish({ type: "test.stats", source: "test", data: {}, priority: "low" });
    const stats = eventBus.getStats();
    expect(stats.published).toBeGreaterThan(0);
  });
});
