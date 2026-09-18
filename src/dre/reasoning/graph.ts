/**
 * 推理图 (Reasoning Graph)
 *
 * 打破 LLM 黑盒: 不再整体调用 LLM，
 * 而是先构建推理图，通过 Gap Detection 识别空洞，
 * 再精细化地调用 LLM 仅填补这些空洞。
 *
 * 推理图 = 前提 + 推理步骤 + 结论
 *
 * 节点类型:
 * - premise: 前提 (已知事实或观察)
 * - inference: 推理步骤 (从前提推导)
 * - conclusion: 结论 (最终判断)
 * - evidence: 证据 (支持或反驳)
 * - gap: 空洞 (需要 LLM 填补的缺失环节)
 *
 * 数据流:
 * 用户输入 → 提取前提 → 构建初始推理图
 *         → Gap Detection (识别缺失的推理步骤)
 *         → 精细化 LLM 调用 (仅填补空洞)
 *         → 验证推理链完整性
 *         → 输出结论
 */

// ========== 类型定义 ==========

/** 推理节点类型 */
export type ReasoningNodeType =
  | "premise"      // 前提: 已知事实
  | "inference"    // 推理: 推导步骤
  | "conclusion"   // 结论: 最终判断
  | "evidence"     // 证据: 支持/反驳
  | "gap";         // 空洞: 待填补

/** 推理节点 */
export interface ReasoningNode {
  id: string;
  type: ReasoningNodeType;
  /** 节点内容 */
  content: string;
  /** 置信度 (0-1) */
  confidence: number;
  /** 来源 */
  source: "user" | "knowledge" | "llm" | "inference" | "gap";
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 创建时间 */
  createdAt: number;
}

/** 推理边 */
export interface ReasoningEdge {
  id: string;
  /** 源节点 (前提) */
  from: string;
  /** 目标节点 (结论) */
  to: string;
  /** 关系类型 */
  relation: "supports" | "contradicts" | "implies" | "requires" | "explains";
  /** 推理强度 (0-1) */
  strength: number;
}

/** 推理空洞 */
export interface ReasoningGap {
  id: string;
  /** 空洞类型 */
  gapType: "missing_premise" | "missing_inference" | "missing_evidence" | "weak_link";
  /** 描述 */
  description: string;
  /** 相关节点 */
  relatedNodes: string[];
  /** 优先级 (越小越紧急) */
  priority: number;
  /** 建议的 LLM 提示 */
  suggestedPrompt?: string;
}

/** 推理结果 */
export interface ReasoningResult {
  /** 结论节点 */
  conclusion: ReasoningNode | null;
  /** 推理链 */
  chain: ReasoningNode[];
  /** 总置信度 */
  confidence: number;
  /** 是否有未填补的空洞 */
  hasGaps: boolean;
  /** 未填补的空洞 */
  gaps: ReasoningGap[];
}

// ========== 推理图 ==========

export class ReasoningGraph {
  private nodes = new Map<string, ReasoningNode>();
  private edges: ReasoningEdge[] = [];

  /**
   * 添加前提节点
   */
  addPremise(content: string, confidence: number = 1.0): ReasoningNode {
    const node: ReasoningNode = {
      id: `premise-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      type: "premise",
      content,
      confidence,
      source: "user",
      createdAt: Date.now(),
    };
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * 添加推理步骤
   */
  addInference(content: string, fromIds: string[], confidence: number = 0.8): ReasoningNode {
    const node: ReasoningNode = {
      id: `inference-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      type: "inference",
      content,
      confidence,
      source: "inference",
      createdAt: Date.now(),
    };
    this.nodes.set(node.id, node);

    // 添加边: 前提 → 推理
    for (const fromId of fromIds) {
      this.edges.push({
        id: `edge-${fromId}-${node.id}`,
        from: fromId,
        to: node.id,
        relation: "implies",
        strength: confidence,
      });
    }

    return node;
  }

  /**
   * 添加结论节点
   */
  addConclusion(content: string, fromIds: string[], confidence: number = 0.7): ReasoningNode {
    const node: ReasoningNode = {
      id: `conclusion-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      type: "conclusion",
      content,
      confidence,
      source: "inference",
      createdAt: Date.now(),
    };
    this.nodes.set(node.id, node);

    // 添加边: 推理 → 结论
    for (const fromId of fromIds) {
      this.edges.push({
        id: `edge-${fromId}-${node.id}`,
        from: fromId,
        to: node.id,
        relation: "supports",
        strength: confidence,
      });
    }

    return node;
  }

  /**
   * 添加证据节点
   */
  addEvidence(content: string, targetId: string, supports: boolean): ReasoningNode {
    const node: ReasoningNode = {
      id: `evidence-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      type: "evidence",
      content,
      confidence: 0.8,
      source: "knowledge",
      createdAt: Date.now(),
    };
    this.nodes.set(node.id, node);

    this.edges.push({
      id: `edge-${node.id}-${targetId}`,
      from: node.id,
      to: targetId,
      relation: supports ? "supports" : "contradicts",
      strength: supports ? 0.8 : 0.6,
    });

    return node;
  }

