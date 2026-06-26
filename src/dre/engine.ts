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

  private db: Database;
  private sqliteBackend: SqliteBackend;

  constructor(config: DREConfig) {
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
   * 处理意识流步骤
   */
  async consciousnessStep(input: {
    observation: string;
    embedding?: number[];
    metadata?: Record<string, unknown>;
  }): Promise<{
    decision: unknown;
    shouldReflect: boolean;
    reflection?: ReflectionResult;
  }> {
    return this.consciousness.step(input);
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
  } {
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
        } catch {
          // 忽略重复边
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
  close(): void {
    this.db.close();
    this.sqliteBackend.close();
    logger.info("[DRE] Engine closed");
  }
}
