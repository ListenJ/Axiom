/**
 * 模型能力注册表 v3.0 (统一版)
 *
 * 从 models.ts 导入数据，保持 assignModel/assignBatch 等高级逻辑。
 */

import { logger } from "../utils/logger.js";
import {
  UNIFIED_REGISTRY,
  getModel as _getModel,
  type UnifiedModel,
  type TaskRole,
  type ModelProvider,
} from "./models.js";

export type { TaskRole, ModelProvider };

export interface ModelCapability {
  id: string;
  provider: ModelProvider;
  model: string;
  roles: TaskRole[];
  contextWindow: number;
  adapter?: "claude_code" | "kimi_code";
  tags: string[];
  priority?: number;
  timeout?: number;
  maxRetries?: number;
  isFree?: boolean;
}

export interface AssignmentResult {
  role: TaskRole;
  model: ModelCapability;
  fallbackChain: ModelCapability[];
  reason: string;
}

// ========== 动态扩展注册表 ==========

const EXTENSIONS = new Map<string, ModelCapability>();

function toCapability(um: UnifiedModel): ModelCapability {
  return {
    id: um.id,
    provider: um.provider,
    model: um.model,
    roles: um.roles,
    contextWindow: um.contextWindow,
    tags: um.tags,
    priority: um.priority,
    timeout: um.timeout,
    maxRetries: um.maxRetries,
    isFree: um.isFree,
  };
}

function getAllCapabilities(): ModelCapability[] {
  const base = UNIFIED_REGISTRY.map(toCapability);
  const extended = Array.from(EXTENSIONS.values());
  return [...base, ...extended];
}

function getCapabilityRegistry(): Map<string, ModelCapability> {
  const map = new Map<string, ModelCapability>();
  for (const cap of getAllCapabilities()) {
    map.set(cap.id, cap);
  }
  return map;
}

// ========== 查询接口 ==========

export function findModelsForRole(role: TaskRole, opts?: {
  minContextWindow?: number;
  excludeAdapters?: boolean;
  excludeModels?: string[];
}): ModelCapability[] {
  const results: ModelCapability[] = [];

  for (const model of getAllCapabilities()) {
    if (!model.roles.includes(role)) continue;
    if (opts?.minContextWindow && model.contextWindow < opts.minContextWindow) continue;
    if (opts?.excludeAdapters && model.adapter) continue;
    if (opts?.excludeModels?.includes(model.id)) continue;
    results.push(model);
  }

  results.sort((a, b) => {
    const aIdx = a.roles.indexOf(role);
    const bIdx = b.roles.indexOf(role);
    return aIdx - bIdx;
  });

  return results;
}

export function getFallbackChain(modelId: string, role: TaskRole): ModelCapability[] {
  const alternatives = findModelsForRole(role);
  return alternatives.filter((m) => m.id !== modelId);
}

export function assignModel(role: TaskRole, opts?: {
  requireAdapter?: "claude_code" | "kimi_code";
  excludeModels?: string[];
}): AssignmentResult | null {
  const candidates = findModelsForRole(role, {
    excludeAdapters: !opts?.requireAdapter,
    excludeModels: opts?.excludeModels,
  });

  if (candidates.length === 0) {
    logger.warn(`[CapabilityRegistry] No model found for role: ${role}`);
    return null;
  }

  const primary = candidates[0];
  const fallbacks = getFallbackChain(primary.id, role);

  return {
    role,
    model: primary,
    fallbackChain: fallbacks.slice(0, 3),
    reason: `${primary.id} (${primary.provider}) → ${primary.roles.indexOf(role) === 0 ? "primary" : "secondary"} role match, ${primary.contextWindow.toLocaleString()} ctx`,
  };
}

export function assignBatch(roles: TaskRole[], opts?: {
  excludeModels?: string[];
}): Map<TaskRole, AssignmentResult> {
  const results = new Map<TaskRole, AssignmentResult>();
  const usedModels: string[] = opts?.excludeModels ? [...opts.excludeModels] : [];

  for (const role of roles) {
    const assignment = assignModel(role, { excludeModels: usedModels });
    if (assignment) {
      results.set(role, assignment);
      usedModels.push(assignment.model.id);
    }
  }
  return results;
}

export function listAllModels(): ModelCapability[] {
  return getAllCapabilities();
}

export function getModel(id: string): ModelCapability | undefined {
  return EXTENSIONS.get(id) ?? toCapability(_getModel(id)!);
}

export function registerModel(capability: ModelCapability): void {
  EXTENSIONS.set(capability.id, capability);
  logger.info(`[CapabilityRegistry] Registered model: ${capability.id} (${capability.provider})`);
}

export function listAllRoles(): TaskRole[] {
  const roles = new Set<TaskRole>();
  for (const model of getAllCapabilities()) {
    for (const role of model.roles) roles.add(role);
  }
  return Array.from(roles);
}
