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
import { SerpApiClient } from "../crawl/serpapi-client.js";
import { proxyManager } from "../crawl/proxy-manager.js";
import { VaultManager } from "../memory/vault-manager.js";
import { KnowledgeGraph } from "../kg/graph.js";
import {
  openCodeSession,
  checkOpenCode,
  listOpenCodeModels,
  OPENCODE_FREE_MODELS,
  getOpenCodeInstallGuide,
} from "../agents/opencode-agent.js";
import {
  runHermesTask,
  planProject,
  deepResearch,
  architectureReview,
  checkHermes,
  getHermesInstallGuide,
} from "../agents/hermes-agent.js";

const dbPath = process.env.DATABASE_PATH || "./data/agent.db";
const db = new Database(dbPath);

// 初始化 Vault（共享记忆库）
const vault = new VaultManager();
const kg = new KnowledgeGraph(dbPath);

const mcp = new McpServer({
  name: "OpenClaw Agent MCP Server",
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

// ===== SerpAPI 深度搜索工具 =====

mcp.registerTool("serpapi_search", {
  description: "使用 SerpAPI 执行 Google 深度搜索，结果以结构化 Markdown 保存到 Vault，含完整原始 JSON",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    location: z.string().optional().describe("地理位置，如 'Austin, Texas, United States'"),
    lang: z.string().optional().default("en").describe("界面语言，如 zh-CN、en"),
    region: z.string().optional().default("us").describe("国家代码，如 cn、us"),
    num: z.number().optional().default(10).describe("结果数量 1-100"),
    safe: z.enum(["active", "off"]).optional().default("active").describe("安全搜索"),
    timeRange: z.string().optional().describe("时间范围，如 qdr:d(一天内), qdr:w(一周内), qdr:m(一月内), qdr:y(一年内)"),
    site: z.string().optional().describe("限定站点，如 'github.com'"),
    saveToVault: z.boolean().optional().default(true).describe("是否保存到 Vault"),
  },
}, async ({ query, location, lang, region, num, safe, timeRange, site, saveToVault }) => {
  const client = new SerpApiClient();
  const start = performance.now();
  const response = await client.search({
    q: query,
    location,
    hl: lang,
    gl: region,
    num: Math.min(num, 100),
    safe,
    ...(timeRange ? { tbs: timeRange } : {}),
    ...(site ? { as_sitesearch: site } : {}),
  });
  const latency = Math.round(performance.now() - start);

  let vaultPath = "";
  if (saveToVault) {
    vaultPath = await vault.writeSerpApiResult(query, response as Record<string, unknown>, {
      location,
      lang,
      region,
      latencyMs: latency,
    });
  }

  // 记录到 SQLite
  try {
    db.run(
      `INSERT INTO search_history (query, query_hash, engines, results_count, top_result_url, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        query,
        String(Bun.hash(query)),
        "serpapi:google",
        response.organic_results?.length ?? 0,
        response.organic_results?.[0]?.link || null,
        latency,
        Date.now(),
      ]
    );
  } catch { /* ignore */ }

  const summary = {
    query,
    search_id: response.search_metadata?.id,
    organic_count: response.organic_results?.length ?? 0,
    knowledge_graph: !!response.knowledge_graph,
    related_questions: response.related_questions?.length ?? 0,
    related_searches: response.related_searches?.length ?? 0,
    images: response.images_results?.length ?? 0,
    videos: response.videos_results?.length ?? 0,
    news: response.news_results?.length ?? 0,
    latency_ms: latency,
    vault_path: vaultPath || null,
  };

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(summary, null, 2),
    }],
  };
});

mcp.registerTool("serpapi_search_and_crawl", {
  description: "SerpAPI 搜索 + 自动爬取前 N 个结果，搜索和爬取结果均保存到 Vault",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    location: z.string().optional().describe("地理位置"),
    lang: z.string().optional().default("en").describe("界面语言"),
    region: z.string().optional().default("us").describe("国家代码"),
    num: z.number().optional().default(10).describe("搜索结果数量"),
    crawlTopN: z.number().optional().default(3).describe("爬取前 N 个结果（最多 10）"),
    safe: z.enum(["active", "off"]).optional().default("active").describe("安全搜索"),
  },
}, async ({ query, location, lang, region, num, crawlTopN, safe }) => {
  const client = new SerpApiClient();
  const pipeline = new DataPipeline();

  // 1. 搜索
  const searchStart = performance.now();
  const response = await client.search({
    q: query,
    location,
    hl: lang,
    gl: region,
    num: Math.min(num, 100),
    safe,
  });
  const searchLatency = Math.round(performance.now() - searchStart);

  const vaultPath = await vault.writeSerpApiResult(query, response as Record<string, unknown>, {
    location,
    lang,
    region,
    latencyMs: searchLatency,
  });

  // 2. 爬取前 N 个有机结果
  const organic = (response.organic_results || []).slice(0, Math.min(crawlTopN, 10));
  const crawled: Array<{ url: string; title: string; success: boolean; vaultPath?: string; error?: string }> = [];

  for (const item of organic) {
    if (!item.link) continue;
    try {
      const result = await pipeline.crawlStructured(item.link);
      if (result) {
        await pipeline.saveCrawlResult(result);
        crawled.push({ url: item.link, title: result.title, success: true });
      } else {
        crawled.push({ url: item.link, title: item.title || item.link, success: false, error: "Crawl returned null" });
      }
    } catch (e: any) {
      crawled.push({ url: item.link, title: item.title || item.link, success: false, error: e.message });
    }
  }

  // 3. 记录搜索历史
  try {
    db.run(
      `INSERT INTO search_history (query, query_hash, engines, results_count, top_result_url, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [query, String(Bun.hash(query)), "serpapi:google+crawl", organic.length, organic[0]?.link || null, searchLatency, Date.now()]
    );
  } catch { /* ignore */ }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        query,
        search_id: response.search_metadata?.id,
        search_vault_path: vaultPath,
        organic_count: organic.length,
        crawled_count: crawled.filter((c) => c.success).length,
        failed_count: crawled.filter((c) => !c.success).length,
        crawled,
      }, null, 2),
    }],
  };
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

