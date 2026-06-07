/**
 * Computer Use Agent — 视觉驱动的计算机自动化
 *
 * 能力:
 *   - 接收屏幕截图 (base64 / URL) 并分析
 *   - 返回结构化操作指令 (click, type, scroll, keypress, wait)
 *   - 支持多步骤任务规划 (plan → execute → verify)
 *   - 自动路由到 vision-capable 模型
 *
 * 使用方式:
 *   // 单步分析
 *   const result = await analyzeScreenshot({ imageBase64: "...", task: "点击登录按钮" });
 *
 *   // 多步任务
 *   const result = await runComputerTask({
 *     images: ["..."],
 *     goal: "在网站上搜索 'OpenClaw' 并复制第一个结果",
 *   });
 */

import { logger } from "../utils/logger.js";
import { proxyFetch } from "../utils/proxy-fetch.js";
import { findModelsForRole, type TaskRole } from "../router/model-capability-registry.js";
import { PROVIDER_CONFIG } from "../router/models.js";
import { TIMEOUTS } from "../constants/timeouts.js";

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ComputerUseInput {
  /** 任务描述 */
  task: string;
  /** 当前屏幕截图 (base64, 不含 data URI 前缀) */
  imageBase64?: string;
  /** 图片 URL (与 imageBase64 二选一) */
  imageUrl?: string;
  /** 图片 MIME 类型 (默认 image/png) */
  imageType?: string;
  /** 历史操作记录 (用于多步任务上下文) */
  history?: ComputerAction[];
  /** 指定模型 (可选) */
  modelId?: string;
  /** 系统提示覆盖 */
  systemPrompt?: string;
}

export interface ComputerUseResult {
  /** 模型思考过程 */
  reasoning: string;
  /** 建议的操作列表 */
  actions: ComputerAction[];
  /** 是否认为任务已完成 */
  completed: boolean;
  /** 使用的模型 */
  model: string;
  /** 使用的 provider */
  provider: string;
  /** 延迟 ms */
  latencyMs: number;
}

export type ComputerAction =
  | { type: "click"; x: number; y: number; button?: "left" | "right"; description?: string }
  | { type: "type"; text: string; description?: string }
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

const DEFAULT_SYSTEM_PROMPT = `You are a computer automation assistant. Analyze the provided screenshot and return a JSON object describing the next action(s) to take.

Rules:
- Return ONLY valid JSON. No markdown, no explanation outside JSON.
- Coordinate system: (0,0) is top-left. x increases right, y increases down.
- Use the exact element positions visible in the screenshot.

JSON format:
{
  "reasoning": "Brief thought process (1-2 sentences)",
  "completed": false,
  "actions": [
    { "type": "click", "x": 120, "y": 340, "description": "Click login button" },
    { "type": "type", "text": "hello world", "description": "Enter search query" },
    { "type": "keypress", "keys": ["Enter"], "description": "Submit form" },
    { "type": "scroll", "x": 500, "y": 400, "scrollY": -300, "description": "Scroll down" },
    { "type": "wait", "ms": 1000, "description": "Wait for page load" },
    { "type": "screenshot", "description": "Take another screenshot" },
    { "type": "done", "answer": "Task result", "description": "Task complete" }
  ]
}

Available action types:
- click: x, y, button (left/right)
- type: text
- keypress: keys (array of key names like ["Control", "c"])
- scroll: x, y, scrollX, scrollY
- move: x, y
- wait: ms (milliseconds)
- screenshot: request new screenshot
- done: answer (final result, only when completed=true)`;

// ═══════════════════════════════════════════════════════════════
// 核心 Computer Use Agent
// ═══════════════════════════════════════════════════════════════

export class ComputerUseAgent {
  private systemPrompt: string;

  constructor(options?: { systemPrompt?: string }) {
    this.systemPrompt = options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  /**
   * 分析单张截图并返回操作建议
   */
  async analyzeScreenshot(input: ComputerUseInput): Promise<ComputerUseResult> {
    const startTime = Date.now();
    const model = this.selectModel(input.modelId);

    const messages = this.buildMessages(input);
    const result = await this.callVisionModel(model, messages);

    const parsed = this.parseResponse(result.content);
    return {
      ...parsed,
      model: model.model,
      provider: model.provider,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * 执行多步计算机任务
   *
   * 交互式循环：分析 → 操作 → 截图 → 分析 → ...
   * 由于 OpenClaw 是后端 Agent，实际执行需要前端/MCP 配合。
   * 本方法返回完整的操作计划，由调用方逐步执行。
   */
  async planTask(
    goal: string,
    initialScreenshot: { imageBase64?: string; imageUrl?: string; imageType?: string }
  ): Promise<ComputerUseResult> {
    return this.analyzeScreenshot({
      task: goal,
      ...initialScreenshot,
      systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\nThis is a multi-step task. Plan all necessary actions and return them in the actions array. If you cannot complete all steps from a single screenshot, end with a "screenshot" action to request the next frame.`,
    });
  }

  /**
   * 获取可用的 vision 模型列表
   */
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
      throw new Error("No vision model available. Configure an API key for a multimodal provider (OpenRouter, OfoxAI, etc.).");
    }

    if (preferredId) {
      const found = candidates.find((c) => c.id === preferredId);
      if (found) return found;
    }

    // 优先选择非 legacy、优先级高的模型
    const sorted = [...candidates].sort((a, b) => {
      const aLegacy = a.tags.includes("legacy") ? 1 : 0;
      const bLegacy = b.tags.includes("legacy") ? 1 : 0;
      if (aLegacy !== bLegacy) return aLegacy - bLegacy;
      return (a.priority ?? 99) - (b.priority ?? 99);
    });

    return sorted[0];
  }

  private buildMessages(input: ComputerUseInput): VisionMessage[] {
    const messages: VisionMessage[] = [
      { role: "system", content: input.systemPrompt ?? this.systemPrompt },
    ];

    // 历史上下文
    if (input.history && input.history.length > 0) {
      messages.push({
        role: "user",
        content: `Previous actions taken:\n${JSON.stringify(input.history, null, 2)}`,
      });
      messages.push({
        role: "assistant",
        content: "Understood. I will continue from the current state.",
      });
    }

    // 构建带图片的用户消息
    const userContent: VisionContentPart[] = [
      { type: "text", text: input.task },
    ];

    if (input.imageBase64) {
      const mime = input.imageType ?? "image/png";
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:${mime};base64,${input.imageBase64}`,
          detail: "high",
        },
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

  private parseResponse(content: string | null): Omit<ComputerUseResult, "model" | "provider" | "latencyMs"> {
    const empty = { reasoning: "", actions: [] as ComputerAction[], completed: false };
    if (!content) return empty;

    try {
      // 提取 JSON（模型可能包裹在 markdown 代码块中）
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return empty;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        reasoning: String(parsed.reasoning ?? ""),
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        completed: Boolean(parsed.completed),
      };
    } catch (e) {
      logger.warn("[ComputerUse] Failed to parse model response", {
        error: (e as Error).message,
        content: content.slice(0, 200),
      });
      return empty;
    }
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

/** 快速分析截图 */
export async function analyzeScreenshot(
  input: ComputerUseInput
): Promise<ComputerUseResult> {
  return getComputerUseAgent().analyzeScreenshot(input);
}

/** 规划多步任务 */
export async function planComputerTask(
  goal: string,
  screenshot: { imageBase64?: string; imageUrl?: string; imageType?: string }
): Promise<ComputerUseResult> {
  return getComputerUseAgent().planTask(goal, screenshot);
}
