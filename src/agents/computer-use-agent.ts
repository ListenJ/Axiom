/**
 * Computer Use Agent v2.0 — CDP 元素增强 + 视觉模型决策
 *
 * 架构:
 *   1. CDP 提取页面元素结构（坐标、类型、文本）→ 结构化上下文
 *   2. CDP 截图 → 视觉上下文
 *   3. 将元素结构 + 截图发送给视觉模型（Qwen2.5-VL-72B）
 *   4. 视觉模型返回操作指令（引用元素 index 或坐标）
 *   5. CDP 精确执行操作
 *
 * 优势:
 *   - Token 消耗降低 60-80%（模型不需要自己"看"坐标）
 *   - 定位精度接近 100%（CDP 提供精确坐标）
 *   - 支持复杂交互链（多步操作）
 *
 * 关于"是否走 model-router / InternalAgent":
 *   callVisionModel() 的消息载荷是 OpenAI 兼容的多模态格式：
 *     `content: string | Array<{type:"text"} | {type:"image_url", image_url:{url,...}}>`
 *   model-router 的 `ChatMessage.content` 当前只接受 `string`（窄类型）。
 *   按任务约束 `MUST NOT touch` 中"不要用 `as any` 压制类型错误"的硬规则，
 *   本函数维持直接 `proxyFetch`（与 Kimi Code、ModelEval `/models` 同属
 *   "特殊外部载荷"例外）。模型选择仍走 `findModelsForRole("computer-use")`
 *   复用统一的视觉模型清单。
 */

import { logger } from "../utils/logger.js";
import { findModelsForRole } from "../router/model-capability-registry.js";
import { proxyFetch } from "../utils/proxy-fetch.js";
import { PROVIDER_CONFIG } from "../router/models.js";
import { TIMEOUTS } from "../constants/timeouts.js";
import {
  captureScreenshot,
  extractInteractiveElements,
  executeCDPAction,
  type InteractiveElement,
  type CDPAction,
} from "../crawl/lightpanda-client.js";

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ComputerUseInput {
  task: string;
  imageBase64?: string;
  imageUrl?: string;
  imageType?: string;
  /** CDP URL — 如果提供，启用元素增强模式 */
  cdpUrl?: string;
  /** 目标 URL — 如果提供，先导航再截图 */
  targetUrl?: string;
  history?: ComputerAction[];
  modelId?: string;
  systemPrompt?: string;
}

export interface ComputerUseResult {
  reasoning: string;
  actions: ComputerAction[];
  completed: boolean;
  model: string;
  provider: string;
  latencyMs: number;
  elements?: InteractiveElement[];
  elementEnhanced: boolean;
}

export type ComputerAction =
  | { type: "click"; x: number; y: number; elementIndex?: number; button?: "left" | "right"; description?: string }
  | { type: "type"; text: string; elementIndex?: number; description?: string }
  | { type: "keypress"; keys: string[]; description?: string }
  | { type: "scroll"; x: number; y: number; scrollX?: number; scrollY?: number; description?: string }
  | { type: "move"; x: number; y: number; description?: string }
  | { type: "wait"; ms: number; description?: string }
  | { type: "screenshot"; description?: string }
  | { type: "done"; answer?: string; description?: string };

interface VisionMessage {
  role: "system" | "user" | "assistant";
  content: string | VisionContentPart[];
}

type VisionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

// ═══════════════════════════════════════════════════════════════
// 系统提示
// ═══════════════════════════════════════════════════════════════

const BASE_SYSTEM_PROMPT = `You are a computer automation assistant. Analyze the provided screenshot and page element structure, then return a JSON object describing the next action(s) to take.

Rules:
- Return ONLY valid JSON. No markdown, no explanation outside JSON.
- When a matching element exists in the element list, prefer using elementIndex over raw coordinates.
- If no matching element, use exact coordinates from the screenshot.

JSON format:
{
  "reasoning": "Brief thought process",
  "completed": false,
  "actions": [
    { "type": "click", "elementIndex": 3, "description": "Click login button" },
    { "type": "type", "elementIndex": 5, "text": "hello world", "description": "Enter search query" },
    { "type": "keypress", "keys": ["Enter"], "description": "Submit form" },
    { "type": "click", "x": 120, "y": 340, "description": "Click at coordinates" },
    { "type": "scroll", "x": 500, "y": 400, "scrollY": -300, "description": "Scroll down" },
    { "type": "wait", "ms": 1000, "description": "Wait for page load" },
    { "type": "screenshot", "description": "Take another screenshot" },
    { "type": "done", "answer": "Task result", "description": "Task complete" }
  ]
}`;

