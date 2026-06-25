/**
 * Smart Memory Gate — 控制何时写入记忆库
 * 不是每一次 Agent 响应都写入 Vault，只有满足显著性标准时才更新
 *
 * 设计原则：
 * 1. 防 AI 幻觉：只有高置信度的内容才写入
 * 2. 防覆盖：相同内容不重复写入
 * 3. 防噪音：低价值内容（闲聊、错误、重试）不写入
 * 4. 防膨胀：控制写入频率，避免记忆库无限增长
 */

import { logger } from "../utils/logger.js";

/** 写入决策结果 */
export interface WriteDecision {
  shouldWrite: boolean;
  reason: string;
  confidence: number;  // 0-1
  category: "high-value" | "medium-value" | "low-value" | "skip";
}

/** 显著性评估上下文 */
export interface SignificanceContext {
  /** Agent 角色/类型 */
  agentRole?: string;
  /** 任务类型 */
  taskType?: "coding" | "research" | "writing" | "planning" | "chat";
  /** 响应长度（字符） */
  responseLength: number;
  /** 是否包含代码 */
  hasCode: boolean;
  /** 是否包含引用/来源 */
  hasCitations: boolean;
  /** 是否包含错误/警告 */
  hasErrors: boolean;
  /** 响应耗时（ms） */
  responseTimeMs?: number;
  /** 用户消息长度 */
  userMessageLength: number;
  /** 是否是对话的第一轮 */
  isFirstTurn: boolean;
  /** 是否包含结构化数据（表格、列表） */
  hasStructuredData: boolean;
  /** 是否包含技术术语 */
  hasTechnicalTerms: boolean;
}

/** 去重缓存条目 */
interface CacheEntry {
  contentHash: string;
  timestamp: number;
  path: string;
}

/** 写入频率限制 */
interface RateLimitState {
  /** 最近 N 分钟内的写入次数 */
  recentWrites: number[];
  /** 每小时最大写入次数 */
  maxWritesPerHour: number;
  /** 每天最大写入次数 */
  maxWritesPerDay: number;
}

/**
 * Smart Memory Gate — 决策是否写入记忆库
 */
export class MemoryGate {
  private writeCache: Map<string, CacheEntry> = new Map();
  private rateLimit: RateLimitState;
  private config: {
    minConfidence: number;
    minResponseLength: number;
    minUserMessageLength: number;
    deduplicationWindowMs: number;
    maxWritesPerHour: number;
    maxWritesPerDay: number;
    /** 高价值任务类型 */
    highValueTasks: string[];
    /** 低价值任务类型（不写入） */
    lowValueTasks: string[];
  };

  constructor(opts?: Partial<typeof this.config>) {
    this.config = {
      minConfidence: 0.6,
      minResponseLength: 100,
      minUserMessageLength: 10,
      deduplicationWindowMs: 3_600_000, // 1 hour
      maxWritesPerHour: 20,
      maxWritesPerDay: 100,
      highValueTasks: ["coding", "research", "writing"],
      lowValueTasks: ["chat"],
      ...opts,
    };

    this.rateLimit = {
      recentWrites: [],
      maxWritesPerHour: this.config.maxWritesPerHour,
      maxWritesPerDay: this.config.maxWritesPerDay,
    };
  }

