/**
 * Real API End-to-End Test
 *
 * Tests the CognitivePipeline + LLM degradation chain with real API endpoints.
 * Uses OfoxAI (GLM-4-9B) as main LLM and DeepSeek as cloud fallback.
 */

const testConfig = {
  // OfoxAI — GLM-4-9B (free tier)
  mainLLM: {
    baseUrl: "https://api.ofox.ai/v1",
    model: "z-ai/glm-4.7-flash:free",
    temperature: 0,
    topK: 1,
    seed: 42,
    timeout: 30000,
  },
  // DeepSeek — cloud fallback
  cloudFallback: {
    baseUrl: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    model: "deepseek-chat",
  },
  dbPath: ":memory:",
};

async function main() {
  console.log("[Test] Starting DREngine with OfoxAI GLM-4-9B...\n");

  const { DREngine } = await import("../src/dre/engine.js");
  const { CognitivePipeline } = await import("../src/dre/pipeline/cognitive-pipeline.js");

  const engine = new DREngine(testConfig);
  await engine.waitForReady();

  const pipeline = new CognitivePipeline(engine);

  // ── Test 1: deterministric classification ──
  console.log("─── Test 1: Deterministic classify ───");
  const result1 = await pipeline.run("帮我分析这个项目的架构，找出性能瓶颈");
  console.log("  Input:", result1.input);
  console.log("  Trace steps:", result1.trace.length);
  console.log("  Confidence:", result1.confidence.toFixed(2));
  console.log("  Has gaps:", result1.hasGaps);
  console.log("  Constraint passed:", result1.constraintPassed);
  console.log("  Recommended action:", result1.recommendedAction ? result1.recommendedAction.slice(0, 60) : "none");
  console.log("  Duration:", result1.totalDurationMs, "ms\n");

  // ── Test 2: runWithLLM (GLM-4-9B via OfoxAI) ──
  console.log("─── Test 2: runWithLLM (OfoxAI GLM-4-9B) ───");
  try {
    const result2 = await pipeline.runWithLLM("请简要说明 JWT 和 Session 的区别");
    console.log("  Input:", result2.input);
    console.log("  Fallback level:", result2.fallbackLevel);
    console.log("  Conclusion:", result2.conclusion ? result2.conclusion.slice(0, 150) : "none");
    console.log("  Confidence:", result2.confidence.toFixed(2));
    console.log("  Duration:", result2.totalDurationMs, "ms\n");
  } catch (err) {
    console.log("  LLM call failed (expected if no API reachable):", (err as Error).message, "\n");
  }

  // ── Test 3: Persona switch ──
  console.log("─── Test 3: Persona switch ───");
  engine.switchPersona("audit", "testing real API");
  const persona = engine.persona.getCurrent();
  console.log("  Mode:", persona.config.mode);
  console.log("  Name:", persona.config.name);
  console.log("  Allow write:", persona.config.allowWrite);
  console.log("  Temperature:", persona.config.temperature);
  engine.switchPersona("general");
  console.log("  Switched back to:", engine.getCurrentPersona(), "\n");

  // ── Test 4: DataUnifier ──
  console.log("─── Test 4: DataUnifier write + search ───");
  const { atom } = engine.data.write({
    content: "JWT 令牌应在 1 小时后过期",
    kind: "fact",
    domain: "security",
    paradigm: "rule",
    sourceType: "test",
  });
  console.log("  Atom created:", atom.id);
  const searchResult = engine.data.search("JWT");
  console.log("  Search results (atoms):", searchResult.atoms.length);
  console.log("  Search results (knowledge):", searchResult.knowledgeNodes.length);

  // ── Test 5: Cognitive state ──
  console.log("\n─── Test 5: Cognitive state ───");
  const state = engine.getCognitiveState();
  console.log("  Persona:", state.persona.mode, "/", state.persona.name);
  console.log("  Consciousness:", state.consciousness.workingMemorySize, "working,", state.consciousness.episodicMemorySize, "episodic");
  console.log("  Reasoning:", state.reasoning.totalNodes, "nodes,", state.reasoning.gaps, "gaps");
  console.log("  Constraints:", state.constraints.total, "total");
  console.log("  Goals:", state.goals.length);
  console.log("  Beliefs:", state.beliefs.length);
  console.log("  Hypotheses:", state.hypotheses.length);
  console.log("  Resource:", state.resource.availableMemory, "MB, canRunLocal:", state.resource.canRunLocal);

  await engine.close();
  console.log("\n[Test] All tests completed.");
}

main().catch(console.error);
