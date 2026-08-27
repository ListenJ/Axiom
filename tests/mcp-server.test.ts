import { describe, it, expect } from "bun:test";
import { ToolRegistry, type ToolDef } from "../src/mcp/tool-registry.js";

describe("MCP Server", () => {
  describe("ToolRegistry", () => {
    it("should initialize empty registry", () => {
      const registry = new ToolRegistry();
      expect(registry).toBeDefined();
      expect(registry.size).toBe(0);
      expect(registry.getToolNames()).toEqual([]);
      expect(registry.getToolsMeta()).toEqual([]);
    });

    it("should add tools", () => {
      const registry = new ToolRegistry();
      const tool: ToolDef = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: { type: "object" },
        handler: async (args) => ({ result: "ok", args }),
      };

      registry.add(tool);
      expect(registry.size).toBe(1);
      expect(registry.getToolNames()).toContain("test_tool");
    });

    it("should build HTTP handlers", () => {
      const registry = new ToolRegistry();
      const tool: ToolDef = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: { type: "object" },
        handler: async (args) => ({ result: "ok", args }),
      };

      registry.add(tool);
      const handlers = registry.buildHttpHandlers();
      expect(handlers).toHaveProperty("test_tool");
      expect(typeof handlers.test_tool).toBe("function");
    });

    it("should get tools metadata", () => {
      const registry = new ToolRegistry();
      const tools: ToolDef[] = [
        {
          name: "tool_a",
          description: "Tool A",
          inputSchema: { type: "object" },
          handler: async () => ({}),
        },
        {
          name: "tool_b",
          description: "Tool B",
          inputSchema: { type: "object" },
          handler: async () => ({}),
        },
      ];

      for (const tool of tools) {
        registry.add(tool);
      }

      const meta = registry.getToolsMeta();
      expect(meta.length).toBe(2);
      expect(meta[0]).toHaveProperty("name");
      expect(meta[0]).toHaveProperty("description");
      expect(meta.map((m) => m.name)).toContain("tool_a");
      expect(meta.map((m) => m.name)).toContain("tool_b");
    });

    it("should support chaining add calls", () => {
      const registry = new ToolRegistry();
      const result = registry
        .add({
          name: "tool_1",
          description: "Tool 1",
          inputSchema: { type: "object" },
          handler: async () => ({}),
        })
        .add({
          name: "tool_2",
          description: "Tool 2",
          inputSchema: { type: "object" },
          handler: async () => ({}),
        });

      expect(result).toBe(registry);
      expect(registry.size).toBe(2);
    });

    it("should execute tool handlers correctly", async () => {
      const registry = new ToolRegistry();
      const tool: ToolDef = {
        name: "echo",
        description: "Echo tool",
        inputSchema: { type: "object" },
        handler: async (args) => ({ echo: args.message }),
      };

      registry.add(tool);
      const handlers = registry.buildHttpHandlers();
      const result = await handlers.echo({ message: "hello" });

      expect(result).toEqual({ echo: "hello" });
    });

    it("should handle multiple tools", async () => {
      const registry = new ToolRegistry();

      registry.add({
        name: "add",
        description: "Add two numbers",
        inputSchema: { type: "object" },
        handler: async (args) => ({ result: (args.a as number) + (args.b as number) }),
      });

      registry.add({
        name: "multiply",
        description: "Multiply two numbers",
        inputSchema: { type: "object" },
        handler: async (args) => ({ result: (args.a as number) * (args.b as number) }),
      });

      const handlers = registry.buildHttpHandlers();

      const addResult = await handlers.add({ a: 2, b: 3 });
      expect(addResult).toEqual({ result: 5 });

      const multiplyResult = await handlers.multiply({ a: 4, b: 5 });
      expect(multiplyResult).toEqual({ result: 20 });
    });

    it("should handle handler errors", async () => {
      const registry = new ToolRegistry();
      const tool: ToolDef = {
        name: "error_tool",
        description: "Tool that throws",
        inputSchema: { type: "object" },
        handler: async () => {
          throw new Error("Test error");
        },
      };

      registry.add(tool);
      const handlers = registry.buildHttpHandlers();

      // HTTP handlers 应捕获异常并返回结构化错误对象，避免崩溃 HTTP 服务器
      const result = await handlers.error_tool({}) as { error: boolean; message: string };
      expect(result.error).toBe(true);
      expect(result.message).toContain("Test error");
      expect(result.message).toContain("error_tool");
    });

    it("should register tools with MCP server (stdio transport)", () => {
      const registry = new ToolRegistry();
      registry.add({
        name: "stdio_tool",
        description: "Test stdio registration",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true }),
      });

      const registered: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> = [];
      const mockMcp = {
        registerTool(name: string, _opts: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
          registered.push({ name, handler });
        },
      } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

      registry.registerWithMcp(mockMcp);
      expect(registered).toHaveLength(1);
      expect(registered[0].name).toBe("stdio_tool");
    });

    it("should wrap handler errors with isError flag (stdio)", async () => {
      const registry = new ToolRegistry();
      registry.add({
        name: "failing_tool",
        description: "Always fails",
        inputSchema: { type: "object" },
        handler: async () => { throw new Error("Boom"); },
      });

      let capturedHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
      const mockMcp = {
        registerTool(_name: string, _opts: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
          capturedHandler = handler;
        },
      } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

      registry.registerWithMcp(mockMcp);
      expect(capturedHandler).not.toBeNull();

      const result = await capturedHandler!({}) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text) as { error: boolean; message: string };
      expect(parsed.error).toBe(true);
      expect(parsed.message).toContain("Boom");
      expect(parsed.message).toContain("failing_tool");
    });

    it("should format text output when format=text", async () => {
      const registry = new ToolRegistry();
      registry.add({
        name: "text_tool",
        description: "Returns text",
        inputSchema: { type: "object" },
        handler: async () => "plain string result",
        format: "text" as const,
      });

      let capturedHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
      const mockMcp = {
        registerTool(_name: string, _opts: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
          capturedHandler = handler;
        },
      } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

      registry.registerWithMcp(mockMcp);
      const result = await capturedHandler!({}) as { content: Array<{ type: string; text: string }> };
      expect(result.content[0].text).toBe("plain string result");
    });

    it("should format JSON output by default", async () => {
      const registry = new ToolRegistry();
      registry.add({
        name: "json_tool",
        description: "Returns object",
        inputSchema: { type: "object" },
        handler: async () => ({ key: "value", num: 42 }),
      });

      let capturedHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
      const mockMcp = {
        registerTool(_name: string, _opts: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) {
          capturedHandler = handler;
        },
      } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

      registry.registerWithMcp(mockMcp);
      const result = await capturedHandler!({}) as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text) as { key: string; num: number };
      expect(parsed.key).toBe("value");
      expect(parsed.num).toBe(42);
    });
  });

  describe("Tool Integration", () => {
    it("should have filesystem tools available", async () => {
      const { readFile, writeFile, listDirectory, deleteFile } = await import("../src/mcp/tools/filesystem.js");

      expect(typeof readFile).toBe("function");
      expect(typeof writeFile).toBe("function");
      expect(typeof listDirectory).toBe("function");
      expect(typeof deleteFile).toBe("function");
    });

    it("should have terminal tools available", async () => {
      const { executeCommand, listProcesses, getSystemInfo } = await import("../src/mcp/tools/terminal.js");

      expect(typeof executeCommand).toBe("function");
      expect(typeof listProcesses).toBe("function");
      expect(typeof getSystemInfo).toBe("function");
    });

    it("should have git tools available", async () => {
      const { gitStatus, gitDiff, gitLog, gitBranch } = await import("../src/mcp/tools/git.js");

      expect(typeof gitStatus).toBe("function");
      expect(typeof gitDiff).toBe("function");
      expect(typeof gitLog).toBe("function");
      expect(typeof gitBranch).toBe("function");
    });

    it("should get system info", async () => {
      const { getSystemInfo } = await import("../src/mcp/tools/terminal.js");
      const info = getSystemInfo();

      expect(info).toHaveProperty("platform");
      expect(info).toHaveProperty("arch");
      expect(info).toHaveProperty("nodeVersion");
      expect(info).toHaveProperty("cpus");
      expect(info).toHaveProperty("totalMemory");
      expect(info).toHaveProperty("freeMemory");
      expect(info).toHaveProperty("cwd");

      expect(typeof info.platform).toBe("string");
      expect(typeof info.cpus).toBe("number");
      expect(info.cpus).toBeGreaterThan(0);
    });
  });
});
