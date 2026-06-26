/**
 * SkillPromoter — Promote recurring (intent, agentName) patterns into Skills.
 *
 * Reads ActivityTracker.snapshot(), selects patterns that exceed a
 * frequency threshold, then calls PromptEngineer.generateSkillWithHermes()
 * to draft a SkillDefinition, validates it, persists it to
 * openclaw-memory/03-Resources/skills/<id>.json, and registers it via
 * SkillRegistry.register().
 *
 * This module does NOT call providers directly. It composes existing
 * subsystems and writes only to paths/files those subsystems own.
 *
 * Important: does not duplicate PromptEngineer / HermesAgent logic. It is
 * a thin orchestrator that delegates the actual LLM work.
 */

import path from "path";
import fs from "fs";
import { logger } from "../../utils/logger.js";
import { getActivityTracker } from "./activity-tracker.js";
import { getPromptEngineer } from "./prompt-engineer-shim.js";
import { getSkillRegistry } from "./skill-registry-shim.js";
import type { PatternCandidate } from "./types.js";
import type { SkillDefinition } from "../../skills/types.js";

export interface PromoterConfig {
  /** Minimum count over the window to be eligible. */
  minCount: number;
  /** Hard cap of skills promoted per reflection cycle. */
  maxPromotionsPerCycle: number;
  /** Where the persisted skill JSON files live (relative to project root). */
  skillDirRel: string;
  /** Skip if the pattern already exists in the registry (default true). */
  skipExisting: boolean;
}

export const DEFAULT_PROMOTER_CONFIG: PromoterConfig = {
  minCount: 5,
  maxPromotionsPerCycle: 2,
  skillDirRel: "./openclaw-memory/03-Resources/skills",
  skipExisting: true,
};

export class SkillPromoter {
  constructor(private readonly config: PromoterConfig = DEFAULT_PROMOTER_CONFIG) {}

  /** Pick eligible patterns from ActivityTracker. */
  pickCandidates(windowMs: number): PatternCandidate[] {
    const snap = getActivityTracker().snapshot();
    return snap
      .filter((s: { count: number }) => s.count >= this.config.minCount)
      .slice(0, this.config.maxPromotionsPerCycle)
      .map((s: { key: string; intent: string; agentName: string; count: number; sampleInputs: string[] }) => ({
        key: s.key,
        intent: s.intent,
        agentName: s.agentName,
        count: s.count,
        windowMs,
        sampleInputs: s.sampleInputs,
      }));
  }

  /**
   * Promote one candidate into the SkillRegistry. Idempotent by id.
   * Returns the new skill id, or null on failure.
   */
  async promote(candidate: PatternCandidate): Promise<string | null> {
    const registry = getSkillRegistry();
    const engineer = getPromptEngineer();

    if (this.config.skipExisting) {
      const slug = this.slugify(`${candidate.intent}-${candidate.agentName}`);
      const existing = registry.list().find((s) => s.id === `auto-${slug}`);
      if (existing) {
        logger.info("[Consciousness/SkillPromoter] skip existing", { key: candidate.key });
        return null;
      }
    }

    const description = `Auto-generated from ${candidate.count} recurring '${candidate.intent}' / '${candidate.agentName}' patterns.`;
    const triggers = this.inferTriggers(candidate);

    const draft = await engineer.generateSkillWithHermes(
      `${candidate.intent}-${candidate.agentName}`,
      description,
      triggers
    );

    if (!draft) {
      logger.warn("[Consciousness/SkillPromoter] Hermes returned no draft", { key: candidate.key });
      return null;
    }

    // Validate: id, promptTemplate, name, description must all be non-empty.
    if (!draft.id || !draft.promptTemplate || !draft.name || !draft.description) {
      logger.warn("[Consciousness/SkillPromoter] invalid draft", { draft });
      return null;
    }

    // Stamp provenance + ensure unique id under auto-* namespace.
    const slug = this.slugify(`${candidate.intent}-${candidate.agentName}`);
    const finalSkill: SkillDefinition = {
      ...draft,
      id: `auto-${slug}-${Date.now().toString(36).slice(-4)}`,
      version: "1.0-auto",
      source: "hermes",
    };

    // 1. Register in-memory.
    registry.register(finalSkill);

    // 2. Persist to disk so loadSkillsFromDirectories picks it up on reload.
    const targetPath = path.join(this.config.skillDirRel, `${finalSkill.id}.json`);
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(finalSkill, null, 2), "utf-8");
    } catch (e) {
      logger.warn("[Consciousness/SkillPromoter] persist failed", { targetPath, error: (e as Error).message });
    }

    logger.info("[Consciousness/SkillPromoter] promoted", {
      id: finalSkill.id,
      key: candidate.key,
      count: candidate.count,
    });

    return finalSkill.id;
  }

  /** Bulk: pick + promote. Returns list of new skill ids. */
  async runOnce(): Promise<string[]> {
    const cands = this.pickCandidates(/* windowMs not tracked yet */ 60 * 60 * 1000);
    const promoted: string[] = [];
    for (const c of cands) {
      const id = await this.promote(c);
      if (id) promoted.push(id);
    }
    return promoted;
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  private inferTriggers(c: PatternCandidate): string[] {
    // Heuristic: if any sample input contains CJK, use the first 2-gram
    // characters as Chinese trigger; otherwise lowercase the longest sample
    // word. Hermes refines the rest.
    const sample = c.sampleInputs[0] ?? "";
    if (/[\u4e00-\u9fa5]/.test(sample)) {
      const cjk: string[] = [];
      for (let i = 0; i < sample.length - 1; i++) {
        if (/[\u4e00-\u9fa5]/.test(sample[i]) && /[\u4e00-\u9fa5]/.test(sample[i + 1])) {
          cjk.push(sample.slice(i, i + 2));
        }
      }
      return [...new Set(cjk)].slice(0, 5);
    }
    return sample
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5);
  }
}
