import { describe, expect, it } from "bun:test";
import {
  ALL_AGENT_TASKS,
  ALL_TASK_FAMILIES,
  getTasksByIds,
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

describe("getTasksByIds", () => {
  it("filters to the requested ids, preserving catalog order", () => {
    const got = getTasksByIds(["EVOLVE-09", "CODING-11"]);
    // 目录顺序优先于请求顺序：coding 族在 self-evolve 族之前
    expect(got.map((t) => t.id)).toEqual(["CODING-11", "EVOLVE-09"]);
  });

  it("ignores unknown ids", () => {
    const got = getTasksByIds(["NOPE-00", "EVOLVE-09", "NOPE-01"]);
    expect(got.map((t) => t.id)).toEqual(["EVOLVE-09"]);
  });

  it("returns empty for no ids or all-unknown", () => {
    expect(getTasksByIds([])).toEqual([]);
    expect(getTasksByIds(["NOPE-00"])).toEqual([]);
  });
});
