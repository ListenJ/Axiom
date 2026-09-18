/**
 * SkillRegistry.executeById — 模型/工具按需执行 skill 的入口测试。
 *
 * Contract:
 *   - 存在的 skill → 填充 params 模板并执行（走 router），返回 SkillExecuteResult；
 *   - 不存在的 skill → 返回 null（调用方可区分"未找到"与"执行失败"）。
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { getSkillRegistry, resetSkillRegistry } from "../../src/skills/skill-registry.js";
import { router, type SmartAssignmentResponse } from "../../src/router/model-router.js";

function fakeResponse(content: string): SmartAssignmentResponse {
  return {
    role: "general-chat",
    model: "fake-model",
    provider: "local",
    endpoint: "",
    content,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    latency_ms: 1,
    fallback_used: false,
  };
}

describe("SkillRegistry.executeById", () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  test("executes an existing skill and injects params into the template", async () => {
    const executeSpy = spyOn(router, "executeWithRole").mockImplementation(
      async (_role, messages) => {
        expect((messages[1] as { content: string }).content).toContain("write hello");
        return fakeResponse("generated code");
      },
    );
    try {
      const result = await getSkillRegistry().executeById("code-generate", { input: "write hello" });
      expect(result).not.toBeNull();
      expect(result!.skillId).toBe("code-generate");
      expect(result!.content).toBe("generated code");
      expect(executeSpy).toHaveBeenCalled();
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("returns null for unknown skill", async () => {
    const result = await getSkillRegistry().executeById("no-such-skill", { input: "x" });
    expect(result).toBeNull();
  });

  test("returns failure content instead of throwing when the model call fails", async () => {
    const executeSpy = spyOn(router, "executeWithRole").mockRejectedValue(new Error("provider down"));
    try {
      const result = await getSkillRegistry().executeById("code-generate", { input: "x" });
      expect(result).not.toBeNull();
      expect(result!.content).toContain("[Skill execution failed]");
    } finally {
      executeSpy.mockRestore();
    }
  });
});
