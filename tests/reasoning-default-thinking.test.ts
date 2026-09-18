/**
 * reasoning-effort 轻任务默认非思考测试
 */
import { describe, expect, it } from "bun:test";
import { defaultThinkingForRole, buildReasoningParams } from "../src/router/reasoning-effort.js";

describe("defaultThinkingForRole", () => {
  it("轻任务默认 false（非思考，降延迟）", () => {
    expect(defaultThinkingForRole("general-tool")).toBe(false);
    expect(defaultThinkingForRole("review")).toBe(false);
    expect(defaultThinkingForRole("general-chat")).toBe(false);
    expect(defaultThinkingForRole("english")).toBe(false);
  });

  it("重任务返回 undefined（默认思考开启）", () => {
    expect(defaultThinkingForRole("research")).toBeUndefined();
    expect(defaultThinkingForRole("decision")).toBeUndefined();
    expect(defaultThinkingForRole("architecture")).toBeUndefined();
    expect(defaultThinkingForRole("math")).toBeUndefined();
  });
});

describe("buildReasoningParams deepseek 思考开关", () => {
  it("thinking:false → disabled", () => {
    const p = buildReasoningParams("deepseek", "high", { thinking: false }) as { thinking: { type: string } };
    expect(p.thinking.type).toBe("disabled");
  });

  it("默认 → enabled", () => {
    const p = buildReasoningParams("deepseek", "high") as { thinking: { type: string } };
    expect(p.thinking.type).toBe("enabled");
  });
});