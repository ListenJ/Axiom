/**
 * Chat service — intent routing, adaptive knowledge retrieval, and context assembly.
 *
 * Routes delegate here instead of importing from agents/ / router/ / memory/
 * directly, breaking the flat graph and providing a single entry point for the
 * request → model call pipeline.
 *
 * 自适应知识检索:
 *   1. 意图识别 → 判断是否需要外部知识
 *   2. 需要 → 触发 tool pipeline (queryTool) 搜索网络
 *   3. 合并结果作为系统提示注入
 */
import type { ChatMessage } from "../router/model-router.js";
import { router } from "../router/model-router.js";
import { runToolLoop } from "./tool-loop.js";
import type { ToolCallDef } from "../utils/tool-surface.js";
import { buildAgentMessages } from "../agents/intent-router.js";
import { enhanceIntentWithLLM, shouldEnhanceIntent, buildEnhancedSystemPrompt } from "../agents/intent-enhancer.js";
import { optimizePrompt } from "../agents/prompt-optimizer.js";
import { injectConstitution } from "../agents/constitution.js";
import { getCurrentMode } from "../agents/execution-mode.js";
import { getConsciousness } from "../agents/consciousness/index.js";
import { logger } from "../utils/logger.js";
import { contextAssembler } from "../components/context-assembler.js";
import type { ComponentBudget, ComponentMessage, TokenBudgetReport } from "../components/contracts.js";
import { getReadOptimizer, type ReadResponse } from "../utils/read-optimizer.js";
import { isReadOptimizerInitialized } from "../utils/read-optimizer-init.js";

export interface PreparedContext {
  chatMessages: ChatMessage[];
  intentInfo: {
    intent: string;
    agentName: string;
    confidence: number;
  } | null;
  codegraphContext: string;
  tokenBudgetReport?: TokenBudgetReport | null;
  readStats?: ReadResponse | null;
}

/**
 * Assemble messages + intent + codegraph + adaptive knowledge context for a chat
 * request. This replaces the previous duplicated logic in handleChat/handleChatStream.
 */
