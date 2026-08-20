/**
 * CodeGraph → PostgreSQL 同步管道 — 已迁移至 SQLite (H-M1-03)
 *
 * 原实现将 CodeGraph 索引同步到 PostgreSQL + pgvector (code_nodes / code_edges)。
 * 现 PostgreSQL 已移除，SQLite (code-index.db + KnowledgeGraphEnhanced) 为唯一持久化。
 * 本文件保留历史接口签名以兼容调用方，实际为 no-op/降级，日志提示迁移。
 *
 * 迁移说明见 docs/ARCHITECTURE.md:58 及 docs/STORAGE-EVALUATION.md
 */
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";
import {
  searchSymbols,
  getCallers,
  getCallees,
  type CodeGraphNode,
} from "../memory/codegraph-index.js";

// ========== 类型定义 ==========

export interface SyncResult {
  filesProcessed: number;
  nodesCreated: number;
  edgesCreated: number;
  embeddingsGenerated: number;
  errors: string[];
}

export interface CodeSearchResult {
  id: number;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  language: string;
  similarity: number;
}

// ========== 项目注册 ==========

/**
 * 注册或更新项目元数据 — PG 已移除，降级为 no-op
 */
export async function registerProject(
  name: string,
  rootPath: string,
  language?: string,
  description?: string,
): Promise<number> {
  logger.warn("[CodeGraphSync] PostgreSQL 已移除 (H-M1-03)，registerProject 降级为 no-op，SQLite 为唯一存储", { name, rootPath });
  return 0;
}

// ========== CodeGraph 同步 ==========

/**
 * 从 CodeGraph CLI 输出同步到 PostgreSQL — 已迁移，no-op
 *
 * @param projectPath 项目根目录
 * @param projectName 项目名称
 * @param options 同步选项
 */
export async function syncCodeGraphToPG(
  projectPath: string,
  projectName: string,
  options: {
    generateEmbeddings?: boolean;
    embeddingModel?: string;
    batchSize?: number;
  } = {},
): Promise<SyncResult> {
  logger.warn("[CodeGraphSync] PostgreSQL 已移除 (H-M1-03)，syncCodeGraphToPG 已迁移至 SQLite 本地索引，跳过 PG 同步", { projectPath, projectName });
  return {
    filesProcessed: 0,
    nodesCreated: 0,
    edgesCreated: 0,
    embeddingsGenerated: 0,
    errors: ["PostgreSQL 已移除，已迁移至 SQLite (H-M1-03)"],
  };
}

/**
 * 收集 CodeGraph 中的所有节点
 */
async function collectAllNodes(projectPath: string): Promise<CodeGraphNode[]> {
  const allNodes: CodeGraphNode[] = [];
  const kinds = ["function", "class", "interface", "method", "variable", "enum", "struct", "module", "type"];

  for (const kind of kinds) {
    try {
      const results = await searchSymbols("", { kind, limit: 1000, projectPath });
      for (const r of results) {
        if (r.node) allNodes.push(r.node);
      }
    } catch {
      // Kind might not exist in this project
    }
  }

  // 去重
  const seen = new Set<string>();
  return allNodes.filter((n) => {
    const key = `${n.filePath}:${n.startLine}:${n.qualifiedName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 按文件路径分组
 */
function groupByFile(nodes: CodeGraphNode[]): Record<string, CodeGraphNode[]> {
  const groups: Record<string, CodeGraphNode[]> = {};
  for (const node of nodes) {
    if (!groups[node.filePath]) groups[node.filePath] = [];
    groups[node.filePath].push(node);
  }
  return groups;
}

/**
 * 生成代码节点的语义向量
 */
async function generateNodeEmbedding(node: CodeGraphNode): Promise<number[] | null> {
  try {
    const { proxyFetch } = await import("../utils/proxy-fetch.js");

    // 构建文本: 限定名 + 签名 + 文档
    const text = [
      node.qualifiedName,
      node.signature || "",
      (node as CodeGraphNode & { docstring?: string }).docstring || "",
      `${node.kind} in ${node.filePath}`,
    ].filter(Boolean).join("\n");

    if (text.length < 10) return null;

    // 使用 SiliconFlow embedding API (免费)
    const apiKey = readString("SILICONFLOW_API_KEY");
    if (!apiKey) return null;

    const res = await proxyFetch("https://api.siliconflow.cn/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "BAAI/bge-m3",
        input: text.slice(0, 2000),
      }),
      timeout: 10000,
    });

    if (!res.ok) return null;

    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
}

// ========== 查询接口 ==========

/**
 * 语义代码搜索 (向量 + 文本混合) — PG 已移除，返回空
 */
export async function searchCode(
  query: string,
  options: {
    kind?: string;
    project?: string;
    limit?: number;
    useVector?: boolean;
  } = {},
): Promise<CodeSearchResult[]> {
  logger.warn("[CodeGraphSync] searchCode PG 已移除，返回空 (H-M1-03)，请使用本地 code-index / KnowledgeGraphEnhanced");
  return [];
}

/**
 * 获取代码实体的关系链 (调用图) — PG 已移除，返回空
 */
export async function getCodeGraph(
  entityName: string,
  depth: number = 2,
): Promise<{
  entity: Record<string, unknown> | null;
  callers: Array<{ name: string; qualified_name: string; kind: string; depth: number }>;
  callees: Array<{ name: string; qualified_name: string; kind: string; depth: number }>;
  impactRadius: Array<{ name: string; qualified_name: string; kind: string; depth: number }>;
}> {
  logger.warn("[CodeGraphSync] getCodeGraph PG 已移除，返回空 (H-M1-03)");
  return { entity: null, callers: [], callees: [], impactRadius: [] };
}

/**
 * 获取项目统计信息 — PG 已移除，返回零
 */
export async function getProjectStats(projectName?: string): Promise<{
  totalProjects: number;
  totalFiles: number;
  totalNodes: number;
  totalEdges: number;
  nodesByKind: Record<string, number>;
  languages: Record<string, number>;
}> {
  logger.warn("[CodeGraphSync] getProjectStats PG 已移除，返回零 (H-M1-03)");
  return {
    totalProjects: 0, totalFiles: 0, totalNodes: 0, totalEdges: 0,
    nodesByKind: {}, languages: {},
  };
}
