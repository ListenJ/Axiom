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

  constructor(engine: DREngine) {
    this.engine = engine;
  }

  /**
   * 执行完整认知闭环
   */
  async run(input: string): Promise<CognitiveLoopResult> {
    const t0 = performance.now();
    const trace: CognitiveStep[] = [];

    const track = (stage: string, inp: string, out: unknown, start: number): CognitiveStep => {
      const s: CognitiveStep = { stage, input: inp, output: out, durationMs: Math.round(performance.now() - start) };
      trace.push(s);
      return s;
    };

    try {
      // ── Step 1: Observation → State (分类 & 加载状态) ──
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
      const knowledge = this.engine.searchKnowledge(
        `${classification.intent} ${classification.domain} ${classification.entities.join(" ")} ${input}`,
        { minConfidence: 0.2, limit: 8 }
      );
      track("knowledge", `${knowledge.length} nodes loaded`, {
        count: knowledge.length,
        domains: [...new Set(knowledge.map((n) => n.domain))],
        paradigms: [...new Set(knowledge.map((n) => n.paradigm))],
      }, t2);

      // ── Step 3: Knowledge → Reasoning (构建推理图) ──
      const t3 = performance.now();
      const { conclusionNode, gaps, premiseCount } = this.buildReasoning(knowledge, input);
      track("reasoning", `premises=${premiseCount}`, {
        nodes: this.engine.reasoning.getStats().totalNodes,
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
      return {
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
    // 每次调用创建独立推理图，避免并发竞态
    const graph = new ReasoningGraph();

    // 1. 添加知识节点作为前提
    const premiseIds: string[] = [];
    for (const node of knowledge) {
      const premise = graph.addPremise(node.content, node.confidence);
      premiseIds.push(premise.id);
    }

    // 2. 从前提推导推理步骤
    if (premiseIds.length >= 2) {
      graph.addInference(
        `从 ${premiseIds.length} 条知识中推导: ${input}`,
        premiseIds,
        Math.min(0.7, 0.3 + premiseIds.length * 0.05),
      );

      // 3. 从推理步骤得出初步结论
      // 取最新推理节点的 ID 作为结论的输入
      const stats = graph.getStats();
      const inferenceIds = premiseIds.slice(0, Math.min(premiseIds.length, 3)); // 直接从前提出发
      graph.addConclusion(
        `基于 ${knowledge.length} 条相关知识, 关于 "${input}" 的综合判断`,
        inferenceIds,
        0.5,
      );
    } else if (premiseIds.length === 1) {
      // 单一前提 → 直接做推理
      graph.addInference(
        `根据知识: ${knowledge[0].content.slice(0, 100)}`,
        premiseIds,
        knowledge[0].confidence,
      );
      graph.addConclusion(
        knowledge[0].content.slice(0, 120),
        premiseIds,
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
