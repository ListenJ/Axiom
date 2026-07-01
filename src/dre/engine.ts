/**
 * DRE — 确定性推理引擎 主入口
 *
 * 整合所有模块:
 * - VFS: 虚拟文件系统
 * - Storage: 知识库存储
 * - Pipeline: 三段甄别
 * - Consciousness: 意识流
 * - KG: 知识图谱
 * - Harness: Agent 编排
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
import { PlannerAgent, CoderAgent, RetrieverAgent, ReflectorAgent, type Tool } from "./harness/agent.js";
import { getVRAMBudgetManager } from "./vram-budget.js";
import { MentalModelPool, createDefaultMentalModelPool } from "./mental-model/pool.js";
import { ReasoningGraph } from "./reasoning/graph.js";
import { ConstraintSolver, createDefaultConstraintSolver } from "./constraint/solver.js";
import { ActorSystem, createDefaultActorSystem } from "./actor/system.js";
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

    // 初始化 LLM 客户端
    this.mainLLM = new LLMClient(config.mainLLM);
    this.discriminLLM = config.discriminLLM ? new LLMClient(config.discriminLLM) : null;

    // 初始化三段甄别流水线
    this.pipeline = new Pipeline(this.knowledgeStore, this.mainLLM);

    // 初始化知识图谱
    this.kg = new KnowledgeGraph();

    // 初始化心智模型池 (预注册 Git/Code 等领域模型)
    this.mentalModels = createDefaultMentalModelPool();

    // 初始化推理图
    this.reasoning = new ReasoningGraph();

    // 初始化约束求解器 (预注册 GPU/策略/时间约束)
    this.constraints = createDefaultConstraintSolver();

    // 初始化 Actor 系统 (异步，不阻塞构造)
    this.actors = new ActorSystem();
    this.initActors();

    // 初始化意识流
    this.consciousness = new ConsciousnessStream({
      workingMemoryCapacity: config.workingMemoryCapacity ?? 16,
      episodicTTL: config.episodicTTL ?? 3600000,
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

    // 异步检查 VRAM (不阻塞构造)
    this.checkVRAMBudget();
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
   * 检查 VRAM 预算，如果不足则记录警告
   */
  private async checkVRAMBudget(): Promise<void> {
    try {
      const vram = getVRAMBudgetManager();
      const status = await vram.getStatus();
      if (!status.canRunLocal) {
        logger.warn("[DRE] VRAM budget insufficient for local inference", {
          gpu: status.gpu.name,
          freeMB: status.gpu.freeMemoryMB,
          recommendedMaxTokens: status.recommendedMaxTokens,
          suggestion: this.config.cloudFallback
            ? "Cloud fallback is configured"
            : "Configure cloudFallback in DREConfig for automatic degradation",
        });
      } else {
        logger.info("[DRE] VRAM budget OK", {
          gpu: status.gpu.name,
          freeMB: status.gpu.freeMemoryMB,
          recommendedMaxTokens: status.recommendedMaxTokens,
        });
      }
    } catch (err) {
      logger.debug("[DRE] VRAM budget check skipped (nvidia-smi unavailable)", { error: (err as Error).message });
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
      // 同步到知识图谱
      this.syncToKG(item);

      logger.info("[DRE] Knowledge accepted", {
        id: item.id,
        stage: result.riskReport.nextStage === 0 ? "prefilter" :
               result.riskReport.nextStage === 2 ? "webverify" : "llmverify",
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
   * 搜索知识
   */
  searchKnowledge(query: string, options?: {
    domain?: string;
    paradigm?: string;
    minConfidence?: number;
    limit?: number;
  }): KnowledgeNode[] {
    return this.knowledgeStore.search(query, options);
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
   * 创建规划 Agent
   */
  createPlannerAgent(tools: Tool[]): PlannerAgent {
    return new PlannerAgent(this.mainLLM, tools);
  }

  /**
   * 创建编码 Agent
   */
  createCoderAgent(tools: Tool[]): CoderAgent {
    return new CoderAgent(this.mainLLM, tools);
  }

  /**
   * 创建检索 Agent
   */
  createRetrieverAgent(tools: Tool[]): RetrieverAgent {
    return new RetrieverAgent(this.mainLLM, tools);
  }

  /**
   * 创建反思 Agent
   */
  createReflectorAgent(tools: Tool[]): ReflectorAgent {
    return new ReflectorAgent(this.mainLLM, tools);
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
  } {
    const mmList = this.mentalModels.list();
    const reasoningStats = this.reasoning.getStats();
    const constraintStats = this.constraints.getStats();
    const actorList = this.actors.list();
    return {
      vfs: { mounts: this.vfs.listMounts() },
      knowledge: {
        nodes: this.db.prepare("SELECT COUNT(*) as c FROM knowledge_node").get() as number,
        edges: this.db.prepare("SELECT COUNT(*) as c FROM kg_edge").get() as number,
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
      this.writeKnowledge({
        id: `reflection-${Date.now()}`,
        title: "经验教训",
        content: lessonContent,
        domain: "meta",
        paradigm: "rule",
        sourceType: "llm",
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

    this.db.close();
    this.sqliteBackend.close();
    logger.info("[DRE] Engine closed");
  }

  /**
   * 云 API 降级: 通过 router.chat 调用云模型
   */
  private async cloudConsciousnessStep(input: {
    observation: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    decision: unknown;
    shouldReflect: boolean;
    reflection?: ReflectionResult;
  }> {
    const { router } = await import("../router/model-router.js");

    const systemPrompt = `你是一个确定性推理引擎的意识流处理器。
当前工作记忆中的观察内容如下。
请根据观察内容做出决策，输出JSON格式:
{"action": "observe|reflect|act", "content": "...", "confidence": 0.0-1.0}`;

    const result = await router.chat("general-chat", [
      { role: "system", content: systemPrompt },
      { role: "user", content: input.observation },
    ]);

    let decision: unknown;
    try {
      decision = JSON.parse(result.content || '{"action":"observe","content":"fallback"}');
    } catch (err) {
      logger.debug("[DRE] Cloud API response not JSON, using raw content", { error: (err as Error).message });
      decision = { action: "observe", content: result.content || input.observation };
    }

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
