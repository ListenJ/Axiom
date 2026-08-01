/**
 * 终端路由 — POST /terminal/session（创建）、GET .../stream（SSE）、
 * POST .../input（写 stdin）、DELETE ...（关闭）。
 *
 * 前置鉴权：主入口 checkApiKey 已覆盖（非 PUBLIC_PATHS 路径全部要求 token）。
 */
import type { RouteContext } from "./types.js";
import { createPtySession, getSession, listSessions, ptySessionStats } from "../terminal/pty-session.js";

function sse(data: string): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** POST /terminal/session — 创建交互式终端会话 */
export async function handleTerminalCreate(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/terminal/session" || ctx.req.method !== "POST") return null;
  try {
    const session = createPtySession();
    return ctx.jsonResponse({ sessionId: session.id }, 200, ctx.baseHeaders);
  } catch (e) {
    return ctx.jsonResponse({ error: (e as Error).message }, 503, ctx.baseHeaders);
  }
}

/** GET /terminal/session/:id/stream — SSE 输出流 */
export async function handleTerminalStream(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/terminal\/session\/([^/]+)\/stream$/);
  if (!match || ctx.req.method !== "GET") return null;
  const session = getSession(match[1]!);
  if (!session) {
    return ctx.jsonResponse({ error: "session not found" }, 404, ctx.baseHeaders);
  }

  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safe = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(chunk)));
        } catch {
          closed = true;
        }
      };
      unsub = session.subscribe(safe);
      // 会话已退出（子进程结束）时结束流并退订
      void session.exited.then(() => {
        closed = true;
        unsub?.();
        unsub = null;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      // 客户端断开时立即退订，避免 listener 残留到会话退出
      unsub?.();
      unsub = null;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      ...ctx.baseHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}

/** POST /terminal/session/:id/input — 写入 stdin */
export async function handleTerminalInput(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/terminal\/session\/([^/]+)\/input$/);
  if (!match || ctx.req.method !== "POST") return null;
  const session = getSession(match[1]!);
  if (!session) {
    return ctx.jsonResponse({ error: "session not found" }, 404, ctx.baseHeaders);
  }
  let body: { data?: unknown };
  try {
    body = (await ctx.req.json()) as typeof body;
  } catch {
    return ctx.jsonResponse({ error: "invalid JSON body" }, 400, ctx.baseHeaders);
  }
  if (typeof body.data !== "string") {
    return ctx.jsonResponse({ error: "data must be a string" }, 400, ctx.baseHeaders);
  }
  session.write(body.data);
  return ctx.jsonResponse({ ok: true }, 200, ctx.baseHeaders);
}

/** DELETE /terminal/session/:id — 关闭会话 */
export async function handleTerminalClose(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/terminal\/session\/([^/]+)$/);
  if (!match || ctx.req.method !== "DELETE") return null;
  const session = getSession(match[1]!);
  if (!session) {
    return ctx.jsonResponse({ error: "session not found" }, 404, ctx.baseHeaders);
  }
  session.close();
  return ctx.jsonResponse({ ok: true }, 200, ctx.baseHeaders);
}

/** GET /terminal/sessions — 会话列表（诊断） */
export async function handleTerminalList(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/terminal/sessions" || ctx.req.method !== "GET") return null;
  return ctx.jsonResponse({ sessions: listSessions(), stats: ptySessionStats() }, 200, ctx.baseHeaders);
}
