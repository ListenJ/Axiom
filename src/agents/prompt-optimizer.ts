/**
 * 提示词优化器 v2.0 —— GLM-4.7-flash 驱动 + Skill 专家增强 + 三重闸门
 *
 * 引擎演进（2026-07-25 用户决策）：
 *   - v1.x 边缘小模型改写：MiniCPM5-1B 漂移、Qwopus3.5-2B 照抄，实测不达标
 *   - v2.0 起改写/忠实度判别改由 GLM-4.7-flash 承担（zhipu 直连 → siliconflow 免费版兜底）
 *   - 边缘 2B 保留为工具模型：意图分类 / 风险初筛 / 记忆辅助 / 知识库整理
 *
 * 流程：
 *   1. 跳过规则（短输入/代码块/命令前缀/开关关闭）
 *   2. 结果缓存查询（相同输入命中直接复用，跳过 GLM 改写与判别）
 *   3. 意图策略识别（纯函数：code/analysis/writing/translation/general）
 *   4. Skill 匹配（agency-zh 专家角色库 + Hermes 自进化 skills，命中则以其工作流为框架）
 *   5. GLM 改写（保持原意与原语言，按策略追加针对性规则）
 *   6. 三重闸门：输出校验 → 语言一致性（确定性）→ GLM 忠实度判别
 *   任一环节失败即回退原文，绝不外发漂移文本；全通过结果才写入缓存
 *
 * 开关：PROMPT_REWRITE=0 关闭（兼容旧开关 EDGE_PROMPT_REWRITE=0）
 */

import { callProvider } from "../router/provider-caller.js";
import { getPromptEngineer } from "./prompt-engineer.js";
import { logger } from "../utils/logger.js";
import { readInt, readString } from "../utils/env.js";
import { Cache } from "../utils/cache.js";
import { createHash } from "crypto";

export interface PromptOptimization {
  /** 优化后文本（未优化时为原文） */
  text: string;
  /** 是否发生了改写 */
  changed: boolean;
}

/** 优化器累计指标（进程内，供观测与测试） */
export interface PromptOptimizerMetrics {
  calls: number;
  skipped: number;
  cacheHits: number;
  cacheMisses: number;
  rewritten: number;
  gateFailures: {
    output: number;
    language: number;
    fidelity: number;
  };
}

/** 意图策略名 */
export type OptimizationStrategy = "code" | "analysis" | "writing" | "translation" | "general";

/** 低于此长度不做优化（短输入没有优化空间） */
const MIN_INPUT_CHARS = 20;

