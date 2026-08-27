/**
 * 插件兼容性测试（需求 2）：hook / tools / skill / MCP 四类兼容契约
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";
import { PluginRegistry } from "../src/plugins/plugin-registry.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import { registerSkillTools } from "../src/mcp/server/skill-tools.js";
import { DEFAULT_SKILL_DIRS } from "../src/skills/types.js";
import type { PluginManifest } from "../src/plugins/types.js";

const manifest = (id: string): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  author: "test",
  description: "compat test",
  category: "test",
  tags: [],
});

function freshRegistry(): { db: Database; toolRegistry: ToolRegistry; registry: PluginRegistry; pluginDir: string } {
  const db = new Database(":memory:");
  const toolRegistry = new ToolRegistry({ guard: async () => {} });
  const pluginDir = join(tmpdir(), `plugin-compat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const registry = new PluginRegistry(db, toolRegistry, pluginDir);
  return { db, toolRegistry, registry, pluginDir };
}

describe("Plugin compatibility — hooks + tools (modern contract)", () => {
  it("enable 注册工具并调用 onEnable；disable 调用 onDisable 并卸载工具", async () => {
    const { db, toolRegistry, registry, pluginDir } = freshRegistry();
    try {
      await registry.install(manifest("hook-plugin"), "./tests/fixtures/hook-plugin", { enable: true });
      expect(registry.get("hook-plugin")?.status).toBe("enabled");
      expect(toolRegistry.getToolNames()).toContain("hook_plugin_ping");

      // enable 已动态 import 安装路径的模块（bun 按路径缓存同一实例）→ 读 hooksLog 验证 onEnable 确实执行
      const installedUrl = pathToFileURL(join(pluginDir, "hook-plugin", "index.js")).href;
      const installedMod = (await import(installedUrl)) as { hooksLog: string[] };
      expect(installedMod.hooksLog).toEqual(["enable"]);

      await registry.disable("hook-plugin");
      expect(installedMod.hooksLog).toEqual(["enable", "disable"]);
      expect(toolRegistry.getToolNames()).not.toContain("hook_plugin_ping");
      expect(registry.get("hook-plugin")?.status).toBe("disabled");
    } finally {
      db.close();
    }
  });
});

describe("Plugin compatibility — legacy activate(ctx) contract", () => {
  it("activate 通过 context.toolRegistry 命令式注册工具", async () => {
    const { db, toolRegistry, registry } = freshRegistry();
    try {
      await registry.install(manifest("legacy-plugin"), "./tests/fixtures/legacy-plugin", { enable: true });
      expect(toolRegistry.getToolNames()).toContain("legacy_plugin_tool");
    } finally {
      db.close();
    }
  });
});

describe("Plugin compatibility — skill + MCP", () => {
  it("插件工具与 skill 工具共存于同一 ToolRegistry", async () => {
    const { db, toolRegistry, registry } = freshRegistry();
    try {
      await registry.install(manifest("hook-plugin"), "./tests/fixtures/hook-plugin", { enable: true });
      registerSkillTools(toolRegistry, [...DEFAULT_SKILL_DIRS]);
      const names = toolRegistry.getToolNames();
      expect(names).toContain("hook_plugin_ping");
      expect(names.some((n) => n.startsWith("skill_"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("registerWithMcp 把插件工具注册到 MCP server（stdio/HTTP 双传输）", async () => {
    const { db, toolRegistry, registry } = freshRegistry();
    try {
      await registry.install(manifest("hook-plugin"), "./tests/fixtures/hook-plugin", { enable: true });
      const registered: string[] = [];
      const mockMcp = { registerTool: (name: string) => { registered.push(name); } };
      toolRegistry.registerWithMcp(mockMcp as never);
      expect(registered).toContain("hook_plugin_ping");
    } finally {
      db.close();
    }
  });
});
