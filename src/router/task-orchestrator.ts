/**
 * 任务编排器 (Task Orchestrator) v2.0
 *
 * 思维链：Understand → Retrieve → Execute → Output
 *
 * 1. Understand: 识别任务类型（关键词匹配，无需 LLM）
 * 2. Retrieve: 按需检索 Vault/SQLite 记忆和代码记忆
 * 3. Execute: 单角色直接执行 或 多角色并行协作
 * 4. Output: 返回结果（多角色时自动汇总）
 *
 * 设计原则：
 *   - 无 L1-L4 分层：避免过度编排，减少延迟
 *   - 无架构设计步骤：Agent 自行决定是否需要架构
 *   - 无评估层：质量由调用方判断，避免自我审查开销
 *   - 简单任务直接执行，复杂任务才分解
 */
import { logger } from "../utils/logger.js";
import { router, toolPool, type SmartAssignmentResponse } from "./model-router.js";
import { retrieveCodeMemory } from "../memory/codegraph-index.js";
import type { ChatMessage, RoleAssignment } from "./model-router.js";
import type { TaskRole } from "./model-capability-registry.js";
import { executionMode } from "../agents/execution-mode.js";
import { injectConstitution } from "../agents/constitution.js";

export interface SubTask {
  id: string;
  role: TaskRole;
  description: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  priority: number; // 0 = highest
  dependsOn?: string[]; // 依赖的其他子任务 ID
}

export interface TaskResult {
  subTaskId: string;
  content: string | null;
  model: string;
  provider: string;
  layer: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  latencyMs: number;
}

export interface OrchestratedResult {
  finalAnswer: string;
  subTaskResults: TaskResult[];
  totalLatencyMs: number;
  totalTokens: number;
  layersUsed: string[];
}

class TaskOrchestrator {
  /**
   * 执行任务：Understand → Retrieve → Execute → Output
   */
  async execute(task: string, opts?: { history?: ChatMessage[]; projectPath?: string }): Promise<OrchestratedResult> {
    const startTime = Date.now();

    // === Step 1: Understand — 识别任务类型 ===
    const taskType = this.classifyTask(task);
    logger.info("[Orchestrator] Understand", { taskType, task: task.slice(0, 80) });

    // === Step 2: Retrieve — 按需检索记忆 ===
    const context = await this.retrieveContext(task, taskType, opts);
    if (context) {
      logger.info("[Orchestrator] Retrieve", {
        vaultSnippets: context.vaultSnippets?.length ?? 0,
        codeSymbols: context.codeSymbols?.length ?? 0,
      });
    }

    // === Step 3: Execute — 执行 ===
    let subTaskResults: TaskResult[];
    const messages = this.buildMessages(task, context, opts?.history);

    if (taskType.needsMultiRole) {
      // 多视角并行（如代码审查+重构）
      logger.info("[Orchestrator] Execute (multi-role)", { roles: taskType.roles });
      subTaskResults = await this.executeRoles(taskType.roles, messages);
    } else {
      // 单一角色直接执行
      logger.info("[Orchestrator] Execute (single)", { role: taskType.roles[0] });
      const result = await this.executeSingle(taskType.roles[0], messages);
      subTaskResults = [result];
    }

    // === Step 4: Output — 返回结果 ===
    const finalAnswer = taskType.needsMultiRole
      ? await this.synthesizeAnswer(task, subTaskResults, opts?.history)
      : (subTaskResults[0]?.content ?? "");

    const totalLatencyMs = Date.now() - startTime;
    const totalTokens = subTaskResults.reduce((sum, r) => sum + (r.usage?.total_tokens ?? 0), 0);

    return {
      finalAnswer,
      subTaskResults,
      totalLatencyMs,
      totalTokens,
      layersUsed: [...new Set(subTaskResults.map((r) => r.layer))],
    };
  }

  // ========== 私有方法：扁平思维链 ==========