// ===== 编码 Agent 工具 (OpenCode) =====
// OpenCode 是交互式 TUI，非交互环境下提供状态检查和指导

mcp.registerTool("code_generate", {
  description: "使用 OpenCode Agent 生成代码（支持免费模型 deepseek-v4-flash-free）。注意：OpenCode 是交互式工具，需在终端运行 bun run src/cli.ts code:open",
  inputSchema: {
    prompt: z.string().describe("代码生成需求描述"),
    model: z.string().optional().describe("模型名称（默认 opencode/deepseek-v4-flash-free）"),
  },
}, async ({ prompt, model }) => {
  const available = await checkOpenCode();
  if (!available) {
    return { content: [{ type: "text" as const, text: getOpenCodeInstallGuide() }] };
  }
  const m = model || OPENCODE_FREE_MODELS[0];
  return {
    content: [{
      type: "text" as const,
      text: `OpenCode 已安装。请在交互式终端中运行以下命令生成代码：\n\n  bun run src/cli.ts code:open "${prompt.replace(/"/g, '\\"')}" --model=${m}\n\n免费模型推荐: ${OPENCODE_FREE_MODELS.join(", ")}`,
    }],
  };
});

mcp.registerTool("code_refactor", {
  description: "使用 OpenCode Agent 重构代码。需在终端交互式运行。",
  inputSchema: {
    description: z.string().describe("重构需求"),
    filePath: z.string().optional().describe("目标文件路径"),
    model: z.string().optional().describe("模型名称"),
  },
}, async ({ description, filePath, model }) => {
  const available = await checkOpenCode();
  if (!available) {
    return { content: [{ type: "text" as const, text: getOpenCodeInstallGuide() }] };
  }
  const m = model || OPENCODE_FREE_MODELS[0];
  const fileArg = filePath ? ` --file=${filePath}` : "";
  return {
    content: [{
      type: "text" as const,
      text: `请在交互式终端中运行：\n\n  bun run src/cli.ts code:open "重构: ${description.replace(/"/g, '\\"')}" --model=${m}${fileArg}`,
    }],
  };
});

