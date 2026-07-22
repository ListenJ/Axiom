/**
 * 端口协议实现 — 推理引擎与知识库的标准化通信层
 *
 * 架构：
 *   推理引擎  ──PortRequest──▶  KnowledgePort  ──▶  知识库（本地或远程）
 *          ◀──PortResponse──
 *
 * 两种实现可透明切换：
 * - LocalKnowledgePort:  进程内直接调用 KnowledgeStore（零网络开销）
 * - RemoteKnowledgePort: 通过 HTTP 调用远程知识库服务（支持分布式部署）
 *
 * 重试机制：
 * - 仅重试 retriable=true 的错误（网络抖动、超时、限流）
 * - 指数退避 + 抖动，避免重试风暴
 * - 超时保护：总耗时超过 request.timeout 后立即放弃
 */

import type { Database } from "bun:sqlite";
import {
  KnowledgeStore,
  type KnowledgeNode,
  type KnowledgeRevision,
} from "../storage/knowledge-store.js";
import { logger } from "../../utils/logger.js";
import {
  type PortRequest,
  type PortResponse,
  type PortError,
  type PortErrorCode,
  type PortMethod,
  type WriteParams,
  type WriteResult,
  type ReadParams,
  type SearchParams,
  type DeleteParams,
  type GetRevisionsParams,
  type HealthResult,
  type RetryConfig,
  DEFAULT_RETRY_CONFIG,
  computeBackoff,
  generateRequestId,
  okResponse,
  errorResponse,
  toPortError,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════
// 端口协议接口
// ═══════════════════════════════════════════════════════════════

/**
 * 知识库端口 — 推理引擎通过此接口访问知识库，不直接依赖具体实现。
 *
 * 调用方只需面向此接口编程，运行时注入 LocalKnowledgePort 或 RemoteKnowledgePort。
 */
export interface KnowledgePort {
  /** 执行一个端口请求，返回统一格式的响应 */
  execute<T = unknown>(request: PortRequest): Promise<PortResponse<T>>;
}

// ═══════════════════════════════════════════════════════════════
// 内部工具
// ═══════════════════════════════════════════════════════════════

/**
 * 可抛出的端口错误 — 携带结构化 PortError 信息。
 * 用于在 dispatch 内部抛出，由 execute() 统一捕获并转换为 PortResponse。
 */
export class PortException extends Error {
  constructor(public readonly portError: PortError) {
    super(portError.message);
    this.name = "PortException";
  }
}

/** 抛出端口错误（简写） */
function throwPortError(
  code: PortErrorCode,
  message: string,
  retriable = false,
  context?: Record<string, unknown>,
): never {
  throw new PortException({ code, message, retriable, context });
}

/** 异步 sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 合并重试配置（默认值 + 请求级覆盖） */
function mergeRetryConfig(
  base: RetryConfig,
  override?: { maxRetries?: number; backoffMs?: number },
): RetryConfig {
  if (!override) return base;
  return {
    ...base,
    maxRetries: override.maxRetries ?? base.maxRetries,
    backoffMs: override.backoffMs ?? base.backoffMs,
  };
}

// ═══════════════════════════════════════════════════════════════
// 抽象基类 — 提供重试机制
// ═══════════════════════════════════════════════════════════════

/**
 * 端口基类 — 封装统一的请求执行 + 重试 + 超时 + 日志逻辑。
 *
 * 子类只需实现 dispatch()，按 method 分发到具体操作。
 */
export abstract class BaseKnowledgePort implements KnowledgePort {
  protected retryConfig: RetryConfig;

  constructor(retryConfig?: Partial<RetryConfig>) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * 执行请求（带重试 + 超时保护）。
   *
   * 重试策略：
   * 1. 首次尝试 + 最多 maxRetries 次重试
   * 2. 仅重试 retriable=true 的错误
   * 3. 指数退避 + 抖动
   * 4. 总耗时超过 timeout 后放弃
   */
  async execute<T = unknown>(request: PortRequest): Promise<PortResponse<T>> {
    const requestId = request.requestId ?? generateRequestId();
    const startTime = Date.now();
    const config = mergeRetryConfig(this.retryConfig, request.retryOverride);
    const timeout = request.timeout ?? 30000;

    let lastError: PortError | null = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      // 超时检查
      const elapsed = Date.now() - startTime;
      if (elapsed > timeout) {
        const timeoutError: PortError = {
          code: "TIMEOUT",
          message: `Request timed out after ${timeout}ms (elapsed ${elapsed}ms, attempt ${attempt})`,
          retriable: false,
        };
        return errorResponse(requestId, timeoutError, elapsed) as PortResponse<T>;
      }

      try {
        const data = await this.dispatch(request.method, request.params);
        const durationMs = Date.now() - startTime;
        if (attempt > 0) {
          logger.info("[Port] Request succeeded after retry", {
            requestId, method: request.method, attempt, durationMs,
          });
        }
        return okResponse<T>(requestId, data as T, durationMs);
      } catch (err) {
        lastError = err instanceof PortException ? err.portError : toPortError(err);

        // 不可重试，或已用完重试次数
        if (!lastError.retriable || attempt >= config.maxRetries) {
          break;
        }

        // 计算退避并等待
        const backoff = computeBackoff(config, attempt);
        logger.warn("[Port] Request failed, retrying", {
          requestId,
          method: request.method,
          attempt: attempt + 1,
          maxRetries: config.maxRetries,
          backoffMs: backoff,
          error: lastError.message,
          code: lastError.code,
        });
        await sleep(backoff);
      }
    }

    const durationMs = Date.now() - startTime;
    logger.error("[Port] Request failed permanently", undefined, {
      requestId, method: request.method, durationMs,
      error: lastError?.message, code: lastError?.code,
    });
    return errorResponse(requestId, lastError!, durationMs) as PortResponse<T>;
  }

  /** 子类实现 — 按 method 分发到具体操作，抛出 PortException 表示失败 */
  protected abstract dispatch(method: PortMethod, params: unknown): Promise<unknown> | unknown;
}

