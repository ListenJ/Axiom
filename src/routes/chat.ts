/**
 * Chat and agent-chat routes — v4.0 (Runtime-integrated)
 *
 * All requests go through:
 *   ChatActor → ConstraintSolver → RuleEngine → CognitivePipeline → CapabilityRegistry → VerificationEngine
 *
 * No direct module-to-module calls. Everything via Actor message passing.
 */
import type { RouteContext } from "./types.js";
import { logger } from "../utils/logger.js";
import { router } from "../router/model-router.js";
import { unifiedRouter } from "../router/unified-router.js";
import { wsManager } from "../utils/websocket.js";
import { buildAgentMessages } from "../agents/intent-router.js";
import { getConsciousness } from "../agents/consciousness/index.js";
import { generateHelpfulError } from "../utils/error-handler.js";
import { getChatActor } from "../runtime/chat-actor.js";
import { constraintSolver } from "../runtime/constraint-solver.js";
import { ruleEngine } from "../runtime/rule-engine.js";
import { verificationEngine } from "../runtime/verification-engine.js";
import { memoryEngine } from "../runtime/memory-engine.js";
import { eventBus } from "../runtime/kernel.js";

export async function handleChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/chat" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { taskType, messages = [], intent: enableIntent = true } = body;

    let chatMessages = messages;
    let intentInfo = null;
    let codegraphContext = "";
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (enableIntent !== false && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find((m: { role: string; content: string }) => m.role === "user");
      if (lastUserMsg?.content) {
        const history = messages.slice(0, -1).filter((m: { role: string; content: string }) => m.role !== "system");
        const { intent, messages: agentMessages } = buildAgentMessages(lastUserMsg.content, history);
        chatMessages = agentMessages;
        intentInfo = intent;

        // ── Step 1: Consciousness observe ──
        try {
          getConsciousness().observe(lastUserMsg.content, {
            intent: intent.intent,
            agentName: intent.agentName,
          });
        } catch { /* non-fatal */ }

        // ── Step 2: Constraint check (gate) ──
        const constraintResult = constraintSolver.solve([lastUserMsg.content]);
        if (!constraintResult.satisfied) {
          logger.warn("[Chat] Constraint violations", {
            violations: constraintResult.violations.map((v) => v.message),
          });
          // Don't block, but log and include in response
        }

        // ── Step 3: Rule evaluation ──
        const ruleContext = {
          intent: intent.intent,
          mode: "agent",
          complexity: lastUserMsg.content.length > 200 ? "complex" : lastUserMsg.content.length > 50 ? "medium" : "simple",
        };
        const ruleMatches = ruleEngine.evaluate(ruleContext);
        if (ruleMatches.length > 0) {
          logger.info("[Chat] Rules matched", {
            rules: ruleMatches.filter((m) => m.matched).map((m) => m.rule.name),
          });
        }

        // ── Step 4: Memory observe ──
        memoryEngine.observe(lastUserMsg.content, "user");

        // ── Step 5: Planning Phase for complex tasks ──
        if (["code", "research"].includes(intent.intent) && lastUserMsg.content.length > 100) {
          try {
            const { planExecution } = await import("../agents/planning/index.js");
            const planResult = await planExecution(lastUserMsg.content, history);
            if (!planResult.skipped && planResult.plan.steps.length > 1) {
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
            }
          } catch { /* non-fatal */ }
        }

        // ── Step 6: CodeGraph retrieval ──
        if (["code", "research"].includes(intent.intent)) {
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
          } catch { /* ignore */ }
        }

        // ── Step 7: Knowledge retrieval ──
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
            logger.debug("Knowledge retrieval failed", { error: (err as Error).message });
          }
        }
      }
    }

    // ── Step 8: Routing via ChatActor (deterministic first, LLM fallback) ──
    let result;
    const lastUserMsg = [...messages].reverse().find((m: { role: string; content: string }) => m.role === "user");

    if (lastUserMsg?.content) {
      try {
        // Try deterministic pipeline first via ChatActor
        const chatActor = getChatActor();
        const chatResponse = await chatActor.requestAndWait({
          id: requestId,
          input: lastUserMsg.content,
          history: chatMessages,
          mode: "agent",
          context: { intent: intentInfo?.intent, taskType },
        });

        if (chatResponse.content) {
          // Deterministic answer found
          result = {
            content: chatResponse.content,
            model: chatResponse.model,
            provider: chatResponse.provider,
            layer: "general" as const,
          };

          // Verify result
          const verification = verificationEngine.verifyResult(requestId, chatResponse.content);
          if (verification.overallVerdict === "fail") {
            logger.warn("[Chat] Verification failed, falling back to LLM", {
              issues: verification.issues.length,
            });
            result = undefined; // Fall through to LLM
          }
        }
      } catch (err) {
        logger.debug("[Chat] ChatActor failed, using LLM", { error: (err as Error).message });
      }

      // ── Step 9: LLM routing fallback ──
      if (!result) {
        try {
          const signal = getConsciousness().getRoutingSignal();
          const decision = await unifiedRouter.route(lastUserMsg.content, chatMessages, {
            signal,
            isTopicContinuation: messages.length > 2,
          });

          logger.info("[Chat] UnifiedRouter decision", {
            role: decision.role,
            strategy: decision.strategy,
            confidence: decision.confidence,
          });

          result = await router.executeWithRole(decision.role, chatMessages);

          // Verify LLM result
          const verification = verificationEngine.verifyResult(requestId, result.content ?? "");
          if (verification.overallVerdict === "fail") {
            logger.warn("[Chat] LLM result verification failed", {
              issues: verification.issues.length,
            });
          }

          // Record in memory
          memoryEngine.observe(result.content ?? "", "llm");

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
          const helpful = generateHelpfulError({
            operation: "routing",
            source: "UnifiedRouter",
            originalError: (err as Error).message,
          });
          logger.warn("[Chat] UnifiedRouter failed, falling back to legacy", {
            error: helpful.message,
          });

          if (intentInfo) {
            result = await router.routeByIntent(intentInfo.intent, chatMessages);
          } else if (taskType) {
            result = await router.chat(taskType, chatMessages);
          } else {
            result = await router.chat("general-chat", chatMessages);
          }
        }
      }
    } else {
      // No user message — legacy routing
      if (intentInfo) {
        result = await router.routeByIntent(intentInfo.intent, chatMessages);
      } else if (taskType) {
        result = await router.chat(taskType, chatMessages);
      } else {
        result = await router.chat("general-chat", chatMessages);
      }
    }

    // ── Step 10: Build response ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = result as any;
    const response = ctx.jsonResponse({
      ...result,
      codegraphContext: codegraphContext ? { length: codegraphContext.length } : null,
      intent: intentInfo ? {
        name: intentInfo.agentName,
        category: intentInfo.intent,
        confidence: intentInfo.confidence,
      } : null,
      runtime: {
        requestId,
        constraintViolations: constraintSolver.solve([lastUserMsg?.content ?? ""]).violations.length,
        rulesMatched: ruleEngine.evaluate({ intent: intentInfo?.intent }).filter((m) => m.matched).length,
      },
    }, 200, ctx.baseHeaders);

    wsManager.broadcast({
      type: "model.usage",
      payload: { layer: r.layer ?? r.role ?? "unknown", taskType: taskType || "auto", provider: result.provider },
      timestamp: new Date().toISOString(),
    });

    return response;
  }
  return null;
}

export async function handleAgentChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agent-chat" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { message, history = [], taskType } = body;
    const { intent, messages: agentMessages } = buildAgentMessages(message, history);

    // Consciousness observe
    try {
      getConsciousness().observe(message, { intent: intent.intent, agentName: intent.agentName });
    } catch { /* non-fatal */ }

    // Memory observe
    memoryEngine.observe(message, "user");

    // Constraint check
    const constraintResult = constraintSolver.solve([message]);

    let result;
    if (intent) {
      result = await router.routeByIntent(intent.intent, agentMessages);
    } else if (taskType) {
      result = await router.chat(taskType, agentMessages);
    } else {
      result = await router.chat("general-chat", agentMessages);
    }

    // Verify result
    const verification = verificationEngine.verifyResult(`agent_${Date.now()}`, result.content ?? "");

    const response = ctx.jsonResponse({
      ...result,
      intent: intent ? {
        name: intent.agentName,
        category: intent.intent,
        confidence: intent.confidence,
      } : null,
      runtime: {
        constraintViolations: constraintResult.violations.length,
        verificationPassed: verification.overallVerdict === "pass",
      },
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
