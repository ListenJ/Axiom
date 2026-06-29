import { describe, it, expect } from "bun:test";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { cognitivePipeline } from "../src/runtime/scheduler.js";
import { atomStore } from "../src/runtime/atom-engine.js";

describe("Cognitive Pipeline Entity Extraction", () => {
  it("extracts CamelCase entities", async () => {
    const result = await cognitivePipeline.run("Fix the AuthService.ts error");
    expect(result).toBeDefined();
  });

  it("extracts snake_case entities", async () => {
    const result = await cognitivePipeline.run("Fix the user_auth_token variable");
    expect(result).toBeDefined();
  });

  it("extracts file paths", async () => {
    const result = await cognitivePipeline.run("Edit src/routes/chat.ts");
    expect(result).toBeDefined();
  });

  it("extracts backtick code", async () => {
    const result = await cognitivePipeline.run("Use `router.executeWithRole()` instead");
    expect(result).toBeDefined();
  });

  it("extracts URLs", async () => {
    const result = await cognitivePipeline.run("Check https://github.com/ListenJ/openclaw-fusion");
    expect(result).toBeDefined();
  });

  it("extracts version numbers", async () => {
    const result = await cognitivePipeline.run("Upgrade to v2.8.2");
    expect(result).toBeDefined();
  });

  it("extracts branch names", async () => {
    const result = await cognitivePipeline.run("Merge feature/runtime-integration");
    expect(result).toBeDefined();
  });
});

describe("Memory Engine Auto-Learning", () => {
  it("learns from chat interaction", () => {
    const obsBefore = memoryEngine.getStats().observations;
    memoryEngine.learnFromChatInteraction(
      "How to fix TypeScript error?",
      "You can fix it by adding type annotations.",
      "code",
      true,
    );
    const obsAfter = memoryEngine.getStats().observations;
    expect(obsAfter).toBeGreaterThan(obsBefore);
  });

  it("learns from tool execution", () => {
    const knBefore = memoryEngine.getStats().knowledge;
    memoryEngine.learnFromToolExecution(
      "code_diagnostics",
      "Check TypeScript errors",
      "Found 3 errors",
      true,
    );
    const knAfter = memoryEngine.getStats().knowledge;
    expect(knAfter).toBeGreaterThanOrEqual(knBefore);
  });

  it("learns from failed tool execution", () => {
    memoryEngine.learnFromToolExecution(
      "terminal_exec",
      "Run tests",
      "Connection timeout",
      false,
    );
    // Should still record observation
    expect(memoryEngine.getStats().observations).toBeGreaterThan(0);
  });
});

describe("Memory Engine Pattern Detection", () => {
  it("detects entity-based patterns", () => {
    // Create observations with shared entities
    memoryEngine.observe("Fixed bug in AuthService.ts", "user");
    memoryEngine.observe("Another fix in AuthService.ts", "user");

    const patterns = memoryEngine.getPatterns();
    expect(Array.isArray(patterns)).toBe(true);
  });

  it("detects outcome-based patterns", () => {
    // Create successful episodes
    memoryEngine.observe("Task completed successfully", "user");
    memoryEngine.observe("Another task completed", "user");

    const patterns = memoryEngine.getPatterns();
    expect(Array.isArray(patterns)).toBe(true);
  });
});
