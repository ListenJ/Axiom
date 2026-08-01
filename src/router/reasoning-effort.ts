/**
 * 思考强度（reasoning effort）→ 各供应商请求参数映射。
 *
 * 依据 knowledge-base/api-formats/*.md 文档（2026-08-01 拉取）整理：
 *   - OpenAI 兼容（opencode/zhipu/ofoxai 等）：reasoning_effort (low/medium/high)
 *   - DeepSeek：thinking.type=enabled + reasoning_effort（新版），思考经 reasoning_content 返回
 *   - Kimi (Moonshot)：K2.x 用 thinking.type，K3 用 reasoning_effort（默认 max）
 *   - MiniMax：M3 用 thinking.type=adaptive（无强度档位）
 *   - SiliconFlow：enable_thinking + thinking_budget（128~32768）
 *   - OpenRouter：reasoning.effort 统一透传
 *   - Anthropic 兼容端点：thinking { type, budget_tokens }（1024~128000）
 *   - Gemini 兼容端点：thinkingConfig.thinkingBudget
 *   - 其余（nvidia-nim 等）：无标准思考参数，返回空对象
 *
 * 设计：深模块 —— 调用方只需传 (provider, effort)，无需感知各家格式差异。
 */
export type ReasoningEffort = "low" | "medium" | "high";

const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

/** 归一化思考强度：未知值回退 medium（默认强度） */
export function normalizeEffort(effort: string | undefined | null): ReasoningEffort {
  if (typeof effort === "string") {
    const v = effort.toLowerCase();
    if ((EFFORTS as readonly string[]).includes(v)) return v as ReasoningEffort;
  }
  return "medium";
}

/** 各档位对应的预算/档位数值（按文档取值） */
const BUDGETS: Record<ReasoningEffort, number> = {
  low: 1024,
  medium: 2048,
  high: 8192,
};

/**
 * 生成指定供应商的思考强度请求参数（追加到请求体）。
 * 无对应参数规范的供应商返回空对象，调用方可安全展开。
 */
export function buildReasoningParams(provider: string, effort: string | undefined | null): Record<string, unknown> {
  const level = normalizeEffort(effort);

  switch (provider) {
    case "deepseek":
      return { thinking: { type: "enabled" }, reasoning_effort: level };
    case "kimi":
      // K2.x 兼容：thinking.type 开启 + reasoning_effort 透传（K3 亦接受）
      return { thinking: { type: "enabled" }, reasoning_effort: level };
    case "minimax":
      // M3：仅 adaptive（开/关），无强度档位
      return { thinking: { type: "adaptive" } };
    case "siliconflow":
      return { enable_thinking: true, thinking_budget: BUDGETS[level] };
    case "openrouter":
      return { reasoning: { effort: level } };
    case "ofoxai-anthropic":
      // Anthropic 预算制：1024~128000，high 取 4096（保守）
      return { thinking: { type: "enabled", budget_tokens: level === "high" ? 4096 : BUDGETS[level] } };
    case "ofoxai-gemini":
      return { thinkingConfig: { thinkingBudget: BUDGETS[level] } };
    case "nvidia-nim":
      return {};
    default:
      // OpenAI 兼容（opencode/zhipu/ofoxai 等）
      return { reasoning_effort: level };
  }
}
