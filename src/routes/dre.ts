/**
 * DRE HTTP 触发入口 — POST /dre/run
 *
 * 运行纯确定性认知管道（零 LLM）：classify → knowledge → reasoning →
 * constraint → action → reflection，全过程发布 cognitive.* 事件到 eventBus，
 * 与 GET /pipeline/stream（SSE）同进程共享，可直接观测。
 */
import type { RouteContext } from "./types.js";
import { getDreKernel } from "../dre/host.js";
import { CognitivePipeline } from "../dre/index.js";

export async function handleDreRun(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/dre/run" || ctx.req.method !== "POST") return null;

  const kernel = getDreKernel();
  if (!kernel) {
    return ctx.jsonResponse(
      { ok: false, error: "DRE Engine is not ready or failed to initialize" },
      503,
      ctx.baseHeaders,
    );
  }

  let body: { input?: unknown; prompt?: unknown };
  try {
    body = (await ctx.req.json()) as { input?: unknown; prompt?: unknown };
  } catch {
    body = {};
  }
  const input =
    (typeof body.input === "string" ? body.input : "") ||
    (typeof body.prompt === "string" ? body.prompt : "");
  if (!input.trim()) {
    return ctx.jsonResponse({ ok: false, error: "input required" }, 400, ctx.baseHeaders);
  }

  try {
    const pipeline = new CognitivePipeline(kernel.getEngine());
    const result = await pipeline.run(input);
    return ctx.jsonResponse({ ok: true, ...result }, 200, ctx.baseHeaders);
  } catch (err) {
    return ctx.jsonResponse(
      { ok: false, error: (err as Error).message },
      500,
      ctx.baseHeaders,
    );
  }
}
