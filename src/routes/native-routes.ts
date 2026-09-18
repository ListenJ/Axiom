/**
 * Native Bridge Routes — Rust 核心 HTTP 代理
 * 将 /native/* 请求转发到 Rust sidecar (localhost:18790)
 */
import type { RouteContext } from "./types.js";
import { logger } from "../utils/logger.js";
import { isNativeReady, nativeSearch, nativeRouterPerf, nativeStats } from "../native-bridge.js";

const NATIVE_PORT = 18790;
const NATIVE_BASE = `http://127.0.0.1:${NATIVE_PORT}`;

export async function handleNativeSearch(ctx: RouteContext): Promise<Response | null> {
  const { url, req } = ctx;
  if (url.pathname !== "/native/search") return null;
  if (req.method !== "POST") return null;

  if (!isNativeReady()) {
    return ctx.jsonResponse({ error: "Native core not available" }, 503);
  }

  try {
    const body = await req.json();
    const results = await nativeSearch(body.query || body.q || "", {
      limit: body.limit,
      tags: body.tags,
      para: body.para,
    });
    return ctx.jsonResponse({
      native: true,
      query: body.query || body.q,
      count: results.length,
      results,
    });
  } catch (e) {
    logger.error("[NativeRoute] Search failed", e as Error);
    return ctx.jsonResponse({ error: "Native search failed" }, 500);
  }
}

export async function handleNativeRouterPerf(ctx: RouteContext): Promise<Response | null> {
  const { url, req } = ctx;
  if (url.pathname !== "/native/router/perf") return null;
  if (req.method !== "GET") return null;

  if (!isNativeReady()) {
    return ctx.jsonResponse({ error: "Native core not available" }, 503);
  }

  const report = await nativeRouterPerf();
  if (!report) {
    return ctx.jsonResponse({ error: "Failed to fetch perf report" }, 500);
  }
  return ctx.jsonResponse(report);
}

export async function handleNativeStats(ctx: RouteContext): Promise<Response | null> {
  const { url, req } = ctx;
  if (url.pathname !== "/native/stats") return null;
  if (req.method !== "GET") return null;

  if (!isNativeReady()) {
    // 未就绪返回 200 空态：前端展示“未启用”，避免控制台 503 噪声
    return ctx.jsonResponse({ available: false, reason: "native core not available" }, 200);
  }

  const stats = await nativeStats();
  return ctx.jsonResponse(stats ?? { error: "Unavailable" });
}

export async function handleNativeProxy(ctx: RouteContext): Promise<Response | null> {
  const { url, req } = ctx;
  if (!url.pathname.startsWith("/native/")) return null;

  // Proxy all other /native/* to Rust sidecar
  try {
    const targetUrl = `${NATIVE_BASE}${url.pathname}${url.search}`;
    const proxyReq = new Request(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    const res = await fetch(proxyReq, { signal: AbortSignal.timeout(10000) });
    return new Response(res.body, {
      status: res.status,
      headers: Object.fromEntries(res.headers),
    });
  } catch (e) {
    logger.warn("[NativeProxy] Forward failed", { path: url.pathname, error: (e as Error).message });
    return ctx.jsonResponse({ error: "Native proxy failed" }, 502);
  }
}
