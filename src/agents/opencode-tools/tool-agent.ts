import { logger } from "../../utils/logger.js";
import { getTokenTracker } from "../../services/index.js";
import { getGlobalBlackboard } from "../../memory/blackboard.js";
import { RateLimitedSemaphore } from "../../utils/concurrency/rate-limited-semaphore.js";
import { PiCodeToolsAdapter } from "../../pi-agent/pi-code-tools.js";
import { CodegenExecutor } from "./codegen.js";
import { ContextPreprocessor } from "./search.js";
import {
  type TaskType,
  type ExecutionStrategy,
  type OpenCodeToolResult,
  type ModelRuntimeState,
  type ComplexityAssessment,
  OPENCODE_FREE_MODELS,
  DEFAULT_OPEN_CODE_MODEL,
  hashPrompt,
  estimateTokens,
  assessComplexity,
  buildAssessmentFromStrategy,
} from "./types.js";

export class OpenCodeToolAgent {
  private piTools: PiCodeToolsAdapter;
  private modelStates = new Map<string, ModelRuntimeState>();
  private modelIndex = 0;
  private cwd: string;
  private codegen: CodegenExecutor;
  private search: ContextPreprocessor;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
    this.piTools = new PiCodeToolsAdapter(this.cwd);

    for (const m of OPENCODE_FREE_MODELS) {
      this.modelStates.set(m.id, {
        sem: new RateLimitedSemaphore({
          permits: m.concurrentLimit,
          rpm: m.rpm,
          windowMs: 60_000,
        }),
        consecutiveFailures: 0,
        circuitOpen: false,
        circuitOpenUntil: 0,
        totalCalls: 0,
        totalFailures: 0,
        droppedStarts: 0,
        latencyHistory: [],
      });
    }

