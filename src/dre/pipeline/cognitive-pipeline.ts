/**
 * CognitivePipeline — 最小认知闭环 (Minimum Cognitive Loop)
 *
 * 将现有 DRE 模块串联为完整的认知流水线:
 *
 *   Observation → State → Knowledge → Reasoning → Constraint → Action → Reflection
 *
 * 核心原则:
 * - 不新增功能模块 — 仅编排现有模块
 * - 零 LLM 确定性分类和状态加载
 * - LLM 仅在 ReasoningGraph 检测到空洞时作为补全器调用
 * - 每步产生可追踪的类型化中间结果
 */

import type { DREngine } from "../engine.js";
import { ReasoningGraph, type ReasoningNode, type ReasoningGap } from "../reasoning/graph.js";
import type { ReflectionResult } from "../consciousness/stream.js";
import type { KnowledgeNode } from "../storage/knowledge-store.js";
import { TaskGraph } from "./task-graph.js";
import type { ToolExecutor } from "./task-graph.js";
import { eventBus } from "../runtime/event-bus.js";
import { worldState } from "../runtime/world-state.js";
import { readString } from "../../utils/env.js";
import { logger } from "../../utils/logger.js";

// ========== 流水线类型 ==========

/** 单步可追踪记录 */
export interface CognitiveStep {
  stage: string;
  input: string;
  output: unknown;
  durationMs: number;
}

/** 认知闭环完整结果 */
export interface CognitiveLoopResult {
  /** 原始输入 */
  input: string;
  /** 分步追踪 */
  trace: CognitiveStep[];
  /** 推理结论 */
  conclusion: string | null;
  /** 综合置信度 (0-1) */
  confidence: number;
  /** 是否有推理空洞 */
  hasGaps: boolean;
  /** 约束是否通过 */
  constraintPassed: boolean | null;
  /** 推荐动作 */
  recommendedAction: string | null;
  /** 是否触发反思 */
  reflectionTriggered: boolean;
  /** 反思所得教训 */
  lessons: string[];
  /** 总耗时 (ms) */
  totalDurationMs: number;
}

// ========== 认知管道 ==========

export class CognitivePipeline {
  private engine: DREngine;
  private toolExecutor: ToolExecutor | null = null;
  private stats = { gapsFilled: 0, gapFallbackCoarse: 0 };
  /**
   * Per-run reasoning graph — isolated to avoid cross-request pollution.
   * engine.reasoning is a shared singleton; using it directly caused
   * premises/conclusions to accumulate across concurrent CognitivePipeline runs.
   */
  private currentGraph: ReasoningGraph | null = null;

  constructor(engine: DREngine) {
    this.engine = engine;
  }

  /**
   * 注册工具执行器 — TaskGraph 节点可通过 graph.callTool() 调用 MCP 工具
   */
  setToolExecutor(executor: ToolExecutor): void {
    this.toolExecutor = executor;
  }

  /**
   * 暴露内部统计 (gap 填补次数 / 粗粒度回退次数) — 用于可观测性
   */
  getStats(): { gapsFilled: number; gapFallbackCoarse: number } {
    return { ...this.stats };
  }

