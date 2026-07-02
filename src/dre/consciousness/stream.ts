/**
 * DRE 意识流 — TypeScript 实现
 *
 * 三层记忆架构:
 * - 工作记忆 (Working Memory): 容量受限 FIFO，当前任务上下文
 * - 短期记忆 (Episodic Memory): 向量索引，TTL=1h
 * - 长期记忆 (Semantic Memory): 知识库 + KG，永久存储
 *
 * 反思机制:
 * - 每 K 步触发反思 Agent
 * - 检测逻辑断点/证据缺失
 * - 生成经验教训写入长期记忆
 * - 必要时回滚至 checkpoint
 *
 * TypeScript 优势:
 * - 强类型系统，编译时捕获错误
 * - 原生 JSON 处理，与 LLM 输出天然契合
 * - AsyncGenerator 流式响应
 * - 事件驱动架构
 */

import { EventEmitter } from "events";

/** 记忆条目 */
export interface MemoryItem {
  id: string;
  content: string;
  embedding?: number[];
  timestamp: number;
  ttl?: number;            // 过期时间戳
  metadata: Record<string, unknown>;
}

/** 反思结果 */
export interface ReflectionResult {
  issues: string[];
  lessons: string[];
  rollback: boolean;
  checkpointTag?: string;
  correctedAction?: string;
}

/** 意识流状态 */
export interface ConsciousnessState {
  workingMemorySize: number;
  episodicMemorySize: number;
  traceLength: number;
  lastReflectionAt: number | null;
  reflectionCount: number;
}

/**
 * 工作记忆 — 容量受限的 FIFO
 */
export class WorkingMemory {
  private buffer: MemoryItem[] = [];
  private readonly capacity: number;

  constructor(capacity: number = 16) {
    this.capacity = capacity;
  }

  /**
   * 推入记忆条目
   */
  push(item: MemoryItem): void {
    this.buffer.push(item);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift(); // FIFO 淘汰
    }
  }

  /**
   * 获取快照
   */
  snapshot(): MemoryItem[] {
    return [...this.buffer];
  }

  /**
   * 获取最近 N 条
   */
  recent(n: number): MemoryItem[] {
    return this.buffer.slice(-n);
  }

  /**
   * 清空
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * 当前大小
   */
  get size(): number {
    return this.buffer.length;
  }
}

/**
 * 短期记忆 — 向量索引，TTL=1h
 */
export class EpisodicMemory {
  private items: MemoryItem[] = [];
  private readonly defaultTTL: number;

  constructor(defaultTTL: number = 3600000) { // 1 hour
    this.defaultTTL = defaultTTL;
  }

  /**
   * 添加记忆条目
   */
  add(item: MemoryItem): void {
    if (!item.ttl) {
      item.ttl = Date.now() + this.defaultTTL;
    }
    this.items.push(item);
  }

