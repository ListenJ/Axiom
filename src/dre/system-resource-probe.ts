/**
 * DRE 可选硬件探测插件（整改 D2，2026-08-25）
 *
 * 设计原则（与 system-resource.ts 一致）：Runtime 只关心资源预算数字，
 * 硬件检测是可插拔的 Infrastructure 层，默认不挂载。
 *
 * 行为：
 *  - parseNvidiaSmiOutput：解析 `nvidia-smi --query-gpu=memory.free
 *    --format=csv,noheader,nounits` 的输出，取第一个 GPU 的空闲显存
 *    MiB 整数；空文本/垃圾文本/非整数值一律返回 null。
 *  - startVramProbe：仅当 env AXIOM_VRAM_PROBE=1 时启动轮询
 *    （首次立即探测 + setInterval），成功解析即写入
 *    ResourceBudgetManager.updateResource({ availableMemory })；
 *    未启用时返回 no-op stop 且不创建任何定时器（默认零行为变化）。
 *    exec 可注入以便测试；默认经 execFile 调用 nvidia-smi。
 */

import { execFile } from "node:child_process";
import { logger } from "../utils/logger.js";
import { readBool } from "../utils/env.js";
import { getResourceBudgetManager } from "./system-resource.js";

const QUERY_ARGS = ["--query-gpu=memory.free", "--format=csv,noheader,nounits"];
const DEFAULT_INTERVAL_MS = 60_000;

export function parseNvidiaSmiOutput(text: string): number | null {
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine === undefined) return null;
  return /^\d+$/.test(firstLine) ? parseInt(firstLine, 10) : null;
}

export interface VramProbeOptions {
  /** 轮询间隔，默认 60000ms */
  intervalMs?: number;
  /** 可注入的 nvidia-smi 执行器（测试 fake）；默认 execFile */
  exec?: (args: string[]) => Promise<{ stdout: string }>;
}

/**
 * 启动 VRAM 探测循环，返回 stop 函数。未设 AXIOM_VRAM_PROBE=1 时不做任何事。
 */
export function startVramProbe(opts?: VramProbeOptions): () => void {
  if (!readBool("AXIOM_VRAM_PROBE")) {
    return () => {};
  }

  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const exec =
    opts?.exec ??
    ((args: string[]) =>
      new Promise<{ stdout: string }>((resolve, reject) => {
        execFile("nvidia-smi", args, { windowsHide: true }, (err, stdout) => {
          if (err) reject(err);
          else resolve({ stdout });
        });
      }));

  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      const { stdout } = await exec(QUERY_ARGS);
      const mb = parseNvidiaSmiOutput(stdout);
      if (mb !== null && !stopped) {
        getResourceBudgetManager().updateResource({ availableMemory: mb });
        logger.debug("[VramProbe] updated availableMemory", { mb });
      }
    } catch (err) {
      // 可选插件：探测失败静默降级（保留 debug 观测）
      logger.debug("[VramProbe] nvidia-smi query failed", { error: String(err) });
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
