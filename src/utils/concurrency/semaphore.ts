/**
 * Counting Semaphore — async-safe mutual-exclusion primitive.
 *
 * Use cases:
 *   - Limit in-process concurrency to N (e.g. "max 8 parallel LLM calls").
 *   - Backpressure for async work without spawning unbounded tasks.
 *
 * Semantics:
 *   - `acquire()` resolves when a permit is available, then increments `active`.
 *   - `release()` decrements `active` and resolves the next waiter (FIFO).
 *   - `withPermit(fn)` is sugar for acquire → run fn → release, even on throw.
 *
 * Implementation notes:
 *   - Pure JS queue, no third-party deps. Works in Node 18+ and Bun.
 *   - FIFO ordering is preserved across acquire() calls; cancellation is NOT
 *     supported — callers that drop an acquire() promise will leak a waiter.
 *     Always wrap `withPermit()` so release is guaranteed.
 */

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class Semaphore {
  private _active = 0;
  private readonly _waiters: Waiter[] = [];

  constructor(public readonly permits: number) {
    if (!Number.isFinite(permits) || permits < 1) {
      throw new RangeError(`Semaphore permits must be ≥ 1 (got ${permits})`);
    }
  }

  /** Number of currently-held permits (running work). */
  get active(): number {
    return this._active;
  }

  /** Number of callers waiting for a permit. */
  get waiting(): number {
    return this._waiters.length;
  }

  /** Whether a permit is immediately available. */
  get isFree(): boolean {
    return this._active < this.permits;
  }

  /**
   * Acquire a permit. Resolves immediately if one is free; otherwise queues
   * until another caller releases. Never rejects unless the semaphore is closed.
   */
  acquire(): Promise<void> {
    if (this._active < this.permits) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  /** Release one permit, waking the oldest waiter if any. */
  release(): void {
    const w = this._waiters.shift();
    if (w) {
      // Permit ownership transfers directly to the waiter; _active stays equal.
      w.resolve();
      return;
    }
    if (this._active > 0) this._active--;
  }

  /**
   * Reject all queued waiters (e.g. on shutdown). In-flight work is unaffected;
   * their subsequent release() calls become no-ops that still decrement _active.
   */
  close(reason = "Semaphore closed"): void {
    while (this._waiters.length > 0) {
      const w = this._waiters.shift()!;
      w.reject(new Error(reason));
    }
  }

  /**
   * Run `fn` while holding one permit. The permit is released whether fn
   * resolves or throws. Returns fn's result.
   */
  async withPermit<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Functional helper: run an async function with `permits` concurrent
 * executions gated by a fresh semaphore. For repeated calls, prefer
 * `new Semaphore(n).withPermit(...)`.
 */
export async function withPermits<T>(
  permits: number,
  fn: () => Promise<T> | T
): Promise<T> {
  const sem = new Semaphore(permits);
  try {
    return await sem.withPermit(fn);
  } finally {
    sem.close("withPermits: one-shot semaphore");
  }
}