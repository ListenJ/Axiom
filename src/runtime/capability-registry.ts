/**
 * Capability Registry — 用能力而非 Agent 进行调度
 *
 * Runtime 不再调用 Agent。
 * Runtime 调用 Capability。
 *
 * 例如：
 * Need: Planning
 * ↓
 * Search Capability
 * ├─ Hermes (external)
 * ├─ Claude (external)
 * ├─ Planner (internal)
 * └─ 本地算法
 * ↓
 * 选择最优
 */

import { logger } from "../utils/logger.js";
import { eventBus, worldState } from "./kernel.js";
import { atomStore } from "./atom-engine.js";

// ─── Capability Types ──────────────────────────────────────────────────────

export type CapabilityProvider = "internal" | "hermes" | "claude" | "gpt" | "opencode" | "local-model";

export interface Capability {
  id: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  provider: CapabilityProvider
  cost: number          // 0 = free, higher = more expensive
  latencyMs: number     // expected latency in ms
  reliability: number   // 0-1, how reliable this capability is
  constraints: string[] // constraint IDs that must be satisfied
  metadata: Record<string, unknown>
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
  private capabilities = new Map<string, Capability>();
  private stats = { searches: 0, selections: 0, fallbacks: 0 };

  /**
   * Register a capability.
   */
  register(cap: Omit<Capability, "id" | "createdAt" | "lastUsed" | "usageCount" | "successRate">): Capability {
    const id = `cap_${cap.name}_${cap.provider}_${Date.now()}`;
    const full: Capability = {
      ...cap,
      id,
      createdAt: Date.now(),
      lastUsed: 0,
      usageCount: 0,
      successRate: 1.0,
    };

    this.capabilities.set(id, full);

    // Store as atom
    atomStore.create("concept", `Capability: ${cap.name}`, {
      source: "capability-registry",
      metadata: {
        provider: cap.provider,
        cost: cap.cost,
        latency: cap.latencyMs,
        reliability: cap.reliability,
      },
    });

    eventBus.publish({
      type: "capability.registered",
      source: "capability-registry",
      data: { id, name: cap.name, provider: cap.provider },
      priority: "low",
    });

    return full;
  }