  /**
   * 执行完整认知闭环
   */
  async run(input: string): Promise<CognitiveLoopResult> {
    const t0 = performance.now();
    const trace: CognitiveStep[] = [];
    let stepIndex = 0;

    const track = (stage: string, inp: string, out: unknown, start: number): CognitiveStep => {
      const s: CognitiveStep = { stage, input: inp, output: out, durationMs: Math.round(performance.now() - start) };
      trace.push(s);
      stepIndex++;
      eventBus.publish({
        type: `cognitive.step.${stage}`,
        source: "cognitive-pipeline",
        data: { step: stepIndex, stage, output: out, durationMs: s.durationMs },
        priority: "low",
      });
      worldState.set("cognitive.pipeline.lastStep", {
        stage, output: out, durationMs: s.durationMs, timestamp: Date.now(),
      });
      worldState.setGoal("current", input, "active");
      return s;
    };

    this.currentGraph = new ReasoningGraph();

    try {
      const t1 = performance.now();
      const classification = this.classify(input);
      const state = this.engine.consciousness.getState();
      track("classify", input, {
        intent: classification.intent,
        domain: classification.domain,
        action: classification.action ?? null,
        entities: classification.entities,
        workingMemorySize: state.workingMemorySize,
      }, t1);

      // ── Step 2: State → Knowledge (加载相关知识) ──
      const t2 = performance.now();
      const searchResult = this.engine.searchData(
        `${classification.intent} ${classification.domain} ${classification.entities.join(" ")} ${input}`,
        { minConfidence: 0.2, limit: 8 }
      );
      const knowledge = searchResult.knowledgeNodes;
      track("knowledge", `${knowledge.length} nodes loaded`, {
        count: knowledge.length,
        domains: [...new Set(knowledge.map((n) => n.domain))],
        paradigms: [...new Set(knowledge.map((n) => n.paradigm))],
      }, t2);

      // ── Step 3: Knowledge → Reasoning (构建推理图) ──
      const t3 = performance.now();
      const { conclusionNode, gaps, premiseCount } = this.buildReasoning(knowledge, input);
      track("reasoning", `premises=${premiseCount}`, {
        nodes: this.currentGraph?.getStats().totalNodes ?? 0,
        gaps: gaps.length,
        hasConclusion: conclusionNode !== null,
        confidence: conclusionNode?.confidence ?? 0,
      }, t3);

      // ── Step 4: Reasoning → Constraint (约束校验) ──
      const t4 = performance.now();
      let constraintPassed: boolean | null = null;
      let violations: string[] = [];
      if (conclusionNode) {
        const check = this.engine.constraints.check(
          conclusionNode.content,
          { intent: classification.intent, domain: classification.domain }
        );
        constraintPassed = check.satisfied;
        violations = check.violations.map((v) => v.reason);
      }
      track("constraint", conclusionNode ? "checking conclusion" : "no conclusion to check", {
        passed: constraintPassed,
        violations: violations.slice(0, 3),
      }, t4);

      // ── Step 5: Action (报告推荐动作, 不自动执行) ──
      const t5 = performance.now();
      let recommendedAction: string | null = null;
      if (constraintPassed && conclusionNode) {
        recommendedAction = classification.action ?? conclusionNode.content.slice(0, 80);
      }
      track("action", recommendedAction ?? "no action", { recommended: recommendedAction }, t5);

      // ── Step 6: Reflection (意识流反思) ──
      const t6 = performance.now();
      let reflectionTriggered = false;
      let lessons: string[] = [];
      let reflectResult: ReflectionResult | undefined;
      try {
        const cs = await this.engine.consciousnessStep({
          observation: `Loop completed: "${input}" → outcome: "${conclusionNode?.content.slice(0, 60) ?? "inconclusive"}"`,
          metadata: {
            traceCount: trace.length,
            gaps: gaps.length,
            confidence: conclusionNode?.confidence ?? 0,
            constraintPassed,
            steps: trace.map((s) => s.stage),
          },
        });
        reflectionTriggered = cs.shouldReflect;
        lessons = cs.reflection?.lessons ?? [];
        reflectResult = cs.reflection;
      } catch (err) {
        logger.debug("[CognitivePipeline] Reflection step skipped", { error: (err as Error).message });
      }
      track("reflection", `triggered=${reflectionTriggered}`, {
        triggered: reflectionTriggered,
        lessons: lessons.length,
        issues: reflectResult?.issues?.length ?? 0,
      }, t6);

      // ── 组装结果 ──
      const result: CognitiveLoopResult = {
        input,
        trace,
        conclusion: conclusionNode?.content ?? null,
        confidence: conclusionNode?.confidence ?? 0,
        hasGaps: gaps.length > 0,
        constraintPassed,
        recommendedAction,
        reflectionTriggered,
        lessons,
        totalDurationMs: Math.round(performance.now() - t0),
      };

      // 发布完成状态到 WorldState (用户可见的思考结果)
      eventBus.publish({
        type: "cognitive.pipeline.completed",
        source: "cognitive-pipeline",
        data: {
          conclusion: result.conclusion?.slice(0, 200),
          confidence: result.confidence,
          hasGaps: result.hasGaps,
          constraintPassed: result.constraintPassed,
          recommendedAction: result.recommendedAction,
          steps: result.trace.length,
          totalMs: result.totalDurationMs,
        },
        priority: "normal",
      });

      worldState.set("cognitive.pipeline.result", {
        conclusion: result.conclusion?.slice(0, 200),
        confidence: result.confidence,
        action: result.recommendedAction,
        completedAt: Date.now(),
      });

      // 更新 Goal 状态 (固定 key 避免无限增长)
      worldState.setGoal(
        "current",
        input,
        result.confidence > 0.5 ? "completed" : "abandoned"
      );

      return result;

    } catch (err) {
      logger.warn("[CognitivePipeline] Pipeline error", { input, error: (err as Error).message });
      const totalMs = Math.round(performance.now() - t0);
      return {
        input,
        trace,
        conclusion: null,
        confidence: 0,
        hasGaps: false,
        constraintPassed: null,
        recommendedAction: null,
        reflectionTriggered: false,
        lessons: [String((err as Error).message)],
        totalDurationMs: totalMs,
      };
    }
  }

