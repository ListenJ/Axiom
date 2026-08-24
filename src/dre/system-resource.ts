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

/**
 * 审计 H-3（2026-08-24）：maxTokens 预算钳制纯函数。
 *
 * 此前 recommendedMaxTokens 仅写入日志，各调用方自传硬编码 maxTokens，
 * 请求可超 llama.cpp --ctx-size，行为取决于外部截断策略。现在所有 LLM
 * 调用点的 maxTokens 统一经此钳制：
 *   - recommended 有效（>0）→ min(requested, recommended)，下限 1
 *   - recommended 缺失/非法 → 原样返回（不臆造上限）
 */
export function clampMaxTokens(requested: number, recommended?: number): number {
  if (!recommended || recommended <= 0) return requested;
  return Math.max(1, Math.min(requested, Math.floor(recommended)));
}

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
  /** M12：滞回降级锁存 —— 跌破阈值后置位，需回升 required+RECOVERY_MARGIN_MB 才恢复 */
  private degraded = false;
  /** M12：availableMemory 连续被抖动过滤的同向次数（缓变逃逸用） */
  private availRejectStreak = 0;
  /** M12：上一次 attempted 小幅更新的方向（+1 上 / -1 下 / 0 无） */
  private lastAttemptedAvailDir = 0;

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
      if (curr === 0 || Math.abs(next - curr) / Math.abs(curr) >= DEBOUNCE_RATIO) {
        // 大幅更新：直接接受并重置同向计数
        this.availRejectStreak = 0;
        this.lastAttemptedAvailDir = 0;
      } else {
        // M12 缓变逃逸：仅当"同向小幅更新连续 ≥3 次"才接受，修复永久缓变失明；
        // 方向交替时计数归位 1 —— 平台期抖动（1299↔1301）永不过滤。
        const dir = Math.sign(next - curr);
        this.availRejectStreak = dir !== 0 && dir === this.lastAttemptedAvailDir ? this.availRejectStreak + 1 : 1;
        this.lastAttemptedAvailDir = dir;
        if (this.availRejectStreak < 3) {
          delete (filtered as any).availableMemory;
        }
        // streak>=3：不删除 → 接受本次及后续同向缓变，直至方向翻转或大幅更新重置
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

    // M12 双阈值滞回：恢复阈值 = required + 500MB，消除临界抖动翻转
    const RECOVERY_MARGIN_MB = 500;

    if (!this.degraded) {
      if (resource.availableMemory < requiredMB) {
        this.degraded = true;
        return {
          canRun: false,
          reason: `Insufficient memory: ${resource.availableMemory}MB available, need ${requiredMB}MB (model=${this.modelMemoryMB}MB + safety=${this.safetyMarginMB}MB)`,
          resource,
        };
      }
    } else {
      const recoverAt = requiredMB + RECOVERY_MARGIN_MB;
      if (resource.availableMemory < recoverAt) {
        return {
          canRun: false,
          reason: `Insufficient memory (hysteresis): ${resource.availableMemory}MB available, need >= ${recoverAt}MB to recover`,
          resource,
        };
      }
      this.degraded = false; // 恢复
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
