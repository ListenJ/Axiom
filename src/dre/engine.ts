/**
 * DRE — 确定性推理引擎 主入口
 *
 * 整合所有模块:
 * - VFS: 虚拟文件系统
 * - Storage: 知识库存储
 * - Pipeline: 三段甄别
 * - Consciousness: 意识流
 * - KG: 知识图谱
 * - Persona: 动态角色加载 (替代 AgentHarness)
 * - LLM: 本地推理
 */

import { Database } from "bun:sqlite";
import { VFS } from "./vfs.js";
import { SqliteBackend } from "./storage/sqlite-backend.js";
import { KnowledgeStore, type KnowledgeNode, type KGEdge } from "./storage/knowledge-store.js";
import { ConsciousnessStream, type ReflectionResult } from "./consciousness/stream.js";
import { Pipeline, type KnowledgeItem, type VerificationResult } from "./pipeline/pipeline.js";
import { KnowledgeGraph, type KGNode } from "./kg/graph.js";
import { LLMClient, type LLMConfig } from "./llm/client.js";

import { getResourceBudgetManager } from "./system-resource.js";
import { MentalModelPool, GIT_CONFLICT_MODEL, CODE_REFACTOR_MODEL, AUTH_MODEL, DATABASE_MODEL } from "./mental-model/pool.js";
import { ReasoningGraph } from "./reasoning/graph.js";
import { ConstraintSolver, RESOURCE_CONSTRAINTS, POLICY_CONSTRAINTS, TEMPORAL_CONSTRAINTS } from "./constraint/solver.js";
import { ActorSystem } from "./actor/system.js";
import { PersonaLoader } from "./persona/loader.js";
import type { PersonaMode, LoadedPersona } from "./persona/types.js";
import { worldState } from "./runtime/world-state.js";
import { DRE_DECISION_SYSTEM, isDreDecision, parseCloudDecisionOrThrow } from "./constraints.js";
import { dataUnifier, type DataUnifier } from "./runtime/data-unifier.js";
import { logger } from "../utils/logger.js";

/** DRE 配置 */
export interface DREConfig {
  /** 数据库路径 */
  dbPath: string;
  /** 主推理模型配置 */
  mainLLM: LLMConfig;
  /** 甄别小模型配置 (可选) */
  discriminLLM?: LLMConfig;
  /** VFS 挂载点 */
  mounts?: {
    kb?: string;
    proj?: string;
    cache?: string;
    log?: string;
  };
  /** 工作记忆容量 */
  workingMemoryCapacity?: number;
  /** 短期记忆 TTL (ms) */
  episodicTTL?: number;
  /** 云 API 降级配置 (可选) */
  cloudFallback?: {
    baseUrl: string;
    apiKey?: string;
    model: string;
  };
}

/**
 * 确定性推理引擎
 */
export class DREngine {
  readonly vfs: VFS;
  readonly knowledgeStore: KnowledgeStore;
  readonly consciousness: ConsciousnessStream;
  readonly pipeline: Pipeline;
  readonly kg: KnowledgeGraph;
  readonly mainLLM: LLMClient;
  readonly discriminLLM: LLMClient | null;
  readonly mentalModels: MentalModelPool;
  readonly reasoning: ReasoningGraph;
  readonly constraints: ConstraintSolver;
  readonly actors: ActorSystem;
  readonly persona: PersonaLoader;
  readonly data: DataUnifier;

  private db: Database;
  private sqliteBackend: SqliteBackend;
  private config: DREConfig;
  private _ready: Promise<void>;
  private _readyResolve!: () => void;

