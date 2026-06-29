/**
 * Memory Engine — Observation → Episode → Pattern → Knowledge → Skill → Policy
 *
 * Memory 不是存东西。Memory 是经验系统。
 *
 * 今天：用户修 Bug → Memory 记录：修了 Bug
 * 以后：Observation → Bug → 原因 → 解决方案 → 抽象 → Skill → 自动复用
 *
 * Memory 最终应该产生 Skill，而不是 Note。
 *
 * 对应认知科学：
 * - Observation: 感知输入
 * - Episode: 情节记忆（具体事件）
 * - Pattern: 模式识别（重复出现的模式）
 * - Knowledge: 语义知识（抽象规则）
 * - Skill: 程序性知识（可执行能力）
 * - Policy: 策略（决策规则）
 */

import { logger } from "../utils/logger.js";
import { eventBus, worldState } from "./kernel.js";
import { atomStore } from "./atom-engine.js";
import { knowledgeNetwork } from "./knowledge-network.js";

// ─── Memory Types ──────────────────────────────────────────────────────────

export type MemoryStage = "observation" | "episode" | "pattern" | "knowledge" | "skill" | "policy";

export interface Observation {
  id: string
  content: string
  source: string
  timestamp: number
  metadata: Record<string, unknown>
  entities: string[]  // extracted entity IDs
}

export interface Episode {
  id: string
  observations: string[]  // observation IDs
  summary: string
  outcome: "success" | "failure" | "neutral"
  cause?: string
  solution?: string
  timestamp: number
  confidence: number
}

export interface Pattern {
  id: string
  episodes: string[]  // episode IDs
  description: string
  frequency: number
  firstSeen: number
  lastSeen: number
  confidence: number
}

export interface Knowledge {
  id: string
  patterns: string[]  // pattern IDs
  statement: string
  domain: string
  confidence: number
  evidence: string[]
  createdAt: number
}

export interface Skill {
  id: string
  knowledge: string[]  // knowledge IDs
  name: string
  description: string
  trigger: string       // what activates this skill
  action: string        // what the skill does
  verification: string  // how to verify success
  confidence: number
  usageCount: number
  successRate: number
  createdAt: number
  lastUsed: number
}

export interface Policy {
  id: string
  skills: string[]  // skill IDs
  name: string
  description: string
  rule: string      // the policy rule
  priority: number
  confidence: number
  createdAt: number
}

// ─── Memory Engine ─────────────────────────────────────────────────────────

class MemoryEngineImpl {
  private observations = new Map<string, Observation>();
  private episodes = new Map<string, Episode>();
  private patterns = new Map<string, Pattern>();
  private knowledge = new Map<string, Knowledge>();
  private skills = new Map<string, Skill>();
  private policies = new Map<string, Policy>();
  private stats = { observations: 0, episodes: 0, patterns: 0, knowledge: 0, skills: 0, policies: 0 };

  // ─── Observation ─────────────────────────────────────────────────

