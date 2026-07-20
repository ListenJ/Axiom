/**
 * 敏感端点二次认证守卫
 *
 * 与 api-keys.ts 原本地 requireAuth 行为对齐：
 *   - 未配置 AXIOM_AUTH_TOKEN → 503（fail-closed）
 *   - token 不匹配 → 401 + 审计日志
 *   - 通过 → 返回 null，调用方继续业务逻辑
 *
 * 所有敏感写操作完成后应调用 auditSuccess 留痕。
 *
 * 位置说明：本模块放在 routes/ 而非 utils/，因为它依赖 routes/types.ts
 * 的 RouteContext 类型（utils/ 是 leaf layer，不允许向上引用）。
 */
import type { RouteContext } from "./types.js";
import { readString } from "../utils/env.js";
import { auditLogger } from "../utils/audit-logger.js";

/** 审计事件类型（与 AuditEvent 中需审计的成功事件对齐） */
export type AuditableEvent =
  | "vault.write"
  | "sandbox.execute"
  | "plugin.install"
  | "plugin.uninstall"
  | "plugin.enable"
  | "plugin.disable"
  | "plugin.configure"
  | "apikey.set"
  | "apikey.delete"
  | "apikey.test";

/**
 * 敏感端点二次认证守卫。
 * @returns Response（拒绝时）或 null（通过时，调用方继续）
 */
export function requireAuthToken(ctx: RouteContext): Response | null {
  const token = readString("AXIOM_AUTH_TOKEN");
  const actor = ctx.req.headers.get("x-real-ip") || "unknown";

  if (!token) {
    auditLogger.log({
      event: "auth.failure",
      actor,
      outcome: "denied",
      reason: "AXIOM_AUTH_TOKEN not configured",
      resource: ctx.url.pathname,
    });
    return ctx.jsonResponse(
      { error: "Server auth not configured (AXIOM_AUTH_TOKEN missing)" },
      503,
      ctx.baseHeaders,
    );
  }

  const provided =
    ctx.req.headers.get("x-api-key") ||
    ctx.req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (provided !== token) {
    auditLogger.log({
      event: "auth.failure",
      actor,
      outcome: "denied",
      reason: "invalid or missing token",
      resource: ctx.url.pathname,
    });
    return ctx.jsonResponse({ error: "Unauthorized" }, 401, ctx.baseHeaders);
  }

  return null;
}

/**
 * 记录敏感操作成功完成的审计日志。
 * @param ctx RouteContext（用于读取 actor IP）
 * @param event AuditableEvent 之一
 * @param resource 受影响资源（缺省回退到 ctx.url.pathname）
 * @param metadata 附加元数据（可选）
 */
export function auditSuccess(
  ctx: RouteContext,
  event: AuditableEvent,
  resource?: string,
  metadata?: Record<string, unknown>,
): void {
  auditLogger.log({
    event,
    actor: ctx.req.headers.get("x-real-ip") || "unknown",
    outcome: "success",
    resource: resource ?? ctx.url.pathname,
    metadata,
  });
}
