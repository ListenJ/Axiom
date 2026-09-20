/**
 * 知识库 embedding 存储（知识库语义层计划 · 切片 4）
 *
 * ## 裁定依据
 * - **D4**：向量存在**同一个 SQLite**（新增表），**不引入向量库依赖**；
 * - `embedding 来源`：SiliconFlow `BAAI/bge-m3`（**仅开发/测试用**，不作为发布的一部分）；
 *   故本模块只负责"存/取"，**不关心**向量从哪来 —— 生产是否启用由授权门与配置决定。
 *
 * ## 为什么要存 `model` 与 `dim`
 * 换模型（或模型版本变了）时，旧向量**与新向量不可比**；把 `model`/`dim` 随行落库，
 * 就能在换模型时**按 model 过滤**、并把其它模型的旧行**清账**（避免"混用两种模型的向量"这种静默错误）。
 *
 * ## 确定性
 * 向量以 **JSON 文本**存储（而非二进制浮点块）：JSON 的数字序列化在 JS 里是稳定的，
 * 且**可读、可对比**。本模块所有函数**不读时钟** —— 时间由调用方经 `now` 传入。
 */
import type { Database } from "bun:sqlite";

export const EMBEDDING_TABLE = "knowledge_embeddings";

export interface EmbeddingInput {
  nodeId: string;
  model: string;
  vector: number[];
}

export interface LoadedEmbedding {
  nodeId: string;
  model: string;
  dim: number;
  vector: number[];
}

/** 建表（幂等）。与知识表同库 ⇒ 满足 D4"同一个 SQLite"。 */
export function ensureEmbeddingTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ${EMBEDDING_TABLE} (
      node_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_model ON ${EMBEDDING_TABLE}(model)`);
}

/**
 * 写入/覆盖一条向量（同 node_id 覆盖 ⇒ 重复摄取幂等）。
 * `now` 由调用方传入（本模块不读时钟）。
 */
export function upsertEmbedding(db: Database, input: EmbeddingInput, now: number): void {
  db.run(
    `INSERT INTO ${EMBEDDING_TABLE} (node_id, model, dim, vector, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       model = excluded.model,
       dim = excluded.dim,
       vector = excluded.vector,
       updated_at = excluded.updated_at`,
    [input.nodeId, input.model, input.vector.length, JSON.stringify(input.vector), now],
  );
}

/** 读回某模型下的全部向量（JSON 解析失败的行**跳过并计数**，不抛错、不静默）。 */
export function loadEmbeddings(db: Database, model: string): {
  embeddings: Map<string, number[]>;
  malformed: number;
} {
  const rows = db
    .query(`SELECT node_id, dim, vector FROM ${EMBEDDING_TABLE} WHERE model = ?`)
    .all(model) as Array<{ node_id: string; dim: number; vector: string }>;

  const embeddings = new Map<string, number[]>();
  let malformed = 0;
  for (const r of rows) {
    try {
      const v = JSON.parse(r.vector) as unknown;
      if (!Array.isArray(v) || v.length !== r.dim) {
        malformed++;
        continue;
      }
      embeddings.set(r.node_id, v as number[]);
    } catch {
      malformed++;
    }
  }
  return { embeddings, malformed };
}

export function countEmbeddings(db: Database, model: string): number {
  const row = db
    .query(`SELECT COUNT(*) AS c FROM ${EMBEDDING_TABLE} WHERE model = ?`)
    .get(model) as { c: number };
  return row?.c ?? 0;
}

/**
 * 清掉"非当前模型"的旧行 —— 换模型时的清账动作，避免两种模型的向量混用。
 * 返回删除行数（便于上报，不静默）。
 */
export function deleteEmbeddingsForOtherModels(db: Database, keepModel: string): number {
  const before = (db.query(`SELECT COUNT(*) AS c FROM ${EMBEDDING_TABLE}`).get() as { c: number }).c;
  db.run(`DELETE FROM ${EMBEDDING_TABLE} WHERE model != ?`, [keepModel]);
  const after = (db.query(`SELECT COUNT(*) AS c FROM ${EMBEDDING_TABLE}`).get() as { c: number }).c;
  return Math.max(0, before - after);
}
