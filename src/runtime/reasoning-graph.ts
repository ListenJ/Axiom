/**
 * Reasoning Graph — 推理图
 *
 * 不再直接调用 LLM，而是先构建 ReasoningGraph。
 * 通过 Gap Detection 识别图中的空洞，
 * 再精细化地调用 LLM 仅填补这些空洞。
 *
 * 打破 LLM 黑盒。
 */

import { eventBus } from "./kernel.js";
import { atomStore } from "./atom-engine.js";

// ─── Reasoning Graph Types ─────────────────────────────────────────────────

export interface ReasoningNode {
  id: string
  type: "observation" | "inference" | "assumption" | "conclusion" | "gap"
  content: string
  confidence: number    // 0-1
  source: "deterministic" | "llm" | "user" | "inferred"
  dependencies: string[] // node IDs this depends on
  timestamp: number
}

export interface ReasoningEdge {
  source: string  // node ID
  target: string  // node ID
  type: "supports" | "contradicts" | "implies" | "requires" | "fills-gap"
  weight: number  // 0-1
}

export interface ReasoningGap {
  id: string
  description: string
  requiredFor: string[]   // node IDs that need this gap filled
  suggestedAction: "ask_user" | "use_llm" | "search_knowledge" | "skip"
  priority: "low" | "medium" | "high"
}

export interface ReasoningGraph {
  id: string
  nodes: ReasoningNode[]
  edges: ReasoningEdge[]
  gaps: ReasoningGap[]
  completeness: number    // 0-1
  confidence: number      // 0-1
  needsLLM: boolean
  llmQueries: string[]    // specific questions for LLM
}

// ─── Reasoning Graph Builder ───────────────────────────────────────────────

class ReasoningGraphBuilderImpl {
  private stats = { built: 0, gapsFound: 0, llmCalls: 0 };

