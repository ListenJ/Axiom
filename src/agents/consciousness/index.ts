/**
 * Consciousness — Public API & Singleton.
 *
 * What the rest of the OpenClaw project should import:
 *
 *   import { getConsciousness } from "./agents/consciousness/index.js";
 *   const c = getConsciousness();
 *
 *   // fire-and-forget
 *   c.triggerNow("manual:user_explicit").catch(() => {});
 *
 *   // inspection
 *   c.status();   // -> { running, lastReflectionAt, ... }
 *
 * Lifecycle integration:
 *   - In src/main.ts, after the vault and cron are initialized, call
 *     `await getConsciousness().start({ enabled: true })`.
 *   - In the chat route (src/routes/chat.ts), call
 *     `getConsciousness().observe(input, intentResult)` after each user turn.
 *   - In VaultFileWatcher (or VaultManager.write* wrappers), call
 *     `getConsciousness().observeVaultWrite()`.
 *
 * Shutdown:
 *   - In src/main.ts shutdown hook, call
 *     `getConsciousness().stop()`. Pending cycles are awaited up to 5s.
 *
 * Conflict-avoidance guarantees (see README.md in this folder):
 *   - Never touches the request hot path. `observe()` is O(1) and synchronous.
 *   - Only writes under `00-Meta/consciousness/...` (its own namespace).
 *   - Only registers skills with the `auto-*` id prefix.
 *   - Reuses existing model routing, never instantiates a provider client.
 *   - Bun.cron is registered through a single addCronTick() callback so
 *     cron/scheduler.ts can call it without us touching its file.
 */

import { logger } from "../../utils/logger.js";
import { getStateStore } from "./state-store.js";
import { getActivityTracker, resetActivityTrackerForTest } from "./activity-tracker.js";
import { getReflectionLoop, _resetReflectionLoopForTest } from "./reflection-loop.js";
import { evaluate, buildScheduleTrigger, buildManualTrigger, isWithinQuietHours } from "./trigger.js";
import type { ReflectionOutcome, ReflectionTrigger, TriggerConfig } from "./types.js";
import { DEFAULT_TRIGGER_CONFIG } from "./types.js";
import { wsManager } from "../../utils/websocket.js";
import { eventBus, worldState } from "../../runtime/kernel.js";

// ─── Routing Signal (for UnifiedRouter) ────────────────────────────────────

export interface RoutingSignal {
  /** Intent drift detected — user switched topics */
  patternDrift: boolean;
  /** Context fatigue — long conversation, model may lose coherence */
  fatigueIndicator: boolean;
  /** Inferred expertise from message complexity */
  expertiseSignal: "beginner" | "intermediate" | "expert";
  /** Urgency level from message tone */
  urgencyLevel: "low" | "normal" | "high";
}

export interface ConsciousnessOptions extends Partial<TriggerConfig> {
  /** Quiet hours — suppress reflection in this window (local time). */
  quietHours?: { startHour: number; endHour: number };
  /** Poll loop interval in ms (for idle/token-budget checks). Default 60_000. */
  pollIntervalMs?: number;
}

export interface ConsciousnessStatus {
  running: boolean;
  enabled: boolean;
  pollActive: boolean;
  lastReflectionAt: number | null;
  lastOutcome: ReflectionOutcome | null;
  stateExists: boolean;
  config: TriggerConfig;
}

class Consciousness {
  private options: ConsciousnessOptions = {};
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cronTickHandler: ((cron: string) => void) | null = null;
  private lastOutcome: ReflectionOutcome | null = null;

  /** Initialize + start background loops. Idempotent. */
  async start(options: ConsciousnessOptions = {}): Promise<void> {
    this.options = { ...DEFAULT_TRIGGER_CONFIG, ...options };
    if (!this.options.enabled) {
      logger.info("[Consciousness] start() called but disabled in config");
      return;
    }

    // Ensure StateStore bootstrap with a fresh state if missing.
    const store = getStateStore();
    if (!store.stats().exists) {
      store.write(store.read());
    }

    // Start the idle/token-budget poll.
    const interval = this.options.pollIntervalMs ?? 60_000;
    this.pollTimer = setInterval(() => this.tick("poll"), interval);
    logger.info("[Consciousness] poll loop started", { intervalMs: interval });
  }

