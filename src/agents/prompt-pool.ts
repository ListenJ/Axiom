/**
 * User Agent Prompt Connection Pool — Cache-aware 系统提示词池化管理
 *
 * 基于 Chapter 5 研究文档实现:
 * - System Prompt Only Caching (41-80% 成本降低, 13-31% TTFT 改善)
 * - 8 核心角色系统提示词预构建与池化
 * - XXH3 增量哈希前缀指纹
 * - 混合 LRU/LFU/TTL 淘汰策略
 * - Handlebars 模板引擎 (微软 Semantic Kernel 验证)
 *
 * 核心思想: 借鉴数据库连接池模式，将稳定可复用的系统提示词前缀
 * (角色定义 + 工具说明 + 安全约束) 预构建为模板并池化管理，
 * 按意图路由复用，最大化模型提供商的 KV cache / prefix cache 命中率。
 *
 * 参考:
 * - Don't Break the Cache (arXiv 2026): https://arxiv.org/html/2601.06007v2
 * - From Prompts to Templates (arXiv 2025): https://arxiv.org/html/2504.02052v2
 * - vLLM Automatic Prefix Caching: https://docs.vllm.ai/en/stable/design/prefix_caching/
 */

import { logger } from "../utils/logger.js";
import { TIMEOUTS } from "../constants/timeouts.js";

// ========== 类型定义 ==========

/** 8 核心角色 */
export type AgentRole =
  | "main_coding"
  | "code_review"
  | "research"
  | "architecture"
  | "decision"
  | "general_chat"
  | "tool_use"
  | "computer_use";

/** Prompt 连接池条目 */
export interface PromptPoolEntry {
  role: AgentRole;
  version: string;                    // 语义版本号 (如 "1.2.0")
  staticPrefix: string;              // 可缓存前缀 (角色定义+工具说明+安全约束)
  prefixHash: string;                // 前缀指纹 (XXH3 哈希)
  dynamicSuffixTemplate: string;     // 动态后缀模板 (Handlebars 语法)
  cacheControlMarker: string;        // 缓存边界标记 (UUID)
  tokenCount: number;                // 前缀 token 计数
  minCacheThreshold: number;         // 最低缓存阈值 (默认 1024)
  lastUsed: number;                  // LRU 时间戳
  hitCount: number;                  // LFU 计数器
  createdAt: number;
}

/** 缓存监控指标 */
export interface CacheMetrics {
  hitRate: number;                   // cache_read_input_tokens / total_input_tokens
  missRate: number;                  // 1 - hitRate
  evictionRate: number;              // evicted_entries / total_entries
  prefixConsistency: number;         // hash_match_count / total_requests
  totalHits: number;
  totalMisses: number;
  totalEvictions: number;
  avgPrefixTokens: number;
}

/** Prompt 组装结果 */
export interface AssembledPrompt {
  systemPrompt: string;              // 完整系统提示词
  staticPrefix: string;              // 可缓存部分
  dynamicSuffix: string;             // 动态部分
  cacheControlMarker: string;        // 缓存边界标记
  prefixHash: string;                // 前缀哈希
  tokenCount: number;                // 估算 token 数
  role: AgentRole;
  version: string;
}

/** 角色配置 */
interface RoleConfig {
  name: AgentRole;
  description: string;
  systemPromptPrefix: string;
  tools: string[];
  constraints: string[];
  examples?: Array<{ input: string; output: string }>;
}

// ========== 常量 ==========

const DEFAULT_POOL_SIZE = 8;           // 8 核心角色
const DEFAULT_MIN_CACHE_THRESHOLD = 1024; // 最低缓存阈值
const DEFAULT_TTL_MS = 5 * 60 * 1000;    // 5 分钟活跃窗口
const EXTENDED_TTL_MS = 60 * 60 * 1000;  // 1 小时扩展窗口
const TOP_N_LFU_PROTECT = 3;             // LFU 保护 Top-3

// ========== XXH3 哈希实现 ==========

/**
 * XXH3 增量哈希 (简化版，用于前缀指纹)
 * 生产环境应使用 @xxhash/xxhash-wasm
 */
