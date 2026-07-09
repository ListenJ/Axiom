/**
 * 真实项目端到端压力测试 — 模拟长时间任务 + 进度反馈 + Token 控制
 */
import { describe, it, expect } from "bun:test";

describe("Tools 真实负载", () => {
  it("long running: 进度回调工作正常", async () => {
    const { createToolContext, emitProgress, consumeTokens, estimateTokens } = await import("../src/tools/types.js");
    const events: string[] = [];
    const ctx = createToolContext("progress-test", 100 * 1024 * 1024, 30000, 500000, (ev) => {
      events.push(`[${ev.stage}] ${ev.toolName}: ${ev.message.slice(0, 80)}`);
    });

    // 模拟长任务: 5 步管道
    for (let i = 1; i <= 5; i++) {
      emitProgress(ctx, "execute", "queryTool", `Searching batch ${i}/5...`, (i / 5) * 100);
      await new Promise(r => setTimeout(r, 20));
      consumeTokens(ctx, `step ${i} result data with some tokens usage `.repeat(10));
    }

    emitProgress(ctx, "complete", "pipeline", "All done", 100);
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(events.some(e => e.includes("Searching batch"))).toBeTrue();
    expect(events.some(e => e.includes("All done"))).toBeTrue();
    expect(ctx.tokenBudget.usedTokens).toBeGreaterThan(0);
    expect(ctx.tokenBudget.usedTokens).toBeLessThanOrEqual(ctx.tokenBudget.maxTokens);
  });

  it("Token 预算: 超出后自动终止", async () => {
    const { createToolContext, consumeTokens } = await import("../src/tools/types.js");
    const ctx = createToolContext("token-limit", 50 * 1024 * 1024, 5000, 100);

    // 写入 50 tokens (预算 100)
    expect(consumeTokens(ctx, "a".repeat(200))).toBeTrue();  // ~50 tokens
    expect(ctx.aborted).toBeFalse();

    // 再写入 200 tokens → 超出 (50+200 > 100)
    expect(consumeTokens(ctx, "a".repeat(800))).toBeFalse();  // ~200 tokens
    expect(ctx.aborted).toBeTrue();
  });

  it("循环检测: 同一输入 6 次后触发", async () => {
    const { detectLoop, clearLoopCache } = await import("../src/tools/types.js");
    clearLoopCache();

    for (let i = 0; i < 5; i++) {
      expect(detectLoop("readTool", "same input data")).toBeFalse();
    }
    // 第 6 次 → 触发循环检测
    expect(detectLoop("readTool", "same input data")).toBeTrue();
  });

  it("管道深度超限", async () => {
    const { createToolContext, consumeTokens, emitProgress } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { queryTool } = await import("../src/tools/query-tool.js");

    const ctx = createToolContext("depth-test", 50 * 1024 * 1024, 5000, 50000);
    ctx.maxDepth = 3; // 仅允许 3 层

    const steps = Array.from({ length: 10 }, (_, i) => ({
      tool: queryTool,
      input: { query: `test-${i}`, scope: "local" as const, maxResults: 1 },
    }));

    const result = await runPipeline(steps, ctx);
    expect(result.aborted).toBeTrue();
    expect(result.error).toContain("Max pipeline depth exceeded");
  });

  it("进度事件可观测", async () => {
    const { createToolContext, emitProgress } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { readTool } = await import("../src/tools/read-tool.js");

    const progress: string[] = [];
    const ctx = createToolContext("progress-observe", 50 * 1024 * 1024, 5000, 50000, (ev) => {
      progress.push(`${ev.stage}:${ev.toolName}:${ev.pct ?? -1}`);
    });

    // 故意传一个不存在的文件来触发 error 回调
    const result = await runPipeline([
      { tool: readTool, input: { source: "file" as const, path: "/nonexistent/test-file.txt" } },
    ], ctx);

    expect(result.error).toBeDefined();
    // 验证进度事件链
    expect(progress.some(p => p.startsWith("validate"))).toBeTrue();
  });
});

describe("Tools 真实文件操作", () => {
  const testDir = "./.tmp-tool-test";

  it("write → read 文件往返", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");

    const ctx = createToolContext("file-roundtrip");

    // 写入
    const wResult = await runPipeline([
      { tool: writeTool, input: { target: "file" as const, path: `${testDir}/hello.txt`, content: "Hello Tools!" } },
    ], ctx);
    expect(wResult.error).toBeUndefined();

    // 读取
    const rResult = await runPipeline([
      { tool: readTool, input: { source: "file" as const, path: `${testDir}/hello.txt` } },
    ], ctx);
    expect(rResult.error).toBeUndefined();
    expect((rResult.stepResults[0] as any).content).toContain("Hello Tools!");

    // 清理
    const fs = await import("fs/promises");
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("超大文件分片读取", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");

    const ctx = createToolContext("huge-file");

    // 写一个 5MB 文件
    const bigContent = "x".repeat(5_000_000);
    await runPipeline([
      { tool: writeTool, input: { target: "file" as const, path: `${testDir}/big.txt`, content: bigContent } },
    ], ctx);

    // 分片读取前 100 字节
    const rResult = await runPipeline([
      { tool: readTool, input: { source: "file" as const, path: `${testDir}/big.txt`, offset: 0, limit: 100 } },
    ], ctx);
    expect((rResult.stepResults[0] as any).content.length).toBe(100);

    const fs = await import("fs/promises");
    await fs.rm(testDir, { recursive: true, force: true });
  });
});