  /** Stop the background loops. Awaits any in-flight cycle up to 5s. */
  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.cronTickHandler = null;
    const loop = getReflectionLoop();
    const deadline = Date.now() + 5_000;
    while (loop.isRunning() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    logger.info("[Consciousness] stopped");
  }

  /** Called by chat routes on each user message. O(1), non-blocking. */
  observe(userInput: string, intent: { intent: string; agentName: string }): void {
    try {
      getActivityTracker().bumpUserActivity(userInput, intent);

      // Publish to Runtime Event Bus
      eventBus.publish({
        type: "consciousness.observation",
        source: "consciousness",
        data: { input: userInput.slice(0, 200), intent: intent.intent, agent: intent.agentName },
        priority: "low",
      });

      // Update world state
      worldState.set("consciousness.lastObservation", {
        timestamp: Date.now(),
        intent: intent.intent,
        agent: intent.agentName,
      });
    } catch (e) {
      logger.debug("[Consciousness] observe failed", { error: (e as Error).message });
    }
  }

  /**
   * Generate routing signals from consciousness state.
   * Called by the UnifiedRouter before routing decisions.
   * O(1) — reads from existing state, no LLM calls.
   */
  getRoutingSignal(): RoutingSignal {
    try {
      const tracker = getActivityTracker();
      const store = getStateStore();
      const state = store.read();

      // Pattern drift: use topic-shift detection from ActivityTracker
      const patternDrift = tracker.detectTopicShift();

      // Fatigue: long session with many turns
      const turnCount = tracker.getTurnCount();
      const totalPatterns = Object.values(state.patternCounts).reduce((a, b) => a + b, 0);
      const fatigueIndicator = turnCount > 30 || totalPatterns > 20 || state.tokensSpentThisSession > 100_000;

      // Expertise: infer from recent focus topics + dominant intent
      const focusTopics = state.recentFocus;
      const expertTopics = ["architecture", "refactor", "optimize", "concurrent", "async"];
      const hasExpertFocus = focusTopics.some((t) =>
        expertTopics.some((et) => t.toLowerCase().includes(et)),
      );
      const dominantIntent = tracker.getDominantIntent();
      const isExpertIntent = dominantIntent === "code" || dominantIntent === "architecture";
      const expertiseSignal: RoutingSignal["expertiseSignal"] =
        hasExpertFocus || isExpertIntent ? "expert"
        : turnCount > 15 ? "intermediate"
        : "beginner";

      // Urgency: detect from recent activity frequency
      const idleMs = tracker.getIdleMs();
      const urgencyLevel: RoutingSignal["urgencyLevel"] =
        idleMs < 5000 ? "high" : idleMs < 30000 ? "normal" : "low";

      return { patternDrift, fatigueIndicator, expertiseSignal, urgencyLevel };
    } catch {
      return {
        patternDrift: false,
        fatigueIndicator: false,
        expertiseSignal: "intermediate",
        urgencyLevel: "normal",
      };
    }
  }

  /** Called by VaultFileWatcher / writeNote wrappers. O(1). */
  observeVaultWrite(): void {
    try {
      getActivityTracker().bumpVaultWrite();
    } catch (e) {
      logger.debug("[Consciousness] observeVaultWrite failed", { error: (e as Error).message });
    }
  }

  /** Register the cron tick handler (call from cron/scheduler.ts). */
  registerCronTick(handler: (cron: string) => void): void {
    this.cronTickHandler = handler;
    logger.info("[Consciousness] cron tick handler registered");
  }

  /** Force a reflection right now. Returns the outcome. */
  async triggerNow(reason?: string): Promise<ReflectionOutcome> {
    return this.dispatch(buildManualTrigger(reason));
  }