  /**
   * 空洞检测 — 识别推理链中的缺失环节
   */
  detectGaps(): ReasoningGap[] {
    const gaps: ReasoningGap[] = [];

    // 检测 1: 孤立的前提 (没有指向任何推理步骤)
    for (const node of this.nodes.values()) {
      if (node.type === "premise") {
        const hasOutEdge = this.edges.some((e) => e.from === node.id);
        if (!hasOutEdge) {
          gaps.push({
            id: `gap-isolated-${node.id}`,
            gapType: "missing_inference",
            description: `前提 "${node.content.slice(0, 50)}" 没有被任何推理步骤使用`,
            relatedNodes: [node.id],
            priority: 2,
            suggestedPrompt: `基于前提 "${node.content}"，可以推导出什么结论？`,
          });
        }
      }
    }

    // 检测 2: 结论没有支撑 (没有入边)
    for (const node of this.nodes.values()) {
      if (node.type === "conclusion") {
        const hasInEdge = this.edges.some((e) => e.to === node.id);
        if (!hasInEdge) {
          gaps.push({
            id: `gap-unsupported-${node.id}`,
            gapType: "missing_premise",
            description: `结论 "${node.content.slice(0, 50)}" 缺乏支撑证据`,
            relatedNodes: [node.id],
            priority: 1,
            suggestedPrompt: `什么证据可以支持 "${node.content}" 这个结论？`,
          });
        }
      }
    }

    // 检测 3: 弱链接 (置信度 < 0.5 的边)
    for (const edge of this.edges) {
      if (edge.strength < 0.5) {
        gaps.push({
          id: `gap-weak-${edge.id}`,
          gapType: "weak_link",
          description: `从 "${this.nodes.get(edge.from)?.content.slice(0, 30) || '?'}" 到 "${this.nodes.get(edge.to)?.content.slice(0, 30) || '?'}" 的推理链较弱`,
          relatedNodes: [edge.from, edge.to],
          priority: 3,
          suggestedPrompt: `从 "${this.nodes.get(edge.from)?.content}" 推导到 "${this.nodes.get(edge.to)?.content}" 的逻辑是否成立？需要什么额外证据？`,
        });
      }
    }

    // 检测 4: 推理链断裂 (前提→推理→结论 路径不完整)
    const premises = Array.from(this.nodes.values()).filter((n) => n.type === "premise");
    const conclusions = Array.from(this.nodes.values()).filter((n) => n.type === "conclusion");

    for (const conclusion of conclusions) {
      const reachable = this.getReachableNodes(conclusion.id, "backward");
      const hasPremise = premises.some((p) => reachable.has(p.id));
      if (!hasPremise && premises.length > 0) {
        gaps.push({
          id: `gap-disconnected-${conclusion.id}`,
          gapType: "missing_inference",
          description: `结论 "${conclusion.content.slice(0, 50)}" 与前提之间缺少推理步骤`,
          relatedNodes: [conclusion.id],
          priority: 1,
          suggestedPrompt: `如何从已知前提推导出 "${conclusion.content}"？`,
        });
      }
    }

    // 按优先级排序
    gaps.sort((a, b) => a.priority - b.priority);

    return gaps;
  }

  /**
   * 为 LLM 生成精确的填补提示
   */
  generateGapFillingPrompt(gap: ReasoningGap): string {
    const relatedContents = gap.relatedNodes
      .map((id) => this.nodes.get(id)?.content)
      .filter(Boolean)
      .join("\n- ");

    return `你是一个推理助手。以下是当前推理链中的一个空洞：

空洞类型: ${gap.gapType}
描述: ${gap.description}

相关节点内容:
- ${relatedContents}

请仅填补这个空洞，提供缺失的推理步骤、前提或证据。
要求：
1. 直接回答，不要重复已有内容
2. 给出具体的推理步骤
3. 评估你回答的置信度 (0-1)`;
  }

