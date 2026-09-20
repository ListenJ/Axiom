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
 *     `setKnowledgeEmbeddingIndexer()` 注入真实实现（见 `src/services/knowledge-embedding-index.ts`）。
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

export type KnowledgeEmbeddingIndexer = (nodes: readonly IndexableUnit[]) => Promise<void>;

let indexer: KnowledgeEmbeddingIndexer | null = null;

/** 注入/清除索引实现（返回可选 dispose，便于测试与热重载）。 */
export function setKnowledgeEmbeddingIndexer(fn: KnowledgeEmbeddingIndexer | null): void {
  indexer = fn;
}

/** 当前是否已注入（供状态查询/测试）。 */
export function hasKnowledgeEmbeddingIndexer(): boolean {
  return indexer !== null;
}

/**
 * 用**真实增量索引**装配一个 `KnowledgeEmbeddingIndexer`（组合根调用）。
 *
 * 注意：此处只做装配，**不做门控** —— 门控在 `indexFreshNodes` 内部（未授权/无路由先返回）。
 */
export function createKnowledgeEmbeddingIndexer(
  db: Database,
  deps: IncrementalIndexDeps,
): KnowledgeEmbeddingIndexer {
  return async (nodes) => {
    const report = await indexFreshNodes(db, nodes, deps);
    if (report.error) logger.warn("[EmbeddingIndexHook] index failed", { error: report.error, nodes: nodes.length });
    if (report.failed > 0) {
      logger.warn("[EmbeddingIndexHook] partial failure", { failed: report.failed, attempted: report.attempted });
    }
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
  if (!indexer) return;
  if (nodes.length === 0) return;
  try {
    await indexer(nodes);
  } catch (err) {
    logger.warn("[EmbeddingIndexHook] indexer threw; write path unaffected", {
      error: err instanceof Error ? err.message : String(err),
      nodes: nodes.length,
    });
  }
}
