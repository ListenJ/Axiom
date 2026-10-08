/**
 * DRE Kernel 工厂 —— 内核装配的单一来源。
 *
 * 背景（内核收敛）：`host.ts`（主服务）与 `mcp/server/dre-tools.ts`（MCP）曾各自
 * 写一遍 `new ConfigLoader().toKernelConfig()` + `new Kernel(...)`，导致参数与注入漂移。
 * 收敛到本工厂，所有 Kernel 装配（含 DRE daemon）都从这里出。
 *
 * 注意：工厂只做"装配"，不做"归属"。全进程应只存在**一个** Kernel 拥有者
 * （DRE daemon，见 docs/superpowers/plans/2026-10-08-kernel-consolidation.md）。
 */
import { ConfigLoader } from "./config.js";
import { Kernel, type KernelConfig } from "./kernel.js";

export interface CreateDreKernelOptions {
  /** 组合根注入项（cloudCaller / hallucinationGate / recordVerdict 等），覆盖 ConfigLoader 结果 */
  overrides?: Partial<KernelConfig>;
  /** 覆盖 tick 间隔（ms） */
  tickInterval?: number;
  /** 覆盖是否自动 tick */
  autoTick?: boolean;
}

/** 按统一口径构造一个 Kernel（未 init；调用方负责 init/shutdown） */
export function createDreKernel(opts: CreateDreKernelOptions = {}): Kernel {
  const config = new ConfigLoader().toKernelConfig() as KernelConfig;
  if (opts.overrides) Object.assign(config, opts.overrides);
  if (opts.tickInterval !== undefined) config.tickInterval = opts.tickInterval;
  if (opts.autoTick !== undefined) config.autoTick = opts.autoTick;
  return new Kernel(config);
}
