/**
 * Agent 评测执行器 — 通过 internalAgent 调用用户配置的模型执行任务，
 * 收集通过/失败、延迟、输出长度（不依赖任何硬编码模型/密钥）。
 */
import { internalAgent } from "../agents/internal-agent.js";
import type { AgentTask } from "./tasks.js";
import type { TaskResult } from "./metrics.js";

export interface RunOptions {
  family?: AgentTask["family"];
  split?: AgentTask["split"];
  concurrency?: number;
  modelHint?: string;
}

async function runOne(task: AgentTask, modelHint?: string): Promise<TaskResult> {
  const t0 = performance.now();
  let content = "";
  let model = modelHint ?? "router-default";
  try {
    const result = await internalAgent.executeWithRole(
      "general-chat",
      [
        ...(task.systemPrompt ? [{ role: "system" as const, content: task.systemPrompt }] : []),
        { role: "user" as const, content: task.prompt },
      ],
      {
        maxTokens: task.maxTokens ?? 512,
        temperature: 0.2,
        timeout: 60_000,
        ...(modelHint ? { model: modelHint } : {}),
      },
    );
    content = result.content || "";
    if (result.model) model = result.model;
  } catch (err) {
    content = `[ERROR] ${(err as Error).message}`;
  }
  const latencyMs = Math.round(performance.now() - t0);
  const verdict = task.verify(content);
  return {
    taskId: task.id,
    family: task.family,
    split: task.split,
    passed: verdict.passed,
    reason: verdict.passed ? undefined : verdict.reason ?? content.slice(0, 200),
    latencyMs,
    outputLength: content.length,
    model,
  };
}

export async function runTasks(tasks: AgentTask[], options: RunOptions = {}): Promise<TaskResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const results: TaskResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const idx = cursor++;
      const task = tasks[idx];
      if (!task) continue;
      results.push(await runOne(task, options.modelHint));
    }
  });
  await Promise.all(workers);
  // 保持输入顺序，便于报告
  const order = new Map(tasks.map((task, i) => [task.id, i]));
  results.sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0));
  return results;
}
