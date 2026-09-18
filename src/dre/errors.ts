/**
 * DRE Error Hierarchy — Typed errors for structured error handling.
 *
 * Inspired by Pydantic AI's error model: callers can catch by category
 * (network, validation, resource, pipeline) without string-matching messages.
 *
 * Usage:
 *   try {
 *     await engine.process(input);
 *   } catch (err) {
 *     if (err instanceof DREValidationError) { ... }
 *     else if (err instanceof DREResourceError) { ... }
 *     else if (err instanceof DREPipelineError) { ... }
 *   }
 */

/** Base class for all DRE errors. */
export class DREError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }

  toJSON(): { name: string; code: string; message: string; context?: unknown } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

/** Input validation failed (bad user input, malformed config). */
export class DREValidationError extends DREError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", context);
  }
}

/** Resource budget exceeded (tokens, memory, concurrency, time). */
export class DREResourceError extends DREError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "RESOURCE_ERROR", context);
  }
}

/** Pipeline stage failed (prefilter, verification, LLM self-reasoning). */
export class DREPipelineError extends DREError {
  constructor(
    message: string,
    public readonly stage: string,
    context?: Record<string, unknown>,
  ) {
    super(message, "PIPELINE_ERROR", { ...context, stage });
  }
}

/** LLM call failed after retries (network, rate limit, bad response). */
export class DRELLMError extends DREError {
  constructor(
    message: string,
    public readonly retriable: boolean,
    context?: Record<string, unknown>,
  ) {
    super(message, "LLM_ERROR", { ...context, retriable });
  }
}

/** Knowledge store / atom store consistency issue. */
export class DREConsistencyError extends DREError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CONSISTENCY_ERROR", context);
  }
}

/** Scheduler task failed or timed out. */
export class DRETaskError extends DREError {
  constructor(
    message: string,
    public readonly taskId?: string,
    context?: Record<string, unknown>,
  ) {
    super(message, "TASK_ERROR", { ...context, taskId });
  }
}

/**
 * Wrap an unknown error into a DREError if it isn't already.
 * Preserves the original error as context.
 */
export function wrapDREError(err: unknown, defaultMessage = "Unknown error"): DREError {
  if (err instanceof DREError) return err;

  if (err instanceof Error) {
    // Heuristic: network errors → DRELLMError, validation → DREValidationError
    const msg = err.message;
    if (msg.includes("fetch") || msg.includes("connect") || msg.includes("timeout")) {
      return new DRELLMError(msg, true, { originalName: err.name });
    }
    if (msg.includes("required") || msg.includes("invalid") || msg.includes("must be")) {
      return new DREValidationError(msg, { originalName: err.name });
    }
    return new DREError(msg, "UNKNOWN", { originalName: err.name });
  }

  return new DREError(defaultMessage, "UNKNOWN", { original: String(err) });
}
