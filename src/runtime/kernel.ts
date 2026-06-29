/**
 * Runtime Kernel — The heart of OpenClaw Runtime
 *
 * This is NOT a request-response system. This is a continuous runtime that:
 * - Runs on ticks (like a game engine)
 * - All communication via events (no direct calls)
 * - Single world state (all modules are projections)
 * - All modules are actors (message passing)
 * - LLM is last resort (algorithms first)
 *
 * Architecture:
 * ┌─────────────────────────────────────────────┐
 * │              Runtime Kernel                  │
 * │  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
 * │  │ Event Bus│ │State Tree│ │Scheduler │    │
 * │  └──────────┘ └──────────┘ └──────────┘    │
 * │  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
 * │  │Tick Engine│ │Actor RT  │ │Context   │    │
 * │  └──────────┘ └──────────┘ └──────────┘    │
 * └─────────────────────────────────────────────┘
 */

import { logger } from "../utils/logger.js";
import { EventEmitter } from "events";

// ─── Event Types ───────────────────────────────────────────────────────────

export type EventPriority = "critical" | "high" | "normal" | "low" | "background";

export interface RuntimeEvent {
  id: string
  type: string
  source: string
  data: unknown
  priority: EventPriority
  timestamp: number
  correlationId?: string
  replyTo?: string
}

export interface EventHandler {
  id: string
  eventType: string
  handler: (event: RuntimeEvent) => Promise<void> | void
  priority: number
  once?: boolean
}

// ─── Event Bus ─────────────────────────────────────────────────────────────

/**
 * Unified Event Bus — ALL communication goes through here.
 * No direct module-to-module calls. Ever.
 */
class EventBusImpl extends EventEmitter {
  private handlers = new Map<string, EventHandler[]>();
  private eventLog: RuntimeEvent[] = [];
  private maxLogSize = 1000;
  private stats = { published: 0, handled: 0, errors: 0 };

  /**
   * Publish an event. All subscribers are notified.
   */
  publish(event: Omit<RuntimeEvent, "id" | "timestamp">): RuntimeEvent {
    const fullEvent: RuntimeEvent = {
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };

    this.stats.published++;
    this.eventLog.push(fullEvent);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog.shift();
    }

    // Notify handlers sorted by priority
    const handlers = this.handlers.get(event.type) ?? [];
    const sorted = [...handlers].sort((a, b) => b.priority - a.priority);

