/**
 * E2E Runtime Integration Tests
 *
 * Tests the ACTUAL runtime end-to-end — real filesystem, real HTTP routing,
 * real MCP tools, real Vault operations. No mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";

function tmpDir(): string {
  const p = join(import.meta.dir, "..", ".tmp-e2e", randomUUID().slice(0, 8));
  mkdirSync(p, { recursive: true });
  return p;
}

function cleanup(p: string) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ok */ }
}

describe("E2E Runtime (real I/O)", () => {
  let dir: string;

  beforeAll(() => { dir = tmpDir(); });
  afterAll(() => cleanup(dir));

  // ══════════════════════════════════════════════════════════════════
  // 1. Vault Real Filesystem
  // ══════════════════════════════════════════════════════════════════
  describe("Vault real filesystem", () => {
    it("writes a note to disk and reads it back", async () => {
      const { getGlobalVault } = await import("../src/memory/vault-manager.js");
      const vault = getGlobalVault();
      const notePath = "00-Meta/e2e-test.md";
      await vault.writeNote(notePath, "# E2E Test\n\nReal filesystem test.", { overwrite: true });
      const read = vault.readNote(notePath);
      expect(read).not.toBeNull();
      expect(read!.content).toContain("E2E Test");
      expect(read!.frontmatter).toBeDefined();
    });

    it("searches for a written note", async () => {
      const { getGlobalVault } = await import("../src/memory/vault-manager.js");
      const vault = getGlobalVault();
      const results = vault.search("E2E Test");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.note.path.includes("e2e-test"))).toBeTrue();
    });

    it("getGlobalVault returns singleton", async () => {
      const { getGlobalVault } = await import("../src/memory/vault-manager.js");
      expect(getGlobalVault()).toBe(getGlobalVault());
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. Real file I/O via Tools
  // ══════════════════════════════════════════════════════════════════
  describe("File I/O via tools", () => {
    it("writeTool writes a file to disk", async () => {
      const { writeTool } = await import("../src/tools/write-tool.js");
      const filePath = join(dir, "e2e-write-test.txt");
      const result = await writeTool.execute({
        payload: { target: "file", path: filePath, content: "hello from e2e" },
        context: { localStore: new Map() } as any,
      });
      expect(result.data).toBeDefined();
      expect(existsSync(filePath)).toBeTrue();
      expect(readFileSync(filePath, "utf-8")).toBe("hello from e2e");
    });

    it("readTool reads a file from disk", async () => {
      const { readTool } = await import("../src/tools/read-tool.js");
      const filePath = join(dir, "e2e-read-test.txt");
      writeFileSync(filePath, "e2e read content", "utf-8");
      const result = await readTool.execute({
        payload: { source: "file", path: filePath },
        context: { localStore: new Map() } as any,
      });
      expect(result.data.content).toContain("e2e read content");
      expect(result.data.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. Tool Pipeline Real Execution
  // ══════════════════════════════════════════════════════════════════
  describe("Tool pipeline real execution", () => {
    it("runPipeline with write then read", async () => {
      const { createToolContext } = await import("../src/tools/types.js");
      const { runPipeline } = await import("../src/tools/pipeline.js");
      const { writeTool } = await import("../src/tools/write-tool.js");
      const { readTool } = await import("../src/tools/read-tool.js");

      const filePath = join(dir, "pipeline-test.txt");
      const ctx = createToolContext(`e2e-pipe-${Date.now()}`);

      const result = await runPipeline([
        { tool: writeTool, input: { target: "file", path: filePath, content: "pipeline content" } },
        { tool: readTool, input: { source: "file", path: filePath } },
      ], ctx);

      expect(result.stepResults.length).toBe(2);
      expect(result.aborted).toBeFalse();
      expect(result.error).toBeUndefined();
    });

    it("pipeline respects CPU budget", async () => {
      const { createToolContext } = await import("../src/tools/types.js");
      const { runPipeline } = await import("../src/tools/pipeline.js");
      const { readTool } = await import("../src/tools/read-tool.js");
      const ctx = createToolContext(`e2e-cpu-${Date.now()}`, 1024, -1);
      const result = await runPipeline([
        { tool: readTool, input: { source: "file", path: join(dir, "x.txt") } },
        { tool: readTool, input: { source: "file", path: join(dir, "y.txt") } },
      ], ctx);
      expect(result.aborted).toBeTrue();
      expect(result.error).toContain("CPU");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 4. MCP Tool Registry Real Execution
  // ══════════════════════════════════════════════════════════════════
  describe("MCP Tool Registry", () => {
    it("ToolRegistry adds and queries tools", async () => {
      const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
      const { z } = await import("zod");
      const reg = new ToolRegistry();
      reg.add({ name: "e2e_test", description: "e2e test tool", inputSchema: { msg: z.string() }, handler: async (args) => ({ echoed: args.msg }) });
      expect(reg.size).toBe(1);
      expect(reg.getToolsMeta()[0].name).toBe("e2e_test");
    });

    it("adaptTool bridges Tool<I,O> to ToolDef", async () => {
      const { adaptTool } = await import("../src/mcp/adapt-tool.js");
      const { readTool } = await import("../src/tools/read-tool.js");
      const td = adaptTool(readTool);
      expect(td.name).toBe("read");
      expect(td.description).toBeString();
      expect(td.handler).toBeFunction();
    });

    it("registered tool handler returns expected shape", async () => {
      const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
      const { z } = await import("zod");
      const reg = new ToolRegistry();
      reg.add({ name: "echo", description: "echo", inputSchema: { input: z.string() }, handler: async (args) => ({ result: args.input }) });
      const handlers = reg.buildHttpHandlers();
      const result = await handlers.echo({ input: "hello" });
      expect(result).toEqual({ result: "hello" });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 5. ConfigCenter Real Configuration
  // ══════════════════════════════════════════════════════════════════
  describe("ConfigCenter real config", () => {
    it("getConfig returns gateway port", () => {
      const { getConfig, resetConfigCenter } = require("../src/core/config-center.js");
      resetConfigCenter();
      const config = getConfig();
      expect(config.gateway.port).toBeGreaterThan(0);
      expect(config.gateway.bind).toBeString();
    });

    it("set and get config value", () => {
      const { getConfigCenter, resetConfigCenter } = require("../src/core/config-center.js");
      resetConfigCenter();
      const cc = getConfigCenter();
      cc.set("gateway.port", 9999, "test", false);
      expect(cc.getNumber("gateway.port")).toBe(9999);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 6. HTTP Router Real Routing
  // ══════════════════════════════════════════════════════════════════
  describe("HttpRouter real routing", () => {
    it("registers and executes routes", async () => {
      const { HttpRouter } = await import("../src/core/http-router.js");
      const router = new HttpRouter({ cacheMaxSize: 0 } as any);
      router.register({ method: "GET", path: "/e2e/hello", handler: async () => new Response("e2e ok") });
      const ctx: any = { url: new URL("http://localhost/e2e/hello"), req: new Request("http://localhost/e2e/hello"), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: Date.now(), baseHeaders: {}, jsonResponse: (d: any, s: number) => new Response(JSON.stringify(d), { status: s }) };
      const res = await router.execute(ctx);
      expect(res).not.toBeNull();
      expect(await res!.text()).toBe("e2e ok");
    });

    it("unknown route returns null", async () => {
      const { HttpRouter } = await import("../src/core/http-router.js");
      const router = new HttpRouter({ cacheMaxSize: 0 } as any);
      router.register({ method: "GET", path: "/known", handler: async () => new Response("ok") });
      const ctx: any = { url: new URL("http://localhost/unknown"), req: new Request("http://localhost/unknown"), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: Date.now(), baseHeaders: {}, jsonResponse: (d: any, s: number) => new Response(JSON.stringify(d), { status: s }) };
      expect(await router.execute(ctx)).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 7. Resilience Real Behavior
  // ══════════════════════════════════════════════════════════════════
  describe("Resilience real behavior", () => {
    it("withRetry retries on failure", async () => {
      const { withRetry } = await import("../src/utils/resilience.js");
      let attempts = 0;
      const result = await withRetry(async () => {
        attempts++;
        if (attempts < 3) throw new Error("temporary");
        return "success";
      }, { maxAttempts: 5, baseDelay: 1 });
      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("withFallback returns fallback on primary failure", async () => {
      const { withFallback } = await import("../src/utils/resilience.js");
      const result = await withFallback(
        async () => { throw new Error("primary failed"); },
        { fallback: "fallback value" },
      );
      expect(result).toBe("fallback value");
    });
  });
});
