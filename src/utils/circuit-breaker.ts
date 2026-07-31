/**
 * 轻量熔断器（Circuit Breaker）— 深模块：小接口，大实现
 *
 * 按 key（如 "provider/model"）跟踪连续失败；超过阈值即打开（拒绝调用），
 * 冷却期结束后进入半开状态（放行一次探测）。防止"故障提供商被反复重试烧秒"，
 * 是模型路由兜底链的最后一环（fallback 链 + maxRetries + breaker）。
 *
 * 防泄漏不变量：条目按 lastFailureAt 过期清理（prune），Map 不会无限增长。
 */
export interface CircuitBreakerOptions {
  /** 连续失败阈值（达到即打开），默认 3 */
  failureThreshold?: number;
  /** 打开后的冷却时长 ms，默认 60_000（1 分钟） */
  cooldownMs?: number;
}

interface Entry {
  failures: number;
  openedAt: number | null;
  lastFailureAt: number;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 3);
    this.cooldownMs = Math.max(1, opts.cooldownMs ?? 60_000);
  }

  /** 是否允许调用该 key；打开且未到冷却结束 → false；冷却结束（半开）→ 重置并放行 */
  allow(key: string): boolean {
    const e = this.entries.get(key);
    if (!e || e.failures < this.failureThreshold) return true;
    const opened = e.openedAt ?? 0;
    if (Date.now() - opened >= this.cooldownMs) {
      // 半开：清除失败状态，放行一次探测
      this.entries.delete(key);
      return true;
    }
    return false;
  }

  /** 调用成功：清除该 key 的失败状态 */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** 调用失败：累加失败计数，达到阈值时打开熔断 */
  recordFailure(key: string): void {
    const now = Date.now();
    const e = this.entries.get(key) ?? { failures: 0, openedAt: null, lastFailureAt: 0 };
    e.failures += 1;
    e.lastFailureAt = now;
    if (e.failures >= this.failureThreshold && e.openedAt === null) {
      e.openedAt = now;
    }
    this.entries.set(key, e);
  }

  /** 清理超过 maxAgeMs 无活动的条目，防止 Map 无限增长；返回清理数 */
  prune(maxAgeMs = this.cooldownMs): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, e] of this.entries) {
      if (now - e.lastFailureAt > maxAgeMs) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  stats(): { entries: number; open: number } {
    let open = 0;
    for (const e of this.entries.values()) {
      if (e.openedAt !== null && Date.now() - e.openedAt < this.cooldownMs) open++;
    }
    return { entries: this.entries.size, open };
  }
}

/** 模型路由全局熔断单例（provider/model 维度） */
export const routerBreaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });