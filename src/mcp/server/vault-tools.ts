import { z } from "zod";
import type { ToolDef, ToolRegistry } from "../tool-registry.js";
import type { VaultManager } from "../../memory/vault-manager.js";

export function registerVaultTools(registry: ToolRegistry, vault: VaultManager): void {
  registry.add({
    name: "memory_search",
    description: "确定性搜索 Vault 中的记忆笔记（关键词 + PARA + 标签 + 关系推导）",
    exposure: ["external", "safe-external"],
    inputSchema: {
      query: z.string().describe("搜索关键词"),
      limit: z.number().optional().default(10).describe("返回结果数量"),
      types: z.array(z.string()).optional().describe("按 frontmatter.type 过滤"),
      tags: z.array(z.string()).optional().describe("必须包含的标签"),
      paraCategory: z.enum(["projects", "areas", "resources", "archives", "conversations", "meta"]).optional().describe("PARA 分类"),
    },
    handler: async (args) => {
      const results = vault.search(args.query as string, {
        limit: args.limit as number,
        types: args.types as string[],
        tags: args.tags as string[],
        paraCategory: args.paraCategory as string,
      });
      return results.map((r) => ({
        path: r.note.path, title: r.note.title, score: r.score,
        reasons: r.reasons, excerpt: r.excerpt, tags: r.note.tags,
      }));
    },
  });

  registry.add({
    name: "memory_read",
    description: "读取指定路径的 Vault 笔记",
    exposure: ["external", "safe-external"],
    inputSchema: { path: z.string().describe("笔记路径，如 '00-Meta/SOUL.md'") },
    handler: async (args) => {
      const note = vault.readNote(args.path as string);
      if (!note) return { error: "Note not found" };
      return { path: args.path, frontmatter: note.frontmatter, content: note.content.slice(0, 5000) };
    },
  });

  registry.add({
    name: "memory_write",
    description: "写入 Vault 笔记（自动处理 frontmatter 和路径）",
    inputSchema: {
      path: z.string().describe("笔记路径"),
      content: z.string().describe("Markdown 内容"),
      title: z.string().optional().describe("标题（写入 frontmatter）"),
      type: z.string().optional().describe("笔记类型"),
      tags: z.array(z.string()).optional().describe("标签列表"),
      source: z.string().optional().describe("来源 URL 或引用"),
      overwrite: z.boolean().optional().default(false).describe("是否覆盖"),
    },
    handler: async (args) => {
      const written = await vault.writeNote(args.path as string, args.content as string, {
        title: args.title as string, type: args.type as string,
        tags: args.tags as string[], source: args.source as string,
        overwrite: args.overwrite as boolean,
      });
      return { savedTo: written };
    },
  });

  registry.add({
    name: "memory_atomic",
    description: "写入原子笔记（Zettelkasten 风格）",
    inputSchema: {
      title: z.string().describe("笔记标题"),
      idea: z.string().describe("核心观点（不超过 300 字）"),
      context: z.string().optional().describe("上下文说明"),
      relatedNotes: z.array(z.string()).optional().describe("关联笔记标题（wiki-link 格式）"),
      tags: z.array(z.string()).optional().describe("标签"),
    },
    handler: async (args) => {
      const notePath = await vault.writeAtomicNote(args.title as string, args.idea as string, {
        context: args.context as string, relatedNotes: args.relatedNotes as string[],
        tags: args.tags as string[],
      });
      return { notePath };
    },
  });

  registry.add({
    name: "memory_browse",
    description: "按 PARA 分类或标签浏览 Vault 笔记",
    inputSchema: {
      by: z.enum(["para", "tag"]).describe("浏览方式"),
      value: z.string().describe("分类名或标签名"),
      limit: z.number().optional().default(20).describe("数量限制"),
    },
    handler: async (args) => {
      const notes = args.by === "para"
        ? vault.browsePara(args.value as string).slice(0, (args.limit as number) || 20)
        : vault.browseTag(args.value as string).slice(0, (args.limit as number) || 20);
      return notes.map((n) => ({ path: n.path, title: n.title, tags: n.tags, modifiedAt: n.modifiedAt }));
    },
  });

  registry.add({
    name: "memory_network",
    description: "获取 Vault 笔记的关联网络（wiki-link 1-2 跳）",
    inputSchema: {
      path: z.string().describe("笔记路径"),
      depth: z.number().optional().default(1).describe("遍历深度（1-2）"),
    },
    handler: async (args) => {
      const network = vault.getNetwork(args.path as string, Math.min((args.depth as number) || 1, 2));
      return { center: args.path, relatedNotes: network.notes.map((n) => n.title), relationships: network.relationships };
    },
  });

  registry.add({
    name: "memory_stats",
    description: "Vault 记忆库统计",
    inputSchema: {},
    handler: async () => vault.stats(),
  });

  registry.add({
    name: "code_index",
    description: "将项目源代码索引到 Vault（所有 Agent 可共享检索）",
    inputSchema: {},
    handler: async () => {
      const result = await vault.indexCode();
      return { indexed: result.indexed, errors: result.errors };
    },
  });
}

