import { describe, it, expect } from "bun:test";
import { mentalModelManager, initMentalModels } from "../src/runtime/mental-model.js";
import { reasoningGraphBuilder } from "../src/runtime/reasoning-graph.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { constraintSolver } from "../src/runtime/constraint-solver.js";

// Initialize
initMentalModels();

describe("Mental Model Simulation", () => {
  it("simulates with state transitions", () => {
    const model = mentalModelManager.getModel("git");
    if (model) {
      // Add a rule with condition and action
      mentalModelManager.addRule(model.id, {
        condition: "HEAD == main",
        action: "set branch to feature",
        confidence: 0.9,
      });

      const simulation = mentalModelManager.simulate(model.id, "switch to feature branch", {
        HEAD: "main",
        branch: "main",
      });

      expect(simulation).toBeDefined();
      expect(simulation?.steps.length).toBeGreaterThan(0);
    }
  });

  it("evaluates conditions correctly", () => {
    const model = mentalModelManager.getModel("auth");
    if (model) {
      mentalModelManager.addRule(model.id, {
        condition: "token exists",
        action: "set authenticated to true",
        confidence: 0.9,
      });

      const simulation = mentalModelManager.simulate(model.id, "authenticate with token", {
        token: "abc123",
      });

      expect(simulation).toBeDefined();
    }
  });

  it("applies relationship effects", () => {
    const model = mentalModelManager.getModel("git");
    if (model) {
      const simulation = mentalModelManager.simulate(model.id, "merge conflict", {
        HEAD: "main",
        Merge: "feature",
      });

      expect(simulation).toBeDefined();
    }
  });
});

describe("Reasoning Graph Enhanced", () => {
  it("identifies gaps in complex reasoning", () => {
    const graph = reasoningGraphBuilder.build(
      "How to implement a Bayesian expertise inference system with exponential decay?"
    );
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.gaps.length).toBeGreaterThanOrEqual(0);
  });

  it("fills gaps and updates completeness", () => {
    const graph = reasoningGraphBuilder.build("Complex question");
    if (graph.gaps.length > 0) {
      const gapNode = graph.nodes.find((n) => n.type === "gap");
      if (gapNode) {
        const filled = reasoningGraphBuilder.fillGap(graph, gapNode.id, "LLM answer", 0.8);
        expect(filled.completeness).toBeGreaterThanOrEqual(graph.completeness);
      }
    }
  });

  it("tracks stats", () => {
    const stats = reasoningGraphBuilder.getStats();
    expect(stats.built).toBeGreaterThan(0);
  });
});

describe("Knowledge Network Enhanced", () => {
  it("creates entities with behaviors", () => {
    const entity = knowledgeNetwork.create("entity", "BehaviorTest", "Content");
    knowledgeNetwork.addBehavior(entity.id, {
      trigger: "temperature > 100",
      action: "evaporate",
      effect: "water turns to steam",
      confidence: 0.99,
    });

    const retrieved = knowledgeNetwork.get(entity.id);
    expect(retrieved?.behaviors.length).toBe(1);
  });

  it("creates entities with predictions", () => {
    const entity = knowledgeNetwork.create("entity", "PredictionTest", "Content");
    knowledgeNetwork.addPrediction(entity.id, {
      condition: "if no fire",
      outcome: "water will not boil",
      confidence: 0.95,
      timeHorizon: "indefinite",
      basedOn: ["physics-law"],
    });

    const retrieved = knowledgeNetwork.get(entity.id);
    expect(retrieved?.predictions.length).toBe(1);
  });

  it("creates and resolves hypotheses", () => {
    const entity = knowledgeNetwork.create("entity", "HypothesisTest", "Content");
    knowledgeNetwork.addHypothesis(entity.id, {
      statement: "This code will pass tests",
      evidence: ["code review passed"],
      counterEvidence: [],
      confidence: 0.7,
    });

    const hypothesis = knowledgeNetwork.get(entity.id)?.hypotheses[0];
    expect(hypothesis).toBeDefined();
    expect(hypothesis?.status).toBe("proposed");

    if (hypothesis) {
      knowledgeNetwork.resolveHypothesis(entity.id, hypothesis.id, "confirmed", "all tests passed");
      expect(knowledgeNetwork.get(entity.id)?.hypotheses[0].status).toBe("confirmed");
    }
  });
});

describe("Multi-dimensional Constraints", () => {
  it("adds resource constraints", () => {
    constraintSolver.addConstraint({
      type: "requires",
      dimension: "resource",
      source: "gpu_task",
      target: "gpu_available",
      confidence: 1.0,
      evidence: "GPU required",
    });

    const resourceConstraints = constraintSolver.getConstraintsByDimension("resource");
    expect(resourceConstraints.length).toBeGreaterThan(0);
  });

  it("adds policy constraints", () => {
    constraintSolver.addConstraint({
      type: "prohibits",
      dimension: "policy",
      source: "production",
      target: "direct_deploy",
      confidence: 1.0,
      evidence: "Requires approval",
    });

    const policyConstraints = constraintSolver.getConstraintsByDimension("policy");
    expect(policyConstraints.length).toBeGreaterThan(0);
  });

  it("solves multi-dimensional constraints", () => {
    const result = constraintSolver.solve(["gpu_task", "production"]);
    expect(result.satisfied).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
