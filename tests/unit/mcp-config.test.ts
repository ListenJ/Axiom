import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";
import { connectExternalMcpServers } from "../../src/mcp/client-connector.js";

describe("mcp config", () => {
  test("no sqlite-server.ts reference", () => {
    const yaml = readFileSync("config/mcp-servers.yaml", "utf8");
    expect(yaml).not.toContain("sqlite-server.ts");
  });

  test("filesystem package exists or optional", () => {
    const yaml = readFileSync("config/mcp-servers.yaml", "utf8");
    const hasCorrectPackage = yaml.includes("@modelcontextprotocol/server-filesystem");
    const hasOptional = /filesystem:\s*\n[\s\S]*?optional:\s*true/.test(yaml);
    // either correct package or marked optional (to tolerate 404)
    expect(hasCorrectPackage || hasOptional).toBe(true);
    // if still using old @anthropic-ai prefix, must be optional
    if (yaml.includes("@anthropic-ai/mcp-server-filesystem")) {
      expect(hasOptional).toBe(true);
    }
  });

  test("free-search marked optional or fixed package", () => {
    const yaml = readFileSync("config/mcp-servers.yaml", "utf8");
    expect(yaml).toContain("free-search:");
    // if package is free-search-mcp (may 404), must be optional:true to allow degraded
    if (yaml.includes("free-search-mcp")) {
      expect(/free-search:\s*\n[\s\S]*?optional:\s*true/.test(yaml)).toBe(true);
    }
  });

  test("obsidian has timeoutMs configurable via MCP_CONNECT_TIMEOUT_MS", () => {
    const yaml = readFileSync("config/mcp-servers.yaml", "utf8");
    // obsidian entry should contain timeoutMs referencing MCP_CONNECT_TIMEOUT_MS
    expect(yaml).toMatch(/obsidian:\s*\n[\s\S]*?timeoutMs:/);
    expect(yaml).toContain("MCP_CONNECT_TIMEOUT_MS");
  });

  test("sqlite server removed entirely", () => {
    const yaml = readFileSync("config/mcp-servers.yaml", "utf8");
    expect(yaml).not.toMatch(/^\s*sqlite:\s*$/m);
    expect(yaml).not.toContain("src/mcp/sqlite-server.ts");
  });

  test("client-connector reads MCP_CONNECT_TIMEOUT_MS env", () => {
    const src = readFileSync("src/mcp/client-connector.ts", "utf8");
    expect(src).toContain("MCP_CONNECT_TIMEOUT_MS");
  });

  test("connectExternalMcpServers resilient: failed only warn not crash", async () => {
    // Use isolated config via tmp file to avoid polluting real yaml
    const tmpPath = ".tmp/mcp-test-resilient.yaml";
    const yamlContent = `
servers:
  good:
    command: "bun"
    args: ["run", "src/mcp/server.ts"]
  bad:
    command: "bun"
    args: ["run", "not-exist.ts"]
`;
    await Bun.write(tmpPath, yamlContent);
    const registry = new ToolRegistry({ guard: async () => {} });
    const fakeFactory = async (name: string) => {
      if (name === "bad") throw new Error("connect ECONNREFUSED");
      return {
        listTools: async () => ({ tools: [{ name: "echo", description: "echo", inputSchema: {} }] }),
        callTool: async () => ({ ok: true }),
        close: async () => {},
      };
    };
    const summary = await connectExternalMcpServers(registry as any, {
      configPath: tmpPath,
      timeoutMs: 1000,
      createClient: fakeFactory as any,
    });
    expect(summary.connected).toContain("good");
    expect(summary.failed.map((f) => f.name)).toContain("bad");
    expect(summary.toolsRegistered).toBe(1);
    // registry should have mcp_good_echo
    expect(registry.getToolNames()).toContain("mcp_good_echo");
    try { await Bun.write(tmpPath, ""); } catch {}
  });

  test("connectExternalMcpServers timeout configurable via MCP_CONNECT_TIMEOUT_MS env", async () => {
    const tmpPath = ".tmp/mcp-test-timeout.yaml";
    const yamlContent = `
servers:
  slow:
    command: "bun"
    args: ["run", "src/mcp/server.ts"]
`;
    await Bun.write(tmpPath, yamlContent);
    const original = process.env.MCP_CONNECT_TIMEOUT_MS;
    process.env.MCP_CONNECT_TIMEOUT_MS = "60";
    // factory that hangs 500ms => should timeout at 60ms
    const hangingFactory = async () =>
      new Promise<any>((resolve) => setTimeout(() => resolve({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({}),
        close: async () => {},
      }), 500));
    const registry = new ToolRegistry({ guard: async () => {} });
    const start = Date.now();
    const summary = await connectExternalMcpServers(registry as any, {
      configPath: tmpPath,
      // no explicit timeoutMs, should pick env var
      createClient: hangingFactory as any,
    });
    const elapsed = Date.now() - start;
    expect(summary.failed.map((f) => f.name)).toContain("slow");
    expect(summary.connected).not.toContain("slow");
    // should timeout roughly within env value + slack, not wait 500ms
    expect(elapsed).toBeLessThan(300);
    // restore
    if (original === undefined) delete process.env.MCP_CONNECT_TIMEOUT_MS;
    else process.env.MCP_CONNECT_TIMEOUT_MS = original;
    try { await Bun.write(tmpPath, ""); } catch {}
  });
});
