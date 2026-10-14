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
import { readString, readInt, readBool } from "../../utils/env.js";
import { logger } from "../../utils/logger.js";

// ========== 传动轴 Bridge C：domain → MentalModel id 映射 ==========

/**
 * 分类 domain → 已注册 MentalModel 的 id。
 *
 * predict() 的入参是 model id 而非 domain；没有这张表，MentalModelPool.get()
 * 恒 miss → 预测恒 null → Bridge C 静默失效（联动审查 2026-10-14 实证）。
 *
 * key 必须与 classify() 实际产出的 domain 字面量一致（general / debug /
 * development / maintenance / quality / discovery / research / operations /
 * version-control），否则仍是死映射。MentalModelPool 只注册了 4 个模型
 * （git-conflict / code-refactor / auth-flow / database-tx），故多数 domain
 * 无对应模型 → 返回 undefined → 跳过预测，不产生噪声事件。
 */
const DOMAIN_TO_MODEL: Record<string, string> = {
  "version-control": "git-conflict", // merge/git 意图 → git-conflict 模型
  development: "code-refactor",      // 重构/创建意图 → code-refactor 模型
};

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

// ========== 并发闸门参数 ==========

/**
 * 并发闸门默认等待上限（毫秒）。
 * 超时后 **不阻塞、不抛穿**，而是 fail-closed 降级返回一个显式的"未执行"结果。
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** CognitivePipeline 构造选项 */
export interface CognitivePipelineOptions {
  /**
   * 等待并发闸门的最长时间（毫秒）。
   * 缺省读 `AXIOM_COGNITIVE_LOCK_TIMEOUT_MS`，再缺省 `DEFAULT_LOCK_TIMEOUT_MS`。
   * `<= 0` 表示**不等待**：闸门被占用时立刻降级。
   */
  lockTimeoutMs?: number;
}

// ========== 认知管道 ==========

export class CognitivePipeline {
  private engine: DREngine;
  private toolExecutor: ToolExecutor | null = null;
  private stats = { gapsFilled: 0, gapFallbackCoarse: 0 };
  /**
   * Per-run reasoning graphs keyed by loop ID — isolated to avoid cross-request pollution.
   * engine.reasoning is a shared singleton; using it directly caused
   * premises/conclusions to accumulate across concurrent CognitivePipeline runs.
   */
  private currentGraph: ReasoningGraph | undefined

  /**
   * 并发闸门 —— 原子式 FIFO 票据链（算法式：无轮询、无 check-then-act 窗口）。
   *
   * 为什么不用布尔标记（旧实现）：`if (locked) { 每 100ms 轮询 } locked = true`
   * 有两个独立缺陷 ——
   *   ① **互斥不成立**：锁释放瞬间多个等待者可同时观察到 `false`，各自再置 `true` 后**并发执行**；
   *   ② **无限等待**：轮询没有 deadline，持锁者内部 `await` 一旦永不 settle，
   *      后续 `run()` 永久阻塞且**不可取消**。
   *
   * 现策略：每次调用**同步**地把一张"释放票据"接到链尾
   * （`const prev = this.lockChain; this.lockChain = prev.then(() => ticket)` 之间无 `await`，
   * 在 JS 事件循环里即为原子操作），然后 `await prev` —— 天然 FIFO、零轮询。
   * 等待超过 `lockTimeoutMs` 则 fail-closed 降级；**但仍在自己轮到时立刻归还票据**，
   * 否则超时者会永久堵死链尾（本算法最易漏的一步，见 acquireGate）。
   */
  private lockChain: Promise<void> = Promise.resolve()
  /** 当前处于闸门区（正持锁 + 正排队）的调用数（可观测，非控制用） */
  private lockWaiters = 0
  /** 累计等待超时次数（可观测） */
  private gateTimeouts = 0
  private readonly lockTimeoutMs: number

