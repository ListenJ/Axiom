/**
 * 知识库语义层 **拼装**（切片 4/5）：词法分 + 语义候选 → 确定性排序
 *
 * ## 这一层做什么
 * 把已就位的三块零件接起来：
 *   1. `createConsentedEmbedder()` —— 授权门；未授权 ⇒ `null` ⇒ **零网络请求**；
 *   2. embedding 计算（真实实现 = `ModelRouter.embeddings()`，由调用方注入）；
 *   3. `rankWithSemanticRecall()` —— 语义**只做候选召回** + 稳定 tie-breaker。
 *
 * ## 明确的降级语义（不得静默）
 * - `embedder === null`（未授权）→ **纯词法**，且**一次都不调用**；
 * - embedder 抛错 / 返回空数组（限流、网络失败）→ **纯词法降级**；
 * - 余弦低于阈值 → 该条不进入语义候选（阈值是**具名常量**，非魔法数）。
 *
 * ## 确定性
 * 余弦用共享实现 `src/utils/math.ts` 的 `cosineSimilarity`（**不手写第二份**）；
 * 最终排序完全交给 `rankWithSemanticRecall`（score desc, id 码元升序）。本模块不读时钟、不写库。
 */
import { cosineSimilarity } from "../utils/math.js";
import { rankWithSemanticRecall, type RecallItem, type RankedRecall, type SemanticCandidate } from "./semantic-recall.js";
import type { EmbeddingsCall } from "./embedding-consent.js";

/** 语义候选的最低余弦相似度。取值理由：低于此值的"相似"在 bge-m3 上多为噪声，拉进候选反而降低精度。 */
export const SEMANTIC_MIN_SIMILARITY = 0.5;

export interface SemanticQueryOptions {
  query: string;
  items: readonly RecallItem[];
  /** 词法腿得分（FTS5/BM25/关键词），由调用方注入 */
  lexicalScore?: (item: RecallItem) => number;
  /** 授权后的 embedder；`null` = 未授权 ⇒ 纯词法且零调用 */
  embedder: EmbeddingsCall | null;
  limit?: number;
}

export interface SemanticQueryOutcome {
  results: RankedRecall[];
  /** 本次是否真的用了语义（供调用方披露/观测；未授权或降级时为 false） */
  semanticUsed: boolean;
}

/**
 * 执行一次知识查询：先算语义候选（若已授权），再交给确定性排序。
 */
export async function queryKnowledgeSemantically(opts: SemanticQueryOptions): Promise<SemanticQueryOutcome> {
  const lexicalOnly = rankWithSemanticRecall({
    items: opts.items,
    ...(opts.lexicalScore ? { lexicalScore: opts.lexicalScore } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
  });

  // 未授权：**直接返回纯词法**，绝不触达 embedder
  if (!opts.embedder) return { results: lexicalOnly, semanticUsed: false };
  if (opts.items.length === 0) return { results: lexicalOnly, semanticUsed: false };

  const texts = [opts.query, ...opts.items.map((it) => it.content)];
  const vectors = await opts.embedder(texts);
  // 失败/降级（空数组或长度不符）→ 纯词法
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    return { results: lexicalOnly, semanticUsed: false };
  }
  const queryVec = vectors[0]!;
  if (!Array.isArray(queryVec) || queryVec.length === 0) {
    return { results: lexicalOnly, semanticUsed: false };
  }

  const candidates: SemanticCandidate[] = [];
  for (let i = 0; i < opts.items.length; i++) {
    const vec = vectors[i + 1]!;
    if (!Array.isArray(vec) || vec.length !== queryVec.length) continue;
    const sim = cosineSimilarity(queryVec, vec);
    if (Number.isFinite(sim) && sim >= SEMANTIC_MIN_SIMILARITY) {
      candidates.push({ id: opts.items[i]!.id, score: sim });
    }
  }

  const results = rankWithSemanticRecall({
    items: opts.items,
    ...(opts.lexicalScore ? { lexicalScore: opts.lexicalScore } : {}),
    semanticCandidates: candidates,
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
  // semanticUsed 只在**确有候选被采纳**时为 true，避免"调了但没起作用"被当成用过
  const usedIds = new Set(results.filter((r) => r.reasons.includes("semantic")).map((r) => r.id));
  return { results, semanticUsed: usedIds.size > 0 };
}
