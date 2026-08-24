/**
 * 统一知识访问层 (Knowledge Access Layer)
 *
 * 核心功能:
 * 1. 统一查询接口 — 一次查询，fan-out 到多个存储
 * 2. 结果合并 — 跨存储的结果按相关性排序
 * 3. 统一格式 — 所有知识单元返回相同的结构
 * 4. 存储路由 — 根据查询意图自动选择存储
 *
 * 支持的存储:
 * - Vault: 笔记内容搜索 (FTS5)
 * - KG: 图谱关系查询 (SQLite)
 * - DRE: 确定性知识查询 (SQLite)
 */

import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { createNodeId, parseNodeId, type StorePrefix } from "./node-id.js";

// ========== 统一知识单元 ==========

/** 知识单元 — 跨存储的统一格式 */
export interface KnowledgeUnit {
  /** 全局 node_id */
  nodeId: string;
  /** 来源存储 */
  store: StorePrefix;
  /** 知识类型 */
  type: string;
  /** 标题 */
  title: string;
  /** 内容摘要 */
  snippet: string;
  /** 相关性分数 (0-1) */
  relevance: number;
  /** 标签 */
  tags: string[];
  /** 元数据 */
  metadata: Record<string, unknown>;
}

/** 查询意图 */
export interface QueryIntent {
  /** 原始查询 */
  query: string;
  /** 目标存储 (可选，不指定则fan-out) */
  targetStore?: StorePrefix;
  /** 类型过滤 */
  typeFilter?: string[];
  /** 标签过滤 */
  tagFilter?: string[];
  /** 最大结果数 */
  limit?: number;
}

/** 查询结果 */
export interface QueryResult {
  /** 查询解释 */
  interpretation: string;
  /** 命中的存储 */
  storesQueried: StorePrefix[];
  /** 合并后的结果 */
  results: KnowledgeUnit[];
  /** 总耗时 (ms) */
  duration: number;
}

// ========== KAL 主类 ==========

export class KnowledgeAccessLayer {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 统一查询入口
   */
  async query(intent: QueryIntent): Promise<QueryResult> {
    const start = performance.now();
    const stores = intent.targetStore
      ? [intent.targetStore]
      : (["vault", "kg", "dre"] as StorePrefix[]);

    const results: KnowledgeUnit[] = [];
    const storesQueried: StorePrefix[] = [];

    // Fan-out 查询
    const promises = stores.map(async (store) => {
      try {
        const storeResults = await this.queryStore(store, intent);
        storesQueried.push(store);
        return storeResults;
      } catch (err) {
        logger.warn(`[KAL] Store ${store} query failed`, { error: (err as Error).message });
        return [];
      }
    });

    const storeResults = await Promise.all(promises);
    for (const storeResult of storeResults) {
      results.push(...storeResult);
    }

    // 按相关性排序
    results.sort((a, b) => b.relevance - a.relevance);

    // 截断
    const limit = intent.limit || 20;
    const truncated = results.slice(0, limit);

    return {
      interpretation: `Query "${intent.query}" across [${storesQueried.join(", ")}]`,
      storesQueried,
      results: truncated,
      duration: Math.round(performance.now() - start),
    };
  }

  /**
   * 按存储查询
   */
  private async queryStore(
    store: StorePrefix,
    intent: QueryIntent
  ): Promise<KnowledgeUnit[]> {
    switch (store) {
      case "vault":
        return this.queryVault(intent);
      case "kg":
        return this.queryKG(intent);
      case "dre":
        return this.queryDRE(intent);
      default:
        return [];
    }
  }

  /**
   * 查询 Vault (FTS5 搜索)
   */
  private queryVault(intent: QueryIntent): KnowledgeUnit[] {
    try {
      const searchQuery = `
        SELECT mn.path, mn.title, mn.content, mn.tags
        FROM memory_notes_fts fts
        JOIN memory_notes mn ON mn.id = fts.rowid
        WHERE memory_notes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `;
      const limit = intent.limit || 10;
      const ftsQuery = this.sanitizeFTS5(intent.query);
      if (!ftsQuery) return [];
      const rows = this.db.query(searchQuery).all(ftsQuery, limit) as Array<{
        path: string;
        title: string;
        content: string;
        tags: string;
      }>;

      return rows.map((row) => ({
        nodeId: createNodeId("vault", "note", row.path),
        store: "vault" as StorePrefix,
        type: "note",
        title: row.title || row.path,
        snippet: (row.content || "").slice(0, 300),
        relevance: 0.8,
        tags: this.safeParseTags(row.tags),
        metadata: { path: row.path },
      }));
    } catch {
      // FTS5 表可能不存在，静默降级
      return [];
    }
  }

