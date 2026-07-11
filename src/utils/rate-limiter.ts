/**
 * API 限流器
 * 支持滑动窗口、令牌桶两种算法
 */

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
) => Promise<{ allowed: boolean; headers: Record<string, string> }>;

/** 基于 IP 的限流中间件 */
export function createRateLimitMiddleware(
  limiter: RateLimiter,
): RateLimitMiddleware {
  return async (req: Request): Promise<{ allowed: boolean; headers: Record<string, string> }> => {
    // Use x-real-ip from trusted reverse proxy only; fall back to anonymous
    // Do NOT trust x-forwarded-for from client (easily spoofed)
    const ip = req.headers.get("x-real-ip") || "anonymous";
    const url = new URL(req.url);
    const result = limiter.check(ip, url.pathname);
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