  /**
   * Understand: 轻量级任务分类（无需 LLM）
   */
  private classifyTask(task: string): { roles: TaskRole[]; needsMultiRole: boolean } {
    const t = task.toLowerCase();

    // 多角色需求（需要多视角协作）
    if (/review.*refactor|audit.*fix|analyze.*improve|代码审查.*重构|审查.*优化/i.test(t)) {
      return { roles: ["review", "coding"], needsMultiRole: true };
    }
    if (/research.*code|调研.*实现|investigate.*implement/i.test(t)) {
      return { roles: ["research", "coding"], needsMultiRole: true };
    }

    // 单角色需求
    if (/refactor|重构|重构代码/i.test(t)) return { roles: ["coding"], needsMultiRole: false };
    if (/review|audit|审查|评审|code review/i.test(t)) return { roles: ["review"], needsMultiRole: false };
    if (/test|测试|unit test|spec/i.test(t)) return { roles: ["coding"], needsMultiRole: false };
    if (/debug|fix|bug|修复|调试/i.test(t)) return { roles: ["coding"], needsMultiRole: false };
    if (/architecture|design|架构|设计/i.test(t)) return { roles: ["decision"], needsMultiRole: false };
    if (/explain|how|what|为什么|如何|解释/i.test(t)) return { roles: ["research"], needsMultiRole: false };

    // 默认：编码任务
    return { roles: ["coding"], needsMultiRole: false };
  }

  /**
   * Retrieve: 按需检索上下文（Vault + CodeGraph）
   */
  private async retrieveContext(
    task: string,
    taskType: { roles: TaskRole[] },
    opts?: { projectPath?: string }
  ): Promise<{ vaultSnippets?: string[]; codeSymbols?: string[] } | null> {
    const isCodeTask = taskType.roles.some((r) => r === "coding" || r === "review");
    if (!isCodeTask) return null;

    const context: { vaultSnippets?: string[]; codeSymbols?: string[] } = {};

    // 检索代码记忆
    try {
      const cgMemory = await retrieveCodeMemory(task, { projectPath: opts?.projectPath });
      if (cgMemory) {
        context.codeSymbols = cgMemory.symbols.map((s) => `${s.node.name} (${s.node.kind})`);
      }
    } catch (e: any) {
      logger.warn(`[Orchestrator] Code memory retrieval failed: ${e.message}`);
    }

    return context.codeSymbols ? context : null;
  }

  /**
   * 构建执行消息（注入检索到的上下文 + 宪法）
   */
  private buildMessages(
    task: string,
    context: { vaultSnippets?: string[]; codeSymbols?: string[] } | null,
    history?: ChatMessage[]
  ): ChatMessage[] {
    const parts: string[] = [];

    // 注入宪法提示词
    const constitution = executionMode.getConstitutionPrompt();
    parts.push(constitution);

    if (context?.codeSymbols?.length) {
      parts.push(`[Code Context]\n${context.codeSymbols.slice(0, 20).join("\n")}`);
    }
    if (context?.vaultSnippets?.length) {
      parts.push(`[Related Notes]\n${context.vaultSnippets.slice(0, 5).join("\n---\n")}`);
    }

    parts.push(`[Task]\n${task}`);

    return [
      ...(history ?? []),
      { role: "user", content: parts.join("\n\n") },
    ];
  }

