/**
 * 工具管道 v3 测试 — 缓存优先 + 非模型操作不消耗 token
 */
import { describe, it, expect } from "bun:test";

describe("Tools v3", () => {
  it("readTool: consumesModelToken=false", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    expect(readTool.consumesModelToken).toBeFalse();
  });

  it("writeTool: consumesModelToken=false", async () => {
    const { writeTool } = await import("../src/tools/write-tool.js");
    expect(writeTool.consumesModelToken).toBeFalse();
  });

  it("queryTool: consumesModelToken=false", async () => {
    const { queryTool } = await import("../src/tools/query-tool.js");
    expect(queryTool.consumesModelToken).toBeFalse();
  });

  it("管道: 工具执行不消耗 model token", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { readTool } = await import("../src/tools/read-tool.js");

    const ctx = createToolContext("no-token-test");
    const result = await runPipeline([
      { tool: readTool, input: { source: "file" as const, path: "./package.json" } },
    ], ctx);

    expect(result.modelTokensUsed).toBe(0);
    expect(ctx.modelCalled).toBeFalse();
  }, 15000);

  it("归一化: 相同语义产生相似 cache key", async () => {
    const { normalizeQuery } = await import("../src/tools/types.js");
    const q1 = normalizeQuery("What is the capital of France?");
    const q2 = normalizeQuery("CAPITAL OF FRANCE");
    const q3 = normalizeQuery("france capital");
    expect(q1).toBe(q2); // 去掉 stop words + sort
    expect(q2).toBe(q3); // 排序后相同
    // 不同语义的查询应有不同 key
    const q4 = normalizeQuery("What is the weather in Paris?");
    expect(q1).not.toBe(q4);
  });

  it("缓存优先路由: 相同意图两次调用命中缓存", async () => {
    const { cacheFirstRoute, writeCache } = await import("../src/services/cache-router.js");
    const { getCacheStats } = await import("../src/tools/types.js");

    // 第一次调用 → 未命中 (返回 null 因为没数据)
    const result1 = await cacheFirstRoute("What is Rust?", "question", { enableKG: false });
    expect(result1).toBeNull();

    // 模拟 LLM 写入缓存
    writeCache("What is Rust?", "question", "Rust is a systems programming language.");

    // 第二次调用 → 命中缓存
    const result2 = await cacheFirstRoute("what is rust?", "question", { enableKG: false });
    expect(result2).not.toBeNull();
    expect(result2!.fromCache).toBeTrue();
    expect(result2!.answer).toContain("Rust");
  });

  it("统计: 缓存命中率可观测", async () => {
    const { getCacheStats, recordCacheHit, recordCacheMiss } = await import("../src/tools/types.js");
    const before = getCacheStats();
    recordCacheHit();
    recordCacheHit();
    recordCacheMiss();
    const after = getCacheStats();
    expect(after.hits).toBe(before.hits + 2);
    expect(after.misses).toBe(before.misses + 1);
  });

  it("文件 read/write: 真实文件操作", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");

    const ctx = createToolContext("file-test");
    const testDir = "./.tmp-tool-v3";
    const testFile = `${testDir}/hello.txt`;

    const wResult = await runPipeline([
      { tool: writeTool, input: { target: "file" as const, path: testFile, content: "Hello v3!" } },
    ], ctx);
    expect(wResult.modelTokensUsed).toBe(0);
    expect(wResult.error).toBeUndefined();

    const rResult = await runPipeline([
      { tool: readTool, input: { source: "file" as const, path: testFile } },
    ], ctx);
    expect(rResult.modelTokensUsed).toBe(0);
    expect((rResult.stepResults[0] as any).content).toContain("Hello v3!");

    const fs = await import("fs/promises");
    await fs.rm(testDir, { recursive: true, force: true });
  });
});
