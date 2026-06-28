/**
 * Atom Engine — Unified Atomic Representation
 *
 * Everything in the runtime is an Atom:
 * - Code: Function, Class, Statement, Expression
 * - Knowledge: Entity, Fact, Rule, Concept
 * - File: Document, Section, Paragraph, Sentence
 * - Task: Goal, Plan, Step, Action
 * - Memory: Observation, Experience, Belief
 *
 * Atoms are the ONLY data type the runtime operates on.
 * Markdown, SQLite, KG are all PROJECTIONS of Atoms.
 *
 * Inspired by: First Principles — decompose everything to indivisible facts.
 */

import { eventBus } from "./kernel.js";

// ─── Atom Types ────────────────────────────────────────────────────────────

export type AtomKind =
  // Code atoms
  | "function" | "class" | "interface" | "type" | "variable" | "statement" | "expression"
  // Knowledge atoms
  | "entity" | "fact" | "rule" | "concept" | "procedure"
  // Document atoms
  | "document" | "section" | "paragraph" | "sentence"
  // Task atoms
  | "goal" | "plan" | "step" | "action"
  // Memory atoms
  | "observation" | "experience" | "belief" | "insight"
  // System atoms
  | "event" | "state" | "constraint" | "relation"

export type AtomConfidence = "certain" | "inferred" | "uncertain" | "hypothetical";

export interface Atom {
  id: string
  kind: AtomKind
  content: string
  metadata: Record<string, unknown>
  relations: AtomRelation[]
  confidence: AtomConfidence
  source: string
  createdAt: number
  updatedAt: number
  version: number
  parentId?: string
  children: string[]
}

export interface AtomRelation {
  type: "is-a" | "part-of" | "depends-on" | "derives-from" | "related-to" | "causes" | "contradicts" | "supports"
  targetId: string
  weight: number
  metadata?: Record<string, unknown>
}

// ─── Atom Store ────────────────────────────────────────────────────────────

/**
 * In-memory atom store with indexing.
 * All operations are O(1) lookup by ID, O(n) by query.
 */
class AtomStoreImpl {
  private atoms = new Map<string, Atom>();
  private byKind = new Map<AtomKind, Set<string>>();
  private bySource = new Map<string, Set<string>>();
  private byParent = new Map<string, Set<string>>();
  private stats = { created: 0, updated: 0, deleted: 0 };

