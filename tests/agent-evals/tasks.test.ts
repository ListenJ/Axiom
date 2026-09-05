import { describe, expect, it } from "bun:test";
import {
  ALL_AGENT_TASKS,
  ALL_TASK_FAMILIES,
  getTasksByFamily,
  validateTasks,
} from "../../src/agent-evals/tasks.js";

describe("Agent task definitions", () => {
  it("has unique ids and valid definitions", () => {
    const errors = validateTasks();
    expect(errors).toEqual([]);
  });

  it("S4 质量门：补全 expectedBehavior 后 validateTasks 仍不误伤", () => {
    const errors = validateTasks();
    expect(errors).toEqual([]);
    const missing = ALL_AGENT_TASKS.filter(
      (t) => typeof t.expectedBehavior !== "string" || t.expectedBehavior.trim().length === 0,
    );
    expect(missing.map((t) => t.id)).toEqual([]);
  });

  it("covers every family with both train and held-out splits", () => {
    for (const family of ALL_TASK_FAMILIES) {
      expect(getTasksByFamily(family, "train").length).toBeGreaterThan(0);
      expect(getTasksByFamily(family, "held-out").length).toBeGreaterThan(0);
    }
  });

  it("has at least 12 tasks total", () => {
    expect(ALL_AGENT_TASKS.length).toBeGreaterThanOrEqual(12);
  });
});
