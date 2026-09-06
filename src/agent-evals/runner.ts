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
import type { TaskResult, TokenUsage } from "./metrics.js";

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

/**
 * 直连 provider 请求超时（清单②执行错误治理，基线文档结论#3）：默认 180s。
 * 原值 fetch 90s / curl 120s 均低于 sensenova p99≈129s 长尾，长输出任务被传输
 * 超时截断为执行错误（66 任务重跑执行错误 zhipu 1→14、sensenova 9→19）。
 * AGENT_EVALS_TIMEOUT_MS（毫秒）可配置；非法值回退默认，绝不产出 0/负超时。
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

export function resolveRequestTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.AGENT_EVALS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
}

async function runOne(task: AgentTask, options: RunOptions): Promise<TaskResult> {
  const t0 = performance.now();
  let content = "";
  let model = options.modelHint ?? options.model ?? "router-default";
  let tokenUsage: TokenUsage | undefined;
  let costUsd: number | undefined;
  const built = buildSystemPrompt(task, options.injectSkills);
  const systemPrompt = options.constraints ? appendConstraints(built.prompt) : built.prompt;
  const injectedSkillIds = built.injectedSkillIds;
  try {
    if (options.provider) {
      // 免费模型限流 / opencode 网络不稳定：任务间最小间隔 4s（实测连续请求会触发超时）
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await callProviderDirect(options.provider, options.model ?? "", task, model, systemPrompt);
        content = res.content;
        tokenUsage = res.usage;
      } catch (primaryErr) {
        if (options.fallbackProvider) {
          const fbModel = options.fallbackModel ?? options.modelHint ?? options.model ?? "";
          logger.warn(`[AgentEval] primary ${options.provider} failed, fallback to ${options.fallbackProvider}/${fbModel}: ${(primaryErr as Error).message.slice(0, 120)}`);
          await new Promise((res) => setTimeout(res, 2000));
          const res = await callProviderDirect(options.fallbackProvider, fbModel, task, fbModel, systemPrompt);
          content = res.content;
          tokenUsage = res.usage;
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
      const u = result.usage;
      tokenUsage = toTokenUsage(u);
      costUsd = typeof u?.cost_usd === "number" ? u.cost_usd : undefined;
    }
  } catch (err) {
    content = `[ERROR] ${(err as Error).message}`;
  }
  const latencyMs = Math.round(performance.now() - t0);
  const isExecutionError = content.startsWith("[ERROR] ");
  if (isExecutionError) {
    // 执行错误（限流/传输/空内容等 provider 侧故障）≠ 能力失败：跳过关键字验证，
    // 避免 `[ERROR] ...` 字符串被关键字验证器误判为能力缺陷，污染能力基线。
    // 本轮已采集的 token/cost 一并保留（限流前的退避重试同样计费）。
    return {
      taskId: task.id,
      family: task.family,
      split: task.split,
      passed: false,
      reason: content.slice(0, 200),
      latencyMs,
      outputLength: content.length,
      model,
      injectedSkills: injectedSkillIds,
      tokenUsage,
      costUsd,
      executionError: true,
    };
  }
  const verdict = await task.verify(content);
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
    tokenUsage,
    costUsd,
  };
}

/** 评测统一口径：默认每个任务重跑 2 次取最优，消除单样本波动（分数口径稳定可比）。 */
export const DEFAULT_RERUN_EACH = 2;

/** 从多次尝试中取最优：任一通过取首个通过；全失败优先保留真实能力失败
 * （非执行错误），仅在全部尝试都是执行错误时保留首次。 */
export function pickBest(attempts: TaskResult[]): TaskResult {
  return (
    attempts.find((a) => a.passed) ??
    attempts.find((a) => !a.executionError) ??
    attempts[0]
  );
}

/**
 * 自适应重跑：首次尝试即通过则停止（通过即通过，无需再采样），否则跑满 rerunEach 次。
 * 结果与「跑满 rerunEach 次后 pickBest」完全等价——pickBest 取首个通过，首次通过
 * 位置之前/之后的重跑样本都不影响其选择；无通过时两者同样跑满全部尝试。
 * 高通过率轮次（基线为主）省约一半 provider 调用，缩短评测耗时与成本。
 */
