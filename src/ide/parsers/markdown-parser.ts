/**
 * Markdown AST Parser
 * 
 * Parses Markdown content into structured AST nodes.
 * Uses heading-based chunking for document slicing.
 */

import {
  type AstNode,
  type AstNodeType,
  type AstParser,
  type ContentType,
  type NodeMetadata,
  type ParseOptions,
  type ParseResult,
} from "../types.js";
import {
  createNode,
  createRange,
  createPosition,
  generateNodeId,
  createRelation,
} from "../ast-engine.js";

/** Markdown parser implementation */
export class MarkdownParser implements AstParser {
  readonly name = "markdown";
  readonly supportedTypes: ContentType[] = ["markdown", "text"];

  canParse(content: string, typeHint?: ContentType): boolean {
    if (typeHint === "markdown") return true;
    const trimmed = content.trim();
    return /^#{1,6}\s/m.test(trimmed) ||
           /^[-*+]\s/m.test(trimmed) ||
           /^```/m.test(trimmed) ||
           /^\d+\.\s/m.test(trimmed) ||
           /^\s*\|/m.test(trimmed);
  }

  parse(content: string, options: ParseOptions = {}): ParseResult {
    const startTime = performance.now();
    const lines = content.split("\n");
    const nodes = new Map<string, AstNode>();
    const relations: ReturnType<typeof createRelation>[] = [];

    // Create root document node
    const root = createNode(
      "document",
      this.extractTitle(content) || "Document",
      content,
      createRange(createPosition(1, 0, 0), createPosition(lines.length, 0, content.length)),
      { contentType: "markdown" }
    );
    nodes.set(root.id, root);

    // Parse document structure
    const sections = this.parseSections(lines, content, root.id);
    
    for (const section of sections) {
      nodes.set(section.id, section);
      relations.push(createRelation(root.id, section.id, "contains"));
      
      // Add section children to root
      root.childrenIds.push(section.id);
    }

    // Parse inline elements within sections
    for (const [_, node] of nodes) {
      if (node.type === "section" || node.type === "heading") {
        const inlineNodes = this.parseInlineElements(node, content);
        for (const inline of inlineNodes) {
          nodes.set(inline.id, inline);
          relations.push(createRelation(node.id, inline.id, "contains"));
          node.childrenIds.push(inline.id);
        }
      }
    }

    const duration = performance.now() - startTime;

    return {
      root,
      nodes,
      relations,
      contentType: "markdown",
      stats: {
        totalNodes: nodes.size,
        maxDepth: this.calculateMaxDepth(nodes),
        durationMs: duration,
      },
    };
  }

  /** Extract document title from content */
  private extractTitle(content: string): string | null {
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  /** Parse document into sections based on headings */
  private parseSections(lines: string[], content: string, rootId: string): AstNode[] {
    const sections: AstNode[] = [];
    let currentSection: AstNode | null = null;
    let sectionContent: string[] = [];
    let sectionStart = 0;

    for (let i = 0; i <= lines.length; i++) {
      const line = lines[i] || "";
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch || i === lines.length) {
        // Save previous section
        if (currentSection && sectionContent.length > 0) {
          currentSection.content = sectionContent.join("\n").trim();
          const endOffset = sectionStart + currentSection.content.length;
          currentSection.range = createRange(
            createPosition(this.getLineNumber(content, sectionStart), 0, sectionStart),
            createPosition(this.getLineNumber(content, endOffset), 0, endOffset)
          );
        }

        if (headingMatch) {
          const level = headingMatch[1].length;
          const title = headingMatch[2].trim();
          sectionStart = this.getOffset(content, i);

          currentSection = createNode(
            "section",
            title,
            "",
            createRange(
              createPosition(i + 1, 0, sectionStart),
              createPosition(i + 1, line.length, sectionStart + line.length)
            ),
            {
              parentId: rootId,
              contentType: "markdown",
              metadata: {
                level,
                headingLevel: level,
                tags: this.extractTags(title),
              },
            }
          );

          // Also create heading node
          const headingNode = createNode(
            "heading",
            title,
            line,
            createRange(
              createPosition(i + 1, 0, sectionStart),
              createPosition(i + 1, line.length, sectionStart + line.length)
            ),
            {
              parentId: currentSection.id,
              contentType: "markdown",
              metadata: {
                level,
                tags: this.extractTags(title),
              },
            }
          );

          currentSection.childrenIds.push(headingNode.id);
          sections.push(currentSection);
          sections.push(headingNode);

          sectionContent = [];
        }
      } else if (currentSection) {
        sectionContent.push(line);
      }
    }

    // If no headings found, create a single section
    if (sections.length === 0) {
      const section = createNode(
        "section",
        "Content",
        content,
        createRange(
          createPosition(1, 0, 0),
          createPosition(lines.length, 0, content.length)
        ),
        { parentId: rootId, contentType: "markdown" }
      );
      sections.push(section);
    }

    return sections;
  }

  /** Parse inline elements within a node */
  private parseInlineElements(parentNode: AstNode, content: string): AstNode[] {
    const nodes: AstNode[] = [];
    const nodeContent = parentNode.content;

    // Parse code blocks
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(nodeContent)) !== null) {
      const language = match[1] || "text";
      const codeContent = match[2].trim();
      const startOffset = parentNode.range.start.offset + match.index;
      const endOffset = startOffset + match[0].length;

      const codeNode = createNode(
        "code",
        `${language} code`,
        codeContent,
        createRange(
          createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
          createPosition(this.getLineNumber(content, endOffset), 0, endOffset)
        ),
        {
          parentId: parentNode.id,
          contentType: "markdown",
          metadata: { language },
        }
      );
      nodes.push(codeNode);
    }

    // Parse lists
    const listRegex = /^([-*+]|\d+\.)\s+(.+)$/gm;
    const listItems: string[] = [];
    while ((match = listRegex.exec(nodeContent)) !== null) {
      listItems.push(match[2]);
    }

    if (listItems.length > 0) {
      const startOffset = parentNode.range.start.offset;
      const listNode = createNode(
        "list",
        `List (${listItems.length} items)`,
        listItems.join("\n"),
        createRange(
          createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
          createPosition(this.getLineNumber(content, startOffset + nodeContent.length), 0, startOffset + nodeContent.length)
        ),
        {
          parentId: parentNode.id,
          contentType: "markdown",
          metadata: { itemCount: listItems.length },
        }
      );
      nodes.push(listNode);
    }

    // Parse tables
    const tableRegex = /\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g;
    while ((match = tableRegex.exec(nodeContent)) !== null) {
      const startOffset = parentNode.range.start.offset + match.index;
      const endOffset = startOffset + match[0].length;

      const tableNode = createNode(
        "table",
        "Table",
        match[0].trim(),
        createRange(
          createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
          createPosition(this.getLineNumber(content, endOffset), 0, endOffset)
        ),
        {
          parentId: parentNode.id,
          contentType: "markdown",
          metadata: { columns: match[1].split("|").length },
        }
      );
      nodes.push(tableNode);
    }

    // Parse blockquotes
    const quoteRegex = /^\u003e\s+(.+)$/gm;
    const quotes: string[] = [];
    while ((match = quoteRegex.exec(nodeContent)) !== null) {
      quotes.push(match[1]);
    }

    if (quotes.length > 0) {
      const startOffset = parentNode.range.start.offset;
      const quoteNode = createNode(
        "quote",
        "Quote",
        quotes.join("\n"),
        createRange(
          createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
          createPosition(this.getLineNumber(content, startOffset + nodeContent.length), 0, startOffset + nodeContent.length)
        ),
        { parentId: parentNode.id, contentType: "markdown" }
      );
      nodes.push(quoteNode);
    }

    return nodes;
  }

  /** Extract tags from heading text */
  private extractTags(text: string): string[] {
    const tags: string[] = [];
    const words = text.toLowerCase().split(/\s+/);
    
    for (const word of words) {
      if (word.length > 3) {
        tags.push(word.replace(/[^\w]/g, ""));
      }
    }
    
    return tags;
  }

  /** Get line number for offset */
  private getLineNumber(content: string, offset: number): number {
    return content.slice(0, offset).split("\n").length;
  }

  /** Get offset for line */
  private getOffset(content: string, lineIndex: number): number {
    const lines = content.split("\n");
    let offset = 0;
    for (let i = 0; i < lineIndex; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }
    return offset;
  }

  /** Calculate maximum depth of nodes */
  private calculateMaxDepth(nodes: Map<string, AstNode>): number {
    let maxDepth = 0;

    for (const [_, node] of nodes) {
      let depth = 0;
      let current: AstNode | undefined = node;
      while (current) {
        depth++;
        current = current.parentId ? nodes.get(current.parentId) : undefined;
      }
      maxDepth = Math.max(maxDepth, depth);
    }

    return maxDepth;
  }
}

/** Create parser instance */
export function createMarkdownParser(): AstParser {
  return new MarkdownParser();
}