  constructor(config: DREConfig) {
    // 保存配置
    this.config = config;

    // 就绪门控
    this._ready = new Promise<void>((resolve) => { this._readyResolve = resolve; });

    // 初始化数据库
    this.db = new Database(config.dbPath);
    this.sqliteBackend = new SqliteBackend(config.dbPath);

    // 初始化 VFS
    this.vfs = VFS.instance();
    const mounts = config.mounts || {};
    this.vfs.mount(mounts.kb || "/kb", this.sqliteBackend);
    this.vfs.mount(mounts.proj || "/proj", this.sqliteBackend);
    this.vfs.mount(mounts.cache || "/cache", this.sqliteBackend);
    this.vfs.mount(mounts.log || "/log", this.sqliteBackend);

    // 初始化知识库存储
    this.knowledgeStore = new KnowledgeStore(this.db);

    // 初始化统一数据入口 (AtomEngine + KnowledgeStore)
    this.data = dataUnifier;
    this.data.init(this.db, this.knowledgeStore);
    this.data.setAutoPersist(true);  // 写入时自动持久化 Atom 到 SQLite

    // 初始化 LLM 客户端
    this.mainLLM = new LLMClient(config.mainLLM);
    this.discriminLLM = config.discriminLLM ? new LLMClient(config.discriminLLM) : null;

    // 初始化三段甄别流水线
    this.pipeline = new Pipeline(this.knowledgeStore, this.mainLLM);

    // 初始化知识图谱
    this.kg = new KnowledgeGraph();

    // 初始化心智模型池 (预注册 Git/Code 等领域模型)
    this.mentalModels = new MentalModelPool();
    this.mentalModels.register(GIT_CONFLICT_MODEL);
    this.mentalModels.register(CODE_REFACTOR_MODEL);
    this.mentalModels.register(AUTH_MODEL);
    this.mentalModels.register(DATABASE_MODEL);
    this.mentalModels.addRule("git-conflict", "same-file-change exists", "resolve_conflict");
    this.mentalModels.addRule("git-conflict", "stagedFiles > 0 && readyToCommit exists", "commit_changes", 0.9);
    this.mentalModels.addRule("auth-flow", "tokenExpired exists", "refresh_token", 0.95);
    this.mentalModels.addRule("database-tx", "deadlockDetected exists", "abort_and_retry", 0.95);

    // 初始化推理图
    this.reasoning = new ReasoningGraph();

    // 初始化约束求解器 (预注册 GPU/策略/时间约束)
    this.constraints = new ConstraintSolver();
    this.constraints.registerAll([...RESOURCE_CONSTRAINTS, ...POLICY_CONSTRAINTS, ...TEMPORAL_CONSTRAINTS]);

    // 初始化 Persona 加载器 (替换 AgentHarness)
    this.persona = new PersonaLoader({
      constraintSolver: this.constraints,
      mentalModelPool: this.mentalModels,
      defaultPersona: "general",
    });

    // 初始化 Actor 系统 (异步，不阻塞构造)
    this.actors = new ActorSystem();
    this.initActors();

    // 初始化意识流
    this.consciousness = new ConsciousnessStream({
      workingMemoryCapacity: config.workingMemoryCapacity ?? 16,
      episodicTTL: config.episodicTTL ?? 3600000,
      // 决策钩子：向 mainLLM 发出精确约束（JSON schema + 枚举 + 数值边界）
      // 网络失败/输出不合 schema → 抛出 → consciousnessStep 降级链真正生效
      decide: async (observation: string) => {
        const resp = await this.mainLLM.generate(observation, {
          system: DRE_DECISION_SYSTEM,
          maxTokens: 256,
        });
        let parsed: unknown; try { parsed = JSON.parse(resp.content); } catch (e) { throw new Error(`[DRE] LLM decision JSON 解析失败: ${(e as Error).message}`); }
        if (!isDreDecision(parsed)) {
          throw new Error("[DRE] LLM decision 不符合约束 schema");
        }
        return parsed;
      },
    });

    // 注册反思事件
    this.consciousness.on("reflection", (result: ReflectionResult) => {
      this.handleReflection(result);
    });

    logger.info("[DRE] Engine initialized", {
      dbPath: config.dbPath,
      mainModel: config.mainLLM.model,
      discriminModel: config.discriminLLM?.model,
    });

    // 检查资源预算 (不阻塞构造)
    this.checkResourceBudget();
  }

  /**
   * 初始化 Actor 系统 (异步)
   */
  private async initActors(): Promise<void> {
    try {
      const { KnowledgeActorBehavior, ConstraintActorBehavior, MentalModelActorBehavior, ReasoningActorBehavior } = await import("./actor/system.js");
      await this.actors.register(new KnowledgeActorBehavior());
      await this.actors.register(new ConstraintActorBehavior());
      await this.actors.register(new MentalModelActorBehavior());
      await this.actors.register(new ReasoningActorBehavior());
      logger.info("[DRE] Actor system initialized", { actors: this.actors.size });
    } catch (err) {
      logger.warn("[DRE] Actor system init failed", { error: (err as Error).message });
    } finally {
      this._readyResolve();
    }
  }

  /**
   * 等待引擎就绪 (Actor 初始化完成)
   */
  async waitForReady(): Promise<void> {
    return this._ready;
  }

