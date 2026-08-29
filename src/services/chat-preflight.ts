/**
 * Chat preflight — 主模型前的串行前置 LLM 调用编排（optimizePrompt → intent 增强）。
 *
 * 真实数据依赖（P0-A 2026-08-29 通读核实，docs/superpowers/specs/2026-08-29-p0-lift-design.md §A）：
 *   optimizePrompt(原始输入) → rewritten
 *   buildAgentMessages(rewritten) → rawIntent —— 关键词意图基于【改写后】文本
 *   enhanceIntentWithLLM(原始输入, rawIntent) —— 语义分类用原始输入，但回退基线
 *     rawIntent 源自改写文本 ⇒ optimize → intent 消费链成立，两者保持串行。
 *   selfThink 只依赖原始输入（routes 层注入），与本编排完全独立 ⇒ 在 routes/chat.ts
 *     经 startSelfThought 提前并发发起（见 self-evolve/engine.ts）。
 *
 * 边缘合并快路径（:9001 可用时）：
 *   一次结构化调用返回 {rewritten, intent, confidence}，替换
 *   「GLM 改写（改写+忠实度两次云调用）+ 关键词匹配 + 边缘/云意图增强」链。
 *   改写文本仍须通过确定性闸门（输出校验+语言一致性，无额外 LLM 调用）；
 *   解析失败 / 边缘不可用 / 闸门拒绝 / 依赖异常 → 静默回退现有串行路径（行为语义不变）。
 *
 * 测试接缝：PreflightDeps 全量可注入，测试用 fake 替换即可（禁止 mock.module）。
 */
import type { IntentResult } from "../agents/intent-router.js";
import { buildAgentMessages } from "../agents/intent-router.js";
import {
  optimizePrompt,
  shouldSkipOptimization,
  isRewriteEnabled,
  passesDeterministicGates,
  type PromptOptimization,
} from "../agents/prompt-optimizer.js";
import { enhanceIntentWithLLM, shouldEnhanceIntent } from "../agents/intent-enhancer.js";
import { extractJson } from "../utils/extract-json.js";
import { logger } from "../utils/logger.js";

/** 合法意图集合（与 intent-enhancer VALID_INTENTS 一致） */
const VALID_INTENTS = new Set(["code", "research", "knowledge", "write", "plan", "chat"]);

/** 1B 边缘模型 confidence 无校准（常为 0），有效枚举标签统一 0.6 下限（同 intent-enhancer 边缘层） */
const EDGE_CONFIDENCE_FLOOR = 0.6;

/** 合并调用输入截断（与 prompt-optimizer 改写输入上限一致） */
const MERGED_MAX_INPUT_CHARS = 2000;

/** 边缘合并调用结果 */
export interface MergedPreflight {
  rewritten: string;
  intent: string;
  confidence: number;
}

/** preflight 产物（供 prepareChatContext 组装） */
export interface PreflightResult {
  optimization: PromptOptimization;
  agentMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  intent: IntentResult;
}

/** 结构化边缘客户端（对齐 edge-client.generate 的实际用面子集，避免跨层类型依赖） */
export interface EdgeClientLike {
  generate(prompt: string, options?: { maxTokens?: number }): Promise<{ content: string }>;
}

/** 边缘依赖：enabled()=EDGE_PROMPT_OPTIMIZER 开关；null = 快路径禁用 */
export interface EdgeDep {
  enabled(): boolean;
  client: EdgeClientLike;
}

/** 兼容归一：传裸客户端（如测试 fake）视为 enabled=true */
export function normalizeEdge(edge?: EdgeDep | EdgeClientLike | null): EdgeDep | null {
  if (!edge) return null;
  if (typeof (edge as EdgeDep).enabled === "function") return edge as EdgeDep;
  return { enabled: () => true, client: edge as EdgeClientLike };
}

/** preflight 依赖（全量可注入；生产用 defaultPreflightDeps，edge 由 routes 组合根注入） */
export interface PreflightDeps {
  /** 边缘依赖（合并快路径）；null = 快路径禁用，走串行 */
  edge: EdgeDep | null;
  /** 快路径资格：默认 改写开关开启 且 输入未被优化器跳过规则排除 */
  canAttemptMerged: (input: string) => boolean;
  /** 边缘合并调用：null = 边缘不可用/解析失败 → 回退串行 */
  mergedEdge: (input: string) => Promise<MergedPreflight | null>;
  /** 确定性闸门（合并改写文本必须通过） */
  gates: (original: string, rewritten: string) => boolean;
  /** 串行路径：提示词优化（失败内部回退原文） */
  optimize: (input: string) => Promise<PromptOptimization>;
  /** 关键词意图 + agent 消息构建（同步，0ms fast path） */
  buildMessages: (
    input: string,
    history: Array<{ role: string; content: string }>,
  ) => {
    intent: IntentResult;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  };
  /** 意图 LLM 增强（双层：边缘 → 云；失败内部回退 baseIntent） */
  enhance: (input: string, base: IntentResult) => Promise<IntentResult>;
  /** 是否需要增强（关键词置信度低于阈值） */
  shouldEnhance: (base: IntentResult) => boolean;
}

