/**
 * 性能基准测试 — 测量各模块热路径
 * bun test tests/perf-benchmark.test.ts --timeout 30000
 */
import { describe, it, expect } from "bun:test";

function bench(name: string, fn: () => void | Promise<void>, iterations = 1000): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") throw new Error("bench fn must be sync");
  }
  return (performance.now() - start) / iterations;
}

async function benchAsync(name: string, fn: () => Promise<void>, iterations = 100): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  return (performance.now() - start) / iterations;
}

describe("性能基准", () => {
  it("[perf] normalizeQuery 性能 1万次", () => {
    const { normalizeQuery } = require("../src/tools/types.js");
    const queries = [
      "What is the capital of France?",
      "你好世界，这是一个测试",
      "How to implement a binary search tree in TypeScript?",
      "The quick brown fox jumps over the lazy dog",
      "Python vs JavaScript for web development in 2026",
      "",
      "a",
      "!!! ??? ...",
      "Capital of France vs capital of Germany which is larger?",
    ];
    const avg = bench("normalizeQuery", () => {
      for (const q of queries) normalizeQuery(q);
    }, 10000);
    console.log(`  normalizeQuery ×10k: ${avg.toFixed(4)}ms/iter`);

    // 验证去重
    const r1 = normalizeQuery("capital of France");
    const r2 = normalizeQuery("france capital");
    expect(r1).toBe(r2);
  });

  it("[perf] constrainsSolver 热路径 1万次", () => {
    const { ConstraintSolver } = require("../src/dre/constraint/solver.js");
    const s = new ConstraintSolver();
    s.register({
      id: "m1", dimension: "physical", type: "min_value",
      name: "", description: "", subject: "mem",
      params: { min: 500 }, priority: 1, enabled: true,
      createdAt: 0,
    });
    s.register({
      id: "m2", dimension: "physical", type: "max_value",
      name: "", description: "", subject: "mem",
      params: { max: 8000 }, priority: 1, enabled: true,
      createdAt: 0,
    });
    s.register({
      id: "p1", dimension: "policy", type: "not_equals",
      name: "", description: "", subject: "env",
      target: "prod", priority: 10, enabled: true,
      createdAt: 0,
    });
    s.register({
      id: "p2", dimension: "field_match", type: "equals",
      name: "", description: "", subject: "role",
      target: "admin", priority: 5, enabled: true,
      createdAt: 0,
    });

    const avg = bench("constraintSolver.check", () => {
      s.check("deploy", { mem: 2000, env: "staging", role: "admin" });
    }, 10000);
    console.log(`  constraintSolver.check ×10k: ${avg.toFixed(4)}ms/iter`);
  });

  it("[perf] EventBus publish 1万次", () => {
    const { eventBus } = require("../src/dre/runtime/event-bus.js");
    // 注册一些处理器
    const subs: string[] = [];
    for (let i = 0; i < 5; i++) {
      subs.push(eventBus.subscribe(`perf.test.${i}`, () => { /* noop */ }));
    }

    const avg = bench("eventBus.publish", () => {
      eventBus.publish({ type: "perf.test.0", source: "perf", data: {}, priority: "normal" });
    }, 10000);
    console.log(`  eventBus.publish ×10k: ${avg.toFixed(4)}ms/iter`);

    // cleanup
    for (const id of subs) eventBus.unsubscribe(id);
  });

  it("[perf] WorldState get/set 1万次", () => {
    const { worldState } = require("../src/dre/runtime/world-state.js");

    const avgSet = bench("worldState.set", () => {
      for (let i = 0; i < 100; i++) worldState.set(`perf.key.${i}`, { value: i });
    }, 100);
    console.log(`  worldState.set ×100/iter: ${(avgSet / 100).toFixed(4)}ms/op`);

    const avgGet = bench("worldState.get", () => {
      for (let i = 0; i < 100; i++) worldState.get(`perf.key.${i}`);
    }, 100);
    console.log(`  worldState.get ×100/iter: ${(avgGet / 100).toFixed(4)}ms/op`);
  });

  it("[perf] detectLoop 热路径 (干净缓存)", () => {
    const { detectLoop, clearLoopCache } = require("../src/tools/types.js");

    const avg = bench("detectLoop (no collision)", () => {
      for (let i = 0; i < 100; i++) detectLoop(`tool-${i}`, `input-${i}`);
    }, 5000);
    console.log(`  detectLoop (不同输入) ×100/iter: ${(avg / 100).toFixed(4)}ms/op`);
  });

  it("[perf] VIBCompressor getRetentionScore 1万次", () => {
    const { VIBCompressor } = require("../src/memory/vib-compressor.js");
    const vib = new VIBCompressor();
    const mem = { id: "1", content: "test", score: 0.8, timestamp: Date.now(), accessCount: 5, lastAccessed: Date.now(), metadata: {} };

    const avg = bench("vibCompressor.getRetentionScore", () => {
      vib.getRetentionScore(mem);
    }, 10000);
    console.log(`  getRetentionScore ×10k: ${avg.toFixed(4)}ms/iter`);
  });

  it("[perf] MemoryGate shouldWrite 1万次", () => {
    const { MemoryGate } = require("../src/memory/memory-gate.js");
    const gate = new MemoryGate({
      maxWritesPerHour: 1000,
      similarityThreshold: 0.85,
      requireHighConfidence: true,
      minResponseLength: 10,
      maxResponseLength: 50000,
    });

    const avg = bench("memoryGate.shouldWrite", () => {
      gate.shouldWrite(
        "Paris is the capital of France.",
        "what is the capital of france",
        { hasErrors: false, hasCode: false, taskType: "qa", isFirstTurn: false, responseLength: 32, confidence: 0.9, tokenCount: 10 },
      );
    }, 10000);
    console.log(`  shouldWrite ×10k: ${avg.toFixed(4)}ms/iter`);
  });

  it("[perf] ReasoningRuntime.run 快速路径 50次", async () => {
    const { getReasoningRuntime } = await import("../src/dre/runtime/reasoner/reasoning-runtime.js");
    const r = getReasoningRuntime();

    const avg = await benchAsync("reasoningRuntime.run", async () => {
      await r.run("quick test");
    }, 50);
    console.log(`  reasoningRuntime.run ×50: ${avg.toFixed(2)}ms/iter`);
  });

  it("[perf] 模块导入时间", async () => {
    const modules = [
      "../src/tools/types.js",
      "../src/tools/pipeline.js",
      "../src/tools/read-tool.js",
      "../src/tools/write-tool.js",
      "../src/tools/query-tool.js",
      "../src/services/cache-router.js",
      "../src/services/knowledge.js",
      "../src/memory/vib-compressor.js",
      "../src/memory/memory-gate.js",
      "../src/dre/runtime/reasoner/reasoning-runtime.js",
      "../src/dre/constraint/solver.js",
      "../src/dre/runtime/event-bus.js",
      "../src/dre/runtime/world-state.js",
    ];

    for (const mod of modules) {
      const start = performance.now();
      await import(mod);
      const elapsed = performance.now() - start;
      console.log(`  import ${mod.replace("../src/", "")}: ${elapsed.toFixed(2)}ms`);
    }
  });
});
