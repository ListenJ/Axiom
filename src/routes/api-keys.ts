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
 *   - Caller must provide OPENCLAW_AUTH_TOKEN via `x-api-key` header or
 *     `Authorization: Bearer <token>` header
 *   - In-memory only — restart reverts to process.env values (until DB persistence is added)
 */

import type { RouteContext } from "./types.js";
import {
  listProviderStatus,
  setApiKeyOverride,
  clearApiKeyOverride,
  isKnownProvider,
} from "../utils/api-key-store.js";
import {
  saveApiKeyOverride,
  deleteApiKeyOverride,
} from "../utils/api-key-persistence.js";
import { logger } from "../utils/logger.js";

function requireAuth(ctx: RouteContext): Response | null {
  const token = process.env.OPENCLAW_AUTH_TOKEN;
  if (!token) {
    // Fail closed: if the operator hasn't configured a token, refuse all calls.
    return ctx.jsonResponse(
      { error: "Server auth not configured (OPENCLAW_AUTH_TOKEN missing)" },
      503,
      ctx.baseHeaders
    );
  }

  const provided =
    ctx.req.headers.get("x-api-key") ||
    ctx.req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (provided !== token) {
    return ctx.jsonResponse({ error: "Unauthorized" }, 401, ctx.baseHeaders);
  }
  return null;
}

export async function handleApiKeys(ctx: RouteContext): Promise<Response | null> {
  const path = ctx.url.pathname;

  // GET /api-keys — list all
  if (path === "/api-keys" && ctx.req.method === "GET") {
    const authErr = requireAuth(ctx);
    if (authErr) return authErr;
    return ctx.jsonResponse({ providers: listProviderStatus() }, 200, ctx.baseHeaders);
  }

  // POST /api-keys — set one
  if (path === "/api-keys" && ctx.req.method === "POST") {
    const authErr = requireAuth(ctx);
    if (authErr) return authErr;

    let body: any;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.jsonResponse({ error: "Invalid JSON body" }, 400, ctx.baseHeaders);
    }

    const { provider, apiKey, baseURL } = body || {};
    if (!provider || typeof provider !== "string") {
      return ctx.jsonResponse({ error: "Missing 'provider' field" }, 400, ctx.baseHeaders);
    }
    if (!isKnownProvider(provider)) {
      return ctx.jsonResponse(
        { error: `Unknown provider: ${provider}`, known: Object.keys(listProviderStatus()) },
        400,
        ctx.baseHeaders
      );
    }
    if (!apiKey || typeof apiKey !== "string") {
      return ctx.jsonResponse({ error: "Missing 'apiKey' field" }, 400, ctx.baseHeaders);
    }
    if (apiKey.length < 8) {
      return ctx.jsonResponse({ error: "API key looks too short (min 8 chars)" }, 400, ctx.baseHeaders);
    }

    try {
      setApiKeyOverride(provider, apiKey, baseURL);
      saveApiKeyOverride(ctx.db, provider, apiKey, baseURL);
      logger.info(`[api-keys] Set override for ${provider}`);
      return ctx.jsonResponse(
        { success: true, provider, message: `Runtime override set for ${provider}` },
        200,
        ctx.baseHeaders
      );
    } catch (e: any) {
      return ctx.jsonResponse({ error: e.message }, 500, ctx.baseHeaders);
    }
  }

  // GET /api-keys/:provider
  const getMatch = path.match(/^\/api-keys\/([a-z0-9_-]+)$/i);
  if (getMatch && ctx.req.method === "GET") {
    const authErr = requireAuth(ctx);
    if (authErr) return authErr;
    const provider = getMatch[1];
    if (!isKnownProvider(provider)) {
      return ctx.jsonResponse({ error: `Unknown provider: ${provider}` }, 404, ctx.baseHeaders);
    }
    const entry = listProviderStatus().find((p) => p.provider === provider);
    return ctx.jsonResponse(entry, 200, ctx.baseHeaders);
  }

  // DELETE /api-keys/:provider
  const deleteMatch = path.match(/^\/api-keys\/([a-z0-9_-]+)$/i);
  if (deleteMatch && ctx.req.method === "DELETE") {
    const authErr = requireAuth(ctx);
    if (authErr) return authErr;
    const provider = deleteMatch[1];
    if (!isKnownProvider(provider)) {
      return ctx.jsonResponse({ error: `Unknown provider: ${provider}` }, 404, ctx.baseHeaders);
    }
    clearApiKeyOverride(provider);
    deleteApiKeyOverride(ctx.db, provider);
    return ctx.jsonResponse(
      { success: true, provider, message: `Runtime override cleared for ${provider}` },
      200,
      ctx.baseHeaders
    );
  }

  return null;
}
