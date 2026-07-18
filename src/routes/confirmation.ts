/**
 * HTTP 路由层二次确认辅助函数
 *
 * 复用 permissions.ts 的一次性确认码机制，封装 HTTP 请求中
 * confirmationId 的读取与响应格式。
 */
import type { RouteContext } from "./types.js";
import { requestConfirmation, confirmOperation } from "../utils/permissions.js";

/**
 * 校验当前 HTTP 请求是否携带有效的一次性确认码。
 *
 * 读取顺序：
 * 1. body.confirmationId（适用于 POST/PUT 请求）
 * 2. x-confirmation-id header（适用于无 body 的 POST/DELETE）
 * 3. query.confirmationId（适用于 GET 请求）
 *
 * 缺失时返回 403 并下发新的 confirmationId；
 * 存在但无效或过期时返回 403；
 * 校验通过返回 null，调用方继续执行原 handler。
 */
export function requireHttpConfirmation(
  ctx: RouteContext,
  operation: string,
  body?: Record<string, unknown>
): Response | null {
  let confirmationId = "";
  if (body && typeof body.confirmationId === "string") {
    confirmationId = body.confirmationId;
  } else {
    confirmationId = ctx.req.headers.get("x-confirmation-id") ?? "";
  }
  if (!confirmationId && ctx.req.method === "GET") {
    confirmationId = ctx.url.searchParams.get("confirmationId") ?? "";
  }

  if (!confirmationId) {
    const id = requestConfirmation(operation);
    return ctx.jsonResponse(
      {
        blocked: true,
        confirmationId: id,
        operation,
        reason: `${operation} requires confirmation`,
      },
      403,
      ctx.baseHeaders
    );
  }

  const result = confirmOperation(confirmationId);
  if (!result.approved) {
    return ctx.jsonResponse(
      { error: "Invalid or expired confirmation" },
      403,
      ctx.baseHeaders
    );
  }
  return null;
}