  /**
   * 用 LLM 结果填补空洞 (接受 ReasoningGap 对象，避免重复计算)
   */
  fillGapFromObject(gap: ReasoningGap, llmResponse: string, confidence: number): ReasoningNode | null {
    let nodeType: ReasoningNodeType;
    switch (gap.gapType) {
      case "missing_premise":
        nodeType = "premise";
        break;
      case "missing_inference":
        nodeType = "inference";
        break;
      case "missing_evidence":
        nodeType = "evidence";
        break;
      default:
        nodeType = "inference";
    }

    const node: ReasoningNode = {
      id: `llm-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      type: nodeType,
      content: llmResponse,
      confidence,
      source: "llm",
      createdAt: Date.now(),
    };
    this.nodes.set(node.id, node);

    // 自动连接到相关节点
    for (const relatedId of gap.relatedNodes) {
      const relatedNode = this.nodes.get(relatedId);
      if (relatedNode) {
        const relation = nodeType === "evidence" ? "supports" : "implies";
        this.edges.push({
          id: `edge-${node.id}-${relatedId}`,
          from: node.id,
          to: relatedId,
          relation,
          strength: confidence,
        });
      }
    }

    return node;
  }

  /**
   * 用 LLM 结果填补空洞 (按 gapId 查找，兼容旧接口)
   */
  fillGap(gapId: string, llmResponse: string, confidence: number): ReasoningNode | null {
    const gap = this.detectGaps().find((g) => g.id === gapId);
    if (!gap) return null;
    return this.fillGapFromObject(gap, llmResponse, confidence);
  }

  /**
   * 批量填补空洞 — 避免循环调用 fillGap() 时每次重算 detectGaps() (O(n²) 风险)
   *
   * 直接按 gapId 在传入的 gaps 数组中匹配，调用 fillGapFromObject 回填。
   * 调用方应传入同一批 detectGaps() 的结果，避免图状态变化导致 gap 漂移。
   */
  fillGapsBatch(
    gaps: ReasoningGap[],
    fillers: Array<{ gapId: string; response: string; confidence: number }>,
  ): ReasoningNode[] {
    const filled: ReasoningNode[] = [];
    for (const filler of fillers) {
      const gap = gaps.find((g) => g.id === filler.gapId);
      if (!gap) continue;
      const node = this.fillGapFromObject(gap, filler.response, filler.confidence);
      if (node) filled.push(node);
    }
    return filled;
  }

  /**
   * 获取推理结果
   */
  getResult(): ReasoningResult {
    const conclusions = Array.from(this.nodes.values()).filter(
      (n) => n.type === "conclusion"
    );

    const conclusion = conclusions.length > 0
      ? conclusions.sort((a, b) => b.confidence - a.confidence)[0]
      : null;

    // 构建推理链 (从前提到结论)
    const chain = conclusion
      ? this.buildChain(conclusion.id)
      : [];

    // 计算总置信度
    const chainConfidences = chain.map((n) => n.confidence);
    const totalConfidence = chainConfidences.length > 0
      ? chainConfidences.reduce((a, b) => a * b, 1)
      : 0;

    const gaps = this.detectGaps();

    return {
      conclusion,
      chain,
      confidence: totalConfidence,
      hasGaps: gaps.length > 0,
      gaps,
    };
  }

  /**
   * 从节点构建推理链 (反向追溯)
   */
  private buildChain(nodeId: string): ReasoningNode[] {
    const chain: ReasoningNode[] = [];
    const visited = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const node = this.nodes.get(current);
      if (node) {
        chain.unshift(node);
        // 找到所有入边
        const inEdges = this.edges.filter((e) => e.to === current);
        for (const edge of inEdges) {
          queue.push(edge.from);
        }
      }
    }

    return chain;
  }

  /**
   * 获取可达节点 (正向或反向)
   */
  private getReachableNodes(startId: string, direction: "forward" | "backward"): Set<string> {
    const reachable = new Set<string>();
    const queue = [startId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);

      const edges = direction === "forward"
        ? this.edges.filter((e) => e.from === current)
        : this.edges.filter((e) => e.to === current);

      for (const edge of edges) {
        const next = direction === "forward" ? edge.to : edge.from;
        queue.push(next);
      }
    }

    return reachable;
  }

  /**
   * 获取图的统计信息
   */
  getStats(): {
    totalNodes: number;
    nodesByType: Record<string, number>;
    totalEdges: number;
    edgesByRelation: Record<string, number>;
    gaps: number;
  } {
    const nodesByType: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    }

    const edgesByRelation: Record<string, number> = {};
    for (const edge of this.edges) {
      edgesByRelation[edge.relation] = (edgesByRelation[edge.relation] || 0) + 1;
    }

    return {
      totalNodes: this.nodes.size,
      nodesByType,
      totalEdges: this.edges.length,
      edgesByRelation,
      gaps: this.detectGaps().length,
    };
  }

  /**
   * 清空推理图
   */
  clear(): void {
    this.nodes.clear();
    this.edges = [];
  }
}
