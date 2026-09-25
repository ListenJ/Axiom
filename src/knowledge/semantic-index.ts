/**
 * 语义索引的**写入腿**与**查询腿**（知识库语义层计划 · 切片 4 剩余部分）
 *
 * ## 为什么两层分开
 * 上一轮（`semantic-recall.ts` / `semantic-layer.ts`）只做了"给定候选如何排序"，
 * 但**没有东西往 `knowledge_embeddings` 表里写**，也没有东西从表里读回来做召回 ——
 * 那会让向量存储变成"有形状无行为"。本模块补的正是这两条腿：
 *   - 写入腿 `indexNodeEmbeddings()`：语料 → embedder → `knowledge_embeddings`；
 *   - 查询腿 `recallBySimilarity()`：query → embedder → 逐行余弦 → **候选**（不决定最终排序）。
 *
 * ## 授权门（D1/D5）在**调用方**，不在本模块
 * 本模块接受 `EmbeddingsCall | null`：`null` ⇒ **不做任何调用**、不写不读向量、返回零结果。
 * 真正的闸门是 `createConsentedEmbedder()`（未授权返回 null）——本模块不重复实现它，
 * 也不 import 网络层（依赖注入，rule 8）。
 *
 * ## 确定性（D3）
 * - 候选排序键 **(score desc, node_id 码元升序)**，id 比较用 `<`/`>`（不用 `localeCompare`）；
 * - `loadEmbeddings` 返回 `Map`，但**排序不依赖遍历顺序**（显式 sort）；
 * - 本模块**不读时钟**：写入时间由调用方经 `now` 传入。
 *
 * ## 边界（如实声明，非"应该没问题"）
 * - 查询腿是**全表暴力余弦**（O(语料规模 × 维度)），适用于本项目知识库量级；
 *   语料上万条时须换 ANN 索引 —— 届时是**新决策**（D4 裁定"不引入向量库依赖"，故本轮不做）。
 * - 语料为空 / embedder 失败 / 维度不符 ⇒ **降级为"无候选"并由返回值显式报数**，不抛错、不静默。
 */
import type { Database } from "bun:sqlite";
import { cosineSimilarity } from "../utils/math.js";
import { EMBEDDING_TABLE, ensureEmbeddingTable, loadEmbeddings, upsertEmbedding } from "./embedding-store.js";
import type { SemanticCandidate } from "./semantic-recall.js";
import { SEMANTIC_MIN_SIMILARITY } from "./semantic-layer.js";
import type { EmbeddingsCall } from "./embedding-consent.js";

export interface IndexableNode {
  nodeId: string;
  /** 参与嵌入的文本（调用方决定用标题/摘要/正文，本模块不猜） */
  content: string;
}

export interface IndexStats {
  /** 成功写入的向量条数 */
  indexed: number;
  /** 未写入的条数（embedder 失败 / 维度不符 / 空向量）—— 显式报数，不静默 */
  failed: number;
  /** 写入向量的维度（无写入时为 0） */
  dim: number;
  /** 本次使用的模型标识（写进表里，供换模型清账用） */
  model: string;
}

export interface RecallOutcome {
  candidates: SemanticCandidate[];
  /** 扫描到的已存向量条数 */
  scanned: number;
  /** JSON 解析失败/维度不符而被跳过的行数（`embedding-store` 报的） */
  malformed: number;
  /** 是否真的产出了候选（false = 调用方应走纯词法） */
  used: boolean;
  /** 读表失败等原因（如旧库无该表）；非空即为显式降级原因 */
  error?: string;
}

/**
 * 写入腿：把一批节点嵌入并落库（**幂等** —— 同 nodeId 覆盖，重复摄取不产生第二行）。
 */
