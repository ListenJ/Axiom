import { describe, expect, it, beforeEach } from "bun:test";
import { mentalModelManager, initMentalModels } from "../../src/runtime/mental-model.js";

describe("MentalModelManager", () => {
  it("should initialize predefined mental models", () => {
    initMentalModels();
    const models = mentalModelManager.getModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it("should create a mental model", () => {
    const model = mentalModelManager.createModel(
      "test-domain",
      [
        { id: "c1", name: "Concept A", description: "First concept", properties: {}, kind: "object" },
        { id: "c2", name: "Concept B", description: "Second concept", properties: {}, kind: "process" },
      ],
      [
        { source: "c1", target: "c2", type: "causes", weight: 0.8 },
      ],
    );

    expect(model.id).toContain("test-domain");
    expect(model.domain).toBe("test-domain");
    expect(model.concepts.length).toBe(2);
    expect(model.relationships.length).toBe(1);
  });

  it("should get model by domain", () => {
    mentalModelManager.createModel("my-domain", [], []);
    const model = mentalModelManager.getModel("my-domain");
    expect(model).toBeDefined();
    expect(model?.domain).toBe("my-domain");
  });

  it("should return undefined for non-existent model", () => {
    const model = mentalModelManager.getModel("non-existent");
    expect(model).toBeUndefined();
  });

  it("should simulate with model id", () => {
    const model = mentalModelManager.createModel(
      "sim-domain",
      [
        { id: "s1", name: "State", description: "Current state", properties: {}, kind: "state" },
      ],
      [],
    );

    const result = mentalModelManager.simulate(model.id, "test scenario", { State: "initial" });
    expect(result).toBeDefined();
    expect(result?.scenario).toBe("test scenario");
  });

  it("should return null for non-existent model simulation", () => {
    const result = mentalModelManager.simulate("non-existent", "scenario", {});
    expect(result).toBeNull();
  });

  it("should return stats", () => {
    initMentalModels();
    const stats = mentalModelManager.getStats();
    expect(stats.models).toBeGreaterThan(0);
    expect(typeof stats.simulations).toBe("number");
    expect(typeof stats.skillsGenerated).toBe("number");
  });
});