export async function rerunAdaptive(runOnce: () => Promise<TaskResult>, rerunEach: number): Promise<TaskResult> {
  const n = Math.max(1, rerunEach);
  const attempts: TaskResult[] = [];
  for (let i = 0; i < n; i++) {
    const attempt = await runOnce();
    attempts.push(attempt);
    if (attempt.passed) break;
  }
  return pickBest(attempts);
}

/** 单任务执行：按 rerunEach 自适应重跑取最优（默认 DEFAULT_RERUN_EACH=2）。 */
async function runOneBest(task: AgentTask, options: RunOptions): Promise<TaskResult> {
  const rerunEach = Math.max(1, options.rerunEach ?? DEFAULT_RERUN_EACH);
  return rerunAdaptive(() => runOne(task, options), rerunEach);
}


/** usage 字段的多形态缓存命中 token（P0-A，字段形态依据 docs/knowledge/prefix-cache-provider-api-2026-09-06.md）：
 * deepseek 系 prompt_cache_hit_tokens 优先 → OpenAI 兼容系 prompt_tokens_details.cached_tokens
 * → 部分 provider 顶层 cached_tokens；缺省/非法值返回 undefined（防御性解析，绝不报错）。 */
function extractCacheHitTokens(u: {
  prompt_cache_hit_tokens?: unknown;
  prompt_tokens_details?: unknown;
  cached_tokens?: unknown;
}): number | undefined {
  if (typeof u.prompt_cache_hit_tokens === "number" && Number.isFinite(u.prompt_cache_hit_tokens)) {
    return u.prompt_cache_hit_tokens;
  }
  if (u.prompt_tokens_details && typeof u.prompt_tokens_details === "object") {
    const cached = (u.prompt_tokens_details as { cached_tokens?: unknown }).cached_tokens;
    if (typeof cached === "number" && Number.isFinite(cached)) return cached;
  }
  if (typeof u.cached_tokens === "number" && Number.isFinite(u.cached_tokens)) return u.cached_tokens;
  return undefined;
}

/** snake_case usage 字段 → camelCase TokenUsage；缺字段保留可用字段，全缺/非对象返回 undefined。 */
function toTokenUsage(
  u: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    prompt_tokens_details?: unknown;
    cached_tokens?: unknown;
  }
  | undefined,
): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const usage: TokenUsage = {};
  if (typeof u.prompt_tokens === "number" && Number.isFinite(u.prompt_tokens)) usage.promptTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === "number" && Number.isFinite(u.completion_tokens)) usage.completionTokens = u.completion_tokens;
  if (typeof u.total_tokens === "number" && Number.isFinite(u.total_tokens)) usage.totalTokens = u.total_tokens;
  const cacheHitTokens = extractCacheHitTokens(u);
  if (cacheHitTokens !== undefined) usage.cacheHitTokens = cacheHitTokens;
  return usage;
}

/** OpenAI 兼容 /chat/completions 响应体的 usage 字段解析（prompt/completion/total_tokens +
 * 多形态缓存命中 token，缺字段保留可用字段）；非法 JSON 或无 usage 返回 undefined（不阻断评测）。
 * 直连路径无成本字段，成本按 token 数展示，不产出 costUsd。 */
export function parseProviderUsage(body: string): TokenUsage | undefined {
  try {
    const data = JSON.parse(body) as {
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        prompt_cache_hit_tokens?: unknown;
        prompt_tokens_details?: unknown;
        cached_tokens?: unknown;
      };
    };
    return toTokenUsage(data.usage);
  } catch {
    return undefined;
  }
}

/** 直连 provider 调用（OpenAI 兼容协议）：
 * 传输层/429/5xx 退避重试 3 次（5s/10s/10s 封顶）；200 但 content 为空时升级 max_tokens 再试一次
 * （deepseek-v4-flash 隐藏推理会吃光小预算导致空回答，实测 4096 可完成推理并输出内容）。
 * usage 取「最终被采用那次调用」的（非空 content 所在那次的用量）。 */
