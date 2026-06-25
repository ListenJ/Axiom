/**
 * Concurrency primitives — unit tests.
 *
 * Coverage:
 *   - Semaphore: acquire/release FIFO, withPermit error path, close().
 *   - BoundedQueue: capacity, dropOldest policy, drain order.
 *   - RateLimitedSemaphore: concurrency cap, RPM cap, sliding window decay.
 *
 * Tests avoid fixed-time sleeps where possible — they poll state with
 * tight deadlines and fail fast if invariants don't hold. The only wall-clock
 * assumption is that setTimeout(0) resolves "soon", which is reliable in
 * Bun's event loop for non-trivial Promise queues.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";

import {
  Semaphore,
  BoundedQueue,
  RateLimitedSemaphore,
  withPermits,
} from "../src/utils/concurrency/index.js";

// Helper: resolve a deferred promise after N microtask hops. This is a
// deterministic way to "release after the waiter has definitely queued".
const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

// Helper: poll `pred()` up to `timeoutMs`; resolve true if it becomes true.
async function waitFor(
  pred: () => boolean,
  timeoutMs = 500,
  intervalMs = 5,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return pred();
}

describe("Semaphore", () => {
  test("constructor rejects invalid permits", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(-1)).toThrow(RangeError);
    expect(() => new Semaphore(Number.NaN)).toThrow(RangeError);
  });

  test("acquire resolves immediately when permits are free", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    expect(sem.active).toBe(1);
    await sem.acquire();
    expect(sem.active).toBe(2);
    expect(sem.isFree).toBe(false);
  });

  test("FIFO ordering across concurrent acquirers", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const promises = [1, 2, 3].map((i) =>
      sem.acquire().then(() => {
        order.push(i);
        // Hold briefly so all three queue up before any release.
        setTimeout(() => sem.release(), 10);
      }),
    );
    // Wait for all three to acquire in FIFO order.
    const ok = await waitFor(() => order.length === 3, 500);
    expect(ok).toBe(true);
    expect(order).toEqual([1, 2, 3]);
    await Promise.all(promises);
  });

  test("release without waiting waiter decrements active", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2);
    sem.release();
    expect(sem.active).toBe(1);
  });

  test("withPermit releases on throw", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.withPermit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sem.active).toBe(0);
    // Semaphore should still be usable after the throw.
    const result = await sem.withPermit(async () => 42);
    expect(result).toBe(42);
  });

  test("close() rejects queued waiters but not in-flight work", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const p = sem.acquire(); // queues
    sem.close("shutdown");
    await expect(p).rejects.toThrow("shutdown");
    // The held permit can still be released cleanly.
    expect(() => sem.release()).not.toThrow();
    expect(sem.active).toBe(0);
  });

  test("withPermits helper creates and tears down one-shot semaphore", async () => {
    const result = await withPermits(3, async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("BoundedQueue", () => {
  test("push returns false when full", () => {
    const q = new BoundedQueue<number>({ capacity: 2 });
    expect(q.push(1)).toBe(true);
    expect(q.push(2)).toBe(true);
    expect(q.push(3)).toBe(false);
    expect(q.size).toBe(2);
    expect(q.droppedCount).toBe(0);
  });

  test("dropOldest evicts and counts", () => {
    const q = new BoundedQueue<number>({ capacity: 2, dropOldest: true });
    q.push(1);
    q.push(2);
    q.push(3); // evicts 1
    expect(q.droppedCount).toBe(1);
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.isEmpty).toBe(true);
  });

  test("FIFO drain order", () => {
    const q = new BoundedQueue<string>({ capacity: 4 });
    ["a", "b", "c"].forEach((s) => q.push(s));
    expect(q.drain()).toEqual(["a", "b", "c"]);
    expect(q.isEmpty).toBe(true);
  });

  test("peek does not mutate", () => {
    const q = new BoundedQueue<number>({ capacity: 3 });
    q.push(7);
    expect(q.peek()).toBe(7);
    expect(q.size).toBe(1);
    expect(q.peek()).toBe(7);
  });

  test("inspect yields items without removing", () => {
    const q = new BoundedQueue<number>({ capacity: 4 });
    [10, 20, 30].forEach((n) => q.push(n));
    const seen: number[] = [];
    q.inspect((n) => seen.push(n));
    expect(seen).toEqual([10, 20, 30]);
    expect(q.size).toBe(3);
  });

  test("clear resets and reports count", () => {
    const q = new BoundedQueue<number>({ capacity: 4 });
    q.push(1);
    q.push(2);
    expect(q.clear()).toBe(2);
    expect(q.isEmpty).toBe(true);
    // capacity is preserved
    expect(q.push(3)).toBe(true);
    expect(q.shift()).toBe(3);
  });

  test("ring buffer wraps correctly past capacity", () => {
    const q = new BoundedQueue<number>({ capacity: 3 });
    q.push(1);
    q.push(2);
    q.push(3);
    q.shift();
    q.shift();
    q.push(4); // tail wraps to index 0
    q.push(5); // tail at index 1
    // Queue is now full; without dropOldest, push(6) is rejected.
    expect(q.push(6)).toBe(false);
    const drained = q.drain();
    expect(drained).toEqual([3, 4, 5]);
  });

  test("ring buffer with dropOldest evicts across wrap", () => {
    const q = new BoundedQueue<number>({ capacity: 3, dropOldest: true });
    q.push(1);
    q.push(2);
    q.push(3);
    q.shift();              // 1 evicted manually
    q.push(4);              // tail wraps to index 0
    q.push(5);              // evicts 3, tail at index 2
    q.push(6);              // evicts 4, tail wraps to index 0
    q.push(7);              // evicts 5, tail at index 1
    // Three evictions total across the four pushes past capacity.
    expect(q.droppedCount).toBe(3);
    expect(q.drain()).toEqual([5, 6, 7]);
  });
});

describe("RateLimitedSemaphore", () => {
  test("admits up to `permits` concurrently", async () => {
    const sem = new RateLimitedSemaphore({ permits: 2, rpm: 1000 });
    await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2);
    // Third acquire must queue.
    let resolved = false;
    const p = sem.acquire().then(() => {
      resolved = true;
    });
    await nextTick();
    expect(resolved).toBe(false);
    sem.release();
    const ok = await waitFor(() => resolved);
    expect(ok).toBe(true);
    await p;
  });

  test("RPM gate caps admissions in a single window", async () => {
    // Short window keeps the test under 1s while exercising real timing.
    const sem = new RateLimitedSemaphore({ permits: 100, rpm: 3, windowMs: 80 });
    expect(await sem.acquire()).toBeUndefined();
    expect(await sem.acquire()).toBeUndefined();
    expect(await sem.acquire()).toBeUndefined();
    // Fourth call must queue.
    let resolved = false;
    const p = sem.acquire().then(() => {
      resolved = true;
    });
    await nextTick();
    expect(resolved).toBe(false);
    // Release one in-flight permit after the window expires; the drain
    // logic then wakes the queued waiter (both gates are now open).
    setTimeout(() => sem.release(), 100);
    const ok = await waitFor(() => resolved, 500);
    expect(ok).toBe(true);
    await p;
  });

  test("availableRpm reflects sliding window state", async () => {
    const sem = new RateLimitedSemaphore({ permits: 100, rpm: 3, windowMs: 60 });
    expect(sem.availableRpm).toBe(3);
    await sem.acquire();
    expect(sem.availableRpm).toBe(2);
    await new Promise((r) => setTimeout(r, 80));
    // After window passes, the slot should be reclaimed.
    expect(sem.availableRpm).toBe(3);
  });

  test("withPermit releases on success and throw", async () => {
    const sem = new RateLimitedSemaphore({ permits: 1, rpm: 5 });
    await expect(
      sem.withPermit(async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(sem.active).toBe(0);
    const result = await sem.withPermit(async () => "ok");
    expect(result).toBe("ok");
  });

  test("close rejects queued waiters", async () => {
    const sem = new RateLimitedSemaphore({ permits: 1, rpm: 100 });
    await sem.acquire();
    const p = sem.acquire();
    sem.close("test-shutdown");
    await expect(p).rejects.toThrow("test-shutdown");
  });

  test("tryAcquire succeeds while capacity available, fails when exhausted", () => {
    const sem = new RateLimitedSemaphore({ permits: 2, rpm: 2 });
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false); // both gates full
    expect(sem.active).toBe(2);
  });

  test("tryRelease is no-op when nothing held", () => {
    const sem = new RateLimitedSemaphore({ permits: 1, rpm: 10 });
    expect(sem.tryRelease()).toBe(false);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryRelease()).toBe(true);
    expect(sem.active).toBe(0);
  });

  test("tryAcquire respects RPM cap independently of concurrency", () => {
    const sem = new RateLimitedSemaphore({ permits: 10, rpm: 2 });
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false); // rpm=2, concurrency=10 → rpm gates
    expect(sem.active).toBe(2);
  });
});