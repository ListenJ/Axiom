/**
 * OpenClaw IDE Plugin - Document Bridge
 * 
 * Provides universal document format and bidirectional conversion
 * between Markdown and Office/IDE document formats.
 * 
 * Philosophy: Markdown as the universal intermediate format.
 * All document operations convert to/from Markdown internally.
 */

import { AstEngine, ContentType, ParseResult } from "./index.js";

/** Universal document node - platform agnostic representation */
export interface DocumentNode {
  id: string;
  type: "heading" | "paragraph" | "code" | "list" | "table" | "image" | "quote" | "page_break";
  content: string;
  level?: number;           // For headings (1-6)
  language?: string;        // For code blocks
  items?: string[];         // For lists
  rows?: Array<{ cells: string[] }>; // For tables
  metadata?: Record<string, unknown>;
}

/** Universal document representation */
export interface UniversalDocument {
  title: string;
  nodes: DocumentNode[];
  metadata: {
    createdAt?: string;
    modifiedAt?: string;
    author?: string;
    sourceFormat?: string;
    wordCount?: number;
  };
}

/** Conversion options */
export interface ConversionOptions {
  preserveFormatting?: boolean;
  extractImages?: boolean;
  includeMetadata?: boolean;
  maxDepth?: number;        // Max heading depth to include
}

/** Document converter interface */
export interface DocumentConverter<T> {
  /** Convert from platform-specific format to universal document */
  fromPlatform(data: T, options?: ConversionOptions): UniversalDocument;
  
  /** Convert from universal document to platform-specific format */
  toPlatform(doc: UniversalDocument, options?: ConversionOptions): T;
  
  /** Platform identifier */
  readonly platform: string;
}

/**
 * Document Bridge - Central conversion hub
 * 
 * Manages converters and orchestrates document transformations.
 */
export class DocumentBridge {
  private converters = new Map<string, DocumentConverter<unknown>>();
  private astEngine = new AstEngine();

  /** Register a document converter */
  registerConverter<T>(converter: DocumentConverter<T>): void {
    this.converters.set(converter.platform, converter as DocumentConverter<unknown>);
  }

  /** Get converter for a platform */
  getConverter<T>(platform: string): DocumentConverter<T> | undefined {
    return this.converters.get(platform) as DocumentConverter<T> | undefined;
  }

  /**
   * Convert document between any two formats.
   * Uses Markdown as the intermediate format.
   */
  convert<TFrom, TTo>(
    source: TFrom,
    fromPlatform: string,
    toPlatform: string,
    options?: ConversionOptions
  ): TTo {
    const fromConv = this.getConverter<TFrom>(fromPlatform);
    const toConv = this.getConverter<TTo>(toPlatform);
    
    if (!fromConv) throw new Error(`No converter registered for platform: ${fromPlatform}`);
    if (!toConv) throw new Error(`No converter registered for platform: ${toPlatform}`);

    // Source → Universal
    const universal = fromConv.fromPlatform(source, options);
    
    // Universal → Target
    return toConv.toPlatform(universal, options);
  }

  /**
   * Parse any document into AST nodes for knowledge graph construction.
   * Auto-detects content type.
   */
  parseToAst(content: string, contentType?: ContentType): ParseResult {
    return this.astEngine.parse(content, { contentType });
  }

  /**
   * Convert Markdown to universal document.
   * Primary entry point for all Markdown-based operations.
   */
  markdownToUniversal(markdown: string, options?: ConversionOptions): UniversalDocument {
    const ast = this.astEngine.parse(markdown, { contentType: "markdown" });
    const nodes: DocumentNode[] = [];

    for (const [, node] of ast.nodes) {
      const docNode = this.astNodeToDocumentNode(node);
      if (docNode) nodes.push(docNode);
    }

    // Extract title from first heading or root node
    const firstHeading = Array.from(ast.nodes.values()).find((n) => n.type === "heading");
    const title = firstHeading?.label || "Untitled";

    return {
      title,
      nodes,
      metadata: {
        sourceFormat: "markdown",
        wordCount: markdown.split(/\s+/).length,
      },
    };
  }

  /**
   * Convert universal document to Markdown.
   */
  universalToMarkdown(doc: UniversalDocument): string {
    const lines: string[] = [];
    
    if (doc.title && doc.title !== "Untitled") {
      lines.push(`# ${doc.title}`, "");
    }

    for (const node of doc.nodes) {
      const md = this.documentNodeToMarkdown(node);
      if (md) lines.push(md, "");
    }

    return lines.join("\n");
  }

  private astNodeToDocumentNode(astNode: { type: string; label: string; content: string; metadata?: Record<string, unknown> }): DocumentNode | null {
    switch (astNode.type) {
      case "heading":
        return {
          id: `h-${Math.random().toString(36).slice(2, 8)}`,
          type: "heading",
          content: astNode.label,
          level: (astNode.metadata?.level as number) || 1,
        };
      case "paragraph":
        return {
          id: `p-${Math.random().toString(36).slice(2, 8)}`,
          type: "paragraph",
          content: astNode.content,
        };
      case "code":
        return {
          id: `c-${Math.random().toString(36).slice(2, 8)}`,
          type: "code",
          content: astNode.content,
          language: (astNode.metadata?.language as string) || "",
        };
      case "list":
        return {
          id: `l-${Math.random().toString(36).slice(2, 8)}`,
          type: "list",
          content: astNode.label,
          items: (astNode.metadata?.items as string[]) || [],
        };
      case "table":
        return {
          id: `t-${Math.random().toString(36).slice(2, 8)}`,
          type: "table",
          content: astNode.label,
          rows: (astNode.metadata?.rows as Array<{ cells: string[] }>) || [],
        };
      case "quote":
        return {
          id: `q-${Math.random().toString(36).slice(2, 8)}`,
          type: "quote",
          content: astNode.content,
        };
      default:
        return null;
    }
  }

  private documentNodeToMarkdown(node: DocumentNode): string | null {
    switch (node.type) {
      case "heading":
        return `${"#".repeat(node.level || 1)} ${node.content}`;
      case "paragraph":
        return node.content;
      case "code":
        return ["\`\`\`" + (node.language || ""), node.content, "\`\`\`"].join("\n");
      case "list":
        return (node.items || []).map((item) => `- ${item}`).join("\n");
      case "table":
        if (!node.rows?.length) return null;
        const header = node.rows[0]?.cells.join(" | ");
        const separator = node.rows[0]?.cells.map(() => "---").join(" | ");
        const body = node.rows.slice(1).map((row) => row.cells.join(" | ")).join("\n");
        return [header, separator, body].join("\n");
      case "quote":
        return node.content.split("\n").map((line) => `> ${line}`).join("\n");
      default:
        return null;
    }
  }
}

/** Global document bridge instance */
export const documentBridge = new DocumentBridge();
