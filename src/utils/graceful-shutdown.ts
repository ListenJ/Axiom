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

  // Handle unhandled rejections
  process.on("unhandledRejection", async (reason: unknown) => {
    logger.error("Unhandled rejection:", reason as Error);
    await gracefulShutdown(timeout);
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
      await Promise.race([
        hook.handler(),
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`Shutdown hook "${hook.name}" timed out`)),
            Math.min(10000, timeoutMs - (Date.now() - startTime))
          );
        }),
      ]);
      logger.debug(`Shutdown hook completed: ${hook.name}`);
    } catch (error) {
      logger.error(`Shutdown hook failed: ${hook.name}`, error as Error);
    }
  }

  const elapsed = Date.now() - startTime;
  logger.info(`Graceful shutdown completed in ${elapsed}ms`);
  process.exit(0);
}

export function isShutdownInProgress(): boolean {
  return isShuttingDown;
}
