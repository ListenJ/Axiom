/**
 * System Resource — 通用资源预算接口
 *
 * 设计原则:
 * - Runtime 不关心底层硬件 (N卡/A卡/Apple Silicon/纯CPU)
 * - Runtime 只关心"我有多少资源预算"
 * - 硬件检测是 Infrastructure 层的插件, 由外部注入
 *
 * 替代原来的 VRAMBudgetManager (硬件强依赖 nvidia-smi)
 */

import { logger } from "../utils/logger.js";

export interface SystemResource {
  /** 总资源预算 (统一单位, 如 MB 表示内存, 任意数表示算力) */
  maxMemory: number;
  /** 当前可用资源 */
  availableMemory: number;
  /** 最大计算预算 (任意单位, 如 GFLOPS 或相对值) */
  maxCompute: number;
  /** 当前可用算力 */
  availableCompute: number;
  /** 资源来源: "plugin" | "manual" | "auto" */
  source: string;
}

export interface ResourceCheckResult {
  canRun: boolean;
  reason: string;
  recommendedMaxTokens?: number;
  resource: SystemResource;
}

/**
 * 默认资源预算 (纯CPU环境, 保守估计)
 */
const DEFAULT_RESOURCE: SystemResource = {
  maxMemory: 4000,
  availableMemory: 4000,
  maxCompute: 100,
  availableCompute: 100,
  source: "default",
};

/**
 * 资源预算管理器 (纯数字比较, 不调用任何硬件检测)
 */
export class ResourceBudgetManager {
  private resource: SystemResource;
  private modelMemoryMB: number;
  private safetyMarginMB: number;
  private kvCacheMaxMB: number;
  private bytesPerToken: number; // KV cache 每 token 字节数：Qwen3-1.7B 28层×2048隐×2(K/V)×2B(FP16)≈229KB/token (229376 bytes)，见 tests/unit/system-resource.test.ts 推导
  private maxTokensCap: number;      // token 上限

  constructor(opts?: {
    resource?: Partial<SystemResource>;
    modelMemoryMB?: number;
    safetyMarginMB?: number;
    kvCacheMaxMB?: number;
    bytesPerToken?: number;
    maxTokensCap?: number;
  }) {
    this.resource = { ...DEFAULT_RESOURCE, ...opts?.resource };
    this.modelMemoryMB = opts?.modelMemoryMB ?? 1100;
    this.safetyMarginMB = opts?.safetyMarginMB ?? 200;
    this.kvCacheMaxMB = opts?.kvCacheMaxMB ?? 2200;
    this.bytesPerToken = opts?.bytesPerToken ?? 28 * 2048 * 2 * 2; // 229376 bytes ≈224KB (1024) / 229KB (1000)，校准自 Qwen3-1.7B 28*2048*2*2，替代旧值 2 导致的 114688 倍误差
    this.maxTokensCap = opts?.maxTokensCap ?? 4096;
  }

  /**
   * 更新资源预算 (由外部插件/用户注入)
   * H-07 防抖：变化 <5% 视为抖动忽略，保持输出稳定（1299↔1301 不翻转）
   */
  updateResource(resource: Partial<SystemResource>): void {
    if (resource.availableMemory !== undefined && (resource.availableMemory < 0 || isNaN(resource.availableMemory))) {
      throw new Error("Invalid availableMemory: " + resource.availableMemory);
    }
    if (resource.maxMemory !== undefined && (resource.maxMemory <= 0 || isNaN(resource.maxMemory))) {
      throw new Error("Invalid maxMemory: " + resource.maxMemory);
    }
    const DEBOUNCE_RATIO = 0.05;
    const filtered: Partial<SystemResource> = { ...resource };
    if (resource.availableMemory !== undefined) {
      const curr = this.resource.availableMemory;
      const next = resource.availableMemory;
      if (curr !== 0 && Math.abs(next - curr) / Math.abs(curr) < DEBOUNCE_RATIO) {
        delete (filtered as any).availableMemory;
      }
    }
    if (resource.maxMemory !== undefined) {
      const curr = this.resource.maxMemory;
      const next = resource.maxMemory;
      if (curr !== 0 && Math.abs(next - curr) / Math.abs(curr) < DEBOUNCE_RATIO) {
        delete (filtered as any).maxMemory;
      }
    }
    if (Object.keys(filtered).length === 0) {
      logger.info("[ResourceBudget] Resource update filtered (jitter <5%)", {
        current: this.resource,
        attempted: resource,
      });
      return;
    }
    this.resource = { ...this.resource, ...filtered };
    logger.info("[ResourceBudget] Resource updated", {
      maxMemory: this.resource.maxMemory,
      availableMemory: this.resource.availableMemory,
      maxCompute: this.resource.maxCompute,
      source: this.resource.source,
    });
  }

  /**
   * 检查是否可以运行本地推理
   */
  canRun(): ResourceCheckResult {
    const { resource } = this;
    const requiredMB = this.modelMemoryMB + this.safetyMarginMB;

    if (resource.availableMemory < requiredMB) {
      return {
        canRun: false,
        reason: `Insufficient memory: ${resource.availableMemory}MB available, need ${requiredMB}MB (model=${this.modelMemoryMB}MB + safety=${this.safetyMarginMB}MB)`,
        resource,
      };
    }

    const availableForKV = resource.availableMemory - this.modelMemoryMB;
    // H2 审计修复：MB → 字节需 ×1024×1024（旧式 ×1024 仅到 KB，结果偏小 1024 倍）
    const recommendedMaxTokens = Math.floor(
      Math.min(availableForKV, this.kvCacheMaxMB) * 1024 * 1024 / this.bytesPerToken
    );

    return {
      canRun: true,
      reason: "Resource sufficient",
      resource,
      recommendedMaxTokens: Math.min(recommendedMaxTokens, this.maxTokensCap),
    };
  }

  /**
   * 获取当前资源状态
   */
  getStatus(): {
    resource: SystemResource;
    canRunLocal: boolean;
    recommendedMaxTokens: number;
    modelMemoryMB: number;
    safetyMarginMB: number;
  } {
    const check = this.canRun();
    return {
      resource: this.resource,
      canRunLocal: check.canRun,
      recommendedMaxTokens: check.recommendedMaxTokens ?? 0,
      modelMemoryMB: this.modelMemoryMB,
      safetyMarginMB: this.safetyMarginMB,
    };
  }

  /**
   * 获取当前资源快照
   */
  getResource(): SystemResource {
    return { ...this.resource };
  }
}

/** 全局单例 */
let instance: ResourceBudgetManager | null = null;

export function getResourceBudgetManager(): ResourceBudgetManager {
  if (!instance) {
    instance = new ResourceBudgetManager();
  }
  return instance;
}