  /**
   * Search for capabilities that match a need.
   */
  search(need: string, opts?: {
    maxCost?: number
    maxLatency?: number
    minReliability?: number
    provider?: CapabilityProvider
  }): CapabilitySearchResult[] {
    this.stats.searches++;
    const results: CapabilitySearchResult[] = [];
    const lowerNeed = need.toLowerCase();

    for (const cap of this.capabilities.values()) {
      // Filter by options
      if (opts?.maxCost && cap.cost > opts.maxCost) continue;
      if (opts?.maxLatency && cap.latencyMs > opts.maxLatency) continue;
      if (opts?.minReliability && cap.reliability < opts.minReliability) continue;
      if (opts?.provider && cap.provider !== opts.provider) continue;

      // Score by relevance
      let score = 0;
      if (cap.name.toLowerCase().includes(lowerNeed)) score += 0.5;
      if (cap.description.toLowerCase().includes(lowerNeed)) score += 0.3;

      // Bonus for low cost
      score += (1 - Math.min(cap.cost, 1)) * 0.1;

      // Bonus for high reliability
      score += cap.reliability * 0.1;

      if (score > 0) {
        results.push({
          capability: cap,
          score,
          reason: `${cap.name} (${cap.provider}) — cost=${cap.cost}, latency=${cap.latencyMs}ms`,
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Select the best capability for a need.
   */
  select(need: string, opts?: Parameters<typeof this.search>[1]): Capability | null {
    const results = this.search(need, opts);
    if (results.length === 0) {
      this.stats.fallbacks++;
      return null;
    }

    const selected = results[0].capability;
    this.stats.selections++;

    // Update usage
    selected.lastUsed = Date.now();
    selected.usageCount++;

    eventBus.publish({
      type: "capability.selected",
      source: "capability-registry",
      data: { id: selected.id, name: selected.name, provider: selected.provider, need },
      priority: "normal",
    });

    return selected;
  }

  /**
   * Record the result of using a capability.
   */
  recordResult(id: string, success: boolean): void {
    const cap = this.capabilities.get(id);
    if (!cap) return;

    cap.usageCount++;
    cap.successRate = (cap.successRate * (cap.usageCount - 1) + (success ? 1 : 0)) / cap.usageCount;
  }

  /**
   * Get all capabilities.
   */
  list(): Capability[] {
    return Array.from(this.capabilities.values());
  }

  /**
   * Get capabilities by provider.
   */
  listByProvider(provider: CapabilityProvider): Capability[] {
    return Array.from(this.capabilities.values()).filter((c) => c.provider === provider);
  }

  /**
   * Get a capability by ID.
   */
  get(id: string): Capability | undefined {
    return this.capabilities.get(id);
  }

  /**
   * Remove a capability.
   */
  remove(id: string): boolean {
    return this.capabilities.delete(id);
  }

  /**
   * Get stats.
   */
  getStats(): { total: number; searches: number; selections: number; fallbacks: number } {
    return { total: this.capabilities.size, ...this.stats };
  }
}

export const capabilityRegistry = new CapabilityRegistryImpl();

// ─── Predefined Capabilities ───────────────────────────────────────────────

/**
 * Initialize common capabilities.
 */
export function initCapabilities(): void {
  // Internal capabilities (free, fast)
  capabilityRegistry.register({
    name: "code_analyze",
    description: "Analyze code structure, complexity, and dependencies",
    inputSchema: { file: "string" },
    outputSchema: { analysis: "object" },
    provider: "internal",
    cost: 0,
    latencyMs: 100,
    reliability: 0.95,
    constraints: [],
    metadata: {},
  });

  capabilityRegistry.register({
    name: "code_diagnostics",
    description: "Run TypeScript/ESLint diagnostics",
    inputSchema: { file: "string" },
    outputSchema: { diagnostics: "array" },
    provider: "internal",
    cost: 0,
    latencyMs: 200,
    reliability: 0.9,
    constraints: ["constraint_code_diagnostics_typescript"],
    metadata: {},
  });

  capabilityRegistry.register({
    name: "memory_search",
    description: "Search the knowledge vault",
    inputSchema: { query: "string" },
    outputSchema: { results: "array" },
    provider: "internal",
    cost: 0,
    latencyMs: 50,
    reliability: 0.95,
    constraints: [],
    metadata: {},
  });

  capabilityRegistry.register({
    name: "planning",
    description: "Create execution plans using deterministic pipeline",
    inputSchema: { input: "string" },
    outputSchema: { plan: "object" },
    provider: "internal",
    cost: 0,
    latencyMs: 500,
    reliability: 0.85,
    constraints: [],
    metadata: {},
  });

  capabilityRegistry.register({
    name: "constraint_solving",
    description: "Solve constraints for a set of entities",
    inputSchema: { entities: "array" },
    outputSchema: { satisfied: "boolean", violations: "array" },
    provider: "internal",
    cost: 0,
    latencyMs: 10,
    reliability: 1.0,
    constraints: [],
    metadata: {},
  });

  // External capabilities (cost, latency)
  capabilityRegistry.register({
    name: "hermes_planning",
    description: "Advanced planning using Hermes agent",
    inputSchema: { task: "string" },
    outputSchema: { plan: "object" },
    provider: "hermes",
    cost: 0.01,
    latencyMs: 2000,
    reliability: 0.9,
    constraints: ["constraint_hermes_installation"],
    metadata: {},
  });

  capabilityRegistry.register({
    name: "claude_reasoning",
    description: "Complex reasoning using Claude",
    inputSchema: { prompt: "string" },
    outputSchema: { response: "string" },
    provider: "claude",
    cost: 0.03,
    latencyMs: 3000,
    reliability: 0.95,
    constraints: [],
    metadata: {},
  });

  capabilityRegistry.register({
    name: "opencode_coding",
    description: "Code generation using OpenCode",
    inputSchema: { task: "string" },
    outputSchema: { code: "string" },
    provider: "opencode",
    cost: 0,
    latencyMs: 5000,
    reliability: 0.85,
    constraints: ["constraint_opencode_installation"],
    metadata: {},
  });

  logger.info("[CapabilityRegistry] Initialized predefined capabilities");
}