// ═══════════════════════════════════════════════════════════════
// 本地知识库端口
// ═══════════════════════════════════════════════════════════════

/**
 * 本地知识库端口 — 进程内直接调用 KnowledgeStore。
 *
 * 特点：
 * - 零网络开销，延迟最低
 * - 包装现有 KnowledgeStore，无需修改存储层
 * - delete 操作需要 db 引用（KnowledgeStore 原生未提供 delete）
 *
 * 用法：
 *   const port = new LocalKnowledgePort(store, { db });
 *   const res = await port.execute({ method: "knowledge.read", params: { nodeId: "x" } });
 */
export class LocalKnowledgePort extends BaseKnowledgePort {
  private store: KnowledgeStore;
  private db: Database | null;

  constructor(
    store: KnowledgeStore,
    options?: {
      db?: Database;
      retryConfig?: Partial<RetryConfig>;
    },
  ) {
    super(options?.retryConfig);
    this.store = store;
    this.db = options?.db ?? null;
  }

  protected dispatch(method: PortMethod, params: unknown): unknown {
    switch (method) {
      case "knowledge.write":
        return this.handleWrite(params as WriteParams);
      case "knowledge.read":
        return this.handleRead(params as ReadParams);
      case "knowledge.search":
        return this.handleSearch(params as SearchParams);
      case "knowledge.delete":
        return this.handleDelete(params as DeleteParams);
      case "knowledge.getRevisions":
        return this.handleGetRevisions(params as GetRevisionsParams);
      case "knowledge.health":
        return this.handleHealth();
      default:
        throwPortError("VALIDATION_ERROR", `Unknown method: ${method}`, false);
    }
  }

