/**
 * DRE LLM 约束测试 —— 决策 schema 确定性校验（无 LLM）
 */
import { describe, it, expect } from "bun:test";
import { isDreDecision, DRE_DECISION_SCHEMA, DRE_DECISION_SYSTEM } from "../src/dre/constraints.js";

describe("isDreDecision", () => {
  it("合法决策通过", () => {
    expect(isDreDecision({ action: "observe", content: "继续观察", confidence: 0.6 })).toBe(true);
    expect(isDreDecision({ action: "reflect", content: "需要反思", confidence: 1 })).toBe(true);
    expect(isDreDecision({ action: "act", content: "执行", confidence: 0 })).toBe(true);
  });

  it("action 枚举越界 / 缺 content / confidence 越界 → 拒绝", () => {
    expect(isDreDecision({ action: "delete", content: "x", confidence: 0.5 })).toBe(false);
    expect(isDreDecision({ action: "observe", confidence: 0.5 })).toBe(false);
    expect(isDreDecision({ action: "observe", content: "x", confidence: 1.2 })).toBe(false);
    expect(isDreDecision({ action: "observe", content: "x", confidence: -0.1 })).toBe(false);
    expect(isDreDecision("not-object")).toBe(false);
    expect(isDreDecision(null)).toBe(false);
    expect(isDreDecision({ action: "observe", content: 123, confidence: 0.5 })).toBe(false);
  });
});

describe("DRE_DECISION_SCHEMA", () => {
  it("schema 包含枚举与数值边界（提示词与其一致）", () => {
    expect(DRE_DECISION_SCHEMA.properties.action.enum).toEqual(["observe", "reflect", "act"]);
    expect(DRE_DECISION_SCHEMA.properties.confidence.minimum).toBe(0);
    expect(DRE_DECISION_SCHEMA.properties.confidence.maximum).toBe(1);
    expect(DRE_DECISION_SCHEMA.required).toContain("content");
  });

  it("系统提示词明确要求严格 JSON 与枚举", () => {
    expect(DRE_DECISION_SYSTEM).toContain("observe");
    expect(DRE_DECISION_SYSTEM).toContain("reflect");
    expect(DRE_DECISION_SYSTEM).toContain("act");
    expect(DRE_DECISION_SYSTEM).toContain("严格 JSON");
  });
});
