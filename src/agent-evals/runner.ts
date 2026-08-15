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
import type { AgentTask, TaskFamily } from "./tasks.js";
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
  /** 主 provider 限流/失败时的备用 provider（配合 fallbackModel） */
  fallbackProvider?: string;
  /** 备用模型（配合 fallbackProvider） */
  fallbackModel?: string;
  /** 注入已归纳的 auto-induce-* 技能到 systemPrompt（评测→进化闭环验证） */
  injectSkills?: boolean;
  /** 附加通用回答约束（完整性/直接性/复杂度标定）——集成化实验：整体补齐短板 */
  constraints?: boolean;
  /** 每个任务重跑 N 次取最优（消除单样本波动，默认 1） */
  rerunEach?: number;
}

async function runOne(task: AgentTask, options: RunOptions): Promise<TaskResult> {
  const t0 = performance.now();
  let content = "";
  let model = options.modelHint ?? options.model ?? "router-default";
  const built = buildSystemPrompt(task, options.injectSkills);
  const systemPrompt = options.constraints ? appendConstraints(built.prompt) : built.prompt;
  const injectedSkillIds = built.injectedSkillIds;
  try {
    if (options.provider) {
      // 免费模型限流 / opencode 网络不稳定：任务间最小间隔 4s（实测连续请求会触发超时）
      await new Promise((r) => setTimeout(r, 4000));
      try {
        content = await callProviderDirect(options.provider, options.model ?? "", task, model, systemPrompt);
      } catch (primaryErr) {
        if (options.fallbackProvider) {
          const fbModel = options.fallbackModel ?? options.modelHint ?? options.model ?? "";
          logger.warn(`[AgentEval] primary ${options.provider} failed, fallback to ${options.fallbackProvider}/${fbModel}: ${(primaryErr as Error).message.slice(0, 120)}`);
          await new Promise((res) => setTimeout(res, 2000));
          content = await callProviderDirect(options.fallbackProvider, fbModel, task, fbModel, systemPrompt);
          model = fbModel;
        } else {
          throw primaryErr;
        }
      }
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

/** 单任务执行：rerunEach>1 时重跑取最优（任一通过即取该次，否则保留首次结果/失败原因），消除单样本波动。 */
async function runOneBest(task: AgentTask, options: RunOptions): Promise<TaskResult> {
  const rerunEach = Math.max(1, options.rerunEach ?? 1);
  let first: TaskResult | undefined;
  for (let i = 0; i < rerunEach; i++) {
    const r = await runOne(task, options);
    first ??= r;
    if (r.passed) return r;
  }
  return first!;
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
  // 限流退避封顶：5s/10s/10s × 3 次（原 5/10/20/40/80s 会让评测无限磨）；有 fallback 时快速失败让位
  for (let attempt = 0; attempt < 3; attempt++) {
    const { status, body } = useCurl
      ? await callWithCurl(cfg.baseURL, apiKey, model, task, systemPrompt)
      : await callWithProxy(cfg.baseURL, apiKey, provider, model, task, systemPrompt);
    if (status === 429 || status >= 500) {
      const delayMs = Math.min(5000 * Math.pow(2, attempt), 10000);
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
      ["curl.exe", "-sS", "--connect-timeout", "15", "-m", "120", "-X", "POST",
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


/** 注入已归纳的技能到 systemPrompt（无技能时保持原样；overrides 供测试注入门控）。
 * 门控：auto-fix-<family>-* 只注入给同任务族；auto-induce-* 全量；
 * 质量门控：deprecated 技能不注入；增益门控：经验证负增益的技能不注入。
 * 返回注入的技能 id 列表（供增益反馈记录）。 */
export function buildSystemPrompt(
  task: AgentTask,
  injectSkills?: boolean,
  overrides?: {
    gain?: { shouldInject(skillId: string, family: TaskFamily): boolean };
    quality?: { getSkillQuality(skillId: string): { deprecated?: boolean } | undefined };
  },
): { prompt: string | undefined; injectedSkillIds: string[] } {
  const base = task.systemPrompt;
  if (!injectSkills) return { prompt: base, injectedSkillIds: [] };
  try {
    clearSkillCache();
    const loaded = loadSkillsFromDirectories({ skillDirs: [...DEFAULT_SKILL_DIRS] }, true);
    const quality = overrides?.quality ?? getDefaultQualityTracker();
    const gain = overrides?.gain ?? getDefaultGainTracker();
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


/** 通用回答约束（中性、不引入方法论框架，避免干扰问答类任务） */
const GENERIC_CONSTRAINTS = [
  "回答要求（通用）：",
  "1. 完整覆盖任务要求的所有要点，逐项给出明确内容，不省略关键概念；",
  "2. 直接给出答案/实现/步骤；涉及实现时明确标定实现目标、时间复杂度与空间复杂度；",
  "3. 任务要求多步时，按顺序完整列出，不跳过任何一步；",
  "4. 不确定的信息明确标注，不编造。",
].join("\n");

function appendConstraints(prompt: string | undefined): string {
  return [prompt, GENERIC_CONSTRAINTS].filter(Boolean).join("\n\n");
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
      results.push(await runOneBest(task, options));
    }
  });
  await Promise.all(workers);
  // 保持输入顺序，便于报告
  const order = new Map(tasks.map((task, i) => [task.id, i]));
  results.sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0));
  return results;
}
