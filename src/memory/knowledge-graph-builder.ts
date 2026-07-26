/**
 * 知识图谱构建器 — 从 CodeGraph + 项目分析构建确定性知识图谱
 *
 * 数据源:
 *   1. CodeGraph CLI 输出 (代码结构: 函数、类、接口、调用关系)
 *   2. 文件系统元数据 (文件类型、目录结构、依赖关系)
 *   3. package.json / 配置文件的静态分析
 *   4. Hermes 研究结果 (动态补充)
 *
 * 输出: PostgreSQL kg_entities + kg_relationships 表
 *
 * 用途: 为 Hermes 深度研究提供确定性的代码结构依据，
 *       避免 LLM 对项目结构的"猜测"式推理。
 */
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";
import { isPgAvailable, getPG } from "../db/pg-client.js";
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

/**
 * PostgreSQL 客户端最小契约 (postgres 包的 tagged template 用法)。
 * 完整客户端类型由 `getPG()` 返回，但 PG 在本项目已禁用，故仅保留调用所需的最小接口。
 */
interface PgClient {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  unsafe(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  json(obj: unknown): unknown;
}

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
 * 从 CodeGraph 构建完整知识图谱
 */
export async function buildKnowledgeGraph(
  options: KGBuildOptions,
): Promise<KGBuildResult> {
  const result: KGBuildResult = {
    entitiesCreated: 0,
    entitiesUpdated: 0,
    relationshipsCreated: 0,
    errors: [],
  };

  if (!(await isPgAvailable())) {
    result.errors.push("PostgreSQL not available");
    return result;
  }

  const pg = getPG();
  const { projectPath, projectName, generateEmbeddings = false, batchSize = 100 } = options;

  logger.info("[KGBuild] Starting knowledge graph build", { projectPath, projectName });

  try {
    // Phase 1: 提取项目级实体
    const projectEntity = await upsertEntity(pg, {
      name: projectName,
      type: "project",
      description: `Project: ${projectName} at ${projectPath}`,
      properties: { path: projectPath },
      source: "codegraph",
    });
    result.entitiesCreated++;

    // Phase 2: 提取文件实体
    const files = scanProjectFiles(projectPath);
    logger.info(`[KGBuild] Found ${files.length} files`);

    const fileEntities = new Map<string, number>();
    for (const file of files) {
      try {
        const fileId = await upsertEntity(pg, {
          name: `${projectName}/${file}`,
          type: "file",
          description: `Source file: ${file}`,
          properties: {
            path: file,
            language: detectLanguage(file),
            project: projectName,
          },
          source: "codegraph",
        });
        fileEntities.set(file, fileId);

        // 文件 -> 项目 关系
        await upsertRelationship(pg, fileId, projectEntity, "part_of");
        result.entitiesCreated++;
        result.relationshipsCreated++;
      } catch (err) {
        result.errors.push(`File ${file}: ${(err as Error).message}`);
      }
    }

    // Phase 3: 提取代码节点实体 (函数、类、接口等)
    const nodeKinds = ["function", "class", "interface", "method", "variable", "enum", "struct", "module", "type"];
    const nodeEntities = new Map<string, number>();

    for (const kind of nodeKinds) {
      try {
        const searchResults = await searchSymbols("", { kind, limit: 500, projectPath });
        for (const sr of searchResults) {
          const node = sr.node;
          if (!node) continue;

          try {
            const nodeId = await upsertEntity(pg, {
              name: node.qualifiedName,
              type: `code_${kind}`,
              description: `${kind}: ${node.name} in ${node.filePath}`,
              properties: {
                kind: node.kind,
                name: node.name,
                qualifiedName: node.qualifiedName,
                filePath: node.filePath,
                startLine: node.startLine,
                endLine: node.endLine,
                signature: (node as {signature: string}).signature,
                project: projectName,
              },
              source: "codegraph",
            });

            nodeEntities.set(node.qualifiedName, nodeId);

            // 节点 -> 文件 关系
            const fileId = fileEntities.get(node.filePath);
            if (fileId) {
              await upsertRelationship(pg, nodeId, fileId, "part_of");
              result.relationshipsCreated++;
            }

            result.entitiesCreated++;
          } catch (err) {
            result.errors.push(`Node ${node.qualifiedName}: ${(err as Error).message}`);
          }
        }
      } catch {
        // Kind may not exist in project
      }
    }

    // Phase 4: 提取调用关系
    logger.info("[KGBuild] Extracting call relationships...");
    for (const [qualifiedName, sourceId] of nodeEntities) {
      try {
        // 调用者
        const callers = await getCallers(qualifiedName, { projectPath });
        for (const caller of callers) {
          const targetId = nodeEntities.get(caller.node.qualifiedName || caller.node.name);
          if (targetId && targetId !== sourceId) {
            await upsertRelationship(pg, targetId, sourceId, "calls");
            result.relationshipsCreated++;
          }
        }

        // 被调用者
        const callees = await getCallees(qualifiedName, { projectPath });
        for (const callee of callees) {
          const targetId = nodeEntities.get(callee.node.qualifiedName || callee.node.name);
          if (targetId && targetId !== sourceId) {
            await upsertRelationship(pg, sourceId, targetId, "calls");
            result.relationshipsCreated++;
          }
        }
      } catch {
        // Skip on error
      }
    }

    // Phase 5: 从 package.json 提取依赖关系
    await extractPackageDependencies(pg, projectPath, projectName, projectEntity, result);

    // Phase 6: 生成向量 (可选)
    if (generateEmbeddings) {
      await generateEntityEmbeddings(pg, result);
    }

    logger.info("[KGBuild] Build complete", {
      entitiesCreated: result.entitiesCreated,
      entitiesUpdated: result.entitiesUpdated,
      relationshipsCreated: result.relationshipsCreated,
      errorCount: result.errors.length,
    });
  } catch (err) {
    result.errors.push(`Build failed: ${(err as Error).message}`);
    logger.error("[KGBuild] Build failed", err as Error);
  }

  return result;
}

// ========== 辅助函数 ==========

/**
 * 扫描项目文件 (排除常见非源码目录)
 */
function scanProjectFiles(projectPath: string): string[] {
  const excludeDirs = new Set([
    "node_modules", ".git", ".next", "dist", "build", "out",
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

async function upsertEntity(pg: PgClient, entity: KGEntity): Promise<number> {
  const embeddingStr = entity._embedding
    ? `'${JSON.stringify(entity._embedding)}'::vector`
    : "NULL";

  const [result] = await pg`
    INSERT INTO kg_entities (name, type, description, properties, source, embedding)
    VALUES (
      ${entity.name},
      ${entity.type},
      ${entity.description || null},
      ${pg.json(entity.properties)},
      ${entity.source},
      ${pg.unsafe(embeddingStr)}
    )
    ON CONFLICT (name)
    DO UPDATE SET
      type = EXCLUDED.type,
      description = COALESCE(EXCLUDED.description, kg_entities.description),
      properties = kg_entities.properties || EXCLUDED.properties,
      updated_at = NOW()
    RETURNING id
  `;
  return result!.id as number;
}

async function upsertRelationship(
  pg: PgClient,
  sourceId: number,
  targetId: number,
  relationType: string,
  weight: number = 1.0,
  properties: Record<string, unknown> = {},
): Promise<void> {
  await pg`
    INSERT INTO kg_relationships (source_id, target_id, relation_type, weight, properties)
    VALUES (${sourceId}, ${targetId}, ${relationType}, ${weight}, ${pg.json(properties)})
    ON CONFLICT (source_id, target_id, relation_type)
    DO UPDATE SET
      weight = EXCLUDED.weight,
      properties = kg_relationships.properties || EXCLUDED.properties
  `;
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

async function extractPackageDependencies(
  pg: PgClient,
  projectPath: string,
  projectName: string,
  projectEntityId: number,
  result: KGBuildResult,
): Promise<void> {
  try {
    const { readFileSync, existsSync } = await import("fs");
    const { join } = await import("path");

    const pkgPath = join(projectPath, "package.json");
    if (!existsSync(pkgPath)) return;

    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    // 依赖项
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    for (const [depName, version] of Object.entries(allDeps)) {
      try {
        const depId = await upsertEntity(pg, {
          name: `npm:${depName}`,
          type: "tool",
          description: `NPM package: ${depName}@${version}`,
          properties: { package: depName, version, isDev: depName in (pkg.devDependencies || {}) },
          source: "codegraph",
        });

        await upsertRelationship(pg, projectEntityId, depId, "depends_on");
        result.entitiesCreated++;
        result.relationshipsCreated++;
      } catch {
        // Skip individual dep errors
      }
    }

    logger.info(`[KGBuild] Extracted ${Object.keys(allDeps).length} npm dependencies`);
  } catch (err) {
    result.errors.push(`Package deps: ${(err as Error).message}`);
  }
}

async function generateEntityEmbeddings(pg: PgClient, result: KGBuildResult): Promise<void> {
  try {
    const { proxyFetch } = await import("../utils/proxy-fetch.js");
    const apiKey = readString("SILICONFLOW_API_KEY");
    if (!apiKey) {
      logger.warn("[KGBuild] No SILICONFLOW_API_KEY, skipping embedding generation");
      return;
    }

    // 获取没有向量的实体
    const entities = await pg`
      SELECT id, name, type, description
      FROM kg_entities
      WHERE embedding IS NULL AND description IS NOT NULL
      LIMIT 500
    `;

    logger.info(`[KGBuild] Generating embeddings for ${entities.length} entities...`);

    for (const entity of entities) {
      try {
        const text = `${entity.name}: ${(entity.description as string | undefined) || ""}`;
        if (text.length < 5) continue;

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

        if (res.ok) {
          const data = await res.json();
          const embedding = data.data?.[0]?.embedding;
          if (embedding) {
            await pg`
              UPDATE kg_entities SET embedding = ${pg.unsafe(`'${JSON.stringify(embedding)}'::vector`)}
              WHERE id = ${entity.id}
            `;
          }
        }
      } catch {
        // Skip individual embedding errors
      }
    }
  } catch (err) {
    result.errors.push(`Embedding generation: ${(err as Error).message}`);
  }
}

// ========== 查询接口 (供 Hermes 使用) ==========

/**
 * 为 Hermes 构建研究上下文 — 获取与查询相关的代码图谱信息
 *
 * 这是知识图谱的核心价值: 给 Hermes 提供确定性的代码结构信息，
 * 避免 LLM 对项目架构的"幻觉"式猜测。
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
  if (!(await isPgAvailable())) {
    return { entities: [], relationships: [], codeStructure: { files: 0, functions: 0, classes: 0, dependencies: [] }, summary: "" };
  }

  const pg = getPG();
  const { maxDepth = 2, maxEntities = 50 } = options;

  // 1. 关键词匹配实体
  const keywords = query.split(/\s+/).filter((w) => w.length > 2);
  const keywordConditions = keywords.map((_, i) =>
    `e.name ILIKE $${i + 1} OR e.description ILIKE $${i + 1}`
  ).join(" OR ");

  const params = keywords.map((k) => `%${k}%`);
  params.push(String(maxEntities));

  const entities = keywordConditions
    ? await pg.unsafe(`
        SELECT e.id, e.name, e.type, e.description, e.properties, e.source
        FROM kg_entities e
        WHERE (${keywordConditions})
        ORDER BY e.type, e.name
        LIMIT $${params.length}
      `, params)
    : [];

  // 2. 获取这些实体之间的关系
  if (entities.length > 0) {
    const entityIds = entities.map((e: Record<string, unknown>) => e.id as number);
    const rels = await pg.unsafe(`
      SELECT
        se.name AS source,
        te.name AS target,
        r.relation_type AS type,
        r.weight
      FROM kg_relationships r
      JOIN kg_entities se ON se.id = r.source_id
      JOIN kg_entities te ON te.id = r.target_id
      WHERE r.source_id = ANY($1::bigint[])
        OR r.target_id = ANY($1::bigint[])
      ORDER BY r.weight DESC
      LIMIT 100
    `, [entityIds]);

    // 3. 项目结构统计
    const stats = await pg`
      SELECT
        (SELECT COUNT(*)::int FROM kg_entities WHERE type = 'file') AS files,
        (SELECT COUNT(*)::int FROM kg_entities WHERE type IN ('code_function', 'code_method')) AS functions,
        (SELECT COUNT(*)::int FROM kg_entities WHERE type IN ('code_class', 'code_interface')) AS classes
    `;

    const deps = await pg`
      SELECT e.name
      FROM kg_entities e
      JOIN kg_relationships r ON r.target_id = e.id
      WHERE r.relation_type = 'depends_on' AND e.type = 'tool'
      ORDER BY r.weight DESC
      LIMIT 20
    `;

    return {
      entities: entities as KGEntity[],
      relationships: (rels || []).map((r: Record<string, unknown>) => ({
        source: r.source as string,
        target: r.target as string,
        type: r.type as string,
        weight: r.weight as number,
      })),
      codeStructure: {
        files: (stats[0]?.files as number | undefined) || 0,
        functions: (stats[0]?.functions as number | undefined) || 0,
        classes: (stats[0]?.classes as number | undefined) || 0,
        dependencies: (deps || []).map((d: Record<string, unknown>) => (d.name as string).replace("npm:", "")),
      },
      summary: generateContextSummary(
        entities as Array<{ type: string; name: string }>,
        (rels || []) as Array<{ source: string; type: string; target: string }>,
        (stats[0] || {}) as { files?: number; functions?: number; classes?: number },
      ),
    };
  }

  return {
    entities: [],
    relationships: [],
    codeStructure: { files: 0, functions: 0, classes: 0, dependencies: [] },
    summary: "",
  };
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
 * 增量更新: 仅处理自上次索引以来变更的文件
 */
export async function incrementalUpdate(
  projectPath: string,
  projectName: string,
): Promise<KGBuildResult> {
  const files = scanProjectFiles(projectPath);

  // 检查每个文件的修改时间
  let changedCount = 0;
  if (lastIncrementalUpdate > 0) {
    for (const file of files) {
      const fullPath = join(projectPath, file);
      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs > lastIncrementalUpdate) {
          changedCount++;
        }
      } catch {
        // 文件可能已被删除，算作变更
        changedCount++;
      }
    }

    if (changedCount === 0) {
      logger.info("[KGBuild] No changes detected, skipping rebuild");
      return { entitiesCreated: 0, entitiesUpdated: 0, relationshipsCreated: 0, errors: [] };
    }

    logger.info(`[KGBuild] Incremental update: ${changedCount}/${files.length} files changed`);
  }

  lastIncrementalUpdate = Date.now();

  return buildKnowledgeGraph({
    projectPath,
    projectName,
    generateEmbeddings: true,
  });
}
