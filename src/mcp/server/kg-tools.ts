import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { ToolRegistry } from "../tool-registry.js";
import type { VaultManager } from "../../memory/vault-manager.js";
import { KnowledgeGraphEnhanced, type KGNodeType, type KGEdgeType } from "../../kg/enhanced.js";
import { KnowledgeAccessLayer } from "../../kal/knowledge-access-layer.js";
import { createNodeId } from "../../kal/node-id.js";
import { parseMarkdownAST, extractAllEntities } from "../../crawl/processor/markdown-ast.js";
import { KGWriter } from "../../crawl/processor/kg-writer.js";

let kal: KnowledgeAccessLayer | null = null;
let kgEnhancedSingleton: KnowledgeGraphEnhanced | null = null;

function getKAL(db: Database): KnowledgeAccessLayer {
  if (!kal) {
    kal = new KnowledgeAccessLayer(db);
  }
  return kal;
}

function getKGEnhancedInstance(db: Database): KnowledgeGraphEnhanced {
  if (!kgEnhancedSingleton) {
    kgEnhancedSingleton = new KnowledgeGraphEnhanced(db);
  }
  return kgEnhancedSingleton;
}

export function registerKgTools(registry: ToolRegistry, db: Database): void {
  // ===== 统一知识访问层 (KAL) 工具 =====

  registry.add({
    name: "kal_query",
    description: "统一知识查询 (跨 Vault/KG/DRE 一次查询，自动 fan-out + 结果合并)",
    inputSchema: {
      query: z.string().describe("搜索关键词或自然语言查询"),
      store: z.enum(["vault", "kg", "dre"]).optional().describe("指定存储 (不指定则查询全部)"),
      typeFilter: z.array(z.string()).optional().describe("类型过滤 (如 function, fact, rule)"),
      tagFilter: z.array(z.string()).optional().describe("标签过滤"),
      limit: z.number().optional().default(20).describe("最大结果数"),
    },
    handler: async (args) => {
      const k = getKAL(db);
      const result = await k.query({
        query: args.query as string,
        targetStore: args.store as "vault" | "kg" | "dre" | undefined,
        typeFilter: args.typeFilter as string[],
        tagFilter: args.tagFilter as string[],
        limit: args.limit as number,
      });
      return result;
    },
  });

  registry.add({
    name: "kal_references",
    description: "查找知识条目的跨存储引用 (通过 node_id)",
    inputSchema: {
      nodeId: z.string().describe("全局 node_id (如 vault:note:xxx, kg:function:yyy)"),
    },
    handler: async (args) => {
      const k = getKAL(db);
      return k.getReferences(args.nodeId as string);
    },
  });

  // ===== DIP 文档处理管道工具 =====

  registry.add({
    name: "dip_ingest_document",
    description: "文档→KG管道: 解析 Markdown 为 AST → 提取实体 → 写入知识图谱 (零LLM)",
    inputSchema: {
      markdown: z.string().describe("Markdown 文档内容"),
      title: z.string().describe("文档标题"),
      sourceUrl: z.string().optional().describe("来源 URL"),
    },
    handler: async (args) => {
      const markdown = args.markdown as string;
      const title = args.title as string;
      const sourceUrl = args.sourceUrl as string;

      const ast = parseMarkdownAST(markdown);

      const entities = extractAllEntities(ast);
      const functions = entities.filter((e) => e.type === "function");
      const classes = entities.filter((e) => e.type === "class");
      const imports = entities.filter((e) => e.type === "import");

      const writer = new KGWriter(db);
      const writeResult = writer.writeAST(ast, title, sourceUrl);

      return {
        success: true,
        document: title,
        ast: {
          totalNodes: entities.length,
          functions: functions.map((f) => f.content),
          classes: classes.map((c) => c.content),
          imports: imports.map((i) => i.content),
        },
        kg: {
          nodesCreated: writeResult.nodesCreated,
          edgesCreated: writeResult.edgesCreated,
          errors: writeResult.errors,
        },
      };
    },
  });

  registry.add({
    name: "dip_query_ast",
    description: "确定性 AST 树查询 (在已索引的文档中搜索节点，零LLM)",
    inputSchema: {
      query: z.string().describe("搜索关键词"),
      nodeType: z.enum(["function", "class", "module", "concept", "document"]).optional().describe("节点类型过滤"),
      limit: z.number().optional().default(20).describe("最大结果数"),
    },
    handler: async (args) => {
      const query = args.query as string;
      const nodeType = args.nodeType as string | undefined;
      const limit = (args.limit as number) || 20;

      const kg = getKGEnhancedInstance(db);
      const nodes = kg.searchNodes(query, {
        type: nodeType as KGNodeType | undefined,
        limit,
      });

      return {
        query,
        results: nodes.map((n) => ({
          nodeId: createNodeId("kg", n.type, n.id),
          type: n.type,
          name: n.name,
          description: (n.description || "").slice(0, 300),
          importance: n.importance,
        })),
        count: nodes.length,
      };
    },
  });

  // ===== 知识图谱工具 (PostgreSQL + SQLite 统一降级) =====

  registry.add({
    name: "kg_stats",
    description: "获取知识图谱统计信息 (PostgreSQL 优先，自动降级到 SQLite)",
    inputSchema: {},
    handler: async () => {
      try {
        const { isPgAvailable, getPG } = await import("../../db/pg-client.js");
        if (await isPgAvailable()) {
          const pg = getPG();
          const [entityCount] = await pg`SELECT COUNT(*)::int as count FROM kg_entities`;
          const [relCount] = await pg`SELECT COUNT(*)::int as count FROM kg_relationships`;
          return { success: true, backend: "postgresql", totalNodes: entityCount?.count || 0, totalEdges: relCount?.count || 0 };
        }
      } catch { /* PG not available, fall through to SQLite */ }
      const kg = getKGEnhancedInstance(db);
      return { success: true, backend: "sqlite", ...kg.getStats() };
    },
  });

  registry.add({
    name: "kg_entities",
    description: "查询知识图谱实体 (PostgreSQL 优先，自动降级到 SQLite)",
    inputSchema: {
      type: z.string().optional().describe("实体类型过滤"),
      query: z.string().optional().describe("搜索关键词"),
      limit: z.number().optional().default(50).describe("返回数量"),
    },
    handler: async (args) => {
      try {
        const { isPgAvailable, getPG } = await import("../../db/pg-client.js");
        if (await isPgAvailable()) {
          const pg = getPG();
          const type = args.type as string;
          const search = args.query as string;
          const limit = (args.limit as number) || 50;
          let query = "SELECT id, name, type, description FROM kg_entities";
          const conditions: string[] = [];
          const params: unknown[] = [];
          if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
          if (search) { params.push(`%${search}%`); conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`); }
          if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
          query += " ORDER BY updated_at DESC LIMIT $" + (params.length + 1);
          params.push(limit);
          const entities = await pg.unsafe(query, params as any[]);
          return { success: true, backend: "postgresql", data: entities, count: entities.length };
        }
      } catch { /* fall through */ }
      const kg = getKGEnhancedInstance(db);
      const nodes = kg.searchNodes((args.query as string) || "", {
        type: args.type as KGNodeType | undefined,
        limit: (args.limit as number) || 50,
      });
      return { success: true, backend: "sqlite", data: nodes, count: nodes.length };
    },
  });

  registry.add({
    name: "kg_entity_detail",
    description: "获取知识图谱实体详情及关系 (PostgreSQL 优先，自动降级到 SQLite)",
    inputSchema: { name: z.string().describe("实体名称") },
    handler: async (args) => {
      try {
        const { isPgAvailable, getPG } = await import("../../db/pg-client.js");
        if (await isPgAvailable()) {
          const pg = getPG();
          const entityName = args.name as string;
          const [entity] = await pg`SELECT * FROM kg_entities WHERE name = ${entityName}`;
          if (!entity) return { success: false, error: "Entity not found" };
          const relationships = await pg`
            SELECT r.relation_type, r.weight,
              CASE WHEN r.source_id = ${entity.id} THEN 'outgoing' ELSE 'incoming' END AS direction,
              CASE WHEN r.source_id = ${entity.id} THEN te.name ELSE se.name END AS other_entity,
              CASE WHEN r.source_id = ${entity.id} THEN te.type ELSE se.type END AS other_type
            FROM kg_relationships r
            JOIN kg_entities se ON se.id = r.source_id
            JOIN kg_entities te ON te.id = r.target_id
            WHERE r.source_id = ${entity.id} OR r.target_id = ${entity.id}
            ORDER BY r.weight DESC`;
          return { success: true, backend: "postgresql", data: { entity, relationships } };
        }
      } catch { /* fall through */ }
      const kg = getKGEnhancedInstance(db);
      const nodes = kg.searchNodes(args.name as string, { limit: 1 });
      if (nodes.length === 0) return { success: false, error: "Entity not found" };
      const node = nodes[0];
      const subgraph = kg.subgraph(node.id, 2, 50);
      return { success: true, backend: "sqlite", data: { entity: node, ...subgraph } };
    },
  });

  registry.add({
    name: "kg_traverse",
    description: "知识图谱遍历 (PostgreSQL 优先，自动降级到 SQLite)",
    inputSchema: {
      entityName: z.string().describe("起始实体名称"),
      depth: z.number().optional().default(2).describe("遍历深度"),
    },
    handler: async (args) => {
      try {
        const { isPgAvailable, getPG } = await import("../../db/pg-client.js");
        if (await isPgAvailable()) {
          const pg = getPG();
          const entityName = args.entityName as string;
          const depth = (args.depth as number) || 2;
          const [entity] = await pg`SELECT id FROM kg_entities WHERE name = ${entityName}`;
          if (!entity) return { success: false, error: "Entity not found" };
          const results = await pg`SELECT * FROM kg_traverse(${entity.id}, ${depth})`;
          return { success: true, backend: "postgresql", data: results, depth, startEntity: entityName };
        }
      } catch { /* fall through */ }
      const kg = getKGEnhancedInstance(db);
      const nodes = kg.searchNodes(args.entityName as string, { limit: 1 });
      if (nodes.length === 0) return { success: false, error: "Entity not found" };
      const subgraph = kg.subgraph(nodes[0].id, (args.depth as number) || 2, 100);
      return { success: true, backend: "sqlite", data: subgraph, depth: args.depth, startEntity: args.entityName };
    },
  });

  registry.add({
    name: "kg_build",
    description: "触发知识图谱构建",
    inputSchema: {
      projectPath: z.string().optional().describe("项目路径"),
      projectName: z.string().optional().describe("项目名称"),
    },
    handler: async (args) => {
      try {
        const { buildKnowledgeGraph } = await import("../../memory/knowledge-graph-builder.js");
        const result = await buildKnowledgeGraph({
          projectPath: (args.projectPath as string) || process.cwd(),
          projectName: (args.projectName as string) || "current",
          generateEmbeddings: false,
        });
        return { success: true, data: result };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  });

  registry.add({
    name: "kg_search",
    description: "知识图谱语义搜索",
    inputSchema: {
      query: z.string().describe("搜索查询"),
      projectName: z.string().optional().describe("项目名称"),
      maxDepth: z.number().optional().default(2).describe("最大深度"),
      maxEntities: z.number().optional().default(30).describe("最大实体数"),
    },
    handler: async (args) => {
      try {
        const { buildResearchContext } = await import("../../memory/knowledge-graph-builder.js");
        const result = await buildResearchContext(args.query as string, {
          projectName: args.projectName as string,
          maxDepth: (args.maxDepth as number) || 2,
          maxEntities: (args.maxEntities as number) || 30,
        });
        return { success: true, data: result };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  });

  registry.add({
    name: "kg_graph",
    description: "获取知识图谱可视化数据 (PostgreSQL 优先，自动降级到 SQLite)",
    inputSchema: {},
    handler: async () => {
      try {
        const { isPgAvailable, getPG } = await import("../../db/pg-client.js");
        if (await isPgAvailable()) {
          const pg = getPG();
          const entities = await pg`SELECT id, name, type, description FROM kg_entities ORDER BY updated_at DESC LIMIT 500`;
          const nodeIds = entities.map((e: any) => String(e.id));
          const relationships = await pg.unsafe(
            `SELECT r.source_id, r.target_id, r.relation_type FROM kg_relationships r
             WHERE r.source_id = ANY($1::bigint[]) AND r.target_id = ANY($1::bigint[])
             ORDER BY r.weight DESC LIMIT 2000`, [nodeIds]);
          const nodes = entities.map((e: any) => ({ id: e.id, name: e.name, type: e.type, label: e.name.split("/").pop()?.split(".").pop() || e.name }));
          const edges = relationships.map((r: any) => ({ source: r.source_id, target: r.target_id, type: r.relation_type }));
          return { success: true, backend: "postgresql", data: { nodes, edges, stats: { nodeCount: nodes.length, edgeCount: edges.length } } };
        }
      } catch { /* fall through */ }
      const kg = getKGEnhancedInstance(db);
      return { success: true, backend: "sqlite", data: kg.toEChartsData({ maxNodes: 200, includeEdges: true }) };
    },
  });

  // ===== 知识图谱增强工具 (SQLite 后端，统一实例) =====

  registry.add({
    name: "kg_add_node",
    description: "添加知识图谱节点",
    inputSchema: {
      type: z.enum(["function", "class", "module", "interface", "type", "variable", "file", "directory", "concept", "entity"]).describe("节点类型"),
      name: z.string().describe("节点名称"),
      description: z.string().optional().describe("节点描述"),
      filePath: z.string().optional().describe("文件路径"),
      lineNumber: z.number().optional().describe("行号"),
      signature: z.string().optional().describe("函数签名"),
      tags: z.array(z.string()).optional().describe("标签"),
    },
    handler: async (args) => {
      const kg = getKGEnhancedInstance(db);
      const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      kg.addNode({
        id: nodeId,
        type: args.type as KGNodeType,
        name: args.name as string,
        description: args.description as string,
        filePath: args.filePath as string,
        lineNumber: args.lineNumber as number,
        signature: args.signature as string,
        tags: args.tags as string[],
      });
      return { success: true, nodeId };
    },
  });

  registry.add({
    name: "kg_add_edge",
    description: "添加知识图谱边",
    inputSchema: {
      source: z.string().describe("源节点 ID"),
      target: z.string().describe("目标节点 ID"),
      type: z.enum(["calls", "imports", "extends", "implements", "contains", "depends-on", "related-to", "is-a", "part-of", "uses", "defines", "exports"]).describe("边类型"),
      weight: z.number().optional().default(1.0).describe("权重"),
      description: z.string().optional().describe("描述"),
    },
    handler: async (args) => {
      const kg = getKGEnhancedInstance(db);
      const edgeId = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      kg.addEdge({
        id: edgeId,
        source: args.source as string,
        target: args.target as string,
        type: args.type as KGEdgeType,
        weight: (args.weight as number) || 1.0,
        description: args.description as string,
      });
      return { success: true, edgeId };
    },
  });

  registry.add({
    name: "kg_search_nodes",
    description: "搜索知识图谱节点",
    inputSchema: {
      query: z.string().describe("搜索关键词"),
      type: z.enum(["function", "class", "module", "interface", "type", "variable", "file", "directory", "concept", "entity"]).optional().describe("节点类型过滤"),
      limit: z.number().optional().default(20).describe("返回数量"),
    },
    handler: async (args) => {
      const kg = getKGEnhancedInstance(db);
      const nodes = kg.searchNodes(args.query as string, {
        type: args.type as KGNodeType | undefined,
        limit: args.limit as number,
      });
      return nodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        description: n.description,
        importance: n.importance,
      }));
    },
  });

  registry.add({
    name: "kg_subgraph",
    description: "获取知识图谱子图 (BFS)",
    inputSchema: {
      nodeId: z.string().describe("起始节点 ID"),
      depth: z.number().optional().default(2).describe("遍历深度"),
      maxNodes: z.number().optional().default(100).describe("最大节点数"),
    },
    handler: async (args) => {
      const kg = getKGEnhancedInstance(db);
      const result = kg.subgraph(args.nodeId as string, args.depth as number, args.maxNodes as number);
      return {
        nodes: result.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          name: n.name,
          description: n.description,
        })),
        edges: result.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: e.type,
          weight: e.weight,
        })),
      };
    },
  });

  registry.add({
    name: "kg_shortest_path",
    description: "查找两个节点之间的最短路径",
    inputSchema: {
      startId: z.string().describe("起始节点 ID"),
      endId: z.string().describe("结束节点 ID"),
    },
    handler: async (args) => {
      const kg = getKGEnhancedInstance(db);
      const path = kg.shortestPath(args.startId as string, args.endId as string);
      if (!path) {
        return { success: false, error: "No path found" };
      }
      return { success: true, path };
    },
  });

  registry.add({
    name: "kg_detect_communities",
    description: "检测知识图谱社区",
    inputSchema: {},
    handler: async () => {
      const kg = getKGEnhancedInstance(db);
      const communities = kg.detectCommunities();
      return communities.map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
        nodeCount: c.nodes.length,
      }));
    },
  });

  registry.add({
    name: "kg_echarts_data",
    description: "获取 ECharts 可视化数据",
    inputSchema: {
      maxNodes: z.number().optional().default(200).describe("最大节点数"),
      includeEdges: z.boolean().optional().default(true).describe("是否包含边"),
    },
    handler: async (args) => {
      const kg = getKGEnhancedInstance(db);
      return kg.toEChartsData({
        maxNodes: args.maxNodes as number,
        includeEdges: args.includeEdges as boolean,
      });
    },
  });

  registry.add({
    name: "kg_d3_data",
    description: "获取 D3.js 可视化数据",
    inputSchema: {
      maxNodes: z.number().optional().default(200).describe("最大节点数"),
    },
    handler: async (args) => {
      const kg = getKGEnhancedInstance(db);
      return kg.toD3Data({ maxNodes: args.maxNodes as number });
    },
  });

  registry.add({
    name: "kg_nl_query",
    description: "自然语言查询知识图谱",
    inputSchema: {
      question: z.string().describe("自然语言问题"),
    },
    handler: async (args) => {
      const kg = getKGEnhancedInstance(db);
      return kg.queryNL(args.question as string);
    },
  });

  registry.add({
    name: "kg_enhanced_stats",
    description: "获取知识图谱增强统计信息",
    inputSchema: {},
    handler: async () => {
      const kg = getKGEnhancedInstance(db);
      return kg.getStats();
    },
  });
}
