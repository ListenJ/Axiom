/**
 * 组合根装配：把**真实** embedding 依赖接到写入侧推送钩子（2026-09-21）
 *
 * 为什么放在 `src/services/`：`src/knowledge/` 不 import `src/router/`（分层 + 架构门禁 Test 9），
 * 而"拿哪个 embedding 路由"只能在组合层决定。调用方（`src/main.ts`、`src/mcp/server.ts`、
 * `src/mcp/kb-backend.ts`）各一行：
 *
 * ```ts
 * enableKnowledgeEmbeddingIndex(db);
 * ```
 *
 * ## 语义
 * - **装配不等于授权**：注入后每次写入都会经过 `indexFreshNodes` 的三道门（授权 / 路由 / 失败降级）；
 *   未授权（默认 `ask`）⇒ 连库都不读，写路径行为与未装配时一致（仅多一次函数调用）。
 * - **可关闭**：返回 dispose 函数（测试/热重载用），或传 `{ disable: true }` 直接清除。
 */
import type { Database } from "bun:sqlite";
import { router } from "../router/model-router.js";
import { findModelsForRole } from "../router/model-capability-registry.js";
import { resolveEmbeddingConsent } from "../knowledge/embedding-consent.js";
import { embeddingModelTagOf } from "../knowledge/embedding-model.js";
import {
  createKnowledgeEmbeddingIndexer,
  setKnowledgeEmbeddingIndexer,
} from "./knowledge-index-hook.js";

export interface EnableOptions {
  /** 为 true 时只清除已注入的实现，不做装配 */
  disable?: boolean;
}

/** 装配（或 `disable: true` 时清除）写入侧索引钩子；返回 dispose。 */
export function enableKnowledgeEmbeddingIndex(db: Database, opts: EnableOptions = {}): () => void {
  if (opts.disable) {
    setKnowledgeEmbeddingIndexer(null);
    return () => setKnowledgeEmbeddingIndexer(null);
  }
  setKnowledgeEmbeddingIndexer(
    createKnowledgeEmbeddingIndexer(db, {
      embeddings: (texts) => router.embeddings(texts),
      resolveModelTag: () => embeddingModelTagOf(findModelsForRole("embedding")),
      consent: resolveEmbeddingConsent,
      // 时间戳在组合层取（knowledge 层保持无时钟；两条 leg 各自调用本工厂）
      now: Date.now(),
    }),
  );
  return () => setKnowledgeEmbeddingIndexer(null);
}
