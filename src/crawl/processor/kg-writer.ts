/**
 * KG Writer — 将 AST 节点写入知识图谱
 *
 * 数据流:
 * AST 节点 → KG 节点 (kg_nodes)
 * AST 关系 → KG 边 (kg_edges)
 *
 * 支持的节点映射:
 * - heading → concept 节点
 * - function → function 节点
 * - class → class 节点
 * - import → depends-on 边
 * - paragraph → concept 节点 (如果包含关键信息)
 */

import { Database } from "bun:sqlite";
import { logger } from "../../utils/logger.js";
import { createNodeId } from "../../kal/node-id.js";
import type { ASTNode } from "./markdown-ast.js";

// ========== 类型定义 ==========

/** 写入结果 */
export interface WriteResult {
  nodesCreated: number;
  edgesCreated: number;
  errors: string[];
}

// ========== KG Writer ==========

export class KGWriter {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureTables();
  }

  /**
   * 确保 KG 表存在 (与 KnowledgeGraphEnhanced 保持一致)
   */
  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kg_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        file_path TEXT,
        line_number INTEGER,
        signature TEXT,
        semantic TEXT,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        community INTEGER,
        importance REAL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kg_edges (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        description TEXT,
        evidence TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source) REFERENCES kg_nodes(id),
        FOREIGN KEY (target) REFERENCES kg_nodes(id)
      );
    `);
  }

  /**
   * 将 AST 写入 KG
   */
  writeAST(ast: ASTNode, documentTitle: string, sourceUrl?: string): WriteResult {
    const result: WriteResult = { nodesCreated: 0, edgesCreated: 0, errors: [] };

    // 1. 创建文档根节点
    const docNodeId = createNodeId("kg", "document", documentTitle);
    this.upsertNode(docNodeId, "document", documentTitle, {
      description: `Document: ${documentTitle}`,
      sourceUrl,
      tags: ["document"],
    });
    result.nodesCreated++;

    // 2. 遍历 AST 子节点
    this.processNode(ast, docNodeId, result);

    logger.info("[KGWriter] AST written to KG", {
      documentTitle,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      errors: result.errors.length,
    });

    return result;
  }

  /**
   * 递归处理 AST 节点
   */
  private processNode(node: ASTNode, parentId: string, result: WriteResult): void {
    for (const child of node.children) {
      try {
        switch (child.type) {
          case "heading":
            this.processHeading(child, parentId, result);
            break;
          case "function":
            this.processFunction(child, parentId, result);
            break;
          case "class":
            this.processClass(child, parentId, result);
            break;
          case "import":
            this.processImport(child, parentId, result);
            break;
          case "code_block":
            this.processCodeBlock(child, parentId, result);
            break;
          case "paragraph":
            this.processParagraph(child, parentId, result);
            break;
          default:
            break;
        }
      } catch (err) {
        result.errors.push(`Error processing ${child.type}: ${(err as Error).message}`);
      }

      // 递归处理子节点
      if (child.children.length > 0) {
        const childNodeId = createNodeId("kg", child.type, `${parentId}:${child.content.slice(0, 50)}`);
        this.processNode(child, childNodeId, result);
      }
    }
  }

  /**
   * 处理标题节点 → concept 节点
   */
  private processHeading(node: ASTNode, parentId: string, result: WriteResult): void {
    const nodeId = createNodeId("kg", "concept", node.content.slice(0, 100));
    const level = (node.metadata.level as number) || 1;

    this.upsertNode(nodeId, "concept", node.content, {
      description: `Section heading (h${level})`,
      level,
      tags: ["heading", `h${level}`],
    });
    result.nodesCreated++;

    // 添加包含边
    this.addEdge(parentId, nodeId, "contains", 1.0);
    result.edgesCreated++;
  }

  /**
   * 处理函数节点 → function 节点
   */
  private processFunction(node: ASTNode, parentId: string, result: WriteResult): void {
    const nodeId = createNodeId("kg", "function", node.content);

    this.upsertNode(nodeId, "function", node.content, {
      description: `Function: ${node.content}`,
      language: node.metadata.language,
      line: node.metadata.line,
      exported: node.metadata.exported,
      async: node.metadata.async,
      tags: ["function", node.metadata.language as string].filter(Boolean),
    });
    result.nodesCreated++;

    // 添加定义边
    this.addEdge(parentId, nodeId, "defines", 1.0);
    result.edgesCreated++;
  }

  /**
   * 处理类节点 → class 节点
   */
  private processClass(node: ASTNode, parentId: string, result: WriteResult): void {
    const nodeId = createNodeId("kg", "class", node.content);

    this.upsertNode(nodeId, "class", node.content, {
      description: `Class: ${node.content}`,
      language: node.metadata.language,
      line: node.metadata.line,
      exported: node.metadata.exported,
      abstract: node.metadata.abstract,
      tags: ["class", node.metadata.language as string].filter(Boolean),
    });
    result.nodesCreated++;

    // 添加定义边
    this.addEdge(parentId, nodeId, "defines", 1.0);
    result.edgesCreated++;
  }

  /**
   * 处理导入节点 → depends-on 边
   */
  private processImport(node: ASTNode, parentId: string, result: WriteResult): void {
    // 查找或创建被导入的模块节点
    const moduleId = createNodeId("kg", "module", node.content);
    this.upsertNode(moduleId, "module", node.content, {
      description: `Module: ${node.content}`,
      language: node.metadata.language,
      tags: ["module"],
    });
    result.nodesCreated++;

    // 添加依赖边
    this.addEdge(parentId, moduleId, "depends-on", 0.8);
    result.edgesCreated++;
  }

  /**
   * 处理代码块 → 记录但不创建独立节点
   */
  private processCodeBlock(node: ASTNode, parentId: string, _result: WriteResult): void {
    // 代码块本身不创建节点，但通过 metadata 记录
    // 实际的函数/类节点已在 extractCodeEntities 中创建
  }

  /**
   * 处理段落 → 如果包含关键词则创建 concept 节点
   */
  private processParagraph(node: ASTNode, parentId: string, result: WriteResult): void {
    // 只有较长的段落才创建节点
    if (node.content.length < 50) return;

    const nodeId = createNodeId("kg", "concept", node.content.slice(0, 80));
    this.upsertNode(nodeId, "concept", node.content.slice(0, 200), {
      description: node.content.slice(0, 500),
      tags: ["paragraph"],
    });
    result.nodesCreated++;

    this.addEdge(parentId, nodeId, "contains", 0.5);
    result.edgesCreated++;
  }

  // ========== 数据库操作 ==========

  private upsertNode(
    id: string,
    type: string,
    name: string,
    metadata: { description?: string; tags?: string[]; [key: string]: unknown }
  ): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO kg_nodes (
        id, type, name, description, tags, metadata, importance, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      type,
      name,
      metadata.description || null,
      JSON.stringify(metadata.tags || []),
      JSON.stringify(metadata),
      0.5,
      now,
      now
    );
  }

  private addEdge(source: string, target: string, type: string, weight: number): void {
    const now = Date.now();
    const edgeId = `edge-${source.slice(0, 20)}-${target.slice(0, 20)}-${type}`;

    this.db.prepare(`
      INSERT OR IGNORE INTO kg_edges (
        id, source, target, type, weight, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(edgeId, source, target, type, weight, now);
  }
}
