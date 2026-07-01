/**
 * VRAM 预算管理器
 *
 * 目标硬件: RTX 3050 Ti 4GB VRAM
 * Qwen3-1.7B Q4_K_M ≈ 1.1GB 模型占用
 * 剩余 KV Cache ≈ 2.4GB
 *
 * 功能:
 * 1. 检测 GPU VRAM 可用性 (nvidia-smi)
 * 2. 提供预算检查 (是否可以运行本地推理)
 * 3. 推荐最大上下文长度
 * 4. 自动降级到云 API
 */

import { logger } from "../utils/logger.js";

/** VRAM 预算配置 */
export interface VRAMBudgetConfig {
  /** 模型基础占用 (MB) */
  modelBaseMB: number;
  /** KV Cache 最大可用 (MB) */
  kvCacheMaxMB: number;
  /** 安全余量 (MB) */
  safetyMarginMB: number;
  /** 触发降级的最小可用 VRAM (MB) */
  fallbackThresholdMB: number;
}

/** GPU 信息 */
export interface GPUInfo {
  available: boolean;
  name?: string;
  totalMemoryMB?: number;
  usedMemoryMB?: number;
  freeMemoryMB?: number;
  driverVersion?: string;
}

/** 默认配置: RTX 3050 Ti 4GB */
const DEFAULT_CONFIG: VRAMBudgetConfig = {
  modelBaseMB: 1100,
  kvCacheMaxMB: 2200,
  safetyMarginMB: 200,
  fallbackThresholdMB: 500,
};

class VRAMBudgetManager {
  private config: VRAMBudgetConfig;
  private cachedGPU: GPUInfo | null = null;
  private lastCheckTime: number = 0;
  private checkIntervalMs: number = 30000; // 30秒缓存

  constructor(config?: Partial<VRAMBudgetConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检测 GPU 信息 (通过 nvidia-smi)
   */
  async detectGPU(): Promise<GPUInfo> {
    const now = Date.now();
    if (this.cachedGPU && now - this.lastCheckTime < this.checkIntervalMs) {
      return this.cachedGPU;
    }

    try {
      const { execSync } = await import("node:child_process");
      const output = execSync(
        'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,driver_version --format=csv,noheader,nounits',
        { encoding: "utf-8", timeout: 5000 }
      );

      const parts = output.trim().split(", ");
      if (parts.length >= 5) {
        this.cachedGPU = {
          available: true,
          name: parts[0],
          totalMemoryMB: parseInt(parts[1]),
          usedMemoryMB: parseInt(parts[2]),
          freeMemoryMB: parseInt(parts[3]),
          driverVersion: parts[4],
        };
      } else {
        this.cachedGPU = { available: false };
      }
    } catch (err) {
      logger.debug("[VRAM] nvidia-smi detection failed", { error: (err as Error).message });
      this.cachedGPU = { available: false };
    }

    this.lastCheckTime = now;
    return this.cachedGPU;
  }

  /**
   * 检查是否有足够 VRAM 运行本地推理
   */
  async canRunLocal(): Promise<{
    canRun: boolean;
    reason: string;
    gpu?: GPUInfo;
    recommendedMaxTokens?: number;
  }> {
    const gpu = await this.detectGPU();

    if (!gpu.available) {
      return {
        canRun: false,
        reason: "No NVIDIA GPU detected",
        gpu,
      };
    }

    const freeMB = gpu.freeMemoryMB || 0;
    const requiredMB = this.config.modelBaseMB + this.config.safetyMarginMB;

    if (freeMB < this.config.fallbackThresholdMB) {
      return {
        canRun: false,
        reason: `VRAM too low: ${freeMB}MB free (threshold: ${this.config.fallbackThresholdMB}MB)`,
        gpu,
      };
    }

    if (freeMB < requiredMB) {
      return {
        canRun: false,
        reason: `Insufficient VRAM for model: ${freeMB}MB free, need ${requiredMB}MB`,
        gpu,
      };
    }

    // 计算推荐最大 KV Cache tokens
    const availableForKV = freeMB - this.config.modelBaseMB;
    const recommendedMaxTokens = Math.floor(
      Math.min(availableForKV, this.config.kvCacheMaxMB) * 1024 / 2
    );

    return {
      canRun: true,
      reason: "VRAM sufficient",
      gpu,
      recommendedMaxTokens: Math.min(recommendedMaxTokens, 4096),
    };
  }

  /**
   * 获取当前预算状态
   */
  async getStatus(): Promise<{
    gpu: GPUInfo;
    budget: VRAMBudgetConfig;
    canRunLocal: boolean;
    recommendedMaxTokens: number;
  }> {
    const gpu = await this.detectGPU();
    const check = await this.canRunLocal();

    return {
      gpu,
      budget: this.config,
      canRunLocal: check.canRun,
      recommendedMaxTokens: check.recommendedMaxTokens || 0,
    };
  }
}

/** 全局单例 */
let manager: VRAMBudgetManager | null = null;

export function getVRAMBudgetManager(): VRAMBudgetManager {
  if (!manager) {
    manager = new VRAMBudgetManager();
  }
  return manager;
}

export { VRAMBudgetManager };
export type { VRAMBudgetConfig as BudgetConfig };
