/**
 * Context Engine — Unified Context Building
 *
 * Instead of each module building its own context, there is ONE place
 * that builds the complete context for any request.
 *
 * Context = World State + Memory + KG + History + Goal + Workspace
 *
 * All modules READ context from here. Nobody builds their own.
 */

import { worldState } from "./world-state.js";
import { atomStore } from "./atom-engine.js";
import { knowledgeNetwork } from "./knowledge-network.js";

// ─── Context Types ─────────────────────────────────────────────────────────

export interface RuntimeContext {
  /** Current user input */
  input: string
  /** Conversation history */
  history: Array<{ role: string; content: string }>
  /** Relevant atoms from knowledge base */
  atoms: Array<{ id: string; kind: string; content: string; confidence: string }>
  /** Relevant entities */
  entities: Array<{ id: string; name: string; state: unknown }>
  /** Relevant memories (from memory engine / consciousness stream) */
  memories: Array<{ id: string; content: string; confidence: number }>
  /** Relevant knowledge nodes (from knowledge network) */
  knowledgeNodes: Array<{ id: string; kind: string; content: string; confidence: number }>
  /** Current workspace state */
  workspace: {
    projectPath?: string
    openFiles?: string[]
    recentCommands?: string[]
  }
  /** Current goals */
  goals: Array<{ id: string; description: string; status: string }>
  /** Current beliefs (from reflection) */
  beliefs: Array<{ statement: string; confidence: number }>
  /** Available tools */
  tools: Array<{ name: string; description: string }>
  /** System state */
  system: {
    uptime: number
    tickNumber: number
    stateVersion: number
  }
  /** Token budget */
  tokenBudget: {
    available: number
    used: number
    max: number
  }
}

export interface BuildOptions {
  /** Max atoms to retrieve (default 20) */
  atomBudget?: number
  /** Max entities to retrieve (default 10) */
  entityBudget?: number
  /** Max knowledge nodes to retrieve (default 5) */
  knowledgeBudget?: number
}

/** State-dependent context parts (cacheable — don't depend on input) */
interface StateContext {
  entities: RuntimeContext["entities"]
  workspace: RuntimeContext["workspace"]
  goals: RuntimeContext["goals"]
  beliefs: RuntimeContext["beliefs"]
  tools: RuntimeContext["tools"]
  system: RuntimeContext["system"]
  tokenBudget: RuntimeContext["tokenBudget"]
}

/** Token estimate result */
export interface TokenEstimate {
  estimated: number
  budget: number
  remaining: number
  overBudget: boolean
}

// ─── Context Builder ───────────────────────────────────────────────────────

class ContextEngineImpl {
  /** Cache only state-dependent parts (input-independent) */
  private stateCache: StateContext | null = null;
  private cacheTime = 0;
  private cacheTtl = 5000; // 5 seconds

  /** Injected memories (from ConsciousnessStream or external source) */
  private injectedMemories: RuntimeContext["memories"] = [];

  /** Build counter for stats */
  private buildCount = 0;
  private cacheHits = 0;
  private cacheMisses = 0;

  /**
   * Build a complete context for a request.
   * State-dependent parts are cached (5s TTL); input-dependent parts are always fresh.
   */
  build(
    input: string,
    history: Array<{ role: string; content: string }> = [],
    opts?: BuildOptions,
  ): RuntimeContext {
    const state = this.getOrCreateStateCache();
    const inputDeps = this.buildInputDependent(input, opts);

    this.buildCount++;
    return {
      input,
      history,
      atoms: inputDeps.atoms,
      knowledgeNodes: inputDeps.knowledgeNodes,
      memories: this.injectedMemories,
      entities: state.entities,
      workspace: state.workspace,
      goals: state.goals,
      beliefs: state.beliefs,
      tools: state.tools,
      system: state.system,
      tokenBudget: state.tokenBudget,
    };
  }

  /**
   * Build a complete context without consulting or updating the cache.
   * Use this when freshness is required (e.g. after state mutations).
   */
  buildRaw(
    input: string,
    history: Array<{ role: string; content: string }> = [],
    opts?: BuildOptions,
  ): RuntimeContext {
    const state = this.buildStateContext();
    const inputDeps = this.buildInputDependent(input, opts);

    this.buildCount++;
    return {
      input,
      history,
      atoms: inputDeps.atoms,
      knowledgeNodes: inputDeps.knowledgeNodes,
      memories: this.injectedMemories,
      entities: state.entities,
      workspace: state.workspace,
      goals: state.goals,
      beliefs: state.beliefs,
      tools: state.tools,
      system: state.system,
      tokenBudget: state.tokenBudget,
    };
  }

  /**
   * Inject memories from external source (e.g. ConsciousnessStream).
   * These will be included in all subsequent build() calls.
   */
  setMemories(memories: RuntimeContext["memories"]): void {
    this.injectedMemories = memories;
  }

  /**
   * Get or create cached state context.
   */
  private getOrCreateStateCache(): StateContext {
    if (this.stateCache && Date.now() - this.cacheTime < this.cacheTtl) {
      this.cacheHits++;
      return this.stateCache;
    }
    this.cacheMisses++;
    this.stateCache = this.buildStateContext();
    this.cacheTime = Date.now();
    return this.stateCache;
  }

