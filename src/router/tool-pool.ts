/**
 * 免费工具模型池 (Tool Model Pool)
 * 管理免费模型的限流、配额、健康状态和负载均衡
 *
 * 免费模型限制（来自 OpenRouter 文档）:
 *   - 速率限制: 通常 1-10 RPM (requests per minute)
 *   - 并发限制: 通常 1-2 并发请求
 *   - 每日配额: 有限制，超过后返回 429
 *
 * 策略:
 *   1. Token Bucket 限流（每分钟请求数限制）
 *   2. 健康检查（连续失败自动降级）
 *   3. Round-robin 负载均衡（同角色多模型轮询）
 *   4. 熔断器（连续失败 N 次后暂停使用）
 */
import { logger } from "../utils/logger.js";

export interface ToolModel {
  id: string;                 // 模型完整 ID，如 "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
  provider: string;           // 提供商，通常是 "openrouter"
  role: ToolRole;             // 角色分类
  rpmLimit: number;           // 每分钟请求限制
  concurrentLimit: number;    // 并发请求限制
  description: string;
}

export type ToolRole =
  | "coding"        // 编码任务
  | "english"       // 英文处理
  | "rl"            // 强化学习 / 推理
  | "general-tool"  // 通用工具
  | "evaluation";   // 评估（付费但有额度限制）

/** 免费工具模型注册表 */
const TOOL_MODEL_REGISTRY: ToolModel[] = [
  // === 编码模型 ===
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    provider: "openrouter",
    role: "coding",
    rpmLimit: 5,
    concurrentLimit: 1,
    description: "NVIDIA Nemotron 3 Nano - 轻量推理编码模型",
  },
  {
    id: "deepseek/deepseek-v4-flash:free",
    provider: "openrouter",
    role: "coding",
    rpmLimit: 10,
    concurrentLimit: 2,
    description: "DeepSeek V4 Flash - 快速编码模型",
  },
  {
    id: "z-ai/glm-4.5-air:free",
    provider: "openrouter",
    role: "coding",
    rpmLimit: 8,
    concurrentLimit: 1,
    description: "GLM 4.5 Air - 轻量中文编码模型",
  },
  {
    id: "qwen/qwen3-coder-480b-a35b-instruct-turbo:free",
    provider: "openrouter",
    role: "coding",
    rpmLimit: 8,
    concurrentLimit: 1,
    description: "Qwen3 Coder Turbo - 阿里代码模型",
  },

  // === 英文处理 ===
  {
    id: "google/gemma-4-31b-it:free",
    provider: "openrouter",
    role: "english",
    rpmLimit: 5,
    concurrentLimit: 1,
    description: "Google Gemma 4 31B IT - 英文理解和生成",
  },

  // === RL / 深度推理 ===
  {
    id: "arcee-ai/trinity-large-thinking:free",
    provider: "openrouter",
    role: "rl",
    rpmLimit: 3,
    concurrentLimit: 1,
    description: "Arcee Trinity Large Thinking - RL/推理模型",
  },

  // === 通用工具模型 ===
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    provider: "openrouter",
    role: "general-tool",
    rpmLimit: 3,
    concurrentLimit: 1,
    description: "NVIDIA Nemotron 3 Super 120B - 通用大模型",
  },
  {
    id: "openai/gpt-oss-120b:free",
    provider: "openrouter",
    role: "general-tool",
    rpmLimit: 3,
    concurrentLimit: 1,
    description: "OpenAI GPT-OSS 120B - 开源通用模型",
  },
  {
    id: "nousresearch/hermes-3-llama-3.1-405b:free",
    provider: "openrouter",
    role: "general-tool",
    rpmLimit: 3,
    concurrentLimit: 1,
    description: "Nous Hermes 3 Llama 3.1 405B - 通用大模型",
  },

  // === 评估层（付费但额度有限）===
  {
    id: "tencent/hy3-preview",
    provider: "openrouter",
    role: "evaluation",
    rpmLimit: 5,
    concurrentLimit: 1,
    description: "Tencent Hunyuan 3 Preview - 评估/决策（$5额度，谨慎使用）",
  },
];

