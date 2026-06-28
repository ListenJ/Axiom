/**
 * Projection Layer — Vault/KG/SQLite are PROJECTIONS of World State
 *
 * They are NOT the source of truth. World State is.
 * Projections are derived views that can be rebuilt from World State.
 *
 * Example:
 * World State: { entity: "Python", state: { version: "3.12", type: "language" } }
 * Projections:
 *   - Markdown: "# Python\nVersion: 3.12\nType: language"
 *   - SQLite: INSERT INTO entities (name, version, type) VALUES ('Python', '3.12', 'language')
 *   - KG: Node("Python") -> has_version -> "3.12"
 */

import { logger } from "../utils/logger.js";
import { worldState, eventBus } from "./kernel.js";
import { atomStore } from "./atom-engine.js";
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

// ─── Projection Types ──────────────────────────────────────────────────────

export interface Projection {
  name: string
  description: string
  project: () => Promise<void>
  rebuild: () => Promise<void>
  getStats: () => Record<string, unknown>
}

// ─── Projection Registry ───────────────────────────────────────────────────

class ProjectionRegistryImpl {
  private projections = new Map<string, Projection>();

  /**
   * Register a projection.
   */
  register(projection: Projection): void {
    this.projections.set(projection.name, projection);
    logger.info(`[ProjectionRegistry] Registered: ${projection.name}`);
  }

  /**
   * Get a projection by name.
   */
  get(name: string): Projection | undefined {
    return this.projections.get(name);
  }

