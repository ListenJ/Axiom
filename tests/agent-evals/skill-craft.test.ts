import { describe, expect, it } from "bun:test";
import {
  craftFailureSkill,
  craftFailureSkills,
  selfCheckFailures,
} from "../../src/agent-evals/skill-craft.js";
import { getTasksByFamily } from "../../src/agent-evals/tasks.js";
import type { TaskResult } from "../../src/agent-evals/metrics.js";

const tasks = getTasksByFamily();

function result(taskId: string, passed: boolean, reason?: string): TaskResult {
  const t = tasks.find((x) => x.id === taskId)!;
  return { taskId, family: t.family, split: t.split, passed, reason, latencyMs: 0, outputLength: 10 };
}

describe("skill-craft (self-check + source-grounding + path planning)", () => {
  it("analyzes failures into gap checks", () => {
    const analyses = selfCheckFailures([result("CODING-02", false, "缺少关键内容: select, group by, sum")], tasks);
    expect(analyses).toHaveLength(1);
    expect(analyses[0].gaps.length).toBeGreaterThan(0);
    expect(analyses[0].path.length).toBeGreaterThanOrEqual(3);
  });

  it("skips passed results", () => {
    const analyses = selfCheckFailures([result("KNOW-01", true)], tasks);
    expect(analyses).toHaveLength(0);
  });

  it("adds generic gap when no keyword matches", () => {
    const analyses = selfCheckFailures([result("MEM-01", false, "weird unknown failure")], tasks);
    expect(analyses[0].gaps.some((g) => g.category === "输出完整性")).toBe(true);
  });

  it("crafts a deterministic idempotent skill with methodology content", () => {
    const analysis = selfCheckFailures([result("CODING-02", false, "缺少关键内容: select")], tasks)[0];
    const skill = craftFailureSkill(analysis, tasks.find((t) => t.id === "CODING-02"));
    expect(skill.id).toBe("auto-fix-coding-coding-02");
    expect(skill.promptTemplate).toContain("自检清单");
    expect(skill.promptTemplate).toContain("溯源铁律");
    expect(skill.promptTemplate).toContain("任务路径规划");
    expect(skill.promptTemplate).toContain("破执三层");
    expect(skill.promptTemplate).toContain("二阶段审查");
    expect(skill.version).toBe("1.0-craft");
  });

  it("registers only new skills (idempotent)", () => {
    const registered: string[] = [];
    const results = [result("CODING-02", false, "缺少 select")];
    const first = craftFailureSkills(results, tasks, (id) => registered.includes(id), (s) => { registered.push(s.id); });
    const second = craftFailureSkills(results, tasks, (id) => registered.includes(id), (s) => { registered.push(s.id); });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