/** 超长输入截断（改写不需要全量上下文，防止恶意消耗）；可用 PROMPT_OPTIMIZER_MAX_INPUT_CHARS 覆盖 */
const MAX_INPUT_CHARS = (() => {
  const raw = readString("PROMPT_OPTIMIZER_MAX_INPUT_CHARS", "2000");
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();

/** 输出长度上限系数：超过 输入*3+200 视为异常膨胀 */
const MAX_OUTPUT_RATIO = 3;

/** GLM 调用超时（改写/判别共用） */
const GLM_TIMEOUT_MS = 15_000;

/** GLM 免费链：zhipu 直连优先，siliconflow 免费版兜底（2026-07-26 实测修正：siliconflow 无 4.7-Flash，用 THUDM/GLM-4-9B） */
const GLM_CHAIN: Array<{ provider: string; model: string }> = [
  { provider: readString("PROMPT_OPTIMIZER_PROVIDER", "zhipu"), model: readString("PROMPT_OPTIMIZER_MODEL", "glm-4.7-flash") },
  { provider: readString("PROMPT_OPTIMIZER_FALLBACK_PROVIDER", "siliconflow"), model: readString("PROMPT_OPTIMIZER_FALLBACK_MODEL", "THUDM/GLM-4-9B-0414") },
];

/** 进程内 LRU 缓存：仅三重闸门全通过的结果写入；TTL 可用 PROMPT_OPTIMIZER_CACHE_TTL_MS 覆盖 */
const optimizerCache = new Cache<string>({
  namespace: "prompt-opt",
  maxSize: 200,
  defaultTtlMs: readInt("PROMPT_OPTIMIZER_CACHE_TTL_MS", 3600_000),
  redis: false,
  persistent: false,
});

/** 累计指标 */
const metrics: PromptOptimizerMetrics = {
  calls: 0,
  skipped: 0,
  cacheHits: 0,
  cacheMisses: 0,
  rewritten: 0,
  gateFailures: { output: 0, language: 0, fidelity: 0 },
};

/** 可注入依赖（测试用 fake；生产为 GLM 链 + promptEngineer） */
export interface PromptOptimizerDeps {
  /** 改写器：(输入, skill 上下文, 策略) → 改写文本 | null；策略为可选第三参，向后兼容 */
  rewrite?: (input: string, skillContext: string | null, strategy?: string) => Promise<string | null>;
  /** 忠实度判别：(原文, 改写) → true/false | null */
  verify?: (original: string, rewritten: string) => Promise<boolean | null>;
  /** Skill 匹配：输入 → skill 上下文 | null */
  matchSkill?: (input: string) => string | null;
  /** 意图策略识别：输入 → 策略名（默认 detectOptimizationStrategy 纯函数） */
  strategy?: (input: string) => string;
}

/**
 * 判断输入是否应跳过优化（导出以便调用方预判与测试）。
 */
export function shouldSkipOptimization(userInput: string): boolean {
  const trimmed = userInput.trim();
  if (trimmed.length < MIN_INPUT_CHARS) return true;
  // 代码块：改写可能破坏代码内容
  if (/```[\s\S]*```/.test(userInput)) return true;
  // 命令行 / 斜杠指令 / 特殊前缀
  if (/^[$>\/!#]/.test(trimmed)) return true;
  return false;
}

/**
 * 意图感知策略识别（纯函数，不调 LLM）。
 *
 * 启发式（按优先级）：代码块 → code；分析/评估/对比/总结 → analysis；
 * 翻译 → translation；写作/撰写/文案/文章/润色 → writing；其余 → general。
 */
export function detectOptimizationStrategy(input: string): OptimizationStrategy {
  if (/```[\s\S]*```/.test(input)) return "code";
  if (/分析|评估|对比|总结/.test(input)) return "analysis";
  if (/翻译/.test(input)) return "translation";
  if (/写作|撰写|文案|文章|润色/.test(input)) return "writing";
  return "general";
}

/** 缓存 key：sha256(规范化输入)，规范化 = trim + 小写 + 连续空白归并，不过度处理 */
function cacheKeyFor(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * 优化用户输入（GLM 改写 + 三重闸门 + 结果去重缓存）。
 *
 * 流程：跳过规则 → 缓存查询（命中直接返回 { text: 缓存结果, changed: true }）
 *   → 意图策略 + Skill 匹配 → GLM 改写 → 三重闸门 → 全通过写缓存。
 *
 * @returns 优化结果；任何失败/闸门拒绝都回退为 { text: 原文, changed: false }
 */
export async function optimizePrompt(
  userInput: string,
  deps?: PromptOptimizerDeps,
): Promise<PromptOptimization> {
  metrics.calls++;
  if (!isRewriteEnabled() || shouldSkipOptimization(userInput)) {
    metrics.skipped++;
    return { text: userInput, changed: false };
  }

  try {
    const rewrite = deps?.rewrite ?? glmRewrite;
    const verify = deps?.verify ?? glmVerifyFidelity;
    const matchSkill = deps?.matchSkill ?? matchSkillContext;
    const detectStrategy = deps?.strategy ?? detectOptimizationStrategy;

    // ── 缓存：相同输入（归一化）命中则直接复用上次全通过的结果 ──
    const cacheKey = cacheKeyFor(userInput);
    const cached = await optimizerCache.get(cacheKey);
    if (cached !== undefined) {
      metrics.cacheHits++;
      return { text: cached, changed: true };
    }
    metrics.cacheMisses++;

    const truncated = userInput.length > MAX_INPUT_CHARS
      ? userInput.slice(0, MAX_INPUT_CHARS)
      : userInput;

    // ── 意图策略：改写器据此追加针对性规则 ──
    const strategy = detectStrategy(truncated);

    // ── Skill 匹配：命中专家角色则以其工作流为改写框架 ──
    const skillContext = matchSkill(truncated);

    // ── GLM 改写（策略作为可选第三参传入，兼容两参 fake） ──
    const optimized = (await rewrite(truncated, skillContext, strategy))?.trim() ?? "";

    // ── 闸门 1：输出校验 ──
    if (!isValidOptimization(optimized, userInput)) {
      metrics.gateFailures.output++;
      logger.debug("Prompt optimizer: invalid output, using original", {
        outputLen: optimized.length,
      });
      return { text: userInput, changed: false };
    }

    // ── 闸门 2：语言一致性（确定性） ──
    if (!sameLanguage(userInput, optimized)) {
      metrics.gateFailures.language++;
      logger.debug("Prompt optimizer: language drift detected, using original");
      return { text: userInput, changed: false };
    }

    // ── 闸门 3：忠实度判别（失败按不忠实处理，安全方向） ──
    const faithful = await verify(userInput, optimized);
    if (faithful !== true) {
      metrics.gateFailures.fidelity++;
      logger.debug("Prompt optimizer: fidelity check rejected, using original");
      return { text: userInput, changed: false };
    }

    // ── 三重闸门全通过：写入缓存（写失败不阻塞成功返回） ──
    try {
      optimizerCache.set(cacheKey, optimized);
    } catch (err) {
      logger.debug("Prompt optimizer: cache write failed", {
        error: (err as Error).message,
      });
    }
    metrics.rewritten++;
    return { text: optimized, changed: true };
  } catch (err) {
    logger.debug("Prompt optimizer: enhancement failed, using original", {
      error: (err as Error).message,
    });
    return { text: userInput, changed: false };
  }
}

/** 清空优化缓存并归零指标（测试/运维用） */
export function resetPromptOptimizerCache(): void {
  optimizerCache.clear();
  metrics.calls = 0;
  metrics.skipped = 0;
  metrics.cacheHits = 0;
  metrics.cacheMisses = 0;
  metrics.rewritten = 0;
  metrics.gateFailures.output = 0;
  metrics.gateFailures.language = 0;
  metrics.gateFailures.fidelity = 0;
}

/** 读取优化器累计指标（返回快照，避免外部改动污染内部计数） */
export function getPromptOptimizerMetrics(): PromptOptimizerMetrics {
  return { ...metrics, gateFailures: { ...metrics.gateFailures } };
}

// ─────────────────────────────────────────────────────────
// 生产实现：GLM 链 / Skill 匹配
// ─────────────────────────────────────────────────────────

/** 开关：PROMPT_REWRITE=0 或旧开关 EDGE_PROMPT_REWRITE=0 均关闭（默认开启）；隐私模式整体关闭 */
function isRewriteEnabled(): boolean {
  const off = (v: string) => v === "0" || v.toLowerCase() === "false";
  if (isPrivacyMode()) return false;
  return !off(readString("PROMPT_REWRITE")) && !off(readString("EDGE_PROMPT_REWRITE"));
}

/** 隐私模式（R6）：AXIOM_PRIVACY_MODE=1 时禁止一切云端 LLM 调用（仅本地边缘模型） */
export function isPrivacyMode(): boolean {
  const v = readString("AXIOM_PRIVACY_MODE", "0").toLowerCase();
  return v === "1" || v === "true";
}

/** GLM 链调用：依次尝试，全部失败返回 null */
async function callGlm(system: string, user: string): Promise<string | null> {
  for (const { provider, model } of GLM_CHAIN) {
    try {
      const resp = await callProvider(
        provider,
        model,
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        GLM_TIMEOUT_MS,
        0,
      );
      const content = (resp.content ?? "").trim();
      if (content) return content;
    } catch (err) {
      logger.debug(`Prompt optimizer: ${provider}/${model} failed, trying next`, {
        error: (err as Error).message,
      });
    }
  }
  return null;
}

/** 各策略对应的改写规则（追加进 system prompt；writing/general 无额外规则） */
const STRATEGY_RULES: Record<string, string> = {
  code: "- 保留代码/命令原文，只优化自然语言部分",
  translation: "- 保持原文的翻译意图，不做内容改写，直接输出优化后的翻译指令",
  analysis: "- 强化结构化输出（结论先行、分点）",
};

/** 输入末尾 60 字符内出现 json（大小写不敏感）时，强制保留 JSON 格式要求 */
function requiresJsonOutput(input: string): boolean {
  return /json/i.test(input.slice(-60));
}

/** 生产改写器：GLM 链（按意图策略追加针对性规则） */
async function glmRewrite(input: string, skillContext: string | null, strategy?: string): Promise<string | null> {
  const skillClause = skillContext
    ? `\n命中专家角色，请以其工作流程为框架组织改写：\n${skillContext}\n`
    : "";
  // 项目上下文（来自 CodeGraph/工作区提示，默认项目路径；可用 PROMPT_PROJECT_CONTEXT 覆盖）
  const projectClause = `\n项目上下文（优化时请结合该项目背景让改写更精准）：\n${readString("PROMPT_PROJECT_CONTEXT", process.cwd()).slice(0, 800)}\n`;
  const strategyRule = STRATEGY_RULES[strategy ?? "general"] ?? "";
  const jsonRule = requiresJsonOutput(input) ? "\n- 输出必须保持 JSON 格式要求" : "";
  const system = `你是提示词优化器。将用户输入改写为更清晰、具体、结构化的提示词。${skillClause}${projectClause}
规则：
- 严格保持原意与原文语言（中文输入中文输出，英文输入英文输出）
- 不回答问题，只输出改写后的提示词文本
- 不添加原文没有的要求，不解释，不加前后缀
- 输出长度不超过原文 2 倍${strategyRule}${jsonRule}`;
  return callGlm(system, input);
}

/** 生产忠实度判别：GLM 链；明确 true 才通过 */
async function glmVerifyFidelity(original: string, rewritten: string): Promise<boolean | null> {
  const content = await callGlm(
    `你是审核员。判断改写是否忠实于原文（意思一致且语言相同）。只回答 JSON {"faithful": true或false}`,
    `原文：【${original}】\n改写：【${rewritten}】`,
  );
  if (content === null) return null;
  return /"faithful"\s*:\s*true/.test(content);
}

/** 生产 Skill 匹配：promptEngineer 角色库（agency-zh + Hermes + 内置） */
function matchSkillContext(input: string): string | null {
  try {
    const skill = getPromptEngineer().matchSkill(input);
    if (!skill) return null;
    // 裁剪人格正文，避免 prompt 过长
    const persona = skill.promptTemplate.slice(0, 800);
    return `【${skill.name}】${persona}`;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// 闸门
// ─────────────────────────────────────────────────────────

/** 闸门 1 校验：非空、未退化、未异常膨胀、非原样照抄 */
function isValidOptimization(optimized: string, original: string): boolean {
  if (optimized.length < 8) return false;
  if (optimized.length > original.length * MAX_OUTPUT_RATIO + 200) return false;
  if (optimized === original.trim()) return false; // 照抄原文等于没改写
  return true;
}

/**
 * 闸门 2：语言一致性 —— 比较 CJK 字符占比是否同侧。
 */
function sameLanguage(original: string, optimized: string): boolean {
  const cjkRatio = (s: string) =>
    (s.match(/[一-龥]/g)?.length ?? 0) / Math.max(s.length, 1);
  const CJK_THRESHOLD = 0.2;
  return (cjkRatio(original) > CJK_THRESHOLD) === (cjkRatio(optimized) > CJK_THRESHOLD);
}