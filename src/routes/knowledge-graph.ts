/**
 * 知识图谱 + 模型顾问 API 路由
 *
 * Endpoints:
 *   GET  /kg/stats              — 图谱统计
 *   GET  /kg/entities           — 查询实体 (支持关键词/类型过滤)
 *   GET  /kg/entity/:name       — 单个实体详情 + 关系
 *   GET  /kg/traverse/:name     — 图遍历 (N度关系)
 *   POST /kg/build              — 触发知识图谱构建
 *   POST /kg/search             — 语义搜索 (需要向量)
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

// ========== 知识图谱路由 ==========

export async function handleKGStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/kg/stats" || ctx.req.method !== "GET") return null;

  try {
    const { getProjectStats } = await import("../db/codegraph-sync.js");
    const stats = await getProjectStats();
    return ctx.jsonResponse({ success: true, data: stats }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Stats failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleKGEntities(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/kg/entities" || ctx.req.method !== "GET") return null;

  try {
    const { isPgAvailable, getPG } = await import("../db/pg-client.js");
    if (!(await isPgAvailable())) {
      return ctx.jsonResponse({ success: false, error: "PostgreSQL not available" }, 503, ctx.baseHeaders);
    }

    const pg = getPG();
    const type = ctx.url.searchParams.get("type");
    const search = ctx.url.searchParams.get("q");
    const limit = parseInt(ctx.url.searchParams.get("limit") || "50");

    let query = "SELECT id, name, type, description, properties, source, created_at FROM kg_entities";
    const conditions: string[] = [];
    const params: any[] = [];

    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
    }

    if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
    query += " ORDER BY updated_at DESC LIMIT $" + (params.length + 1);
    params.push(limit);

    const entities = await pg.unsafe(query, params);
    return ctx.jsonResponse({ success: true, data: entities, count: entities.length }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Entities query failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleKGEntityDetail(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/kg\/entity\/(.+)$/);
  if (!match || ctx.req.method !== "GET") return null;

  try {
    const { isPgAvailable, getPG } = await import("../db/pg-client.js");
    if (!(await isPgAvailable())) {
      return ctx.jsonResponse({ success: false, error: "PostgreSQL not available" }, 503, ctx.baseHeaders);
    }

    const pg = getPG();
    const name = decodeURIComponent(match[1]);

    const [entity] = await pg`
      SELECT * FROM kg_entities WHERE name = ${name}
    `;

    if (!entity) {
      return ctx.jsonResponse({ success: false, error: "Entity not found" }, 404, ctx.baseHeaders);
    }

    // 获取关系
    const relationships = await pg`
      SELECT
        r.relation_type,
        r.weight,
        r.properties,
        CASE WHEN r.source_id = ${entity.id} THEN 'outgoing' ELSE 'incoming' END AS direction,
        CASE WHEN r.source_id = ${entity.id} THEN te.name ELSE se.name END AS other_entity,
        CASE WHEN r.source_id = ${entity.id} THEN te.type ELSE se.type END AS other_type
      FROM kg_relationships r
      JOIN kg_entities se ON se.id = r.source_id
      JOIN kg_entities te ON te.id = r.target_id
      WHERE r.source_id = ${entity.id} OR r.target_id = ${entity.id}
      ORDER BY r.weight DESC
    `;

    return ctx.jsonResponse({
      success: true,
      data: { entity, relationships },
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
    const { isPgAvailable, getPG } = await import("../db/pg-client.js");
    if (!(await isPgAvailable())) {
      return ctx.jsonResponse({ success: false, error: "PostgreSQL not available" }, 503, ctx.baseHeaders);
    }

    const pg = getPG();
    const name = decodeURIComponent(match[1]);
    const depth = parseInt(ctx.url.searchParams.get("depth") || "2");

    // 查找实体 ID
    const [entity] = await pg`SELECT id FROM kg_entities WHERE name = ${name}`;
    if (!entity) {
      return ctx.jsonResponse({ success: false, error: "Entity not found" }, 404, ctx.baseHeaders);
    }

    // 调用图遍历函数
    const results = await pg`SELECT * FROM kg_traverse(${entity.id}, ${depth})`;

    return ctx.jsonResponse({
      success: true,
      data: results,
      depth,
      startEntity: name,
    }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Traverse failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
}

export async function handleKGBuild(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/kg/build" || ctx.req.method !== "POST") return null;

  try {
    const { buildKnowledgeGraph } = await import("../memory/knowledge-graph-builder.js");
    const body = await ctx.req.json().catch(() => ({}));

    const result = await buildKnowledgeGraph({
      projectPath: body.projectPath || process.cwd(),
      projectName: body.projectName || "current",
      generateEmbeddings: body.generateEmbeddings ?? false,
    });

    return ctx.jsonResponse({ success: true, data: result }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Build failed", err as Error);
    return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
  }
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

    return ctx.jsonResponse({ success: true, data: result }, 200, ctx.baseHeaders);
  } catch (err) {
    logger.error("[KGRoute] Search failed", err as Error);
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
