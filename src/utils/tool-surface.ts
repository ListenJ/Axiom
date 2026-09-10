export interface ToolSurfaceLike {
  name: string;
  description: string;
  inputSchema: unknown;
  format?: "json" | "text";
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}
// ─── 原生 function-calling 支持（OpenAI 兼容 tools）────────────────────────

/** OpenAI function tool 定义（发给模型的 tools 数组项） */
export interface ToolCallDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 模型返回的 tool call（OpenAI 格式） */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** zod 模式 → OpenAI JSON Schema（覆盖本项目工具用到的 string/record/optional/default/describe/object） */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema === null || typeof schema !== "object") return { type: "string" };
  const def = (schema as { _def?: unknown })._def as
    | { typeName?: string; innerType?: unknown; shape?: Record<string, unknown> | (() => Record<string, unknown>); description?: string; default?: unknown; type?: unknown }
    | undefined;
  if (!def) {
    // 纯对象形式：{ key: zodSchema }（ToolDef.inputSchema 常用）→ 转为 object properties；
    // 已是成形 JSON Schema（type/properties/items/enum 等键）→ 原样透传
    const keys = Object.keys(schema as Record<string, unknown>);
    const jsonSchemaKeys = ["type", "properties", "items", "anyOf", "allOf", "oneOf", "enum", "const"];
    if (keys.some((k) => jsonSchemaKeys.includes(k))) return schema as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      properties[key] = zodToJsonSchema(value);
      if (!isOptionalZod(value)) required.push(key);
    }
    return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
  }

  const withDesc = (out: Record<string, unknown>): Record<string, unknown> =>
    def.description ? { ...out, description: def.description } : out;

  switch (def.typeName) {
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodNumber":
      return withDesc({ type: "number" });
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodRecord":
      return withDesc({ type: "object", additionalProperties: zodToJsonSchema(def.innerType ?? { type: "string" }) });
    case "ZodOptional":
      return zodToJsonSchema(def.innerType ?? {});
    case "ZodDefault":
      return { ...zodToJsonSchema(def.innerType ?? {}), default: def.default };
    case "ZodArray":
      return withDesc({ type: "array", items: zodToJsonSchema(def.type ?? { type: "string" }) });
    case "ZodObject": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const shape = typeof def.shape === "function" ? def.shape() : (def.shape ?? {});
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptionalZod(value)) required.push(key);
      }
      return withDesc({
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      });
    }
    default:
      return withDesc({ type: "string" });
  }
}

function isOptionalZod(schema: unknown): boolean {
  const typeName = (schema as { _def?: { typeName?: string } } | null)?._def?.typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}

/** ToolSurfaceLike 列表 → OpenAI function tools 数组 */
export function toOpenAITools(tools: ToolSurfaceLike[]): ToolCallDef[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.inputSchema),
    },
  }));
}
