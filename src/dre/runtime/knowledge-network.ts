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

import { eventBus } from "./event-bus.js";
import { atomStore, type AtomKind } from "./atom-engine.js";

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

/**
 * EntityLink — relationship between two entities.
 * The "network" needs edges, not just nodes.
 */
export interface EntityLink {
  id: string
  src: string
  dst: string
  relation: string
  weight: number
  evidence?: string
  createdAt: number
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

/** Max timeline entries kept per entity; oldest are trimmed when exceeded. */
const MAX_TIMELINE_ENTRIES = 1000;

class KnowledgeNetworkImpl {
  private entities = new Map<string, KnowledgeEntity>();
  private byKind = new Map<EntityKind, Set<string>>();
  private byState = new Map<string, Set<string>>();
  private links = new Map<string, EntityLink>();
  private linksBySrc = new Map<string, Set<string>>();
  private linksByDst = new Map<string, Set<string>>();
  /** Reverse index: entityId → atomId (for atomStore sync on update/delete) */
  private entityToAtom = new Map<string, string>();
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

    // Store as atom and track the atomId for sync on update/delete
    const atom = atomStore.create(kind as AtomKind, name, {
      source: opts?.source ?? "knowledge-network",
      confidence: opts?.confidence ? (opts.confidence > 0.8 ? "certain" : opts.confidence > 0.5 ? "inferred" : "uncertain") : "inferred",
      metadata: { entityId: id },
    });
    this.entityToAtom.set(id, atom.id);

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
    this.trimTimeline(entity);

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
   * Update entity content/name (with version bump + timeline entry).
   * Syncs the corresponding atom in atomStore so ContextEngine sees fresh content.
   */
  update(id: string, patch: { name?: string; content?: string }): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    const changes: string[] = [];
    if (patch.name !== undefined && patch.name !== entity.name) {
      entity.name = patch.name;
      changes.push("name");
    }
    if (patch.content !== undefined && patch.content !== entity.content) {
      entity.content = patch.content;
      changes.push("content");
    }
    if (changes.length === 0) return true;

    entity.timeline.push({
      timestamp: Date.now(),
      state: entity.state.current,
      event: `updated: ${changes.join(", ")}`,
    });
    this.trimTimeline(entity);
    entity.updatedAt = Date.now();
    entity.version++;
    this.stats.updated++;

    // Sync atom store — use name as atom content (matches create() behavior)
    const atomId = this.entityToAtom.get(id);
    if (atomId) {
      atomStore.update(atomId, entity.name, { entityId: id });
    }

    eventBus.publish({
      type: "knowledge.updated",
      source: "knowledge-network",
      data: { id, changes },
      priority: "normal",
    });

    return true;
  }

  /**
   * Delete an entity. Also removes all links referencing it and the corresponding atom.
   */
  delete(id: string): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    this.removeFromIndex(this.byKind, entity.kind, id);
    this.removeFromIndex(this.byState, entity.state.current, id);
    this.entities.delete(id);

    // Remove all links that reference this entity
    const linkIdsToRemove = new Set<string>();
    const srcLinks = this.linksBySrc.get(id);
    if (srcLinks) for (const lid of srcLinks) linkIdsToRemove.add(lid);
    const dstLinks = this.linksByDst.get(id);
    if (dstLinks) for (const lid of dstLinks) linkIdsToRemove.add(lid);

    for (const lid of linkIdsToRemove) {
      this.deleteLink(lid);
    }

    // Remove the corresponding atom to prevent stale references in ContextEngine
    const atomId = this.entityToAtom.get(id);
    if (atomId) {
      atomStore.delete(atomId);
      this.entityToAtom.delete(id);
    }

    eventBus.publish({
      type: "knowledge.deleted",
      source: "knowledge-network",
      data: { id, kind: entity.kind },
      priority: "normal",
    });

    return true;
  }

  /**
   * Create a directed link between two entities.
   * If a link with the same src/dst/relation already exists, update its weight/evidence
   * instead of creating a duplicate (matches atomStore.relate() dedup behavior).
   * Both endpoints must exist.
   */
  link(src: string, dst: string, relation: string, opts?: { weight?: number; evidence?: string }): EntityLink | null {
    if (!this.entities.has(src) || !this.entities.has(dst)) return null;

    // Check for existing link with same src/dst/relation
    const existing = this.findLink(src, dst, relation);
    if (existing) {
      if (opts?.weight !== undefined) existing.weight = opts.weight;
      if (opts?.evidence !== undefined) existing.evidence = opts.evidence;
      return existing;
    }

    const id = `link_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const link: EntityLink = {
      id,
      src,
      dst,
      relation,
      weight: opts?.weight ?? 1.0,
      evidence: opts?.evidence,
      createdAt: Date.now(),
    };

    this.links.set(id, link);
    this.addToIndex(this.linksBySrc, src, id);
    this.addToIndex(this.linksByDst, dst, id);

    eventBus.publish({
      type: "knowledge.linked",
      source: "knowledge-network",
      data: { id, src, dst, relation },
      priority: "low",
    });

    return link;
  }

  /**
   * Find an existing link by src/dst/relation triple.
   */
  private findLink(src: string, dst: string, relation: string): EntityLink | undefined {
    const linkIds = this.linksBySrc.get(src);
    if (!linkIds) return undefined;
    for (const lid of linkIds) {
      const link = this.links.get(lid);
      if (link && link.dst === dst && link.relation === relation) return link;
    }
    return undefined;
  }

  /**
   * Get all links from an entity (outgoing).
   */
  getLinksFrom(src: string): EntityLink[] {
    const ids = this.linksBySrc.get(src);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.links.get(id)!).filter(Boolean);
  }

  /**
   * Get all links to an entity (incoming).
   */
  getLinksTo(dst: string): EntityLink[] {
    const ids = this.linksByDst.get(dst);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.links.get(id)!).filter(Boolean);
  }

  /**
   * Get stats.
   */
  getStats(): { total: number; byKind: Record<string, number>; byState: Record<string, number>; created: number; queried: number; updated: number; links: number } {
    const byKind: Record<string, number> = {};
    for (const [kind, ids] of this.byKind) {
      byKind[kind] = ids.size;
    }
    const byState: Record<string, number> = {};
    for (const [state, ids] of this.byState) {
      byState[state] = ids.size;
    }
    return { total: this.entities.size, byKind, byState, links: this.links.size, ...this.stats };
  }

  /**
   * Reset all network state. Useful for tests.
   */
  reset(): void {
    this.entities.clear();
    this.byKind.clear();
    this.byState.clear();
    this.links.clear();
    this.linksBySrc.clear();
    this.linksByDst.clear();
    this.entityToAtom.clear();
    this.stats = { created: 0, queried: 0, updated: 0 };
  }

  // ─── Private ─────────────────────────────────────────────────────

  private deleteLink(linkId: string): void {
    const link = this.links.get(linkId);
    if (!link) return;
    this.links.delete(linkId);
    this.removeFromIndex(this.linksBySrc, link.src, linkId);
    this.removeFromIndex(this.linksByDst, link.dst, linkId);
  }

  private trimTimeline(entity: KnowledgeEntity): void {
    while (entity.timeline.length > MAX_TIMELINE_ENTRIES) {
      entity.timeline.shift();
    }
  }

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
