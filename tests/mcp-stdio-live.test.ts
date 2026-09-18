/**
 * MCP stdio 真实连通测试（R-015 闭环）
 *
 * 用真实 SDK StdioClientTransport 拉起本仓库 tests/fixtures/mcp-stdio-echo.ts
 * 子进程，走 connectExternalMcpServers 全链路：连接 → listTools → 注册 →
 * callTool → closeExternalMcpClients 关闭子进程。验证 Bun 环境下 stdio
 * 类 MCP server 可真实工作（此前仅 fake 覆盖，真实连通未验证）。
 */
import { describe, expect, it, afterAll } from "bun:test";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import {
  connectExternalMcpServers,
  closeExternalMcpClients,
  getMcpClientStats,
} from "../src/mcp/client-connector.js";

const yamlPath = `.tmp/mcp-stdio-live-${process.pid}-${Date.now()}.yaml`;

function createTestRegistry(): ToolRegistry {
  return new ToolRegistry({ guard: async () => {} });
}

describe("MCP stdio 真实连通 (R-015)", () => {
  it("bun 子进程 stdio server 全链路连通并在关闭后回收", async () => {
    // 测试隔离：先关闭其他文件遗留的 client，避免共享模块状态污染精确计数
    await closeExternalMcpClients();
    await Bun.write(yamlPath, [
      "servers:",
      "  echo-server:",
      '    command: "bun"',
      '    args: ["run", "tests/fixtures/mcp-stdio-echo.ts"]',
      "",
    ].join("\n"));

    const registry = createTestRegistry();
    const summary = await connectExternalMcpServers(registry, { configPath: yamlPath });

    expect(summary.failed).toEqual([]);
    expect(summary.connected).toEqual(["echo-server"]);
    expect(summary.toolsRegistered).toBe(1);
    expect(registry.getToolNames()).toContain("mcp_echo-server_echo");
    expect(getMcpClientStats().connected).toBe(1);

    const handlers = registry.buildHttpHandlers();
    const res = await handlers["mcp_echo-server_echo"]({ text: "hello" }) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(res.content[0].text).toBe("echo:hello");

    const n = await closeExternalMcpClients();
    expect(n).toBe(1);
    expect(getMcpClientStats().connected).toBe(0);
  }, 20000);

  afterAll(async () => {
    await closeExternalMcpClients().catch(() => {});
    await Bun.file(yamlPath).delete().catch(() => {});
  });
});