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
