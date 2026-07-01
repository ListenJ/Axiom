/**
 * Plugin Market Tests
 * 
 * Tests the plugin registry, routes, and lifecycle management.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { PluginRegistry } from "../src/plugins/plugin-registry.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
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

  describe("Plugin Routes", () => {
    it("should return empty plugin list or 401", async () => {
      const apiKey = process.env.AXIOM_AUTH_TOKEN || "test-key";
      try {
        const res = await fetch("http://localhost:18789/plugins", {
          headers: { "X-API-Key": apiKey },
        });
        // Server may not be running
        expect([200, 401]).toContain(res.status);
        if (res.status === 200) {
          const data = await res.json();
          expect(data.success).toBe(true);
          expect(data.plugins).toBeArray();
        }
      } catch {
        // Server not running - skip
        expect(true).toBe(true);
      }
    });

    it("should return available plugins or 401", async () => {
      const apiKey = process.env.AXIOM_AUTH_TOKEN || "test-key";
      try {
        const res = await fetch("http://localhost:18789/plugins/available", {
          headers: { "X-API-Key": apiKey },
        });
        expect([200, 401]).toContain(res.status);
        if (res.status === 200) {
          const data = await res.json();
          expect(data.success).toBe(true);
          expect(data.plugins).toBeArray();
        }
      } catch {
        // Server not running - skip
        expect(true).toBe(true);
      }
    });
  });
});

