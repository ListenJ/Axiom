/**
 * Chat and agent-chat routes
 */
import type { RouteContext } from "./types.js";

export async function handleChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/chat" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { taskType, messages = [], intent: enableIntent = true } = body;
    const { router } = await import("../router/model-router.js");
    const { wsManager } = await import("../utils/websocket.js");

    let chatMessages = messages;
    let intentInfo = null;
    let codegraphContext = "";

    if (enableIntent !== false && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      if (lastUserMsg?.content) {
        const { buildAgentMessages } = await import("../agents/intent-router.js");
        const history = messages.slice(0, -1).filter((m: any) => m.role !== "system");
        const { intent, messages: agentMessages } = buildAgentMessages(lastUserMsg.content, history);
        chatMessages = agentMessages;
        intentInfo = intent;

        // 代码相关意图：自动检索 CodeGraph 记忆
        if (intent && ["code", "research"].includes(intent.intent)) {
          try {
            const { retrieveCodeMemory } = await import("../memory/codegraph-index.js");
            const cgResult = await retrieveCodeMemory(lastUserMsg.content);
            if (cgResult && cgResult.results) {
              codegraphContext = cgResult.results.slice(0, 3000);
              chatMessages = [
                { role: "system", content: `[CodeGraph Context]\n${codegraphContext}` },
                ...chatMessages.filter((m: any) => m.role !== "system"),
              ];
            }
          } catch { /* ignore codegraph errors */ }
        }
      }
    }

    let result;
    if (intentInfo) {
      result = await router.routeByIntent(intentInfo.intent, chatMessages);
    } else if (taskType) {
      result = await router.chat(taskType, chatMessages);
    } else {
      result = await router.chat("general-chat", chatMessages);
    }

    const response = ctx.jsonResponse({
      ...result,
      codegraphContext: codegraphContext ? { length: codegraphContext.length } : null,
      intent: intentInfo ? {
        name: intentInfo.agentName,
        category: intentInfo.intent,
        confidence: intentInfo.confidence,
      } : null,
    }, 200, ctx.baseHeaders);

    wsManager.broadcast({
      type: "model.usage",
      payload: { layer: result.layer, taskType: taskType || "auto", provider: result.provider },
      timestamp: new Date().toISOString(),
    });
    if (intentInfo) {
      wsManager.broadcast({
        type: "agent.intent",
        payload: { intent: intentInfo.agentName, confidence: intentInfo.confidence, layer: result.layer },
        timestamp: new Date().toISOString(),
      });
    }

    return response;
  }
  return null;
}

export async function handleAgentChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agent-chat" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { message, history = [], taskType } = body;
    const { buildAgentMessages } = await import("../agents/intent-router.js");
    const { intent, messages: agentMessages } = buildAgentMessages(message, history);
    const { router } = await import("../router/model-router.js");
    const { wsManager } = await import("../utils/websocket.js");

    let result;
    if (intent) {
      result = await router.routeByIntent(intent.intent, agentMessages);
    } else if (taskType) {
      result = await router.chat(taskType, agentMessages);
    } else {
      result = await router.chat("general-chat", agentMessages);
    }

    const response = ctx.jsonResponse({
      ...result,
      intent: intent ? {
        name: intent.agentName,
        category: intent.intent,
        confidence: intent.confidence,
      } : null,
    }, 200, ctx.baseHeaders);

    wsManager.broadcast({
      type: "agent.intent",
      payload: { intent: intent?.agentName || "general", confidence: intent?.confidence || 0, layer: result.layer },
      timestamp: new Date().toISOString(),
    });

    return response;
  }
  return null;
}