  /**
   * Build input-dependent parts (always fresh — never cached).
   */
  private buildInputDependent(input: string, opts?: BuildOptions) {
    const atomBudget = opts?.atomBudget ?? 20;
    const knowledgeBudget = opts?.knowledgeBudget ?? 5;

    const atoms = atomStore.search(input, atomBudget).map((a) => ({
      id: a.id,
      kind: a.kind,
      content: a.content.slice(0, 200),
      confidence: a.confidence,
    }));

    const knowledgeNodes = knowledgeNetwork
      .search(input, knowledgeBudget)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        content: e.content.slice(0, 200),
        confidence: e.confidence,
      }));

    return { atoms, knowledgeNodes };
  }

  /**
   * Build state-dependent parts (cacheable — don't depend on input).
   */
  private buildStateContext(): StateContext {
    const entityBudget = 10;

    const entities = atomStore.queryByKind("entity").slice(0, entityBudget).map((a) => ({
      id: a.id,
      name: a.content,
      state: a.metadata,
    }));

    const workspace = worldState.get<RuntimeContext["workspace"]>("workspace") ?? {};

    const goalsObj = worldState.get<Record<string, { description: string; status: string }>>("mental.goals") ?? {};
    const goals = Object.entries(goalsObj).map(([key, value]) => ({
      id: key,
      description: value.description ?? "",
      status: value.status ?? "active",
    }));

    const beliefsObj = worldState.get<Record<string, { statement: string; confidence: number }>>("mental.beliefs") ?? {};
    const beliefs = Object.entries(beliefsObj).map(([key, value]) => ({
      statement: value.statement ?? key,
      confidence: value.confidence ?? 0.5,
    }));

    const tools = Array.from(worldState.query("tools.").entries()).map(([key, value]) => ({
      name: key.replace("tools.", ""),
      description: (value as { description?: string })?.description ?? "",
    }));

    const system = {
      uptime: Date.now() - (worldState.get<number>("system.startTime") ?? Date.now()),
      tickNumber: worldState.get<number>("runtime.tickNumber") ?? 0,
      stateVersion: worldState.getVersion(),
    };

    const tokenBudget = worldState.get<RuntimeContext["tokenBudget"]>("tokens") ?? {
      available: 100000,
      used: 0,
      max: 100000,
    };

    return { entities, workspace, goals, beliefs, tools, system, tokenBudget };
  }

  /**
   * Format context for LLM prompt.
   * @param context - The runtime context to format
   * @param maxAtoms - Max atoms to include in prompt (default 10, was hardcoded 5)
   * @param maxHistory - Max history messages to include (default 6)
   */
  formatForPrompt(context: RuntimeContext, opts?: {
    maxAtoms?: number
    maxEntities?: number
    maxBeliefs?: number
    maxHistory?: number
  }): string {
    const maxAtoms = opts?.maxAtoms ?? 10;
    const maxEntities = opts?.maxEntities ?? 5;
    const maxBeliefs = opts?.maxBeliefs ?? 3;
    const maxHistory = opts?.maxHistory ?? 6;

    const parts: string[] = [];

    // System info
    parts.push(`[System: uptime=${Math.floor(context.system.uptime / 1000)}s, tick=${context.system.tickNumber}]`);

    // Workspace
    if (context.workspace.projectPath) {
      parts.push(`[Project: ${context.workspace.projectPath}]`);
    }

    // Goals
    if (context.goals.length > 0) {
      parts.push(`[Goals: ${context.goals.map((g) => g.description).join("; ")}]`);
    }

    // Relevant atoms
    if (context.atoms.length > 0) {
      parts.push(`[Knowledge: ${context.atoms.slice(0, maxAtoms).map((a) => a.content).join("; ")}]`);
    }

    // Knowledge nodes
    if (context.knowledgeNodes.length > 0) {
      parts.push(`[KG: ${context.knowledgeNodes.slice(0, 5).map((k) => k.content).join("; ")}]`);
    }

    // Memories
    if (context.memories.length > 0) {
      parts.push(`[Memories: ${context.memories.slice(0, 3).map((m) => m.content).join("; ")}]`);
    }

    // Entities
    if (context.entities.length > 0) {
      parts.push(`[Entities: ${context.entities.slice(0, maxEntities).map((e) => e.name).join(", ")}]`);
    }

    // Beliefs
    if (context.beliefs.length > 0) {
      parts.push(`[Beliefs: ${context.beliefs.slice(0, maxBeliefs).map((b) => `${b.statement} (${(b.confidence * 100).toFixed(0)}%)`).join("; ")}]`);
    }

    // History
    if (context.history.length > 0) {
      parts.push("[History]");
      for (const msg of context.history.slice(-maxHistory)) {
        parts.push(`${msg.role}: ${msg.content.slice(0, 200)}`);
      }
    }

    // Input
    parts.push(`[Input] ${context.input}`);

    return parts.join("\n");
  }

  /**
   * Estimate token count for a given context (rough: 1 token ≈ 4 chars).
   */
  estimateTokens(context: RuntimeContext): TokenEstimate {
    const prompt = this.formatForPrompt(context);
    const estimated = Math.ceil(prompt.length / 4);
    const budget = context.tokenBudget.max;
    const used = context.tokenBudget.used;
    const remaining = budget - used - estimated;
    return {
      estimated,
      budget,
      remaining,
      overBudget: remaining < 0,
    };
  }

  /**
   * Invalidate the context cache.
   */
  invalidateCache(): void {
    this.stateCache = null;
  }

  /**
   * Get stats.
   */
  getStats(): {
    cached: boolean
    cacheAge: number
    cacheHitRate: number
    buildCount: number
    memoryCount: number
  } {
    const totalRequests = this.cacheHits + this.cacheMisses;
    return {
      cached: this.stateCache !== null,
      cacheAge: this.stateCache ? Date.now() - this.cacheTime : 0,
      cacheHitRate: totalRequests > 0 ? this.cacheHits / totalRequests : 0,
      buildCount: this.buildCount,
      memoryCount: this.injectedMemories.length,
    };
  }
}

export const contextEngine = new ContextEngineImpl();
