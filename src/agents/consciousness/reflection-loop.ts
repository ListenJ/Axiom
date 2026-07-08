/**
 * ReflectionLoop — The think / reflect / act cycle.
 *
 * Single responsibility: orchestrate a single reflection pass.
 *
 *   think()    — collect observations (state, activity, curator summary)
 *   reflect()  — call router.executeWithRole("general-chat", msgs) once
 *   act()      — invoke SkillPromoter + MemoryCurator with the LLM's hints
 *   runOnce()  — composes think → reflect → act into a single cycle
 *
 * Only ONE LLM call per cycle, on `general-chat` role (cheap, low latency).
 * Uses router.executeWithRole (not direct provider calls) so it inherits
 * fallback chains, token tracking, and circuit breakers.
 *
 * Concurrency: an internal `running` flag prevents overlapping cycles.
 * If a trigger fires while one is in flight, the second call is no-op'd
 * and logged.
 */

import { logger } from "../../utils/logger.js";
import { router, type ChatMessage } from "../../services/index.js";
import { getStateStore } from "./state-store.js";
import { getActivityTracker } from "./activity-tracker.js";
import { SkillPromoter, DEFAULT_PROMOTER_CONFIG } from "./skill-promoter.js";
import { MemoryCurator, DEFAULT_CURATOR_CONFIG } from "./memory-curator.js";
import { getGlobalVault } from "../../memory/vault-manager.js";
import type { ReflectionOutcome, ReflectionTrigger, MentalState, Belief } from "./types.js";

const REFLECTION_TEMPERATURE = 0.3;
const REFLECTION_NOTE_PREFIX = "00-Meta/consciousness/reflections";

export class ReflectionLoop {
  private running = false;
  private readonly promoter = new SkillPromoter(DEFAULT_PROMOTER_CONFIG);
  private readonly curator = new MemoryCurator(DEFAULT_CURATOR_CONFIG);

  async runOnce(trigger: ReflectionTrigger): Promise<ReflectionOutcome> {
    if (this.running) {
      logger.info("[Consciousness/ReflectionLoop] cycle already in flight, skipping");
      return this.skipOutcome(trigger, "cycle_already_in_flight");
    }
    this.running = true;
    const startedAt = Date.now();
    const stateStore = getStateStore();
    const stateBefore = stateStore.read();
    let tokensUsed = 0;
    let summary = "no summary";
    let abortedReason: string | undefined;
    const promotedSkillIds: string[] = [];
    const curatorNotePaths: string[] = [];
    let archivedCount = 0;

    try {
      // ── think ──────────────────────────────────────────────────────────
      const observations = this.collectObservations();
      logger.info("[Consciousness/ReflectionLoop] think() complete", observations);

      // ── reflect — single LLM call ─────────────────────────────────────
      const messages = this.buildReflectionMessages(observations, trigger);
      try {
        const response = await router.executeWithRole("general-chat", messages, {
          temperature: REFLECTION_TEMPERATURE,
        });
        summary = (response.content ?? "").slice(0, 500) || "no summary";
        tokensUsed = response.usage?.total_tokens ?? 0;
        // Approximate: executeWithRole's SmartAssignmentResponse doesn't return
        // usage; fall back to a content-length / 4 heuristic.
        if (!tokensUsed) tokensUsed = Math.ceil((response.content?.length ?? 0) / 4);
      } catch (e) {
        abortedReason = `llm_error: ${(e as Error).message}`;
        logger.warn("[Consciousness/ReflectionLoop] LLM reflect() failed, will still run curator", { error: (e as Error).message });
      }

      // ── act — promote + curate, unconditionally (even if LLM failed) ─
      try {
        const ids = await this.promoter.runOnce();
        promotedSkillIds.push(...ids);
      } catch (e) {
        logger.warn("[Consciousness/ReflectionLoop] promoter failed", { error: (e as Error).message });
      }
      try {
        const co = await this.curator.runOnce();
        archivedCount = co.archived;
        curatorNotePaths.push(...co.distilled);
        curatorNotePaths.push(...co.notes);
      } catch (e) {
        logger.warn("[Consciousness/ReflectionLoop] curator failed", { error: (e as Error).message });
      }

      // ── persist insight note ──────────────────────────────────────────
      try {
        const insightPath = await this.writeInsightNote({
          trigger,
          summary,
          promotedSkillIds,
          archivedCount,
          tokensUsed,
        });
        curatorNotePaths.push(insightPath);
      } catch (e) {
        logger.warn("[Consciousness/ReflectionLoop] writeInsightNote failed", { error: (e as Error).message });
      }

      // ── update self-state ─────────────────────────────────────────────
      const finishedAt = Date.now();
      const extractedMental = this.extractMentalState(summary);
      stateStore.patch({
        lastReflectionAt: finishedAt,
        tokensSpentThisSession: stateBefore.tokensSpentThisSession + tokensUsed,
        recentInsights: [summary, ...stateBefore.recentInsights].slice(0, 3),
        mood: this.extractMood(summary) ?? stateBefore.mood,
        nextGoal: this.extractGoal(summary) ?? stateBefore.nextGoal,
        mental: {
          ...stateBefore.mental,
          currentIntent: extractedMental.intent ?? stateBefore.mental.currentIntent,
          goals: extractedMental.goals.length > 0 ? extractedMental.goals : stateBefore.mental.goals,
          beliefs: extractedMental.beliefs.length > 0 ? extractedMental.beliefs : stateBefore.mental.beliefs,
          mood: this.extractMood(summary) ?? stateBefore.mental.mood,
        },
      });

      return {
        trigger,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        tokensUsed,
        promotedSkillIds,
        curatorNotePaths,
        archivedCount,
        summary,
        ...(abortedReason ? { abortedReason } : {}),
      };
    } finally {
      this.running = false;
    }
  }

