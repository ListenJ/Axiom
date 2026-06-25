/**
 * ApprovalBridge — unit tests.
 *
 * Covers the four core paths:
 *   - register a handler → request → handler calls resolve(true) → resolves true
 *   - same flow with resolve(false) → resolves false
 *   - no handlers → auto-deny after 1s (fail-safe)
 *   - timeout → rejects with "approval-timeout"
 *   - settle unknown id → returns false (no-op)
 *   - denyAll() rejects every pending request
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  ApprovalBridge,
  setApprovalBridge,
  getApprovalBridge,
} from "../src/utils/approval-bridge.js";

describe("ApprovalBridge", () => {
  let bridge: ApprovalBridge;

  beforeEach(() => {
    bridge = new ApprovalBridge();
    setApprovalBridge(bridge);
  });

  afterEach(() => {
    setApprovalBridge(new ApprovalBridge());
  });

  test("approve path: handler resolves true", async () => {
    bridge.onRequest(async (req) => {
      // Simulate user clicking "Approve" in dashboard
      setTimeout(() => bridge.resolve(req.id, true), 10);
    });
    const ok = await bridge.request("fs_delete", { path: "/tmp/x" });
    expect(ok).toBe(true);
    expect(bridge.pendingCount).toBe(0);
  });

  test("deny path: handler resolves false", async () => {
    bridge.onRequest(async (req) => {
      setTimeout(() => bridge.resolve(req.id, false), 10);
    });
    const ok = await bridge.request("fs_delete", { path: "/tmp/x" });
    expect(ok).toBe(false);
  });

  test("no handler: auto-deny after 1s (fail-safe)", async () => {
    const start = Date.now();
    const ok = await bridge.request("fs_delete", { path: "/tmp/x" });
    const elapsed = Date.now() - start;
    expect(ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(900); // ~1s backstop
    expect(elapsed).toBeLessThan(2000);
  });

  test("timeout: rejects with approval-timeout when not answered", async () => {
    bridge.onRequest(async () => {
      // Never resolve — simulate a user that walked away
    });
    let err: Error | null = null;
    try {
      await bridge.request("fs_delete", { path: "/tmp/x" }, { timeoutMs: 200 });
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    expect(err?.message).toBe("approval-timeout");
  });

  test("resolve() on unknown id returns false (idempotent)", () => {
    expect(bridge.resolve("nonexistent-id", true)).toBe(false);
  });

  test("denyAll() rejects every pending request", async () => {
    const promises: Promise<boolean>[] = [];
    for (let i = 0; i < 3; i++) {
      promises.push(bridge.request(`tool-${i}`, {}, { timeoutMs: 60_000 }));
    }
    expect(bridge.pendingCount).toBe(3);
    const n = bridge.denyAll("test-shutdown");
    expect(n).toBe(3);
    expect(bridge.pendingCount).toBe(0);
    const results = await Promise.all(promises.map((p) => p.catch((e) => e)));
    // denyAll during shutdown rejects (timeout-equivalent) the remaining waiters
    for (const r of results) {
      if (r instanceof Error) expect(r.message).toBe("test-shutdown");
      else expect(r).toBe(false);
    }
  });

  test("listPending() reflects in-flight requests", async () => {
    bridge.onRequest(() => {/* never resolve */});
    const promises = [
      bridge.request("fs_write", { path: "/a" }, { timeoutMs: 60_000 }),
      bridge.request("fs_delete", { path: "/b" }, { timeoutMs: 60_000 }),
    ];
    // listPending must reflect both immediately
    expect(bridge.listPending()).toHaveLength(2);
    expect(bridge.listPending().map((r) => r.tool).sort()).toEqual(["fs_delete", "fs_write"]);
    // Cleanup so the promises don't hang the test
    bridge.denyAll("test-teardown");
    const results = await Promise.allSettled(promises);
    expect(results).toHaveLength(2);
  });

  test("module-level getApprovalBridge() returns the installed bridge", () => {
    const custom = new ApprovalBridge();
    setApprovalBridge(custom);
    expect(getApprovalBridge()).toBe(custom);
  });

  test("onRequest returns an unsubscribe function", async () => {
    let called = 0;
    const off = bridge.onRequest((req) => {
      called++;
      // Resolve so the request completes — handlers that just log without
      // resolving would hang the test for 1s (the no-handler backstop).
      bridge.resolve(req.id, true);
    });
    const ok = await bridge.request("t1", {});
    off();
    expect(ok).toBe(true);
    expect(called).toBe(1);
    // A second request after unsubscribe → no handler → auto-deny after 1s
    const t0 = Date.now();
    const ok2 = await bridge.request("t2", {});
    expect(ok2).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });
});