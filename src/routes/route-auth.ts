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
import { safeStringEqual } from "../utils/auth-check.js";
import { callerCredential } from "../utils/call-context.js";
import { logger } from "../utils/logger.js";

/** 第二因子分级：write = fail-closed（未配置 403）；read = fail-open（放行 + 每进程 warn 一次） */
export type SecondFactorTier = "write" | "read";

const SECOND_FACTOR_ENV = "AXIOM_SECOND_FACTOR_TOKEN";

/** 每进程只提示一次：只读端点缺配置时放行是已知 fail-open 缺口，但不能刷屏。 */
let secondFactorReadWarned = false;

const SECOND_FACTOR_RECOVERY = {
  env: SECOND_FACTOR_ENV,
  docs: "docs/CONFIGURATION.md",
  hint:
    "写操作在未配置 AXIOM_SECOND_FACTOR_TOKEN 时按 fail-closed 拒绝（403）。" +
    "请在 .env 设置该变量（至少 16 位随机串）后重启服务；只读终端视图不受影响。",
} as const;

/**
 * 第二因子当前状态（D3=C，2026-10-22 P2）：**只读**暴露，不改变拒绝语义。
 * `/health.security.secondFactor` 用它把「只读 tier 仍在 fail-open」这一降级变成可观测状态，
 * 避免运维只能从一条 warn 日志里看到缺口。
 */
export interface SecondFactorStatus {
  configured: boolean;
  /** 写 tier 永远是 fail-closed（未配置 403） */
  writeTier: "fail-closed";
  /** 读 tier 在未配置时 fail-open（放行 + warn once） */
  readTier: "fail-open";
  /** 未配置时给出缺失的 env 名，便于直接定位 */
  missingEnv?: string;
}

/** 读取第二因子状态（供 /health 与测试；不触发任何鉴权/告警副作用）。 */
export function getSecondFactorStatus(): SecondFactorStatus {
  const configured = readString(SECOND_FACTOR_ENV) !== "";
  return configured
    ? { configured, writeTier: "fail-closed", readTier: "fail-open" }
    : { configured, writeTier: "fail-closed", readTier: "fail-open", missingEnv: SECOND_FACTOR_ENV };
}

/**
 * 第二因子分级守卫（D1=C，2026-10-22 P1.4）。
 *
 * - 未配置：
 *   - tier="write" → **403** `{ code: "second-factor-unconfigured", recovery }`（不是 503，不黑屏）；
 *   - tier="read"  → 放行（null），并每进程 `logger.warn` 一次（缺口可见）。
 * - 已配置：callerCredential（并保留终端专用 x-second-factor 头兼容）与 expected 常量时间比较；
 *   不匹配 → 403 `{ code: "invalid-second-factor", recovery }`。
 *
 * 所有拒绝都写 audit.failure（reason 用 code，不记录 token 值）。
 */
export function requireSecondFactorToken(
  ctx: RouteContext,
  tier: SecondFactorTier,
): Response | null {
  const expected = readString(SECOND_FACTOR_ENV);
  const actor = ctx.req.headers.get("x-real-ip") || "unknown";
  const resource = ctx.url.pathname;

  if (!expected) {
    if (tier === "read") {
      if (!secondFactorReadWarned) {
        secondFactorReadWarned = true;
        logger.warn(
          "[route-auth] AXIOM_SECOND_FACTOR_TOKEN 未配置：写操作将 403（fail-closed），只读视图放行（此提示每进程仅一次）",
        );
      }
      return null;
    }
    auditLogger.log({
      event: "auth.failure",
      actor,
      outcome: "denied",
      reason: "second-factor-unconfigured",
      resource,
    });
    return ctx.jsonResponse(
      {
        error: `Second factor token not configured (${SECOND_FACTOR_ENV} missing) — 写操作已按 fail-closed 拒绝`,
        code: "second-factor-unconfigured",
        recovery: SECOND_FACTOR_RECOVERY,
      },
      403,
      ctx.baseHeaders,
    );
  }

  const provided =
    ctx.req.headers.get("x-second-factor") ||
    ctx.req.headers.get("x-axiom-second-factor") ||
    callerCredential(ctx.req.headers) ||
    "";
  if (safeStringEqual(provided, expected)) return null;

  auditLogger.log({
    event: "auth.failure",
    actor,
    outcome: "denied",
    reason: "invalid-second-factor",
    resource,
  });
  return ctx.jsonResponse(
    {
      error: "Unauthorized - second factor token required",
      code: "invalid-second-factor",
      recovery: SECOND_FACTOR_RECOVERY,
    },
    403,
    ctx.baseHeaders,
  );
}

/** 审计事件类型（与 AuditEvent 中需审计的成功事件对齐） */
export type AuditableEvent =
  | "vault.write"
  | "sandbox.execute"
  | "sandbox.high_risk_approved"
  | "plugin.install"
  | "plugin.uninstall"
  | "plugin.enable"
  | "plugin.disable"
  | "plugin.configure"
  | "apikey.set"
  | "apikey.delete"
  | "apikey.test"
  // 切片 B（2026-09-20）：注册用户自定义 provider（写入同一事实源 api-key-store）
  | "apikey.custom.register"
  | "skill.install"
  | "mcp.install";

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

  const provided = callerCredential(ctx.req.headers);

  if (!safeStringEqual(provided, token)) {
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
