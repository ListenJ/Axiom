import { describe, it, expect } from "bun:test";
import { reasoningGraphBuilder } from "../src/runtime/reasoning-graph.js";
import { mentalModelManager, initMentalModels } from "../src/runtime/mental-model.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { constraintSolver } from "../src/runtime/constraint-solver.js";
import { memoryEngine } from "../src/runtime/memory-engine.js";

// Initialize mental models
initMentalModels();

describe("Reasoning Graph", () => {
  it("builds a reasoning graph from input", () => {
    const graph = reasoningGraphBuilder.build("How to fix a TypeScript error?");
    expect(graph.id).toBeDefined();
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.completeness).toBeDefined();
    expect(graph.needsLLM).toBeDefined();
  });

  it("identifies gaps in reasoning", () => {
    const graph = reasoningGraphBuilder.build("Complex question requiring multiple steps");
    expect(graph.gaps).toBeDefined();
    expect(Array.isArray(graph.gaps)).toBe(true);
  });

  it("fills gaps with LLM output", () => {
    const graph = reasoningGraphBuilder.build("test input");
    if (graph.gaps.length > 0) {
      const gapId = graph.nodes.find((n) => n.type === "gap")?.id;
      if (gapId) {
        const filled = reasoningGraphBuilder.fillGap(graph, gapId, "LLM answer", 0.8);
        expect(filled.completeness).toBeGreaterThanOrEqual(graph.completeness);
      }
    }
  });

  it("tracks stats", () => {
    const stats = reasoningGraphBuilder.getStats();
    expect(stats.built).toBeGreaterThan(0);
  });
});

describe("Mental Model", () => {
  it("creates mental models", () => {
    const model = mentalModelManager.getModel("git");
    expect(model).toBeDefined();
    expect(model?.concepts.length).toBeGreaterThan(0);
  });

  it("adds rules to models", () => {
    const model = mentalModelManager.getModel("git");
    if (model) {
      const ok = mentalModelManager.addRule(model.id, {
        condition: "merge conflict detected",
        action: "resolve conflict by choosing incoming changes",
        confidence: 0.8,
      });
      expect(ok).toBe(true);
    }
  });

  it("simulates scenarios", () => {
    const model = mentalModelManager.getModel("git");
    if (model) {
      const simulation = mentalModelManager.simulate(model.id, "merge two branches", {
        HEAD: "main",
        branch: "feature",
      });
      expect(simulation).toBeDefined();
      expect(simulation?.outcome).toBeDefined();
    }
  });

  it("generates skills from simulations", () => {
    const model = mentalModelManager.getModel("git");
    if (model) {
      const simulation = mentalModelManager.simulate(model.id, "test scenario", {});
      if (simulation) {
        const skill = mentalModelManager.generateSkillFromSimulation(model.id, simulation.id);
        expect(typeof skill === "string" || skill === null).toBe(true);
      }
    }
  });

  it("gets all models", () => {
    const models = mentalModelManager.getModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it("gets stats", () => {
    const stats = mentalModelManager.getStats();
    expect(stats.models).toBeGreaterThan(0);
  });
});

describe("Knowledge Network Enhanced", () => {
  it("adds behaviors to entities", () => {
    const entity = knowledgeNetwork.create("entity", "BehaviorEntity", "Content");
    const ok = knowledgeNetwork.addBehavior(entity.id, {
      trigger: "temperature > 100",
      action: "evaporate",
      effect: "water turns to steam",
      confidence: 0.99,
    });
    expect(ok).toBe(true);
    expect(knowledgeNetwork.get(entity.id)?.behaviors.length).toBe(1);
  });

  it("adds predictions to entities", () => {
    const entity = knowledgeNetwork.create("entity", "PredictionEntity", "Content");
    const ok = knowledgeNetwork.addPrediction(entity.id, {
      condition: "if no fire",
      outcome: "water will not boil",
      confidence: 0.95,
      timeHorizon: "indefinite",
      basedOn: ["physics-law-1"],
    });
    expect(ok).toBe(true);
    expect(knowledgeNetwork.get(entity.id)?.predictions.length).toBe(1);
  });

  it("adds and resolves hypotheses", () => {
    const entity = knowledgeNetwork.create("entity", "HypothesisEntity", "Content");
    const ok = knowledgeNetwork.addHypothesis(entity.id, {
      statement: "This code will pass all tests",
      evidence: ["code review passed"],
      counterEvidence: [],
      confidence: 0.7,
    });
    expect(ok).toBe(true);

    const hypothesis = knowledgeNetwork.get(entity.id)?.hypotheses[0];
    expect(hypothesis).toBeDefined();
    expect(hypothesis?.status).toBe("proposed");

    // Resolve hypothesis
    if (hypothesis) {
      const resolved = knowledgeNetwork.resolveHypothesis(entity.id, hypothesis.id, "confirmed", "all tests passed");
      expect(resolved).toBe(true);
      expect(knowledgeNetwork.get(entity.id)?.hypotheses[0].status).toBe("confirmed");
    }
  });
});

describe("Multi-dimensional Constraints", () => {
  it("adds constraints with dimensions", () => {
    constraintSolver.addConstraint({
      type: "requires",
      dimension: "resource",
      source: "gpu_task",
      target: "gpu_available",
      confidence: 1.0,
      evidence: "GPU required for ML inference",
    });

    const resourceConstraints = constraintSolver.getConstraintsByDimension("resource");
    expect(resourceConstraints.length).toBeGreaterThan(0);
  });

  it("queries constraints by dimension", () => {
    constraintSolver.addConstraint({
      type: "prohibits",
      dimension: "policy",
      source: "production",
      target: "direct_deploy",
      confidence: 1.0,
      evidence: "Production requires approval",
    });

    const policyConstraints = constraintSolver.getConstraintsByDimension("policy");
    expect(policyConstraints.length).toBeGreaterThan(0);
  });
});

describe("Memory Engine Mental Model Integration", () => {
  it("forms skills from mental models", () => {
    // Create a pattern that matches a mental model domain
    memoryEngine.observe("Git merge conflict in main branch", "user");
    memoryEngine.observe("Resolved conflict by accepting incoming changes", "user");

    const formed = memoryEngine.formSkillsFromMentalModels();
    expect(typeof formed).toBe("number");
  });
});
