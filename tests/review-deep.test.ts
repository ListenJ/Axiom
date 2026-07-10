/**
 * 深度代码 Review + 极端边界测试
 */
import { describe, it, expect } from "bun:test";

describe("[Review] Tools 接口完整性", () => {
  it("所有工具实现 Tool 接口", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { queryTool } = await import("../src/tools/query-tool.js");
    const tools = [readTool, writeTool, queryTool];
    for (const t of tools) {
      expect(t.name).toBeString();
      expect(t.description).toBeString();
      expect(t.consumesModelToken).toBeBoolean();
      expect(t.validate).toBeFunction();
      expect(t.execute).toBeFunction();
    }
  });

  it("readTool 验证: 无效输入被拒绝", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    expect(readTool.validate!({ source: "" as any, path: "" })).toBeString();
    expect(readTool.validate!({ source: "file" as const, path: "" })).toBeString();
    expect(readTool.validate!({ source: "file" as const, path: "/ok" })).toBeNull();
  });

  it("writeTool 验证: 无效输入被拒绝", async () => {
    const { writeTool } = await import("../src/tools/write-tool.js");
    expect(writeTool.validate!({ target: "" as any, path: "", content: "" })).toBeString();
    expect(writeTool.validate!({ target: "file" as const, path: "", content: "" })).toBeString();
    expect(writeTool.validate!({ target: "file" as const, path: "/ok", content: "x" })).toBeNull();
  });

  it("queryTool 验证: 空查询被拒绝", async () => {
    const { queryTool } = await import("../src/tools/query-tool.js");
    expect(queryTool.validate!({ query: "" })).toBeString();
    expect(queryTool.validate!({ query: "test" })).toBeNull();
  });
});

describe("[Review] readTool 边缘", () => {
  it("空 source 字符串被拒绝", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    expect(readTool.validate!({ source: "" as any, path: "/ok" })).toBeString();
  });

  it("无效 source 枚举被拒绝", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    expect(readTool.validate!({ source: "invalid" as any, path: "/ok" })).toBeString();
  });

  it("缺失 path 被拒绝", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    expect(readTool.validate!({ source: "file" as const } as any)).toBeString();
  });
});

describe("[Review] writeTool 边缘", () => {
  it("空 content 字符串被接受", async () => {
    const { writeTool } = await import("../src/tools/write-tool.js");
    expect(writeTool.validate!({ target: "file" as const, path: "/ok", content: "" })).toBeNull();
  });

  it("无效 target 枚举被拒绝", async () => {
    const { writeTool } = await import("../src/tools/write-tool.js");
    expect(writeTool.validate!({ target: "invalid" as any, path: "/ok", content: "x" })).toBeString();
  });

  it("缺失 target + path 被拒绝", async () => {
    const { writeTool } = await import("../src/tools/write-tool.js");
    expect(writeTool.validate!({} as any)).toBeString();
  });
});

describe("[Review] queryTool 边缘", () => {
  it("超长查询被接受", async () => {
    const { queryTool } = await import("../src/tools/query-tool.js");
    expect(queryTool.validate!({ query: "a".repeat(10000) })).toBeNull();
  });

  it("纯空白查询通过 validate", async () => {
    const { queryTool } = await import("../src/tools/query-tool.js");
    expect(queryTool.validate!({ query: "   " })).toBeNull();
  });
});

describe("[Review] Pipeline 边界", () => {
  it("空管道立即返回", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const r = await runPipeline([], createToolContext());
    expect(r.stepResults).toBeEmpty();
    expect(r.error).toBeUndefined();
  });

  it("aborted=true 时跳过所有步骤", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const ctx = createToolContext();
    ctx.aborted = true;
    const r = await runPipeline([
      { tool: readTool, input: { source: "file" as const, path: "/any" } },
    ], ctx);
    expect(r.aborted).toBeTrue();
  });

  it("CPU 超限终止", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const ctx = createToolContext("cpu-test", 50 * 1024 * 1024, 10);
    // 让 startTime 回溯 100ms，使第一次检查就超限
    (ctx as any).startTime = Date.now() - 200;
    const r = await runPipeline([
      { tool: readTool, input: { source: "file" as const, path: "/ok" } },
    ], ctx);
    expect(r.aborted).toBeTrue();
  });

  it("深度超限终止", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const ctx = createToolContext();
    ctx.maxDepth = 0;
    const r = await runPipeline([
      { tool: readTool, input: { source: "file" as const, path: "/ok" } },
    ], ctx);
    expect(r.aborted).toBeTrue();
    expect(r.error).toContain("depth");
  });
});

describe("[Review] normalizeQuery 边界", () => {
  it("空字符串", async () => {
    const { normalizeQuery } = await import("../src/tools/types.js");
    expect(normalizeQuery("")).toBe("");
  });

  it("纯标点", async () => {
    const { normalizeQuery } = await import("../src/tools/types.js");
    expect(normalizeQuery("!!! ??? ...")).toBe("");
  });

  it("纯中文", async () => {
    const { normalizeQuery } = await import("../src/tools/types.js");
    const r = normalizeQuery("你好世界");
    expect(r.length).toBeGreaterThan(0);
  });

  it("混合英文中文", async () => {
    const { normalizeQuery } = await import("../src/tools/types.js");
    const r = normalizeQuery("What is Rust 编程语言?");
    expect(r).toContain("rust");
    expect(r).toContain("编程语言");
  });

  it("去重", async () => {
    const { normalizeQuery } = await import("../src/tools/types.js");
    const r1 = normalizeQuery("capital of France");
    const r2 = normalizeQuery("france capital");
    expect(r1).toBe(r2);
  });

  it("已标准化字符串保持原样", async () => {
    const { normalizeQuery } = await import("../src/tools/types.js");
    expect(normalizeQuery("hello world")).toBe("hello world");
  });

  it("全角字符被正则过滤", async () => {
    const { normalizeQuery } = await import("../src/tools/types.js");
    expect(normalizeQuery("１２３")).toBe("");
    expect(normalizeQuery("Ｈｅｌｌｏ")).toBe("");
  });
});

describe("[Review] detectLoop 边界", () => {
  it("不同输入不触发", async () => {
    const { detectLoop, clearLoopCache } = await import("../src/tools/types.js");
    clearLoopCache();
    for (let i = 0; i < 10; i++) {
      expect(detectLoop("t", `input-${i}`)).toBeFalse();
    }
  });

  it("超时后重置", async () => {
    const { detectLoop, clearLoopCache } = await import("../src/tools/types.js");
    clearLoopCache();
    // 5 calls → no loop
    for (let i = 0; i < 5; i++) expect(detectLoop("t", "same")).toBeFalse();
    // 6th → yes
    expect(detectLoop("t", "same")).toBeTrue();
  });
});

describe("[Review] cacheFirstRoute 边界", () => {
  it("空配置不崩溃", async () => {
    const { cacheFirstRoute } = await import("../src/services/cache-router.js");
    const r = await cacheFirstRoute("", "test", {});
    expect(r).toBeNull();
  });
});
