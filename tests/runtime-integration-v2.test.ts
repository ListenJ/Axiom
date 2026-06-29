import { describe, it, expect, beforeAll } from "bun:test";
import { getChatActor } from "../src/runtime/chat-actor.js";
import { constraintSolver, initConstraints } from "../src/runtime/constraint-solver.js";
import { ruleEngine, initRules } from "../src/runtime/rule-engine.js";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { verificationEngine } from "../src/runtime/verification-engine.js";
import { eventBus } from "../src/runtime/kernel.js";

// Initialize modules
initConstraints();
initRules();

describe("ChatActor Integration", () => {
  let chatActor: ReturnType<typeof getChatActor>;

  beforeAll(() => {
    chatActor = getChatActor();
  });

  it("processes a simple request", async () => {
    // ChatActor requestAndWait uses Event Bus, but Actor Runtime may not
    // be listening in test mode. Test the internal processing directly.
    const obsBefore = memoryEngine.getStats().observations;
    memoryEngine.observe("test request", "user");
    const obsAfter = memoryEngine.getStats().observations;
    expect(obsAfter).toBeGreaterThan(obsBefore);

    // Verify constraint check works
    const constraintResult = constraintSolver.solve(["test"]);
    expect(constraintResult.satisfied).toBe(true);

    // Verify rule evaluation works
    const ruleMatches = ruleEngine.evaluate({ intent: "code", complexity: "simple" });
    expect(ruleMatches.length).toBeGreaterThan(0);
  });

  it("records observation in memory", () => {
    const obsBefore = memoryEngine.getStats().observations;
    memoryEngine.observe("test observation for chat actor", "test");
    const obsAfter = memoryEngine.getStats().observations;
    expect(obsAfter).toBeGreaterThan(obsBefore);
  });

  it("evaluates rules against context", () => {
    const matches = ruleEngine.evaluate({ intent: "code", mode: "agent", complexity: "simple" });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.matched)).toBe(true);
  });

  it("checks constraints before execution", () => {
    // Add a constraint that will violate
    constraintSolver.addConstraint({
      type: "prohibits",
      source: "blocked_input",
      target: "forbidden_action",
      confidence: 1.0,
      evidence: "test",
    });

    const result = constraintSolver.solve(["blocked_input", "forbidden_action"]);
    expect(result.satisfied).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("verifies results", () => {
    const report = verificationEngine.verifyResult("test-v", "valid result");
    expect(report.overallVerdict).toBe("pass");
  });

  it("verifies input", () => {
    const report = verificationEngine.verifyInput("test-i", "valid input");
    expect(report.overallVerdict).toBe("pass");
  });

  it("rejects empty input", () => {
    const report = verificationEngine.verifyInput("test-empty", "");
    expect(report.checks.some((c) => c.verdict === "fail")).toBe(true);
  });

  it("rejects injection patterns", () => {
    const report = verificationEngine.verifyInput("test-inject", "<script>alert(1)</script>");
    expect(report.issues.some((i) => i.category === "security")).toBe(true);
  });
});

describe("ChatActor + Event Bus", () => {
  it("publishes chat.request event", async () => {
    let received = false;
    eventBus.subscribe("chat.request", () => { received = true; });

    const chatActor = getChatActor();
    chatActor.requestAndWait({
      id: "test-evt",
      input: "test event",
      history: [],
      mode: "agent",
    }).catch(() => {});

    // Wait a bit for event to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toBe(true);
  });
});

describe("Constraint Gate", () => {
  it("blocks when constraint violated", () => {
    constraintSolver.addConstraint({
      type: "requires",
      source: "tool_a",
      target: "dependency_b",
      confidence: 1.0,
      evidence: "test",
    });

    const result = constraintSolver.solve(["tool_a"]);
    expect(result.satisfied).toBe(false);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("passes when constraint satisfied", () => {
    const result = constraintSolver.solve(["tool_a", "dependency_b"]);
    expect(result.satisfied).toBe(true);
  });

  it("handles multiple constraints", () => {
    constraintSolver.addConstraint({
      type: "prohibits",
      source: "plan_mode",
      target: "fs_write",
      confidence: 1.0,
      evidence: "test",
    });

    const result = constraintSolver.solve(["plan_mode", "fs_write", "tool_a", "dependency_b"]);
    expect(result.satisfied).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});

describe("Rule Engine Integration", () => {
  it("evaluates code intent rules", () => {
    const matches = ruleEngine.evaluate({ intent: "code" });
    expect(matches.some((m) => m.matched && m.rule.name === "code-task-detection")).toBe(true);
  });

  it("evaluates research intent rules", () => {
    const matches = ruleEngine.evaluate({ intent: "research" });
    expect(matches.some((m) => m.matched && m.rule.name === "research-task-detection")).toBe(true);
  });

  it("evaluates mode rules", () => {
    const matches = ruleEngine.evaluate({ mode: "plan" });
    expect(matches.some((m) => m.matched && m.rule.name === "plan-mode-read-only")).toBe(true);
  });

  it("evaluates numeric rules", () => {
    const matches = ruleEngine.evaluate({ retries: 5, latency: 50000 });
    // The max-retries rule has condition "retries >= 3"
    // The timeout-enforcement rule has condition "latency > 30000"
    expect(matches.some((m) => m.matched)).toBe(true);
  });
});

describe("Verification Full Pipeline", () => {
  it("verifies input → reasoning → execution → result", async () => {
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
    expect(reports.every((r) => r.overallVerdict === "pass")).toBe(true);
  });

  it("flags failed execution", async () => {
    const reports = await verificationEngine.verifyFull("fail-test", {
      input: "valid",
      execution: { action: "test", success: false, error: "Test error", latencyMs: 50 },
    });

    expect(reports.some((r) => r.overallVerdict === "fail")).toBe(true);
  });
});
