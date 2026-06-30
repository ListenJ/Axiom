import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  eventBus,
  worldState,
  tickEngine,
  actorRuntime,
  initRuntime,
  getRuntimeStatus,
} from "../../src/runtime/kernel.js";

describe("WorldState", () => {
  it("should set and get values", () => {
    worldState.set("test.key", "value");
    expect(worldState.get<string>("test.key")).toBe("value");
  });

  it("should handle nested keys", () => {
    worldState.set("a.b.c.d", 42);
    expect(worldState.get<number>("a.b.c.d")).toBe(42);
  });

  it("should return undefined for non-existent keys", () => {
    expect(worldState.get("non.existent")).toBeUndefined();
  });

  it("should query by prefix", () => {
    worldState.set("entities.e1", { id: "e1", name: "Entity 1" });
    worldState.set("entities.e2", { id: "e2", name: "Entity 2" });
    worldState.set("other.key", "value");

    const entities = worldState.query("entities.");
    expect(entities.size).toBe(2);
    expect(entities.has("entities.e1")).toBe(true);
    expect(entities.has("entities.e2")).toBe(true);
  });

  it("should track version on updates", () => {
    const v1 = worldState.getVersion();
    worldState.set("version.test", "value");
    const v2 = worldState.getVersion();
    expect(v2).toBeGreaterThan(v1);
  });

  it("should snapshot state as object", () => {
    worldState.set("snap.x", 1);
    worldState.set("snap.y", 2);
    const snapshot = worldState.snapshot();
    expect(snapshot["snap.x"]).toBe(1);
    expect(snapshot["snap.y"]).toBe(2);
  });

  it("should set and get intent", () => {
    worldState.setIntent("Test intent", 1.0);
    const intent = worldState.getIntent();
    expect(intent).toBeDefined();
    expect(intent?.intent).toBe("Test intent");
  });

  it("should set and get goals", () => {
    worldState.setGoal("goal-1", "Achieve something", "active");
    worldState.setGoal("goal-2", "Achieve another", "active");

    const goals = worldState.getGoals();
    expect(goals["goal-1"]).toBeDefined();
    expect(goals["goal-1"].description).toBe("Achieve something");
    expect(goals["goal-2"]).toBeDefined();
  });

  it("should set and get beliefs", () => {
    worldState.setBelief("belief-1", "Something is true", 0.8);
    const beliefs = worldState.getBeliefs();
    expect(beliefs["belief-1"]).toBeDefined();
    expect(beliefs["belief-1"].statement).toBe("Something is true");
    expect(beliefs["belief-1"].confidence).toBe(0.8);
  });

  it("should set and get hypotheses", () => {
    worldState.setHypothesis("hyp-1", "Maybe X causes Y", "proposed");
    const hypotheses = worldState.getHypotheses();
    expect(hypotheses["hyp-1"]).toBeDefined();
    expect(hypotheses["hyp-1"].statement).toBe("Maybe X causes Y");
    expect(hypotheses["hyp-1"].status).toBe("proposed");
  });
});

describe("EventBus", () => {
  it("should publish and subscribe events", () => {
    let received = false;
    eventBus.subscribe("test.event", () => {
      received = true;
    });

    eventBus.publish({
      type: "test.event",
      source: "test",
      data: {},
      priority: "normal",
    });

    expect(received).toBe(true);
  });

  it("should pass event data to handler", () => {
    let receivedData: unknown;
    eventBus.subscribe("test.data", (evt) => {
      receivedData = evt.data;
    });

    eventBus.publish({
      type: "test.data",
      source: "test",
      data: { key: "value" },
      priority: "normal",
    });

    expect(receivedData).toEqual({ key: "value" });
  });

  it("should return stats", () => {
    const stats = eventBus.getStats();
    expect(typeof stats.published).toBe("number");
    expect(typeof stats.handled).toBe("number");
    expect(typeof stats.errors).toBe("number");
  });
});

describe("TickEngine", () => {
  afterEach(() => {
    tickEngine.stop();
  });

  it("should track tick number", () => {
    expect(tickEngine.getTickNumber()).toBe(0);
  });

  it("should report running state", () => {
    expect(tickEngine.isRunning()).toBe(false);
  });

  it("should return stats", () => {
    const stats = tickEngine.getStats();
    expect(stats.tickNumber).toBe(0);
    expect(stats.running).toBe(false);
    expect(typeof stats.intervalMs).toBe("number");
    expect(typeof stats.phaseCount).toBe("number");
  });
});

describe("ActorRuntime", () => {
  it("should register actors", () => {
    actorRuntime.register({
      id: "test-actor-2",
      state: "idle",
      receive: async () => {},
    });

    const stats = actorRuntime.getStats();
    expect(stats.actorCount).toBeGreaterThan(0);
  });

  it("should return stats", () => {
    const stats = actorRuntime.getStats();
    expect(typeof stats.actorCount).toBe("number");
    expect(typeof stats.queueSize).toBe("number");
    expect(typeof stats.messagesSent).toBe("number");
  });
});

describe("Runtime Initialization", () => {
  it("should initialize without errors", () => {
    expect(() => initRuntime()).not.toThrow();
  });

  it("should return runtime status", () => {
    initRuntime();
    const status = getRuntimeStatus();
    expect(status.tick).toBeDefined();
    expect(status.events).toBeDefined();
    expect(status.actors).toBeDefined();
    expect(typeof status.stateVersion).toBe("number");
  });
});
