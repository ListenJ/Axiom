import { describe, it, expect } from "bun:test";
import {
  scoreCandidates,
  buildRoutingContext,
} from "../src/router/context-scorer.js";
import {
  applyStrategies,
  recordCircuitFailure,
  recordCircuitSuccess,
  isCircuitOpen,
} from "../src/router/route-strategy.js";
import type { TaskRole } from "../src/router/model-capability-registry.js";

describe("Context-aware Routing", () => {
  describe("Context Scorer", () => {
    it("buildRoutingContext infers time of day", () => {
      const ctx = buildRoutingContext([{ role: "user", content: "hello" }]);
      expect(["morning", "afternoon", "evening", "night"]).toContain(ctx.timeOfDay);
    });

    it("buildRoutingContext infers simple complexity for short messages", () => {
      const ctx = buildRoutingContext([{ role: "user", content: "hi" }]);
      expect(ctx.taskComplexity).toBe("simple");
    });

    it("buildRoutingContext infers complex for architecture tasks", () => {
      const ctx = buildRoutingContext([{ role: "user", content: "design the architecture for the system" }]);
      expect(ctx.taskComplexity).toBe("complex");
    });

    it("scoreCandidates returns sorted scores", () => {
      const candidates = [
        { model: "m1", provider: "p1", role: "coding" as TaskRole },
        { model: "m2", provider: "p2", role: "research" as TaskRole },
        { model: "m3", provider: "p3", role: "general-chat" as TaskRole },
      ];
      const ctx = buildRoutingContext([{ role: "user", content: "hello" }]);
      const scores = scoreCandidates(candidates, ctx);
      expect(scores.length).toBe(3);
      // Should be sorted descending
      expect(scores[0].totalScore).toBeGreaterThanOrEqual(scores[1].totalScore);
    });

    it("expertise bonus is applied for expert users", () => {
      const candidates = [
        { model: "m1", provider: "p1", role: "coding" as TaskRole },
      ];
      const expertCtx = buildRoutingContext(
        [{ role: "user", content: "implement async concurrent processing with TypeScript generics" }],
      );
      const beginnerCtx = buildRoutingContext(
        [{ role: "user", content: "hi" }],
      );
      const expertScores = scoreCandidates(candidates, expertCtx);
      const beginnerScores = scoreCandidates(candidates, beginnerCtx);
      // Expert should get higher score for coding role
      expect(expertScores[0].totalScore).toBeGreaterThan(beginnerScores[0].totalScore);
    });
  });

  describe("Route Strategy", () => {
    it("applyStrategies returns a role", () => {
      const candidates = [
        { model: "m1", provider: "p1", role: "coding" as TaskRole },
        { model: "m2", provider: "p2", role: "research" as TaskRole },
      ];
      const ctx = buildRoutingContext([{ role: "user", content: "hello" }]);
      const scores = scoreCandidates(candidates, ctx);
      const result = applyStrategies(scores, ctx);
      expect(result.role).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reason).toBeDefined();
    });

    it("circuit breaker filters failed models", () => {
      // Open circuit for m1
      for (let i = 0; i < 3; i++) recordCircuitFailure("m1");
      expect(isCircuitOpen("m1")).toBe(true);

      // m2 should not be affected
      expect(isCircuitOpen("m2")).toBe(false);

      // Reset
      recordCircuitSuccess("m1");
      expect(isCircuitOpen("m1")).toBe(false);
    });

    it("fatigue mitigation increases thinking intensity for long context", () => {
      const candidates = [
        { model: "m1", provider: "p1", role: "coding" as TaskRole },
      ];
      const longCtx = buildRoutingContext(
        [{ role: "user", content: "hello" }],
        { cumulativeContextTokens: 20000 },
      );
      const scores = scoreCandidates(candidates, longCtx);
      const result = applyStrategies(scores, longCtx);
      expect(["medium", "high"]).toContain(result.thinkingIntensity);
    });
  });
});