    this.codegen = new CodegenExecutor(this.modelStates, this.cwd, () => this.selectNextModel());
    this.search = new ContextPreprocessor({
      piTools: this.piTools,
      cwd: this.cwd,
      codegraphReady: false,
    });
  }

  async execute(prompt: string, options?: {
    strategy?: ExecutionStrategy;
    injectContext?: boolean;
    model?: string;
    timeoutMs?: number;
    taskTypeHint?: TaskType;
    agentId?: string;
  }): Promise<OpenCodeToolResult> {
    const startTime = Date.now();
    const agentId = options?.agentId ?? "opencode-tool-agent";

    const bbKey = `task:${hashPrompt(prompt)}`;
    const bb = getGlobalBlackboard();
    const bbRead = bb.read(bbKey, { minConfidence: 0.8, fields: ["content", "strategy", "model"] });

    if (bbRead.hit && bbRead.projected) {
      const cached = bbRead.projected as Record<string, unknown>;
      logger.info("[OpenCodeToolAgent] Blackboard hit, returning cached result", { key: bbKey });
      return {
        content: String(cached.content ?? ""),
        model: String(cached.model ?? "blackboard"),
        provider: "blackboard",
        strategy: (cached.strategy as ExecutionStrategy) ?? "opencode-only",
        latencyMs: Date.now() - startTime,
        tokenSaved: estimateTokens(prompt),
        fallbackUsed: false,
        contextInjected: true,
        toolsUsed: ["blackboard"],
      };
    }

    const assessment = options?.strategy
      ? buildAssessmentFromStrategy(options.strategy, options.taskTypeHint)
      : assessComplexity(prompt, options?.taskTypeHint);

    logger.info("[OpenCodeToolAgent] Task assessed", {
      score: assessment.score,
      type: assessment.taskType,
      strategy: assessment.recommendedStrategy,
      reasons: assessment.reasons,
    });

    const { enhancedPrompt, toolsUsed, tokenSaved: toolTokenSaved } = await this.search.preprocessWithPiTools(
      prompt,
      assessment.taskType,
      options?.injectContext !== false
    );

    let result: OpenCodeToolResult;

    switch (assessment.recommendedStrategy) {
      case "opencode-only":
        result = await this.codegen.runOpenCodeOnly(enhancedPrompt, options);
        break;
      case "parallel":
        result = await this.codegen.runParallel(enhancedPrompt, assessment.taskType, options);
        break;
      case "opencode-primary":
        result = await this.codegen.runOpenCodePrimary(enhancedPrompt, assessment.taskType, options);
        break;
      case "axiom-only":
        result = await this.codegen.runAxiomOnly(enhancedPrompt, assessment.taskType, options);
        break;
      default:
        result = await this.codegen.runOpenCodePrimary(enhancedPrompt, assessment.taskType, options);
    }

    result.tokenSaved += toolTokenSaved;
    result.toolsUsed = [...toolsUsed, ...result.toolsUsed];
    result.latencyMs = Date.now() - startTime;

    if (result.content.length > 0 && !result.fallbackUsed) {
      bb.write(bbKey, {
        content: result.content,
        strategy: result.strategy,
        model: result.model,
        prompt: prompt.slice(0, 500),
      }, agentId, {
        confidence: result.strategy === "opencode-only" ? 0.85 : 0.75,
        expireMs: 10 * 60 * 1000,
        tags: ["opencode", assessment.taskType, result.strategy],
      });
    }

    this.trackExecution(result, assessment);

    logger.info("[OpenCodeToolAgent] Execution complete", {
      strategy: result.strategy,
      model: result.model,
      latency: result.latencyMs,
      tokenSaved: result.tokenSaved,
      fallbackUsed: result.fallbackUsed,
    });

    return result;
  }

  async batchExecute(prompts: string[], options?: {
    strategy?: ExecutionStrategy;
    injectContext?: boolean;
  }): Promise<OpenCodeToolResult[]> {
    const results = await Promise.all(
      prompts.map((p) => this.execute(p, options))
    );
    return results;
  }

  getHealthReport(): Record<string, unknown> {
    const report: Record<string, unknown> = {};
    for (const m of OPENCODE_FREE_MODELS) {
      const state = this.modelStates.get(m.id)!;
      const avgLatency = state.latencyHistory.length > 0
        ? Math.round(state.latencyHistory.reduce((a, b) => a + b, 0) / state.latencyHistory.length)
        : 0;
      report[m.id] = {
        totalCalls: state.totalCalls,
        totalFailures: state.totalFailures,
        successRate: state.totalCalls > 0
          ? ((state.totalCalls - state.totalFailures) / state.totalCalls * 100).toFixed(1) + "%"
          : "N/A",
        avgLatencyMs: avgLatency,
        activeRequests: state.sem.active,
        rpmThisMinute: state.sem.currentRpm,
        droppedStarts: state.droppedStarts,
        circuitOpen: state.circuitOpen,
        health: state.circuitOpen ? "熔断" : state.consecutiveFailures > 0 ? "告警" : "健康",
      };
    }
    return report;
  }

  private selectNextModel(): string {
    const now = Date.now();
    const available: string[] = [];

    for (const m of OPENCODE_FREE_MODELS) {
      const state = this.modelStates.get(m.id)!;

      if (state.circuitOpen) {
        if (now < state.circuitOpenUntil) continue;
        state.circuitOpen = false;
        state.consecutiveFailures = 0;
      }

      if (state.sem.active >= state.sem.permits) continue;
      if (state.sem.availableRpm <= 0) continue;

      available.push(m.id);
    }

    if (available.length === 0) {
      logger.warn("[OpenCodeToolAgent] All models circuit-open or rate-limited, forcing default");
      return DEFAULT_OPEN_CODE_MODEL;
    }

    this.modelIndex = (this.modelIndex + 1) % available.length;
    return available[this.modelIndex];
  }

  private trackExecution(result: OpenCodeToolResult, assessment: ComplexityAssessment): void {
    getTokenTracker().record({
      timestamp: Date.now(),
      model: result.model,
      provider: result.provider,
      role: assessment.taskType,
      taskType: assessment.taskType,
      promptTokens: 0,
      completionTokens: estimateTokens(result.content),
      totalTokens: estimateTokens(result.content),
      latencyMs: result.latencyMs,
      contentLength: result.content.length,
      success: !result.fallbackUsed && result.content.length > 0,
      fallbackUsed: result.fallbackUsed,
    });
  }
}
