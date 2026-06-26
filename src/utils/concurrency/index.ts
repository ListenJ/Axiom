/**
 * Lightweight async concurrency primitives — zero dependencies.
 *
 * Pick the right primitive for the failure mode you're protecting against:
 *
 *   Semaphore
 *     Caps in-flight concurrency to N. Use when "we can only do K things at
 *     once" is the only constraint. No time dimension. ~140 lines.
 *
 *   BoundedQueue
 *     Fixed-capacity FIFO. Use to buffer work between producer and consumer
 *     with explicit backpressure (push returns false when full). ~120 lines.
 *
 *   RateLimitedSemaphore
 *     Combines concurrency permits with a sliding-window RPM cap. Use when
 *     an upstream provider enforces BOTH "max K concurrent" and "max R per
 *     minute" (e.g. LLM APIs). ~150 lines.
 *
 * All three are Promise-based, single-event-loop safe, and JSDoc'd.
 * The legacy utils/RateLimiter is unaffected — keep using it for simple
 * per-key throttling without admission control.
 */

export { Semaphore, withPermits } from "./semaphore.js";
export type { Semaphore as SemaphoreType } from "./semaphore.js";

export { BoundedQueue } from "./bounded-queue.js";
export type { BoundedQueueOptions } from "./bounded-queue.js";

export { RateLimitedSemaphore } from "./rate-limited-semaphore.js";
export type { RateLimitedSemaphoreOptions } from "./rate-limited-semaphore.js";