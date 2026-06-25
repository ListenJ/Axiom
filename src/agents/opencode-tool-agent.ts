/**
 * OpenCode 工具 Agent v3.0 — 免费模型驱动的轻量任务执行器
 *
 * 设计理念：OpenCode 内置免费模型，可直接执行简单任务，无需经过 OpenClaw 模型路由。
 * 将所有优化方案叠加：
 *   1. Pi Agent 本地工具预处理（grep/find/read/ls）— 零 token
 *   2. CodeGraph 索引 — 文件/符号搜索
 *   3. 任务复杂度评估 — 自动选择执行路径
 *   4. 并行执行 + 最快优先 — 同时调用 OpenCode + 主路由
 *   5. 优雅降级 — OpenCode 失败自动回退到 OpenClaw
 *   6. Token 节省追踪 — 量化收益
 *   7. 免费模型轮询 — 多模型负载均衡 + circuit breaker
 *   8. 上下文自动注入 — CodeGraph/Pi Agent 检索结果自动增强 prompt
 */
import { spawn } from "bun";
import { logger } from "../utils/logger.js";
import { router, type ChatMessage } from "../router/model-router.js";
import { toolPool } from "../router/tool-pool.js";
import { getTokenTracker } from "../router/token-tracker.js";
import { RateLimitedSemaphore } from "../utils/concurrency/rate-limited-semaphore.js";
import { PiCodeToolsAdapter } from "../pi-agent/pi-code-tools.js";
import {
  isCodegraphInitialized,
  searchSymbols,
  searchFiles,
  buildContext,
  type CodeGraphSearchResult,
} from "../memory/codegraph-index.js";
import { retrieveCodeMemory } from "../memory/codegraph-index.js";
import { getGlobalBlackboard, type WriteOptions } from "../memory/blackboard.js";
import { getReadOptimizer, type ReadRequest } from "../utils/read-optimizer.js";

// ═══════════════════════════════════════════════════════════════
// 常量与类型
// ═══════════════════════════════════════════════════════════════

/** OpenCode 免费模型（按推荐度排序） */
export const OPENCODE_FREE_MODELS = [
  { id: "opencode/deepseek-v4-flash-free", rpm: 30, concurrentLimit: 2, context: 128000, priority: 1 },
  { id: "opencode/big-pickle", rpm: 20, concurrentLimit: 2, context: 64000, priority: 2 },
  { id: "opencode/nemotron-3-super-free", rpm: 20, concurrentLimit: 2, context: 128000, priority: 3 },
];

/** 默认编码模型 */
export const DEFAULT_OPEN_CODE_MODEL = process.env.OPENCODE_DEFAULT_MODEL || OPENCODE_FREE_MODELS[0].id;

/** 复杂度阈值（字符数/turn 数） */
const COMPLEXITY_THRESHOLDS = {
  maxPromptLength: 8000,      // 超过则认为复杂
  maxContextLines: 200,       // 代码上下文行数上限
  maxFiles: 5,                // 涉及文件数上限
};

/** 任务类型 */
export type TaskType =
  | "code-complete"     // 代码补全
  | "code-explain"      // 代码解释
  | "file-search"       // 文件查找
  | "symbol-search"     // 符号搜索
  | "quick-fix"         // 快速修复
  | "simple-chat"       // 简单对话
  | "doc-generate"      // 文档生成
  | "test-scaffold";    // 测试脚手架

/** 执行策略 */
export type ExecutionStrategy =
  | "opencode-only"     // 仅 OpenCode（最简单任务）
  | "parallel"          // 并行 OpenCode + OpenClaw（取最快）
  | "opencode-primary"  // OpenCode 优先，失败回退
  | "openclaw-only";    // 仅 OpenClaw（最复杂任务）

/** 执行结果 */
export interface OpenCodeToolResult {
  content: string;
  model: string;
  provider: string;
  strategy: ExecutionStrategy;
  latencyMs: number;
  tokenSaved: number;         // 估算节省的 token
  fallbackUsed: boolean;
  contextInjected: boolean;
  toolsUsed: string[];        // 使用的本地工具
}

/**
 * 运行时状态 — Phase Audit-#1 migration.
 *
 * Old: lastMinuteRequests: number[] (O(n) per query via filter scan) +
 *      activeRequests: number (counter).
 * New: a single per-model RateLimitedSemaphore that owns both the
 *      concurrent-slot gate and the rolling 60s RPM window with O(1)
 *      admission. Other state (circuit, latency, totals) is unchanged.
 */
interface ModelRuntimeState {
  sem: RateLimitedSemaphore;
  consecutiveFailures: number;
  circuitOpen: boolean;
  circuitOpenUntil: number;
  totalCalls: number;
  totalFailures: number;
  /** Times markRequestStart was called but the semaphore was full (race). */
  droppedStarts: number;
  latencyHistory: number[];
}

