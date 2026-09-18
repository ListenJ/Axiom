/**
 * 审计去伪验证（规则 12：「要么补行为，要么撤接口」）
 *
 * 背景：三个内置插件此前注册的工具返回伪造结果 ——
 * `code-analysis-enhanced` 用 `Math.random()` 生成复杂度 / pass-fail / 漏洞 severity / 行号；
 * `doc-generator` 用 `Math.random()` 生成 ADR 编号且不读任何真实文件；
 * `git-workflow-enhanced` 的清单声明了代码中根本不存在的 `manage_git_hooks`（phantom）。
 *
 * 处置：前两者撤掉全部工具注册（`tools: []`），第三者为真实确定性实现故**保留 4 个工具**、
 * 仅移除 phantom 声明；三者都由不可加载的 `.ts` 转为可加载的 `.js`。
 *
 * 本测试证明「接口被保留」是**真的保留**（能装、能启用），而不是又一次"有形状无行为"。
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PluginRegistry } from "../../src/plugins/plugin-registry.js";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";

const REPO = join(import.meta.dir, "..", "..");

function mkRegistry(): { db: Database; registry: PluginRegistry; toolRegistry: ToolRegistry; sandbox: string } {
  const sandbox = mkdtempSync(join(tmpdir(), "plugin-defab-"));
  const db = new Database(":memory:");
  const toolRegistry = new ToolRegistry({ guard: async () => {} });
  const registry = new PluginRegistry(db, toolRegistry, join(sandbox, "plugins"));
  return { db, registry, toolRegistry, sandbox };
}

describe("内置插件去伪：接口保留且真正可加载", () => {
  for (const id of ["code-analysis-enhanced", "doc-generator"]) {
    it(`${id}：可安装且可启用（接口真保留），但注册 0 个工具（伪造行为已撤）`, async () => {
      const { db, registry, toolRegistry, sandbox } = mkRegistry();
      try {
        await registry.installFromPath(join(REPO, "plugins", id), { enable: true });

        // 接口保留：安装成功且状态为 enabled（不再抛 Entry file not found）
        expect(registry.get(id)?.status).toBe("enabled");

        // 伪造行为已撤：不注册任何工具
        const names = toolRegistry.getToolNames();
        const fromThisPlugin = names.filter((n) => n.startsWith(id.replace(/-/g, "_")));
        expect(fromThisPlugin).toEqual([]);
      } finally {
        db.close();
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  }

  it("git-workflow-enhanced：真实实现被保留 —— 注册 4 个工具，且无 phantom manage_git_hooks", async () => {
    const { db, registry, toolRegistry, sandbox } = mkRegistry();
    try {
      await registry.installFromPath(join(REPO, "plugins", "git-workflow-enhanced"), { enable: true });
      expect(registry.get("git-workflow-enhanced")?.status).toBe("enabled");

      const names = toolRegistry.getToolNames();
      // 4 个真实工具（原先因 entry 指向不存在的 index.js 而根本加载不了）
      for (const t of ["generate_branch_name", "generate_commit_message", "generate_pr_template", "update_changelog"]) {
        expect(names).toContain(t);
      }
      // phantom 声明已移除
      expect(names).not.toContain("manage_git_hooks");
    } finally {
      db.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("去伪后的可执行代码不含 Math.random 调用（按解析后的产出判定，非文本扫描）", async () => {
    const { readFileSync } = await import("fs");

    // git-workflow-enhanced：真实实现，转译产物中应完全无 Math.random（连注释都无）
    const gw = readFileSync(join(REPO, "plugins", "git-workflow-enhanced", "index.js"), "utf-8");
    expect(gw).not.toContain("Math.random");

    // code-analysis-enhanced / doc-generator：断言的是**行为**而非文本 ——
    // 启用后工具集为空，即伪造结果无法通过任何工具泄露出来。
    // （文件头与警告文案会"提到" Math.random 作为审计结论，那是文档，不是调用。）
    for (const id of ["code-analysis-enhanced", "doc-generator"]) {
      const { db, registry, toolRegistry, sandbox } = mkRegistry();
      try {
        await registry.installFromPath(join(REPO, "plugins", id), { enable: true });
        expect(registry.get(id)?.status).toBe("enabled");
        // 该插件的 activate() 里不能再有任何 toolRegistry.add 调用生效
        const names = toolRegistry.getToolNames();
        expect(names.filter((n) => !n.startsWith("skill_"))).toEqual([]);
      } finally {
        db.close();
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });
});
