/**
 * HITL 审批路由（2026-07-26 前端审查修复 H1）
 *
 * 闭环：执行层的双层复核/强制审批 → ApprovalBridge → main.ts 订阅广播
 * approval.requested → 客户端（前端/CLI/curl）经本路由提交决定 →
 * ApprovalBridge.resolve → 广播 approval.resolved。
 * 写入操作需要二次认证（requireAuthToken）。
 */
import type { RouteContext } from "./types.js";
import { requireAuthToken } from "./route-auth.js";
import { getApprovalBridge } from "../utils/approval-bridge.js";
import { wsManager } from "../utils/websocket.js";
import { logger } from "../utils/logger.js";

export async function handleApprovalResolve(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/approvals\/([^/]+)\/resolve$/);
  if (!match || ctx.req.method !== "POST") return null;

  const authErr = requireAuthToken(ctx);
  if (authErr) return authErr;

  const id = decodeURIComponent(match[1]);
  let approved = false;
  let reason: string | undefined;
  try {
    const body = await ctx.req.json() as { approved?: unknown; reason?: unknown };
    approved = body.approved === true;
    reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined;
  } catch {
    return ctx.jsonResponse({ error: "Invalid JSON body" }, 400, ctx.baseHeaders);
  }

  const found = getApprovalBridge().resolve(id, approved, reason);
  if (!found) {
    return ctx.jsonResponse({ error: "Approval not found or already resolved/expired" }, 404, ctx.baseHeaders);
  }

  logger.info(`[Approvals] ${id} ${approved ? "approved" : "denied"} via REST`, { reason });
  wsManager.broadcast({
    type: "approval.resolved",
    payload: { id, approved, reason },
    timestamp: new Date().toISOString(),
  });
  return ctx.jsonResponse({ success: true, id, approved }, 200, ctx.baseHeaders);
}

/** GET /approvals/pending — 列出待审批项（便于客户端轮询补偿 WS 不可靠场景） */
export async function handleApprovalPending(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/approvals/pending" || ctx.req.method !== "GET") return null;

  const authErr = requireAuthToken(ctx);
  if (authErr) return authErr;

  return ctx.jsonResponse({ pending: getApprovalBridge().listPending() }, 200, ctx.baseHeaders);
}
