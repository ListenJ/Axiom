/**
 * DRE 主服务宿主集成（P2，方案 A：单进程内共用 eventBus）。
 *
 * main.ts 启动时初始化一次 Kernel；/pipeline/stream 与 /dre/run 与 Kernel
 * 处于同一进程、同一 eventBus 单例，观测链路因此天然打通。
 * 开关：AXIOM_DRE_ENABLED=0 关闭（默认开启）。
 */
import { Kernel, ConfigLoader, type KernelConfig } from "./index.js";
import { readBool } from "../utils/env.js";
import { logger } from "../utils/logger.js";

let kernel: Kernel | null = null;
let startPromise: Promise<Kernel | null> | null = null;
/** L1 组合根注入项（如 cloudCaller 适配器），initDreKernel 时合并进 config */
let hostOverrides: Partial<KernelConfig> | null = null;

/** 组合根注入配置覆盖（必须在 initDreKernel 首次调用前设置） */
export function setDreHostOverrides(overrides: Partial<KernelConfig>): void {
  hostOverrides = overrides;
}

/** 主服务是否启用 DRE 宿主集成（AXIOM_DRE_ENABLED，默认 1） */
export function isDreHostEnabled(): boolean {
  return readBool("AXIOM_DRE_ENABLED", true);
}

/**
 * 初始化（或复用）DRE Kernel。幂等：并发调用共享同一次启动。
 * @returns Kernel 实例；宿主被禁用时返回 null。
 */
export async function initDreKernel(): Promise<Kernel | null> {
  if (!isDreHostEnabled()) {
    logger.info("[DRE] Host integration disabled (AXIOM_DRE_ENABLED=0)");
    return null;
  }
  if (kernel) return kernel;  if (!startPromise) {
    startPromise = (async () => {
      const config = new ConfigLoader().toKernelConfig() as KernelConfig;
      // L1：组合根注入项（cloudCaller 等）由 main.ts 通过 overrides 传入，
      // src/dre 包内不 import 上层 router。
      if (hostOverrides) Object.assign(config, hostOverrides);
      const k = new Kernel(config);
      await k.init();
      kernel = k;
      logger.info("[DRE] Kernel ready (host integration)", { state: k.getStatus().state });
      return k;
    })().catch((err) => {
      // 启动失败：复位 promise 与 kernel，允许下次调用重试（而非永久复用失败 promise）
      startPromise = null;
      kernel = null;
      throw err;
    });
  }
  return startPromise;
}

/** 当前已就绪的 Kernel（未初始化返回 null） */
export function getDreKernel(): Kernel | null {
  return kernel;
}

/** 关闭宿主 Kernel（幂等） */
export async function shutdownDreKernel(): Promise<void> {
  if (kernel) {
    await kernel.shutdown();
    kernel = null;
  }
  startPromise = null;
}


