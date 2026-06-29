/**
 * Knowledge Network — 升级知识系统
 *
 * 不再是简单的 Entity + Relation (Graph)。
 * 而是 Entity + State + Constraint + Capability + Evidence + Timeline + Behavior + Prediction。
 *
 * 关键创新：
 * - Behavior: 实体的行为模式（苹果会腐烂）
 * - Prediction: 基于行为的预测（如果不关火，水会干）
 * - Hypothesis: 假设验证机制
 */

import { eventBus } from "./kernel.js";
import { atomStore } from "./atom-engine.js";

// ─── Knowledge Entity ──────────────────────────────────────────────────────

export type EntityKind =
  | "function" | "class" | "interface" | "type" | "variable"
  | "entity" | "fact" | "rule" | "concept" | "procedure"
  | "document" | "section" | "paragraph"
  | "goal" | "plan" | "step" | "action"
  | "observation" | "experience" | "belief" | "insight"
  | "constraint" | "capability" | "agent" | "tool" | "model"
  | "behavior" | "prediction" | "hypothesis"

export interface KnowledgeEntity {
  id: string
  kind: EntityKind
  name: string
  content: string
  state: EntityState
  constraints: string[]     // constraint IDs
  capabilities: string[]    // capability names
  evidence: Evidence[]
  timeline: TimelineEntry[]
  behaviors: Behavior[]     // 行为模式
  predictions: Prediction[] // 预测
  hypotheses: Hypothesis[]  // 假设
  confidence: number        // 0-1
  source: string
  createdAt: number
  updatedAt: number
  version: number
}

export interface EntityState {
  current: string                    // "open" | "closed" | "running" | "sleeping" | etc.
  properties: Record<string, unknown>
  lastChanged: number
}

export interface Evidence {
  source: string
  confidence: number
  timestamp: number
  description: string
}

export interface TimelineEntry {
  timestamp: number
  state: string
  event: string
  metadata?: Record<string, unknown>
}

/**
 * Behavior — 实体的行为模式
 * 描述实体在特定条件下的反应
 */
export interface Behavior {
  id: string
  trigger: string           // 触发条件
  action: string            // 行为描述
  effect: string            // 效果
  confidence: number        // 0-1
  observedCount: number     // 观察次数
  lastObserved: number      // 最后观察时间
}

/**
 * Prediction — 基于行为的预测
 * 描述在特定条件下会发生什么
 */
export interface Prediction {
  id: string
  condition: string         // 条件
  outcome: string           // 预测结果
  confidence: number        // 0-1
  timeHorizon: string       // 时间范围
  basedOn: string[]         // 基于的行为/证据 ID
  validated: boolean        // 是否已验证
  validatedAt?: number      // 验证时间
}

/**
 * Hypothesis — 假设验证机制
 * 科学态度：怀疑和验证
 */
export interface Hypothesis {
  id: string
  statement: string         // 假设陈述
  evidence: string[]        // 支持证据
  counterEvidence: string[] // 反对证据
  status: "proposed" | "testing" | "confirmed" | "rejected"
  confidence: number        // 0-1
  proposedAt: number
  resolvedAt?: number
}

// ─── Knowledge Network ─────────────────────────────────────────────────────

class KnowledgeNetworkImpl {
  private entities = new Map<string, KnowledgeEntity>();
  private byKind = new Map<EntityKind, Set<string>>();
  private byState = new Map<string, Set<string>>();
  private stats = { created: 0, queried: 0, updated: 0 };

