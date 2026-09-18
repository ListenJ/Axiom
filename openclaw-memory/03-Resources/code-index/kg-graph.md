---
id: code-kg.graph
type: code-index
source: kg\graph.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 1501
tags: [code, auto-indexed]
exports: ["Entity", "Relationship", "GraphPath", "Subgraph", "KnowledgeGraph"]
imports: ["bun:sqlite"]
---

# kg.graph

## 元信息

- **源文件**: `kg\graph.ts`
- **模块**: `kg.graph`
- **行数**: 406
- **索引时间**: 2026-05-25T05:11:12.532Z

## 依赖

- [[bun:sqlite]]

## 导出清单

| 类型 | 名称 | 行号 |
|------|------|------|
| interface | `Entity` | 18 |
| interface | `Relationship` | 27 |
| interface | `GraphPath` | 36 |
| interface | `Subgraph` | 41 |
| class | `KnowledgeGraph` | 46 |

## 代码

```typescript
/**
 * 知识图谱 (Knowledge Graph) 管理器
 * 基于 SQLite 的 entities + relationships 表实现轻量级图数据库
 *
 * 支持：
 * - 实体 CRUD（人物、组织、概念、工具、文件）
 * - 关系创建与查询
 * - 图遍历（BFS/DFS）
 * - 最短路径
 * - 中心性分析（度中心性）
 * - 子图提取
 */
import { Database } from "bun:sqlite";

export type EntityType = "person" | "org" | "concept" | "tool" | "file" | "project" | "topic";
export type RelationType = "uses" | "depends_on" | "part_of" | "mentions" | "created_by" | "related_to" | "contains" | "references";

export interface Entity {
  id: number;
  name: string;
  type: EntityType;
  properties?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Relationship {
  id: number;
  sourceEntity: number;
  targetEntity: number;
  relationType: RelationType;
  properties?: Record<string, unknown>;
  createdAt: Date;
}

export interface GraphPath {
  nodes: Entity[];
  edges: Relationship[];
}

export interface Subgraph {
  entities: Entity[];
  relationships: Relationship[];
}

export class KnowledgeGraph {
  private db: Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || process.env.DATABASE_PATH || "./data/agent.db");
    this.initSchema();
  }

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        properties TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_entity INTEGER NOT NULL,
        target_entity INTEGER NOT NULL,
        relation_type TEXT NOT NULL,
        properties TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source_entity) REFERENCES entities(id),
        FOREIGN KEY (target_entity) REFERENCES entities(id)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_entity)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_entity)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(relation_type)`);
  }

  // ===== 实体操作 =====

  createEntity(name: string, type: EntityType, properties?: Record<string, unknown>): Entity {
    const now = Date.now();
    const result = this.db.run(
      `INSERT OR REPLACE INTO entities (name, type, properties, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [name, type, properties ? JSON.stringify(properties) : null, now, now]
    );
    return {
      id: Number(result.lastInsertRowid),
      name,
      type,
      properties,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  getEntity(id: number): Entity | null {
    const row = this.db.query("SELECT * FROM entities WHERE id = ?").get(id) as any;
    return row ? this.parseEntity(row) : null;
  }

  getEntityByName(name: string): Entity | null {
    const row = this.db.query("SELECT * FROM entities WHERE name = ?").get(name) as any;
    return row ? this.parseEntity(row) : null;
  }

  findEntities(type?: EntityType, limit = 100): Entity[] {
    let sql = "SELECT * FROM entities";
    const params: any[] = [];
    if (type) { sql += " WHERE type = ?"; params.push(type); }
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.query(sql).all(...params) as any[];
    return rows.map(this.parseEntity);
  }

  searchEntities(query: string, limit = 20): Entity[] {
    const rows = this.db
      .query("SELECT * FROM entities WHERE name LIKE ? ORDER BY name LIMIT ?")
      .all(`%${query}%`, limit) as any[];
    return rows.map(this.parseEntity);
  }

  updateEntity(id: number, updates: Partial<Pick<Entity, "name" | "type" | "properties">>): Entity | null {
    const sets: string[] = [];
    const params: any[] = [];
    if (updates.name) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.type) { sets.push("type = ?"); params.push(updates.type); }
    if (updates.properties) { sets.push("properties = ?"); params.push(JSON.stringify(updates.properties)); }
    if (sets.length === 0) return this.getEntity(id);
    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);
    this.db.run(`UPDATE entities SET ${sets.join(", ")} WHERE id = ?`, params);
    return this.getEntity(id);
  }

  deleteEntity(id: number): void {
    this.db.run("DELETE FROM relationships WHERE source_entity = ? OR target_entity = ?", [id, id]);
    this.db.run("DELETE FROM entities WHERE id = ?", [id]);
  }

  // ===== 关系操作 =====

  createRelationship(
    sourceId: number,
    targetId: number,
    relationType: RelationType,
    properties?: Record<string, unknown>
  ): Relationship {
    const now = Date.now();
    const result = this.db.run(
      `INSERT INTO relationships (source_entity, target_entity, relation_type, properties, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [sourceId, targetId, relationType, properties ? JSON.stringify(properties) : null, now]
    );
    return {
      id: Number(result.lastInsertRowid),
      sourceEntity: sourceId,
      targetEntity: targetId,
      relationType,
      properties,
      createdAt: new Date(now),
    };
  }

  getRelationships(entityId: number, direction: "out" | "in" | "both" = "both"): Array<Relationship & { other: Entity }> {
    const results: Array<Relationship & { other: Entity }> = [];

    if (direction === "out" || direction === "both") {
      const rows = this.db
        .query(`
          SELECT r.*, e.id as other_id, e.name as other_name, e.type as other_type,
                 e.properties as other_props, e.created_at as other_created, e.updated_at as other_updated
          FROM relationships r
          JOIN entities e ON r.target_entity = e.id
          WHERE r.source_entity = ?
        `)
        .all(entityId) as any[];
      for (const row of rows) {
        results.push({
          ...this.parseRel(row),
          other: this.parseEntity({
            id: row.other_id, name: row.other_name, type: row.other_type,
            properties: row.other_props, created_at: row.other_created, updated_at: row.other_updated,
          }),
        });
      }
    }

    if (direction === "in" || direction === "both") {
      const rows = this.db
        .query(`
          SELECT r.*, e.id as other_id, e.name as other_name, e.type as other_type,
                 e.properties as other_props, e.created_at as other_created, e.updated_at as other_updated
          FROM relationships r
          JOIN entities e ON r.source_entity = e.id
          WHERE r.target_entity = ?
        `)
        .all(entityId) as any[];
      for (const row of rows) {
        results.push({
          ...this.parseRel(row),
          other: this.parseEntity({
            id: row.other_id, name: row.other_name, type: row.other_type,
            properties: row.other_props, created_at: row.other_created, updated_at: row.other_updated,
          }),
        });
      }
    }

    return results;
  }

  deleteRelationship(id: number): void {
    this.db.run("DELETE FROM relationships WHERE id = ?", [id]);
  }

  // ===== 图遍历 =====

  /** BFS 遍历，返回从起点可达的所有节点 */
  bfs(startEntityId: number, maxDepth = 3, relationFilter?: RelationType[]): Subgraph {
    const visited = new Set<number>();
    const queue: Array<{ id: number; depth: number }> = [{ id: startEntityId, depth: 0 }];
    const entities: Entity[] = [];
    const relationships: Relationship[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);

      const entity = this.getEntity(current.id);
      if (entity) entities.push(entity);
      if (current.depth >= maxDepth) continue;

      const rels = this.db
        .query("SELECT * FROM relationships WHERE source_entity = ? OR target_entity = ?")
        .all(current.id, current.id) as any[];

      for (const rel of rels) {
        if (relationFilter && !relationFilter.includes(rel.relation_type)) continue;
        relationships.push(this.parseRel(rel));
        const nextId = rel.source_entity === current.id ? rel.target_entity : rel.source_entity;
        if (!visited.has(nextId)) {
          queue.push({ id: nextId, depth: current.depth + 1 });
        }
      }
    }

    return { entities, relationships };
  }

  /** 查找两实体间的最短路径 */
  shortestPath(fromId: number, toId: number, maxDepth = 5): GraphPath | null {
    if (fromId === toId) {
      const e = this.getEntity(fromId);
      return e ? { nodes: [e], edges: [] } : null;
    }

    const queue: Array<{ id: number; path: number[]; depth: number }> = [{ id: fromId, path: [], depth: 0 }];
    const visited = new Set<number>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);

      if (current.depth >= maxDepth) continue;

      const rels = this.db
        .query("SELECT * FROM relationships WHERE source_entity = ? OR target_entity = ?")
        .all(current.id, current.id) as any[];

      for (const rel of rels) {
        const nextId = rel.source_entity === current.id ? rel.target_entity : rel.source_entity;
        const relObj = this.parseRel(rel);
        const newPath = [...current.path, relObj.id];

        if (nextId === toId) {
          const nodes: Entity[] = [];
          const edges: Relationship[] = [];
          // 重建路径上的所有节点和边
          const nodeIds = [fromId];
          let curr = fromId;
          for (const relId of newPath) {
            const r = this.db.query("SELECT * FROM relationships WHERE id = ?").get(relId) as any;
            edges.push(this.parseRel(r));
            const next = r.source_entity === curr ? r.target_entity : r.source_entity;
            nodeIds.push(next);
            curr = next;
          }
          for (const nid of nodeIds) {
            const e = this.getEntity(nid);
            if (e) nodes.push(e);
          }
          return { nodes, edges };
        }

        if (!visited.has(nextId)) {
          queue.push({ id: nextId, path: newPath, depth: current.depth + 1 });
        }
      }
    }

    return null;
  }

  // ===== 分析 =====

  /** 度中心性（连接数最多的实体） */
  centrality(limit = 20): Array<{ entity: Entity; degree: number }> {
    const rows = this.db.query(`
      SELECT e.*, COUNT(r.id) as degree
      FROM entities e
      LEFT JOIN relationships r ON e.id = r.source_entity OR e.id = r.target_entity
      GROUP BY e.id
      ORDER BY degree DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map((row) => ({
      entity: this.parseEntity(row),
      degree: row.degree,
    }));
  }

  /** 统计概览 */
  stats(): { entityCount: number; relationCount: number; typeDistribution: Record<string, number> } {
    const entityCount = (this.db.query("SELECT COUNT(*) as c FROM entities").get() as any)?.c || 0;
    const relationCount = (this.db.query("SELECT COUNT(*) as c FROM relationships").get() as any)?.c || 0;
    const typeRows = this.db.query("SELECT type, COUNT(*) as c FROM entities GROUP BY type").all() as any[];
    const typeDistribution: Record<string, number> = {};
    for (const r of typeRows) typeDistribution[r.type] = r.c;

    return { entityCount, relationCount, typeDistribution };
  }

  // ===== 批量操作 =====

  /** 从文本中自动提取实体（简化版：基于关键词匹配已有实体） */
  extractEntitiesFromText(text: string): Entity[] {
    const all = this.findEntities(undefined, 1000);
    return all.filter((e) => text.toLowerCase().includes(e.name.toLowerCase()));
  }

  /** 导入 JSON 数据 */
  importJson(data: { entities: Array<{ name: string; type: EntityType; properties?: Record<string, unknown> }>; relationships: Array<{ source: string; target: string; type: RelationType; properties?: Record<string, unknown> }> }): void {
    const idMap = new Map<string, number>();

    for (const e of data.entities) {
      const existing = this.getEntityByName(e.name);
      if (existing) {
        idMap.set(e.name, existing.id);
      } else {
        const created = this.createEntity(e.name, e.type, e.properties);
        idMap.set(e.name, created.id);
      }
    }

    for (const r of data.relationships) {
      const sourceId = idMap.get(r.source);
      const targetId = idMap.get(r.target);
      if (sourceId && targetId) {
        this.createRelationship(sourceId, targetId, r.type, r.properties);
      }
    }
  }

  // ===== 解析器 =====

  private parseEntity(row: any): Entity {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      properties: row.properties ? JSON.parse(row.properties) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private parseRel(row: any): Relationship {
    return {
      id: row.id,
      sourceEntity: row.source_entity,
      targetEntity: row.target_entity,
      relationType: row.relation_type,
      properties: row.properties ? JSON.parse(row.properties) : undefined,
      createdAt: new Date(row.created_at),
    };
  }

  close() {
    this.db.close();
  }
}

export default KnowledgeGraph;

```