export async function prepareChatContext(
  messages: Array<{ role: string; content: string }>,
  enableIntent: boolean,
  vault: unknown,
  options: { budget?: number | ComponentBudget } = {},
): Promise<PreparedContext> {
  let chatMessages: ChatMessage[] = messages.map((m) => ({
    role: m.role as ChatMessage["role"],
    content: m.content,
  }));
  let intentInfo: PreparedContext["intentInfo"] = null;
  let codegraphContext = "";
  let tokenBudgetReport: TokenBudgetReport | null = null;
  let readStats: ReadResponse | null = null;

  if (enableIntent !== false && messages.length > 0) {
    const lastUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMsg?.content) {
      const history = messages
        .slice(0, -1)
        .filter((m) => m.role !== "system");

      // ── 提示词优化：GLM-4.7-flash 改写 + Skill 专家增强 + 三重闸门 ──
      // 设计：每条输入先经 GLM 改写为更清晰的提示词，再进入 agent 主循环
      // 失败容错：GLM 链失败/闸门拒绝 → 回退原文，不阻塞主流程
      // 原文仍用于意识观察与知识检索；仅外发给主模型的 user 消息使用优化文本
      const optimization = await optimizePrompt(lastUserMsg.content);
      if (optimization.changed) {
        logger.debug("Prompt optimized by edge model", {
          original: lastUserMsg.content.slice(0, 80),
          optimized: optimization.text.slice(0, 80),
        });
      }

      const { intent: rawIntent, messages: agentMessages } = buildAgentMessages(
        optimization.text,
        history,
      );

      // ── 意图增强：当关键词匹配置信度低时，异步调用 GLM4.7-flash 做语义级分类 ──
      // 设计：fast path（关键词 0ms）+ slow path（LLM ~200ms）双轨
      // 失败容错：LLM 调用失败/超时 → 回退到 rawIntent，不阻塞主流程
      let intent = rawIntent;
      if (shouldEnhanceIntent(rawIntent)) {
        intent = await enhanceIntentWithLLM(lastUserMsg.content, rawIntent);
      }
      // 无论是否经过 LLM 增强，都用增强版 system prompt（注入思考框架）
      // 约束词（宪法）前置注入：所有聊天路径（/chat、/chat/stream、/v1/*）统一受宪法约束
      const enhancedSystem = injectConstitution(
        buildEnhancedSystemPrompt(intent.intent, lastUserMsg.content),
        getCurrentMode(),
      );
      // 缓存友好的消息结构（2026-07-25）：
      //   稳定前缀在前 —— [增强 system]（同一 intent 文本 byte 级稳定）
      //   易变内容在后 —— [codegraph 上下文][知识上下文]（固定相对次序）
      // 并行分支只写局部变量，Promise.all 后确定性组装（此前 prepend 写法
      // 会丢弃 enhanced system 且分支间存在 read-modify-write 竞态）
      const enhancedSystemMsg: ChatMessage = { role: "system", content: enhancedSystem };
      const restMessages = agentMessages.filter((m, idx) => !(idx === 0 && m.role === "system"));
      let codegraphMsg: ChatMessage | null = null;
      let knowledgeMsg: ChatMessage | null = null;
      intentInfo = intent;
      getConsciousness().observe(lastUserMsg.content, intent);

      // ── 并行化：CodeGraph 检索 + 自适应知识检索同时进行 ──
      // 历史问题：原实现串行执行 retrieveCodeMemory → retrieveKnowledge，
      //          总延迟 = T(codegraph) + T(knowledge)
      // 优化后：Promise.all 并行，总延迟 ≈ max(T(codegraph), T(knowledge))
      // 失败容错：单个分支失败不影响另一个；任一返回空都不阻塞主流程
      const needCodegraph = intent && ["code", "research"].includes(intent.intent);
      const needKnowledge = shouldSearch(intentInfo.intent);
      if (needCodegraph || needKnowledge) {
        // 构建并行任务（懒加载模块以避免启动时全部加载）
        const parallelTasks: Promise<void>[] = [];
        if (needCodegraph) {
          parallelTasks.push(
            (async () => {
              try {
                const useOptimizer = isReadOptimizerInitialized();
                if (useOptimizer) {
                  const rr = await getReadOptimizer().read({
                    resource: "codegraph",
                    action: "buildContext",
                    params: { task: lastUserMsg.content, projectPath: process.cwd() },
                    fields: ["results"],
                    agentId: "context-assembler",
                  });
                  readStats = rr;
                  const content =
                    typeof rr.data === "string"
                      ? rr.data
                      : JSON.stringify(rr.data ?? "");
                  if (content && content !== "null") {
                    codegraphContext = content.slice(0, 3000);
                    codegraphMsg = {
                      role: "system",
                      content: "[CodeGraph Context]\n" + codegraphContext,
                    };
                  }
                } else {
                  const { retrieveCodeMemory } = await import(
                    "../memory/codegraph-index.js"
                  );
                  const cgResult = await retrieveCodeMemory(lastUserMsg.content);
                  if (
                    cgResult &&
                    cgResult.source === "codegraph" &&
                    cgResult.results
                  ) {
                    codegraphContext = cgResult.results.slice(0, 3000);
                    codegraphMsg = {
                      role: "system",
                      content: "[CodeGraph Context]\n" + codegraphContext,
                    };
                  }
                }
              } catch {
                /* non-fatal */
              }
            })(),
          );
        }
        if (needKnowledge) {
          parallelTasks.push(
            (async () => {
              try {
                const { retrieveKnowledge } = await import("./knowledge.js");
                const kr = await retrieveKnowledge({
                  query: lastUserMsg.content,
                  intent: intentInfo.intent,
                  confidence: intentInfo.confidence,
                });
                if (kr.sources.length > 0) {
                  knowledgeMsg = { role: "system", content: kr.context };
                }
              } catch (err) {
                logger.debug("Adaptive knowledge retrieval failed", {
                  error: (err as Error).message,
                });
              }
            })(),
          );
        }
        await Promise.all(parallelTasks);
      }

      // 确定性组装：稳定前缀 → 易变上下文（固定次序）→ 历史与当前输入
      chatMessages = [
        enhancedSystemMsg,
        ...(codegraphMsg ? [codegraphMsg] : []),
        ...(knowledgeMsg ? [knowledgeMsg] : []),
        ...restMessages,
      ];
    }
  }

  const assembled = await contextAssembler.assemble({
    messages: chatMessages as unknown as ComponentMessage[],
    role: intentInfo?.intent ?? "chat",
    budget: options.budget,
  });
  chatMessages = assembled.messages;
  tokenBudgetReport = assembled.tokenBudgetReport;

  return {
    chatMessages,
    intentInfo,
    codegraphContext,
    tokenBudgetReport,
    readStats,
  };
}

/** 需要自适应搜索的意图类别 */
function shouldSearch(intent: string): boolean {
  return [
    "research", "knowledge", "news", "fact", "question",
    "code", "tutorial", "comparison", "howto", "write",
    "explain", "analyze", "review",
  ].includes(intent);
}

/** executeChat 的扩展选项（原生 function-calling） */
export interface ExecuteChatOptions {
  /** 工具循环使用的 TaskRole（由路由层计算） */
  role?: string;
  /** OpenAI 兼容 tools 定义 */
  tools?: ToolCallDef[];
  /** 工具执行器（按名称分发） */
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 工具循环最大轮数 */
  maxToolIterations?: number;
}

/**
 * Execute a blocking (non-streaming) chat call through the model router.
 * 传入 tools + executeTool 时走原生 function-calling 工具循环（按需调用工具）。
 */
export async function executeChat(
  messages: ChatMessage[],
  intentInfo: PreparedContext["intentInfo"],
  taskType: string | undefined,
  options: ExecuteChatOptions = {},
) {
  if (options.tools?.length && options.role && options.executeTool) {
    return runToolLoop(options.role, messages, {
      tools: options.tools,
      executeTool: options.executeTool,
      maxIterations: options.maxToolIterations,
    });
  }
  if (intentInfo) {
    return router.routeByIntent(intentInfo.intent, messages);
  }
  if (taskType) {
    return router.chat(taskType, messages);
  }
  return router.chat("general-chat", messages);
}
