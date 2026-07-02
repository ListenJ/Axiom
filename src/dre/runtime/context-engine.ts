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

import { eventBus } from "./event-bus.js";
import { worldState } from "./world-state.js";
import { atomStore } from "./atom-engine.js";

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

// ─── Context Builder ───────────────────────────────────────────────────────

class ContextEngineImpl {
  private contextCache: RuntimeContext | null = null;
  private cacheTime = 0;
  private cacheTtl = 5000; // 5 seconds

  /**
   * Build a complete context for a request.
   * This is the ONLY place context is built.
   */
  build(input: string, history: Array<{ role: string; content: string }> = []): RuntimeContext {
    // Check cache
    if (this.contextCache && Date.now() - this.cacheTime < this.cacheTtl) {
      return { ...this.contextCache, input, history };
    }

    // Gather atoms relevant to input
    const relevantAtoms = atomStore.search(input, 20).map((a) => ({
      id: a.id,
      kind: a.kind,
      content: a.content.slice(0, 200),
      confidence: a.confidence,
    }));

    // Gather entities
    const entities = atomStore.queryByKind("entity").slice(0, 10).map((a) => ({
      id: a.id,
      name: a.content,
      state: a.metadata,
    }));

    // Get workspace state from world state
    const workspace = worldState.get<RuntimeContext["workspace"]>("workspace") ?? {};

    // Get goals
    const goalsObj = worldState.get<Record<string, { description: string; status: string }>>("mental.goals") ?? {};
    const goals = Object.entries(goalsObj).map(([key, value]) => ({
      id: key,
      description: value.description ?? "",
      status: value.status ?? "active",
    }));

    // Get beliefs
    const beliefsObj = worldState.get<Record<string, { statement: string; confidence: number }>>("mental.beliefs") ?? {};
    const beliefs = Object.entries(beliefsObj).map(([key, value]) => ({
      statement: value.statement ?? key,
      confidence: value.confidence ?? 0.5,
    }));

    // Get available tools
    const tools = Array.from(worldState.query("tools.").entries()).map(([key, value]) => ({
      name: key.replace("tools.", ""),
      description: (value as any)?.description ?? "",
    }));

    // Get system state
    const system = {
      uptime: Date.now() - (worldState.get<number>("system.startTime") ?? Date.now()),
      tickNumber: worldState.get<number>("runtime.tickNumber") ?? 0,
      stateVersion: worldState.getVersion(),
    };

    // Token budget
    const tokenBudget = worldState.get<RuntimeContext["tokenBudget"]>("tokens") ?? {
      available: 100000,
      used: 0,
      max: 100000,
    };

    const context: RuntimeContext = {
      input,
      history,
      atoms: relevantAtoms,
      entities,
      workspace,
      goals,
      beliefs,
      tools,
      system,
      tokenBudget,
    };

    // Update cache
    this.contextCache = context;
    this.cacheTime = Date.now();

    return context;
  }

  /**
   * Format context for LLM prompt.
   */
  formatForPrompt(context: RuntimeContext): string {
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
      parts.push(`[Knowledge: ${context.atoms.slice(0, 5).map((a) => a.content).join("; ")}]`);
    }

    // Entities
    if (context.entities.length > 0) {
      parts.push(`[Entities: ${context.entities.slice(0, 5).map((e) => e.name).join(", ")}]`);
    }

    // Beliefs
    if (context.beliefs.length > 0) {
      parts.push(`[Beliefs: ${context.beliefs.slice(0, 3).map((b) => `${b.statement} (${(b.confidence * 100).toFixed(0)}%)`).join("; ")}]`);
    }

    // History
    if (context.history.length > 0) {
      parts.push("[History]");
      for (const msg of context.history.slice(-6)) {
        parts.push(`${msg.role}: ${msg.content.slice(0, 200)}`);
      }
    }

    // Input
    parts.push(`[Input] ${context.input}`);

    return parts.join("\n");
  }

  /**
   * Invalidate the context cache.
   */
  invalidateCache(): void {
    this.contextCache = null;
  }

  /**
   * Get stats.
   */
  getStats(): { cached: boolean; cacheAge: number; atomCount: number } {
    return {
      cached: this.contextCache !== null,
      cacheAge: this.contextCache ? Date.now() - this.cacheTime : 0,
      atomCount: this.contextCache?.atoms.length ?? 0,
    };
  }
}

export const contextEngine = new ContextEngineImpl();
