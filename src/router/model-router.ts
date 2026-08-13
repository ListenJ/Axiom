/**
 * 多平台模型路由器 v5.0 — 扁平化架构
 *
 * 设计原则:
 *   - 单一 OpenAI 兼容 API
 *   - 扁平路由表: intent → role 直接映射，无嵌套 if/else
 *   - 统一执行端口: 所有调用走统一的 execute() 管线
 *   - 静态配置表 + 简单 fallback
 *   - 熔断器: 连续失败阈值打开 + 冷却 (utils/circuit-breaker)
 */

import { logger } from "../utils/logger.js";
import { proxyFetch } from "../utils/proxy-fetch.js";
import { toolPool, type ToolRole } from "./tool-pool.js";
import { assignModel, findModelsForRole, type TaskRole, type AssignmentResult, type ModelCapability } from "./model-capability-registry.js";
import { PROVIDER_CONFIG } from "./models.js";
import { getTokenTracker } from "./token-tracker.js";
import { getEffectiveApiKey, getEffectiveBaseURL } from "../utils/api-key-store.js";
import { TIMEOUTS } from "../constants/timeouts.js";
import { metrics } from "../utils/metrics.js";
import { calculateBackoffDelay } from "../utils/resilience.js";
import { callProvider, callProviderNativeStream, type ChatMessage, type StreamChunkCallback, type NativeStreamResult } from "./provider-caller.js";
import type { ToolCall, ToolCallDef } from "../utils/tool-surface.js";
import { INTENT_ROUTE_TABLE, DEFAULT_ROLE } from "./route-table.js";
import { getModelOutputStore } from "../utils/model-output-store.js";
import { llmCache, llmCacheKey, type CachedLLMResponse } from "../utils/cache.js";
import { routerBreaker } from "../utils/circuit-breaker.js";

// =============================================================================
// 端口定义 (Input / Output Ports)
// =============================================================================

/**
 * 流式事件 — `chatStream` 异步生成器 yield 的事件类型。
 *
 *  - start: 流开始，携带 routing 元数据（model / provider / role / intent）
 *  - token:  增量文本块（来自上游 delta 或整段缓冲内容）
 *  - done:   流结束，携带 usage 与汇总信息
 *  - error:  任意阶段错误（保留 stream 语义，调用方可决定是否中断）
 */
export type ChatStreamEvent =
  | { type: "start"; model: string; provider: string; role: TaskRole; layer?: "decision" | "architecture" | "tool" | "evaluation" | "general"; intent?: string }
  | { type: "token"; content: string }
  | { type: "tool"; name: string; args: string }
  | { type: "done"; content: string; usage?: ChatResponse["usage"]; model: string; provider: string; fallbackUsed: boolean }
  | { type: "error"; message: string };

/** 基础输出 */
export interface ChatResponse {
  content: string | null;
  model: string;
  provider: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  layer?: "decision" | "architecture" | "tool" | "evaluation" | "general";
}

/** 智能任务分配输出 */
export interface SmartAssignmentResponse {
  role: TaskRole;
  model: string;
  provider: string;
  endpoint: string;
  content: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
  };
  latency_ms?: number;
  fallback_used?: boolean;
  /** 模型发起的工具调用（function calling） */
  toolCalls?: ToolCall[];
  /** 任务分层（与 ChatResponse.layer 对齐，便于路由层透传） */
  layer?: "decision" | "architecture" | "tool" | "evaluation" | "general";
}