/** 任务复杂度评估结果 */
interface ComplexityAssessment {
  score: number;              // 0-100，越高越复杂
  taskType: TaskType;
  recommendedStrategy: ExecutionStrategy;
  reasons: string[];
}

// ═══════════════════════════════════════════════════════════════
// OpenCode 工具 Agent 主类
// ═══════════════════════════════════════════════════════════════

export class OpenCodeToolAgent {
  private piTools: PiCodeToolsAdapter;
  private modelStates = new Map<string, ModelRuntimeState>();
  private modelIndex = 0; // round-robin 索引
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
    this.piTools = new PiCodeToolsAdapter(this.cwd);

    // 初始化模型状态 — 每个模型一个 RateLimitedSemaphore
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
  }

  // ---------------------------------------------------------------------------
  // 公共 API
  // ---------------------------------------------------------------------------

  /**
   * 执行用户请求 — 智能路由到 OpenCode 或 OpenClaw
   *
   * 叠加所有优化方案:
   *   1. 黑板优先 (Blackboard-First) — 检查是否已有相同任务结果
   *   2. 读取优化管道 — 通过 ReadOptimizerFacade 统一读取
   *   3. Pi Agent 本地工具预处理（零 token）
   *   4. CodeGraph 上下文注入
   *   5. 任务复杂度评估 — 自动选择执行路径
   *   6. 并行执行 + 最快优先
   *   7. 优雅降级
   *   8. Token 节省追踪
   *   9. 结果写入黑板 — 供其他 Agent 复用
   */
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

    // ===== Step 0: 黑板优先读取 (Blackboard-First) =====
    const bbKey = `task:${this.hashPrompt(prompt)}`;
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
        tokenSaved: this.estimateTokens(prompt),
        fallbackUsed: false,
        contextInjected: true,
        toolsUsed: ["blackboard"],
      };
    }

    // ===== Step 1: 任务复杂度评估 =====
    const assessment = options?.strategy
      ? this.buildAssessmentFromStrategy(options.strategy, options.taskTypeHint)
      : await this.assessComplexity(prompt, options?.taskTypeHint);

    logger.info("[OpenCodeToolAgent] Task assessed", {
      score: assessment.score,
      type: assessment.taskType,
      strategy: assessment.recommendedStrategy,
      reasons: assessment.reasons,
    });

    // ===== Step 2: Pi Agent 本地工具预处理（通过读取优化管道） =====
    const { enhancedPrompt, toolsUsed, tokenSaved: toolTokenSaved } = await this.preprocessWithPiTools(
      prompt,
      assessment.taskType,
      options?.injectContext !== false
    );

    // ===== Step 3: 按策略执行 =====
    let result: OpenCodeToolResult;

    switch (assessment.recommendedStrategy) {
      case "opencode-only":
        result = await this.runOpenCodeOnly(enhancedPrompt, options);
        break;
      case "parallel":
        result = await this.runParallel(enhancedPrompt, assessment.taskType, options);
        break;
      case "opencode-primary":
        result = await this.runOpenCodePrimary(enhancedPrompt, assessment.taskType, options);
        break;
      case "openclaw-only":
        result = await this.runOpenClawOnly(enhancedPrompt, assessment.taskType, options);
        break;
      default:
        result = await this.runOpenCodePrimary(enhancedPrompt, assessment.taskType, options);
    }

    result.tokenSaved += toolTokenSaved;
    result.toolsUsed = [...toolsUsed, ...result.toolsUsed];
    result.latencyMs = Date.now() - startTime;

    // ===== Step 4: 结果写入黑板（供其他 Agent 复用） =====
    if (result.content.length > 0 && !result.fallbackUsed) {
      bb.write(bbKey, {
        content: result.content,
        strategy: result.strategy,
        model: result.model,
        prompt: prompt.slice(0, 500),
      }, agentId, {
        confidence: result.strategy === "opencode-only" ? 0.85 : 0.75,
        expireMs: 10 * 60 * 1000, // 10 分钟过期
        tags: ["opencode", assessment.taskType, result.strategy],
      });
    }

    // ===== Step 5: Token 追踪 =====
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

  /**
   * 批量执行（并行处理多个简单任务）
   */
  async batchExecute(prompts: string[], options?: {
    strategy?: ExecutionStrategy;
    injectContext?: boolean;
  }): Promise<OpenCodeToolResult[]> {
    const results = await Promise.all(
      prompts.map((p) => this.execute(p, options))
    );
    return results;
  }

  /**
   * 健康状态报告
   */
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
        health: state.circuitOpen ? "🔴熔断" : state.consecutiveFailures > 0 ? "🟡告警" : "🟢健康",
      };
    }
    return report;
  }

  // ---------------------------------------------------------------------------
  // 策略执行器
  // ---------------------------------------------------------------------------

  /** 仅 OpenCode — 最简单、最快 */
  private async runOpenCodeOnly(
    prompt: string,
    options?: { model?: string; timeoutMs?: number }
  ): Promise<OpenCodeToolResult> {
    const model = this.selectNextModel();
    const result = await this.callOpenCode(prompt, model, options?.timeoutMs);

    return {
      content: result.content,
      model: result.model,
      provider: "opencode",
      strategy: "opencode-only",
      latencyMs: result.latencyMs,
      tokenSaved: this.estimateTokenSaved(prompt, result.content),
      fallbackUsed: false,
      contextInjected: prompt.length > 500, // 如果 prompt 被增强过
      toolsUsed: [],
    };
  }

  /** 并行执行：OpenCode + OpenClaw 同时调用，取最快 */
  private async runParallel(
    prompt: string,
    taskType: TaskType,
    options?: { model?: string; timeoutMs?: number }
  ): Promise<OpenCodeToolResult> {
    const startTime = Date.now();
    const model = this.selectNextModel();

    const opencodePromise = this.callOpenCode(prompt, model, options?.timeoutMs ?? 30000)
      .then((r): { source: "opencode"; result: typeof r } => ({ source: "opencode", result: r }))
      .catch((err): { source: "opencode"; result: { content: string; model: string; latencyMs: number; error?: string } } => ({
        source: "opencode",
        result: { content: "", model, latencyMs: 0, error: err.message },
      }));

    const openclawPromise = this.callOpenClaw(prompt, taskType)
      .then((r): { source: "openclaw"; result: typeof r } => ({ source: "openclaw", result: r }))
      .catch((err): { source: "openclaw"; result: { content: string; model: string; provider: string; latencyMs: number; error?: string } } => ({
        source: "openclaw",
        result: { content: "", model: "", provider: "", latencyMs: 0, error: err.message },
      }));

    // 等待第一个成功返回的
    const winner = await Promise.race([opencodePromise, openclawPromise]);

    // 如果 OpenCode 赢了
    if (winner.source === "opencode" && winner.result.content) {
      const latencyMs = Date.now() - startTime;
      return {
        content: winner.result.content,
        model: winner.result.model,
        provider: "opencode",
        strategy: "parallel",
        latencyMs,
        tokenSaved: this.estimateTokenSaved(prompt, winner.result.content),
        fallbackUsed: false,
        contextInjected: true,
        toolsUsed: [],
      };
    }

    // 如果 OpenClaw 赢了或 OpenCode 失败，等待另一个
    const settled = await Promise.allSettled([opencodePromise, openclawPromise]);

    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.result.content && !("error" in s.value.result)) {
        const isOpenCode = s.value.source === "opencode";
        return {
          content: s.value.result.content,
          model: s.value.result.model,
          provider: isOpenCode ? "opencode" : (s.value.result as any).provider || "openclaw",
          strategy: "parallel",
          latencyMs: Date.now() - startTime,
          tokenSaved: isOpenCode ? this.estimateTokenSaved(prompt, s.value.result.content) : 0,
          fallbackUsed: !isOpenCode,
          contextInjected: true,
          toolsUsed: [],
        };
      }
    }

    // 全部失败
    return {
      content: "[System] All execution paths failed for this task.",
      model: "degraded",
      provider: "local",
      strategy: "parallel",
      latencyMs: Date.now() - startTime,
      tokenSaved: 0,
      fallbackUsed: true,
      contextInjected: true,
      toolsUsed: [],
    };
  }

  /** OpenCode 优先，失败回退到 OpenClaw */
  private async runOpenCodePrimary(
    prompt: string,
    taskType: TaskType,
    options?: { model?: string; timeoutMs?: number }
  ): Promise<OpenCodeToolResult> {
    const startTime = Date.now();
    const model = this.selectNextModel();

    try {
      const ocResult = await this.callOpenCode(prompt, model, options?.timeoutMs ?? 30000);
      return {
        content: ocResult.content,
        model: ocResult.model,
        provider: "opencode",
        strategy: "opencode-primary",
        latencyMs: Date.now() - startTime,
        tokenSaved: this.estimateTokenSaved(prompt, ocResult.content),
        fallbackUsed: false,
        contextInjected: true,
        toolsUsed: [],
      };
    } catch (error) {
      logger.warn("[OpenCodeToolAgent] OpenCode failed, falling back to OpenClaw", {
        model,
        error: error instanceof Error ? error.message : String(error),
      });

      const ocResult = await this.callOpenClaw(prompt, taskType);
      return {
        content: ocResult.content,
        model: ocResult.model,
        provider: ocResult.provider,
        strategy: "opencode-primary",
        latencyMs: Date.now() - startTime,
        tokenSaved: 0,
        fallbackUsed: true,
        contextInjected: true,
        toolsUsed: [],
      };
    }
  }

  /** 仅 OpenClaw — 复杂任务 */
  private async runOpenClawOnly(
    prompt: string,
    taskType: TaskType,
    _options?: { model?: string; timeoutMs?: number }
  ): Promise<OpenCodeToolResult> {
    const startTime = Date.now();
    const result = await this.callOpenClaw(prompt, taskType);

    return {
      content: result.content,
      model: result.model,
      provider: result.provider,
      strategy: "openclaw-only",
      latencyMs: Date.now() - startTime,
      tokenSaved: 0,
      fallbackUsed: false,
      contextInjected: true,
      toolsUsed: [],
    };
  }

  // ---------------------------------------------------------------------------
  // 底层调用
  // ---------------------------------------------------------------------------

  /** 调用 OpenCode CLI */
  private async callOpenCode(
    prompt: string,
    model: string,
    timeoutMs = 30000
  ): Promise<{ content: string; model: string; latencyMs: number }> {
    const startTime = Date.now();
    const state = this.modelStates.get(model)!;

    // 标记请求开始 — sem.tryAcquire() 是 O(1) 原子操作，
    // 如果模型已满（concurrent 或 RPM），记录到 droppedStarts 供运维监控。
    if (!state.sem.tryAcquire()) {
      state.droppedStarts++;
      state.totalCalls++;
      throw new Error(`[OpenCodeToolAgent] model ${model} is at capacity (active=${state.sem.active}/${state.sem.permits}, rpm=${state.sem.currentRpm}/${state.sem.rpm})`);
    }
    state.totalCalls++;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const proc = spawn({
        cmd: ["opencode", "run", "--model", model, "--pure", prompt],
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.cwd,
        env: { ...process.env },
      });

      const textDecoder = new TextDecoder();
      let output = "";
      let stderr = "";

      // 读取 stdout
      const stdoutReader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          output += textDecoder.decode(value, { stream: true });
        }
      } finally {
        stdoutReader.releaseLock();
      }

      // 读取 stderr
      const stderrReader = proc.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderr += textDecoder.decode(value, { stream: true });
        }
      } finally {
        stderrReader.releaseLock();
      }

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const latencyMs = Date.now() - startTime;
      state.sem.tryRelease();

      if (exitCode !== 0 && !output) {
        state.consecutiveFailures++;
        this.checkCircuitBreaker(model, state);
        throw new Error(`OpenCode exited with code ${exitCode}: ${stderr}`);
      }

      // 成功
      state.consecutiveFailures = 0;
      state.latencyHistory.push(latencyMs);
      if (state.latencyHistory.length > 10) state.latencyHistory.shift();

      // 清理输出（去除 ANSI 颜色码）
      const cleaned = this.stripAnsi(output || stderr);

      return { content: cleaned, model, latencyMs };
    } catch (error) {
      clearTimeout(timer);
      state.sem.tryRelease();
      state.consecutiveFailures++;
      state.totalFailures++;
      this.checkCircuitBreaker(model, state);
      throw error;
    }
  }

  /** 调用 OpenClaw 模型路由 */
  private async callOpenClaw(
    prompt: string,
    taskType: TaskType
  ): Promise<{ content: string; model: string; provider: string }> {
    const role = this.mapTaskTypeToRole(taskType);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt },
    ];

    const result = await router.execute({ role, messages, trackAs: taskType });

    return {
      content: result.content || "",
      model: result.model,
      provider: result.provider,
    };
  }

  // ---------------------------------------------------------------------------
  // Pi Agent 预处理
  // ---------------------------------------------------------------------------

  /**
   * 使用 Pi Agent 本地工具预处理 prompt（通过读取优化管道）
   *
   * 叠加优化:
   *   - 黑板优先 (Blackboard-First)
   *   - 读取优化管道 (ReadOptimizerFacade)
   *   - 字段投影 (列裁剪)
   *   - 请求去重
   */
  private async preprocessWithPiTools(
    prompt: string,
    taskType: TaskType,
    injectContext: boolean
  ): Promise<{ enhancedPrompt: string; toolsUsed: string[]; tokenSaved: number }> {
    if (!injectContext) {
      return { enhancedPrompt: prompt, toolsUsed: [], tokenSaved: 0 };
    }

    const toolsUsed: string[] = [];
    let contextParts: string[] = [];
    let tokenSaved = 0;

    // 提取 prompt 中的潜在标识符
    const identifiers = this.extractIdentifiersFromPrompt(prompt);

    // 使用读取优化门面执行所有读取操作
    const facade = getReadOptimizer();

    switch (taskType) {
      case "code-complete":
      case "quick-fix":
      case "code-explain": {
        if (identifiers.length > 0) {
          // 通过优化管道 grep 搜索（带字段投影）
          const grepReq: ReadRequest = {
            resource: "pi-tools",
            action: "grep",
            params: { query: identifiers[0], path: this.cwd },
            fields: ["content", "success"],
            agentId: "opencode-tool-agent",
            cacheTtlMs: 30 * 1000,
          };

          // 先查黑板是否有该标识符的搜索结果
          const bb = getGlobalBlackboard();
          const bbGrepKey = `grep:${identifiers[0]}:${this.cwd}`;
          const bbGrep = bb.read(bbGrepKey, { minConfidence: 0.7 });

          let grepResultContent = "";
          if (bbGrep.hit && bbGrep.entry) {
            grepResultContent = String(bbGrep.entry.value ?? "");
            toolsUsed.push("blackboard:grep");
          } else {
            const grepResult = await this.piTools.grep(identifiers[0], { path: this.cwd });
            if (grepResult.success && grepResult.content) {
              grepResultContent = grepResult.content;
              toolsUsed.push("grep");
              tokenSaved += this.estimateTokens(grepResultContent);
              // 写入黑板
              bb.write(bbGrepKey, grepResultContent, "opencode-tool-agent", {
                confidence: 0.8,
                expireMs: 60 * 1000,
                tags: ["grep", identifiers[0]],
              });
            }
          }

          if (grepResultContent) {
            contextParts.push(`## 代码搜索结果\n${grepResultContent}`);

            // 读取最相关的文件（通过优化管道，字段投影）
            const filePaths = this.extractFilePaths(grepResultContent).slice(0, 2);
            for (const fp of filePaths) {
              const bbReadKey = `read:${fp}`;
              const bbRead = bb.read(bbReadKey, { minConfidence: 0.7 });

              let fileContent = "";
              if (bbRead.hit && bbRead.entry) {
                fileContent = String(bbRead.entry.value ?? "");
                toolsUsed.push("blackboard:read");
              } else {
                const readResult = await this.piTools.readFile(fp, { limit: 50 });
                if (readResult.success) {
                  fileContent = readResult.content;
                  toolsUsed.push(`read:${fp}`);
                  tokenSaved += this.estimateTokens(fileContent);
                  // 写入黑板
                  bb.write(bbReadKey, fileContent, "opencode-tool-agent", {
                    confidence: 0.9,
                    expireMs: 2 * 60 * 1000,
                    tags: ["read", fp],
                  });
                }
              }

              if (fileContent) {
                contextParts.push(`## 文件: ${fp}\n${fileContent}`);
              }
            }
          }
        }
        break;
      }

      case "file-search": {
        const bb = getGlobalBlackboard();
        const globPattern = this.extractGlobPattern(prompt);
        if (globPattern) {
          const bbFindKey = `find:${globPattern}:${this.cwd}`;
          const bbFind = bb.read(bbFindKey, { minConfidence: 0.7 });

          let findResultContent = "";
          if (bbFind.hit && bbFind.entry) {
            findResultContent = String(bbFind.entry.value ?? "");
            toolsUsed.push("blackboard:find");
          } else {
            const findResult = await this.piTools.findFiles(globPattern, { path: this.cwd });
            if (findResult.success && findResult.content) {
              findResultContent = findResult.content;
              toolsUsed.push("find");
              // 写入黑板
              bb.write(bbFindKey, findResultContent, "opencode-tool-agent", {
                confidence: 0.9,
                expireMs: 60 * 1000,
                tags: ["find", globPattern],
              });
            }
          }

          if (findResultContent) {
            contextParts.push(`## 文件列表\n${findResultContent}`);
          }
        }
        break;
      }

      case "symbol-search": {
        const bb = getGlobalBlackboard();
        if (identifiers.length > 0 && await isCodegraphInitialized(this.cwd)) {
          const bbSymbolKey = `symbol:${identifiers[0]}`;
          const bbSymbol = bb.read(bbSymbolKey, { minConfidence: 0.7 });

          let symbols: { kind: string; name: string; filePath: string; startLine: number }[] = [];
          if (bbSymbol.hit && bbSymbol.entry) {
            symbols = bbSymbol.entry.value as typeof symbols;
            toolsUsed.push("blackboard:symbol");
          } else {
            const cgSymbols = await searchSymbols(identifiers[0], { limit: 10, projectPath: this.cwd });
            symbols = cgSymbols.map((s) => ({
              kind: s.node.kind,
              name: s.node.name,
              filePath: s.node.filePath,
              startLine: s.node.startLine,
            }));
            if (symbols.length > 0) {
              toolsUsed.push("codegraph:searchSymbols");
              tokenSaved += symbols.length * 50;
              // 写入黑板
              bb.write(bbSymbolKey, symbols, "opencode-tool-agent", {
                confidence: 0.85,
                expireMs: 3 * 60 * 1000,
                tags: ["symbol", identifiers[0]],
              });
            }
          }

          if (symbols.length > 0) {
            contextParts.push(`## 符号搜索结果\n${symbols.map((s) => `${s.kind} ${s.name} (${s.filePath}:${s.startLine})`).join("\n")}`);
          }
        }
        break;
      }

      case "doc-generate":
      case "test-scaffold": {
        const bb = getGlobalBlackboard();
        if (identifiers.length > 0) {
          const bbGrepKey = `grep:${identifiers[0]}:${this.cwd}`;
          const bbGrep = bb.read(bbGrepKey, { minConfidence: 0.7 });

          let grepContent = "";
          if (bbGrep.hit && bbGrep.entry) {
            grepContent = String(bbGrep.entry.value ?? "");
          } else {
            const grepResult = await this.piTools.grep(identifiers[0], { path: this.cwd });
            if (grepResult.success && grepResult.content) {
              grepContent = grepResult.content;
              toolsUsed.push("grep");
            }
          }

          if (grepContent) {
            contextParts.push(`## 相关代码\n${grepContent}`);
          }

          // 查找已有测试/文档作为参考
          const refPattern = taskType === "test-scaffold" ? "*.test.*" : "*.md";
          const findResult = await this.piTools.findFiles(refPattern, { path: this.cwd });
          if (findResult.success && findResult.content) {
            const refs = findResult.content.split("\n").filter(Boolean).slice(0, 2);
            for (const ref of refs) {
              const readResult = await this.piTools.readFile(ref, { limit: 30 });
              if (readResult.success) {
                toolsUsed.push(`read:${ref}`);
                contextParts.push(`## 参考: ${ref}\n${readResult.content}`);
              }
            }
          }
        }
        break;
      }

      default:
        break;
    }

    // 构建增强 prompt
    if (contextParts.length > 0) {
      const enhanced = `${contextParts.join("\n\n---\n\n")}\n\n---\n\n## 任务\n\n${prompt}`;
      return { enhancedPrompt: enhanced, toolsUsed, tokenSaved };
    }

    return { enhancedPrompt: prompt, toolsUsed, tokenSaved };
  }

  // ---------------------------------------------------------------------------
  // 复杂度评估
  // ---------------------------------------------------------------------------

  /** 评估任务复杂度 */
  private async assessComplexity(prompt: string, typeHint?: TaskType): Promise<ComplexityAssessment> {
    const reasons: string[] = [];
    let score = 0;

    // 1. prompt 长度
    if (prompt.length > COMPLEXITY_THRESHOLDS.maxPromptLength) {
      score += 30;
      reasons.push("Prompt 过长（>8000 字符）");
    } else if (prompt.length > 4000) {
      score += 15;
      reasons.push("Prompt 较长");
    }

    // 2. 多步骤指示
    const steps = (prompt.match(/\b(step|步骤|首先|然后|最后|接着|之后)\b/gi) || []).length;
    if (steps >= 3) {
      score += 20;
      reasons.push("多步骤任务");
    }

    // 3. 涉及多个文件
    const fileRefs = prompt.match(/\b\w+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c)\b/g);
    if (fileRefs && fileRefs.length > COMPLEXITY_THRESHOLDS.maxFiles) {
      score += 20;
      reasons.push(`涉及 ${fileRefs.length} 个文件`);
    }

    // 4. 架构/设计关键词
    const complexKeywords = /\b(architecture|design|system|refactor|implement|framework|微服务|架构|设计|系统|框架)\b/gi;
    if (complexKeywords.test(prompt)) {
      score += 15;
      reasons.push("涉及架构/设计");
    }

    // 5. 推理/数学关键词
    const reasoningKeywords = /\b(reasoning|math|algorithm|prove|optimize|证明|算法|优化|推导)\b/gi;
    if (reasoningKeywords.test(prompt)) {
      score += 15;
      reasons.push("需要推理/数学能力");
    }

    // 6. 基于类型提示调整
    let taskType = typeHint || this.inferTaskType(prompt);

    if (taskType === "simple-chat") score = Math.max(0, score - 20);
    if (taskType === "file-search") score = Math.max(0, score - 30);
    if (taskType === "code-complete") score = Math.max(0, score - 10);

    score = Math.min(100, Math.max(0, score));

    // 确定策略
    let strategy: ExecutionStrategy;
    if (score < 20) {
      strategy = "opencode-only";
      reasons.push("简单任务 → OpenCode 直接执行");
    } else if (score < 40) {
      strategy = "parallel";
      reasons.push("中等复杂度 → 并行执行取最快");
    } else if (score < 60) {
      strategy = "opencode-primary";
      reasons.push("较复杂 → OpenCode 优先，失败回退");
    } else {
      strategy = "openclaw-only";
      reasons.push("复杂任务 → 直接走 OpenClaw 主力模型");
    }

    return { score, taskType, recommendedStrategy: strategy, reasons };
  }

  private buildAssessmentFromStrategy(strategy: ExecutionStrategy, typeHint?: TaskType): ComplexityAssessment {
    return {
      score: strategy === "opencode-only" ? 10 : strategy === "parallel" ? 30 : strategy === "opencode-primary" ? 50 : 80,
      taskType: typeHint || "simple-chat",
      recommendedStrategy: strategy,
      reasons: ["用户指定策略"],
    };
  }

  /** 推断任务类型 */
  private inferTaskType(prompt: string): TaskType {
    const p = prompt.toLowerCase();

    if (/\b(find|search|查找|搜索|where is|locate)\b/.test(p) && /\.(ts|js|tsx|jsx|py|go|json|md|yaml)\b/.test(p)) {
      return "file-search";
    }
    if (/\b(symbol|class|function|interface|定义|声明)\b/.test(p) && /\b(where|find|search|查找)\b/.test(p)) {
      return "symbol-search";
    }
    if (/\b(complete|补全|finish|fill|implement)\b/.test(p)) {
      return "code-complete";
    }
    if (/\b(explain|解释|what does|how does|说明)\b/.test(p)) {
      return "code-explain";
    }
    if (/\b(fix|bug|debug|修复|错误|bug)\b/.test(p)) {
      return "quick-fix";
    }
    if (/\b(document|doc|文档|注释|jsdoc)\b/.test(p)) {
      return "doc-generate";
    }
    if (/\b(test|测试|unit test|spec)\b/.test(p)) {
      return "test-scaffold";
    }

    return "simple-chat";
  }

  // ---------------------------------------------------------------------------
  // 模型选择
  // ---------------------------------------------------------------------------

  /** 选择下一个可用模型（round-robin + circuit breaker） */
  private selectNextModel(): string {
    const now = Date.now();
    const available: string[] = [];

    for (const m of OPENCODE_FREE_MODELS) {
      const state = this.modelStates.get(m.id)!;

      // 检查熔断器（RateLimitedSemaphore 不管熔断，单独处理）
      if (state.circuitOpen) {
        if (now < state.circuitOpenUntil) continue;
        // 熔断器自动恢复
        state.circuitOpen = false;
        state.consecutiveFailures = 0;
      }

      // 并发限制：O(1) 读 sem.active vs sem.permits
      if (state.sem.active >= state.sem.permits) continue;

      // RPM 限制：O(1) 读 sem.availableRpm
      if (state.sem.availableRpm <= 0) continue;

      available.push(m.id);
    }

    if (available.length === 0) {
      // 所有模型都不可用，强制使用默认
      logger.warn("[OpenCodeToolAgent] All models circuit-open or rate-limited, forcing default");
      return DEFAULT_OPEN_CODE_MODEL;
    }

    // Round-robin
    this.modelIndex = (this.modelIndex + 1) % available.length;
    return available[this.modelIndex];
  }

  /** 检查并触发熔断器 */
  private checkCircuitBreaker(modelId: string, state: ModelRuntimeState): void {
    if (state.consecutiveFailures >= 3) {
      state.circuitOpen = true;
      state.circuitOpenUntil = Date.now() + 60000;
      logger.warn(`[OpenCodeToolAgent] Circuit breaker OPEN for ${modelId}`, {
        resumeAt: new Date(state.circuitOpenUntil).toISOString(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 辅助方法
  // ---------------------------------------------------------------------------

  private mapTaskTypeToRole(taskType: TaskType): import("../router/model-capability-registry.js").TaskRole {
    switch (taskType) {
      case "code-complete":
      case "quick-fix":
      case "test-scaffold":
        return "coding";
      case "code-explain":
      case "doc-generate":
        return "general-chat";
      case "file-search":
      case "symbol-search":
        return "general-tool";
      default:
        return "general-chat";
    }
  }

  private extractIdentifiersFromPrompt(prompt: string): string[] {
    const identifiers: string[] = [];

    // 匹配函数/类/变量名
    const matches = prompt.match(/\b([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+)\b/g);
    if (matches) {
      for (const id of matches) {
        if (id.length > 2 && !this.isCommonWord(id)) {
          identifiers.push(id);
        }
      }
    }

    // 匹配文件名
    const fileMatches = prompt.match(/\b\w+\.(ts|js|tsx|jsx|py|go|rs)\b/g);
    if (fileMatches) {
      for (const f of fileMatches) {
        const base = f.replace(/\.(ts|js|tsx|jsx|py|go|rs)$/, "");
        if (!identifiers.includes(base)) identifiers.push(base);
      }
    }

    return [...new Set(identifiers)].slice(0, 5);
  }

  private isCommonWord(word: string): boolean {
    const common = new Set([
      "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our",
      "this", "that", "with", "have", "from", "they", "she", "will", "would", "there", "their", "what",
      "about", "which", "when", "make", "like", "time", "just", "know", "take", "people", "year", "good",
      "some", "come", "could", "state", "over", "think", "also", "back", "after", "use", "two", "how",
      "work", "first", "well", "way", "even", "new", "want", "because", "any", "these", "give", "day",
      "most", "us", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
      "did", "done", "get", "got", "gotten", "go", "went", "gone", "see", "saw", "seen", "come", "came",
      "know", "knew", "known", "take", "took", "taken", "find", "found", "think", "thought", "tell", "told",
      "become", "became", "leave", "left", "feel", "felt", "put", "bring", "brought", "begin", "began",
      "keep", "kept", "hold", "held", "write", "wrote", "written", "stand", "stood", "hear", "heard",
      "let", "make", "made", "say", "said", "pay", "paid", "run", "ran", "move", "live", "believe",
      "bring", "happen", "stand", "open", "walk", "offer", "remember", "love", "consider", "appear",
      "buy", "wait", "serve", "die", "send", "expect", "build", "stay", "fall", "cut", "reach", "kill",
      "remain", "code", "function", "class", "const", "let", "var", "import", "export", "return",
      "async", "await", "if", "else", "for", "while", "switch", "case", "try", "catch", "throw",
    ]);
    return common.has(word.toLowerCase());
  }

  private extractFilePaths(grepOutput: string): string[] {
    const lines = grepOutput.split("\n");
    const paths = new Set<string>();
    for (const line of lines) {
      const match = line.match(/^([^:]+):\d+:/);
      if (match) paths.add(match[1]);
    }
    return Array.from(paths);
  }

  private extractGlobPattern(prompt: string): string | null {
    // 尝试从 prompt 中提取 glob 模式
    const globMatch = prompt.match(/\*\*?\/[^\s'"]+/);
    if (globMatch) return globMatch[0];

    const extMatch = prompt.match(/\*\.(ts|js|tsx|jsx|py|go|rs|json|md|yaml|yml)\b/);
    if (extMatch) return `*${extMatch[0]}`;

    // 如果提到文件类型
    if (/\btypescript\b|\b\.ts\b/.test(prompt)) return "*.ts";
    if (/\bjavascript\b|\b\.js\b/.test(prompt)) return "*.js";
    if (/\bjson\b/.test(prompt)) return "*.json";
    if (/\bmarkdown\b|\b\.md\b/.test(prompt)) return "*.md";

    return null;
  }

  private stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, "");
  }

  private estimateTokens(text: string): number {
    return Math.floor(text.length / 4);
  }

  private hashPrompt(prompt: string): string {
    // 简单 hash：取前 80 字符 + 长度
    const prefix = prompt.slice(0, 80).replace(/\s+/g, "_");
    return `${prefix}_${prompt.length}`;
  }

  private estimateTokenSaved(prompt: string, result: string): number {
    // 估算：如果走 OpenClaw 路由，需要支付 prompt + result 的 token
    // OpenCode 免费，只计算 result 的 token（但实际上免费模型不收费）
    // 保守估算节省量 = prompt token * 0.5（因为预处理已经做了一部分）
    const promptTokens = this.estimateTokens(prompt);
    return Math.floor(promptTokens * 0.5);
  }

  private trackExecution(result: OpenCodeToolResult, assessment: ComplexityAssessment): void {
    getTokenTracker().record({
      timestamp: Date.now(),
      model: result.model,
      provider: result.provider,
      role: assessment.taskType,
      taskType: assessment.taskType,
      promptTokens: 0,
      completionTokens: this.estimateTokens(result.content),
      totalTokens: this.estimateTokens(result.content),
      latencyMs: result.latencyMs,
      contentLength: result.content.length,
      success: !result.fallbackUsed && result.content.length > 0,
      fallbackUsed: result.fallbackUsed,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// 便捷函数
// ═══════════════════════════════════════════════════════════════

let globalAgent: OpenCodeToolAgent | null = null;

export function getOpenCodeToolAgent(cwd?: string): OpenCodeToolAgent {
  if (!globalAgent) {
    globalAgent = new OpenCodeToolAgent(cwd);
  }
  return globalAgent;
}

/** 检测 opencode CLI 是否可用 */
export async function checkOpenCodeCli(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ["opencode", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** 获取 OpenCode 可用免费模型列表 */
export async function getAvailableFreeModels(): Promise<string[]> {
  const available: string[] = [];
  for (const m of OPENCODE_FREE_MODELS) {
    available.push(m.id);
  }
  return available;
}

/** 快速执行（使用默认配置） */
export async function quickExecute(
  prompt: string,
  options?: {
    strategy?: ExecutionStrategy;
    injectContext?: boolean;
    cwd?: string;
  }
): Promise<OpenCodeToolResult> {
  const agent = getOpenCodeToolAgent(options?.cwd);
  return agent.execute(prompt, options);
}

// TaskType, ExecutionStrategy, ComplexityAssessment 已在上方导出