async function callProviderDirect(
  provider: string,
  model: string,
  task: AgentTask,
  label: string,
  systemPrompt?: string,
): Promise<{ content: string; usage?: TokenUsage }> {
  const cfg = getProviderConfig(provider);
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  const apiKey = readString(cfg.apiKeyEnv);
  // deepseek-v4-flash 隐藏推理会吃光小预算导致空回答（finish_reason=length + content=""）：
  // 预算下限提到 4096（简单任务仍会提前 stop，不影响速度）；仍空则升级 8192 兜底
  const baseBudget = Math.max(task.maxTokens ?? 512, 4096);
  const budgets = [baseBudget, 8192];
  for (const maxTokens of budgets) {
    const res = await callProviderWithBudget(provider, cfg, apiKey, model, task, label, systemPrompt, maxTokens);
    if (res.content.trim().length > 0) return res;
    if (maxTokens === budgets[budgets.length - 1]) break;
    logger.warn(`[AgentEval] ${label} empty content (hidden reasoning likely consumed budget), retry with max_tokens=${maxTokens} -> ${budgets[budgets.length - 1]}`);
  }
  throw new Error(`${provider} empty content after retries`);
}

/** 单预算下的 provider 调用：429/5xx/传输层退避重试 3 次，返回 content（可能为空）+ usage。
 * 响应体只解析一次 JSON：content 与 usage 共用同一次 parse 结果。 */
async function callProviderWithBudget(
  provider: string,
  cfg: { baseURL: string; apiKeyEnv: string },
  apiKey: string,
  model: string,
  task: AgentTask,
  label: string,
  systemPrompt: string | undefined,
  maxTokens: number,
): Promise<{ content: string; usage?: TokenUsage }> {
  const useCurl = provider === "opencode"; // Bun fetch/proxyFetch 无法直连 opencode.ai，仅 curl 可达
  // 限流退避封顶：5s/10s/10s × 3 次（原 5/10/20/40/80s 会让评测无限磨）；有 fallback 时快速失败让位
  for (let attempt = 0; attempt < 3; attempt++) {
    let status: number;
    let body: string;
    try {
      const res = useCurl
        ? await callWithCurl(cfg.baseURL, apiKey, model, task, systemPrompt, maxTokens)
        : await callWithProxy(cfg.baseURL, apiKey, provider, model, task, systemPrompt, maxTokens);
      status = res.status;
      body = res.body;
    } catch (err) {
      // 传输层错误（连接重置/超时/解析失败）与 5xx 同等重试：否则 curl 断连直接变成 [ERROR] 内容
      const delayMs = Math.min(5000 * Math.pow(2, attempt), 10000);
      logger.warn(`[AgentEval] ${label} transport error (${(err as Error).message.slice(0, 120)}), retry in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (status === 429 || status >= 500) {
      const delayMs = Math.min(5000 * Math.pow(2, attempt), 10000);
      logger.warn(`[AgentEval] ${label} rate-limited (${status}), retry in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (status >= 400) {
      throw new Error(`${provider} returned ${status}: ${body.slice(0, 200)}`);
    }
    const data = JSON.parse(body) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    return { content: data.choices?.[0]?.message?.content ?? "", usage: toTokenUsage(data.usage) };
  }
  throw new Error(`${provider} failed after retries`);
}


/** proxyFetch 路径（zhipu 等可达 provider），返回 status + body。 */
async function callWithProxy(
  baseURL: string,
  apiKey: string,
  provider: string,
  model: string,
  task: AgentTask,
  systemPrompt?: string,
  maxTokens = task.maxTokens ?? 512,
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
      max_tokens: maxTokens,
      temperature: 0.2,
      // GLM 推理模型默认强制思考（content 为空），评测场景禁用思考以获得直接答案
      ...(provider === "zhipu" ? { thinking: { type: "disabled" } } : {}),
    }),
    signal: AbortSignal.timeout(resolveRequestTimeoutMs()),
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
  maxTokens = task.maxTokens ?? 512,
): Promise<{ status: number; body: string }> {
  const messages = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    { role: "user" as const, content: task.prompt },
  ];
  const payload = JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    thinking: { type: "disabled" }, // deepseek-v4-flash 推理模型：禁用思考以获得直接回答
  });
  const tmpFile = path.join(os.tmpdir(), `agent-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, payload, "utf8");
  try {
    const proc = spawnSync(
      ["curl.exe", "-sS", "--connect-timeout", "15", "-m", String(Math.round(resolveRequestTimeoutMs() / 1000)), "-X", "POST",
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
