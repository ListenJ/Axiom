/**
 * Vault stats cache — async refresh, sync read.
 *
 * Phase P1-6: `vault.stats()` walks the SQLite index plus the in-memory
 * search engine, taking a few hundred microseconds. That's fine for
 * ad-hoc queries but it became a hot path inside the heartbeat loop
 * (every 30s) and the /health endpoint (every request). Each call also
 * briefly blocks the event loop on a sync method.
 *
 * What this provides:
 *   - A cached snapshot of vault.stats() that is read synchronously.
 *   - A background timer that refreshes the snapshot every N ms.
 *   - `init(vault)` to attach the live VaultManager and start the timer.
 *   - `invalidate()` for callers that know the vault changed (e.g. right
 *     after a write) and want to force the next read to refresh.
 *   - `stop()` for graceful shutdown.
 *
 * What this does NOT do:
 *   - It does NOT subscribe to vault file-watcher events. Callers that
 *     want event-driven refresh can call invalidate() after a write.
 */

import { logger } from "./logger.js";

interface VaultStatsLike {
  totalNotes: number;
  totalWords: number;
  totalTags: number;
  totalLinks: number;
  paraDistribution: Record<string, number>;
  cacheHitRate: number;
}

interface VaultManagerLike {
  stats(): VaultStatsLike;
}

const DEFAULT_REFRESH_MS = 10_000;
const REFRESH_ON_ERROR_BACKOFF_MS = 30_000;

export class VaultStatsCache {
  private _vault: VaultManagerLike | null = null;
  private _snapshot: VaultStatsLike | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _refreshMs: number = DEFAULT_REFRESH_MS;
  private _refreshing: Promise<void> | null = null;

  /** Number of times the background refresh ran. */
  get refreshCount(): number {
    return this._refreshCount;
  }
  private _refreshCount = 0;

  /** Number of times the cache was read before the first refresh completed. */
  get missCount(): number {
    return this._missCount;
  }
  private _missCount = 0;

  /** Last successful refresh timestamp (ms). 0 if never refreshed. */
  get lastRefreshedAt(): number {
    return this._lastRefreshedAt;
  }
  private _lastRefreshedAt = 0;

  init(vault: VaultManagerLike, refreshMs: number = DEFAULT_REFRESH_MS): void {
    this._vault = vault;
    this._refreshMs = Math.max(1_000, refreshMs);
    // Prime: do one immediate async refresh so the first /health call
    // after startup has real data.
    void this._refresh();
    this._timer = setInterval(() => {
      void this._refresh();
    }, this._refreshMs);
    if (typeof (this._timer as { unref?: () => void }).unref === "function") {
      (this._timer as { unref: () => void }).unref();
    }
    logger.info(`[VaultStatsCache] initialized, refreshMs=${this._refreshMs}`);
  }

  /**
   * Read the current cached stats. Returns `null` until the first
   * background refresh completes (typically < 100ms after init).
   */
  read(): VaultStatsLike | null {
    if (!this._snapshot) this._missCount++;
    return this._snapshot;
  }

  /**
   * Force the next background tick to refresh sooner. Use after
   * vault.writeNote() etc. to keep the cache from going stale.
   */
  invalidate(): void {
    if (this._vault) void this._refresh();
  }

  /** Stop the background timer. Safe to call multiple times. */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ----- internals -----

  private async _refresh(): Promise<void> {
    if (!this._vault) return;
    if (this._refreshing) return this._refreshing; // de-dup concurrent refresh
    this._refreshing = (async () => {
      try {
        // vault.stats() is synchronous, but wrap in microtask to avoid
        // blocking the event loop. setImmediate yields first.
        await new Promise<void>((r) => setImmediate(r));
        const stats = this._vault!.stats();
        this._snapshot = stats;
        this._lastRefreshedAt = Date.now();
        this._refreshCount++;
      } catch (err) {
        logger.warn(
          `[VaultStatsCache] refresh failed`,
          { error: err instanceof Error ? err.message : String(err) },
        );
        // Backoff: skip the next tick to avoid hot-loop on a broken vault.
        if (this._timer) {
          clearInterval(this._timer);
          this._timer = setInterval(() => void this._refresh(), REFRESH_ON_ERROR_BACKOFF_MS);
          if (typeof (this._timer as { unref?: () => void }).unref === "function") {
            (this._timer as { unref: () => void }).unref();
          }
        }
      } finally {
        this._refreshing = null;
      }
    })();
    return this._refreshing;
  }
}

/** Process-wide singleton. */
export const vaultStatsCache = new VaultStatsCache();