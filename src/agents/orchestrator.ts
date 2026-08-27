/**
 * Multi-Agent Orchestrator — 统一多 Agent 编排
 *
 * 核心功能:
 * 1. Agent Registry — 动态注册/发现 Agent
 * 2. Task Router — 基于任务类型自动选择 Agent
 * 3. Task Decomposition — 复杂任务分解为子任务
 * 4. Parallel Execution — 并行执行独立子任务
 * 5. Result Aggregation — 合并子任务结果
 * 6. Human-in-the-loop — 关键决策点人工确认
 *
 * 架构设计:
 * - 所有 Agent 实现统一的 AgentInterface
 * - Orchestrator 负责任务调度和结果合并
 * - 支持串行/并行/DAG 三种执行模式
 */

import { logger } from "../utils/logger.js";
import { toAxiomError } from "../utils/errors.js";
import { recognizeIntent, type IntentResult } from "./intent-router.js";
import { getPromptPool, type AgentRole } from "./prompt-pool.js";
import { internalAgent } from "./internal-agent.js";
import {
  NativeGeneralAgent,
  NativeCodeAgent,
  NativeResearchAgent,
} from "../components/native-agents.js";
import { createNativeAgentOptions } from "./component-bootstrap.js";
import { getDefaultSelfEvolve } from "../self-evolve/index.js";
import type { SelfEvolveEngine } from "../self-evolve/engine.js";

// ========== 类型定义 ==========

/** Agent 统一接口 */
export interface AgentInterface {
  /** Agent 唯一标识 */
  id: string;
  /** Agent 名称 */
  name: string;
  /** Agent 描述 */
  description: string;
  /** 支持的任务类型 */
  capabilities: string[];
  /** 执行任务 */
  execute(task: AgentTask): Promise<AgentResult>;
  /** 健康检查 */
  healthCheck(): Promise<boolean>;
}

/** Agent 任务 */
export interface AgentTask {
  /** 任务 ID */
  id: string;
  /** 任务类型 */
  type: string;
  /** 任务描述 */
  description: string;
  /** 任务输入 */
  input: Record<string, unknown>;
  /** 任务上下文 */
  context?: Record<string, unknown>;
  /** 优先级 (1-10, 10 最高) */
  priority?: number;
  /** 超时时间 (ms) */
  timeout?: number;
  /** 是否需要人工确认 */
  requireConfirmation?: boolean;
  /** 依赖的任务 ID 列表 */
  dependsOn?: string[];
}

/** Agent 执行结果 */
export interface AgentResult {
  /** 任务 ID */
  taskId: string;
  /** Agent ID */
  agentId: string;
  /** 是否成功 */
  success: boolean;
  /** 结果数据 */
  data?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行耗时 (ms) */
  duration: number;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/** 编排计划 */
export interface OrchestrationPlan {
  /** 计划 ID */
  id: string;
  /** 计划名称 */
  name: string;
  /** 执行步骤 */
  steps: OrchestrationStep[];
  /** 执行模式 */
  mode: "sequential" | "parallel" | "dag";
}

/** 编排步骤 */
export interface OrchestrationStep {
  /** 步骤 ID */
  id: string;
  /** 步骤名称 */
  name: string;
  /** 分配的 Agent ID */
  agentId: string;
  /** 任务 */
  task: AgentTask;
  /** 依赖的步骤 IDs (DAG 模式) */
  dependsOn?: string[];
  /** 是否需要人工确认 */
  requireConfirmation?: boolean;
}

/** 编排结果 */
export interface OrchestrationResult {
  /** 计划 ID */
  planId: string;
  /** 是否成功 */
  success: boolean;
  /** 步骤结果 */
  stepResults: Map<string, AgentResult>;
  /** 最终结果 */
  finalResult?: unknown;
  /** 总耗时 (ms) */
  totalDuration: number;
  /** 错误信息 */
  errors: string[];
}

// ========== Agent Registry ==========

class AgentRegistryImpl {
  private agents = new Map<string, AgentInterface>();

  /**
   * 注册 Agent
   */
  register(agent: AgentInterface): void {
    if (this.agents.has(agent.id)) {
      logger.warn("[AgentRegistry] Agent already registered, overwriting", { id: agent.id });
    }
    this.agents.set(agent.id, agent);
    logger.info("[AgentRegistry] Agent registered", { id: agent.id, name: agent.name });
  }

