/**
 * MCP 服务器入口 v2.2
 * 基于 @modelcontextprotocol/sdk，使用 ToolRegistry 统一注册，消除 stdio/HTTP 重复
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
import { VaultManager } from "../memory/vault-manager.js";
import { withRetry, withTimeout } from "../utils/resilience.js";
import { TIMEOUTS } from "../constants/timeouts.js";
import {
  openCodeSession,
  checkOpenCode,
  listOpenCodeModels,
  OPENCODE_FREE_MODELS,
  getOpenCodeInstallGuide,
  executeCodeGenerate,
  executeCodeRefactor,
  executeCodeReview,
  executeCodeTest,
} from "../agents/opencode-agent.js";
import {
  runHermesTask,
  deepResearch,
  checkHermes,
  getHermesInstallGuide,
  codeReview,
} from "../agents/hermes-agent.js";
import {
  readFile,
  writeFile,
  listDirectory,
  searchFiles,
  deleteFile,
  moveFile,
} from "./tools/filesystem.js";
import {
  executeCommand,
  listProcesses,
  getSystemInfo,
} from "./tools/terminal.js";
import {
  gitStatus,
  gitDiff,
  gitLog,
  gitBranch,
  gitBlame,
} from "./tools/git.js";
import {
  findSymbols,
  findReferences,
  getDiagnostics,
  getFileOutline,
  analyzeCode,
  getQuickDiagnostics,
  getCodeActions,
  detectLanguage,
} from "./tools/code-analysis.js";
import {
  loadSkillsFromDirectories,
  saveSkillFile,
  createSkillFileBoilerplate,
  clearSkillCache,
} from "../skills/skill-loader.js";
import { router } from "../router/model-router.js";
import { getTokenTracker } from "../router/token-tracker.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  createSnapshot,
  revertSnapshot,
  listSnapshots,
  diffSnapshot,
  getSnapshotStatus,
} from "./tools/workspace-snapshot.js";
import {
  executionMode,
  type ExecutionMode,
  TOOL_CLASSIFICATIONS,
} from "../agents/execution-mode.js";
import { getConstitutionForMode } from "../agents/constitution.js";
import {
  minimaxWebSearch,
  minimaxImageUnderstand,
  checkMiniMaxHealth,
  getMiniMaxInfo,
} from "./tools/minimax.js";

const dbPath = process.env.DATABASE_PATH || "./data/agent.db";
const db = new Database(dbPath);

// 初始化 Vault（共享记忆库）
const vault = new VaultManager();

const mcp = new McpServer({
  name: "OpenClaw Agent MCP Server",
  version: "2.2.0",
});

// ===== 工具定义（单一事实来源） =====

const registry = new ToolRegistry();

// -- Vault 核心记忆工具 --
registry.add({
  name: "memory_search",
  description: "确定性搜索 Vault 中的记忆笔记（关键词 + PARA + 标签 + 关系推导）",
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
      path: r.note.path,
      title: r.note.title,
      score: r.score,
      reasons: r.reasons,
      excerpt: r.excerpt,
      tags: r.note.tags,
    }));
  },
});

registry.add({
  name: "memory_read",
  description: "读取指定路径的 Vault 笔记",
  inputSchema: {
    path: z.string().describe("笔记路径，如 '00-Meta/SOUL.md'"),
  },
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
      title: args.title as string,
      type: args.type as string,
      tags: args.tags as string[],
      source: args.source as string,
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
      context: args.context as string,
      relatedNotes: args.relatedNotes as string[],
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
    return {
      center: args.path,
      relatedNotes: network.notes.map((n) => n.title),
      relationships: network.relationships,
    };
  },
});

registry.add({
  name: "memory_stats",
  description: "Vault 记忆库统计",
  inputSchema: {},
  handler: async () => vault.stats(),
});

// -- 代码索引工具 --
registry.add({
  name: "code_index",
  description: "将项目源代码索引到 Vault（所有 Agent 可共享检索）",
  inputSchema: {},
  handler: async () => {
    const result = await vault.indexCode();
    return { indexed: result.indexed, errors: result.errors };
  },
});

// -- 结构化数据采集工具 --
registry.add({
  name: "web_fetch",
  description: "抓取网页并提取结构化数据（自动写入 Vault 记忆库）",
  inputSchema: { url: z.string().url().describe("目标 URL") },
  handler: async (args) => {
    const pipeline = new DataPipeline();
    const result = await pipeline.crawlStructured(args.url as string);
    if (!result) return { error: "Failed to fetch URL" };
    return {
      url: result.url,
      title: result.title,
      description: result.description,
      headings: result.headings.length,
      tables: result.tables.length,
      codeBlocks: result.codeBlocks.length,
      images: result.images.length,
      savedToVault: true,
    };
  },
});

registry.add({
  name: "web_search",
  description: "多引擎搜索（结果自动写入 Vault）",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    engines: z.array(z.string()).optional().describe("引擎列表"),
    num: z.number().optional().default(10).describe("每个引擎数量"),
  },
  handler: async (args) => {
    const pipeline = new DataPipeline();
    return pipeline.searchMulti(args.query as string, {
      engines: args.engines as string[],
      num: args.num as number,
    });
  },
});

registry.add({
  name: "search_engines_list",
  description: "列出可用搜索引擎",
  inputSchema: {},
  handler: async () => searchAggregator.listEngines(),
});

// -- SerpAPI 深度搜索工具 --
registry.add({
  name: "serpapi_search",
  description: "使用 SerpAPI 执行 Google 深度搜索，结果以结构化 Markdown 保存到 Vault，含完整原始 JSON",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    location: z.string().optional().describe("地理位置"),
    lang: z.string().optional().default("en").describe("界面语言"),
    region: z.string().optional().default("us").describe("国家代码"),
    num: z.number().optional().default(10).describe("结果数量 1-100"),
    safe: z.enum(["active", "off"]).optional().default("active").describe("安全搜索"),
    timeRange: z.string().optional().describe("时间范围"),
    site: z.string().optional().describe("限定站点"),
    saveToVault: z.boolean().optional().default(true).describe("是否保存到 Vault"),
  },
  handler: async (args) => {
    const client = new SerpApiClient();
    const start = performance.now();
    const response = await client.search({
      q: args.query as string,
      location: args.location as string,
      hl: args.lang as string,
      gl: args.region as string,
      num: Math.min((args.num as number) || 10, 100),
      safe: args.safe as "active" | "off",
      ...(args.timeRange ? { tbs: args.timeRange as string } : {}),
      ...(args.site ? { as_sitesearch: args.site as string } : {}),
    });
    const latency = Math.round(performance.now() - start);

    let vaultPath = "";
    if (args.saveToVault !== false) {
      vaultPath = await vault.writeSerpApiResult(args.query as string, response as Record<string, unknown>, {
        location: args.location as string,
        lang: args.lang as string,
        region: args.region as string,
        latencyMs: latency,
      });
    }

    try {
      db.run(
        `INSERT INTO search_history (query, query_hash, engines, results_count, top_result_url, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          args.query as string,
          String(Bun.hash(args.query as string)),
          "serpapi:google",
          response.organic_results?.length ?? 0,
          (response.organic_results?.[0]?.link as string | null) ?? null,
          latency,
          Date.now(),
        ]
      );
    } catch { /* ignore */ }

    return {
      query: args.query,
      search_id: response.search_metadata?.id ?? null,
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
  },
});

