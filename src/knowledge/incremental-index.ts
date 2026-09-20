/**
 * **增量**索引（A7 后半，2026-09-21）：把"新入库的文档"补成向量
 *
 * ## 解决什么
 * 全量索引脚本（`scripts/index-knowledge-embeddings.ts`）需要人工重跑；
 * 采集管线写完新文档后，`knowledge_embeddings` 里没有对应向量 ⇒ 语义召回漏掉新内容。
 * 本模块提供"只索引**还没索引过**的节点"这一步，供采集收尾调用。
 *
 * ## 门控顺序（默认零成本，与全量脚本同口径）
 * 1. **先看授权与路由，再碰数据库** —— 未授权（默认 `ask`）/无 embedding 路由时**直接返回**：
 *    既不调模型、**也不读库**（连语料扫描都不做）。这是"默认关闭"能真正零成本的前提。
 * 2. 已授权且解析到模型 ⇒ 才扫描语料、比对已索引集合、分批调用 embedding。
 *
 * ## 不做什么（如实边界）
 * - **不做变更检测**：只补"完全没有向量"的节点。文档被**修改**后（内容变了但 nodeId 不变）
 *   不会自动重新嵌入 —— 需重跑全量脚本（或将来引入 content_hash 比对）。这是已知取舍，不是遗漏。
 * - 不做删除同步：节点被删除后其向量行会残留（`deleteEmbeddingsForOtherModels` 只管换模型）。
 * - 不抛错：任何异常都收敛进 report 的 `error` 字段（采集管线不应因向量索引失败而失败）。
 */
import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { collectKnowledgeCorpus } from "./kb-corpus.js";
import { indexNodeEmbeddings, type IndexableNode } from "./semantic-index.js";
import type { EmbeddingConsentMode, EmbeddingsCall } from "./embedding-consent.js";

export interface IncrementalIndexDeps {
  /** 真实 embedding 调用（组合根注入，通常是 `ModelRouter.embeddings`） */
  embeddings: EmbeddingsCall;
  /** 模型标签解析（组合根注入：`() => embeddingModelTagOf(findModelsForRole("embedding"))`） */
  resolveModelTag: () => string | null;
  /** 授权状态解析（通常是 `resolveEmbeddingConsent`） */
  consent: () => EmbeddingConsentMode;
  /** 每次 embedding 调用携带多少条文本（默认 32） */
  batchSize?: number;
  /** 每个知识表最多扫描多少行（默认 5000，与全量脚本一致） */
  limitPerStore?: number;
  /**
   * 写入向量行的 `updated_at` 时间戳。**由调用方注入**（不在此处调 `Date.now()`）：
   * 与本仓库既有约定一致（`indexNodeEmbeddings({now})`）—— 让"时间来源"留在组合根，
   * 本模块保持无时钟、可复现，也就不必进 LIMITATIONS §5 的不确定性披露表。
   */
  now: number;
}

/** 本次未做索引的**显式原因**（不静默跳过） */
export type IncrementalIndexSkipReason = "not-authorized" | "no-route" | "nothing-to-index";

export interface IncrementalIndexReport {
  /** 解析到的模型标签（未解析到时为 null） */
  model: string | null;
  /** 本次扫描到的语料条数（0 = 未扫描/空库） */
  corpusSize: number;
  /** 语料中已有当前模型向量的条数 */
  alreadyIndexed: number;
  /** 本次送去嵌入的条数 */
  attempted: number;
  /** 成功写入的条数 */
  indexed: number;
  /** 未写入的条数（维度不符/返回为空） */
  failed: number;
  /** 写入向量的维度（无写入时 0） */
  dim: number;
  /** 非空 = 本次没有索引任何东西，以及为什么 */
  skipped?: IncrementalIndexSkipReason;
  /** 语料采集层面的不完整信号（触顶 / 表缺失），供调用方上报 */
  corpusIssues: string[];
  /** 未预期错误的可读原因（非空即本次未完成；不抛给调用方） */
  error?: string;
}

const DEFAULT_BATCH_SIZE = 32;

function baseReport(model: string | null): IncrementalIndexReport {
  return { model, corpusSize: 0, alreadyIndexed: 0, attempted: 0, indexed: 0, failed: 0, dim: 0, corpusIssues: [] };
}

/** 读出"当前模型已索引"的 nodeId 集合。表不存在（老库/首次）⇒ 空集合，不算错误。 */
export function loadIndexedNodeIds(db: Database, model: string): Set<string> {
  try {
    const rows = db
      .query(`SELECT node_id FROM knowledge_embeddings WHERE model = ?`)
      .all(model) as Array<{ node_id: string }>;
    return new Set(rows.map((r) => r.node_id));
  } catch {
    return new Set();
  }
}

/** 纯函数：挑出**还没有向量**的节点（保序，便于测试与复现） */
export function selectUnindexedNodes(
  nodes: readonly IndexableNode[],
  indexedIds: ReadonlySet<string>,
): IndexableNode[] {
  return nodes.filter((n) => !indexedIds.has(n.nodeId));
}

/**
 * 跑一次增量索引。**不抛错**；门控未过时连库都不读。
 */
