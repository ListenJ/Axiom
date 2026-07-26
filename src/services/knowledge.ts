/**
 * 自适应知识检索服务
 *
 * 流程:
 *   1. 接收用户查询
 *   2. 意图识别 → 判断是否需要外部知识
 *   3. 需要则触发 knowledgetool 搜索
 *   4. 合并本地 + 网络结果
 *   5. 格式化为 AI 上下文
 */
import { queryTool } from "../tools/query-tool.js";
import { readTool } from "../tools/read-tool.js";
import { createToolContext } from "../tools/types.js";
import { runPipeline } from "../tools/pipeline.js";
import { logger } from "../utils/logger.js";

export interface KnowledgeRequest {
  query: string;
  intent: string;
  confidence: number;
  existingContext?: string;
}

export interface KnowledgeResult {
  context: string;
  sources: Array<{ source: string; title: string; url?: string }>;
  totalResults: number;
  pipelineError?: string;
}

/**
 * 自适应知识检索 — 根据意图和置信度决定是否触发搜索
 */
export async function retrieveKnowledge(req: KnowledgeRequest): Promise<KnowledgeResult> {
  // 需要外部搜索的意图
  const NEEDS_WEB = new Set([
    "research", "knowledge", "news", "fact", "question",
    "code", "tutorial", "comparison", "howto",
  ]);

  const shouldSearch = NEEDS_WEB.has(req.intent) || req.confidence < 0.6;

  if (!shouldSearch) {
    return { context: req.existingContext ?? "", sources: [], totalResults: 0 };
  }

  // 隐私模式（R6）：禁止外发检索（用户查询不离开本机，仅返回已有上下文）
  const { isPrivacyMode } = await import("../agents/prompt-optimizer.js");
  if (isPrivacyMode()) {
    logger.info("[Knowledge] privacy mode: web retrieval skipped");
    return { context: req.existingContext ?? "", sources: [], totalResults: 0 };
  }

  // 创建工具管道
  const ctx = createToolContext(`knowledge-${Date.now()}`);

  // 注入 vault 实例（复用全局单例）
  try {
    const { getGlobalVault } = await import("../memory/vault-manager.js");
    ctx.localStore.set("vaultManager", getGlobalVault());
  } catch { /* vault 不可用 */ }

  // 边缘查询改写：自然语言 → 检索关键词（失败回退原始查询）
  let effectiveQuery = req.query;
  try {
    const { rewriteKnowledgeQueryWithEdge } = await import("../knowledge/edge-assist.js");
    const rewritten = await rewriteKnowledgeQueryWithEdge(req.query);
    if (rewritten) {
      logger.debug("Knowledge query rewritten by edge model", { original: req.query.slice(0, 60), rewritten });
      effectiveQuery = rewritten;
    }
  } catch { /* 边缘不可用，用原始查询 */ }

  const pipeline = [
    {
      tool: queryTool,
      input: { query: effectiveQuery, scope: "auto" as const, maxResults: 8 },
    },
  ];

  const result = await runPipeline(pipeline, ctx);

  if (result.error) {
    return {
      context: req.existingContext ?? "",
      sources: [],
      totalResults: 0,
      pipelineError: result.error,
    };
  }

  type KnowledgeQueryResult = { source: string; title: string; url?: string; snippet: string };
  const queryOutput = result.stepResults[0] as { results: KnowledgeQueryResult[]; totalFound: number; scopeUsed: string };
  if (!queryOutput?.results?.length) {
    return { context: req.existingContext ?? "", sources: [], totalResults: 0 };
  }

  // 格式化为 AI 上下文
  const sources = queryOutput.results.map((r: KnowledgeQueryResult) => ({
    source: r.source,
    title: r.title,
    url: r.url,
  }));

  let context = req.existingContext ? req.existingContext + "\n\n" : "";
  context += `[自适应检索: "${req.query}"]\n`;
  context += `检索范围: ${queryOutput.scopeUsed}\n`;
  context += `找到 ${queryOutput.totalFound} 条结果:\n\n`;

  for (const r of queryOutput.results.slice(0, 5)) {
    context += `• [${r.source}] ${r.title}\n`;
    if (r.snippet) context += `  ${r.snippet.slice(0, 300)}\n`;
    context += "\n";
  }

  return { context, sources, totalResults: queryOutput.totalFound };
}
