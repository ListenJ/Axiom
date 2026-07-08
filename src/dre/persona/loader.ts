/**
 * Persona Loader — 动态角色加载器
 *
 * 核心设计:
 * - Persona 不是切换 Agent，而是切换 Runtime 的配置上下文
 * - 加载 Persona = 注入 Constraints + 激活 MentalModels + 选择 Capabilities
 * - 支持栈式切换 (push/pop)
 */

import { logger } from "../../utils/logger.js";
import type {
  PersonaMode,
  PersonaConfig,
  LoadedPersona,
  PersonaContext,
} from "./types.js";
import {
  SECURITY_PERSONA_CONFIG,
  CREATIVE_PERSONA_CONFIG,
  GENERAL_PERSONA_CONFIG,
} from "./types.js";
import { PromptTemplateStore, createDefaultPromptStore } from "./prompt-store.js";
import type { Constraint, ConstraintSolver } from "../constraint/solver.js";
import { AUDIT_CONSTRAINTS, RESOURCE_CONSTRAINTS } from "../constraint/solver.js";
import type { CapabilityContract } from "../runtime/capability-registry.js";
import { capabilityRegistry } from "../runtime/capability-registry.js";

export interface PersonaLoaderConfig {
  /** 约束求解器引用 */
  constraintSolver?: ConstraintSolver;
  /** MentalModel Pool 引用 */
  mentalModelPool?: {
    activate(id: string): void;
    deactivate(id: string): void;
    getActiveIds(): string[];
  };
  /** 初始 Persona */
  defaultPersona?: PersonaMode;
}

export class PersonaLoader {
  private context: PersonaContext;
  private promptStore: PromptTemplateStore;
  private constraintSolver: ConstraintSolver | null;
  private mentalModelPool: PersonaLoaderConfig["mentalModelPool"] | null;

  /** 注册的自定义 Persona 配置 */
  private customPersonas = new Map<string, PersonaConfig>();

  constructor(config: PersonaLoaderConfig = {}) {
    this.promptStore = createDefaultPromptStore();
    this.constraintSolver = config.constraintSolver ?? null;
    this.mentalModelPool = config.mentalModelPool ?? null;

    const defaultMode = config.defaultPersona ?? "general";
    const defaultConfig = this.resolveConfig(defaultMode);

    const promptTemplate = this.promptStore.get(defaultConfig.promptTemplateId);
    if (!promptTemplate) {
      throw new Error(
        `[PersonaLoader] Prompt template "${defaultConfig.promptTemplateId}" not found for persona "${defaultMode}". ` +
        `Ensure the template is registered in PromptTemplateStore.`
      );
    }

    const loaded: LoadedPersona = {
      config: defaultConfig,
      loadedAt: Date.now(),
      activeConstraints: [],
      activeMentalModels: [],
      promptTemplate,
    };

    this.context = {
      current: loaded,
      stack: [],
      history: [],
    };

    this.applyPersona(loaded);

    logger.info("[PersonaLoader] Initialized", {
      defaultMode,
      persona: loaded.config.name,
    });
  }

  /**
   * 切换到新 Persona (压栈)
   */
  switchTo(mode: PersonaMode, reason: string = "manual"): LoadedPersona {
    const prev = this.context.current;
    this.context.stack.push(prev);
    this.context.history.push({
      from: prev.config.mode,
      to: mode,
      timestamp: Date.now(),
      reason,
    });

    const config = this.resolveConfig(mode);
    const promptTemplate = this.promptStore.get(config.promptTemplateId);
    if (!promptTemplate) {
      throw new Error(
        `[PersonaLoader] Prompt template "${config.promptTemplateId}" not found for persona "${mode}".`
      );
    }

    const loaded: LoadedPersona = {
      config,
      loadedAt: Date.now(),
      activeConstraints: [],
      activeMentalModels: [],
      promptTemplate,
    };

    // 卸载旧 Persona 的资源
    this.unapplyPersona(prev);
    // 应用新 Persona
    this.applyPersona(loaded);

    this.context.current = loaded;

    logger.info("[PersonaLoader] Switched", {
      from: prev.config.mode,
      to: mode,
      reason,
      stackDepth: this.context.stack.length,
    });

    return loaded;
  }

