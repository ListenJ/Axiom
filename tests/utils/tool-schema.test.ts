/**
 * tool-surface 扩展测试：zod 模式 → OpenAI JSON Schema；ToolSurfaceLike → OpenAI function tools。
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema, toOpenAITools, type ToolSurfaceLike } from "../../src/utils/tool-surface.js";

const skillSchema = z.object({
  skillId: z.string().describe("目标 skill id"),
  params: z.record(z.string()).optional(),
});

describe("zodToJsonSchema", () => {
  test("converts object schema with required/optional/description", () => {
    const schema = zodToJsonSchema(skillSchema);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["skillId"]);
    const props = schema.properties as Record<string, { type: string; description?: string }>;
    expect(props.skillId.type).toBe("string");
    expect(props.skillId.description).toBe("目标 skill id");
    expect(props.params.type).toBe("object");
  });
});

describe("toOpenAITools", () => {
  test("converts ToolSurfaceLike list into OpenAI function tool defs", () => {
    const tools: ToolSurfaceLike[] = [
      { name: "skill_run", description: "按需执行 skill", inputSchema: skillSchema, handler: async () => ({}) },
    ];
    const defs = toOpenAITools(tools);
    expect(defs).toHaveLength(1);
    expect(defs[0].type).toBe("function");
    expect(defs[0].function.name).toBe("skill_run");
    expect((defs[0].function.parameters as { required?: string[] }).required).toEqual(["skillId"]);
  });
});