  /**
   * Health check — verify all subsystems are operational.
   * Returns a structured report; does not throw.
   *
   * Inspired by LangGraph's health check and Kubernetes readiness probes.
   * Use this for:
   * - Startup readiness gates
   * - Periodic monitoring
   * - Debugging "why is nothing working?"
   */
  async healthCheck(): Promise<{
    healthy: boolean
    version: string
    uptime: number
    checks: Array<{ name: string; ok: boolean; detail?: string }>
  }> {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

    // DB connectivity
    try {
      this.db.query("SELECT 1").get();
      checks.push({ name: "database", ok: true });
    } catch (err) {
      checks.push({ name: "database", ok: false, detail: (err as Error).message });
    }

    // Knowledge store
    try {
      this.knowledgeStore.search("");
      checks.push({ name: "knowledgeStore", ok: true });
    } catch (err) {
      checks.push({ name: "knowledgeStore", ok: false, detail: (err as Error).message });
    }

    // LLM client (circuit state, not a real call)
    try {
      const state = this.mainLLM.getCircuitState?.();
      checks.push({
        name: "mainLLM",
        ok: state !== "open",
        detail: state ? `circuit=${state}` : undefined,
      });
    } catch {
      checks.push({ name: "mainLLM", ok: true, detail: "circuit check unavailable" });
    }

    // Consciousness stream
    try {
      const state = this.consciousness.getState();
      checks.push({
        name: "consciousness",
        ok: typeof state.workingMemorySize === "number",
      });
    } catch (err) {
      checks.push({ name: "consciousness", ok: false, detail: (err as Error).message });
    }

    // Actor system
    try {
      checks.push({
        name: "actors",
        ok: this.actors.size > 0,
        detail: `${this.actors.size} actors`,
      });
    } catch (err) {
      checks.push({ name: "actors", ok: false, detail: (err as Error).message });
    }

    // Scheduler
    try {
      const { scheduler } = await import("./runtime/scheduler.js");
      const status = scheduler.getStatus();
      checks.push({
        name: "scheduler",
        ok: status.budget.currentTasks >= 0,
      });
    } catch (err) {
      checks.push({ name: "scheduler", ok: false, detail: (err as Error).message });
    }

    // Resource budget
    try {
      const budget = getResourceBudgetManager();
      const status = budget.getStatus();
      checks.push({
        name: "resources",
        ok: status.canRunLocal || !!this.config.cloudFallback,
        detail: status.canRunLocal ? "local" : (this.config.cloudFallback ? "cloud-fallback" : "insufficient"),
      });
    } catch {
      checks.push({ name: "resources", ok: true, detail: "check skipped" });
    }

    const healthy = checks.every((c) => c.ok);
    return {
      healthy,
      version: "3.1.0",
      uptime: Date.now() - this._startTime,
      checks,
    };
  }

  private readonly _startTime = Date.now();

  /**
   * 检查资源预算，如果不足则记录警告
   */
  private checkResourceBudget(): void {
    try {
      const budget = getResourceBudgetManager();
      const status = budget.getStatus();
      if (!status.canRunLocal) {
        logger.warn("[DRE] Resource budget insufficient for local inference", {
          availableMemory: status.resource.availableMemory,
          recommendedMaxTokens: status.recommendedMaxTokens,
          suggestion: this.config.cloudFallback
            ? "Cloud fallback is configured"
            : "Configure cloudFallback in DREConfig for automatic degradation",
        });
      } else {
        logger.info("[DRE] Resource budget OK", {
          availableMemory: status.resource.availableMemory,
          recommendedMaxTokens: status.recommendedMaxTokens,
        });
      }
    } catch (err) {
      logger.debug("[DRE] Resource budget check skipped", { error: (err as Error).message });
    }
  }

  /**
   * 写入知识 (触发三段甄别)
   */
  async writeKnowledge(item: KnowledgeItem): Promise<{
    accepted: boolean;
    verification?: VerificationResult;
  }> {
    logger.info("[DRE] Writing knowledge", { id: item.id, title: item.title });

    const result = await this.pipeline.process(item);

    if (result.accepted) {
      // via DataUnifier
      this.data.write({
        id: item.id,
        content: item.content,
        kind: "entity",
        domain: item.domain,
        paradigm: item.paradigm,
        sourceType: item.sourceType,
        metadata: { title: item.title },
      });

      this.syncToKG(item);

      logger.info("[DRE] Knowledge accepted", {
        id: item.id,
        stage: result.riskReport.nextStage === 0 ? "prefilter" :
               result.riskReport.nextStage === 2 ? "webverify" :
               result.riskReport.nextStage === 3 ? "llmverify" : "unknown",
      });
    } else {
      logger.warn("[DRE] Knowledge rejected", {
        id: item.id,
        riskScore: result.riskReport.riskScore,
        verdict: result.verification?.verdict,
      });
    }

    return result;
  }

