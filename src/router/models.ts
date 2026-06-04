// src/router/models.ts
// Unified Model Registry — Single source of truth for all model metadata
// Consumers: model-router.ts, tool-pool.ts, model-capability-registry.ts

export type ModelProvider =
  | "siliconflow"
  | "ofoxai"
  | "ofoxai-anthropic"
  | "ofoxai-gemini"
  | "openrouter"
  | "deepseek"
  | "opencode"
  | "kimi"
  | "minimax";

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
  | "main_coding";

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

// ═══════════════════════════════════════════════════════════════
// Provider configs
// ═══════════════════════════════════════════════════════════════
export const PROVIDER_CONFIG: Record<ModelProvider, ProviderConfig> = {
  siliconflow: {
    baseURL: "https://api.siliconflow.cn/v1",
    apiKeyEnv: "SILICONFLOW_API_KEY",
  },
  ofoxai: {
    baseURL: "https://api.ofoxai.com",
    apiKeyEnv: "OFOXAI_API_KEY",
  },
  "ofoxai-anthropic": {
    baseURL: "https://api.ofoxai.com/anthropic",
    apiKeyEnv: "OFOXAI_ANTHROPIC_API_KEY",
  },
  "ofoxai-gemini": {
    baseURL: "https://api.ofoxai.com/gemini",
    apiKeyEnv: "OFOXAI_GEMINI_API_KEY",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  opencode: {
    baseURL: "https://api.opencode.ai/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
  },
  kimi: {
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
  },
  minimax: {
    baseURL: process.env.MINIMAX_BASE_URL || "https://api.minimax.chat/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
  },
};

// ═══════════════════════════════════════════════════════════════
// Unified Model Registry — All models in one place
// ═══════════════════════════════════════════════════════════════
export const UNIFIED_REGISTRY: UnifiedModel[] = [
  // ─── Decision / Routing ───
  {
    id: "nvidia-nano",
    provider: "openrouter",
    model: "nvidia/nemotron-3-nano:free",
    roles: ["decision"],
    contextWindow: 4096,
    isFree: true,
    tags: ["fast", "cheap"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "NVIDIA Nemotron 3 Nano — fast decision router",
    priority: 1,
    maxRetries: 2,
    timeout: 15000,
  },
  // ─── Architecture / Design ───
  {
    id: "deepseek-v3",
    provider: "deepseek",
    model: "deepseek-chat",
    roles: ["architecture", "general-chat"],
    contextWindow: 64000,
    isFree: false,
    tags: ["reasoning", "coding"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "DeepSeek V3 — reasoning & architecture",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },
  // ─── Code Generation ───
  {
    id: "deepseek-coder",
    provider: "deepseek",
    model: "deepseek-coder",
    roles: ["code-generation", "code-review", "review"],
    contextWindow: 32000,
    isFree: false,
    tags: ["coding"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "DeepSeek Coder — code generation",
    priority: 1,
    maxRetries: 3,
    timeout: 120000,
  },
  {
    id: "opencode-coder",
    provider: "opencode",
    model: "opencode-coder",
    roles: ["code-generation", "code-review"],
    contextWindow: 128000,
    isFree: false,
    tags: ["coding", "long-context"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "OpenCode Coder — long-context code",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },
  {
    id: "kimi-coder",
    provider: "kimi",
    model: "kimi-k1.5",
    roles: ["code-generation", "code-review"],
    contextWindow: 128000,
    isFree: false,
    tags: ["coding", "long-context"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Kimi K1.5 — long-context code",
    priority: 3,
    maxRetries: 3,
    timeout: 120000,
  },
  {
    id: "qwen-coder",
    provider: "siliconflow",
    model: "Qwen/Qwen2.5-Coder-32B-Instruct",
    roles: ["code-generation", "code-review"],
    contextWindow: 32000,
    isFree: false,
    tags: ["coding"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Qwen 2.5 Coder — code tasks",
    priority: 4,
    maxRetries: 3,
    timeout: 120000,
  },
  // ─── General Chat ───
  {
    id: "gemini-flash",
    provider: "ofoxai-gemini",
    model: "gemini-2.0-flash",
    roles: ["general-chat", "english"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["fast", "long-context", "multimodal"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "Gemini 2.0 Flash — fast general chat",
    priority: 1,
    maxRetries: 2,
    timeout: 60000,
  },
  {
    id: "gpt-4o",
    provider: "ofoxai",
    model: "gpt-4o",
    roles: ["general-chat", "evaluation"],
    contextWindow: 128000,
    isFree: false,
    tags: ["general", "multimodal"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "GPT-4o — general purpose",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },
  // ─── English / Translation ───
  {
    id: "llama-english",
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    roles: ["english"],
    contextWindow: 131072,
    isFree: true,
    tags: ["free", "english"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "Llama 3.3 70B — free English tasks",
    priority: 1,
    maxRetries: 2,
    timeout: 60000,
  },
  // ─── RL / Research ───
  {
    id: "deepseek-research",
    provider: "deepseek",
    model: "deepseek-researcher",
    roles: ["rl", "general-tool"],
    contextWindow: 64000,
    isFree: false,
    tags: ["research"],
    rpmLimit: 20,
    concurrentLimit: 1,
    description: "DeepSeek Researcher — RL & research",
    priority: 1,
    maxRetries: 3,
    timeout: 120000,
  },
  // ─── Free General Models (tool-pool primary) ───
  // Updated 2026-06-04: Replaced deprecated models with current OpenRouter free tier
  {
    id: "gemma-4-free",
    provider: "openrouter",
    model: "google/gemma-4-26b-a4b-it:free",
    roles: ["coding", "general-tool", "evaluation", "review"],
    contextWindow: 128000,
    isFree: true,
    tags: ["free", "coding"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "Gemma 4 26B — free coding & general",
  },
  {
    id: "gemma-4-31b-free",
    provider: "openrouter",
    model: "google/gemma-4-31b-it:free",
    roles: ["coding", "general-tool", "english", "review"],
    contextWindow: 128000,
    isFree: true,
    tags: ["free", "coding"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "Gemma 4 31B — free coding & english",
  },
  {
    id: "qwen3-coder-free",
    provider: "openrouter",
    model: "qwen/qwen3-coder:free",
    roles: ["coding", "general-tool"],
    contextWindow: 32000,
    isFree: true,
    tags: ["free", "coding"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "Qwen3 Coder — free coding",
  },
  {
    id: "qwen3-next-free",
    provider: "openrouter",
    model: "qwen/qwen3-next-80b-a3b-instruct:free",
    roles: ["general-tool", "english", "review"],
    contextWindow: 32000,
    isFree: true,
    tags: ["free"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "Qwen3 Next 80B — free general",
  },
  {
    id: "llama-3.3-free",
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    roles: ["general-tool", "english"],
    contextWindow: 131072,
    isFree: true,
    tags: ["free"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "Llama 3.3 70B — free general",
  },
  {
    id: "gpt-oss-free",
    provider: "openrouter",
    model: "openai/gpt-oss-120b:free",
    roles: ["general-tool", "english", "review"],
    contextWindow: 128000,
    isFree: true,
    tags: ["free", "reasoning"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "GPT-OSS 120B — free reasoning",
  },
  {
    id: "glm-air-free",
    provider: "openrouter",
    model: "z-ai/glm-4.5-air:free",
    roles: ["general-tool", "english"],
    contextWindow: 32000,
    isFree: true,
    tags: ["free"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "GLM 4.5 Air — free general",
  },
  {
    id: "kimi-k2-free",
    provider: "openrouter",
    model: "moonshotai/kimi-k2.6:free",
    roles: ["coding", "general-tool"],
    contextWindow: 256000,
    isFree: true,
    tags: ["free", "coding", "long-context"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "Kimi K2.6 — free coding (256K context)",
  },
  // ─── Embedding ───
  {
    id: "bge-embedding",
    provider: "siliconflow",
    model: "BAAI/bge-m3",
    roles: ["embedding"],
    contextWindow: 8192,
    isFree: false,
    tags: ["embedding"],
    rpmLimit: 300,
    concurrentLimit: 5,
    description: "BGE M3 — embedding model",
    priority: 1,
    maxRetries: 3,
    timeout: 30000,
  },
  // ─── MiniMax — 国内直连 ───
  {
    id: "minimax-m3",
    provider: "minimax",
    model: "MiniMax-M3",
    roles: [
      "general-chat",
      "architecture",
      "decision",
      "research",
      "review",
      "general-tool",
    ],
    contextWindow: 256000,
    isFree: false,
    tags: ["long-context", "chinese", "reasoning"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description:
      "MiniMax-M3 — MiniMax 旗舰模型（256K context，支持架构设计、研究分析，国内直连）",
    priority: 1,
    maxRetries: 2,
    timeout: 60000,
  },
  {
    id: "minimax-m27",
    provider: "minimax",
    model: "MiniMax-M2.7",
    roles: ["general-chat", "english", "review"],
    contextWindow: 128000,
    isFree: false,
    tags: ["long-context", "chinese", "balanced"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description:
      "MiniMax-M2.7 — 高性能均衡模型（128K context，通用对话与内容分析，国内直连）",
    priority: 2,
    maxRetries: 2,
    timeout: 60000,
  },
  {
    id: "minimax-m25",
    provider: "minimax",
    model: "MiniMax-M2.5",
    roles: ["general-chat", "english", "general-tool"],
    contextWindow: 32000,
    isFree: false,
    tags: ["chinese", "fast", "lightweight"],
    rpmLimit: 120,
    concurrentLimit: 8,
    description:
      "MiniMax-M2.5 — 轻量快速模型（32K context，响应速度快，适合高频对话场景，国内直连）",
    priority: 3,
    maxRetries: 2,
    timeout: 30000,
  },
];

// ═══════════════════════════════════════════════════════════════
// Convenience lookups
// ═══════════════════════════════════════════════════════════════

/** Get all models supporting a specific role */
export function findModelsForRole(role: TaskRole): UnifiedModel[] {
  return UNIFIED_REGISTRY.filter((m) => m.roles.includes(role));
}

/** Get models for a task (legacy alias for model-router) */
export function getModelsForTask(task: string): UnifiedModel[] {
  return UNIFIED_REGISTRY.filter(
    (m) => m.roles.includes(task as TaskRole) || m.roles.includes("general-tool")
  );
}

/** Get a model by ID */
export function getModel(id: string): UnifiedModel | undefined {
  return UNIFIED_REGISTRY.find((m) => m.id === id);
}

/** Get fallback chain for a role (sorted by priority) */
export function getFallbackChain(role: TaskRole): UnifiedModel[] {
  return findModelsForRole(role).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
}

/** List all free models */
export function listFreeModels(): UnifiedModel[] {
  return UNIFIED_REGISTRY.filter((m) => m.isFree);
}

/** List all models */
export function listAllModels(): UnifiedModel[] {
  return [...UNIFIED_REGISTRY];
}

/** List all unique roles */
export function listAllRoles(): TaskRole[] {
  const roles = new Set<TaskRole>();
  for (const m of UNIFIED_REGISTRY) {
    for (const r of m.roles) roles.add(r);
  }
  return Array.from(roles);
}
