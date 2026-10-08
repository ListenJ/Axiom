/**
 * Pipeline SSE — 认知管道执行进度（内核收敛后 = DRE daemon /events 的代理）。
 *
 * 内核收敛：`cognitive.*` 事件由唯一 Kernel 拥有者（DRE daemon）发布；本进程不再持有
 * 内核单例，故本路由把 daemon 的 `/events` 流原样转给前端，SSE 契约不变。
 */
import type { RouteContext } from "./types.js";
import { getDreKernel } from "../dre/host.js";

export async function handlePipelineStream(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/pipeline/stream" || ctx.req.method !== "GET") return null;

  const client = getDreKernel();
  if (!client) {
    return new Response(
      `data: ${JSON.stringify({ type: "error", message: "DRE daemon unreachable" })}\n\n`,
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...ctx.baseHeaders },
      },
    );
  }

  let upstream: Response;
  try {
    upstream = await client.openEvents();
  } catch {
    return new Response(
      `data: ${JSON.stringify({ type: "error", message: "DRE daemon events unavailable" })}\n\n`,
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...ctx.baseHeaders },
      },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...ctx.baseHeaders,
    },
  });
}