  /**
   * 读取知识
   */
  readKnowledge(nodeId: string): KnowledgeNode | null {
    return this.knowledgeStore.read(nodeId);
  }

  /**
   * 搜索数据 (通过 DataUnifier 统一搜索 Atom + KnowledgeStore)
   */
  searchData(query: string, options?: {
    domain?: string;
    paradigm?: string;
    minConfidence?: number;
    limit?: number;
  }) {
    return this.data.search(query, options);
  }

  /**
   * 子图检索
   */
  subgraph(seedNodeId: string, depth: number = 2, maxNodes: number = 50): KnowledgeNode[] {
    return this.knowledgeStore.subgraph(seedNodeId, depth, maxNodes);
  }

  /**
   * 处理意识流步骤 (三级降级: 本地LLM → 云API → 规则推理)
   */
  async consciousnessStep(input: {
    observation: string;
    embedding?: number[];
    metadata?: Record<string, unknown>;
  }): Promise<{
    decision: unknown;
    shouldReflect: boolean;
    reflection?: ReflectionResult;
    fallbackLevel?: "local" | "cloud" | "rule";
  }> {
    try {
      // L1: 本地 LLM
      const result = await this.consciousness.step(input);
      return { ...result, fallbackLevel: "local" };
    } catch (localErr) {
      logger.warn("[DRE] Local LLM failed for consciousness step", {
        error: (localErr as Error).message,
      });

      // L2: 云 API 降级
      if (this.config.cloudFallback) {
        try {
          const cloudResult = await this.cloudConsciousnessStep(input);
          return { ...cloudResult, fallbackLevel: "cloud" };
        } catch (cloudErr) {
          logger.warn("[DRE] Cloud API also failed for consciousness step", {
            error: (cloudErr as Error).message,
          });
        }
      }

      // L3: 规则推理 (零LLM)
      const ruleResult = this.ruleBasedConsciousnessStep(input);
      return { ...ruleResult, fallbackLevel: "rule" };
    }
  }

  /**
   * 切换 Persona 模式
   */
  switchPersona(mode: PersonaMode, reason?: string): LoadedPersona {
    return this.persona.switchTo(mode, reason);
  }

  /**
   * 获取当前 Persona
   */
  getCurrentPersona(): PersonaMode {
    return this.persona.getCurrentMode();
  }

  /**
   * 获取统一认知状态 (CognitiveState)
   *
   * 聚合所有子系统的状态为单一可查询结构。
   * "状态式"交互模式的核心入口。
   */
  getCognitiveState(): {
    persona: {
      mode: PersonaMode;
      name: string;
      temperature: number;
      allowWrite: boolean;
      canUseTools: boolean;
      stackDepth: number;
      switchCount: number;
    };
    consciousness: {
      workingMemorySize: number;
      episodicMemorySize: number;
      traceLength: number;
      reflectionCount: number;
      lastReflectionAt: number;
    };
    reasoning: {
      totalNodes: number;
      totalEdges: number;
      gaps: number;
    };
    constraints: {
      total: number;
      byDimension: Record<string, number>;
    };
    goals: Array<{ id: string; description: string; status: string }>;
    beliefs: Array<{ statement: string; confidence: number }>;
    hypotheses: Array<{ statement: string; status: string }>;
    resource: {
      availableMemory: number;
      canRunLocal: boolean;
    };
  } {
    const personaSummary = this.persona.getContextSummary();
    const consciousnessState = this.consciousness.getState();
    const reasoningStats = this.reasoning.getStats();
    const constraintStats = this.constraints.getStats();
    const budgetStatus = getResourceBudgetManager().getStatus();

    const goals = Object.entries(worldState.getGoals()).map(([id, g]) => ({
        id,
        description: g.description,
        status: g.status,
      }));
    const beliefs = Object.values(worldState.getBeliefs()).map((b) => ({
        statement: b.statement,
        confidence: b.confidence,
      }));
    const hypotheses = Object.values(worldState.getHypotheses()).map((h) => ({
        statement: h.statement,
        status: h.status,
      }));

    return {
      persona: {
        mode: personaSummary.currentMode as PersonaMode,
        name: personaSummary.currentPersona,
        temperature: this.persona.getTemperature(),
        allowWrite: this.persona.canWrite(),
        canUseTools: this.persona.canUseTools(),
        stackDepth: personaSummary.stackDepth,
        switchCount: personaSummary.switchCount,
      },
      consciousness: {
        workingMemorySize: consciousnessState.workingMemorySize,
        episodicMemorySize: consciousnessState.episodicMemorySize,
        traceLength: consciousnessState.traceLength,
        reflectionCount: consciousnessState.reflectionCount,
        lastReflectionAt: consciousnessState.lastReflectionAt,
      },
      reasoning: {
        totalNodes: reasoningStats.totalNodes,
        totalEdges: reasoningStats.totalEdges,
        gaps: reasoningStats.gaps,
      },
      constraints: {
        total: constraintStats.total,
        byDimension: constraintStats.byDimension,
      },
      goals,
      beliefs,
      hypotheses,
      resource: {
        availableMemory: budgetStatus.resource.availableMemory,
        canRunLocal: budgetStatus.canRunLocal,
      },
    };
  }

