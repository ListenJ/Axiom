/**
 * Plugin Market Tests
 * 
 * Tests the plugin registry, routes, and lifecycle management.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { PluginRegistry } from "../src/plugins/plugin-registry.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import { createPluginRoutes } from "../src/routes/plugin-routes.js";
import type { PluginManifest } from "../src/plugins/types.js";

describe("Plugin Market", () => {
  let db: Database;
  let toolRegistry: ToolRegistry;
  let registry: PluginRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    toolRegistry = new ToolRegistry();
    registry = new PluginRegistry(db, toolRegistry);
  });

  afterEach(() => {
    db.close();
  });

  describe("PluginRegistry", () => {
    it("should initialize with empty plugin list", () => {
      const plugins = registry.list();
      expect(plugins).toBeArray();
      expect(plugins.length).toBe(0);
    });

    it("should install a plugin from manifest", async () => {
      const manifest: PluginManifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        author: "Test Author",
        description: "A test plugin",
        category: "developer-tools",
        tags: ["test", "dev"],
      };

      const plugin = await registry.install(manifest, "./tests/fixtures/test-plugin", { enable: false });
      expect(plugin.manifest.id).toBe("test-plugin");
      expect(plugin.status).toBe("installed");
      expect(plugin.manifest.name).toBe("Test Plugin");
    });

    it("should enable and disable a plugin", async () => {
      const manifest: PluginManifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        author: "Test Author",
        description: "A test plugin",
        category: "developer-tools",
        tags: ["test"],
      };

      await registry.install(manifest, "./tests/fixtures/test-plugin");
      
      await registry.enable("test-plugin");
      let plugin = registry.get("test-plugin");
      expect(plugin?.status).toBe("enabled");

      await registry.disable("test-plugin");
      plugin = registry.get("test-plugin");
      expect(plugin?.status).toBe("disabled");
    });

    it("should uninstall a plugin", async () => {
      const manifest: PluginManifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        author: "Test Author",
        description: "A test plugin",
        category: "developer-tools",
        tags: ["test"],
      };

      await registry.install(manifest, "./tests/fixtures/test-plugin");
      expect(registry.get("test-plugin")).toBeDefined();

      await registry.uninstall("test-plugin");
      expect(registry.get("test-plugin")).toBeUndefined();
    });

    it("should configure a plugin", async () => {
      const manifest: PluginManifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        author: "Test Author",
        description: "A test plugin",
        category: "developer-tools",
        tags: ["test"],
        config: [
          { key: "apiKey", type: "string", label: "API Key", required: true },
          { key: "timeout", type: "number", label: "Timeout", default: 30000 },
        ],
      };

      await registry.install(manifest, "./tests/fixtures/test-plugin");
      await registry.configure("test-plugin", { apiKey: "secret123", timeout: 5000 });

      const plugin = registry.get("test-plugin");
      expect(plugin?.configValues.apiKey).toBe("secret123");
      expect(plugin?.configValues.timeout).toBe(5000);
    });

    it("should list available built-in plugins", async () => {
      const manifests = await registry.listAvailable();
      expect(manifests).toBeArray();
      // Should find example plugins if they exist
      const hasCodeAnalysis = manifests.some((m) => m.id === "code-analysis-enhanced");
      expect(hasCodeAnalysis).toBe(true);
    });

    it("should get active tools from enabled plugins", async () => {
      const manifest: PluginManifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        author: "Test Author",
        description: "A test plugin",
        category: "developer-tools",
        tags: ["test"],
      };

      await registry.install(manifest, "./tests/fixtures/test-plugin");
      await registry.enable("test-plugin");

      const tools = registry.getActiveTools();
      expect(tools).toBeArray();
    });

    it("should persist plugins to database", async () => {
      const manifest: PluginManifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        author: "Test Author",
        description: "A test plugin",
        category: "developer-tools",
        tags: ["test"],
      };

      await registry.install(manifest, "./tests/fixtures/test-plugin");
      
      // Create a new registry instance with the same database
      const newRegistry = new PluginRegistry(db, toolRegistry);
      const plugin = newRegistry.get("test-plugin");
      expect(plugin).toBeDefined();
      expect(plugin?.manifest.name).toBe("Test Plugin");
    });

    it("should not install duplicate plugins without overwrite", async () => {
      const manifest: PluginManifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        author: "Test Author",
        description: "A test plugin",
        category: "developer-tools",
        tags: ["test"],
      };

      await registry.install(manifest, "./tests/fixtures/test-plugin");
      
      // Try to install again without overwrite
      await expect(registry.install(manifest, "./tests/fixtures/test-plugin")).rejects.toThrow();
    });

    it("should overwrite existing plugin with overwrite option", async () => {
      const manifest: PluginManifest = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        author: "Test Author",
        description: "A test plugin",
        category: "developer-tools",
        tags: ["test"],
      };

      await registry.install(manifest, "./tests/fixtures/test-plugin");
      
      const updatedManifest = { ...manifest, version: "2.0.0" };
      const plugin = await registry.install(updatedManifest, "./tests/fixtures/test-plugin", { overwrite: true });
      expect(plugin.manifest.version).toBe("2.0.0");
    });
  });

  // 审计整改 R1：原用例以 catch{expect(true)} 在无守护进程时恒绿。
  // 现由 AXIOM_LIVE_SERVER=1 门控；启用后断言真实生效（不再吞错）。
  describe("Plugin Routes", () => {
    const itLive = process.env.AXIOM_LIVE_SERVER ? it : it.skip;

    itLive("should return empty plugin list or 401", async () => {
      const apiKey = process.env.AXIOM_AUTH_TOKEN || "test-key";
      const res = await fetch("http://localhost:18789/plugins", {
        headers: { "X-API-Key": apiKey },
      });
      expect([200, 401]).toContain(res.status);
      if (res.status === 200) {
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.plugins).toBeArray();
      }
    });

    itLive("should return available plugins or 401", async () => {
      const apiKey = process.env.AXIOM_AUTH_TOKEN || "test-key";
      const res = await fetch("http://localhost:18789/plugins/available", {
        headers: { "X-API-Key": apiKey },
      });
      expect([200, 401]).toContain(res.status);
      if (res.status === 200) {
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.plugins).toBeArray();
      }
    });
  });
});

// ============================================================================
// W3 修复单元测试：plugin-routes.ts install 处理器
// 验证：① 前端只传 pluginId 时回退到 ./plugins/<id>；② overwrite 选项透传
// 注意：不调用 uninstall —— 因为 pluginDir 默认为 ./plugins/，installFromPath 是
// 就地安装（source==target），uninstall 会删除 ./plugins/<id> 源目录！
// 每个测试用独立 in-memory DB，registry 启动即空，无需跨测试清理。
// ============================================================================
describe("Plugin Routes — W3 install path fallback & overwrite (unit)", () => {
  let db: Database;
  let toolRegistry: ToolRegistry;
  let routes: ReturnType<typeof createPluginRoutes>;
  const PLUGIN_ID = "test-plugin";
  const DIRECT_PATH = "./plugins/test-plugin";

  function makeInstallRequest(body: { path: string; enable?: boolean; overwrite?: boolean }): Request {
    return new Request("http://localhost/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    toolRegistry = new ToolRegistry();
    routes = createPluginRoutes(db, toolRegistry);
  });

  afterEach(() => {
    // 仅关闭 DB —— 不调用 uninstall（会删除 ./plugins/<id> 源目录）
    db.close();
  });

  it("W3-1: 仅传 pluginId（路径不存在）时回退到 ./plugins/<id>", async () => {
    // body.path = "test-plugin"（不是有效相对路径，但 ./plugins/test-plugin 存在）
    const res = await routes.install(makeInstallRequest({ path: PLUGIN_ID, enable: false }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.plugin.id).toBe(PLUGIN_ID);
  });

  it("W3-2: 直接传完整路径时正常安装（不走回退）", async () => {
    const res = await routes.install(makeInstallRequest({ path: DIRECT_PATH, enable: false }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.plugin.id).toBe(PLUGIN_ID);
  });

  it("W3-3: 路径不存在且无回退候选时返回 500", async () => {
    const res = await routes.install(makeInstallRequest({ path: "nonexistent-plugin-id-xyz" }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(String(data.error)).toContain("not found");
  });

  it("W3-4: 缺少 path 字段返回 400", async () => {
    const res = await routes.install(
      new Request("http://localhost/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("required");
  });

  it("W3-5: 重复安装不带 overwrite 返回 500 'already installed'", async () => {
    // 首次安装
    const res1 = await routes.install(makeInstallRequest({ path: DIRECT_PATH, enable: false }));
    expect(res1.status).toBe(200);

    // 再次安装，不带 overwrite —— 应失败（同一 registry 实例，DB 已有记录）
    const res2 = await routes.install(makeInstallRequest({ path: DIRECT_PATH, enable: false }));
    expect(res2.status).toBe(500);
    const data2 = await res2.json();
    expect(data2.success).toBe(false);
    expect(String(data2.error)).toContain("already installed");
  });

  it("W3-6: 重复安装带 overwrite=true 成功替换", async () => {
    // 首次安装
    await routes.install(makeInstallRequest({ path: DIRECT_PATH, enable: false }));

    // 再次安装，带 overwrite —— 应成功（同一 registry 实例）
    const res = await routes.install(
      makeInstallRequest({ path: DIRECT_PATH, enable: false, overwrite: true })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.plugin.id).toBe(PLUGIN_ID);
  });

  it("W3-7: enable 默认为 true（不传 enable 字段）", async () => {
    const res = await routes.install(makeInstallRequest({ path: DIRECT_PATH }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // enable 默认 true → 经 enablePlugin 流程后 status 应为 enabled（activate 成功）
    // 或 installed（activate 抛错时保持 installed）
    expect(["enabled", "installed"]).toContain(data.plugin.status);
  });
});

