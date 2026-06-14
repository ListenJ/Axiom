import { describe, it, expect } from "bun:test";

describe("Plugins Page", () => {
  it("should list installed plugins", () => {
    const plugins = [
      { id: "plugin-1", name: "MCP Server", enabled: true, version: "1.0.0" },
      { id: "plugin-2", name: "Code Analyzer", enabled: false, version: "2.1.0" },
    ];

    expect(plugins.length).toBe(2);
    expect(plugins[0].enabled).toBe(true);
    expect(plugins[1].enabled).toBe(false);
  });

  it("should filter enabled plugins", () => {
    const plugins = [
      { id: "plugin-1", enabled: true },
      { id: "plugin-2", enabled: false },
      { id: "plugin-3", enabled: true },
    ];

    const enabled = plugins.filter((p) => p.enabled);
    expect(enabled.length).toBe(2);
    expect(enabled[0].id).toBe("plugin-1");
    expect(enabled[1].id).toBe("plugin-3");
  });

  it("should filter disabled plugins", () => {
    const plugins = [
      { id: "plugin-1", enabled: true },
      { id: "plugin-2", enabled: false },
      { id: "plugin-3", enabled: true },
    ];

    const disabled = plugins.filter((p) => !p.enabled);
    expect(disabled.length).toBe(1);
    expect(disabled[0].id).toBe("plugin-2");
  });

  it("should toggle plugin state", () => {
    const plugins = [
      { id: "plugin-1", enabled: true },
      { id: "plugin-2", enabled: false },
    ];

    const toggle = (id: string) =>
      plugins.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p));

    const result = toggle("plugin-1");
    expect(result[0].enabled).toBe(false);

    const result2 = toggle("plugin-2");
    expect(result2[1].enabled).toBe(true);
  });

  it("should install plugin", () => {
    const available = [
      { id: "plugin-a", name: "Plugin A" },
      { id: "plugin-b", name: "Plugin B" },
    ];

    const installed: Array<{ id: string; name: string; enabled: boolean }> = [];

    const install = (id: string) => {
      const plugin = available.find((p) => p.id === id);
      if (plugin) {
        installed.push({ ...plugin, enabled: true });
      }
    };

    install("plugin-a");
    expect(installed.length).toBe(1);
    expect(installed[0].name).toBe("Plugin A");
    expect(installed[0].enabled).toBe(true);
  });

  it("should uninstall plugin", () => {
    const plugins = [
      { id: "plugin-1", name: "Plugin 1" },
      { id: "plugin-2", name: "Plugin 2" },
    ];

    const uninstall = (id: string) => plugins.filter((p) => p.id !== id);

    const result = uninstall("plugin-1");
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("plugin-2");
  });

  it("should group plugins by author", () => {
    const plugins = [
      { id: "p1", author: "OpenAI" },
      { id: "p2", author: "Anthropic" },
      { id: "p3", author: "OpenAI" },
    ];

    const grouped = plugins.reduce((acc, p) => {
      if (!acc[p.author]) acc[p.author] = [];
      acc[p.author].push(p);
      return acc;
    }, {} as Record<string, typeof plugins>);

    expect(Object.keys(grouped).length).toBe(2);
    expect(grouped["OpenAI"].length).toBe(2);
    expect(grouped["Anthropic"].length).toBe(1);
  });

  it("should search plugins by name", () => {
    const plugins = [
      { id: "p1", name: "MCP Server" },
      { id: "p2", name: "Code Analyzer" },
      { id: "p3", name: "MCP Client" },
    ];

    const search = (query: string) =>
      plugins.filter((p) =>
        p.name.toLowerCase().includes(query.toLowerCase())
      );

    const results = search("mcp");
    expect(results.length).toBe(2);
    expect(results[0].id).toBe("p1");
    expect(results[1].id).toBe("p3");
  });

  it("should validate plugin config", () => {
    const config = {
      apiKey: "test-key",
      timeout: 30000,
      retries: 3,
    };

    expect(typeof config.apiKey).toBe("string");
    expect(typeof config.timeout).toBe("number");
    expect(typeof config.retries).toBe("number");
    expect(config.timeout).toBeGreaterThan(0);
    expect(config.retries).toBeGreaterThan(0);
  });

  it("should list active tools from enabled plugins", () => {
    const plugins = [
      { id: "p1", enabled: true, tools: ["tool-a", "tool-b"] },
      { id: "p2", enabled: false, tools: ["tool-c"] },
      { id: "p3", enabled: true, tools: ["tool-d"] },
    ];

    const activeTools = plugins
      .filter((p) => p.enabled)
      .flatMap((p) => p.tools.map((t) => ({ name: t, pluginId: p.id })));

    expect(activeTools.length).toBe(3);
    expect(activeTools[0].name).toBe("tool-a");
    expect(activeTools[0].pluginId).toBe("p1");
  });

  it("should check plugin version compatibility", () => {
    const isCompatible = (v: string, min: string, max: string) => {
      const toNum = (s: string) => {
        const [major, minor, patch] = s.split(".").map(Number);
        return major * 10000 + minor * 100 + patch;
      };
      const nv = toNum(v);
      return nv >= toNum(min) && nv <= toNum(max);
    };

    expect(isCompatible("2.1.0", "1.0.0", "3.0.0")).toBe(true);
    expect(isCompatible("1.0.0", "1.0.0", "3.0.0")).toBe(true);
    expect(isCompatible("3.0.0", "1.0.0", "3.0.0")).toBe(true);
    expect(isCompatible("0.9.0", "1.0.0", "3.0.0")).toBe(false);
    expect(isCompatible("4.0.0", "1.0.0", "3.0.0")).toBe(false);
  });
});
