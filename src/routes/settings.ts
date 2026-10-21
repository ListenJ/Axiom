/**
 * Settings routes — 设置目录与语义搜索
 *
 * GET  /settings/catalog — 返回设置目录（无敏感值）
 * POST /settings/search  — 语义搜索（**授权后**才走路由 embedding；未授权/失败 → 纯关键词，零网络请求）
 *
 * 另含两个「面板数据」端点（供设置页中 type=panel 的条目消费）：
 *   GET/POST /settings/web-search — 网络搜索：引擎池状态与开关、SearXNG、聚合与抓取策略
 *   GET/POST /settings/approver   — 安全：高危操作审批模型的状态与选择
 */
import type { RouteContext } from "./types.js";
import { SETTING_SECTIONS, SETTINGS_CATALOG } from "../core/settings-catalog.js";
import { searchSettings } from "../core/settings-search.js";
import { router } from "../router/model-router.js";
import { createConsentedEmbedder } from "../knowledge/embedding-consent.js";
import {
  applyWebSearchPatch,
  describeWebSearchSetup,
  listEngineStatus,
  loadWebSearchConfigWithRevision,
  saveWebSearchConfig,
  WebSearchConfigConflictError,
  WebSearchConfigValidationError,
} from "../crawl/web-search-config.js";
import { describeApproverSetup, listConfiguredModels } from "../agents/approver-model.js";
import { readString, writeString } from "../utils/env.js";
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

/** 网络搜索面板的可注入依赖（仅用于隔离临时配置的集成测试；生产调用不传 → 使用默认配置路径）。 */
export interface WebSearchSettingsDeps {
  configPath?: string;
}

/**
 * GET/POST /settings/web-search
 *
 * 2026-10-22 P1（审计 A2/A3）：
 *   - GET 额外返回 `revision`（配置文件内容修订号）；
 *   - POST 支持 `If-Match` 头（或 body.ifRevision）做**乐观并发**：磁盘内容已变 → **409**
 *     `{ code: "revision-conflict", revision }`，不再静默覆盖别人的保存；
 *   - 请求体经 `applyWebSearchPatch` **白名单 + 类型/范围校验**，未知字段忽略并回传 `ignored`；
 *   - 保存为原子写（见 web-search-config.ts），响应回传新 `revision` 供前端继续 CAS。
 */
export async function handleWebSearchSettings(
  ctx: RouteContext,
  deps: WebSearchSettingsDeps = {},
): Promise<Response | null> {
  if (ctx.url.pathname !== "/settings/web-search") return null;
  const configPath = deps.configPath;

  if (ctx.req.method === "GET") {
    const { config: cfg, revision } = loadWebSearchConfigWithRevision(configPath);
    return ctx.jsonResponse(
      {
        revision,
        summary: describeWebSearchSetup(configPath),
        engines: listEngineStatus(configPath),
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
      const body = (await ctx.req.json()) as unknown;
      const ifMatchHeader = ctx.req.headers.get("if-match");
      const bodyRevision =
        body && typeof body === "object" && typeof (body as { ifRevision?: unknown }).ifRevision === "string"
          ? (body as { ifRevision: string }).ifRevision
          : null;
      const expectedFromClient = (ifMatchHeader ?? bodyRevision ?? "").replace(/^"|"$/g, "") || undefined;

      const current = loadWebSearchConfigWithRevision(configPath);
      const { config, applied } = applyWebSearchPatch(current.config, body);
      // 客户端未带修订号时以"服务端最新值"为基线（等价旧行为，但整个读改写仍在同一次调用内完成）
      const revision = saveWebSearchConfig(config, configPath, {
        expectedRevision: expectedFromClient ?? current.revision,
      });
      // P3/D5：配置已变化 → 立即失效搜索聚合缓存。否则同一查询会在缓存 TTL 内继续返回
      // 旧引擎/旧策略下的结果（用户改了引擎开关却"看起来没生效"）。
      try {
        const { searchCache } = await import("../utils/cache.js");
        searchCache.clear();
      } catch (e) {
        logger.warn("[Settings] 搜索缓存失效失败（配置已保存）", { error: (e as Error).message });
      }
      return ctx.jsonResponse(
        { ok: true, revision, engines: listEngineStatus(configPath), applied },
        200,
        ctx.baseHeaders,
      );
    } catch (e) {
      if (e instanceof WebSearchConfigConflictError) {
        const latest = loadWebSearchConfigWithRevision(configPath);
        logger.warn("[Settings] 网络搜索配置写入冲突（409）", {
          expected: e.expectedRevision,
          actual: e.actualRevision,
        });
        return ctx.jsonResponse(
          {
            error: e.message,
            code: "revision-conflict",
            revision: latest.revision,
            engines: listEngineStatus(configPath),
          },
          409,
          ctx.baseHeaders,
        );
      }
      if (e instanceof WebSearchConfigValidationError) {
        return ctx.jsonResponse({ error: e.message, code: "invalid-patch" }, 400, ctx.baseHeaders);
      }
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
      writeString("AXIOM_APPROVER_MODEL", model);
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
    // D1/D5 授权门：未授权（默认 `ask`）⇒ `createConsentedEmbedder` 返回 `null`
    // ⇒ `searchSettings` 拿到 null 即纯关键词路径，**一次网络请求都不发**。
    // 逐请求构造（不在模块作用域构造）：避免 import 期副作用，且运行期改授权立即生效。
    const embedder = createConsentedEmbedder({ embeddings: (texts) => router.embeddings(texts) });
    const result = await searchSettings(q, { limit: body.limit, embedder });
    return ctx.jsonResponse(result, 200, ctx.baseHeaders);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return ctx.jsonResponse({ error: msg }, 500, ctx.baseHeaders);
  }
}
