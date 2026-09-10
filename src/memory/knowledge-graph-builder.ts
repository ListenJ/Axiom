/**
 * 知识图谱构建器 — 从 CodeGraph + 项目分析构建确定性知识图谱 (已迁移至 SQLite H-M1-03)
 *
 * 原输出: PostgreSQL kg_entities + kg_relationships 表
 * 现输出: SQLite KnowledgeGraphEnhanced (kg/enhanced.ts) + 本地 code-index
 * PG 已移除，保留接口签名，实际为 SQLite 降级/no-op，日志提示迁移。
 */
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";
import {
  searchSymbols,
  getCallers,
  getCallees,
  type CodeGraphNode,
  type CodeGraphSearchResult,
} from "../memory/codegraph-index.js";
import { readdirSync, statSync } from "fs";
import { join, extname, relative } from "path";

// ========== 类型定义 ==========
// PG 已移除 (H-M1-03): 原 PgClient / getPG / isPgAvailable 已迁移至 SQLite

export interface KGEntity {
  id?: number;
  name: string;
  type: string;       // person, org, concept, tool, file, api, pattern, project
  description?: string;
  properties: Record<string, unknown>;
  source: string;     // codegraph, hermes, manual, web_search
  /**
   * 向量嵌入（pgvector 格式字符串），由构建流程在写入前注入。
   * 声明在此接口上以避免 `as unknown as` 双重断言；未启用 PG 时为 undefined。
   */
  _embedding?: string;
}

export interface KGRelationship {
  sourceName: string;
  targetName: string;
  relationType: string;  // uses, depends_on, part_of, mentions, implements, extends
  weight?: number;
  properties?: Record<string, unknown>;
}

export interface KGBuildResult {
  entitiesCreated: number;
  entitiesUpdated: number;
  relationshipsCreated: number;
  errors: string[];
}

export interface KGBuildOptions {
  /** 项目路径 */
  projectPath: string;
  /** 项目名称 */
  projectName: string;
  /** 是否生成语义向量 (需要 embedding API) */
  generateEmbeddings?: boolean;
  /** 向量维度 (默认 1536) */
  embeddingDimensions?: number;
  /** 是否包含代码体 (可能较大) */
  includeCodeBody?: boolean;
  /** 批量大小 */
  batchSize?: number;
}

// ========== 知识图谱构建 ==========

/**
 * 从 CodeGraph 构建完整知识图谱 — PG 已移除，降级为 SQLite/no-op (H-M1-03)
 */
export async function buildKnowledgeGraph(
  options: KGBuildOptions,
): Promise<KGBuildResult> {
  logger.warn("[KGBuild] PostgreSQL 已移除 (H-M1-03)，buildKnowledgeGraph 已迁移至 SQLite KnowledgeGraphEnhanced，当前降级为 no-op", { projectPath: options.projectPath });
  return {
    entitiesCreated: 0,
    entitiesUpdated: 0,
    relationshipsCreated: 0,
    errors: ["PostgreSQL 已移除，已迁移至 SQLite (H-M1-03) — 请使用 kg/enhanced.ts / dip_ingest_document"],
  };
}

// ========== 辅助函数 ==========

/**
 * 扫描项目文件 (排除常见非源码目录)
 */
function scanProjectFiles(projectPath: string): string[] {
  const excludeDirs = new Set([
    "node_modules", ".git", ".next", "dist", "build", "out", ".tmp", ".tmp-build", ".tmp-e2e",
    ".venv", "__pycache__", ".cache", "target", ".codegraph",
  ]);
  const includeExts = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
    ".c", ".cpp", ".h", ".cs", ".rb", ".php", ".swift", ".kt",
    ".json", ".yaml", ".yml", ".toml", ".md",
  ]);

  const files: string[] = [];

  function walk(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (excludeDirs.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (includeExts.has(ext) || entry.name === "package.json" || entry.name === "Dockerfile") {
            files.push(relative(projectPath, fullPath));
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  walk(projectPath);
  return files;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
    c: "c", cpp: "cpp", cs: "csharp", rb: "ruby", php: "php",
    swift: "swift", dart: "dart", lua: "lua", sh: "shell",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", html: "html", css: "css", sql: "sql",
  };
  return langMap[ext] || "unknown";
}

// 以下 PG 专属辅助已移除 (upsertEntity/upsertRelationship/extractPackageDependencies/generateEntityEmbeddings)
// 如需 SQLite 实现请使用 src/kg/enhanced.ts 的 KnowledgeGraphEnhanced

// ========== 查询接口 (供 Hermes 使用) ==========

/**
 * 为 Hermes 构建研究上下文 — PG 已移除，返回空 (H-M1-03)
 *
 * 原实现从 PostgreSQL 检索实体/关系，现 SQLite KnowledgeGraphEnhanced 为唯一来源。
 * 调用方应迁移至 kal/query 或 kg/enhanced.ts 的 searchNodes/subgraph。
 */
export async function buildResearchContext(
  query: string,
  options: {
    projectName?: string;
    maxDepth?: number;
    maxEntities?: number;
  } = {},
): Promise<{
  entities: KGEntity[];
  relationships: Array<{
    source: string;
    target: string;
    type: string;
    weight: number;
  }>;
  codeStructure: {
    files: number;
    functions: number;
    classes: number;
    dependencies: string[];
  };
  summary: string;
}> {
  logger.warn("[KGBuild] buildResearchContext PG 已移除，返回空 (H-M1-03)，请使用 KnowledgeGraphEnhanced / KAL");
  return { entities: [], relationships: [], codeStructure: { files: 0, functions: 0, classes: 0, dependencies: [] }, summary: "" };
}

/**
 * 生成上下文摘要文本 (供 Hermes prompt 注入)
 */
function generateContextSummary(
  entities: Array<{ type: string; name: string }>,
  relationships: Array<{ source: string; type: string; target: string }>,
  stats: { files?: number; functions?: number; classes?: number },
): string {
  if (entities.length === 0) return "No matching code entities found.";

  const parts: string[] = [];

  // 项目规模
  if (stats.files || stats.functions || stats.classes) {
    parts.push(
      `Project structure: ${stats.files || 0} files, ${stats.functions || 0} functions/methods, ${stats.classes || 0} classes/interfaces.`
    );
  }

  // 匹配的实体
  const grouped: Record<string, string[]> = {};
  for (const e of entities) {
    if (!grouped[e.type]) grouped[e.type] = [];
    grouped[e.type].push(e.name);
  }
  for (const [type, names] of Object.entries(grouped)) {
    parts.push(`${type} entities: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` (+${names.length - 10} more)` : ""}`);
  }

  // 关键关系
  if (relationships.length > 0) {
    const relSummary = relationships.slice(0, 10).map((r) =>
      `${r.source} --[${r.type}]--> ${r.target}`
    ).join("; ");
    parts.push(`Key relationships: ${relSummary}`);
  }

  return parts.join("\n");
}

// 模块级变量：记录上次增量更新的时间戳
let lastIncrementalUpdate = 0;

/**
 * 增量更新: 仅处理自上次索引以来变更的文件 — PG 已移除，no-op
 */
export async function incrementalUpdate(
  projectPath: string,
  projectName: string,
): Promise<KGBuildResult> {
  logger.warn("[KGBuild] incrementalUpdate PG 已移除 (H-M1-03)，降级为 no-op");
  lastIncrementalUpdate = Date.now();
  return { entitiesCreated: 0, entitiesUpdated: 0, relationshipsCreated: 0, errors: ["PostgreSQL 已移除 (H-M1-03)"] };
}