export async function indexNodeEmbeddings(
  deps: { db: Database; embedder: EmbeddingsCall | null; model: string; now: number },
  nodes: readonly IndexableNode[],
): Promise<IndexStats> {
  const empty: IndexStats = { indexed: 0, failed: 0, dim: 0, model: deps.model };
  // 未授权 / 无语料 ⇒ 零调用（不建表、不写库），保持"未授权即零副作用"
  if (!deps.embedder || nodes.length === 0) return empty;

  // 写入腿拥有 schema：一旦走到这里（已授权且有待索引语料），表就该存在 —— 无论本次是否写成功。
  ensureEmbeddingTable(deps.db);

  let vectors: number[][];
  try {
    vectors = await deps.embedder(nodes.map((n) => n.content));
  } catch {
    // embedder 实现本身若抛错（本项目的包装层已兜住，但直接注入的假实现可能抛）
    return { ...empty, failed: nodes.length };
  }
  if (!Array.isArray(vectors) || vectors.length !== nodes.length) {
    return { ...empty, failed: nodes.length };
  }

  let indexed = 0;
  let failed = 0;
  let dim = 0;
  for (let i = 0; i < nodes.length; i++) {
    const v = vectors[i];
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => Number.isFinite(x))) {
      failed++;
      continue;
    }
    if (dim === 0) dim = v.length;
    if (v.length !== dim) {
      // 同一次调用里的维度不一致 ⇒ 说明 embedder 不可信，整条不写（避免混维度入库）
      failed++;
      continue;
    }
    upsertEmbedding(deps.db, { nodeId: nodes[i].nodeId, model: deps.model, vector: v }, deps.now);
    indexed++;
  }
  return { indexed, failed, dim: indexed > 0 ? dim : 0, model: deps.model };
}

/**
 * 查询腿：把 query 嵌入，与**已落库的全部向量**逐行算余弦，产出候选（top-K）。
 *
 * 注意：候选的 score 是**余弦**，与词法分（BM25 等）尺度不同 —— 故调用方必须把候选交给
 * `rankWithSemanticRecall()`（取 max + 稳定 tie-breaker），**不得**直接用 cosine 混排。
 */
export async function recallBySimilarity(
  deps: {
    db: Database;
    embedder: EmbeddingsCall | null;
    model: string;
    query: string;
    minSimilarity?: number;
    topK?: number;
  },
): Promise<RecallOutcome> {
  const none: RecallOutcome = { candidates: [], scanned: 0, malformed: 0, used: false };
  if (!deps.embedder) return none;

  let loaded: { embeddings: Map<string, number[]>; malformed: number };
  try {
    ensureTableForRead(deps.db);
    loaded = loadEmbeddings(deps.db, deps.model);
  } catch (e) {
    return { ...none, error: (e as Error).message };
  }
  const scanned = loaded.embeddings.size;
  if (scanned === 0) return { candidates: [], scanned: 0, malformed: loaded.malformed, used: false };

  let vectors: number[][];
  try {
    vectors = await deps.embedder([deps.query]);
  } catch {
    return { candidates: [], scanned, malformed: loaded.malformed, used: false };
  }
  const qv = Array.isArray(vectors) ? vectors[0] : undefined;
  if (!Array.isArray(qv) || qv.length === 0) {
    return { candidates: [], scanned, malformed: loaded.malformed, used: false };
  }

  const threshold = deps.minSimilarity ?? SEMANTIC_MIN_SIMILARITY;
  const candidates: SemanticCandidate[] = [];
  for (const [nodeId, vec] of loaded.embeddings) {
    if (vec.length !== qv.length) continue;
    const sim = cosineSimilarity(qv, vec);
    if (Number.isFinite(sim) && sim >= threshold) candidates.push({ id: nodeId, score: sim });
  }

  // D3：同分按 node_id 码元升序（`<`/`>`，不用 localeCompare）⇒ 与 Map 遍历顺序无关
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const topK = deps.topK && deps.topK > 0 ? Math.floor(deps.topK) : candidates.length;
  const sliced = candidates.slice(0, topK);
  return {
    candidates: sliced,
    scanned,
    malformed: loaded.malformed,
    used: sliced.length > 0,
  };
}
/**
 * 查询腿的建表策略：只在**表确实缺失**时建（先读 `sqlite_master`，避免每查询一次 DDL 写事务）。
 * 旧库（引入本表之前建立的 SQLite）走这条路径；新库在写入腿就已建好。
 */
function ensureTableForRead(db: Database): void {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(EMBEDDING_TABLE);
  if (!row) ensureEmbeddingTable(db);
}
