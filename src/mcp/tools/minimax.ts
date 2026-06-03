/**
 * MiniMax MCP 工具封装
 * 提供网络搜索和图像识别能力
 * 
 * API 文档: https://platform.minimax.io/docs/guides/token-plan-mcp-guide
 * Token Plan (网络搜索 + 图像识别): https://api.minimax.io
 * 标准版: https://api.minimax.chat
 * 
 * 特性:
 * - web_search: 网络搜索 (POST /v1/coding_plan/search)
 * - understand_image: 图像识别 (POST /v1/coding_plan/vlm)
 * 
 * 若订阅了 MiniMax Token Plan，可使用同一 API Key 同时调用模型和 MCP 工具
 */

import { logger } from "../../utils/logger.js";
import { TIMEOUTS } from "../../constants/timeouts.js";
import { withRetry, withTimeout } from "../../utils/resilience.js";

/** MiniMax API 配置 */
interface MiniMaxConfig {
  apiKey: string;
  baseUrl: string;
}

function getMiniMaxConfig(): MiniMaxConfig {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MiniMax API key not configured. Set MINIMAX_API_KEY environment variable. " +
      "If you have a Token Plan subscription, use the same key for both model calls and MCP tools."
    );
  }
  // Token Plan 使用 api.minimax.io（网络搜索+图像识别），标准版使用 api.minimax.chat
  const baseUrl = process.env.MINIMAX_BASE_URL || "https://api.minimax.io";
  return { apiKey, baseUrl };
}

/** 构建 MiniMax API 请求头 */
function buildHeaders(config: MiniMaxConfig): Record<string, string> {
  return {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    "MM-API-Source": "Minimax-MCP",
  };
}

/**
 * 验证 MiniMax API 响应格式
 */
function validateMiniMaxResponse<T>(data: unknown): T {
  if (data === null || typeof data !== "object") {
    throw new Error("Invalid MiniMax API response: expected object, got " + typeof data);
  }
  return data as T;
}

/** 通用 API 调用 */
async function callMiniMaxAPI<T>(
  endpoint: string,
  body: Record<string, unknown>,
  config?: MiniMaxConfig
): Promise<T> {
  const cfg = config || getMiniMaxConfig();
  const url = `${cfg.baseUrl}${endpoint}`;

  const response = await withTimeout(
    withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: buildHeaders(cfg),
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`MiniMax API error ${res.status}: ${errorText}`);
        }
        return res;
      },
      { maxAttempts: 2, baseDelay: 500 }
    ),
    TIMEOUTS.API_DEFAULT
  );

  const jsonData = await response.json();
  return validateMiniMaxResponse<T>(jsonData);
}

// ==================== 网络搜索 ====================

export interface MiniMaxWebSearchResult {
  title: string;
  link: string;
  snippet: string;
  displayedUrl?: string;
  date?: string;
}

export interface MiniMaxWebSearchResponse {
  success: boolean;
  results: MiniMaxWebSearchResult[];
  totalResults?: number;
  query: string;
}

/**
 * MiniMax 网络搜索
 * 使用 MiniMax 的 web_search 能力进行实时网络搜索
 */
export async function minimaxWebSearch(
  query: string,
  _opts?: { num?: number; lang?: string }
): Promise<MiniMaxWebSearchResponse> {
  try {
    const response = await callMiniMaxAPI<{
      data?: {
        results?: Array<{
          title: string;
          link: string;
          snippet?: string;
          displayedUrl?: string;
          date?: string;
        }>;
        totalResults?: number;
      };
    }>(
      "/v1/coding_plan/search",
      {
        q: query,
      }
    );

    const results = response.data?.results || [];
    return {
      success: true,
      query,
      results: results.map((r) => ({
        title: r.title,
        link: r.link,
        snippet: r.snippet || "",
        displayedUrl: r.displayedUrl,
        date: r.date,
      })),
      totalResults: response.data?.totalResults,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[MiniMax] Web search failed", { query, error: message });
    return {
      success: false,
      query,
      results: [],
    };
  }
}

// ==================== 图像识别 ====================

export interface MiniMaxImageUnderstandResult {
  description: string;
  objects?: string[];
  text?: string;
  scenes?: string[];
}

export interface MiniMaxImageUnderstandResponse {
  success: boolean;
  result?: MiniMaxImageUnderstandResult;
  error?: string;
}

/**
 * MiniMax 图像识别
 * 使用 MiniMax 的 understand_image 能力分析图像内容
 * 支持 URL 或 base64 编码的图像数据
 */
export async function minimaxImageUnderstand(
  imageUrlOrBase64: string,
  opts?: { prompt?: string }
): Promise<MiniMaxImageUnderstandResponse> {
  try {
    const body: Record<string, unknown> = {
      image_url: imageUrlOrBase64,
    };
    if (opts?.prompt) {
      body.prompt = opts.prompt;
    }

    const response = await callMiniMaxAPI<{
      data?: {
        description?: string;
        objects?: string[];
        text?: string;
        scenes?: string[];
      };
    }>("/v1/coding_plan/vlm", body);

    const data = response.data;
    if (!data) {
      return {
        success: false,
        error: "No data returned from image understanding",
      };
    }

    return {
      success: true,
      result: {
        description: data.description || "",
        objects: data.objects,
        text: data.text,
        scenes: data.scenes,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[MiniMax] Image understand failed", { error: message });
    return {
      success: false,
      error: message,
    };
  }
}

// ==================== 健康检查 ====================

/**
 * 检查 MiniMax API 是否可用
 * 使用一个轻量级调用验证 key 有效性，避免产生费用
 */
export async function checkMiniMaxHealth(): Promise<{
  ok: boolean;
  latency: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const config = getMiniMaxConfig();
    // 使用 HEAD 请求检查 API 可用性，避免产生费用
    const url = `${config.baseUrl}/v1/models`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "MM-API-Source": "Minimax-MCP-Health",
      },
    });
    
    if (res.ok || res.status === 404) {
      // 404 表示端点不存在但服务可用
      return { ok: true, latency: Date.now() - start };
    }
    
    const errorText = await res.text();
    return { 
      ok: false, 
      latency: Date.now() - start, 
      error: `HTTP ${res.status}: ${errorText}` 
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, latency: Date.now() - start, error: message };
  }
}

/**
 * 获取 MiniMax 配置信息（脱敏）
 */
export function getMiniMaxInfo(): {
  configured: boolean;
  baseUrl: string;
  hasTokenPlan: boolean;
} {
  try {
    const config = getMiniMaxConfig();
    return {
      configured: true,
      baseUrl: config.baseUrl,
      hasTokenPlan: config.baseUrl.includes("minimax.io"),
    };
  } catch {
    return {
      configured: false,
      baseUrl: "",
      hasTokenPlan: false,
    };
  }
}
