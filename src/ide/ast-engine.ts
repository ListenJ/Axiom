/**
 * AST Engine - Core implementation
 * 
 * Generic engine for parsing content into AST nodes and building knowledge graphs.
 */

import {
  type AstNode,
  type AstNodeType,
  type AstParser,
  type ContentType,
  type KnowledgeGraph,
  type NodeFilter,
  type NodeMetadata,
  type NodeRelation,
  type NodeTransformer,
  type ParseOptions,
  type ParseResult,
  type SliceOptions,
  type SliceResult,
  type SliceStrategy,
  type SourcePosition,
  type SourceRange,
  type GraphQuery,
} from "./types.js";

let idCounter = 0;

/** Generate unique node ID */
export function generateNodeId(prefix = "node"): string {
  return `${prefix}_${++idCounter}_${Date.now().toString(36)}`;
}

/** Create source position */
export function createPosition(line = 1, column = 0, offset = 0): SourcePosition {
  return { line, column, offset };
}

/** Create source range */
export function createRange(start: SourcePosition, end: SourcePosition): SourceRange {
  return { start, end };
}

/** Create AST node */
export function createNode(
  type: AstNodeType,
  label: string,
  content: string,
  range: SourceRange,
  options: {
    parentId?: string | null;
    contentType?: ContentType;
    metadata?: NodeMetadata;
  } = {}
): AstNode {
  return {
    id: generateNodeId(type),
    type,
    label,
    content,
    range,
    parentId: options.parentId ?? null,
    childrenIds: [],
    metadata: options.metadata ?? {},
    contentType: options.contentType ?? "text",
  };
}

/** Create node relation */
export function createRelation(
  fromId: string,
  toId: string,
  type: NodeRelation["type"],
  metadata?: Record<string, unknown>
): NodeRelation {
  return { fromId, toId, type, metadata };
}

/** Detect content type from content string */
export function detectContentType(content: string, hint?: ContentType): ContentType {
  if (hint) return hint;

  const trimmed = content.trim();

  // Markdown detection
  if (/^#{1,6}\s/m.test(trimmed) || /^[-*+]\s/m.test(trimmed) || /^```/m.test(trimmed)) {
    return "markdown";
  }

  // JSON detection
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || 
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { JSON.parse(trimmed); return "json"; } catch { /* not JSON */ }
  }

  // YAML detection
  if (/^[\w-]+:\s/m.test(trimmed) && !trimmed.includes(";")) {
    return "yaml";
  }

  // HTML detection
  if (/^\s*<(!DOCTYPE|html|div|span|p)\b/i.test(trimmed)) {
    return "html";
  }

  // CSS detection
  if (/^[.#@]?[\w-]+\s*\{/.test(trimmed)) {
    return "css";
  }

  // Code detection (TypeScript/JavaScript)
  if (/\b(function|const|let|var|class|interface|import|export)\b/.test(trimmed)) {
    return "typescript";
  }

  // Python detection
  if (/\b(def|class|import|from)\b/.test(trimmed) && /:\s*$/.test(trimmed)) {
    return "python";
  }

  return "text";
}

/** AST Engine implementation */
export class AstEngine {
  private parsers: Map<ContentType, AstParser> = new Map();
  private graphs: Map<string, KnowledgeGraph> = new Map();

  /** Register a parser for content types */
  registerParser(parser: AstParser): void {
    for (const type of parser.supportedTypes) {
      this.parsers.set(type, parser);
    }
  }

  /** Get parser for content type */
  getParser(contentType: ContentType): AstParser | undefined {
    return this.parsers.get(contentType);
  }

  /** Parse content into AST */
  parse(content: string, options: ParseOptions = {}): ParseResult {
    const startTime = performance.now();
    const contentType = options.contentType ?? detectContentType(content);
    const parser = this.parsers.get(contentType);

    if (!parser) {
      // Fallback: create simple document node
      const root = createNode(
        "document",
        "Document",
        content,
        createRange(createPosition(1, 0, 0), createPosition(1, 0, content.length)),
        { contentType }
      );
      return {
        root,
        nodes: new Map([[root.id, root]]),
        relations: [],
        contentType,
        stats: {
          totalNodes: 1,
          maxDepth: 1,
          durationMs: performance.now() - startTime,
        },
      };
    }

    return parser.parse(content, options);
  }

  /** Build knowledge graph from parse result */
  buildGraph(result: ParseResult, graphId?: string): KnowledgeGraph {
    const id = graphId ?? generateNodeId("graph");
    const graph = new SimpleKnowledgeGraph();
    graph.buildFromParse(result);
    this.graphs.set(id, graph);
    return graph;
  }