  /**
   * Create a knowledge entity.
   */
  create(kind: EntityKind, name: string, content: string, opts?: {
    state?: string
    properties?: Record<string, unknown>
    constraints?: string[]
    capabilities?: string[]
    evidence?: Evidence[]
    confidence?: number
    source?: string
  }): KnowledgeEntity {
    const id = `kn_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const entity: KnowledgeEntity = {
      id,
      kind,
      name,
      content,
      state: {
        current: opts?.state ?? "active",
        properties: opts?.properties ?? {},
        lastChanged: now,
      },
      constraints: opts?.constraints ?? [],
      capabilities: opts?.capabilities ?? [],
      evidence: opts?.evidence ?? [],
      timeline: [{
        timestamp: now,
        state: opts?.state ?? "active",
        event: "created",
      }],
      behaviors: [],
      predictions: [],
      hypotheses: [],
      confidence: opts?.confidence ?? 0.8,
      source: opts?.source ?? "system",
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    this.entities.set(id, entity);
    this.stats.created++;

    // Update indexes
    this.addToIndex(this.byKind, kind, id);
    this.addToIndex(this.byState, entity.state.current, id);

    // Store as atom
    atomStore.create(kind, name, {
      source: opts?.source ?? "knowledge-network",
      confidence: opts?.confidence ? (opts.confidence > 0.8 ? "certain" : opts.confidence > 0.5 ? "inferred" : "uncertain") : "inferred",
      metadata: { entityId: id },
    });

    eventBus.publish({
      type: "knowledge.created",
      source: "knowledge-network",
      data: { id, kind, name },
      priority: "low",
    });

    return entity;
  }

  /**
   * Get an entity by ID.
   */
  get(id: string): KnowledgeEntity | undefined {
    return this.entities.get(id);
  }

  /**
   * Update entity state.
   */
  updateState(id: string, newState: string, properties?: Record<string, unknown>): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    const oldState = entity.state.current;

    // Remove from old state index
    this.removeFromIndex(this.byState, oldState, id);

    // Update state
    entity.state.current = newState;
    entity.state.lastChanged = Date.now();
    if (properties) entity.state.properties = { ...entity.state.properties, ...properties };

    // Add to new state index
    this.addToIndex(this.byState, newState, id);

    // Add timeline entry
    entity.timeline.push({
      timestamp: Date.now(),
      state: newState,
      event: `state_changed: ${oldState} → ${newState}`,
    });

    entity.updatedAt = Date.now();
    entity.version++;
    this.stats.updated++;

    eventBus.publish({
      type: "knowledge.state_changed",
      source: "knowledge-network",
      data: { id, kind: entity.kind, oldState, newState },
      priority: "normal",
    });

    return true;
  }

  /**
   * Add evidence to an entity.
   */
  addEvidence(id: string, evidence: Evidence): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    entity.evidence.push(evidence);
    entity.updatedAt = Date.now();
    entity.version++;

    // Update confidence based on evidence
    const avgConfidence = entity.evidence.reduce((sum, e) => sum + e.confidence, 0) / entity.evidence.length;
    entity.confidence = avgConfidence;

    return true;
  }

  /**
   * Add a constraint to an entity.
   */
  addConstraint(id: string, constraintId: string): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    if (!entity.constraints.includes(constraintId)) {
      entity.constraints.push(constraintId);
      entity.updatedAt = Date.now();
      entity.version++;
    }

    return true;
  }

  /**
   * Add a capability to an entity.
   */
  addCapability(id: string, capability: string): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    if (!entity.capabilities.includes(capability)) {
      entity.capabilities.push(capability);
      entity.updatedAt = Date.now();
      entity.version++;
    }

    return true;
  }

  /**
   * Add a behavior to an entity.
   * 描述实体在特定条件下的反应。
   */
  addBehavior(id: string, behavior: Omit<Behavior, "id" | "observedCount" | "lastObserved">): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    const newBehavior: Behavior = {
      ...behavior,
      id: `beh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      observedCount: 1,
      lastObserved: Date.now(),
    };

    entity.behaviors.push(newBehavior);
    entity.updatedAt = Date.now();
    entity.version++;

    eventBus.publish({
      type: "knowledge.behavior_added",
      source: "knowledge-network",
      data: { entityId: id, behavior: newBehavior.trigger },
      priority: "normal",
    });

