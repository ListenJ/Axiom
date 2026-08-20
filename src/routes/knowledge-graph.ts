/**
 * 知识图谱 + 模型顾问 API 路由 (PG 已移除 H-M1-03，SQLite 为唯一后端)
 *
 * Endpoints:
 *   GET  /kg/stats              — 图谱统计 (SQLite)
 *   GET  /kg/entities           — 查询实体 (SQLite)
 *   GET  /kg/entity/:name       — 单个实体详情 + 关系 (SQLite)
 *   GET  /kg/traverse/:name     — 图遍历 (SQLite)
 *   POST /kg/build              — 触发知识图谱构建 (no-op，已迁移)
 *   POST /kg/search             — 语义搜索 (SQLite)
 *
 *   GET  /advisor/recommend     — 模型推荐 (按角色)
 *   GET  /advisor/free-models   — 免费模型列表
 *   POST /advisor/evolve        — 触发进化周期
 *   GET  /advisor/status        — 进化状态
 *
 *   POST /research/run          — 触发 KG 增强的深度研究
 */
import type { RouteContext, RouteHandler } from "./types.js";
import { logger } from "../utils/logger.js";
import { KnowledgeGraphEnhanced } from "../kg/enhanced.js";

// ========== 知识图谱路由 ==========

function getKGEnhanced(db: import("bun:sqlite").Database): KnowledgeGraphEnhanced {
  return new KnowledgeGraphEnhanced(db);
}