// -- MiniMax MCP 工具（网络搜索 + 图像识别）--
// 若订阅了 MiniMax Token Plan，可使用同一 API Key 同时调用模型和 MCP 工具
registry.add({
  name: "minimax_web_search",
  description: "MiniMax 网络搜索（实时搜索结果，支持中文优化）",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    num: z.number().optional().default(10).describe("返回结果数量"),
    lang: z.string().optional().default("zh").describe("搜索语言"),
  },
  handler: async (args) => {
    const result = await minimaxWebSearch(args.query as string, {
      num: args.num as number,
      lang: args.lang as string,
    });
    return {
      success: result.success,
      query: result.query,
      total_results: result.totalResults,
      results: result.results.map((r) => ({
        title: r.title,
        link: r.link,
        snippet: r.snippet,
        displayed_url: r.displayedUrl,
        date: r.date,
      })),
    };
  },
});

registry.add({
  name: "minimax_image_understand",
  description: "MiniMax 图像识别（分析图像内容，支持 URL 或 base64）",
  inputSchema: {
    image: z.string().describe("图像 URL 或 base64 编码数据"),
    prompt: z.string().optional().describe("自定义提示词（可选）"),
  },
  handler: async (args) => {
    const result = await minimaxImageUnderstand(args.image as string, {
      prompt: args.prompt as string,
    });
    return {
      success: result.success,
      description: result.result?.description,
      objects: result.result?.objects,
      text: result.result?.text,
      scenes: result.result?.scenes,
      error: result.error,
    };
  },
});

