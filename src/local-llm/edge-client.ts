/**
 * 边缘小模型客户端 —— llama.cpp 部署的 MiniCPM5-1B
 *
 * 用途: 提示词优化 / 高危操作初筛 / vault 文档管理 / 知识库管理
 * 的轻量分类·改写·打标任务, 全部遵循 "边缘增强, 失败回退" 模式。
 *
 * 配置 (env):
 * - EDGE_LLM_URL   默认 http://192.168.0.150:9001 (LLMClient 自拼 /v1)
 * - EDGE_LLM_MODEL 默认 MiniCPM5-1B (llama.cpp 忽略 model 字段)
 * - EDGE_LLM_TRANSPORT 默认 "chat"; 设为 "completion" 走原生 /completion
 *   (chat template 强制思考且无法关闭的模型需要, 如 Qwopus3.5-2B)
 *
 * MiniCPM5/Qwopus4B 是 reasoning 模型, chat 模式默认携带 chat_template_kwargs
 * { enable_thinking: false } 关闭思考, 保证分类/改写任务低延迟。
 */

import { LLMClient } from "../dre/llm/client.js";
import { readString } from "../utils/env.js";

let instance: LLMClient | null = null;

/** 获取边缘模型单例客户端 */
export function getEdgeClient(): LLMClient {
  if (!instance) {
    instance = new LLMClient({
      baseUrl: readString("EDGE_LLM_URL", "http://192.168.0.150:9001"),
      model: readString("EDGE_LLM_MODEL", "MiniCPM5-1B"),
      timeout: 8000,
      maxTokens: 512,
      transport: readString("EDGE_LLM_TRANSPORT") === "completion" ? "completion" : "chat",
      chatTemplateKwargs: { enable_thinking: false },
      retry: { maxRetries: 1 },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 30000 },
    });
  }
  return instance;
}

/**
 * 功能开关: env 为 "0"/"false" 时关闭, 未设置默认开启。
 * 用于 EDGE_PROMPT_OPTIMIZER / EDGE_RISK_MONITOR / EDGE_MEMORY_ASSIST / EDGE_KNOWLEDGE_ASSIST
 */
export function isEdgeEnabled(flag: string): boolean {
  const v = readString(flag, "1").toLowerCase();
  return v !== "0" && v !== "false";
}

/**
 * 容错 JSON 解析: 剥离 markdown code fence, 提取首个 {...} 对象。
 * 解析失败返回 null (调用方据此回退)。
 */
export function extractJson<T = Record<string, unknown>>(content: string): T | null {
  let text = content.trim();

  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // 不是纯 JSON, 尝试提取首个对象
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      // 提取后仍解析失败
    }
  }

  return null;
}
