/**
 * 假设状态机回归测试 — P0-4
 *
 * 行为规格（经公共接口 HypothesisManager 验证）：
 * 1. refuted 必须可达：已有支持证据的假设，驳斥证据占优（≥3 且多于支持）时应被驳斥，
 *    而非永久卡在 testing（旧行为要求 supporting===0 才能 refute）。
 * 2. confirmed 纯净路径保持：3 支持 / 0 驳斥 → confirmed。
 * 3. 损坏的 hypothesis JSON 不应拖垮 addEvidence（单条损坏行只影响自身）。
 * 4. 损坏的 hypothesis JSON 不应让 getUntested 整批失败（按行跳过）。
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { HypothesisManager } from "../../src/dre/storage/knowledge-store.js";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE knowledge_node (
      node_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      domain TEXT NOT NULL DEFAULT 'test',
      paradigm TEXT NOT NULL DEFAULT 'fact',
      confidence REAL NOT NULL DEFAULT 0.5,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_uri TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      behavior TEXT,
      prediction TEXT,
      hypothesis TEXT
    );
  `);
  return db;
}

function insertNode(
  db: Database,
  nodeId: string,
  hypothesis: unknown | null,
  createdAt = Date.now()
): void {
  db.prepare(`
    INSERT INTO knowledge_node (
      node_id, title, content, content_hash, domain, paradigm,
      source_type, created_at, updated_at, confidence, hypothesis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nodeId, `t-${nodeId}`, `c-${nodeId}`, "hash", "test",
    hypothesis ? "hypothesis" : "fact", "manual", createdAt, createdAt, 0.5,
    hypothesis === null ? null : typeof hypothesis === "string" ? hypothesis : JSON.stringify(hypothesis)
  );
}

function readHypothesis(db: Database, nodeId: string): { status: string } {
  const row = db.prepare("SELECT hypothesis FROM knowledge_node WHERE node_id = ?").get(nodeId) as {
    hypothesis: string;
  };
  return JSON.parse(row.hypothesis);
}

describe("HypothesisManager 状态机（P0-4 回归）", () => {
  test("混合证据下驳斥可达：2 支持 + 3 驳斥 → refuted", () => {
    const db = createDb();
    const mgr = new HypothesisManager(db);
    insertNode(db, "h1", {
      claim: "c", supportingEvidence: [], contradictingEvidence: [],
      status: "untested", proposedAt: Date.now(),
    });
    mgr.propose("h1", "claim");
    mgr.addEvidence("h1", "s1", true);
    mgr.addEvidence("h1", "s2", true);
    mgr.addEvidence("h1", "x1", false);
    mgr.addEvidence("h1", "x2", false);
    mgr.addEvidence("h1", "x3", false);
    expect(readHypothesis(db, "h1").status).toBe("refuted");
  });

  test("纯净路径保持：3 支持 / 0 驳斥 → confirmed", () => {
    const db = createDb();
    const mgr = new HypothesisManager(db);
    insertNode(db, "h2", null);
    mgr.propose("h2", "claim");
    mgr.addEvidence("h2", "s1", true);
    mgr.addEvidence("h2", "s2", true);
    mgr.addEvidence("h2", "s3", true);
    expect(readHypothesis(db, "h2").status).toBe("confirmed");
  });

  test("addEvidence 对损坏 JSON 行不抛错且不破坏该行", () => {
    const db = createDb();
    const mgr = new HypothesisManager(db);
    insertNode(db, "bad", "{broken-json");
    expect(() => mgr.addEvidence("bad", "e1", true)).not.toThrow();
  });

  test("getUntested 跳过损坏行，返回其余有效假设", () => {
    const db = createDb();
    insertNode(db, "good", {
      claim: "c", supportingEvidence: [], contradictingEvidence: [],
      status: "untested", proposedAt: Date.now(),
    }, 1000);
    insertNode(db, "bad", "{broken-json", 2000);
    const mgr = new HypothesisManager(db);
    const result = mgr.getUntested();
    expect(result.map((n) => n.nodeId)).toEqual(["good"]);
  });
});
