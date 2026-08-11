/**
 * MCP skill_run 工具 — 模型可按需调用 skill 的对外通道测试。
 *
 * Contract:
 *   - skill_run 注册在 ToolRegistry 中（exposure 含 internal/external）；
 *   - handler 按 skillId 执行并返回结果；未知 skillId → reject。
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { ToolRegistry, type ToolDef } from "../../src/mcp/tool-registry.js";
import { registerSkillTools } from "../../src/mcp/server/skill-tools.js";
import { resetSkillRegistry } from "../../src/skills/skill-registry.js";
import { router, type SmartAssignmentResponse } from "../../src/router/model-router.js";

function findTool(registry: ToolRegistry, name: string): ToolDef {
  const tools = (registry as unknown as { tools: ToolDef[] }).tools;
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

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

describe("skill_run MCP tool", () => {
  let registry: ToolRegistry;
  let skillRun: ToolDef;

  beforeEach(() => {
    resetSkillRegistry();
    registry = new ToolRegistry({ guard: async () => {} });
    registerSkillTools(registry, []);
    skillRun = findTool(registry, "skill_run");
  });

  test("is registered with internal + external exposure", () => {
    expect(skillRun.exposure).toContain("internal");
    expect(skillRun.exposure).toContain("external");
  });

  test("executes the requested skill by id", async () => {
    const executeSpy = spyOn(router, "executeWithRole").mockImplementation(async () =>
      fakeResponse("skill output"),
    );
    try {
      const result = await skillRun.handler({ skillId: "code-generate", params: { input: "hi" } });
      expect((result as { skillId: string }).skillId).toBe("code-generate");
      expect((result as { content: string }).content).toBe("skill output");
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("rejects when the skill does not exist", async () => {
    await expect(skillRun.handler({ skillId: "nope" })).rejects.toThrow("Skill not found: nope");
  });
});
