import { describe, it, expect, beforeEach } from "bun:test";
import { eventBus, worldState, tickEngine, actorRuntime, getRuntimeStatus } from "../src/runtime/kernel.js";
import { atomStore } from "../src/runtime/atom-engine.js";
import { scheduler } from "../src/runtime/scheduler.js";
import { contextEngine } from "../src/runtime/context-engine.js";

describe("Runtime Kernel", () => {
  describe("Event Bus", () => {
    it("publishes and subscribes to events", async () => {
      let received = false;
      eventBus.subscribe("test.event", () => { received = true; });
      eventBus.publish({ type: "test.event", source: "test", data: {}, priority: "normal" });
      // Event handlers are sync in this case
      expect(received).toBe(true);
    });

    it("returns event with id and timestamp", () => {
      const evt = eventBus.publish({ type: "test.meta", source: "test", data: {}, priority: "normal" });
      expect(evt.id).toBeDefined();
      expect(evt.timestamp).toBeGreaterThan(0);
    });

    it("tracks stats", () => {
      const stats = eventBus.getStats();
      expect(stats.published).toBeGreaterThan(0);
    });
  });

  describe("World State", () => {
    it("sets and gets values", () => {
      worldState.set("test.key", "test.value");
      expect(worldState.get("test.key")).toBe("test.value");
    });

    it("watches for changes", () => {
      let changed = false;
      const unsub = worldState.watch("test.watch", () => { changed = true; });
      worldState.set("test.watch", "new.value");
      expect(changed).toBe(true);
      unsub();
    });

    it("queries by prefix", () => {
      worldState.set("query.a", 1);
      worldState.set("query.b", 2);
      worldState.set("other.c", 3);
      const results = worldState.query("query.");
      expect(results.size).toBeGreaterThanOrEqual(2);
    });

    it("increments version on change", () => {
      const v1 = worldState.getVersion();
      worldState.set("test.version", "v");
      expect(worldState.getVersion()).toBeGreaterThan(v1);
    });
  });

  describe("Atom Store", () => {
    it("creates atoms", () => {
      const atom = atomStore.create("entity", "TestEntity", { source: "test" });
      expect(atom.id).toBeDefined();
      expect(atom.kind).toBe("entity");
      expect(atom.content).toBe("TestEntity");
    });

    it("queries by kind", () => {
      atomStore.create("function", "testFunc", { source: "test" });
      const funcs = atomStore.queryByKind("function");
      expect(funcs.length).toBeGreaterThan(0);
    });

    it("searches atoms", () => {
      atomStore.create("fact", "The sky is blue", { source: "test" });
      const results = atomStore.search("sky");
      expect(results.length).toBeGreaterThan(0);
    });

    it("creates relations", () => {
      const a1 = atomStore.create("entity", "A", { source: "test" });
      const a2 = atomStore.create("entity", "B", { source: "test" });
      const ok = atomStore.relate(a1.id, a2.id, "related-to");
      expect(ok).toBe(true);
      const related = atomStore.getRelated(a1.id);
      expect(related.some((r) => r.id === a2.id)).toBe(true);
    });
  });

  describe("Scheduler", () => {
    it("submits and gets tasks", () => {
      const task = scheduler.submit({
        name: "test-task",
        priority: "normal",
        payload: {},
        dependencies: [],
        maxRetries: 1,
      });
      expect(task.id).toBeDefined();
      expect(task.status).toBe("pending");
    });

    it("gets next task", () => {
      const next = scheduler.getNext();
      if (next) {
        expect(next.status).toBe("running");
        scheduler.complete(next.id, {});
      }
    });
  });

  describe("Context Engine", () => {
    it("builds context", () => {
      const ctx = contextEngine.build("test input", []);
      expect(ctx.input).toBe("test input");
      expect(ctx.system).toBeDefined();
    });

    it("formats context for prompt", () => {
      const ctx = contextEngine.build("test", [{ role: "user", content: "hello" }]);
      const prompt = contextEngine.formatForPrompt(ctx);
      expect(prompt).toContain("test");
      expect(prompt).toContain("hello");
    });
  });

  describe("Runtime Status", () => {
    it("returns complete status", () => {
      const status = getRuntimeStatus();
      expect(status.tick).toBeDefined();
      expect(status.events).toBeDefined();
      expect(status.actors).toBeDefined();
      expect(status.stateVersion).toBeGreaterThan(0);
    });
  });
});
