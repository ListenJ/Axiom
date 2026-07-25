/**
 * 意图增强器 v1.0 —— GLM4.7-flash 驱动的语义级意图理解与 prompt 增强
 *
 * 设计目标（"随心所想"）：
 *   - 关键词匹配（recognizeIntent）作为 fast path（0ms）保留
 *   - 当 fast path 置信度低（confidence < ENHANCE_THRESHOLD）时，异步调用 GLM4.7-flash
 *     做语义级意图分类，能理解关键词匹配漏掉的模糊/复杂查询
 *   - LLM 失败时优雅降级回原意图，不阻塞主流程
 *   - 同时提供按意图动态注入思考框架的 prompt 增强能力
 *
 * 集成方式：
 *   - chat.ts prepareChatContext 中，recognizeIntent 后判断 confidence，
 *     低于阈值时调用 enhanceIntentWithLLM
 *   - buildAgentMessages 系统提示改为调用 buildEnhancedSystemPrompt
 *
 * 性能预算：
 *   - GLM4.7-flash 官方 API 直连，200K 上下文，典型响应 200-500ms
 *   - 超时 5s（保守上限，远超典型响应），失败回退
 *   - rpmLimit 200 / concurrentLimit 16，远高于意图分类场景需求
 */

import { callProvider } from "../router/provider-caller.js";
import { getEdgeClient, isEdgeEnabled } from "../local-llm/edge-client.js";
import { logger } from "../utils/logger.js";
import type { IntentResult } from "./intent-router.js";

// ─────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────

/** 触发 LLM 增强的置信度阈值：低于此值才调用 GLM4.7-flash */
const ENHANCE_THRESHOLD = 0.5;

/** LLM 增强 API 超时（ms）—— GLM4.7-flash 通常 200-500ms，5s 是保守上限 */
const ENHANCE_TIMEOUT_MS = 5000;

/** LLM 上下文窗口限制（用于估算单次调用成本） */
const MAX_INPUT_CHARS = 4000;

/** GLM4.7-flash 模型配置（zhipu 官方免费 API） */
const GLM_FLASH_MODEL = "glm-4.7-flash";
const GLM_FLASH_PROVIDER = "zhipu";

/** 合法意图集合（与 intent-router.ts CATEGORY_INTENTS 一致） */
const VALID_INTENTS = new Set(["code", "research", "knowledge", "write", "plan", "chat"]);

// ─────────────────────────────────────────────────────────
// 意图分类 prompt
// ─────────────────────────────────────────────────────────

/**
 * 构建意图分类的 system prompt。
 *
 * 设计要点：
 *   - 强制 JSON 输出（便于解析，避免自由文本）
 *   - 给出 6 个类别明确边界，避免 LLM 自由发挥
 *   - 要求简短 reason（用于调试与日志，不影响主流程）
 */
const CLASSIFIER_SYSTEM_PROMPT = `你是意图分类器。给定用户输入，输出严格 JSON：
{"intent": "code|research|knowledge|write|plan|chat", "confidence": 0.0-1.0, "reason": "<=20字"}

类别定义：
- code: 编程/技术/开发/Bug/架构/部署/服务器/数据库
- research: 调研/分析/论文/数据/产品需求/竞品/行业
- knowledge: 查询知识库/历史记录/概念解释/原理
- write: 撰写文档/报告/邮件/翻译/润色
- plan: 计划/排期/项目管理/任务分解
- chat: 闲聊/问候/其他

只输出 JSON，不要任何其他文字。`;

/**
 * 构建边缘小模型 (1B) 专用的意图分类 prompt。
 *
 * 实测结论（2026-07-25，对真实端点采样）：1B 模型无法遵循长 system prompt
 * 与类别定义列表，会跑题或直接回答问题；唯一稳定的形态是
 * 「单条 user 消息融合任务+输入+内联 schema」。因此边缘路径不用
 * CLASSIFIER_SYSTEM_PROMPT，改用本融合式 prompt。
 *
 * 模型返回的 confidence 常为 0（无校准能力），调用方需自行设定置信度下限。
 */
function buildEdgeClassifierPrompt(input: string): string {
  return `Classify intent of the input into one of: code, research, knowledge, write, plan, chat. Input: "${input}". Reply JSON {"intent":"...","confidence":0.0-1.0}`;
}

// ─────────────────────────────────────────────────────────
// 意图增强主函数
// ─────────────────────────────────────────────────────────

/**
 * 判断是否需要 LLM 增强。
 * 公开此函数，让调用方（chat.ts）能预先判断，避免无谓的 await。
 */
