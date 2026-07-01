/**
 * 知识图谱增强模块
 *
 * 功能:
 * 1. 语义层: 基于 LLM 的代码语义理解 (函数意图、业务逻辑)
 * 2. 动态层: 运行时调用链追踪
 * 3. 可视化: 交互式知识图谱浏览器 (D3.js/ECharts 数据格式)
 * 4. 查询: 自然语言查询代码库
 *
 * 核心能力:
 * - 代码结构分析 (AST → 知识图谱)
 * - 语义关系抽取 (LLM 辅助)
 * - 社区检测 (Louvain 算法)
 * - 自然语言 → 图查询转换
 */

import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import type { LLMClient } from "../dre/index.js";

// ========== 类型定义 ==========

/** 图谱节点类型 */
export type KGNodeType =
  | "function"
  | "class"
  | "module"
  | "interface"
  | "type"
  | "variable"
  | "file"
  | "directory"
  | "concept"
  | "entity";

/** 图谱边类型 */
export type KGEdgeType =
  | "calls"
  | "imports"
  | "extends"
  | "implements"
  | "contains"
  | "depends-on"
  | "related-to"
  | "is-a"
  | "part-of"
  | "uses"
  | "defines"
  | "exports";

/** 图谱节点 */
export interface KGNode {
  id: string;
  type: KGNodeType;
  name: string;
  description?: string;
  filePath?: string;
  lineNumber?: number;
  signature?: string;
  semantic?: string;        // LLM 生成的语义描述
  tags?: string[];
  metadata?: Record<string, unknown>;
  community?: number;       // 社区 ID
  importance?: number;      // 重要性分数 (0-1)
}

/** 图谱边 */
export interface KGEdge {
  id: string;
  source: string;
  target: string;
  type: KGEdgeType;
  weight: number;
  description?: string;
  evidence?: string[];
}

/** 图谱数据 (可视化格式) */
export interface KGGraphData {
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    category: number;
    symbolSize: number;
    value: number;
    x?: number;
    y?: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
    value: number;
    lineStyle?: {
      width: number;
      curveness: number;
    };
  }>;
  categories: Array<{
    name: string;
    itemStyle?: {
      color: string;
    };
  }>;
}

/** 自然语言查询结果 */
export interface NLQueryResult {
  query: string;
  interpretation: string;
  nodes: KGNode[];
  paths: Array<{
    from: string;
    to: string;
    path: string[];
  }>;
  explanation: string;
}

/** 社区信息 */
export interface Community {
  id: number;
  nodes: string[];
  label: string;
  description: string;
}

// ========== 颜色配置 ==========

const NODE_COLORS: Record<KGNodeType, string> = {
  function: "#5470c6",
  class: "#91cc75",
  module: "#fac858",
  interface: "#ee6666",
  type: "#73c0de",
  variable: "#3ba272",
  file: "#fc8452",
  directory: "#9a60b4",
  concept: "#ea7ccc",
  entity: "#48b8d0",
};

// ========== 知识图谱增强类 ==========

export class KnowledgeGraphEnhanced {
  private db: Database;
  private llm: LLMClient | null;
  private nodes = new Map<string, KGNode>();
  private edges = new Map<string, KGEdge>();
  private adjacency = new Map<string, string[]>(); // nodeId → edgeIds

  constructor(db: Database, llm?: LLMClient) {
    this.db = db;
    this.llm = llm || null;
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kg_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        file_path TEXT,
        line_number INTEGER,
        signature TEXT,
        semantic TEXT,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        community INTEGER,
        importance REAL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kg_edges (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        description TEXT,
        evidence TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source) REFERENCES kg_nodes(id),
        FOREIGN KEY (target) REFERENCES kg_nodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(type);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_community ON kg_nodes(community);
    `);
  }

  // ========== 节点管理 ==========

  /**
   * 添加节点
   */
  addNode(node: KGNode): void {
    const now = Date.now();

    this.db.prepare(`
      INSERT OR REPLACE INTO kg_nodes (
        id, type, name, description, file_path, line_number,
        signature, semantic, tags, metadata, community, importance,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.id,
      node.type,
      node.name,
      node.description || null,
      node.filePath || null,
      node.lineNumber || null,
      node.signature || null,
      node.semantic || null,
      JSON.stringify(node.tags || []),
      JSON.stringify(node.metadata || {}),
      node.community || null,
      node.importance || 0.5,
      now,
      now
    );

    this.nodes.set(node.id, node);
  }

