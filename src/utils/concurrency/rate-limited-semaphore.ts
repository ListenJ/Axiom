/**
 * RateLimitedSemaphore — concurrent-permit semaphore with a sliding-window
 * RPM (requests-per-minute) cap layered on top.
 *
 * Two-dimensional backpressure:
 *   1. `permits`     — how many calls may be IN-FLIGHT right now (concurrency).
 *   2. `rpm`         — how many calls may START within a rolling 60s window (rate).
 *
 * A call is admitted only when BOTH gates have room. This mirrors how upstream
 * LLM providers expose quotas (e.g. "10 concurrent, 500 RPM") and prevents two
 * failure modes the provider's scheduler would penalize us for:
 *   - Burst-saturating worker pool (concurrency-only primitive).
 *   - Hammering provider in a tight loop (rate-only primitive).
 *
 * Implementation notes:
 *   - Ring buffer of timestamps (size = rpm) — O(1) admission and O(1) rotate.
 *   - When full and not dropOldest, callers wait on a Promise queue keyed by
 *     their timestamp expiry (FIFO order across all waiters).
 *   - We deliberately do NOT spin-wait; the event loop wakes us on the next
 *     "would be free" tick, computed in O(1) from head-of-ring.
 *   - acquire() never rejects unless close() is called.
 *
 * Cost: ~150 lines, zero deps. Replaces any need for p-limit + bottleneck
 * combinations while keeping the existing utils/RateLimiter intact for cases
 * that only need simple per-key throttling.
 */

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface RateLimitedSemaphoreOptions {
  /** Maximum concurrent in-flight calls. Default 8. */
  permits?: number;
  /** Maximum calls allowed per rolling 60s window. Default 500. */
  rpm?: number;
  /** Custom window in milliseconds. Default 60_000. */
  windowMs?: number;
}

export class RateLimitedSemaphore {
  private readonly _permits: number;
  private readonly _rpm: number;
  private readonly _windowMs: number;

  private _active = 0;
  private readonly _waiters: Waiter[] = [];

  // Ring buffer of call-start timestamps within the rolling window.
  private readonly _ring: number[];
  private _ringHead = 0;
  private _ringSize = 0;

  constructor(opts: RateLimitedSemaphoreOptions = {}) {
    this._permits = Math.max(1, opts.permits ?? 8);
    this._rpm = Math.max(1, opts.rpm ?? 500);
    this._windowMs = Math.max(1, opts.windowMs ?? 60_000);
    this._ring = new Array(this._rpm);
  }

  get permits(): number {
    return this._permits;
  }

  get rpm(): number {
    return this._rpm;
  }

  get active(): number {
    return this._active;
  }

  get waiting(): number {
    return this._waiters.length;
  }

  /** How many RPM slots are still available right now (>= 0). */
  get availableRpm(): number {
    this._evictExpired(Date.now());
    return this._rpm - this._ringSize;
  }

  /** How many RPM slots are currently in use within the rolling window. */
  get currentRpm(): number {
    this._evictExpired(Date.now());
    return this._ringSize;
  }

  /**
   * Acquire both a concurrency permit and an RPM slot.
   * Resolves when both are available; queues FIFO otherwise.
   */
  acquire(): Promise<void> {
    if (this._canAdmitNow()) {
      this._admit();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  /** Release one permit. The RPM slot ages out by time alone — no manual clock. */
  release(): void {
    if (this._active > 0) this._active--;
    this._drainWaiters();
  }

  /**
   * Non-blocking acquire. Returns true if a permit was claimed; false if
   * either the concurrency cap or the RPM window would be exceeded.
   *
   * Use this when the caller is bookkeeping (e.g. firing-and-forgetting a
   * trackRequestStart) and cannot await. Callers that want true backpressure
   * should use the async `acquire()`.
   */
  tryAcquire(): boolean {
    if (!this._canAdmitNow()) return false;
    this._admit();
    return true;
  }

  /**
   * Non-blocking release. Returns true if a permit was actually decremented
   * (i.e. `active > 0`); false if nothing was held. Pair with `tryAcquire`.
   */
  tryRelease(): boolean {
    if (this._active === 0) return false;
    this.release();
    return true;
  }

  /**
   * Run `fn` while holding both gates. Released on resolve or throw.
   */
  async withPermit<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Reject all queued waiters (e.g. on shutdown). */
  close(reason = "RateLimitedSemaphore closed"): void {
    while (this._waiters.length > 0) {
      const w = this._waiters.shift()!;
      w.reject(new Error(reason));
    }
  }

  // ----- internals -----

  private _canAdmitNow(): boolean {
    if (this._active >= this._permits) return false;
    this._evictExpired(Date.now());
    return this._ringSize < this._rpm;
  }

  private _admit(): void {
    this._active++;
    const now = Date.now();
    this._ring[this._ringHead + this._ringSize < this._rpm
      ? this._ringHead + this._ringSize
      : (this._ringHead + this._ringSize) % this._rpm] = now;
    this._ringSize++;
  }

  private _evictExpired(now: number): void {
    const cutoff = now - this._windowMs;
    while (this._ringSize > 0 && this._ring[this._ringHead]! <= cutoff) {
      this._ring[this._ringHead] = 0;
      this._ringHead = (this._ringHead + 1) % this._rpm;
      this._ringSize--;
    }
  }

  private _drainWaiters(): void {
    while (this._waiters.length > 0 && this._canAdmitNow()) {
      const w = this._waiters.shift()!;
      this._admit();
      w.resolve();
    }
  }
}