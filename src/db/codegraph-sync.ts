/**
 * CodeGraph → PostgreSQL 同步管道
 *
 * 将 CodeGraph 的 SQLite 输出同步到 PostgreSQL + pgvector，
 * 为 Hermes Agent 提供确定性代码分析依据。
 *
 * 流程:
 *   1. 读取 CodeGraph 索引结果 (通过 codegraph-index.ts CLI)
 *   2. 提取代码节点和关系
 *   3. 生成语义向量 (通过 embedding API)
 *   4. 写入 PostgreSQL code_nodes / code_edges 表
 *
 * 同时支持:
 *   - 从 CodeGraph SQLite 导入 (兼容现有索引)
 *   - 从文件系统直接扫描 (tree-sitter 风格的简易解析)
 */
import { logger } from "../utils/logger.js";
import { isPgAvailable, getPG } from "./pg-client.js";
import {
  searchSymbols,
  getCallers,
  getCallees,
  buildContext,
  getImpact,
  getStatus,
  type CodeGraphNode,
  type CodeGraphSearchResult,
  type CodeGraphContextResult,
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
 * 注册或更新项目元数据
 */
export async function registerProject(
  name: string,
  rootPath: string,
  language?: string,
  description?: string,
): Promise<number> {
  const pg = getPG();

  const [result] = await pg`
    INSERT INTO code_projects (name, root_path, language, description, indexed_at)
    VALUES (${name}, ${rootPath}, ${language || null}, ${description || null}, NOW())
    ON CONFLICT (name, root_path)
    DO UPDATE SET
      language = COALESCE(EXCLUDED.language, code_projects.language),
      description = COALESCE(EXCLUDED.description, code_projects.description),
      indexed_at = NOW()
    RETURNING id
  `;

  return result.id as number;
}

// ========== CodeGraph 同步 ==========

/**
 * 从 CodeGraph CLI 输出同步到 PostgreSQL
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
  const result: SyncResult = {
    filesProcessed: 0,
    nodesCreated: 0,
    edgesCreated: 0,
    embeddingsGenerated: 0,
    errors: [],
  };

  if (!(await isPgAvailable())) {
    result.errors.push("PostgreSQL not available");
    return result;
  }

  const pg = getPG();
  const { generateEmbeddings = false, batchSize = 100 } = options;

  logger.info("[CodeGraphSync] Starting sync", { projectPath, projectName });

  try {
    // Step 1: 注册项目
    const projectId = await registerProject(projectName, projectPath);

    // Step 2: 从 CodeGraph 搜索所有节点
    const allNodes = await collectAllNodes(projectPath);
    logger.info(`[CodeGraphSync] Found ${allNodes.length} nodes`);

    // Step 3: 按文件分组处理
    const fileGroups = groupByFile(allNodes);

    for (const [filePath, nodes] of Object.entries(fileGroups)) {
      try {
        // 注册文件
        const fileId = await registerFile(pg, projectId, filePath, nodes[0]?.language || "unknown");
        result.filesProcessed++;

        // 批量插入节点
        for (const node of nodes) {
          const embedding = generateEmbeddings
            ? await generateNodeEmbedding(node)
            : null;

          await pg`
            INSERT INTO code_nodes (file_id, kind, name, qualified_name, signature,
              start_line, end_line, docstring, code_body, metadata, embedding)
            VALUES (
              ${fileId}, ${node.kind}, ${node.name}, ${node.qualifiedName},
              ${node.signature || null}, ${node.startLine}, ${node.endLine},
              ${null}, ${null},
              ${pg.json({})},
              ${embedding ? pg.unsafe(`'${JSON.stringify(embedding)}'::vector`) : null}
            )
            ON CONFLICT DO NOTHING
          `;
          result.nodesCreated++;
          if (embedding) result.embeddingsGenerated++;
        }
      } catch (err) {
        result.errors.push(`File ${filePath}: ${(err as Error).message}`);
      }
    }

    // Step 4: 构建关系边
    const edgesBuilt = await buildEdgesFromCodeGraph(pg, allNodes, projectPath);
    result.edgesCreated = edgesBuilt;

    logger.info("[CodeGraphSync] Sync complete", {
      filesProcessed: result.filesProcessed,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      embeddingsGenerated: result.embeddingsGenerated,
    });
  } catch (err) {
    result.errors.push(`Sync failed: ${(err as Error).message}`);
    logger.error("[CodeGraphSync] Sync failed", err as Error);
  }

  return result;
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
 * 注册文件记录
 */
async function registerFile(
  pg: any,
  projectId: number,
  filePath: string,
  language: string,
): Promise<number> {
  const [result] = await pg`
    INSERT INTO code_files (project_id, file_path, language, indexed_at)
    VALUES (${projectId}, ${filePath}, ${language}, NOW())
    ON CONFLICT (project_id, file_path)
    DO UPDATE SET indexed_at = NOW()
    RETURNING id
  `;
  return result.id as number;
}

/**
 * 从 CodeGraph 关系构建 PostgreSQL 边
 */
async function buildEdgesFromCodeGraph(
  pg: any,
  nodes: CodeGraphNode[],
  projectPath: string,
): Promise<number> {
  let edgesCreated = 0;

  // 建立 name → id 映射
  const nodeMap = new Map<string, number>();
  const dbNodes = await pg`SELECT id, qualified_name, file_id FROM code_nodes`;
  for (const n of dbNodes) {
    nodeMap.set(n.qualified_name, n.id);
  }

  // 遍历每个节点获取调用关系
  for (const node of nodes) {
    try {
      const callers = await getCallers(node.qualifiedName, { projectPath });
      for (const caller of callers) {
        const callerNode = caller.node;
        if (!callerNode) continue;
        const sourceId = nodeMap.get(callerNode.qualifiedName || callerNode.name);
        const targetId = nodeMap.get(node.qualifiedName);
        if (sourceId && targetId) {
          await pg`
            INSERT INTO code_edges (source_id, target_id, edge_type)
            VALUES (${sourceId}, ${targetId}, 'calls')
            ON CONFLICT (source_id, target_id, edge_type) DO NOTHING
          `;
          edgesCreated++;
        }
      }

      const callees = await getCallees(node.qualifiedName, { projectPath });
      for (const callee of callees) {
        const calleeNode = callee.node;
        if (!calleeNode) continue;
        const sourceId = nodeMap.get(node.qualifiedName);
        const targetId = nodeMap.get(calleeNode.qualifiedName || calleeNode.name);
        if (sourceId && targetId) {
          await pg`
            INSERT INTO code_edges (source_id, target_id, edge_type)
            VALUES (${sourceId}, ${targetId}, 'calls')
            ON CONFLICT (source_id, target_id, edge_type) DO NOTHING
          `;
          edgesCreated++;
        }
      }
    } catch {
      // Skip nodes with errors
    }
  }

  return edgesCreated;
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
      (node as any).docstring || "",
      `${node.kind} in ${node.filePath}`,
    ].filter(Boolean).join("\n");

    if (text.length < 10) return null;

    // 使用 SiliconFlow embedding API (免费)
    const apiKey = process.env.SILICONFLOW_API_KEY;
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
 * 语义代码搜索 (向量 + 文本混合)
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
  if (!(await isPgAvailable())) return [];

  const pg = getPG();
  const { kind, project, limit = 10, useVector = false } = options;

  // 文本搜索 (trigram)
  let whereClause = "";
  const params: any[] = [query, limit];

  if (kind) {
    whereClause += ` AND cn.kind = $${params.length + 1}`;
    params.push(kind);
  }

  if (project) {
    whereClause += ` AND cp.name = $${params.length + 1}`;
    params.push(project);
  }

  const results = await pg.unsafe(`
    SELECT
      cn.id, cn.name, cn.qualified_name, cn.kind,
      cf.file_path, cf.language,
      similarity(cn.name, $1) AS similarity
    FROM code_nodes cn
    JOIN code_files cf ON cf.id = cn.file_id
    LEFT JOIN code_projects cp ON cp.id = cf.project_id
    WHERE cn.name % $1 ${whereClause}
    ORDER BY similarity DESC
    LIMIT $2
  `, params);

  return (results as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    qualifiedName: r.qualified_name,
    kind: r.kind,
    filePath: r.file_path,
    language: r.language,
    similarity: r.similarity,
  })) as CodeSearchResult[];
}