  /**
   * 查询 KG (知识图谱)
   */
  private queryKG(intent: QueryIntent): KnowledgeUnit[] {
    try {
      const searchQuery = `
        SELECT id, type, name, description, tags, importance
        FROM kg_nodes
        WHERE (name LIKE ? OR description LIKE ? OR semantic LIKE ?)
        ${intent.typeFilter ? "AND type IN (" + intent.typeFilter.map(() => "?").join(",") + ")" : ""}
        ORDER BY importance DESC
        LIMIT ?
      `;

      const pattern = `%${intent.query}%`;
      const params: (string | number)[] = [pattern, pattern, pattern];
      if (intent.typeFilter) {
        params.push(...intent.typeFilter);
      }
      params.push(intent.limit || 10);

      const rows = this.db.query(searchQuery).all(...params) as Array<{
        id: string;
        type: string;
        name: string;
        description: string;
        tags: string;
        importance: number;
      }>;

      return rows.map((row) => ({
        nodeId: createNodeId("kg", row.type, row.id),
        store: "kg" as StorePrefix,
        type: row.type,
        title: row.name,
        snippet: (row.description || "").slice(0, 300),
        relevance: row.importance || 0.5,
        tags: this.safeParseTags(row.tags),
        metadata: { id: row.id },
      }));
    } catch {
      return [];
    }
  }

  /**
   * 查询 DRE (确定性知识)
   */
  private queryDRE(intent: QueryIntent): KnowledgeUnit[] {
    try {
      const searchQuery = `
        SELECT node_id, title, content, domain, paradigm, confidence
        FROM knowledge_node
        WHERE (title LIKE ? OR content LIKE ?)
        ${intent.typeFilter ? "AND paradigm IN (" + intent.typeFilter.map(() => "?").join(",") + ")" : ""}
        ORDER BY confidence DESC
        LIMIT ?
      `;

      const pattern = `%${intent.query}%`;
      const params: (string | number)[] = [pattern, pattern];
      if (intent.typeFilter) {
        params.push(...intent.typeFilter);
      }
      params.push(intent.limit || 10);

      const rows = this.db.query(searchQuery).all(...params) as Array<{
        node_id: string;
        title: string;
        content: string;
        domain: string;
        paradigm: string;
        confidence: number;
      }>;

      return rows.map((row) => ({
        nodeId: createNodeId("dre", row.domain, row.node_id),
        store: "dre" as StorePrefix,
        type: row.paradigm,
        title: row.title,
        snippet: (row.content || "").slice(0, 300),
        relevance: row.confidence || 0.5,
        tags: [row.domain, row.paradigm],
        metadata: { id: row.node_id, domain: row.domain },
      }));
    } catch {
      return [];
    }
  }

  /**
   * 获取跨存储引用 (通过 node_id 查找关联)
   */
  async getReferences(nodeId: string): Promise<KnowledgeUnit[]> {
    const parsed = parseNodeId(nodeId);
    if (!parsed) return [];

    // 跨存储引用：KG 出入边 UNION
    // 以该 nodeId 为源或目标的边，另一端即其引用方/被引用方。
    // （Vault wiki-link 图由 DeterministicSearchEngine 在文件层内存构建，
    //  不在本 SQLite 之内，故此处仅覆盖可在 db 中可靠验证的 KG 边。）
    const results: KnowledgeUnit[] = [];

    try {
      const edges = this.db
        .query(
          `SELECT source, target, type FROM kg_edges WHERE source = ? OR target = ? LIMIT 50`,
        )
        .all(nodeId, nodeId) as Array<{ source: string; target: string; type: string }>;

      for (const edge of edges) {
        const otherId = edge.source === nodeId ? edge.target : edge.source;
        const node = this.db
          .query(`SELECT id, type, name, description FROM kg_nodes WHERE id = ?`)
          .get(otherId) as { id: string; type: string; name: string; description: string } | undefined;

        if (node) {
          results.push({
            // kg_nodes.id 已是完整 node_id，切勿二次前缀（避免 kg:type:kg:type:x）
            nodeId: node.id,
            store: "kg",
            type: node.type,
            title: node.name,
            snippet: (node.description || "").slice(0, 300),
            relevance: 0.6,
            tags: [],
            metadata: { referencedBy: nodeId, edgeType: edge.type },
          });
        }
      }
    } catch { /* kg 表可能不存在 */ }

    return results;
  }

  private safeParseTags(tagsJson: string): string[] {
    try {
      return JSON.parse(tagsJson || "[]");
    } catch {
      return [];
    }
  }

  /**
   * FTS5 查询转义 (与 VaultManager 保持一致)
   * 移除特殊字符，每个词加引号和前缀通配符
   */
  private sanitizeFTS5(query: string): string {
    const cleaned = query
      .replace(/[^\w\u4e00-\u9fa5\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"*`)
      .join(" OR ");
    return cleaned;
  }
}
