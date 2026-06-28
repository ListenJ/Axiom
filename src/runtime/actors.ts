/**
 * Actor Implementations — All modules as actors with message passing
 *
 * Each actor:
 * - Receives messages via the Actor Runtime
 * - Publishes events to the Event Bus
 * - Reads/writes World State
 * - No direct calls to other modules
 */

import { logger } from "../utils/logger.js";
import { actorRuntime, eventBus, worldState } from "./kernel.js";
import { atomStore } from "./atom-engine.js";
import type { Actor, ActorMessage } from "./kernel.js";

// ─── Memory Actor ──────────────────────────────────────────────────────────

/**
 * Memory Actor — handles all memory operations via message passing.
 * Replaces direct function calls to memory modules.
 */
class MemoryActor implements Actor {
  id = "memory";
  state: "idle" | "running" | "sleeping" | "waiting" | "error" = "idle";

  async receive(msg: ActorMessage): Promise<void> {
    this.state = "running";

    switch (msg.type) {
      case "memory.search": {
        const query = msg.data as { query: string; limit?: number };
        const results = atomStore.search(query.query, query.limit ?? 10);
        eventBus.publish({
          type: "memory.search.result",
          source: "memory",
          data: { query: query.query, results: results.map((r) => ({ id: r.id, content: r.content.slice(0, 200) })) },
          priority: "normal",
          replyTo: msg.id,
        });
        break;
      }

      case "memory.store": {
        const data = msg.data as { kind: string; content: string; source: string };
        const atom = atomStore.create(data.kind as any, data.content, { source: data.source });
        eventBus.publish({
          type: "memory.stored",
          source: "memory",
          data: { id: atom.id, kind: atom.kind },
          priority: "normal",
          replyTo: msg.id,
        });
        break;
      }

      case "memory.relate": {
        const data = msg.data as { sourceId: string; targetId: string; type: string };
        const ok = atomStore.relate(data.sourceId, data.targetId, data.type as any);
        eventBus.publish({
          type: "memory.related",
          source: "memory",
          data: { ok, sourceId: data.sourceId, targetId: data.targetId },
          priority: "normal",
          replyTo: msg.id,
        });
        break;
      }

      default:
        logger.debug("[MemoryActor] Unknown message type", { type: msg.type });
    }

    this.state = "idle";
  }
}

// ─── Reflection Actor ──────────────────────────────────────────────────────

/**
 * Reflection Actor — handles reflection and learning via message passing.
 */
class ReflectionActor implements Actor {
  id = "reflection";
  state: "idle" | "running" | "sleeping" | "waiting" | "error" = "idle";

  async receive(msg: ActorMessage): Promise<void> {
    this.state = "running";

    switch (msg.type) {
      case "reflection.analyze": {
        const data = msg.data as { input: string; output: string };
        // Simple reflection: check if output contains uncertainty markers
        const hasUncertainty = /I don't know|I'm not sure|不确定|不知道/i.test(data.output);
        const hasFabrication = /\[FABRICATED\]/.test(data.output);

        eventBus.publish({
          type: "reflection.result",
          source: "reflection",
          data: {
            hasUncertainty,
            hasFabrication,
            confidence: hasFabrication ? 0.1 : hasUncertainty ? 0.5 : 0.9,
          },
          priority: "normal",
          replyTo: msg.id,
        });
        break;
      }

      case "reflection.learn": {
        const data = msg.data as { lesson: string; source: string };
        // Store the lesson as an atom
        atomStore.create("insight", data.lesson, {
          source: data.source,
          confidence: "inferred",
          metadata: { learnedAt: Date.now() },
        });

        eventBus.publish({
          type: "reflection.learned",
          source: "reflection",
          data: { lesson: data.lesson },
          priority: "normal",
          replyTo: msg.id,
        });
        break;
      }

      default:
        logger.debug("[ReflectionActor] Unknown message type", { type: msg.type });
    }

    this.state = "idle";
  }
}

// ─── Planner Actor ─────────────────────────────────────────────────────────

/**
 * Planner Actor — handles planning via message passing.
 */
class PlannerActor implements Actor {
  id = "planner";
  state: "idle" | "running" | "sleeping" | "waiting" | "error" = "idle";

  async receive(msg: ActorMessage): Promise<void> {
    this.state = "running";

    switch (msg.type) {
      case "planner.create": {
        const data = msg.data as { input: string; context?: unknown };
        // Use the cognitive pipeline for deterministic planning
        const { cognitivePipeline } = await import("./scheduler.js");
        const result = await cognitivePipeline.run(data.input);

        eventBus.publish({
          type: "planner.plan.created",
          source: "planner",
          data: {
            needsLLM: result.needsLLM,
            result: result.result,
            stageTimings: Object.fromEntries(result.stageTimings),
          },
          priority: "normal",
          replyTo: msg.id,
        });
        break;
      }

      default:
        logger.debug("[PlannerActor] Unknown message type", { type: msg.type });
    }

    this.state = "idle";
  }
}

// ─── Search Actor ──────────────────────────────────────────────────────────

/**
 * Search Actor — handles search operations via message passing.
 */
class SearchActor implements Actor {
  id = "search";
  state: "idle" | "running" | "sleeping" | "waiting" | "error" = "idle";

  async receive(msg: ActorMessage): Promise<void> {
    this.state = "running";

    switch (msg.type) {
      case "search.query": {
        const data = msg.data as { query: string; sources?: string[] };
        // Search atoms
        const atomResults = atomStore.search(data.query, 20);

        eventBus.publish({
          type: "search.results",
          source: "search",
          data: {
            query: data.query,
            results: atomResults.map((r) => ({
              id: r.id,
              kind: r.kind,
              content: r.content.slice(0, 200),
              confidence: r.confidence,
            })),
          },
          priority: "normal",
          replyTo: msg.id,
        });
        break;
      }

      default:
        logger.debug("[SearchActor] Unknown message type", { type: msg.type });
    }

    this.state = "idle";
  }
}

// ─── Initialize Actors ─────────────────────────────────────────────────────

/**
 * Register all actors with the Actor Runtime.
 * Call once at startup.
 */
export function initActors(): void {
  actorRuntime.register(new MemoryActor());
  actorRuntime.register(new ReflectionActor());
  actorRuntime.register(new PlannerActor());
  actorRuntime.register(new SearchActor());

  // Subscribe to events and forward to actors
  eventBus.subscribe("consciousness.reflection", async (evt) => {
    const data = evt.data as { summary?: string };
    if (data.summary) {
      actorRuntime.send({
        from: "consciousness",
        to: "reflection",
        type: "reflection.learn",
        data: { lesson: data.summary, source: "consciousness" },
      });
    }
  });

  logger.info("[Actors] Initialized all actors");
}