  /** True if a cycle is currently running. */
  isRunning(): boolean { return this.running; }

  // ─── private helpers ───────────────────────────────────────────────────

  private collectObservations(): Record<string, unknown> {
    const state = getStateStore().read();
    const activity = getActivityTracker().stats();
    return {
      idleMs: activity.idleMs,
      lastUserActivityAt: activity.lastUserActivityAt,
      lastVaultWriteAt: activity.lastVaultWriteAt,
      tokensSpentThisSession: state.tokensSpentThisSession,
      recentFocus: state.recentFocus,
      recentInsights: state.recentInsights,
      patternKeys: Object.keys(state.patternCounts).slice(0, 10),
      mood: state.mood,
      nextGoal: state.nextGoal,
      // 心智状态
      mental: {
        currentIntent: state.mental.currentIntent,
        activeGoals: state.mental.goals.filter((g) => g.status === "active").map((g) => g.description),
        activeBeliefs: state.mental.beliefs.filter((b) => b.status === "active").map((b) => b.proposition),
        activeHypotheses: state.mental.activeHypotheses,
      },
    };
  }

  private buildReflectionMessages(obs: Record<string, unknown>, trigger: ReflectionTrigger): ChatMessage[] {
    const sys = `你是一个安静、理性的自省助手。请用 1-3 句中文描述你对自己当前状态的观察，必要时给出下一周期的目标。绝不写超过 500 字。

请额外输出以下结构化信息（JSON格式，用 \`\`\`json 块包裹）：
- intent: 当前意图（一句话）
- goals: 当前活跃目标列表（每个目标包含 description 和 priority）
- beliefs: 你对当前世界的信念列表（每个信念包含 proposition 和 confidence 0-1）`;
    const user = `## 触发\n${JSON.stringify(trigger)}\n\n## 观察\n${JSON.stringify(obs, null, 2)}\n\n请输出:\n1. 一句"心情"描述（中性、严肃、无情绪）\n2. 一句"下一目标"\n3. 一句"总结"\n4. JSON 结构化信息（intent/goals/beliefs）`;
    return [
      { role: "system", content: sys },
      { role: "user", content: user },
    ];
  }