  /** Get graph by ID */
  getGraph(id: string): KnowledgeGraph | undefined {
    return this.graphs.get(id);
  }

  /** Slice content using strategy */
  slice(content: string, options: SliceOptions): SliceResult[] {
    const parseResult = this.parse(content, {
      contentType: this.detectTypeForStrategy(options.strategy),
    });

    const slices: SliceResult[] = [];
    const minSize = options.minSize ?? 100;
    const maxSize = options.maxSize ?? 2000;
    const overlap = options.overlap ?? 0;

    const nodes = Array.from(parseResult.nodes.values());
    const strategyNodes = this.filterNodesByStrategy(nodes, options.strategy);

    for (const node of strategyNodes) {
      const nodeContent = node.content;

      if (nodeContent.length < minSize) continue;

      // Split large nodes into chunks
      if (nodeContent.length > maxSize) {
        const chunks = this.chunkContent(nodeContent, maxSize, overlap);
        for (let i = 0; i < chunks.length; i++) {
          slices.push(this.createSlice(chunks[i], node, i, slices));
        }
      } else {
        slices.push(this.createSlice(nodeContent, node, 0, slices));
      }
    }

    return slices;
  }

  /** Detect content type for slicing strategy */
  private detectTypeForStrategy(strategy: SliceStrategy): ContentType {
    switch (strategy) {
      case "by_heading":
      case "by_paragraph":
      case "by_section":
        return "markdown";
      case "by_function":
      case "by_class":
        return "typescript";
      default:
        return "text";
    }
  }

  /** Filter nodes by slicing strategy */
  private filterNodesByStrategy(nodes: AstNode[], strategy: SliceStrategy): AstNode[] {
    switch (strategy) {
      case "by_heading":
        return nodes.filter(n => n.type === "heading" || n.type === "section");
      case "by_function":
        return nodes.filter(n => n.type === "function");
      case "by_class":
        return nodes.filter(n => n.type === "class" || n.type === "interface");
      case "by_paragraph":
        return nodes.filter(n => n.type === "paragraph" || n.type === "code");
      case "by_section":
        return nodes.filter(n => n.type === "section" || n.type === "heading");
      default:
        return nodes;
    }
  }

  /** Chunk content into pieces */
  private chunkContent(content: string, maxSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < content.length) {
      const end = Math.min(start + maxSize, content.length);
      chunks.push(content.slice(start, end));
      start = end - overlap;
      if (start >= end) start = end; // Prevent infinite loop
    }

    return chunks;
  }

  /** Create slice result */
  private createSlice(
    content: string,
    sourceNode: AstNode,
    chunkIndex: number,
    existingSlices: SliceResult[]
  ): SliceResult {
    const sliceId = generateNodeId("slice");
    
    // Find related slices from same parent
    const relatedSliceIds = existingSlices
      .filter(s => s.sourceNodeId === sourceNode.id)
      .map(s => s.id);

    return {
      id: sliceId,
      content,
      sourceNodeId: sourceNode.id,
      range: sourceNode.range,
      relatedSliceIds,
      metadata: {
        ...sourceNode.metadata,
        chunkIndex,
        totalChunks: chunkIndex + 1,
      },
    };
  }

  /** Transform nodes in parse result */
  transform(result: ParseResult, transformer: NodeTransformer): ParseResult {
    const newNodes = new Map<string, AstNode>();
    
    for (const [id, node] of result.nodes) {
      newNodes.set(id, transformer(node));
    }

    return {
      ...result,
      nodes: newNodes,
    };
  }

  /** Filter nodes in parse result */
  filter(result: ParseResult, filter: NodeFilter): ParseResult {
    const filteredNodes = new Map<string, AstNode>();
    
    for (const [id, node] of result.nodes) {
      if (filter(node)) {
        filteredNodes.set(id, node);
      }
    }

    return {
      ...result,
      nodes: filteredNodes,
    };
  }
}

/** Simple knowledge graph implementation */
class SimpleKnowledgeGraph implements KnowledgeGraph {
  nodes: Map<string, AstNode> = new Map();
  relations: NodeRelation[] = [];

  addNode(node: AstNode): void {
    this.nodes.set(node.id, node);
  }

  addRelation(relation: NodeRelation): void {
    this.relations.push(relation);
  }

  queryNodes(options: GraphQuery): AstNode[] {
    let results = Array.from(this.nodes.values());

    if (options.types) {
      results = results.filter(n => options.types!.includes(n.type));
    }

    if (options.contentTypes) {
      results = results.filter(n => options.contentTypes!.includes(n.contentType));
    }

    if (options.labelContains) {
      const search = options.labelContains.toLowerCase();
      results = results.filter(n => n.label.toLowerCase().includes(search));
    }

    if (options.tags) {
      results = results.filter(n => 
        n.metadata.tags?.some(tag => options.tags!.includes(tag))
      );
    }

    if (options.minImportance !== undefined) {
      results = results.filter(n => 
        (n.metadata.importance ?? 0) >= options.minImportance!
      );
    }

    if (options.maxDepth !== undefined) {
      results = results.filter(n => this.getDepth(n.id) <= options.maxDepth!);
    }

    if (options.filter) {
      results = results.filter(options.filter);
    }

    return results;
  }