/** 生产依赖（测试整体替换为 fake，不用 mock.module） */
export function defaultPreflightDeps(): PreflightDeps {
  // edge 默认 null：组合根（routes）注入生产边缘客户端；缺省时合并快路径禁用、
  // 静默走串行路径（行为语义不变，见 spec §A 降级纪律）。
  const edge: EdgeDep | null = null;
  return {
    edge,
    canAttemptMerged: (input) => isRewriteEnabled() && !shouldSkipOptimization(input),
    mergedEdge: (input) => mergedEdgePreflight(input, edge),
    gates: passesDeterministicGates,
    optimize: (input) => optimizePrompt(input),
    buildMessages: buildAgentMessages,
    enhance: enhanceIntentWithLLM,
    shouldEnhance: shouldEnhanceIntent,
  };
}

/**
 * 编排主模型前的前置调用。
 *
 * 快路径（边缘合并）：任何失败都静默回退串行路径——快路径是纯优化，
 * 绝不阻塞或改变主流程行为。
 */
export async function runPreflight(
  rawInput: string,
  history: Array<{ role: string; content: string }>,
  deps: PreflightDeps = defaultPreflightDeps(),
): Promise<PreflightResult> {
  // ── 快路径：边缘合并调用（改写 + 意图一次出）──
  try {
    if (deps.canAttemptMerged(rawInput)) {
      const merged = await deps.mergedEdge(rawInput);
      if (merged && deps.gates(rawInput, merged.rewritten)) {
        // 关键词意图仍基于合并改写文本（与串行路径同源），合并意图按
        // enhanceIntentWithLLM 边缘层语义组合：confidence 抬到 0.6 下限后取 max
        const { intent: baseIntent, messages: agentMessages } = deps.buildMessages(
          merged.rewritten,
          history,
        );
        const intent: IntentResult = {
          intent: merged.intent,
          agentName: baseIntent.agentName,
          confidence: Math.max(
            Math.max(merged.confidence, EDGE_CONFIDENCE_FLOOR),
            baseIntent.confidence,
          ),
          matchedKeywords: baseIntent.matchedKeywords,
          recommendedRole: baseIntent.recommendedRole,
        };
        return {
          optimization: { text: merged.rewritten, changed: true },
          agentMessages,
          intent,
        };
      }
    }
  } catch (err) {
    logger.debug("Preflight: merged edge fast path failed, falling back to serial", {
      error: (err as Error).message,
    });
  }

  // ── 现有串行路径（行为语义不变）──
  const optimization = await deps.optimize(rawInput);
  const { intent: rawIntent, messages: agentMessages } = deps.buildMessages(
    optimization.text,
    history,
  );
  const intent = deps.shouldEnhance(rawIntent)
    ? await deps.enhance(rawInput, rawIntent)
    : rawIntent;
  return { optimization, agentMessages, intent };
}

/**
 * 边缘合并调用：改写 + 意图一次结构化调用。
 * 1B 模型唯一稳定形态是「单条 user 消息融合任务+输入+内联 schema」
 * （见 intent-enhancer.ts 实测结论），故不使用独立 system prompt。
 * 返回 null = 边缘关闭/调用失败/解析失败/字段非法 → 调用方回退串行路径。
 */
export async function mergedEdgePreflight(
  userInput: string,
  edge?: EdgeDep | EdgeClientLike | null,
): Promise<MergedPreflight | null> {
  const e = normalizeEdge(edge);
  if (!e || !e.enabled()) return null;
  const client = e.client;
  try {
    const truncated = userInput.length > MERGED_MAX_INPUT_CHARS
      ? userInput.slice(0, MERGED_MAX_INPUT_CHARS)
      : userInput;
    const resp = await client.generate(
      `Rewrite the input into a clearer prompt and classify its intent into one of: code, research, knowledge, write, plan, chat.`
        + ` Keep the original meaning and language; do not answer the question.`
        + ` Input: "${truncated}".`
        + ` Reply JSON {"rewritten":"...","intent":"...","confidence":0.0-1.0}`,
      { maxTokens: 512 },
    );
    const parsed = extractJson<{
      rewritten?: unknown;
      intent?: unknown;
      confidence?: unknown;
    }>(resp.content ?? "");
    if (!parsed) return null;
    const rewritten = typeof parsed.rewritten === "string" ? parsed.rewritten.trim() : "";
    const intent = typeof parsed.intent === "string" ? parsed.intent.trim() : "";
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0;
    if (!rewritten || !VALID_INTENTS.has(intent)) return null;
    return { rewritten, intent, confidence };
  } catch (err) {
    logger.debug("Preflight: merged edge call failed", {
      error: (err as Error).message,
    });
    return null;
  }
}
