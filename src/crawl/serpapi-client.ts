/**
 * SerpAPI 专用客户端
 * 支持 Google 搜索完整参数与响应，输出结构化数据供 Vault 持久化
 *
 * 端点: https://serpapi.com/search.json?engine=google
 * 文档: https://serpapi.com/search-api
 */

import { logger } from "../utils/logger.js";

const SERPAPI_BASE = "https://serpapi.com/search.json";

// ========== 请求参数 ==========

export interface SerpApiSearchParams {
  /** 搜索关键词 */
  q: string;
  /** 搜索引擎 */
  engine?: string;
  /** 地理位置 */
  location?: string;
  /** Google 域名 */
  google_domain?: string;
  /** 界面语言 */
  hl?: string;
  /** 国家/地区代码 */
  gl?: string;
  /** 安全搜索 */
  safe?: "active" | "off";
  /** 时间范围 */
  tbs?: string;
  /** 每页结果数 (max 100) */
  num?: number;
  /** 起始偏移 */
  start?: number;
  /** 限定站点 */
  as_sitesearch?: string;
  /** 设备类型 */
  device?: "desktop" | "tablet" | "mobile";
  /** 其他 SerpAPI 原生参数 */
  [key: string]: unknown;
}

// ========== 响应结构（常用字段） ==========

export interface SerpApiOrganicResult {
  position: number;
  title: string;
  link: string;
  displayed_link?: string;
  snippet?: string;
  snippet_highlighted_words?: string[];
  sitelinks?: {
    inline?: Array<{ title: string; link: string }>;
    expanded?: Array<{ title: string; link: string; snippet?: string }>;
  };
  date?: string;
  rich_snippet?: Record<string, unknown>;
  about_this_result?: Record<string, unknown>;
}

export interface SerpApiKnowledgeGraph {
  title?: string;
  type?: string;
  description?: string;
  website?: string;
  image?: string;
  [key: string]: unknown;
}

export interface SerpApiRelatedQuestion {
  question: string;
  snippet?: string;
  title?: string;
  link?: string;
  displayed_link?: string;
}

export interface SerpApiRelatedSearch {
  query: string;
  link: string;
}

export interface SerpApiImageResult {
  position: number;
  thumbnail: string;
  source: string;
  title: string;
  link: string;
  original?: string;
}

export interface SerpApiVideoResult {
  position: number;
  title: string;
  link: string;
  thumbnail: string;
  channel?: string;
  duration?: string;
  date?: string;
}

export interface SerpApiNewsResult {
  position: number;
  title: string;
  link: string;
  source: string;
  date: string;
  snippet?: string;
  thumbnail?: string;
}

export interface SerpApiSearchMetadata {
  id: string;
  status: string;
  json_endpoint: string;
  created_at: string;
  processed_at: string;
  google_url: string;
  raw_html_file: string;
  total_time_taken: number;
}

export interface SerpApiSearchParameters {
  engine: string;
  q: string;
  location?: string;
  google_domain?: string;
  hl?: string;
  gl?: string;
  device?: string;
  [key: string]: unknown;
}

export interface SerpApiSearchInformation {
  organic_results_state?: string;
  query_displayed?: string;
  total_results?: number;
  time_taken_displayed?: number;
}

export interface SerpApiResponse {
  search_metadata: SerpApiSearchMetadata;
  search_parameters: SerpApiSearchParameters;
  search_information?: SerpApiSearchInformation;
  organic_results?: SerpApiOrganicResult[];
  knowledge_graph?: SerpApiKnowledgeGraph;
  related_questions?: SerpApiRelatedQuestion[];
  related_searches?: SerpApiRelatedSearch[];
  images_results?: SerpApiImageResult[];
  videos_results?: SerpApiVideoResult[];
  news_results?: SerpApiNewsResult[];
  ads?: unknown[];
  local_results?: unknown;
  shopping_results?: unknown;
  // 允许其他字段
  [key: string]: unknown;
}

// ========== 客户端 ==========

export class SerpApiClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.SERPAPI_KEY || "";
    this.baseUrl = SERPAPI_BASE;
    if (!this.apiKey) {
      logger.warn("SerpApiClient initialized without API key");
    }
  }

  /**
   * 执行搜索请求
   */
  async search(params: SerpApiSearchParams): Promise<SerpApiResponse> {
    if (!this.apiKey) {
      throw new Error("SERPAPI_KEY is not set. Provide it via constructor or environment variable.");
    }

    const url = new URL(this.baseUrl);
    url.searchParams.set("api_key", this.apiKey);

    // 合并默认引擎
    const merged = { engine: "google", ...params };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    const startTime = performance.now();
    logger.info("[SerpAPI] Request", { q: params.q, location: params.location });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "OpenClaw-Agent/1.0 (Bun)",
        },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`SerpAPI HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = (await res.json()) as SerpApiResponse;
      const latency = Math.round(performance.now() - startTime);

      logger.info("[SerpAPI] Response", {
        query: params.q,
        organic_count: data.organic_results?.length ?? 0,
        latency_ms: latency,
        search_id: data.search_metadata?.id,
      });

      return data;
    } catch (e: unknown) {
      clearTimeout(timer);
      logger.error("[SerpAPI] Request failed", e instanceof Error ? e : new Error(String(e)), { query: params.q });
      throw e;
    }
  }

  /**
   * 批量搜索（串行，带延迟）
   */
  async searchBatch(
    queries: SerpApiSearchParams[],
    opts?: { delayMs?: number }
  ): Promise<SerpApiResponse[]> {
    const results: SerpApiResponse[] = [];
    const delay = opts?.delayMs ?? 1500;

    for (const params of queries) {
      try {
        const res = await this.search(params);
        results.push(res);
      } catch (e: unknown) {
        logger.warn("[SerpAPI] Batch item failed", { q: params.q, error: e instanceof Error ? e.message : String(e) });
      }
      if (results.length < queries.length) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    return results;
  }

  /** 健康检查 */
  async healthCheck(): Promise<{ ok: boolean; latency: number; error?: string }> {
    const start = performance.now();
    try {
      // 使用一个无害的查询测试连通性
      await this.search({ q: "test", num: 1 });
      return { ok: true, latency: Math.round(performance.now() - start) };
    } catch (e: unknown) {
      return { ok: false, latency: Math.round(performance.now() - start), error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export default SerpApiClient;
