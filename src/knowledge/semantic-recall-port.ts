/**
 * KAL 语义召回端口的**生产实现**（A5/A7 接线，2026-09-21）
 *
 * 把三块已就位的零件接成一个 `SemanticRecallPort`：
 *   授权门（`createConsentedEmbedder`） → 模型标签（`resolveEmbeddingModelTag`）
 *   → 向量召回（`recallBySimilarity`，读同库的 `knowledge_embeddings` 表）
 *
 * ## 三道门，缺一即**零调用**（不是"调了但忽略结果"）
 * 1. **授权**：`AXIOM_EMBEDDING_CONSENT` 非 `yes`（默认 `ask`）⇒ 不构造 embedder；
 * 2. **路由**：无 embedding 路由（发布默认：SiliconFlow 被 `devOnly` 闸门过滤、用户也未配模型）
 *    ⇒ 标签为 `null` ⇒ 直接返回空候选，**连 embedder 都不调**；
 * 3. **失败降级**：embedder 抛错/超时 ⇒ 授权门包装层返回空数组 ⇒ 无候选（KAL 侧再兜一层 try/catch）。
 *
 * 三道门都在**每次 recall 时重新求值**：运行期改授权/换模型立即生效，不需要重启，也不会因
 * 构造期快照而"卡住旧配置"（此前 9001 死端点就是构造期快照引发的教训）。
 *
 * ## 依赖注入（规则 8）
 * 三个依赖**全部由调用方注入**（`embeddings` 真实调用 / `resolveModelTag` 标签解析 / `consent` 授权）：
 *   - 本模块因此可在**无网络、无凭据、无 dev 模型**的环境被完整测试；
 *   - 且 `src/knowledge/` **不 import `src/router/`**（分层：knowledge 不反向依赖 router；
 *     同时满足架构门禁"单目录 ≤8 个顶层依赖"，见 `tests/architecture-integrity.test.ts` Test 9）。
 *   组合根（`src/mcp/server/kg-tools.ts`）与索引脚本负责把真实路由接进来。
 */
import type { Database } from "bun:sqlite";
import type { SemanticRecallPort } from "../kal/knowledge-access-layer.js";
import {
  createConsentedEmbedder,
  type EmbeddingConsentMode,
  type EmbeddingsCall,
} from "./embedding-consent.js";
import { recallBySimilarity } from "./semantic-index.js";

export interface SemanticRecallPortDeps {
  /** 真实 embedding 调用（组合根传 `ModelRouter.embeddings`） */
  embeddings: EmbeddingsCall;
  /** 模型标签解析（组合根传 `() => embeddingModelTagOf(findModelsForRole("embedding"))`） */
  resolveModelTag: () => string | null;
  /** 授权模式解析（通常传 `resolveEmbeddingConsent`） */
  consent: () => EmbeddingConsentMode;
}

/**
 * 构造给 KAL 用的语义端口。
 *
 * 注意：端口**总是**被构造出来（这样运行期授权/配模型后无需重建 KAL），
 * 但每次 `recall` 都会重新过三道门 —— 未授权时它只会返回空数组，**不发起任何网络请求**。
 */
export function buildSemanticRecallPort(db: Database, deps: SemanticRecallPortDeps): SemanticRecallPort {
  const d = deps;
  return {
    recall: async (query, opts) => {
      const embedder = createConsentedEmbedder({ embeddings: d.embeddings }, { mode: d.consent() });
      if (!embedder) return []; // 门 1：未授权
      const model = d.resolveModelTag();
      if (!model) return []; // 门 2：无路由（发布默认）
      const out = await recallBySimilarity({
        db,
        embedder,
        model,
        query,
        topK: opts.topK,
      });
      return out.candidates;
    },
  };
}
