/**
 * 读取优化门面 (ReadOptimizerFacade)
 *
 * 核心读取优化管道 — 所有外部数据获取的必经之路
 *
 * 设计哲学:
 *   - 读取优先: 将所有外部数据获取视为"读操作"
 *   - 拦截器链: Cache → BatchCollector → FieldProjection → RateLimit → Fallback
 *   - 请求去重: 相同资源请求合并
 *   - 列裁剪: 只返回请求字段，降低 Token 消耗
 *   - 无向量: 不使用向量相似度，只用精确匹配和图谱查询
 *
 * 拦截器链 (基于配置驱动):
 *   1. CacheInterceptor      — 分层缓存 (黑板 → 本地内存 → SQLite)
 *   2. BatchCollector        — 时间窗口内合并 IN 查询/批量 API
 *   3. FieldProjection       — 列裁剪，剔除未请求字段
 *   4. RateLimitInterceptor  — 令牌桶限流
 *   5. FallbackInterceptor   — 降级/兜底策略
 *
 * 使用示例:
 *   const facade = new ReadOptimizerFacade();
 *   const result = await facade.read({
 *     resource: "codegraph",
 *     action: "searchSymbols",
 *     params: { query: "UserService" },
 *     fields: ["name", "filePath", "startLine"],
 *     agentId: "opencode-agent",
 *   });
 */

import { logger } from "./logger.js";
import { Cache } from "./cache.js";
import { getGlobalBlackboard, type ReadOptions, type ReadResult } from "../memory/blackboard.js";

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ReadRequest {
  resource: string;           // 资源类型: codegraph, vault, db, api, fs
  action: string;             // 操作: search, get, list, query
  params: Record<string, unknown>;
  fields?: string[];          // 字段投影 (列裁剪)
  limit?: number;             // 结果限制
  agentId: string;            // 请求者身份
  priority?: number;          // 优先级 (1-10)
  cacheTtlMs?: number;        // 缓存 TTL
  skipCache?: boolean;        // 跳过缓存
}

export interface ReadResponse {
  data: unknown;
  source: "blackboard" | "cache" | "batch" | "direct" | "fallback";
  latencyMs: number;
  fieldsProjected: boolean;
  batched: boolean;
  cached: boolean;
}

export interface InterceptorContext {
  request: ReadRequest;
  response?: ReadResponse;
  metadata: Record<string, unknown>;
  cancelled: boolean;
}

export interface Interceptor {
  name: string;
  priority: number;           // 执行顺序 (小 -> 大)
  beforeRead?(ctx: InterceptorContext): Promise<void> | void;
  afterRead?(ctx: InterceptorContext): Promise<void> | void;
}

export interface BatchWindow {
  maxWaitMs: number;          // 最大等待时间
  maxBatchSize: number;       // 最大批量大小
}

// ═══════════════════════════════════════════════════════════════
// 读取优化门面
// ═══════════════════════════════════════════════════════════════

export class ReadOptimizerFacade {
  private interceptors: Interceptor[] = [];
  private cache: Cache<unknown>;
  private rateLimiters = new Map<string, TokenBucket>();
  private batchQueues = new Map<string, BatchQueue>();
  private stats = {
    totalReads: 0,
    blackboardHits: 0,
    cacheHits: 0,
    batchHits: 0,
    fallbackHits: 0,
    fieldProjections: 0,
    rateLimitDrops: 0,
    totalLatency: 0,
  };

  constructor(options?: { cacheMaxSize?: number; defaultTtlMs?: number; redis?: boolean }) {
    this.cache = new Cache<unknown>({
      namespace: "read_optimizer",
      maxSize: options?.cacheMaxSize ?? 500,
      defaultTtlMs: options?.defaultTtlMs ?? 5 * 60 * 1000,
      redis: options?.redis ?? true,
    });

    // 注册默认拦截器
    this.registerDefaultInterceptors();
  }

  // ---------------------------------------------------------------------------
  // 核心读取入口
  // ---------------------------------------------------------------------------

