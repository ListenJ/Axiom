/**
 * Consciousness / self-reflection HTTP routes.
 *
 * These endpoints are additive and never block the chat hot path.
 */
import type { RouteContext } from "./types.js";
import { withTimeout } from "../utils/resilience.js";
import { getConsciousness } from "../agents/consciousness/index.js";

export async function handleConsciousness(ctx: RouteContext): Promise<Response | null> {
  const base = ctx.url.pathname;
  const method = ctx.req.method;

  if (base === "/consciousness/status" && method === "GET") {
    return ctx.jsonResponse(getConsciousness().status(), 200, ctx.baseHeaders);
  }

  if (base === "/consciousness/reflect" && method === "POST") {
    try {
      const body = await ctx.req.json().catch(() => ({}));
      // 有界超时：反射循环可能依赖 LLM（无 key 时重试挂起），HTTP 层不允许无限等待
      const outcome = await withTimeout(getConsciousness().triggerNow(body.reason || "manual:http"), 30_000);
      return ctx.jsonResponse({ success: true, outcome }, 200, ctx.baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ctx.jsonResponse({ error: msg }, 500, ctx.baseHeaders);
    }
  }

  return null;
}
