---
id: code-router.model-router
type: code-index
source: router\model-router.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 541
tags: [code, auto-indexed]
exports: ["router"]
---

# router.model-router

## 元信息

- **源文件**: `router\model-router.ts`
- **模块**: `router.model-router`
- **行数**: 175
- **索引时间**: 2026-05-25T05:11:12.539Z

## 导出清单

| 类型 | 名称 | 行号 |
|------|------|------|
| variable | `router` | 174 |

## 代码

```typescript
/**
 * 多平台模型路由器
 * 实现四级路由：硅基流动免费 → OfoxAI免费 → 付费主力 → OpenRouter兜底
 */

interface ModelRoute {
  provider: "siliconflow" | "ofoxai" | "openrouter" | "deepseek";
  model: string;
  priority: number;
  maxRetries: number;
  timeout: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  content: string | null;
  model: string;
  provider: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// 路由配置表
const MODEL_ROUTES: Record<string, ModelRoute[]> = {
  "general-chat": [
    { provider: "siliconflow", model: "Qwen/Qwen2-7B-Instruct", priority: 0, maxRetries: 2, timeout: 10000 },
    { provider: "ofoxai", model: "qwen-3-5", priority: 1, maxRetries: 2, timeout: 15000 },
  ],
  "code-generation": [
    { provider: "ofoxai", model: "deepseek/deepseek-v4-flash", priority: 0, maxRetries: 2, timeout: 15000 },
    { provider: "siliconflow", model: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", priority: 1, maxRetries: 2, timeout: 10000 },
  ],
  "complex-reasoning": [
    { provider: "ofoxai", model: "deepseek/deepseek-v4-pro", priority: 0, maxRetries: 2, timeout: 30000 },
    { provider: "ofoxai", model: "anthropic/claude-opus-4-6", priority: 1, maxRetries: 1, timeout: 30000 },
  ],
  "embedding": [
    { provider: "siliconflow", model: "BAAI/bge-large-zh", priority: 0, maxRetries: 2, timeout: 10000 },
  ],
};

// 平台配置
const PROVIDER_CONFIG: Record<string, { baseURL: string; apiKeyEnv: string }> = {
  siliconflow: {
    baseURL: process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1",
    apiKeyEnv: "SILICONFLOW_API_KEY",
  },
  ofoxai: {
    baseURL: process.env.OFOXAI_BASE_URL || "https://api.ofox.ai/v1",
    apiKeyEnv: "OFOXAI_API_KEY",
  },
  openrouter: {
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  deepseek: {
    baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
};

class MultiPlatformRouter {
  async chat(taskType: string, messages: ChatMessage[]): Promise<ChatResponse> {
    const routes = MODEL_ROUTES[taskType];
    if (!routes) throw new Error(`Unknown task type: ${taskType}`);

    // 按优先级排序
    const sortedRoutes = routes.sort((a, b) => a.priority - b.priority);

    for (const route of sortedRoutes) {
      for (let attempt = 0; attempt <= route.maxRetries; attempt++) {
        try {
          const response = await this.callProvider(route.provider, route.model, messages, route.timeout);
          return {
            content: response.content,
            model: route.model,
            provider: route.provider,
            usage: response.usage,
          };
        } catch (error) {
          console.warn(`[Router] Attempt ${attempt + 1} failed for ${route.provider}/${route.model}:`, error);
          if (attempt === route.maxRetries) continue;
        }
      }
    }

    throw new Error("All model routes exhausted");
  }

  private async callProvider(
    provider: string,
    model: string,
    messages: ChatMessage[],
    timeoutMs: number
  ): Promise<{ content: string | null; usage?: any }> {
    const config = PROVIDER_CONFIG[provider];
    if (!config) throw new Error(`Unknown provider: ${provider}`);

    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing API key for ${provider}: ${config.apiKeyEnv}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${config.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(provider === "openrouter"
            ? { "HTTP-Referer": "https://openclaw.ai", "X-Title": "OpenClaw Agent" }
            : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json();
      return {
        content: data.choices?.[0]?.message?.content ?? null,
        usage: data.usage,
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  async embeddings(texts: string[]): Promise<number[][]> {
    const route = MODEL_ROUTES["embedding"]?.[0];
    if (!route) throw new Error("No embedding route configured");

    const config = PROVIDER_CONFIG[route.provider];
    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing API key for embedding`);

    const res = await fetch(`${config.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: route.model,
        input: texts,
      }),
    });

    if (!res.ok) throw new Error(`Embedding request failed: ${res.status}`);
    const data = await res.json();
    return data.data?.map((d: any) => d.embedding) ?? [];
  }
}

export const router = new MultiPlatformRouter();

```