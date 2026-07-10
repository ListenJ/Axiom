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
} from "../utils/api-key-store.js";
import {
  saveApiKeyOverride,
  deleteApiKeyOverride,
} from "../utils/api-key-persistence.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

/** Minimum API key length for validation */
const MIN_API_KEY_LENGTH = 8;

function requireAuth(ctx: RouteContext): Response | null {
  const token = readString("AXIOM_AUTH_TOKEN");
  if (!token) {
    // Fail closed: if the operator hasn't configured a token, refuse all calls.
    return ctx.jsonResponse(
      { error: "Server auth not configured (AXIOM_AUTH_TOKEN missing)" },
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

export async function handleApiKeys(ctx: RouteContext): Promise<Response | null> {
  const path = ctx.url.pathname;

  // All /api-keys routes require authentication
  const authErr = requireAuth(ctx);
  if (authErr) return authErr;

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

    try {
      // Persist to DB first, then update memory — ensures consistency
      saveApiKeyOverride(ctx.db, provider, apiKey, baseURL);
      setApiKeyOverride(provider, apiKey, baseURL);
      logger.info(`[api-keys] Set override for ${provider}`);
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
    if (!isKnownProvider(provider)) {
      return ctx.jsonResponse({ error: `Unknown provider: ${provider}` }, 404, ctx.baseHeaders);
    }
    const entry = listProviderStatus().find((p) => p.provider === provider);
    return ctx.jsonResponse(entry, 200, ctx.baseHeaders);
  }

  // DELETE /api-keys/:provider
  const deleteMatch = path.match(/^\/api-keys\/([a-z0-9_-]+)$/i);
  if (deleteMatch && ctx.req.method === "DELETE") {
    const provider = deleteMatch[1];
    if (!isKnownProvider(provider)) {
      return ctx.jsonResponse({ error: `Unknown provider: ${provider}` }, 404, ctx.baseHeaders);
    }
    // Delete from DB first, then clear memory — ensures consistency
    deleteApiKeyOverride(ctx.db, provider);
    clearApiKeyOverride(provider);
    return ctx.jsonResponse(
      { success: true, provider, message: `Runtime override cleared for ${provider}` },
      200,
      ctx.baseHeaders
    );
  }

  return null;
}