  /**
   * 注销 Agent
   */
  unregister(agentId: string): boolean {
    const deleted = this.agents.delete(agentId);
    if (deleted) {
      logger.info("[AgentRegistry] Agent unregistered", { id: agentId });
    }
    return deleted;
  }

  /**
   * 获取 Agent
   */
  get(agentId: string): AgentInterface | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 列出所有 Agent
   */
  list(): AgentInterface[] {
    return Array.from(this.agents.values());
  }

  /**
   * 按能力查找 Agent
   */
  findByCapability(capability: string): AgentInterface[] {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.capabilities.includes(capability)
    );
  }

  /**
   * 健康检查所有 Agent
   */
  async healthCheckAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    const checks = Array.from(this.agents.entries()).map(async ([id, agent]) => {
      try {
        const healthy = await agent.healthCheck();
        results.set(id, healthy);
      } catch {
        results.set(id, false);
      }
    });
    await Promise.all(checks);
    return results;
  }
}

// ========== Task Router ==========

class TaskRouterImpl {
  /**
   * 根据任务类型选择最佳 Agent
   */
  selectAgent(task: AgentTask, registry: AgentRegistryImpl): AgentInterface | null {
    // 1. 按能力匹配
    const capableAgents = registry.findByCapability(task.type);
    if (capableAgents.length > 0) {
      // 2. 按优先级排序 (可用其他策略)
      return capableAgents[0];
    }

    // 3. 回退到通用 Agent
    const generalAgents = registry.findByCapability("general");
    return generalAgents.length > 0 ? generalAgents[0] : null;
  }

  /**
   * 根据意图选择 Agent
   */
  selectAgentByIntent(intent: IntentResult, registry: AgentRegistryImpl): AgentInterface | null {
    // 与 intent-router.ts CATEGORY_INTENTS 的 role 字段对齐（main_coding/research/coding）
    const roleMapping: Record<string, string> = {
      "main_coding": "native-code",
      "coding": "native-code",
      "code-generation": "native-code",
      "code-review": "native-code",
      "refactoring": "native-code",
      "testing": "native-code",
      "research": "native-research",
      "deep-research": "native-research",
      "architecture": "native-research",
      "decision": "native-general",
      "general-chat": "native-general",
      "general-tool": "native-general",
    };

    const agentId = roleMapping[intent.recommendedRole] || "native-general";
    return registry.get(agentId) || null;
  }
}

// ========== Task Decomposer ==========

class TaskDecomposerImpl {
  /**
   * 分解复杂任务为子任务
   */
  decompose(task: AgentTask): AgentTask[] {
    // 基于任务类型的分解策略
    const strategies: Record<string, (t: AgentTask) => AgentTask[]> = {
      "code-review": this.decomposeCodeReview,
      "research": this.decomposeResearch,
      "architecture": this.decomposeArchitecture,
    };

    const strategy = strategies[task.type];
    if (strategy) {
      return strategy(task);
    }

    // 默认: 不分解
    return [task];
  }

  private decomposeCodeReview(task: AgentTask): AgentTask[] {
    return [
      {
        ...task,
        id: `${task.id}-analyze`,
        type: "code-analysis",
        description: `分析代码: ${task.description}`,
      },
      {
        ...task,
        id: `${task.id}-security`,
        type: "security-scan",
        description: `安全扫描: ${task.description}`,
      },
      {
        ...task,
        id: `${task.id}-performance`,
        type: "performance-analysis",
        description: `性能分析: ${task.description}`,
      },
    ];
  }

  private decomposeResearch(task: AgentTask): AgentTask[] {
    return [
      {
        ...task,
        id: `${task.id}-gather`,
        type: "data-gathering",
        description: `收集数据: ${task.description}`,
      },
      {
        ...task,
        id: `${task.id}-analyze`,
        type: "data-analysis",
        description: `分析数据: ${task.description}`,
        dependsOn: [`${task.id}-gather`],
      },
      {
        ...task,
        id: `${task.id}-synthesize`,
        type: "synthesis",
        description: `综合结论: ${task.description}`,
        dependsOn: [`${task.id}-analyze`],
      },
    ];
  }

