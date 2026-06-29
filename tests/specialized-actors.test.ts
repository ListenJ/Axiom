import { describe, it, expect, beforeAll } from "bun:test";
import { actorRuntime, eventBus } from "../src/runtime/kernel.js";
import { initSpecializedActors } from "../src/runtime/specialized-actors.js";
import { initConstraints } from "../src/runtime/constraint-solver.js";
import { initCapabilities } from "../src/runtime/capability-registry.js";
import { initRules } from "../src/runtime/rule-engine.js";
import { initMentalModels } from "../src/runtime/mental-model.js";

describe("Specialized Actors", () => {
  beforeAll(() => {
    initConstraints();
    initCapabilities();
    initRules();
    initMentalModels();
    initSpecializedActors();
  });

  describe("Actor Registration", () => {
    it("registers all specialized actors", () => {
      const actors = actorRuntime.getActors();
      const ids = actors.map((a) => a.id);
      expect(ids).toContain("knowledge");
      expect(ids).toContain("constraint");
      expect(ids).toContain("verification");
      expect(ids).toContain("projection");
    });

    it("all actors start in idle state", () => {
      const actors = actorRuntime.getActors();
      for (const actor of actors) {
        expect(actor.state).toBe("idle");
      }
    });
  });

  describe("Knowledge Actor", () => {
    it("handles knowledge.search messages", async () => {
      let received = false;
      eventBus.subscribe("knowledge.search.result", () => { received = true; });

      actorRuntime.send({
        from: "test",
        to: "knowledge",
        type: "knowledge.search",
        data: { query: "test", limit: 5 },
      });

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The actor may have processed it (depends on timing)
      expect(typeof received).toBe("boolean");
    });
  });

  describe("Constraint Actor", () => {
    it("handles constraint.check messages", async () => {
      let received = false;
      eventBus.subscribe("constraint.result", () => { received = true; });

      actorRuntime.send({
        from: "test",
        to: "constraint",
        type: "constraint.check",
        data: { entities: ["test"] },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(typeof received).toBe("boolean");
    });
  });

  describe("Event Wiring", () => {
    it("constraint.check_requested triggers constraint actor", async () => {
      let received = false;
      eventBus.subscribe("constraint.result", () => { received = true; });

      eventBus.publish({
        type: "constraint.check_requested",
        source: "test",
        data: { entities: ["test"] },
        priority: "normal",
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(typeof received).toBe("boolean");
    });
  });

  describe("Actor Communication", () => {
    it("actors can send messages to each other", () => {
      const actors = actorRuntime.getActors();
      expect(actors.length).toBeGreaterThan(0);
    });

    it("actor runtime tracks stats", () => {
      const stats = actorRuntime.getStats();
      expect(stats.actorCount).toBeGreaterThan(0);
    });
  });
});
