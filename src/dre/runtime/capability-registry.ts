/**
 * Capability Registry — 能力与模型解耦
 *
 * 能力是抽象的 (ICodeReasoning, IArchitectureAnalysis)，
 * 模型是 Provider (Hermes, Claude, GPT, 本地算法)。
 *
 * 运行时根据 Latency、Cost、Confidence 动态选择 Provider。
 *
 * 例如：
 * Need: CodeReasoning
 * ↓
 * Search Providers
 * ├─ local-algorithm (cost=0, latency=100ms, confidence=0.7)
 * ├─ hermes (cost=$0.01, latency=2000ms, confidence=0.9)
 * ├─ claude (cost=$0.03, latency=3000ms, confidence=0.95)
 * ↓
 * 选择最优 (基于当前上下文)
 */

import { logger } from "../utils/logger.js";
import { eventBus } from "./event-bus.js";

// ─── Abstract Capability Contracts ─────────────────────────────────────────

/**
 * 抽象能力契约 — 与具体模型解耦
 */
export type CapabilityContract =
  | "code.reasoning"       // 代码推理
  | "code.generation"      // 代码生成
  | "code.review"          // 代码审查
  | "architecture.analysis" // 架构分析
  | "research.synthesis"   // 研究综合
  | "planning.structured"  // 结构化规划
  | "knowledge.retrieval"  // 知识检索
  | "memory.consolidation" // 记忆整合
  | "verification.factual" // 事实验证
  | "reasoning.causal"     // 因果推理
  | "reasoning.analogical" // 类比推理
  | "reasoning.deductive"  // 演绎推理
  | "generation.creative"  // 创意生成
  | "analysis.sentiment"   // 情感分析
  | "analysis.summarization" // 摘要分析

// ─── Provider Types ────────────────────────────────────────────────────────

export interface CapabilityProvider {
  id: string
  name: string
  type: "internal" | "external" | "hybrid"
  capabilities: CapabilityContract[]
  costPerCall: number       // 0 = free
  avgLatencyMs: number
  reliability: number       // 0-1
  maxConcurrency: number
  metadata: Record<string, unknown>
}

export interface Capability {
  id: string
  contract: CapabilityContract
  provider: CapabilityProvider
  name: string
  description: string
  cost: number
  latencyMs: number
  reliability: number
  constraints: string[]
  createdAt: number
  lastUsed: number
  usageCount: number
  successRate: number
}

export interface CapabilitySearchResult {
  capability: Capability
  score: number
  reason: string
}

// ─── Capability Registry ───────────────────────────────────────────────────

class CapabilityRegistryImpl {
  private providers = new Map<string, CapabilityProvider>();
  private capabilities = new Map<string, Capability>();
  private stats = { searches: 0, selections: 0, fallbacks: 0 };

  /**
   * Register a provider.
   */
  registerProvider(provider: CapabilityProvider): void {
    this.providers.set(provider.id, provider);

    // Auto-create capabilities for each contract
    for (const contract of provider.capabilities) {
      const cap: Capability = {
        id: `${provider.id}:${contract}`,
        contract,
        provider,
        name: `${contract} via ${provider.name}`,
        description: `${contract} capability provided by ${provider.name}`,
        cost: provider.costPerCall,
        latencyMs: provider.avgLatencyMs,
        reliability: provider.reliability,
        constraints: [],
        createdAt: Date.now(),
        lastUsed: 0,
        usageCount: 0,
        successRate: 1.0,
      };
      this.capabilities.set(cap.id, cap);
    }

    logger.info("[CapabilityRegistry] Registered provider", {
      id: provider.id,
      capabilities: provider.capabilities.length,
    });
  }

