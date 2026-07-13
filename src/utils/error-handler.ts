/**
 * Error Handler — Provides helpful error messages and recovery suggestions.
 */
import { logger } from "../utils/logger.js";

export interface ErrorContext {
  operation: string
  source?: string
  originalError: string
  metadata?: Record<string, unknown>
}

export interface HelpfulError {
  message: string
  cause: string
  suggestions: string[]
  severity: "low" | "medium" | "high" | "critical"
  retryable: boolean
}

export function generateHelpfulError(ctx: ErrorContext): HelpfulError {
  const error = ctx.originalError.toLowerCase();

  if (error.includes("econnrefused") || error.includes("enotfound") || error.includes("timeout")) {
    return {
      message: `Network error during ${ctx.operation}`,
      cause: "The remote service is unavailable or the connection timed out",
      suggestions: [
        "Check your internet connection",
        "Verify the API endpoint is correct",
        "Try again in a few seconds",
        "Check if the service is down (status page)",
      ],
      severity: "medium",
      retryable: true,
    };
  }

  if (error.includes("401") || error.includes("unauthorized") || error.includes("api key")) {
    return {
      message: `Authentication failed during ${ctx.operation}`,
      cause: "Invalid or missing API key",
      suggestions: [
        "Check your API key in .env file",
        "Verify the key hasn't expired",
        "Ensure the key has the required permissions",
      ],
      severity: "high",
      retryable: false,
    };
  }

  if (error.includes("429") || error.includes("rate limit") || error.includes("too many requests")) {
    return {
      message: `Rate limited during ${ctx.operation}`,
      cause: "Too many requests to the API",
      suggestions: [
        "Wait a few seconds before retrying",
        "Reduce request frequency",
        "Check your API plan limits",
      ],
      severity: "low",
      retryable: true,
    };
  }

  if (error.includes("model") && (error.includes("not found") || error.includes("unavailable"))) {
    return {
      message: `Model unavailable for ${ctx.operation}`,
      cause: "The requested model is not available",
      suggestions: [
        "Try a different model",
        "Check model availability in /eval/stats",
        "The system will auto-fallback to another model",
      ],
      severity: "medium",
      retryable: true,
    };
  }

  if (ctx.source && error.includes("tool")) {
    return {
      message: `Tool execution failed: ${ctx.source}`,
      cause: "The tool encountered an error during execution",
      suggestions: [
        "Check tool parameters",
        "Verify the tool is available",
        "Try with different parameters",
        "Check /health for tool status",
      ],
      severity: "medium",
      retryable: true,
    };
  }

  if (error.includes("enoent") || error.includes("file not found")) {
    return {
      message: `File not found during ${ctx.operation}`,
      cause: "The requested file does not exist",
      suggestions: [
        "Check the file path",
        "Ensure the file exists",
        "Use fs_list to browse available files",
      ],
      severity: "low",
      retryable: false,
    };
  }

  if (error.includes("eacces") || error.includes("permission denied")) {
    return {
      message: `Permission denied during ${ctx.operation}`,
      cause: "Insufficient permissions to access the resource",
      suggestions: [
        "Check file permissions",
        "Run with appropriate user privileges",
        "Ensure the file is not locked by another process",
      ],
      severity: "medium",
      retryable: false,
    };
  }

  if (error.includes("planning") || error.includes("plan")) {
    return {
      message: `Planning failed during ${ctx.operation}`,
      cause: "The planning phase encountered an error",
      suggestions: [
        "The system will use a simple passthrough plan",
        "Try rephrasing your request",
        "Break down complex requests into smaller parts",
      ],
      severity: "low",
      retryable: true,
    };
  }

  return {
    message: `Error during ${ctx.operation}`,
    cause: ctx.originalError,
    suggestions: [
      "Try again",
      "Check /health for system status",
      "Simplify your request if it was complex",
    ],
    severity: "medium",
    retryable: true,
  };
}

export function formatErrorForResponse(error: HelpfulError): {
  error: string
  cause: string
  suggestions: string[]
  severity: string
  retryable: boolean
} {
  return {
    error: error.message,
    cause: error.cause,
    suggestions: error.suggestions,
    severity: error.severity,
    retryable: error.retryable,
  };
}

export function logHelpfulError(ctx: ErrorContext, error: HelpfulError): void {
  const err = new Error(error.message)
  logger.error(`[${ctx.source ?? "System"}] ${error.message}`, err, {
    severity: error.severity,
    retryable: error.retryable,
    cause: error.cause,
    originalError: ctx.originalError,
    operation: ctx.operation,
  })
}
