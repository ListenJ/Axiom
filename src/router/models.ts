// src/router/models.ts
// Unified Model Registry — Single source of truth for all model metadata
// Consumers: model-router.ts, tool-pool.ts, model-capability-registry.ts
// Updated: 2026-06-05 with real data from OpenRouter API & OfoxAI
// Data sources:
//   - OpenRouter API: https://openrouter.ai/api/v1/models (400+ models)
//   - OfoxAI: https://ofox.ai/models (101 models with live pricing)

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
  | "nvidia-nim";

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
  "nvidia-nim": {
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NIM_API_KEY",
  },
};

// ═══════════════════════════════════════════════════════════════
// Unified Model Registry — All models in one place
// Updated: 2026-06-05 with verified pricing from OpenRouter & OfoxAI
// ═══════════════════════════════════════════════════════════════
export const UNIFIED_REGISTRY: UnifiedModel[] = [
  // ═══════════════════════════════════════════════════════════════
  // 旗舰模型 / Flagship Models (2026)
  // ═══════════════════════════════════════════════════════════════

  // ─── GPT-5.5 (OpenAI via OpenRouter/OfoxAI) ───
  {
    id: "gpt-5.5",
    provider: "openrouter",
    model: "openai/gpt-5.5",
    roles: ["decision", "architecture", "code-generation", "general-chat", "research", "deep_research", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["flagship", "reasoning", "multimodal"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "GPT-5.5 — OpenAI 旗舰模型 (1M ctx, $4.25/$25.5 per 1M)",
    priority: 1,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── GPT-5.4 Pro (OpenAI via OpenRouter) ───
  {
    id: "gpt-5.4-pro",
    provider: "openrouter",
    model: "openai/gpt-5.4-pro",
    roles: ["architecture", "code-generation", "deep_research", "research", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["flagship", "reasoning", "multimodal"],
    rpmLimit: 20,
    concurrentLimit: 1,
    description: "GPT-5.4 Pro — OpenAI 高阶模型 (1M ctx, $30/$180 per 1M)",
    priority: 1,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Claude Opus 4.8 (Anthropic via OpenRouter/OfoxAI) ───
  {
    id: "claude-opus-4.8",
    provider: "ofoxai-anthropic",
    model: "claude-opus-4-8-20260301",
    roles: ["architecture", "code-generation", "deep_research", "research", "review", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["flagship", "reasoning", "coding"],
    rpmLimit: 20,
    concurrentLimit: 1,
    description: "Claude Opus 4.8 — Anthropic 最新旗舰 (1M ctx, $5/$25 per 1M)",
    priority: 1,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Claude Opus 4.7 (Anthropic via OpenRouter/OfoxAI) ───
  {
    id: "claude-opus-4.7",
    provider: "ofoxai-anthropic",
    model: "claude-opus-4-7-20251101",
    roles: ["architecture", "code-generation", "deep_research", "research", "review", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["flagship", "reasoning", "coding"],
    rpmLimit: 20,
    concurrentLimit: 1,
    description: "Claude Opus 4.7 — Anthropic 旗舰模型 (1M ctx, $5/$25 per 1M)",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Claude Sonnet 4.6 (Anthropic via OpenRouter/OfoxAI) ───
  {
    id: "claude-sonnet-4.6",
    provider: "ofoxai-anthropic",
    model: "claude-sonnet-4-6-20251101",
    roles: ["code-generation", "code-review", "general-chat", "review", "research", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["mid-tier", "coding", "fast"],
    rpmLimit: 40,
    concurrentLimit: 2,
    description: "Claude Sonnet 4.6 — 高性能均衡模型 (1M ctx, $3/$15 per 1M)",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Gemini 3.1 Pro (Google via OfoxAI/OpenRouter) ───
  {
    id: "gemini-3.1-pro",
    provider: "ofoxai-gemini",
    model: "gemini-3.1-pro-preview",
    roles: ["architecture", "code-generation", "general-chat", "research", "deep_research", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["flagship", "multimodal", "long-context"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Gemini 3.1 Pro — Google 旗舰模型 (1M ctx, $2/$12 per 1M)",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Gemini 2.5 Pro (Google via OpenRouter) ───
  {
    id: "gemini-2.5-pro",
    provider: "openrouter",
    model: "google/gemini-2.5-pro",
    roles: ["architecture", "code-generation", "general-chat", "research", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["flagship", "multimodal", "long-context"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Gemini 2.5 Pro — Google 前代旗舰 (1M ctx, $1.25/$10 per 1M)",
    priority: 3,
    maxRetries: 3,
    timeout: 120000,
  },

  // ═══════════════════════════════════════════════════════════════
  // 主力任务模型 / Main Task Models (2026)
  // ═══════════════════════════════════════════════════════════════

  // ─── GPT-5.4 (OpenAI via OpenRouter) ───
  {
    id: "gpt-5.4",
    provider: "openrouter",
    model: "openai/gpt-5.4",
    roles: ["code-generation", "general-chat", "research", "review", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["mid-tier", "reasoning", "multimodal"],
    rpmLimit: 40,
    concurrentLimit: 2,
    description: "GPT-5.4 — OpenAI 主力模型 (1M ctx, $2.5/$15 per 1M)",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── DeepSeek V4 Pro ───
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    roles: ["decision", "architecture", "code-generation", "code-review", "general-chat", "research"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["main", "reasoning", "coding", "chinese"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "DeepSeek V4 Pro — 1.6T/49B MoE, 1M ctx ($0.43/$0.87 per 1M via OpenRouter)",
    priority: 1,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── DeepSeek V4 Flash ───
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    roles: ["code-generation", "general-chat", "general-tool", "review"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["fast", "coding", "chinese"],
    rpmLimit: 120,
    concurrentLimit: 8,
    description: "DeepSeek V4 Flash — 284B/13B MoE, 1M ctx, 极速响应 ($0.14/$0.28 per 1M)",
    priority: 2,
    maxRetries: 2,
    timeout: 60000,
  },

  // ─── DeepSeek R1 (Reasoning) ───
  {
    id: "deepseek-r1",
    provider: "deepseek",
    model: "deepseek-reasoner",
    roles: ["deep_research", "research", "math", "architecture", "evaluation"],
    contextWindow: 163840,
    isFree: false,
    tags: ["reasoning", "rl", "chinese"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "DeepSeek R1 — 推理专用模型 ($0.70/$2.50 per 1M)",
    priority: 1,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── GLM 5.1 (SiliconFlow) ───
  {
    id: "glm-5.1",
    provider: "siliconflow",
    model: "zhipu/GLM-5.1",
    roles: ["decision", "architecture", "code-generation", "code-review", "general-chat", "research", "review"],
    contextWindow: 200000,
    isFree: false,
    tags: ["main", "reasoning", "coding", "chinese"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "GLM 5.1 — 智谱旗舰模型 ($0.98/$3.08 per 1M via OpenRouter)",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── GLM 5 (SiliconFlow) ───
  {
    id: "glm-5",
    provider: "siliconflow",
    model: "zhipu/GLM-5",
    roles: ["code-generation", "general-chat", "research", "general-tool", "review"],
    contextWindow: 200000,
    isFree: false,
    tags: ["mid-tier", "coding", "chinese"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "GLM 5 — 智谱主力模型 ($0.60/$1.92 per 1M via OpenRouter)",
    priority: 3,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Kimi K2.6 ───
  {
    id: "kimi-k2.6",
    provider: "kimi",
    model: "kimi-k2.6",
    roles: ["code-generation", "code-review", "coding", "general-chat", "research", "review"],
    contextWindow: 262000,
    isFree: false,
    tags: ["coding", "long-context", "chinese"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Kimi K2.6 — Moonshot 代码与长上下文任务 (262K ctx, $0.68/$3.42 per 1M)",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Kimi K2.5 ───
  {
    id: "kimi-k2.5",
    provider: "kimi",
    model: "kimi-k2.5",
    roles: ["code-generation", "general-chat", "general-tool", "review"],
    contextWindow: 262000,
    isFree: false,
    tags: ["coding", "long-context", "chinese", "balanced"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "Kimi K2.5 — Moonshot 均衡模型 (262K ctx, $0.40/$1.90 per 1M)",
    priority: 3,
    maxRetries: 2,
    timeout: 60000,
  },

  // ─── Kimi Latest ───
  {
    id: "kimi-latest",
    provider: "kimi",
    model: "kimi-latest",
    roles: ["general-chat", "general-tool", "english", "review"],
    contextWindow: 128000,
    isFree: false,
    tags: ["general", "chinese", "balanced"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "Kimi Latest — Moonshot 最新通用模型 (128K context)",
    priority: 3,
    maxRetries: 2,
    timeout: 60000,
  },

  // ─── MiniMax M3 ───
  {
    id: "minimax-m3",
    provider: "minimax",
    model: "MiniMax-M3",
    roles: ["general-chat", "architecture", "decision", "research", "review", "general-tool"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["long-context", "chinese", "reasoning", "multimodal"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "MiniMax M3 — 1M context 多模态模型 ($0.30/$1.20 per 1M via OpenRouter)",
    priority: 2,
    maxRetries: 2,
    timeout: 60000,
  },

  // ─── MiniMax M2.7 ───
  {
    id: "minimax-m2.7",
    provider: "minimax",
    model: "MiniMax-M2.7",
    roles: ["general-chat", "architecture", "decision", "research", "review", "general-tool"],
    contextWindow: 200000,
    isFree: false,
    tags: ["long-context", "chinese", "reasoning"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "MiniMax M2.7 — 200K context 高效模型 ($0.28/$1.20 per 1M via OpenRouter)",
    priority: 3,
    maxRetries: 2,
    timeout: 60000,
  },

  // ─── MiniMax M2.5 ───
  {
    id: "minimax-m2.5",
    provider: "minimax",
    model: "MiniMax-M2.5",
    roles: ["general-chat", "general-tool", "english", "review"],
    contextWindow: 200000,
    isFree: false,
    tags: ["chinese", "fast", "balanced"],
    rpmLimit: 120,
    concurrentLimit: 8,
    description: "MiniMax M2.5 — 快速均衡模型 ($0.15/$1.15 per 1M via OpenRouter)",
    priority: 4,
    maxRetries: 2,
    timeout: 30000,
  },

  // ═══════════════════════════════════════════════════════════════
  // 开源模型 / Open-Weight Models (2026)
  // ═══════════════════════════════════════════════════════════════

  // ─── Llama 4 Scout ───
  {
    id: "llama-4-scout",
    provider: "openrouter",
    model: "meta-llama/llama-4-scout",
    roles: ["code-generation", "general-chat", "english", "general-tool"],
    contextWindow: 10000000,  // 10M context!
    isFree: false,
    tags: ["open-weight", "ultra-long-context", "coding"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Llama 4 Scout — 109B/17B, 10M context window",
    priority: 3,
    maxRetries: 2,
    timeout: 120000,
  },

  // ─── Llama 4 Maverick ───
  {
    id: "llama-4-maverick",
    provider: "openrouter",
    model: "meta-llama/llama-4-maverick",
    roles: ["code-generation", "architecture", "general-chat", "research"],
    contextWindow: 128000,
    isFree: false,
    tags: ["open-weight", "coding", "reasoning"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Llama 4 Maverick — 400B/17B, 高性能开源模型",
    priority: 3,
    maxRetries: 2,
    timeout: 120000,
  },

  // ─── Qwen3.7-Plus ───
  {
    id: "qwen3.7-plus",
    provider: "siliconflow",
    model: "alibaba/Qwen3.7-Plus",
    roles: ["code-generation", "general-chat", "general-tool", "review"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["open-weight", "chinese", "balanced", "long-context"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "Qwen3.7 Plus — 阿里巴巴增强版 (1M ctx, $0.40/$1.60 per 1M)",
    priority: 3,
    maxRetries: 2,
    timeout: 60000,
  },

  // ─── Qwen3.5-Flash ───
  {
    id: "qwen3.5-flash",
    provider: "siliconflow",
    model: "alibaba/Qwen3.5-Flash",
    roles: ["code-generation", "general-chat", "general-tool"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["open-weight", "chinese", "fast", "budget"],
    rpmLimit: 120,
    concurrentLimit: 8,
    description: "Qwen3.5 Flash — 极速经济模型 (1M ctx, $0.10/$0.40 per 1M)",
    priority: 4,
    maxRetries: 2,
    timeout: 30000,
  },

  // ─── Qwen2.5-VL-72B-Instruct (Vision — 旗舰) ───
  {
    id: "qwen2.5-vl-72b",
    provider: "siliconflow",
    model: "Qwen/Qwen2.5-VL-72B-Instruct",
    roles: ["computer-use", "general-chat", "english", "research"],
    contextWindow: 32000,
    isFree: false,
    tags: ["vision", "multimodal", "chinese", "computer-use", "flagship"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Qwen2.5-VL-72B — 旗舰视觉语言模型，支持高分辨率截图分析和计算机自动化 (32K ctx)",
    priority: 1,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Qwen2-VL-72B-Instruct (Vision — 备选) ───
  {
    id: "qwen2-vl-72b",
    provider: "siliconflow",
    model: "Qwen/Qwen2-VL-72B-Instruct",
    roles: ["computer-use", "general-chat", "english"],
    contextWindow: 32000,
    isFree: false,
    tags: ["vision", "multimodal", "chinese", "computer-use"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Qwen2-VL-72B — 大参数视觉语言模型 (32K ctx)",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── QVQ-72B-Preview (Vision Reasoning) ───
  {
    id: "qvq-72b",
    provider: "siliconflow",
    model: "Qwen/QVQ-72B-Preview",
    roles: ["computer-use", "deep_research", "research", "general-chat"],
    contextWindow: 32000,
    isFree: false,
    tags: ["vision", "reasoning", "multimodal", "chinese", "computer-use"],
    rpmLimit: 20,
    concurrentLimit: 1,
    description: "QVQ-72B-Preview — 视觉推理模型，支持深度视觉分析和复杂任务规划 (32K ctx)",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Mistral Medium 3.5 ───
  {
    id: "mistral-medium-3.5",
    provider: "openrouter",
    model: "mistralai/mistral-medium-3-5",
    roles: ["code-generation", "general-chat", "english", "general-tool"],
    contextWindow: 262000,
    isFree: false,
    tags: ["open-weight", "coding", "balanced"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "Mistral Medium 3.5 — 128B 稠密模型 ($1.50/$7.50 per 1M)",
    priority: 3,
    maxRetries: 2,
    timeout: 60000,
  },

  // ─── NVIDIA Nemotron 3 Ultra ───
  {
    id: "nvidia-nemotron-3-ultra",
    provider: "openrouter",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    roles: ["architecture", "code-generation", "research", "general-chat"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["open-weight", "reasoning", "long-context"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "NVIDIA Nemotron 3 Ultra — 550B/55B MoE, 1M ctx ($0.50/$2.50 per 1M)",
    priority: 3,
    maxRetries: 2,
    timeout: 120000,
  },

  // ═══════════════════════════════════════════════════════════════
  // 经济型模型 / Budget Models (2026)
  // ═══════════════════════════════════════════════════════════════

  // ─── GPT-5.4 Mini ───
  {
    id: "gpt-5.4-mini",
    provider: "openrouter",
    model: "openai/gpt-5.4-mini",
    roles: ["decision", "general-tool", "english", "general-chat", "computer-use"],
    contextWindow: 400000,
    isFree: false,
    tags: ["budget", "fast", "multimodal"],
    rpmLimit: 120,
    concurrentLimit: 8,
    description: "GPT-5.4 Mini — 经济型轻量模型 ($0.75/$4.5 per 1M)",
    priority: 4,
    maxRetries: 2,
    timeout: 30000,
  },

  // ─── GPT-5.4 Nano ───
  {
    id: "gpt-5.4-nano",
    provider: "openrouter",
    model: "openai/gpt-5.4-nano",
    roles: ["decision", "general-tool", "english"],
    contextWindow: 400000,
    isFree: false,
    tags: ["budget", "fast", "lightweight"],
    rpmLimit: 180,
    concurrentLimit: 10,
    description: "GPT-5.4 Nano — 超轻量经济模型 ($0.20/$1.25 per 1M)",
    priority: 5,
    maxRetries: 2,
    timeout: 20000,
  },

  // ─── Gemini 3.5 Flash ───
  {
    id: "gemini-3.5-flash",
    provider: "ofoxai-gemini",
    model: "gemini-3.5-flash",
    roles: ["general-chat", "english", "general-tool", "review", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["budget", "fast", "multimodal", "long-context"],
    rpmLimit: 120,
    concurrentLimit: 8,
    description: "Gemini 3.5 Flash — 极速响应 (1M ctx, $1.5/$9 per 1M)",
    priority: 4,
    maxRetries: 2,
    timeout: 30000,
  },

  // ─── Gemini 3.1 Flash Lite ───
  {
    id: "gemini-3.1-flash-lite",
    provider: "ofoxai-gemini",
    model: "gemini-3.1-flash-lite",
    roles: ["general-chat", "english", "general-tool"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["budget", "fast", "lightweight"],
    rpmLimit: 180,
    concurrentLimit: 10,
    description: "Gemini 3.1 Flash Lite — 超轻量经济模型 (1M ctx, $0.25/$1.5 per 1M)",
    priority: 5,
    maxRetries: 2,
    timeout: 20000,
  },

  // ─── GLM-4.7-Flash (Free) ───
  {
    id: "glm-4.7-flash-free",
    provider: "siliconflow",
    model: "zhipu/GLM-4.7-Flash:free",
    roles: ["general-chat", "general-tool", "english"],
    contextWindow: 200000,
    isFree: true,
    tags: ["free", "chinese", "fast"],
    rpmLimit: 120,
    concurrentLimit: 8,
    description: "GLM-4.7-Flash — 智谱免费极速模型 (200K ctx)",
    priority: 5,
    maxRetries: 2,
    timeout: 30000,
  },

  // ─── GLM-4.7 ───
  {
    id: "glm-4.7",
    provider: "siliconflow",
    model: "zhipu/GLM-4.7",
    roles: ["general-chat", "general-tool", "english", "review"],
    contextWindow: 200000,
    isFree: false,
    tags: ["budget", "chinese", "fast"],
    rpmLimit: 120,
    concurrentLimit: 8,
    description: "GLM 4.7 — 智谱经济模型 (200K ctx, $0.40/$1.75 per 1M)",
    priority: 4,
    maxRetries: 2,
    timeout: 30000,
  },

  // ═══════════════════════════════════════════════════════════════
  // 免费模型 / Free Models (OpenRouter)
  // ═══════════════════════════════════════════════════════════════

  // ─── OpenRouter Free Tier ───
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
    description: "Gemma 4 26B — 免费编码与通用",
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
    description: "Gemma 4 31B — 免费编码与英文",
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
    description: "Qwen3 Coder — 免费编码",
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
    description: "Qwen3 Next 80B — 免费通用",
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
    description: "Llama 3.3 70B — 免费通用",
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
    description: "GPT-OSS 120B — 免费推理",
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
    description: "GLM 4.5 Air — 免费通用",
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
    description: "Kimi K2.6 — 免费编码 (256K context)",
  },
  {
    id: "nvidia-nemotron-free",
    provider: "openrouter",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    roles: ["general-tool", "english", "research"],
    contextWindow: 1000000,
    isFree: true,
    tags: ["free", "reasoning", "long-context"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "NVIDIA Nemotron 3 Ultra — 免费推理 (1M context)",
  },

  // ═══════════════════════════════════════════════════════════════
  // 专用模型 / Specialized Models
  // ═══════════════════════════════════════════════════════════════

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
    description: "BGE M3 — 向量嵌入模型",
    priority: 1,
    maxRetries: 3,
    timeout: 30000,
  },

  // ─── Decision / Routing ───
  {
    id: "nvidia-nano",
    provider: "openrouter",
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    roles: ["decision"],
    contextWindow: 256000,
    isFree: true,
    tags: ["fast", "cheap", "free"],
    rpmLimit: 60,
    concurrentLimit: 2,
    description: "NVIDIA Nemotron 3 Nano Omni — 免费快速决策路由",
    priority: 3,
    maxRetries: 2,
    timeout: 15000,
  },

  // ═══════════════════════════════════════════════════════════════
  // 遗留模型 / Legacy Models (向后兼容)
  // ═══════════════════════════════════════════════════════════════
  {
    id: "deepseek-v3",
    provider: "deepseek",
    model: "deepseek-chat",
    roles: ["architecture", "general-chat"],
    contextWindow: 64000,
    isFree: false,
    tags: ["reasoning", "coding", "legacy"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "DeepSeek V3 — 推理与架构 (legacy, $0.20/$0.80 per 1M)",
    priority: 5,
    maxRetries: 3,
    timeout: 120000,
  },
  {
    id: "deepseek-coder",
    provider: "deepseek",
    model: "deepseek-coder",
    roles: ["code-generation", "code-review", "review"],
    contextWindow: 32000,
    isFree: false,
    tags: ["coding", "legacy"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "DeepSeek Coder — 代码生成 (legacy)",
    priority: 5,
    maxRetries: 3,
    timeout: 120000,
  },
  {
    id: "gpt-4o",
    provider: "ofoxai",
    model: "gpt-4o",
    roles: ["general-chat", "evaluation", "computer-use"],
    contextWindow: 128000,
    isFree: false,
    tags: ["general", "multimodal", "legacy"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "GPT-4o — 通用目的 (legacy)",
    priority: 4,
    maxRetries: 3,
    timeout: 120000,
  },
  {
    id: "gemini-2.0-flash",
    provider: "ofoxai-gemini",
    model: "gemini-2.0-flash",
    roles: ["general-chat", "english", "computer-use"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["fast", "long-context", "multimodal", "legacy"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "Gemini 2.0 Flash — 快速通用 (legacy)",
    priority: 3,
    maxRetries: 2,
    timeout: 60000,
  },
  {
    id: "claude-opus-4.6",
    provider: "ofoxai-anthropic",
    model: "claude-opus-4-6-20251001",
    roles: ["architecture", "code-generation"],
    contextWindow: 1000000,
    isFree: false,
    tags: ["flagship", "coding", "legacy"],
    rpmLimit: 20,
    concurrentLimit: 1,
    description: "Claude Opus 4.6 — 前代旗舰 (legacy, $5/$25 per 1M)",
    priority: 3,
    maxRetries: 3,
    timeout: 120000,
  },

  // ═══════════════════════════════════════════════════════════════
  // NVIDIA NIM Models (2026) — 优先级: GLM5.1 最高
  // Base URL: https://integrate.api.nvidia.com/v1
  // ═══════════════════════════════════════════════════════════════

  // ─── GLM5.1 (NVIDIA NIM, 智谱, 优先级最高) ───
  {
    id: "nim-glm5.1",
    provider: "nvidia-nim",
    model: "z-ai/glm5.1",
    roles: ["code-generation", "architecture", "deep_research", "research", "general-chat", "review"],
    contextWindow: 200000,
    isFree: false,
    tags: ["flagship", "reasoning", "coding", "chinese", "nim-priority"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "GLM5.1 (NVIDIA NIM) — 智谱旗舰 754B MoE, 200K ctx, 优先使用",
    priority: 1,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── DeepSeek V4 Pro (NVIDIA NIM) ───
  {
    id: "nim-deepseek-v4-pro",
    provider: "nvidia-nim",
    model: "deepseek-ai/deepseek-v4-pro",
    roles: ["code-generation", "architecture", "deep_research", "research", "review"],
    contextWindow: 163840,
    isFree: false,
    tags: ["main", "reasoning", "coding", "nim"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "DeepSeek V4 Pro (NVIDIA NIM) — 1.6T MoE, 128K ctx",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── DeepSeek V4 Flash (NVIDIA NIM) ───
  {
    id: "nim-deepseek-v4-flash",
    provider: "nvidia-nim",
    model: "deepseek-ai/deepseek-v4-flash",
    roles: ["code-generation", "general-chat", "general-tool", "review"],
    contextWindow: 163840,
    isFree: false,
    tags: ["fast", "coding", "nim"],
    rpmLimit: 120,
    concurrentLimit: 8,
    description: "DeepSeek V4 Flash (NVIDIA NIM) — 极速响应, 128K ctx",
    priority: 2,
    maxRetries: 2,
    timeout: 60000,
  },

  // ─── Qwen3 80B Thinking (NVIDIA NIM) ───
  {
    id: "nim-qwen3-80b",
    provider: "nvidia-nim",
    model: "qwen/qwen3-next-80b-a3b-thinking",
    roles: ["deep_research", "architecture", "math", "research", "code-generation"],
    contextWindow: 131072,
    isFree: false,
    tags: ["reasoning", "thinking", "nim"],
    rpmLimit: 30,
    concurrentLimit: 2,
    description: "Qwen3 80B Thinking (NVIDIA NIM) — 推理增强, 128K ctx",
    priority: 2,
    maxRetries: 3,
    timeout: 120000,
  },

  // ─── Llama 3.3 Nemotron Super (NVIDIA NIM) ───
  {
    id: "nim-nemotron-super",
    provider: "nvidia-nim",
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    roles: ["general-chat", "code-generation", "review", "general-tool"],
    contextWindow: 131072,
    isFree: false,
    tags: ["fast", "balanced", "nim"],
    rpmLimit: 60,
    concurrentLimit: 4,
    description: "Nemotron Super 49B (NVIDIA NIM) — 高性能均衡, 128K ctx",
    priority: 3,
    maxRetries: 2,
    timeout: 60000,
  },

  // ─── Kimi K2.6 (NVIDIA NIM) ───
  {
    id: "nim-kimi-k2.6",
    provider: "nvidia-nim",
    model: "moonshotai/kimi-k2.6",
    roles: ["code-generation", "general-chat", "research", "review"],
    contextWindow: 131072,
    isFree: false,
    tags: ["coding", "chinese", "nim"],
    rpmLimit: 40,
    concurrentLimit: 2,
    description: "Kimi K2.6 (NVIDIA NIM) — Moonshot 编程模型, 128K ctx",
    priority: 3,
    maxRetries: 3,
    timeout: 90000,
  },

  // ─── MiniMax M2.7 (NVIDIA NIM) ───
  {
    id: "nim-minimax-m2.7",
    provider: "nvidia-nim",
    model: "minimaxai/minimax-m2.7",
    roles: ["general-chat", "code-generation", "research"],
    contextWindow: 131072,
    isFree: false,
    tags: ["fast", "chinese", "nim"],
    rpmLimit: 40,
    concurrentLimit: 2,
    description: "MiniMax M2.7 (NVIDIA NIM) — 快速通用, 128K ctx",
    priority: 3,
    maxRetries: 2,
    timeout: 60000,
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

/** Get provider config for a model */
export function getProviderConfig(modelId: string): ProviderConfig | undefined {
  const model = getModel(modelId);
  if (!model) return undefined;
  return PROVIDER_CONFIG[model.provider];
}

/** Check if a provider is configured */
export function isProviderConfigured(provider: ModelProvider): boolean {
  const config = PROVIDER_CONFIG[provider];
  if (!config) return false;
  return !!process.env[config.apiKeyEnv];
}

/** List configured providers */
export function listConfiguredProviders(): ModelProvider[] {
  return (Object.keys(PROVIDER_CONFIG) as ModelProvider[]).filter(isProviderConfigured);
}
