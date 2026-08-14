/**
 * DRE LLM 约束 —— 意识流决策的精确输出约束。
 *
 * 目标：向 LLM 发出准确约束（JSON Schema + 枚举 + 数值边界），并做确定性校验，
 * 拒绝不符合 schema 的输出（降级链据此走 cloud/rule），避免幻觉/格式漂移。
 */
export const DRE_DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["observe", "reflect", "act"] },
    content: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["action", "content", "confidence"],
} as const;

/** 意识流决策系统提示词（与 schema 一一对应，杜绝自由格式） */
export const DRE_DECISION_SYSTEM = `你是确定性推理引擎的意识流处理器。
根据观察内容输出严格 JSON（不要输出任何其他文本），必须满足：
{"action": "observe" | "reflect" | "act", "content": "一句话决策说明", "confidence": 0.0-1.0 之间的数字}`;

/** 校验 LLM 输出是否满足决策 schema（确定性，无 LLM） */
export function isDreDecision(value: unknown): value is {
  action: "observe" | "reflect" | "act";
  content: string;
  confidence: number;
} {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.action !== "string" || !["observe", "reflect", "act"].includes(obj.action)) return false;
  if (typeof obj.content !== "string") return false;
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) return false;
  return true;
}
