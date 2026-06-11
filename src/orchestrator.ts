/**
 * OpenClaw AI Agent - System Orchestrator v2.3.0
 * Integrates code retrieval router, context manager, graceful degradation,
 * and enhanced file watcher into the main system.
 */

import {
  MultiPlatformRouter,
  type ChatMessage,
  type SmartAssignmentResponse,
} from './router/model-router.js';
import { CodeRetrievalRouter } from './router/code-retrieval-router.js';
import { ContextManager } from './context/context-manager.js';
import { GracefulDegradationRouter } from './router/graceful-degradation.js';
import { EnhancedFileWatcher } from './memory/enhanced-watcher.js';
import type { EnhancedWatcherOptions } from './memory/enhanced-watcher.js';
import { PiAgentAdapter } from './pi-agent/pi-agent-adapter.js';
import { getOptimalRoute, recordOutcome, type RoutingDecision } from './router/intelligent-router.js';
import { type TaskRole } from './router/models.js';
import { logger } from './utils/logger.js';

export interface OrchestratorConfig {
  enableCodeRetrieval: boolean;
  enableContextManagement: boolean;
  enableGracefulDegradation: boolean;
  enableEnhancedWatcher: boolean;
  enablePiAgent: boolean;
  /**
   * When true, use IntelligentRouter to determine role/complexity from the
   * user's messages instead of always hardcoding `code-generation`.
   * Defaults to true.
   */
  enableIntelligentRouting: boolean;
  contextThreshold: number;
  codeRetrievalThreshold: number;
  piAgentCwd?: string;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  enableCodeRetrieval: true,
  enableContextManagement: true,
  enableGracefulDegradation: true,
  enableEnhancedWatcher: true,
  enablePiAgent: true,
  enableIntelligentRouting: true,
  contextThreshold: 0.6,
  codeRetrievalThreshold: 0.5,
};

export class SystemOrchestrator {
  private router: MultiPlatformRouter;
  private codeRetrieval?: CodeRetrievalRouter;
  private contextManager?: ContextManager;
  private degradationRouter?: GracefulDegradationRouter;
  private enhancedWatcher?: EnhancedFileWatcher;
  private piAgent?: PiAgentAdapter;
  private config: OrchestratorConfig;
  private lastDecision?: RoutingDecision;

  constructor(
    router: MultiPlatformRouter,
    config: Partial<OrchestratorConfig> = {}
  ) {
    this.router = router;
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.enableCodeRetrieval) {
      this.codeRetrieval = new CodeRetrievalRouter();
    }

    if (this.config.enableContextManagement) {
      this.contextManager = new ContextManager();
    }

    if (this.config.enableGracefulDegradation) {
      this.degradationRouter = new GracefulDegradationRouter();
    }

