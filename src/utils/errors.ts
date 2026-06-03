/**
 * 统一错误处理系统
 * 提供类型化的错误类，支持上下文信息和结构化日志
 */

export interface ErrorContext {
  [key: string]: unknown;
}

/**
 * OpenClaw 基础错误类
 * 所有自定义错误的基类
 */
export class OpenClawError extends Error {
  public readonly code: string;
  public readonly context?: ErrorContext;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: string,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    this.cause = cause;

    // 保持正确的堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * 转换为日志友好的对象
   */
  toLogObject(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      cause: this.cause
        ? {
            name: this.cause.name,
            message: this.cause.message,
          }
        : undefined,
      stack: this.stack,
    };
  }
}

/**
 * 配置错误
 */
export class ConfigError extends OpenClawError {
  constructor(message: string, context?: ErrorContext, cause?: Error) {
    super(message, "CONFIG_ERROR", context, cause);
  }
}

/**
 * API 调用错误
 */
export class APIError extends OpenClawError {
  public readonly statusCode?: number;

  constructor(
    message: string,
    statusCode?: number,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(message, "API_ERROR", context, cause);
    this.statusCode = statusCode;
  }
}

/**
 * 验证错误
 */
export class ValidationError extends OpenClawError {
  public readonly field?: string;

  constructor(
    message: string,
    field?: string,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(message, "VALIDATION_ERROR", context, cause);
    this.field = field;
  }
}

/**
 * 资源未找到错误
 */
export class NotFoundError extends OpenClawError {
  public readonly resource?: string;

  constructor(
    message: string,
    resource?: string,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(message, "NOT_FOUND", context, cause);
    this.resource = resource;
  }
}

/**
 * MCP 协议错误
 */
export class MCPError extends OpenClawError {
  public readonly toolName?: string;

  constructor(
    message: string,
    toolName?: string,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(message, "MCP_ERROR", context, cause);
    this.toolName = toolName;
  }
}

/**
 * 数据库错误
 */
export class DatabaseError extends OpenClawError {
  constructor(message: string, context?: ErrorContext, cause?: Error) {
    super(message, "DATABASE_ERROR", context, cause);
  }
}

/**
 * 网络错误
 */
export class NetworkError extends OpenClawError {
  constructor(message: string, context?: ErrorContext, cause?: Error) {
    super(message, "NETWORK_ERROR", context, cause);
  }
}

/**
 * 超时错误
 */
export class TimeoutError extends OpenClawError {
  public readonly timeoutMs?: number;

  constructor(
    message: string,
    timeoutMs?: number,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(message, "TIMEOUT_ERROR", context, cause);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 认证/授权错误
 */
export class AuthenticationError extends OpenClawError {
  constructor(message: string, context?: ErrorContext, cause?: Error) {
    super(message, "AUTHENTICATION_ERROR", context, cause);
  }
}

/**
 * 速率限制错误
 */
export class RateLimitError extends OpenClawError {
  public readonly retryAfter?: number;

  constructor(
    message: string,
    retryAfter?: number,
    context?: ErrorContext,
    cause?: Error
  ) {
    super(message, "RATE_LIMIT_ERROR", context, cause);
    this.retryAfter = retryAfter;
  }
}

/**
 * 电路断路器错误（从 resilience.ts 迁移）
 */
export class CircuitOpenError extends OpenClawError {
  constructor(message: string, context?: ErrorContext) {
    super(message, "CIRCUIT_OPEN", context);
  }
}

/**
 * 错误工具函数
 */

/**
 * 从未知错误创建 OpenClawError
 */
export function toOpenClawError(
  error: unknown,
  defaultMessage = "Unknown error"
): OpenClawError {
  if (error instanceof OpenClawError) {
    return error;
  }

  if (error instanceof Error) {
    return new OpenClawError(error.message, "UNKNOWN_ERROR", undefined, error);
  }

  return new OpenClawError(
    typeof error === "string" ? error : defaultMessage,
    "UNKNOWN_ERROR",
    { originalError: error }
  );
}

/**
 * 安全地获取错误消息
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

/**
 * 安全地获取错误堆栈
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

/**
 * 判断错误是否为特定类型
 */
export function isErrorOfType<T extends OpenClawError>(
  error: unknown,
  ErrorClass: new (...args: unknown[]) => T
): error is T {
  return error instanceof ErrorClass;
}

/**
 * HTTP 状态码映射
 */
export function errorToStatusCode(error: unknown): number {
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof RateLimitError) return 429;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ValidationError) return 400;
  if (error instanceof TimeoutError) return 504;
  if (error instanceof APIError) return error.statusCode ?? 500;
  if (error instanceof OpenClawError) return 500;
  return 500;
}

/**
 * 创建错误响应对象（用于 API 返回）
 */
export function createErrorResponse(
  error: unknown,
  includeStack = false
): Record<string, unknown> {
  const openClawError = toOpenClawError(error);

  const response: Record<string, unknown> = {
    success: false,
    error: {
      name: openClawError.name,
      code: openClawError.code,
      message: openClawError.message,
    },
  };

  if (includeStack && openClawError.stack) {
    response.error = {
      ...response.error as Record<string, unknown>,
      stack: openClawError.stack,
    };
  }

  if (openClawError.context && Object.keys(openClawError.context).length > 0) {
    response.meta = openClawError.context;
  }

  return response;
}