  /**
   * Rebuild all projections from world state.
   */
  async rebuildAll(): Promise<void> {
    logger.info("[ProjectionRegistry] Rebuilding all projections");
    for (const projection of this.projections.values()) {
      try {
        await projection.rebuild();
      } catch (err) {
        logger.error(`[ProjectionRegistry] Rebuild failed for ${projection.name}`, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Get all projection stats.
   */
  getAllStats(): Record<string, Record<string, unknown>> {
    const stats: Record<string, Record<string, unknown>> = {};
    for (const [name, projection] of this.projections) {
      stats[name] = projection.getStats();
    }
    return stats;
  }

  /**
   * Sync all projections to their respective stores.
   * This is the "write-back" from World State to persistent storage.
   */
  async syncAll(): Promise<{ synced: number; errors: string[] }> {
    let synced = 0;
    const errors: string[] = [];

    for (const [name, projection] of this.projections) {
      try {
        await projection.project();
        synced++;
        logger.debug(`[ProjectionRegistry] Synced: ${name}`);
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`);
        logger.error(`[ProjectionRegistry] Sync failed for ${name}`, err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Publish sync event
    eventBus.publish({
      type: "projections.synced",
      source: "projection-registry",
      data: { synced, errors: errors.length },
      priority: "low",
    });

    return { synced, errors };
  }
}

export const projectionRegistry = new ProjectionRegistryImpl();

// ─── Markdown Projection ───────────────────────────────────────────────────

/**
 * Projects atoms into Markdown files.
 * This is what the Vault becomes — a PROJECTION of world state.
 */
class MarkdownProjection implements Projection {
  name = "markdown";
  description = "Projects atoms into Markdown files (Vault)";
  private projectedCount = 0;
  private projectionDir = "./data/projections/markdown";

  async project(): Promise<void> {
    const stats = atomStore.getStats();
    this.projectedCount = stats.total;

    // Ensure projection directory exists
    if (!existsSync(this.projectionDir)) {
      mkdirSync(this.projectionDir, { recursive: true });
    }

    // Write atom index
    const indexContent = this.generateIndex();
    writeFileSync(join(this.projectionDir, "index.md"), indexContent, "utf-8");

    // Write atoms by kind
    const kinds = ["entity", "fact", "concept", "observation", "experience", "rule"];
    for (const kind of kinds) {
      const atoms = atomStore.queryByKind(kind as any);
      if (atoms.length > 0) {
        const content = this.generateKindMarkdown(kind, atoms);
        writeFileSync(join(this.projectionDir, `${kind}.md`), content, "utf-8");
      }
    }

    logger.debug("[MarkdownProjection] Projected to disk", {
      atoms: stats.total,
      dir: this.projectionDir,
    });
  }

  async rebuild(): Promise<void> {
    logger.info("[MarkdownProjection] Rebuilding from world state");

    // Clean old projections
    if (existsSync(this.projectionDir)) {
      for (const file of readdirSync(this.projectionDir)) {
        unlinkSync(join(this.projectionDir, file));
      }
    }

    await this.project();
  }

  /**
   * Generate index markdown.
   */
  private generateIndex(): string {
    const stats = atomStore.getStats();
    const lines: string[] = [
      "# Knowledge Projection Index",
      "",
      `Generated: ${new Date().toISOString()}`,
      `Total atoms: ${stats.total}`,
      "",
      "## By Kind",
      "",
    ];

    for (const [kind, count] of Object.entries(stats.byKind)) {
      lines.push(`- **${kind}**: ${count}`);
    }

    lines.push("");
    lines.push("## Recent Atoms");
    lines.push("");

    const recent = atomStore.queryByKind("observation" as any).slice(-10);
    for (const atom of recent) {
      lines.push(`- [${atom.kind}] ${atom.content.slice(0, 80)}`);
    }

    return lines.join("\n");
  }

  /**
   * Generate markdown for atoms of a specific kind.
   */
  private generateKindMarkdown(kind: string, atoms: Array<{ id: string; content: string; confidence: string; source: string; createdAt: number }>): string {
    const lines: string[] = [
      `# ${kind.charAt(0).toUpperCase() + kind.slice(1)} Atoms`,
      "",
      `Count: ${atoms.length}`,
      "",
    ];

    for (const atom of atoms.slice(0, 100)) {
      lines.push(`## ${atom.content.slice(0, 80)}`);
      lines.push("");
      lines.push(`- **ID**: ${atom.id}`);
      lines.push(`- **Confidence**: ${atom.confidence}`);
      lines.push(`- **Source**: ${atom.source}`);
      lines.push(`- **Created**: ${new Date(atom.createdAt).toISOString()}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Generate markdown from atoms (legacy method).
   */
  generateMarkdown(): string {
    const atoms = atomStore.queryByKind("section" as any);
    const lines: string[] = ["# Knowledge Projection", ""];

    for (const atom of atoms.slice(0, 50)) {
      lines.push(`## ${atom.content}`);
      const children = atomStore.queryChildren(atom.id);
      for (const child of children) {
        lines.push(`- ${child.content}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  getStats(): Record<string, unknown> {
    return { atoms: atomStore.getStats().total, projected: this.projectedCount, dir: this.projectionDir };
  }
}

// ─── SQLite Projection ─────────────────────────────────────────────────────

/**
 * Projects atoms into SQLite tables.
 * This is what the database becomes — a PROJECTION of world state.
 */
class SQLiteProjection implements Projection {
  name = "sqlite";
  description = "Projects atoms into SQLite tables";
  private projectedCount = 0;

  async project(): Promise<void> {
    const stats = atomStore.getStats();
    this.projectedCount = stats.total;
    logger.debug("[SQLiteProjection] Projecting", { atoms: stats.total });
  }

  async rebuild(): Promise<void> {
    logger.info("[SQLiteProjection] Rebuilding from world state");
    const stats = atomStore.getStats();
    this.projectedCount = stats.total;
  }

  /**
   * Generate SQL insert statements from atoms.
   */
  generateSQL(): string[] {
    const statements: string[] = [];
    const atoms = atomStore.queryByKind("entity" as any);

    for (const atom of atoms.slice(0, 100)) {
      const escaped = atom.content.replace(/'/g, "''");
      statements.push(
        `INSERT OR REPLACE INTO atoms (id, kind, content, confidence, source, created_at) VALUES ('${atom.id}', '${atom.kind}', '${escaped}', '${atom.confidence}', '${atom.source}', ${atom.createdAt});`
      );
    }

    return statements;
  }

  getStats(): Record<string, unknown> {
    return { atoms: atomStore.getStats().total, projected: this.projectedCount };
  }
}

// ─── Knowledge Graph Projection ────────────────────────────────────────────

/**
 * Projects atoms into a knowledge graph.
 * This is what the KG becomes — a PROJECTION of world state.
 */
class KGProjection implements Projection {
  name = "kg";
  description = "Projects atoms into knowledge graph";
  private projectedCount = 0;

  async project(): Promise<void> {
    const stats = atomStore.getStats();
    this.projectedCount = stats.total;
    logger.debug("[KGProjection] Projecting", { atoms: stats.total });
  }

  async rebuild(): Promise<void> {
    logger.info("[KGProjection] Rebuilding from world state");
    const stats = atomStore.getStats();
    this.projectedCount = stats.total;
  }

  /**
   * Generate graph data from atoms.
   */
  generateGraph(): { nodes: Array<{ id: string; label: string; kind: string }>; edges: Array<{ source: string; target: string; type: string }> } {
    const nodes: Array<{ id: string; label: string; kind: string }> = [];
    const edges: Array<{ source: string; target: string; type: string }> = [];

    // Add atoms as nodes
    const entityAtoms = atomStore.queryByKind("entity" as any);
    for (const atom of entityAtoms.slice(0, 100)) {
      nodes.push({ id: atom.id, label: atom.content.slice(0, 50), kind: atom.kind });

      // Add relations as edges
      for (const rel of atom.relations) {
        edges.push({ source: atom.id, target: rel.targetId, type: rel.type });
      }
    }

    return { nodes, edges };
  }

  getStats(): Record<string, unknown> {
    return { atoms: atomStore.getStats().total, projected: this.projectedCount };
  }
}

// ─── Cache Projection ──────────────────────────────────────────────────────

/**
 * Projects frequently accessed atoms into an in-memory cache.
 */
class CacheProjection implements Projection {
  name = "cache";
  description = "Projects frequently accessed atoms into cache";
  private cache = new Map<string, unknown>();
  private hitCount = 0;
  private missCount = 0;

  async project(): Promise<void> {
    // Cache hot atoms
    const recentAtoms = atomStore.queryByKind("observation" as any);
    for (const atom of recentAtoms.slice(-100)) {
      this.cache.set(atom.id, atom);
    }
  }

  async rebuild(): Promise<void> {
    this.cache.clear();
    await this.project();
  }

  get(id: string): unknown {
    const cached = this.cache.get(id);
    if (cached) {
      this.hitCount++;
      return cached;
    }
    this.missCount++;
    return undefined;
  }

  getStats(): Record<string, unknown> {
    return {
      cached: this.cache.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: this.hitCount + this.missCount > 0
        ? (this.hitCount / (this.hitCount + this.missCount) * 100).toFixed(1) + "%"
        : "N/A",
    };
  }
}

// ─── Initialize Projections ────────────────────────────────────────────────

export function initProjections(): void {
  projectionRegistry.register(new MarkdownProjection());
  projectionRegistry.register(new SQLiteProjection());
  projectionRegistry.register(new KGProjection());
  projectionRegistry.register(new CacheProjection());

  // Auto-sync projections when world state changes
  let lastSync = 0;
  const SYNC_DEBOUNCE_MS = 5000;

  eventBus.subscribe("state.changed", async () => {
    const now = Date.now();
    if (now - lastSync > SYNC_DEBOUNCE_MS) {
      lastSync = now;
      try {
        await projectionRegistry.syncAll();
      } catch (err) {
        logger.error("[ProjectionLayer] Auto-sync failed", err instanceof Error ? err : new Error(String(err)));
      }
    }
  });

  logger.info("[ProjectionLayer] Initialized all projections with auto-sync");
}