/** 批量任务输入 */
export interface RoleAssignment {
  role: TaskRole;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

/** 路由决策元数据 */
export interface RoutingMeta {
  role: TaskRole;
  thinking: "none" | "low" | "medium" | "high";
  reason: string;
}

/** 统一执行端口输入 */
export interface ExecuteInput {
  role: TaskRole;
  messages: ChatMessage[];
  timeout?: number;
  temperature?: number;
  maxTokens?: number;
  /** 外部中止信号（透传给 provider 调用） */
  signal?: AbortSignal;
  trackAs?: string;
  /**
   * Models to skip during fallback iteration. Used by `executeWithRole`
   * (single-shot) and `dispatcher.dispatchBatch` (`preventDuplicateModels: true`)
   * to avoid re-trying models that already failed for this call.
   */
  excludeModels?: string[];
  /** OpenAI 兼容 tools 定义（function calling） */
  tools?: ToolCallDef[];
}

/** 统一执行端口输出 */
export interface ExecuteOutput {
  content: string | null;
  model: string;
  provider: string;
  usage?: ChatResponse["usage"];
  latencyMs: number;
  fallbackUsed: boolean;
  routingMeta?: RoutingMeta;
  toolCalls?: ToolCall[];
}

// =============================================================================
// Token 追踪辅助
// =============================================================================

function trackCall(
  model: string,
  provider: string,
  messages: ChatMessage[],
  result: {
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    latencyMs: number;
    success: boolean;
    fallbackUsed?: boolean;
  },
  meta?: { role?: string; taskType?: string }
) {
  const usage = result.usage;
  if (!usage || !usage.total_tokens) return;

  getTokenTracker().record({
    timestamp: Date.now(),
    model,
    provider,
    role: meta?.role,
    taskType: meta?.taskType,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    latencyMs: result.latencyMs,
    contentLength: messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
    success: result.success,
    fallbackUsed: result.fallbackUsed ?? false,
  });
}

const DEFAULT_RETRY_ATTEMPTS = 3;

// =============================================================================
// 路由器 v5.0 — 扁平化核心
// =============================================================================

// ---------------------------------------------------------------------------
// 永久性失败处理（2026-07-26 生产化修复）
// 缺 key / 型号不存在 / 未授权等永久性错误：不重试（此前每个死模型每次请求
// 都白烧 maxRetries 次），并拉黑 5 分钟（避免后续请求重复烧秒）。
// ---------------------------------------------------------------------------
const PERMANENT_FAILURE_RE = /Missing API key|Model does not exist|Model disabled|HTTP 40[134]/i;
const BLACKLIST_TTL_MS = 5 * 60 * 1000;
const modelBlacklist = new Map<string, number>(); // "provider/model" -> 拉黑截止时刻

/** 判定错误是否永久性（不可重试）—— 导出供单元测试 */
export function isPermanentFailure(msg: string): boolean {
  return PERMANENT_FAILURE_RE.test(msg);
}

/** 记录一次永久性失败（拉黑 TTL）—— 导出供单元测试 */
export function recordPermanentFailure(provider: string, model: string): void {
  modelBlacklist.set(`${provider}/${model}`, Date.now() + BLACKLIST_TTL_MS);
}

/** 查询模型是否在黑名单中（过期自动清除）—— 导出供单元测试 */
export function isModelBlacklisted(provider: string, model: string): boolean {
  const until = modelBlacklist.get(`${provider}/${model}`);
  if (until === undefined) return false;
  if (Date.now() > until) {
    modelBlacklist.delete(`${provider}/${model}`);
    return false;
  }
  return true;
}

export class MultiPlatformRouter {
  // ---------------------------------------------------------------------------
  // 统一执行端口 (Unified Execution Port)
  // 所有角色调用最终都走到这里，集中处理 fallback、tracking、timeout
  // ---------------------------------------------------------------------------
  async execute(input: ExecuteInput): Promise<ExecuteOutput> {
    const { role, messages, timeout = TIMEOUTS.API_DEFAULT, temperature, maxTokens, signal, trackAs, tools } = input;
    const startTime = Date.now();

    const allModels = findModelsForRole(role);
    if (allModels.length === 0) {
      logger.warn(`[Router] No models for role: ${role}`);
      return {
        content: `[System] No models configured for role "${role}".`,
        model: "none",
        provider: "local",
        latencyMs: 0,
        fallbackUsed: true,
      };
    }

    // Phase P0-3: filter out models that already failed for this call.
    // executeWithRole passes its `excludeModels` option through; dispatcher
    // accumulates excludeModels as it walks preventDuplicateModels: true.
    const excluded = new Set(input.excludeModels ?? []);
    const candidates = (excluded.size > 0
      ? allModels.filter((m) => !excluded.has(m.id) && !excluded.has(m.model))
      : allModels
    ).filter((m) => !isModelBlacklisted(m.provider, m.model));
    if (candidates.length === 0) {
      logger.warn(`[Router] No candidate models for role ${role} after exclude`, {
        excluded: Array.from(excluded),
      });
      return {
        content: `[System] No available models for role "${role}" after exclusions.`,
        model: "none",
        provider: "local",
        latencyMs: 0,
        fallbackUsed: true,
      };
    }
    // Task-type-based routing: light roles (read/check) prefer free models,
    // heavy roles (code/decision) prefer DeepSeek via priority.
    const LIGHT_ROUTES = new Set<TaskRole>([
      "general-tool", "research", "general-chat", "code-review", "english", "evaluation",
    ]);
    const isLightRoute = LIGHT_ROUTES.has(role);
    const sortedModels = [...candidates].sort((a, b) => {
      // Light roles: free models first (cost saving), then by priority
      if (isLightRoute && a.isFree !== b.isFree) {
        return a.isFree ? -1 : 1;
      }
      // Heavy roles: DeepSeek already has priority 1 in the registry
      return (a.priority ?? 99) - (b.priority ?? 99);
    });

    let lastError: Error | undefined;
    for (const model of sortedModels) {
      const breakerKey = `${model.provider}/${model.model}`;
      if (!routerBreaker.allow(breakerKey)) {
        logger.warn(`[Router] Circuit open, skip ${breakerKey}`);
        continue;
      }
      // Per-model retry: honor the model's own maxRetries, falling back to DEFAULT_RETRY_ATTEMPTS.
      const maxRetries = Math.max(1, model.maxRetries ?? DEFAULT_RETRY_ATTEMPTS);

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const loopStart = Date.now();

        // LLM cache: only for deterministic calls (temperature === 0).
        // Cache hit eliminates the API call entirely — max hit-rate savings.
        if (temperature === 0 && attempt === 0) {
          const cKey = llmCacheKey({
            provider: model.provider,
            model: model.model,
            messages,
            temperature: 0,
          });
          const cached = await llmCache.get(cKey);
          if (cached) {
            routerBreaker.recordSuccess(breakerKey);
            const latencyMs = Date.now() - loopStart;
            metrics.increment("routing_decisions_total", 1, { role, source: "execute-cached", model: model.id });
            logger.info(`[Router] Execute cache HIT role=${role} model=${model.provider}/${model.model} latencyMs=${latencyMs}`);
            trackCall(model.model, model.provider, messages, {
              usage: cached.usage,
              latencyMs,
              success: true,
              fallbackUsed: false,
            }, { role: trackAs ?? role, taskType: trackAs ?? role });
            return {
              content: cached.content,
              model: cached.model,
              provider: cached.provider,
              usage: cached.usage,
              latencyMs,
              fallbackUsed: false,
            };
          }
        }

        try {
          const response = await callProvider(
            model.provider,
            model.model,
            messages,
            model.timeout ?? timeout,
            temperature,
            undefined,
            tools,
            { baseURL: model.baseURL, apiKey: model.apiKey },
            maxTokens,
            signal
          );
          const latencyMs = Date.now() - loopStart;
          trackCall(model.model, model.provider, messages, {
            usage: response.usage,
            latencyMs,
            success: true,
          }, { role: trackAs ?? role, taskType: trackAs ?? role });
          logger.info(`[Router] Execute success role=${role} model=${model.provider}/${model.model} attempts=${attempt + 1} latencyMs=${latencyMs}`);
          routerBreaker.recordSuccess(breakerKey);

          // Record routing decision metric
          metrics.increment("routing_decisions_total", 1, { role, source: "execute", model: model.id });
          metrics.histogram("routing_duration_seconds", (Date.now() - startTime) / 1000, { role, source: "execute" });

          // Persist model output to disk (non-blocking, eliminates context dependency)
          getModelOutputStore().persist({
            provider: model.provider,
            model: model.model,
            prompt: messages[messages.length - 1]?.content ?? "",
            messages,
            temperature,
            latencyMs,
            success: true,
            response: {
              content: response.content,
              usage: response.usage,
            },
          });

          // Cache successful deterministic response for future hits
          if (temperature === 0) {
            const cKey = llmCacheKey({
              provider: model.provider,
              model: model.model,
              messages,
              temperature: 0,
            });
            const cached: CachedLLMResponse = {
              content: response.content,
              model: model.model,
              provider: model.provider,
              usage: response.usage,
            };
            llmCache.set(cKey, cached);
          }

          return {
            content: response.content,
            model: model.model,
            provider: model.provider,
            usage: response.usage,
            latencyMs,
            fallbackUsed: false,
            toolCalls: response.toolCalls,
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const msg = lastError.message;
          routerBreaker.recordFailure(breakerKey);
          logger.warn(
            `[Router] Execute failed ${model.provider}/${model.model} (attempt ${attempt + 1}/${maxRetries})`,
            { error: msg }
          );
          trackCall(model.model, model.provider, messages, {
            latencyMs: Date.now() - loopStart,
            success: false,
          }, { role: trackAs ?? role, taskType: trackAs ?? role });
          // 永久性失败（缺 key/型号不存在/未授权）：拉黑 5 分钟并直接换下一个模型，不再重试
          if (PERMANENT_FAILURE_RE.test(msg)) {
            modelBlacklist.set(`${model.provider}/${model.model}`, Date.now() + BLACKLIST_TTL_MS);
            logger.warn(`[Router] Permanent failure, blacklisted 5min: ${model.provider}/${model.model}`, { error: msg });
            break;
          }
          // Exponential backoff with jitter, capped at 5s
          if (attempt < maxRetries - 1) {
            const delay = calculateBackoffDelay(attempt);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      // Track fallback to next model
      metrics.increment("routing_fallback_total", 1, { role });
      logger.warn(`[Router] Model ${model.provider}/${model.model} exhausted retries`, {
        error: lastError?.message,
      });
    }

    logger.error(`[Router] All models exhausted for role: ${role}`);
    metrics.increment("routing_decisions_total", 1, { role, source: "execute", model: "degraded" });

    // Persist degraded response for observability
    getModelOutputStore().persist({
      provider: "local",
      model: "degraded",
      prompt: messages[messages.length - 1]?.content ?? "",
      messages,
      temperature,
      latencyMs: Date.now() - startTime,
      success: false,
      error: lastError ?? new Error(`All models exhausted for role: ${role}`),
    });

    return {
      content: "I'm currently experiencing high load. Please try again in a moment.",
      model: "degraded",
      provider: "local",
      latencyMs: Date.now() - startTime,
      fallbackUsed: true,
    };
  }

  // ---------------------------------------------------------------------------
  // 高层 API (向后兼容)
  // ---------------------------------------------------------------------------

  async decide(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.execute({ role: "decision", messages, trackAs: "decide" });
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage, layer: "decision" };
  }

  async architect(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.execute({ role: "architecture", messages, trackAs: "architect" });
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage, layer: "architecture" };
  }

  async evaluate(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.execute({ role: "evaluation", messages, trackAs: "evaluate" });
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage, layer: "evaluation" };
  }

