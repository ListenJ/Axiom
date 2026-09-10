/**
 * 端口协议类型定义 — 推理引擎与知识库的标准化通信契约
 *
 * 设计目标：
 * - 解耦：推理引擎通过 Port 接口访问知识库，不直接依赖具体实现
 * - 可替换：LocalKnowledgePort（进程内）↔ RemoteKnowledgePort（HTTP/WS）透明切换
 * - 可追溯：每个请求带 requestId，支持审计与回放
 * - 容错：内置错误分类 + 重试策略，调用方无需自行处理网络抖动
 *
 * 协议格式借鉴 JSON-RPC 2.0，但简化为单向请求/响应（无通知）。
 */

// ═══════════════════════════════════════════════════════════════
// 请求/响应基础类型
// ═══════════════════════════════════════════════════════════════

/** 端口协议操作类型 — 与 KnowledgeStore 核心方法一一对应 */
export type PortMethod =
  | "knowledge.write"
  | "knowledge.read"
  | "knowledge.search"
  | "knowledge.delete"
  | "knowledge.getRevisions"
  | "knowledge.health";

/** 端口请求 — 所有知识库操作的统一封装 */
export interface PortRequest<T = unknown> {
  /** 操作类型 */
  method: PortMethod;
  /** 请求体（具体结构由 method 决定） */
  params: T;
  /** 请求 ID，用于审计与回放（不传则自动生成） */
  requestId?: string;
  /** 请求超时（ms），默认 30000 */
  timeout?: number;
  /** 重试配置覆盖（可选） */
  retryOverride?: { maxRetries?: number; backoffMs?: number };
}

/** 端口响应 — 成功与失败统一格式 */
export interface PortResponse<T = unknown> {
  /** 对应请求的 ID */
  requestId: string;
  /** 是否成功 */
  ok: boolean;
  /** 响应数据（ok=true 时有效） */
  data?: T;
  /** 错误信息（ok=false 时有效） */
  error?: PortError;
  /** 服务端处理耗时（ms） */
  durationMs: number;
}

/** 端口错误 — 结构化错误，便于调用方分类处理 */
export interface PortError {
  /** 错误码 — 与 DREError.code 对齐 */
  code: PortErrorCode;
  /** 人类可读消息 */
  message: string;
  /** 是否可重试 */
  retriable: boolean;
  /** 额外上下文 */
  context?: Record<string, unknown>;
}

/** 端口错误码枚举 */
export type PortErrorCode =
  | "VALIDATION_ERROR" // 输入校验失败
  | "NOT_FOUND" // 资源不存在
  | "CONFLICT" // 版本冲突/重复写入
  | "TIMEOUT" // 请求超时
  | "CONNECTION_ERROR" // 远程连接失败
  | "RATE_LIMITED" // 被限流
  | "INTERNAL_ERROR" // 服务端内部错误
  | "UNKNOWN"; // 未知错误

// ═══════════════════════════════════════════════════════════════
// 各操作的 params 与 data 类型
// ═══════════════════════════════════════════════════════════════

/** knowledge.write 请求参数 */
export interface WriteParams {
  /** 知识节点（不含 createdAt/updatedAt/revision/contentHash，由存储层填充） */
  node: {
    nodeId?: string;
    title: string;
    content: string;
    domain: string;
    paradigm: string;
    confidence: number;
    sourceType: "manual" | "web" | "llm" | "ocr" | "kg";
    schemaVersion?: number;
    isVerified?: boolean;
  };
}

/** knowledge.write 响应数据 */
export interface WriteResult {
  nodeId: string;
  revision: number;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

/** knowledge.read 请求参数 */
export interface ReadParams {
  nodeId: string;
}

/** knowledge.search 请求参数 */
export interface SearchParams {
  query: string;
  limit?: number;
  domain?: string;
  paradigm?: string;
  minConfidence?: number;
}

/** knowledge.delete 请求参数 */
export interface DeleteParams {
  nodeId: string;
}

/** knowledge.getRevisions 请求参数 */
export interface GetRevisionsParams {
  nodeId: string;
}

/** 健康检查响应 */
export interface HealthResult {
  healthy: boolean;
  latencyMs: number;
  details?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// 重试配置
// ═══════════════════════════════════════════════════════════════

/** 重试策略配置 */
export interface RetryConfig {
  /** 最大重试次数（不含首次尝试），默认 2 */
  maxRetries: number;
  /** 初始退避（ms），默认 100 */
  backoffMs: number;
  /** 退避倍率，默认 2（指数退避） */
  backoffMultiplier: number;
  /** 最大退避（ms），默认 5000 */
  maxBackoffMs: number;
  /** 抖动比例（0-1），默认 0.2，避免重试风暴 */
  jitter: number;
}

/** 默认重试配置 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  backoffMs: 100,
  backoffMultiplier: 2,
  maxBackoffMs: 5000,
  jitter: 0.2,
};

/**
 * 计算第 n 次重试的退避时间（含抖动）。
 * 公式：backoffMs * (backoffMultiplier ^ attempt) * (1 ± jitter)
 */
export function computeBackoff(config: RetryConfig, attempt: number): number {
  const base = config.backoffMs * Math.pow(config.backoffMultiplier, attempt);
  const clamped = Math.min(base, config.maxBackoffMs);
  const jitterDelta = clamped * config.jitter;
  const jitter = (Math.random() * 2 - 1) * jitterDelta;
  return Math.max(0, Math.round(clamped + jitter));
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

/** 生成请求 ID（短 UUID，便于日志阅读） */
export function generateRequestId(): string {
  // crypto.randomUUID() 在 Bun 中可用，取前 8 位足够唯一
  return crypto.randomUUID().slice(0, 8);
}

/** 构造成功响应 */
export function okResponse<T>(requestId: string, data: T, durationMs: number): PortResponse<T> {
  return { requestId, ok: true, data, durationMs };
}

/** 构造失败响应 */
export function errorResponse(
  requestId: string,
  error: PortError,
  durationMs: number,
): PortResponse {
  return { requestId, ok: false, error, durationMs };
}

/** 将未知错误转换为 PortError */
export function toPortError(err: unknown): PortError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: string; message: string; retriable?: boolean; context?: Record<string, unknown> };
    return {
      code: e.code as PortErrorCode,
      message: e.message,
      retriable: e.retriable ?? false,
      context: e.context,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  // 启发式分类：网络/超时错误可重试
  const retriable = /fetch|connect|timeout|econnreset|socket hang up/i.test(msg);
  return {
    code: retriable ? "CONNECTION_ERROR" : "UNKNOWN",
    message: msg,
    retriable,
  };
}
