/**
 * Settings routes — 设置目录与语义搜索
 *
 * GET  /settings/catalog — 返回设置目录（无敏感值）
 * POST /settings/search  — 语义搜索（本地 embedding → 路由 embedding → 关键词兜底）
 *
 * 另含两个「面板数据」端点（供设置页中 type=panel 的条目消费）：
 *   GET/POST /settings/web-search — 网络搜索：引擎池状态与开关、SearXNG、聚合与抓取策略
 *   GET/POST /settings/approver   — 安全：高危操作审批模型的状态与选择
 */
import type { RouteContext } from "./types.js";
import { SETTING_SECTIONS, SETTINGS_CATALOG } from "../core/settings-catalog.js";
import { searchSettings } from "../core/settings-search.js";
import {
  describeWebSearchSetup,
  listEngineStatus,
  loadWebSearchConfig,
  saveWebSearchConfig,
} from "../crawl/web-search-config.js";
import { describeApproverSetup, listConfiguredModels } from "../agents/approver-model.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

export async function handleSettingsCatalog(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/settings/catalog" || ctx.req.method !== "GET") return null;
  return ctx.jsonResponse(
    { sections: SETTING_SECTIONS, items: SETTINGS_CATALOG },
    200,
    ctx.baseHeaders,
  );
}

// ══════════════════════════════════════════════════════════════════
// 网络搜索面板
// ══════════════════════════════════════════════════════════════════

export async function handleWebSearchSettings(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/settings/web-search") return null;

  if (ctx.req.method === "GET") {
    const cfg = loadWebSearchConfig();
    return ctx.jsonResponse(
      {
        summary: describeWebSearchSetup(),
        engines: listEngineStatus(),
        aggregate: cfg.aggregate,
        searxng: cfg.searxng,
        policy: cfg.policy,
      },
      200,
      ctx.baseHeaders,
    );
  }

  if (ctx.req.method === "POST") {
    try {
      const body = (await ctx.req.json()) as {
        engines?: Array<{ id: string; enabled?: boolean; weight?: number }>;
        aggregate?: Record<string, unknown>;
        searxng?: Record<string, unknown>;
        policy?: Record<string, unknown>;
      };
      const cfg = loadWebSearchConfig();

      for (const patch of body.engines ?? []) {
        const engine = cfg.engines.find((e) => e.id === patch.id);
        if (!engine) continue;
        if (typeof patch.enabled === "boolean") engine.enabled = patch.enabled;
        if (typeof patch.weight === "number") engine.weight = patch.weight;
      }
      if (body.aggregate) Object.assign(cfg.aggregate, body.aggregate);
      if (body.searxng) Object.assign(cfg.searxng, body.searxng);
      if (body.policy) Object.assign(cfg.policy, body.policy);

      saveWebSearchConfig(cfg);
      return ctx.jsonResponse({ ok: true, engines: listEngineStatus() }, 200, ctx.baseHeaders);
    } catch (e) {
      logger.warn("[Settings] 网络搜索配置写入失败", { error: (e as Error).message });
      return ctx.jsonResponse({ error: (e as Error).message }, 400, ctx.baseHeaders);
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════
// 审批模型面板（安全）
// ══════════════════════════════════════════════════════════════════

export async function handleApproverSettings(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/settings/approver") return null;

  if (ctx.req.method === "GET") {
    const setup = describeApproverSetup();
    return ctx.jsonResponse(
      {
        ...setup,
        configuredModels: listConfiguredModels(),
        explicit: readString("AXIOM_APPROVER_MODEL", ""),
        envVar: "AXIOM_APPROVER_MODEL",
      },
      200,
      ctx.baseHeaders,
    );
  }

  if (ctx.req.method === "POST") {
    try {
      const body = (await ctx.req.json()) as { model?: string };
      const model = (body.model ?? "").trim();
      if (!model) {
        return ctx.jsonResponse(
          { error: "缺少 model（写法 provider/model 或 model）" },
          400,
          ctx.baseHeaders,
        );
      }
      // 写入 .env 的 AXIOM_APPROVER_MODEL，并同步当前进程 env 使其立即生效
      const { upsertEnvVar } = await import("../utils/env-file.js");
      const result = upsertEnvVar("AXIOM_APPROVER_MODEL", model);
      process.env.AXIOM_APPROVER_MODEL = model;
      return ctx.jsonResponse({ ok: true, model, envPath: result.path }, 200, ctx.baseHeaders);
    } catch (e) {
      logger.warn("[Settings] 审批模型写入失败", { error: (e as Error).message });
      return ctx.jsonResponse({ error: (e as Error).message }, 400, ctx.baseHeaders);
    }
  }

  return null;
}

export async function handleSettingsSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/settings/search" || ctx.req.method !== "POST") return null;
  try {
    const body = (await ctx.req.json()) as { q?: string; limit?: number };
    const q = (body.q ?? "").trim();
    if (!q) {
      return ctx.jsonResponse({ error: "Missing q param" }, 400, ctx.baseHeaders);
    }
    const result = await searchSettings(q, { limit: body.limit });
    return ctx.jsonResponse(result, 200, ctx.baseHeaders);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return ctx.jsonResponse({ error: msg }, 500, ctx.baseHeaders);
  }
}