  /**
   * 执行完整认知闭环 + TaskGraph 执行
   */
  async runFull(input: string): Promise<CognitiveLoopResult & {
    executionGraph?: { tasks: number; completed: number; failed: number; status: string };
  }> {
    const base = await this.run(input);
    if (!base.recommendedAction || !base.constraintPassed) return base;
    const executionGraph = await this.executeTaskGraph(base.recommendedAction, base.conclusion);
    return { ...base, executionGraph };
  }

  /**
   * 带 LLM 降级的完整认知闭环 + TaskGraph 执行
   */
  async runFullWithLLM(input: string): Promise<CognitiveLoopResult & {
    fallbackLevel?: "deterministic" | "local" | "cloud" | "rule";
    executionGraph?: { tasks: number; completed: number; failed: number; status: string };
  }> {
    const base = await this.runWithLLM(input);
    if (!base.recommendedAction || !base.constraintPassed) return base;
    const executionGraph = await this.executeTaskGraph(base.recommendedAction, base.conclusion, {
      llmAssisted: base.fallbackLevel !== "deterministic",
    });
    return { ...base, executionGraph };
  }

  /**
   * 共享 TaskGraph 执行工厂 (替换 runFull/runFullWithLLM 的重复代码)
   */
  private async executeTaskGraph(
    action: string,
    conclusion: string | null,
    opts?: { llmAssisted?: boolean },
  ): Promise<{ tasks: number; completed: number; failed: number; status: string } | undefined> {
    try {
      const graph = new TaskGraph();
      if (this.toolExecutor) graph.setToolExecutor(this.toolExecutor);
      graph.addTask("exec-action", action, async () => {
        await this.engine.actors.send("pipeline", "knowledge", "request", "execute", {
          action,
          conclusion,
          ...(opts?.llmAssisted ? { llmAssisted: true } : {}),
        });
        return { dispatched: true, action };
      }, {
        rollback: async () => {
          await this.engine.actors.send("pipeline", "knowledge", "notify", "rollback", { action });
        },
      });

      await graph.executeAll();

      return {
        tasks: graph.getAllTasks().length,
        completed: graph.getStatus() === "completed" ? 1 : 0,
        failed: graph.getStatus() === "failed" ? 1 : 0,
        status: graph.getStatus(),
      };
    } catch (err) {
      logger.warn("[CognitivePipeline] TaskGraph execution failed", { action, error: (err as Error).message });
      return undefined;
    }
  }