  /**
   * 获取引擎状态
   */
  getStatus(): {
    vfs: { mounts: string[] };
    knowledge: { nodes: number; edges: number };
    consciousness: {
      workingMemorySize: number;
      episodicMemorySize: number;
      traceLength: number;
      reflectionCount: number;
    };
    kg: { nodes: number; edges: number };
    mentalModels: { total: number; domains: string[] };
    reasoning: { nodes: number; edges: number; gaps: number };
    constraints: { total: number; byDimension: Record<string, number> };
    actors: { count: number; types: string[] };
    resource: { availableMemory: number; maxMemory: number; canRunLocal: boolean };
    persona: { currentMode: PersonaMode; currentPersona: string; stackDepth: number; switchCount: number };
  } {
    const mmList = this.mentalModels.list();
    const reasoningStats = this.reasoning.getStats();
    const constraintStats = this.constraints.getStats();
    const actorList = this.actors.list();
    const budgetStatus = getResourceBudgetManager().getStatus();
    return {
      vfs: { mounts: this.vfs.listMounts() },
      knowledge: {
        nodes: (() => { try { return (this.db.prepare("SELECT COUNT(*) as c FROM knowledge_node").get() as { c: number }).c; } catch { return 0; } })(),
        edges: (() => { try { return (this.db.prepare("SELECT COUNT(*) as c FROM kg_edge").get() as { c: number }).c; } catch { return 0; } })(),
      },
      consciousness: this.consciousness.getState(),
      kg: {
        nodes: this.kg.nodeCount,
        edges: this.kg.edgeCount,
      },
      mentalModels: {
        total: mmList.length,
        domains: [...new Set(mmList.map((m) => m.domain))],
      },
      reasoning: {
        nodes: reasoningStats.totalNodes,
        edges: reasoningStats.totalEdges,
        gaps: reasoningStats.gaps,
      },
      constraints: {
        total: constraintStats.total,
        byDimension: constraintStats.byDimension,
      },
      actors: {
        count: actorList.length,
        types: actorList.map((a) => a.type),
      },
      resource: {
        availableMemory: budgetStatus.resource.availableMemory,
        maxMemory: budgetStatus.resource.maxMemory,
        canRunLocal: budgetStatus.canRunLocal,
      },
      persona: this.persona.getContextSummary(),
    };
  }

  /**
   * 同步知识到图谱
   */
  private syncToKG(item: KnowledgeItem): void {
    const kgNode: KGNode = {
      id: item.id,
      title: item.title,
      domain: item.domain,
      paradigm: item.paradigm,
      confidence: 1.0,
    };

    this.kg.addNode(kgNode);

    // 查找相关节点并建立边
    const related = this.knowledgeStore.search(item.title, { limit: 3 });
    for (const node of related) {
      if (node.nodeId !== item.id) {
        const edge: KGEdge = {
          srcNode: item.id,
          dstNode: node.nodeId,
          relation: "related-to",
          weight: 0.5,
        };

        try {
          this.knowledgeStore.addEdge(edge);
          this.kg.addEdge({
            src: item.id,
            dst: node.nodeId,
            relation: "related-to",
            weight: 0.5,
          });
        } catch (err) {
          logger.debug("[DRE] syncToKG edge skipped (duplicate or error)", { error: (err as Error).message });
        }
      }
    }
  }