export async function handleKGStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/kg/stats" || ctx.req.method !== "GET") return null;

  try {
    const kg = getKGEnhanced(ctx.db);
    const stats = kg.getStats();
    return ctx.jsonResponse({
      success: true,
      backend: "sqlite",
      data: {
        totalNodes: stats.totalNodes,
        totalEdges: stats.totalEdges,
        nodesByKind: stats.nodesByType,
        sources: {},
        nodesByType: stats.nodesByType,
        edgesByType: stats.edgesByType,
        avgDegree: stats.avgDegree,
        communities: stats.communities,
      },
    }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Stats failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleKGEntities(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/kg/entities" || ctx.req.method !== "GET") return null;

  try {
    const kg = getKGEnhanced(ctx.db);
    const type = ctx.url.searchParams.get("type") || undefined;
    const search = ctx.url.searchParams.get("q") || "";
    const limit = parseInt(ctx.url.searchParams.get("limit") || "50");
    const nodes = kg.searchNodes(search, { type: type as any, limit });
    return ctx.jsonResponse({ success: true, backend: "sqlite", data: nodes, count: nodes.length }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Entities query failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleKGEntityDetail(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/kg\/entity\/(.+)$/);
  if (!match || ctx.req.method !== "GET") return null;

  try {
    const kg = getKGEnhanced(ctx.db);
    const name = decodeURIComponent(match[1]);
    const nodes = kg.searchNodes(name, { limit: 1 });
    if (nodes.length === 0) {
      return ctx.jsonResponse({ success: false, error: "Entity not found" }, 404, ctx.baseHeaders);
    }
    const node = nodes[0];
    const subgraph = kg.subgraph(node.id, 2, 50);
    return ctx.jsonResponse({
      success: true,
      backend: "sqlite",
      data: { entity: node, ...subgraph },
    }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Entity detail failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleKGTraverse(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/kg\/traverse\/(.+)$/);
  if (!match || ctx.req.method !== "GET") return null;

  try {
    const kg = getKGEnhanced(ctx.db);
    const name = decodeURIComponent(match[1]);
    const depth = parseInt(ctx.url.searchParams.get("depth") || "2");
    const nodes = kg.searchNodes(name, { limit: 1 });
    if (nodes.length === 0) {
      return ctx.jsonResponse({ success: false, error: "Entity not found" }, 404, ctx.baseHeaders);
    }
    const subgraph = kg.subgraph(nodes[0].id, depth, 100);
    return ctx.jsonResponse({
      success: true,
      backend: "sqlite",
      data: subgraph,
      depth,
      startEntity: name,
    }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Traverse failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

/** KG 构建任务状态（异步 job）。 */
interface KGBuildJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  projectPath: string;
  projectName: string;
  generateEmbeddings: boolean;
  result?: unknown;
  error?: string;
}

const kgBuildJobs = new Map<string, KGBuildJob>();
const KG_JOB_MAX = 20;
/** 单任务队列：同一时刻只允许一个构建（buildKnowledgeGraph 写同一 SQLite）。 */
let activeKgBuildId: string | null = null;

function pruneKgJobs(): void {
  while (kgBuildJobs.size > KG_JOB_MAX) {
    const oldest = [...kgBuildJobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) kgBuildJobs.delete(oldest[0]);
  }
}

async function runKgBuild(job: KGBuildJob): Promise<void> {
  job.status = "running";
  job.startedAt = Date.now();
  try {
    const { buildKnowledgeGraph } = await import("../memory/knowledge-graph-builder.js");
    job.result = await buildKnowledgeGraph({
      projectPath: job.projectPath,
      projectName: job.projectName,
      generateEmbeddings: job.generateEmbeddings,
    });
    job.status = "completed";
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    job.finishedAt = Date.now();
    activeKgBuildId = null;
  }
}

/** POST /kg/build — 提交异步构建任务，立即返回 jobId；GET /kg/jobs/:id 轮询。 */
export async function handleKGBuild(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/kg/build" || ctx.req.method !== "POST") return null;

  try {
    const body = await ctx.req.json().catch(() => ({}));
    const projectPath = typeof body.projectPath === "string" && body.projectPath.trim()
      ? body.projectPath.trim()
      : process.cwd();
    const { existsSync } = await import("node:fs");
    if (!existsSync(projectPath)) {
      return ctx.jsonResponse({ success: false, error: `projectPath not found: ${projectPath}` }, 400, ctx.baseHeaders);
    }
    if (activeKgBuildId) {
      const active = kgBuildJobs.get(activeKgBuildId);
      return ctx.jsonResponse(
        { success: false, error: "A KG build is already running", jobId: activeKgBuildId, jobStatus: active?.status },
        409,
        ctx.baseHeaders,
      );
    }
    const id = `kg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job: KGBuildJob = {
      id,
      status: "queued",
      createdAt: Date.now(),
      projectPath,
      projectName: typeof body.projectName === "string" && body.projectName.trim() ? body.projectName.trim() : "current",
      generateEmbeddings: body.generateEmbeddings === true,
    };
    kgBuildJobs.set(id, job);
    activeKgBuildId = id;
    pruneKgJobs();
    // 后台执行，不阻塞请求（构建可能持续数分钟）
    void runKgBuild(job);
    return ctx.jsonResponse({ success: true, jobId: id, status: job.status, projectPath }, 202, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Build submit failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

/** GET /kg/jobs/:id — 查询构建任务状态/结果。 */
export async function handleKGJobStatus(ctx: RouteContext): Promise<Response | null> {
  const prefix = "/kg/jobs/";
  if (!ctx.url.pathname.startsWith(prefix) || ctx.req.method !== "GET") return null;
  const id = decodeURIComponent(ctx.url.pathname.slice(prefix.length));
  if (!id) return ctx.jsonResponse({ error: "job id required" }, 400, ctx.baseHeaders);
  const job = kgBuildJobs.get(id);
  if (!job) return ctx.jsonResponse({ error: "job not found", jobId: id }, 404, ctx.baseHeaders);
  return ctx.jsonResponse({
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    projectPath: job.projectPath,
    projectName: job.projectName,
    result: job.result ?? undefined,
    error: job.error,
  }, 200, ctx.baseHeaders);
}

/** GET /kg/jobs — 列出最近构建任务（概要）。 */
export async function handleKGJobsList(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/kg/jobs" || ctx.req.method !== "GET") return null;
  const jobs = [...kgBuildJobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((j) => ({ jobId: j.id, status: j.status, createdAt: j.createdAt, projectPath: j.projectPath, projectName: j.projectName }));
  return ctx.jsonResponse({ jobs, count: jobs.length }, 200, ctx.baseHeaders);
}

export async function handleKGSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/kg/search" || ctx.req.method !== "POST") return null;

  try {
    const { buildResearchContext } = await import("../memory/knowledge-graph-builder.js");
    const body = await ctx.req.json();

    const result = await buildResearchContext(body.query || "", {
      projectName: body.projectName,
      maxDepth: body.maxDepth || 2,
      maxEntities: body.maxEntities || 30,
    });

    return ctx.jsonResponse({ success: true, backend: "sqlite", data: result }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Search failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleKGGraph(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/kg/graph" || ctx.req.method !== "GET") return null;

  try {
    const kg = getKGEnhanced(ctx.db);
    const data = kg.toEChartsData({ maxNodes: 200, includeEdges: true });
    return ctx.jsonResponse({
      success: true,
      backend: "sqlite",
      data,
    }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Graph failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

// ========== 模型顾问路由 ==========

export async function handleAdvisorRecommend(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/advisor/recommend" || ctx.req.method !== "GET") return null;

  try {
    const { recommendModels } = await import("../router/model-advisor.js");
    const role = ctx.url.searchParams.get("role") || "general-tool";
    const limit = parseInt(ctx.url.searchParams.get("limit") || "5");

    const recommendations = await recommendModels(role, { limit });
    return ctx.jsonResponse({ success: true, data: recommendations, role }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[AdvisorRoute] Recommend failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleAdvisorFreeModels(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/advisor/free-models" || ctx.req.method !== "GET") return null;

  try {
    const { discoverFreeModels } = await import("../router/model-advisor.js");
    const models = await discoverFreeModels();
    return ctx.jsonResponse({ success: true, data: models, count: models.length }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[AdvisorRoute] Free models failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleAdvisorEvolve(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/advisor/evolve" || ctx.req.method !== "POST") return null;

  try {
    const { runEvolutionCycle } = await import("../router/model-advisor.js");
    const cycle = await runEvolutionCycle();
    return ctx.jsonResponse({ success: true, data: cycle }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[AdvisorRoute] Evolve failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleAdvisorHealth(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/advisor/health" || ctx.req.method !== "GET") return null;
  return ctx.jsonResponse({
    status: "ok",
    models: [],
    timestamp: Date.now(),
  }, 200, ctx.baseHeaders);
}

export async function handleAdvisorStatus(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/advisor/status" || ctx.req.method !== "GET") return null;

  try {
    const { getProxyStatus } = await import("../utils/adaptive-proxy.js");
    const proxyStatus = getProxyStatus();

    return ctx.jsonResponse({
      success: true,
      data: {
        proxy: proxyStatus,
        providers: Object.keys(process.env).filter((k) => k.endsWith("_API_KEY")).length,
        timestamp: new Date().toISOString(),
      },
    }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[AdvisorRoute] Status failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

// ========== 研究路由 ==========

export async function handleResearchRun(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/research/run" || ctx.req.method !== "POST") return null;

  try {
    const { runKnowledgeGraphResearch } = await import("../agents/kg-research-agent.js");
    const body = await ctx.req.json();

    const result = await runKnowledgeGraphResearch({
      query: body.query || "Analyze the project architecture",
      projectName: body.projectName,
      depth: body.depth || "deep",
      model: body.model,
      additionalContext: body.additionalContext,
      timeout: body.timeout || 120000,
    });

    return ctx.jsonResponse({ success: true, data: result }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[ResearchRoute] Run failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}
