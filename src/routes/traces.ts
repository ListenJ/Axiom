import type { RouteContext } from "./types.js";

export async function handleTraceList(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/traces" || ctx.req.method !== "GET") return null
  const { getAllTraces } = await import("../utils/agent-trace.js")
  const traces = getAllTraces(50)
  return ctx.jsonResponse({ traces }, 200, ctx.baseHeaders)
}

export async function handleTraceDetail(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/traces\/(.+)$/)
  if (!match || ctx.req.method !== "GET") return null
  const { getTrace } = await import("../utils/agent-trace.js")
  const trace = getTrace(match[1])
  if (!trace) return ctx.jsonResponse({ error: "Trace not found" }, 404, ctx.baseHeaders)
  return ctx.jsonResponse(trace, 200, ctx.baseHeaders)
}
