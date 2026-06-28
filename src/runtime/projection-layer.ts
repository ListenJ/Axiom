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

  async project(): Promise<void> {
    const stats = atomStore.getStats();
    logger.debug("[MarkdownProjection] Projecting", { atoms: stats.total });
  }

  async rebuild(): Promise<void> {
    logger.info("[MarkdownProjection] Rebuilding from world state");
    // Would regenerate all markdown files from atoms
  }

  getStats(): Record<string, unknown> {
    return { atoms: atomStore.getStats().total };
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

  async project(): Promise<void> {
    const stats = atomStore.getStats();
    logger.debug("[SQLiteProjection] Projecting", { atoms: stats.total });
  }

  async rebuild(): Promise<void> {
    logger.info("[SQLiteProjection] Rebuilding from world state");
    // Would regenerate all SQLite tables from atoms
  }

  getStats(): Record<string, unknown> {
    return { atoms: atomStore.getStats().total };
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

  async project(): Promise<void> {
    const stats = atomStore.getStats();
    logger.debug("[KGProjection] Projecting", { atoms: stats.total });
  }

  async rebuild(): Promise<void> {
    logger.info("[KGProjection] Rebuilding from world state");
    // Would regenerate KG from atom relations
  }

  getStats(): Record<string, unknown> {
    return { atoms: atomStore.getStats().total };
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

  async project(): Promise<void> {
    // Cache hot atoms
    const recentAtoms = atomStore.queryByKind("observation");
    for (const atom of recentAtoms.slice(-100)) {
      this.cache.set(atom.id, atom);
    }
  }

  async rebuild(): Promise<void> {
    this.cache.clear();
    await this.project();
  }

  getStats(): Record<string, unknown> {
    return { cached: this.cache.size };
  }

  get(id: string): unknown {
    return this.cache.get(id);
  }
}

// ─── Initialize Projections ────────────────────────────────────────────────

export function initProjections(): void {
  projectionRegistry.register(new MarkdownProjection());
  projectionRegistry.register(new SQLiteProjection());
  projectionRegistry.register(new KGProjection());
  projectionRegistry.register(new CacheProjection());

  // Subscribe to state changes and update projections
  eventBus.subscribe("state.changed", async () => {
    // Debounce: only project every 5 seconds
    // In production, this would be more sophisticated
  });

  logger.info("[ProjectionLayer] Initialized all projections");
}
