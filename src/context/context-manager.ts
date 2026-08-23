/**
 * 上下文管理器 (Context Manager)
 *
 * 管理 Agent 对话上下文的生命周期:
 *   - 监控上下文使用量 (token count vs max context window)
 *   - 当使用量 >60% 时触发上下文分割/压缩
 *   - 使用记忆层 (embedding models) 存储和检索历史上下文
 *   - 支持并行读取: 将上下文分块并行处理
 *   - 优雅降级: 上下文过大时切换更便宜的模型处理
 *
 * 记忆层使用 embedding 角色模型进行上下文摘要和检索。
 */

import { logger } from "../utils/logger.js";
import { cosineSimilarity as sharedCosineSimilarity } from "../utils/math.js";
import { router, type ChatMessage } from "../router/model-router.js";
import { findModelsForRole, type TaskRole, type ModelCapability } from "../router/model-capability-registry.js";
import { getTokenTracker } from "../router/token-tracker.js";
import { TIMEOUTS } from "../constants/timeouts.js";

// ═══════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════

export interface ContextChunk {
  id: string;
  index: number;           // 在原始上下文中的位置
  messages: ChatMessage[];
  tokenCount: number;
  summary?: string;        // 摘要 (由 embedding 模型生成)
  embedding?: number[];    // 向量嵌入
  timestamp: number;
  importance: number;      // 重要性评分 0-1
}

export interface MemoryEntry {
  id: string;
  summary: string;
  embedding: number[];
  timestamp: number;
  messageCount: number;
  tokenCount: number;
  tags: string[];
}

export interface ContextStats {
  totalTokens: number;
  maxTokens: number;
  usagePercent: number;
  chunkCount: number;
  memoryEntries: number;
  activeChunks: number;
  compressedChunks: number;
}

