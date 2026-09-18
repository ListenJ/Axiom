/**
 * 审计 H7（2026-08-28）：enhanced.ts 内存 adjacency 不从 DB 恢复
 *
 * 构造函数建空 Map，仅本次运行写入的节点/边进内存邻接表；
 * 进程重启后 subgraph/shortestPath/getNeighbors 等基于 adjacency 的图查询全部空转。
 * 本测试用实例 A 写入节点+边并关闭库，再用新实例 B 打开同一文件库，
 * 锁定 B 的图查询能看到 A 写入的数据（重启恢复语义）。
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeGraphEnhanced } from "../src/kg/enhanced.js";

const dir = mkdtempSync(join(tmpdir(), "kg-restore-"));
const dbPath = join(dir, "kg.db");

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 文件句柄延迟时容忍 */ }
});

describe("审计 H7: 重启后内存 adjacency 从 DB 恢复", () => {
  test("实例 A 写入的节点与边，新实例 B 重建后图查询可见", () => {
    const dbA = new Database(dbPath);
    const a = new KnowledgeGraphEnhanced(dbA);
    a.addNode({ id: "rst-a", type: "function", name: "RestoreA" });
    a.addNode({ id: "rst-b", type: "function", name: "RestoreB" });
    a.addNode({ id: "rst-c", type: "function", name: "RestoreC" });
    a.addEdge({ id: "rst-e1", source: "rst-a", target: "rst-b", type: "calls", weight: 1.0 });
    a.addEdge({ id: "rst-e2", source: "rst-b", target: "rst-c", type: "calls", weight: 1.0 });
    dbA.close(); // 模拟进程退出

    const dbB = new Database(dbPath);
    const b = new KnowledgeGraphEnhanced(dbB);
    try {
      // 邻接遍历恢复
      const out = b.getOutEdges("rst-a");
      expect(out.length).toBe(1);
      expect(out[0].target).toBe("rst-b");
      // BFS 子图恢复
      const sg = b.subgraph("rst-a", 2);
      expect(sg.nodes.length).toBe(3);
      expect(sg.edges.length).toBe(2);
      // 最短路径恢复
      expect(b.shortestPath("rst-a", "rst-c")).toEqual(["rst-a", "rst-b", "rst-c"]);
      // 统计恢复
      const stats = b.getStats();
      expect(stats.totalNodes).toBe(3);
      expect(stats.totalEdges).toBe(2);
    } finally {
      dbB.close();
    }
  });
});
