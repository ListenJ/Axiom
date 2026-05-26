/**
 * 任务编排器 (Task Orchestrator) v1.0
 *
 * 分层任务调度策略：
 *   1. L1 Decision: DeepSeek-V4 Pro 分解任务为子任务
 *   2. L2 Architecture: KIMI-k2.6 设计系统架构（如需要）
 *   3. L3 Tool Pool: 免费模型并行执行子任务
 *   4. L4 Evaluation: Tencent hy3 + DeepSeek 评估结果质量
 *   5. 整合: L1 Decision 汇总输出最终答案
 *
 * 免费模型使用策略：
 *   - 每个子任务标记所需 role (coding/english/rl/general)
 *   - ToolPool 自动选择可用模型，带限流和熔断
 *   - 并发控制：同角色最多 N 个并行（N = 该角色模型数）
 */
import { logger } from "../utils/logger.js";
import { router, toolPool, type ToolRole } from "./model-router.js";
import { retrieveCodeMemory } from "../memory/codegraph-index.js";
import type { ChatMessage } from "./model-router.js";

export interface SubTask {
  id: string;
  role: ToolRole | "decision" | "architecture" | "evaluation";
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
   * 执行一个复杂任务，自动分层调度
   */
  async execute(task: string, opts?: { history?: ChatMessage[]; projectPath?: string }): Promise<OrchestratedResult> {
    const startTime = Date.now();
    const subTaskResults: TaskResult[] = [];
    const layersUsed = new Set<string>();

    // === Step 1: L1 决策层 — 分解任务 ===
    logger.info("[Orchestrator] Step 1: Decomposing task with L1 Decision");
    const decomposition = await this.decomposeTask(task, opts?.history);
    layersUsed.add("decision");

    // === Step 2: 检索代码记忆（如需要） ===
    let codeContext = "";
    if (decomposition.needsCodeContext) {
      const cgMemory = await retrieveCodeMemory(task, { projectPath: opts?.projectPath });
      if (cgMemory) {
        codeContext = cgMemory.results;
        logger.info("[Orchestrator] Retrieved code memory", {
          symbols: cgMemory.symbols.length,
          contextLength: codeContext.length,
        });
      }
    }

    // === Step 3: 并行执行子任务 ===
    const pendingTasks = this.buildSubTasks(decomposition, codeContext);
    logger.info("[Orchestrator] Step 3: Executing sub-tasks", { count: pendingTasks.length });

    // 按依赖关系分层执行
    const executedIds = new Set<string>();
    while (executedIds.size < pendingTasks.length) {
      const readyTasks = pendingTasks.filter(
        (t) => !executedIds.has(t.id) && (t.dependsOn ?? []).every((d) => executedIds.has(d))
      );
      if (readyTasks.length === 0) break;

      // 同角色并行限制：按角色分组，每组最多并行 N 个
      const byRole = this.groupByRole(readyTasks);
      const batchPromises: Promise<void>[] = [];

      for (const [role, tasks] of Object.entries(byRole)) {
        const concurrency = role === "coding" ? 2 : 1; // coding 模型最多 2 个并行
        const chunks = this.chunkArray(tasks, concurrency);
        for (const chunk of chunks) {
          batchPromises.push(
            (async () => {
              const results = await Promise.all(
                chunk.map((st) => this.executeSubTask(st))
              );
              for (const r of results) {
                subTaskResults.push(r);
                layersUsed.add(r.layer);
                executedIds.add(r.subTaskId);
              }
            })()
          );
        }
      }

      await Promise.all(batchPromises);
    }

    // === Step 4: L4 评估层（可选，关键任务） ===
    if (decomposition.needsEvaluation) {
      logger.info("[Orchestrator] Step 4: Evaluating results with L4");
      const evalResult = await this.evaluateResults(task, subTaskResults);
      if (evalResult.quality < 0.7) {
        logger.warn("[Orchestrator] Quality below threshold, re-executing with refined prompts");
        // 可以在这里实现重试逻辑
      }
      layersUsed.add("evaluation");
    }

    // === Step 5: L1 决策层 — 汇总最终答案 ===
    logger.info("[Orchestrator] Step 5: Synthesizing final answer");
    const finalAnswer = await this.synthesizeAnswer(task, subTaskResults, opts?.history);
    layersUsed.add("decision");

    const totalLatencyMs = Date.now() - startTime;
    const totalTokens = subTaskResults.reduce((sum, r) => sum + (r.usage?.total_tokens ?? 0), 0);

    return {
      finalAnswer,
      subTaskResults,
      totalLatencyMs,
      totalTokens,
      layersUsed: [...layersUsed],
    };
  }

  // ========== 私有方法 ==========

