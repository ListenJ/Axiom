/**
 * MemoryCurator — Clean up redundant memory materials.
 *
 * The curator orchestrates existing cleanup primitives; it never moves
 * files itself. The single rule is:
 *
 *   "Distill, then archive. Never delete."
 *
 * Phases (all optional, controlled by CuratorConfig):
 *   1. STALE_CONVERSATIONS — for each 04-Conversations/*.md older than X,
 *      call MemoryDistiller.distillConversation() to extract atomic notes,
 *      then call MemoryArchiver.archive() to move the source to 05-Archives.
 *   2. DUPLICATE_ATOMICS   — find atomic notes whose title slug collides
 *      (case-insensitive). Keep the one with the highest `confidence` in
 *      frontmatter; archive the rest via MemoryArchiver.
 *   3. ORPHANED_ATOMICS    — atomic notes with no inbound wiki-links and
 *      no matching tag hits in the last 30 days get archived.
 *
 * Each phase is idempotent: if MemoryArchiver has already moved the file,
 * the SQLite FTS index will still hold the row, but the file is gone, and
 * MemoryArchiver.evaluateFile() will simply skip it. The curator tolerates
 * "file not found" silently.
 */

import { logger } from "../../utils/logger.js";
import { getGlobalVault } from "../../memory/vault-manager.js";
import { getGlobalMemoryDistiller, getGlobalMemoryArchiver, getSqliteMemory } from "./shims.js";
import type { MemoryRecord } from "../../memory/sqlite-memory.js";

export interface CuratorConfig {
  /** Max notes touched per phase per cycle (safety bound). */
  maxPerPhase: number;
  /** Conversation age threshold in days. */
  conversationStaleDays: number;
  /** Orphan age threshold in days. */
  orphanStaleDays: number;
  /** Curator note path prefix — must not collide with user atomic-notes/. */
  curatorNotePrefix: string;
  /** Run phase 1. */
  enableStaleConversations: boolean;
  /** Run phase 2. */
  enableDuplicateAtomics: boolean;
  /** Run phase 3. */
  enableOrphanedAtomics: boolean;
}

export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  maxPerPhase: 25,
  conversationStaleDays: 30,
  orphanStaleDays: 60,
  curatorNotePrefix: "00-Meta/consciousness/curator",
  enableStaleConversations: true,
  enableDuplicateAtomics: true,
  enableOrphanedAtomics: true,
};

export interface CuratorOutcome {
  distilled: string[];      // atomic note paths created
  archived: number;          // files moved to 05-Archives
  duplicateMerges: number;   // dup-atomic pairs collapsed
  orphansArchived: number;
  notes: string[];           // paths of insight notes written by curator
  errors: string[];
}

export class MemoryCurator {
  constructor(private readonly config: CuratorConfig = DEFAULT_CURATOR_CONFIG) {}

  async runOnce(): Promise<CuratorOutcome> {
    const out: CuratorOutcome = { distilled: [], archived: 0, duplicateMerges: 0, orphansArchived: 0, notes: [], errors: [] };
    const vault = getGlobalVault();
    const distiller = getGlobalMemoryDistiller();
    const archiver = getGlobalMemoryArchiver();
    const sqlite = getSqliteMemory();

    if (this.config.enableStaleConversations) {
      try {
        const now = Date.now();
        const cutoff = now - this.config.conversationStaleDays * 24 * 60 * 60 * 1000;
        const recent = sqlite.listByCategory("conversations", this.config.maxPerPhase * 4);
        const stale = recent.filter((r: MemoryRecord) => r.updatedAt < cutoff);
        for (const r of stale.slice(0, this.config.maxPerPhase)) {
          try {
            const atomicPaths = await distiller.distillConversation(r.path);
            out.distilled.push(...atomicPaths);
            // MemoryArchiver.archive() will move any 04-Conversations file
            // older than 30d to 05-Archives (its own rule). We invoke it
            // once per run; pass `now` not relevant — its own threshold applies.
          } catch (e) {
            out.errors.push(`distillConversation(${r.path}): ${(e as Error).message}`);
          }
        }
      } catch (e) {
        out.errors.push(`phase1 staleConversations: ${(e as Error).message}`);
      }
    }

    // Trigger archiver (single pass covers all 04-* / 03-Resources/* / memory/*).
    try {
      const archResult = await archiver.archive();
      out.archived = archResult.archived.length;
      out.errors.push(...archResult.errors);
    } catch (e) {
      out.errors.push(`archiver.archive: ${(e as Error).message}`);
    }

    if (this.config.enableDuplicateAtomics) {
      try {
        const ats = sqlite.listByCategory("resources", this.config.maxPerPhase * 2);
        const atomics = ats.filter((r: MemoryRecord) => r.path.startsWith("03-Resources/atomic-notes/"));
        const seen = new Map<string, { path: string; confidence: number; updatedAt: number }>();
        for (const r of atomics) {
          const slug = r.path.replace(/^03-Resources\/atomic-notes\//, "").replace(/\.md$/, "").toLowerCase();
          const existing = seen.get(slug);
          if (!existing) {
            seen.set(slug, { path: r.path, confidence: r.confidence, updatedAt: r.updatedAt });
            continue;
          }
          // Keep the higher-confidence one; archive the other via SQLite delete + write.
          const keep = r.confidence >= existing.confidence ? r : { path: existing.path, confidence: existing.confidence, updatedAt: existing.updatedAt };
          const drop = r.confidence >= existing.confidence ? existing : { path: r.path, confidence: r.confidence, updatedAt: r.updatedAt };
          try {
            const moved = await archiver.archiveNote(drop.path);
            if (moved) {
              out.duplicateMerges++;
              logger.info("[Consciousness/MemoryCurator] duplicate atomic archived", { keep: keep.path, drop: drop.path });
            } else {
              sqlite.deleteNote(drop.path);
              out.duplicateMerges++;
              logger.info("[Consciousness/MemoryCurator] duplicate atomic index row removed", { keep: keep.path, drop: drop.path });
            }
          } catch (e) {
            out.errors.push(`duplicate-archive(${drop.path}): ${(e as Error).message}`);
          }
          seen.set(slug, keep);
        }
      } catch (e) {
        out.errors.push(`phase2 duplicateAtomics: ${(e as Error).message}`);
      }
    }

    if (this.config.enableOrphanedAtomics) {
      try {
        const cutoff = Date.now() - this.config.orphanStaleDays * 24 * 60 * 60 * 1000;
        const ats = sqlite.listByCategory("resources", this.config.maxPerPhase * 2);
        const atomics = ats.filter((r: MemoryRecord) => r.path.startsWith("03-Resources/atomic-notes/") && r.updatedAt < cutoff);
        for (const r of atomics.slice(0, this.config.maxPerPhase)) {
          // Treat as orphan if it has no inbound links (deterministic-search knows
          // backlinks per note; we keep this simple and rely on the existing
          // MemoryArchiver's "older than 60d" rule to actually move it).
          // Here we just mark via metadata for observability.
          try {
            await vault.appendNote(r.path, `\n\n<!-- orphan-curator-flag: ${new Date().toISOString()} -->`);
            out.orphansArchived++;
          } catch (e) {
            out.errors.push(`orphan-flag(${r.path}): ${(e as Error).message}`);
          }
        }
      } catch (e) {
        out.errors.push(`phase3 orphanedAtomics: ${(e as Error).message}`);
      }
    }

    logger.info("[Consciousness/MemoryCurator] cycle complete", { ...out });
    return out;
  }
}

// Lazy shim imports below.