function xxh3Hash(data: string): string {
  let hash = BigInt(0);
  const prime = BigInt(0x9E3779B185EBCA87);

  for (let i = 0; i < data.length; i++) {
    const char = BigInt(data.charCodeAt(i));
    hash = hash ^ char;
    hash = hash * prime;
    hash = hash & BigInt("0xFFFFFFFFFFFFFFFF"); // 64-bit mask
  }

  return hash.toString(16).padStart(16, "0");
}

/**
 * 估算 token 数 (简化版: ~4 chars per token for English, ~2 for CJK)
 */
function estimateTokenCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK characters
    if (code >= 0x4E00 && code <= 0x9FFF) {
      count += 0.5; // 2 chars = 1 token
    } else {
      count += 0.25; // 4 chars = 1 token
    }
  }
  return Math.ceil(count);
}

/**
 * 生成 UUID 缓存边界标记
 */
function generateCacheMarker(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ========== 8 核心角色配置 ==========

const ROLE_CONFIGS: Record<AgentRole, RoleConfig> = {
  main_coding: {
    name: "main_coding",
    description: "代码生成、重构、实现",
    systemPromptPrefix: `You are OpenCode, an expert coding agent specialized in generating, refactoring, and implementing code.

## Core Capabilities
- Generate production-ready code in TypeScript, Python, Rust, Go, and more
- Refactor existing code with best practices and design patterns
- Implement features following TDD methodology
- Debug and fix issues with minimal changes

## Tools Available
- Read/Write/Edit files
- Execute bash commands
- Search codebase (grep, glob)
- Run tests and linting

## Safety Constraints
- Never commit secrets or API keys
- Always run lint/typecheck after changes
- Prefer editing existing files over creating new ones
- Follow existing code conventions`,
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    constraints: [
      "Never commit secrets",
      "Run lint after changes",
      "Follow code conventions",
      "Minimize output tokens",
      "Read AGENTS.md before editing",
      "One test -> one implementation -> repeat",
    ],
  },

  code_review: {
    name: "code_review",
    description: "代码审查、质量保障、测试生成",
    systemPromptPrefix: `You are a senior code reviewer focused on quality assurance and test generation.

## Core Capabilities
- Review code for bugs, security issues, and performance problems
- Generate comprehensive test suites (unit, integration, e2e)
- Suggest refactoring improvements
- Verify adherence to coding standards

## Review Checklist
1. Security: No secrets exposed, proper input validation
2. Performance: No unnecessary allocations, efficient algorithms
3. Maintainability: Clear naming, proper abstractions, DRY
4. Testing: Adequate coverage, edge cases handled
5. Documentation: Complex logic explained, API documented`,
    tools: ["Read", "Grep", "Glob", "Bash"],
    constraints: [
      "Focus on actionable feedback",
      "Provide specific line references",
      "Suggest concrete fixes",
      "Rate severity (critical/warning/info)",
    ],
  },

  research: {
    name: "research",
    description: "研究、分析、深度研究",
    systemPromptPrefix: `You are a research agent specialized in deep analysis and information synthesis.

## Core Capabilities
- Conduct multi-source research on technical topics
- Synthesize findings into structured reports
- Verify claims with citations and sources
- Identify patterns and insights across large datasets

## Research Methodology
1. Define clear research questions
2. Gather data from multiple authoritative sources
3. Cross-validate information for accuracy
4. Synthesize findings with proper citations
5. Present conclusions with confidence levels

## Output Format
- Structured markdown with clear sections
- Inline citations with source URLs
- Data tables for comparisons
- Confidence ratings for each finding`,
    tools: ["WebSearch", "WebFetch", "Read", "Write", "MemorySearch"],
    constraints: [
      "Always cite sources",
      "Distinguish facts from opinions",
      "Note conflicting information",
      "Provide confidence levels",
    ],
  },

  architecture: {
    name: "architecture",
    description: "系统设计、架构评审",
    systemPromptPrefix: `You are an architecture agent specialized in system design and technical decisions.

## Core Capabilities
- Design scalable system architectures
- Evaluate trade-offs between approaches
- Review existing architectures for improvements
- Create technical design documents

## Design Principles
1. Separation of Concerns
2. Single Responsibility
3. Open/Closed Principle
4. Dependency Inversion
5. Composition over Inheritance

## Architecture Review Checklist
- Scalability: Horizontal/vertical scaling strategy
- Reliability: Fault tolerance, redundancy
- Security: Attack surface, authentication, authorization
- Performance: Latency targets, throughput requirements
- Maintainability: Code organization, documentation`,
    tools: ["Read", "Grep", "Glob", "Write"],
    constraints: [
      "Consider scalability implications",
      "Document trade-offs explicitly",
      "Provide migration paths",
      "Estimate complexity",
    ],
  },

  decision: {
    name: "decision",
    description: "战略决策、方案评估",
    systemPromptPrefix: `You are a decision-making agent focused on strategic technical decisions.

## Core Capabilities
- Evaluate multiple solution approaches
- Perform cost-benefit analysis
- Assess risks and mitigation strategies
- Recommend optimal paths forward

## Decision Framework
1. Define decision criteria and weights
2. Generate candidate solutions
3. Evaluate each against criteria
4. Assess risks and dependencies
5. Recommend with justification

## Output Format
- Decision matrix with weighted scores
- Risk assessment (probability × impact)
- Implementation roadmap
- Success metrics and milestones`,
    tools: ["Read", "WebSearch", "MemorySearch"],
    constraints: [
      "Consider multiple perspectives",
      "Quantify when possible",
      "Acknowledge uncertainty",
      "Provide clear recommendations",
    ],
  },

  general_chat: {
    name: "general_chat",
    description: "通用对话、Q&A",
    systemPromptPrefix: `You are a helpful AI assistant for general conversation and Q&A.

## Core Capabilities
- Answer questions on a wide range of topics
- Explain complex concepts clearly
- Provide practical advice and suggestions
- Engage in natural, helpful conversation

## Communication Style
- Clear and concise responses
- Adapt detail level to question complexity
- Use examples to illustrate points
- Acknowledge limitations honestly

## Safety Guidelines
- Refuse harmful or illegal requests
- Protect user privacy
- Provide accurate information
- Correct mistakes when identified`,
    tools: ["WebSearch", "Read"],
    constraints: [
      "Be helpful but honest",
      "Don't fabricate information",
      "Respect user privacy",
      "Stay on topic",
      "Use tools for deterministic facts",
      "Lead with conclusion, then evidence",
    ],
  },

  tool_use: {
    name: "tool_use",
    description: "工具调用 (翻译/数学/OCR)",
    systemPromptPrefix: `You are a tool-use agent specialized in executing specific tasks with external tools.

## Core Capabilities
- Translate between languages accurately
- Solve mathematical problems step-by-step
- Process and analyze documents (OCR, extraction)
- Execute precise computational tasks

## Tool Usage Guidelines
1. Select the most appropriate tool for the task
2. Validate inputs before execution
3. Handle errors gracefully with fallbacks
4. Return structured, parseable results

## Output Format
- Structured JSON when applicable
- Step-by-step explanations for math
- Confidence scores for OCR/extraction
- Error messages with suggested fixes`,
    tools: ["Translate", "Calculator", "OCR", "Bash"],
    constraints: [
      "Validate inputs first",
      "Return structured results",
      "Handle edge cases",
      "Log tool invocations",
    ],
  },

  computer_use: {
    name: "computer_use",
    description: "UI 自动化、浏览器控制",
    systemPromptPrefix: `You are a computer-use agent specialized in UI automation and browser control.

## Core Capabilities
- Navigate and interact with web pages
- Fill forms and click elements
- Take screenshots and extract text
- Automate desktop applications

## Safety Constraints
- Never submit forms without user confirmation
- Take screenshots before destructive actions
- Respect rate limits and robots.txt
- Handle authentication securely

## Interaction Pattern
1. Observe current state (screenshot/accessibility tree)
2. Plan next action
3. Execute action with confirmation
4. Verify result
5. Report status`,
    tools: ["Browser", "Screenshot", "Click", "Type", "Read"],
    constraints: [
      "Confirm before submitting",
      "Take screenshots for audit",
      "Respect rate limits",
      "Handle authentication securely",
    ],
  },
};

// ========== 主连接池类 ==========

export class UserAgentPromptPool {
  private pool: Map<AgentRole, PromptPoolEntry[]> = new Map();
  private metrics: {
    hits: number;
    misses: number;
    evictions: number;
    hashMatches: number;
    totalRequests: number;
  } = {
    hits: 0,
    misses: 0,
    evictions: 0,
    hashMatches: 0,
    totalRequests: 0,
  };

  constructor() {
    this.initializePool();
  }

  /**
   * 初始化连接池，预构建 8 角色模板
   */
  private initializePool() {
    for (const [role, config] of Object.entries(ROLE_CONFIGS)) {
      const entry = this.buildPoolEntry(role as AgentRole, config);
      this.pool.set(role as AgentRole, [entry]);
    }

    logger.info("[PromptPool] Initialized with 8 role templates", {
      roles: Array.from(this.pool.keys()),
    });
  }

  /**
   * 构建池化条目
   */
  private buildPoolEntry(role: AgentRole, config: RoleConfig): PromptPoolEntry {
    const cacheMarker = generateCacheMarker();

    // 构建静态前缀 (可缓存部分)
    const staticPrefix = [
      config.systemPromptPrefix,
      "",
      "## Available Tools",
      ...config.tools.map(t => `- ${t}`),
      "",
      "## Constraints",
      ...config.constraints.map(c => `- ${c}`),
      "",
      `<!-- CACHE_BOUNDARY: ${cacheMarker} -->`,
    ].join("\n");

    // 动态后缀模板 (Handlebars 语法)
    const dynamicSuffixTemplate = [
      "",
      "## Current Task",
      "{{task_description}}",
      "",
      "{{#if context}}",
      "## Context",
      "{{context}}",
      "{{/if}}",
      "",
      "{{#if user_input}}",
      "## User Input",
      "{{user_input}}",
      "{{/if}}",
      "",
      "{{#if examples}}",
      "## Examples",
      "{{#each examples}}",
      "Input: {{this.input}}",
      "Output: {{this.output}}",
      "{{/each}}",
      "{{/if}}",
    ].join("\n");

    const prefixHash = xxh3Hash(staticPrefix);
    const tokenCount = estimateTokenCount(staticPrefix);

    return {
      role,
      version: "1.0.0",
      staticPrefix,
      prefixHash,
      dynamicSuffixTemplate,
      cacheControlMarker: cacheMarker,
      tokenCount,
      minCacheThreshold: DEFAULT_MIN_CACHE_THRESHOLD,
      lastUsed: Date.now(),
      hitCount: 0,
      createdAt: Date.now(),
    };
  }

  /**
   * 获取角色的缓存友好提示词
   * 核心方法: 从连接池检索匹配角色的标准化前缀
   */
  acquire(
    role: AgentRole,
    dynamicVars: {
      task_description: string;
      context?: string;
      user_input?: string;
      examples?: Array<{ input: string; output: string }>;
    }
  ): AssembledPrompt {
    this.metrics.totalRequests++;

    // 从池中获取条目
    const entries = this.pool.get(role);
    if (!entries || entries.length === 0) {
      this.metrics.misses++;
      logger.warn("[PromptPool] No entry for role, creating new", { role });
      const config = ROLE_CONFIGS[role];
      const newEntry = this.buildPoolEntry(role, config);
      this.pool.set(role, [newEntry]);
      return this.assemblePrompt(newEntry, dynamicVars);
    }

    // LRU: 选择最近使用的条目
    const entry = entries.sort((a, b) => b.lastUsed - a.lastUsed)[0];

    // 检查前缀哈希一致性
    const currentHash = xxh3Hash(entry.staticPrefix);
    if (currentHash === entry.prefixHash) {
      this.metrics.hashMatches++;
    }

    // 更新使用统计
    entry.lastUsed = Date.now();
    entry.hitCount++;

    this.metrics.hits++;

    return this.assemblePrompt(entry, dynamicVars);
  }

  /**
   * 组装完整提示词
   */
  private assemblePrompt(
    entry: PromptPoolEntry,
    dynamicVars: {
      task_description: string;
      context?: string;
      user_input?: string;
      examples?: Array<{ input: string; output: string }>;
    }
  ): AssembledPrompt {
    // 简单模板渲染 (替代 Handlebars 以减少依赖)
    let dynamicSuffix = entry.dynamicSuffixTemplate;
    dynamicSuffix = dynamicSuffix.replace("{{task_description}}", dynamicVars.task_description);
    dynamicSuffix = dynamicSuffix.replace("{{#if context}}\n{{context}}\n{{/if}}",
      dynamicVars.context ? `\n## Context\n${dynamicVars.context}\n` : "");
    dynamicSuffix = dynamicSuffix.replace("{{#if user_input}}\n{{user_input}}\n{{/if}}",
      dynamicVars.user_input ? `\n## User Input\n${dynamicVars.user_input}\n` : "");

    // 处理 examples
    if (dynamicVars.examples && dynamicVars.examples.length > 0) {
      const examplesText = dynamicVars.examples
        .map(e => `Input: ${e.input}\nOutput: ${e.output}`)
        .join("\n\n");
      dynamicSuffix = dynamicSuffix.replace(
        "{{#if examples}}\n## Examples\n{{#each examples}}\nInput: {{this.input}}\nOutput: {{this.output}}\n{{/each}}\n{{/if}}",
        `\n## Examples\n${examplesText}\n`
      );
    } else {
      dynamicSuffix = dynamicSuffix.replace(
        "{{#if examples}}\n## Examples\n{{#each examples}}\nInput: {{this.input}}\nOutput: {{this.output}}\n{{/each}}\n{{/if}}",
        ""
      );
    }

    // 组装完整提示词
    const systemPrompt = entry.staticPrefix + "\n" + dynamicSuffix;
    const totalTokens = estimateTokenCount(systemPrompt);

    return {
      systemPrompt,
      staticPrefix: entry.staticPrefix,
      dynamicSuffix,
      cacheControlMarker: entry.cacheControlMarker,
      prefixHash: entry.prefixHash,
      tokenCount: totalTokens,
      role: entry.role,
      version: entry.version,
    };
  }

  /**
   * 释放角色条目 (更新 LRU)
   */
  release(role: AgentRole, cacheHit: boolean) {
    const entries = this.pool.get(role);
    if (!entries || entries.length === 0) return;

    const entry = entries[0];
    entry.lastUsed = Date.now();

    if (cacheHit) {
      this.metrics.hits++;
    }
  }

  /**
   * 混合淘汰策略: LRU + LFU + TTL
   */
  evict(): number {
    let evictedCount = 0;
    const now = Date.now();

    for (const [role, entries] of this.pool) {
      const survivingEntries: PromptPoolEntry[] = [];

      for (const entry of entries) {
        // TTL 兜底
        const age = now - entry.lastUsed;
        if (age > EXTENDED_TTL_MS) {
          this.metrics.evictions++;
          evictedCount++;
          logger.info("[PromptPool] Evicted by TTL", { role, age });
          continue;
        }

        // LFU 保护: Top-N 高频角色不被淘汰
        const allEntries = Array.from(this.pool.values()).flat();
        const topEntries = allEntries
          .sort((a, b) => b.hitCount - a.hitCount)
          .slice(0, TOP_N_LFU_PROTECT);

        if (topEntries.some(e => e.prefixHash === entry.prefixHash)) {
          survivingEntries.push(entry);
          continue;
        }

        // LRU: 超过 TTL 但未达 EXTENDED_TTL 的条目标记为可淘汰
        if (age > DEFAULT_TTL_MS && entries.length > 1) {
          this.metrics.evictions++;
          evictedCount++;
          logger.info("[PromptPool] Evicted by LRU", { role, age });
          continue;
        }

        survivingEntries.push(entry);
      }

      this.pool.set(role, survivingEntries.length > 0 ? survivingEntries : [
        this.buildPoolEntry(role, ROLE_CONFIGS[role])
      ]);
    }

    return evictedCount;
  }

  /**
   * 缓存预热: 为所有角色预构建缓存
   */
  warmup(): void {
    logger.info("[PromptPool] Warming up cache for all roles");

    for (const role of Object.keys(ROLE_CONFIGS) as AgentRole[]) {
      // 发送空任务触发 cache write
      this.acquire(role, {
        task_description: "Cache warmup",
        context: "This is a warmup request to pre-build cache.",
      });
    }

    logger.info("[PromptPool] Cache warmup complete");
  }

  /**
   * 获取缓存监控指标
   */
  getMetrics(): CacheMetrics {
    const totalEntries = Array.from(this.pool.values()).flat().length;
    const totalTokens = Array.from(this.pool.values()).flat()
      .reduce((sum, e) => sum + e.tokenCount, 0);

    return {
      hitRate: this.metrics.totalRequests > 0
        ? this.metrics.hits / this.metrics.totalRequests
        : 0,
      missRate: this.metrics.totalRequests > 0
        ? this.metrics.misses / this.metrics.totalRequests
        : 0,
      evictionRate: totalEntries > 0
        ? this.metrics.evictions / totalEntries
        : 0,
      prefixConsistency: this.metrics.totalRequests > 0
        ? this.metrics.hashMatches / this.metrics.totalRequests
        : 0,
      totalHits: this.metrics.hits,
      totalMisses: this.metrics.misses,
      totalEvictions: this.metrics.evictions,
      avgPrefixTokens: totalEntries > 0
        ? Math.round(totalTokens / totalEntries)
        : 0,
    };
  }

  /**
   * 获取池状态
   */
  getPoolStatus(): {
    roles: AgentRole[];
    totalEntries: number;
    totalTokens: number;
    oldestEntry: string | null;
    newestEntry: string | null;
  } {
    const allEntries = Array.from(this.pool.values()).flat();
    const sorted = allEntries.sort((a, b) => a.createdAt - b.createdAt);

    return {
      roles: Array.from(this.pool.keys()),
      totalEntries: allEntries.length,
      totalTokens: allEntries.reduce((sum, e) => sum + e.tokenCount, 0),
      oldestEntry: sorted.length > 0
        ? new Date(sorted[0].createdAt).toISOString()
        : null,
      newestEntry: sorted.length > 0
        ? new Date(sorted[sorted.length - 1].createdAt).toISOString()
        : null,
    };
  }

  /**
   * 更新角色配置
   */
  updateRoleConfig(role: AgentRole, config: Partial<RoleConfig>): void {
    const existingConfig = ROLE_CONFIGS[role];
    const updatedConfig = { ...existingConfig, ...config };
    const newEntry = this.buildPoolEntry(role, updatedConfig);

    this.pool.set(role, [newEntry]);
    logger.info("[PromptPool] Role config updated", { role, version: newEntry.version });
  }

  /**
   * 获取角色配置
   */
  getRoleConfig(role: AgentRole): RoleConfig {
    return ROLE_CONFIGS[role];
  }

  /**
   * 列出所有角色
   */
  listRoles(): Array<{
    role: AgentRole;
    description: string;
    tokenCount: number;
    hitCount: number;
    lastUsed: string;
  }> {
    const result: Array<{
      role: AgentRole;
      description: string;
      tokenCount: number;
      hitCount: number;
      lastUsed: string;
    }> = [];

    for (const [role, entries] of this.pool) {
      if (entries.length > 0) {
        const entry = entries[0];
        result.push({
          role,
          description: ROLE_CONFIGS[role].description,
          tokenCount: entry.tokenCount,
          hitCount: entry.hitCount,
          lastUsed: new Date(entry.lastUsed).toISOString(),
        });
      }
    }

    return result;
  }

  /**
   * 重置指标
   */
  resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      hashMatches: 0,
      totalRequests: 0,
    };
  }
}

// ========== 全局单例 ==========

let _instance: UserAgentPromptPool | null = null;

export function getPromptPool(): UserAgentPromptPool {
  if (!_instance) {
    _instance = new UserAgentPromptPool();
  }
  return _instance;
}