  async chat(taskType: TaskRole | string, messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.execute({ role: taskType as TaskRole, messages, trackAs: "chat" });
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage, layer: "general" };
  }

  /**
   * 流式 chat：异步生成器 yield ChatStreamEvent。
   *
   * 两条路径:
   *   1. 原生流式（默认开启）— 通过全局 fetch + ReadableStream 真正按 delta 推送。
   *      proxyFetch 会缓冲整个响应，无法用于真流式；这里使用 runtime 内置的
   *      globalThis.fetch（Bun / Node 18+）实现真正的增量读取。
   *   2. 缓冲回退 — 当原生 fetch 失败、被禁用或不在 runtime 中时，回退到
   *      `callProvider`（buffered）一次性拿到完整回复，再作为单个 token 事件发出，
   *      实现 SSE 协议兼容的“模拟流式”。
   *
   *  任何路径都会保证: start → (token* | error) → done  的事件序列。
   */
  async *chatStream(
    taskType: TaskRole | string,
    messages: ChatMessage[],
    options?: {
      preferNativeStream?: boolean;
      intent?: string;
      reasoningEffort?: string;
      tools?: ToolCallDef[];
      executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      maxToolIterations?: number;
    }
  ): AsyncGenerator<ChatStreamEvent> {
    const role = taskType as TaskRole;
    const preferNative = options?.preferNativeStream !== false;
    const intentLabel = options?.intent;
    const reasoningEffort = options?.reasoningEffort;
    const models = findModelsForRole(role);
    if (models.length === 0) {
      logger.warn(`[Router/chatStream] No models for role: ${role}`);
      yield { type: "error", message: `No models configured for role "${role}".` };
      return;
    }

    const sortedModels = [...models].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

    // 流式工具循环：tools + executeTool 存在时，模型可发起 tool_calls，
    // 服务端执行后追加 assistant(tool_calls)+tool 消息并继续下一轮（有界）。
    const tools = options?.tools;
    const executeTool = options?.executeTool;
    const maxToolIterations = options?.maxToolIterations ?? (tools?.length ? 4 : 1);
    const working: ChatMessage[] = [...messages];
    let toolRounds = 0;

    // 流事件先一次性给出 routing metadata，让前端可在首字节前就显示 provider 信息
    const firstModel = sortedModels[0]!;
    yield {
      type: "start",
      model: firstModel.id,
      provider: firstModel.provider,
      role,
      layer: "general",
      ...(intentLabel ? { intent: intentLabel } : {}),
    };

    const startTime = Date.now();
    let lastError: Error | undefined;

    toolLoop: while (toolRounds < maxToolIterations) {
    for (const model of sortedModels) {
      const breakerKey = `${model.provider}/${model.model}`;
      if (!routerBreaker.allow(breakerKey)) {
        logger.warn(`[Router/chatStream] Circuit open, skip ${breakerKey}`);
        continue;
      }
      const maxRetries = Math.max(1, model.maxRetries ?? DEFAULT_RETRY_ATTEMPTS);

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const loopStart = Date.now();
        // 缓冲路径：复用 callProvider 拿到完整文本，整段作为一个 token 推送
        const fallbackBufferedStream = async (): Promise<NativeStreamResult> => {
          const response = await callProvider(
            model.provider,
            model.model,
            working,
            model.timeout ?? TIMEOUTS.API_DEFAULT,
            0.7,
            reasoningEffort,
            tools,
            { baseURL: model.baseURL, apiKey: model.apiKey },
          );
          const text = response.content ?? "";
          // 缓冲路径：返回完整文本，由调用方决定如何分片成 SSE token
          return { content: text, usage: response.usage, toolCalls: response.toolCalls };
        };

        try {
          // 路径选择：
          //   preferNative=true  → 先尝试原生 fetch 流式；失败时回退到缓冲
          //   preferNative=false → 直接走缓冲路径
          let nativeOk = false;

          if (preferNative) {
            // 异步队列：在 onChunk 回调里把每个 delta 推入队列，
            // 异步生成器在 while 循环里立即读出并 yield —— 实现真正的 token 级增量。
            // 这避免了在 callback 中直接 yield 造成的生成器状态错乱。
            type StreamItem =
              | { kind: "chunk"; content: string }
              | { kind: "done"; result: NativeStreamResult }
              | { kind: "error"; error: Error };

            const queue: StreamItem[] = [];
            let pending: (() => void) | null = null;
            let streamClosed = false;

            const enqueue = (item: StreamItem): void => {
              queue.push(item);
              if (pending) {
                const wake = pending;
                pending = null;
                wake();
              }
            };

            const waitForNext = (): Promise<void> => {
              if (queue.length > 0 || streamClosed) return Promise.resolve();
              return new Promise<void>((resolve) => {
                pending = resolve;
              });
            };

            // 后台启动原生流式调用；onChunk 把每个 delta 推进队列。
            const streamPromise = callProviderNativeStream(
              model.provider,
              model.model,
              working,
              model.timeout ?? TIMEOUTS.API_STREAMING,
              0.7,
              (delta) => {
                enqueue({ kind: "chunk", content: delta });
              },
              undefined,
              reasoningEffort,
              tools,
              { baseURL: model.baseURL, apiKey: model.apiKey },
            ).then(
              (result) => enqueue({ kind: "done", result }),
              (err: unknown) =>
                enqueue({
                  kind: "error",
                  error: err instanceof Error ? err : new Error(String(err)),
                }),
            ).finally(() => {
              streamClosed = true;
              if (pending) {
                const wake = pending;
                pending = null;
                wake();
              }
            });
            // 链式 .then().finally() 始终 resolve（错误已转入队列），无未处理拒绝；
            // 保留引用以防调用方注册额外的 .then 处理器。
            void streamPromise;

            let nativeResult: NativeStreamResult | null = null;
            try {
              while (true) {
                await waitForNext();
                if (queue.length === 0) break;
                const item = queue.shift();
                if (!item) continue;
                if (item.kind === "chunk") {
                  yield { type: "token", content: item.content };
                } else if (item.kind === "done") {
                  nativeResult = item.result;
                  break;
                } else {
                  // item.kind === "error"
                  throw item.error;
                }
              }
            } catch (nativeErr) {
              // 原生流式失败（无 fetch / proxy 不支持 / 网络错误）— 静默回退到缓冲
              logger.debug(`[Router/chatStream] native stream failed for ${model.provider}/${model.model}, falling back to buffered`, {
                error: nativeErr instanceof Error ? nativeErr.message : String(nativeErr),
              });
            }

            if (nativeResult?.toolCalls?.length && executeTool) {
              working.push({ role: "assistant", content: nativeResult.content ?? "", tool_calls: nativeResult.toolCalls });
              for (const call of nativeResult.toolCalls) {
                yield { type: "tool", name: call.function.name, args: call.function.arguments.slice(0, 200) };
                let output: unknown;
                try {
                  output = await executeTool(call.function.name, parseToolArgs(call.function.arguments));
                } catch (err) {
                  output = { error: err instanceof Error ? err.message : String(err) };
                }
                working.push({ role: "tool", tool_call_id: call.id, content: typeof output === "string" ? output : JSON.stringify(output) });
              }
              toolRounds++;
              continue toolLoop;
            }

            if (nativeResult) {
              const latencyMs = Date.now() - loopStart;
              trackCall(model.model, model.provider, messages, {
                usage: nativeResult.usage,
                latencyMs,
                success: true,
                fallbackUsed: false,
              }, { role, taskType: "chat-stream" });
              metrics.increment("routing_decisions_total", 1, { role, source: "chatStream", model: model.id });
              metrics.histogram("routing_duration_seconds", (Date.now() - startTime) / 1000, { role, source: "chatStream" });
              logger.info(`[Router/chatStream] native stream success role=${role} model=${model.provider}/${model.model} latencyMs=${latencyMs} bytes=${nativeResult.content.length}`);
              routerBreaker.recordSuccess(breakerKey);

              yield {
                type: "done",
                content: nativeResult.content,
                usage: nativeResult.usage,
                model: model.id,
                provider: model.provider,
                fallbackUsed: false,
              };
              nativeOk = true;
            }
          }

          if (!nativeOk) {
            // 缓冲路径：整段内容作为单个 token 事件推送（模拟流式）
            const result = await fallbackBufferedStream();

            if (result.toolCalls?.length && executeTool) {
              working.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
              for (const call of result.toolCalls) {
                yield { type: "tool", name: call.function.name, args: call.function.arguments.slice(0, 200) };
                let output: unknown;
                try {
                  output = await executeTool(call.function.name, parseToolArgs(call.function.arguments));
                } catch (err) {
                  output = { error: err instanceof Error ? err.message : String(err) };
                }
                working.push({ role: "tool", tool_call_id: call.id, content: typeof output === "string" ? output : JSON.stringify(output) });
              }
              toolRounds++;
              continue toolLoop;
            }

            const latencyMs = Date.now() - loopStart;
            trackCall(model.model, model.provider, messages, {
              usage: result.usage,
              latencyMs,
              success: true,
              fallbackUsed: !preferNative,
            }, { role, taskType: "chat-stream" });
            metrics.increment("routing_decisions_total", 1, { role, source: "chatStream-buffered", model: model.id });
            logger.info(`[Router/chatStream] buffered success role=${role} model=${model.provider}/${model.model} latencyMs=${latencyMs} bytes=${result.content.length}`);
            routerBreaker.recordSuccess(breakerKey);

            if (result.content.length > 0) {
              yield { type: "token", content: result.content };
            }
            yield {
              type: "done",
              content: result.content,
              usage: result.usage,
              model: model.id,
              provider: model.provider,
              fallbackUsed: !preferNative,
            };
          }

          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const msg = lastError.message;
          routerBreaker.recordFailure(breakerKey);
          logger.warn(
            `[Router/chatStream] ${model.provider}/${model.model} failed (attempt ${attempt + 1}/${maxRetries})`,
            { error: msg },
          );
          trackCall(model.model, model.provider, messages, {
            latencyMs: Date.now() - loopStart,
            success: false,
          }, { role, taskType: "chat-stream" });
          if (attempt < maxRetries - 1) {
            const delay = calculateBackoffDelay(attempt);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      // 进入下一个 model 前计数一次 fallback
      metrics.increment("routing_fallback_total", 1, { role });
      logger.warn(`[Router/chatStream] Model ${model.provider}/${model.model} exhausted retries`, {
        error: lastError?.message,
      });
    }

      // 当前 tool round 内所有 model 都失败
      logger.error(`[Router/chatStream] All models exhausted for role: ${role}`);
      metrics.increment("routing_decisions_total", 1, { role, source: "chatStream", model: "degraded" });
      yield {
        type: "error",
        message: lastError?.message ?? `All models for role "${role}" are unavailable.`,
      };
      return;
    } // toolLoop

    yield {
      type: "error",
      message: "[Tool loop] exceeded max tool iterations without a final answer.",
    };
  }

  // ---------------------------------------------------------------------------
  // Tool Pool (独立端口，保持与之前相同的重试逻辑)
  // ---------------------------------------------------------------------------

  async tool(role: ToolRole, messages: ChatMessage[]): Promise<ChatResponse> {
    const maxAttempts = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const model = toolPool.selectNext(role);
      if (!model) break;

      toolPool.markRequestStart(model.id);
      const startTime = Date.now();

      try {
        const response = await callProvider(model.provider, model.id, messages, TIMEOUTS.API_DEFAULT);
        const latencyMs = Date.now() - startTime;
        toolPool.recordLatency(model.id, latencyMs);
        toolPool.markRequestSuccess(model.id);
        const result: ChatResponse = { ...response, model: model.id, provider: model.provider, layer: "tool" };
        trackCall(model.id, model.provider, messages, { usage: response.usage, latencyMs, success: true }, { role, taskType: "tool" });
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        toolPool.markRequestFailure(model.id, msg);
        lastError = error instanceof Error ? error : new Error(String(error));
        trackCall(model.id, model.provider, messages, { latencyMs: Date.now() - startTime, success: false }, { role, taskType: "tool" });
        logger.warn(`[Router] Tool ${model.id} failed (attempt ${attempt + 1})`, { error: msg });
        await this.delay(calculateBackoffDelay(attempt, { baseDelay: 1000 }));
      }
    }

    logger.error(`[Router] All tool models exhausted for role: ${role}`);
    return {
      content: `Tool execution failed for ${role}. Please retry or check model availability.`,
      model: "degraded",
      provider: "local",
      layer: "tool",
    };
  }

  // ---------------------------------------------------------------------------
  // 扁平化意图路由
  // ---------------------------------------------------------------------------

  async routeByIntent(intent: string, messages: ChatMessage[], options?: { preferTool?: boolean }): Promise<ChatResponse> {
    const route = INTENT_ROUTE_TABLE[intent];

    if (route) {
      if (route.useTool && options?.preferTool !== false) {
        return this.tool(route.role as ToolRole, messages);
      }
      return this.chat(route.role, messages);
    }

    // 未匹配到任何意图，走默认
    return this.chat(DEFAULT_ROLE, messages);
  }

  // ---------------------------------------------------------------------------
  // Auto Route — 使用廉价模型做 per-turn 路由决策
  // ---------------------------------------------------------------------------

  async autoRoute(messages: ChatMessage[]): Promise<ChatResponse & { routing?: RoutingMeta }> {
    const startTime = Date.now();

    const routingModel = assignModel("decision");
    if (!routingModel) {
      logger.warn("[AutoRoute] No decision model configured, falling back to general-chat");
      const fallback = await this.chat("general-chat", messages);
      return { ...fallback, routing: { role: "general-chat", thinking: "none", reason: "无决策模型配置" } };
    }

    const routingMessages: ChatMessage[] = [
      {
        role: "system",
        content: `你是一个任务路由专家。分析用户请求，输出 JSON 格式的路由决策。

可用角色:
- coding: 代码生成、重构、调试
- review: 代码审查、质量评估
- research: 技术研究、知识查询
- architecture: 架构设计、系统规划
- decision: 决策分析、方案比较
- general-chat: 一般对话、解释说明

思考强度:
- none: 简单任务，直接回答
- low: 标准思考，平衡速度和质量
- medium: 复杂任务，需要多步推理
- high: 非常困难的任务，深度分析

输出格式:
{
  "role": "角色名称",
  "thinking": "none/low/medium/high",
  "reason": "简要说明选择理由"
}`,
      },
      messages[messages.length - 1],
    ];

    try {
      const model = routingModel.model;
      const flashResponse = await callProvider(model.provider, model.model, routingMessages, 10000);
      const routing = this.parseRoutingDecision(flashResponse.content);

      logger.info("[AutoRoute] Routing decision", {
        role: routing.role,
        thinking: routing.thinking,
        reason: routing.reason,
        model: model.id,
      });

      trackCall(model.id, model.provider, routingMessages, { latencyMs: Date.now() - startTime, success: true }, { role: "decision", taskType: "auto_route" });

      const result = await this.executeWithRole(routing.role, messages);

      return {
        content: result.content,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        layer: "general",
        routing: {
          role: routing.role,
          thinking: routing.thinking,
          reason: routing.reason,
        },
      };
    } catch (error) {
      logger.warn("[AutoRoute] Routing failed, falling back to general-chat", { error: (error as Error).message });
      const fallback = await this.chat("general-chat", messages);
      return { ...fallback, routing: { role: "general-chat", thinking: "none", reason: "路由失败，使用默认回退" } };
    }
  }

  parseRoutingDecision(content: string | null): RoutingMeta {
    const defaultResult: RoutingMeta = { role: "general-chat", thinking: "none", reason: "解析失败，使用默认值" };
    if (!content) {
      logger.warn("[AutoRoute] Empty content from decision model, using default route");
      return defaultResult;
    }

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            role: (parsed.role as TaskRole) || defaultResult.role,
            thinking: parsed.thinking || defaultResult.thinking,
            reason: parsed.reason || defaultResult.reason,
          };
        } catch (jsonErr) {
          logger.warn("[AutoRoute] JSON.parse failed on extracted block", {
            snippet: jsonMatch[0].slice(0, 200),
            error: (jsonErr as Error).message,
          });
        }
      } else {
        logger.warn("[AutoRoute] No JSON block found in decision model output", {
          snippet: content.slice(0, 200),
        });
      }
    } catch {
      const lower = content.toLowerCase();
      if (lower.includes("code") || lower.includes("编码") || lower.includes("代码")) return { role: "coding", thinking: "medium", reason: "关键词匹配: code" };
      if (lower.includes("review") || lower.includes("审查")) return { role: "review", thinking: "medium", reason: "关键词匹配: review" };
      if (lower.includes("arch") || lower.includes("架构")) return { role: "architecture", thinking: "high", reason: "关键词匹配: architecture" };
      if (lower.includes("research") || lower.includes("调研")) return { role: "research", thinking: "high", reason: "关键词匹配: research" };
    }

    return defaultResult;
  }

  // ---------------------------------------------------------------------------
  // Embeddings
  // ---------------------------------------------------------------------------

  async embeddings(texts: string[]): Promise<number[][]> {
    const models = findModelsForRole("embedding");
    if (models.length === 0) throw new Error("No embedding route configured");
    const model = models[0];

    const config = PROVIDER_CONFIG[model.provider as keyof typeof PROVIDER_CONFIG];
    const apiKey = getEffectiveApiKey(model.provider, config.apiKeyEnv);
    if (!apiKey) throw new Error(`Missing API key for embedding`);

    const baseURL = getEffectiveBaseURL(model.provider, config.apiKeyEnv, config.baseURL);

    const res = await proxyFetch(`${baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: model.model, input: texts }),
    });

    if (!res.ok) throw new Error(`Embedding request failed: ${res.status}`);
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    return data.data?.map((d) => d.embedding ?? []) ?? [];
  }

  // ---------------------------------------------------------------------------
  // 智能任务分配
  // ---------------------------------------------------------------------------

  assign(role: TaskRole, opts?: { excludeModels?: string[] }): AssignmentResult {
    const result = assignModel(role, { excludeModels: opts?.excludeModels });
    if (!result) throw new Error(`No model found for role: ${role}`);
    return result;
  }

  /**
   * Phase P0-3: executeWithRole now delegates to the unified `execute()`
   * port. Both `chat()` and `executeWithRole()` therefore go through the
   * same fallback chain, the same per-model retry+backoff, and the same
   * `excludeModels` skip — no more double-attempting a model that already
   * failed for the same call.
   *
   * Backward compat: the return shape (SmartAssignmentResponse) is
   * unchanged. The `model.id` field now uses the executed model (after
   * fallback), which matches what `chat()` and `chatStream()` already
   * returned.
   */
  async executeWithRole(role: TaskRole, messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number; excludeModels?: string[]; tools?: ToolCallDef[]; timeout?: number; signal?: AbortSignal; trackAs?: string }): Promise<SmartAssignmentResponse> {
    const out = await this.execute({
      role,
      messages,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      trackAs: options?.trackAs ?? role,
      ...(options?.excludeModels && options.excludeModels.length > 0
        ? { excludeModels: options.excludeModels }
        : {}),
      ...(options?.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    });
    let endpoint = "";
    try {
      const assignment = this.assign(role, { excludeModels: options?.excludeModels });
      const config = PROVIDER_CONFIG[assignment.model.provider as keyof typeof PROVIDER_CONFIG];
      endpoint = config?.baseURL ?? "";
    } catch {
      // 无可用模型时降级（endpoint 留空），不抛错——与 execute 的降级语义一致
    }
    return {
      role,
      model: out.model,
      provider: out.provider,
      endpoint,
      content: out.content,
      usage: out.usage,
      latency_ms: out.latencyMs,
      fallback_used: out.fallbackUsed,
      toolCalls: out.toolCalls,
    };
  }

  async batchExecute(assignments: RoleAssignment[], opts?: { preventDuplicateModels?: boolean }): Promise<SmartAssignmentResponse[]> {
    const usedModels: string[] = [];
    const promises = assignments.map((a) => {
      const exclude = opts?.preventDuplicateModels ? [...usedModels] : undefined;
      return this.executeWithRole(a.role, a.messages, {
        temperature: a.temperature,
        maxTokens: a.maxTokens,
        excludeModels: exclude,
      }).then((res) => {
        if (opts?.preventDuplicateModels) usedModels.push(res.model);
        return res;
      }).catch((err) => ({
        role: a.role,
        model: "error",
        provider: "error",
        endpoint: "",
        content: `Error: ${err.message}`,
        latency_ms: 0,
        fallback_used: true,
      }));
    });
    return Promise.all(promises);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** 解析模型返回的工具调用参数（非法 JSON 降级为空对象） */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const router = new MultiPlatformRouter();
export { toolPool, type ToolRole };
export type { TaskRole } from "./model-capability-registry.js";
export type { ChatMessage, StreamChunkCallback } from "./provider-caller.js";
