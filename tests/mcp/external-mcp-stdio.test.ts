import { afterAll, describe, expect, it } from "bun:test";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";
import {
  connectExternalMcpServers,
  closeExternalMcpClients,
  getMcpClientStats,
} from "../../src/mcp/client-connector.js";

const yamlPath = `.tmp/mcp-external-${process.pid}-${Date.now()}.yaml`;

async function writeConfig(threshold = ""): Promise<void> {
  const envLines = threshold
    ? [
        "    env:",
        `      AXIOM_EXTERNAL_RECOVERABLE_THRESHOLD: "${threshold}"`,
      ]
    : [];
  await Bun.write(yamlPath, [
    "servers:",
    "  axiom-external:",
    '    command: "bun"',
    '    args: ["run", "src/mcp/server.ts", "--external", "--stdio"]',
    ...envLines,
    "",
  ].join("\n"));
}

describe("Axiom external MCP stdio", () => {
  it("exposes only curated external tools", async () => {
    await closeExternalMcpClients();
    await writeConfig();
    const registry = new ToolRegistry({ guard: async () => {} });
    const summary = await connectExternalMcpServers(registry, { configPath: yamlPath, timeoutMs: 20000 });

    expect(summary.failed).toEqual([]);
    expect(summary.connected).toEqual(["axiom-external"]);
    expect(summary.toolsRegistered).toBeGreaterThanOrEqual(9);

    const names = registry.getToolNames();
    for (const expected of [
      "mcp_axiom-external_memory_search",
      "mcp_axiom-external_memory_read",
      "mcp_axiom-external_web_search",
      "mcp_axiom-external_search_engines_list",
      "mcp_axiom-external_skill_list",
      "mcp_axiom-external_token_stats",
      "mcp_axiom-external_kal_query",
      "mcp_axiom-external_read_tool_result",
      "mcp_axiom-external_recoverable_output_stats",
    ]) {
      expect(names).toContain(expected);
    }

    expect(names).not.toContain("mcp_axiom-external_memory_write");
    expect(names).not.toContain("mcp_axiom-external_snapshot_create");
    expect(names).not.toContain("mcp_axiom-external_native_agent_execute");
    expect(getMcpClientStats().connected).toBe(1);

    const closed = await closeExternalMcpClients();
    expect(closed).toBe(1);
  });

  it("can call a safe external tool", async () => {
    await closeExternalMcpClients();
    const registry = new ToolRegistry({ guard: async () => {} });
    const summary = await connectExternalMcpServers(registry, { configPath: yamlPath, timeoutMs: 20000 });
    expect(summary.connected).toContain("axiom-external");

    const handlers = registry.buildHttpHandlers();
    const result = await handlers["mcp_axiom-external_search_engines_list"]({}) as {
      content?: Array<{ type: string; text: string }>;
    };
    const text = result.content?.[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
  });

  it("externalizes large output and reads it back", async () => {
    await closeExternalMcpClients();
    await writeConfig("16");
    const registry = new ToolRegistry({ guard: async () => {} });
    const summary = await connectExternalMcpServers(registry, { configPath: yamlPath, timeoutMs: 20000 });
    expect(summary.connected).toContain("axiom-external");

    const handlers = registry.buildHttpHandlers();
    const result = await handlers["mcp_axiom-external_search_engines_list"]({}) as {
      content?: Array<{ type: string; text: string }>;
    };
    const parsed = JSON.parse(result.content?.[0]?.text ?? "{}") as {
      recoverable?: boolean;
      toolId?: string;
    };
    expect(parsed.recoverable).toBe(true);
    expect(typeof parsed.toolId).toBe("string");

    const readResult = await handlers["mcp_axiom-external_read_tool_result"]({
      toolId: parsed.toolId,
    }) as { content?: Array<{ type: string; text: string }> };
    const readText = readResult.content?.[0]?.text ?? "";
    expect(readText).toContain("duckduckgo");
  });

  afterAll(async () => {
    await closeExternalMcpClients().catch(() => {});
    await Bun.file(yamlPath).delete().catch(() => {});
  });
});