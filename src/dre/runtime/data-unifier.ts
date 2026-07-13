/**
 * DataUnifier — 统一数据入口
 *
 * 所有数据通过 DataUnifier 写入和查询。
 * 内部协调 AtomEngine (原子) + KnowledgeStore (知识) + VFS (文件)。
 * 外部只看到一个 write/search/query 接口。
 *
 * 替代 VFS + KnowledgeStore + AtomEngine 三个独立入口的混乱局面。
 */

import { atomStore, type Atom, type AtomKind, type AtomConfidence } from "./atom-engine.js";
import type { KnowledgeStore, KnowledgeNode, KnowledgeParadigm, KGEdge } from "../storage/knowledge-store.js";
import type { Database } from "bun:sqlite";
import { logger } from "../../utils/logger.js";

/** AtomConfidence → 数值置信度映射 (KnowledgeNode.confidence 需要 number) */
function mapConfidence(c: AtomConfidence | undefined): number {
  switch (c) {
    case "certain": return 0.9;
    case "inferred": return 0.7;
    case "uncertain": return 0.4;
    case "hypothetical": return 0.2;
    default: return 0.5;
  }
}

export interface DataItem {
  id?: string;
  content: string;
  kind: AtomKind;
  domain?: string;
  paradigm?: string;
  sourceType?: string;
  confidence?: AtomConfidence;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  limit?: number;
  domain?: string;
  paradigm?: string;
  minConfidence?: number;
  kind?: AtomKind;
}

export interface SearchResult {
  atoms: Atom[];
  knowledgeNodes: KnowledgeNode[];
}

/**
 * 统一数据入口
 */
export class DataUnifier {
  private db: Database | null = null;
  private knowledgeStore: KnowledgeStore | null = null;
  private autoPersist = false;

  /**
   * 初始化 — 连接数据库和存储后端
   */
  init(db: Database, knowledgeStore: KnowledgeStore): void {
    this.db = db;
    this.knowledgeStore = knowledgeStore;
    atomStore.initPersist(db);
    // 尝试从 SQLite 加载已有原子
    try {
      const loaded = atomStore.load(db);
      if (loaded > 0) logger.info("[DataUnifier] Restored atoms from SQLite", { count: loaded });
    } catch {
      // 首次运行: 表可能还不存在
      logger.info("[DataUnifier] No persisted atoms found (fresh start)");
    }
  }

  /**
   * 写入数据 — 同时创建 Atom + 写入 KnowledgeStore
   */
  write(item: DataItem): { atom: Atom; knowledgeNode?: KnowledgeNode } {
    // 1. 创建 Atom (核心抽象)
    const atom = atomStore.create(item.kind, item.content, {
      metadata: {
        ...item.metadata,
        domain: item.domain,
        paradigm: item.paradigm,
        sourceType: item.sourceType,
      },
      confidence: item.confidence ?? "inferred",
      source: item.sourceType ?? "data-unifier",
    });

    // 2. 同步写入 KnowledgeStore (知识持久化)
    let knowledgeNode: KnowledgeNode | undefined;
    if (this.knowledgeStore) {
      try {
        const sourceType = (item.sourceType ?? "manual") as KnowledgeNode["sourceType"];
        const node = this.knowledgeStore.write({
          nodeId: atom.id,
          title: item.content.slice(0, 100),
          content: item.content,
          schemaVersion: 1,
          domain: item.domain ?? "general",
          paradigm: (item.paradigm ?? "fact") as KnowledgeParadigm,
          confidence: mapConfidence(item.confidence),
          sourceType,
          isVerified: false,
        });
        knowledgeNode = node;
      } catch (err) {
        logger.warn("[DataUnifier] KnowledgeStore write failed", { error: (err as Error).message });
      }
    }

    // 3. 可选自动持久化 — persist only the newly written atom (O(1)), not the
    // entire store. The old code called atomStore.persist(this.db) on every
    // write, which re-upserted all N atoms each time — O(N²) over N writes.
    if (this.autoPersist && this.db) {
      try {
        atomStore.persistOne(this.db, atom);
      } catch (err) {
        logger.warn("[DataUnifier] persistOne failed", { error: (err as Error).message });
      }
    }

    return { atom, knowledgeNode };
  }

  /**
   * 搜索 — 同时搜索 Atom 和 KnowledgeStore
   */
  search(query: string, options: SearchOptions = {}): SearchResult {
    let atoms = atomStore.search(query, options.limit ?? 20);
    if (options.kind) {
      atoms = atoms.filter((a) => a.kind === options.kind);
    }

    let knowledgeNodes: KnowledgeNode[] = [];
    if (this.knowledgeStore) {
      try {
        knowledgeNodes = this.knowledgeStore.search(query, {
          domain: options.domain,
          paradigm: options.paradigm,
          minConfidence: options.minConfidence,
          limit: options.limit,
        });
      } catch {
        // non-fatal
      }
    }

    return { atoms, knowledgeNodes };
  }

  /**
   * 按种类查询 Atom
   */
  queryByKind(kind: AtomKind): Atom[] {
    return atomStore.queryByKind(kind);
  }

  /**
   * 按源查询 Atom
   */
  queryBySource(source: string): Atom[] {
    return atomStore.queryBySource(source);
  }

  /**
   * 持久化所有 Atom 到 SQLite
   */
  persist(): void {
    if (this.db) {
      try { atomStore.persist(this.db); } catch (err) {
        logger.warn("[DataUnifier] Persist failed", { error: (err as Error).message });
      }
    }
  }

  /**
   * 开启/关闭自动持久化
   */
  setAutoPersist(enabled: boolean): void {
    this.autoPersist = enabled;
  }

  /**
   * 获取 Atom 统计
   */
  getAtomStats() {
    return atomStore.getStats();
  }
}

/** 全局单例 */
export const dataUnifier = new DataUnifier();