  /**
   * Search for capabilities that match a contract.
   */
  search(contract: CapabilityContract, opts?: {
    maxCost?: number
    maxLatency?: number
    minReliability?: number
  }): CapabilitySearchResult[] {
    this.stats.searches++;
    const results: CapabilitySearchResult[] = [];

    for (const cap of this.capabilities.values()) {
      if (cap.contract !== contract) continue;

      // Filter by options
      if (opts?.maxCost && cap.cost > opts.maxCost) continue;
      if (opts?.maxLatency && cap.latencyMs > opts.maxLatency) continue;
      if (opts?.minReliability && cap.reliability < opts.minReliability) continue;

      // Score: lower cost + lower latency + higher reliability = better
      const costScore = cap.cost === 0 ? 1.0 : Math.max(0, 1 - cap.cost / 0.1);
      const latencyScore = Math.max(0, 1 - cap.latencyMs / 10000);
      const reliabilityScore = cap.reliability;

      const score = (costScore * 0.3) + (latencyScore * 0.3) + (reliabilityScore * 0.4);

      results.push({
        capability: cap,
        score,
        reason: `${cap.provider.name} — cost=${cap.cost}, latency=${cap.latencyMs}ms, reliability=${cap.reliability}`,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Select the best capability for a contract.
   */
  select(contract: CapabilityContract, opts?: Parameters<typeof this.search>[1]): Capability | null {
    const results = this.search(contract, opts);
    if (results.length === 0) {
      this.stats.fallbacks++;
      return null;
    }

    const selected = results[0].capability;
    this.stats.selections++;

    selected.lastUsed = Date.now();
    selected.usageCount++;

    eventBus.publish({
      type: "capability.selected",
      source: "capability-registry",
      data: {
        contract,
        provider: selected.provider.name,
        cost: selected.cost,
        latency: selected.latencyMs,
      },
      priority: "normal",
    });

    return selected;
  }

  /**
   * Record the result of using a capability.
   */
  recordResult(capabilityId: string, success: boolean): void {
    const cap = this.capabilities.get(capabilityId);
    if (!cap) return;

    cap.usageCount++;
    cap.successRate = (cap.successRate * (cap.usageCount - 1) + (success ? 1 : 0)) / cap.usageCount;

    // Update provider reliability
    cap.provider.reliability = (cap.provider.reliability * 0.9) + (success ? 0.1 : 0);
  }

  /**
   * Get all providers.
   */
  getProviders(): CapabilityProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all capabilities.
   */
  list(): Capability[] {
    return Array.from(this.capabilities.values());
  }

  /**
   * Get capabilities by contract.
   */
  listByContract(contract: CapabilityContract): Capability[] {
    return Array.from(this.capabilities.values()).filter((c) => c.contract === contract);
  }

  /**
   * Get stats.
   */
  getStats(): { providers: number; capabilities: number; searches: number; selections: number; fallbacks: number } {
    return {
      providers: this.providers.size,
      capabilities: this.capabilities.size,
      ...this.stats,
    };
  }
}

export const capabilityRegistry = new CapabilityRegistryImpl();

// ─── Predefined Providers ──────────────────────────────────────────────────

/**
 * Initialize common providers and capabilities.
 */
export function initCapabilities(): void {
  // Internal algorithm provider (free, fast, lower confidence)
  capabilityRegistry.registerProvider({
    id: "internal-algorithm",
    name: "Internal Algorithm",
    type: "internal",
    capabilities: [
      "code.reasoning",
      "knowledge.retrieval",
      "memory.consolidation",
      "reasoning.deductive",
    ],
    costPerCall: 0,
    avgLatencyMs: 100,
    reliability: 0.7,
    maxConcurrency: 100,
    metadata: {},
  });

  // Local model provider (free, medium latency)
  capabilityRegistry.registerProvider({
    id: "local-model",
    name: "Local Model (Qwen3)",
    type: "internal",
    capabilities: [
      "code.reasoning",
      "code.generation",
      "code.review",
      "planning.structured",
      "reasoning.causal",
      "reasoning.analogical",
    ],
    costPerCall: 0,
    avgLatencyMs: 500,
    reliability: 0.8,
    maxConcurrency: 4,
    metadata: { model: "qwen3-1.7b" },
  });

  // Hermes provider (external, higher confidence)
  capabilityRegistry.registerProvider({
    id: "hermes",
    name: "Hermes Agent",
    type: "external",
    capabilities: [
      "architecture.analysis",
      "research.synthesis",
      "code.reasoning",
      "planning.structured",
      "verification.factual",
    ],
    costPerCall: 0.01,
    avgLatencyMs: 2000,
    reliability: 0.9,
    maxConcurrency: 2,
    metadata: { agent: "hermes" },
  });

  // Claude provider (external, highest confidence)
  capabilityRegistry.registerProvider({
    id: "claude",
    name: "Claude",
    type: "external",
    capabilities: [
      "reasoning.causal",
      "reasoning.analogical",
      "reasoning.deductive",
      "generation.creative",
      "analysis.sentiment",
      "analysis.summarization",
      "verification.factual",
    ],
    costPerCall: 0.03,
    avgLatencyMs: 3000,
    reliability: 0.95,
    maxConcurrency: 2,
    metadata: { model: "claude-3.5-sonnet" },
  });

  logger.info("[CapabilityRegistry] Initialized providers and capabilities");
}
