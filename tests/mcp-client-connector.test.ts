import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import {
  loadMcpServerConfigs,
  connectExternalMcpServers,
  closeExternalMcpClients,
  getMcpClientStats,
  type McpClientLike,
  type McpClientFactory,
  type McpServerEntry,
} from "../src/mcp/client-connector.js";

/** 空守卫：测试聚焦连接器行为，不触发生产双层复核 */
function createTestRegistry(): ToolRegistry {
  return new ToolRegistry({ guard: async () => {} });
}

describe("MCP Client Connector (R-015)", () => {
  describe("loadMcpServerConfigs", () => {
    it("should parse config/mcp-servers.yaml correctly", async () => {
      const servers = await loadMcpServerConfigs("config/mcp-servers.yaml");

      expect(Object.keys(servers)).toContain("context7");
      expect(Object.keys(servers)).toContain("free-search");
      expect(Object.keys(servers)).toContain("opencode");

      // remote HTTP 类型
      expect(servers.context7.type).toBe("remote");
      expect(servers.context7.url).toBe("https://mcp.context7.com/mcp");

      // stdio 类型
      expect(servers["free-search"].command).toBe("bunx");
      expect(servers["free-search"].args).toEqual(["-y", "free-search-mcp"]);

      // env 占位符原样保留（连接时才展开）
      expect(servers.opencode.env?.OPENCODE_API_KEY).toBe("${OPENCODE_API_KEY}");
    });

    it("should return empty map for missing config file", async () => {
      const servers = await loadMcpServerConfigs("config/__nonexistent__.yaml");
      expect(servers).toEqual({});
    });

    it("should return empty map for yaml without servers key", async () => {
      const tmpPath = `.tmp/test-mcp-no-servers-${Date.now()}.yaml`;
      await Bun.write(tmpPath, "other: 1\n");
      try {
        const servers = await loadMcpServerConfigs(tmpPath);
        expect(servers).toEqual({});
      } finally {
        await Bun.file(tmpPath).delete().catch(() => {});
      }
    });
  });

  describe("connectExternalMcpServers", () => {
    const fakeYaml = `.tmp/test-mcp-servers-${Date.now()}.yaml`;

    async function writeFakeConfig(): Promise<void> {
      await Bun.write(fakeYaml, [
        "servers:",
        "  alpha:",
        '    type: "remote"',
        '    url: "https://fake.example/mcp"',
        "  beta:",
        '    command: "bunx"',
        '    args: ["-y", "fake-mcp"]',
        "  broken:",
        '    command: "bunx"',
        '    args: ["-y", "missing-mcp"]',
        "",
      ].join("\n"));
    }

    function fakeClientFactory(overrides?: Record<string, Partial<McpServerEntry>>) {
      const calls: Array<{ name: string; entry: McpServerEntry }> = [];
      const factory = async (name: string, entry: McpServerEntry): Promise<McpClientLike> => {
        calls.push({ name, entry });
        if (name === "broken") throw new Error("spawn bunx ENOENT");
        return {
          listTools: async () => ({
            tools: [
              { name: "search", description: `${name} search`, inputSchema: { type: "object" } },
            ],
          }),
          callTool: async (params) => ({ server: name, tool: params.name, args: params.arguments }),
          close: async () => {},
        };
      };
      return { factory, calls };
    }

    it("should register remote tools with mcp_<server>_ prefix", async () => {
      await writeFakeConfig();
      const registry = createTestRegistry();
      const { factory } = fakeClientFactory();

      const summary = await connectExternalMcpServers(registry, {
        configPath: fakeYaml,
        createClient: factory,
      });

      expect(summary.connected.sort()).toEqual(["alpha", "beta"]);
      expect(summary.toolsRegistered).toBe(2);
      expect(registry.getToolNames()).toContain("mcp_alpha_search");
      expect(registry.getToolNames()).toContain("mcp_beta_search");
    });

    it("should gracefully degrade on connection failure", async () => {
      await writeFakeConfig();
      const registry = createTestRegistry();
      const { factory } = fakeClientFactory();

      const summary = await connectExternalMcpServers(registry, {
        configPath: fakeYaml,
        createClient: factory,
      });

      // broken 失败被捕获，不影响其余 server
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0].name).toBe("broken");
      expect(summary.failed[0].error).toContain("ENOENT");
      expect(summary.connected.sort()).toEqual(["alpha", "beta"]);
    });

    it("should proxy tool calls to the remote client", async () => {
      await writeFakeConfig();
      const registry = createTestRegistry();
      const { factory } = fakeClientFactory();

      await connectExternalMcpServers(registry, {
        configPath: fakeYaml,
        createClient: factory,
      });

      const handlers = registry.buildHttpHandlers();
      const result = await handlers.mcp_alpha_search({ q: "hello" }) as { server: string; tool: string; args: unknown };
      expect(result.server).toBe("alpha");
      expect(result.tool).toBe("search");
      expect(result.args).toEqual({ q: "hello" });
    });

    it("should degrade to empty summary when config is missing", async () => {
      const registry = createTestRegistry();
      const summary = await connectExternalMcpServers(registry, {
        configPath: "config/__nonexistent__.yaml",
      });
      expect(summary.connected).toEqual([]);
      expect(summary.failed).toEqual([]);
      expect(summary.toolsRegistered).toBe(0);
      expect(registry.size).toBe(0);
    });
    it("should close the client when listTools fails", async () => {
      await writeFakeConfig();
      const registry = createTestRegistry();
      const closed: string[] = [];
      const factory: McpClientFactory = async (name: string) => {
        if (name !== "alpha") throw new Error("spawn failed");
        return {
          listTools: async () => { throw new Error("listTools failed"); },
          callTool: async () => ({}),
          close: async () => { closed.push(name); },
        };
      };

      const summary = await connectExternalMcpServers(registry, {
        configPath: fakeYaml,
        createClient: factory,
      });

      expect(summary.failed).toHaveLength(3);
      expect(summary.failed.find((f) => f.name === "alpha")?.error).toContain("listTools failed");
      expect(closed).toEqual(["alpha"]);
    });

    it("should close the client when listTools times out", async () => {
      await writeFakeConfig();
      const registry = createTestRegistry();
      const closed: string[] = [];
      const factory: McpClientFactory = async (name: string) => {
        if (name !== "alpha") throw new Error("spawn failed");
        return {
          listTools: () => new Promise<never>(() => {}), // 永不返回
          callTool: async () => ({}),
          close: async () => { closed.push(name); },
        };
      };

      const summary = await connectExternalMcpServers(registry, {
        configPath: fakeYaml,
        timeoutMs: 150,
        createClient: factory,
      });

      expect(summary.failed).toHaveLength(3);
      expect(summary.failed.some((f) => f.name === "alpha" && f.error.includes("timed out"))).toBe(true);
      expect(closed).toEqual(["alpha"]);
    });

    it("should close the client when tool registration fails", async () => {
      await writeFakeConfig();
      const closed: string[] = [];
      const badRegistry = {
        add: () => { throw new Error("duplicate tool name"); },
        size: 0,
      } as unknown as ToolRegistry;
      const factory: McpClientFactory = async (name: string) => {
        if (name !== "alpha") throw new Error("spawn failed");
        return {
          listTools: async () => ({
            tools: [{ name: "search", description: "x", inputSchema: {} }],
          }),
          callTool: async () => ({}),
          close: async () => { closed.push(name); },
        };
      };

      const summary = await connectExternalMcpServers(badRegistry, {
        configPath: fakeYaml,
        createClient: factory,
      });

      expect(summary.failed).toHaveLength(3);
      expect(closed).toEqual(["alpha"]);
    });

    it("should close an orphaned client when createClient times out then resolves late", async () => {
      await writeFakeConfig();
      const registry = createTestRegistry();
      const closed: string[] = [];
      const createHolder: { resolve: ((c: McpClientLike) => void) | null } = { resolve: null };
      const factory: McpClientFactory = (name: string) => {
        if (name !== "alpha") throw new Error("spawn failed");
        return new Promise<McpClientLike>((resolve) => { createHolder.resolve = resolve; });
      };

      const summary = await connectExternalMcpServers(registry, {
        configPath: fakeYaml,
        timeoutMs: 150,
        createClient: factory,
      });

      expect(summary.failed).toHaveLength(3);
      expect(closed).toEqual([]); // 超时瞬间尚未创建

      // 迟到完成的连接必须被立即关闭，防止孤儿子进程残留
      createHolder.resolve?.({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({}),
        close: async () => { closed.push("alpha"); },
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(closed).toEqual(["alpha"]);
    });

    it("should close all connected clients and clear the registry via closeExternalMcpClients", async () => {
      await writeFakeConfig();
      const registry = createTestRegistry();
      const closed: string[] = [];
      const factory: McpClientFactory = async (name: string) => {
        if (name === "broken") throw new Error("spawn failed");
        return {
          listTools: async () => ({ tools: [{ name: "search" }] }),
          callTool: async () => ({}),
          close: async () => { closed.push(name); },
        };
      };

      const summary = await connectExternalMcpServers(registry, {
        configPath: fakeYaml,
        createClient: factory,
      });
      expect(summary.connected.sort()).toEqual(["alpha", "beta"]);
      expect(getMcpClientStats().connected).toBe(2);

      const n = await closeExternalMcpClients();
      expect(n).toBe(2);
      expect(closed.sort()).toEqual(["alpha", "beta"]);
      expect(getMcpClientStats().connected).toBe(0);

      // 幂等：再次关闭返回 0
      expect(await closeExternalMcpClients()).toBe(0);
    });

    it("should remove a client from the registry when listTools fails", async () => {
      await writeFakeConfig();
      const registry = createTestRegistry();
      const factory: McpClientFactory = async (name: string) => {
        if (name !== "alpha") throw new Error("spawn failed");
        return {
          listTools: async () => { throw new Error("listTools failed"); },
          callTool: async () => ({}),
          close: async () => {},
        };
      };

      await connectExternalMcpServers(registry, {
        configPath: fakeYaml,
        createClient: factory,
      });

      // alpha 失败即关闭并从注册表移除；beta/broken 在创建阶段失败，从未登记
      expect(getMcpClientStats().connected).toBe(0);
    });

    it("should close the previous client when the same server reconnects (no registry leak)", async () => {
      await writeFakeConfig();
      const registry = createTestRegistry();
      const closed: string[] = [];
      let spawnCount = 0;
      const factory: McpClientFactory = async (name: string) => {
        if (name !== "alpha") throw new Error("spawn failed");
        const mySpawn = ++spawnCount;
        return {
          listTools: async () => ({ tools: [{ name: "search" }] }),
          callTool: async () => ({}),
          close: async () => { closed.push(`alpha#${mySpawn}`); },
        };
      };

      await connectExternalMcpServers(registry, { configPath: fakeYaml, createClient: factory });
      expect(getMcpClientStats().connected).toBe(1);

      await connectExternalMcpServers(registry, { configPath: fakeYaml, createClient: factory });
      expect(getMcpClientStats().connected).toBe(1);
      // 第一次连接的 client 必须在第二次连接（同名覆盖）时被关闭，否则泄漏
      expect(closed).toEqual(["alpha#1"]);
    });
  });
});
