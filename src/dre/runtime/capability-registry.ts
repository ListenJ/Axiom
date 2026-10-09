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

import { logger } from "../../utils/logger.js";
import { eventBus } from "./event-bus.js";
import { HIGH_RISK_CAPABILITIES, type Capability as PermissionCapability } from "../../utils/permissions.js";
import { runIsolated } from "./capability-isolation.js";

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

/** 自扩展归属：外围可运行时热加；`kernel-proposal` 只能"提案"，不得自动注册 */
export type CapabilityPlacement = "periphery" | "kernel-proposal";
/** 隔离级别：含高危能力的 provider 必须 worker/sandbox，不得 in-process */
export type CapabilityIsolation = "in-process" | "worker" | "sandbox";

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
  // ── 自扩展元数据（内置 provider 可缺省；动态注册 provider 必须显式声明）──
  /** 归属：外围可热加；kernel-proposal 只可提案 */
  placement?: CapabilityPlacement;
  /** 隔离级别 */
  isolation?: CapabilityIsolation;
  /** 副作用能力声明（唯一权威词表见 utils/permissions.ts；动态注册必须显式声明） */
  sideEffects?: PermissionCapability[];
  /** 来源：内置 或 运行时自扩展 */
  source?: "builtin" | "dynamic";
  // ── 可执行体（须与 isolation 匹配；动态注册必须提供对应项，否则拒绝）──
  /** isolation="in-process" 时的进程内实现 */
  invoke?: (req: Record<string, unknown>) => Promise<unknown>;
  /** isolation="worker" 时的子进程入口模块 */
  worker?: { entry: string; args?: string[] };
  /** isolation="sandbox" 时的沙箱命令 */
  sandbox?: { command: string; args?: string[] };
}

/** 能力缺口（观测产物；**只报告/提案，不自动注册**） */
export interface CapabilityGap {
  contract: CapabilityContract;
  kind: "no-provider" | "low-success";
  evidence: { misses?: number; usageCount?: number; successRate?: number };
}

/** 内核能力提案（不注册、不执行；内核变更走门禁） */
export interface KernelCapabilityProposal {
  id: string;
  contract: CapabilityContract;
  rationale: string;
  estimate?: Record<string, unknown>;
  proposedAt: number;
  status: "pending";
}