  private async writeInsightNote(args: {
    trigger: ReflectionTrigger;
    summary: string;
    promotedSkillIds: string[];
    archivedCount: number;
    tokensUsed: number;
  }): Promise<string> {
    const date = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const path = `${REFLECTION_NOTE_PREFIX}/${date}.md`;
    const content = `---
type: consciousness-reflection
created: ${new Date().toISOString()}
trigger: ${args.trigger.kind}
tokens_used: ${args.tokensUsed}
promoted_skills: ${args.promotedSkillIds.length}
archived: ${args.archivedCount}
tags: [consciousness, reflection, auto-generated]
---

# Self-Reflection — ${new Date().toISOString()}

## Trigger
\`\`\`json
${JSON.stringify(args.trigger, null, 2)}
\`\`\`

## Summary

${args.summary}

## Actions
- Skills promoted: ${args.promotedSkillIds.join(", ") || "(none)"}
- Memory artifacts archived: ${args.archivedCount}

---
*Auto-generated by Axiom Consciousness module. Do not edit by hand.*
`;
    return getGlobalVault().writeNote(path, content, {
      title: `Reflection ${date}`,
      tags: ["consciousness", "reflection", "auto-generated"],
      type: "consciousness-reflection",
      paraCategory: "meta",
      source: "consciousness",
      confidence: 1.0,
    });
  }

  private extractMood(summary: string): string | null {
    const m = summary.match(/心情[::]\s*([^\n]+)/);
    return m?.[1]?.slice(0, 100) ?? null;
  }

  private extractGoal(summary: string): string | null {
    const m = summary.match(/下一目标[::]\s*([^\n]+)/) ?? summary.match(/目标[::]\s*([^\n]+)/);
    return m?.[1]?.slice(0, 200) ?? null;
  }

  /**
   * 从 LLM 响应中提取心智状态 (intent/goals/beliefs)
   */
  private extractMentalState(summary: string): {
    intent: string | null;
    goals: Array<{ id: string; description: string; priority: number; status: "active" }>;
    beliefs: Belief[];
  } {
    const result = { intent: null as string | null, goals: [] as Array<{ id: string; description: string; priority: number; status: "active" }>, beliefs: [] as Belief[] };

    // 尝试从 JSON 块中提取
    const jsonMatch = summary.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        if (data.intent) result.intent = data.intent;
        if (Array.isArray(data.goals)) {
          result.goals = data.goals.map((g: any, i: number) => ({
            id: `goal-${Date.now()}-${i}`,
            description: g.description || String(g),
            priority: g.priority || 5,
            status: "active" as const,
          }));
        }
        if (Array.isArray(data.beliefs)) {
          result.beliefs = data.beliefs.map((b: any, i: number) => ({
            id: `belief-${Date.now()}-${i}`,
            proposition: b.proposition || String(b),
            confidence: b.confidence || 0.5,
            supportingEvidence: [],
            contradictingEvidence: [],
            formedAt: Date.now(),
            updatedAt: Date.now(),
            status: "active" as const,
          }));
        }
      } catch {
        // JSON 解析失败，忽略
      }
    }

    return result;
  }

  private skipOutcome(trigger: ReflectionTrigger, reason: string): ReflectionOutcome {
    const now = Date.now();
    return {
      trigger,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      tokensUsed: 0,
      promotedSkillIds: [],
      curatorNotePaths: [],
      archivedCount: 0,
      summary: "skipped",
      abortedReason: reason,
    };
  }
}

let _instance: ReflectionLoop | null = null;
export function getReflectionLoop(): ReflectionLoop {
  if (!_instance) _instance = new ReflectionLoop();
  return _instance;
}

/** Test seam: reset singleton so each test gets a fresh loop. */
export function _resetReflectionLoopForTest(): void {
  _instance = null;
}
