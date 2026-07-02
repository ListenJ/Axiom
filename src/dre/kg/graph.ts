/**
 * DRE 知识图谱
 *
 * 特性:
 * - 实体/关系存储
 * - BFS 子图检索
 * - 最短证据路径
 * - 按环境指纹检索项目节点
 * - 社区检测 (Louvain)
 */

import { logger } from "../../utils/logger.js";

/** 图谱节点 */
export interface KGNode {
  id: string;
  title: string;
  domain: string;
  paradigm: string;
  confidence: number;
  filePath?: string;      // 项目节点特有
  envHash?: string;       // 依赖环境指纹
}

/** 图谱边 */
export interface KGEdge {
  src: string;
  dst: string;
  relation: "is-a" | "part-of" | "depends-on" | "derives-from" | "related-to";
  weight: number;
  evidence?: string[];
}

/**
 * 知识图谱
 */
export class KnowledgeGraph {
  private nodes = new Map<string, KGNode>();
  private adjacency = new Map<string, KGEdge[]>();
  private _edgeCount = 0;
  private _nodesByDomain = new Map<string, KGNode[]>();
  private _nodesByEnv = new Map<string, KGNode[]>();

  /**
   * 添加节点
   */
  addNode(node: KGNode): void {
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) {
      this.adjacency.set(node.id, []);
    }
    // 更新域索引
    const domainList = this._nodesByDomain.get(node.domain) || [];
    domainList.push(node);
    this._nodesByDomain.set(node.domain, domainList);
    // 更新环境索引
    if (node.envHash) {
      const envList = this._nodesByEnv.get(node.envHash) || [];
      envList.push(node);
      this._nodesByEnv.set(node.envHash, envList);
    }
  }

  /**
   * 添加边
   */
  addEdge(edge: KGEdge): void {
    // 防止重复边
    const key = `${edge.src}->${edge.dst}:${edge.relation}`;
    if (this.adjacency.get(edge.src)?.some((e) => `${e.src}->${e.dst}:${e.relation}` === key)) {
      return;
    }

    // 确保节点存在
    if (!this.nodes.has(edge.src) || !this.nodes.has(edge.dst)) {
      throw new Error(`Node not found: ${!this.nodes.has(edge.src) ? edge.src : edge.dst}`);
    }

    this._edgeCount++;

    // 添加出边
    if (!this.adjacency.has(edge.src)) {
      this.adjacency.set(edge.src, []);
    }
    this.adjacency.get(edge.src)!.push(edge);

    // 添加反向边 (无向图)
    if (!this.adjacency.has(edge.dst)) {
      this.adjacency.set(edge.dst, []);
    }
    this.adjacency.get(edge.dst)!.push({
      src: edge.dst,
      dst: edge.src,
      relation: edge.relation,
      weight: edge.weight,
      evidence: edge.evidence,
    });
  }

  /**
   * 获取节点
   */
  getNode(id: string): KGNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * BFS 子图检索
   */
  subgraph(seedId: string, depth: number = 2, maxNodes: number = 50): KGNode[] {
    const visited = new Set<string>();
    const result: KGNode[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: seedId, depth: 0 }];

    while (queue.length > 0 && result.length < maxNodes) {
      const { id, depth: currentDepth } = queue.shift()!;

      if (visited.has(id)) continue;
      visited.add(id);

      const node = this.nodes.get(id);
      if (node) {
        result.push(node);
      }

      if (currentDepth >= depth) continue;

      // 获取邻居
      const edges = this.adjacency.get(id) || [];
      for (const edge of edges) {
        if (!visited.has(edge.dst)) {
          queue.push({ id: edge.dst, depth: currentDepth + 1 });
        }
      }
    }

    return result;
  }

  /**
   * 最短路径 (BFS)
   */
  shortestPath(startId: string, endId: string): KGEdge[] | null {
    if (startId === endId) return [];

    const visited = new Set<string>();
    const parent = new Map<string, { node: string; edge: KGEdge }>();
    const queue: string[] = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current === endId) {
        // 回溯路径
        const path: KGEdge[] = [];
        let node = endId;
        while (parent.has(node)) {
          const p = parent.get(node)!;
          path.unshift(p.edge);
          node = p.node;
        }
        return path;
      }

      const edges = this.adjacency.get(current) || [];
      for (const edge of edges) {
        if (!visited.has(edge.dst)) {
          visited.add(edge.dst);
          parent.set(edge.dst, { node: current, edge });
          queue.push(edge.dst);
        }
      }
    }

    return null; // 无路径
  }

  /**
   * 按环境指纹检索项目节点
   */
  nodesByEnv(envHash: string): KGNode[] {
    return this._nodesByEnv.get(envHash) || [];
  }

  /**
   * 按域检索
   */
  nodesByDomain(domain: string): KGNode[] {
    return this._nodesByDomain.get(domain) || [];
  }

  /**
   * 获取所有节点
   */
  allNodes(): KGNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * 获取所有边
   */
  allEdges(): KGEdge[] {
    const edges: KGEdge[] = [];
    const seen = new Set<string>();

    for (const [src, srcEdges] of this.adjacency) {
      for (const edge of srcEdges) {
        const key = `${edge.src}-${edge.dst}-${edge.relation}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(edge);
        }
      }
    }

    return edges;
  }

  /**
   * 节点数
   */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * 边数
   */
  get edgeCount(): number {
    return this._edgeCount;
  }

  /**
   * 社区检测 (简化版 Louvain)
   */
  detectCommunities(): Map<string, number> {
    const communities = new Map<string, number>();
    let communityId = 0;

    // 初始化：每个节点一个社区
    for (const node of this.nodes.keys()) {
      communities.set(node, communityId++);
    }

    // 简化实现：基于连通分量
    const visited = new Set<string>();

    for (const node of this.nodes.keys()) {
      if (visited.has(node)) continue;

      const component = this.bfsComponent(node);
      for (const id of component) {
        communities.set(id, communities.get(node)!);
        visited.add(id);
      }
    }

    return communities;
  }

  /**
   * BFS 获取连通分量
   */
  private bfsComponent(startId: string): string[] {
    const visited = new Set<string>();
    const queue: string[] = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const edges = this.adjacency.get(current) || [];

      for (const edge of edges) {
        if (!visited.has(edge.dst)) {
          visited.add(edge.dst);
          queue.push(edge.dst);
        }
      }
    }

    return Array.from(visited);
  }

  /**
   * 导出为 JSON
   */
  toJSON(): { nodes: KGNode[]; edges: KGEdge[] } {
    return {
      nodes: this.allNodes(),
      edges: this.allEdges(),
    };
  }

  /**
   * 从 JSON 导入
   */
  static fromJSON(data: { nodes: KGNode[]; edges: KGEdge[] }): KnowledgeGraph {
    const kg = new KnowledgeGraph();

    for (const node of data.nodes) {
      kg.addNode(node);
    }

    for (const edge of data.edges) {
      try {
        kg.addEdge(edge);
      } catch (err) {
        logger.debug("[KG] Edge skipped (duplicate or invalid)", { error: (err as Error).message });
      }
    }

    return kg;
  }
}
