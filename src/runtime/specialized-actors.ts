/**
 * Specialized Actors — 万物皆 Actor
 *
 * 将关键模块微观化为 Actor，通过 EventBus 通信。
 * 不再有 functionA.call(functionB)，全部变成 message passing。
 */

import { logger } from "../utils/logger.js";
import { eventBus, actorRuntime } from "./kernel.js";
import type { Actor, ActorMessage } from "./kernel.js";

// ─── Knowledge Actor ───────────────────────────────────────────────────────

/**
 * Knowledge Actor — 负责知识网络的一致性和查询。
 */
export class KnowledgeActor implements Actor {
  id = "knowledge";
  state: "idle" | "running" | "sleeping" | "waiting" | "error" = "idle";

  async receive(msg: ActorMessage): Promise<void> {
    this.state = "running";

    try {
      const { knowledgeNetwork } = await import("./knowledge-network.js");

      switch (msg.type) {
        case "knowledge.search": {
          const { query, limit } = msg.data as { query: string; limit?: number };
          const results = knowledgeNetwork.search(query, limit ?? 10);
          eventBus.publish({
            type: "knowledge.search.result",
            source: "knowledge-actor",
            data: { results: results.map((r) => ({ id: r.id, name: r.name, content: r.content.slice(0, 200) })) },
            priority: "normal",
            replyTo: msg.id,
          });
          break;
        }

        case "knowledge.create": {
          const { kind, name, content, opts } = msg.data as { kind: string; name: string; content: string; opts?: Record<string, unknown> };
          const entity = knowledgeNetwork.create(kind as any, name, content, opts as any);
          eventBus.publish({
            type: "knowledge.created",
            source: "knowledge-actor",
            data: { id: entity.id, kind: entity.kind, name: entity.name },
            priority: "normal",
            replyTo: msg.id,
          });
          break;
        }

        case "knowledge.update_state": {
          const { id, state } = msg.data as { id: string; state: string };
          knowledgeNetwork.updateState(id, state);
          break;
        }

        case "knowledge.add_behavior": {
          const { id, behavior } = msg.data as { id: string; behavior: any };
          knowledgeNetwork.addBehavior(id, behavior);
          break;
        }

        case "knowledge.add_prediction": {
          const { id, prediction } = msg.data as { id: string; prediction: any };
          knowledgeNetwork.addPrediction(id, prediction);
          break;
        }
      }
    } catch (err) {
      logger.error("[KnowledgeActor] Failed", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.state = "idle";
    }
  }
}

// ─── Constraint Actor ──────────────────────────────────────────────────────

/**
 * Constraint Actor — 监听所有 Proposed Action，独立发出 Veto 消息。
 */
export class ConstraintActor implements Actor {
  id = "constraint";
  state: "idle" | "running" | "sleeping" | "waiting" | "error" = "idle";

  async receive(msg: ActorMessage): Promise<void> {
    this.state = "running";

    try {
      const { constraintSolver } = await import("./constraint-solver.js");

      switch (msg.type) {
        case "constraint.check": {
          const { entities, context } = msg.data as { entities: string[]; context?: Record<string, unknown> };
          const result = constraintSolver.solve(entities, context);

          if (!result.satisfied) {
            eventBus.publish({
              type: "constraint.veto",
              source: "constraint-actor",
              data: {
                violations: result.violations.map((v) => ({
                  type: v.constraint.type,
                  message: v.message,
                  severity: v.severity,
                })),
              },
              priority: "high",
            });
          }

          eventBus.publish({
            type: "constraint.result",
            source: "constraint-actor",
            data: { satisfied: result.satisfied, violations: result.violations.length },
            priority: "normal",
            replyTo: msg.id,
          });
          break;
        }

        case "constraint.learn": {
          const { source, type, target, evidence, confidence, dimension } = msg.data as {
            source: string; type: string; target: string; evidence: string; confidence?: number; dimension?: string;
          };
          constraintSolver.learn(source, type as any, target, evidence, confidence, dimension as any);
          break;
        }
      }
    } catch (err) {
      logger.error("[ConstraintActor] Failed", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.state = "idle";
    }
  }
}

// ─── Verification Actor ────────────────────────────────────────────────────

/**
 * Verification Actor — 独立验证输入、推理、执行、结果。
 */
export class VerificationActor implements Actor {
  id = "verification";
  state: "idle" | "running" | "sleeping" | "waiting" | "error" = "idle";

  async receive(msg: ActorMessage): Promise<void> {
    this.state = "running";

    try {
      const { verificationEngine } = await import("./verification-engine.js");

      switch (msg.type) {
        case "verification.verify_input": {
          const { taskId, input } = msg.data as { taskId: string; input: unknown };
          const result = verificationEngine.verifyInput(taskId, input);
          eventBus.publish({
            type: "verification.result",
            source: "verification-actor",
            data: { taskId, stage: "input", verdict: result.overallVerdict, confidence: result.overallConfidence },
            priority: "normal",
            replyTo: msg.id,
          });
          break;
        }

        case "verification.verify_result": {
          const { taskId, result } = msg.data as { taskId: string; result: unknown };
          const report = verificationEngine.verifyResult(taskId, result as string);
          eventBus.publish({
            type: "verification.result",
            source: "verification-actor",
            data: { taskId, stage: "result", verdict: report.overallVerdict, confidence: report.overallConfidence },
            priority: "normal",
            replyTo: msg.id,
          });
          break;
        }
      }
    } catch (err) {
      logger.error("[VerificationActor] Failed", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.state = "idle";
    }
  }
}

// ─── Projection Actor ──────────────────────────────────────────────────────

/**
 * Projection Actor — 异步处理数据同步，不阻塞主流程。
 */
export class ProjectionActor implements Actor {
  id = "projection";
  state: "idle" | "running" | "sleeping" | "waiting" | "error" = "idle";

  async receive(msg: ActorMessage): Promise<void> {
    this.state = "running";

    try {
      const { projectionRegistry } = await import("./projection-layer.js");

      switch (msg.type) {
        case "projection.sync": {
          const result = await projectionRegistry.syncAll();
          eventBus.publish({
            type: "projection.synced",
            source: "projection-actor",
            data: { synced: result.synced, errors: result.errors.length },
            priority: "low",
            replyTo: msg.id,
          });
          break;
        }

        case "projection.rebuild": {
          await projectionRegistry.rebuildAll();
          eventBus.publish({
            type: "projection.rebuilt",
            source: "projection-actor",
            data: {},
            priority: "low",
            replyTo: msg.id,
          });
          break;
        }
      }
    } catch (err) {
      logger.error("[ProjectionActor] Failed", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.state = "idle";
    }
  }
}

// ─── Initialize All Actors ─────────────────────────────────────────────────

/**
 * Register all specialized actors.
 */
export function initSpecializedActors(): void {
  actorRuntime.register(new KnowledgeActor());
  actorRuntime.register(new ConstraintActor());
  actorRuntime.register(new VerificationActor());
  actorRuntime.register(new ProjectionActor());

  // Wire events to actors
  eventBus.subscribe("constraint.check_requested", (evt) => {
    const data = evt.data as { entities: string[] };
    actorRuntime.send({
      from: "system",
      to: "constraint",
      type: "constraint.check",
      data: { entities: data.entities },
    });
  });

  eventBus.subscribe("projection.sync_requested", () => {
    actorRuntime.send({
      from: "system",
      to: "projection",
      type: "projection.sync",
      data: {},
    });
  });

  logger.info("[Actors] Initialized specialized actors (knowledge, constraint, verification, projection)");
}