  /**
   * 处理反思结果
   */
  private handleReflection(result: ReflectionResult): void {
    logger.info("[DRE] Reflection triggered", {
      issues: result.issues.length,
      lessons: result.lessons.length,
      rollback: result.rollback,
    });

    // 经验写入长期记忆 (需经三段甄别)
    if (result.lessons.length > 0) {
      const lessonContent = result.lessons.join("\n");
      // writeKnowledge is async; EventEmitter does not await listeners, so attach
      // a .catch() to prevent an unhandled rejection from crashing the process.
      this.writeKnowledge({
        id: `reflection-${Date.now()}`,
        title: "经验教训",
        content: lessonContent,
        domain: "meta",
        paradigm: "rule",
        sourceType: "llm",
      }).catch((err) => {
        logger.warn("[DRE] Failed to persist reflection lessons", { error: (err as Error).message });
      });
    }
  }

  /**
   * 关闭引擎
   */
  async close(): Promise<void> {
    // 关闭 Actor 系统
    await this.actors.shutdown();
    logger.info("[DRE] Actor system shut down");
    try { this.db.close(); } catch (err) {
      logger.warn("[DRE] DB close error", { error: (err as Error).message });
    }
    try { this.sqliteBackend.close(); } catch (err) {
      logger.warn("[DRE] SQLite backend close error", { error: (err as Error).message });
    }
    logger.info("[DRE] Engine closed");
  }

  /**
   * 云 API 降级: 直接使用 cloudFallback.baseUrl/model/apiKey 调用 OpenAI 兼容端点。
   *
   * 设计说明：cloudFallback 的三个字段（baseUrl/model/apiKey）是真实请求参数，
   * 而非仅当布尔开关——若只靠主路由，DRE 就失去了自包含性，也无法在
   * 主路由未配置对应 provider 时独立工作。调用方显式传入这些值，绕过模型路由。
   */
  private async cloudConsciousnessStep(input: {
    observation: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    decision: unknown;
    shouldReflect: boolean;
    reflection?: ReflectionResult;
  }> {
    const fb = this.config.cloudFallback;
    if (!fb?.apiKey) {
      throw new Error("[DRE] cloudFallback 未配置 apiKey，无法执行云端降级");
    }
    const { callProvider } = await import("../router/provider-caller.js");

    const systemPrompt = DRE_DECISION_SYSTEM;
    const result = await callProvider(
      "deepseek",
      fb.model ?? "deepseek-v4-flash",
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: input.observation },
      ],
      30000,
      0,
      undefined,
      undefined,
      { baseURL: fb.baseUrl, apiKey: fb.apiKey },
    );

    // M11 审计修复：云端坏输出与本地同级 —— 抛错由降级链继续走 L3 规则，
    // 不再静默合成 observe(0.5) 掩盖输出质量问题。
    const decision = parseCloudDecisionOrThrow(result.content);

    return {
      decision,
      shouldReflect: false,
    };
  }

  /**
   * 规则推理降级: 零LLM，基于关键词匹配和工作记忆快照
   */
  private ruleBasedConsciousnessStep(input: {
    observation: string;
    metadata?: Record<string, unknown>;
  }): {
    decision: unknown;
    shouldReflect: boolean;
    reflection?: ReflectionResult;
  } {
    const observation = input.observation.toLowerCase();

    // 简单意图识别
    let action = "observe";
    let confidence = 0.5;

    if (observation.includes("error") || observation.includes("错误") || observation.includes("失败")) {
      action = "reflect";
      confidence = 0.7;
    } else if (observation.includes("todo") || observation.includes("待办") || observation.includes("需要")) {
      action = "act";
      confidence = 0.6;
    } else if (observation.includes("总结") || observation.includes("回顾") || observation.includes("分析")) {
      action = "reflect";
      confidence = 0.6;
    }

    const decision = {
      action,
      content: input.observation,
      confidence,
      source: "rule-based-fallback",
    };

    // 如果检测到异常关键词，触发反思
    const shouldReflect = action === "reflect" && confidence >= 0.7;

    let reflection: ReflectionResult | undefined;
    if (shouldReflect) {
      reflection = {
        issues: ["降级到规则推理，LLM不可用"],
        lessons: ["需要检查本地LLM服务或配置云API降级"],
        rollback: false,
      };
    }

    return { decision, shouldReflect, reflection };
  }
}