mcp.registerTool("code_review", {
  description: "使用 OpenCode Agent 审查代码。需在终端交互式运行。",
  inputSchema: {
    filePath: z.string().describe("要审查的文件路径"),
    model: z.string().optional().describe("模型名称"),
  },
}, async ({ filePath, model }) => {
  const available = await checkOpenCode();
  if (!available) {
    return { content: [{ type: "text" as const, text: getOpenCodeInstallGuide() }] };
  }
  const m = model || OPENCODE_FREE_MODELS[0];
  return {
    content: [{
      type: "text" as const,
      text: `请在交互式终端中运行：\n\n  bun run src/cli.ts code:open "审查代码: ${filePath}" --model=${m}\n\n或直接打开 OpenCode：\n  bun run src/cli.ts code:open --model=${m}`,
    }],
  };
});

mcp.registerTool("code_test", {
  description: "使用 OpenCode Agent 运行测试。需在终端交互式运行。",
  inputSchema: {
    testCommand: z.string().optional().describe("测试命令（如 bun test）"),
  },
}, async ({ testCommand }) => {
  const available = await checkOpenCode();
  if (!available) {
    return { content: [{ type: "text" as const, text: getOpenCodeInstallGuide() }] };
  }
  return {
    content: [{
      type: "text" as const,
      text: `请在交互式终端中运行：\n\n  bun run src/cli.ts code:open "运行测试${testCommand ? ": " + testCommand : ""}"`,
    }],
  };
});

mcp.registerTool("opencode_status", {
  description: "检查 OpenCode Agent 状态和可用模型",
  inputSchema: {},
}, async () => {
  const available = await checkOpenCode();
  const models = available ? await listOpenCodeModels() : [];
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ installed: available, freeModels: OPENCODE_FREE_MODELS, allModels: models.slice(0, 50), cliCommand: "bun run src/cli.ts code:open" }, null, 2),
    }],
  };
});

// ===== 项目管理 Agent 工具 (Hermes) =====

mcp.registerTool("project_plan", {
  description: "使用 Hermes Agent 创建项目任务计划",
  inputSchema: {
    description: z.string().describe("项目描述"),
    cwd: z.string().optional().describe("工作目录"),
  },
}, async ({ description, cwd }) => {
  const result = await planProject(description, cwd);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ success: result.success, output: result.stdout, errors: result.stderr }, null, 2),
    }],
  };
});

mcp.registerTool("project_research", {
  description: "使用 Hermes Agent 进行深度研究",
  inputSchema: {
    topic: z.string().describe("研究主题"),
    cwd: z.string().optional().describe("工作目录"),
  },
}, async ({ topic, cwd }) => {
  const result = await deepResearch(topic, cwd);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ success: result.success, output: result.stdout, errors: result.stderr }, null, 2),
    }],
  };
});

mcp.registerTool("project_arch_review", {
  description: "使用 Hermes Agent 进行架构审查",
  inputSchema: {
    projectPath: z.string().optional().describe("项目路径（默认当前目录）"),
    cwd: z.string().optional().describe("工作目录"),
  },
}, async ({ projectPath, cwd }) => {
  const result = await architectureReview(projectPath, cwd);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ success: result.success, output: result.stdout, errors: result.stderr }, null, 2),
    }],
  };
});

mcp.registerTool("hermes_status", {
  description: "检查 Hermes Agent 安装状态",
  inputSchema: {},
}, async () => {
  const available = await checkHermes();
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ installed: available, installGuide: available ? "Hermes is ready" : "Run: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash" }, null, 2),
    }],
  };
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
              { name: "code_generate", description: "OpenCode 代码生成" },
              { name: "code_refactor", description: "OpenCode 代码重构" },
              { name: "code_review", description: "OpenCode 代码审查" },
              { name: "code_test", description: "OpenCode 运行测试" },
              { name: "opencode_status", description: "OpenCode 状态检查" },
              { name: "project_plan", description: "Hermes 项目计划" },
              { name: "project_research", description: "Hermes 深度研究" },
              { name: "project_arch_review", description: "Hermes 架构审查" },
              { name: "hermes_status", description: "Hermes 状态检查" },
            ],
          },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
    },
  });
  console.log(`[MCP] Server running on http://localhost:${port}`);
}
