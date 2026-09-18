/**
 * 回归测试：插件 manifest 的 id / entry 不得逃出插件目录（TDD RED → GREEN）
 *
 * 缺陷（第三方审计 C-2，Axiom 侧已修、本仓库仍活跃）：
 * `plugin-registry.ts:171` 对 `manifest.id` 只做真值检查，随后
 * `:195 join(this.pluginDir, manifest.id)` 直接用于目标路径 ⇒ 形如 `../../evil`
 * 的 id 可把插件内容写到**插件目录之外**。
 * 同理 `:328 join(plugin.path, manifest.entry)` 之后 `:338 await import(entryPath)`
 * ⇒ 形如 `../../payload.js` 的 entry 可加载**插件目录之外的任意模块**（代码执行）。
 *
 * 断言的是对外行为（安装被拒 / 越界模块未被加载），不绑定具体实现方式。
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PluginRegistry } from "../../src/plugins/plugin-registry.js";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";
import type { PluginManifest } from "../../src/plugins/types.js";

const manifest = (id: string, entry?: string): PluginManifest => ({
  id,
  name: id || "noname",
  version: "1.0.0",
  author: "test",
  description: "containment test",
  category: "test",
  tags: [],
  ...(entry ? { entry } : {}),
});

function mkRegistry(): {
  db: Database;
  registry: PluginRegistry;
  toolRegistry: ToolRegistry;
  pluginDir: string;
  sandbox: string;
} {
  const sandbox = mkdtempSync(join(tmpdir(), "plugin-containment-"));
  const pluginDir = join(sandbox, "plugins");
  mkdirSync(pluginDir, { recursive: true });
  const db = new Database(":memory:");
  const toolRegistry = new ToolRegistry({ guard: async () => {} });
  const registry = new PluginRegistry(db, toolRegistry, pluginDir);
  return { db, registry, toolRegistry, pluginDir, sandbox };
}

describe("插件 manifest 包含性（id / entry 不得逃出插件目录）", () => {
  it("恶意 id（路径穿越）在安装期即被拒，且不在插件目录外产生写入", async () => {
    const { db, registry, pluginDir, sandbox } = mkRegistry();
    try {
      const src = join(sandbox, "src-evil");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "index.js"), "export const hacked = true;\n");

      await expect(registry.install(manifest("../../escaped"), src)).rejects.toThrow();

      // 本 sandbox 内不得出现任何越界写入（escaped 与 plugins 平级，是逃逸落点）
      expect(existsSync(join(sandbox, "escaped"))).toBe(false);
      // 插件目录内也不应留下含穿越片段的条目
      expect(readdirSync(pluginDir).some((n) => n.includes(".."))).toBe(false);
    } finally {
      db.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("非法字符的 id（路径分隔符 / 绝对路径）被拒", async () => {
    const { db, registry, sandbox } = mkRegistry();
    try {
      const src = join(sandbox, "src-bad");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "index.js"), "export const x = 1;\n");

      for (const badId of ["a/b", "a\\b", "/abs/path", "..", "."]) {
        await expect(registry.install(manifest(badId), src)).rejects.toThrow();
      }
    } finally {
      db.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("恶意 entry（../../payload.js）在安装期即被拒，越界模块从未执行", async () => {
    const { db, registry, sandbox } = mkRegistry();
    try {
      // 在插件目录之外放一个会被"加载即执行"的模块
      const marker = join(sandbox, "PWNED_BY_ENTRY");
      const payload = join(sandbox, "payload.js");
      writeFileSync(
        payload,
        `import { writeFileSync } from "fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nexport default { tools: [] };\n`,
      );

      const src = join(sandbox, "src-entry");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "index.js"), "export default { tools: [] };\n");

      // 安装期即须拒绝（entry 声明就含 ".."）——比"启用期拒绝"更早、更安全
      await expect(
        registry.install(manifest("entry-escape", "../../payload.js"), src),
      ).rejects.toThrow();

      // 关键：越界模块从未被执行
      expect(existsSync(marker)).toBe(false);
      // 且该插件不应被登记
      expect(registry.get("entry-escape")).toBeUndefined();
    } finally {
      db.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("合法 id 与 entry 仍可正常安装并启用（不得误伤正常插件）", async () => {
    const { db, registry, toolRegistry, sandbox } = mkRegistry();
    try {
      const src = join(sandbox, "src-good");
      mkdirSync(src, { recursive: true });
      writeFileSync(
        join(src, "index.js"),
        "export default { tools: [{ name: 'good_ping', description: 'p', inputSchema: { type: 'object' }, handler: async () => ({ ok: true }) }] };\n",
      );

      const installed = await registry.install(manifest("good-plugin", "index.js"), src, { enable: true });
      expect(installed.manifest.id).toBe("good-plugin");
      expect(registry.get("good-plugin")?.status).toBe("enabled");
      expect(toolRegistry.getToolNames()).toContain("good_ping");
    } finally {
      db.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
