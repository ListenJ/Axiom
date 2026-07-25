/**
 * 提示词优化器 v1.1 —— 边缘小模型驱动的用户输入改写（三重闸门防漂移）
 *
 * 模型演进（2026-07-25 实测）：
 *   - MiniCPM5-1B：自由改写语义漂移（4 例 3 漂移）、自验无判别力 → 本模块曾默认关闭
 *   - Qwopus3.5-4B-Coder（当前部署）：改写 4/4 忠实、忠实度判别能识别漂移、
 *     意图/风险分类全部正确 → 重新默认启用
 *
 * 三重闸门（任一失败即回退原文，绝不外发漂移文本）：
 *   1. 输出校验：非空、未异常膨胀（> 原文*3+200 视为灌水）
 *   2. 语言一致性：确定性 CJK 比例比对（4B 偶发 EN→ZH 漂移，LLM 判别漏检此项）
 *   3. LLM 忠实度判别：原意是否一致；判别失败/垃圾输出一律按不忠实处理（安全方向）
 *
 * 跳过条件（避免无意义改写与延迟）：
 *   - 输入过短（< 20 字符，如问候语）
 *   - 含代码块（```...```）—— 改写可能破坏代码
 *   - 命令/斜杠指令前缀（$ / > ! # 开头）
 *   - EDGE_PROMPT_REWRITE=0 全局关闭
 *
 * 性能预算：4B 模型 ~0.8-1.4s 改写 + ~0.5-1s 判别 ≈ 2s/条；
 * 超时由 edge-client 熔断器兜底（8s），异常立即回退原文。
 */

import { getEdgeClient, isEdgeEnabled, extractJson } from "../local-llm/edge-client.js";
import type { LLMClient } from "../dre/llm/client.js";
import { logger } from "../utils/logger.js";

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

/** 输出长度上限系数：超过 输入*3+200 视为异常膨胀（模型灌水） */
const MAX_OUTPUT_RATIO = 3;

/** 可注入的最小客户端接口（测试用 fake；生产为边缘单例） */
type GenerateClient = Pick<LLMClient, "generate">;

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
 * 用边缘小模型优化用户输入。
 *
 * @param userInput 用户原始输入
 * @param client    可注入的 LLM 客户端（测试用；默认边缘单例）
 * @returns 优化结果；任何失败/闸门拒绝都回退为 { text: 原文, changed: false }
 */
export async function optimizePromptWithEdge(
  userInput: string,
  client?: GenerateClient,
): Promise<PromptOptimization> {
  if (!isEdgeEnabled("EDGE_PROMPT_REWRITE") || shouldSkipOptimization(userInput)) {
    return { text: userInput, changed: false };
  }

  try {
    const llm = client ?? getEdgeClient();
    const truncated = userInput.length > MAX_INPUT_CHARS
      ? userInput.slice(0, MAX_INPUT_CHARS)
      : userInput;

    // ── 改写 ──
    const resp = await llm.generate(
      `改写任务：把【】里的口语化输入改写成一条明确的任务指令，保留全部关键信息，保持原语言，只输出指令本身。\n【${truncated}】`,
      { maxTokens: 512 },
    );
    const optimized = (resp.content ?? "").trim();

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

    // ── 闸门 3：LLM 忠实度判别 ──
    const faithful = await verifyFidelity(llm, truncated, optimized);
    if (!faithful) {
      logger.debug("Prompt optimizer: fidelity check rejected, using original");
      return { text: userInput, changed: false };
    }

    return { text: optimized, changed: true };
  } catch (err) {
    // 网络/超时/熔断 —— 优雅降级
    logger.debug("Prompt optimizer: edge call failed, using original", {
      error: (err as Error).message,
    });
    return { text: userInput, changed: false };
  }
}

/** 闸门 1 校验：非空、未退化、未异常膨胀、非原样照抄 */
function isValidOptimization(optimized: string, original: string): boolean {
  if (optimized.length < 8) return false;
  if (optimized.length > original.length * MAX_OUTPUT_RATIO + 200) return false;
  if (optimized === original.trim()) return false; // 照抄原文等于没改写
  return true;
}

/**
 * 闸门 2：语言一致性 —— 比较 CJK 字符占比是否同侧。
 * 原文以中文为主则改写也须以中文为主，反之亦然。
 */
function sameLanguage(original: string, optimized: string): boolean {
  const cjkRatio = (s: string) =>
    (s.match(/[一-龥]/g)?.length ?? 0) / Math.max(s.length, 1);
  const CJK_THRESHOLD = 0.2;
  return (cjkRatio(original) > CJK_THRESHOLD) === (cjkRatio(optimized) > CJK_THRESHOLD);
}

/**
 * 闸门 3：LLM 忠实度判别。
 * 返回 true 仅当模型明确回答 {"faithful": true}；解析失败按不忠实处理。
 */
async function verifyFidelity(
  llm: GenerateClient,
  original: string,
  optimized: string,
): Promise<boolean> {
  const resp = await llm.generate(
    `判断改写是否忠实于原文（意思一致且语言相同）。原文：【${original}】改写：【${optimized}】只回答JSON {"faithful": true或false}`,
    { maxTokens: 40, answerPrefix: '{"faithful":' },
  );
  const parsed = extractJson<{ faithful?: unknown }>(resp.content ?? "");
  return parsed?.faithful === true;
}
