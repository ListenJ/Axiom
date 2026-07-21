/**
 * API 限流器
 * 支持滑动窗口、令牌桶两种算法
 */

import crypto from "node:crypto";

interface RateLimitRule {
  windowMs: number;   // 时间窗口 (ms)
  maxRequests: number; // 窗口内最大请求数
}

interface RateLimitState {
  requests: number[]; // 请求时间戳数组
}

export class RateLimiter {
  private store = new Map<string, RateLimitState>();
  private rules: Map<string, RateLimitRule>;
  private defaultRule: RateLimitRule;

  constructor(defaultRule?: RateLimitRule) {
    this.defaultRule = defaultRule ?? { windowMs: 60_000, maxRequests: 60 };
    this.rules = new Map();
  }

  /** 为特定路径设置规则 */
  setRule(path: string, rule: RateLimitRule): void {
    this.rules.set(path, rule);
  }

  /**
   * 检查是否允许请求
   * @returns { allowed, remaining, resetAt }
   */
  check(key: string, path?: string): { allowed: boolean; remaining: number; resetAt: number; retryAfter?: number } {
    const rule = (path && this.rules.get(path)) || this.defaultRule;
    const now = Date.now();
    const windowStart = now - rule.windowMs;

    let state = this.store.get(key);
    if (!state) {
      state = { requests: [] };
      this.store.set(key, state);
    }

    // 清理窗口外的请求记录
    state.requests = state.requests.filter((t) => t > windowStart);

    if (state.requests.length >= rule.maxRequests) {
      const resetAt = state.requests[0] + rule.windowMs;
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: Math.ceil((resetAt - now) / 1000),
      };
    }

    state.requests.push(now);

    return {
      allowed: true,
      remaining: rule.maxRequests - state.requests.length,
      resetAt: now + rule.windowMs,
    };
  }

  /** 获取限流头信息 */
  getHeaders(result: { remaining: number; resetAt: number; retryAfter?: number }): Record<string, string> {
    const headers: Record<string, string> = {
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
    };
    if (result.retryAfter) {
      headers["Retry-After"] = String(result.retryAfter);
    }
    return headers;
  }

  /** 清理长期未使用的状态 */
  cleanup(): void {
    const now = Date.now();
    for (const [key, state] of this.store) {
      const maxWindow = Math.max(
        this.defaultRule.windowMs,
        ...Array.from(this.rules.values()).map((r) => r.windowMs)
      );
      if (state.requests.length === 0 || state.requests[state.requests.length - 1] < now - maxWindow * 2) {
        this.store.delete(key);
      }
    }
  }
}

/** Rate-limit middleware function type returned by {@link createRateLimitMiddleware}. */
export type RateLimitMiddleware = (
  req: Request,
  ip?: string,
) => Promise<{ allowed: boolean; headers: Record<string, string> }>;

/** 基于 IP 的限流中间件 */
export function createRateLimitMiddleware(
  limiter: RateLimiter,
): RateLimitMiddleware {
  return async (req: Request, ip?: string): Promise<{ allowed: boolean; headers: Record<string, string> }> => {
    // Prefer the socket peer address passed by the server (spoof-proof).
    // x-real-ip is only a fallback for legacy callers — clients can spoof it.
    // Do NOT trust x-forwarded-for from client (easily spoofed)
    const key = ip || req.headers.get("x-real-ip") || "anonymous";
    const url = new URL(req.url);
    const result = limiter.check(key, url.pathname);
    return {
      allowed: result.allowed,
      headers: limiter.getHeaders(result),
    };
  };
}

/** 全局限流器实例 */
export const apiLimiter = new RateLimiter({ windowMs: 60_000, maxRequests: 100 });
apiLimiter.setRule("/web-search", { windowMs: 60_000, maxRequests: 30 });
apiLimiter.setRule("/web-fetch", { windowMs: 60_000, maxRequests: 20 });
apiLimiter.setRule("/chat", { windowMs: 60_000, maxRequests: 10 });

// ============================================================================
// Task 4.2 — 多维度限流器（IP + per-user + global）
// ============================================================================

export interface MultiDimensionConfig {
  /** per-IP 配额（默认 100/min） */
  ip?: RateLimitRule;
  /** per-user 配额（按 x-api-key hash 分桶，默认 200/min） */
  user?: RateLimitRule;
  /** 全局配额（默认 1000/min） */
  global?: RateLimitRule;
}

