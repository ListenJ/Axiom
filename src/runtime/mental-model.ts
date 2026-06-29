/**
 * Mental Model — 心智模型层
 *
 * 在 Pattern 和 Skill 之间插入心智模型。
 * 当系统学习到 Git 冲突模式时，不应直接生成 Skill，
 * 而是先构建一个包含 Index/HEAD 概念的内部模拟模型，
 * 并在此模型上演练出 Skill。
 *
 * 解决 Pattern → Skill 的认知断层。
 */

import { logger } from "../utils/logger.js";
import { eventBus } from "./kernel.js";
import { atomStore } from "./atom-engine.js";
import { knowledgeNetwork } from "./knowledge-network.js";

// ─── Mental Model Types ────────────────────────────────────────────────────

export interface MentalModel {
  id: string
  name: string
  domain: string                    // 领域 (git, auth, database, etc.)
  concepts: Concept[]               // 概念
  relationships: ConceptRelation[]  // 概念关系
  rules: ModelRule[]                // 领域规则
  simulations: Simulation[]         // 模拟结果
  confidence: number                // 0-1
  createdAt: number
  updatedAt: number
}

export interface Concept {
  id: string
  name: string
  description: string
  properties: Record<string, unknown>
  kind: "object" | "process" | "state" | "constraint"
}

export interface ConceptRelation {
  source: string    // concept ID
  target: string    // concept ID
  type: "causes" | "enables" | "prevents" | "requires" | "part-of" | "creates"
  weight: number    // 0-1
}

export interface ModelRule {
  id: string
  condition: string
  action: string
  confidence: number
}

export interface Simulation {
  id: string
  scenario: string
  steps: SimulationStep[]
  outcome: "success" | "failure" | "uncertain"
  confidence: number
  timestamp: number
}

export interface SimulationStep {
  action: string
  result: string
  state: Record<string, unknown>
}

// ─── Mental Model Manager ──────────────────────────────────────────────────

class MentalModelManagerImpl {
  private models = new Map<string, MentalModel>();
  private stats = { created: 0, simulations: 0, skillsGenerated: 0 };

  /**
   * Create a mental model for a domain.
   */
  createModel(domain: string, concepts: Concept[], relations: ConceptRelation[]): MentalModel {
    const id = `model_${domain}_${Date.now()}`;
    const model: MentalModel = {
      id,
      name: `${domain} Model`,
      domain,
      concepts,
      relationships: relations,
      rules: [],
      simulations: [],
      confidence: 0.5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.models.set(id, model);
    this.stats.created++;

    // Store as knowledge
    knowledgeNetwork.create("concept", `${domain} Mental Model`, JSON.stringify(concepts), {
      confidence: 0.5,
      source: "mental-model",
      metadata: { modelId: id, domain },
    });

    eventBus.publish({
      type: "mental_model.created",
      source: "mental-model",
      data: { id, domain, conceptCount: concepts.length },
      priority: "normal",
    });

    return model;
  }

  /**
   * Add a rule to a mental model.
   */
  addRule(modelId: string, rule: Omit<ModelRule, "id">): boolean {
    const model = this.models.get(modelId);
    if (!model) return false;

    model.rules.push({
      ...rule,
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
    model.updatedAt = Date.now();
    return true;
  }

  /**
   * Simulate a scenario in a mental model.
   * Returns the simulation result without actually executing.
   */
  simulate(modelId: string, scenario: string, initialState: Record<string, unknown>): Simulation | null {
    const model = this.models.get(modelId);
    if (!model) return null;

    this.stats.simulations++;

    const steps: SimulationStep[] = [];
    const state = { ...initialState };

    // Apply rules to simulate
    for (const rule of model.rules) {
      // Simple rule application (in production, this would be more sophisticated)
      steps.push({
        action: rule.action,
        result: `Applied: ${rule.condition}`,
        state: { ...state },
      });
    }

    const simulation: Simulation = {
      id: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      scenario,
      steps,
      outcome: steps.length > 0 ? "success" : "uncertain",
      confidence: model.confidence,
      timestamp: Date.now(),
    };

    model.simulations.push(simulation);
    model.updatedAt = Date.now();

    return simulation;
  }

  /**
   * Generate a skill from a successful simulation.
   */
  generateSkillFromSimulation(modelId: string, simulationId: string): string | null {
    const model = this.models.get(modelId);
    if (!model) return null;

    const simulation = model.simulations.find((s) => s.id === simulationId);
    if (!simulation || simulation.outcome !== "success") return null;

    this.stats.skillsGenerated++;

    // Create a skill from the simulation steps
    const skillDescription = `Skill from ${model.domain}: ${simulation.scenario}`;

    // Store as knowledge
    knowledgeNetwork.create("concept", skillDescription, JSON.stringify(simulation.steps), {
      confidence: simulation.confidence,
      source: "mental-model",
      metadata: { modelId, simulationId },
    });

    return skillDescription;
  }

  /**
   * Get a mental model by domain.
   */
  getModel(domain: string): MentalModel | undefined {
    return Array.from(this.models.values()).find((m) => m.domain === domain);
  }

  /**
   * Get all mental models.
   */
  getModels(): MentalModel[] {
    return Array.from(this.models.values());
  }

  /**
   * Get stats.
   */
  getStats(): { models: number; simulations: number; skillsGenerated: number } {
    return { models: this.models.size, ...this.stats };
  }
}

export const mentalModelManager = new MentalModelManagerImpl();

// ─── Predefined Mental Models ──────────────────────────────────────────────

/**
 * Initialize common mental models.
 */
export function initMentalModels(): void {
  // Git Mental Model
  mentalModelManager.createModel("git", [
    { id: "HEAD", name: "HEAD", description: "Current commit pointer", properties: {}, kind: "object" },
    { id: "Index", name: "Index", description: "Staging area", properties: {}, kind: "object" },
    { id: "WorkingDir", name: "Working Directory", description: "Current files", properties: {}, kind: "object" },
    { id: "Merge", name: "Merge", description: "Merge operation", properties: {}, kind: "process" },
    { id: "Conflict", name: "Conflict", description: "Merge conflict", properties: {}, kind: "state" },
  ], [
    { source: "Merge", target: "Conflict", type: "creates", weight: 0.3 },
    { source: "HEAD", target: "Index", type: "part-of", weight: 1.0 },
  ]);

  // Auth Mental Model
  mentalModelManager.createModel("auth", [
    { id: "Token", name: "Token", description: "Authentication token", properties: {}, kind: "object" },
    { id: "Refresh", name: "Refresh", description: "Token refresh", properties: {}, kind: "process" },
    { id: "Expiry", name: "Expiry", description: "Token expiration", properties: {}, kind: "state" },
    { id: "Validation", name: "Validation", description: "Token validation", properties: {}, kind: "process" },
  ], [
    { source: "Expiry", target: "Refresh", type: "causes", weight: 1.0 },
    { source: "Token", target: "Validation", type: "requires", weight: 1.0 },
  ]);

  logger.info("[MentalModel] Initialized mental models");
}
