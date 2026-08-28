/**
 * 审计 H2（2026-08-28）：MCP kg_add_node/kg_add_edge 随机 id 绕过内容哈希去重
 *
 * 此前 handler 生成 `node-${Date.now()}-${Math.random()...}` / `edge-${...}` 随机 id，
 * 击穿 enhanced.ts W10 的内容哈希去重（仅空 id / tmp- 前缀才走 sha256 哈希），
 * 同内容手工写入必产生重复节点/边。
 * 本测试经 ToolRegistry（no-op guard）直接调用 MCP handler 锁定行为：
 *  1. 同内容 kg_add_node 两次调用 → 同一 kg_ 哈希 nodeId，库内仅 1 行；
 *  2. 同 source/target/type kg_add_edge 两次调用 → 同一 kg_ 哈希 edgeId，库内仅 1 行。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ToolRegistry } from "../src/mcp/tool-registry.js";
import { registerKgTools } from "../src/mcp/server/kg-tools.js";

const db = new Database(":memory:");
const registry = new ToolRegistry({ guard: async () => {} });
registerKgTools(registry, db);
const handlers = registry.buildHttpHandlers();

describe("审计 H2: kg_add_node/kg_add_edge 内容哈希去重", () => {
  test("kg_add_node 同内容两次调用去重为 1 个节点且返回 kg_ 哈希 id", async () => {
    const r1 = (await handlers["kg_add_node"]({ type: "concept", name: "DedupNode", description: "same" })) as { success: boolean; nodeId: string };
    const r2 = (await handlers["kg_add_node"]({ type: "concept", name: "DedupNode", description: "same" })) as { success: boolean; nodeId: string };
    expect(r1.success).toBe(true);
    expect(r1.nodeId).toMatch(/^kg_[0-9a-f]{16}$/);
    expect(r2.nodeId).toBe(r1.nodeId);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM kg_nodes WHERE name = 'DedupNode'").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("kg_add_edge 同 source/target/type 两次调用去重为 1 条边且返回 kg_ 哈希 id", async () => {
    const a = (await handlers["kg_add_node"]({ type: "function", name: "EdgeSrc" })) as { nodeId: string };
    const b = (await handlers["kg_add_node"]({ type: "function", name: "EdgeDst" })) as { nodeId: string };
    const e1 = (await handlers["kg_add_edge"]({ source: a.nodeId, target: b.nodeId, type: "calls" })) as { success: boolean; edgeId: string };
    const e2 = (await handlers["kg_add_edge"]({ source: a.nodeId, target: b.nodeId, type: "calls" })) as { success: boolean; edgeId: string };
    expect(e1.success).toBe(true);
    expect(e1.edgeId).toMatch(/^kg_[0-9a-f]{16}$/);
    expect(e2.edgeId).toBe(e1.edgeId);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM kg_edges WHERE source = ? AND target = ? AND type = 'calls'").get(a.nodeId, b.nodeId) as { c: number }).c;
    expect(count).toBe(1);
  });
});
