/**
 * InternalAgent — Lightweight wrapper around model-router for internal agents.
 *
 * Purpose
 *   - Centralize the "call an LLM from inside this codebase" pattern so that
 *     retry / fallback / timeout / tracking / metrics are inherited for free.
 *   - Keep the API surface small: role + messages + a few options, returning
 *     the model text content.
 *   - Stay stateless: no long-lived state, no extra network plumbing — we just
 *     delegate to `MultiPlatformRouter` from `src/router/model-router.ts`.
 *
 * Design notes
 *   - This is a *thin* wrapper. It does not add retry/fallback/timeout — those
 *     already live in the router. It only normalizes the call shape so internal
 *     agents don't reinvent the boilerplate.
 *   - For "custom external tool APIs" (Kimi Code, MiniMax MCP, etc.) that use
 *     non-standard endpoints, this wrapper is intentionally NOT used; they
 *     remain direct because they are outside the standard model registry.
 *
 * Usage
 *   ```ts
 *   import { internalAgent } from "./internal-agent.js";
 *
 *   // Buffered chat
 *   const { content } = await internalAgent.chat([
 *     { role: "system", content: "You are a helpful assistant." },
 *     { role: "user", content: "Hello" },
 *   ]);
 *
 *   // Role-routed chat
 *   const review = await internalAgent.chat(messages, "code-review", { temperature: 0.3 });
 *
 *   // Streaming
 *   for await (const ev of internalAgent.stream("general-chat", messages)) {
 *     if (ev.type === "token") process.stdout.write(ev.content);
 *   }
 *
 *   // Execute with role (for SmartAssignmentResponse / fallback control)
 *   const result = await internalAgent.executeWithRole("research", messages);
 *   ```
 */

import {
  router,
  type ChatMessage,
  type SmartAssignmentResponse,
} from "../router/model-router.js";
import type { TaskRole } from "../router/models.js";

// ChatStreamEvent type (not yet in model-router)
type ChatStreamEvent = { role: string; content: string; done: boolean };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options accepted by every InternalAgent method. */
export interface InternalChatOptions {
  /** Sampling temperature (0-2). Passed through to the router. */
  temperature?: number;
  /** Cap on completion tokens. Passed through to the router. */
  maxTokens?: number;
  /** Per-call timeout in ms. Overrides the role's default timeout. */
  timeout?: number;
  /** External abort signal. Bridged into the router's internal controller. */
  signal?: AbortSignal;
  /** Exclude specific model IDs from assignment (passed to `executeWithRole`). */
  excludeModels?: string[];
  /** Custom label used for token tracking / metrics. Defaults to the role. */
  trackAs?: string;
}

/** Minimal chat result shape returned by `internalAgent.chat`. */
export interface InternalChatResult {
  content: string;
  model: string;
  provider: string;
  latencyMs: number;
  fallbackUsed: boolean;
}

/** Default role when none is supplied. Matches the router's DEFAULT_ROLE. */
const DEFAULT_ROLE: TaskRole = "general-chat";

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Buffered chat completion with role-based routing.
 *
 * Returns the model's text content (empty string when the router signals a
 * degraded response with no content). Inherits retry, fallback, timeout and
 * tracking from the router.
 */
export async function chat(
  messages: ChatMessage[],
  role: TaskRole = DEFAULT_ROLE,
  options: InternalChatOptions = {},
): Promise<InternalChatResult> {
  const result = await router.execute({
    role,
    messages,
    timeout: options.timeout,
    temperature: options.temperature,
    trackAs: options.trackAs ?? role,
  });

  return {
    content: result.content ?? "",
    model: result.model,
    provider: result.provider,
    latencyMs: result.latencyMs,
    fallbackUsed: result.fallbackUsed,
  };
}

/**
 * Role-routed execution that returns full `SmartAssignmentResponse` metadata.
 * Use this when you need to inspect the chosen endpoint, model id, or latency
 * (e.g. for logging or for callers that already handle their own fallbacks).
 */
export async function executeWithRole(
  role: TaskRole,
  messages: ChatMessage[],
  options: InternalChatOptions = {},
): Promise<SmartAssignmentResponse> {
  return router.executeWithRole(role, messages, {
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    excludeModels: options.excludeModels,
  });
}

/**
 * Streaming chat completion. Yields `ChatStreamEvent`s from the router.
 * Use the default role when `role` is omitted.
 */
export async function* stream(
  role: TaskRole,
  messages: ChatMessage[],
  options: { intent?: string; preferNativeStream?: boolean } = {},
): AsyncGenerator<ChatStreamEvent> {
  yield* (router as any).chatStream(role, messages, options);
}

/** Streaming chat with the default `general-chat` role. */
export async function* streamDefault(
  messages: ChatMessage[],
  options: { intent?: string; preferNativeStream?: boolean } = {},
): AsyncGenerator<ChatStreamEvent> {
  yield* (router as any).chatStream(DEFAULT_ROLE, messages, options);
}

// ---------------------------------------------------------------------------
// Stateless object-style surface
// ---------------------------------------------------------------------------

/**
 * Default export — a stateless handle that exposes the same methods.
 * Internal agents should import this object rather than instantiating anything.
 */
export const internalAgent = {
  chat,
  executeWithRole,
  stream,
  streamDefault,
};

export default internalAgent;