// ═══════════════════════════════════════════════════════════════
// Computer Use Agent
// ═══════════════════════════════════════════════════════════════

export class ComputerUseAgent {
  private systemPrompt: string;

  constructor(options?: { systemPrompt?: string }) {
    this.systemPrompt = options?.systemPrompt ?? BASE_SYSTEM_PROMPT;
  }

  /**
   * 分析任务并返回操作建议
   *
   * 两种模式:
   *   1. 纯视觉模式: 只提供截图，模型自己判断坐标
   *   2. 元素增强模式: CDP 提取元素结构 + 截图，模型引用元素 index
   */
  async analyze(input: ComputerUseInput): Promise<ComputerUseResult> {
    const startTime = Date.now();
    const model = this.selectModel(input.modelId);

    // 元素增强模式
    let elements: InteractiveElement[] | undefined;
    let screenshotBase64 = input.imageBase64;

    if (input.cdpUrl) {
      logger.info("[ComputerUse] Element-enhanced mode", { cdpUrl: input.cdpUrl, targetUrl: input.targetUrl });

      // 1. 截图
      if (!screenshotBase64) {
        try {
          const ss = await captureScreenshot(input.targetUrl, input.cdpUrl, { format: "png", timeout: 20000 });
          screenshotBase64 = ss.base64;
          logger.info("[ComputerUse] Screenshot captured", { loadTimeMs: ss.loadTimeMs });
        } catch (e) {
          logger.warn("[ComputerUse] Screenshot failed", { error: (e as Error).message });
        }
      }

      // 2. 提取元素结构
      try {
        elements = await extractInteractiveElements(input.cdpUrl, 10000);
        logger.info("[ComputerUse] Elements extracted", { count: elements.length });
      } catch (e) {
        logger.warn("[ComputerUse] Element extraction failed", { error: (e as Error).message });
      }
    }

    // 构建消息
    const messages = this.buildMessages(input, screenshotBase64, elements);
    const result = await this.callVisionModel(model, messages);

    const parsed = this.parseResponse(result.content, elements);
    return {
      ...parsed,
      model: model.model,
      provider: model.provider,
      latencyMs: Date.now() - startTime,
      elements,
      elementEnhanced: !!elements && elements.length > 0,
    };
  }

  /**
   * 执行单步操作（通过 CDP）
   */
  async executeAction(
    action: ComputerAction,
    cdpUrl?: string
  ): Promise<{ success: boolean; message?: string; screenshot?: string }> {
    if (!cdpUrl) {
      return { success: false, message: "CDP URL not provided, cannot execute action" };
    }

    try {
      // 如果 action 有 elementIndex，从上次提取的元素中获取坐标
      const resolvedAction = await this.resolveElementCoordinates(action, cdpUrl);

      const cdpAction: CDPAction = {
        type: resolvedAction.type as CDPAction["type"],
        x: (resolvedAction as any).x,
        y: (resolvedAction as any).y,
        text: (resolvedAction as any).text,
        keys: (resolvedAction as any).keys,
        ms: (resolvedAction as any).ms,
      };

      const execResult = await executeCDPAction(cdpAction, cdpUrl, 10000);

      // 操作后自动截图
      let screenshot: string | undefined;
      if (resolvedAction.type !== "done") {
        try {
          const ss = await captureScreenshot(undefined, cdpUrl, { format: "png", timeout: 10000 });
          screenshot = ss.base64;
        } catch {}
      }

      return { ...execResult, screenshot };
    } catch (e) {
      return { success: false, message: (e as Error).message };
    }
  }

