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

      expect(async () => {
        await handlers.error_tool({});
      }).toThrow();
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
