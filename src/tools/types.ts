/**
 * 工具层核心类型 v3 — 区分 model token vs tool compute
 *
 * 核心原则:
 *   工具执行不消耗 model token。Model token 仅在真正调用 LLM API 时消耗。
 *   工具执行记录的是 compute (CPU/内存/耗时) 而非 token。
 */
import { logger } from "../utils/logger.js";

// ─── 进度回调 ──────────────────────────────────────
export type ProgressStage = "validate" | "execute" | "transform" | "complete" | "error" | "timeout" | "loop-detected"
  | "cache-hit" | "cache-miss" | "model-call";

export interface ProgressEvent {
  readonly stage: ProgressStage;
  readonly toolName: string;
  readonly message: string;
  readonly pct?: number;
  readonly elapsedMs: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;

// ─── Model Token (仅 LLM API 调用时消耗) ─────────
const _modelTokenTracker = { calls: 0, totalTokens: 0 };

export function getModelTokenStats() {
  return { ..._modelTokenTracker };
}

export function trackModelTokens(tokens: number, callCount = 1): void {
  _modelTokenTracker.calls += callCount;
  _modelTokenTracker.totalTokens += tokens;
}

export function estimateModelTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── 缓存命中统计 ──────────────────────────────────
const _cacheStats = { hits: 0, misses: 0, rate: 0 };

export function recordCacheHit(): void { _cacheStats.hits++; updateCacheRate(); }
export function recordCacheMiss(): void { _cacheStats.misses++; updateCacheRate(); }
export function getCacheStats() { return { ..._cacheStats, rate: _cacheStats.rate }; }
function updateCacheRate(): void {
  const total = _cacheStats.hits + _cacheStats.misses;
  _cacheStats.rate = total > 0 ? _cacheStats.hits / total : 0;
}

// ─── 语义缓存 Key ──────────────────────────────────
const stopWords = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "in", "on", "at", "to", "for", "of", "and", "or", "but", "not",
  "what", "which", "who", "whom", "when", "where", "why", "how",
  "this", "that", "these", "those", "it", "its", "i", "me", "my",
  "you", "your", "he", "she", "they", "them", "we", "our",
  "do", "does", "did", "has", "have", "had",
  "can", "will", "would", "could", "should", "may", "might",
]);
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, " ")  // 去标点，保留中文
    .split(/\s+/)
    .filter(w => w.length > 0 && !stopWords.has(w))
    .sort()
    .join(" ");
}

// ─── 循环检测 ──────────────────────────────────────
const recentCalls = new Map<string, number[]>();

export function detectLoop(toolName: string, input: string): boolean {
  const key = `${toolName}:${input.slice(0, 200)}`;
  const now = Date.now();
  const calls = recentCalls.get(key) ?? [];
  const recent = calls.filter(t => now - t < 60000);
  recent.push(now);
  recentCalls.set(key, recent);
  if (recent.length > 5) {
    // Only warn once per cycle — skip if we already warned in this window
    const alreadyWarned = calls.find(t => t === -1);
    if (!alreadyWarned) {
      recentCalls.set(key, [-1]);
      logger.warn(`[ToolGuard] Loop detected: ${key} (${recent.length} calls in 60s)`);
    }
    return true;
  }
  return false;
}

export function clearLoopCache(): void { recentCalls.clear(); }

// ─── 上下文 ────────────────────────────────────────
export interface ToolContext {
  readonly requestId: string;
  readonly startTime: number;
  readonly maxMemoryBytes: number;
  readonly maxCpuMs: number;
  readonly localStore: Map<string, unknown>;
  readonly onProgress?: ProgressCallback;
  maxDepth: number;
  depth: number;
  aborted: boolean;
  /** 缓存层引用（可选注入） */
  cache?: { get(key: string): Promise<unknown>; set(key: string, value: unknown, ttlMs?: number): void };
  /** 此请求是否已触发模型调用 */
  modelCalled: boolean;
}

// ─── 工具接口 ──────────────────────────────────────
export interface ToolInput<I = unknown> {
  readonly payload: I;
  readonly context: ToolContext;
}

export interface ToolMetrics {
  readonly durationMs: number;
  readonly cpuMs: number;
  readonly memoryBytes: number;
  /** 计算开销（非 model token） */
  readonly computeUnits: number;
}

export interface ToolOutput<O = unknown> {
  readonly data: O;
  readonly metrics: ToolMetrics;
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  /** 工具消耗 compute 而非 model token */
  readonly consumesModelToken: boolean; // true if this tool calls LLM
  validate?(input: I): string | null;
  execute(input: ToolInput<I>): Promise<ToolOutput<O>>;
  dispose?(): void | Promise<void>;
}

export type ToolPipeline = {
  readonly pipe: readonly Tool[];
  readonly name: string;
};

// ─── 工厂 ──────────────────────────────────────────
export function createToolContext(
  requestId?: string,
  maxMemoryBytes = 50 * 1024 * 1024,
  maxCpuMs = 10_000,
  onProgress?: ProgressCallback,
): ToolContext {
  return {
    requestId: requestId ?? crypto.randomUUID(),
    startTime: Date.now(),
    maxMemoryBytes,
    maxCpuMs,
    localStore: new Map(),
    onProgress,
    maxDepth: 10,
    depth: 0,
    aborted: false,
    modelCalled: false,
  };
}

export function createToolOutput<O>(data: O, startTime: number, computeUnits = 0): ToolOutput<O> {
  return {
    data,
    metrics: {
      durationMs: Date.now() - startTime,
      cpuMs: Date.now() - startTime,
      memoryBytes: process.memoryUsage?.()?.rss ?? 0,
      computeUnits,
    },
  };
}

export function emitProgress(ctx: ToolContext, stage: ProgressStage, toolName: string, message: string, pct?: number): void {
  ctx.onProgress?.({
    stage, toolName, message, pct, elapsedMs: Date.now() - ctx.startTime,
  });
}