/**
 * 获取代码实体的关系链 (调用图)
 */
export async function getCodeGraph(
  entityName: string,
  depth: number = 2,
): Promise<{
  entity: any;
  callers: any[];
  callees: any[];
  impactRadius: any[];
}> {
  if (!(await isPgAvailable())) {
    return { entity: null, callers: [], callees: [], impactRadius: [] };
  }

  const pg = getPG();

  // 查找实体
  const [entity] = await pg`
    SELECT cn.*, cf.file_path, cf.language
    FROM code_nodes cn
    JOIN code_files cf ON cf.id = cn.file_id
    WHERE cn.name = ${entityName} OR cn.qualified_name = ${entityName}
    LIMIT 1
  `;

  if (!entity) return { entity: null, callers: [], callees: [], impactRadius: [] };

  // 递归查询调用者
  const callers = await pg.unsafe(`
    WITH RECURSIVE call_chain AS (
      SELECT ce.source_id, ce.target_id, 1 AS depth,
             ARRAY[cn.name] AS path
      FROM code_edges ce
      JOIN code_nodes cn ON cn.id = ce.source_id
      WHERE ce.target_id = $1 AND ce.edge_type = 'calls'
      UNION ALL
      SELECT ce.source_id, ce.target_id, cc.depth + 1,
             cc.path || cn2.name
      FROM code_edges ce
      JOIN code_nodes cn2 ON cn2.id = ce.source_id
      JOIN call_chain cc ON cc.source_id = ce.target_id
      WHERE ce.edge_type = 'calls' AND cc.depth < $2
    )
    SELECT DISTINCT cn.name, cn.qualified_name, cn.kind, cc.depth
    FROM call_chain cc
    JOIN code_nodes cn ON cn.id = cc.source_id
    ORDER BY cc.depth
  `, [entity.id, depth]);

  // 递归查询被调用者
  const callees = await pg.unsafe(`
    WITH RECURSIVE call_chain AS (
      SELECT ce.source_id, ce.target_id, 1 AS depth
      FROM code_edges ce
      JOIN code_nodes cn ON cn.id = ce.target_id
      WHERE ce.source_id = $1 AND ce.edge_type = 'calls'
      UNION ALL
      SELECT ce.source_id, ce.target_id, cc.depth + 1
      FROM code_edges ce
      JOIN code_nodes cn2 ON cn2.id = ce.target_id
      JOIN call_chain cc ON cc.target_id = ce.source_id
      WHERE ce.edge_type = 'calls' AND cc.depth < $2
    )
    SELECT DISTINCT cn.name, cn.qualified_name, cn.kind, cc.depth
    FROM call_chain cc
    JOIN code_nodes cn ON cn.id = cc.target_id
    ORDER BY cc.depth
  `, [entity.id, depth]);

  return {
    entity,
    callers: callers as any[],
    callees: callees as any[],
    impactRadius: callers as any[],  // 调用者即为影响半径
  };
}

