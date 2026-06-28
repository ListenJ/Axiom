/**
 * Chat Actor — Central coordinator for all chat requests.
 *
 * This actor replaces the direct function calls in chat.ts.
 * All communication goes through the Actor Runtime message passing.
 *
 * Flow:
 *   User Message → ChatActor
 *     → MemoryActor: record observation
 *     → ConstraintSolver: check constraints
 *     → RuleEngine: evaluate rules
 *     → CognitivePipeline: deterministic reasoning
 *     → CapabilityRegistry: select best capability
 *     → VerificationEngine: verify result
 *     → MemoryActor: complete episode
 *     → Response
 */

import { logger } from "../utils/logger.js";
import { eventBus, worldState } from "./kernel.js";
import type { Actor, ActorMessage } from "./kernel.js";
import { memoryEngine } from "./memory-engine.js";
import { constraintSolver } from "./constraint-solver.js";
import { ruleEngine } from "./rule-engine.js";
import { capabilityRegistry } from "./capability-registry.js";
import { verificationEngine } from "./verification-engine.js";
import { cognitivePipeline } from "./scheduler.js";
import { contextEngine } from "./context-engine.js";

// ─── Chat Request/Response ─────────────────────────────────────────────────

export interface ChatRequest {
  id: string
  input: string
  history: Array<{ role: string; content: string }>
  mode: "plan" | "agent" | "yolo"
  context?: Record<string, unknown>
}

export interface ChatResponse {
  id: string
  content: string
  model: string
  provider: string
  source: "deterministic" | "llm" | "capability"
  verification?: { passed: boolean; confidence: number; issues: string[] }
  ruleMatches: string[]
  constraintViolations: string[]
  latencyMs: number
}

// ─── Chat Actor ────────────────────────────────────────────────────────────

export class ChatActor implements Actor {
  id = "chat";
  state: "idle" | "running" | "sleeping" | "waiting" | "error" = "idle";
  private pendingRequests = new Map<string, {
    resolve: (response: ChatResponse) => void
    reject: (error: Error) => void
  }>();

  async receive(msg: ActorMessage): Promise<void> {
    if (msg.type === "chat.request") {
      this.state = "running";
      const request = msg.data as ChatRequest;

      try {
        const response = await this.processRequest(request);

        // Reply to the sender
        eventBus.publish({
          type: "chat.response",
          source: "chat-actor",
          data: response,
          priority: "normal",
          replyTo: msg.id,
        });

        // If there's a pending promise, resolve it
        const pending = this.pendingRequests.get(request.id);
        if (pending) {
          pending.resolve(response);
          this.pendingRequests.delete(request.id);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error("[ChatActor] Request failed", error);

        eventBus.publish({
          type: "chat.error",
          source: "chat-actor",
          data: { requestId: request.id, error: error.message },
          priority: "high",
          replyTo: msg.id,
        });

        const pending = this.pendingRequests.get(request.id);
        if (pending) {
          pending.reject(error);
          this.pendingRequests.delete(request.id);
        }
      } finally {
        this.state = "idle";
      }
    }
  }

  /**
   * Send a chat request and wait for the response.
   * Used by chat.ts to bridge HTTP request → Actor → HTTP response.
   */
  async requestAndWait(request: ChatRequest): Promise<ChatResponse> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });

      eventBus.publish({
        type: "chat.request",
        source: "http-handler",
        data: request,
        priority: "high",
      });

      // Timeout after 60 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(request.id)) {
          this.pendingRequests.delete(request.id);
          reject(new Error("Chat request timed out"));
        }
      }, 60_000);
    });
  }

  // ─── Private: Process Request ────────────────────────────────────────

  private async processRequest(request: ChatRequest): Promise<ChatResponse> {
    const startTime = Date.now();
    const ruleMatches: string[] = [];
    const constraintViolations: string[] = [];

    // ── Step 1: Record observation in Memory ──
    memoryEngine.observe(request.input, "user");

    // ── Step 2: Check constraints ──
    const constraintResult = constraintSolver.solve([request.input], request.context);
    if (!constraintResult.satisfied) {
      for (const violation of constraintResult.violations) {
        constraintViolations.push(violation.message);
      }
      logger.info("[ChatActor] Constraint violations", { count: constraintViolations.length });
    }

    // ── Step 3: Evaluate rules ──
    const ruleContext = {
      input: request.input,
      mode: request.mode,
      complexity: request.input.length > 200 ? "complex" : request.input.length > 50 ? "medium" : "simple",
    };
    const ruleMatchesResult = ruleEngine.evaluate(ruleContext);
    for (const match of ruleMatchesResult) {
      if (match.matched) {
        ruleMatches.push(match.rule.name);
        logger.info("[ChatActor] Rule matched", { rule: match.rule.name, action: match.rule.action });
      }
    }

    // ── Step 4: Run Cognitive Pipeline (deterministic first) ──
    const pipelineResult = await cognitivePipeline.run(request.input);

    if (pipelineResult.result && !pipelineResult.needsLLM) {
      // Deterministic answer found
      const data = pipelineResult.result as { found?: boolean; related?: string[] };
      if (data.found && data.related && data.related.length > 0) {
        const content = `Based on knowledge: ${data.related.join("; ")}`;

        // ── Step 5: Verify result ──
        const verification = verificationEngine.verifyResult(request.id, content);

        // ── Step 6: Record success in memory ──
        const episode = memoryEngine.getCurrentEpisode();
        if (episode) {
          memoryEngine.completeEpisode(episode.id, "success", undefined, content);
        }

        return {
          id: request.id,
          content,
          model: "deterministic-pipeline",
          provider: "runtime",
          source: "deterministic",
          verification: {
            passed: verification.overallVerdict === "pass",
            confidence: verification.overallConfidence,
            issues: verification.issues.map((i) => i.description),
          },
          ruleMatches,
          constraintViolations,
          latencyMs: Date.now() - startTime,
        };
      }
    }

    // ── Step 7: No deterministic answer — need LLM ──
    // Return a signal that the caller should use LLM routing
    return {
      id: request.id,
      content: "", // Empty = caller should use LLM
      model: "none",
      provider: "runtime",
      source: "llm",
      ruleMatches,
      constraintViolations,
      latencyMs: Date.now() - startTime,
    };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _chatActor: ChatActor | null = null;

export function getChatActor(): ChatActor {
  if (!_chatActor) {
    _chatActor = new ChatActor();
  }
  return _chatActor;
}