  /**
   * 带 LLM 降级的完整认知闭环
   *
   * 三级降级:
   * L1: 确定性推理 (run) → 如果无 Gap 则直接返回
   * L2: 本地 LLM → 通过 consciousnessStep 调用
   * L3: 云 API → 通过 DREngine cloudFallback
   * L4: 规则推理 → 纯关键词
   *
   * 原先仅 DREngine.consciousnessStep() 有降级链，
   * 现在 CognitivePipeline 也具备完整的 LLM 回退能力。
   */
  async runWithLLM(input: string): Promise<CognitiveLoopResult & {
    fallbackLevel?: "deterministic" | "local" | "cloud" | "rule";
  }> {
    // L1: 纯确定性推理
    const deterministic = await this.run(input);

    // 如果确定性推理已经成功 (有结论且无 Gap)，直接返回
    if (deterministic.conclusion && !deterministic.hasGaps && deterministic.confidence > 0.5) {
      return { ...deterministic, fallbackLevel: "deterministic" };
    }

    // L1.5: 精细 Gap 填补 (per-gap LLM call)
    // 仅在 DRE_GAP_FILL_FINE !== "0" (默认开启) 且确定性推理检测到空洞时触发
    // 对每个 gap 单独生成 prompt 调用 LLM，避免粗粒度地把整个上下文丢给 LLM
    const fineGapFillEnabled = readString("DRE_GAP_FILL_FINE") !== "0";
    if (fineGapFillEnabled && deterministic.hasGaps) {
      const graph = this.currentGraph;
      if (!graph) {
        return { ...deterministic, fallbackLevel: "rule", lessons: [...deterministic.lessons, "No reasoning graph available"] };
      }
      const gaps = graph.detectGaps();
      if (gaps.length > 0 && gaps.length <= 5) {
        try {
          const fillers: Array<{ gapId: string; response: string; confidence: number }> = [];
          for (const gap of gaps) {
            const prompt = graph.generateGapFillingPrompt(gap);
            const gapResult = await this.engine.consciousnessStep({ observation: prompt });
            const response = typeof gapResult.decision === "string"
              ? gapResult.decision
              : JSON.stringify(gapResult.decision).slice(0, 500);
            const confidence = typeof gapResult.decision === "object" && gapResult.decision !== null
              && "confidence" in gapResult.decision
              && typeof (gapResult.decision as Record<string, unknown>).confidence === "number"
                ? (gapResult.decision as Record<string, unknown>).confidence as number
                : 0.6;
            fillers.push({ gapId: gap.id, response, confidence });
          }
          graph.fillGapsBatch(gaps, fillers);
          this.stats.gapsFilled += fillers.length;

          // 重新检测 gaps，若全部填补或整体置信度达标则提前返回
          const remainingGaps = graph.detectGaps();
          const result = graph.getResult();
          if (remainingGaps.length === 0 || result.confidence > 0.5) {
            return {
              ...deterministic,
              conclusion: result.conclusion?.content ?? deterministic.conclusion,
              confidence: Math.max(deterministic.confidence, result.confidence),
              hasGaps: remainingGaps.length > 0,
              lessons: [...deterministic.lessons, `Fine-grained gap fill: ${fillers.length} gaps filled`],
              fallbackLevel: "local",
            };
          }
          // 精细填补后仍有 gaps，继续走粗粒度路径
          logger.info("[CognitivePipeline] Fine gap fill insufficient, falling back to coarse", {
            filled: fillers.length,
            remaining: remainingGaps.length,
            newConfidence: result.confidence.toFixed(2),
          });
        } catch (err) {
          logger.warn("[CognitivePipeline] Fine gap fill failed, falling back to coarse", {
            error: (err as Error).message,
          });
        }
      } else if (gaps.length > 5) {
        // 硬上限：gap 数量过多时直接走粗粒度路径，避免 token 成本失控
        this.stats.gapFallbackCoarse++;
        logger.info("[CognitivePipeline] Gap count exceeds threshold, using coarse fallback", {
          gaps: gaps.length,
        });
      }
    }

    logger.info("[CognitivePipeline] Deterministic insufficient, falling back to LLM", {
      hasGaps: deterministic.hasGaps,
      confidence: deterministic.confidence,
      hasConclusion: deterministic.conclusion !== null,
    });

    // L2: 本地 LLM
    try {
      worldState.set("cognitive.pipeline.fallback", {
        level: "local",
        reason: deterministic.hasGaps ? "reasoning gaps" : "low confidence",
        timestamp: Date.now(),
      });

      eventBus.publish({
        type: "cognitive.pipeline.fallback",
        source: "cognitive-pipeline",
        data: { level: "local", reason: deterministic.hasGaps ? "gaps" : "confidence" },
        priority: "high",
      });

      const llmResult = await this.engine.consciousnessStep({
        observation: `Context: ${input}\n\nDeterministic result: ${deterministic.conclusion ?? "inconclusive"}\nGaps: ${deterministic.hasGaps ? "YES" : "none"}\n\nPlease complete the reasoning:`,
      });

      if (llmResult.fallbackLevel === "local") {
        // 本地 LLM 成功
        return {
          ...deterministic,
          conclusion: typeof llmResult.decision === "string"
            ? llmResult.decision
            : JSON.stringify(llmResult.decision).slice(0, 500),
          confidence: Math.max(deterministic.confidence, 0.6),
          lessons: [...deterministic.lessons, "Local LLM assisted"],
          fallbackLevel: "local",
        };
      }

      // L3: 云 API (已由 consciousnessStep 内部处理)
      if (llmResult.fallbackLevel === "cloud") {
        return {
          ...deterministic,
          conclusion: typeof llmResult.decision === "string"
            ? llmResult.decision
            : JSON.stringify(llmResult.decision).slice(0, 500),
          confidence: Math.max(deterministic.confidence, 0.7),
          lessons: [...deterministic.lessons, "Cloud API assisted"],
          fallbackLevel: "cloud",
        };
      }

      // L4: 规则推理 — consciousnessStep 返回的 decision 是规则推理结果, 应当使用 (与 L2/L3 一致)
      return {
        ...deterministic,
        conclusion: typeof llmResult.decision === "string"
          ? llmResult.decision
          : JSON.stringify(llmResult.decision).slice(0, 500),
        confidence: Math.max(deterministic.confidence, 0.4),
        lessons: [...deterministic.lessons, "Rule-based fallback — result may be incomplete"],
        fallbackLevel: "rule",
      };

    } catch (err) {
      logger.warn("[CognitivePipeline] LLM fallback failed", { error: (err as Error).message });

      // 最终退回到规则推理
      return {
        ...deterministic,
        lessons: [...deterministic.lessons, `Fallback error: ${(err as Error).message}`],
        fallbackLevel: "rule",
      };
    }
  }

