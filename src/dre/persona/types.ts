/**
 * Persona System — 动态运行时配置上下文
 *
 * Persona 不是 Agent，而是 Runtime 的一组特定配置:
 *   Persona = Constraints + MentalModels + Capabilities + PromptTemplate
 *
 * - "切换到安全审计模式" -> 加载 SecurityPersona
 * - "切换到创意写作模式" -> 加载 CreativePersona
 *
 * 这替代了原来的硬编码 AgentHarness 子类。
 */

import type { Constraint } from "../constraint/solver.js";
import type { CapabilityContract } from "../runtime/capability-registry.js";
import type { PromptTemplate } from "./prompt-store.js";

/** 对话模式 (替换原来的 Agent 类型) */
export type PersonaMode =
  | "plan"         // 确定性规划
  | "code"         // 代码生成/重构
  | "retrieve"     // 知识检索
  | "reflect"      // 自监督/反思
  | "audit"        // 安全审计
  | "creative"     // 创意生成
  | "research"     // 研究分析
  | "general";     // 通用模式

/** Persona 配置 */
export interface PersonaConfig {
  /** Persona 唯一 ID */
  id: string;
  /** Persona 名称 */
  name: string;
  /** 模式 */
  mode: PersonaMode;
  /** 描述 */
  description: string;
  /** 系统提示模板 ID */
  promptTemplateId: string;
  /** 该 Persona 需要的约束列表 */
  constraints: Constraint[];
  /** 该 Persona 激活的心智模型 ID 列表 */
  mentalModelIds: string[];
  /** 该 Persona 需要的能力契约列表 */
  requiredCapabilities: CapabilityContract[];
  /** 是否允许写操作 */
  allowWrite: boolean;
  /** 是否允许工具调用 */
  allowToolCalls: boolean;
  /** 最大推理步数 */
  maxSteps: number;
  /** LLM 温度 (0=确定性) */
  temperature: number;
  /** Persona 元数据 */
  metadata: Record<string, unknown>;
}

/** 加载的 Persona 实例 */
export interface LoadedPersona {
  config: PersonaConfig;
  /** 加载时间 */
  loadedAt: number;
  /** 激活的约束 IDs */
  activeConstraints: string[];
  /** 激活的心智模型 */
  activeMentalModels: string[];
  /** 当前提示模板 */
  promptTemplate: PromptTemplate;
}

/** Persona 切换上下文 */
export interface PersonaContext {
  /** 当前 Persona */
  current: LoadedPersona;
  /** 历史 Persona 栈 (支持回退) */
  stack: LoadedPersona[];
  /** 切换历史 */
  history: Array<{
    from: PersonaMode;
    to: PersonaMode;
    timestamp: number;
    reason: string;
  }>;
}

// ─── 预定义 Persona ─────────────────────────────────────────────────────────

/** 安全审计 Persona */
export const SECURITY_PERSONA_CONFIG: Omit<PersonaConfig, "constraints" | "mentalModelIds" | "requiredCapabilities"> = {
  id: "persona-security-audit",
  name: "安全审计",
  mode: "audit",
  description: "安全审计模式: 禁止写操作, 专注静态分析和漏洞检测",
  promptTemplateId: "prompt-audit",
  allowWrite: false,
  allowToolCalls: true,
  maxSteps: 80,
  temperature: 0,
  metadata: {},
};

/** 创意写作 Persona */
export const CREATIVE_PERSONA_CONFIG: Omit<PersonaConfig, "constraints" | "mentalModelIds" | "requiredCapabilities"> = {
  id: "persona-creative",
  name: "创意写作",
  mode: "creative",
  description: "创意写作模式: 鼓励发散思维, 高温度",
  promptTemplateId: "prompt-creative",
  allowWrite: true,
  allowToolCalls: true,
  maxSteps: 100,
  temperature: 0.7,
  metadata: {},
};

/** 通用 Persona */
export const GENERAL_PERSONA_CONFIG: Omit<PersonaConfig, "constraints" | "mentalModelIds" | "requiredCapabilities"> = {
  id: "persona-general",
  name: "通用模式",
  mode: "general",
  description: "通用协作模式: 允许读写, 平衡的温度",
  promptTemplateId: "prompt-general",
  allowWrite: true,
  allowToolCalls: true,
  maxSteps: 50,
  temperature: 0.3,
  metadata: {},
};