  /**
   * 统一读取入口
   *
   * 流程:
   *   1. 拦截器 beforeRead
   *   2. 黑板查询 (Blackboard-First)
   *   3. 缓存查询
   *   4. 批量收集
   *   5. 实际读取
   *   6. 字段投影
   *   7. 拦截器 afterRead
   */
  async read(request: ReadRequest): Promise<ReadResponse> {
    const startTime = Date.now();
    this.stats.totalReads++;

    const ctx: InterceptorContext = {
      request,
      metadata: {},
      cancelled: false,
    };

    try {
      // Step 1: 拦截器 beforeRead
      for (const interceptor of this.sortedInterceptors()) {
        if (ctx.cancelled) break;
        if (interceptor.beforeRead) {
          await interceptor.beforeRead(ctx);
        }
      }

      if (ctx.cancelled) {
        const errorMsg = ctx.metadata["error"] as string | undefined;
        if (errorMsg) {
          return {
            data: { error: errorMsg, constraint: "hard_limit" },
            source: "fallback",
            latencyMs: Date.now() - startTime,
            fieldsProjected: false,
            batched: false,
            cached: false,
          };
        }
        return this.buildEmptyResponse(startTime);
      }

      // Step 2: 黑板优先 (Blackboard-First)
      const bbResult = this.readFromBlackboard(request);
      if (bbResult.hit) {
        this.stats.blackboardHits++;
        ctx.response = {
          data: bbResult.projected ?? bbResult.entry?.value,
          source: "blackboard",
          latencyMs: Date.now() - startTime,
          fieldsProjected: !!request.fields,
          batched: false,
          cached: true,
        };
        return ctx.response;
      }

      // Step 3: 缓存查询 (L1 → L2 → L3)
      if (!request.skipCache) {
        const cacheKey = this.buildCacheKey(request);
        const cached = await this.cache.get(cacheKey);
        if (cached !== undefined) {
          this.stats.cacheHits++;
          ctx.response = {
            data: cached,
            source: "cache",
            latencyMs: Date.now() - startTime,
            fieldsProjected: false,
            batched: false,
            cached: true,
          };
          return ctx.response;
        }
      }

      // Step 4: 批量收集
      const batched = await this.tryBatch(request);
      if (batched !== undefined) {
        this.stats.batchHits++;
        ctx.response = {
          data: batched,
          source: "batch",
          latencyMs: Date.now() - startTime,
          fieldsProjected: false,
          batched: true,
          cached: false,
        };
        return ctx.response;
      }

      // Step 5: 实际读取 (由调用方提供的 executor 执行)
      // 这里 facade 本身不执行读取，而是通过 executor 委托
      // 如果没有注册 executor，返回降级响应
      const executor = this.executors.get(request.resource);
      let data: unknown;

      if (executor) {
        data = await executor(request);
      } else {
        data = await this.fallbackRead(request);
      }

      // Step 6: 字段投影 (列裁剪)
      let projected = data;
      if (request.fields && request.fields.length > 0) {
        projected = this.projectFields(data, request.fields);
        this.stats.fieldProjections++;
      }

      // 写入缓存
      if (!request.skipCache) {
        const cacheKey = this.buildCacheKey(request);
        this.cache.set(cacheKey, projected, request.cacheTtlMs);
      }

      ctx.response = {
        data: projected,
        source: "direct",
        latencyMs: Date.now() - startTime,
        fieldsProjected: !!request.fields,
        batched: false,
        cached: false,
      };

      // Step 7: 拦截器 afterRead
      for (const interceptor of this.sortedInterceptors()) {
        if (interceptor.afterRead) {
          await interceptor.afterRead(ctx);
        }
      }

      this.stats.totalLatency += ctx.response.latencyMs;
      return ctx.response;
    } catch (error) {
      logger.error("[ReadOptimizer] Read failed", error as Error, { request });

      // 降级策略
      const fallback = await this.fallbackRead(request);
      this.stats.fallbackHits++;

      return {
        data: fallback,
        source: "fallback",
        latencyMs: Date.now() - startTime,
        fieldsProjected: false,
        batched: false,
        cached: false,
      };
    }
  }