  private decomposeArchitecture(task: AgentTask): AgentTask[] {
    return [
      {
        ...task,
        id: `${task.id}-requirements`,
        type: "requirements-analysis",
        description: `需求分析: ${task.description}`,
      },
      {
        ...task,
        id: `${task.id}-design`,
        type: "system-design",
        description: `系统设计: ${task.description}`,
        dependsOn: [`${task.id}-requirements`],
      },
      {
        ...task,
        id: `${task.id}-review`,
        type: "design-review",
        description: `设计评审: ${task.description}`,
        dependsOn: [`${task.id}-design`],
      },
    ];
  }
}

// ========== Orchestrator ==========

export class AgentOrchestrator {
  private registry: AgentRegistryImpl;
  private router: TaskRouterImpl;
  private decomposer: TaskDecomposerImpl;

  constructor(private readonly options: { selfEvolve?: Pick<SelfEvolveEngine, "selfImprove"> } = {}) {
    this.registry = new AgentRegistryImpl();
    this.router = new TaskRouterImpl();
    this.decomposer = new TaskDecomposerImpl();
  }

  /**
   * 获取 Agent Registry
   */
  getRegistry(): AgentRegistryImpl {
    return this.registry;
  }

  /**
   * 执行单个任务
   */
  async executeTask(task: AgentTask): Promise<AgentResult> {
    const startTime = Date.now();

    try {
      // 1. 选择 Agent
      const agent = this.router.selectAgent(task, this.registry);
      if (!agent) {
        return {
          taskId: task.id,
          agentId: "none",
          success: false,
          error: `No agent found for task type: ${task.type}`,
          duration: Date.now() - startTime,
        };
      }

      // 2. 人工确认闭环（审计整改 O2）：requireConfirmation 任务先经
      // approval-bridge 走 HITL 确认，拒绝/超时 → failed result 且不执行。
      if (task.requireConfirmation) {
        const { getApprovalBridge } = await import("../utils/approval-bridge.js");
        let approved = false;
        try {
          approved = await getApprovalBridge().request(
            `orchestrator_task:${task.type}`,
            { taskId: task.id, description: task.description, input: task.input },
            { risk: "caution" },
          );
        } catch (err) {
          logger.warn("[Orchestrator] Confirmation request failed (treated as denied)", {
            taskId: task.id,
            error: (err as Error).message,
          });
        }
        if (!approved) {
          const denied: AgentResult = {
            taskId: task.id,
            agentId: agent.id,
            success: false,
            error: "Task requires confirmation but approval was denied or timed out",
            duration: Date.now() - startTime,
          };
          await this.recordEvolution(task, denied);
          return denied;
        }
      }

      // 3. 执行任务（审计整改 O2：task.timeout 到期强制失败，timer 必须清理）
      logger.info("[Orchestrator] Executing task", {
        taskId: task.id,
        agentId: agent.id,
        type: task.type,
      });

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await (task.timeout
        ? Promise.race([
            agent.execute(task),
            new Promise<never>((_, reject) => {
              timeoutTimer = setTimeout(
                () => reject(new Error(`Task ${task.id} timeout after ${task.timeout}ms`)),
                task.timeout,
              );
            }),
          ])
        : agent.execute(task));
      clearTimeout(timeoutTimer);

      await this.recordEvolution(task, result);

      logger.info("[Orchestrator] Task completed", {
        taskId: task.id,
        agentId: agent.id,
        success: result.success,
        duration: result.duration,
      });

      return result;
    } catch (err) {
      const error = toAxiomError(err, "Task execution failed");
      logger.error(`[Orchestrator] Task ${task.id} failed`, error);

      const failed: AgentResult = {
        taskId: task.id,
        agentId: "unknown",
        success: false,
        error: error.message,
        duration: Date.now() - startTime,
      };
      await this.recordEvolution(task, failed);
      return failed;
    }
  }