  /**
   * Record an observation from the external world.
   */
  observe(content: string, source: string, metadata?: Record<string, unknown>): Observation {
    const id = `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Extract entities from content
    const entities = this.extractEntities(content);

    const observation: Observation = {
      id,
      content,
      source,
      timestamp: Date.now(),
      metadata: metadata ?? {},
      entities,
    };

    this.observations.set(id, observation);
    this.stats.observations++;

    // Store as atom
    atomStore.create("observation", content, {
      source,
      metadata: { observationId: id, entities },
    });

    // Update world state
    worldState.set("memory.lastObservation", {
      timestamp: Date.now(),
      content: content.slice(0, 200),
      source,
    });

    eventBus.publish({
      type: "memory.observation",
      source: "memory-engine",
      data: { id, content: content.slice(0, 200), source, entityCount: entities.length },
      priority: "low",
    });

    // Try to form an episode from recent observations
    this.tryFormEpisode();

    return observation;
  }

  // ─── Episode ─────────────────────────────────────────────────────

  /**
   * Form an episode from recent observations.
   * Enhanced: detects problem→investigation→solution patterns.
   */
  private tryFormEpisode(): Episode | null {
    const recentObs = Array.from(this.observations.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);

    if (recentObs.length < 2) return null;

    // Check if observations form a coherent episode
    const sharedEntities = this.findSharedEntities(recentObs);
    const hasTimeCoherence = this.checkTimeCoherence(recentObs, 60000); // within 60 seconds
    const hasSemanticCoherence = this.checkSemanticCoherence(recentObs);

    if (sharedEntities.length === 0 && !hasTimeCoherence && !hasSemanticCoherence) return null;

    // Detect episode pattern
    const pattern = this.detectEpisodePattern(recentObs);

    const id = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const summary = recentObs.slice(0, 3).map((o) => o.content.slice(0, 50)).join(" → ");

    const episode: Episode = {
      id,
      observations: recentObs.map((o) => o.id),
      summary,
      outcome: pattern.outcome,
      cause: pattern.cause,
      solution: pattern.solution,
      timestamp: Date.now(),
      confidence: sharedEntities.length > 0 ? 0.8 : 0.6,
    };

    this.episodes.set(id, episode);
    this.stats.episodes++;

    // Store as atom
    atomStore.create("experience", summary, {
      source: "memory-engine",
      metadata: { episodeId: id, sharedEntities, pattern: pattern.type },
    });

    eventBus.publish({
      type: "memory.episode",
      source: "memory-engine",
      data: { id, summary, outcome: episode.outcome, pattern: pattern.type },
      priority: "normal",
    });

    // Try to extract patterns
    this.tryExtractPatterns();

    return episode;
  }

  /**
   * Check if observations are within a time window.
   */
  private checkTimeCoherence(observations: Observation[], windowMs: number): boolean {
    if (observations.length < 2) return false;
    const newest = Math.max(...observations.map((o) => o.timestamp));
    const oldest = Math.min(...observations.map((o) => o.timestamp));
    return (newest - oldest) < windowMs;
  }

  /**
   * Check semantic coherence (shared keywords).
   */
  private checkSemanticCoherence(observations: Observation[]): boolean {
    if (observations.length < 2) return false;
    const keywords = observations.flatMap((o) =>
      o.content.toLowerCase().match(/\b\w{4,}\b/g) ?? []
    );
    const unique = new Set(keywords);
    return unique.size < keywords.length * 0.7; // 30%+ keyword overlap
  }

  /**
   * Detect the pattern of an episode (problem→investigation→solution, etc.).
   */
  private detectEpisodePattern(observations: Observation[]): {
    type: string
    outcome: "success" | "failure" | "neutral"
    cause?: string
    solution?: string
  } {
    const contents = observations.map((o) => o.content.toLowerCase());

    // Pattern: problem → investigation → solution
    const hasProblem = contents.some((c) =>
      c.includes("bug") || c.includes("error") || c.includes("fail") || c.includes("issue")
    );
    const hasInvestigation = contents.some((c) =>
      c.includes("search") || c.includes("find") || c.includes("look") || c.includes("check")
    );
    const hasSolution = contents.some((c) =>
      c.includes("fix") || c.includes("solve") || c.includes("done") || c.includes("work")
    );

    if (hasProblem && hasSolution) {
      return {
        type: "problem-solution",
        outcome: "success",
        cause: contents.find((c) => c.includes("bug") || c.includes("error")),
        solution: contents.find((c) => c.includes("fix") || c.includes("solve")),
      };
    }

    if (hasProblem && hasInvestigation) {
      return {
        type: "problem-investigation",
        outcome: "neutral",
        cause: contents.find((c) => c.includes("bug") || c.includes("error")),
      };
    }

    // Pattern: question → answer
    const hasQuestion = contents.some((c) => c.includes("?") || c.includes("how") || c.includes("what"));
    const hasAnswer = contents.some((c) => c.length > 50); // substantial answer

    if (hasQuestion && hasAnswer) {
      return { type: "question-answer", outcome: "success" };
    }

    return { type: "sequence", outcome: "neutral" };
  }

  /**
   * Check if observations are within a time window.
   */
  completeEpisode(episodeId: string, outcome: "success" | "failure", cause?: string, solution?: string): boolean {
    const episode = this.episodes.get(episodeId);
    if (!episode) return false;

    episode.outcome = outcome;
    episode.cause = cause;
    episode.solution = solution;

    // If successful, try to form knowledge
    if (outcome === "success" && solution) {
      this.tryFormKnowledge(episode);
    }

    return true;
  }

  // ─── Pattern ─────────────────────────────────────────────────────

  /**
   * Extract patterns from episodes.
   */
  private tryExtractPatterns(): void {
    const allEpisodes = Array.from(this.episodes.values());
    if (allEpisodes.length < 2) return;

    // Method 1: Group episodes by shared entities
    const entityGroups = new Map<string, Episode[]>();
    for (const ep of allEpisodes) {
      const obs = ep.observations.map((id) => this.observations.get(id)).filter(Boolean);
      const entities = obs.flatMap((o) => o.entities);
      const uniqueEntities = [...new Set(entities)].sort();
      if (uniqueEntities.length > 0) {
        const key = uniqueEntities.join("|");
        if (!entityGroups.has(key)) entityGroups.set(key, []);
        entityGroups.get(key)!.push(ep);
      }
    }

    // Method 2: Group episodes by outcome type
    const outcomeGroups = new Map<string, Episode[]>();
    for (const ep of allEpisodes) {
      if (ep.outcome !== "neutral") {
        const key = ep.outcome;
        if (!outcomeGroups.has(key)) outcomeGroups.set(key, []);
        outcomeGroups.get(key)!.push(ep);
      }
    }

    // Method 3: Group episodes by similar summaries (keyword overlap)
    const summaryGroups = new Map<string, Episode[]>();
    for (const ep of allEpisodes) {
      const keywords = ep.summary.toLowerCase().match(/\b\w{4,}\b/g) ?? [];
      const key = keywords.slice(0, 3).sort().join("|");
      if (key.length > 0) {
        if (!summaryGroups.has(key)) summaryGroups.set(key, []);
        summaryGroups.get(key)!.push(ep);
      }
    }

    // Merge all groups and create patterns
    const allGroups = new Map<string, Episode[]>();
    for (const [key, eps] of entityGroups) allGroups.set(`entity:${key}`, eps);
    for (const [key, eps] of outcomeGroups) allGroups.set(`outcome:${key}`, eps);
    for (const [key, eps] of summaryGroups) allGroups.set(`summary:${key}`, eps);

    for (const [key, episodes] of allGroups) {
      if (episodes.length >= 2) {
        // Check if pattern already exists
        const existing = Array.from(this.patterns.values())
          .some((p) => p.episodes.join("|") === episodes.map((e) => e.id).join("|"));
        if (existing) continue;

        const id = `pattern_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const description = `Recurring ${key.split(":")[0]} pattern: ${episodes[0].summary.slice(0, 80)}`;

        const pattern: Pattern = {
          id,
          episodes: episodes.map((e) => e.id),
          description,
          frequency: episodes.length,
          firstSeen: Math.min(...episodes.map((e) => e.timestamp)),
          lastSeen: Math.max(...episodes.map((e) => e.timestamp)),
          confidence: Math.min(0.5 + episodes.length * 0.1, 0.95),
        };

        this.patterns.set(id, pattern);
        this.stats.patterns++;

        // Store as atom
        atomStore.create("concept", description, {
          source: "memory-engine",
          metadata: { patternId: id, frequency: pattern.frequency, groupKey: key },
        });

        eventBus.publish({
          type: "memory.pattern",
          source: "memory-engine",
          data: { id, description, frequency: pattern.frequency, groupKey: key },
          priority: "normal",
        });
      }
    }
  }

  // ─── Knowledge ───────────────────────────────────────────────────

  /**
   * Form knowledge from a successful episode.
   */
  private tryFormKnowledge(episode: Episode): void {
    if (!episode.solution) return;

    const id = `know_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const statement = episode.cause
      ? `When ${episode.cause}, then ${episode.solution}`
      : episode.solution;

    const kn: Knowledge = {
      id,
      patterns: [],
      statement,
      domain: this.inferDomain(episode),
      confidence: episode.confidence,
      evidence: [episode.id],
      createdAt: Date.now(),
    };

    this.knowledge.set(id, kn);
    this.stats.knowledge++;

    // Store in knowledge network
    knowledgeNetwork.create("fact", statement, statement, {
      confidence: episode.confidence,
      source: "memory-engine",
      evidence: [{
        source: `episode:${episode.id}`,
        confidence: episode.confidence,
        timestamp: Date.now(),
        description: episode.summary,
      }],
    });

    // Store as atom
    atomStore.create("fact", statement, {
      source: "memory-engine",
      confidence: episode.confidence > 0.8 ? "certain" : "inferred",
      metadata: { knowledgeId: id },
    });

    eventBus.publish({
      type: "memory.knowledge",
      source: "memory-engine",
      data: { id, statement, domain: kn.domain },
      priority: "normal",
    });

    // Try to form a skill
    this.tryFormSkill(kn);
  }

  // ─── Skill ───────────────────────────────────────────────────────

  /**
   * Form a skill from knowledge.
   */
  private tryFormSkill(knowledge: Knowledge): void {
    const id = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const skill: Skill = {
      id,
      knowledge: [knowledge.id],
      name: `auto_${knowledge.domain}_${Date.now()}`,
      description: knowledge.statement,
      trigger: this.inferTrigger(knowledge),
      action: this.inferAction(knowledge),
      verification: "check outcome matches expectation",
      confidence: knowledge.confidence,
      usageCount: 0,
      successRate: 1.0,
      createdAt: Date.now(),
      lastUsed: 0,
    };

    this.skills.set(id, skill);
    this.stats.skills++;

    // Store in capability registry
    const { capabilityRegistry } = require("./capability-registry.js");
    capabilityRegistry.register({
      name: skill.name,
      description: skill.description,
      inputSchema: {},
      outputSchema: {},
      provider: "internal",
      cost: 0,
      latencyMs: 100,
      reliability: skill.confidence,
      constraints: [],
      metadata: { skillId: id, autoGenerated: true },
    });

    eventBus.publish({
      type: "memory.skill",
      source: "memory-engine",
      data: { id, name: skill.name, description: skill.description },
      priority: "high",
    });

    logger.info("[MemoryEngine] Skill created", { id, name: skill.name });
  }

  // ─── Policy ──────────────────────────────────────────────────────

  /**
   * Create a policy from a skill.
   */
  createPolicy(skillId: string, rule: string, priority = 0): Policy | null {
    const skill = this.skills.get(skillId);
    if (!skill) return null;

    const id = `policy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const policy: Policy = {
      id,
      skills: [skillId],
      name: `Policy: ${skill.name}`,
      description: `Auto-generated policy for ${skill.name}`,
      rule,
      priority,
      confidence: skill.confidence,
      createdAt: Date.now(),
    };

    this.policies.set(id, policy);
    this.stats.policies++;

    // Store as constraint
    const { constraintSolver } = require("./constraint-solver.js");
    constraintSolver.addConstraint({
      type: "requires",
      source: skill.name,
      target: rule,
      confidence: policy.confidence,
      evidence: "auto-generated policy",
    });

    eventBus.publish({
      type: "memory.policy",
      source: "memory-engine",
      data: { id, name: policy.name, rule },
      priority: "normal",
    });

    return policy;
  }

  // ─── Query ───────────────────────────────────────────────────────

  /**
   * Search across all memory stages.
   */
  search(query: string): {
    observations: Observation[]
    episodes: Episode[]
    patterns: Pattern[]
    knowledge: Knowledge[]
    skills: Skill[]
  } {
    const lower = query.toLowerCase();

    return {
      observations: Array.from(this.observations.values()).filter((o) => o.content.toLowerCase().includes(lower)),
      episodes: Array.from(this.episodes.values()).filter((e) => e.summary.toLowerCase().includes(lower)),
      patterns: Array.from(this.patterns.values()).filter((p) => p.description.toLowerCase().includes(lower)),
      knowledge: Array.from(this.knowledge.values()).filter((k) => k.statement.toLowerCase().includes(lower)),
      skills: Array.from(this.skills.values()).filter((s) => s.description.toLowerCase().includes(lower)),
    };
  }

  /**
   * Get all skills.
   */
  getSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get the current (most recent, uncompleted) episode.
   * Used by the feedback loop to mark episodes as success/failure.
   */
  getCurrentEpisode(): Episode | null {
    const episodes = Array.from(this.episodes.values())
      .sort((a, b) => b.timestamp - a.timestamp);
    return episodes.find((e) => e.outcome === "neutral") ?? null;
  }

  /**
   * Get all patterns.
   */
  getPatterns(): Pattern[] {
    return Array.from(this.patterns.values());
  }

  /**
   * Get all knowledge.
   */
  getKnowledge(): Knowledge[] {
    return Array.from(this.knowledge.values());
  }

  /**
   * Get all episodes.
   */
  getEpisodes(): Episode[] {
    return Array.from(this.episodes.values());
  }

  /**
   * Force skill formation from successful patterns.
   * Call this periodically or when patterns reach a threshold.
   */
  formSkillsFromPatterns(): number {
    let formed = 0;
    const patterns = Array.from(this.patterns.values())
      .filter((p) => p.frequency >= 3 && p.confidence >= 0.7);

    for (const pattern of patterns) {
      // Check if skill already exists for this pattern
      const existing = Array.from(this.skills.values())
        .some((s) => s.knowledge.some((k) => pattern.episodes.includes(k)));
      if (existing) continue;

      // Form knowledge from pattern
      const knowledge: Knowledge = {
        id: `know_pattern_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        patterns: [pattern.id],
        statement: pattern.description,
        domain: "pattern",
        confidence: pattern.confidence,
        evidence: pattern.episodes,
        createdAt: Date.now(),
      };

      this.knowledge.set(knowledge.id, knowledge);
      this.stats.knowledge++;

      // Form skill from knowledge
      this.tryFormSkill(knowledge);
      formed++;
    }

    return formed;
  }

  /**
   * Form skills from successful episodes with clear cause-solution patterns.
   * Called by the Tick Engine's reflect phase.
   */
  formSkillsFromSuccessfulEpisodes(): number {
    let formed = 0;
    const successfulEpisodes = Array.from(this.episodes.values())
      .filter((e) => e.outcome === "success" && e.cause && e.solution);

    for (const episode of successfulEpisodes) {
      // Check if knowledge already exists for this episode
      const existingKnowledge = Array.from(this.knowledge.values())
        .some((k) => k.evidence.includes(episode.id));
      if (existingKnowledge) continue;

      // Form knowledge from episode
      const knowledge: Knowledge = {
        id: `know_episode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        patterns: [],
        statement: `When ${episode.cause}, then ${episode.solution}`,
        domain: this.inferDomain(episode),
        confidence: episode.confidence,
        evidence: [episode.id],
        createdAt: Date.now(),
      };

      this.knowledge.set(knowledge.id, knowledge);
      this.stats.knowledge++;

      // Store in knowledge network
      knowledgeNetwork.create("fact", knowledge.statement, knowledge.statement, {
        confidence: knowledge.confidence,
        source: "memory-engine",
        evidence: [{
          source: `episode:${episode.id}`,
          confidence: knowledge.confidence,
          timestamp: Date.now(),
          description: episode.summary,
        }],
      });

      // Store as atom
      atomStore.create("fact", knowledge.statement, {
        source: "memory-engine",
        confidence: knowledge.confidence > 0.8 ? "certain" as const : "inferred" as const,
        metadata: { knowledgeId: knowledge.id },
      });

      // Try to form skill
      this.tryFormSkill(knowledge);
      formed++;

      eventBus.publish({
        type: "memory.skill_from_episode",
        source: "memory-engine",
        data: { episodeId: episode.id, knowledgeId: knowledge.id, statement: knowledge.statement },
        priority: "normal",
      });
    }

    return formed;
  }

  /**
   * Get stats.
   */
  getStats(): Record<string, number> {
    return { ...this.stats };
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private extractEntities(content: string): string[] {
    const entities: string[] = [];
    // Simple entity extraction: capitalized words, code patterns
    const patterns = [
      /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,  // CamelCase
      /\b[a-z]+(?:_[a-z]+)+\b/g,            // snake_case
      /\b\w+\.(ts|js|tsx|jsx|py|rs|go)\b/g, // file extensions
      /`[^`]+`/g,                             // backtick code
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) entities.push(...matches.slice(0, 5));
    }

    return [...new Set(entities)].slice(0, 10);
  }

  private findSharedEntities(observations: Observation[]): string[] {
    if (observations.length === 0) return [];
    const sets = observations.map((o) => new Set(o.entities));
    const shared = sets[0];
    for (let i = 1; i < sets.length; i++) {
      for (const e of shared) {
        if (!sets[i].has(e)) shared.delete(e);
      }
    }
    return Array.from(shared);
  }

  private inferDomain(episode: Episode): string {
    const content = episode.summary.toLowerCase();
    if (content.includes("bug") || content.includes("fix") || content.includes("error")) return "debugging";
    if (content.includes("test") || content.includes("spec")) return "testing";
    if (content.includes("refactor") || content.includes("optimize")) return "refactoring";
    if (content.includes("doc") || content.includes("readme")) return "documentation";
    return "general";
  }

  private inferTrigger(knowledge: Knowledge): string {
    if (knowledge.cause) return `When ${knowledge.cause}`;
    return `When ${knowledge.domain} task detected`;
  }

  private inferAction(knowledge: Knowledge): string {
    return knowledge.statement;
  }
}

export const memoryEngine = new MemoryEngineImpl();