  /**
   * 批量读取 — 自动合并和去重
   */
  async readBatch(requests: ReadRequest[]): Promise<ReadResponse[]> {
    // 去重: 相同 resource + action + params 只读一次
    const uniqueMap = new Map<string, ReadRequest>();
    const indices: number[] = [];

    for (let i = 0; i < requests.length; i++) {
      const key = this.buildCacheKey(requests[i]);
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, requests[i]);
      }
      indices.push(Array.from(uniqueMap.keys()).indexOf(key));
    }

    // 并行执行唯一请求
    const uniqueResults = await Promise.all(
      Array.from(uniqueMap.values()).map((req) => this.read(req))
    );

    // 映射回原始顺序
    return indices.map((idx) => uniqueResults[idx]);
  }

  // ---------------------------------------------------------------------------
  // 拦截器管理
  // ---------------------------------------------------------------------------

  registerInterceptor(interceptor: Interceptor): void {
    this.interceptors.push(interceptor);
    this.interceptors.sort((a, b) => a.priority - b.priority);
    logger.info("[ReadOptimizer] Registered interceptor", { name: interceptor.name, priority: interceptor.priority });
  }

  removeInterceptor(name: string): void {
    this.interceptors = this.interceptors.filter((i) => i.name !== name);
  }

  private sortedInterceptors(): Interceptor[] {
    return [...this.interceptors].sort((a, b) => a.priority - b.priority);
  }

  // ---------------------------------------------------------------------------
  // 执行器注册
  // ---------------------------------------------------------------------------

  private executors = new Map<string, (req: ReadRequest) => Promise<unknown>>();

  registerExecutor(resource: string, executor: (req: ReadRequest) => Promise<unknown>): void {
    this.executors.set(resource, executor);
  }

  // ---------------------------------------------------------------------------
  // 统计与监控
  // ---------------------------------------------------------------------------

  getStats(): Record<string, unknown> {
    return {
      ...this.stats,
      avgLatency: this.stats.totalReads > 0 ? Math.round(this.stats.totalLatency / this.stats.totalReads) : 0,
      blackboardHitRate: this.stats.totalReads > 0
        ? Math.round((this.stats.blackboardHits / this.stats.totalReads) * 1000) / 10
        : 0,
      cacheHitRate: this.stats.totalReads > 0
        ? Math.round((this.stats.cacheHits / this.stats.totalReads) * 1000) / 10
        : 0,
      interceptors: this.interceptors.map((i) => i.name),
    };
  }

  // ---------------------------------------------------------------------------
  // 私有方法 — 拦截器实现
  // ---------------------------------------------------------------------------

  private registerDefaultInterceptors(): void {
    // 1. 硬约束拦截器 — 防止危险查询 (priority: 5)
    this.registerInterceptor({
      name: "HardConstraintsInterceptor",
      priority: 5,
      beforeRead: (ctx) => {
        const { params, resource, action } = ctx.request;
        const query = String(params.sql || params.query || params.cypher || "");

        if (!query) return;

        // Block SELECT * / RETURN *
        if (/^\s*SELECT\s+\*\s*/i.test(query)) {
          ctx.cancelled = true;
          ctx.metadata["error"] = "SELECT * is blocked for performance reasons. Specify columns explicitly.";
          logger.warn("[ReadOptimizer] Blocked SELECT * query", { resource, action });
          return;
        }
        if (/^\s*RETURN\s+\*\s*/i.test(query)) {
          ctx.cancelled = true;
          ctx.metadata["error"] = "RETURN * is blocked for performance reasons. Specify fields explicitly.";
          logger.warn("[ReadOptimizer] Blocked RETURN * query", { resource, action });
          return;
        }

        // Auto-append LIMIT 50 if missing
        if (/^\s*SELECT/i.test(query) && !/\bLIMIT\s+\d+/i.test(query)) {
          const modified = query.trim() + " LIMIT 50";
          if (params.sql) ctx.request.params.sql = modified;
          if (params.query) ctx.request.params.query = modified;
          if (params.cypher) ctx.request.params.cypher = modified;
          logger.debug("[ReadOptimizer] Auto-appended LIMIT 50", { resource, action });
        }
        if (/^\s*MATCH/i.test(query) && !/\bLIMIT\s+\d+/i.test(query)) {
          const modified = query.trim() + " LIMIT 50";
          if (params.cypher) ctx.request.params.cypher = modified;
          logger.debug("[ReadOptimizer] Auto-appended LIMIT 50 to Cypher", { resource, action });
        }
      },
    });

    // 2. 限流拦截器 (priority: 10)
    this.registerInterceptor({
      name: "RateLimitInterceptor",
      priority: 10,
      beforeRead: (ctx) => {
        const { agentId, resource } = ctx.request;
        const key = `${agentId}:${resource}`;

        if (!this.rateLimiters.has(key)) {
          this.rateLimiters.set(key, new TokenBucket(60, 10)); // 60/min, burst 10
        }

        const bucket = this.rateLimiters.get(key)!;
        if (!bucket.consume()) {
          this.stats.rateLimitDrops++;
          ctx.cancelled = true;
          logger.warn("[ReadOptimizer] Rate limit exceeded", { agentId, resource });
        }
      },
    });

    // 3. 字段投影拦截器 — 标记 projection 需求 (priority: 30)
    this.registerInterceptor({
      name: "FieldProjectionInterceptor",
      priority: 30,
      beforeRead: (ctx) => {
        if (ctx.request.fields && ctx.request.fields.length > 0) {
          ctx.metadata["fieldsRequested"] = ctx.request.fields;
        }
      },
      afterRead: (ctx) => {
        if (ctx.metadata["fieldsRequested"] && ctx.response) {
          ctx.response.fieldsProjected = true;
        }
      },
    });

    // 4. 降级拦截器 (priority: 50)
    this.registerInterceptor({
      name: "FallbackInterceptor",
      priority: 50,
      afterRead: (ctx) => {
        if (!ctx.response || ctx.response.source === "fallback") {
          logger.info("[ReadOptimizer] Fallback triggered", {
            resource: ctx.request.resource,
            action: ctx.request.action,
          });
        }
      },
    });

    // 5. 日志拦截器 (priority: 100)
    this.registerInterceptor({
      name: "LoggingInterceptor",
      priority: 100,
      afterRead: (ctx) => {
        if (ctx.response) {
          logger.debug("[ReadOptimizer] Read complete", {
            resource: ctx.request.resource,
            action: ctx.request.action,
            source: ctx.response.source,
            latency: ctx.response.latencyMs,
            agentId: ctx.request.agentId,
          });
        }
      },
    });
  }

  private readFromBlackboard(request: ReadRequest): ReadResult {
    const bb = getGlobalBlackboard();
    const key = `${request.resource}:${request.action}:${JSON.stringify(request.params)}`;

    return bb.read(key, {
      minConfidence: 0.7,
      fields: request.fields,
      agentId: request.agentId,
    });
  }

  private async tryBatch(request: ReadRequest): Promise<unknown | undefined> {
    const queueKey = `${request.resource}:${request.action}`;

    // 已有活跃窗口 → 加入等待
    const existing = this.batchQueues.get(queueKey);
    if (existing) {
      return new Promise((resolve, reject) => {
        existing.items.push({ request, resolve, reject });
      });
    }

    // 创建新窗口，等待后续请求合并
    return new Promise((resolve, reject) => {
      const windowMs = 8; // 8ms 微窗口，同事件循环内的请求可合并
      const queue = new BatchQueue(windowMs, async (items) => {
        // 批量执行
        this.batchQueues.delete(queueKey);
        const executor = this.executors.get(request.resource);

        if (items.length === 1) {
          // 只有一条，直接执行
          try {
            const result = executor ? await executor(items[0].request) : await this.fallbackRead(items[0].request);
            items[0].resolve(result);
          } catch (e) {
            items[0].reject(e instanceof Error ? e : new Error(String(e)));
          }
          return;
        }

        // 多条：尝试批量执行（如果 executor 支持批量）
        try {
          if (executor && items.length > 1) {
            // 优先尝试批量 executor
            const batchedResult = await this.executeBatched(items, executor);
            if (batchedResult) {
              for (let i = 0; i < items.length; i++) {
                items[i].resolve(batchedResult[i]);
              }
              return;
            }
          }

          // 回退到并行单条执行
          const results = await Promise.all(
            items.map((item) =>
              executor ? executor(item.request) : this.fallbackRead(item.request)
            )
          );
          for (let i = 0; i < items.length; i++) {
            items[i].resolve(results[i]);
          }
        } catch (e) {
          for (const item of items) {
            item.reject(e instanceof Error ? e : new Error(String(e)));
          }
        }
      });

      queue.add({ request, resolve, reject });
      this.batchQueues.set(queueKey, queue);
    });
  }

  /**
   * 尝试批量执行 — 如果 executor 的 params 可合并（如 IN 查询、多 symbol）
   */
  private async executeBatched(
    items: BatchItem[],
    executor: (req: ReadRequest) => Promise<unknown>
  ): Promise<unknown[] | null> {
    // 检查是否支持批量合并（基于 action 类型）
    const action = items[0].request.action;
    const resource = items[0].request.resource;

    // CodeGraph: searchSymbols / searchFiles 可合并查询列表
    if (resource === "codegraph" && (action === "searchSymbols" || action === "searchFiles")) {
      const queries = items.map((i) => String(i.request.params.query || i.request.params.pattern || "")).filter(Boolean);
      if (queries.length > 1) {
        const mergedReq: ReadRequest = {
          ...items[0].request,
          params: { ...items[0].request.params, queries },
        };
        const result = await executor(mergedReq);
        if (Array.isArray(result)) {
          // 简单分配：均分结果
          const perItem = Math.ceil(result.length / items.length);
          return items.map((_, idx) => result.slice(idx * perItem, (idx + 1) * perItem));
        }
      }
    }

    // Vault: search 可合并关键词
    if (resource === "vault" && action === "search") {
      const queries = items.map((i) => String(i.request.params.query || "")).filter(Boolean);
      if (queries.length > 1) {
        const mergedReq: ReadRequest = {
          ...items[0].request,
          params: { ...items[0].request.params, queries: queries.join(" OR ") },
        };
        const result = await executor(mergedReq);
        if (Array.isArray(result)) {
          const perItem = Math.ceil(result.length / items.length);
          return items.map((_, idx) => result.slice(idx * perItem, (idx + 1) * perItem));
        }
      }
    }

    return null; // 不支持批量合并，回退到并行
  }

  private projectFields(data: unknown, fields: string[]): unknown {
    if (Array.isArray(data)) {
      return data.map((item) => this.projectFields(item, fields));
    }

    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      const projected: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in obj) projected[field] = obj[field];
      }
      return projected;
    }

    return data;
  }

  private async fallbackRead(request: ReadRequest): Promise<unknown> {
    logger.warn("[ReadOptimizer] Fallback read", { resource: request.resource, action: request.action });
    // 返回空结果或默认值
    return {
      error: "Resource not available",
      resource: request.resource,
      action: request.action,
      fallback: true,
    };
  }

  private buildCacheKey(request: ReadRequest): string {
    return `${request.resource}:${request.action}:${JSON.stringify(request.params)}`;
  }

  private buildEmptyResponse(startTime: number): ReadResponse {
    return {
      data: null,
      source: "fallback",
      latencyMs: Date.now() - startTime,
      fieldsProjected: false,
      batched: false,
      cached: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// 令牌桶限流器
// ═══════════════════════════════════════════════════════════════

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRatePerMs: number;

  constructor(capacityPerMinute: number, burstSize: number) {
    this.capacity = burstSize;
    this.tokens = burstSize;
    this.lastRefill = Date.now();
    this.refillRatePerMs = capacityPerMinute / 60000;
  }

  consume(tokens = 1): boolean {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const toAdd = elapsed * this.refillRatePerMs;

    this.tokens = Math.min(this.capacity, this.tokens + toAdd);
    this.lastRefill = now;
  }
}

// ═══════════════════════════════════════════════════════════════
// 批量队列
// ═══════════════════════════════════════════════════════════════

interface BatchItem {
  request: ReadRequest;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

class BatchQueue {
  items: BatchItem[] = [];
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private maxWaitMs: number,
    private onFlush: (items: BatchItem[]) => void
  ) {}

  add(item: BatchItem): void {
    this.items.push(item);

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.maxWaitMs);
    }
  }

  private flush(): void {
    this.onFlush(this.items);
    this.items = [];
    this.timer = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 全局实例
// ═══════════════════════════════════════════════════════════════

let globalFacade: ReadOptimizerFacade | null = null;

export function getReadOptimizer(): ReadOptimizerFacade {
  if (!globalFacade) {
    globalFacade = new ReadOptimizerFacade();
  }
  return globalFacade;
}
