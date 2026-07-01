/**
 * 弹性工具集 - 提供重试、降级、超时等可靠性模式
 */
import { logger } from "./logger.js";
import { TIMEOUTS } from "../constants/timeouts.js";

// ========== 重试机制 ==========

interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  retryable?: (error: Error) => boolean;
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: TIMEOUTS.CIRCUIT_BREAKER_MAX_DELAY,
  backoffMultiplier: 2,
  retryable: () => true,
  onRetry: () => {},
};

/**
 * 带指数退避的重试包装器
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt === opts.maxAttempts || !opts.retryable(lastError)) {
        throw lastError;
      }

      opts.onRetry(lastError, attempt);
      
      const delay = Math.min(
        opts.baseDelay * Math.pow(opts.backoffMultiplier, attempt - 1),
        opts.maxDelay
      );
      await sleep(delay + Math.random() * 500); // 添加抖动
    }
  }

  throw lastError || new Error("Retry exhausted");
}

// ========== 降级处理 ==========

interface FallbackOptions<T> {
  fallback: T | (() => T | Promise<T>);
  logFailure?: boolean;
}

/**
 * 带降级的主函数包装器
 */
export async function withFallback<T>(
  fn: () => Promise<T>,
  options: FallbackOptions<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (options.logFailure !== false) {
      logger.warn(`[Fallback] Primary failed, using fallback`, { error: err.message });
    }
    
    if (typeof options.fallback === "function") {
      return await (options.fallback as () => Promise<T>)();
    }
    return options.fallback;
  }
}

// ========== 超时包装 ==========

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // 支持外部取消
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Operation aborted by signal"));
      }, { once: true });
    }

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// ========== 健康检查 ==========

interface HealthCheck {
  name: string;
  check: () => Promise<boolean>;
  interval?: number;
}

export class HealthMonitor {
  private checks = new Map<string, { check: () => Promise<boolean>; interval: number; timer?: Timer; lastStatus?: boolean }>();
  private running = false;

  register(check: HealthCheck) {
    this.checks.set(check.name, {
      check: check.check,
      interval: check.interval || TIMEOUTS.HEARTBEAT_INTERVAL,
    });
  }

  start() {
    if (this.running) return;
    this.running = true;

    for (const [name, cfg] of this.checks) {
      cfg.timer = setInterval(async () => {
        try {
          const ok = await cfg.check();
          if (cfg.lastStatus === false && ok) {
            logger.info(`[HealthMonitor] ${name} recovered`);
          } else if (!ok) {
            logger.warn(`[HealthMonitor] ${name} unhealthy`);
          }
          cfg.lastStatus = ok;
        } catch (error: unknown) {
          logger.error(`[HealthMonitor] ${name} check failed`, error instanceof Error ? error : new Error(String(error)));
          cfg.lastStatus = false;
        }
      }, cfg.interval);
    }
  }

  stop() {
    this.running = false;
    for (const cfg of this.checks.values()) {
      if (cfg.timer) clearInterval(cfg.timer);
    }
  }

  async checkAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [name, cfg] of this.checks) {
      try {
        results[name] = await cfg.check();
      } catch {
        results[name] = false;
      }
    }
    return results;
  }
}

// ========== 工具函数 ==========

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 可重试的网络错误判断
export function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timedout") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("socket") ||
    msg.includes("network") ||
    msg.includes("abort") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("504")
  );
}

/**
 * 计算指数退避延迟（带抖动）
 * 用于 model-router.ts 等需要自定义重试逻辑的场景
 */
export function calculateBackoffDelay(
  attempt: number,
  options: {
    baseDelay?: number;
    maxDelay?: number;
    backoffMultiplier?: number;
    jitterMax?: number;
  } = {}
): number {
  const baseDelay = options.baseDelay ?? 500;
  const maxDelay = options.maxDelay ?? 5000;
  const backoffMultiplier = options.backoffMultiplier ?? 2;
  const jitterMax = options.jitterMax ?? 200;

  return Math.min(
    baseDelay * Math.pow(backoffMultiplier, attempt) + Math.random() * jitterMax,
    maxDelay
  );
}
