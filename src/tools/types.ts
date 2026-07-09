/**
 * 工具层核心类型 v2 — 进度回调 + 用量跟踪 + 循环保护
 */
import { logger } from "../utils/logger.js";

// ─── 进度回调 ──────────────────────────────────────
export type ProgressStage = "validate" | "execute" | "transform" | "complete" | "error" | "timeout" | "loop-detected";

export interface ProgressEvent {
  readonly stage: ProgressStage;
  readonly toolName: string;
  readonly message: string;
  readonly pct?: number;        // 0-100
  readonly elapsedMs: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;

// ─── Token 用量 ────────────────────────────────────
export interface TokenBudget {
  /** 总 Token 预算 */
  maxTokens: number;
  /** 已消耗 Token */
  usedTokens: number;
  /** Token 单价 (模拟) */
  readonly costPerToken: number;
}

// ─── Token 跟踪器 ──────────────────────────────────
const _tokenTracker = {
  calls: 0,
  totalTokens: 0,
};

export function getTokenStats() {
  return { ..._tokenTracker };
}

export function estimateTokens(text: string): number {
  // 粗略估算: 1 token ≈ 4 chars
  return Math.ceil(text.length / 4);
}

export function trackTokenUsage(tokens: number): void {
  _tokenTracker.calls++;
  _tokenTracker.totalTokens += tokens;
}

// ─── 循环检测 ──────────────────────────────────────
const RECENT_CALLS_MAX = 100;
const recentCalls = new Map<string, number[]>(); // toolName → timestamps

export function detectLoop(toolName: string, input: string): boolean {
  const key = `${toolName}:${input.slice(0, 200)}`;
  const now = Date.now();
  const calls = recentCalls.get(key) ?? [];
  // 清除 60s 前的记录
  const recent = calls.filter(t => now - t < 60000);
  recent.push(now);
  recentCalls.set(key, recent);
  // 60s 内同一输入超过 5 次 → 循环
  if (recent.length > 5) {
    logger.warn(`[ToolGuard] Loop detected: ${key} (${recent.length} calls in 60s)`);
    return true;
  }
  return false;
}

export function clearLoopCache(): void {
  recentCalls.clear();
}

// ─── 上下文 (增强) ─────────────────────────────────
export interface ToolContext {
  readonly requestId: string;
  readonly startTime: number;
  readonly maxMemoryBytes: number;
  readonly maxCpuMs: number;
  readonly localStore: Map<string, unknown>;
  readonly tokenBudget: TokenBudget;
  readonly onProgress?: ProgressCallback;
  /** 最大管道深度 (防递归) */
  maxDepth: number;
  /** 当前执行深度 */
  depth: number;
  /** 已终止标志 */
  aborted: boolean;
}

/** 上下文用尽的 Token */
export function consumeTokens(ctx: ToolContext, text: string): boolean {
  const tokens = estimateTokens(text);
  if (ctx.tokenBudget.usedTokens + tokens > ctx.tokenBudget.maxTokens) {
    ctx.aborted = true;
    logger.warn(`[ToolGuard] Token budget exceeded: ${ctx.tokenBudget.usedTokens}/${ctx.tokenBudget.maxTokens}`);
    return false;
  }
  ctx.tokenBudget.usedTokens += tokens;
  trackTokenUsage(tokens);
  return true;
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
  readonly tokensUsed: number;
}

export interface ToolOutput<O = unknown> {
  readonly data: O;
  readonly metrics: ToolMetrics;
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
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
  maxTokens = 100_000,
  onProgress?: ProgressCallback,
): ToolContext {
  return {
    requestId: requestId ?? crypto.randomUUID(),
    startTime: Date.now(),
    maxMemoryBytes,
    maxCpuMs,
    localStore: new Map(),
    tokenBudget: { maxTokens, usedTokens: 0, costPerToken: 0.000002 },
    onProgress,
    maxDepth: 10,
    depth: 0,
    aborted: false,
  };
}

export function createToolOutput<O>(data: O, startTime: number, tokensUsed = 0): ToolOutput<O> {
  return {
    data,
    metrics: {
      durationMs: Date.now() - startTime,
      cpuMs: Date.now() - startTime,
      memoryBytes: process.memoryUsage?.()?.rss ?? 0,
      tokensUsed,
    },
  };
}

/** Emit progress event (no-op if no callback) */
export function emitProgress(
  ctx: ToolContext,
  stage: ProgressStage,
  toolName: string,
  message: string,
  pct?: number,
): void {
  ctx.onProgress?.({
    stage,
    toolName,
    message,
    pct,
    elapsedMs: Date.now() - ctx.startTime,
  });
}
