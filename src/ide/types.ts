/**
 * AST Engine - Generic Abstract Syntax Tree parsing and slicing
 * 
 * Provides unified interfaces for parsing various content types into
 * structured AST nodes that can be used for knowledge graph construction.
 * 
 * Philosophy: Zero vectors, zero embeddings — structural analysis only
 */

/** Content types supported by the AST engine */
export type ContentType = 
  | "markdown" 
  | "typescript" 
  | "javascript" 
  | "python"
  | "json"
  | "yaml"
  | "html"
  | "css"
  | "text";

/** Node types in the AST */
export type AstNodeType =
  | "document"      // Root node
  | "heading"       // Title/section header
  | "paragraph"     // Text block
  | "code"          // Code block
  | "list"          // Ordered/unordered list
  | "table"         // Data table
  | "quote"         // Blockquote
  | "function"      // Function declaration
  | "class"         // Class declaration
  | "interface"     // Interface declaration
  | "import"        // Import statement
  | "comment"       // Comment block
  | "section";      // Generic section container

/** Relationship types between nodes */
export type RelationType =
  | "contains"      // Parent-child
  | "references"    // Cross-reference
  | "depends_on"    // Dependency
  | "extends"       // Inheritance
  | "implements"    // Interface implementation
  | "calls";        // Function call

/** Position in source content */
export interface SourcePosition {
  line: number;
  column: number;
  offset: number;
}

/** Source range */
export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

/** Metadata for an AST node */
export interface NodeMetadata {
  /** Node importance score (0-1) */
  importance?: number;
  /** Tags for categorization */
  tags?: string[];
  /** Language identifier (for code blocks) */
  language?: string;
  /** Heading level (for heading nodes) */
  level?: number;
  /** Additional parser-specific data */
  [key: string]: unknown;
}

/** Core AST Node */
export interface AstNode {
  /** Unique identifier */
  id: string;
  /** Node type */
  type: AstNodeType;
  /** Human-readable label */
  label: string;
  /** Raw content */
  content: string;
  /** Position in source */
  range: SourceRange;
  /** Parent node ID (null for root) */
  parentId: string | null;
  /** Child node IDs */
  childrenIds: string[];
  /** Node metadata */
  metadata: NodeMetadata;
  /** Content type this node was parsed from */
  contentType: ContentType;
}

/** Relationship between two nodes */
export interface NodeRelation {
  /** Source node ID */
  fromId: string;
  /** Target node ID */
  toId: string;
  /** Relationship type */
  type: RelationType;
  /** Relationship metadata */
  metadata?: Record<string, unknown>;
}

/** Parse options */
export interface ParseOptions {
  /** Content type hint */
  contentType?: ContentType;
  /** Whether to include comments */
  includeComments?: boolean;
  /** Minimum node importance threshold */
  minImportance?: number;
  /** Maximum depth for tree traversal */
  maxDepth?: number;
  /** Custom metadata extractor */
  metadataExtractor?: (node: AstNode, source: string) => NodeMetadata;
}

/** Parse result */
export interface ParseResult {
  /** Root node */
  root: AstNode;
  /** All nodes flattened */
  nodes: Map<string, AstNode>;
  /** Node relationships */
  relations: NodeRelation[];
  /** Content type detected */
  contentType: ContentType;
  /** Parse statistics */
  stats: {
    totalNodes: number;
    maxDepth: number;
    durationMs: number;
  };
}

/** Generic parser interface */
export interface AstParser {
  /** Parser name */
  readonly name: string;
  /** Supported content types */
  readonly supportedTypes: ContentType[];
  /** Parse content into AST */
  parse(content: string, options?: ParseOptions): ParseResult;
  /** Detect if this parser can handle the content */
  canParse(content: string, typeHint?: ContentType): boolean;
}

/** Node filter predicate */
export type NodeFilter = (node: AstNode) => boolean;

/** Node transformer */
export type NodeTransformer = (node: AstNode) => AstNode;

/** Query options for knowledge graph */
export interface GraphQuery {
  /** Filter by node type */
  types?: AstNodeType[];
  /** Filter by content type */
  contentTypes?: ContentType[];
  /** Text search in labels */
  labelContains?: string;
  /** Filter by tags */
  tags?: string[];
  /** Minimum importance */
  minImportance?: number;
  /** Maximum depth from root */
  maxDepth?: number;
  /** Custom filter */
  filter?: NodeFilter;
}

/** Knowledge graph representation */
export interface KnowledgeGraph {
  /** All nodes */
  nodes: Map<string, AstNode>;
  /** All relations */
  relations: NodeRelation[];
  /** Add a node */
  addNode(node: AstNode): void;
  /** Add a relation */
  addRelation(relation: NodeRelation): void;
  /** Query nodes */
  queryNodes(options: GraphQuery): AstNode[];
  /** Get node by ID */
  getNode(id: string): AstNode | undefined;
  /** Get children of a node */
  getChildren(parentId: string): AstNode[];
  /** Get related nodes */
  getRelated(nodeId: string, relationType?: RelationType): AstNode[];
  /** Build from parse result */
  buildFromParse(result: ParseResult): void;
  /** Export to various formats */
  export(format: "json" | "dot" | "mermaid"): string;
}

/** Slicing strategy */
export type SliceStrategy =
  | "by_heading"      // Slice by Markdown headings
  | "by_function"     // Slice by code functions
  | "by_class"        // Slice by code classes
  | "by_paragraph"    // Slice by paragraphs
  | "by_section";     // Slice by generic sections

/** Slice options */
export interface SliceOptions {
  /** Strategy to use */
  strategy: SliceStrategy;
  /** Minimum slice size (characters) */
  minSize?: number;
  /** Maximum slice size (characters) */
  maxSize?: number;
  /** Whether to include metadata */
  includeMetadata?: boolean;
  /** Overlap between slices (characters) */
  overlap?: number;
}

/** Slice result */
export interface SliceResult {
  /** Slice ID */
  id: string;
  /** Slice content */
  content: string;
  /** Source node ID */
  sourceNodeId: string;
  /** Slice position in source */
  range: SourceRange;
  /** Related slice IDs */
  relatedSliceIds: string[];
  /** Slice metadata */
  metadata: NodeMetadata;
}
