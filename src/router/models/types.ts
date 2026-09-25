/**
 * Model types — pure interfaces, no data.
 * Split from models.ts (was 1128 lines) for maintainability.
 */

export type ModelProvider =
  | "siliconflow"
  | "ofoxai"
  | "ofoxai-anthropic"
  | "ofoxai-gemini"
  | "openrouter"
  | "deepseek"
  | "opencode"
  | "kimi"
  | "minimax"
  | "nvidia-nim"
  | "zhipu"
  | "sensenova";

export type TaskRole =
  | "decision"
  | "architecture"
  | "evaluation"
  | "general-chat"
  | "code-generation"
  | "code-review"
  | "embedding"
  | "english"
  | "rl"
  | "general-tool"
  | "coding"
  | "research"
  | "memory"
  | "deep_research"
  | "math"
  | "review"
  | "main_coding"
  | "computer-use"
  | "intent-classifier";

export interface UnifiedModel {
  id: string;                    // Unique model identifier
  provider: ModelProvider;       // Provider key
  model: string;                 // API model name
  roles: TaskRole[];             // Supported task roles
  contextWindow: number;         // Max context window
  isFree: boolean;               // Free tier available?
  tags: string[];                // Extra tags (e.g. "coding", "fast")
  /**
   * **仅开发/测试用**：该模型不得出现在发布路径上。
   *
   * 语义（2026-09-20 用户裁定：SiliconFlow 暂留但只作 dev/test）：标了 `devOnly` 的条目
   * **默认不被自动解析**（`findModelsForRole` 会过滤掉它），只有显式设置
   * `AXIOM_ALLOW_DEV_MODELS=1` 时才参与解析。
   * 该字段**必须**有配套行为，否则就是"有形状无行为"（见 model-capability-registry.ts 的过滤实现 + 守护测试）。
   */
  devOnly?: boolean;
  rpmLimit?: number;             // Requests per minute limit
  concurrentLimit?: number;      // Max concurrent requests
  description?: string;          // Human readable description
  // Provider-specific routing config (for model-router)
  priority?: number;             // Lower = higher priority
  maxRetries?: number;
  timeout?: number;
  // Runtime config (for tool-pool)
  adapter?: "openai" | "anthropic" | "gemini" | "opencode";
}

export interface ProviderConfig {
  baseURL: string;
  apiKeyEnv: string;
}