  /**
   * 多步任务循环：分析 → 执行 → 截图 → 分析 → ...
   */
  async runTask(
    goal: string,
    cdpUrl: string,
    targetUrl?: string,
    maxSteps: number = 10
  ): Promise<ComputerUseResult[]> {
    const history: ComputerUseResult[] = [];
    let currentUrl = targetUrl;

    for (let step = 0; step < maxSteps; step++) {
      logger.info(`[ComputerUse] Step ${step + 1}/${maxSteps}`, { goal, url: currentUrl });

      const result = await this.analyze({
        task: goal,
        cdpUrl,
        targetUrl: currentUrl,
        history: history.flatMap((h) => h.actions),
      });

      history.push(result);

      if (result.completed) {
        logger.info("[ComputerUse] Task completed", { steps: step + 1 });
        break;
      }

      // 执行第一个非-done 操作
      const execAction = result.actions.find((a) => a.type !== "done");
      if (execAction) {
        const execResult = await this.executeAction(execAction, cdpUrl);
        if (!execResult.success) {
          logger.warn("[ComputerUse] Action failed", { action: execAction.type, error: execResult.message });
        }
      }

      // 如果最后一个操作是 screenshot 或 wait，继续循环
      const lastAction = result.actions[result.actions.length - 1];
      if (lastAction?.type === "screenshot" || lastAction?.type === "wait") {
        await new Promise((r) => setTimeout(r, (lastAction as any).ms ?? 1000));
      }
    }

    return history;
  }

