/**
 * Runtime API Key management routes
 *
 * GET    /api-keys                 — list all providers + status (masked)
 * GET    /api-keys/:provider       — get one provider status
 * POST   /api-keys                  — set { provider, apiKey, baseURL? }
 * DELETE /api-keys/:provider        — clear runtime override for one provider
 *
 * Security:
 *   - The actual API key is never returned (only masked)
 *   - Auth is ALWAYS enforced (no dev-mode bypass)
 *   - Caller must provide AXIOM_AUTH_TOKEN via `x-api-key` header or
 *     `Authorization: Bearer <token>` header
 *   - In-memory only — restart reverts to process.env values (until DB persistence is added)
 */

import type { RouteContext, ApiKeyRequestBody } from "./types.js";
import {
  listProviderStatus,
  setApiKeyOverride,
  clearApiKeyOverride,
  isKnownProvider,
  isResolvableProvider,
  registerCustomProvider,
  unregisterCustomProvider,
  getEffectiveApiKey,
  getEffectiveBaseURL,
  testProviderConnection,
} from "../utils/api-key-store.js";
import {
  saveApiKeyOverride,
  deleteApiKeyOverride,
} from "../utils/api-key-persistence.js";
import { requireAuthToken, auditSuccess } from "./route-auth.js";
import { logger } from "../utils/logger.js";
import { assertSafeOutboundUrl, OutboundUrlBlockedError } from "../utils/url-safety.js";

/** Minimum API key length for validation */
const MIN_API_KEY_LENGTH = 8;

