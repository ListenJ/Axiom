/**
 * OpenClaw AI Agent - System Orchestrator v2.2.0
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

export interface OrchestratorConfig {
  enableCodeRetrieval: boolean;
  enableContextManagement: boolean;
  enableGracefulDegradation: boolean;
  enableEnhancedWatcher: boolean;
  contextThreshold: number;
  codeRetrievalThreshold: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  enableCodeRetrieval: true,
  enableContextManagement: true,
  enableGracefulDegradation: true,
  enableEnhancedWatcher: true,
  contextThreshold: 0.6,
  codeRetrievalThreshold: 0.5,
};

export class SystemOrchestrator {
  private router: MultiPlatformRouter;
  private codeRetrieval?: CodeRetrievalRouter;
  private contextManager?: ContextManager;
  private degradationRouter?: GracefulDegradationRouter;
  private enhancedWatcher?: EnhancedFileWatcher;
  private config: OrchestratorConfig;

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
    if (this.codeRetrieval && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.content) {
        const analysis = await this.codeRetrieval.analyzeQuery(lastMessage.content);
        if (analysis.confidence > this.config.codeRetrievalThreshold) {
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

    // Step 3: Build enhanced messages with code context
    const enhancedMessages = this.buildEnhancedMessages(
      optimizedMessages,
      codeContext
    );

    // Step 4: Route request with graceful degradation
    let response: SmartAssignmentResponse;
    if (this.degradationRouter) {
      response = await this.degradationRouter.executeWithFallback(
        'code-generation',
        enhancedMessages,
        { timeoutMs: 30000 }
      );
    } else {
      const chatResponse = await this.router.chat('code-generation', enhancedMessages);
      response = {
        role: 'code-generation',
        model: chatResponse.model,
        provider: chatResponse.provider,
        endpoint: '',
        content: chatResponse.content,
        usage: chatResponse.usage,
        latency_ms: Date.now() - startTime,
        fallback_used: false,
      };
    }

    // Step 5: Track response metrics
    const duration = Date.now() - startTime;
    this.logMetrics(requestId, duration, contextUsagePercent, codeContext);

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
    codeContext: string
  ): void {
    console.log(`[Orchestrator] Request ${requestId} completed:`, {
      duration: `${duration}ms`,
      contextUsage: `${contextUsagePercent}%`,
      codeContextLength: codeContext.length,
      features: {
        codeRetrieval: !!this.codeRetrieval,
        contextManagement: !!this.contextManager,
        gracefulDegradation: !!this.degradationRouter,
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
    };
  } {
    return {
      config: this.config,
      components: {
        codeRetrieval: !!this.codeRetrieval,
        contextManager: !!this.contextManager,
        degradationRouter: !!this.degradationRouter,
        enhancedWatcher: !!this.enhancedWatcher,
      },
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
