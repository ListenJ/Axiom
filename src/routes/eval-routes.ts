/**
 * Evaluation Routes — 模型评估 API 端点
 *
 * 端点:
 *   GET  /eval/stats          — 评估统计摘要
 *   GET  /eval/results        — 查询评估结果 (支持过滤/排序)
 *   GET  /eval/model/:id      — 单个模型评估详情
 *   GET  /eval/trend/:id      — 模型评估趋势 (历史数据)
 *   GET  /eval/models         — OpenRouter 缓存的模型列表
 *   POST /eval/run            — 触发模型评估
 *   POST /eval/assign         — 触发动态模型分配
 *   GET  /eval/assignments    — 查看当前动态分配
 *   GET  /eval/assign/report  — 最近一次分配报告
 */

import { logger } from "../utils/logger.js";
import type { RouteContext } from "./types.js";

// ========== 评估统计 ==========

export async function handleEvalStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/eval/stats" && ctx.req.method === "GET") {
    try {
      const { getModelEvalService } = await import("../eval/model-eval-service.js");
      const service = getModelEvalService();
      const stats = service.getStats();
      return ctx.jsonResponse({ success: true, data: stats }, 200, ctx.baseHeaders);
    } catch (err) {
      logger.error("[EvalRoute] Stats failed", err as Error);
      return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

// ========== 查询评估结果 ==========

export async function handleEvalResults(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/eval/results" && ctx.req.method === "GET") {
    try {
      const { getModelEvalService } = await import("../eval/model-eval-service.js");
      const service = getModelEvalService();

      const provider = ctx.url.searchParams.get("provider") || undefined;
      const minOverall = Number(ctx.url.searchParams.get("minOverall")) || undefined;
      const sortBy = (ctx.url.searchParams.get("sortBy") as "overall" | "capability" | "speed" | "cost" | "safety") || "overall";
      const limit = Number(ctx.url.searchParams.get("limit")) || 20;
      const sinceDays = Number(ctx.url.searchParams.get("days")) || 7;

      const results = service.getLatestResults({
        provider,
        minOverall,
        sortBy,
        limit,
        sinceDays,
      });

      return ctx.jsonResponse({
        success: true,
        data: results,
        query: { provider, minOverall, sortBy, limit, sinceDays },
        count: results.length,
      }, 200, ctx.baseHeaders);
    } catch (err) {
      logger.error("[EvalRoute] Results query failed", err as Error);
      return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

// ========== 单个模型评估详情 ==========

export async function handleEvalModel(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/eval\/model\/(.+)$/);
  if (match && ctx.req.method === "GET") {
    try {
      const modelId = decodeURIComponent(match[1]);
      const { getModelEvalService } = await import("../eval/model-eval-service.js");
      const service = getModelEvalService();
      const result = service.getModelEval(modelId);

      if (!result) {
        return ctx.jsonResponse({
          success: false,
          error: `No evaluation found for model: ${modelId}`,
        }, 404, ctx.baseHeaders);
      }

      return ctx.jsonResponse({ success: true, data: result }, 200, ctx.baseHeaders);
    } catch (err) {
      logger.error("[EvalRoute] Model eval failed", err as Error);
      return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

// ========== 模型评估趋势 ==========

export async function handleEvalTrend(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/eval\/trend\/(.+)$/);
  if (match && ctx.req.method === "GET") {
    try {
      const modelId = decodeURIComponent(match[1]);
      const days = Number(ctx.url.searchParams.get("days")) || 30;
      const { getModelEvalService } = await import("../eval/model-eval-service.js");
      const service = getModelEvalService();
      const trend = service.getModelTrend(modelId, days);

      return ctx.jsonResponse({
        success: true,
        modelId,
        data: trend,
        days,
        points: trend.length,
      }, 200, ctx.baseHeaders);
    } catch (err) {
      logger.error("[EvalRoute] Trend query failed", err as Error);
      return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

// ========== OpenRouter 缓存模型 ==========

export async function handleEvalModels(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/eval/models" && ctx.req.method === "GET") {
    try {
      const { getModelEvalService } = await import("../eval/model-eval-service.js");
      const service = getModelEvalService();
      const models = service.getCachedModels();
      const limit = Number(ctx.url.searchParams.get("limit")) || 50;
      const offset = Number(ctx.url.searchParams.get("offset")) || 0;

      return ctx.jsonResponse({
        success: true,
        data: models.slice(offset, offset + limit),
        total: models.length,
        limit,
        offset,
      }, 200, ctx.baseHeaders);
    } catch (err) {
      logger.error("[EvalRoute] Models list failed", err as Error);
      return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

// ========== 触发评估 ==========

export async function handleEvalRun(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/eval/run" && ctx.req.method === "POST") {
    try {
      let body: any = {};
      try { body = await ctx.req.json(); } catch { /* empty body ok */ }

      const { getModelEvalService } = await import("../eval/model-eval-service.js");
      const service = getModelEvalService();

      const mode = body.mode || "quick"; // "full" | "quick"
      const includeBenchmarks = body.includeBenchmarks !== false;
      const models = body.models as string[] | undefined;

      logger.info("[EvalRoute] Starting evaluation", { mode, includeBenchmarks, models });

      let results;
      if (mode === "full") {
        results = await service.runFullEvaluation({
          models,
          includeBenchmarks,
        });
      } else {
        results = await service.quickEvaluation();
      }

      return ctx.jsonResponse({
        success: true,
        mode,
        evaluated: results.length,
        data: results.slice(0, 20), // cap response size
        message: `Evaluated ${results.length} models (${mode} mode)`,
      }, 200, ctx.baseHeaders);
    } catch (err) {
      logger.error("[EvalRoute] Eval run failed", err as Error);
      return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

// ========== 触发动态分配 ==========

export async function handleEvalAssign(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/eval/assign" && ctx.req.method === "POST") {
    try {
      let body: any = {};
      try { body = await ctx.req.json(); } catch { /* empty body ok */ }

      const { getDynamicModelAssigner } = await import("../router/dynamic-model-assigner.js");
      const assigner = getDynamicModelAssigner();

      const report = await assigner.runAssignment({
        forceRefresh: body.forceRefresh || false,
        includeBenchmarks: body.includeBenchmarks !== false,
      });

      return ctx.jsonResponse({
        success: true,
        data: report,
        message: `Assigned ${report.assignedModels} models from ${report.evaluatedModels} evaluations`,
      }, 200, ctx.baseHeaders);
    } catch (err) {
      logger.error("[EvalRoute] Assign failed", err as Error);
      return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

// ========== 查看动态分配 ==========

export async function handleEvalAssignments(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/eval/assignments" && ctx.req.method === "GET") {
    try {
      const { getDynamicModelAssigner } = await import("../router/dynamic-model-assigner.js");
      const assigner = getDynamicModelAssigner();
      const assignments = assigner.getAllAssignments();

      return ctx.jsonResponse({
        success: true,
        data: assignments,
        count: assignments.length,
      }, 200, ctx.baseHeaders);
    } catch (err) {
      logger.error("[EvalRoute] Assignments list failed", err as Error);
      return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

// ========== 分配报告 ==========

export async function handleEvalAssignReport(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/eval/assign/report" && ctx.req.method === "GET") {
    try {
      const { getDynamicModelAssigner } = await import("../router/dynamic-model-assigner.js");
      const assigner = getDynamicModelAssigner();
      const report = assigner.getLastReport();

      if (!report) {
        return ctx.jsonResponse({
          success: false,
          error: "No assignment report available. Run POST /eval/assign first.",
        }, 404, ctx.baseHeaders);
      }

      return ctx.jsonResponse({ success: true, data: report }, 200, ctx.baseHeaders);
    } catch (err) {
      logger.error("[EvalRoute] Assign report failed", err as Error);
      return ctx.jsonResponse({ success: false, error: (err as Error).message }, 500, ctx.baseHeaders);
    }
  }
  return null;
}