  /**
   * Build a reasoning graph from input and context.
   */
  build(input: string, context?: {
    knowledge?: Array<{ id: string; content: string; confidence: number }>
    history?: Array<{ role: string; content: string }>
  }): ReasoningGraph {
    this.stats.built++;

    const nodes: ReasoningNode[] = [];
    const edges: ReasoningEdge[] = [];
    const gaps: ReasoningGap[] = [];

    // Step 1: Create observation nodes from input
    const observationNode: ReasoningNode = {
      id: "obs_1",
      type: "observation",
      content: input,
      confidence: 1.0,
      source: "user",
      dependencies: [],
      timestamp: Date.now(),
    };
    nodes.push(observationNode);

    // Step 2: Create inference nodes from knowledge
    if (context?.knowledge) {
      for (let i = 0; i < context.knowledge.length; i++) {
        const kn = context.knowledge[i];
        const inferenceNode: ReasoningNode = {
          id: `inf_${i + 1}`,
          type: "inference",
          content: kn.content,
          confidence: kn.confidence,
          source: "deterministic",
          dependencies: ["obs_1"],
          timestamp: Date.now(),
        };
        nodes.push(inferenceNode);
        edges.push({
          source: "obs_1",
          target: `inf_${i + 1}`,
          type: "supports",
          weight: kn.confidence,
        });
      }
    }

    // Step 3: Identify gaps
    const gapAnalysis = this.identifyGaps(nodes, input);

    for (let i = 0; i < gapAnalysis.length; i++) {
      const gap = gapAnalysis[i];
      const gapNode: ReasoningNode = {
        id: `gap_${i + 1}`,
        type: "gap",
        content: gap.description,
        confidence: 0,
        source: "inferred",
        dependencies: [],
        timestamp: Date.now(),
      };
      nodes.push(gapNode);
      gaps.push(gap);
    }

    // Step 4: Calculate completeness
    const totalNodes = nodes.length;
    const gapNodes = nodes.filter((n) => n.type === "gap").length;
    const completeness = totalNodes > 0 ? (totalNodes - gapNodes) / totalNodes : 1;

    // Step 5: Determine if LLM is needed
    const needsLLM = gaps.some((g) => g.suggestedAction === "use_llm");
    const llmQueries = gaps
      .filter((g) => g.suggestedAction === "use_llm")
      .map((g) => g.description);

    if (needsLLM) this.stats.llmCalls++;

    const graph: ReasoningGraph = {
      id: `graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      nodes,
      edges,
      gaps,
      completeness,
      confidence: this.calculateConfidence(nodes),
      needsLLM,
      llmQueries,
    };

    eventBus.publish({
      type: "reasoning_graph.built",
      source: "reasoning-graph",
      data: {
        id: graph.id,
        nodeCount: nodes.length,
        gapCount: gaps.length,
        completeness,
        needsLLM,
      },
      priority: "normal",
    });

    return graph;
  }

  /**
   * Fill a gap in the reasoning graph with LLM output.
   */
  fillGap(graph: ReasoningGraph, gapId: string, content: string, confidence: number): ReasoningGraph {
    const gapNode = graph.nodes.find((n) => n.id === gapId && n.type === "gap");
    if (!gapNode) return graph;

    // Convert gap to inference
    gapNode.type = "inference";
    gapNode.content = content;
    gapNode.confidence = confidence;
    gapNode.source = "llm";

    // Remove from gaps
    graph.gaps = graph.gaps.filter((g) => g.id !== gapId.replace("gap_", "gap_"));

    // Recalculate
    graph.completeness = this.calculateCompleteness(graph);
    graph.confidence = this.calculateConfidence(graph.nodes);
    graph.needsLLM = graph.gaps.some((g) => g.suggestedAction === "use_llm");

    return graph;
  }

  /**
   * Get stats.
   */
  getStats(): { built: number; gapsFound: number; llmCalls: number } {
    return { ...this.stats };
  }

  // ─── Private ─────────────────────────────────────────────────────

  private identifyGaps(nodes: ReasoningNode[], input: string): ReasoningGap[] {
    const gaps: ReasoningGap[] = [];

    // Gap 1: Missing conclusion
    const hasConclusion = nodes.some((n) => n.type === "conclusion");
    if (!hasConclusion && nodes.length > 1) {
      gaps.push({
        id: "gap_conclusion",
        description: "Missing conclusion from reasoning chain",
        requiredFor: nodes.map((n) => n.id),
        suggestedAction: "use_llm",
        priority: "high",
      });
    }

    // Gap 2: Low confidence inferences
    const lowConfidence = nodes.filter((n) => n.type === "inference" && n.confidence < 0.5);
    for (const node of lowConfidence) {
      gaps.push({
        id: `gap_confidence_${node.id}`,
        description: `Low confidence in: ${node.content.slice(0, 100)}`,
        requiredFor: [node.id],
        suggestedAction: "search_knowledge",
        priority: "medium",
      });
    }

    // Gap 3: Missing dependencies
    for (const node of nodes) {
      if (node.dependencies.length === 0 && node.type === "inference") {
        gaps.push({
          id: `gap_dep_${node.id}`,
          description: `Missing dependencies for: ${node.content.slice(0, 100)}`,
          requiredFor: [node.id],
          suggestedAction: "search_knowledge",
          priority: "low",
        });
      }
    }

    this.stats.gapsFound += gaps.length;
    return gaps;
  }

  private calculateCompleteness(graph: ReasoningGraph): number {
    const total = graph.nodes.length;
    const gaps = graph.gaps.length;
    return total > 0 ? (total - gaps) / total : 1;
  }

  private calculateConfidence(nodes: ReasoningNode[]): number {
    if (nodes.length === 0) return 0;
    const sum = nodes.reduce((acc, n) => acc + n.confidence, 0);
    return sum / nodes.length;
  }
}

export const reasoningGraphBuilder = new ReasoningGraphBuilderImpl();
