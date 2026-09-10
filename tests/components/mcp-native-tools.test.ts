import { describe, it, expect, afterEach } from "bun:test";
import { resetComponentKernel } from "../../src/components/kernel.js";
import { initializeComponentKernel } from "../../src/agents/component-bootstrap.js";
import { registerNativeTools } from "../../src/mcp/server/native-tools.js";
import type { ToolRegistry, ToolDef } from "../../src/mcp/tool-registry.js";

describe("native_toolchain_status MCP tool", () => {
  afterEach(() => {
    resetComponentKernel();
  });

  it("registers and reports component health", async () => {
    await initializeComponentKernel();
    const captured: ToolDef[] = [];
    const registry = {
      add: (tool: ToolDef) => {
        captured.push(tool);
      },
    } as unknown as ToolRegistry;

    registerNativeTools(registry);
    expect(captured.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["native_toolchain_status"]),
    );
    const statusTool = captured.find(
      (tool) => tool.name === "native_toolchain_status",
    )!;

    const result = (await statusTool.handler({})) as {
      native: boolean;
      components: Array<{ id: string; ready: boolean }>;
    };
    expect(result.native).toBe(true);
    expect(result.components.length).toBeGreaterThanOrEqual(4);
  });
});
