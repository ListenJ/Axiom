/**
 * VaultStatsCache — unit tests.
 *
 * The cache is read-sync, refresh-async. We use a fake vault object so the
 * tests don't depend on the real VaultManager (which would need a temp
 * directory, index time, and file IO).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { VaultStatsCache } from "../src/utils/vault-stats-cache.js";

function makeFakeVault(initial: { notes: number; words: number; tags: number; links: number }) {
  let counter = 0;
  let last = { ...initial };
  return {
    stats: () => {
      counter++;
      return {
        totalNotes: last.notes,
        totalWords: last.words,
        totalTags: last.tags,
        totalLinks: last.links,
        paraDistribution: { "01-Projects": 5 },
        cacheHitRate: 0.5,
      };
    },
    set(next: { notes: number; words: number; tags: number; links: number }): void {
      last = next;
    },
    calls: () => counter,
  };
}

describe("VaultStatsCache", () => {
  let cache: VaultStatsCache;

  beforeEach(() => {
    cache = new VaultStatsCache();
  });

  afterEach(() => {
    cache.stop();
  });

  test("read() before init returns null", () => {
    expect(cache.read()).toBeNull();
  });

  test("init() primes cache and start background refresh", async () => {
    const v = makeFakeVault({ notes: 10, words: 100, tags: 5, links: 3 });
    cache.init(v, 1000);

    // Prime happens async; wait for first refresh.
    const ok = await waitFor(() => cache.read() !== null, 200);
    expect(ok).toBe(true);
    expect(cache.read()?.totalNotes).toBe(10);
    expect(cache.refreshCount).toBeGreaterThanOrEqual(1);
  });

  test("read() is sync and does not call vault.stats()", async () => {
    const v = makeFakeVault({ notes: 5, words: 50, tags: 2, links: 1 });
    cache.init(v, 60_000); // long refresh, no ticks expected during the test
    await waitFor(() => cache.read() !== null, 200);
    const callsAfterInit = v.calls();
    // 5 sync reads should not bump vault.stats() call count
    for (let i = 0; i < 5; i++) cache.read();
    expect(v.calls()).toBe(callsAfterInit);
  });

  test("invalidate() triggers an extra refresh", async () => {
    const v = makeFakeVault({ notes: 1, words: 10, tags: 0, links: 0 });
    cache.init(v, 60_000);
    await waitFor(() => cache.read() !== null, 200);
    v.set({ notes: 99, words: 999, tags: 9, links: 9 });
    cache.invalidate();
    const ok = await waitFor(() => cache.read()?.totalNotes === 99, 200);
    expect(ok).toBe(true);
  });

  test("stop() halts the background timer", async () => {
    const v = makeFakeVault({ notes: 1, words: 1, tags: 0, links: 0 });
    cache.init(v, 50);
    await waitFor(() => cache.refreshCount >= 2, 300);
    const before = cache.refreshCount;
    cache.stop();
    await new Promise((r) => setTimeout(r, 150));
    expect(cache.refreshCount).toBe(before);
  });

  test("backoff on error: missing vault.stats() throws → timer slows", async () => {
    const brokenVault = {
      stats: () => { throw new Error("vault not ready"); },
    };
    cache.init(brokenVault, 50);
    // The first refresh will fail; backoff should kick in and stop the
    // rapid retries. We can't assert the exact backoff without a real
    // timer mock, but we can assert that missCount grows (since the
    // cache never gets a value).
    await new Promise((r) => setTimeout(r, 200));
    expect(cache.read()).toBeNull();
    expect(cache.missCount).toBeGreaterThan(0);
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  return pred();
}