/**
 * OpenClaw IDE Plugin - AST Engine
 * 
 * Provides generic AST parsing, knowledge graph construction,
 * and content slicing for documents and code.
 */

// Core types
export type {
  ContentType,
  AstNodeType,
  RelationType,
  SliceStrategy,
  AstNode,
  NodeRelation,
  ParseResult,
  KnowledgeGraph,
  AstParser,
  ParseOptions,
  SliceOptions,
} from "./types.js";

// Core engine
export { AstEngine } from "./ast-engine.js";

// Parsers
export { MarkdownParser } from "./parsers/markdown-parser.js";
export { CodeParser } from "./parsers/code-parser.js";

// Document Bridge
export {
  DocumentBridge,
  documentBridge,
  type DocumentNode,
  type UniversalDocument,
  type ConversionOptions,
  type DocumentConverter,
} from "./document-bridge.js";

// MCP Direct Tool Calling
export {
  DirectToolCaller,
  createDirectToolCaller,
  COMMON_INTENT_PATTERNS,
  type IntentClassification,
  type DirectToolResult,
  type IntentPattern,
} from "./mcp-direct-tools.js";

// IDE Core
export {
  IdePluginCore,
  CodeContextExtractor,
  AnalysisEngine,
  SuggestionProvider,
  idePlugin,
  type IdeAdapter,
  type CodeContext,
  type CodeAnalysis,
  type CodeSuggestion,
  type IdeAction,
  type IdeActionResponse,
} from "./ide-core.js";

// IDE Adapters
export { VSCodeAdapter } from "./adapters/vscode-adapter.js";

// Office Adapters (optional, for document processing)
export {
  BaseOfficeAdapter,
  OfficeUtils,
  WordAdapter,
  ExcelAdapter,
  PowerPointAdapter,
  PlatformAdapter,
} from "./office/platform-adapter.js";
export type {
  OfficeAdapter,
  OfficeDocumentType,
  PlatformCapabilities,
  PlatformInfo,
} from "./office/platform-adapter.js";

// Constants
export const IDE_PLUGIN_VERSION = "0.3.0";
