/**
 * 弹性工具集 - 提供重试、熔断、降级、超时等可靠性模式
 */
import { logger } from "./logger.js";

// ========== 重试机制 ==========

export interface RetryOptions {
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
  maxDelay: 30000,
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
    } catch (error: any) {
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

// ========== 熔断器 ==========

export interface CircuitBreakerOptions {
  failureThreshold?: number;    // 触发熔断的失败次数
  resetTimeout?: number;        // 熔断后恢复时间(ms)
  halfOpenMaxCalls?: number;    // 半开状态最大测试调用数
}

type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private lastFailureTime?: number;
  private halfOpenCalls = 0;
  private readonly opts: Required<CircuitBreakerOptions>;

  constructor(
    private name: string,
    options: CircuitBreakerOptions = {}
  ) {
    this.opts = {
      failureThreshold: options.failureThreshold ?? 5,
      resetTimeout: options.resetTimeout ?? 30000,
      halfOpenMaxCalls: options.halfOpenMaxCalls ?? 3,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - (this.lastFailureTime || 0) > this.opts.resetTimeout) {
        this.state = "half-open";
        this.halfOpenCalls = 0;
        logger.info(`[CircuitBreaker] ${this.name} entering half-open state`);
      } else {
        throw new CircuitOpenError(`Circuit breaker '${this.name}' is OPEN`);
      }
    }

    if (this.state === "half-open" && this.halfOpenCalls >= this.opts.halfOpenMaxCalls) {
      throw new CircuitOpenError(`Circuit breaker '${this.name}' half-open limit reached`);
    }

    if (this.state === "half-open") {
      this.halfOpenCalls++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error: any) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    if (this.state === "half-open") {
      this.state = "closed";
      this.failures = 0;
      this.halfOpenCalls = 0;
      logger.info(`[CircuitBreaker] ${this.name} closed (recovery successful)`);
    }
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.opts.failureThreshold) {
      this.state = "open";
      logger.warn(`[CircuitBreaker] ${this.name} OPENED after ${this.failures} failures`);
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

// ========== 降级处理 ==========

export interface FallbackOptions<T> {
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
  } catch (error: any) {
    if (options.logFailure !== false) {
      logger.warn(`[Fallback] Primary failed, using fallback`, { error: error.message });
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

export interface HealthCheck {
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
      interval: check.interval || 30000,
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
        } catch (error: any) {
          logger.error(`[HealthMonitor] ${name} check failed`, error);
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

// ========== 批量操作容错 ==========

export interface BatchResult<T> {
  success: T[];
  failed: Array<{ item: any; error: string }>;
}

/**
 * 批量执行，单个失败不影响整体
 */
export async function batchWithResilience<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  options?: { concurrency?: number; continueOnError?: boolean }
): Promise<BatchResult<R>> {
  const { concurrency = 3, continueOnError = true } = options || {};
  const result: BatchResult<R> = { success: [], failed: [] };

  // 简单的并发控制
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const promise = (async () => {
      try {
        const r = await fn(item);
        result.success.push(r);
      } catch (error: any) {
        if (continueOnError) {
          result.failed.push({ item, error: error.message });
        } else {
          throw error;
        }
      }
    })().finally(() => {
      const idx = executing.indexOf(promise);
      if (idx > -1) executing.splice(idx, 1);
    });

    executing.push(promise);
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return result;
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

// 全局熔断器实例（按 provider 分）
const circuitBreakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
  if (!circuitBreakers.has(name)) {
    circuitBreakers.set(name, new CircuitBreaker(name, options));
  }
  return circuitBreakers.get(name)!;
}