export function shouldEnhanceIntent(baseIntent: IntentResult): boolean {
  return baseIntent.confidence < ENHANCE_THRESHOLD;
}

/**
 * 用 GLM4.7-flash 做语义级意图分类。
 *
 * @param userInput   用户原始输入
 * @param baseIntent  关键词匹配的初步结果（作为 fallback）
 * @returns 增强后的 IntentResult（可能修正 intent / 提升 confidence）；失败时返回 baseIntent
 */
export async function enhanceIntentWithLLM(
  userInput: string,
  baseIntent: IntentResult,
): Promise<IntentResult> {
  // 截断超长输入（防止恶意消耗 token，GLM4.7-flash 200K ctx 但意图分类不需要全量）
  const truncatedInput = userInput.length > MAX_INPUT_CHARS
    ? userInput.slice(0, MAX_INPUT_CHARS)
    : userInput;

  // ── 第一层：边缘小模型 (MiniCPM5-1B, 本地免费 ~100ms) ──
  // 失败/非法输出时继续走下方 zhipu 路径，构成双轨回退链
  if (isEdgeEnabled("EDGE_PROMPT_OPTIMIZER")) {
    try {
      const edgeResp = await getEdgeClient().generate(
        buildEdgeClassifierPrompt(truncatedInput),
        { maxTokens: 64 },
      );
      const parsed = parseClassifierResponse((edgeResp.content ?? "").trim());
      if (parsed && VALID_INTENTS.has(parsed.intent)) {
        // 1B 模型 confidence 无校准（常为 0），有效枚举标签统一给到 0.6 下限
        return buildEnhancedResult(
          { intent: parsed.intent, confidence: Math.max(parsed.confidence, 0.6) },
          baseIntent,
        );
      }
      logger.debug("Intent enhancer: invalid edge response, falling back to zhipu", {
        content: (edgeResp.content ?? "").slice(0, 100),
      });
    } catch (err) {
      logger.debug("Intent enhancer: edge call failed, falling back to zhipu", {
        error: (err as Error).message,
      });
    }
  }

  // ── 第二层：zhipu GLM4.7-flash（云端备用） ──
  try {
    const response = await callProvider(
      GLM_FLASH_PROVIDER,
      GLM_FLASH_MODEL,
      [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: truncatedInput },
      ],
      ENHANCE_TIMEOUT_MS,
      0, // temperature=0：分类任务需要确定性
    );

    const content = (response.content ?? "").trim();
    const parsed = parseClassifierResponse(content);

    if (parsed && VALID_INTENTS.has(parsed.intent)) {
      return buildEnhancedResult(parsed, baseIntent);
    }

    // LLM 返回格式错误或意图非法 —— 回退
    logger.debug("Intent enhancer: invalid LLM response, falling back", {
      content: content.slice(0, 100),
    });
    return baseIntent;
  } catch (err) {
    // API 失败/超时/网络错误 —— 优雅降级
    logger.debug("Intent enhancer: LLM call failed, falling back to keyword match", {
      error: (err as Error).message,
    });
    return baseIntent;
  }
}

/**
 * 用 LLM 分类结果构建增强 IntentResult（边缘层与云端层共用）。
 */
function buildEnhancedResult(
  parsed: { intent: string; confidence: number },
  baseIntent: IntentResult,
): IntentResult {
  return {
    intent: parsed.intent,
    agentName: baseIntent.agentName, // 保留原 agentName（与意图解耦）
    confidence: Math.max(parsed.confidence, baseIntent.confidence),
    matchedKeywords: baseIntent.matchedKeywords,
    recommendedRole: baseIntent.recommendedRole,
    // 隐式约定：增强后的 intent 已被 LLM 校验过，可作为更可信的结果
  };
}

/**
 * 解析 LLM 返回的 JSON。
 * 容错：剥离 markdown code fence（```json ... ```）、提取首个 JSON 对象。
 */