export async function runIncrementalIndex(
  db: Database,
  deps: IncrementalIndexDeps,
): Promise<IncrementalIndexReport> {
  // ── 门 1/2：先判授权与路由（在碰数据库之前）──
  let model: string | null = null;
  try {
    model = deps.resolveModelTag();
  } catch (err) {
    return { ...baseReport(null), error: `resolveModelTag failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (deps.consent() !== "yes") return { ...baseReport(model), skipped: "not-authorized" };
  if (!model) return { ...baseReport(null), skipped: "no-route" };

  // ── 门 3 已过：现在才读库 ──
  try {
    const corpus = collectKnowledgeCorpus(db, {
      ...(deps.limitPerStore ? { limitPerStore: deps.limitPerStore } : {}),
    });
    const corpusIssues: string[] = [];
    let storesWithError = 0;
    for (const store of ["vault", "kg", "dre"] as const) {
      const s = corpus.perStore[store];
      if (s.truncated) corpusIssues.push(`${store}:truncated`);
      if (s.error) {
        corpusIssues.push(`${store}:error:${s.error}`);
        storesWithError++;
      }
    }

    const indexedIds = loadIndexedNodeIds(db, model);
    const pending = selectUnindexedNodes(corpus.nodes, indexedIds);

    const report: IncrementalIndexReport = {
      ...baseReport(model),
      corpusSize: corpus.nodes.length,
      alreadyIndexed: corpus.nodes.length - pending.length,
      corpusIssues,
    };
    // 三个存储**全都读失败** ⇒ 不是"库是空的"，而是"库不可用"（句柄关闭/库结构不符）。
    // 必须报错而不是伪装成 nothing-to-index —— 否则调用方会把"索引彻底没跑"当成"已经是最新"。
    if (storesWithError === 3) {
      const msg = `corpus unreadable (all 3 stores failed): ${corpusIssues.join("; ")}`;
      logger.warn("[IncrementalIndex] corpus unreadable", { error: msg });
      return { ...report, error: msg };
    }
    if (pending.length === 0) return { ...report, skipped: "nothing-to-index" };

    const batchSize = deps.batchSize && deps.batchSize > 0 ? Math.floor(deps.batchSize) : DEFAULT_BATCH_SIZE;
    let indexed = 0;
    let failed = 0;
    let dim = 0;
    for (let i = 0; i < pending.length; i += batchSize) {
      const stats = await indexNodeEmbeddings(
        { db, embedder: deps.embeddings, model, now: deps.now },
        pending.slice(i, i + batchSize),
      );
      indexed += stats.indexed;
      failed += stats.failed;
      if (stats.dim > 0) dim = stats.dim;
    }
    return { ...report, attempted: pending.length, indexed, failed, dim };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("[IncrementalIndex] failed", { error: msg });
    return { ...baseReport(model), error: msg };
  }
}

/**
 * **推送式**索引：写入方把"我刚写了这几条"交给本函数，只索引这几条。
 *
 * 与 `runIncrementalIndex`（扫全库补缺口）的区别与取舍：
 * - 推送式**精确**：不扫库、不会因为库里有大量历史未索引条目而**意外产生巨额 token 消耗**；
 *   且写入方知道内容 ⇒ **文档被修改**（内容变、nodeId 不变）也能重新嵌入（覆盖式 upsert）。
 * - 扫描式**兜底**：用于采集管线收尾/人工重跑，能补齐任何"推送时漏掉"的条目（例如进程在
 *   写库后、嵌入前退出）。
 * 两者是互补关系，**都需要保留**；调用方按场景选。
 *
 * 门控与 `runIncrementalIndex` 一致：未授权 / 无路由 ⇒ **不碰数据库、不调模型**，直接返回。
 * 同样**不抛错**（写入路径不应因向量索引失败而失败）。
 */
export async function indexFreshNodes(
  db: Database,
  nodes: readonly IndexableNode[],
  deps: IncrementalIndexDeps,
): Promise<IncrementalIndexReport> {
  let model: string | null = null;
  try {
    model = deps.resolveModelTag();
  } catch (err) {
    return { ...baseReport(null), error: `resolveModelTag failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (deps.consent() !== "yes") return { ...baseReport(model), skipped: "not-authorized" };
  if (!model) return { ...baseReport(null), skipped: "no-route" };
  if (nodes.length === 0) return { ...baseReport(model), skipped: "nothing-to-index" };

  try {
    const batchSize = deps.batchSize && deps.batchSize > 0 ? Math.floor(deps.batchSize) : DEFAULT_BATCH_SIZE;
    let indexed = 0;
    let failed = 0;
    let dim = 0;
    for (let i = 0; i < nodes.length; i += batchSize) {
      const stats = await indexNodeEmbeddings(
        { db, embedder: deps.embeddings, model, now: deps.now },
        nodes.slice(i, i + batchSize),
      );
      indexed += stats.indexed;
      failed += stats.failed;
      if (stats.dim > 0) dim = stats.dim;
    }
    return { ...baseReport(model), corpusSize: nodes.length, attempted: nodes.length, indexed, failed, dim };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("[IncrementalIndex] fresh-node index failed", { error: msg });
    return { ...baseReport(model), error: msg };
  }
}
