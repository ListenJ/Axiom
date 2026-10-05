/**
 * Vault wiki-link 索引同步叶子模块（P2-2）。
 *
 * 只负责把 DeterministicSearchEngine 已解析的出链写入 SQLiteMemory；
 * 失败仅日志降级，不阻断 Vault 写入。拆出以保持 vault-manager.ts 的架构行数棘轮。
 */
import type { DeterministicSearchEngine } from "./deterministic-search.js";
import type { SQLiteMemory } from "./sqlite-memory.js";
import { logger } from "../utils/logger.js";

export function syncWikiLinks(
  engine: DeterministicSearchEngine,
  sqliteMemory: SQLiteMemory,
  notePath: string,
): void {
  try {
    const links = engine.getWikiOutgoingLinks(notePath).map((link) => ({
      targetText: link.targetText,
      targetPath: link.targetPath,
    }));
    sqliteMemory.replaceWikiLinks(notePath, links);
  } catch (e) {
    logger.warn("[Vault] wiki-link index sync failed", {
      path: notePath,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 写入/覆盖后刷新引擎并同步当前笔记出链；失败不抛穿 Vault 写路径。 */
export function reloadAndSyncWikiLinks(
  engine: DeterministicSearchEngine,
  sqliteMemory: SQLiteMemory,
  vaultPath: string,
  notePath: string,
): void {
  try {
    engine.reload(vaultPath);
    syncWikiLinks(engine, sqliteMemory, notePath);
  } catch (e) {
    logger.warn("[Vault] post-write wiki-link reload failed", {
      path: notePath,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