/** 单个模型的运行时状态 */
interface ModelRuntimeState {
  lastMinuteRequests: number[];   // 时间戳数组，最近一分钟的请求
  activeRequests: number;         // 当前活跃请求数
  consecutiveFailures: number;    // 连续失败次数
  circuitOpen: boolean;           // 熔断器是否打开
  circuitOpenUntil: number;       // 熔断器恢复时间
  totalCalls: number;             // 总调用次数
  totalFailures: number;          // 总失败次数
}

export class ToolModelPool {
  private states = new Map<string, ModelRuntimeState>();
  private roleIndex = new Map<ToolRole, number>(); // round-robin 索引

  constructor() {
    for (const m of TOOL_MODEL_REGISTRY) {
      this.states.set(m.id, {
        lastMinuteRequests: [],
        activeRequests: 0,
        consecutiveFailures: 0,
        circuitOpen: false,
        circuitOpenUntil: 0,
        totalCalls: 0,
        totalFailures: 0,
      });
      if (!this.roleIndex.has(m.role)) {
        this.roleIndex.set(m.role, 0);
      }
    }
  }

  /** 获取某角色的可用模型列表（已过滤掉熔断和超限的） */
  getAvailableModels(role: ToolRole): ToolModel[] {
    const now = Date.now();
    return TOOL_MODEL_REGISTRY.filter((m) => {
      if (m.role !== role) return false;
      const state = this.states.get(m.id)!;

      // 检查熔断器
      if (state.circuitOpen) {
        if (now < state.circuitOpenUntil) return false;
        // 熔断器恢复
        state.circuitOpen = false;
        state.consecutiveFailures = 0;
      }

      // 清理过期的请求记录（超过1分钟）
      state.lastMinuteRequests = state.lastMinuteRequests.filter((t) => now - t < 60000);

      // 检查 RPM 限制
      if (state.lastMinuteRequests.length >= m.rpmLimit) return false;

      // 检查并发限制
      if (state.activeRequests >= m.concurrentLimit) return false;

      return true;
    });
  }

  /** Round-robin 选择下一个可用模型 */
  selectNext(role: ToolRole): ToolModel | null {
    const available = this.getAvailableModels(role);
    if (available.length === 0) return null;

    const idx = this.roleIndex.get(role) || 0;
    const model = available[idx % available.length];
    this.roleIndex.set(role, (idx + 1) % available.length);
    return model;
  }

  /** 标记请求开始 */
  markRequestStart(modelId: string): void {
    const state = this.states.get(modelId);
    if (!state) return;
    state.activeRequests++;
    state.lastMinuteRequests.push(Date.now());
    state.totalCalls++;
  }

  /** 标记请求成功 */
  markRequestSuccess(modelId: string): void {
    const state = this.states.get(modelId);
    if (!state) return;
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    state.consecutiveFailures = 0;
  }

  /** 标记请求失败 */
  markRequestFailure(modelId: string, error?: string): void {
    const state = this.states.get(modelId);
    if (!state) return;
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    state.consecutiveFailures++;
    state.totalFailures++;

    // 熔断逻辑：连续 3 次失败，熔断 60 秒
    if (state.consecutiveFailures >= 3) {
      state.circuitOpen = true;
      state.circuitOpenUntil = Date.now() + 60000;
      logger.warn(`[ToolPool] Circuit breaker OPEN for ${modelId} (3 consecutive failures)`, {
        error,
        resumeAt: new Date(state.circuitOpenUntil).toISOString(),
      });
    }
  }

  /** 获取池状态报告 */
  getStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {};
    for (const m of TOOL_MODEL_REGISTRY) {
      const state = this.states.get(m.id)!;
      stats[m.id] = {
        role: m.role,
        activeRequests: state.activeRequests,
        rpmThisMinute: state.lastMinuteRequests.filter((t) => Date.now() - t < 60000).length,
        rpmLimit: m.rpmLimit,
        consecutiveFailures: state.consecutiveFailures,
        circuitOpen: state.circuitOpen,
        totalCalls: state.totalCalls,
        totalFailures: state.totalFailures,
        health: state.circuitOpen ? "🔴熔断" : state.consecutiveFailures > 0 ? "🟡告警" : "🟢健康",
      };
    }
    return stats;
  }

  /** 列出所有注册模型 */
  listModels(): ToolModel[] {
    return [...TOOL_MODEL_REGISTRY];
  }
}

export const toolPool = new ToolModelPool();
