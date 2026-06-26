/**
 * 知识库存储层
 *
 * 实现知识条目的 CRUD + 版本快照 + 三段甄别集成
 *
 * 范式设计 (3NF/4NF):
 * - knowledge_node: 知识条目主表
 * - knowledge_revision: 版本快照 (多值依赖分离)
 * - kg_edge: 知识图谱边
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";

/** 知识条目 */
export interface KnowledgeNode {
  nodeId: string;
  title: string;
  content: string;
  contentHash: string;
  schemaVersion: number;
  domain: string;
  paradigm: "fact" | "rule" | "procedure" | "concept";
  confidence: number;
  sourceType: "manual" | "web" | "llm" | "ocr" | "kg";
  sourceUri?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  isVerified: boolean;
}

/** 知识版本 */
export interface KnowledgeRevision {
  nodeId: string;
  revision: number;
  content: string;
  diff?: string;
  reason?: string;
  verifiedBy?: string;
  createdAt: number;
}

/** 知识图谱边 */
export interface KGEdge {
  srcNode: string;
  dstNode: string;
  relation: "is-a" | "part-of" | "depends-on" | "derives-from" | "related-to";
  weight: number;
  evidence?: string[];
}

/**
 * 知识库存储
 */
export class KnowledgeStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 写入知识条目 (需经三段甄别)
   */
  write(node: Omit<KnowledgeNode, "createdAt" | "updatedAt" | "revision" | "contentHash">): KnowledgeNode {
    const now = Date.now();
    const contentHash = createHash("sha256").update(node.content).digest("hex");

    const txn = this.db.transaction(() => {
      // 检查是否已存在
      const existing = this.db.prepare(
        "SELECT revision FROM knowledge_node WHERE node_id = ?"
      ).get(node.nodeId) as { revision: number } | undefined;

      const revision = existing ? existing.revision + 1 : 1;

      // 保存版本快照
      if (existing) {
        const oldContent = this.db.prepare(
          "SELECT content FROM knowledge_node WHERE node_id = ?"
        ).get(node.nodeId) as { content: string } | undefined;

        if (oldContent) {
          const diff = this.computeDiff(oldContent.content, node.content);
          this.db.prepare(`
            INSERT INTO knowledge_revision (node_id, revision, content, diff, reason, verified_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(node.nodeId, existing.revision, oldContent.content, diff, "update", node.sourceType, now);
        }
      }

      // 插入或更新
      this.db.prepare(`
        INSERT INTO knowledge_node (
          node_id, title, content, content_hash, schema_version,
          domain, paradigm, confidence, source_type, source_uri,
          created_at, updated_at, revision, is_verified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          content_hash = excluded.content_hash,
          domain = excluded.domain,
          paradigm = excluded.paradigm,
          confidence = excluded.confidence,
          source_type = excluded.source_type,
          source_uri = excluded.source_uri,
          updated_at = excluded.updated_at,
          revision = excluded.revision,
          is_verified = excluded.is_verified
      `).run(
        node.nodeId, node.title, node.content, contentHash,
        node.schemaVersion || 1, node.domain, node.paradigm,
        node.confidence, node.sourceType, node.sourceUri || null,
        now, now, revision, node.isVerified ? 1 : 0
      );
    });

    txn();

    return {
      ...node,
      contentHash,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
  }

  /**
   * 读取知识条目
   */
  read(nodeId: string): KnowledgeNode | null {
    const row = this.db.prepare(`
      SELECT * FROM knowledge_node WHERE node_id = ?
    `).get(nodeId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToNode(row);
  }

  /**
   * 搜索知识条目
   */
  search(query: string, options?: {
    domain?: string;
    paradigm?: string;
    minConfidence?: number;
    limit?: number;
  }): KnowledgeNode[] {
    let sql = "SELECT * FROM knowledge_node WHERE 1=1";
    const params: unknown[] = [];

    if (query) {
      sql += " AND (title LIKE ? OR content LIKE ?)";
      params.push(`%${query}%`, `%${query}%`);
    }

    if (options?.domain) {
      sql += " AND domain = ?";
      params.push(options.domain);
    }

    if (options?.paradigm) {
      sql += " AND paradigm = ?";
      params.push(options.paradigm);
    }

    if (options?.minConfidence) {
      sql += " AND confidence >= ?";
      params.push(options.minConfidence);
    }

    sql += " ORDER BY confidence DESC, updated_at DESC";
    sql += ` LIMIT ${options?.limit || 10}`;

    const rows = this.db.prepare(sql).all(...(params as any[])) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToNode(row));
  }

  /**
   * 获取知识条目版本历史
   */
  getRevisions(nodeId: string): KnowledgeRevision[] {
    const rows = this.db.prepare(`
      SELECT * FROM knowledge_revision
      WHERE node_id = ? ORDER BY revision DESC
    `).all(nodeId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      nodeId: row.node_id as string,
      revision: row.revision as number,
      content: row.content as string,
      diff: row.diff as string | undefined,
      reason: row.reason as string | undefined,
      verifiedBy: row.verified_by as string | undefined,
      createdAt: row.created_at as number,
    }));
  }

  /**
   * 添加知识图谱边
   */
  addEdge(edge: KGEdge): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO kg_edge (src_node, dst_node, relation, weight, evidence)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      edge.srcNode,
      edge.dstNode,
      edge.relation,
      edge.weight,
      edge.evidence ? JSON.stringify(edge.evidence) : null
    );
  }

  /**
   * 获取节点的出边
   */
  getOutEdges(nodeId: string): KGEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM kg_edge WHERE src_node = ?
    `).all(nodeId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      srcNode: row.src_node as string,
      dstNode: row.dst_node as string,
      relation: row.relation as KGEdge["relation"],
      weight: row.weight as number,
      evidence: row.evidence ? JSON.parse(row.evidence as string) : undefined,
    }));
  }

  /**
   * 获取节点的入边
   */
  getInEdges(nodeId: string): KGEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM kg_edge WHERE dst_node = ?
    `).all(nodeId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      srcNode: row.src_node as string,
      dstNode: row.dst_node as string,
      relation: row.relation as KGEdge["relation"],
      weight: row.weight as number,
      evidence: row.evidence ? JSON.parse(row.evidence as string) : undefined,
    }));
  }

  /**
   * BFS 子图检索
   */
  subgraph(seedNodeId: string, depth: number = 2, maxNodes: number = 50): KnowledgeNode[] {
    const visited = new Set<string>();
    const result: KnowledgeNode[] = [];
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: seedNodeId, depth: 0 }];

    while (queue.length > 0 && result.length < maxNodes) {
      const { nodeId, depth: currentDepth } = queue.shift()!;

      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = this.read(nodeId);
      if (node) {
        result.push(node);
      }

      if (currentDepth >= depth) continue;

      // 获取邻居
      const outEdges = this.getOutEdges(nodeId);
      const inEdges = this.getInEdges(nodeId);

      for (const edge of [...outEdges, ...inEdges]) {
        const neighbor = edge.srcNode === nodeId ? edge.dstNode : edge.srcNode;
        if (!visited.has(neighbor)) {
          queue.push({ nodeId: neighbor, depth: currentDepth + 1 });
        }
      }
    }

    return result;
  }

  /**
   * 计算差异 (简化版)
   */
  private computeDiff(oldContent: string, newContent: string): string {
    // 简化实现：只记录变更标记
    if (oldContent === newContent) return "";
    return `@@ -old +new @@\n-${oldContent.slice(0, 100)}\n+${newContent.slice(0, 100)}`;
  }

  /**
   * 行转知识条目
   */
  private rowToNode(row: Record<string, unknown>): KnowledgeNode {
    return {
      nodeId: row.node_id as string,
      title: row.title as string,
      content: row.content as string,
      contentHash: row.content_hash as string,
      schemaVersion: row.schema_version as number,
      domain: row.domain as string,
      paradigm: row.paradigm as KnowledgeNode["paradigm"],
      confidence: row.confidence as number,
      sourceType: row.source_type as KnowledgeNode["sourceType"],
      sourceUri: row.source_uri as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      revision: row.revision as number,
      isVerified: (row.is_verified as number) === 1,
    };
  }
}
