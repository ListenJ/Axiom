/**
 * Chat service — intent routing, knowledge retrieval, and context assembly.
 *
 * Routes delegate here instead of importing from agents/ / router/ / memory/
 * directly, breaking the flat graph and providing a single entry point for the
 * request → model call pipeline.
 */
import type { ChatMessage } from "../router/model-router.js";
import { router } from "../router/model-router.js";
import { buildAgentMessages } from "../agents/intent-router.js";
import { getConsciousness } from "../agents/consciousness/index.js";
import { logger } from "../utils/logger.js";

export interface PreparedContext {
  chatMessages: ChatMessage[];
  intentInfo: {
    intent: string;
    agentName: string;
    confidence: number;
  } | null;
  codegraphContext: string;
}

/**
 * Assemble messages + intent + codegraph + knowledge context for a chat
 * request. This is the pipeline that was previously duplicated in
 * handleChat and handleChatStream.
 */
export async function prepareChatContext(
  messages: Array<{ role: string; content: string }>,
  enableIntent: boolean,
  vault: unknown,
): Promise<PreparedContext> {
  let chatMessages: ChatMessage[] = messages.map((m) => ({
    role: m.role as ChatMessage["role"],
    content: m.content,
  }));
  let intentInfo: PreparedContext["intentInfo"] = null;
  let codegraphContext = "";

  if (enableIntent !== false && messages.length > 0) {
    const lastUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMsg?.content) {
      const history = messages
        .slice(0, -1)
        .filter((m) => m.role !== "system");

      const { intent, messages: agentMessages } = buildAgentMessages(
        lastUserMsg.content,
        history,
      );
      chatMessages = agentMessages;
      intentInfo = intent;
      getConsciousness().observe(lastUserMsg.content, intent);

      // CodeGraph memory for code / research intents
      if (intent && ["code", "research"].includes(intent.intent)) {
        try {
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
            chatMessages = [
              {
                role: "system",
                content: `[CodeGraph Context]\n${codegraphContext}`,
              },
              ...chatMessages.filter((m) => m.role !== "system"),
            ];
          }
        } catch {
          /* non-fatal — continue without codegraph context */
        }
      }

      // Knowledge retrieval for knowledge / research intents
      if (intentInfo && ["knowledge", "research"].includes(intentInfo.intent)) {
        try {
          const {
            decomposeQuery,
            searchKnowledgeBase,
            synthesizeResults,
            buildKnowledgePrompt,
          } = await import("../agents/query-decomposer.js");
          const decomposed = decomposeQuery(lastUserMsg.content);
          const fragments = await searchKnowledgeBase(
            decomposed.subQueries,
            vault,
          );
          if (fragments.length > 0) {
            const context = synthesizeResults(fragments, lastUserMsg.content);
            const knowledgePrompt = buildKnowledgePrompt(context);
            chatMessages = [
              { role: "system", content: knowledgePrompt },
              ...chatMessages,
            ];
          }
        } catch (err) {
          logger.debug(
            "Knowledge retrieval failed, continuing without context",
            { error: (err as Error).message },
          );
        }
      }
    }
  }

  return { chatMessages, intentInfo, codegraphContext };
}

/**
 * Execute a blocking (non-streaming) chat call through the model router.
 */
export async function executeChat(
  messages: ChatMessage[],
  intentInfo: PreparedContext["intentInfo"],
  taskType: string | undefined,
) {
  if (intentInfo) {
    return router.routeByIntent(intentInfo.intent, messages);
  }
  if (taskType) {
    return router.chat(taskType, messages);
  }
  return router.chat("general-chat", messages);
}