  constructor(engine: DREngine, opts: CognitivePipelineOptions = {}) {
    this.engine = engine;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? readInt(
      "AXIOM_COGNITIVE_LOCK_TIMEOUT_MS",
      DEFAULT_LOCK_TIMEOUT_MS,
      { min: 0, max: 600_000 },
    );
  }

  /**
   * 取得并发闸门。成功返回**释放函数**；等待超时返回 `null`（调用方负责 fail-closed 降级）。
   *
   * 关键算法点：入队是**同步原子**的（读 `lockChain` 与写回之间没有 `await`），
   * 因此不存在"两个调用者都以为自己排在第一位"的窗口；顺序即为调用到达顺序（FIFO）。
   * 超时放弃时**仍会在轮到自己时立刻归还票据** —— 否则链尾永久堵塞，超时者会把
   * 后面所有等待者一起拖死（这正是"有超时"与"有超时且不泄漏队列"的区别）。
   */
  private async acquireGate(): Promise<(() => void) | null> {
    let release!: () => void
    const ticket = new Promise<void>((res) => { release = res })
    const prev = this.lockChain
    // ↓ 以下两条语句之间无 await：在事件循环内不可被打断 ⇒ 原子入队
    this.lockChain = prev.then(() => ticket)

    if (this.lockTimeoutMs <= 0) {
      // 不等待模式：仍有拿到闸门的机会（前一位已释放时 prev 已 resolve）
      const acquired = await Promise.race([
        prev.then(() => true as const),
        new Promise<false>((res) => { setTimeout(() => res(false), 0) }),
      ])
      if (!acquired) { void prev.then(() => release()); return null }
      return release
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((res) => {
      timer = setTimeout(() => res(false), this.lockTimeoutMs)
    })
    const acquired = await Promise.race([prev.then(() => true as const), timedOut])
    if (timer !== undefined) clearTimeout(timer)

    if (!acquired) {
      // 归还排队位置（自己轮到时立即释放），保证超时不影响后来者
      void prev.then(() => release())
      return null
    }
    return release
  }

  /** 并发闸门可观测性：在闸门区的调用数（含持锁者）/ 累计超时次数 / 当前等待上限 */
  getGateStats(): { waiting: number; timeouts: number; lockTimeoutMs: number } {
    return { waiting: this.lockWaiters, timeouts: this.gateTimeouts, lockTimeoutMs: this.lockTimeoutMs }
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
    const waitStart = performance.now();
    this.lockWaiters++;
    const release = await this.acquireGate();

    if (!release) {
      // 有界等待：闸门被长任务占用 ⇒ 显式 fail-closed 降级，绝不无限阻塞
      this.lockWaiters--;
      this.gateTimeouts++;
      const waitedMs = Math.round(performance.now() - waitStart);
      logger.warn("[CognitivePipeline] 并发闸门等待超时，fail-closed 降级", {
        input: input.slice(0, 80),
        lockTimeoutMs: this.lockTimeoutMs,
        waitedMs,
        waiting: this.lockWaiters,
      });
      return {
        input,
        trace: [],
        conclusion: null,
        confidence: 0,
        hasGaps: false,
        constraintPassed: null,
        recommendedAction: null,
        reflectionTriggered: false,
        lessons: [`并发等待超时（>${this.lockTimeoutMs}ms，实际等待 ${waitedMs}ms）：闸门被占用，已 fail-closed 降级，未执行本轮回环`],
        totalDurationMs: waitedMs,
      };
    }

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
      // 审计修复（WorldState 一致性）：setGoal 现在校验 description 非空，
      // 而这里此前直接把**原始输入**当目标描述写入，空输入会抛错并让整条流水线提前退出
      // （实测：trace 长度从 6 掉到 1）。
      // 语义上：空输入**没有可表述的目标** —— 跳过写入，而不是把一个空字符串塞进状态树。
      // 「空状态的确定性」比没有状态更危险：下游会把空目标当成有效目标。
      const goalText = input.trim();
      if (goalText) worldState.setGoal("current", goalText, "active");
      return s;
    };

    try {
      this.currentGraph = new ReasoningGraph();

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
      let knowledge = searchResult.knowledgeNodes;

      // 传动轴 Bridge B：突触建议 → 知识注入
      // 确定性搜索结果为主，突触建议为辅（加法合并，非替换）
      // 突触 score 权重 ≤0.3——永不喧宾夺主
      let synapseHints = 0;
      if (this.engine.synapse && readBool("AXIOM_META_LOOP_B", true)) {
        try {
          const suggestions = await this.engine.synapse.suggestNextSteps(
            classification.domain || "general",
            classification.intent || input.slice(0, 100),
            { limit: 3 },
          );
          for (const suggestion of suggestions) {
            if (suggestion.score < 0.3) continue; // 低分跳过
            // 尝试按 targetId 加载知识节点
            const synapseResult = this.engine.searchData(suggestion.targetId, {
              minConfidence: 0.1,
              limit: 2,
            });
            if (synapseResult.knowledgeNodes.length > 0) {
              // 去重：避免与确定性结果重复
              const existingIds = new Set(knowledge.map((n) => n.nodeId));
              for (const node of synapseResult.knowledgeNodes) {
                if (!existingIds.has(node.nodeId)) {
                  knowledge.push(node);
                  synapseHints++;
                  existingIds.add(node.nodeId);
                }
              }
            }
          }
          if (synapseHints > 0) {
            eventBus.publish({
              type: "meta.loop.b.hint",
              source: "cognitive-pipeline",
              data: { hints: synapseHints, fromSuggestions: suggestions.length },
              priority: "low",
            });
          }
        } catch {
          // 突触失败不影响主管道——fail-safe 降级
        }
      }

      track("knowledge", `${knowledge.length} nodes loaded`, {
        count: knowledge.length,
        synapseHints,
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

      // 传动轴 Bridge C：心智模型预测 → 行动咨询
      // 咨询而非覆盖——预测与推荐行动一致则提升置信度，不一致则标记差异供审计
      // 注：predict() 的第一个参数是 MentalModel 的 id（如 "git-conflict"），
      // 不是分类 domain（如 "general"）。未做映射时 models.get() 恒 miss → 预测
      // 永远返回 null，本桥静默失效（联动审查实证）。故此处显式映射，无匹配则跳过。
      let predictionConsulted = false;
      let predictionAligned = false;
      if (recommendedAction && readBool("AXIOM_META_LOOP_C", true)) {
        const modelId = DOMAIN_TO_MODEL[classification.domain ?? ""];
        try {
          const prediction = modelId
            ? this.engine.mentalModels.predict(modelId, input.slice(0, 200))
            : null;
          if (prediction && prediction.probability >= 0.7) {
            predictionConsulted = true;
            predictionAligned = prediction.predictedState.toLowerCase().includes(
              recommendedAction.slice(0, 30).toLowerCase(),
            );
            eventBus.publish({
              type: "meta.loop.c.consult",
              source: "cognitive-pipeline",
              data: {
                modelId,
                predictedState: prediction.predictedState,
                recommendedAction: recommendedAction.slice(0, 80),
                probability: prediction.probability,
                aligned: predictionAligned,
              },
              priority: "low",
            });
          }
        } catch {
          // 预测失败不影响主管道——fail-safe 降级
        }
      }

      track("action", recommendedAction ?? "no action", {
        recommended: recommendedAction,
        predictionConsulted,
        predictionAligned,
      }, t5);

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
      // 传动轴数据源：lessons + issues 供 MetaCognitiveLoop 消费（闭合反馈环 A/D）
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
          // 传动轴：反馈环数据
          input: input.slice(0, 200),
          lessons: lessons.length > 0 ? lessons.slice(0, 10) : undefined,
          issues: reflectResult?.issues?.slice(0, 10) ?? undefined,
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
    } finally {
      // 单点释放（原子归位）：覆盖正常返回 / 异常 / 未来新增的提前 return。
      // 旧实现把解锁散落在成功与 catch 两处，任何新增的提前 return 都会漏放锁。
      this.lockWaiters--;
      release();
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
