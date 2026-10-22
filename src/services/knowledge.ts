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
import { createInjectedToolContext } from "../tools/runtime-deps.js";
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
  /**
   * P2.1：运行时依赖缺失导致的降级原因码（vault / 统一搜索通道）。
   * 有值 ⇒ 本次 context 不完整（本地记忆腿或统一搜索腿被跳过），调用方不得当作完整结果。
   */
  degraded?: string[];
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

  // 创建工具管道（P2.1）：依赖注入收敛到 createInjectedToolContext；缺依赖时 typed 原因
  // 由 warn-once 日志 + queryTool 输出 `degraded` 暴露，不再用空 catch 静默跳过记忆腿。
  const { context: ctx } = await createInjectedToolContext(`knowledge-${Date.now()}`);

  // 检索键 = 用户原始查询（确定性）：不经过 LLM 改写，同输入同输出。
  // （2026-09-17 移除 rewriteKnowledgeQueryWithEdge 链 —— LLM 改写引入非确定性，与
  //   确定性检索承诺冲突；检索键漂移问题随之消除。）

  const pipeline = [
    {
      tool: queryTool,
      input: { query: req.query, scope: "auto" as const, maxResults: 8 },
    },
  ];

  const result = await runPipeline(pipeline, ctx);

  // P2.1：依赖降级原因（优先取 queryTool 实际输出，错误路径回退到上下文里记录的探测结果）
  const runtimeStatus = ctx.localStore.get("runtimeDepsStatus") as
    | { degraded?: string[] }
    | undefined;

  if (result.error) {
    return {
      context: req.existingContext ?? "",
      sources: [],
      totalResults: 0,
      pipelineError: result.error,
      ...(runtimeStatus?.degraded?.length ? { degraded: runtimeStatus.degraded } : {}),
    };
  }

  type KnowledgeQueryResult = { source: string; title: string; url?: string; snippet: string };
  const queryOutput = result.stepResults[0] as {
    results: KnowledgeQueryResult[];
    totalFound: number;
    scopeUsed: string;
    degraded?: string[];
  };
  const degraded = queryOutput?.degraded?.length
    ? queryOutput.degraded
    : runtimeStatus?.degraded;
  if (!queryOutput?.results?.length) {
    return {
      context: req.existingContext ?? "",
      sources: [],
      totalResults: 0,
      ...(degraded?.length ? { degraded } : {}),
    };
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

  return {
    context,
    sources,
    totalResults: queryOutput.totalFound,
    ...(degraded?.length ? { degraded } : {}),
  };
}
