/**
 * MCP 服务器入口 v2.2
 * 基于 @modelcontextprotocol/sdk，使用 ToolRegistry 统一注册，消除 stdio/HTTP 重复
 *
 * 所有记忆操作通过 Obsidian Vault 文件系统进行，确保所有 Agent 共享同一记忆库。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installCodeIndexPort } from "../codeindex/codegraph-port.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { DataPipeline } from "../crawl/data-pipeline.js";
import { searchAggregator } from "../crawl/search-engines.js";
import { SerpApiClient } from "../crawl/serpapi-client.js";
import { getGlobalVault } from "../memory/vault-manager.js";
import { withRetry, withTimeout } from "../utils/resilience.js";
import { logger } from "../utils/logger.js";
import { checkApiKey, isLocalAddress } from "../utils/auth-check.js";
import { localBypassEnabled } from "../utils/security-defaults.js";
import { TIMEOUTS } from "../constants/timeouts.js";
import { registerVaultTools } from "./server/vault-tools.js";
import { registerWebTools } from "./server/web-tools.js";
import { registerSkillTools } from "./server/skill-tools.js";
import { DEFAULT_SKILL_DIRS } from "../skills/types.js";
import { registerDreTools, shutdownKernel, invokeRemoteDreTool } from "./server/dre-tools.js";
import { registerKgTools } from "./server/kg-tools.js";
import { registerCodeAgentTools } from "./server/code-agent-tools.js";
import { registerHermesTools } from "./server/hermes-tools.js";
import { registerRouterTools } from "./server/router-tools.js";
import { registerDbTools } from "./server/db-tools.js";
import { registerSafetyTools } from "./server/safety-tools.js";
import { registerLspTools } from "./server/lsp-tools.js";
import { registerTokenTools } from "./server/token-tools.js";
import { registerModeTools } from "./server/mode-tools.js";
import { registerArenaTools } from "./server/arena-tools.js";
import { registerPromptTools } from "./server/prompt-tools.js";
import { registerOrchestratorTools } from "./server/orchestrator-tools.js";
import { registerNativeTools } from "./server/native-tools.js";
import { initializeComponentKernel } from "../agents/component-bootstrap.js";
import { credentialPrincipal, runAsCallPrincipal } from "../utils/call-context.js";
import { registerSceneTools } from "./server/scene-tools.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  createSnapshot,
  revertSnapshot,
  listSnapshots,
  diffSnapshot,
  getSnapshotStatus,
} from "./tools/workspace-snapshot.js";
import { registerGitHubTools } from "./server/github-tools.js";
import { getProxyStatus } from "../utils/adaptive-proxy.js";
import { registerExternalTools } from "./register-external-tools.js";
import { readString } from "../utils/env.js";
import { adaptTools } from "./adapt-tool.js";
import { readTool } from "../tools/read-tool.js";
import { writeTool } from "../tools/write-tool.js";
import { queryTool } from "../tools/query-tool.js";
import {
  RecoverableOutputStore,
  wrapWithRecoverableOutput,
  DEFAULT_MAX_ENTRY_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
} from "../components/recoverable-output.js";
import { registerRecoverableOutputTools } from "./server/recoverable-output-tools.js";
import { registerMindTools } from "./server/mind-tools.js";
import { registerBrowserTools } from "./server/browser-tools.js";
import { registerDocumentTools } from "./server/document-tools.js";
import { enableKnowledgeEmbeddingIndex } from "../services/knowledge-embedding-index.js";
import { applySqliteConcurrencyPragmas } from "../utils/sqlite-pragmas.js";


const dbPath = readString("DATABASE_PATH", "./data/agent.db");
const db = new Database(dbPath);
// 多进程写基线：MCP 与主服务可能同时写 agent.db，须 busy_timeout 防 SQLITE_BUSY（见 src/utils/sqlite-pragmas.ts）
applySqliteConcurrencyPragmas(db);
// ADR-013：装配代码索引端口（外围 codeindex 实现注入内核 memory 的接口槽）。
// 轮 7 审计：自 import 间移至 db 装配区——原位置在模块求值极早期拉起
// codeindex→local-index→bun:sqlite 依赖链，先于 DATABASE_PATH 读取。
installCodeIndexPort();
// 写入侧语义索引装配（2026-09-21）：未授权/无路由时零成本；详见 services/knowledge-embedding-index.ts
enableKnowledgeEmbeddingIndex(db);

// 初始化 Vault（共享记忆库）
const vault = getGlobalVault();

const mcp = new McpServer({
  name: "Axiom Agent MCP Server",
  version: "2.9.2",
});

// ===== 工具定义（单一事实来源） =====

// 真懒加载开关（2026-09-18，T3）：
// 默认关闭 → tools/list 行为与历史逐字节一致。
// AXIOM_MCP_LAZY_TOOLS=1 → tools/list 只下发 tool_search/tool_describe/tool_invoke，
// 其余工具定义在客户端显式取用前不进入上下文（小模型场景的 token 成本主项）。
const lazyTools = readString("AXIOM_MCP_LAZY_TOOLS", "0") === "1";
const registry = new ToolRegistry({ lazy: lazyTools });
const recoverableOutputStore = new RecoverableOutputStore({
  maxEntries: Number(readString("AXIOM_EXTERNAL_RECOVERABLE_MAX_ENTRIES", "1000")) || 1000,
  ttlMs: Number(readString("AXIOM_EXTERNAL_RECOVERABLE_TTL_MS", String(60 * 60 * 1000))) || 60 * 60 * 1000,
  maxEntryBytes:
    Number(readString("AXIOM_EXTERNAL_RECOVERABLE_MAX_ENTRY_BYTES", String(DEFAULT_MAX_ENTRY_BYTES))) ||
    DEFAULT_MAX_ENTRY_BYTES,
  maxTotalBytes:
    Number(readString("AXIOM_EXTERNAL_RECOVERABLE_MAX_TOTAL_BYTES", String(DEFAULT_MAX_TOTAL_BYTES))) ||
    DEFAULT_MAX_TOTAL_BYTES,
});
registerRecoverableOutputTools(registry, recoverableOutputStore);

// Register self-contained external tools (MiniMax / fs / terminal / git / code-analysis).
// Moved to mcp/register-external-tools.ts to reduce this file from ~3500 to ~3200 lines.
// Remaining internal tools (memory, scene, pipeline, dre, kg, persona …) follow below.
registerExternalTools(registry);

// -- Pipeline 通用工具 (缓存优先/循环检测/进度/资源限制) --
for (const td of adaptTools([readTool, writeTool, queryTool])) registry.add(td);

registerVaultTools(registry, vault);

const pipeline = new DataPipeline();
registerWebTools(registry, pipeline);

// -- SerpAPI 深度搜索工具 --
registry.add({
  name: "serpapi_search",
  capability: ["net.outbound", "fs.write", "db.write"],
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

registerGitHubTools(registry);

registry.add({
  name: "serpapi_search_and_crawl",
  capability: ["net.outbound", "fs.write", "db.write"],
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

registerCodeAgentTools(registry);

registerHermesTools(registry);

registerRouterTools(registry);

registerDbTools(registry, db);

// S4 HITL 真值标注管道：hallucination_feedback（校准闭环人工入口）
registerSafetyTools(registry, db);

registerLspTools(registry);

// -- Skill 管理工具 (extracted to server/skill-tools.ts) --
// SKILL_DIR 环境变量可覆盖首目录；其余沿用统一默认列表（W3 修复）
const skillDirs = [
  readString("SKILL_DIR", "./skills"),
  ...DEFAULT_SKILL_DIRS.filter((d) => d !== "./skills"),
];
registerSkillTools(registry, skillDirs);

registerTokenTools(registry);

registerModeTools(registry);

// ===== Workspace Snapshot 工具 =====

registry.add({
  name: "snapshot_create",
  capability: ["proc.exec", "fs.read", "fs.write"],
  payloadFields: { "proc.exec": "fixed" },
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
  capability: ["proc.exec", "fs.read", "fs.write"],
  payloadFields: { "proc.exec": "fixed" },
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
  capability: ["proc.exec"],
  payloadFields: { "proc.exec": "fixed" },
  description: "列出所有工作区快照",
  inputSchema: {},
  handler: async () => {
    return await listSnapshots();
  },
});

registry.add({
  name: "snapshot_diff",
  capability: ["proc.exec", "fs.read", "fs.write"],
  payloadFields: { "proc.exec": "fixed" },
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
  capability: ["proc.exec"],
  payloadFields: { "proc.exec": "fixed" },
  description: "获取快照系统状态",
  inputSchema: {},
  handler: async () => {
    return { success: true, ...getSnapshotStatus() };
  },
});

registerArenaTools(registry);

registerPromptTools(registry);

registerOrchestratorTools(registry);

await initializeComponentKernel();
registerNativeTools(registry);

// ===== DRE 工具 (extracted to server/dre-tools.ts) =====
registerDreTools(registry, { forward: (name, args) => invokeRemoteDreTool(name, args) });
registerMindTools(registry, { forward: (name, args) => invokeRemoteDreTool(name, args) });
registerBrowserTools(registry);
registerDocumentTools(registry);

// ===== KG / DIP / KAL 工具 (extracted to server/kg-tools.ts) =====
registerKgTools(registry, db);

// ===== 补充缺失的工具 =====

registry.add({
  name: "proxy_status",
  capability: ["internal"],
  description: "获取代理状态信息",
  inputSchema: {},
  handler: async () => {
    try {
      const status = getProxyStatus();
      return { success: true, data: status };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
});



// -- 场景路由工具 (extracted to server/scene-tools.ts) --
registerSceneTools(registry);

// ===== 进程退出清理 =====

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`[MCP] Received ${signal}, shutting down...`);
  try {
    await shutdownKernel();
  } catch (err) {
    logger.warn("[MCP] Shutdown error", { error: (err as Error).message });
  }
  process.exit(0);
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

// ===== 启动服务器 =====

const transport = process.argv.includes("--stdio") ? "stdio" : "http";
const externalMode = process.argv.includes("--external");
const recoverableThresholdBytes = Number(readString("AXIOM_EXTERNAL_RECOVERABLE_THRESHOLD", "8192")) || 8192;
const externalTools = externalMode
  ? registry.filterByExposure(["external", "safe-external"]).map((tool) =>
      wrapWithRecoverableOutput(tool, recoverableOutputStore, recoverableThresholdBytes)
    )
  : undefined;

if (transport === "stdio") {
  // stdio 传输：外部模式仅注册 exposure 工具
  registry.registerWithMcp(mcp, externalTools);
  const stdio = new StdioServerTransport();
  mcp.connect(stdio);
} else {
  // HTTP 传输：SDK Streamable HTTP（2026-07-26 替换自制 JSON-RPC-over-POST）
  // 兼容性：Claude Code / Codex CLI / Cursor 等标准 MCP 远程客户端可直接连接；
  // 自制协议缺失 inputSchema、notifications/initialized、协议协商，已废弃。
  // 无状态模式：SDK 要求每请求新建 server+transport（注册为纯内存操作，开销可忽略）。
  const port = Number(readString("MCP_PORT", "3001"));
  // 安全（2026-07-26 审查修复）：
  // - 默认仅绑定回环（MCP_HOST=0.0.0.0 才暴露网络，此前 Bun 默认 0.0.0.0 全无认证）
  // - 与网关一致的认证：远程必须 x-api-key（AXIOM_AUTH_TOKEN 未配置时 fail-closed）；
  //   回环豁免与网关共用同一开关且默认关闭（S3 / L6），本机进程不再有第二条免鉴权入口
  const hostname = readString("MCP_HOST", "127.0.0.1");
  const apiKey = readString("AXIOM_AUTH_TOKEN");
  const allowLocalBypass = localBypassEnabled(process.env);

  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  );

  Bun.serve({
    port,
    hostname,
    async fetch(req, server) {
      const remoteAddr = server.requestIP(req)?.address;
      if (!checkApiKey(req, allowLocalBypass && isLocalAddress(remoteAddr), apiKey)) {
        logger.warn("[MCP] Unauthorized request rejected", { remote: remoteAddr });
        return Response.json({ error: "Unauthorized — invalid or missing API key" }, { status: 401 });
      }
      const reqServer = new McpServer({ name: "Axiom Agent MCP Server", version: "2.9.2" });
      registry.registerWithMcp(reqServer, externalTools);
      const httpTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await reqServer.connect(httpTransport);
      // 主体标注（R3-③ / I4）：SDK 在 handleRequest 内同步把消息交给 onmessage，
      // 工具执行链由此派生 ⇒ 异步上下文能穿透到守卫。无凭证（回环豁免）落 anonymous 桶。
      const response = await runAsCallPrincipal(
        credentialPrincipal(req.headers),
        () => httpTransport.handleRequest(req),
      );
      // 无状态模式下每请求新建 server+transport（SDK 要求）；请求结束（响应体流尽或
      // 客户端中途断开）时 close，释放 _streamMapping/_requestResponseMap 与监听器，
      // 避免长生命周期进程下逐请求累积。
      const body = response.body;
      if (!body) return response;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          void httpTransport.close();
        } catch {}
        try {
          void reqServer.close();
        } catch {}
      };
      const passthrough = new TransformStream<Uint8Array, Uint8Array>();
      void body.pipeTo(passthrough.writable).then(release, release);
      return new Response(passthrough.readable, response);
    },
  });
  logger.info(
    `[MCP] Server running on http://${hostname}:${port} (streamable-http, auth: ${
      apiKey
        ? allowLocalBypass
          ? "x-api-key required, except loopback bypass is ON"
          : "x-api-key required for all requests"
        : "FAIL-CLOSED no token"
    })`,
  );
}
