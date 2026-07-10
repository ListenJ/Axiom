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
    const { detectLoop } = require("../src/tools/types.js");
    let iter = 0;

    const avg = bench("detectLoop (no collision)", () => {
      for (let i = 0; i < 100; i++) detectLoop(`tool-${iter}-${i}`, `input-${i}`);
      iter++;
    }, 500);
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

  it("[perf] Cache.getOrSet 1万次", async () => {
    const { Cache } = require("../src/utils/cache.js");
    const cache = new Cache({ maxSize: 200, defaultTtlMs: 60000, redis: false, persistent: false });
    for (let i = 0; i < 100; i++) cache.set(`k-${i}`, `v-${i}`);
    let counter = 0;
    const avg = await benchAsync("cache.getOrSet", async () => {
      for (let i = 0; i < 100; i++) {
        await cache.getOrSet(`k-${(counter++) % 150}`, async () => `v`, 60000);
      }
    }, 100);
    console.log(`  cache.getOrSet ×10k: ${avg.toFixed(4)}ms/iter (${(avg / 100).toFixed(4)}ms/op)`);
    cache.destroy();
  });

  it("[perf] Cache.evictLRU 1000次", () => {
    const { Cache } = require("../src/utils/cache.js");
    const cache = new Cache({ maxSize: 10, defaultTtlMs: 60000, redis: false, persistent: false });
    for (let i = 0; i < 10; i++) cache.set(`k-${i}`, `v-${i}`);
    let idx = 0;
    const avg = bench("cache.evictLRU", () => {
      cache.set(`ev-${idx++}`, `v`);
    }, 1000);
    console.log(`  cache.evictLRU ×1k: ${avg.toFixed(4)}ms/iter`);
    cache.destroy();
  });

  it("[perf] ThompsonRouter.route 1万次", async () => {
    const { ThompsonRouter } = require("../src/router/thompson-router.js");
    const router = new ThompsonRouter({
      arms: [
        { id: "fast", model: "gpt-3.5", provider: "openai", alpha: 10, beta: 2 },
        { id: "cheap", model: "claude-haiku", provider: "anthropic", alpha: 5, beta: 5 },
        { id: "smart", model: "gpt-4", provider: "openai", alpha: 20, beta: 3 },
      ],
      minSamples: 10, decayFactor: 0.95, inMemory: true,
    });
    const ctx = { taskType: "qa", inputLength: 100 };
    const avg = await benchAsync("thompsonRouter.route", async () => {
      for (let i = 0; i < 100; i++) await router.route(ctx);
    }, 100);
    console.log(`  thompsonRouter.route ×10k: ${avg.toFixed(4)}ms/iter (${(avg / 100).toFixed(4)}ms/op)`);
  });

  it("[perf] ThompsonRouter.reportFeedback 1万次", () => {
    const { ThompsonRouter } = require("../src/router/thompson-router.js");
    const router = new ThompsonRouter({
      arms: [
        { id: "fast", model: "gpt-3.5", provider: "openai", alpha: 1, beta: 1 },
        { id: "cheap", model: "claude-haiku", provider: "anthropic", alpha: 1, beta: 1 },
      ],
      minSamples: 10, decayFactor: 0.95, inMemory: true,
    });
    const avg = bench("thompsonRouter.reportFeedback", () => {
      for (let i = 0; i < 100; i++) router.reportFeedback(i % 2 === 0 ? "fast" : "cheap", i % 3 !== 0);
    }, 100);
    console.log(`  thompsonRouter.reportFeedback ×10k: ${avg.toFixed(4)}ms/iter (${(avg / 100).toFixed(4)}ms/op)`);
  });

  it("[perf] ConstraintSolver.check (RESOURCE_CONSTRAINTS) 1万次", () => {
    const { ConstraintSolver, RESOURCE_CONSTRAINTS } = require("../src/dre/constraint/solver.js");
    const s = new ConstraintSolver();
    s.registerAll(RESOURCE_CONSTRAINTS);
    s.registerAll([
      { id: "add-mem-min", dimension: "physical", type: "min_value", name: "", description: "", subject: "available_memory_mb", params: { min: 256 }, priority: 2, enabled: true, createdAt: 0 },
      { id: "add-mem-max", dimension: "physical", type: "max_value", name: "", description: "", subject: "available_memory_mb", params: { max: 32000 }, priority: 1, enabled: true, createdAt: 0 },
      { id: "policy-env", dimension: "policy", type: "not_equals", name: "", description: "", subject: "env", target: "prod", priority: 10, enabled: true, createdAt: 0 },
      { id: "field-role", dimension: "field_match", type: "equals", name: "", description: "", subject: "role", target: "admin", priority: 5, enabled: true, createdAt: 0 },
      { id: "logical-dep", dimension: "logical", type: "requires", name: "", description: "", subject: "deploy", target: "docker", priority: 7, enabled: true, createdAt: 0 },
      { id: "temporal-hours", dimension: "temporal", type: "between", name: "", description: "", subject: "deploy", params: { min: 6, max: 22 }, priority: 3, enabled: true, createdAt: 0 },
      { id: "field-category", dimension: "field_match", type: "in_set", name: "", description: "", subject: "category", params: { values: ["web", "api", "worker"] }, priority: 2, enabled: true, createdAt: 0 },
      { id: "policy-action", dimension: "policy", type: "in_set", name: "", description: "", subject: "action", params: { values: ["deploy", "rollback", "scale"] }, priority: 8, enabled: true, createdAt: 0 },
    ]);
    const avg = bench("constraintSolver.check (RESOURCE_CONSTRAINTS)", () => {
      s.check("deploy", { available_memory_mb: 2000, env: "staging", role: "admin", has_docker: true, category: "web", action: "deploy" });
    }, 10000);
    console.log(`  constraintSolver.check (10约束) ×10k: ${avg.toFixed(4)}ms/iter`);
  });

  it("[perf] MockVaultManager.search 1万次", () => {
    const { MockVaultManager } = require("./helpers/vault-mock.js");
    const vm = new MockVaultManager();
    for (let i = 0; i < 100; i++) {
      vm.notes.set(`note-${i}.md`, {
        path: `note-${i}.md`, title: `Note ${i}`,
        content: `This is the content of note ${i}. It contains searchable text like apple, banana, cherry.`,
        frontmatter: {}, tags: [`tag-${i % 10}`], wikiLinks: [], backlinks: [],
        wordCount: 20, modifiedAt: Date.now(),
      });
    }
    const avg = bench("mockVault.search", () => {
      for (let i = 0; i < 100; i++) vm.search(`search-term-${i % 10}`);
    }, 100);
    console.log(`  mockVault.search ×10k: ${avg.toFixed(4)}ms/iter (${(avg / 100).toFixed(4)}ms/op)`);
  });

  it("[perf] MockVaultManager.callCount 1万次", () => {
    const { MockVaultManager } = require("./helpers/vault-mock.js");
    const vm = new MockVaultManager();
    for (let i = 0; i < 20; i++) { vm.search(`q-${i}`); vm.readNote(`note-${i}.md`); }
    const avg = bench("mockVault.callCount", () => {
      for (let i = 0; i < 100; i++) vm.callCount(i % 2 === 0 ? "search" : "readNote");
    }, 100);
    console.log(`  mockVault.callCount ×10k: ${avg.toFixed(4)}ms/iter (${(avg / 100).toFixed(4)}ms/op)`);
  });

  it("[perf] ConfigCenter get/getString/getNumber 混合读取 1万次", () => {
    const { ConfigCenter } = require("../src/core/config-center.js");
    const cc = new ConfigCenter(":memory:");
    const avg = bench("configCenter.mixedReads", () => {
      for (let i = 0; i < 100; i++) {
        cc.get("gateway.port");
        cc.getString("gateway.bind");
        cc.getNumber("crawler.max_concurrent");
        cc.get("model.siliconflow_key");
        cc.getString("memory.vault_path");
        cc.getNumber("security.max_body_size");
        cc.get("advanced.codegraph_auto_index");
        cc.getString("gateway.auth_token");
      }
    }, 125);
    console.log(`  configCenter.mixedReads ×10k: ${avg.toFixed(4)}ms/iter (${(avg / 800).toFixed(4)}ms/op)`);
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