  /**
   * 搜索相似记忆 (余弦相似度)
   */
  search(queryEmbedding: number[], k: number = 5): MemoryItem[] {
    if (!queryEmbedding || this.items.length === 0) return [];

    // 计算余弦相似度
    const similarities = this.items
      .filter((item) => item.embedding && item.embedding.length > 0)
      .map((item) => ({
        item,
        similarity: this.cosineSimilarity(queryEmbedding, item.embedding!),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);

    return similarities.map((s) => s.item);
  }

  /**
   * 清理过期记忆
   */
  cleanup(): number {
    const now = Date.now();
    const before = this.items.length;
    this.items = this.items.filter((item) => !item.ttl || item.ttl > now);
    return before - this.items.length;
  }

  /**
   * 获取所有记忆
   */
  getAll(): MemoryItem[] {
    return [...this.items];
  }

  /**
   * 当前大小
   */
  get size(): number {
    return this.items.length;
  }

  /**
   * 余弦相似度计算
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}

/**
 * 反思队列 — 触发自反思
 */
export class ReflectionQueue {
  private triggers: Array<(trace: TraceEntry[]) => { triggered: boolean; issues: string[]; lessons: string[] }> = [];

  constructor() {
    // 注册默认触发条件
    this.triggers.push(this.checkConsecutiveFailures.bind(this));
    this.triggers.push(this.checkOutputInconsistency.bind(this));
    this.triggers.push(this.checkConfidenceVariance.bind(this));
  }

  /**
   * 检查是否应该触发反思 (返回匹配的 issues/lessons)
   */
  shouldReflect(trace: TraceEntry[]): { triggered: boolean; issues: string[]; lessons: string[] } {
    if (trace.length < 10) return { triggered: false, issues: [], lessons: [] };

    for (const trigger of this.triggers) {
      const result = trigger(trace);
      if (result.triggered) return result;
    }

    return { triggered: false, issues: [], lessons: [] };
  }

  /**
   * 触发条件 1: 连续 3 次同子任务失败
   */
  private checkConsecutiveFailures(trace: TraceEntry[]): { triggered: boolean; issues: string[]; lessons: string[] } {
    const recent = trace.slice(-10);
    const failures = recent.filter((t) => t.status === "failed");
    if (failures.length >= 3) {
      return {
        triggered: true,
        issues: [`发现 ${failures.length} 个失败步骤`],
        lessons: ["需要加强错误处理和重试机制"],
      };
    }
    // 即使不足 3 次, 仍在 reflect 时报告
    if (failures.length > 0) {
      return {
        triggered: false,
        issues: [`发现 ${failures.length} 个失败步骤`],
        lessons: ["需要加强错误处理和重试机制"],
      };
    }
    return { triggered: false, issues: [], lessons: [] };
  }

  /**
   * 触发条件 2: output_hash 不一致
   */
  private checkOutputInconsistency(trace: TraceEntry[]): { triggered: boolean; issues: string[]; lessons: string[] } {
    const recent = trace.slice(-10);
    const outputs = recent
      .filter((t) => t.stepType === "think")
      .map((t) => t.outputHash);

    if (outputs.length < 3) return { triggered: false, issues: [], lessons: [] };

    const uniqueOutputs = new Set(outputs);
    const inconsistent = uniqueOutputs.size < outputs.length * 0.7;
    if (inconsistent) {
      return {
        triggered: true,
        issues: ["输出不一致，可能存在幻觉"],
        lessons: ["需要加强确定性约束"],
      };
    }
    return { triggered: false, issues: [], lessons: [] };
  }

  /**
   * 触发条件 3: 置信度方差 > 0.15
   */
  private checkConfidenceVariance(trace: TraceEntry[]): { triggered: boolean; issues: string[]; lessons: string[] } {
    const recent = trace.slice(-10);
    const confidences = recent
      .map((t) => t.confidence ?? 1.0);

    if (confidences.length < 3) return { triggered: false, issues: [], lessons: [] };

    const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const variance = confidences.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / confidences.length;
    const volatile = Math.sqrt(variance) > 0.15;
    if (volatile) {
      return {
        triggered: true,
        issues: ["置信度波动过大"],
        lessons: ["需要更稳定的推理策略"],
      };
    }
    return { triggered: false, issues: [], lessons: [] };
  }
}

/** 推理追踪条目 */
export interface TraceEntry {
  stepSeq: number;
  stepType: "observe" | "think" | "act" | "reflect" | "checkpoint";
  inputHash: string;
  outputHash: string;
  modelName?: string;
  promptHash?: string;
  seed?: number;
  temperature?: number;
  payload?: unknown;
  confidence?: number;
  status?: "success" | "failed";
  timestamp: number;
}

/**
 * 意识流管理器
 *
 * 核心循环:
 * 1. 观察 → 工作记忆
 * 2. 决策 → 检索 KG + 工作记忆 → LLM 推理
 * 3. 行动 → 执行工具调用
 * 4. 反思 → 检查触发条件 → 生成经验教训
 */
export class ConsciousnessStream extends EventEmitter {
  readonly workingMemory: WorkingMemory;
  readonly episodicMemory: EpisodicMemory;
  readonly reflectionQueue: ReflectionQueue;

  private trace: TraceEntry[] = [];
  private stepCounter: number = 0;
  private lastReflectionAt: number | null = null;
  private reflectionCount: number = 0;

  constructor(options?: {
    workingMemoryCapacity?: number;
    episodicTTL?: number;
  }) {
    super();

    this.workingMemory = new WorkingMemory(options?.workingMemoryCapacity ?? 16);
    this.episodicMemory = new EpisodicMemory(options?.episodicTTL ?? 3600000);
    this.reflectionQueue = new ReflectionQueue();
  }

  /**
   * 处理一步
   */
  async step(input: {
    observation: string;
    embedding?: number[];
    metadata?: Record<string, unknown>;
  }): Promise<{
    decision: unknown;
    shouldReflect: boolean;
    reflection?: ReflectionResult;
  }> {
    this.stepCounter++;
    const now = Date.now();

    // 1. 观察 → 工作记忆
    const memoryItem: MemoryItem = {
      id: `wm-${this.stepCounter}`,
      content: input.observation,
      embedding: input.embedding,
      timestamp: now,
      metadata: input.metadata ?? {},
    };
    this.workingMemory.push(memoryItem);

    // 2. 短期记忆索引
    if (input.embedding) {
      this.episodicMemory.add(memoryItem);
    }

    // 3. 决策 (由外部 Agent 实现)
    const decision = await this.decide(input.observation);

    // 4. 记录追踪
    const traceEntry: TraceEntry = {
      stepSeq: this.stepCounter,
      stepType: "think",
      inputHash: this.hash(input.observation),
      outputHash: this.hash(JSON.stringify(decision)),
      confidence: (decision as { confidence?: number })?.confidence,
      status: "success",
      timestamp: now,
    };
    this.trace.push(traceEntry);

    // 5. 反思检查
    const reflectionResult = this.reflectionQueue.shouldReflect(this.trace);
    const shouldReflect = reflectionResult.triggered;
    let reflection: ReflectionResult | undefined;

    if (shouldReflect) {
      reflection = await this.reflect(reflectionResult);
      this.lastReflectionAt = Date.now();
      this.reflectionCount++;

      this.emit("reflection", reflection);
    }

    return { decision, shouldReflect, reflection };
  }

  /**
   * 决策 (可由外部 Agent 覆盖)
   */
  protected async decide(observation: string): Promise<unknown> {
    // 默认实现：返回观察内容
    return { action: "observe", content: observation };
  }

  /**
   * 反思 — 基于 ReflectionQueue 的分析结果生成经验教训
   */
  async reflect(analysis?: { triggered: boolean; issues: string[]; lessons: string[] }): Promise<ReflectionResult> {
    if (analysis) {
      // 使用已有分析结果 (来自 shouldReflect)
      const rollback = analysis.issues.length >= 3;
      return {
        issues: analysis.issues,
        lessons: analysis.lessons,
        rollback,
        checkpointTag: rollback ? `checkpoint-${this.stepCounter}` : undefined,
      };
    }

    // 降级: 无分析结果时直接从 trace 分析
    const result = this.reflectionQueue.shouldReflect(this.trace);
    const rollback = result.issues.length >= 3;
    return {
      issues: result.issues,
      lessons: result.lessons,
      rollback,
      checkpointTag: rollback ? `checkpoint-${this.stepCounter}` : undefined,
    };
  }

  /**
   * 获取状态
   */
  getState(): ConsciousnessState {
    return {
      workingMemorySize: this.workingMemory.size,
      episodicMemorySize: this.episodicMemory.size,
      traceLength: this.trace.length,
      lastReflectionAt: this.lastReflectionAt,
      reflectionCount: this.reflectionCount,
    };
  }

  /**
   * 获取追踪记录
   */
  getTrace(): TraceEntry[] {
    return [...this.trace];
  }

  /**
   * 清理过期记忆
   */
  cleanup(): void {
    const removed = this.episodicMemory.cleanup();
    if (removed > 0) {
      this.emit("cleanup", { removed });
    }
  }

  /**
   * 计算哈希
   */
  private hash(content: string): string {
    // 简化实现：使用内置哈希
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为 32 位整数
    }
    return hash.toString(16);
  }
}