  /**
   * 执行反馈回流自我进化：成功 → Improve（写教训）；失败 → Debug（修订计划）。
   * 非阻断：engine 缺失或抛错均不影响任务结果。
   */
  private async recordEvolution(task: AgentTask, result: AgentResult): Promise<void> {
    if (!this.options.selfEvolve) return;
    try {
      await this.options.selfEvolve.selfImprove({
        task: task.description,
        feedback: {
          action: task.description || task.type,
          outcome: result.success ? "completed" : `failed: ${(result.error ?? "").slice(0, 300)}`,
          success: result.success,
          error: result.error,
        },
      });
    } catch (err) {
      logger.debug("[Orchestrator] self-improve skipped", { error: (err as Error).message });
    }
  }

  /**
   * 执行编排计划
   */
  async executePlan(plan: OrchestrationPlan): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const stepResults = new Map<string, AgentResult>();
    const errors: string[] = [];

    logger.info("[Orchestrator] Executing plan", {
      planId: plan.id,
      name: plan.name,
      mode: plan.mode,
      steps: plan.steps.length,
    });

    try {
      switch (plan.mode) {
        case "sequential":
          await this.executeSequential(plan, stepResults, errors);
          break;
        case "parallel":
          await this.executeParallel(plan, stepResults, errors);
          break;
        case "dag":
          await this.executeDAG(plan, stepResults, errors);
          break;
      }

      const success = errors.length === 0;

      logger.info("[Orchestrator] Plan completed", {
        planId: plan.id,
        success,
        errors: errors.length,
        duration: Date.now() - startTime,
      });

      return {
        planId: plan.id,
        success,
        stepResults,
        totalDuration: Date.now() - startTime,
        errors,
      };
    } catch (err) {
      const error = toAxiomError(err, "Plan execution failed");
      errors.push(error.message);

      return {
        planId: plan.id,
        success: false,
        stepResults,
        totalDuration: Date.now() - startTime,
        errors,
      };
    }
  }

  /**
   * 串行执行
   */
  private async executeSequential(
    plan: OrchestrationPlan,
    results: Map<string, AgentResult>,
    errors: string[]
  ): Promise<void> {
    for (const step of plan.steps) {
      const result = await this.executeStep(step);
      results.set(step.id, result);

      if (!result.success) {
        errors.push(`Step ${step.id} failed: ${result.error}`);
        break; // 串行模式下失败则停止
      }
    }
  }

  /**
   * 并行执行
   */
  private async executeParallel(
    plan: OrchestrationPlan,
    results: Map<string, AgentResult>,
    errors: string[]
  ): Promise<void> {
    const promises = plan.steps.map(async (step) => {
      const result = await this.executeStep(step);
      results.set(step.id, result);

      if (!result.success) {
        errors.push(`Step ${step.id} failed: ${result.error}`);
      }
    });

    await Promise.all(promises);
  }

  /**
   * DAG 执行 (基于依赖关系)
   */
  private async executeDAG(
    plan: OrchestrationPlan,
    results: Map<string, AgentResult>,
    errors: string[]
  ): Promise<void> {
    const completed = new Set<string>();
    const completedSuccess = new Set<string>();
    const remaining = new Set(plan.steps.map((s) => s.id));

    while (remaining.size > 0) {
      // 找出所有依赖已满足的步骤（仅成功完成的依赖才视为就绪）
      const ready = plan.steps.filter(
        (step) =>
          remaining.has(step.id) &&
          (!step.dependsOn || step.dependsOn.every((dep) => completedSuccess.has(dep)))
      );

      if (ready.length === 0) {
        errors.push("Deadlock detected: no steps can be executed");
        break;
      }

      // 并行执行就绪的步骤
      const promises = ready.map(async (step) => {
        const result = await this.executeStep(step);
        results.set(step.id, result);

        if (!result.success) {
          errors.push(`Step ${step.id} failed: ${result.error}`);
        }

        completed.add(step.id);
        remaining.delete(step.id);
        if (result.success) completedSuccess.add(step.id);
      });

      await Promise.all(promises);
    }
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(step: OrchestrationStep): Promise<AgentResult> {
    // 人工确认闭环（审计整改 O2）：step.requireConfirmation 与
    // task.requireConfirmation 任一为真都先经 approval-bridge 确认。
    if (step.requireConfirmation && !step.task.requireConfirmation) {
      return this.executeTask({ ...step.task, requireConfirmation: true });
    }
    return this.executeTask(step.task);
  }

  /**
   * 获取编排状态
   */
  getStatus(): {
    registeredAgents: number;
    agentHealth: Map<string, boolean>;
  } {
    return {
      registeredAgents: this.registry.list().length,
      agentHealth: new Map(), // 需要异步获取
    };
  }
}

