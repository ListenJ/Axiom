import { describe, it, expect, beforeEach } from "bun:test";
import { constraintSolver, initConstraints } from "../src/runtime/constraint-solver.js";
import { capabilityRegistry, initCapabilities } from "../src/runtime/capability-registry.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { ruleEngine, initRules } from "../src/runtime/rule-engine.js";
import { agentExecutor } from "../src/runtime/agent-executor.js";
import { verificationEngine } from "../src/runtime/verification-engine.js";

// Initialize modules once
initConstraints();
initCapabilities();
initRules();

describe("Constraint Solver", () => {
  it("adds and solves constraints", () => {
    constraintSolver.addConstraint({
      type: "requires",
      dimension: "resource",
      source: "toolA",
      target: "dependencyB",
      confidence: 1.0,
      evidence: "test",
    });

    const result = constraintSolver.solve(["toolA"]);
    expect(result.satisfied).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("passes when constraints satisfied", () => {
    const result = constraintSolver.solve(["toolA", "dependencyB"]);
    expect(result.satisfied).toBe(true);
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

  it("gets stats", () => {
    const stats = constraintSolver.getStats();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.solved).toBeGreaterThan(0);
  });
});

describe("Capability Registry", () => {
  it("searches for capabilities by contract", () => {
    const results = capabilityRegistry.search("code.reasoning");
    expect(results.length).toBeGreaterThan(0);
  });

  it("selects best capability", () => {
    const cap = capabilityRegistry.select("code.reasoning");
    expect(cap).not.toBeNull();
    expect(cap!.name).toBeDefined();
  });

  it("records results", () => {
    const cap = capabilityRegistry.select("code.reasoning");
    if (cap) {
      capabilityRegistry.recordResult(cap.id, true);
      expect(cap.successRate).toBeGreaterThanOrEqual(0);
    }
  });

  it("lists providers", () => {
    const providers = capabilityRegistry.getProviders();
    expect(providers.length).toBeGreaterThan(0);
  });
});

describe("Knowledge Network", () => {
  it("creates entities", () => {
    const entity = knowledgeNetwork.create("entity", "TestEntity", "Test content");
    expect(entity.id).toBeDefined();
    expect(entity.kind).toBe("entity");
    expect(entity.state.current).toBe("active");
  });

  it("updates entity state", () => {
    const entity = knowledgeNetwork.create("entity", "StatefulEntity", "Content");
    const ok = knowledgeNetwork.updateState(entity.id, "running");
    expect(ok).toBe(true);
    expect(knowledgeNetwork.get(entity.id)?.state.current).toBe("running");
  });

  it("adds evidence", () => {
    const entity = knowledgeNetwork.create("fact", "EvidenceFact", "Content");
    knowledgeNetwork.addEvidence(entity.id, {
      source: "test",
      confidence: 0.9,
      timestamp: Date.now(),
      description: "test evidence",
    });
    expect(knowledgeNetwork.get(entity.id)?.evidence.length).toBe(1);
  });

  it("queries by kind", () => {
    knowledgeNetwork.create("concept", "QueryConcept", "Content");
    const results = knowledgeNetwork.queryByKind("concept");
    expect(results.length).toBeGreaterThan(0);
  });

  it("queries by state", () => {
    knowledgeNetwork.create("entity", "ActiveEntity", "Content", { state: "active" });
    const results = knowledgeNetwork.queryByState("active");
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("Memory Engine", () => {
  it("records observations", () => {
    const obs = memoryEngine.observe("Test observation", "test");
    expect(obs.id).toBeDefined();
    expect(obs.content).toBe("Test observation");
  });

  it("searches across memory stages", () => {
    memoryEngine.observe("UniqueSearchTerm12345", "test");
    const results = memoryEngine.search("UniqueSearchTerm12345");
    expect(results.observations.length).toBeGreaterThan(0);
  });

  it("gets stats", () => {
    const stats = memoryEngine.getStats();
    expect(stats.observations).toBeGreaterThan(0);
  });
});

describe("Rule Engine", () => {
  it("adds rules", () => {
    const rule = ruleEngine.addRule({
      type: "inference",
      name: "test-rule",
      description: "Test rule",
      condition: "key == value",
      action: "do_something",
      priority: 10,
      confidence: 0.9,
      source: "test",
    });
    expect(rule.id).toBeDefined();
  });

  it("evaluates rules", () => {
    // The rule engine uses simple condition matching
    // The predefined rules check for specific context keys
    const matches = ruleEngine.evaluate({ intent: "code" });
    expect(matches.length).toBeGreaterThan(0);
  });

  it("lists rules by type", () => {
    const inferenceRules = ruleEngine.listByType("inference");
    expect(inferenceRules.length).toBeGreaterThan(0);
  });
});

describe("Agent Executor", () => {
  it("executes a task", async () => {
    const report = await agentExecutor.execute({
      id: "test-task-1",
      description: "Test task",
      resources: [],
      constraints: [],
      goal: "test",
      priority: "normal",
      metadata: {},
    });

    expect(report.taskId).toBe("test-task-1");
    expect(report.status).toBeDefined();
    expect(report.totalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("blocks on constraint violations", async () => {
    // Add a constraint that will violate
    constraintSolver.addConstraint({
      type: "prohibits",
      dimension: "policy",
      source: "blocked_task",
      target: "forbidden_resource",
      confidence: 1.0,
      evidence: "test",
    });

    const report = await agentExecutor.execute({
      id: "blocked-task",
      description: "Blocked task",
      resources: [],
      constraints: ["blocked_task", "forbidden_resource"],
      goal: "test",
      priority: "normal",
      metadata: {},
    });

    expect(report.status).toBe("failed");
  });

  it("gets stats", () => {
    const stats = agentExecutor.getStats();
    expect(stats.tasks).toBeGreaterThan(0);
  });
});

describe("Verification Engine", () => {
  it("verifies input", () => {
    const report = verificationEngine.verifyInput("test-1", "valid input");
    expect(report.overallVerdict).toBe("pass");
  });

  it("flags empty input", () => {
    const report = verificationEngine.verifyInput("test-2", "");
    expect(report.checks.some((c) => c.verdict === "fail")).toBe(true);
  });

  it("flags injection patterns", () => {
    const report = verificationEngine.verifyInput("test-3", "<script>alert(1)</script>");
    expect(report.issues.some((i) => i.category === "security")).toBe(true);
  });

  it("verifies execution", () => {
    const report = verificationEngine.verifyExecution("test-4", {
      action: "test",
      success: true,
      latencyMs: 100,
    });
    expect(report.overallVerdict).toBe("pass");
  });

  it("flags failed execution", () => {
    const report = verificationEngine.verifyExecution("test-5", {
      action: "test",
      success: false,
      error: "Test error",
      latencyMs: 100,
    });
    expect(report.overallVerdict).toBe("fail");
  });

  it("verifies result", () => {
    const report = verificationEngine.verifyResult("test-6", "valid result");
    expect(report.overallVerdict).toBe("pass");
  });

  it("flags fabrication markers", () => {
    const report = verificationEngine.verifyResult("test-7", "[FABRICATED] fake data");
    expect(report.issues.some((i) => i.category === "hallucination")).toBe(true);
  });

  it("full verification pipeline", async () => {
    const reports = await verificationEngine.verifyFull("full-test", {
      input: "valid input",
      plan: { steps: [{ id: 1 }], complexity: "simple" },
      execution: { action: "test", success: true, latencyMs: 50 },
      result: "valid result",
    });

    expect(reports.length).toBe(4);
    expect(reports[0].stage).toBe("input");
    expect(reports[1].stage).toBe("reasoning");
    expect(reports[2].stage).toBe("execution");
    expect(reports[3].stage).toBe("result");
  });
});