function parseClassifierResponse(content: string): {
  intent: string;
  confidence: number;
  reason?: string;
} | null {
  let text = content.trim();

  // 剥离 markdown code fence
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }

  // 尝试直接 JSON.parse
  try {
    const obj = JSON.parse(text);
    if (typeof obj.intent === "string" && typeof obj.confidence === "number") {
      return {
        intent: obj.intent,
        confidence: obj.confidence,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
      };
    }
  } catch {
    // 不是纯 JSON，尝试提取首个 {...} 块
  }

  // 提取首个 JSON 对象
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (typeof obj.intent === "string" && typeof obj.confidence === "number") {
        return {
          intent: obj.intent,
          confidence: obj.confidence,
          reason: typeof obj.reason === "string" ? obj.reason : undefined,
        };
      }
    } catch {
      // 提取后仍解析失败
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────
// Prompt 增强（按意图动态注入思考框架）
// ─────────────────────────────────────────────────────────

/**
 * 按意图动态构建增强版 system prompt。
 *
 * 设计思路：
 *   - 原 intent-router.ts 的 systemPrompts 是简短的身份声明
 *   - 本函数在身份声明基础上，按意图注入"思考框架"，引导 LLM 结构化思考
 *   - 框架不是死板模板，而是"思考支架"——保留 LLM 灵活性的同时提升回答质量
 *
 * 与原 systemPrompts 的关系：
 *   - 本函数返回的 prompt 完全替代原 systemPrompts[intent]
 *   - 保留原 prompt 的"中性、严肃、无情感"基调
 */
export function buildEnhancedSystemPrompt(intent: string, userInput: string): string {
  const baseIdentity = "You are Axiom. Maintain a neutral, serious tone. Do not express emotion, enthusiasm, or empathy.";

  // 用户输入的关键信号提取（用于 prompt 个性化，不强制）
  const inputHint = extractInputHint(userInput);

  const frameworks: Record<string, string> = {
    code: `${baseIdentity} You are a disciplined software engineering assistant.

Thinking framework:
1. Restate the problem in technical terms to confirm understanding.
2. Identify constraints (language, framework, performance, security).
3. Propose 1-2 viable approaches with trade-offs.
4. Implement the recommended approach with concise code.
5. Note edge cases or testing considerations.

When the request is ambiguous, state the assumption you're making before proceeding. Prefer correctness over verbosity.${inputHint}`,

    research: `${baseIdentity} You are a research analyst.

Thinking framework:
1. Define the research question precisely.
2. Identify what evidence would answer it.
3. Evaluate available evidence (cite when possible).
4. Distinguish established fact from inference.
5. State conclusions with appropriate confidence qualifiers.

Never fabricate sources. If evidence is insufficient, say so plainly.${inputHint}`,

    knowledge: `${baseIdentity} You are a knowledge navigator.

Thinking framework:
1. Check if the provided context answers the query.
2. If yes, synthesize a concise answer citing the context.
3. If partially, answer what you can and flag the gap.
4. If no, state plainly that the context is insufficient.

Do not speculate beyond the provided context. Do not blend in outside knowledge without flagging it.${inputHint}`,

    write: `${baseIdentity} You are a technical writer.

Thinking framework:
1. Identify the document's purpose and audience.
2. Outline the structure (sections, flow).
3. Draft key points with supporting detail.
4. Ensure consistent terminology and tone.

Prefer clarity over ornament. Use lists and tables when they aid comprehension.${inputHint}`,

    plan: `${baseIdentity} You are a project planner.

Thinking framework:
1. Restate the goal and success criteria.
2. Decompose into ordered work packages.
3. Identify dependencies and critical path.
4. Note risks with mitigation.
5. Suggest checkpoints or milestones.

Be concrete about owners, durations, and sequencing. Avoid vague verbs.${inputHint}`,

    chat: `${baseIdentity} Answer accurately and concisely. When the question has multiple interpretations, pick the most likely one and proceed; note the interpretation if it's non-obvious.${inputHint}`,
  };

  return frameworks[intent] || frameworks.chat;
}

/**
 * 从用户输入中提取关键提示信号（不影响主流程，仅用于 prompt 个性化）。
 * 例如：检测到代码片段 → 提示 LLM "user provided code"；检测到错误日志 → "user shared an error"。
 */
function extractInputHint(userInput: string): string {
  const hints: string[] = [];

  // 代码块
  if (/```[\s\S]*```/.test(userInput) || /\n\s{4,}\S/.test(userInput)) {
    hints.push("The user provided code; reference it explicitly when relevant.");
  }

  // 错误日志
  if (/\b(error|exception|traceback|stack trace|panic)\b/i.test(userInput)) {
    hints.push("The user shared an error; diagnose root cause before proposing fixes.");
  }

  // 命令行
  if (/^\s*\$\s/m.test(userInput) || /\bnpm|bun|yarn|pnpm|cargo|git\s+\w+/i.test(userInput)) {
    hints.push("The user shared command-line output; interpret it in context.");
  }

  // 中文提问
  if (/[\u4e00-\u9fa5]/.test(userInput)) {
    hints.push("Respond in the same language as the user's query.");
  }

  return hints.length > 0 ? `\n\nContext signals:\n- ${hints.join("\n- ")}` : "";
}
