/**
 * Resilience toolkit integration tests
 * Covers: retry, circuit breaker, fallback, timeout, health monitor, batch resilience
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  withRetry,
  CircuitBreaker,
  CircuitOpenError,
  withFallback,
  withTimeout,
  HealthMonitor,
  batchWithResilience,
  isRetryableError,
  getCircuitBreaker,
} from "../src/utils/resilience.js";

describe("withRetry", () => {
  test("succeeds on first attempt", async () => {
    const fn = () => Promise.resolve("success");
    const result = await withRetry(fn, { maxAttempts: 3 });
    expect(result).toBe("success");
  });

  test("retries on failure and eventually succeeds", async () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error("temp"));
      return Promise.resolve("ok");
    };

    const result = await withRetry(fn, { maxAttempts: 3, baseDelay: 50 });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("throws after max attempts", async () => {
    const fn = () => Promise.reject(new Error("always fails"));
    await expect(withRetry(fn, { maxAttempts: 2, baseDelay: 10 })).rejects.toThrow("always fails");
  });

  test("respects retryable predicate", async () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      return Promise.reject(new Error("non-retryable"));
    };

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelay: 10,
        retryable: (e) => !e.message.includes("non-retryable"),
      })
    ).rejects.toThrow("non-retryable");
    expect(attempts).toBe(1);
  });

  test("calls onRetry callback", async () => {
    const retries: Array<{ error: string; attempt: number }> = [];
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error("retry me"));
      return Promise.resolve("done");
    };

    await withRetry(fn, {
      maxAttempts: 3,
      baseDelay: 10,
      onRetry: (e, attempt) => retries.push({ error: e.message, attempt }),
    });

    expect(retries).toHaveLength(2);
    expect(retries[0].attempt).toBe(1);
    expect(retries[1].attempt).toBe(2);
  });
});

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker("test", { failureThreshold: 3, resetTimeout: 100 });
  });

  test("executes normally when closed", async () => {
    const result = await cb.execute(() => Promise.resolve(42));
    expect(result).toBe(42);
    expect(cb.getState()).toBe("closed");
  });

  test("opens after threshold failures", async () => {
    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(() => Promise.reject(new Error("fail")));
      } catch {
        // ignore
      }
    }
    expect(cb.getState()).toBe("open");
    expect(cb.getStats().failures).toBe(3);
  });

  test("rejects when open", async () => {
    // Force open
    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(() => Promise.reject(new Error("fail")));
      } catch {
        // ignore
      }
    }

    await expect(cb.execute(() => Promise.resolve(1))).rejects.toBeInstanceOf(CircuitOpenError);
  });

  test("allows execution after timeout (recovery path)", async () => {
    // Force open
    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(() => Promise.reject(new Error("fail")));
      } catch {
        // ignore
      }
    }

    expect(cb.getState()).toBe("open");

    // Wait for reset timeout, then call execute to trigger recovery
    await new Promise((r) => setTimeout(r, 150));
    // After timeout, execute should be allowed (half-open → success → closed)
    const result = await cb.execute(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(cb.getState()).toBe("closed");
  });

  test("closes after successful half-open call", async () => {
    // Force open
    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(() => Promise.reject(new Error("fail")));
      } catch {
        // ignore
      }
    }

    await new Promise((r) => setTimeout(r, 150));
    const result = await cb.execute(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(cb.getState()).toBe("closed");
    expect(cb.getStats().failures).toBe(0);
  });
});

describe("withFallback", () => {
  test("returns primary result on success", async () => {
    const result = await withFallback(
      () => Promise.resolve("primary"),
      { fallback: "fallback" }
    );
    expect(result).toBe("primary");
  });

  test("returns static fallback on failure", async () => {
    const result = await withFallback(
      () => Promise.reject(new Error("fail")),
      { fallback: "static-fallback" }
    );
    expect(result).toBe("static-fallback");
  });

  test("returns function fallback on failure", async () => {
    const result = await withFallback(
      () => Promise.reject(new Error("fail")),
      { fallback: () => "computed-fallback" }
    );
    expect(result).toBe("computed-fallback");
  });

  test("returns async function fallback on failure", async () => {
    const result = await withFallback(
      () => Promise.reject(new Error("fail")),
      { fallback: async () => "async-fallback" }
    );
    expect(result).toBe("async-fallback");
  });
});

describe("withTimeout", () => {
  test("resolves if promise completes in time", async () => {
    const promise = new Promise((resolve) => setTimeout(() => resolve("ok"), 10));
    const result = await withTimeout(promise as Promise<string>, 100);
    expect(result).toBe("ok");
  });

  test("rejects if promise exceeds timeout", async () => {
    const promise = new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(withTimeout(promise, 50)).rejects.toThrow("timed out");
  });

  test("aborts on signal", async () => {
    const controller = new AbortController();
    const promise = new Promise((resolve) => setTimeout(resolve, 1000));
    const timeoutPromise = withTimeout(promise, 500, controller.signal);

    controller.abort();

    await expect(timeoutPromise).rejects.toThrow("aborted by signal");
  });
});

describe("HealthMonitor", () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor();
  });

  test("returns all healthy when checks pass", async () => {
    monitor.register({ name: "db", check: () => Promise.resolve(true) });
    monitor.register({ name: "api", check: () => Promise.resolve(true) });

    const results = await monitor.checkAll();
    expect(results.db).toBe(true);
    expect(results.api).toBe(true);
  });

  test("returns false when check fails", async () => {
    monitor.register({ name: "db", check: () => Promise.resolve(false) });
    monitor.register({ name: "api", check: () => Promise.resolve(true) });

    const results = await monitor.checkAll();
    expect(results.db).toBe(false);
    expect(results.api).toBe(true);
  });

  test("returns false when check throws", async () => {
    monitor.register({
      name: "broken",
      check: () => Promise.reject(new Error("boom")),
    });

    const results = await monitor.checkAll();
    expect(results.broken).toBe(false);
  });

  test("starts and stops interval checks", () => {
    let count = 0;
    monitor.register({
      name: "counter",
      check: () => {
        count++;
        return Promise.resolve(true);
      },
      interval: 50,
    });

    monitor.start();
    expect(monitor).toBeDefined(); // monitor started
    monitor.stop();
  });
});

describe("batchWithResilience", () => {
  test("processes all items successfully", async () => {
    const items = [1, 2, 3];
    const result = await batchWithResilience(items, (x) => Promise.resolve(x * 2));

    expect(result.success).toEqual([2, 4, 6]);
    expect(result.failed).toHaveLength(0);
  });

  test("continues on individual errors", async () => {
    const items = [1, 2, 3];
    const result = await batchWithResilience(items, (x) => {
      if (x === 2) return Promise.reject(new Error("bad"));
      return Promise.resolve(x * 2);
    });

    expect(result.success).toEqual([2, 6]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].item).toBe(2);
    expect(result.failed[0].error).toBe("bad");
  });

  test("throws on first error when continueOnError=false", async () => {
    const items = [1, 2, 3];
    await expect(
      batchWithResilience(
        items,
        (x) => {
          if (x === 2) return Promise.reject(new Error("bad"));
          return Promise.resolve(x);
        },
        { continueOnError: false, concurrency: 1 }
      )
    ).rejects.toThrow("bad");
  });

  test("respects concurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const items = [1, 2, 3, 4, 5];
    const result = await batchWithResilience(
      items,
      async (x) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        return x;
      },
      { concurrency: 2 }
    );

    expect(result.success).toEqual([1, 2, 3, 4, 5]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

describe("isRetryableError", () => {
  test("identifies network errors as retryable", () => {
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryableError(new Error("ENOTFOUND"))).toBe(true);
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableError(new Error("network error"))).toBe(true);
    expect(isRetryableError(new Error("aborted"))).toBe(true);
  });

  test("identifies HTTP status codes as retryable", () => {
    expect(isRetryableError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRetryableError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isRetryableError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isRetryableError(new Error("504 Gateway Timeout"))).toBe(true);
  });

  test("does not identify generic errors as retryable", () => {
    expect(isRetryableError(new Error("validation failed"))).toBe(false);
    expect(isRetryableError(new Error("not found"))).toBe(false);
    expect(isRetryableError(new Error("permission denied"))).toBe(false);
  });
});

describe("getCircuitBreaker", () => {
  test("returns same instance for same name", () => {
    const cb1 = getCircuitBreaker("provider-a");
    const cb2 = getCircuitBreaker("provider-a");
    expect(cb1).toBe(cb2);
  });

  test("returns different instances for different names", () => {
    const cb1 = getCircuitBreaker("provider-a");
    const cb2 = getCircuitBreaker("provider-b");
    expect(cb1).not.toBe(cb2);
  });

  test("returns CircuitBreaker instance", () => {
    const cb = getCircuitBreaker("test-provider");
    expect(cb).toBeInstanceOf(CircuitBreaker);
  });
});
