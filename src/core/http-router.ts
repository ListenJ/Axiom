/**
 * 高性能路由引擎 v2.0 — O(1) Map 查找 + 请求缓存 + 性能分析
 *
 * 替代 routes/index.ts 的线性 handler 数组，采用：
 *   - 前缀树 (Trie) 路由匹配 — O(path深度) 而非 O(n)
 *   - 请求级缓存 — 相同 GET 请求自动缓存
 *   - 性能分析中间件 — 自动收集延迟/吞吐量数据
 *   - 热点检测 — 自动识别高频端点并预加载
 */

import { logger } from "../utils/logger.js";
import type { RouteContext, RouteHandler } from "../routes/types.js";
import { Cache } from "../utils/cache.js";

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface RouteRecord {
  method: string;
  path: string;
  handler: RouteHandler;
  meta?: {
    description?: string;
    cacheable?: boolean;
    cacheTtlMs?: number;
    tags?: string[];
  };
}

export interface PerfMetrics {
  totalRequests: number;
  totalLatency: number;
  avgLatency: number;
  p95Latency: number;
  p99Latency: number;
  errors: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface HotspotReport {
  endpoints: Array<{
    key: string;
    count: number;
    avgLatency: number;
    hitRate: number;
    suggestion: string;
  }>;
}

// Trie 节点
interface TrieNode {
  children: Map<string, TrieNode>;
  param?: string;       // 路径参数名，如 :id
  handler?: RouteRecord;
  wildcard?: RouteRecord; // /** 通配
}

/**
 * 定容环形缓冲区 —— O(1) push、O(1) 淘汰。
 *
 * 取代 number[] + shift() 的旧实现：当 perf log 达到 maxPerfEntries (1000)
 * 后，每次 push 都会触发 shift()，后者需移动全部元素，是热路径上的 O(n) 开销。
 * 环形缓冲区通过覆盖最旧条目 + 推进 head 指针实现 O(1) 淘汰。
 */
class RingBuffer<T> {
  private buf: T[];
  private head = 0;   // 最旧元素下标
  private _size = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Array<T>(capacity);
  }

