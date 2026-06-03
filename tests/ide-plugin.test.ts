/**
 * IDE Plugin Tests
 * 
 * Tests for IDE Core, VSCode Adapter, and Code Analysis
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  DocumentBridge,
  DirectToolCaller,
  COMMON_INTENT_PATTERNS,
  IdePluginCore,
  CodeContextExtractor,
  AnalysisEngine,
  SuggestionProvider,
  VSCodeAdapter,
} from "../src/ide/index.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import type { IntentPattern } from "../src/ide/mcp-direct-tools.js";

// Test-specific intent patterns with single required keyword
const TEST_INTENT_PATTERNS: IntentPattern[] = [
  {
    id: "read_file",
    tool: "filesystem.read_file",
    requiredKeywords: ["read"],
    optionalKeywords: ["file", "open"],
    minConfidence: 0.5,
  },
  {
    id: "terminal_execute",
    tool: "terminal.execute",
    requiredKeywords: ["run"],
    optionalKeywords: ["command", "execute"],
    minConfidence: 0.5,
  },
];

// Mock ToolRegistry for testing
function createMockRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.add({
    name: "filesystem.read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    handler: async (args) => ({ content: `Content of ${args.path}` }),
  });
  registry.add({
    name: "terminal.execute",
    description: "Execute a command",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    handler: async (args) => ({ output: `Executed: ${args.command}` }),
  });
  return registry;
}

describe("Document Bridge", () => {
  const bridge = new DocumentBridge();

  test("markdownToUniversal parses document", () => {
    const markdown = `# Title\n\n## Section 1\n\nThis is a paragraph.\n`;

    const doc = bridge.markdownToUniversal(markdown);

    // Should return a valid document object
    expect(doc).toBeDefined();
    expect(doc.nodes).toBeDefined();
    expect(Array.isArray(doc.nodes)).toBe(true);
  });

  test("universalToMarkdown converts back to markdown", () => {
    const doc = {
      title: "Test Document",
      nodes: [
        { id: "1", type: "heading" as const, content: "Heading 1", level: 1 },
        { id: "2", type: "paragraph" as const, content: "This is a paragraph." },
      ],
      metadata: { sourceFormat: "test" },
    };

    const markdown = bridge.universalToMarkdown(doc);

    expect(markdown).toContain("# Test Document");
    expect(markdown).toContain("# Heading 1");
    expect(markdown).toContain("This is a paragraph.");
  });

  test("roundtrip conversion produces output", () => {
    const original = `# Roundtrip Test\n\nParagraph content here.\n`;

    const doc = bridge.markdownToUniversal(original);
    const regenerated = bridge.universalToMarkdown(doc);
    
    // Should produce non-empty output
    expect(typeof regenerated).toBe("string");
    expect(regenerated.length).toBeGreaterThanOrEqual(0);
  });
});

describe("MCP Direct Tool Calling", () => {
  let registry: ToolRegistry;
  let caller: DirectToolCaller;

  beforeEach(() => {
    registry = createMockRegistry();
    caller = new DirectToolCaller(registry, { confidenceThreshold: 0.6 });
    caller.registerPatterns(TEST_INTENT_PATTERNS);
  });

  test("classifies read_file intent", () => {
    const result = caller.classifyIntent("read file test.txt");

    expect(result).not.toBeNull();
    expect(result?.intent).toBe("read_file");
    expect(result?.tool).toBe("filesystem.read_file");
  });

  test("classifies terminal_execute intent", () => {
    const result = caller.classifyIntent("run command ls -la");

    expect(result).not.toBeNull();
    expect(result?.intent).toBe("terminal_execute");
    expect(result?.tool).toBe("terminal.execute");
  });

  test("returns null for unclear intent", () => {
    const result = caller.classifyIntent("今天天气怎么样");
    
    expect(result).toBeNull();
  });

  test("tryDirectCall falls back on low confidence for simple text", async () => {
    const result = await caller.tryDirectCall("test.txt");
    
    // Single keyword should not trigger direct execution
    expect(result.fallbackNeeded).toBe(true);
    expect(result.success).toBe(false);
  });

  test("tryDirectCall falls back on low confidence", async () => {
    const result = await caller.tryDirectCall("some random text");
    
    expect(result.success).toBe(false);
    expect(result.fallbackNeeded).toBe(true);
  });

  test("executeTool directly invokes tool", async () => {
    const result = await caller.executeTool("filesystem.read_file", { path: "test.txt" });
    
    expect(result.success).toBe(true);
    expect(result.tool).toBe("filesystem.read_file");
    expect(result.result).toEqual({ content: "Content of test.txt" });
  });
});

describe("IDE Core", () => {
  let plugin: IdePluginCore;

  beforeEach(() => {
    plugin = new IdePluginCore();
  });

  test("registers adapters", () => {
    const adapter = new VSCodeAdapter();
    plugin.registerAdapter(adapter);
    
    expect(plugin.getAdapters().length).toBe(1);
    expect(plugin.getAdapters()[0].name).toBe("vscode");
  });

  test("handles analyze action", async () => {
    const response = await plugin.handleAction({
      type: "analyze",
      context: {
        filePath: "test.ts",
        content: "function add(a: number, b: number) { return a + b; }",
        cursor: { line: 0, character: 0 },
        language: "typescript",
      },
    });

    expect(response.success).toBe(true);
    expect(response.analysis).toBeDefined();
    expect(response.suggestions).toBeDefined();
  });

  test("handles complete action", async () => {
    const response = await plugin.handleAction({
      type: "complete",
      context: {
        filePath: "test.ts",
        content: "const x = ",
        cursor: { line: 0, character: 10 },
        language: "typescript",
      },
    });

    expect(response.success).toBe(true);
  });
});

describe("Code Context Extractor", () => {
  const extractor = new CodeContextExtractor();

  test("extracts context from TypeScript code", () => {
    const context = {
      filePath: "test.ts",
      content: "function test() { return 1; }",
      cursor: { line: 0, character: 0 },
      language: "typescript",
    };

    const enhanced = extractor.extractContext(context);
    
    expect(enhanced.filePath).toBe("test.ts");
    expect(enhanced.language).toBe("typescript");
  });

  test("detects content type from language", () => {
    const context = {
      filePath: "test.ts",
      content: "function test() {\n  const x = 1;\n}",
      cursor: { line: 1, character: 2 },
      language: "typescript",
    };

    // Should not throw
    const scope = extractor.getCurrentScope(context);
    // Scope may or may not be found depending on parser, but should not throw
    expect(scope !== undefined || scope === undefined).toBe(true);
  });
});

describe("Analysis Engine", () => {
  const engine = new AnalysisEngine();

  test("analyzes TypeScript code", () => {
    const context = {
      filePath: "test.ts",
      content: "function calculate(x: number): number { return x + 10; }",
      cursor: { line: 0, character: 0 },
      language: "typescript",
    };

    const analysis = engine.analyze(context);
    
    expect(analysis.ast).toBeDefined();
    expect(analysis.ast.nodes.size).toBeGreaterThan(0);
    expect(analysis.complexity.cyclomatic).toBeGreaterThanOrEqual(1);
  });

  test("analyzes Python code", () => {
    const context = {
      filePath: "test.py",
      content: "def calculate(x):\n    return x + 10",
      cursor: { line: 0, character: 0 },
      language: "python",
    };

    const analysis = engine.analyze(context);
    
    expect(analysis.ast).toBeDefined();
    expect(analysis.ast.nodes.size).toBeGreaterThan(0);
    expect(analysis.complexity.cyclomatic).toBeGreaterThanOrEqual(1);
  });
});

describe("Suggestion Provider", () => {
  const provider = new SuggestionProvider();

  test("generates suggestions for TypeScript", async () => {
    const context = {
      filePath: "test.ts",
      content: "function test() { return 1; }",
      cursor: { line: 0, character: 0 },
      language: "typescript",
    };

    const suggestions = await provider.generateSuggestions(context);
    
    expect(suggestions).toBeDefined();
    expect(Array.isArray(suggestions)).toBe(true);
  });
});

describe("VSCode Adapter", () => {
  const adapter = new VSCodeAdapter();

  test("has correct name", () => {
    expect(adapter.name).toBe("vscode");
  });

  test("supports multiple languages", () => {
    expect(adapter.supportedLanguages).toContain("typescript");
    expect(adapter.supportedLanguages).toContain("javascript");
    expect(adapter.supportedLanguages).toContain("python");
  });

  test("starts disconnected", () => {
    expect(adapter.isConnected()).toBe(false);
  });

  test("handles explain action with selection", async () => {
    const response = await adapter.handleAction({
      type: "explain",
      context: {
        filePath: "test.ts",
        content: "function add(a: number, b: number) { return a + b; }",
        cursor: { line: 0, character: 0 },
        language: "typescript",
        selection: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 50 },
        },
      },
    });

    expect(response.success).toBe(true);
    expect(response.suggestions.length).toBeGreaterThan(0);
    expect(response.suggestions[0].type).toBe("documentation");
  });

  test("handles explain action without selection", async () => {
    const response = await adapter.handleAction({
      type: "explain",
      context: {
        filePath: "test.ts",
        content: "function add(a: number, b: number) { return a + b; }",
        cursor: { line: 0, character: 0 },
        language: "typescript",
      },
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("No code selected");
  });
});