  /**
   * Execute (single): 单角色直接执行
   */
  private async executeSingle(role: TaskRole, messages: ChatMessage[]): Promise<TaskResult> {
    const start = Date.now();
    try {
      const result = await router.executeWithRole(role, messages);
      return {
        subTaskId: role,
        content: result.content ?? "",
        model: result.model,
        provider: result.provider,
        layer: result.role ?? role,
        usage: result.usage,
        latencyMs: Date.now() - start,
      };
    } catch (e: any) {
      logger.error(`[Orchestrator] Single execution failed`, e);
      return {
        subTaskId: role,
        content: `Error: ${e.message}`,
        model: "error",
        provider: "error",
        layer: role,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Execute (multi-role): 顺序分配模型，避免不同角色使用同一实例
   */
  private async executeRoles(roles: TaskRole[], messages: ChatMessage[]): Promise<TaskResult[]> {
    const usedModels: string[] = [];
    const results: TaskResult[] = [];

    for (const role of roles) {
      const start = Date.now();
      try {
        const result = await router.executeWithRole(role, messages, { excludeModels: usedModels });
        usedModels.push(result.model);
        results.push({
          subTaskId: role,
          content: result.content ?? "",
          model: result.model,
          provider: result.provider,
          layer: result.role ?? role,
          usage: result.usage,
          latencyMs: Date.now() - start,
        });
      } catch (e: any) {
        logger.error(`[Orchestrator] Role ${role} failed`, e);
        results.push({
          subTaskId: role,
          content: `Error: ${e.message}`,
          model: "error",
          provider: "error",
          layer: role,
          latencyMs: Date.now() - start,
        });
      }
    }
    return results;
  }

  /**
   * Output: 多角色结果汇总（单角色时跳过）
   */
  private async synthesizeAnswer(task: string, results: TaskResult[], history?: ChatMessage[]): Promise<string> {
    const synthesisMessages: ChatMessage[] = [
      {
        role: "system",
        content: "Combine the sub-task results into a coherent final answer.",
      },
      ...(history ?? []),
      {
        role: "user",
        content: `Task: ${task}\n\nResults:\n${results
          .map((r) => `### [${r.layer}] ${r.model}\n${r.content ?? ""}`)
          .join("\n\n")}`,
      },
    ];

    try {
      const result = await router.executeWithRole("decision", synthesisMessages);
      return result.content ?? "Synthesis failed";
    } catch {
      return results.map((r) => r.content).filter(Boolean).join("\n\n---\n\n");
    }
  }

  /**
   * 多Agent并行执行 —— 使用智能任务分配矩阵
   * 
   * 将任务分解为多个角色，每个角色分配最优模型，并行执行。
   * 适用于需要多视角协作的复杂任务（如深度研究、代码审查+重构）。
   */
  async executeMultiAgent(
    task: string,
    roles: TaskRole[],
    opts?: { history?: ChatMessage[]; projectPath?: string }
  ): Promise<OrchestratedResult> {
    const startTime = Date.now();

    // Step 1: 为每个角色构建任务消息
    const assignments: RoleAssignment[] = roles.map((role) => ({
      role,
      messages: [
        {
          role: "system",
          content: `You are a ${role} specialist. Complete the following task to the best of your ability.`,
        },
        ...(opts?.history ?? []),
        { role: "user", content: task },
      ],
    }));

    logger.info("[Orchestrator] Multi-agent parallel execution", {
      roles,
      task: task.slice(0, 100),
    });

    // Step 2: 并行执行所有角色
    const results = await router.batchExecute(assignments);

    const subTaskResults: TaskResult[] = results.map((r, i) => ({
      subTaskId: `agent-${roles[i]}`,
      content: r.content,
      model: r.model,
      provider: r.provider,
      layer: r.role,
      usage: r.usage,
      latencyMs: r.latency_ms ?? 0,
    }));

    const layersUsed = new Set(roles);

    // Step 3: 汇总结果
    const finalAnswer = await this.synthesizeAnswer(task, subTaskResults, opts?.history);

    const totalLatencyMs = Date.now() - startTime;
    const totalTokens = subTaskResults.reduce(
      (sum, r) => sum + (r.usage?.total_tokens ?? 0),
      0
    );

    return {
      finalAnswer,
      subTaskResults,
      totalLatencyMs,
      totalTokens,
      layersUsed: [...layersUsed],
    };
  }

  private extractJson(text: string): any {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch { /* ignore */ }
    }
    return {};
  }
}

export const orchestrator = new TaskOrchestrator();
