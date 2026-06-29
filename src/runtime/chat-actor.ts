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
import { eventBus } from "./kernel.js";
import type { Actor, ActorMessage } from "./kernel.js";
import { memoryEngine } from "./memory-engine.js";
import { constraintSolver } from "./constraint-solver.js";
import { ruleEngine } from "./rule-engine.js";
import { capabilityRegistry } from "./capability-registry.js";
import { verificationEngine } from "./verification-engine.js";
import { cognitivePipeline } from "./scheduler.js";
import { contextEngine } from "./context-engine.js";
import { reasoningGraphBuilder } from "./reasoning-graph.js";
import { mentalModelManager } from "./mental-model.js";
import { agentExecutor } from "./agent-executor.js";

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
  simulations?: Array<{ domain: string; outcome: string; confidence: number }>
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

    // ── Step 0: Build unified context ──
    const context = await contextEngine.build(request.input, {
      history: request.history,
      mode: request.mode,
      metadata: request.context,
    });

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

    // ── Step 3.5: Mental model simulation ──
    const models = mentalModelManager.getModels();
    const simulations: Array<{ domain: string; outcome: string; confidence: number }> = [];
    for (const model of models.slice(0, 3)) {
      const sim = mentalModelManager.simulate(model.id, request.input, {
        context: context.goals.map((g) => g.description),
        constraints: constraintViolations,
      });
      if (sim) {
        simulations.push({
          domain: model.domain,
          outcome: sim.outcome,
          confidence: sim.confidence,
        });
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
          simulations,
          latencyMs: Date.now() - startTime,
        };
      }
    }

    // ── Step 5: Build Reasoning Graph (break LLM black box) ──
    const knowledgeResults = memoryEngine.search(request.input, 5);
    const reasoningGraph = reasoningGraphBuilder.build(request.input, {
      knowledge: knowledgeResults.knowledge.map((k) => ({
        id: k.id,
        content: k.statement,
        confidence: k.confidence,
      })),
    });

    logger.info("[ChatActor] Reasoning graph built", {
      nodes: reasoningGraph.nodes.length,
      gaps: reasoningGraph.gaps.length,
      completeness: reasoningGraph.completeness,
      needsLLM: reasoningGraph.needsLLM,
    });

    // If reasoning graph has gaps, they become specific LLM queries
    if (reasoningGraph.needsLLM && reasoningGraph.llmQueries.length > 0) {
      eventBus.publish({
        type: "reasoning.gaps_detected",
        source: "chat-actor",
        data: {
          gaps: reasoningGraph.llmQueries,
          completeness: reasoningGraph.completeness,
        },
        priority: "normal",
      });
    }

    // ── Step 6: No deterministic answer — use Agent Executor ──
    // Delegate to agent executor for capability-based execution
    try {
      const agentReport = await agentExecutor.execute({
        id: request.id,
        description: request.input,
        resources: [],
        constraints: constraintViolations,
        goal: "answer user question",
        priority: "normal",
        metadata: { mode: request.mode, simulations },
      });

      if (agentReport.status === "completed" && agentReport.result) {
        const agentResult = agentReport.result as { results?: unknown[] };
        if (agentResult.results && agentResult.results.length > 0) {
          const content = JSON.stringify(agentResult.results.slice(0, 3));
          return {
            id: request.id,
            content,
            model: "agent-executor",
            provider: "runtime",
            source: "capability",
            ruleMatches,
            constraintViolations,
            simulations,
            latencyMs: Date.now() - startTime,
          };
        }
      }
    } catch { /* fall through to LLM signal */ }

    // ── Step 7: No deterministic answer — need LLM ──
    return {
      id: request.id,
      content: "", // Empty = caller should use LLM
      model: "none",
      provider: "runtime",
      source: "llm",
      ruleMatches,
      constraintViolations,
      simulations,
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
