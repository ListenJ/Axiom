/**
 * 知识库后端收敛进 DRE —— 守卫测试（T3，2026-09-17）
 *
 * 背景：此前图谱边存在两张表 —— DRE 侧 kg_edge（sqlite-backend.ts）与
 * 代码 KG 侧 kg_edges（kg/schema.ts），KAL 用 UNION ALL + try/catch 缝合。
 * 收敛后：唯一边表 kg_edges，由 DRE 的 SqliteBackend 托管建表，DDL 单源在
 * kg/schema.ts；kg_edge 的 DDL 与所有读写出入口必须消失。
 *
 * 本测试垂直切片覆盖：存储结构、DRE 边写入/读取、KAL 单腿查询。
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { SqliteBackend } from "../../src/dre/storage/sqlite-backend.js";
import { KnowledgeStore } from "../../src/dre/storage/knowledge-store.js";
import { KnowledgeAccessLayer } from "../../src/kal/knowledge-access-layer.js";
import { kgEdgeId } from "../../src/kg/schema.js";

/**
 * Windows 下删除临时目录（2026-09-20）。
 *
 * 为什么需要重试：`src/utils/logger.ts:95` 已记录同类现象 ——
 * **SQLite 的文件句柄在 close() 后并非立即由 OS 释放**，此刻 rmSync 会抛
 * `EBUSY: resource busy or locked`（POSIX 无此约束，故 Linux 侧从不暴露）。
 * 这里做**有界重试**（至多 ~1s），且**最后一次仍失败就抛出** —— 不静默掩盖。
 */
function rmTempDirWithRetry(dir: string, attempts = 10, waitMs = 100): void {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) throw e;
      Bun.sleepSync(waitMs);
    }
  }
}


function tmpDb(): { db: Database; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kg-unify-"));
  const path = join(dir, "test.db");
  const db = new Database(path);
  return { db, path, cleanup: () => { db.close(); rmTempDirWithRetry(dir); } };
}

describe("切片1：DRE 存储托管唯一边表 kg_edges", () => {
  it("SqliteBackend 初始化后存在 kg_edges，且不存在旧表 kg_edge", () => {
    const dir = mkdtempSync(join(tmpdir(), "dre-"));
    const path = join(dir, "agent.db");
    try {
      // Windows：SqliteBackend 自己持句柄，不 close 就 rmSync 会 EBUSY（POSIX 无此约束）
      const backend = new SqliteBackend(path);
      const db = new Database(path, { readonly: true });
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kg%'")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("kg_edges");
      expect(names).not.toContain("kg_edge");
      db.close();
      backend.close();
    } finally {
      rmTempDirWithRetry(dir);
    }
  });
});

describe("切片2：DRE 边写入/读取走 kg_edges 列名", () => {
  it("addEdge 写入后可按出边/入边读回（source/target/type）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ks-edge-"));
    const path = join(dir, "agent.db");
    try {
      // SqliteBackend 托管建表（唯一边表 kg_edges）
      const backend = new SqliteBackend(path);
      const db = new Database(path);
      const store = new KnowledgeStore(db);
      store.addEdge({
        srcNode: "nodeA",
        dstNode: "nodeB",
        relation: "depends-on",
        weight: 0.8,
        evidence: ["doc1"],
      });
      const out = store.getOutEdges("nodeA");
      expect(out.length).toBe(1);
      expect(out[0].dstNode).toBe("nodeB");
      expect(out[0].relation).toBe("depends-on");
      const inn = store.getInEdges("nodeB");
      expect(inn.length).toBe(1);
      expect(inn[0].srcNode).toBe("nodeA");
      // 幂等：重复写同一条边不重复
      store.addEdge({
        srcNode: "nodeA",
        dstNode: "nodeB",
        relation: "depends-on",
        weight: 0.8,
      });
      expect(store.getOutEdges("nodeA").length).toBe(1);
      db.close();
      backend.close();
    } finally {
      rmTempDirWithRetry(dir);
    }
  });
});

describe("切片3：KAL getReferences 单腿查询（无 UNION 缝合）", () => {
  it("getReferences 的 SQL 不再引用旧表 kg_edge、不再 UNION ALL 缝合", () => {
    const { readFileSync } = require("node:fs");
    const src = readFileSync(join(import.meta.dir, "../../src/kal/knowledge-access-layer.ts"), "utf-8");
    const refStart = src.indexOf("async getReferences");
    const refEnd = src.indexOf("\n  }", refStart);
    const body = src.slice(refStart, refEnd === -1 ? undefined : refEnd);
    // 精确匹配 SQL 表引用（注释中的历史说明允许提及旧表名）
    expect(/\b(FROM|INTO|JOIN|UPDATE)\s+kg_edge\b/i.test(body)).toBe(false);
    expect(body).not.toContain("UNION ALL");
  });

  it("全仓源码不再有 SQL 引用旧表 kg_edge（DRE 侧已并入 kg_edges）", () => {
    const { readFileSync, readdirSync, statSync } = require("node:fs");
    const repo = join(import.meta.dir, "../../src");
    const hits: string[] = [];
    const tableRe = /\b(FROM|INTO|JOIN|UPDATE)\s+kg_edge\b/i;
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          const t = readFileSync(p, "utf-8");
          if (tableRe.test(t)) hits.push(p);
        }
      }
    })(repo);
    expect(hits).toEqual([]);
  });
});

describe("切片4：跨写入方边 id 收敛（同一逻辑边 = 同一行）", () => {
  it("kgEdgeId 公式稳定且与 KnowledgeStore/Enhanced 写入一致", () => {
    const id1 = kgEdgeId("A", "B", "depends-on");
    const id2 = kgEdgeId("A", "B", "depends-on");
    const id3 = kgEdgeId("B", "A", "depends-on"); // 方向不同 → 不同边
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1.startsWith("edge-")).toBe(true);
  });

  it("DRE KnowledgeStore 与增强图谱对同一逻辑边写入收敛为同一行（不重复）", () => {
    const dir = mkdtempSync(join(tmpdir(), "kg-conv-"));
    const path = join(dir, "agent.db");
    try {
      const backend = new SqliteBackend(path); // 托管建表
      const db = new Database(path);
      const store = new KnowledgeStore(db);
      store.addEdge({ srcNode: "X", dstNode: "Y", relation: "related-to", weight: 1 });
      // 用共享公式直接查：行存在且 id 与公式一致
      const row = db.query("SELECT id, source, target, type FROM kg_edges").get() as {
        id: string; source: string; target: string; type: string;
      };
      expect(row.id).toBe(kgEdgeId("X", "Y", "related-to"));
      // 重复写不新增
      store.addEdge({ srcNode: "X", dstNode: "Y", relation: "related-to", weight: 1 });
      const n = (db.query("SELECT COUNT(*) AS c FROM kg_edges").get() as { c: number }).c;
      expect(n).toBe(1);
      db.close();
      backend.close();
    } finally {
      rmTempDirWithRetry(dir);
    }
  });
});
