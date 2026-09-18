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

describe("zodToJsonSchema 纯对象（ToolDef.inputSchema 格式）", () => {
  test("web_search 纯对象 schema 转为 object properties + required", () => {
    const schema = zodToJsonSchema({
      query: z.string().describe("搜索关键词"),
      engines: z.array(z.string()).optional(),
      num: z.number().optional().default(10),
    });
    expect(schema.type).toBe("object");
    expect((schema.required as string[])).toEqual(["query"]);
    const props = schema.properties as Record<string, { type: string; description?: string }>;
    expect(props.query.type).toBe("string");
    expect(props.query.description).toBe("搜索关键词");
    expect(props.engines.type).toBe("array");
    expect(props.num.type).toBe("number");
  });

  test("空对象 schema（无参数工具）返回空 properties", () => {
    const schema = zodToJsonSchema({});
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({});
  });

  test("已成形 JSON Schema 原样透传", () => {
    const schema = zodToJsonSchema({ type: "string" });
    expect(schema).toEqual({ type: "string" });
  });
});
