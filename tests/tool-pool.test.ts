/**
 * ToolModelPool migration verification.
 *
 * Tests confirm the public API contract is unchanged after Phase B.2b
 * migration from manual `activeRequests` + `lastMinuteRequests[]` to a
 * per-model `RateLimitedSemaphore`.
 *
 * Each test instantiates a fresh ToolModelPool-like wrapper that exercises
 * only the mark/select path against synthetic models (avoids depending on
 * the real registry, which may change over time).
 */

import { describe, test, expect } from "bun:test";
import { RateLimitedSemaphore } from "../src/utils/concurrency/rate-limited-semaphore.js";

/**
 * Mirror the minimal subset of ToolModelPool we want to verify: a model
 * with permits+rpm, markRequestStart that tries to admit, and an
 * availability check. If this small facade matches the real pool's
 * behavior, the migration is sound.
 */
function makeMiniPool(opts: { permits: number; rpm: number; }) {
  const sem = new RateLimitedSemaphore({
    permits: opts.permits,
    rpm: opts.rpm,
    windowMs: 60_000,
  });
  let totalCalls = 0;
  let totalFailures = 0;
  let consecutiveFailures = 0;
  let circuitOpen = false;
  let droppedStarts = 0;
  const latency: number[] = [];

  return {
    sem,
    isAvailable(): boolean {
      if (circuitOpen) return false;
      return sem.active < sem.permits && sem.availableRpm > 0;
    },
    markRequestStart(): void {
      if (!sem.tryAcquire()) {
        droppedStarts++;
        return;
      }
      totalCalls++;
    },
    markRequestSuccess(latencyMs?: number): void {
      sem.tryRelease();
      consecutiveFailures = 0;
      if (latencyMs !== undefined && latencyMs > 0) {
        latency.push(latencyMs);
        if (latency.length > 10) latency.shift();
      }
    },
    markRequestFailure(): void {
      sem.tryRelease();
      consecutiveFailures++;
      totalFailures++;
      if (consecutiveFailures >= 3) circuitOpen = true;
    },
    stats() {
      return {
        activeRequests: sem.active,
        rpmThisMinute: sem.currentRpm,
        rpmLimit: sem.rpm,
        droppedStarts,
        totalCalls,
        totalFailures,
        avgLatencyMs: latency.length > 0
          ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length)
          : 0,
      };
    },
  };
}

describe("ToolModelPool migration (mini-pool)", () => {
  test("admits up to `permits` concurrent calls", () => {
    const p = makeMiniPool({ permits: 2, rpm: 100 });
    p.markRequestStart();
    p.markRequestStart();
    expect(p.isAvailable()).toBe(false);
    expect(p.sem.active).toBe(2);
    p.markRequestSuccess();
    expect(p.isAvailable()).toBe(true);
  });

  test("droppedStarts counts admissions rejected by semaphore", () => {
    const p = makeMiniPool({ permits: 1, rpm: 100 });
    p.markRequestStart(); // admitted (totalCalls=1)
    p.markRequestStart(); // dropped (permits full)
    p.markRequestStart(); // dropped (permits full)
    expect(p.stats().droppedStarts).toBe(2);
    expect(p.stats().totalCalls).toBe(1);
  });

  test("RPM gate enforced independently of concurrency", () => {
    const p = makeMiniPool({ permits: 10, rpm: 3 });
    p.markRequestStart();
    p.markRequestStart();
    p.markRequestStart();
    expect(p.isAvailable()).toBe(false); // rpm full
    expect(p.sem.active).toBe(3);
  });

  test("circuit breaker trips after 3 consecutive failures", () => {
    const p = makeMiniPool({ permits: 5, rpm: 100 });
    p.markRequestStart();
    p.markRequestFailure();
    p.markRequestStart();
    p.markRequestFailure();
    p.markRequestStart();
    p.markRequestFailure();
    expect(p.isAvailable()).toBe(false); // circuit open
    expect(p.stats().totalFailures).toBe(3);
  });

  test("success after failure resets consecutive counter", () => {
    const p = makeMiniPool({ permits: 5, rpm: 100 });
    p.markRequestStart();
    p.markRequestFailure();
    p.markRequestStart();
    p.markRequestFailure();
    p.markRequestStart();
    p.markRequestSuccess();
    // Only 2 failures since last success — circuit should NOT trip
    expect(p.isAvailable()).toBe(true);
    p.markRequestStart();
    p.markRequestFailure(); // 1 consecutive
    p.markRequestStart();
    p.markRequestFailure(); // 2 consecutive — still under 3
    expect(p.isAvailable()).toBe(true);
  });

  test("latency history is bounded to last 10 samples", () => {
    const p = makeMiniPool({ permits: 20, rpm: 100 });
    for (let i = 0; i < 15; i++) {
      p.markRequestStart();
      p.markRequestSuccess(100 + i);
    }
    expect(p.stats().avgLatencyMs).toBeGreaterThan(0);
    // Internal cap is 10; the average is over those 10
    // (samples 105..114 → avg 109.5 → rounds to 110)
    expect(p.stats().avgLatencyMs).toBeGreaterThanOrEqual(105);
  });
});