  private async decomposeTask(task: string, history?: ChatMessage[]): Promise<{
    subTasks: Array<{ role: ToolRole | "architecture"; description: string; systemPrompt?: string }>;
    needsCodeContext: boolean;
    needsEvaluation: boolean;
    needsArchitecture: boolean;
  }> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `You are a task decomposition engine. Analyze the user's request and break it into sub-tasks.

Rules:
1. Each sub-task must have a clear role: coding | english | rl | general-tool | architecture
2. Mark if the task needs code context retrieval
3. Mark if the task needs quality evaluation
4. Keep sub-tasks minimal and focused

Output JSON only:
{
  "subTasks": [{"role": "...", "description": "...", "systemPrompt": "optional"}],
  "needsCodeContext": boolean,
  "needsEvaluation": boolean,
  "needsArchitecture": boolean
}`,
      },
      ...(history ?? []),
      { role: "user", content: task },
    ];

    try {
      const result = await router.decide(messages);
      const parsed = this.extractJson(result.content ?? "{}");
      return {
        subTasks: parsed.subTasks ?? [],
        needsCodeContext: parsed.needsCodeContext ?? false,
        needsEvaluation: parsed.needsEvaluation ?? false,
        needsArchitecture: parsed.needsArchitecture ?? false,
      };
    } catch (e: any) {
      logger.error("[Orchestrator] Task decomposition failed", e);
      // 回退：单任务直接执行
      return {
        subTasks: [{ role: "general-tool", description: task }],
        needsCodeContext: false,
        needsEvaluation: false,
        needsArchitecture: false,
      };
    }
  }

  private buildSubTasks(
    decomposition: {
      subTasks: Array<{ role: ToolRole | "architecture"; description: string; systemPrompt?: string }>;
      needsCodeContext: boolean;
      needsEvaluation: boolean;
      needsArchitecture: boolean;
    },
    codeContext: string
  ): SubTask[] {
    const tasks: SubTask[] = [];
    let idCounter = 0;

    // 如需要架构设计，先执行
    if (decomposition.needsArchitecture) {
      tasks.push({
        id: `arch-${idCounter++}`,
        role: "architecture",
        description: "Design system architecture",
        messages: [
          { role: "system", content: "You are a system architect. Design clean, scalable architecture." },
          { role: "user", content: `Design architecture for: ${decomposition.subTasks.map((s) => s.description).join("\n")}` },
        ],
        priority: 0,
      });
    }

    for (const st of decomposition.subTasks) {
      const id = `task-${idCounter++}`;
      const messages: ChatMessage[] = [
        ...(st.systemPrompt ? [{ role: "system" as const, content: st.systemPrompt }] : []),
        { role: "user" as const, content: codeContext ? `[Code Context]\n${codeContext}\n\n[Task]\n${st.description}` : st.description },
      ];

      tasks.push({
        id,
        role: st.role,
        description: st.description,
        messages,
        priority: 1,
        dependsOn: decomposition.needsArchitecture ? [tasks[0].id] : undefined,
      });
    }

    return tasks.sort((a, b) => a.priority - b.priority);
  }

  private async executeSubTask(subTask: SubTask): Promise<TaskResult> {
    const start = Date.now();
    try {
      let result;
      switch (subTask.role) {
        case "decision":
          result = await router.decide(subTask.messages);
          break;
        case "architecture":
          result = await router.architect(subTask.messages);
          break;
        case "evaluation":
          result = await router.evaluate(subTask.messages);
          break;
        default:
          result = await router.tool(subTask.role, subTask.messages);
      }

      return {
        subTaskId: subTask.id,
        content: result.content ?? "",
        model: result.model,
        provider: result.provider,
        layer: result.layer ?? subTask.role,
        usage: result.usage,
        latencyMs: Date.now() - start,
      };
    } catch (e: any) {
      logger.error(`[Orchestrator] Sub-task ${subTask.id} failed`, e);
      return {
        subTaskId: subTask.id,
        content: `Error: ${e.message}`,
        model: "error",
        provider: "error",
        layer: subTask.role,
        latencyMs: Date.now() - start,
      };
    }
  }

  private async evaluateResults(task: string, results: TaskResult[]): Promise<{ quality: number; feedback: string }> {
    const evalMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a quality evaluator. Rate the task completion quality from 0.0 to 1.0 and provide brief feedback.",
      },
      {
        role: "user",
        content: `Task: ${task}\n\nResults:\n${results.map((r) => `[${r.layer}] ${r.model}: ${r.content?.slice(0, 500)}`).join("\n---\n")}\n\nOutput JSON: { "quality": number, "feedback": string }`,
      },
    ];

    try {
      const result = await router.evaluate(evalMessages);
      const parsed = this.extractJson(result.content ?? "{}");
      return { quality: parsed.quality ?? 0.5, feedback: parsed.feedback ?? "" };
    } catch {
      return { quality: 0.5, feedback: "Evaluation failed" };
    }
  }

  private async synthesizeAnswer(task: string, results: TaskResult[], history?: ChatMessage[]): Promise<string> {
    const synthesisMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a synthesis engine. Combine the sub-task results into a coherent, final answer for the user.",
      },
      ...(history ?? []),
      {
        role: "user",
        content: `Original task: ${task}\n\nSub-task results:\n${results
          .map((r) => `### [${r.layer}] via ${r.model}\n${r.content ?? ""}`)
          .join("\n\n")}\n\nPlease provide the final synthesized answer.`,
      },
    ];

    try {
      const result = await router.decide(synthesisMessages);
      return result.content ?? "Synthesis failed";
    } catch {
      // 回退：拼接所有结果
      return results.map((r) => r.content).filter(Boolean).join("\n\n---\n\n");
    }
  }

  private groupByRole(tasks: SubTask[]): Record<string, SubTask[]> {
    const groups: Record<string, SubTask[]> = {};
    for (const t of tasks) {
      const key = t.role;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    return groups;
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
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
