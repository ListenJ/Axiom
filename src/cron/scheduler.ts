/**
 * Bun Cron 定时任务调度器
 * 自动执行：健康检查 / 免费模型发现 / 代理检查 / 心跳
 *
 * 运行: bun run src/cron/scheduler.ts   （import.meta.main 守卫，直接运行即启动）
 * 或在主服务中显式调用 startCronScheduler()
 *
 * 审计修复（2026-09-14）：原先本模块在**顶层**建库、注册 Bun.cron 并立即执行一次
 * healthCheckTask()，于是任何 import 它的代码都会：①在磁盘上建库 ②注册 4 个全局
 * 定时任务 ③触发真实外呼 ④安装进程级监听器。现收敛为显式启动：
 *   - 数据库惰性打开（getDb()），import 不落盘
 *   - cron 注册与进程监听器只在 startCronScheduler() 内进行
 *   - 直接运行本文件时由 import.meta.main 守卫自动启动，保持原命令行用法不变
 */
import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";

let _db: Database | null = null;

/** 惰性打开数据库：import 本模块不再产生落盘副作用 */
function getDb(): Database {
  if (_db) return _db;
  const dbPath = readString("DATABASE_PATH", "./data/agent.db");
  const db = new Database(dbPath);
  try { db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA busy_timeout=5000"); } catch {}
  _db = db;
  return db;
}

async function withRetry<T>(fn: () => T | Promise<T>, retries = 1): Promise<T> {
  try {
    return await fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (retries > 0 && /database is locked|SQLITE_BUSY/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 100));
      return await fn();
    }
    throw e;
  }
}

// ===== 任务 1: 平台健康检查（每 60 秒）=====
async function healthCheckTask() {
  try {
    const checks: Record<string, boolean> = {};
    const platforms = [
      { name: "siliconflow", url: "https://api.siliconflow.cn/v1/models", key: readString("SILICONFLOW_API_KEY") },
      { name: "ofoxai", url: "https://api.ofox.ai/v1/models", key: readString("OFOXAI_API_KEY") },
      { name: "openrouter", url: "https://openrouter.ai/api/v1/models", key: readString("OPENROUTER_API_KEY") },
      { name: "deepseek", url: "https://api.deepseek.com/v1/models", key: readString("DEEPSEEK_API_KEY") },
    ];

    for (const p of platforms) {
      if (!p.key) { checks[p.name] = false; continue; }
      try {
        const res = await fetch(p.url, {
          headers: { Authorization: `Bearer ${p.key}` },
          signal: AbortSignal.timeout(5000),
        });
        checks[p.name] = res.ok;
      } catch { checks[p.name] = false; }
    }

    await withRetry(() =>
      getDb().run(
        `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        ["health_check", JSON.stringify({ time: new Date().toISOString(), checks })],
      ),
    );

    const up = Object.values(checks).filter(Boolean).length;
    logger.info(`[Cron] Health check: ${up}/${platforms.length} platforms up`);
  } catch (e: unknown) {
    logger.warn("[Cron] healthCheck failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

// ===== 任务 2: 免费模型发现（每 10 分钟）=====
async function discoverFreeModelsTask() {
  logger.info("[Cron] Discovering free models...");
  try {
    // 触发免费模型发现脚本的逻辑
    // 这里简化处理，实际可调用 scripts/discover-free-models.ts
    const freeCount = getDb().query("SELECT COUNT(*) as c FROM free_models WHERE is_available = 1").get() as { c: number } | null;
    logger.info(`[Cron] Current free models: ${freeCount?.c || 0}`);
  } catch (e: unknown) {
    logger.warn("[Cron] Free model discovery failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

// ===== 任务 3: 心跳（每 30 分钟）=====
async function heartbeatTask() {
  try {
    logger.info("[Cron] HEARTBEAT — System OK");
    await withRetry(() =>
      getDb().run(
        `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        ["heartbeat", new Date().toISOString()],
      ),
    );
  } catch (e: unknown) {
    logger.warn("[Cron] heartbeat failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

// ===== 任务 5: 清理过期缓存（每天凌晨）=====
async function cleanupTask() {
  try {
    logger.info("[Cron] Running daily cleanup...");
    getDb().run(`DELETE FROM search_history WHERE created_at < unixepoch() - 2592000`);
    getDb().run(`DELETE FROM crawl_results WHERE status != 'success' AND created_at < unixepoch() - 604800`);
    logger.info("[Cron] Cleanup complete");
  } catch (e: unknown) {
    logger.warn("[Cron] cleanup failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

// ===== 显式启动 =====

/** 启动选项（默认全开，保持原"import 即启动"的等价行为需显式调用） */
export interface StartCronOptions {
  /** 是否注册 Bun.cron 定时任务（默认 true） */
  registerCron?: boolean;
  /** 是否在启动时立即跑一次健康检查（默认 true） */
  runImmediately?: boolean;
  /** 是否安装 unhandledRejection / uncaughtException 监听器（默认 true） */
  installProcessHandlers?: boolean;
}

/**
 * 显式启动 cron 调度器。
 *
 * 幂等：重复调用不会重复注册（第二次起为 no-op）。**只有本函数（或直接运行本文件）
 * 才会产生副作用**；单纯 import 不会建库、不会注册定时任务、不会外呼。
 */
let _started = false;
export function startCronScheduler(opts: StartCronOptions = {}): void {
  if (_started) return;
  _started = true;

  const {
    registerCron = true,
    runImmediately = true,
    installProcessHandlers = true,
  } = opts;

  // 打开数据库（惰性）：启动即校验可打开，让配置错误在启动期暴露
  getDb();

  logger.info("⏰ Cron scheduler starting...\n");

  if (registerCron) {
    if (typeof Bun !== "undefined" && Bun.cron) {
      Bun.cron("*/1 * * * *", () => healthCheckTask().catch((e) => logger.warn("[Cron] unhandled", { error: String(e) })));
      Bun.cron("*/10 * * * *", () => discoverFreeModelsTask().catch((e) => logger.warn("[Cron] unhandled", { error: String(e) })));
      Bun.cron("*/30 * * * *", () => heartbeatTask().catch((e) => logger.warn("[Cron] unhandled", { error: String(e) })));
      Bun.cron("0 3 * * *", () => cleanupTask().catch((e) => logger.warn("[Cron] unhandled", { error: String(e) })));

      logger.info("[完成] Cron jobs registered:");
      logger.info("   • Health check: every 60s");
      logger.info("   • Free model discovery: every 10min");
      logger.info("   • Heartbeat: every 30min");
      logger.info("   • Cleanup: daily at 03:00");
    } else {
      logger.warn("[警告] Bun.cron not available. Run with Bun 1.1+");
    }
  }

  if (installProcessHandlers) {
    if (process.listenerCount("unhandledRejection") === 0) {
      process.on("unhandledRejection", (r) => logger.error("[Cron] unhandledRejection", r as Error));
    }
    if (process.listenerCount("uncaughtException") === 0) {
      process.on("uncaughtException", (e) => logger.error("[Cron] uncaughtException", e));
    }
  }

  if (runImmediately) {
    healthCheckTask().catch((e) => logger.warn("[Cron] initial healthCheck failed", { error: e instanceof Error ? e.message : String(e) }));
  }
}

// 直接运行本文件时自动启动（保持 `bun run src/cron/scheduler.ts` 的用法不变）
if (import.meta.main) {
  startCronScheduler();
}

export { healthCheckTask, heartbeatTask, cleanupTask, discoverFreeModelsTask };