registry.add({
  name: "minimax_health",
  description: "检查 MiniMax API 连接状态",
  inputSchema: {},
  handler: async () => {
    const health = await checkMiniMaxHealth();
    const info = getMiniMaxInfo();
    return {
      ok: health.ok,
      latency_ms: health.latency,
      error: health.error,
      configured: info.configured,
      base_url: info.baseUrl,
      has_token_plan: info.hasTokenPlan,
    };
  },
});

registry.add({
  name: "serpapi_search_and_crawl",
  description: "SerpAPI 搜索 + 自动爬取前 N 个结果",
  inputSchema: {
    query: z.string().describe("搜索关键词"),
    location: z.string().optional().describe("地理位置"),
    lang: z.string().optional().default("en").describe("界面语言"),
    region: z.string().optional().default("us").describe("国家代码"),
    num: z.number().optional().default(10).describe("搜索结果数量"),
    crawlTopN: z.number().optional().default(3).describe("爬取前 N 个结果"),
    safe: z.enum(["active", "off"]).optional().default("active").describe("安全搜索"),
  },
  handler: async (args) => {
    const client = new SerpApiClient();
    const pipeline = new DataPipeline();
    const searchStart = performance.now();
    const response = await client.search({
      q: args.query as string,
      location: args.location as string,
      hl: args.lang as string,
      gl: args.region as string,
      num: Math.min((args.num as number) || 10, 100),
      safe: args.safe as "active" | "off",
    });
    const searchLatency = Math.round(performance.now() - searchStart);

    const vaultPath = await vault.writeSerpApiResult(args.query as string, response as Record<string, unknown>, {
      location: args.location as string,
      lang: args.lang as string,
      region: args.region as string,
      latencyMs: searchLatency,
    });

    const organic = (response.organic_results || []).slice(0, Math.min((args.crawlTopN as number) || 3, 10));
    const crawled: Array<{ url: string; title: string; success: boolean; error?: string }> = [];

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
      } catch (e: unknown) {
        crawled.push({ url: item.link, title: item.title || item.link, success: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    try {
      db.run(
        `INSERT INTO search_history (query, query_hash, engines, results_count, top_result_url, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [args.query as string, String(Bun.hash(args.query as string)), "serpapi:google+crawl", organic.length, (organic[0]?.link as string | null) ?? null, searchLatency, Date.now()]
      );
    } catch { /* ignore */ }

    return {
      query: args.query,
      search_id: response.search_metadata?.id ?? null,
      search_vault_path: vaultPath,
      organic_count: organic.length,
      crawled_count: crawled.filter((c) => c.success).length,
      failed_count: crawled.filter((c) => !c.success).length,
      crawled,
    };
  },
});

// -- 编码 Agent 工具 --
registry.add({
  name: "code_generate",
  description: "使用 AI 模型生成代码（自动注入 CodeGraph 上下文，支持免费模型）",
  inputSchema: {
    prompt: z.string().describe("代码生成需求描述"),
    language: z.string().optional().describe("编程语言"),
    context: z.string().optional().describe("现有代码上下文"),
    model: z.string().optional().describe("模型名称"),
  },
  handler: async (args) => {
    const result = await executeCodeGenerate({
      prompt: args.prompt as string,
      language: args.language as string | undefined,
      context: args.context as string | undefined,
      model: args.model as string | undefined,
    });
    return result;
  },
});

registry.add({
  name: "code_refactor",
  description: "使用 AI 模型重构代码（自动注入 CodeGraph 上下文）",
  inputSchema: {
    code: z.string().describe("要重构的代码"),
    description: z.string().describe("重构需求描述"),
    language: z.string().optional().describe("编程语言"),
  },
  handler: async (args) => {
    const result = await executeCodeRefactor({
      code: args.code as string,
      description: args.description as string,
      language: args.language as string | undefined,
    });
    return result;
  },
});

registry.add({
  name: "code_review",
  description: "使用 AI 模型审查代码（优先 GLM-5.1）",
  inputSchema: {
    code: z.string().describe("要审查的代码"),
    language: z.string().optional().describe("编程语言"),
    context: z.string().optional().describe("代码上下文"),
  },
  handler: async (args) => {
    const result = await executeCodeReview({
      code: args.code as string,
      language: args.language as string | undefined,
      context: args.context as string | undefined,
    });
    return result;
  },
});

registry.add({
  name: "code_test",
  description: "使用 AI 模型生成测试用例",
  inputSchema: {
    code: z.string().describe("要测试的代码"),
    language: z.string().optional().describe("编程语言"),
    framework: z.string().optional().describe("测试框架"),
  },
  handler: async (args) => {
    const result = await executeCodeTest({
      code: args.code as string,
      language: args.language as string | undefined,
      framework: args.framework as string | undefined,
    });
    return result;
  },
});

registry.add({
  name: "opencode_status",
  description: "检查 OpenCode Agent 状态和可用模型",
  inputSchema: {},
  handler: async () => {
    const available = await checkOpenCode();
    const models = available ? await listOpenCodeModels() : [];
    return { installed: available, freeModels: OPENCODE_FREE_MODELS, allModels: models.slice(0, 50) };
  },
});

// -- Hermes 工具 --
registry.add({
  name: "project_research",
  description: "使用 Hermes Agent 进行深度研究",
  inputSchema: {
    topic: z.string().describe("研究主题"),
    cwd: z.string().optional().describe("工作目录"),
  },
  handler: async (args) => {
    const result = await deepResearch(args.topic as string, args.cwd as string);
    return { success: result.success, output: result.stdout, errors: result.stderr };
  },
});

registry.add({
  name: "hermes_status",
  description: "检查 Hermes Agent 安装状态",
  inputSchema: {},
  handler: async () => {
    const available = await checkHermes();
    return { installed: available, installGuide: available ? "Hermes is ready" : "Run: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash" };
  },
});

// -- 模型路由工具 --
registry.add({
  name: "model_chat",
  description: "通过多平台路由器发送聊天请求",
  inputSchema: {
    taskType: z.enum(["general-chat", "code-generation", "complex-reasoning"]).describe("任务类型"),
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })).describe("消息列表"),
  },
  handler: async (args) => {
    const messages = (args.messages as Array<{ role: string; content: string }>).map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));
    const result = await router.chat(args.taskType as string, messages);
    return { content: result.content || "" };
  },
});

// -- 数据库工具 --
registry.add({
  name: "db_query",
  description: "执行 SQLite 查询（只读）",
  inputSchema: {
    sql: z.string().describe("SELECT 查询语句"),
    params: z.array(z.any()).optional().default([]),
  },
  handler: async (args) => {
    const normalized = (args.sql as string).trim().toLowerCase();
    if (!normalized.startsWith("select")) {
      return { error: "Only SELECT queries are allowed" };
    }
    try {
      return db.query(args.sql as string).all(...((args.params || []) as (string | number | boolean | null)[]));
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

registry.add({
  name: "list_free_models",
  description: "列出当前可用的免费模型",
  inputSchema: {},
  handler: async () => {
    return db.query("SELECT id, name, provider, context_length FROM free_models WHERE is_available = 1").all();
  },
});

// -- 文件系统工具 --
registry.add({
  name: "fs_read",
  description: "读取文件内容（支持偏移和限制）",
  inputSchema: {
    path: z.string().describe("文件路径"),
    offset: z.number().optional().describe("起始行偏移"),
    limit: z.number().optional().describe("最大读取行数"),
  },
  handler: async (args) => readFile(args.path as string, { offset: args.offset as number, limit: args.limit as number }),
});

registry.add({
  name: "fs_write",
  description: "写入或追加文件内容",
  inputSchema: {
    path: z.string().describe("文件路径"),
    content: z.string().describe("写入内容"),
    append: z.boolean().optional().describe("是否追加模式"),
  },
  handler: async (args) => writeFile(args.path as string, args.content as string, { append: args.append as boolean }),
});

registry.add({
  name: "fs_list",
  description: "列出目录内容",
  inputSchema: {
    path: z.string().optional().describe("目录路径，默认当前目录"),
  },
  handler: async (args) => listDirectory((args.path as string) || "."),
});

registry.add({
  name: "fs_search",
  description: "在文件中搜索内容",
  inputSchema: {
    query: z.string().describe("搜索关键词或正则表达式"),
    path: z.string().optional().describe("搜索目录，默认当前目录"),
    maxResults: z.number().optional().describe("最大结果数"),
  },
  handler: async (args) => searchFiles(args.query as string, { path: args.path as string, maxResults: args.maxResults as number }),
});

registry.add({
  name: "fs_delete",
  description: "删除文件或目录",
  inputSchema: {
    path: z.string().describe("要删除的路径"),
  },
  handler: async (args) => deleteFile(args.path as string),
});

registry.add({
  name: "fs_move",
  description: "移动或重命名文件",
  inputSchema: {
    source: z.string().describe("源路径"),
    destination: z.string().describe("目标路径"),
  },
  handler: async (args) => moveFile(args.source as string, args.destination as string),
});

// -- 终端工具 --
registry.add({
  name: "terminal_exec",
  description: "执行终端命令（有安全检查）",
  inputSchema: {
    command: z.string().describe("要执行的命令"),
    cwd: z.string().optional().describe("工作目录"),
    timeout: z.number().optional().describe("超时毫秒数"),
  },
  handler: async (args) => executeCommand(args.command as string, { cwd: args.cwd as string, timeout: args.timeout as number }),
});

registry.add({
  name: "terminal_list",
  description: "列出当前进程",
  inputSchema: {},
  handler: async () => listProcesses(),
});

registry.add({
  name: "terminal_info",
  description: "获取系统信息",
  inputSchema: {},
  handler: async () => getSystemInfo(),
});

// -- Git 工具 --
registry.add({
  name: "git_status",
  description: "获取 Git 仓库状态",
  inputSchema: {
    repoPath: z.string().optional().describe("仓库路径，默认当前目录"),
  },
  handler: async (args) => gitStatus(args.repoPath as string),
});

registry.add({
  name: "git_diff",
  description: "获取 Git diff",
  inputSchema: {
    repoPath: z.string().optional().describe("仓库路径"),
    target: z.string().optional().describe("对比目标（commit/branch）"),
    filePath: z.string().optional().describe("指定文件路径"),
    staged: z.boolean().optional().describe("是否只看 staged"),
  },
  handler: async (args) => gitDiff(args.repoPath as string, { since: args.target as string, file: args.filePath as string, staged: args.staged as boolean }),
});

registry.add({
  name: "git_log",
  description: "获取 Git 提交历史",
  inputSchema: {
    repoPath: z.string().optional().describe("仓库路径"),
    maxCount: z.number().optional().describe("最大提交数"),
    filePath: z.string().optional().describe("指定文件"),
  },
  handler: async (args) => gitLog(args.repoPath as string, { maxCount: args.maxCount as number, file: args.filePath as string }),
});

registry.add({
  name: "git_branch",
  description: "获取 Git 分支信息",
  inputSchema: {
    repoPath: z.string().optional().describe("仓库路径"),
  },
  handler: async (args) => gitBranch(args.repoPath as string),
});

registry.add({
  name: "git_blame",
  description: "获取文件 Git blame 信息",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
    repoPath: z.string().optional().describe("仓库路径"),
  },
  handler: async (args) => gitBlame((args.repoPath as string) || ".", args.filePath as string),
});

// -- 代码分析工具 --
registry.add({
  name: "code_symbols",
  description: "查找代码中的符号（函数、类、接口等）",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
    type: z.enum(["function", "class", "interface", "type", "variable", "export"]).optional().describe("符号类型过滤"),
  },
  handler: async (args) => {
    const result = await findSymbols(args.filePath as string);
    const filterType = args.type as string;
    if (filterType && result.success && result.symbols) {
      result.symbols = result.symbols.filter((s: any) => s.type === filterType);
    }
    return result;
  },
});

registry.add({
  name: "code_references",
  description: "查找符号引用",
  inputSchema: {
    symbol: z.string().describe("符号名称"),
    path: z.string().optional().describe("搜索目录"),
  },
  handler: async (args) => findReferences(args.symbol as string, args.path as string),
});

registry.add({
  name: "code_diagnostics",
  description: "获取 TypeScript 诊断信息",
  inputSchema: {
    filePath: z.string().optional().describe("指定文件路径，默认全项目"),
  },
  handler: async (args) => getDiagnostics(args.filePath as string),
});

registry.add({
  name: "code_outline",
  description: "获取文件代码大纲",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
  },
  handler: async (args) => getFileOutline(args.filePath as string),
});

registry.add({
  name: "code_analyze",
  description: "分析代码复杂度、依赖和 TODO",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
  },
  handler: async (args) => analyzeCode(args.filePath as string),
});

// -- LSP 增强工具 --

registry.add({
  name: "code_quick_diagnostics",
  description: "快速诊断单个文件（使用增量检查，更快）",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
  },
  handler: async (args) => getQuickDiagnostics(args.filePath as string),
});

registry.add({
  name: "code_actions",
  description: "获取代码修复建议（Code Actions）",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
  },
  handler: async (args) => getCodeActions(args.filePath as string),
});

registry.add({
  name: "code_detect_language",
  description: "检测文件编程语言",
  inputSchema: {
    filePath: z.string().describe("文件路径"),
  },
  handler: async (args) => ({
    success: true,
    language: detectLanguage(args.filePath as string),
    filePath: args.filePath,
  }),
});

// -- Skill 管理工具 --
const skillDirs = [
  process.env.SKILL_DIR || "./skills",
  "./openclaw-memory/03-Resources/skills",
];

registry.add({
  name: "skill_list",
  description: "列出所有已加载的 skills 和 prompt templates",
  inputSchema: {
    includeBuiltin: z.boolean().optional().default(true).describe("是否包含内置 skills"),
    includeFile: z.boolean().optional().default(true).describe("是否包含从文件加载的 skills"),
  },
  handler: async (args) => {
    const loaded = loadSkillsFromDirectories({ skillDirs });
    const includeBuiltin = args.includeBuiltin !== false;
    const includeFile = args.includeFile !== false;

    const skills = Array.from(loaded.skills.values())
      .filter((s) => {
        if (s.source === "builtin" && !includeBuiltin) return false;
        if (s.source === "file" && !includeFile) return false;
        return true;
      })
      .map((s) => ({
        id: s.id, name: s.name, description: s.description,
        triggers: s.triggers, outputFormat: s.outputFormat,
        version: s.version, source: s.source, filePath: s.filePath,
      }));

    const templates = Array.from(loaded.templates.values())
      .filter((t) => {
        if (t.source === "builtin" && !includeBuiltin) return false;
        if (t.source === "file" && !includeFile) return false;
        return true;
      })
      .map((t) => ({
        id: t.id, name: t.name, category: t.category,
        description: t.description, variables: t.variables,
        tags: t.tags, version: t.version, source: t.source, filePath: t.filePath,
      }));

    return { skills, templates, errors: loaded.errors };
  },
});

registry.add({
  name: "skill_reload",
  description: "重新从磁盘加载所有 skill 文件",
  inputSchema: {},
  handler: async () => {
    clearSkillCache();
    const loaded = loadSkillsFromDirectories({ skillDirs }, true);
    return {
      success: true,
      skillsLoaded: loaded.skills.size,
      templatesLoaded: loaded.templates.size,
      errors: loaded.errors,
    };
  },
});

registry.add({
  name: "skill_create",
  description: "创建新的 skill 文件",
  inputSchema: {
    filePath: z.string().describe("skill 文件路径（.json 或 .yaml）"),
    name: z.string().describe("skill 名称"),
    description: z.string().describe("skill 描述"),
    author: z.string().optional().describe("作者"),
  },
  handler: async (args) => {
    const boilerplate = createSkillFileBoilerplate({
      name: args.name as string,
      description: args.description as string,
      author: args.author as string | undefined,
    });
    saveSkillFile(args.filePath as string, boilerplate);
    return { success: true, filePath: args.filePath, boilerplate };
  },
});

// -- Token 使用统计工具 --
registry.add({
  name: "token_stats",
  description: "获取总体 token 使用统计（调用次数、token 消耗、成功率、延迟）",
  inputSchema: {
    since: z.number().optional().describe("起始时间戳（毫秒）"),
    until: z.number().optional().describe("结束时间戳（毫秒）"),
  },
  handler: async (args) => {
    const tracker = getTokenTracker();
    const stats = tracker.getOverallStats({
      since: args.since as number | undefined,
      until: args.until as number | undefined,
    });
    return stats;
  },
});

registry.add({
  name: "token_stats_by_model",
  description: "按模型统计 token 使用情况",
  inputSchema: {
    since: z.number().optional().describe("起始时间戳（毫秒）"),
    limit: z.number().optional().default(20).describe("返回模型数量"),
  },
  handler: async (args) => {
    const tracker = getTokenTracker();
    const stats = tracker.getStatsByModel({
      since: args.since as number | undefined,
      limit: args.limit as number | undefined,
    });
    return stats;
  },
});

registry.add({
  name: "token_stats_by_role",
  description: "按角色统计 token 使用情况",
  inputSchema: {
    since: z.number().optional().describe("起始时间戳（毫秒）"),
    limit: z.number().optional().default(20).describe("返回角色数量"),
  },
  handler: async (args) => {
    const tracker = getTokenTracker();
    const stats = tracker.getStatsByRole({
      since: args.since as number | undefined,
      limit: args.limit as number | undefined,
    });
    return stats;
  },
});

registry.add({
  name: "token_daily_stats",
  description: "按天统计 token 使用情况",
  inputSchema: {
    days: z.number().optional().default(7).describe("最近多少天"),
  },
  handler: async (args) => {
    const tracker = getTokenTracker();
    const stats = tracker.getDailyStats(args.days as number | undefined);
    return stats;
  },
});

// -- 执行模式管理工具 (CodeWhale-inspired) --
registry.add({
  name: "set_mode",
  description: "切换执行模式: plan(只读调查) / agent(默认,需审批) / yolo(自动批准)",
  inputSchema: {
    mode: z.enum(["plan", "agent", "yolo"]).describe("目标执行模式"),
    reason: z.string().optional().describe("切换原因"),
  },
  handler: async (args) => {
    const mode = args.mode as ExecutionMode;
    const previous = executionMode.getMode();
    executionMode.setMode(mode);
    return {
      success: true,
      previous,
      current: mode,
      reason: args.reason as string | undefined,
      config: executionMode.getConfig(),
      constitution: getConstitutionForMode(mode),
    };
  },
});

registry.add({
  name: "get_mode",
  description: "获取当前执行模式和宪法",
  inputSchema: {},
  handler: async () => {
    const mode = executionMode.getMode();
    return {
      mode,
      config: executionMode.getConfig(),
      constitution: getConstitutionForMode(mode),
      history: executionMode.getModeHistory(),
    };
  },
});

registry.add({
  name: "list_mode_tools",
  description: "列出当前模式下允许使用的工具",
  inputSchema: {
    category: z.string().optional().describe("按分类过滤"),
    risk: z.enum(["safe", "caution", "destructive"]).optional().describe("按风险等级过滤"),
  },
  handler: async (args) => {
    const tools = executionMode.getAllowedTools();
    let filtered = tools;
    if (args.category) {
      filtered = filtered.filter((t) => t.category === args.category);
    }
    if (args.risk) {
      filtered = filtered.filter((t) => t.risk === args.risk);
    }
    return {
      mode: executionMode.getMode(),
      total: TOOL_CLASSIFICATIONS.length,
      allowed: tools.length,
      filtered: filtered.length,
      tools: filtered.map((t) => ({
        name: t.name,
        risk: t.risk,
        category: t.category,
        description: t.description,
      })),
    };
  },
});

registry.add({
  name: "revert_mode",
  description: "回退到上一个执行模式",
  inputSchema: {},
  handler: async () => {
    const previous = executionMode.getMode();
    const current = executionMode.revertMode();
    return {
      success: true,
      previous,
      current,
      constitution: getConstitutionForMode(current),
    };
  },
});

// ===== Workspace Snapshot 工具 =====

registry.add({
  name: "snapshot_create",
  description: "创建工作区快照（保存当前所有文件状态）",
  inputSchema: {
    message: z.string().optional().describe("快照说明信息"),
  },
  handler: async (args: { message?: string }) => {
    return await createSnapshot(args.message);
  },
});

registry.add({
  name: "snapshot_revert",
  description: "回退到指定快照",
  inputSchema: {
    snapshotId: z.string().describe("快照ID（commit hash）"),
  },
  handler: async (args: Record<string, unknown>) => {
    return await revertSnapshot(args.snapshotId as string);
  },
});

registry.add({
  name: "snapshot_list",
  description: "列出所有工作区快照",
  inputSchema: {},
  handler: async () => {
    return await listSnapshots();
  },
});

registry.add({
  name: "snapshot_diff",
  description: "查看快照差异",
  inputSchema: {
    snapshotId: z.string().optional().describe("快照ID，不提供则对比最近两次快照"),
  },
  handler: async (args: { snapshotId?: string }) => {
    return await diffSnapshot(args.snapshotId);
  },
});

registry.add({
  name: "snapshot_status",
  description: "获取快照系统状态",
  inputSchema: {},
  handler: async () => {
    return { success: true, ...getSnapshotStatus() };
  },
});

// ===== 启动服务器 =====

const transport = process.argv.includes("--stdio") ? "stdio" : "http";

if (transport === "stdio") {
  // stdio 传输：注册所有工具
  registry.registerWithMcp(mcp);
  const stdio = new StdioServerTransport();
  mcp.connect(stdio);
} else {
  // HTTP 传输：构建 handlers 和 meta
  const toolHandlers = registry.buildHttpHandlers();
  const toolsMeta = registry.getToolsMeta();
  const port = Number(process.env.MCP_PORT) || 3001;

  Bun.serve({
    port,
    async fetch(req) {
      if (req.method !== "POST") return Response.json({ error: "Only POST supported" }, { status: 405 });
      try {
        const body = await req.json();
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0", id: body.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "OpenClaw Agent MCP Server", version: "2.2.0" },
            },
          });
        }
        if (body.method === "initialized") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
        }
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0", id: body.id,
            result: { tools: toolsMeta },
          });
        }
        if (body.method === "tools/call") {
          const { name, arguments: args } = body.params;
          const handler = toolHandlers[name];
          if (!handler) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              error: { code: -32602, message: `Tool '${name}' not found` },
            }, { status: 400 });
          }

          // Execution mode enforcement
          const modeCheck = executionMode.canExecute(name);
          if (!modeCheck.allowed) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text" as const, text: `Blocked: ${modeCheck.reason}` }],
                isError: true,
              },
            });
          }

          try {
            const result = await withTimeout(
              withRetry(() => handler(args || {}), { maxAttempts: 2, baseDelay: 500 }),
              TIMEOUTS.MCP_TOOL_DEFAULT
            );
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
              },
            });
          } catch (err) {
            return Response.json({
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
                isError: true,
              },
            });
          }
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
    },
  });
  console.log(`[MCP] Server running on http://localhost:${port}`);
}
