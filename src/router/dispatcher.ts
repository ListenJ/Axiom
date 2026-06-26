/**
 * Dispatcher — bounded-concurrency wrapper around `router.executeWithRole`.
 *
 * Why this exists:
 *   - `router.batchExecute()` currently fires `Promise.all(assignments.map(...))`,
 *     which is unbounded. A 1000-assignment batch would launch 1000 HTTP
 *     requests simultaneously, exhausting undici's per-host connection pool
 *     (default 256) and likely tripping upstream rate limits.
 *   - The legacy `ToolModelPool` rolls its own activeRequests counter and
 *     sliding-window RPM array. Both have O(n) hot paths and no shared
 *     backpressure semantics with the router.
 *
 * What this provides:
 *   - A single Semaphore (default 256 permits) gating all upstream model
 *     calls. Tunable per-process; the cap is well above undici's pool so the
 *     limiter is the upstream provider, not the dispatcher.
 *   - `dispatch(role, messages)` — single call under the semaphore.
 *   - `dispatchBatch(assignments, opts)` — bounded-concurrency batch that
 *     replaces router.batchExecute. Same return shape (parallel results in
 *     input order); errors are caught per-item and surfaced as
 *     `{ content: "Error: ..." }` results, matching router.batchExecute.
 *   - `dispatchStream(assignments)` — async iterator yielding results in
 *     completion order, useful for UI consumers that want to render as soon
 *     as each sub-agent finishes.
 *
 * What this does NOT do (deferred to later phases):
 *   - Per-model RPM gates (tool-pool responsibility). The semaphore here is
 *     global; finer-grained caps belong to model selection, not admission.
 *   - Retry/backoff on transient errors. The router's own fallback chain
 *     handles that today; dispatcher only adds bounded concurrency.
 */

import {
  router,
  type ChatMessage,
  type RoleAssignment,
  type SmartAssignmentResponse,
  type TaskRole,
} from "./model-router.js";
import { Semaphore } from "../utils/concurrency/semaphore.js";
import { logger } from "../utils/logger.js";

export interface DispatcherOptions {
  /**
   * Global concurrency cap for in-flight model calls. Default 256, which
   * sits comfortably above undici's default per-host pool (256) so the
   * limiter stays invisible for ordinary HTTP traffic but still bounds
   * catastrophic bursts at ~1000.
   */
  permits?: number;
  /**
   * Soft cap on queued (waiting) callers. When reached, dispatch() rejects
   * with a `queue-overflow` error rather than blocking forever. Default 4096.
   */
  maxQueue?: number;
}

export class Dispatcher {
  private readonly _sem: Semaphore;
  private readonly _maxQueue: number;

  constructor(opts: DispatcherOptions = {}) {
    const permits = opts.permits ?? 256;
    const maxQueue = opts.maxQueue ?? 4096;
    if (permits < 1) {
      throw new RangeError(`Dispatcher permits must be ≥ 1 (got ${permits})`);
    }
    this._sem = new Semaphore(permits);
    this._maxQueue = maxQueue;
  }

  get permits(): number {
    return this._sem.permits;
  }

  get active(): number {
    return this._sem.active;
  }

  /** Number of callers currently waiting on the semaphore (NOT in-flight). */
  get waiting(): number {
    return this._sem.waiting;
  }

  /**
   * Run a single model call under the semaphore. Rejects with
   * `Error("queue-overflow")` if the waiting queue is at capacity.
   *
   * The check uses `sem.waiting` (not a separate counter) so in-flight
   * calls don't consume the queue budget — only callers that would actually
   * block count toward the cap.
   */
  async dispatch(
    role: TaskRole,
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number; excludeModels?: string[] }
  ): Promise<SmartAssignmentResponse> {
    if (this._sem.waiting >= this._maxQueue) {
      throw new Error("queue-overflow");
    }
    return this._sem.withPermit(() =>
      router.executeWithRole(role, messages, options)
    );
  }

  /**
   * Run a batch of role assignments under the same bounded semaphore.
   *
   * Returns results in INPUT ORDER. Per-item errors are caught and surfaced
   * as `{ role, content: "Error: …", model: "error", provider: "error", … }`,
   * matching the legacy router.batchExecute contract.
   */
  async dispatchBatch(
    assignments: RoleAssignment[],
    opts?: { preventDuplicateModels?: boolean }
  ): Promise<SmartAssignmentResponse[]> {
    const usedModels: string[] = [];
    return Promise.all(
      assignments.map((a, idx) =>
        this.dispatch(a.role, a.messages, {
          temperature: a.temperature,
          maxTokens: a.maxTokens,
          excludeModels: opts?.preventDuplicateModels ? [...usedModels] : undefined,
        })
          .then((res) => {
            if (opts?.preventDuplicateModels) usedModels.push(res.model);
            return res;
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[Dispatcher] assignment ${idx} (${a.role}) failed`, {
              error: msg,
              role: a.role,
              assignmentIndex: idx,
            });
            return {
              role: a.role,
              model: "error",
              provider: "error",
              endpoint: "",
              content: `Error: ${msg}`,
              latency_ms: 0,
              fallback_used: true,
            } as SmartAssignmentResponse;
          })
      )
    );
  }

  /**
   * Stream sub-agent results as they complete (NOT in input order).
   *
   * Use case: UI wants to render a streaming dashboard where the slowest
   * sub-agent shouldn't block rendering of the fastest. The semaphore still
   * gates total concurrency; only the ordering changes.
   */
  async *dispatchStream(
    assignments: RoleAssignment[],
    opts?: { preventDuplicateModels?: boolean }
  ): AsyncGenerator<{ index: number; result: SmartAssignmentResponse }, void, void> {
    const usedModels: string[] = [];
    const promises = assignments.map((a, idx) =>
      this.dispatch(a.role, a.messages, {
        temperature: a.temperature,
        maxTokens: a.maxTokens,
        excludeModels: opts?.preventDuplicateModels ? [...usedModels] : undefined,
      })
        .then((res) => {
          if (opts?.preventDuplicateModels) usedModels.push(res.model);
          return { index: idx, result: res };
        })
        .catch((err): { index: number; result: SmartAssignmentResponse } => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[Dispatcher] stream assignment ${idx} (${a.role}) failed`, {
            error: msg,
            role: a.role,
            assignmentIndex: idx,
          });
          return {
            index: idx,
            result: {
              role: a.role,
              model: "error",
              provider: "error",
              endpoint: "",
              content: `Error: ${msg}`,
              latency_ms: 0,
              fallback_used: true,
            },
          };
        })
    );
    for (const p of promises) yield await p;
  }

  /** Reject all queued callers (e.g. on shutdown). In-flight work is unaffected. */
  close(reason = "Dispatcher closed"): void {
    this._sem.close(reason);
  }
}

/**
 * Process-wide default dispatcher. Constructed lazily so importing this
 * module does not allocate a Semaphore (which matters for unit tests that
 * never invoke dispatch).
 */
let _default: Dispatcher | null = null;

export function getDispatcher(): Dispatcher {
  if (!_default) _default = new Dispatcher();
  return _default;
}

/** Test seam: replace the default dispatcher. No-op outside tests. */
export function _setDispatcherForTest(d: Dispatcher | null): void {
  if (process.env.NODE_ENV === "production") return;
  _default = d;
}

export { router };
export type { ChatMessage, RoleAssignment, SmartAssignmentResponse, TaskRole };