  private handleWrite(params: WriteParams): WriteResult {
    const { node } = params;
    if (!node) {
      throwPortError("VALIDATION_ERROR", "params.node is required");
    }
    if (!node!.title || typeof node!.title !== "string") {
      throwPortError("VALIDATION_ERROR", "node.title is required and must be a string");
    }
    if (!node!.content || typeof node!.content !== "string") {
      throwPortError("VALIDATION_ERROR", "node.content is required and must be a string");
    }
    if (!node!.domain) {
      throwPortError("VALIDATION_ERROR", "node.domain is required");
    }

    // 生成 nodeId（调用方未提供时）
    const nodeId = node!.nodeId || `node-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      const written = this.store.write({
        nodeId,
        title: node!.title,
        content: node!.content,
        domain: node!.domain,
        paradigm: node!.paradigm as KnowledgeNode["paradigm"],
        confidence: node!.confidence,
        sourceType: node!.sourceType,
        schemaVersion: node!.schemaVersion ?? 1,
        isVerified: node!.isVerified ?? false,
        sourceUri: undefined,
      });
      return {
        nodeId: written.nodeId,
        revision: written.revision,
        contentHash: written.contentHash,
        createdAt: written.createdAt,
        updatedAt: written.updatedAt,
      };
    } catch (err) {
      // SQLite 约束冲突等 → INTERNAL_ERROR
      throwPortError(
        "INTERNAL_ERROR",
        `Write failed: ${(err as Error).message}`,
        false,
      );
    }
  }

  private handleRead(params: ReadParams): KnowledgeNode {
    if (!params?.nodeId) {
      throwPortError("VALIDATION_ERROR", "params.nodeId is required");
    }
    const node = this.store.read(params.nodeId);
    if (!node) {
      throwPortError("NOT_FOUND", `Knowledge node not found: ${params.nodeId}`, false);
    }
    return node;
  }

  private handleSearch(params: SearchParams): KnowledgeNode[] {
    if (!params?.query && params.query !== "") {
      throwPortError("VALIDATION_ERROR", "params.query is required");
    }
    return this.store.search(params.query, {
      domain: params.domain,
      paradigm: params.paradigm,
      minConfidence: params.minConfidence,
      limit: params.limit,
    });
  }

  private handleDelete(params: DeleteParams): { deleted: boolean; nodeId: string } {
    if (!params?.nodeId) {
      throwPortError("VALIDATION_ERROR", "params.nodeId is required");
    }
    if (!this.db) {
      throwPortError(
        "INTERNAL_ERROR",
        "Delete not supported: no db reference provided to LocalKnowledgePort",
        false,
      );
    }

    // 先检查存在性
    const existing = this.store.read(params.nodeId);
    if (!existing) {
      throwPortError("NOT_FOUND", `Knowledge node not found: ${params.nodeId}`, false);
    }

    try {
      // 级联删除：节点 + 版本快照 + FTS 索引（FTS 由触发器自动维护）
      this.db.prepare("DELETE FROM knowledge_node WHERE node_id = ?").run(params.nodeId);
      this.db.prepare("DELETE FROM knowledge_revision WHERE node_id = ?").run(params.nodeId);
      return { deleted: true, nodeId: params.nodeId };
    } catch (err) {
      throwPortError(
        "INTERNAL_ERROR",
        `Delete failed: ${(err as Error).message}`,
        false,
      );
    }
  }

  private handleGetRevisions(params: GetRevisionsParams): KnowledgeRevision[] {
    if (!params?.nodeId) {
      throwPortError("VALIDATION_ERROR", "params.nodeId is required");
    }
    return this.store.getRevisions(params.nodeId);
  }

  private handleHealth(): HealthResult {
    const start = performance.now();
    try {
      // 最轻量的探活：空查询搜索
      this.store.search("");
      return {
        healthy: true,
        latencyMs: Math.round(performance.now() - start),
      };
    } catch (err) {
      return {
        healthy: false,
        latencyMs: Math.round(performance.now() - start),
        details: { error: (err as Error).message },
      };
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 远程知识库端口
// ═══════════════════════════════════════════════════════════════

/**
 * 远程知识库端口 — 通过 HTTP POST 调用远程知识库服务。
 *
 * 特点：
 * - 支持分布式部署：知识库与推理引擎可部署在不同进程/机器
 * - HTTP 状态码自动映射为 PortErrorCode
 * - 与 LocalKnowledgePort 接口完全一致，可透明替换
 *
 * 远程服务需实现 POST /api/port 端点，接收 {method, params}，返回 {ok, data?, error?}。
 *
 * 用法：
 *   const port = new RemoteKnowledgePort("https://kb.example.com", { apiKey: "..." });
 *   const res = await port.execute({ method: "knowledge.read", params: { nodeId: "x" } });
 */
export class RemoteKnowledgePort extends BaseKnowledgePort {
  private baseUrl: string;
  private apiKey: string | undefined;
  private defaultHeaders: Record<string, string>;

  constructor(
    baseUrl: string,
    options?: {
      apiKey?: string;
      headers?: Record<string, string>;
      retryConfig?: Partial<RetryConfig>;
    },
  ) {
    super(options?.retryConfig);
    // 规范化：去除尾部斜杠
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = options?.apiKey;
    this.defaultHeaders = {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  protected async dispatch(method: PortMethod, params: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/api/port`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.defaultHeaders,
        body: JSON.stringify({ method, params }),
      });
    } catch (err) {
      // fetch 本身抛出 → 网络层错误，可重试
      throwPortError(
        "CONNECTION_ERROR",
        `Network error: ${(err as Error).message}`,
        true,
      );
    }

    // 非 2xx 状态码 → 映射为 PortError
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const code = this.httpStatusToCode(res.status);
      // 5xx 和 429 可重试
      const retriable = res.status >= 500 || res.status === 429;
      throwPortError(
        code,
        `HTTP ${res.status}: ${bodyText.slice(0, 500)}`,
        retriable,
        { httpStatus: res.status },
      );
    }

    // 解析响应体
    let body: { ok: boolean; data?: unknown; error?: PortError };
    try {
      body = (await res.json()) as { ok: boolean; data?: unknown; error?: PortError };
    } catch (err) {
      throwPortError(
        "INTERNAL_ERROR",
        `Failed to parse response JSON: ${(err as Error).message}`,
        false,
      );
    }

    if (!body.ok) {
      // 远程服务返回的业务错误
      throw new PortException(
        body.error ?? {
          code: "UNKNOWN" as PortErrorCode,
          message: "Remote service returned error without details",
          retriable: false,
        },
      );
    }

    return body.data;
  }

  /** HTTP 状态码 → PortErrorCode 映射 */
  private httpStatusToCode(status: number): PortErrorCode {
    if (status === 400) return "VALIDATION_ERROR";
    if (status === 404) return "NOT_FOUND";
    if (status === 409) return "CONFLICT";
    if (status === 408) return "TIMEOUT";
    if (status === 429) return "RATE_LIMITED";
    if (status >= 500) return "INTERNAL_ERROR";
    return "CONNECTION_ERROR";
  }
}

// ═══════════════════════════════════════════════════════════════
// 便捷工厂函数
// ═══════════════════════════════════════════════════════════════

/**
 * 创建本地知识库端口。
 *
 * @param store  知识库存储实例
 * @param db     数据库实例（用于 delete 等原生不支持的操作）
 * @param retry  重试配置
 */
export function createLocalPort(
  store: KnowledgeStore,
  options?: { db?: Database; retryConfig?: Partial<RetryConfig> },
): LocalKnowledgePort {
  return new LocalKnowledgePort(store, options);
}

/**
 * 创建远程知识库端口。
 *
 * @param baseUrl  远程知识库服务地址（如 https://kb.example.com）
 * @param options  API Key / 自定义 Headers / 重试配置
 */
export function createRemotePort(
  baseUrl: string,
  options?: { apiKey?: string; headers?: Record<string, string>; retryConfig?: Partial<RetryConfig> },
): RemoteKnowledgePort {
  return new RemoteKnowledgePort(baseUrl, options);
}