  /**
   * 获取节点
   */
  getNode(id: string): KGNode | null {
    if (this.nodes.has(id)) {
      return this.nodes.get(id)!;
    }

    const row = this.db.prepare("SELECT * FROM kg_nodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const node = this.rowToNode(row);
    this.nodes.set(id, node);
    return node;
  }

  /**
   * 搜索节点
   */
  searchNodes(query: string, options?: {
    type?: KGNodeType;
    limit?: number;
  }): KGNode[] {
    let sql = "SELECT * FROM kg_nodes WHERE (name LIKE ? OR description LIKE ? OR semantic LIKE ?)";
    const params: unknown[] = [`%${query}%`, `%${query}%`, `%${query}%`];

    if (options?.type) {
      sql += " AND type = ?";
      params.push(options.type);
    }

    sql += " ORDER BY importance DESC LIMIT ?";
    params.push(options?.limit || 20);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToNode(row));
  }

  // ========== 边管理 ==========

  /**
   * 添加边
   */
  addEdge(edge: KGEdge): void {
    const now = Date.now();

    this.db.prepare(`
      INSERT OR REPLACE INTO kg_edges (
        id, source, target, type, weight, description, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      edge.id,
      edge.source,
      edge.target,
      edge.type,
      edge.weight,
      edge.description || null,
      JSON.stringify(edge.evidence || []),
      now
    );

    this.edges.set(edge.id, edge);

    // 更新邻接表
    if (!this.adjacency.has(edge.source)) {
      this.adjacency.set(edge.source, []);
    }
    this.adjacency.get(edge.source)!.push(edge.id);

    if (!this.adjacency.has(edge.target)) {
      this.adjacency.set(edge.target, []);
    }
    this.adjacency.get(edge.target)!.push(edge.id);
  }

  /**
   * 获取节点的出边
   */
  getOutEdges(nodeId: string): KGEdge[] {
    const edgeIds = this.adjacency.get(nodeId) || [];
    return edgeIds
      .map((id) => this.edges.get(id))
      .filter((e): e is KGEdge => e !== undefined && e.source === nodeId);
  }

  /**
   * 获取节点的入边
   */
  getInEdges(nodeId: string): KGEdge[] {
    const edgeIds = this.adjacency.get(nodeId) || [];
    return edgeIds
      .map((id) => this.edges.get(id))
      .filter((e): e is KGEdge => e !== undefined && e.target === nodeId);
  }

  /**
   * 获取节点的所有邻居
   */
  getNeighbors(nodeId: string): KGNode[] {
    const outEdges = this.getOutEdges(nodeId);
    const inEdges = this.getInEdges(nodeId);

    const neighborIds = new Set<string>();
    for (const edge of outEdges) {
      neighborIds.add(edge.target);
    }
    for (const edge of inEdges) {
      neighborIds.add(edge.source);
    }

    return Array.from(neighborIds)
      .map((id) => this.getNode(id))
      .filter((n): n is KGNode => n !== null);
  }

  // ========== 图查询 ==========

  /**
   * BFS 子图检索
   */
  subgraph(seedId: string, depth: number = 2, maxNodes: number = 100): {
    nodes: KGNode[];
    edges: KGEdge[];
  } {
    const visitedNodes = new Set<string>();
    const visitedEdges = new Set<string>();
    const resultNodes: KGNode[] = [];
    const resultEdges: KGEdge[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: seedId, depth: 0 }];

    while (queue.length > 0 && resultNodes.length < maxNodes) {
      const { id, depth: currentDepth } = queue.shift()!;

      if (visitedNodes.has(id)) continue;
      visitedNodes.add(id);

      const node = this.getNode(id);
      if (node) {
        resultNodes.push(node);
      }

      if (currentDepth >= depth) continue;

      // 获取所有边
      const outEdges = this.getOutEdges(id);
      const inEdges = this.getInEdges(id);

      for (const edge of [...outEdges, ...inEdges]) {
        if (!visitedEdges.has(edge.id)) {
          visitedEdges.add(edge.id);
          resultEdges.push(edge);
        }

        const neighborId = edge.source === id ? edge.target : edge.source;
        if (!visitedNodes.has(neighborId)) {
          queue.push({ id: neighborId, depth: currentDepth + 1 });
        }
      }
    }

    return { nodes: resultNodes, edges: resultEdges };
  }

  /**
   * 最短路径 (BFS)
   */
  shortestPath(startId: string, endId: string): string[] | null {
    if (startId === endId) return [startId];

    const visited = new Set<string>();
    const parent = new Map<string, string>();
    const queue: string[] = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current === endId) {
        // 回溯路径
        const path: string[] = [];
        let node: string | undefined = endId;
        while (node) {
          path.unshift(node);
          node = parent.get(node);
        }
        return path;
      }

      const neighbors = this.getNeighbors(current);
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.id)) {
          visited.add(neighbor.id);
          parent.set(neighbor.id, current);
          queue.push(neighbor.id);
        }
      }
    }

    return null;
  }

  /**
   * 多跳路径查找
   */
  findPaths(startId: string, endId: string, maxDepth: number = 4): string[][] {
    const paths: string[][] = [];
    const visited = new Set<string>();

    const dfs = (current: string, path: string[]) => {
      if (path.length > maxDepth) return;
      if (current === endId) {
        paths.push([...path]);
        return;
      }

      visited.add(current);
      const neighbors = this.getNeighbors(current);

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.id)) {
          path.push(neighbor.id);
          dfs(neighbor.id, path);
          path.pop();
        }
      }
      visited.delete(current);
    };

    dfs(startId, [startId]);
    return paths;
  }

  // ========== 社区检测 ==========

  /**
   * 社区检测 (简化版 Louvain)
   */
  detectCommunities(): Community[] {
    const communities = new Map<number, string[]>();
    const nodeToCommunity = new Map<string, number>();
    let communityId = 0;

    // 初始化
    for (const node of this.nodes.keys()) {
      nodeToCommunity.set(node, communityId);
      communities.set(communityId, [node]);
      communityId++;
    }

    // 迭代优化 (简化版)
    let changed = true;
    let iterations = 0;
    const maxIterations = 10;

    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;

      for (const nodeId of this.nodes.keys()) {
        const neighbors = this.getNeighbors(nodeId);
        const neighborCommunities = new Map<number, number>();

        for (const neighbor of neighbors) {
          const comm = nodeToCommunity.get(neighbor.id)!;
          neighborCommunities.set(comm, (neighborCommunities.get(comm) || 0) + 1);
        }

        // 找到最佳社区
        let bestCommunity = nodeToCommunity.get(nodeId)!;
        let bestCount = 0;

        for (const [comm, count] of neighborCommunities) {
          if (count > bestCount) {
            bestCount = count;
            bestCommunity = comm;
          }
        }

        // 如果有更好的社区，移动节点
        if (bestCommunity !== nodeToCommunity.get(nodeId)) {
          const oldCommunity = nodeToCommunity.get(nodeId)!;
          const oldNodes = communities.get(oldCommunity)!;
          const index = oldNodes.indexOf(nodeId);
          if (index > -1) {
            oldNodes.splice(index, 1);
          }

          if (!communities.has(bestCommunity)) {
            communities.set(bestCommunity, []);
          }
          communities.get(bestCommunity)!.push(nodeId);
          nodeToCommunity.set(nodeId, bestCommunity);
          changed = true;
        }
      }
    }

    // 生成社区标签
    const result: Community[] = [];
    for (const [id, nodes] of communities) {
      if (nodes.length > 0) {
        result.push({
          id,
          nodes,
          label: `Community ${id}`,
          description: this.generateCommunityDescription(nodes),
        });
      }
    }

    return result;
  }

  /**
   * 生成社区描述
   */
  private generateCommunityDescription(nodeIds: string[]): string {
    const types = new Map<string, number>();
    for (const id of nodeIds) {
      const node = this.getNode(id);
      if (node) {
        types.set(node.type, (types.get(node.type) || 0) + 1);
      }
    }

    const sorted = Array.from(types.entries()).sort((a, b) => b[1] - a[1]);
    const mainTypes = sorted.slice(0, 3).map(([type, count]) => `${count} ${type}s`);

    return `Contains ${mainTypes.join(", ")}`;
  }

  // ========== 可视化数据生成 ==========

  /**
   * 生成 ECharts 可视化数据
   */
  toEChartsData(options?: {
    maxNodes?: number;
    includeEdges?: boolean;
  }): KGGraphData {
    const maxNodes = options?.maxNodes || 200;
    const nodes = Array.from(this.nodes.values()).slice(0, maxNodes);
    const nodeIds = new Set(nodes.map((n) => n.id));

    // 分类
    const types = new Set(nodes.map((n) => n.type));
    const categories = Array.from(types).map((type, index) => ({
      name: type,
      itemStyle: {
        color: NODE_COLORS[type as KGNodeType] || "#999",
      },
    }));

    const categoryMap = new Map<string, number>();
    categories.forEach((c, i) => categoryMap.set(c.name, i));

    // 节点数据
    const graphNodes = nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      category: categoryMap.get(node.type) || 0,
      symbolSize: Math.max(10, Math.min(50, (node.importance || 0.5) * 50)),
      value: node.importance || 0.5,
    }));

    // 边数据
    const graphEdges: KGGraphData["edges"] = [];
    if (options?.includeEdges !== false) {
      for (const edge of this.edges.values()) {
        if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
          graphEdges.push({
            source: edge.source,
            target: edge.target,
            type: edge.type,
            value: edge.weight,
            lineStyle: {
              width: Math.max(1, Math.min(5, edge.weight * 3)),
              curveness: 0.3,
            },
          });
        }
      }
    }

    return {
      nodes: graphNodes,
      edges: graphEdges,
      categories,
    };
  }

  /**
   * 生成 D3.js 可视化数据
   */
  toD3Data(options?: {
    maxNodes?: number;
  }): {
    nodes: Array<{
      id: string;
      name: string;
      group: number;
      radius: number;
    }>;
    links: Array<{
      source: string;
      target: string;
      value: number;
    }>;
  } {
    const maxNodes = options?.maxNodes || 200;
    const nodes = Array.from(this.nodes.values()).slice(0, maxNodes);
    const nodeIds = new Set(nodes.map((n) => n.id));

    const types = Array.from(new Set(nodes.map((n) => n.type)));
    const typeMap = new Map<string, number>();
    types.forEach((t, i) => typeMap.set(t, i));

    const graphNodes = nodes.map((node) => ({
      id: node.id,
      name: node.name,
      group: typeMap.get(node.type) || 0,
      radius: Math.max(5, Math.min(25, (node.importance || 0.5) * 25)),
    }));

    const links: Array<{ source: string; target: string; value: number }> = [];
    for (const edge of this.edges.values()) {
      if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
        links.push({
          source: edge.source,
          target: edge.target,
          value: edge.weight,
        });
      }
    }

    return { nodes: graphNodes, links };
  }

  // ========== 自然语言查询 ==========

  /**
   * 自然语言查询
   */
  async queryNL(question: string): Promise<NLQueryResult> {
    // 1. 解析查询意图
    const interpretation = this.interpretQuery(question);

    // 2. 搜索相关节点
    const nodes = this.searchNodes(interpretation.keywords.join(" "), {
      limit: 10,
    });

    // 3. 查找路径
    const paths: NLQueryResult["paths"] = [];
    if (nodes.length >= 2) {
      for (let i = 0; i < Math.min(3, nodes.length - 1); i++) {
        for (let j = i + 1; j < Math.min(5, nodes.length); j++) {
          const path = this.shortestPath(nodes[i].id, nodes[j].id);
          if (path) {
            paths.push({
              from: nodes[i].name,
              to: nodes[j].name,
              path,
            });
          }
        }
      }
    }

    // 4. 生成解释
    const explanation = this.generateExplanation(question, nodes, paths);

    return {
      query: question,
      interpretation: interpretation.description,
      nodes,
      paths,
      explanation,
    };
  }

  /**
   * 解析查询意图
   */
  private interpretQuery(question: string): {
    intent: string;
    keywords: string[];
    description: string;
  } {
    const lower = question.toLowerCase();

    // 意图识别
    let intent = "search";
    if (lower.includes("调用") || lower.includes("call")) {
      intent = "call-chain";
    } else if (lower.includes("依赖") || lower.includes("depend")) {
      intent = "dependency";
    } else if (lower.includes("实现") || lower.includes("implement")) {
      intent = "implementation";
    } else if (lower.includes("相似") || lower.includes("similar")) {
      intent = "similarity";
    }

    // 关键词提取
    const keywords: string[] = [];
    const words = question.match(/[\u4e00-\u9fa5]+|[a-zA-Z][a-zA-Z0-9]*/g) || [];
    for (const word of words) {
      if (word.length >= 2) {
        keywords.push(word);
      }
    }

    return {
      intent,
      keywords,
      description: `Interpreted as ${intent} query with keywords: ${keywords.join(", ")}`,
    };
  }

  /**
   * 生成解释
   */
  private generateExplanation(
    question: string,
    nodes: KGNode[],
    paths: NLQueryResult["paths"]
  ): string {
    if (nodes.length === 0) {
      return `No relevant nodes found for query: "${question}"`;
    }

    let explanation = `Found ${nodes.length} relevant nodes:\n`;
    for (const node of nodes.slice(0, 5)) {
      explanation += `- ${node.name} (${node.type}): ${node.description || "No description"}\n`;
    }

    if (paths.length > 0) {
      explanation += `\nFound ${paths.length} connection paths:\n`;
      for (const p of paths.slice(0, 3)) {
        explanation += `- ${p.from} → ${p.to}: ${p.path.join(" → ")}\n`;
      }
    }

    return explanation;
  }

  // ========== 统计信息 ==========

  /**
   * 获取统计信息
   */
  getStats(): {
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
    avgDegree: number;
    communities: number;
  } {
    const nodesByType: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    }

    const edgesByType: Record<string, number> = {};
    for (const edge of this.edges.values()) {
      edgesByType[edge.type] = (edgesByType[edge.type] || 0) + 1;
    }

    const totalDegree = Array.from(this.adjacency.values()).reduce(
      (sum, edges) => sum + edges.length,
      0
    );

    const communities = this.detectCommunities();

    return {
      totalNodes: this.nodes.size,
      totalEdges: this.edges.size,
      nodesByType,
      edgesByType,
      avgDegree: this.nodes.size > 0 ? totalDegree / this.nodes.size : 0,
      communities: communities.length,
    };
  }

  // ========== 辅助方法 ==========

  private rowToNode(row: Record<string, unknown>): KGNode {
    return {
      id: row.id as string,
      type: row.type as KGNodeType,
      name: row.name as string,
      description: row.description as string | undefined,
      filePath: row.file_path as string | undefined,
      lineNumber: row.line_number as number | undefined,
      signature: row.signature as string | undefined,
      semantic: row.semantic as string | undefined,
      tags: JSON.parse((row.tags as string) || "[]"),
      metadata: JSON.parse((row.metadata as string) || "{}"),
      community: row.community as number | undefined,
      importance: row.importance as number | undefined,
    };
  }
}