  /**
   * 评估是否应该写入记忆库
   */
  shouldWrite(
    response: string,
    userMessage: string,
    ctx: SignificanceContext,
  ): WriteDecision {
    // 1. 基础检查：响应太短 → 跳过
    if (response.length < this.config.minResponseLength) {
      return {
        shouldWrite: false,
        reason: `Response too short (${response.length} < ${this.config.minResponseLength})`,
        confidence: 0,
        category: "skip",
      };
    }

    // 2. 基础检查：用户消息太短（可能是闲聊）
    if (userMessage.length < this.config.minUserMessageLength) {
      return {
        shouldWrite: false,
        reason: "User message too short (likely casual chat)",
        confidence: 0,
        category: "skip",
      };
    }

    // 3. 错误响应 → 不写入
    if (ctx.hasErrors) {
      return {
        shouldWrite: false,
        reason: "Response contains errors — not worth persisting",
        confidence: 0,
        category: "skip",
      };
    }

    // 4. 去重检查：相同内容近期已写入 → 跳过
    const contentHash = this.hashContent(response);
    const cached = this.writeCache.get(contentHash);
    if (cached && Date.now() - cached.timestamp < this.config.deduplicationWindowMs) {
      return {
        shouldWrite: false,
        reason: `Duplicate content (last written ${Math.round((Date.now() - cached.timestamp) / 60000)}min ago)`,
        confidence: 0,
        category: "skip",
      };
    }

    // 5. 频率限制检查
    if (this.isRateLimited()) {
      return {
        shouldWrite: false,
        reason: `Rate limit exceeded (${this.rateLimit.recentWrites.length} writes in last hour)`,
        confidence: 0,
        category: "skip",
      };
    }

    // 6. 计算置信度
    let confidence = 0;
    const reasons: string[] = [];

    // 任务类型加权
    if (ctx.taskType && this.config.highValueTasks.includes(ctx.taskType)) {
      confidence += 0.3;
      reasons.push(`High-value task: ${ctx.taskType}`);
    } else if (ctx.taskType && this.config.lowValueTasks.includes(ctx.taskType)) {
      confidence -= 0.2;
      reasons.push(`Low-value task: ${ctx.taskType}`);
    }

    // 代码内容加分
    if (ctx.hasCode) {
      confidence += 0.2;
      reasons.push("Contains code");
    }

    // 引用/来源加分
    if (ctx.hasCitations) {
      confidence += 0.15;
      reasons.push("Contains citations");
    }

    // 结构化数据加分
    if (ctx.hasStructuredData) {
      confidence += 0.1;
      reasons.push("Contains structured data");
    }

    // 技术术语加分
    if (ctx.hasTechnicalTerms) {
      confidence += 0.1;
      reasons.push("Contains technical terms");
    }

    // 响应长度加分（适度）
    if (response.length > 500) {
      confidence += 0.1;
      reasons.push("Substantial response");
    }
    if (response.length > 2000) {
      confidence += 0.05;
      reasons.push("Very detailed response");
    }

    // 首轮对话加分
    if (ctx.isFirstTurn) {
      confidence += 0.05;
      reasons.push("First turn of conversation");
    }

    // 长用户消息加分（用户投入了精力）
    if (ctx.userMessageLength > 200) {
      confidence += 0.05;
      reasons.push("Detailed user query");
    }

    // 限制置信度范围
    confidence = Math.max(0, Math.min(1, confidence));

    // 7. 最终决策
    if (confidence >= this.config.minConfidence) {
      const category = confidence >= 0.8 ? "high-value" : "medium-value";
      return {
        shouldWrite: true,
        reason: reasons.join("; "),
        confidence,
        category,
      };
    }

    return {
      shouldWrite: false,
      reason: `Confidence too low (${confidence.toFixed(2)} < ${this.config.minConfidence}): ${reasons.join("; ")}`,
      confidence,
      category: "low-value",
    };
  }

  /**
   * 记录一次写入（用于频率限制和去重）
   */
  recordWrite(contentHash: string, path: string): void {
    const now = Date.now();

    // 更新去重缓存
    this.writeCache.set(contentHash, { contentHash, timestamp: now, path });

    // 更新频率限制
    this.rateLimit.recentWrites.push(now);

    // 清理过期记录（1小时前）
    const oneHourAgo = now - 3_600_000;
    this.rateLimit.recentWrites = this.rateLimit.recentWrites.filter(t => t > oneHourAgo);

    // 清理过期缓存
    for (const [key, entry] of this.writeCache) {
      if (now - entry.timestamp > this.config.deduplicationWindowMs) {
        this.writeCache.delete(key);
      }
    }

    logger.debug("[MemoryGate] Write recorded", {
      path,
      recentWrites: this.rateLimit.recentWrites.length,
    });
  }

  /**
   * 获取当前写入统计
   */
  stats(): {
    recentWrites: number;
    maxWritesPerHour: number;
    maxWritesPerDay: number;
    cacheSize: number;
  } {
    const now = Date.now();
    const oneDayAgo = now - 86_400_000;
    return {
      recentWrites: this.rateLimit.recentWrites.filter(t => t > oneDayAgo).length,
      maxWritesPerHour: this.rateLimit.maxWritesPerHour,
      maxWritesPerDay: this.rateLimit.maxWritesPerDay,
      cacheSize: this.writeCache.size,
    };
  }

  private isRateLimited(): boolean {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const recentCount = this.rateLimit.recentWrites.filter(t => t > oneHourAgo).length;
    return recentCount >= this.rateLimit.maxWritesPerHour;
  }

  private hashContent(content: string): string {
    // Simple hash for dedup — not cryptographic
    let hash = 0;
    const str = content.slice(0, 1000); // Only hash first 1000 chars for speed
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return String(hash);
  }
}

/** 全局单例 */
let _gate: MemoryGate | null = null;

export function getMemoryGate(): MemoryGate {
  if (!_gate) {
    _gate = new MemoryGate();
  }
  return _gate;
}