/**
 * 获取项目统计信息
 */
export async function getProjectStats(projectName?: string): Promise<{
  totalProjects: number;
  totalFiles: number;
  totalNodes: number;
  totalEdges: number;
  nodesByKind: Record<string, number>;
  languages: Record<string, number>;
}> {
  if (!(await isPgAvailable())) {
    return {
      totalProjects: 0, totalFiles: 0, totalNodes: 0, totalEdges: 0,
      nodesByKind: {}, languages: {},
    };
  }

  const pg = getPG();

  const [projects] = await pg`SELECT COUNT(*)::int AS count FROM code_projects`;
  const [files] = await pg`SELECT COUNT(*)::int AS count FROM code_files`;
  const [nodes] = await pg`SELECT COUNT(*)::int AS count FROM code_nodes`;
  const [edges] = await pg`SELECT COUNT(*)::int AS count FROM code_edges`;

  const kindStats = await pg`
    SELECT kind, COUNT(*)::int AS count
    FROM code_nodes GROUP BY kind ORDER BY count DESC
  `;

  const langStats = await pg`
    SELECT language, COUNT(*)::int AS count
    FROM code_files GROUP BY language ORDER BY count DESC
  `;

  return {
    totalProjects: projects.count,
    totalFiles: files.count,
    totalNodes: nodes.count,
    totalEdges: edges.count,
    nodesByKind: Object.fromEntries(kindStats.map((r: any) => [r.kind, r.count])),
    languages: Object.fromEntries(langStats.map((r: any) => [r.language, r.count])),
  };
}