  // ========== 私有方法 ==========

  /**
   * Step 1 内部: 零 LLM 关键词分类
   */
  private classify(input: string): {
    intent: string;
    domain: string;
    entities: string[];
    action?: string;
  } {
    const lower = input.toLowerCase();

    // 意图分类 (规则引擎, 非 LLM)
    let intent = "query";
    let domain = "general";
    let action: string | undefined;

    if (lower.includes("error") || lower.includes("错误") || lower.includes("bug")) {
      intent = "troubleshoot";
      domain = "debug";
    } else if (lower.includes("refactor") || lower.includes("重构") || lower.includes("优化")) {
      intent = "refactor";
      domain = "development";
      action = "refactor";
    } else if (lower.includes("create") || lower.includes("创建") || lower.includes("新建")) {
      intent = "create";
      domain = "development";
      action = "create";
    } else if (lower.includes("delete") || lower.includes("删除") || lower.includes("移除")) {
      intent = "delete";
      domain = "maintenance";
      action = "delete";
    } else if (lower.includes("test") || lower.includes("测试") || lower.includes("spec")) {
      intent = "test";
      domain = "quality";
      action = "test";
    } else if (lower.includes("search") || lower.includes("搜索") || lower.includes("查找")) {
      intent = "search";
      domain = "discovery";
    } else if (lower.includes("analyze") || lower.includes("分析") || lower.includes("review")) {
      intent = "analyze";
      domain = "research";
    } else if (lower.includes("deploy") || lower.includes("部署") || lower.includes("发布")) {
      intent = "deploy";
      domain = "operations";
      action = "deploy";
    } else if (lower.includes("merge") || lower.includes("git") || lower.includes("合并")) {
      intent = "merge";
      domain = "version-control";
      action = "merge";
    }

    // 实体提取 (简单正则)
    const entities: string[] = [];
    const codeMatch = input.match(/[\w\-\/]+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|json|yaml|yml|md)/g);
    if (codeMatch) entities.push(...codeMatch);

    const importMatch = input.match(/import\s+.+?from\s+["'](.+?)["']/g);
    if (importMatch) {
      for (const m of importMatch) {
        const path = m.match(/["'](.+?)["']/)?.[1];
        if (path) entities.push(path);
      }
    }

    return { intent, domain, entities, action };
  }

  /**
   * Step 3 内部: 从知识节点构建推理图
   * 返回: 结论节点, 空洞列表, 前提数量
   */
  private buildReasoning(
    knowledge: KnowledgeNode[],
    input: string,
  ): { conclusionNode: ReasoningNode | null; gaps: ReasoningGap[]; premiseCount: number } {
    const graph = this.currentGraph ?? this.engine.reasoning;

    const premiseIds: string[] = [];
    for (const node of knowledge) {
      const premise = graph.addPremise(node.content, node.confidence);
      premiseIds.push(premise.id);
    }

    if (premiseIds.length >= 2) {
      const inferenceId = graph.addInference(
        `从 ${premiseIds.length} 条知识中推导: ${input}`,
        premiseIds,
        Math.min(0.7, 0.3 + premiseIds.length * 0.05),
      );
      graph.addConclusion(
        `基于 ${knowledge.length} 条相关知识, 关于 "${input}" 的综合判断`,
        [inferenceId.id],
        0.5,
      );
    } else if (premiseIds.length === 1) {
      const inferenceId = graph.addInference(
        `根据知识: ${knowledge[0].content.slice(0, 100)}`,
        premiseIds,
        knowledge[0].confidence,
      );
      graph.addConclusion(
        knowledge[0].content.slice(0, 120),
        [inferenceId.id],
        knowledge[0].confidence * 0.8,
      );
    }

    // 4. 空洞检测
    const gaps = graph.detectGaps();

    // 5. 获取结论
    const result = graph.getResult();
    const conclusionNode = result.conclusion;

    return {
      conclusionNode,
      gaps,
      premiseCount: premiseIds.length,
    };
  }
}