  /**
   * Create a new atom.
   */
  create(kind: AtomKind, content: string, opts?: {
    metadata?: Record<string, unknown>
    relations?: AtomRelation[]
    confidence?: AtomConfidence
    source?: string
    parentId?: string
  }): Atom {
    const id = `atom_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const atom: Atom = {
      id,
      kind,
      content,
      metadata: opts?.metadata ?? {},
      relations: opts?.relations ?? [],
      confidence: opts?.confidence ?? "inferred",
      source: opts?.source ?? "system",
      createdAt: now,
      updatedAt: now,
      version: 1,
      parentId: opts?.parentId,
      children: [],
    };

    this.atoms.set(id, atom);
    this.stats.created++;

    // Update indexes
    this.addToIndex(this.byKind, kind, id);
    if (opts?.source) this.addToIndex(this.bySource, opts.source, id);
    if (opts?.parentId) {
      this.addToIndex(this.byParent, opts.parentId, id);
      const parent = this.atoms.get(opts.parentId);
      if (parent) {
        parent.children.push(id);
        parent.updatedAt = now;
        parent.version++;
      }
    }

    // Publish event
    eventBus.publish({
      type: "atom.created",
      source: "atom-engine",
      data: { id, kind, content: content.slice(0, 100) },
      priority: "normal",
    });

    return atom;
  }

  /**
   * Get an atom by ID.
   */
  get(id: string): Atom | undefined {
    return this.atoms.get(id);
  }

  /**
   * Update an atom's content.
   */
  update(id: string, content: string, metadata?: Record<string, unknown>): Atom | undefined {
    const atom = this.atoms.get(id);
    if (!atom) return undefined;

    atom.content = content;
    if (metadata) atom.metadata = { ...atom.metadata, ...metadata };
    atom.updatedAt = Date.now();
    atom.version++;
    this.stats.updated++;

    eventBus.publish({
      type: "atom.updated",
      source: "atom-engine",
      data: { id, kind: atom.kind, version: atom.version },
      priority: "normal",
    });

    return atom;
  }

  /**
   * Delete an atom.
   */
  delete(id: string): boolean {
    const atom = this.atoms.get(id);
    if (!atom) return false;

    // Remove from indexes
    this.removeFromIndex(this.byKind, atom.kind, id);
    this.removeFromIndex(this.bySource, atom.source, id);
    if (atom.parentId) this.removeFromIndex(this.byParent, atom.parentId, id);

    // Remove from parent's children
    if (atom.parentId) {
      const parent = this.atoms.get(atom.parentId);
      if (parent) {
        parent.children = parent.children.filter((c) => c !== id);
      }
    }

    this.atoms.delete(id);
    this.stats.deleted++;

    eventBus.publish({
      type: "atom.deleted",
      source: "atom-engine",
      data: { id, kind: atom.kind },
      priority: "normal",
    });

    return true;
  }

  /**
   * Add a relation between atoms.
   */
  relate(sourceId: string, targetId: string, type: AtomRelation["type"], weight = 1.0): boolean {
    const source = this.atoms.get(sourceId);
    const target = this.atoms.get(targetId);
    if (!source || !target) return false;

    // Check for duplicate
    const exists = source.relations.some((r) => r.targetId === targetId && r.type === type);
    if (exists) return false;

    source.relations.push({ type, targetId, weight });
    source.updatedAt = Date.now();
    source.version++;

    // Add inverse relation
    const inverseType = this.getInverseRelationType(type);
    if (inverseType) {
      target.relations.push({ type: inverseType, targetId: sourceId, weight });
      target.updatedAt = Date.now();
      target.version++;
    }

    return true;
  }

  /**
   * Query atoms by kind.
   */
  queryByKind(kind: AtomKind): Atom[] {
    const ids = this.byKind.get(kind) ?? new Set();
    return Array.from(ids).map((id) => this.atoms.get(id)!).filter(Boolean);
  }

  /**
   * Query atoms by source.
   */
  queryBySource(source: string): Atom[] {
    const ids = this.bySource.get(source) ?? new Set();
    return Array.from(ids).map((id) => this.atoms.get(id)!).filter(Boolean);
  }

  /**
   * Query children of an atom.
   */
  queryChildren(parentId: string): Atom[] {
    const ids = this.byParent.get(parentId) ?? new Set();
    return Array.from(ids).map((id) => this.atoms.get(id)!).filter(Boolean);
  }

  /**
   * Get related atoms.
   */
  getRelated(id: string, relationType?: AtomRelation["type"]): Atom[] {
    const atom = this.atoms.get(id);
    if (!atom) return [];

    const relations = relationType
      ? atom.relations.filter((r) => r.type === relationType)
      : atom.relations;

    return relations
      .map((r) => this.atoms.get(r.targetId))
      .filter((a): a is Atom => a !== undefined);
  }

  /**
   * Search atoms by content (simple substring match).
   */
  search(query: string, limit = 20): Atom[] {
    const lower = query.toLowerCase();
    const results: Atom[] = [];

    for (const atom of this.atoms.values()) {
      if (atom.content.toLowerCase().includes(lower)) {
        results.push(atom);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Get stats.
   */
  getStats(): { total: number; byKind: Record<string, number>; created: number; updated: number; deleted: number } {
    const byKind: Record<string, number> = {};
    for (const [kind, ids] of this.byKind) {
      byKind[kind] = ids.size;
    }
    return { total: this.atoms.size, byKind, ...this.stats };
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

  private getInverseRelationType(type: AtomRelation["type"]): AtomRelation["type"] | null {
    const inverseMap: Record<string, AtomRelation["type"]> = {
      "is-a": "is-a",
      "part-of": "part-of",
      "depends-on": "derives-from",
      "derives-from": "depends-on",
      "related-to": "related-to",
      "causes": "causes",
      "contradicts": "contradicts",
      "supports": "supports",
    };
    return inverseMap[type] ?? null;
  }
}

export const atomStore = new AtomStoreImpl();

// ─── Atom Parsers ──────────────────────────────────────────────────────────

/**
 * Parse a code file into atoms.
 */
export function parseCodeToAtoms(code: string, filePath: string): Atom[] {
  const atoms: Atom[] = [];

  // Simple regex-based parsing (AST would be better in production)
  const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
  const classPattern = /(?:export\s+)?class\s+(\w+)/g;
  const interfacePattern = /(?:export\s+)?interface\s+(\w+)/g;

  let match: RegExpExecArray | null;

  while ((match = functionPattern.exec(code)) !== null) {
    atoms.push(atomStore.create("function", match[1], {
      source: filePath,
      metadata: { line: code.slice(0, match.index).split("\n").length },
    }));
  }

  while ((match = classPattern.exec(code)) !== null) {
    atoms.push(atomStore.create("class", match[1], {
      source: filePath,
      metadata: { line: code.slice(0, match.index).split("\n").length },
    }));
  }

  while ((match = interfacePattern.exec(code)) !== null) {
    atoms.push(atomStore.create("interface", match[1], {
      source: filePath,
      metadata: { line: code.slice(0, match.index).split("\n").length },
    }));
  }

  return atoms;
}

/**
 * Parse a markdown document into atoms.
 */
export function parseMarkdownToAtoms(markdown: string, filePath: string): Atom[] {
  const atoms: Atom[] = [];
  const lines = markdown.split("\n");

  let currentSection: Atom | null = null;
  let currentParagraph: Atom | null = null;
  let paragraphText: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Section header
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      // Flush previous paragraph
      if (paragraphText.length > 0 && currentSection) {
        currentParagraph = atomStore.create("paragraph", paragraphText.join("\n"), {
          source: filePath,
          parentId: currentSection.id,
          metadata: { line: i },
        });
        atoms.push(currentParagraph);
        paragraphText = [];
      }

      currentSection = atomStore.create("section", headerMatch[2], {
        source: filePath,
        metadata: { level: headerMatch[1].length, line: i },
      });
      atoms.push(currentSection);
      continue;
    }

    // Non-empty line: accumulate paragraph
    if (line.trim().length > 0) {
      paragraphText.push(line);
    } else if (paragraphText.length > 0 && currentSection) {
      currentParagraph = atomStore.create("paragraph", paragraphText.join("\n"), {
        source: filePath,
        parentId: currentSection.id,
        metadata: { line: i },
      });
      atoms.push(currentParagraph);
      paragraphText = [];
    }
  }

  // Flush last paragraph
  if (paragraphText.length > 0 && currentSection) {
    currentParagraph = atomStore.create("paragraph", paragraphText.join("\n"), {
      source: filePath,
      parentId: currentSection.id,
    });
    atoms.push(currentParagraph);
  }

  return atoms;
}
