import { logger } from "./logger.js";
import { TIMEOUTS } from "../constants/timeouts.js";

export interface ShutdownHook {
  name: string;
  handler: () => Promise<void> | void;
  priority?: number;
}

const shutdownHooks: ShutdownHook[] = [];
let isShuttingDown = false;

export function registerShutdownHook(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
  shutdownHooks.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  logger.debug(`Registered shutdown hook: ${hook.name}`);
}

export function setupGracefulShutdown(options?: {
  timeout?: number;
  signals?: NodeJS.Signals[];
}): void {
  const { timeout = TIMEOUTS.GRACEFUL_SHUTDOWN, signals = ["SIGTERM", "SIGINT"] } = options || {};

  for (const signal of signals) {
    process.on(signal, async () => {
      logger.info(`Received ${signal}, starting graceful shutdown...`);
      await gracefulShutdown(timeout);
    });
  }

  // Handle uncaught exceptions
  process.on("uncaughtException", async (error: Error) => {
    logger.error("Uncaught exception:", error);
    await gracefulShutdown(timeout);
  });

  // 审计 Low（2026-08-29）：unhandledRejection 此前一次即触发全停机——单个未处理拒绝
  // （如第三方库的边缘分支）会直接杀掉进程。改为每次 log.error + 计数，滑动窗口内
  // 连续超过阈值才停机；错误本体始终完整记录，不吞错。
  const REJECTION_THRESHOLD = 5;
  const REJECTION_WINDOW_MS = 60_000;
  let rejectionCount = 0;
  let rejectionWindowTimer: ReturnType<typeof setTimeout> | null = null;
  process.on("unhandledRejection", async (reason: unknown) => {
    logger.error("Unhandled rejection:", reason as Error);
    rejectionCount++;
    if (rejectionWindowTimer) clearTimeout(rejectionWindowTimer);
    rejectionWindowTimer = setTimeout(() => {
      rejectionCount = 0;
    }, REJECTION_WINDOW_MS);
    if (rejectionCount >= REJECTION_THRESHOLD) {
      logger.error(
        `Unhandled rejections exceeded threshold (${rejectionCount}/${REJECTION_THRESHOLD} within ${REJECTION_WINDOW_MS / 1000}s), shutting down`,
      );
      await gracefulShutdown(timeout);
    }
  });
}

export async function gracefulShutdown(timeoutMs: number = TIMEOUTS.GRACEFUL_SHUTDOWN): Promise<void> {
  if (isShuttingDown) {
    logger.warn("Shutdown already in progress, waiting...");
    return;
  }

  isShuttingDown = true;
  const startTime = Date.now();

  logger.info(`Executing ${shutdownHooks.length} shutdown hooks...`);

  for (const hook of shutdownHooks) {
    if (Date.now() - startTime > timeoutMs) {
      logger.error(`Shutdown timeout reached (${timeoutMs}ms), forcing exit`);
      process.exit(1);
    }

    try {
      logger.debug(`Running shutdown hook: ${hook.name}`);
      // 审计 Low（2026-08-29）：剩余预算 <= 0 时 setTimeout 会以 0/负延迟立即触发，
      // 把尚在执行的钩子误判为超时；预算耗尽按超时语义统一 force exit。
      const remaining = Math.min(10000, timeoutMs - (Date.now() - startTime));
      if (remaining <= 0) {
        logger.error(`Shutdown timeout reached (${timeoutMs}ms), forcing exit`);
        process.exit(1);
      }
      let raceTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          hook.handler(),
          new Promise((_resolve, reject) => {
            raceTimer = setTimeout(
              () => reject(new Error(`Shutdown hook "${hook.name}" timed out`)),
              remaining,
            );
          }),
        ]);
      } finally {
        // 竞速结束后复位计时器，避免悬空定时器保持事件循环或误触发
        if (raceTimer) clearTimeout(raceTimer);
      }
      logger.debug(`Shutdown hook completed: ${hook.name}`);
    } catch (error) {
      logger.error(`Shutdown hook failed: ${hook.name}`, error as Error);
    }
  }

  const elapsed = Date.now() - startTime;
  logger.info(`Graceful shutdown completed in ${elapsed}ms`);
  process.exit(0);
}

