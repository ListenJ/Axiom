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
  | "zhipu";

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
  | "computer-use";

export interface UnifiedModel {
  id: string;                    // Unique model identifier
  provider: ModelProvider;       // Provider key
  model: string;                 // API model name
  roles: TaskRole[];             // Supported task roles
  contextWindow: number;         // Max context window
  isFree: boolean;               // Free tier available?
  tags: string[];                // Extra tags (e.g. "coding", "fast")
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