  /**
   * 返回上一个 Persona (弹栈)
   */
  popToPrevious(): LoadedPersona | null {
    const prev = this.context.stack.pop();
    if (!prev) {
      logger.warn("[PersonaLoader] No previous persona to pop to");
      return null;
    }

    this.unapplyPersona(this.context.current);
    this.applyPersona(prev);

    this.context.history.push({
      from: this.context.current.config.mode,
      to: prev.config.mode,
      timestamp: Date.now(),
      reason: "pop",
    });

    this.context.current = prev;

    logger.info("[PersonaLoader] Popped to", {
      mode: prev.config.mode,
      remainingStack: this.context.stack.length,
    });

    return prev;
  }

  /**
   * 获取当前 Persona
   */
  getCurrent(): LoadedPersona {
    return this.context.current;
  }

  /**
   * 获取当前模式
   */
  getCurrentMode(): PersonaMode {
    return this.context.current.config.mode;
  }

  /**
   * 渲染当前 Persona 的系统提示
   */
  renderSystemPrompt(variables: Record<string, string> = {}): string {
    const persona = this.context.current;
    return this.promptStore.render(persona.config.promptTemplateId, variables);
  }

  /**
   * 获取当前 Persona 的 LLM 温度
   */
  getTemperature(): number {
    return this.context.current.config.temperature;
  }

  /**
   * 检查当前是否允许某操作
   */
  canWrite(): boolean {
    return this.context.current.config.allowWrite;
  }

  canUseTools(): boolean {
    return this.context.current.config.allowToolCalls;
  }

  /**
   * 注册自定义 Persona 配置
   */
  registerPersona(config: PersonaConfig): void {
    this.customPersonas.set(config.mode, config);
    logger.info("[PersonaLoader] Registered custom persona", { mode: config.mode, name: config.name });
  }

  /**
   * 获取所有可用模式
   */
  getAvailableModes(): PersonaMode[] {
    const builtin: PersonaMode[] = ["plan", "code", "retrieve", "reflect", "audit", "creative", "general"];
    const custom = Array.from(this.customPersonas.keys()) as PersonaMode[];
    return [...new Set([...builtin, ...custom])];
  }

  /**
   * 获取上下文摘要
   */
  getContextSummary() {
    return {
      currentMode: this.context.current.config.mode,
      currentPersona: this.context.current.config.name,
      stackDepth: this.context.stack.length,
      switchCount: this.context.history.length,
      activeSince: this.context.current.loadedAt,
    };
  }

  /**
   * 应用 Persona (激活约束 + 心智模型 + 能力供应商)
   */
  private applyPersona(persona: LoadedPersona): void {
    // 注册约束
    if (this.constraintSolver && persona.config.constraints.length > 0) {
      this.constraintSolver.registerAll(persona.config.constraints);
      persona.activeConstraints = persona.config.constraints.map((c) => c.id);
    }

    // 激活心智模型
    if (this.mentalModelPool && persona.config.mentalModelIds.length > 0) {
      for (const modelId of persona.config.mentalModelIds) {
        try {
          this.mentalModelPool.activate(modelId);
          persona.activeMentalModels.push(modelId);
        } catch (err) {
          logger.debug("[PersonaLoader] Failed to activate mental model", {
            modelId,
            error: (err as Error).message,
          });
        }
      }
    }

    // 自动选择最优 Capability Provider (v3.1)
    if (persona.config.requiredCapabilities.length > 0) {
      for (const contract of persona.config.requiredCapabilities) {
        const selected = capabilityRegistry.select(contract, {
          // audit persona 优先本地 (零成本+零延迟)
          maxCost: persona.config.mode === "audit" ? 0 : undefined,
          maxLatency: persona.config.mode === "plan" ? 1000 : undefined,
          minReliability: persona.config.mode === "audit" ? 0.7 : undefined,
        });
        if (selected) {
          logger.debug("[PersonaLoader] Capability selected", {
            persona: persona.config.mode,
            contract,
            provider: selected.provider.name,
            reliability: selected.reliability,
          });
        }
      }
    }
  }

