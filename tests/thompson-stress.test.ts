/**
 * Thompson Router: deep stress tests for the cold-start fix
 */
import { describe, it, expect } from "bun:test";
import { createThompsonRouter, type RouterArm } from "../src/router/thompson-router.js";

function makeArm(id: string, alpha = 1, beta = 1): RouterArm {
  return { id, model: id, provider: "p", alpha, beta, metadata: {} };
}

describe("ThompsonRouter", () => {
  it("cold start: all arms with prior (1,1) still route", async () => {
    // After the fix: previously this disabled TS because hasColdArm was true.
    // Now TS always runs with the uninformative prior.
    const router = createThompsonRouter({
      arms: [makeArm("a1"), makeArm("a2")],
      minSamples: 10,
      inMemory: true,
    });
    const d = await router.route({ taskType: "general-chat", inputLength: 100, timeWindow: 5000 });
    expect(d.arm).toBeDefined();
    expect(d.reason).toContain("Thompson");
    expect(d.samples.length).toBe(2);
  });

  it("single arm routes correctly", async () => {
    const router = createThompsonRouter({
      arms: [makeArm("only")],
      minSamples: 0,
      inMemory: true,
    });
    const d = await router.route({ taskType: "chat", inputLength: 10 });
    expect(d.arm.id).toBe("only");
  });

  it("feedback updates stats", async () => {
    const router = createThompsonRouter({
      arms: [makeArm("a1"), makeArm("a2")],
      minSamples: 0,
      inMemory: true,
    });
    router.reportFeedback("a1", true);
    router.reportFeedback("a2", false);
    const stats = router.getArmStats();
    const a1 = stats.find(s => s.id === "a1")!;
    const a2 = stats.find(s => s.id === "a2")!;
    expect(a1.mean).toBeGreaterThan(a2.mean);
  });

  // Stress: 100 calls should be fast
  it("stress: 100 concurrent routes", async () => {
    const arms = Array.from({ length: 5 }, (_, i) => makeArm(`arm${i}`, 1 + i, 1));
    const router = createThompsonRouter({ arms, minSamples: 0, inMemory: true });
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => router.route({ taskType: "chat", inputLength: 50 })),
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(5000); // 100 routes in 5s
    expect(results.length).toBe(100);
    results.forEach(r => expect(r.arm).toBeDefined());
  });

  it("persistence: in-memory arms survive reset", async () => {
    const router = createThompsonRouter({
      arms: [makeArm("x")],
      minSamples: 0,
      inMemory: true,
    });
    router.reportFeedback("x", true);
    expect(router.getTotalRounds()).toBe(1);
    router.reset();
    expect(router.getTotalRounds()).toBe(0);
    const d = await router.route({ taskType: "chat", inputLength: 50 });
    expect(d.arm.id).toBe("x");
  });
});