    if (this.config.enablePiAgent) {
      this.piAgent = new PiAgentAdapter(this.config.piAgentCwd);
    }
  }

  /**
   * Initialize enhanced file watcher for a workspace
   */
  initializeFileWatcher(
    opts: EnhancedWatcherOptions
  ): EnhancedFileWatcher | undefined {
    if (!this.config.enableEnhancedWatcher) return undefined;

    this.enhancedWatcher = new EnhancedFileWatcher(opts);
    this.enhancedWatcher.start();
    return this.enhancedWatcher;
  }

  /**
   * Main entry point for processing user requests
   */
  async processRequest(
    messages: ChatMessage[],
    requestId: string
  ): Promise<SmartAssignmentResponse> {
    const startTime = Date.now();

    // Step 1: Check context usage and optimize if needed
    let optimizedMessages = messages;
    let contextUsagePercent = 0;
    if (this.contextManager) {
      const stats = this.contextManager.getStats();
      contextUsagePercent = stats.usagePercent;
      if (stats.usagePercent > this.config.contextThreshold * 100) {
        optimizedMessages = await this.contextManager.getEffectiveContext(
          messages
        );
      }
    }

    // Step 2: Determine if code retrieval is needed
    let codeContext = '';
    let piAgentUsed = false;
    let tokensSaved = 0;

    if (this.codeRetrieval && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.content) {
        const analysis = await this.codeRetrieval.analyzeQuery(lastMessage.content);
        if (analysis.confidence > this.config.codeRetrievalThreshold) {
          // 优先使用 Pi Agent 进行本地检索（零 token 消耗）
          if (this.piAgent && analysis.suggestedStrategy === 'pi-agent') {
            const piResult = await this.piAgent.retrieveCodeContext(lastMessage.content);
            if (piResult.success) {
              codeContext = piResult.content;
              piAgentUsed = true;
              tokensSaved = piResult.tokenSaved;
            }
          }

          // 如果 Pi Agent 未使用或失败，使用 CodeGraph 检索
          if (!codeContext) {
            const strategy = await this.codeRetrieval.selectStrategy(analysis);
            const retrievalResult = await this.codeRetrieval.executeRetrieval(
              lastMessage.content,
              analysis,
              strategy
            );
            codeContext = retrievalResult.context;
          }
        }
      }
    }

    // Step 3: Build enhanced messages with code context
    const enhancedMessages = this.buildEnhancedMessages(
      optimizedMessages,
      codeContext
    );

    // Step 4: Route request with graceful degradation
    // If intelligent routing is enabled, use IntelligentRouter to determine
    // the right role based on user intent + message complexity. Otherwise
    // fall back to the historical hardcoded `code-generation` role.
    let selectedRole: TaskRole = 'code-generation';
    let intelligentDecision: RoutingDecision | undefined;
    if (this.config.enableIntelligentRouting) {
      try {
        const decision = getOptimalRoute({ messages: enhancedMessages });
        intelligentDecision = decision;
        this.lastDecision = decision;
        selectedRole = decision.role;
        logger.info(`[Orchestrator] Intelligent routing → intent=${decision.intent} role=${decision.role} complexity=${decision.complexity} confidence=${decision.confidence.toFixed(2)} model=${decision.model.id}`);
      } catch (err) {
        logger.warn('[Orchestrator] IntelligentRouter failed, falling back to code-generation', { error: (err as Error).message });
      }
    }

    let response: SmartAssignmentResponse;
    if (this.degradationRouter) {
      response = await this.degradationRouter.executeWithFallback(
        selectedRole,
        enhancedMessages,
        { timeoutMs: 30000 }
      );
    } else {
      const chatResponse = await this.router.chat(selectedRole, enhancedMessages);
      response = {
        role: selectedRole,
        model: chatResponse.model,
        provider: chatResponse.provider,
        endpoint: '',
        content: chatResponse.content,
        usage: chatResponse.usage,
        latency_ms: Date.now() - startTime,
        fallback_used: false,
      };
    }

    // Step 4b: Record the routing outcome for adaptive learning
    if (intelligentDecision) {
      try {
        recordOutcome({
          decision: intelligentDecision,
          success: !!response.content,
          latencyMs: response.latency_ms ?? Date.now() - startTime,
          errorMessage: response.content ? undefined : 'empty content',
        });
      } catch (err) {
        // Non-fatal — never break the request on outcome-recording errors
        logger.debug('[Orchestrator] recordOutcome failed', { error: (err as Error).message });
      }
    }

    // Step 5: Track response metrics
    const duration = Date.now() - startTime;
    this.logMetrics(requestId, duration, contextUsagePercent, codeContext, piAgentUsed, tokensSaved);

    return response;
  }

  /**
   * Build enhanced messages by prepending code context
   */
  private buildEnhancedMessages(
    messages: ChatMessage[],
    codeContext: string
  ): ChatMessage[] {
    if (!codeContext) return messages;

    const systemMessage: ChatMessage = {
      role: 'system',
      content: `Relevant code context:\n${codeContext}`,
    };

    const result: ChatMessage[] = [systemMessage];
    for (const msg of messages) {
      if (msg.role === 'system') {
        result[0] = {
          ...msg,
          content: `${msg.content}\n\n${systemMessage.content}`,
        };
      } else {
        result.push(msg);
      }
    }

    return result;
  }

  /**
    * Log request metrics for monitoring
    */
  private logMetrics(
    requestId: string,
    duration: number,
    contextUsagePercent: number,
    codeContext: string,
    piAgentUsed?: boolean,
    tokensSaved?: number
  ): void {
    console.log(`[Orchestrator] Request ${requestId} completed:`, {
      duration: `${duration}ms`,
      contextUsage: `${contextUsagePercent}%`,
      codeContextLength: codeContext.length,
      features: {
        codeRetrieval: !!this.codeRetrieval,
        contextManagement: !!this.contextManager,
        gracefulDegradation: !!this.degradationRouter,
        piAgent: !!this.piAgent,
      },
      piAgent: {
        used: piAgentUsed ?? false,
        tokensSaved: tokensSaved ?? 0,
      },
    });
  }

  /**
   * Get current system status
   */
  getStatus(): {
    config: OrchestratorConfig;
    components: {
      codeRetrieval: boolean;
      contextManager: boolean;
      degradationRouter: boolean;
      enhancedWatcher: boolean;
      piAgent: boolean;
      intelligentRouting: boolean;
    };
    lastDecision?: {
      intent: string;
      role: TaskRole;
      complexity: string;
      model: string;
      confidence: number;
    };
  } {
    return {
      config: this.config,
      components: {
        codeRetrieval: !!this.codeRetrieval,
        contextManager: !!this.contextManager,
        degradationRouter: !!this.degradationRouter,
        enhancedWatcher: !!this.enhancedWatcher,
        piAgent: !!this.piAgent,
        intelligentRouting: this.config.enableIntelligentRouting,
      },
      lastDecision: this.lastDecision
        ? {
            intent: this.lastDecision.intent,
            role: this.lastDecision.role,
            complexity: this.lastDecision.complexity,
            model: this.lastDecision.model.id,
            confidence: this.lastDecision.confidence,
          }
        : undefined,
    };
  }

  /**
   * Shutdown all components gracefully
   */
  async shutdown(): Promise<void> {
    if (this.enhancedWatcher) {
      this.enhancedWatcher.stop();
    }
    if (this.contextManager) {
      this.contextManager.clearMemory();
    }
  }
}

export default SystemOrchestrator;
