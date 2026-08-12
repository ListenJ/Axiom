/**
 * Agent 评测执行器 — 通过 internalAgent 调用用户配置的模型执行任务，
 * 收集通过/失败、延迟、输出长度（不依赖任何硬编码模型/密钥）。
 */
import { internalAgent } from "../agents/internal-agent.js";
import { getProviderConfig } from "../utils/api-key-store.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import type { AgentTask } from "./tasks.js";
import type { TaskResult } from "./metrics.js";

export interface RunOptions {
  family?: AgentTask["family"];
  split?: AgentTask["split"];
  concurrency?: number;
  modelHint?: string;
  /** 直连 provider（如 zhipu）：绕过 model-router，使用用户 .env 中的 key（评测不依赖路由配置） */
  provider?: string;
  /** 直连模型 id（如 glm-4.7-flash），需配合 provider 使用 */
  model?: string;
}

async function runOne(task: AgentTask, options: RunOptions): Promise<TaskResult> {
  const t0 = performance.now();
  let content = "";
  let model = options.modelHint ?? options.model ?? "router-default";
  try {
    if (options.provider) {
      // 免费模型限流友好：任务间最小间隔
      await new Promise((r) => setTimeout(r, 1000));
      content = await callProviderDirect(options.provider, options.model ?? "", task, model);
    } else {
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
        },
      );
      content = result.content || "";
      if (result.model) model = result.model;
    }
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


/** 直连 provider 调用（OpenAI 兼容协议），429/5xx 退避重试 3 次（2s/4s/8s）。 */
async function callProviderDirect(
  provider: string,
  model: string,
  task: AgentTask,
  label: string,
): Promise<string> {
  const cfg = getProviderConfig(provider);
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  const apiKey = readString(cfg.apiKeyEnv);
  const messages = [
    ...(task.systemPrompt ? [{ role: "system" as const, content: task.systemPrompt }] : []),
    { role: "user" as const, content: task.prompt },
  ];
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: task.maxTokens ?? 512,
        temperature: 0.2,
        // GLM 推理模型默认强制思考（content 为空），评测场景禁用思考以获得直接答案
        ...(provider === "zhipu" ? { thinking: { type: "disabled" } } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status === 429 || res.status >= 500) {
      const delayMs = 3000 * Math.pow(2, attempt);
      logger.warn(`[AgentEval] ${label} rate-limited (${res.status}), retry in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      throw new Error(`${provider} returned ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }
  throw new Error(`${provider} rate-limited after 3 retries`);
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
      results.push(await runOne(task, options));
    }
  });
  await Promise.all(workers);
  // 保持输入顺序，便于报告
  const order = new Map(tasks.map((task, i) => [task.id, i]));
  results.sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0));
  return results;
}