  /**
   * 卸载 Persona (移除约束 + 停用心智模型)
   */
  private unapplyPersona(persona: LoadedPersona): void {
    if (this.constraintSolver && persona.activeConstraints.length > 0) {
      for (const constraintId of persona.activeConstraints) {
        this.constraintSolver.unregister(constraintId);
      }
    }

    if (this.mentalModelPool && persona.activeMentalModels.length > 0) {
      for (const modelId of persona.activeMentalModels) {
        try {
          this.mentalModelPool.deactivate(modelId);
        } catch {
          // ignore deactivate errors
        }
      }
    }
  }

  /**
   * 解析 Persona 配置 (合并内置 + 自定义)
   */
  private resolveConfig(mode: PersonaMode): PersonaConfig {
    // 优先使用自定义配置
    const custom = this.customPersonas.get(mode);
    if (custom) return custom;

    // 内置配置
    const baseConfig = BUILTIN_PERSONA_BASE[mode];
    const builtin = baseConfig ?? BUILTIN_PERSONA_BASE.general;

    return {
      ...builtin,
      constraints: this.builtinConstraints(mode),
      mentalModelIds: [],
      requiredCapabilities: this.builtinCapabilities(mode),
    };
  }

  /**
   * 内置 Persona 的约束映射
   */
  private builtinConstraints(mode: PersonaMode): Constraint[] {
    switch (mode) {
      case "audit":
        return [...AUDIT_CONSTRAINTS];
      case "plan":
      case "code":
        return [...RESOURCE_CONSTRAINTS];
      default:
        return [];
    }
  }

  private builtinCapabilities(mode: PersonaMode): CapabilityContract[] {
    switch (mode) {
      case "audit":
        return ["code.review", "verification.factual"];
      case "code":
        return ["code.reasoning", "code.generation", "code.review"];
      case "plan":
        return ["planning.structured", "reasoning.deductive"];
      case "retrieve":
        return ["knowledge.retrieval"];
      case "reflect":
        return ["reasoning.causal", "verification.factual"];
      case "research":
        return ["research.synthesis", "reasoning.analogical", "architecture.analysis"];
      case "creative":
        return ["generation.creative"];
      default:
        return [];
    }
  }
}

/**
 * 内置 Persona 基础配置
 */
const BUILTIN_PERSONA_BASE: Record<PersonaMode, Omit<PersonaConfig, "constraints" | "mentalModelIds" | "requiredCapabilities">> = {
  plan: {
    id: "persona-plan",
    name: "确定性规划器",
    mode: "plan",
    description: "输出 JSON 格式的执行计划, 温度=0",
    promptTemplateId: "prompt-plan",
    allowWrite: false,
    allowToolCalls: true,
    maxSteps: 80,
    temperature: 0,
    metadata: {},
  },
  code: {
    id: "persona-code",
    name: "代码生成器",
    mode: "code",
    description: "diff 格式输出, 测试反馈, 温度=0",
    promptTemplateId: "prompt-code",
    allowWrite: true,
    allowToolCalls: true,
    maxSteps: 50,
    temperature: 0,
    metadata: {},
  },
  retrieve: {
    id: "persona-retrieve",
    name: "知识检索器",
    mode: "retrieve",
    description: "本地知识库检索, 引用 node_id, 温度=0",
    promptTemplateId: "prompt-retrieve",
    allowWrite: false,
    allowToolCalls: true,
    maxSteps: 30,
    temperature: 0,
    metadata: {},
  },
  reflect: {
    id: "persona-reflect",
    name: "反思模式",
    mode: "reflect",
    description: "自监督复盘, 检测逻辑断点/证据缺失/幻觉, 温度=0",
    promptTemplateId: "prompt-reflect",
    allowWrite: true,
    allowToolCalls: true,
    maxSteps: 60,
    temperature: 0,
    metadata: {},
  },
  audit: {
    ...SECURITY_PERSONA_CONFIG,
  },
  creative: {
    ...CREATIVE_PERSONA_CONFIG,
  },
  research: {
    id: "persona-research",
    name: "研究分析",
    mode: "research",
    description: "研究综合模式: 多源证据聚合, 假设生成, 论证构建",
    promptTemplateId: "prompt-research",
    allowWrite: true,
    allowToolCalls: true,
    maxSteps: 100,
    temperature: 0.1,
    metadata: {},
  },
  general: {
    ...GENERAL_PERSONA_CONFIG,
  },
};