export interface SplitOptions {
  thresholdPercent?: number;  // 触发分割的阈值 (默认 60%)
  maxChunkTokens?: number;    // 每块最大 token 数
  preserveRecent?: number;    // 保留最近的 N 条消息不压缩
  parallelProcessing?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Token 估算 (简化版 Tiktoken)
// ═══════════════════════════════════════════════════════════════

function estimateTokens(text: string): number {
  // 粗略估算: 英文 ~4 chars/token, 中文 ~1.5 chars/token
  // 混合文本使用保守估算
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function estimateMessageTokens(msg: ChatMessage): number {
  // 每条消息基础开销 ~4 tokens + content
  return 4 + estimateTokens(msg.content);
}

// ═══════════════════════════════════════════════════════════════
// ContextManager 主类
// ═══════════════════════════════════════════════════════════════

export class ContextManager {
  private chunks: ContextChunk[] = [];
  private memory: MemoryEntry[] = [];
  private maxContextWindow: number;
  private defaultModel: ModelCapability | null = null;

  constructor(options?: { maxContextWindow?: number }) {
    this.maxContextWindow = options?.maxContextWindow ?? 128000;
    this.initDefaultModel();
  }

  private initDefaultModel(): void {
    const models = findModelsForRole("general-chat");
    this.defaultModel = models.length > 0 ? models[0] : null;
  }

  /**
   * 获取当前上下文统计
   */
  getStats(): ContextStats {
    const totalTokens = this.chunks.reduce((sum, c) => sum + c.tokenCount, 0);
    return {
      totalTokens,
      maxTokens: this.maxContextWindow,
      usagePercent: totalTokens / this.maxContextWindow,
      chunkCount: this.chunks.length,
      memoryEntries: this.memory.length,
      activeChunks: this.chunks.filter((c) => !c.summary).length,
      compressedChunks: this.chunks.filter((c) => !!c.summary).length,
    };
  }

  /**
   * 检查上下文使用量，超过阈值时触发分割
   */
  async checkUsage(
    messages: ChatMessage[],
    options: SplitOptions = {}
  ): Promise<{ messages: ChatMessage[]; action: "none" | "split" | "compress" }> {
    const { thresholdPercent = 0.6, preserveRecent = 4 } = options;

    const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const usagePercent = totalTokens / this.maxContextWindow;

    logger.info("[ContextManager] Usage check", {
      tokens: totalTokens,
      max: this.maxContextWindow,
      percent: `${(usagePercent * 100).toFixed(1)}%`,
      threshold: `${(thresholdPercent * 100).toFixed(0)}%`,
    });

    if (usagePercent < thresholdPercent) {
      return { messages, action: "none" };
    }

    // 超过阈值，需要分割/压缩
    if (usagePercent > 0.85) {
      // 严重超过，强制压缩旧上下文到记忆层
      const compressed = await this.compressContext(messages, { preserveRecent });
      return { messages: compressed, action: "compress" };
    }

    // 中等超过，分割上下文
    const split = await this.splitContext(messages, options);
    return { messages: split.activeMessages, action: "split" };
  }

  /**
   * 分割上下文为活跃部分和归档部分
   */
  async splitContext(
    messages: ChatMessage[],
    options: SplitOptions = {}
  ): Promise<{ activeMessages: ChatMessage[]; archivedChunks: ContextChunk[] }> {
    const { maxChunkTokens = 8000, preserveRecent = 4, parallelProcessing = true } = options;

    // 保留最近的消息
    const recentMessages = messages.slice(-preserveRecent);
    const olderMessages = messages.slice(0, -preserveRecent);

    if (olderMessages.length === 0) {
      return { activeMessages: messages, archivedChunks: [] };
    }

    // 将旧消息分割为 chunks
    const chunks = this.createChunks(olderMessages, maxChunkTokens);

    // 并行处理 chunks (生成摘要和 embedding)
    if (parallelProcessing) {
      await Promise.all(chunks.map((chunk) => this.processChunk(chunk)));
    } else {
      for (const chunk of chunks) {
        await this.processChunk(chunk);
      }
    }

    // 存储到记忆层
    for (const chunk of chunks) {
      if (chunk.summary) {
        await this.storeToMemory(chunk);
      }
    }

    this.chunks.push(...chunks);

    logger.info("[ContextManager] Context split", {
      originalMessages: messages.length,
      activeMessages: recentMessages.length,
      archivedChunks: chunks.length,
    });

    return { activeMessages: recentMessages, archivedChunks: chunks };
  }

  /**
   * 压缩上下文：将旧消息摘要后存储到记忆层
   */
  async compressContext(
    messages: ChatMessage[],
    options: { preserveRecent?: number } = {}
  ): Promise<ChatMessage[]> {
    const { preserveRecent = 4 } = options;

    const recentMessages = messages.slice(-preserveRecent);
    const olderMessages = messages.slice(0, -preserveRecent);

    if (olderMessages.length === 0) return messages;

    // 生成整体摘要
    const summary = await this.generateSummary(olderMessages);

    // 存储到记忆层
    const chunk: ContextChunk = {
      id: `chunk_${Date.now()}`,
      index: 0,
      messages: olderMessages,
      tokenCount: olderMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
      summary,
      timestamp: Date.now(),
      importance: 0.8,
    };

    await this.processChunk(chunk);
    await this.storeToMemory(chunk);
    this.chunks.push(chunk);

    // 返回压缩后的上下文：系统提示 + 摘要 + 最近消息
    const compressedMessages: ChatMessage[] = [
      {
        role: "system",
        content: `Previous conversation summary:\n${summary}\n\n(Use retrieveFromMemory() if you need details from earlier context)`,
      },
      ...recentMessages,
    ];

    logger.info("[ContextManager] Context compressed", {
      originalMessages: messages.length,
      compressedTo: compressedMessages.length,
      summaryLength: summary.length,
    });

    return compressedMessages;
  }

  /**
   * 从记忆层检索相关上下文
   */
  async retrieveFromMemory(query: string, options?: { limit?: number }): Promise<ChatMessage[]> {
    const limit = options?.limit ?? 3;

    if (this.memory.length === 0) {
      return [];
    }

    try {
      // 生成查询的 embedding
      const queryEmbedding = await this.generateEmbedding(query);

      // 计算相似度，返回最相关的记忆
      const scored = this.memory.map((entry) => ({
        entry,
        similarity: this.cosineSimilarity(queryEmbedding, entry.embedding),
      }));

      scored.sort((a, b) => b.similarity - a.similarity);
      const topEntries = scored.slice(0, limit);

      logger.info("[ContextManager] Memory retrieval", {
        query: query.slice(0, 50),
        candidates: this.memory.length,
        retrieved: topEntries.length,
        topScore: topEntries[0]?.similarity.toFixed(3),
      });

      // 转换为消息格式
      return topEntries.map((s) => ({
        role: "system" as const,
        content: `[Retrieved Memory] ${s.entry.summary}`,
      }));
    } catch (error) {
      logger.warn("[ContextManager] Memory retrieval failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 获取有效上下文 (活跃 + 检索到的记忆)
   */
  async getEffectiveContext(
    messages: ChatMessage[],
    query?: string
  ): Promise<ChatMessage[]> {
    const { action, messages: processed } = await this.checkUsage(messages);

    if (action === "none" || !query) {
      return processed;
    }

    // 从记忆层检索相关上下文
    const retrieved = await this.retrieveFromMemory(query);

    // 合并：系统提示 + 检索到的记忆 + 当前消息
    const systemMessages = processed.filter((m) => m.role === "system");
    const nonSystemMessages = processed.filter((m) => m.role !== "system");

    return [...systemMessages, ...retrieved, ...nonSystemMessages];
  }

  /**
   * 设置最大上下文窗口
   */
  setMaxContextWindow(tokens: number): void {
    this.maxContextWindow = tokens;
    logger.info("[ContextManager] Max context window updated", { tokens });
  }

  /**
   * 清除所有记忆
   */
  clearMemory(): void {
    this.memory = [];
    this.chunks = [];
    logger.info("[ContextManager] Memory cleared");
  }

  /**
   * 获取记忆层统计
   */
  getMemoryStats(): { entries: number; totalTokens: number; oldestEntry: number | null } {
    return {
      entries: this.memory.length,
      totalTokens: this.memory.reduce((sum, e) => sum + e.tokenCount, 0),
      oldestEntry: this.memory.length > 0 ? this.memory.reduce((min, e) => Math.min(min, e.timestamp), this.memory[0]!.timestamp) : null,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 私有辅助方法
  // ═══════════════════════════════════════════════════════════════

  private createChunks(messages: ChatMessage[], maxChunkTokens: number): ContextChunk[] {
    const chunks: ContextChunk[] = [];
    let currentChunk: ChatMessage[] = [];
    let currentTokens = 0;
    let chunkIndex = 0;

    for (const msg of messages) {
      const msgTokens = estimateMessageTokens(msg);

      if (currentTokens + msgTokens > maxChunkTokens && currentChunk.length > 0) {
        chunks.push({
          id: `chunk_${Date.now()}_${chunkIndex}`,
          index: chunkIndex,
          messages: [...currentChunk],
          tokenCount: currentTokens,
          timestamp: Date.now(),
          importance: this.estimateImportance(currentChunk),
        });
        currentChunk = [];
        currentTokens = 0;
        chunkIndex++;
      }

      currentChunk.push(msg);
      currentTokens += msgTokens;
    }

    if (currentChunk.length > 0) {
      chunks.push({
        id: `chunk_${Date.now()}_${chunkIndex}`,
        index: chunkIndex,
        messages: [...currentChunk],
        tokenCount: currentTokens,
        timestamp: Date.now(),
        importance: this.estimateImportance(currentChunk),
      });
    }

    return chunks;
  }

  private async processChunk(chunk: ContextChunk): Promise<void> {
    try {
      // 生成摘要
      const summary = await this.generateSummary(chunk.messages);
      chunk.summary = summary;

      // 生成 embedding
      const embedding = await this.generateEmbedding(summary);
      chunk.embedding = embedding;
    } catch (error) {
      logger.warn("[ContextManager] Chunk processing failed", {
        chunkId: chunk.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async generateSummary(messages: ChatMessage[]): Promise<string> {
    try {
      // 使用 decision 或 general-chat 角色生成摘要
      const content = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");

      const summaryMessages: ChatMessage[] = [
        {
          role: "system",
          content:
            "Summarize the following conversation concisely. Capture key facts, decisions, and context. Output in the same language as the conversation.",
        },
        { role: "user", content: content.slice(0, 4000) }, // 限制输入长度
      ];

      // 尝试使用便宜的模型
      const cheapModels = findModelsForRole("decision").filter((m) => m.isFree || m.priority && m.priority <= 3);
      const model = cheapModels.length > 0 ? cheapModels[0] : null;

      if (model) {
        const response = await router.executeWithRole("decision", summaryMessages, {
          temperature: 0.3,
          maxTokens: 300,
        });
        return response.content || "[Summary unavailable]";
      }

      // Fallback: 使用简单的文本截断
      return this.fallbackSummary(messages);
    } catch {
      return this.fallbackSummary(messages);
    }
  }

  private fallbackSummary(messages: ChatMessage[]): string {
    // 提取关键信息作为摘要
    const keyMessages = messages.filter(
      (m) =>
        m.role === "system" ||
        m.content.includes("IMPORTANT") ||
        m.content.includes("决策") ||
        m.content.includes("decision")
    );

    if (keyMessages.length > 0) {
      return keyMessages.map((m: ChatMessage) => `${m.role}: ${m.content.slice(0, 200)}`).join("\n");
    }

    // 最后一条用户消息作为摘要
    const lastUser = messages.filter((m) => m.role === "user").pop();
    return lastUser ? `Last topic: ${lastUser.content.slice(0, 200)}` : "[No summary available]";
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      const embeddings = await router.embeddings([text.slice(0, 4000)]);
      return embeddings[0] || [];
    } catch {
      // Fallback: 使用简单的哈希 embedding (非语义，但可用)
      return this.fallbackEmbedding(text);
    }
  }

  private fallbackEmbedding(text: string): number[] {
    // 简单的字符频率向量 (128维)
    const vec = new Array(128).fill(0);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i) % 128;
      vec[code] += 1;
    }
    // 归一化
    const sum = vec.reduce((a, b) => a + b, 0);
    return sum > 0 ? vec.map((v) => v / sum) : vec;
  }

  private async storeToMemory(chunk: ContextChunk): Promise<void> {
    if (!chunk.summary || !chunk.embedding) return;

    const entry: MemoryEntry = {
      id: chunk.id,
      summary: chunk.summary,
      embedding: chunk.embedding,
      timestamp: chunk.timestamp,
      messageCount: chunk.messages.length,
      tokenCount: chunk.tokenCount,
      tags: this.extractTags(chunk.messages),
    };

    this.memory.push(entry);

    // 如果记忆过多，清理旧的
    if (this.memory.length > 100) {
      this.memory.sort((a, b) => a.timestamp - b.timestamp);
      this.memory = this.memory.slice(-80); // 保留最近的 80 条
    }
  }

  private extractTags(messages: ChatMessage[]): string[] {
    const tags = new Set<string>();
    const text = messages.map((m) => m.content).join(" ");

    if (/code|function|class|import/.test(text)) tags.add("code");
    if (/bug|error|fix|debug/.test(text)) tags.add("debug");
    if (/design|architecture|system/.test(text)) tags.add("architecture");
    if (/test|spec|assert/.test(text)) tags.add("testing");
    if (/doc|readme|comment/.test(text)) tags.add("documentation");

    return Array.from(tags);
  }

  private estimateImportance(messages: ChatMessage[]): number {
    let score = 0.5;

    for (const msg of messages) {
      const content = msg.content.toLowerCase();

      // 系统消息通常更重要
      if (msg.role === "system") score += 0.2;

      // 包含关键信息
      if (/important|critical|decision|final|confirm/.test(content)) score += 0.15;
      if (/error|bug|fail|exception/.test(content)) score += 0.1;

      // 包含代码
      if (/```|\bfunction\b|\bclass\b/.test(content)) score += 0.1;
    }

    return Math.min(score, 1.0);
  }

  // L9：余弦实现收敛至 src/utils/math.ts（共享单份）
  private readonly cosineSimilarity = sharedCosineSimilarity;
}

export const contextManager = new ContextManager();