    for (const h of sorted) {
      try {
        const result = h.handler(fullEvent);
        if (result instanceof Promise) {
          result.catch((err) => {
            this.stats.errors++;
            logger.error(`[EventBus] Handler ${h.id} failed for ${event.type}`, err instanceof Error ? err : new Error(String(err)));
          });
        }
        this.stats.handled++;
        if (h.once) {
          this.unsubscribe(h.id);
        }
      } catch (err) {
        this.stats.errors++;
        logger.error(`[EventBus] Handler ${h.id} failed for ${event.type}`, err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Also emit on EventEmitter for external listeners
    this.emit(event.type, fullEvent);

    return fullEvent;
  }

  /**
   * Subscribe to an event type.
   */
  subscribe(eventType: string, handler: (event: RuntimeEvent) => Promise<void> | void, priority = 0): string {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: EventHandler = { id, eventType, handler, priority };

    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(entry);

    return id;
  }

  /**
   * Subscribe once — auto-unsubscribes after first trigger.
   */
  subscribeOnce(eventType: string, handler: (event: RuntimeEvent) => Promise<void> | void, priority = 0): string {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: EventHandler = { id, eventType, handler, priority, once: true };

    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(entry);

    return id;
  }

  /**
   * Unsubscribe a handler.
   */
  unsubscribe(id: string): void {
    for (const [type, handlers] of this.handlers) {
      const idx = handlers.findIndex((h) => h.id === id);
      if (idx !== -1) {
        handlers.splice(idx, 1);
        if (handlers.length === 0) this.handlers.delete(type);
        return;
      }
    }
  }

  /**
   * Get recent events.
   */
  getRecentEvents(count = 20): RuntimeEvent[] {
    return this.eventLog.slice(-count);
  }

  /**
   * Get event stats.
   */
  getStats(): { published: number; handled: number; errors: number; subscriberCount: number } {
    let subscriberCount = 0;
    for (const handlers of this.handlers.values()) {
      subscriberCount += handlers.length;
    }
    return { ...this.stats, subscriberCount };
  }
}

export const eventBus = new EventBusImpl();

// ─── World State Tree ──────────────────────────────────────────────────────

/**
 * Single source of truth for the entire system.
 * All modules read from and write to this state tree.
 * All other data stores (Vault, KG, SQLite) are PROJECTIONS of this state.
 */
class WorldStateImpl {
  private state = new Map<string, unknown>();
  private version = 0;
  private listeners = new Map<string, Array<(value: unknown, oldValue: unknown) => void>>();

  /**
   * Get a value from the state tree.
   */
  get<T = unknown>(path: string): T | undefined {
    return this.state.get(path) as T | undefined;
  }

  /**
   * Set a value in the state tree. Notifies listeners.
   */
  set<T = unknown>(path: string, value: T): void {
    const oldValue = this.state.get(path);
    this.state.set(path, value);
    this.version++;

    // Notify listeners
    const listeners = this.listeners.get(path) ?? [];
    for (const listener of listeners) {
      try {
        listener(value, oldValue);
      } catch (err) {
        logger.error(`[WorldState] Listener failed for ${path}`, err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Publish state change event
    eventBus.publish({
      type: "state.changed",
      source: "world-state",
      data: { path, value, oldValue, version: this.version },
      priority: "normal",
    });
  }

  /**
   * Update a value using a function.
   */
  update<T = unknown>(path: string, updater: (current: T | undefined) => T): void {
    const current = this.get<T>(path);
    const next = updater(current);
    this.set(path, next);
  }

  /**
   * Subscribe to changes on a specific path.
   */
  watch(path: string, listener: (value: unknown, oldValue: unknown) => void): () => void {
    if (!this.listeners.has(path)) {
      this.listeners.set(path, []);
    }
    this.listeners.get(path)!.push(listener);

    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(path);
      if (listeners) {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    };
  }

  /**
   * Get all paths matching a prefix.
   */
  query(prefix: string): Map<string, unknown> {
    const result = new Map<string, unknown>();
    for (const [key, value] of this.state) {
      if (key.startsWith(prefix)) {
        result.set(key, value);
      }
    }
    return result;
  }

  /**
   * Get the current version number.
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * Get state snapshot for serialization.
   */
  snapshot(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of this.state) {
      obj[key] = value;
    }
    return obj;
  }
}

export const worldState = new WorldStateImpl();

// ─── Tick Engine ───────────────────────────────────────────────────────────

export type TickPhase = "observe" | "update" | "reason" | "schedule" | "execute" | "reflect" | "sleep";

export interface TickContext {
  tickNumber: number
  phase: TickPhase
  startTime: number
  deltaTime: number
  events: RuntimeEvent[]
}

type TickHandler = (ctx: TickContext) => Promise<void> | void;

/**
 * Continuous runtime loop. Like a game engine's update loop.
 * The system runs on ticks, not on requests.
 */
class TickEngineImpl {
  private tickNumber = 0;
  private running = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickIntervalMs = 1000; // 1 second per tick
  private phases: TickPhase[] = ["observe", "update", "reason", "schedule", "execute", "reflect", "sleep"];
  private handlers = new Map<TickPhase, TickHandler[]>();
  private lastTickTime = 0;

  /**
   * Register a handler for a specific tick phase.
   */
  onPhase(phase: TickPhase, handler: TickHandler): void {
    if (!this.handlers.has(phase)) {
      this.handlers.set(phase, []);
    }
    this.handlers.get(phase)!.push(handler);
  }

  /**
   * Start the tick engine.
   */
  start(intervalMs = 1000): void {
    if (this.running) return;
    this.running = true;
    this.tickIntervalMs = intervalMs;
    this.lastTickTime = Date.now();

    logger.info("[TickEngine] Starting runtime loop", { intervalMs });

    this.interval = setInterval(() => {
      this.tick().catch((err) => {
        logger.error("[TickEngine] Tick failed", err instanceof Error ? err : new Error(String(err)));
      });
    }, intervalMs);
  }

  /**
   * Stop the tick engine.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.running = false;
    logger.info("[TickEngine] Stopped");
  }

  /**
   * Execute a single tick through all phases.
   */
  async tick(): Promise<void> {
    const now = Date.now();
    const deltaTime = now - this.lastTickTime;
    this.lastTickTime = now;
    this.tickNumber++;

    // Collect events from this tick
    const tickEvents = eventBus.getRecentEvents(50);

    for (const phase of this.phases) {
      const ctx: TickContext = {
        tickNumber: this.tickNumber,
        phase,
        startTime: now,
        deltaTime,
        events: tickEvents,
      };

      const handlers = this.handlers.get(phase) ?? [];
      for (const handler of handlers) {
        try {
          await handler(ctx);
        } catch (err) {
          logger.error(`[TickEngine] Phase ${phase} handler failed`, err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }

  /**
   * Check if the engine is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current tick number.
   */
  getTickNumber(): number {
    return this.tickNumber;
  }

  /**
   * Get stats.
   */
  getStats(): { tickNumber: number; running: boolean; intervalMs: number; phaseCount: number } {
    let phaseCount = 0;
    for (const handlers of this.handlers.values()) {
      phaseCount += handlers.length;
    }
    return {
      tickNumber: this.tickNumber,
      running: this.running,
      intervalMs: this.tickIntervalMs,
      phaseCount,
    };
  }
}

export const tickEngine = new TickEngineImpl();

// ─── Actor Runtime ─────────────────────────────────────────────────────────

export type ActorState = "idle" | "running" | "sleeping" | "waiting" | "error";

export interface ActorMessage {
  id: string
  from: string
  to: string
  type: string
  data: unknown
  timestamp: number
  replyTo?: string
}

export interface Actor {
  id: string
  state: ActorState
  receive: (msg: ActorMessage) => Promise<void> | void
  onStart?: () => Promise<void> | void
  onStop?: () => Promise<void> | void
}

/**
 * Actor Runtime — all modules are actors that communicate via message passing.
 * No direct function calls between modules.
 */
class ActorRuntimeImpl {
  private actors = new Map<string, Actor>();
  private messageQueue: ActorMessage[] = [];
  private stats = { messagesSent: 0, messagesProcessed: 0, errors: 0 };

  /**
   * Register an actor.
   */
  register(actor: Actor): void {
    this.actors.set(actor.id, actor);
    logger.info(`[ActorRuntime] Registered actor: ${actor.id}`);
  }

  /**
   * Unregister an actor.
   */
  unregister(id: string): void {
    const actor = this.actors.get(id);
    if (actor?.onStop) {
      actor.onStop().catch((err) => {
        logger.error(`[ActorRuntime] Actor ${id} onStop failed`, err instanceof Error ? err : new Error(String(err)));
      });
    }
    this.actors.delete(id);
  }

  /**
   * Send a message to an actor.
   */
  send(msg: Omit<ActorMessage, "id" | "timestamp">): void {
    const fullMsg: ActorMessage = {
      ...msg,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };

    this.stats.messagesSent++;
    this.messageQueue.push(fullMsg);

    // Process immediately if actor exists
    const actor = this.actors.get(msg.to);
    if (actor) {
      this.processMessage(actor, fullMsg).catch((err) => {
        this.stats.errors++;
        logger.error(`[ActorRuntime] Message processing failed for ${msg.to}`, err instanceof Error ? err : new Error(String(err)));
      });
    }
  }

  /**
   * Broadcast a message to all actors.
   */
  broadcast(type: string, data: unknown, from: string): void {
    for (const actor of this.actors.values()) {
      if (actor.id !== from) {
        this.send({ from, to: actor.id, type, data });
      }
    }
  }

  /**
   * Process a message for an actor.
   */
  private async processMessage(actor: Actor, msg: ActorMessage): Promise<void> {
    try {
      actor.state = "running";
      await actor.receive(msg);
      this.stats.messagesProcessed++;
      actor.state = "idle";
    } catch (err) {
      actor.state = "error";
      this.stats.errors++;
      logger.error(`[ActorRuntime] Actor ${actor.id} failed processing message`, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Get all registered actors.
   */
  getActors(): Actor[] {
    return Array.from(this.actors.values());
  }

  /**
   * Get stats.
   */
  getStats(): { actorCount: number; queueSize: number; messagesSent: number; messagesProcessed: number; errors: number } {
    return {
      actorCount: this.actors.size,
      queueSize: this.messageQueue.length,
      ...this.stats,
    };
  }
}

export const actorRuntime = new ActorRuntimeImpl();

// ─── Runtime Initialization ────────────────────────────────────────────────

/**
 * Initialize the runtime. Call once at startup.
 */
export function initRuntime(): void {
  logger.info("[Runtime] Initializing OpenClaw Runtime Kernel");

  // Set up default tick phases
  tickEngine.onPhase("observe", (ctx) => {
    // Observation phase: collect events from external world
    if (ctx.tickNumber % 10 === 0) {
      logger.debug("[Runtime] Tick", { tick: ctx.tickNumber, phase: ctx.phase });
    }

    // Publish tick event for other modules
    eventBus.publish({
      type: "tick.observe",
      source: "tick-engine",
      data: { tick: ctx.tickNumber, deltaTime: ctx.deltaTime },
      priority: "low",
    });
  });

  tickEngine.onPhase("update", async () => {
    // Update phase: sync world state from external stores
    try {
      // Sync runtime metrics
      const eventStats = eventBus.getStats();
      const actorStats = actorRuntime.getStats();
      worldState.set("runtime.events", {
        published: eventStats.published,
        handled: eventStats.handled,
        errors: eventStats.errors,
        timestamp: Date.now(),
      });
      worldState.set("runtime.actors", {
        count: actorStats.actorCount,
        queueSize: actorStats.queueSize,
        messagesSent: actorStats.messagesSent,
        timestamp: Date.now(),
      });

      // Sync atom store stats
      const { atomStore } = await import("./atom-engine.js");
      worldState.set("runtime.atoms", atomStore.getStats());

      // Sync memory engine stats
      const { memoryEngine } = await import("./memory-engine.js");
      worldState.set("runtime.memory", memoryEngine.getStats());

      // Sync constraint solver stats
      const { constraintSolver } = await import("./constraint-solver.js");
      worldState.set("runtime.constraints", constraintSolver.getStats());

      // Sync capability registry stats
      const { capabilityRegistry } = await import("./capability-registry.js");
      worldState.set("runtime.capabilities", capabilityRegistry.getStats());

      // Sync rule engine stats
      const { ruleEngine } = await import("./rule-engine.js");
      worldState.set("runtime.rules", ruleEngine.getStats());
    } catch { /* non-fatal */ }
  });

  tickEngine.onPhase("reason", async () => {
    // Reason phase: evaluate rules + check constraints
    try {
      const { ruleEngine } = await import("./rule-engine.js");
      const { constraintSolver } = await import("./constraint-solver.js");

      // Evaluate rules against current world state
      const context = {
        stateVersion: worldState.getVersion(),
        timestamp: Date.now(),
        tickNumber: tickEngine.getTickNumber(),
      };
      const matches = ruleEngine.evaluate(context);
      const matchedRules = matches.filter((m) => m.matched);

      if (matchedRules.length > 0) {
        worldState.set("runtime.ruleMatches", {
          count: matchedRules.length,
          rules: matchedRules.map((m) => ({ name: m.rule.name, action: m.rule.action })),
          timestamp: Date.now(),
        });

        // Publish rule match events
        for (const match of matchedRules) {
          eventBus.publish({
            type: "rule.matched",
            source: "tick-engine",
            data: { rule: match.rule.name, action: match.rule.action },
            priority: "normal",
          });
        }
      }

      // Check constraints on current entities
      const entityKeys = worldState.query("entities.");
      const entityIds = Array.from(entityKeys.keys()).map((k) => k.replace("entities.", ""));
      if (entityIds.length > 0) {
        const constraintResult = constraintSolver.solve(entityIds);
        worldState.set("runtime.constraints", {
          satisfied: constraintResult.satisfied,
          violationCount: constraintResult.violations.length,
          violations: constraintResult.violations.map((v) => ({
            type: v.constraint.type,
            message: v.message,
            severity: v.severity,
          })),
          timestamp: Date.now(),
        });

        if (!constraintResult.satisfied) {
          eventBus.publish({
            type: "tick.constraint_violation",
            source: "tick-engine",
            data: { violations: constraintResult.violations.length },
            priority: "high",
          });
        }
      }
    } catch { /* non-fatal */ }
  });

  tickEngine.onPhase("schedule", async () => {
    // Schedule phase: check for pending tasks and process them
    try {
      const { scheduler } = await import("./scheduler.js");
      const status = scheduler.getStatus();
      worldState.set("runtime.scheduler", {
        queued: status.queued,
        running: status.running,
        completed: status.completed,
        timestamp: Date.now(),
      });

      // Process next task from queue if resources available
      if (status.queued > 0 && status.running < 5) {
        const task = scheduler.getNext();
        if (task) {
          eventBus.publish({
            type: "scheduler.task_started",
            source: "tick-engine",
            data: { id: task.id, name: task.name, priority: task.priority },
            priority: "normal",
          });
        }
      }
    } catch { /* non-fatal */ }
  });

  tickEngine.onPhase("execute", () => {
    // Execute phase: process any pending actor messages
    const actorStats = actorRuntime.getStats();
    worldState.set("runtime.actors", {
      count: actorStats.actorCount,
      queueSize: actorStats.queueSize,
      messagesSent: actorStats.messagesSent,
      timestamp: Date.now(),
    });
  });

  tickEngine.onPhase("reflect", async () => {
    // Reflection phase: periodic self-assessment + rule learning
    const stateVersion = worldState.getVersion();
    const eventStats = eventBus.getStats();
    const actorStats = actorRuntime.getStats();

    // Update runtime metrics in world state
    worldState.set("runtime.metrics", {
      stateVersion,
      eventStats,
      actorStats,
      timestamp: Date.now(),
    });

    // Learn rules from successful patterns (every 10 ticks)
    if (tickEngine.getTickNumber() % 10 === 0) {
      try {
        const { ruleEngine } = await import("./rule-engine.js");
        const learned = await ruleEngine.learnFromMemory();
        if (learned > 0) {
          logger.info("[Runtime] Learned new rules from patterns", { count: learned });
          eventBus.publish({
            type: "rules.learned",
            source: "tick-engine",
            data: { count: learned },
            priority: "normal",
          });
        }
      } catch { /* non-fatal */ }

      // Also try to form skills from patterns
      try {
        const { memoryEngine } = await import("./memory-engine.js");
        const formed = memoryEngine.formSkillsFromPatterns();
        if (formed > 0) {
          logger.info("[Runtime] Formed new skills from patterns", { count: formed });
        }

        // Also try to form skills from successful episodes
        const formedFromEpisodes = memoryEngine.formSkillsFromSuccessfulEpisodes();
        if (formedFromEpisodes > 0) {
          logger.info("[Runtime] Formed new skills from successful episodes", { count: formedFromEpisodes });
        }
      } catch { /* non-fatal */ }
    }
  });

  tickEngine.onPhase("sleep", async () => {
    // Sleep phase: cleanup and maintenance
    // Clean old events from the event bus log
    const stats = eventBus.getStats();
    if (stats.published > 10000) {
      logger.info("[Runtime] High event count, consider cleanup", { published: stats.published });
    }

    // Auto-cleanup old observations every 100 ticks
    if (tickEngine.getTickNumber() % 100 === 0) {
      try {
        const { memoryEngine } = await import("./memory-engine.js");
        const removed = memoryEngine.cleanup(1000);
        if (removed > 0) {
          logger.info("[Runtime] Cleaned up old observations", { removed });
          eventBus.publish({
            type: "memory.cleanup",
            source: "tick-engine",
            data: { removed },
            priority: "low",
          });
        }
      } catch { /* non-fatal */ }
    }
  });

  logger.info("[Runtime] Runtime Kernel initialized");
}

/**
 * Get runtime status.
 */
export function getRuntimeStatus(): {
  tick: ReturnType<TickEngineImpl["getStats"]>;
  events: ReturnType<EventBusImpl["getStats"]>;
  actors: ReturnType<ActorRuntimeImpl["getStats"]>;
  stateVersion: number;
} {
  return {
    tick: tickEngine.getStats(),
    events: eventBus.getStats(),
    actors: actorRuntime.getStats(),
    stateVersion: worldState.getVersion(),
  };
}