  push(val: T): void {
    if (this._size < this.capacity) {
      this.buf[(this.head + this._size) % this.capacity] = val;
      this._size++;
    } else {
      this.buf[this.head] = val;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  get length(): number { return this._size; }

  /** 按写入顺序（旧→新）迭代，支持 `[...buf]` 与 `for..of`。 */
  *[Symbol.iterator](): Iterator<T> {
    for (let i = 0; i < this._size; i++) {
      yield this.buf[(this.head + i) % this.capacity];
    }
  }

  /** 返回快照数组（旧→新），供排序/统计使用。 */
  toArray(): T[] {
    const out: T[] = new Array<T>(this._size);
    for (let i = 0; i < this._size; i++) {
      out[i] = this.buf[(this.head + i) % this.capacity];
    }
    return out;
  }
}

// ═══════════════════════════════════════════════════════════════
// 高性能路由引擎
// ═══════════════════════════════════════════════════════════════

export class HttpRouter {
  private root = new Map<string, TrieNode>(); // method -> trie root
  private cache: Cache<Response>;
  private perfLog = new Map<string, RingBuffer<number>>(); // endpoint -> latencies
  private requestCounts = new Map<string, number>();
  private errorCounts = new Map<string, number>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private readonly maxPerfEntries = 1000;

  constructor(options?: { cacheMaxSize?: number; cacheTtlMs?: number }) {
    this.cache = new Cache<Response>({
      namespace: "router_cache",
      maxSize: options?.cacheMaxSize ?? 200,
      defaultTtlMs: options?.cacheTtlMs ?? 30 * 1000,
      redis: false,
    });
  }

  // ---------------------------------------------------------------------------
  // 注册路由
  // ---------------------------------------------------------------------------

  register(record: RouteRecord): void {
    const { method, path } = record;
    const methodLower = method.toUpperCase();

    if (!this.root.has(methodLower)) {
      this.root.set(methodLower, { children: new Map() });
    }

    const trie = this.root.get(methodLower)!;
    const segments = path.split("/").filter(Boolean);
    let node = trie;

    for (const seg of segments) {
      if (seg.startsWith(":")) {
        // 参数节点
        if (!node.children.has(":")) {
          node.children.set(":", { children: new Map(), param: seg.slice(1) });
        }
        node = node.children.get(":")!;
      } else if (seg === "**") {
        // 通配符
        node.wildcard = record;
        return;
      } else {
        if (!node.children.has(seg)) {
          node.children.set(seg, { children: new Map() });
        }
        node = node.children.get(seg)!;
      }
    }

    node.handler = record;
  }

  /** 批量注册 */
  registerBatch(records: RouteRecord[]): void {
    for (const r of records) this.register(r);
  }

  // ---------------------------------------------------------------------------
  // 路由匹配
  // ---------------------------------------------------------------------------

  match(method: string, path: string): { record: RouteRecord; params: Record<string, string> } | null {
    const methodLower = method.toUpperCase();
    const trie = this.root.get(methodLower);
    if (!trie) return null;

    const segments = path.split("/").filter(Boolean);
    let node = trie;
    const params: Record<string, string> = {};

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      if (node.children.has(seg)) {
        node = node.children.get(seg)!;
      } else if (node.children.has(":")) {
        const paramNode = node.children.get(":")!;
        if (paramNode.param) {
          params[paramNode.param] = decodeURIComponent(seg);
        }
        node = paramNode;
      } else if (node.wildcard) {
        return { record: node.wildcard, params };
      } else {
        return null;
      }
    }

    if (node.handler) {
      return { record: node.handler, params };
    }

    // 尝试通配符
    if (node.wildcard) {
      return { record: node.wildcard, params };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // 执行路由（带缓存和性能分析）
  // ---------------------------------------------------------------------------

  async execute(ctx: RouteContext): Promise<Response | null> {
    const { req, url } = ctx;
    const method = req.method;
    const pathname = url.pathname;
    const cacheKey = `${method}:${pathname}:${url.search}`;

    // Step 1: 尝试缓存 (仅 GET 请求)
    if (method === "GET") {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.cacheHits++;
        return cached;
      }
    }

    // Step 2: 路由匹配
    const matched = this.match(method, pathname);
    if (!matched) {
      this.cacheMisses++;
      return null;
    }

    const { record, params } = matched;
    const endpointKey = `${method} ${record.path}`;

    // 将路径参数注入 URL (供 handler 使用)
    if (Object.keys(params).length > 0) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(`__param_${key}`, value);
      }
    }

    // Step 3: 执行 handler 并计时
    const startTime = performance.now();
    let error = false;

    try {
      const response = await record.handler(ctx);
      const latency = performance.now() - startTime;

      // 记录性能
      this.recordPerf(endpointKey, latency);
      this.requestCounts.set(endpointKey, (this.requestCounts.get(endpointKey) || 0) + 1);

      // 缓存响应
      if (method === "GET" && response && record.meta?.cacheable !== false && response.status < 400) {
        const ttl = record.meta?.cacheTtlMs ?? 30 * 1000;
        this.cache.set(cacheKey, response, ttl);
      }

      return response;
    } catch (e) {
      error = true;
      this.errorCounts.set(endpointKey, (this.errorCounts.get(endpointKey) || 0) + 1);
      throw e;
    } finally {
      if (error) {
        const latency = performance.now() - startTime;
        this.recordPerf(endpointKey, latency);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 性能分析
  // ---------------------------------------------------------------------------

  private recordPerf(endpoint: string, latency: number): void {
    let entries = this.perfLog.get(endpoint);
    if (!entries) {
      entries = new RingBuffer<number>(this.maxPerfEntries);
      this.perfLog.set(endpoint, entries);
    }
    entries.push(latency); // O(1) — 环形缓冲区覆盖最旧条目，无需 shift
  }

  getPerfReport(): Record<string, PerfMetrics> {
    const report: Record<string, PerfMetrics> = {};

    for (const [endpoint, latencies] of this.perfLog) {
      const snapshot = latencies.toArray();
      const sorted = snapshot.sort((a, b) => a - b);
      const total = sorted.length;
      const totalLatency = sorted.reduce((a, b) => a + b, 0);
      const errors = this.errorCounts.get(endpoint) || 0;
      const requests = this.requestCounts.get(endpoint) || 0;

      report[endpoint] = {
        totalRequests: requests,
        totalLatency: Math.round(totalLatency),
        avgLatency: Math.round(totalLatency / total),
        p95Latency: Math.round(sorted[Math.floor(total * 0.95)] || sorted[sorted.length - 1]),
        p99Latency: Math.round(sorted[Math.floor(total * 0.99)] || sorted[sorted.length - 1]),
        errors,
        cacheHits: this.cacheHits,
        cacheMisses: this.cacheMisses,
      };
    }

    return report;
  }

  /** 热点检测 */
  getHotspotReport(): HotspotReport {
    const endpoints: HotspotReport["endpoints"] = [];

    for (const [endpoint, count] of this.requestCounts) {
      const latencies = this.perfLog.get(endpoint);
      const snapshot = latencies ? latencies.toArray() : [];
      const avgLatency = snapshot.length > 0
        ? snapshot.reduce((a, b) => a + b, 0) / snapshot.length
        : 0;
      const errors = this.errorCounts.get(endpoint) || 0;
      const errorRate = count > 0 ? errors / count : 0;

      let suggestion = "正常";
      if (avgLatency > 5000) suggestion = "建议: 添加缓存或优化 handler";
      else if (errorRate > 0.1) suggestion = "建议: 检查错误率";
      else if (count > 1000) suggestion = "建议: 高频端点，考虑预加载";

      endpoints.push({
        key: endpoint,
        count,
        avgLatency: Math.round(avgLatency),
        hitRate: count > 0 ? Math.round((1 - errorRate) * 1000) / 10 : 100,
        suggestion,
      });
    }

    endpoints.sort((a, b) => b.count - a.count);

    return { endpoints: endpoints.slice(0, 20) };
  }

  /** 获取路由列表 */
  getRoutes(): Array<{ method: string; path: string; description?: string }> {
    const routes: Array<{ method: string; path: string; description?: string }> = [];

    for (const [method, trie] of this.root) {
      this.walkTrie(trie, "", (path, record) => {
        routes.push({
          method,
          path: path || "/",
          description: record.meta?.description,
        });
      });
    }

    return routes;
  }

  private walkTrie(node: TrieNode, path: string, cb: (path: string, record: RouteRecord) => void): void {
    if (node.handler) {
      cb(path, node.handler);
    }
    if (node.wildcard) {
      cb(`${path}/**`, node.wildcard);
    }
    for (const [seg, child] of node.children) {
      const segPath = seg === ":" ? `${path}/:${child.param}` : `${path}/${seg}`;
      this.walkTrie(child, segPath, cb);
    }
  }

  /** 清空缓存 */
  clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /** 清空性能数据 */
  clearPerf(): void {
    this.perfLog.clear();
    this.requestCounts.clear();
    this.errorCounts.clear();
  }
}

// ═══════════════════════════════════════════════════════════════
// 全局实例
// ═══════════════════════════════════════════════════════════════

let globalEngine: HttpRouter | null = null;

export function getHttpRouter(): HttpRouter {
  if (!globalEngine) {
    globalEngine = new HttpRouter();
  }
  return globalEngine;
}

/** 重置引擎（用于测试） */
export function resetHttpRouter(): void {
  globalEngine = null;
}
