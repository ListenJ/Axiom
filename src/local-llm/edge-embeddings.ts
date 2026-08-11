/**
 * 边缘 embedding 客户端 —— 本地模型向量化（设置语义搜索用）
 *
 * 配置 (env)：
 * - EDGE_EMBED_URL    默认回落 EDGE_LLM_URL → http://192.168.0.150:9001
 * - EDGE_EMBED_MODEL  默认回落 EDGE_LLM_MODEL → BAAI/bge-m3
 * - EDGE_SETTINGS_SEARCH=0  禁用设置语义搜索（强制关键词兜底）
 *
 * 语义搜索走"边缘增强·失败回退"：本模块失败返回 null，由上层回落
 * 模型路由 embedding，再回落关键词。
 */
import { readString } from "../utils/env.js";

const DEFAULT_EMBED_BASE = "http://127.0.0.1:9001";
const DEFAULT_EMBED_MODEL = "BAAI/bge-m3";
const TIMEOUT_MS = 5000;

export function isEdgeEmbeddingsEnabled(): boolean {
  return readString("EDGE_SETTINGS_SEARCH", "1").toLowerCase() !== "0";
}

export function getEdgeEmbedBaseUrl(): string {
  return readString("EDGE_EMBED_URL", readString("EDGE_LLM_URL", DEFAULT_EMBED_BASE));
}

export function getEdgeEmbedModel(): string {
  return readString("EDGE_EMBED_MODEL", readString("EDGE_LLM_MODEL", DEFAULT_EMBED_MODEL));
}

/**
 * 调用本地 embedding 服务（OpenAI 兼容 /v1/embeddings）。
 * 成功返回向量数组；不可用/超时/非 2xx 一律返回 null（不抛错）。
 */
export async function getEdgeEmbeddings(texts: string[]): Promise<number[][] | null> {
  if (!isEdgeEmbeddingsEnabled() || texts.length === 0) return null;

  const base = getEdgeEmbedBaseUrl().replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: getEdgeEmbedModel(), input: texts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    return data.data?.map((d) => d.embedding ?? []) ?? null;
  } catch {
    return null;
  }
}