    return true;
  }

  /**
   * Add a prediction to an entity.
   * 基于行为的预测。
   */
  addPrediction(id: string, prediction: Omit<Prediction, "id" | "validated" | "validatedAt">): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    const newPrediction: Prediction = {
      ...prediction,
      id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      validated: false,
    };

    entity.predictions.push(newPrediction);
    entity.updatedAt = Date.now();
    entity.version++;

    eventBus.publish({
      type: "knowledge.prediction_added",
      source: "knowledge-network",
      data: { entityId: id, prediction: newPrediction.condition },
      priority: "normal",
    });

    return true;
  }

  /**
   * Add a hypothesis to an entity.
   * 假设验证机制。
   */
  addHypothesis(id: string, hypothesis: Omit<Hypothesis, "id" | "status" | "proposedAt">): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    const newHypothesis: Hypothesis = {
      ...hypothesis,
      id: `hyp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "proposed",
      proposedAt: Date.now(),
    };

    entity.hypotheses.push(newHypothesis);
    entity.updatedAt = Date.now();
    entity.version++;

    eventBus.publish({
      type: "knowledge.hypothesis_added",
      source: "knowledge-network",
      data: { entityId: id, hypothesis: newHypothesis.statement },
      priority: "normal",
    });

    return true;
  }

  /**
   * Resolve a hypothesis (confirm or reject).
   */
  resolveHypothesis(entityId: string, hypothesisId: string, status: "confirmed" | "rejected", evidence?: string): boolean {
    const entity = this.entities.get(entityId);
    if (!entity) return false;

    const hypothesis = entity.hypotheses.find((h) => h.id === hypothesisId);
    if (!hypothesis) return false;

    hypothesis.status = status;
    hypothesis.resolvedAt = Date.now();

    if (evidence) {
      if (status === "confirmed") {
        hypothesis.evidence.push(evidence);
      } else {
        hypothesis.counterEvidence.push(evidence);
      }
    }

    entity.updatedAt = Date.now();
    entity.version++;

    eventBus.publish({
      type: "knowledge.hypothesis_resolved",
      source: "knowledge-network",
      data: { entityId, hypothesisId, status },
      priority: "normal",
    });

    return true;
  }

  /**
   * Query entities by kind.
   */
  queryByKind(kind: EntityKind): KnowledgeEntity[] {
    this.stats.queried++;
    const ids = this.byKind.get(kind) ?? new Set();
    return Array.from(ids).map((id) => this.entities.get(id)!).filter(Boolean);
  }

  /**
   * Query entities by state.
   */
  queryByState(state: string): KnowledgeEntity[] {
    this.stats.queried++;
    const ids = this.byState.get(state) ?? new Set();
    return Array.from(ids).map((id) => this.entities.get(id)!).filter(Boolean);
  }

  /**
   * Search entities by content.
   */
  search(query: string, limit = 20): KnowledgeEntity[] {
    this.stats.queried++;
    const lower = query.toLowerCase();
    const results: KnowledgeEntity[] = [];

    for (const entity of this.entities.values()) {
      if (entity.name.toLowerCase().includes(lower) || entity.content.toLowerCase().includes(lower)) {
        results.push(entity);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Get entity timeline.
   */
  getTimeline(id: string): TimelineEntry[] {
    const entity = this.entities.get(id);
    return entity?.timeline ?? [];
  }

  /**
   * Get stats.
   */
  getStats(): { total: number; byKind: Record<string, number>; byState: Record<string, number>; created: number; queried: number; updated: number } {
    const byKind: Record<string, number> = {};
    for (const [kind, ids] of this.byKind) {
      byKind[kind] = ids.size;
    }
    const byState: Record<string, number> = {};
    for (const [state, ids] of this.byState) {
      byState[state] = ids.size;
    }
    return { total: this.entities.size, byKind, byState, ...this.stats };
  }

  // ─── Private ─────────────────────────────────────────────────────

  private addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key)!.add(id);
  }

  private removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    const set = index.get(key);
    if (set) {
      set.delete(id);
      if (set.size === 0) index.delete(key);
    }
  }
}

export const knowledgeNetwork = new KnowledgeNetworkImpl();
