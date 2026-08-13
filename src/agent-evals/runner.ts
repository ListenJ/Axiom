/**
 * Agent 评测执行器 — 通过 internalAgent 调用用户配置的模型执行任务，
 * 收集通过/失败、延迟、输出长度（不依赖任何硬编码模型/密钥）。
 */
import { spawnSync } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { internalAgent } from "../agents/internal-agent.js";
import { getProviderConfig } from "../utils/api-key-store.js";
import { loadSkillsFromDirectories, clearSkillCache } from "../skills/skill-loader.js";
import { DEFAULT_SKILL_DIRS } from "../skills/types.js";
import { getDefaultQualityTracker } from "../self-evolve/skill-quality.js";
import { getDefaultGainTracker } from "./skill-gain.js";
import { proxyFetch } from "../utils/proxy-fetch.js";
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
  /** 注入已归纳的 auto-induce-* 技能到 systemPrompt（评测→进化闭环验证） */
  injectSkills?: boolean;
}

async function runOne(task: AgentTask, options: RunOptions): Promise<TaskResult> {
  const t0 = performance.now();
  let content = "";
  let model = options.modelHint ?? options.model ?? "router-default";
  const { prompt: systemPrompt, injectedSkillIds } = buildSystemPrompt(task, options.injectSkills);
  try {
    if (options.provider) {
      // 免费模型限流 / opencode 网络不稳定：任务间最小间隔 4s（实测连续请求会触发超时）
      await new Promise((r) => setTimeout(r, 4000));
      content = await callProviderDirect(options.provider, options.model ?? "", task, model, systemPrompt);
    } else {
      const result = await internalAgent.executeWithRole(
        "general-chat",
        [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
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
    injectedSkills: injectedSkillIds,
  };
}


/** 直连 provider 调用（OpenAI 兼容协议），429/5xx 退避重试 3 次（2s/4s/8s）。 */
async function callProviderDirect(
  provider: string,
  model: string,
  task: AgentTask,
  label: string,
  systemPrompt?: string,
): Promise<string> {
  const cfg = getProviderConfig(provider);
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  const apiKey = readString(cfg.apiKeyEnv);
  const messages = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    { role: "user" as const, content: task.prompt },
  ];
  const useCurl = provider === "opencode"; // Bun fetch/proxyFetch 无法直连 opencode.ai，仅 curl 可达
  for (let attempt = 0; attempt < 5; attempt++) {
    const { status, body } = useCurl
      ? await callWithCurl(cfg.baseURL, apiKey, model, task, systemPrompt)
      : await callWithProxy(cfg.baseURL, apiKey, provider, model, task, systemPrompt);
    if (status === 429 || status >= 500) {
      const delayMs = 5000 * Math.pow(2, attempt);
      logger.warn(`[AgentEval] ${label} rate-limited (${status}), retry in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (status >= 400) {
      throw new Error(`${provider} returned ${status}: ${body.slice(0, 200)}`);
    }
    const data = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }
  throw new Error(`${provider} rate-limited after retries`);
}


/** proxyFetch 路径（zhipu 等可达 provider），返回 status + body。 */
async function callWithProxy(
  baseURL: string,
  apiKey: string,
  provider: string,
  model: string,
  task: AgentTask,
  systemPrompt?: string,
): Promise<{ status: number; body: string }> {
  const res = await proxyFetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        { role: "user" as const, content: task.prompt },
      ],
      max_tokens: task.maxTokens ?? 512,
      temperature: 0.2,
      // GLM 推理模型默认强制思考（content 为空），评测场景禁用思考以获得直接答案
      ...(provider === "zhipu" ? { thinking: { type: "disabled" } } : {}),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  return { status: res.status, body: await res.text().catch(() => "") };
}

/** curl 路径（opencode.ai 仅 curl 可达）：返回 status + body。 */
async function callWithCurl(
  baseURL: string,
  apiKey: string,
  model: string,
  task: AgentTask,
  systemPrompt?: string,
): Promise<{ status: number; body: string }> {
  const messages = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    { role: "user" as const, content: task.prompt },
  ];
  const payload = JSON.stringify({
    model,
    messages,
    max_tokens: task.maxTokens ?? 512,
    temperature: 0.2,
    thinking: { type: "disabled" }, // deepseek-v4-flash 推理模型：禁用思考以获得直接回答
  });
  const tmpFile = path.join(os.tmpdir(), `agent-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, payload, "utf8");
  try {
    const proc = spawnSync(
      ["curl.exe", "-sS", "-m", "180", "-X", "POST",
        `${baseURL.replace(/\/$/, "")}/chat/completions`,
        "-H", "Content-Type: application/json",
        "-H", `Authorization: Bearer ${apiKey}`,
        "--data", `@${tmpFile}`,
        "-w", "\n%{http_code}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    if (proc.exitCode !== 0) {
      throw new Error(`curl failed (${proc.exitCode}): ${stderr.slice(0, 200)}`);
    }
    const parts = stdout.trimEnd().split("\n");
    const status = Number(parts.pop());
    return { status: Number.isFinite(status) ? status : 0, body: parts.join("\n") };
  } finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  }
}


/** 注入已归纳的技能到 systemPrompt（无技能时保持原样）。
 * 门控：auto-fix-<family>-* 只注入给同任务族；auto-induce-* 全量；
 * 质量门控：deprecated 技能不注入；增益门控：经验证负增益的技能不注入。
 * 返回注入的技能 id 列表（供增益反馈记录）。 */
function buildSystemPrompt(task: AgentTask, injectSkills?: boolean): { prompt: string | undefined; injectedSkillIds: string[] } {
  const base = task.systemPrompt;
  if (!injectSkills) return { prompt: base, injectedSkillIds: [] };
  try {
    clearSkillCache();
    const loaded = loadSkillsFromDirectories({ skillDirs: [...DEFAULT_SKILL_DIRS] }, true);
    const quality = getDefaultQualityTracker();
    const gain = getDefaultGainTracker();
    const skills = [...loaded.skills.values()].filter((s) => {
      if (s.id.startsWith("auto-fix-")) {
        // 方法论技能只注入开发类任务族（coding/planning/tool-use）；
        // 知识问答/记忆/反思类直接回答更优，方法论框架反而干扰（实测 KNOW/PLAN 失败）
        if (!["coding", "planning", "tool-use"].includes(task.family)) return false;
        if (!s.id.startsWith(`auto-fix-${task.family}-`)) return false;
      } else if (!s.id.startsWith("auto-induce-")) {
        return false;
      }
      // 质量门控：deprecated 技能不再注入
      if (quality.getSkillQuality(s.id)?.deprecated) return false;
      // 增益门控：仅严格正增益（样本≥3）注入
      if (!gain.shouldInject(s.id, task.family)) return false;
      return true;
    });
    if (skills.length === 0) return { prompt: base, injectedSkillIds: [] };
    const lines = skills.map((s) => `- ${s.name}：${s.description.split("\n")[0]}`);
    return {
      prompt: [
        base,
        "（以下为可能与当前任务相关的经验要点；仅当适用时参考，不要改变回答结构与风格。）",
        ...lines,
      ].filter(Boolean).join("\n\n"),
      injectedSkillIds: skills.map((s) => s.id),
    };
  } catch {
    return { prompt: base, injectedSkillIds: [] };
  }
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
