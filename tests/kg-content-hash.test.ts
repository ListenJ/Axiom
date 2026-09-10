import { describe, it, expect } from "bun:test";
import { KnowledgeGraphEnhanced } from "../src/kg/enhanced.js";
import { Database } from "bun:sqlite";

describe("kg content hash S8", () => {
  it("同内容二次写入不产生重复节点", () => {
    const db = new Database(":memory:");
    const kg = new KnowledgeGraphEnhanced(db as any);
    const n1 = { id: "", type: "concept" as const, name: "X", description: "desc", importance: 0.5 };
    const n2 = { id: "", type: "concept" as const, name: "X", description: "desc", importance: 0.5 };
    kg.addNode(n1 as any);
    kg.addNode(n2 as any);
    const nodes = kg.searchNodes("X");
    expect(nodes.length).toBe(1);
  });

  it("tmp- 前缀同内容二次写入不产生重复节点", () => {
    const db = new Database(":memory:");
    const kg = new KnowledgeGraphEnhanced(db as any);
    const n1 = { id: "tmp-abc123", type: "concept" as const, name: "Y", description: "same", importance: 0.5 };
    const n2 = { id: "tmp-xyz789", type: "concept" as const, name: "Y", description: "same", importance: 0.5 };
    kg.addNode(n1 as any);
    kg.addNode(n2 as any);
    const nodes = kg.searchNodes("Y");
    expect(nodes.length).toBe(1);
  });

  it("同内容生成稳定 kg_ 哈希 id", () => {
    const db = new Database(":memory:");
    const kg = new KnowledgeGraphEnhanced(db as any);
    const n1 = { id: "", type: "concept" as const, name: "Z", description: "stable", importance: 0.5 };
    kg.addNode(n1 as any);
    // n1.id should have been mutated to kg_<hash>
    expect((n1 as any).id).toMatch(/^kg_[0-9a-f]{16}$/);
    const fetched = kg.getNode((n1 as any).id);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("Z");
  });

  // ===== 审计 S2 M5（2026-08-29）：节点身份哈希只取 type:name =====

  it("同 type+name 不同 description 二次写入仍 1 行且 description 已更新（M5）", () => {
    const db = new Database(":memory:");
    const kg = new KnowledgeGraphEnhanced(db as any);
    kg.addNode({ id: "", type: "concept" as const, name: "M5Node", description: "old desc", importance: 0.5 } as any);
    kg.addNode({ id: "", type: "concept" as const, name: "M5Node", description: "new desc", importance: 0.5 } as any);
    const rows = db.prepare("SELECT id, description FROM kg_nodes WHERE name = 'M5Node'").all() as Array<{ id: string; description: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].description).toBe("new desc");
  });

  it("description 变更不改变实体 kg_ 哈希 id（M5）", () => {
    const db = new Database(":memory:");
    const kg = new KnowledgeGraphEnhanced(db as any);
    const n1 = { id: "", type: "function" as const, name: "HashStableFn", description: "v1" } as any;
    kg.addNode(n1);
    const id1 = n1.id as string;
    expect(id1).toMatch(/^kg_[0-9a-f]{16}$/);
    const n2 = { id: "", type: "function" as const, name: "HashStableFn", description: "totally different v2" } as any;
    kg.addNode(n2);
    expect(n2.id).toMatch(/^kg_[0-9a-f]{16}$/);
    expect(n2.id).toBe(id1);
  });

  it("同内容不同 id 的边不重复", () => {
    const db = new Database(":memory:");
    const kg = new KnowledgeGraphEnhanced(db as any);
    // need nodes for edge source/target
    kg.addNode({ id: "src-1", type: "concept" as const, name: "A", description: "a", importance: 0.5 } as any);
    kg.addNode({ id: "dst-1", type: "concept" as const, name: "B", description: "b", importance: 0.5 } as any);
    const e1 = { id: "", source: "src-1", target: "dst-1", type: "related-to" as const, weight: 1.0 };
    const e2 = { id: "tmp-edge2", source: "src-1", target: "dst-1", type: "related-to" as const, weight: 1.0 };
    kg.addEdge(e1 as any);
    kg.addEdge(e2 as any);
    // after hash, both edges should have same id, so only one edge stored
    const out = kg.getOutEdges("src-1");
    expect(out.length).toBe(1);
    expect(out[0].id).toMatch(/^kg_/);
  });
});

// ===== 审计 S2 L1（2026-08-29）：REPLACE 沿用旧行 created_at =====

describe("kg created_at 溯源 S2 L1", () => {
  it("节点 REPLACE 后 created_at 不变、updated_at 刷新", async () => {
    const db = new Database(":memory:");
    const kg = new KnowledgeGraphEnhanced(db as any);
    kg.addNode({ id: "", type: "concept" as const, name: "TsNode", description: "v1", importance: 0.5 } as any);
    const first = db.prepare("SELECT created_at, updated_at FROM kg_nodes WHERE name = 'TsNode'").get() as { created_at: number; updated_at: number };
    await new Promise((r) => setTimeout(r, 10));
    kg.addNode({ id: "", type: "concept" as const, name: "TsNode", description: "v2", importance: 0.5 } as any);
    const second = db.prepare("SELECT created_at, updated_at FROM kg_nodes WHERE name = 'TsNode'").get() as { created_at: number; updated_at: number };
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBeGreaterThan(first.updated_at);
  });

  it("边 REPLACE 后 created_at 不变", async () => {
    const db = new Database(":memory:");
    const kg = new KnowledgeGraphEnhanced(db as any);
    kg.addNode({ id: "src-l1", type: "concept" as const, name: "LA", importance: 0.5 } as any);
    kg.addNode({ id: "dst-l1", type: "concept" as const, name: "LB", importance: 0.5 } as any);
    kg.addEdge({ id: "", source: "src-l1", target: "dst-l1", type: "related-to" as const, weight: 1.0 } as any);
    const first = db.prepare("SELECT created_at FROM kg_edges WHERE source = 'src-l1' AND target = 'dst-l1'").get() as { created_at: number };
    await new Promise((r) => setTimeout(r, 10));
    kg.addEdge({ id: "", source: "src-l1", target: "dst-l1", type: "related-to" as const, weight: 2.0 } as any);
    const second = db.prepare("SELECT created_at, weight FROM kg_edges WHERE source = 'src-l1' AND target = 'dst-l1'").get() as { created_at: number; weight: number };
    expect(second.created_at).toBe(first.created_at);
    expect(second.weight).toBe(2.0);
  });
});