  getNode(id: string): AstNode | undefined {
    return this.nodes.get(id);
  }

  getChildren(parentId: string): AstNode[] {
    return Array.from(this.nodes.values())
      .filter(n => n.parentId === parentId);
  }

  getRelated(nodeId: string, relationType?: NodeRelation["type"]): AstNode[] {
    const relatedIds = this.relations
      .filter(r => {
        if (r.fromId !== nodeId) return false;
        if (relationType && r.type !== relationType) return false;
        return true;
      })
      .map(r => r.toId);

    return relatedIds
      .map(id => this.nodes.get(id))
      .filter((n): n is AstNode => n !== undefined);
  }

  buildFromParse(result: ParseResult): void {
    // Add all nodes
    for (const [_, node] of result.nodes) {
      this.addNode(node);
    }

    // Add relations from parent-child relationships
    for (const [_, node] of result.nodes) {
      if (node.parentId) {
        this.addRelation(createRelation(node.parentId, node.id, "contains"));
      }
      for (const childId of node.childrenIds) {
        this.addRelation(createRelation(node.id, childId, "contains"));
      }
    }

    // Add additional relations from parse result
    for (const relation of result.relations) {
      this.addRelation(relation);
    }
  }

  export(format: "json" | "dot" | "mermaid"): string {
    switch (format) {
      case "json":
        return JSON.stringify({
          nodes: Array.from(this.nodes.values()),
          relations: this.relations,
        }, null, 2);

      case "dot":
        return this.exportToDot();

      case "mermaid":
        return this.exportToMermaid();

      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  private exportToDot(): string {
    const lines = ["digraph KnowledgeGraph {"];
    
    for (const [_, node] of this.nodes) {
      const label = node.label.replace(/"/g, '\\"');
      lines.push(`  "${node.id}" [label="${label}"];`);
    }

    for (const rel of this.relations) {
      lines.push(`  "${rel.fromId}" -> "${rel.toId}" [label="${rel.type}"];`);
    }

    lines.push("}");
    return lines.join("\n");
  }

  private exportToMermaid(): string {
    const lines = ["graph TD;"];
    
    for (const [_, node] of this.nodes) {
      const label = node.label.replace(/\[/g, "(").replace(/\]/g, ")");
      lines.push(`  ${node.id}["${label}"];`);
    }

    for (const rel of this.relations) {
      lines.push(`  ${rel.fromId} --${rel.type}--> ${rel.toId};`);
    }

    return lines.join("\n");
  }

  private getDepth(nodeId: string): number {
    const node = this.nodes.get(nodeId);
    if (!node || !node.parentId) return 0;
    return 1 + this.getDepth(node.parentId);
  }
}

/** Global AST engine instance */
export const astEngine = new AstEngine();

/** Utility functions for node manipulation */
export const NodeUtils = {
  /** Get node hierarchy path */
  getPath(nodeId: string, nodes: Map<string, AstNode>): AstNode[] {
    const path: AstNode[] = [];
    let current = nodes.get(nodeId);
    
    while (current) {
      path.unshift(current);
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    
    return path;
  },

  /** Get node siblings */
  getSiblings(nodeId: string, nodes: Map<string, AstNode>): AstNode[] {
    const node = nodes.get(nodeId);
    if (!node || !node.parentId) return [];
    
    return Array.from(nodes.values())
      .filter(n => n.parentId === node.parentId && n.id !== nodeId);
  },

  /** Calculate node importance based on depth and children */
  calculateImportance(node: AstNode): number {
    let score = 0.5;
    
    // Higher level headings are more important
    if (node.type === "heading" && node.metadata.level) {
      score += (7 - node.metadata.level) * 0.1;
    }
    
    // Nodes with children are more important
    score += Math.min(node.childrenIds.length * 0.05, 0.3);
    
    // Code and function nodes are important
    if (["function", "class", "interface"].includes(node.type)) {
      score += 0.2;
    }
    
    return Math.min(score, 1);
  },

  /** Extract keywords from node content */
  extractKeywords(content: string, maxKeywords = 5): string[] {
    const words = content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3);
    
    const frequency = new Map<string, number>();
    for (const word of words) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
    
    return Array.from(frequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKeywords)
      .map(([word]) => word);
  },
};