  /** Synchronous inspection for /consciousness/status. */
  status(): ConsciousnessStatus {
    const loop = getReflectionLoop();
    return {
      running: loop.isRunning(),
      enabled: this.options.enabled ?? DEFAULT_TRIGGER_CONFIG.enabled,
      pollActive: this.pollTimer !== null,
      lastReflectionAt: getStateStore().read().lastReflectionAt || null,
      lastOutcome: this.lastOutcome,
      stateExists: getStateStore().stats().exists,
      config: { ...DEFAULT_TRIGGER_CONFIG, ...this.options } as TriggerConfig,
    };
  }

  // ─── private ───────────────────────────────────────────────────────────

  /** Periodic tick — evaluate idle / token-budget triggers. */
  private async tick(source: "poll" | "cron"): Promise<void> {
    if (source === "poll") {
      const config = { ...DEFAULT_TRIGGER_CONFIG, ...this.options };
      const decision = evaluate(config);
      if (!decision) return;
      if (decision.withinQuietHours) return;
      if (this.options.quietHours && isWithinQuietHours(this.options.quietHours.startHour, this.options.quietHours.endHour)) {
        logger.debug("[Consciousness] suppressed by quiet hours");
        return;
      }
      await this.dispatch(decision.fired);
      return;
    }
    if (source === "cron" && this.options.scheduleCron) {
      await this.dispatch(buildScheduleTrigger(this.options.scheduleCron));
    }
  }

  /** Single dispatch point — guarantees outcome bookkeeping + WebSocket broadcast. */
  private async dispatch(trigger: ReflectionTrigger): Promise<ReflectionOutcome> {
    logger.info("[Consciousness] dispatch", { kind: trigger.kind });
    const outcome = await getReflectionLoop().runOnce(trigger);
    this.lastOutcome = outcome;
    // After a reflection, reset hot-path counters (so the next cycle measures
    // fresh activity). Keep lastUserActivityAt — that's the source of truth
    // for idle detection.
    getActivityTracker().resetCounters();

    // Broadcast reflection outcome via WebSocket
    try {
      wsManager.broadcast({
        type: "consciousness.status",
        payload: {
          trigger: trigger.kind,
          summary: outcome.summary,
          durationMs: outcome.durationMs,
          tokensUsed: outcome.tokensUsed,
          promotedSkills: outcome.promotedSkillIds,
          archivedCount: outcome.archivedCount,
          abortedReason: outcome.abortedReason,
        },
        timestamp: new Date().toISOString(),
      });

      // Publish to Runtime Event Bus
      eventBus.publish({
        type: "consciousness.reflection",
        source: "consciousness",
        data: {
          trigger: trigger.kind,
          summary: outcome.summary,
          durationMs: outcome.durationMs,
          tokensUsed: outcome.tokensUsed,
          promotedSkills: outcome.promotedSkillIds,
        },
        priority: "normal",
      });

      // Update world state with reflection result
      worldState.set("consciousness.lastReflection", {
        timestamp: Date.now(),
        trigger: trigger.kind,
        summary: outcome.summary,
        mood: getStateStore().read().mood,
        nextGoal: getStateStore().read().nextGoal,
      });
    } catch { /* non-fatal */ }

    return outcome;
  }
}

let _instance: Consciousness | null = null;
export function getConsciousness(): Consciousness {
  if (!_instance) _instance = new Consciousness();
  return _instance;
}

/**
 * Test seam. Stops any running poll loop on the previous instance before
 * discarding the singleton — otherwise the setInterval closure keeps a
 * reference alive and leaks.
 */
export function _resetConsciousnessForTest(): void {
  if (_instance) {
    // Defensive: stop() is async but clearInterval is sync; fire-and-forget
    // is acceptable here because we are about to drop the reference.
    try {
      void _instance.stop().catch(() => {});
    } catch {
      // best-effort — tests should not throw on cleanup
    }
  }
  _instance = null;
  resetActivityTrackerForTest();
  _resetReflectionLoopForTest();
}

// Re-exports for convenience.
export type { ReflectionOutcome, ReflectionTrigger, TriggerConfig, TraceAnomaly } from "./types.js";
export { DEFAULT_TRIGGER_CONFIG } from "./types.js";
export { recordTraceEntry, getTraceEntries, clearTrace, analyzeTrace } from "./trace-analyzer.js";
export type { TraceEntry } from "./trace-analyzer.js";
