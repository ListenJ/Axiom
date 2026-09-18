/**
 * 工具适配器 + MCP 集成端到端测试
 */
import { describe, it, expect } from "bun:test";

describe("adaptTool 端到端", () => {
  it("readTool 适配为 ToolDef", async () => {
    const { adaptTool } = await import("../src/mcp/adapt-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const def = adaptTool(readTool);
    expect(def.name).toBe("read");
    expect(def.description).toBeString();
    expect(typeof def.handler).toBe("function");
    // handler 执行会做文件读取，这里只验证结构
    expect(def.tags).toContain("pipeline");
  });

  it("handler 拒绝空参数（validate 拦截）", async () => {
    const { adaptTool } = await import("../src/mcp/adapt-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const def = adaptTool(readTool);
    await expect(def.handler({})).rejects.toThrow("Validation failed");
  });

  it("handler 拒绝空 source", async () => {
    const { adaptTool } = await import("../src/mcp/adapt-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const def = adaptTool(readTool);
    await expect(def.handler({ source: "", path: "/x" })).rejects.toThrow("Validation failed");
  });

  it("writeTool 适配并验证", async () => {
    const { adaptTool } = await import("../src/mcp/adapt-tool.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const def = adaptTool(writeTool);
    expect(def.name).toBe("write");
    await expect(def.handler({ target: "invalid" })).rejects.toThrow("Validation failed");
  });

  it("queryTool 适配并拒绝空查询", async () => {
    const { adaptTool } = await import("../src/mcp/adapt-tool.js");
    const { queryTool } = await import("../src/tools/query-tool.js");
    const def = adaptTool(queryTool);
    expect(def.name).toBe("query");
    await expect(def.handler({ query: "" })).rejects.toThrow("Validation failed");
  });

  it("adaptTools 批量适配", async () => {
    const { adaptTools } = await import("../src/mcp/adapt-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { queryTool } = await import("../src/tools/query-tool.js");
    const defs = adaptTools([readTool, writeTool, queryTool]);
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.name).sort()).toEqual(["query", "read", "write"]);
  });

  it("覆盖参数 tags/format", async () => {
    const { adaptTool } = await import("../src/mcp/adapt-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const def = adaptTool(readTool, { tags: ["test", "pipeline"], format: "text" });
    expect(def.tags).toEqual(["test", "pipeline"]);
    expect(def.format).toBe("text");
  });
});

describe("MCP ToolRegistry 集成", () => {
  it("注册适配工具后可通过 getToolsMeta 查询", async () => {
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const { adaptTools } = await import("../src/mcp/adapt-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { queryTool } = await import("../src/tools/query-tool.js");
    const registry = new ToolRegistry();
    for (const td of adaptTools([readTool, writeTool, queryTool])) registry.add(td);
    const meta = registry.getToolsMeta();
    expect(meta.some((m) => m.name === "read")).toBeTrue();
    expect(meta.some((m) => m.name === "write")).toBeTrue();
    expect(meta.some((m) => m.name === "query")).toBeTrue();
    expect(registry.size).toBe(3);
  });

  it("HttpHandlers 映射正确", async () => {
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const { adaptTools } = await import("../src/mcp/adapt-tool.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { queryTool } = await import("../src/tools/query-tool.js");
    const registry = new ToolRegistry();
    for (const td of adaptTools([readTool, writeTool, queryTool])) registry.add(td);
    const handlers = registry.buildHttpHandlers();
    expect(handlers).toHaveProperty("read");
    expect(handlers).toHaveProperty("write");
    expect(handlers).toHaveProperty("query");
  });
});