export interface MultiDimensionResult {
  allowed: boolean;
  /** 触发限流的维度（allowed=false 时有值） */
  limitedDimension?: "ip" | "user" | "global";
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

/**
 * 多维度限流器：IP + per-user + global 三维度独立计数，任一超限即拒绝。
 *
 * 设计：
 * - 复用 RateLimiter 滑动窗口逻辑（3 个独立实例）
 * - per-user 维度按 x-api-key 的 sha256 hash 前 16 字符分桶（避免明文 key 作为 Map key）
 * - global 维度所有请求共享一个桶（key 固定为 "__global__"）
 */
export class MultiDimensionLimiter {
  private ipLimiter: RateLimiter;
  private userLimiter: RateLimiter;
  private globalLimiter: RateLimiter;

  constructor(config: MultiDimensionConfig = {}) {
    this.ipLimiter = new RateLimiter(config.ip ?? { windowMs: 60_000, maxRequests: 100 });
    this.userLimiter = new RateLimiter(config.user ?? { windowMs: 60_000, maxRequests: 200 });
    this.globalLimiter = new RateLimiter(config.global ?? { windowMs: 60_000, maxRequests: 1000 });
  }

  /** 为特定路径设置规则（应用到所有维度） */
  setRule(path: string, rule: RateLimitRule): void {
    this.ipLimiter.setRule(path, rule);
    this.userLimiter.setRule(path, rule);
    this.globalLimiter.setRule(path, rule);
  }

  /**
   * 检查是否允许请求（三维度独立计数，任一超限即拒绝）。
   * @param ip 客户端 IP（必填）
   * @param userKey 用户标识（x-api-key hash，可选 — 未认证请求只走 IP + global）
   * @param path 请求路径（可选，用于 per-path 规则）
   */
  check(ip: string, userKey?: string, path?: string): MultiDimensionResult {
    // global 维度始终检查
    const globalResult = this.globalLimiter.check("__global__", path);
    if (!globalResult.allowed) {
      return {
        allowed: false,
        limitedDimension: "global",
        remaining: 0,
        resetAt: globalResult.resetAt,
        retryAfter: globalResult.retryAfter,
      };
    }

    // IP 维度始终检查
    const ipResult = this.ipLimiter.check(ip, path);
    if (!ipResult.allowed) {
      return {
        allowed: false,
        limitedDimension: "ip",
        remaining: 0,
        resetAt: ipResult.resetAt,
        retryAfter: ipResult.retryAfter,
      };
    }

    // user 维度仅认证请求检查
    let userResult: ReturnType<RateLimiter["check"]> | null = null;
    if (userKey) {
      userResult = this.userLimiter.check(userKey, path);
      if (!userResult.allowed) {
        return {
          allowed: false,
          limitedDimension: "user",
          remaining: 0,
          resetAt: userResult.resetAt,
          retryAfter: userResult.retryAfter,
        };
      }
    }

    // 三维度都通过：返回最小 remaining（最接近限流的维度）
    const remainings = [globalResult.remaining, ipResult.remaining];
    if (userResult) remainings.push(userResult.remaining);
    const minRemaining = Math.min(...remainings);
    const maxResetAt = Math.max(globalResult.resetAt, ipResult.resetAt, userResult?.resetAt ?? 0);

    return {
      allowed: true,
      remaining: minRemaining,
      resetAt: maxResetAt,
    };
  }

  /** 清理长期未使用的状态（委托给三个子 limiter） */
  cleanup(): void {
    this.ipLimiter.cleanup();
    this.userLimiter.cleanup();
    this.globalLimiter.cleanup();
  }

  /** 生成限流头信息 */
  getHeaders(result: MultiDimensionResult): Record<string, string> {
    const headers: Record<string, string> = {
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
    };
    if (result.retryAfter) {
      headers["Retry-After"] = String(result.retryAfter);
    }
    return headers;
  }
}

/** 从 Request 提取 user key（x-api-key 的 sha256 hash 前 16 字符）。无认证返回 undefined。 */
export function extractUserKey(req: Request): string | undefined {
  const apiKey = req.headers.get("x-api-key") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!apiKey) return undefined;
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/** 多维度限流中间件 */
export function createMultiDimensionMiddleware(
  limiter: MultiDimensionLimiter,
): RateLimitMiddleware {
  return async (req: Request, ip?: string): Promise<{ allowed: boolean; headers: Record<string, string> }> => {
    const clientIp = ip || req.headers.get("x-real-ip") || "anonymous";
    const userKey = extractUserKey(req);
    const url = new URL(req.url);
    const result = limiter.check(clientIp, userKey, url.pathname);
    return {
      allowed: result.allowed,
      headers: limiter.getHeaders(result),
    };
  };
}

/** 全局多维度限流器实例（默认配额：IP 100/min, user 200/min, global 1000/min） */
export const multiDimLimiter = new MultiDimensionLimiter();