/** Validate baseURL format if provided */
function isValidBaseURL(url: string | undefined): boolean {
  if (!url) return true; // optional field
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * P1.2：用户可控 BYOK 端点的 SSRF 守卫。**必须在落库/注册/注入 key 之前** await。
 * 被拒返回 400（code + recovery）：本机/内网端点需显式配置 AXIOM_SSRF_ALLOWLIST；
 * 不做响应后补救，也不把拒绝做成 503/黑屏。
 */
async function guardOutboundBaseURL(
  ctx: RouteContext,
  baseURL: string,
): Promise<Response | null> {
  try {
    await assertSafeOutboundUrl(baseURL);
    return null;
  } catch (e) {
    if (e instanceof OutboundUrlBlockedError) {
      return ctx.jsonResponse(
        { error: e.recovery, code: e.code, recovery: e.recovery },
        400,
        ctx.baseHeaders,
      );
    }
    logger.error("[api-keys] SSRF guard unexpected failure", e instanceof Error ? e : new Error(String(e)));
    return ctx.jsonResponse({ error: "baseURL 安全检查失败，请稍后重试" }, 500, ctx.baseHeaders);
  }
}

export async function handleApiKeys(ctx: RouteContext): Promise<Response | null> {
  const path = ctx.url.pathname;

  // 仅 /api-keys 路由需要二次认证；非该前缀的请求直接放行（原实现无条件 auth，导致任何未匹配路径（如 /search 导航）到达这里都 401）
  if (!path.startsWith("/api-keys")) return null;

  // All /api-keys routes require authentication
  const authErr = requireAuthToken(ctx);
  if (authErr) return authErr;

  // POST /api-keys/:provider/test — 测试 provider API Key 连通性
  const testMatch = path.match(/^\/api-keys\/([a-z0-9_-]+)\/test$/);
  if (testMatch && ctx.req.method === "POST") {
    const provider = testMatch[1];
    // 自定义 provider 也可测连通性（2026-09-21 修复：此前只认内置项 ⇒ 已注册的自定义项被 404）
    if (!isResolvableProvider(provider)) {
      return ctx.jsonResponse({ error: `Unknown provider: ${provider}` }, 404, ctx.baseHeaders);
    }
    const status = listProviderStatus().find((p) => p.provider === provider);
    if (!status) {
      return ctx.jsonResponse({ error: `Unknown provider: ${provider}` }, 404, ctx.baseHeaders);
    }
    const apiKey = getEffectiveApiKey(provider, status.apiKeyEnv);
    if (!apiKey) {
      return ctx.jsonResponse(
        { ok: false, error: `未配置 ${status.apiKeyEnv}` },
        400,
        ctx.baseHeaders
      );
    }
    const result = await testProviderConnection(
      apiKey,
      getEffectiveBaseURL(provider, status.apiKeyEnv, status.baseURL),
      status.adapter
    );
    if (result.ok) {
      auditSuccess(ctx, "apikey.test", provider, { ok: true });
    }
    // P1.2：SSRF 拒绝是 4xx（请求侧配置错误，code+recovery 已带），不是 5xx 网关错误。
    const testStatus = result.ok ? 200 : result.code ? 400 : 502;
    return ctx.jsonResponse(result, testStatus, ctx.baseHeaders);
  }

  // GET /api-keys — list all
  if (path === "/api-keys" && ctx.req.method === "GET") {
    return ctx.jsonResponse({ providers: listProviderStatus() }, 200, ctx.baseHeaders);
  }

  // POST /api-keys — set one
  if (path === "/api-keys" && ctx.req.method === "POST") {
    let body: ApiKeyRequestBody | undefined;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.jsonResponse({ error: "Invalid JSON body" }, 400, ctx.baseHeaders);
    }

    const { provider, apiKey, baseURL, adapter, displayName } = body || {};
    if (!provider || typeof provider !== "string") {
      return ctx.jsonResponse({ error: "Missing 'provider' field" }, 400, ctx.baseHeaders);
    }
    // 切片 B（2026-09-20）：未知 provider **不再一律拒绝**。
    // 若同时提供了 adapter + baseURL + apiKey，则注册为**用户自定义 provider**，
    // 条目写入同一事实源（api-key-store），密钥复用既有 override 通路 —— 不产生第二份 provider 表。
    if (!isKnownProvider(provider)) {
      const hasCustomFields =
        typeof adapter === "string" && adapter.trim().length > 0 &&
        typeof baseURL === "string" && baseURL.trim().length > 0 &&
        typeof apiKey === "string" && apiKey.trim().length > 0;
      if (hasCustomFields) {
        // P1.2：注册（含 key 注入）之前完成出站 SSRF 校验；被拒直接 400，不产生任何半状态。
        const blocked = await guardOutboundBaseURL(ctx, String(baseURL));
        if (blocked) return blocked;
        const reg = registerCustomProvider({
          provider,
          baseURL: String(baseURL),
          adapter: String(adapter),
          apiKey: String(apiKey),
          displayName: typeof displayName === "string" ? displayName : undefined,
        });
        if (!reg.ok) {
          return ctx.jsonResponse({ error: reg.error }, 400, ctx.baseHeaders);
        }
        // 落库（复用既有 override 表；加密为 fail-closed：未配 AXIOM_ENCRYPTION_KEY 会抛错）
        try {
          saveApiKeyOverride(ctx.db, provider, String(apiKey), String(baseURL), {
            adapter: String(adapter),
            displayName: typeof displayName === "string" ? displayName : undefined,
          });
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          logger.error("[api-keys] Failed to persist custom provider", err);
          // 内存已注册但落库失败 ⇒ 回滚，避免"本次可用、重启消失"的半状态
          unregisterCustomProvider(provider);
          return ctx.jsonResponse({ error: "Failed to persist custom provider" }, 500, ctx.baseHeaders);
        }
        auditSuccess(ctx, "apikey.custom.register", provider);
        return ctx.jsonResponse({ ok: true, custom: true, provider: reg.entry }, 200, ctx.baseHeaders);
      }
      return ctx.jsonResponse(
        {
          error: `Unknown provider: ${provider}`,
          known: Object.keys(listProviderStatus()),
          hint: "新增自定义 provider 需同时提供 adapter / baseURL / apiKey 三个字段",
        },
        400,
        ctx.baseHeaders
      );
    }
    if (!apiKey || typeof apiKey !== "string") {
      return ctx.jsonResponse({ error: "Missing 'apiKey' field" }, 400, ctx.baseHeaders);
    }
    if (apiKey.length < MIN_API_KEY_LENGTH) {
      return ctx.jsonResponse(
        { error: `API key too short (min ${MIN_API_KEY_LENGTH} chars)` },
        400,
        ctx.baseHeaders
      );
    }
    if (!isValidBaseURL(baseURL)) {
      return ctx.jsonResponse(
        { error: "Invalid baseURL format (must be http:// or https://)" },
        400,
        ctx.baseHeaders
      );
    }
    // P1.2：内置 provider 的 baseURL override 同样是用户可控出站端点，必须在落库/注入 key 之前校验。
    if (baseURL !== undefined && baseURL !== null && String(baseURL).trim() !== "") {
      const blocked = await guardOutboundBaseURL(ctx, String(baseURL));
      if (blocked) return blocked;
    }

    try {
      // Persist to DB first, then update memory — ensures consistency
      saveApiKeyOverride(ctx.db, provider, apiKey, baseURL);
      setApiKeyOverride(provider, apiKey, baseURL);
      logger.info(`[api-keys] Set override for ${provider}`);
      auditSuccess(ctx, "apikey.set", provider);
      return ctx.jsonResponse(
        { success: true, provider, message: `Runtime override set for ${provider}` },
        200,
        ctx.baseHeaders
      );
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      logger.error("[api-keys] Failed to set override", err);
      return ctx.jsonResponse(
        { error: "Failed to save API key override" },
        500,
        ctx.baseHeaders
      );
    }
  }

  // GET /api-keys/:provider
  const getMatch = path.match(/^\/api-keys\/([a-z0-9_-]+)$/i);
  if (getMatch && ctx.req.method === "GET") {
    const provider = getMatch[1];
    // 内置 ∪ 自定义（2026-09-21 修复：自定义 provider 此前查详情恒 404）
    if (!isResolvableProvider(provider)) {
      return ctx.jsonResponse({ error: `Unknown provider: ${provider}` }, 404, ctx.baseHeaders);
    }
    const entry = listProviderStatus().find((p) => p.provider === provider);
    return ctx.jsonResponse(entry, 200, ctx.baseHeaders);
  }

  // DELETE /api-keys/:provider
  const deleteMatch = path.match(/^\/api-keys\/([a-z0-9_-]+)$/i);
  if (deleteMatch && ctx.req.method === "DELETE") {
    const provider = deleteMatch[1];
    // 内置 ∪ 自定义（2026-09-21 修复：自定义 provider 此前无法清 override）
    if (!isResolvableProvider(provider)) {
      return ctx.jsonResponse({ error: `Unknown provider: ${provider}` }, 404, ctx.baseHeaders);
    }
    // Delete from DB first, then clear memory — ensures consistency
    deleteApiKeyOverride(ctx.db, provider);
    clearApiKeyOverride(provider);
    auditSuccess(ctx, "apikey.delete", provider);
    return ctx.jsonResponse(
      { success: true, provider, message: `Runtime override cleared for ${provider}` },
      200,
      ctx.baseHeaders
    );
  }

  // POST /api-keys/:provider/test — 测试 API Key 连通性
  // NOTE: 此端点依赖 api-key-store.ts 的 testProviderConnection（WIP，未提交）。
  // 待 api-key-store.ts 的 provider 适配/区域系统合并后，在此处恢复端点实现。
  // 届时同步恢复 auditSuccess(ctx, "apikey.test", provider, { ok: result.ok }) 调用。

  return null;
}
