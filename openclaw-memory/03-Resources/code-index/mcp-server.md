---
id: code-mcp.server
type: code-index
source: mcp\server.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 1451
tags: [code, auto-indexed]
imports: ["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/server/stdio.js", "zod", "bun:sqlite", "crawl-data-pipeline.js", "crawl-search-engines.js", "crawl-proxy-manager.js", "memory-vault-manager.js", "kg-graph.js"]
---

# mcp.server

## 元信息

- **源文件**: `mcp\server.ts`
- **模块**: `mcp.server`
- **行数**: 358
- **索引时间**: 2026-05-25T05:11:12.535Z

## 依赖

- [[@modelcontextprotocol-sdk-server-mcp.js]]
- [[@modelcontextprotocol-sdk-server-stdio.js]]
- [[zod]]
- [[bun:sqlite]]
- [[crawl-data-pipeline.js]]
- [[crawl-search-engines.js]]
- [[crawl-proxy-manager.js]]
- [[memory-vault-manager.js]]
- [[kg-graph.js]]

## 代码

```typescript
/**
 * MCP 服务器入口 v2.1
 * 基于 @modelcontextprotocol/sdk，暴露 Vault 核心记忆、确定性搜索、知识图谱等工具
 *
 * 所有记忆操作通过 Obsidian Vault 文件系统进行，确保所有 Agent 共享同一记忆库。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { DataPipeline } from "../crawl/data-pipeline.js";
import { searchAggregator } from "../crawl/search-engines.js";
import { proxyManager } from "../crawl/proxy-manager.js";
import { VaultManager } from "../memory/vault-manager.js";
import { KnowledgeGraph } from "../kg/graph.js";

const dbPath = process.env.DATABASE_PATH || "./data/agent.db";
const db = new Database(dbPath);

// 初始化 Vault（共享记忆库）
const vault = new VaultManager();
const kg = new KnowledgeGraph(dbPath);

const mcp = new McpServer({
  name: "Axiom Agent MCP Server",
  version: "2.1.0",
});

// ===== Vault 核心记忆工具 =====

mcp.registerTool("memory_search", {
  description: "确定性搜索 Vault 中的记忆笔记（关键词 + PARA + 标签 + 关系推导）",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    limit: z.number().optional().default(10).describe("返回结果数量"),
    types: z.array(z.string()).optional().describe("按 frontmatter.type 过滤"),
    tags: z.array(z.string()).optional().describe("必须包含的标签"),
    paraCategory: z.enum(["projects", "areas", "resources", "archives", "conversations", "meta"]).optional().describe("PARA 分类"),
  },
}, async ({ query, limit, types, tags, paraCategory }) => {
  const results = vault.search(query, { limit, types, tags, paraCategory });
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(results.map((r) => ({
        path: r.note.path,
        title: r.note.title,
        score: r.score,
        reasons: r.reasons,
        excerpt: r.excerpt,
        tags: r.note.tags,
      })), null, 2),
    }],
  };
});

mcp.registerTool("memory_read", {
  description: "读取指定路径的 Vault 笔记",
  inputSchema: {
    path: z.string().describe("笔记路径，如 '00-Meta/SOUL.md'"),
  },
}, async ({ path }) => {
  const note = vault.readNote(path);
  if (!note) {
    return { content: [{ type: "text" as const, text: "Note not found" }] };
  }
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ path, frontmatter: note.frontmatter, content: note.content.slice(0, 5000) }, null, 2),
    }],
  };
});

mcp.registerTool("memory_write", {
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
}, async ({ path, content, title, type, tags, source, overwrite }) => {
  const written = await vault.writeNote(path, content, { title, type, tags, source, overwrite });
  return { content: [{ type: "text" as const, text: `Saved to ${written}` }] };
});

mcp.registerTool("memory_atomic", {
  description: "写入原子笔记（Zettelkasten 风格）",
  inputSchema: {
    title: z.string().describe("笔记标题"),
    idea: z.string().describe("核心观点（不超过 300 字）"),
    context: z.string().optional().describe("上下文说明"),
    relatedNotes: z.array(z.string()).optional().describe("关联笔记标题（wiki-link 格式）"),
    tags: z.array(z.string()).optional().describe("标签"),
  },
}, async ({ title, idea, context, relatedNotes, tags }) => {
  const notePath = await vault.writeAtomicNote(title, idea, { context, relatedNotes, tags });
  return { content: [{ type: "text" as const, text: `Atomic note created: ${notePath}` }] };
});

mcp.registerTool("memory_browse", {
  description: "按 PARA 分类或标签浏览 Vault 笔记",
  inputSchema: {
    by: z.enum(["para", "tag"]).describe("浏览方式"),
    value: z.string().describe("分类名或标签名"),
    limit: z.number().optional().default(20).describe("数量限制"),
  },
}, async ({ by, value, limit }) => {
  const notes = by === "para"
    ? vault.browsePara(value).slice(0, limit)
    : vault.browseTag(value).slice(0, limit);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(notes.map((n) => ({ path: n.path, title: n.title, tags: n.tags, modifiedAt: n.modifiedAt })), null, 2),
    }],
  };
});

mcp.registerTool("memory_network", {
  description: "获取 Vault 笔记的关联网络（wiki-link 1-2 跳）",
  inputSchema: {
    path: z.string().describe("笔记路径"),
    depth: z.number().optional().default(1).describe("遍历深度（1-2）"),
  },
}, async ({ path, depth }) => {
  const network = vault.getNetwork(path, Math.min(depth, 2));
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        center: path,
        relatedNotes: network.notes.map((n) => n.title),
        relationships: network.relationships,
      }, null, 2),
    }],
  };
});

mcp.registerTool("memory_stats", {
  description: "Vault 记忆库统计",
  inputSchema: {},
}, async () => {
  const stats = vault.stats();
  return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
});

// ===== 代码索引工具 =====

mcp.registerTool("code_index", {
  description: "将项目源代码索引到 Vault（所有 Agent 可共享检索）",
  inputSchema: {},
}, async () => {
  const result = await vault.indexCode();
  return { content: [{ type: "text" as const, text: `Indexed ${result.indexed} files. Errors: ${result.errors.join(", ") || "none"}` }] };
});

// ===== 结构化数据采集工具 =====

mcp.registerTool("web_fetch", {
  description: "抓取网页并提取结构化数据（自动写入 Vault 记忆库）",
  inputSchema: { url: z.string().url().describe("目标 URL") },
}, async ({ url }) => {
  const pipeline = new DataPipeline();
  const result = await pipeline.crawlStructured(url);
  if (!result) return { content: [{ type: "text" as const, text: "Failed to fetch URL" }] };
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        url: result.url, title: result.title, description: result.description,
        headings: result.headings.length, tables: result.tables.length,
        codeBlocks: result.codeBlocks.length, images: result.images.length,
        savedToVault: true,
      }, null, 2),
    }],
  };
});

mcp.registerTool("web_search", {
  description: "多引擎搜索（结果自动写入 Vault）",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    engines: z.array(z.string()).optional().describe("引擎列表"),
    num: z.number().optional().default(10).describe("每个引擎数量"),
  },
}, async ({ query, engines, num }) => {
  const pipeline = new DataPipeline();
  const results = await pipeline.searchMulti(query, { engines, num });
  return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
});

mcp.registerTool("search_engines_list", {
  description: "列出可用搜索引擎",
  inputSchema: {},
}, async () => {
  return { content: [{ type: "text" as const, text: JSON.stringify(searchAggregator.listEngines(), null, 2) }] };
});

mcp.registerTool("proxy_status", {
  description: "代理池健康状态",
  inputSchema: {},
}, async () => {
  return { content: [{ type: "text" as const, text: `Healthy proxies: ${proxyManager.getHealthyCount()}` }] };
});

// ===== 知识图谱工具 =====

mcp.registerTool("kg_create_entity", {
  description: "在知识图谱中创建实体",
  inputSchema: {
    name: z.string().describe("实体名称"),
    type: z.enum(["person", "org", "concept", "tool", "file", "project", "topic"]).describe("实体类型"),
    properties: z.record(z.any()).optional().describe("属性 JSON"),
  },
}, async ({ name, type, properties }) => {
  const entity = kg.createEntity(name, type, properties);
  return { content: [{ type: "text" as const, text: JSON.stringify(entity, null, 2) }] };
});

mcp.registerTool("kg_create_relationship", {
  description: "创建实体间关系",
  inputSchema: {
    sourceName: z.string().describe("源实体名称"),
    targetName: z.string().describe("目标实体名称"),
    relationType: z.enum(["uses", "depends_on", "part_of", "mentions", "created_by", "related_to", "contains", "references"]).describe("关系类型"),
  },
}, async ({ sourceName, targetName, relationType }) => {
  const src = kg.getEntityByName(sourceName);
  const tgt = kg.getEntityByName(targetName);
  if (!src) return { content: [{ type: "text" as const, text: `Entity not found: ${sourceName}` }] };
  if (!tgt) return { content: [{ type: "text" as const, text: `Entity not found: ${targetName}` }] };
  const rel = kg.createRelationship(src.id, tgt.id, relationType);
  return { content: [{ type: "text" as const, text: JSON.stringify(rel, null, 2) }] };
});

mcp.registerTool("kg_search", {
  description: "搜索知识图谱实体",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    limit: z.number().optional().default(10),
  },
}, async ({ query, limit }) => {
  const results = kg.searchEntities(query, limit);
  return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
});

mcp.registerTool("kg_shortest_path", {
  description: "查找两实体间最短路径",
  inputSchema: {
    fromName: z.string().describe("起始实体名称"),
    toName: z.string().describe("目标实体名称"),
  },
}, async ({ fromName, toName }) => {
  const from = kg.getEntityByName(fromName);
  const to = kg.getEntityByName(toName);
  if (!from) return { content: [{ type: "text" as const, text: `Entity not found: ${fromName}` }] };
  if (!to) return { content: [{ type: "text" as const, text: `Entity not found: ${toName}` }] };
  const path = kg.shortestPath(from.id, to.id);
  return { content: [{ type: "text" as const, text: JSON.stringify(path, null, 2) }] };
});

// ===== 模型路由工具 =====

mcp.registerTool("model_chat", {
  description: "通过多平台路由器发送聊天请求",
  inputSchema: {
    taskType: z.enum(["general-chat", "code-generation", "complex-reasoning"]).describe("任务类型"),
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })).describe("消息列表"),
  },
}, async ({ taskType, messages }) => {
  const { router } = await import("../router/model-router.js");
  const result = await router.chat(taskType, messages);
  return { content: [{ type: "text" as const, text: result.content || "" }] };
});

// ===== 数据库工具 =====

mcp.registerTool("db_query", {
  description: "执行 SQLite 查询（只读）",
  inputSchema: {
    sql: z.string().describe("SELECT 查询语句"),
    params: z.array(z.any()).optional().default([]),
  },
}, async ({ sql, params }) => {
  const normalized = sql.trim().toLowerCase();
  if (!normalized.startsWith("select")) {
    return { content: [{ type: "text" as const, text: "Error: Only SELECT queries are allowed" }] };
  }
  try {
    const rows = db.query(sql).all(...params);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
  }
});

// ===== 免费模型工具 =====

mcp.registerTool("list_free_models", {
  description: "列出当前可用的免费模型",
  inputSchema: {},
}, async () => {
  const rows = db.query("SELECT id, name, provider, context_length FROM free_models WHERE is_available = 1").all();
  return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
});

// 启动服务器
const transport = process.argv.includes("--stdio") ? "stdio" : "http";

if (transport === "stdio") {
  const stdio = new StdioServerTransport();
  mcp.connect(stdio);
} else {
  const port = Number(process.env.MCP_PORT) || 3001;
  Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== "POST") return Response.json({ error: "Only POST supported" }, { status: 405 });
      const body = await req.json();
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0", id: body.id,
          result: {
            tools: [
              { name: "memory_search", description: "Vault 确定性记忆搜索" },
              { name: "memory_read", description: "读取 Vault 笔记" },
              { name: "memory_write", description: "写入 Vault 笔记" },
              { name: "memory_atomic", description: "写入原子笔记" },
              { name: "memory_browse", description: "PARA/标签浏览" },
              { name: "memory_network", description: "笔记关联网络" },
              { name: "memory_stats", description: "Vault 统计" },
              { name: "code_index", description: "索引代码到 Vault" },
              { name: "web_fetch", description: "网页抓取（自动写入 Vault）" },
              { name: "web_search", description: "多引擎搜索（自动写入 Vault）" },
              { name: "search_engines_list", description: "搜索引擎列表" },
              { name: "proxy_status", description: "代理状态" },
              { name: "kg_create_entity", description: "创建 KG 实体" },
              { name: "kg_create_relationship", description: "创建 KG 关系" },
              { name: "kg_search", description: "搜索 KG 实体" },
              { name: "kg_shortest_path", description: "KG 最短路径" },
              { name: "model_chat", description: "模型聊天" },
              { name: "db_query", description: "数据库查询" },
              { name: "list_free_models", description: "免费模型列表" },
            ],
          },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
    },
  });
  console.log(`[MCP] Server running on http://localhost:${port}`);
}

```