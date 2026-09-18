/**
 * Enhanced tests for runtime modules:
 * - scheduler.ts: preemption, retry backoff, deadline expiry, getTask, reset
 * - capability-registry.ts: usageCount single-source, unregisterProvider, getCapability, reset
 * - knowledge-network.ts: delete (with link cleanup), update, link, reset, timeline cap
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { scheduler, type ScheduledTask } from "../../src/dre/runtime/scheduler.js";
import { capabilityRegistry, type CapabilityContract } from "../../src/dre/runtime/capability-registry.js";
import { knowledgeNetwork } from "../../src/dre/runtime/knowledge-network.js";
import { atomStore } from "../../src/dre/runtime/atom-engine.js";

// ========== Scheduler ==========

describe("Scheduler: enhanced", () => {
  beforeEach(() => {
    scheduler.reset();
  });

  afterEach(() => {
    scheduler.reset();
  });

  test("submit + getNext returns highest priority task first", () => {
    scheduler.submit({ name: "low", priority: "low", payload: {}, maxRetries: 0, dependencies: [] });
    scheduler.submit({ name: "critical", priority: "critical", payload: {}, maxRetries: 0, dependencies: [] });
    scheduler.submit({ name: "normal", priority: "normal", payload: {}, maxRetries: 0, dependencies: [] });

    const first = scheduler.getNext();
    expect(first?.name).toBe("critical");
    const second = scheduler.getNext();
    expect(second?.name).toBe("normal");
  });

  test("getNext respects dependency completion", () => {
    const dep = scheduler.submit({
      name: "dep", priority: "normal", payload: {}, maxRetries: 0, dependencies: [],
    });
    const next = scheduler.getNext();
    expect(next?.id).toBe(dep.id);
    scheduler.complete(dep.id, { ok: true });

    const dependent = scheduler.submit({
      name: "dependent",
      priority: "normal",
      payload: {},
      maxRetries: 0,
      dependencies: [dep.id],
    });
    const fetched = scheduler.getNext();
    expect(fetched?.id).toBe(dependent.id);
  });

  test("getNext returns null when dependency not yet completed", () => {
    const dep = scheduler.submit({
      name: "dep", priority: "normal", payload: {}, maxRetries: 0, dependencies: [],
    });
    // Don't complete dep — pull it to running so it's not in completed
    scheduler.getNext();

    scheduler.submit({
      name: "dependent",
      priority: "normal",
      payload: {},
      maxRetries: 0,
      dependencies: [dep.id],
    });
    expect(scheduler.getNext()).toBeNull();
  });

  test("deadline expiry auto-fails pending tasks", () => {
    const task = scheduler.submit({
      name: "expired",
      priority: "normal",
      payload: {},
      maxRetries: 0,
      dependencies: [],
      deadline: Date.now() - 1000, // already expired
    });
    // getNext triggers expirePendingTasks
    scheduler.getNext();
    const found = scheduler.getTask(task.id);
    expect(found?.status).toBe("failed");
    expect(found?.error).toContain("Deadline exceeded");
  });

  test("fail() with retry sets exponential backoff via notBefore", () => {
    const task = scheduler.submit({
      name: "retryable",
      priority: "normal",
      payload: {},
      maxRetries: 3,
      dependencies: [],
    });
    scheduler.getNext(); // pull to running
    scheduler.fail(task.id, "transient error");

    const queued = scheduler.getTask(task.id);
    expect(queued?.status).toBe("pending");
    expect(queued?.retries).toBe(1);
    expect(queued?.notBefore).toBeGreaterThan(Date.now() - 10);
    // First retry backoff = 100ms
    expect(queued?.notBefore! - Date.now()).toBeLessThanOrEqual(150);
  });

  test("getNext skips tasks whose backoff hasn't elapsed", () => {
    const task = scheduler.submit({
      name: "backoff",
      priority: "normal",
      payload: {},
      maxRetries: 3,
      dependencies: [],
    });
    scheduler.getNext();
    scheduler.fail(task.id, "err");

    // Should not be returned because notBefore is in the future
    const fetched = scheduler.getNext();
    expect(fetched?.id).not.toBe(task.id);
  });

  test("fail() with retries exhausted marks task as failed", () => {
    const task = scheduler.submit({
      name: "doomed",
      priority: "normal",
      payload: {},
      maxRetries: 2, // 2 retries allowed = 3 total attempts
      dependencies: [],
    });
    scheduler.getNext();
    scheduler.fail(task.id, "err1"); // retries=1, 1<=2 → retry
    expect(scheduler.getTask(task.id)?.status).toBe("pending");

    // Force backoff elapsed
    const queued = scheduler.getTask(task.id);
    if (queued) queued.notBefore = 0;
    scheduler.getNext();
    scheduler.fail(task.id, "err2"); // retries=2, 2<=2 → retry
    expect(scheduler.getTask(task.id)?.status).toBe("pending");

    // Force backoff elapsed again
    const queued2 = scheduler.getTask(task.id);
    if (queued2) queued2.notBefore = 0;
    scheduler.getNext();
    scheduler.fail(task.id, "err3"); // retries=3, 3<=2 false → failed

    const final = scheduler.getTask(task.id);
    expect(final?.status).toBe("failed");
    expect(final?.retries).toBe(3);
  });

  test("maxRetries=0 means immediate failure with no retry", () => {
    const task = scheduler.submit({
      name: "no-retry",
      priority: "normal",
      payload: {},
      maxRetries: 0,
      dependencies: [],
    });
    scheduler.getNext();
    scheduler.fail(task.id, "err");

    const final = scheduler.getTask(task.id);
    expect(final?.status).toBe("failed");
    expect(final?.retries).toBe(1);
  });

  test("preemption: critical task preempts running low-priority task when slots full", () => {
    scheduler.setBudget({ maxConcurrentTasks: 1, maxTokensPerMinute: 100000, maxMemoryMB: 4096 });

    const low = scheduler.submit({
      name: "low", priority: "low", payload: {}, maxRetries: 0, dependencies: [],
    });
    const started = scheduler.getNext();
    expect(started?.id).toBe(low.id);

    // Now slot is full; submit critical
    const critical = scheduler.submit({
      name: "critical", priority: "critical", payload: {}, maxRetries: 0, dependencies: [],
    });
    const next = scheduler.getNext();
    expect(next?.id).toBe(critical.id);

    // Low should be re-queued (not lost) — status back to pending
    const lowTask = scheduler.getTask(low.id);
    expect(lowTask?.status).toBe("pending");
    expect(lowTask?.error).toContain("Preempted");
  });

  test("preemption does not occur for normal-priority running tasks", () => {
    scheduler.setBudget({ maxConcurrentTasks: 1, maxTokensPerMinute: 100000, maxMemoryMB: 4096 });

    const normal = scheduler.submit({
      name: "normal", priority: "normal", payload: {}, maxRetries: 0, dependencies: [],
    });
    scheduler.getNext();

    scheduler.submit({
      name: "critical", priority: "critical", payload: {}, maxRetries: 0, dependencies: [],
    });
    const next = scheduler.getNext();
    expect(next).toBeNull(); // No preemption of normal-priority

    const normalTask = scheduler.getTask(normal.id);
    expect(normalTask?.status).toBe("running");
  });

  test("getTask looks up tasks in any state", () => {
    const t = scheduler.submit({
      name: "lookup", priority: "normal", payload: {}, maxRetries: 0, dependencies: [],
    });
    expect(scheduler.getTask(t.id)?.id).toBe(t.id);

    scheduler.getNext();
    expect(scheduler.getTask(t.id)?.status).toBe("running");

    scheduler.complete(t.id, "done");
    expect(scheduler.getTask(t.id)?.status).toBe("completed");
  });

  test("getTask returns undefined for unknown id", () => {
    expect(scheduler.getTask("nonexistent")).toBeUndefined();
  });

  test("reset clears all state", () => {
    scheduler.submit({ name: "a", priority: "normal", payload: {}, maxRetries: 0, dependencies: [] });
    scheduler.getNext();
    scheduler.reset();
    const status = scheduler.getStatus();
    expect(status.queued).toBe(0);
    expect(status.running).toBe(0);
    expect(status.completed).toBe(0);
    expect(status.budget.currentTasks).toBe(0);
  });

  test("completed history is trimmed to maxCompletedHistory (100)", () => {
    for (let i = 0; i < 120; i++) {
      const t = scheduler.submit({
        name: `t${i}`, priority: "normal", payload: {}, maxRetries: 0, dependencies: [],
      });
      scheduler.getNext();
      scheduler.complete(t.id, i);
    }
    const status = scheduler.getStatus();
    expect(status.completed).toBeLessThanOrEqual(100);
  });
});

// ========== CapabilityRegistry ==========

describe("CapabilityRegistry: enhanced", () => {
  beforeEach(() => {
    capabilityRegistry.reset();
  });

  afterEach(() => {
    capabilityRegistry.reset();
  });

  function registerProvider(id: string, contract: CapabilityContract, reliability = 0.9) {
    capabilityRegistry.registerProvider({
      id,
      name: id,
      type: "internal",
      capabilities: [contract],
      costPerCall: 0,
      avgLatencyMs: 100,
      reliability,
      maxConcurrency: 4,
      metadata: {},
    });
  }

  test("select() does NOT increment usageCount (single-source via recordResult)", () => {
    registerProvider("p1", "code.reasoning");
    const selected = capabilityRegistry.select("code.reasoning");
    expect(selected).not.toBeNull();
    expect(selected?.usageCount).toBe(0); // select should not bump usageCount
  });

  test("recordResult() increments usageCount and updates successRate", () => {
    registerProvider("p1", "code.reasoning");
    const selected = capabilityRegistry.select("code.reasoning")!;
    capabilityRegistry.recordResult(selected.id, true);

    const cap = capabilityRegistry.getCapability(selected.id);
    expect(cap?.usageCount).toBe(1);
    expect(cap?.successRate).toBe(1.0);
  });

  test("successRate math is correct after multiple calls (no double-counting)", () => {
    registerProvider("p1", "code.reasoning");
    const selected = capabilityRegistry.select("code.reasoning")!;

    capabilityRegistry.recordResult(selected.id, true);
    capabilityRegistry.recordResult(selected.id, false);

    const cap = capabilityRegistry.getCapability(selected.id);
    expect(cap?.usageCount).toBe(2);
    // successRate = (1.0 * 1 + 0) / 2 = 0.5
    expect(cap?.successRate).toBe(0.5);
  });

  test("unregisterProvider removes provider and its capabilities", () => {
    registerProvider("p1", "code.reasoning");
    registerProvider("p2", "code.generation");

    expect(capabilityRegistry.getProviders().length).toBe(2);
    expect(capabilityRegistry.list().length).toBe(2);

    const removed = capabilityRegistry.unregisterProvider("p1");
    expect(removed).toBe(true);

    expect(capabilityRegistry.getProviders().length).toBe(1);
    expect(capabilityRegistry.list().length).toBe(1);
    expect(capabilityRegistry.listByContract("code.reasoning").length).toBe(0);
    expect(capabilityRegistry.listByContract("code.generation").length).toBe(1);
  });

  test("unregisterProvider returns false for unknown provider", () => {
    expect(capabilityRegistry.unregisterProvider("nonexistent")).toBe(false);
  });

  test("getCapability returns capability by id", () => {
    registerProvider("p1", "code.reasoning");
    const selected = capabilityRegistry.select("code.reasoning")!;
    const cap = capabilityRegistry.getCapability(selected.id);
    expect(cap?.id).toBe(selected.id);
  });

  test("getCapability returns undefined for unknown id", () => {
    expect(capabilityRegistry.getCapability("nonexistent")).toBeUndefined();
  });

  test("select() returns null when no provider matches contract (fallback++)", () => {
    const statsBefore = capabilityRegistry.getStats();
    const selected = capabilityRegistry.select("code.reasoning");
    expect(selected).toBeNull();
    const statsAfter = capabilityRegistry.getStats();
    expect(statsAfter.fallbacks).toBe(statsBefore.fallbacks + 1);
  });

  test("select() respects maxCost filter", () => {
    capabilityRegistry.registerProvider({
      id: "free",
      name: "Free",
      type: "internal",
      capabilities: ["code.reasoning"],
      costPerCall: 0,
      avgLatencyMs: 100,
      reliability: 0.7,
      maxConcurrency: 4,
      metadata: {},
    });
    capabilityRegistry.registerProvider({
      id: "paid",
      name: "Paid",
      type: "external",
      capabilities: ["code.reasoning"],
      costPerCall: 0.05,
      avgLatencyMs: 100,
      reliability: 0.99,
      maxConcurrency: 4,
      metadata: {},
    });
    const selected = capabilityRegistry.select("code.reasoning", { maxCost: 0.01 });
    expect(selected?.provider.id).toBe("free");
  });

  test("recordResult updates provider reliability with EMA", () => {
    registerProvider("p1", "code.reasoning", 0.9);
    const selected = capabilityRegistry.select("code.reasoning")!;
    const originalReliability = selected.provider.reliability;
    capabilityRegistry.recordResult(selected.id, false);

    const cap = capabilityRegistry.getCapability(selected.id);
    // EMA: 0.9 * 0.9 + 0 = 0.81
    expect(cap?.provider.reliability).toBeCloseTo(0.81, 5);
    expect(cap?.provider.reliability).toBeLessThan(originalReliability);
  });

  test("reset clears providers, capabilities, and stats", () => {
    registerProvider("p1", "code.reasoning");
    capabilityRegistry.select("code.reasoning");
    capabilityRegistry.reset();
    const stats = capabilityRegistry.getStats();
    expect(stats.providers).toBe(0);
    expect(stats.capabilities).toBe(0);
    expect(stats.searches).toBe(0);
    expect(stats.selections).toBe(0);
  });
});

// ========== KnowledgeNetwork ==========

describe("KnowledgeNetwork: enhanced", () => {
  beforeEach(() => {
    knowledgeNetwork.reset();
  });

  afterEach(() => {
    knowledgeNetwork.reset();
  });

  test("update() changes name and content with version bump", () => {
    const e = knowledgeNetwork.create("concept", "Original", "original content");
    const initialVersion = e.version;

    const ok = knowledgeNetwork.update(e.id, { name: "Updated", content: "new content" });
    expect(ok).toBe(true);

    const after = knowledgeNetwork.get(e.id);
    expect(after?.name).toBe("Updated");
    expect(after?.content).toBe("new content");
    expect(after?.version).toBe(initialVersion + 1);

    // Timeline should record the update
    const tl = knowledgeNetwork.getTimeline(e.id);
    expect(tl.some((t) => t.event.includes("updated"))).toBe(true);
  });

  test("update() with no-op patch returns true without version bump", () => {
    const e = knowledgeNetwork.create("concept", "Same", "same content");
    const initialVersion = e.version;
    const ok = knowledgeNetwork.update(e.id, { name: "Same", content: "same content" });
    expect(ok).toBe(true);
    expect(knowledgeNetwork.get(e.id)?.version).toBe(initialVersion);
  });

  test("update() returns false for unknown entity", () => {
    expect(knowledgeNetwork.update("nonexistent", { name: "x" })).toBe(false);
  });

  test("delete() removes entity from all indexes", () => {
    const e = knowledgeNetwork.create("concept", "ToDelete", "content");
    expect(knowledgeNetwork.getStats().total).toBe(1);
    expect(knowledgeNetwork.queryByKind("concept").length).toBe(1);

    const ok = knowledgeNetwork.delete(e.id);
    expect(ok).toBe(true);
    expect(knowledgeNetwork.get(e.id)).toBeUndefined();
    expect(knowledgeNetwork.getStats().total).toBe(0);
    expect(knowledgeNetwork.queryByKind("concept").length).toBe(0);
  });

  test("delete() returns false for unknown entity", () => {
    expect(knowledgeNetwork.delete("nonexistent")).toBe(false);
  });

  test("delete() also removes links referencing the entity", () => {
    const a = knowledgeNetwork.create("concept", "A", "a");
    const b = knowledgeNetwork.create("concept", "B", "b");
    const link = knowledgeNetwork.link(a.id, b.id, "depends-on");
    expect(link).not.toBeNull();

    // Delete A — link should be gone too
    knowledgeNetwork.delete(a.id);
    expect(knowledgeNetwork.getLinksTo(b.id).length).toBe(0);

    // Recreate A and try to link — should fail because A no longer exists
    const a2 = knowledgeNetwork.create("concept", "A2", "a2");
    // (link from a2 to b is fine, but old link from a to b is gone)
    const newLink = knowledgeNetwork.link(a2.id, b.id, "depends-on");
    expect(newLink).not.toBeNull();
  });

  test("link() creates directed edge between entities", () => {
    const a = knowledgeNetwork.create("concept", "A", "a");
    const b = knowledgeNetwork.create("concept", "B", "b");
    const link = knowledgeNetwork.link(a.id, b.id, "related-to", { weight: 0.8 });

    expect(link).not.toBeNull();
    expect(link?.relation).toBe("related-to");
    expect(link?.weight).toBe(0.8);

    expect(knowledgeNetwork.getLinksFrom(a.id).length).toBe(1);
    expect(knowledgeNetwork.getLinksTo(b.id).length).toBe(1);
  });

  test("link() returns null when either endpoint doesn't exist", () => {
    const a = knowledgeNetwork.create("concept", "A", "a");
    expect(knowledgeNetwork.link(a.id, "nonexistent", "x")).toBeNull();
    expect(knowledgeNetwork.link("nonexistent", a.id, "x")).toBeNull();
  });

  test("getLinksFrom / getLinksTo return directional links", () => {
    const a = knowledgeNetwork.create("concept", "A", "a");
    const b = knowledgeNetwork.create("concept", "B", "b");
    const c = knowledgeNetwork.create("concept", "C", "c");

    knowledgeNetwork.link(a.id, b.id, "ab");
    knowledgeNetwork.link(b.id, c.id, "bc");
    knowledgeNetwork.link(a.id, c.id, "ac");

    expect(knowledgeNetwork.getLinksFrom(a.id).length).toBe(2);
    expect(knowledgeNetwork.getLinksFrom(b.id).length).toBe(1);
    expect(knowledgeNetwork.getLinksTo(c.id).length).toBe(2);
    expect(knowledgeNetwork.getLinksTo(a.id).length).toBe(0);
  });

  test("getStats includes link count", () => {
    const a = knowledgeNetwork.create("concept", "A", "a");
    const b = knowledgeNetwork.create("concept", "B", "b");
    knowledgeNetwork.link(a.id, b.id, "x");
    knowledgeNetwork.link(b.id, a.id, "y");

    const stats = knowledgeNetwork.getStats();
    expect(stats.links).toBe(2);
    expect(stats.total).toBe(2);
  });

  test("timeline is capped at MAX_TIMELINE_ENTRIES (1000)", () => {
    const e = knowledgeNetwork.create("concept", "Mutator", "init");
    // Trigger 1050 state changes — each adds a timeline entry
    for (let i = 0; i < 1050; i++) {
      knowledgeNetwork.updateState(e.id, `state-${i}`);
    }
    const tl = knowledgeNetwork.getTimeline(e.id);
    expect(tl.length).toBeLessThanOrEqual(1000);
    // Most recent should be the last state we set
    expect(tl[tl.length - 1].state).toBe("state-1049");
  });

  test("reset clears entities, links, and stats", () => {
    const a = knowledgeNetwork.create("concept", "A", "a");
    const b = knowledgeNetwork.create("concept", "B", "b");
    knowledgeNetwork.link(a.id, b.id, "x");

    knowledgeNetwork.reset();
    const stats = knowledgeNetwork.getStats();
    expect(stats.total).toBe(0);
    expect(stats.links).toBe(0);
    expect(stats.created).toBe(0);
  });

  test("create + update + delete round-trip preserves no stale indexes", () => {
    const e1 = knowledgeNetwork.create("fact", "E1", "e1", { state: "open" });
    const e2 = knowledgeNetwork.create("fact", "E2", "e2", { state: "open" });

    expect(knowledgeNetwork.queryByState("open").length).toBe(2);

    knowledgeNetwork.updateState(e1.id, "closed");
    expect(knowledgeNetwork.queryByState("open").length).toBe(1);
    expect(knowledgeNetwork.queryByState("closed").length).toBe(1);

    knowledgeNetwork.delete(e2.id);
    expect(knowledgeNetwork.queryByState("open").length).toBe(0);
    expect(knowledgeNetwork.queryByState("closed").length).toBe(1);
  });

  test("update() syncs atomStore so ContextEngine sees fresh content", () => {
    const e = knowledgeNetwork.create("concept", "OriginalName", "original content");
    // Verify atom was created with original name
    const atomsBefore = atomStore.search("OriginalName", 10);
    expect(atomsBefore.length).toBeGreaterThanOrEqual(1);

    // Update name — atom should be synced
    knowledgeNetwork.update(e.id, { name: "UpdatedName" });

    // Old name should no longer surface in atom search
    const atomsAfterOld = atomStore.search("OriginalName", 10);
    expect(atomsAfterOld.length).toBe(0);

    // New name should surface
    const atomsAfterNew = atomStore.search("UpdatedName", 10);
    expect(atomsAfterNew.length).toBeGreaterThanOrEqual(1);
  });

  test("delete() removes the corresponding atom from atomStore", () => {
    const e = knowledgeNetwork.create("concept", "ToDeleteEntity", "content");
    expect(atomStore.search("ToDeleteEntity", 10).length).toBeGreaterThanOrEqual(1);

    knowledgeNetwork.delete(e.id);

    // Atom should be gone — no stale reference for ContextEngine
    expect(atomStore.search("ToDeleteEntity", 10).length).toBe(0);
  });

  test("link() deduplicates same src/dst/relation (updates weight instead)", () => {
    const a = knowledgeNetwork.create("concept", "A", "a");
    const b = knowledgeNetwork.create("concept", "B", "b");

    const link1 = knowledgeNetwork.link(a.id, b.id, "related-to", { weight: 0.5 });
    const link2 = knowledgeNetwork.link(a.id, b.id, "related-to", { weight: 0.9 });

    // Should be the same link (updated), not a new one
    expect(link1?.id).toBe(link2?.id);
    expect(link2?.weight).toBe(0.9);
    expect(knowledgeNetwork.getLinksFrom(a.id).length).toBe(1);
  });

  test("link() allows different relations between same entities", () => {
    const a = knowledgeNetwork.create("concept", "A", "a");
    const b = knowledgeNetwork.create("concept", "B", "b");

    knowledgeNetwork.link(a.id, b.id, "depends-on");
    knowledgeNetwork.link(a.id, b.id, "related-to");

    expect(knowledgeNetwork.getLinksFrom(a.id).length).toBe(2);
  });

  test("link() with default weight is 1.0", () => {
    const a = knowledgeNetwork.create("concept", "A", "a");
    const b = knowledgeNetwork.create("concept", "B", "b");
    const link = knowledgeNetwork.link(a.id, b.id, "x");
    expect(link?.weight).toBe(1.0);
  });
});
