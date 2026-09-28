/**
 * 可选语义层（"一部分向量化"）——确定性检索的增强，不是替代。
 *
 * 纪律（与 src/core/settings-search.ts 同款、README:282 "余弦仅可选语义层"同口径）：
 *  - 默认关闭，`MEMORY_SEMANTIC_SEARCH=1` 显式开启；embedding 端点缺失/失败 ⇒ 返回 null
 *    ⇒ 调用方 fail-open 回纯关键词路径，确定性承诺不被破坏；
 *  - 向量按 (model, text) 哈希缓存进 agent.db（embeddings_cache），写一次反复用；
 *  - 余弦用共享 cosineSimilarity；同模型同文本同硬件下推理确定（与 Laya N=5 同类证据口径）；
 *  - 批量嵌入分块（CHUNK）且首块失败即停（端点宕机时不做 N×5s 的无谓等待）。
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { cosineSimilarity } from "../utils/math.js";
import { getEdgeEmbeddings, getEdgeEmbedModel } from "../local-llm/edge-embeddings.js";
import { readBool, readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

export type SemanticEmbedder = (texts: string[]) => Promise<number[][] | null>;

export function isSemanticSearchEnabled(): boolean {
  return readBool("MEMORY_SEMANTIC_SEARCH", false);
}

/** 生产 embedder：edge-embeddings（BAAI/bge-m3，本地端点），失败返回 null 由调用方降级 */
export const edgeEmbedder: SemanticEmbedder = (texts) => getEdgeEmbeddings(texts);

const CHUNK = 32;
const EMBED_TEXT_MAX = 4000;

function vecHash(model: string, text: string): string {
  return createHash("sha1").update(model).update("\u0000").update(text).digest("hex");
}

function packVector(v: number[]): Uint8Array {
  const arr = new Float32Array(v);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function unpackVector(b: Uint8Array): number[] {
  return Array.from(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
}

export interface SemanticHit {
  path: string;
  score: number;
}

export class SemanticLayer {
  private schemaReady = false;

  constructor(private db: Database) {}

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS embeddings_cache (
        hash TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.schemaReady = true;
  }

  /** 批量嵌入 + 缓存：先查缓存，缺的 分块 请求 embedder；任一块返回 null（端点不可用）即停止后续块。 */
  async embedWithCache(texts: string[], embedder: SemanticEmbedder): Promise<Map<string, number[]>> {
    this.ensureSchema();
    const model = getEdgeEmbedModel();
    const map = new Map<string, number[]>();
    const missing: Array<{ hash: string; text: string }> = [];
    for (const t of texts) {
      const clipped = t.length > EMBED_TEXT_MAX ? t.slice(0, EMBED_TEXT_MAX) : t;
      const h = vecHash(model, clipped);
      const row = this.db.query("SELECT vector FROM embeddings_cache WHERE hash = ?").get(h) as { vector: Uint8Array } | null;
      if (row) map.set(h, unpackVector(row.vector));
      else missing.push({ hash: h, text: clipped });
    }
    if (missing.length === 0) return map;

    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO embeddings_cache (hash, model, dim, vector, updated_at) VALUES (?,?,?,?,?)",
    );
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      const vectors = await embedder(chunk.map(m => m.text));
      if (!vectors) {
        // 端点不可用：fail-open。首块即失败则没有继续分块的意义（避免 N×timeout）。
        if (i === 0) logger.debug("[semantic] embedding endpoint unavailable; cache-only mode");
        break;
      }
      const now = new Date().toISOString();
      chunk.forEach((m, j) => {
        const v = vectors[j];
        if (!Array.isArray(v) || v.length === 0) return;
        ins.run(m.hash, model, v.length, packVector(v), now);
        map.set(m.hash, v);
      });
    }
    return map;
  }

  /**
   * 对 memory_notes 的 content 做向量检索：query 向量 × 全库缓存余弦，降阈值取 top-k。
   * 首次调用会对全库做一次性批量嵌入（此后走缓存）。
   */
  async rank(query: string, k: number, embedder: SemanticEmbedder): Promise<SemanticHit[]> {
    const notes = this.db.query("SELECT path, content FROM memory_notes").all() as Array<{ path: string; content: string }>;
    if (notes.length === 0) return [];
    const model = getEdgeEmbedModel();

    const queryVecs = await this.embedWithCache([query], embedder);
    const q = queryVecs.get(vecHash(model, query.length > EMBED_TEXT_MAX ? query.slice(0, EMBED_TEXT_MAX) : query));
    if (!q || q.length === 0) return [];

    const contents = notes.map(n => n.content);
    const vecs = await this.embedWithCache(contents, embedder);

    const threshold = Number(readString("MEMORY_SEMANTIC_THRESHOLD", "0.2"));
    const hits: SemanticHit[] = [];
    for (let i = 0; i < notes.length; i++) {
      const v = vecs.get(vecHash(model, contents[i].length > EMBED_TEXT_MAX ? contents[i].slice(0, EMBED_TEXT_MAX) : contents[i]));
      if (!v || v.length !== q.length) continue;
      const score = cosineSimilarity(q, v);
      if (score >= threshold) hits.push({ path: notes[i].path, score });
    }
    hits.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path));
    return hits.slice(0, k);
  }
}
