import { describe, expect, it } from "bun:test";
import { ToolRegistry, type ToolDef, type ToolExposure } from "../../src/mcp/tool-registry.js";

function makeTool(name: string, exposure?: ToolExposure[]): ToolDef {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object" },
    exposure,
    handler: async () => ({ name }),
  };
}

describe("ToolRegistry external exposure", () => {
  it("defaults exposure to internal", () => {
    const registry = new ToolRegistry();
    registry.add(makeTool("internal_tool"));
    expect(registry.filterByExposure(["internal"])).toHaveLength(1);
    expect(registry.filterByExposure(["external"])).toHaveLength(0);
  });

  it("filters external tools by exposure", () => {
    const registry = new ToolRegistry();
    registry.add(makeTool("internal_tool"));
    registry.add(makeTool("external_tool", ["external"]));
    registry.add(makeTool("safe_tool", ["safe-external"]));
    const external = registry.filterByExposure(["external", "safe-external"]);
    expect(external.map((t) => t.name).sort()).toEqual(["external_tool", "safe_tool"]);
    expect(registry.filterByExposure(["internal"]).map((t) => t.name)).toEqual(["internal_tool"]);
  });

  it("registers only selected tools with MCP", () => {
    const registry = new ToolRegistry();
    registry.add(makeTool("internal_tool"));
    registry.add(makeTool("external_tool", ["external"]));
    const names: string[] = [];
    const mockMcp = {
      registerTool(name: string) {
        names.push(name);
      },
    } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
    registry.registerWithMcp(mockMcp, registry.filterByExposure(["external"]));
    expect(names).toEqual(["external_tool"]);
  });

  it("builds HTTP handlers for selected tools only", async () => {
    const registry = new ToolRegistry();
    registry.add(makeTool("internal_tool"));
    registry.add(makeTool("external_tool", ["external"]));
    const handlers = registry.buildHttpHandlers(registry.filterByExposure(["external"]));
    expect(Object.keys(handlers)).toEqual(["external_tool"]);
    expect(await handlers.external_tool({})).toEqual({ name: "external_tool" });
  });

  it("preserves explicit exposure arrays after add", () => {
    const registry = new ToolRegistry();
    registry.add(makeTool("dual_tool", ["internal", "external"]));
    const external = registry.filterByExposure(["external"]);
    expect(external).toHaveLength(1);
    expect(external[0].exposure).toEqual(["internal", "external"]);
  });

  it("filterByExposure returns stable sorted order", () => {
    const registry = new ToolRegistry();
    registry.add(makeTool("z_tool", ["external"]));
    registry.add(makeTool("a_tool", ["external"]));
    registry.add(makeTool("m_tool", ["safe-external"]));
    const names = registry.filterByExposure(["external", "safe-external"]).map((t) => t.name);
    expect(names).toEqual(["a_tool", "m_tool", "z_tool"]);
  });
});
