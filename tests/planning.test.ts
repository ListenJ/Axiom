import { describe, it, expect } from "bun:test";
import {
  assessComplexity,
  verifyOutput,
  verifyPlanExecution,
  CERTAINTY_LEVELS,
} from "../src/agents/planning/index.js";
import type { ExecutionPlan } from "../src/agents/planning/index.js";

describe("Planning Phase", () => {
  describe("Complexity Classifier", () => {
    it("short messages are simple", () => {
      const result = assessComplexity("hello");
      expect(result.complexity).toBe("simple");
      expect(result.needsPlanning).toBe(false);
    });

    it("greetings are simple", () => {
      expect(assessComplexity("hi there").complexity).toBe("simple");
      expect(assessComplexity("你好").complexity).toBe("simple");
    });

    it("refactoring tasks are medium or complex", () => {
      const result = assessComplexity("refactor the authentication module to use JWT tokens");
      expect(["medium", "complex"]).toContain(result.complexity);
      expect(result.needsPlanning).toBe(true);
    });

    it("architecture tasks are complex", () => {
      const result = assessComplexity("design the architecture for a microservice system");
      expect(result.complexity).toBe("complex");
    });

    it("single complexity keyword is medium", () => {
      const result = assessComplexity("optimize the database query performance");
      expect(result.complexity).toBe("medium");
      expect(result.needsPlanning).toBe(true);
    });

    it("long messages without keywords are medium", () => {
      const longMsg = "a".repeat(250);
      const result = assessComplexity(longMsg);
      expect(result.complexity).toBe("medium");
    });
  });

  describe("Output Verifier", () => {
    const simplePlan: ExecutionPlan = {
      understanding: "test",
      knownFacts: [],
      unknowns: [],
      steps: [{ id: 1, action: "generate", description: "test", expectedOutput: "test", verifyMethod: "test" }],
      verificationCriteria: "test",
      complexity: "simple",
      firstPrinciples: [],
    };

    const complexPlan: ExecutionPlan = {
      understanding: "complex task",
      knownFacts: [],
      unknowns: [],
      steps: [
        { id: 1, action: "analyze", description: "analyze", expectedOutput: "analysis", verifyMethod: "check" },
        { id: 2, action: "generate", description: "generate", expectedOutput: "output", verifyMethod: "check" },
      ],
      verificationCriteria: "output must be correct",
      complexity: "complex",
      firstPrinciples: ["atomic fact"],
    };

    it("simple plan skips verification", async () => {
      const result = await verifyPlanExecution(simplePlan, "any output");
      expect(result.passed).toBe(true);
      expect(result.summary).toContain("SKIPPED");
    });

    it("complex plan with good output passes", () => {
      const result = verifyOutput(complexPlan, "This is a detailed analysis of the problem. ".repeat(5));
      expect(result.passed).toBe(true);
    });

    it("complex plan with suspicious URLs flagged", () => {
      const result = verifyOutput(complexPlan, "Check http://localhost:5173/api/test for details. " + "x".repeat(100));
      expect(result.issues.some((i) => i.category === "hallucination")).toBe(true);
    });

    it("complex plan with fake citation flagged", () => {
      const result = verifyOutput(complexPlan, "According to a recent study, this is correct. " + "x".repeat(100));
      expect(result.issues.some((i) => i.description.includes("Citation"))).toBe(true);
    });

    it("FABRICATED marker is high severity", () => {
      const result = verifyOutput(complexPlan, `${CERTAINTY_LEVELS.FABRICATED} This is made up. ` + "x".repeat(100));
      expect(result.issues.some((i) => i.severity === "high")).toBe(true);
      expect(result.passed).toBe(false);
    });

    it("empty output for complex task flagged", () => {
      const result = verifyOutput(complexPlan, "short");
      expect(result.issues.some((i) => i.category === "incomplete")).toBe(true);
    });
  });
});
