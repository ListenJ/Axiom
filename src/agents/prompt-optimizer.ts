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
 *   2. Skill 匹配（agency-zh 专家角色库 + Hermes 自进化 skills，命中则以其工作流为框架）
 *   3. GLM 改写（保持原意与原语言）
 *   4. 三重闸门：输出校验 → 语言一致性（确定性）→ GLM 忠实度判别
 *   任一环节失败即回退原文，绝不外发漂移文本
 *
 * 开关：PROMPT_REWRITE=0 关闭（兼容旧开关 EDGE_PROMPT_REWRITE=0）
 */

import { callProvider } from "../router/provider-caller.js";
import { getPromptEngineer } from "./prompt-engineer.js";
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";

export interface PromptOptimization {
  /** 优化后文本（未优化时为原文） */
  text: string;
  /** 是否发生了改写 */
  changed: boolean;
}

/** 低于此长度不做优化（短输入没有优化空间） */
const MIN_INPUT_CHARS = 20;

/** 超长输入截断（改写不需要全量上下文，防止恶意消耗） */
const MAX_INPUT_CHARS = 2000;

/** 输出长度上限系数：超过 输入*3+200 视为异常膨胀 */
const MAX_OUTPUT_RATIO = 3;

/** GLM 调用超时（改写/判别共用） */
const GLM_TIMEOUT_MS = 15_000;

/** GLM 免费链：zhipu 直连优先，siliconflow 免费版兜底（2026-07-26 实测修正：siliconflow 无 4.7-Flash，用 THUDM/GLM-4-9B） */
const GLM_CHAIN: Array<{ provider: string; model: string }> = [
  { provider: readString("PROMPT_OPTIMIZER_PROVIDER", "zhipu"), model: readString("PROMPT_OPTIMIZER_MODEL", "glm-4.7-flash") },
  { provider: readString("PROMPT_OPTIMIZER_FALLBACK_PROVIDER", "siliconflow"), model: readString("PROMPT_OPTIMIZER_FALLBACK_MODEL", "THUDM/GLM-4-9B-0414") },
];

/** 可注入依赖（测试用 fake；生产为 GLM 链 + promptEngineer） */
export interface PromptOptimizerDeps {
  /** 改写器：(输入, skill 上下文) → 改写文本 | null */
  rewrite?: (input: string, skillContext: string | null) => Promise<string | null>;
  /** 忠实度判别：(原文, 改写) → true/false | null */
  verify?: (original: string, rewritten: string) => Promise<boolean | null>;
  /** Skill 匹配：输入 → skill 上下文 | null */
  matchSkill?: (input: string) => string | null;
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
 * 优化用户输入（GLM 改写 + 三重闸门）。
 *
 * @returns 优化结果；任何失败/闸门拒绝都回退为 { text: 原文, changed: false }
 */
export async function optimizePrompt(
  userInput: string,
  deps?: PromptOptimizerDeps,
): Promise<PromptOptimization> {
  if (!isRewriteEnabled() || shouldSkipOptimization(userInput)) {
    return { text: userInput, changed: false };
  }

  try {
    const rewrite = deps?.rewrite ?? glmRewrite;
    const verify = deps?.verify ?? glmVerifyFidelity;
    const matchSkill = deps?.matchSkill ?? matchSkillContext;

    const truncated = userInput.length > MAX_INPUT_CHARS
      ? userInput.slice(0, MAX_INPUT_CHARS)
      : userInput;

    // ── Skill 匹配：命中专家角色则以其工作流为改写框架 ──
    const skillContext = matchSkill(truncated);

    // ── GLM 改写 ──
    const optimized = (await rewrite(truncated, skillContext))?.trim() ?? "";

    // ── 闸门 1：输出校验 ──
    if (!isValidOptimization(optimized, userInput)) {
      logger.debug("Prompt optimizer: invalid output, using original", {
        outputLen: optimized.length,
      });
      return { text: userInput, changed: false };
    }

    // ── 闸门 2：语言一致性（确定性） ──
    if (!sameLanguage(userInput, optimized)) {
      logger.debug("Prompt optimizer: language drift detected, using original");
      return { text: userInput, changed: false };
    }

    // ── 闸门 3：忠实度判别（失败按不忠实处理，安全方向） ──
    const faithful = await verify(userInput, optimized);
    if (faithful !== true) {
      logger.debug("Prompt optimizer: fidelity check rejected, using original");
      return { text: userInput, changed: false };
    }

    return { text: optimized, changed: true };
  } catch (err) {
    logger.debug("Prompt optimizer: enhancement failed, using original", {
      error: (err as Error).message,
    });
    return { text: userInput, changed: false };
  }
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

/** 生产改写器：GLM 链 */
async function glmRewrite(input: string, skillContext: string | null): Promise<string | null> {
  const skillClause = skillContext
    ? `\n命中专家角色，请以其工作流程为框架组织改写：\n${skillContext}\n`
    : "";
  const system = `你是提示词优化器。将用户输入改写为更清晰、具体、结构化的提示词。${skillClause}
规则：
- 严格保持原意与原文语言（中文输入中文输出，英文输入英文输出）
- 不回答问题，只输出改写后的提示词文本
- 不添加原文没有的要求，不解释，不加前后缀
- 输出长度不超过原文 2 倍`;
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
