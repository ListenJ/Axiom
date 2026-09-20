/**
 * 切片 4：embedding 存储（同一 SQLite、换模型清账、确定性）
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  EMBEDDING_TABLE,
  ensureEmbeddingTable,
  upsertEmbedding,
  loadEmbeddings,
  countEmbeddings,
  deleteEmbeddingsForOtherModels,
} from "../../src/knowledge/embedding-store.js";

function db(): Database {
  const d = new Database(":memory:");
  ensureEmbeddingTable(d);
  return d;
}

describe("embedding 存储（切片 4）", () => {
  it("与知识表同库建表，可写入并原样读回", () => {
    const d = db();
    upsertEmbedding(d, { nodeId: "n1", model: "BAAI/bge-m3", vector: [0.1, -0.2, 0.3] }, 1000);
    const { embeddings, malformed } = loadEmbeddings(d, "BAAI/bge-m3");
    expect(malformed).toBe(0);
    expect(embeddings.get("n1")).toEqual([0.1, -0.2, 0.3]);
    d.close();
  });

  it("同 node_id 覆盖 ⇒ 重复摄取幂等（不产生第二行）", () => {
    const d = db();
    upsertEmbedding(d, { nodeId: "n1", model: "m", vector: [1, 2] }, 1);
    upsertEmbedding(d, { nodeId: "n1", model: "m", vector: [3, 4] }, 2);
    expect(countEmbeddings(d, "m")).toBe(1);
    expect(loadEmbeddings(d, "m").embeddings.get("n1")).toEqual([3, 4]);
    d.close();
  });

  it("维度随行落库；维度不符的行被计为 malformed 而非静默吞掉", () => {
    const d = db();
    upsertEmbedding(d, { nodeId: "ok", model: "m", vector: [1, 2, 3] }, 1);
    // 手工塞一条维度与内容不符的行（模拟外部损坏 / 手工写入）
    d.run(`INSERT INTO ${EMBEDDING_TABLE} (node_id, model, dim, vector, updated_at) VALUES (?,?,?,?,?)`,
      ["bad", "m", 3, JSON.stringify([1, 2]), 1]);
    const { embeddings, malformed } = loadEmbeddings(d, "m");
    expect(embeddings.size).toBe(1);
    expect(malformed).toBe(1);
    d.close();
  });

  it("换模型时清账：只保留当前模型的行，并返回删除数", () => {
    const d = db();
    upsertEmbedding(d, { nodeId: "a", model: "old-model", vector: [1] }, 1);
    upsertEmbedding(d, { nodeId: "b", model: "new-model", vector: [2] }, 1);
    expect(deleteEmbeddingsForOtherModels(d, "new-model")).toBe(1);
    expect(countEmbeddings(d, "old-model")).toBe(0);
    expect(countEmbeddings(d, "new-model")).toBe(1);
    d.close();
  });

  it("确定性：同输入写入后读回结果稳定（5 次一致）", () => {
    const d = db();
    upsertEmbedding(d, { nodeId: "n", model: "m", vector: [0.5, 0.25, 0.125] }, 7);
    const runs = Array.from({ length: 5 }, () => JSON.stringify(loadEmbeddings(d, "m").embeddings.get("n")));
    for (const r of runs) expect(r).toEqual(runs[0]);
    d.close();
  });
});
