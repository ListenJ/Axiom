/**
 * Pipeline SSE — 认知管道执行进度（内核收敛后 = DRE daemon /events 的代理）。
 *
 * 内核收敛：`cognitive.*` 事件由唯一 Kernel 拥有者（DRE daemon）发布；本进程不再持有
 * 内核单例，故本路由把 daemon 的 `/events` 流转给前端，SSE 契约不变。
 *
 * 清理语义（对齐 chat/stream 与本仓 SSE 清理门禁）：客户端断开 → `cancel()` 取消上游
 * reader（进而中止到 daemon 的连接），不留悬挂的流/套接字。
 */
import type { RouteContext } from "./types.js";
import { getDreKernel } from "../dre/host.js";

function sseError(message: string, headers: Record<string, string>): Response {
  return new Response(`data: ${JSON.stringify({ type: "error", message })}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...headers },
  });
}

export async function handlePipelineStream(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/pipeline/stream" || ctx.req.method !== "GET") return null;

  const client = getDreKernel();
  if (!client) return sseError("DRE daemon unreachable", ctx.baseHeaders);

  let upstream: Response;
  try {
    upstream = await client.openEvents();
  } catch {
    return sseError("DRE daemon events unavailable", ctx.baseHeaders);
  }
  if (!upstream.body) return sseError("DRE daemon events stream empty", ctx.baseHeaders);

  const reader = upstream.body.getReader();
  // 空闲超时（轮 7 审计：daemon 化时丢失——旧实现 300s 自动关闭，防 daemon 端
  // 从不发 done 且无心跳时的僵尸连接聚积）。每次 pull 前重置；读挂在 upstream 上
  // 无法主动打断，超时路径以 cancel 上游 + 关流收口（cancel 亦清计时器）。
  const IDLE_TIMEOUT_MS = 300_000;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { void reader.cancel("idle-timeout"); } catch { /* 已关闭 */ }
        try { controller.close(); } catch { /* 已关闭 */ }
      }, IDLE_TIMEOUT_MS);
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(idleTimer);
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        clearTimeout(idleTimer);
        try { controller.error(err); } catch { /* 已关闭 */ }
      }
    },
    // 客户端断开/取消：取消上游 reader → 中止到 daemon 的连接，资源回收。
    async cancel(reason) {
      clearTimeout(idleTimer);
      try {
        await reader.cancel(reason);
      } catch {
        /* 上游可能已关闭 */
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...ctx.baseHeaders,
    },
  });
}
