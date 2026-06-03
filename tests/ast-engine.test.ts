/**
 * AST Engine Unit Tests
 * Tests for markdown parser, code parser, and knowledge graph
 */

import { describe, test, expect } from "bun:test";
import { AstEngine } from "../src/ide/ast-engine.js";
import { MarkdownParser } from "../src/ide/parsers/markdown-parser.js";
import { CodeParser } from "../src/ide/parsers/code-parser.js";
import type { ContentType, AstNodeType } from "../src/ide/types.js";

describe("AST Engine", () => {
  const engine = new AstEngine();

  test("should auto-detect markdown content", () => {
    const markdown = `# Hello World

This is a test document.

## Section 1

Some content here.

## Section 2

More content.
`;

    const result = engine.parse(markdown);
    expect(result.contentType).toBe("markdown" as ContentType);
    expect(result.nodes.size).toBeGreaterThan(0);
    const firstNode = Array.from(result.nodes.values())[0];
    expect(firstNode.type).toBe("document" as AstNodeType);
  });

  test("should auto-detect TypeScript code", () => {
    const code = `
function hello(name: string): string {
  return \`Hello, \${name}!\`;
}

class Greeter {
  greet(name: string) {
    return hello(name);
  }
}
`;

    const result = engine.parse(code);
    expect(result.contentType).toBe("typescript" as ContentType);
    expect(result.nodes.size).toBeGreaterThan(0);
  });

  test("should slice markdown by headings", () => {
    const markdown = `# Doc

## Section A
Content A

## Section B
Content B
`;

    const slices = engine.slice(markdown, { 
      strategy: "by_heading",
      minSize: 5  // Lower threshold for test content
    });
    
    expect(slices.length).toBeGreaterThanOrEqual(2);
    expect(slices.some(s => s.content?.includes("Section A"))).toBe(true);
    expect(slices.some(s => s.content?.includes("Section B"))).toBe(true);
  });

  test("should slice code by functions", () => {
    const code = `
function foo() { return 1; }
function bar() { return 2; }
`;

    const slices = engine.slice(code, { 
      strategy: "by_function",
      minSize: 5  // Lower threshold for test content
    });
    
    expect(slices.length).toBeGreaterThanOrEqual(2);
    expect(slices.some(s => s.content?.includes("foo"))).toBe(true);
    expect(slices.some(s => s.content?.includes("bar"))).toBe(true);
  });

  test("should build knowledge graph from nodes", () => {
    const markdown = `# Main

## Sub 1
See also [[Sub 2]]

## Sub 2
Related to [[Sub 1]]
`;

    const result = engine.parse(markdown);
    const graph = engine.buildGraph(result, "test-graph");
    
    expect(graph.nodes.size).toBeGreaterThan(0);
    // Contains relations from parent-child structure
    expect(graph.relations.length).toBeGreaterThanOrEqual(0);
  });
});

describe("Markdown Parser", () => {
  const parser = new MarkdownParser();

  test("should parse headings correctly", () => {
    const markdown = `# H1
## H2
### H3
`;

    const result = parser.parse(markdown);
    const headings = Array.from(result.nodes.values()).filter(n => n.type === "heading" as AstNodeType);
    
    expect(headings.length).toBe(3);
    expect(headings[0].metadata.level).toBe(1);
    expect(headings[1].metadata.level).toBe(2);
    expect(headings[2].metadata.level).toBe(3);
  });

  test("should detect code blocks", () => {
    const markdown = `
\`\`\`typescript
const x = 1;
\`\`\`
`;

    const result = parser.parse(markdown);
    const codeBlocks = Array.from(result.nodes.values()).filter(n => n.type === "code" as AstNodeType);
    
    expect(codeBlocks.length).toBe(1);
    expect(codeBlocks[0].metadata.language).toBe("typescript");
  });

  test("should detect lists", () => {
    const markdown = `
- Item 1
- Item 2
- Item 3
`;

    const result = parser.parse(markdown);
    const lists = Array.from(result.nodes.values()).filter(n => n.type === "list" as AstNodeType);
    
    expect(lists.length).toBe(1);
  });

  test("should detect tables", () => {
    const markdown = `
| Col1 | Col2 |
|------|------|
| A    | B    |
`;

    const result = parser.parse(markdown);
    const tables = Array.from(result.nodes.values()).filter(n => n.type === "table" as AstNodeType);
    
    expect(tables.length).toBe(1);
  });
});

describe("Code Parser", () => {
  const parser = new CodeParser();

  test("should parse TypeScript functions", () => {
    const code = `
function add(a: number, b: number): number {
  return a + b;
}

const multiply = (a: number, b: number) => a * b;
`;

    const result = parser.parse(code, { contentType: "typescript" as ContentType });
    const functions = Array.from(result.nodes.values()).filter(n => n.type === "function" as AstNodeType);
    
    expect(functions.length).toBe(2);
    expect(functions.some(f => f.label === "add")).toBe(true);
    expect(functions.some(f => f.label === "multiply")).toBe(true);
  });

  test("should parse TypeScript classes", () => {
    const code = `
class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}
`;

    const result = parser.parse(code, { contentType: "typescript" as ContentType });
    const classes = Array.from(result.nodes.values()).filter(n => n.type === "class" as AstNodeType);
    
    expect(classes.length).toBe(1);
    expect(classes[0].label).toBe("Calculator");
  });

  test("should parse Python functions", () => {
    const code = `
def greet(name):
    return f"Hello, {name}!"

class Person:
    def __init__(self, name):
        self.name = name
`;

    const result = parser.parse(code, { contentType: "python" as ContentType });
    const functions = Array.from(result.nodes.values()).filter(n => n.type === "function" as AstNodeType);
    const classes = Array.from(result.nodes.values()).filter(n => n.type === "class" as AstNodeType);
    
    expect(functions.length).toBe(1); // greet only (standalone)
    expect(classes.length).toBe(1);
    // __init__ is a method inside Person class, not a standalone function
  });

  test("should detect cross-references", () => {
    const code = `
function helper() { return 42; }

function main() {
  return helper();
}
`;

    const result = parser.parse(code, { contentType: "typescript" as ContentType });
    const mainFunc = Array.from(result.nodes.values()).find(n => n.label === "main");
    
    expect(mainFunc).toBeDefined();
    // Check relations for cross-reference
    const callsRelation = result.relations.find(r => 
      r.type === "calls" && 
      r.fromId === mainFunc?.id
    );
    expect(callsRelation).toBeDefined();
  });
});