  listVisionModels(): Array<{ id: string; provider: string; model: string; contextWindow: number }> {
    return findModelsForRole("computer-use").map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model,
      contextWindow: m.contextWindow,
    }));
  }

  // ---------------------------------------------------------------------------
  // 私有方法
  // ---------------------------------------------------------------------------

  private selectModel(preferredId?: string) {
    const candidates = findModelsForRole("computer-use");
    if (candidates.length === 0) {
      throw new Error("No vision model available. Configure an API key for a multimodal provider (SiliconFlow, OpenRouter, OfoxAI).");
    }

    if (preferredId) {
      const found = candidates.find((c) => c.id === preferredId);
      if (found) return found;
    }

    // 优先: 非 legacy > vision 标签 > priority
    const sorted = [...candidates].sort((a, b) => {
      const aVision = a.tags.includes("vision") ? 0 : 1;
      const bVision = b.tags.includes("vision") ? 0 : 1;
      if (aVision !== bVision) return aVision - bVision;
      const aLegacy = a.tags.includes("legacy") ? 1 : 0;
      const bLegacy = b.tags.includes("legacy") ? 1 : 0;
      if (aLegacy !== bLegacy) return aLegacy - bLegacy;
      return (a.priority ?? 99) - (b.priority ?? 99);
    });

    return sorted[0];
  }

  private buildMessages(
    input: ComputerUseInput,
    screenshotBase64?: string,
    elements?: InteractiveElement[]
  ): VisionMessage[] {
    const systemPrompt = input.systemPrompt ?? this.systemPrompt;

    // 构建元素结构文本（如果有）
    let elementText = "";
    if (elements && elements.length > 0) {
      elementText = `\n\n## 页面可交互元素 (${elements.length} 个)\n\n`;
      elementText += "| Index | Tag | Role | Text | Center (x,y) | Size (w×h) |\n";
      elementText += "|-------|-----|------|------|--------------|------------|\n";
      for (const el of elements.slice(0, 50)) {
        const text = el.text.replace(/\|/g, "\\|").slice(0, 30) || "-";
        elementText += `| ${el.index} | ${el.tag} | ${el.role} | ${text} | (${el.centerX},${el.centerY}) | ${el.width}×${el.height} |\n`;
      }
      elementText += "\n使用 elementIndex 引用元素，比坐标更精确。\n";
    }

    const messages: VisionMessage[] = [
      { role: "system", content: systemPrompt + elementText },
    ];

    // 历史上下文
    if (input.history && input.history.length > 0) {
      messages.push({
        role: "user",
        content: `Previous actions:\n${JSON.stringify(input.history.slice(-5), null, 2)}`,
      });
      messages.push({
        role: "assistant",
        content: "Understood. Continuing from current state.",
      });
    }

    // 用户消息：任务 + 截图
    const userContent: VisionContentPart[] = [
      { type: "text", text: input.task },
    ];

    if (screenshotBase64) {
      const mime = input.imageType ?? "image/png";
      userContent.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${screenshotBase64}`, detail: "high" },
      });
    } else if (input.imageUrl) {
      userContent.push({
        type: "image_url",
        image_url: { url: input.imageUrl, detail: "high" },
      });
    }

    messages.push({ role: "user", content: userContent });
    return messages;
  }

  private async callVisionModel(
    model: { provider: string; model: string },
    messages: VisionMessage[]
  ): Promise<{ content: string | null }> {
    // 多模态消息载荷（content: string | VisionContentPart[]）无法直接走
    // model-router（其 ChatMessage.content 是窄类型 string）。此处保留直接通道：
    //   - 模型清单仍通过 findModelsForRole("computer-use") 与 router 共享
    //   - provider / API key / base URL 走与 router 同一套解析（PROVIDER_CONFIG +
    //     getEffectiveApiKey + getEffectiveBaseURL），避免重复配置
    //   - 加上显式 AbortSignal.timeout + Bearer header，行为与 router 路径一致
    const config = PROVIDER_CONFIG[model.provider as keyof typeof PROVIDER_CONFIG];
    if (!config) throw new Error(`Unknown provider: ${model.provider}`);

    const { getEffectiveApiKey, getEffectiveBaseURL } = await import("../utils/api-key-store.js");
    const apiKey = getEffectiveApiKey(model.provider, config.apiKeyEnv);
    if (!apiKey) throw new Error(`Missing API key for ${model.provider}: ${config.apiKeyEnv}`);

    const baseURL = getEffectiveBaseURL(model.provider, config.apiKeyEnv, config.baseURL);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (model.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://openclaw.ai";
      headers["X-Title"] = "OpenClaw Agent";
    }

    const res = await proxyFetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.model,
        messages,
        temperature: 0.3,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(TIMEOUTS.API_MEDIUM),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return { content: data.choices?.[0]?.message?.content ?? null };
  }

  private parseResponse(
    content: string | null,
    elements?: InteractiveElement[]
  ): Omit<ComputerUseResult, "model" | "provider" | "latencyMs" | "elements" | "elementEnhanced"> {
    const empty = { reasoning: "", actions: [] as ComputerAction[], completed: false };
    if (!content) return empty;

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return empty;

      const parsed = JSON.parse(jsonMatch[0]);
      const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];

      // 解析 action，如果有 elementIndex 则解析为坐标
      const actions: ComputerAction[] = rawActions.map((a: any) => {
        const base = { type: a.type, description: a.description };
        if (a.elementIndex !== undefined && elements) {
          const el = elements.find((e) => e.index === a.elementIndex);
          if (el) {
            if (a.type === "click") {
              return { ...base, type: "click", x: el.centerX, y: el.centerY, elementIndex: a.elementIndex };
            }
            if (a.type === "type") {
              return { ...base, type: "type", text: a.text ?? "", elementIndex: a.elementIndex };
            }
          }
        }
        return a as ComputerAction;
      });

      return {
        reasoning: String(parsed.reasoning ?? ""),
        actions,
        completed: Boolean(parsed.completed),
      };
    } catch (e) {
      logger.warn("[ComputerUse] Parse failed", { error: (e as Error).message, content: content.slice(0, 200) });
      return empty;
    }
  }

  private async resolveElementCoordinates(
    action: ComputerAction,
    cdpUrl: string
  ): Promise<ComputerAction> {
    if (!(action as any).elementIndex) return action;

    try {
      const elements = await extractInteractiveElements(cdpUrl, 10000);
      const el = elements.find((e) => e.index === (action as any).elementIndex);
      if (el) {
        if (action.type === "click") {
          return { ...action, x: el.centerX, y: el.centerY };
        }
        if (action.type === "type") {
          // 先 click 聚焦，再 type
          await executeCDPAction({ type: "click", x: el.centerX, y: el.centerY }, cdpUrl, 5000);
        }
      }
    } catch {}

    return action;
  }
}

// ═══════════════════════════════════════════════════════════════
// 便捷函数
// ═══════════════════════════════════════════════════════════════

let globalAgent: ComputerUseAgent | null = null;

export function getComputerUseAgent(): ComputerUseAgent {
  if (!globalAgent) globalAgent = new ComputerUseAgent();
  return globalAgent;
}

export async function analyzeScreenshot(input: ComputerUseInput): Promise<ComputerUseResult> {
  return getComputerUseAgent().analyze(input);
}

export async function executeComputerAction(
  action: ComputerAction,
  cdpUrl?: string
): Promise<{ success: boolean; message?: string; screenshot?: string }> {
  return getComputerUseAgent().executeAction(action, cdpUrl);
}

export async function runComputerTask(
  goal: string,
  cdpUrl: string,
  targetUrl?: string,
  maxSteps?: number
): Promise<ComputerUseResult[]> {
  return getComputerUseAgent().runTask(goal, cdpUrl, targetUrl, maxSteps);
}