/** 自扩展注册被拒（fail-closed）时抛出 */
export class CapabilityRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRegistrationError";
  }
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
  /** Reverse index: contract → capability ids (avoids O(n) scan in search()) */
  private capabilitiesByContract = new Map<CapabilityContract, Set<string>>();
  private stats = { searches: 0, selections: 0, fallbacks: 0 };
  private kernelProposals: KernelCapabilityProposal[] = [];
  /** 观测：契约被检索但无可用 provider 的次数（缺口信号） */
  private searchMisses = new Map<CapabilityContract, number>();

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

      // Update contract index
      if (!this.capabilitiesByContract.has(contract)) {
        this.capabilitiesByContract.set(contract, new Set());
      }
      this.capabilitiesByContract.get(contract)!.add(cap.id);
    }

    logger.info("[CapabilityRegistry] Registered provider", {
      id: provider.id,
      capabilities: provider.capabilities.length,
    });
  }

  /**
   * 注册**自扩展** provider（运行时按场景新增的能力）。**fail-closed**：
   *  - `placement="kernel-proposal"` → 拒绝（内核只能经 proposeCapability 提案，不得自动落核）；
   *  - 未声明 `sideEffects` → 拒绝（无声明即不可信）；
   *  - 命中高危能力（`HIGH_RISK_CAPABILITIES`）→ 须显式授权，且须 worker/sandbox 隔离。
   */
  registerDynamicProvider(provider: CapabilityProvider, ctx?: { authorized?: boolean }): void {
    if (provider.placement === "kernel-proposal") {
      throw new CapabilityRegistrationError(
        `provider '${provider.id}' 归属内核：不得自动注册，请走 proposeCapability 内核门禁`,
      );
    }
    const effects = provider.sideEffects;
    if (!Array.isArray(effects) || effects.length === 0) {
      throw new CapabilityRegistrationError(`provider '${provider.id}' 未声明 sideEffects（无声明即拒绝）`);
    }
    const highRisk = effects.filter((c) => HIGH_RISK_CAPABILITIES.has(c));
    if (highRisk.length > 0) {
      if (ctx?.authorized !== true) {
        throw new CapabilityRegistrationError(
          `provider '${provider.id}' 声明高危能力 [${highRisk.join(", ")}] 但未获授权，拒绝注册`,
        );
      }
      if (provider.isolation !== "worker" && provider.isolation !== "sandbox") {
        throw new CapabilityRegistrationError(
          `provider '${provider.id}' 含高危能力，须 worker/sandbox 隔离，不能 in-process`,
        );
      }
    }
    // 可执行体须与声明的隔离匹配（fail-closed：声明了隔离就必须真有对应执行体）
    const iso = provider.isolation ?? "in-process";
    if (iso === "worker" && !provider.worker?.entry) {
      throw new CapabilityRegistrationError(`provider '${provider.id}' 声明 worker 隔离但缺 worker.entry（无可执行体即拒绝）`);
    }
    if (iso === "sandbox" && !provider.sandbox?.command) {
      throw new CapabilityRegistrationError(`provider '${provider.id}' 声明 sandbox 隔离但缺 sandbox.command（无可执行体即拒绝）`);
    }
    if (iso === "in-process" && typeof provider.invoke !== "function") {
      throw new CapabilityRegistrationError(`provider '${provider.id}' 声明 in-process 隔离但缺 invoke（无可执行体即拒绝）`);
    }

    this.registerProvider({ ...provider, source: "dynamic" });
  }

  /**
   * 按契约选择最佳 provider 并**按其隔离声明执行**（fail-closed，不退回 in-process），
   * 随后记录结果（成功/失败）。
   */
  async invokeCapability(
    contract: CapabilityContract,
    req: Record<string, unknown> = {},
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    const cap = this.select(contract);
    if (!cap) throw new CapabilityRegistrationError(`无 provider 可服务契约 '${contract}'`);
    let ok = false;
    try {
      const result = await runIsolated(cap.provider, req, opts);
      ok = true;
      return result;
    } finally {
      this.recordResult(cap.id, ok);
    }
  }

  /**
   * 记录一条**内核能力提案**（不注册、不执行）。内核变更须走门禁，运行时无权自动落核。
   */
  proposeCapability(input: {
    contract: CapabilityContract;
    rationale: string;
    estimate?: Record<string, unknown>;
  }): KernelCapabilityProposal {
    const proposal: KernelCapabilityProposal = {
      id: `kprop-${Date.now()}-${this.kernelProposals.length + 1}`,
      contract: input.contract,
      rationale: input.rationale,
      estimate: input.estimate,
      proposedAt: Date.now(),
      status: "pending",
    };
    this.kernelProposals.push(proposal);
    eventBus.publish({
      type: "capability.kernel_proposed",
      source: "capability-registry",
      data: { id: proposal.id, contract: proposal.contract },
      priority: "normal",
    });
    logger.info("[CapabilityRegistry] Kernel capability proposed", { id: proposal.id, contract: proposal.contract });
    return proposal;
  }

  /** 列出所有内核能力提案（只读快照） */
  listKernelProposals(): KernelCapabilityProposal[] {
    return [...this.kernelProposals];
  }

  private noteSearchMiss(contract: CapabilityContract): void {
    this.searchMisses.set(contract, (this.searchMisses.get(contract) ?? 0) + 1);
  }

  /**
   * 分析**能力缺口**（观测 → 缺口），供上层决定"外围热加"或"内核提案"。
   * **只报告**：不注册、不改动任何 provider。
   *  - `no-provider`：该契约被检索过但没有 provider（`misses` 次数）；
   *  - `low-success`：该契约有 provider 且用量达阈值，但最佳成功率低于阈值。
   */
  analyzeGaps(opts?: { minUsageForLowSuccess?: number; minSuccessRate?: number }): CapabilityGap[] {
    const minUsage = opts?.minUsageForLowSuccess ?? 5;
    const minRate = opts?.minSuccessRate ?? 0.5;
    const gaps: CapabilityGap[] = [];

    for (const [contract, misses] of this.searchMisses) {
      if (misses > 0) gaps.push({ contract, kind: "no-provider", evidence: { misses } });
    }

    const byContract = new Map<CapabilityContract, Capability[]>();
    for (const cap of this.capabilities.values()) {
      const list = byContract.get(cap.contract) ?? [];
      list.push(cap);
      byContract.set(cap.contract, list);
    }
    for (const [contract, caps] of byContract) {
      const totalUsage = caps.reduce((a, c) => a + c.usageCount, 0);
      const bestRate = caps.reduce((a, c) => Math.max(a, c.successRate), 0);
      if (totalUsage >= minUsage && bestRate < minRate) {
        gaps.push({ contract, kind: "low-success", evidence: { usageCount: totalUsage, successRate: bestRate } });
      }
    }
    return gaps;
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

    // Use contract index instead of scanning all capabilities (O(n) → O(k)).
    const ids = this.capabilitiesByContract.get(contract);
    if (!ids) {
      this.noteSearchMiss(contract);
      return results;
    }

    for (const capId of ids) {
      const cap = this.capabilities.get(capId);
      if (!cap) continue;

      // Filter by options — use `!== undefined` instead of truthiness so that
      // maxCost=0 (audit mode: only free capabilities) is respected, not skipped.
      if (opts?.maxCost !== undefined && cap.cost > opts.maxCost) continue;
      if (opts?.maxLatency !== undefined && cap.latencyMs > opts.maxLatency) continue;
      if (opts?.minReliability !== undefined && cap.reliability < opts.minReliability) continue;

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
    if (results.length === 0) this.noteSearchMiss(contract);
    return results;
  }

  /**
   * Select the best capability for a contract.
   * Note: selection marks lastUsed + bumps stats only; usageCount/successRate
   * are updated by recordResult() after the call resolves. This avoids
   * double-counting usage when a selection is made but the call is not yet
   * executed (or fails before invocation).
   */
  select(contract: CapabilityContract, opts?: Parameters<typeof this.search>[1]): Capability | null {
    const results = this.search(contract, opts);
    if (results.length === 0) {
      this.stats.fallbacks++;
      logger.warn("[CapabilityRegistry] No provider available for contract", { contract });
      return null;
    }

    const selected = results[0].capability;
    this.stats.selections++;

    selected.lastUsed = Date.now();

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
   * This is the single source of truth for usageCount/successRate — select()
   * does NOT increment usageCount to avoid counting selections that never
   * actually invoke the provider.
   */
  recordResult(capabilityId: string, success: boolean): void {
    const cap = this.capabilities.get(capabilityId);
    if (!cap) return;

    cap.usageCount++;
    cap.successRate = (cap.successRate * (cap.usageCount - 1) + (success ? 1 : 0)) / cap.usageCount;

    // Update provider reliability with exponential moving average
    cap.provider.reliability = (cap.provider.reliability * 0.9) + (success ? 0.1 : 0);
  }

  /**
   * Unregister a provider and all its capabilities.
   */
  unregisterProvider(providerId: string): boolean {
    const provider = this.providers.get(providerId);
    if (!provider) return false;

    // Remove all capabilities belonging to this provider
    for (const capId of [...this.capabilities.keys()]) {
      if (capId.startsWith(`${providerId}:`)) {
        const cap = this.capabilities.get(capId);
        if (cap) {
          const set = this.capabilitiesByContract.get(cap.contract);
          if (set) {
            set.delete(capId);
            if (set.size === 0) this.capabilitiesByContract.delete(cap.contract);
          }
        }
        this.capabilities.delete(capId);
      }
    }

    this.providers.delete(providerId);

    eventBus.publish({
      type: "capability.provider_unregistered",
      source: "capability-registry",
      data: { providerId },
      priority: "normal",
    });

    logger.info("[CapabilityRegistry] Unregistered provider", {
      providerId,
      capabilities: provider.capabilities.length,
    });
    return true;
  }

  /**
   * Get a capability by ID.
   */
  getCapability(capabilityId: string): Capability | undefined {
    return this.capabilities.get(capabilityId);
  }

  /**
   * Reset all registry state. Useful for tests.
   */
  reset(): void {
    this.providers.clear();
    this.capabilities.clear();
    this.capabilitiesByContract.clear();
    this.kernelProposals = [];
    this.searchMisses.clear();
    this.stats = { searches: 0, selections: 0, fallbacks: 0 };
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
    const ids = this.capabilitiesByContract.get(contract);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.capabilities.get(id))
      .filter((c): c is Capability => c !== undefined);
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
