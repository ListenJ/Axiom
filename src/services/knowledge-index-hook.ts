/**
 * 写入侧 → 向量索引的**推送钩子**（2026-09-21）
 *
 * ## 为什么住在 `src/services/`（不是 `src/knowledge/`）
 * 本仓库把 `src/services/` 定义为**破环层**（见 `tests/architecture-integrity.test.ts` 的
 * `KNOWN_CIRCULAR_PAIRS` 注释）。若把本文件放在 `src/knowledge/`，则
 * `memory → knowledge` 与既有 `knowledge → memory` 会构成**新的目录级环**（实测：Test 15 失败）；
 * `memory → services` 本就是已知允许对，`dre → services` 也不构成环。故放在这里。
 * 本文件因此**只依赖 `utils/logger`**（叶子），不 import `knowledge/`、也不 import `router/`。
 *
 * ## 解决什么
 * 知识写入方（vault 笔记、KG 节点、DRE 知识条目）在**各自的层**里，而向量索引需要
 * `ModelRouter` 的 embedding 依赖 —— 但 `src/knowledge/`、`src/memory/`、`src/dre/` 都
 * 不该 import `src/router/`（分层 + 架构门禁）。故采用**可注入钩子**：
 *   - 写入方只喊一声 `notifyKnowledgeWritten([...])`（不关心谁来索引、有没有索引）；
 *   - **组合根**（`src/main.ts` / `src/mcp/server.ts` / `src/mcp/kb-backend.ts`）在启动时用
 *     `setKnowledgeIndexSink()` 注入真实实现（见 `src/services/knowledge-embedding-index.ts`）。
 *   这与本仓库 `model-router.setThompsonRouter(port)` 的既有做法同型。
 *
 * ## 三条硬性质（都是可测的，不是口号）
 * 1. **默认关闭零成本**：未注入 ⇒ `notifyKnowledgeWritten` 立即返回，不读库、不触网；
 * 2. **永不抛**：钩子内部异常/失败一律吞进日志 —— 写入路径不应因向量索引失败而失败；
 * 3. **不静默**：注入了但失败 ⇒ `logger.warn` 留痕（不是无声无息）。
 *
 * ## 已知边界（如实声明）
 * 钩子是**全局单例**（与本仓库 Thompson 端口同型）：多进程各自注入各自的；同进程内以最后一次注入为准。
 * 推送是**尽力而为**：进程在"写库后、嵌入前"退出会漏，需靠幂等的
 * `runIncrementalIndex()`（采集管线收尾 / 索引脚本）兜底补齐。
 */
import { logger } from "../utils/logger.js";
import type { Database } from "bun:sqlite";
import { indexFreshNodes, type IncrementalIndexDeps } from "../knowledge/incremental-index.js";

/** 推送单元（结构类型，避免本模块依赖 `knowledge/` 的类型导出） */
export interface IndexableUnit {
  nodeId: string;
  content: string;
}

/**
 * 索引侧的**全部能力**（写入 + 删除）。用单个 sink 而不是两个全局，是为了保证
 * "索引与删除同步由同一处装配/清除"——否则很容易只装了写入、忘了删除（那正是脏数据的来源）。
 */
export interface KnowledgeIndexSink {
  /** 索引刚写入/更新的单元 */
  index(nodes: readonly IndexableUnit[]): Promise<void>;
  /**
   * 删除这些 nodeId 的向量（节点已从知识库删除）。
   * 可选：老装配方未提供时，钩子退化为"不删除"并**不做任何 DB 操作**（由扫描腿兜底清理）。
   */
  prune?(nodeIds: readonly string[]): Promise<void>;
}

let sink: KnowledgeIndexSink | null = null;

/** 注入/清除索引 sink（传 null 清除）。 */
export function setKnowledgeIndexSink(next: KnowledgeIndexSink | null): void {
  sink = next;
}

/** 当前是否已注入（供状态查询/测试）。 */
export function hasKnowledgeIndexSink(): boolean {
  return sink !== null;
}

/**
 * 用**真实增量索引**装配一个 `KnowledgeEmbeddingIndexer`（组合根调用）。
 *
 * 注意：此处只做装配，**不做门控** —— 门控在 `indexFreshNodes` 内部（未授权/无路由先返回）。
 */
export function createKnowledgeEmbeddingIndexer(
  db: Database,
  deps: IncrementalIndexDeps,
): KnowledgeIndexSink {
  return {
    index: async (nodes) => {
      const report = await indexFreshNodes(db, nodes, deps);
      if (report.error) logger.warn("[EmbeddingIndexHook] index failed", { error: report.error, nodes: nodes.length });
      if (report.failed > 0) {
        logger.warn("[EmbeddingIndexHook] partial failure", { failed: report.failed, attempted: report.attempted });
      }
    },
    prune: async (nodeIds) => {
      // 删除同步：纯本地 DB 操作（**不调模型、不耗 token**），故不需要授权门；
      // 但需要表存在 —— 首次写入前表可能还没有，此时无事可删。
      const { deleteEmbeddingsByNodeIds } = await import("../knowledge/embedding-store.js");
      const pruned = deleteEmbeddingsByNodeIds(db, nodeIds);
      if (pruned > 0) logger.info("[EmbeddingIndexHook] pruned embeddings", { pruned, requested: nodeIds.length });
    },
  };
}

/**
 * 通知"这些知识单元刚被写入"。
 *
 * **永不抛**：未注入直接返回；注入的实现抛错则吞掉并 `logger.warn` 留痕。
 * 写入方可以 `await`（异步路径，如 `vault-manager.writeNote`），也可以在同步路径上
 * fire-and-forget（如 `KnowledgeStore.write`）—— 后者是尽力而为，漏掉的由幂等 sweep 兜底。
 */
export async function notifyKnowledgeWritten(nodes: readonly IndexableUnit[]): Promise<void> {
  if (!sink) return;
  if (nodes.length === 0) return;
  try {
    await sink.index(nodes);
  } catch (err) {
    logger.warn("[EmbeddingIndexHook] indexer threw; write path unaffected", {
      error: err instanceof Error ? err.message : String(err),
      nodes: nodes.length,
    });
  }
}

/**
 * 通知"这些 nodeId 对应的知识单元已被删除"（删除同步，2026-09-21）。
 *
 * 与写入通知同型：未注入 / sink 未实现 `prune` ⇒ **空操作**；实现抛错 ⇒ 吞进 `logger.warn`（删除路径不受影响）。
 * 兜底：即便这里漏了，扫描腿（`runIncrementalIndex({pruneOrphans:true})`）会在下次语料扫描时清掉残留。
 */
export async function notifyKnowledgeDeleted(nodeIds: readonly string[]): Promise<void> {
  if (!sink?.prune) return;
  const ids = nodeIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return;
  try {
    await sink.prune(ids);
  } catch (err) {
    logger.warn("[EmbeddingIndexHook] prune threw; delete path unaffected", {
      error: err instanceof Error ? err.message : String(err),
      nodeIds: ids.length,
    });
  }
}
