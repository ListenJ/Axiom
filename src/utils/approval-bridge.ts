/**
 * HITL (Human-in-the-Loop) Approval Bridge.
 *
 * Phase P0-1: turns `ExecutionModeManager.requestApproval()` from a no-op
 * auto-approver into a real WebSocket-driven confirmation handshake.
 *
 * Design:
 *   - ApprovalBridge owns the `pendingApprovals` Map. Every call to
 *     `request(tool, args)` allocates a unique id, registers a Promise,
 *     and emits an "approval.requested" event. The matching `resolve(id,
 *     approved, reason?)` settles the promise.
 *   - A default timeout (60s) auto-denies. The pending entry is removed
 *     and the promise rejects with `Error("approval-timeout")`.
 *   - The bridge is exposed to the ExecutionModeManager via a setter
 *     (`setApprovalBridge`). This keeps execution-mode.ts framework-agnostic
 *     and unit-testable.
 *   - The WebSocket layer subscribes via `onRequest(handler)` and calls
 *     `resolve(id, approved)` when the user clicks approve/deny in the
 *     dashboard. The bridge emits "resolved" callbacks so the WS layer
 *     can confirm delivery to the originating client.
 *
 * Wire format (WebSocket message):
 *   {
 *     type: "approval.requested",
 *     payload: { id, tool, args, risk, requestedAt, timeoutMs }
 *   }
 *   {
 *     type: "approval.resolved",
 *     payload: { id, approved, reason, resolvedAt }
 *   }
 */

import { randomUUID } from "node:crypto";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

export type ApprovalRisk = "safe" | "caution" | "destructive" | "unknown";

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: unknown;
  risk: ApprovalRisk;
  requestedAt: number;
  timeoutMs: number;
}

export interface ApprovalResolution {
  id: string;
  approved: boolean;
  reason?: string;
  resolvedAt: number;
}

export type ApprovalRequestHandler = (req: ApprovalRequest) => void | Promise<void>;
export type ApprovalResolveHandler = (res: ApprovalResolution) => void | Promise<void>;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000; // 5 minutes hard cap

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onResolved?: ApprovalResolveHandler;
}

export class ApprovalBridge {
  private readonly _pending = new Map<string, PendingEntry>();
  private _requestHandlers: ApprovalRequestHandler[] = [];

  /** Number of approvals currently waiting for a user response. */
  get pendingCount(): number {
    return this._pending.size;
  }

  /** Snapshot of pending requests (for /api/approvals endpoint or dashboards). */
  listPending(): ApprovalRequest[] {
    return Array.from(this._pending.values()).map((e) => e.request);
  }

  /** Subscribe to new approval requests. Returns an unsubscribe function. */
  onRequest(handler: ApprovalRequestHandler): () => void {
    this._requestHandlers.push(handler);
    return () => {
      const i = this._requestHandlers.indexOf(handler);
      if (i >= 0) this._requestHandlers.splice(i, 1);
    };
  }

  /**
   * Submit an approval request. Returns a Promise that:
   *   - resolves `true` if the user approved,
   *   - resolves `false` if the user denied,
   *   - rejects with `Error("approval-timeout")` if the user didn't respond
   *     within `timeoutMs` (capped at MAX_TIMEOUT_MS).
   *
   * If no request handler is registered (e.g. CLI / test mode), the
   * request auto-resolves after a short delay (1s) with `approved: false`
   * to fail safe. Callers that want auto-approval should use YOLO mode
   * and skip calling this altogether.
   */
  async request(
    tool: string,
    args: unknown,
    options: { risk?: ApprovalRisk; timeoutMs?: number; onResolved?: ApprovalResolveHandler } = {},
  ): Promise<boolean> {
    const id = randomUUID();
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const req: ApprovalRequest = {
      id,
      tool,
      args,
      risk: options.risk ?? "unknown",
      requestedAt: Date.now(),
      timeoutMs,
    };

    return new Promise<boolean>((resolve, reject) => {
      // The timer deliberately keeps the event loop alive — callers may
      // be awaiting the Promise with nothing else on the loop, and we
      // don't want the timeout to fire after the process exits. (Earlier
      // versions called .unref() and tests that awaited a single approval
      // were terminated before the timeout could fire.)
      const timer = setTimeout(() => {
        this._settle(id, false, "approval-timeout");
      }, timeoutMs);

      this._pending.set(id, {
        request: req,
        resolve,
        reject,
        timer,
        ...(options.onResolved ? { onResolved: options.onResolved } : {}),
      });

      // Fire-and-forget: any handler error is logged but does not reject
      // the approval. The user response is what settles the promise.
      void this._emit(req);
    });
  }

  /**
   * Settle a pending approval. Returns true if a matching request was
   * found, false otherwise (e.g. already timed out, or unknown id).
   */
  resolve(id: string, approved: boolean, reason?: string): boolean {
    return this._settle(id, approved, reason);
  }

  /** Reject all pending approvals (e.g. on shutdown). */
  denyAll(reason = "shutdown"): number {
    let n = 0;
    for (const id of Array.from(this._pending.keys())) {
      if (this._settle(id, false, reason)) n++;
    }
    return n;
  }

  // ----- internals -----

  private _settle(id: string, approved: boolean, reason?: string): boolean {
    const entry = this._pending.get(id);
    if (!entry) return false;
    this._pending.delete(id);
    clearTimeout(entry.timer);
    const resolution: ApprovalResolution = {
      id,
      approved,
      resolvedAt: Date.now(),
      ...(reason ? { reason } : {}),
    };
    if (approved) entry.resolve(true);
    else if (reason === "approval-timeout" || reason === "shutdown")
      entry.reject(new Error(reason));
    else entry.resolve(false);

    if (entry.onResolved) {
      try {
        void entry.onResolved(resolution);
      } catch (err) {
        logger.warn(`[ApprovalBridge] onResolved handler threw`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return true;
  }

  private async _emit(req: ApprovalRequest): Promise<void> {
    if (this._requestHandlers.length === 0) {
      // No WS layer attached. Auto-deny after 1s so the calling tool fails
      // closed. Callers that want auto-approve should not invoke this.
      logger.warn(
        `[ApprovalBridge] no handlers for ${req.tool} (${req.risk}); auto-denying in 1s`,
      );
      // Note: we don't unref() the no-handler timer because doing so lets
      // the event loop exit early when nothing else is keeping it alive
      // (e.g. in unit tests that only await a single Promise).
      setTimeout(() => this._settle(req.id, false, "no-handler"), 1000);
      return;
    }
    for (const h of this._requestHandlers) {
      try {
        await h(req);
      } catch (err) {
        logger.warn(`[ApprovalBridge] request handler threw for ${req.id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** Process-wide default bridge; replace via setApprovalBridge in tests. */
let _bridge: ApprovalBridge = new ApprovalBridge();

export function getApprovalBridge(): ApprovalBridge {
  return _bridge;
}

export function setApprovalBridge(bridge: ApprovalBridge): void {
  if (readString("NODE_ENV") === "production") return;
  // Deny any in-flight approvals from the old bridge before swapping.
  _bridge.denyAll("bridge-replaced");
  _bridge = bridge;
}