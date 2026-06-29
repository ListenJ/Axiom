import { describe, it, expect } from "bun:test";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { cognitivePipeline } from "../src/runtime/scheduler.js";

describe("Memory Engine Similarity", () => {
  it("finds similar observations", () => {
    memoryEngine.observe("Fixed TypeScript error in AuthService", "user");
    memoryEngine.observe("TypeScript error in UserService", "user");
    memoryEngine.observe("Python syntax error", "user");

    const similar = memoryEngine.findSimilarObservations("TypeScript error");
    expect(similar.length).toBeGreaterThan(0);
  });

  it("finds similar episodes", () => {
    memoryEngine.observe("Fixed bug in login system", "user");
    memoryEngine.observe("Applied null check fix", "user");
    
    const similar = memoryEngine.findSimilarEpisodes("bug fix");
    expect(Array.isArray(similar)).toBe(true);
  });

  it("cleans up old observations", () => {
    // Create many observations
    for (let i = 0; i < 10; i++) {
      memoryEngine.observe(`Observation ${i}`, "test");
    }

    const removed = memoryEngine.cleanup(5);
    expect(typeof removed).toBe("number");
  });
});

describe("Cognitive Pipeline Enhanced", () => {
  it("extracts multiple entity types", async () => {
    const result = await cognitivePipeline.run(
      "Fix the AuthService.ts error in src/routes/chat.ts using router.executeWithRole()"
    );
    expect(result).toBeDefined();
    expect(result.stage).toBeDefined();
  });

  it("handles complex queries", async () => {
    const result = await cognitivePipeline.run(
      "How do I implement a Bayesian expertise inference system with exponential decay?"
    );
    expect(result).toBeDefined();
  });

  it("handles code-related queries", async () => {
    const result = await cognitivePipeline.run(
      "Refactor the user_auth_token to use JWT tokens with refresh logic"
    );
    expect(result).toBeDefined();
  });
});