// ========== 内置 Agent 实现 ==========

/**
 * Internal Agent — 通用内部 Agent
 */
export class InternalAgent implements AgentInterface {
  id = "internal";
  name = "Internal Agent";
  description = "通用内部 Agent，处理一般对话和工具调用";
  capabilities = ["general", "general-chat", "general-tool"];

  async execute(task: AgentTask): Promise<AgentResult> {
    const startTime = Date.now();

    try {
      // 使用 Prompt Pool 获取缓存友好的系统提示
      const pool = getPromptPool();
      const prompt = pool.acquire("general_chat", {
        task_description: task.description,
        context: task.context ? JSON.stringify(task.context) : undefined,
      });

      const result = await internalAgent.executeWithRole("general-chat", [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: task.description },
      ]);

      return {
        taskId: task.id,
        agentId: this.id,
        success: true,
        data: { message: result.content || "[No response from model]" },
        duration: Date.now() - startTime,
        metadata: { model: result.model, provider: result.provider },
      };
    } catch (err) {
      return {
        taskId: task.id,
        agentId: this.id,
        success: false,
        error: (err as Error).message,
        duration: Date.now() - startTime,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/**
 * Code Agent — 代码生成 Agent
 */
export class CodeAgent implements AgentInterface {
  id = "opencode";
  name = "Code Agent";
  description = "代码生成、重构、测试 Agent";
  capabilities = ["code-generation", "code-review", "refactoring", "testing"];

  async execute(task: AgentTask): Promise<AgentResult> {
    const startTime = Date.now();

    try {
      const pool = getPromptPool();
      const prompt = pool.acquire("main_coding", {
        task_description: task.description,
        context: task.context ? JSON.stringify(task.context) : undefined,
      });

      const result = await internalAgent.executeWithRole("code-generation", [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: task.description },
      ]);

      return {
        taskId: task.id,
        agentId: this.id,
        success: true,
        data: { message: result.content || "[No response from model]" },
        duration: Date.now() - startTime,
        metadata: { model: result.model, provider: result.provider },
      };
    } catch (err) {
      return {
        taskId: task.id,
        agentId: this.id,
        success: false,
        error: (err as Error).message,
        duration: Date.now() - startTime,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/**
 * Research Agent — 研究分析 Agent
 */
export class ResearchAgent implements AgentInterface {
  id = "hermes";
  name = "Research Agent";
  description = "深度研究、分析、报告生成 Agent";
  capabilities = ["research", "analysis", "deep-research", "architecture"];

  async execute(task: AgentTask): Promise<AgentResult> {
    const startTime = Date.now();

    try {
      const pool = getPromptPool();
      const prompt = pool.acquire("research", {
        task_description: task.description,
        context: task.context ? JSON.stringify(task.context) : undefined,
      });

      const result = await internalAgent.executeWithRole("research", [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: task.description },
      ]);

      return {
        taskId: task.id,
        agentId: this.id,
        success: true,
        data: { message: result.content || "[No response from model]" },
        duration: Date.now() - startTime,
        metadata: { model: result.model, provider: result.provider },
      };
    } catch (err) {
      return {
        taskId: task.id,
        agentId: this.id,
        success: false,
        error: (err as Error).message,
        duration: Date.now() - startTime,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// ========== 全局单例 ==========

let _instance: AgentOrchestrator | null = null;

export function getAgentOrchestrator(): AgentOrchestrator {
  if (!_instance) {
    _instance = new AgentOrchestrator({ selfEvolve: getDefaultSelfEvolve() });

    // Day0: native agents are the default path; external CLIs remain optional adapters.
    const options = createNativeAgentOptions();
    _instance.getRegistry().register(new NativeGeneralAgent(options));
    _instance.getRegistry().register(new NativeCodeAgent(options));
    _instance.getRegistry().register(new NativeResearchAgent(options));
  }
  return _instance;
}
