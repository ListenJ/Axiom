/**
 * 统一错误处理系统
 * 提供类型化的错误类，支持上下文信息和结构化日志
 */

interface ErrorContext {
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
 * 电路断路器错误（从 resilience.ts 迁移）
 */
export class CircuitOpenError extends OpenClawError {
  constructor(message: string, context?: ErrorContext) {
    super(message, "CIRCUIT_OPEN", context);
  }
}

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
