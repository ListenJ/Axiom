/**
 * Planning Phase — JSON Schema for constrained generation.
 *
 * The planner outputs a structured ExecutionPlan that the verifier
 * later checks against.  All fields are intentionally narrow so
 * the LLM cannot free-form hallucinate a plan.
 */

// ─── Data Types ────────────────────────────────────────────────────────────

export type StepAction =
  | "analyze"       // 纯分析，不调工具
  | "search"        // 检索知识库 / 网络
  | "generate"      // 生成代码 / 文本
  | "verify"        // 验证前序步骤输出
  | "ask_user"      // 向用户确认
  | "tool_call";    // 调用指定工具

export type Complexity = "simple" | "medium" | "complex";

export interface PlanStep {
  /** 递增 id，从 1 开始 */
  id: number;
  /** 动作类型 */
  action: StepAction;
  /** 人类可读描述 */
  description: string;
  /** 当 action=tool_call 时指定工具名 */
  tool?: string;
  /** 预期输出描述（一句话） */
  expectedOutput: string;
  /** 如何验证这步是否成功 */
  verifyMethod: string;
  /** 依赖的步骤 id 列表 */
  dependsOn?: number[];
}

export interface ExecutionPlan {
  /** 对用户意图的理解（一句话） */
  understanding: string;
  /** 从对话历史提取的已知事实 */
  knownFacts: string[];
  /** 需要确认或查找的未知项 */
  unknowns: string[];
  /** 原子步骤列表 */
  steps: PlanStep[];
  /** 整体验证标准（一句话） */
  verificationCriteria: string;
  /** 任务复杂度评估 */
  complexity: Complexity;
  /** 第一性原理分解：不可再分的原子事实 */
  firstPrinciples: string[];
  /** 如果不确定，需要向用户确认的问题 */
  clarificationsNeeded?: string[];
}

// ─── JSON Schema (for constrained generation) ──────────────────────────────

export const EXECUTION_PLAN_SCHEMA = {
  type: "object",
  required: [
    "understanding",
    "knownFacts",
    "unknowns",
    "steps",
    "verificationCriteria",
    "complexity",
    "firstPrinciples",
  ],
  properties: {
    understanding: { type: "string", minLength: 1, maxLength: 300 },
    knownFacts: { type: "array", items: { type: "string" }, maxItems: 10 },
    unknowns: { type: "array", items: { type: "string" }, maxItems: 5 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        required: ["id", "action", "description", "expectedOutput", "verifyMethod"],
        properties: {
          id: { type: "integer", minimum: 1 },
          action: {
            type: "string",
            enum: ["analyze", "search", "generate", "verify", "ask_user", "tool_call"],
          },
          description: { type: "string", minLength: 1, maxLength: 200 },
          tool: { type: "string" },
          expectedOutput: { type: "string", minLength: 1, maxLength: 200 },
          verifyMethod: { type: "string", minLength: 1, maxLength: 200 },
          dependsOn: { type: "array", items: { type: "integer" } },
        },
      },
    },
    verificationCriteria: { type: "string", minLength: 1, maxLength: 300 },
    complexity: { type: "string", enum: ["simple", "medium", "complex"] },
    firstPrinciples: { type: "array", items: { type: "string" }, maxItems: 5 },
    clarificationsNeeded: { type: "array", items: { type: "string" }, maxItems: 3 },
  },
} as const;

// ─── Prompt Template ───────────────────────────────────────────────────────

export function buildPlanningPrompt(
  userInput: string,
  conversationHistory: string,
  availableTools: string,
  currentTime: string,
): string {
  return `You are the Planning Phase of OpenClaw AI Agent.

## First Principles (apply before planning)
1. Identify the most basic assumptions in the problem
2. Decompose complex problems into indivisible atomic facts
3. Reason from atomic facts — do NOT rely on analogy or "common knowledge"
4. Distinguish what is CERTAIN from what is INFERRED
5. If uncertain, say "I am uncertain" — never fabricate

## Authority Hierarchy
1. User explicit intent > historical instructions
2. Real-time tool output > assumptions
3. Verification > confidence
4. Safety mode > efficiency

## Current Context
- Time: ${currentTime}
- Available tools: ${availableTools}

## Conversation History (recent)
${conversationHistory || "(first message)"}

## User Input
${userInput}

## Task
Create an execution plan. Output ONLY valid JSON matching this structure:
{
  "understanding": "one sentence understanding of the user's intent",
  "knownFacts": ["fact from conversation or knowledge"],
  "unknowns": ["what needs to be confirmed or discovered"],
  "steps": [
    {
      "id": 1,
      "action": "analyze|search|generate|verify|ask_user|tool_call",
      "description": "what to do",
      "tool": "tool name if action=tool_call",
      "expectedOutput": "what this step should produce",
      "verifyMethod": "how to check this step succeeded"
    }
  ],
  "verificationCriteria": "how to verify the final answer is correct",
  "complexity": "simple|medium|complex",
  "firstPrinciples": ["atomic fact derived from first principles analysis"],
  "clarificationsNeeded": ["question for user if truly uncertain"]
}

Rules:
- If the task is simple (greeting, factual question, 1-step task), use 1 step with complexity=simple
- If uncertain about user intent, put the question in clarificationsNeeded
- Every step must have a concrete verifyMethod
- Do NOT hallucinate tools — only use listed available tools
- Maximum 8 steps, minimum 1`;
}
