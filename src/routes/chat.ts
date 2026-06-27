/**
 * Chat and agent-chat routes — v3.0
 *
 * Integrates:
 * - UnifiedRouter (consciousness-aware dynamic routing)
 * - Consciousness.observe() + getRoutingSignal()
 * - Planning Phase for complex tasks
 */
import type { RouteContext } from "./types.js";
import { logger } from "../utils/logger.js";
import { router } from "../router/model-router.js";
import { unifiedRouter } from "../router/unified-router.js";
import { wsManager } from "../utils/websocket.js";
import { buildAgentMessages } from "../agents/intent-router.js";
import { getConsciousness } from "../agents/consciousness/index.js";
import { planExecution } from "../agents/planning/index.js";

export async function handleChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/chat" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { taskType, messages = [], intent: enableIntent = true } = body;

    let chatMessages = messages;
    let intentInfo = null;
    let codegraphContext = "";

    if (enableIntent !== false && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find((m: { role: string; content: string }) => m.role === "user");
      if (lastUserMsg?.content) {
        const history = messages.slice(0, -1).filter((m: { role: string; content: string }) => m.role !== "system");
        const { intent, messages: agentMessages } = buildAgentMessages(lastUserMsg.content, history);
        chatMessages = agentMessages;
        intentInfo = intent;

        // ── Consciousness: observe user input ──
        try {
          getConsciousness().observe(lastUserMsg.content, {
            intent: intent.intent,
            agentName: intent.agentName,
          });
        } catch { /* non-fatal */ }

        // ── Planning Phase for complex tasks ──
        const complexity = planExecution.length > 0 ? "check" : "skip";
        if (["code", "research"].includes(intent.intent) && lastUserMsg.content.length > 100) {
          try {
            const planResult = await planExecution(lastUserMsg.content, history);
            if (!planResult.skipped && planResult.plan.steps.length > 1) {
              // Inject plan context into system message
              const planContext = [
                "[Execution Plan]",
                `Understanding: ${planResult.plan.understanding}`,
                `Steps: ${planResult.plan.steps.map((s) => `${s.id}. ${s.description}`).join(" → ")}`,
                `Verification: ${planResult.plan.verificationCriteria}`,
                planResult.plan.firstPrinciples.length > 0
                  ? `First Principles: ${planResult.plan.firstPrinciples.join("; ")}`
                  : "",
              ].filter(Boolean).join("\n");

              chatMessages = [
                ...chatMessages.filter((m: { role: string }) => m.role !== "system"),
                { role: "system" as const, content: planContext },
              ];

              logger.info("[Chat] Planning phase injected", {
                steps: planResult.plan.steps.length,
                complexity: planResult.plan.complexity,
                latencyMs: planResult.latencyMs,
              });
            }
          } catch { /* non-fatal: continue without plan */ }
        }

        // 代码相关意图：自动检索 CodeGraph 记忆
        if (intent && ["code", "research"].includes(intent.intent)) {
          try {
            const { retrieveCodeMemory } = await import("../memory/codegraph-index.js");
            const cgResult = await retrieveCodeMemory(lastUserMsg.content);
            if (cgResult && cgResult.source === "codegraph" && cgResult.results) {
              codegraphContext = cgResult.results.slice(0, 3000);
              chatMessages = [
                { role: "system", content: `[CodeGraph Context]\n${codegraphContext}` },
                ...chatMessages.filter((m: { role: string; content: string }) => m.role !== "system"),
              ];
            }
          } catch { /* ignore codegraph errors */ }
        }

        // Knowledge retrieval for knowledge/research intents
        if (intentInfo && ["knowledge", "research"].includes(intentInfo.intent)) {
          try {
            const { decomposeQuery, searchKnowledgeBase, synthesizeResults, buildKnowledgePrompt } = await import("../agents/query-decomposer.js");
            const decomposed = decomposeQuery(lastUserMsg.content);
            const fragments = await searchKnowledgeBase(decomposed.subQueries, ctx.vault);
            if (fragments.length > 0) {
              const context = synthesizeResults(fragments, lastUserMsg.content);
              const knowledgePrompt = buildKnowledgePrompt(context);
              chatMessages = [
                { role: "system", content: knowledgePrompt },
                ...chatMessages,
              ];
            }
          } catch (err) {
            logger.debug("Knowledge retrieval failed, continuing without context", { error: (err as Error).message });
          }
        }
      }
    }

    // ── Unified Router: consciousness-aware routing ──
    let result;
    const lastUserMsg = [...messages].reverse().find((m: { role: string; content: string }) => m.role === "user");

    if (lastUserMsg?.content) {
      try {
        // Get consciousness routing signal
        const signal = getConsciousness().getRoutingSignal();

        // Use unified router for routing decision
        const decision = await unifiedRouter.route(lastUserMsg.content, chatMessages, {
          signal,
          isTopicContinuation: messages.length > 2,
        });

        logger.info("[Chat] UnifiedRouter decision", {
          role: decision.role,
          strategy: decision.strategy,
          confidence: decision.confidence,
          fastPath: decision.fastPath,
          latencyMs: decision.latencyMs,
        });

        // Execute with the decided role
        result = await router.executeWithRole(decision.role, chatMessages);

        // Broadcast routing decision
        wsManager.broadcast({
          type: "routing.decision",
          payload: {
            role: decision.role,
            strategy: decision.strategy,
            confidence: decision.confidence,
            thinkingIntensity: decision.thinkingIntensity,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        // Fallback to legacy routing
        logger.warn("[Chat] UnifiedRouter failed, falling back to legacy", { error: (err as Error).message });
        if (intentInfo) {
          result = await router.routeByIntent(intentInfo.intent, chatMessages);
        } else if (taskType) {
          result = await router.chat(taskType, chatMessages);
        } else {
          result = await router.chat("general-chat", chatMessages);
        }
      }
    } else {
      // No user message — use legacy routing
      if (intentInfo) {
        result = await router.routeByIntent(intentInfo.intent, chatMessages);
      } else if (taskType) {
        result = await router.chat(taskType, chatMessages);
      } else {
        result = await router.chat("general-chat", chatMessages);
      }
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = result as any;
    wsManager.broadcast({
      type: "model.usage",
      payload: { layer: r.layer ?? r.role ?? "unknown", taskType: taskType || "auto", provider: result.provider },
      timestamp: new Date().toISOString(),
    });
    if (intentInfo) {
      wsManager.broadcast({
        type: "agent.intent",
        payload: { intent: intentInfo.agentName, confidence: intentInfo.confidence, layer: r.layer ?? r.role ?? "unknown" },
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
    const { intent, messages: agentMessages } = buildAgentMessages(message, history);

    // ── Consciousness: observe ──
    try {
      getConsciousness().observe(message, {
        intent: intent.intent,
        agentName: intent.agentName,
      });
    } catch { /* non-fatal */ }

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
      payload: { intent: intent?.agentName || "general", confidence: intent?.confidence || 0, layer: (result as any).layer ?? "unknown" },
      timestamp: new Date().toISOString(),
    });

    return response;
  }
  return null;
}
