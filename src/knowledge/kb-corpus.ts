/**
 * 知识库**索引语料**采集（A7，2026-09-21）
 *
 * 把三个知识表里的文本取成"可嵌入"的 `{nodeId, content}` 列表，供
 * `indexNodeEmbeddings()` 写进 `knowledge_embeddings`。
 *
 * ## nodeId 必须与 KAL **逐字节一致**（否则写了也召不回）
 * - vault：`createNodeId("vault","note",path)`
 * - kg：`kg_nodes.id` **原样**（审计 M14：库里已是完整 node_id，切勿二次加前缀）
 * - dre：`createNodeId("dre", domain, node_id)`
 * 这三条口径与 `KnowledgeAccessLayer` 的查询/物化完全同源（同一个 `createNodeId`），
 * 并由 `tests/unit/kb-corpus-kal-roundtrip.test.ts` 做**往返守卫**防止漂移。
 *
 * ## 边界（如实声明，不静默）
 * - 每个表都有 `ORDER BY <确定性键>` + `LIMIT`（默认 5000），**确定性**且内存有界；
 *   触顶时该 store 记 `truncated: true` —— 调用方必须把"没索引完"这件事报出来。
 * - 表不存在/查询失败 ⇒ 记 `error` 并返回已取到的部分，**不抛**（旧库/裁剪库兼容）。
 * - 空文本条目**跳过并计数**（`skipped`），不产生"空向量"。
 */
import type { Database } from "bun:sqlite";
import { vaultNoteNodeId, dreKnowledgeNodeId } from "../kal/knowledge-node-id.js";
import { logger } from "../utils/logger.js";
import type { IndexableNode } from "./semantic-index.js";

export type CorpusStore = "vault" | "kg" | "dre";

export interface CorpusStoreStats {
  /** 实际写入语料的条数 */
  collected: number;
  /** 是否因 `limitPerStore` 触顶而**还有未采集的行**（true 表示本次索引不完整） */
  truncated: boolean;
  /** 文本为空被跳过的条数 */
  skipped: number;
  /** 表缺失/查询失败的原因（非空即该 store 采集不完整） */
  error?: string;
}

export interface CorpusCollection {
  nodes: IndexableNode[];
  perStore: Record<CorpusStore, CorpusStoreStats>;
  /** 采集上限（调用方可见，便于判断 truncated 的含义） */
  limitPerStore: number;
}

export interface CollectCorpusOptions {
  /** 每个表最多取多少行（默认 5000；确定性取前 N 行） */
  limitPerStore?: number;
}

const DEFAULT_LIMIT_PER_STORE = 5000;

function emptyStats(): CorpusStoreStats {
  return { collected: 0, truncated: false, skipped: 0 };
}

export function collectKnowledgeCorpus(db: Database, opts: CollectCorpusOptions = {}): CorpusCollection {
  const limitPerStore = opts.limitPerStore && opts.limitPerStore > 0 ? Math.floor(opts.limitPerStore) : DEFAULT_LIMIT_PER_STORE;
  const nodes: IndexableNode[] = [];
  const perStore: Record<CorpusStore, CorpusStoreStats> = {
    vault: emptyStats(),
    kg: emptyStats(),
    dre: emptyStats(),
  };

  const take = (store: CorpusStore, nodeId: string, text: string) => {
    const content = text.trim();
    if (content.length === 0) {
      perStore[store].skipped++;
      return;
    }
    nodes.push({ nodeId, content });
    perStore[store].collected++;
  };

  /** 触顶判定：多取一行即可知道"是否还有剩余"，无需 COUNT(*) 全表扫 */
  const probeLimit = limitPerStore + 1;

  // ① Vault（memory_notes）
  try {
    const rows = db
      .query(`SELECT path, title, content FROM memory_notes ORDER BY id ASC LIMIT ?`)
      .all(probeLimit) as Array<{ path: string; title: string; content: string }>;
    const slice = rows.slice(0, limitPerStore);
    perStore.vault.truncated = rows.length > limitPerStore;
    for (const r of slice) take("vault", vaultNoteNodeId(r.path), `${r.title ?? ""} ${r.content ?? ""}`);
  } catch (err) {
    perStore.vault.error = err instanceof Error ? err.message : String(err);
    logger.debug("[kb-corpus] vault collection degraded", { error: perStore.vault.error });
  }

  // ② KG（kg_nodes）：id 即完整 node_id，原样使用
  try {
    const rows = db
      .query(`SELECT id, name, description FROM kg_nodes ORDER BY id ASC LIMIT ?`)
      .all(probeLimit) as Array<{ id: string; name: string; description: string }>;
    const slice = rows.slice(0, limitPerStore);
    perStore.kg.truncated = rows.length > limitPerStore;
    for (const r of slice) take("kg", r.id, `${r.name ?? ""} ${r.description ?? ""}`);
  } catch (err) {
    perStore.kg.error = err instanceof Error ? err.message : String(err);
    logger.debug("[kb-corpus] kg collection degraded", { error: perStore.kg.error });
  }

  // ③ DRE（knowledge_node）
  try {
    const rows = db
      .query(`SELECT node_id, domain, title, content FROM knowledge_node ORDER BY node_id ASC LIMIT ?`)
      .all(probeLimit) as Array<{ node_id: string; domain: string; title: string; content: string }>;
    const slice = rows.slice(0, limitPerStore);
    perStore.dre.truncated = rows.length > limitPerStore;
    for (const r of slice) take("dre", dreKnowledgeNodeId(r.domain, r.node_id), `${r.title ?? ""} ${r.content ?? ""}`);
  } catch (err) {
    perStore.dre.error = err instanceof Error ? err.message : String(err);
    logger.debug("[kb-corpus] dre collection degraded", { error: perStore.dre.error });
  }

  return { nodes, perStore, limitPerStore };
}
