/**
 * Bun Cron 定时任务调度器
 * 自动执行：健康检查 / 免费模型发现 / 代理检查 / 心跳
 *
 * 运行: bun run src/cron/scheduler.ts
 * 或在主服务中 import 启动
 */
import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";

const dbPath = readString("DATABASE_PATH", "./data/agent.db");
const db = new Database(dbPath);
try { db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA busy_timeout=5000"); } catch {}

logger.info("⏰ Cron scheduler starting...\n");

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
      db.run(
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
    const freeCount = db.query("SELECT COUNT(*) as c FROM free_models WHERE is_available = 1").get() as { c: number } | null;
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
      db.run(
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
    db.run(`DELETE FROM search_history WHERE created_at < unixepoch() - 2592000`);
    db.run(`DELETE FROM crawl_results WHERE status != 'success' AND created_at < unixepoch() - 604800`);
    logger.info("[Cron] Cleanup complete");
  } catch (e: unknown) {
    logger.warn("[Cron] cleanup failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

// ===== 注册定时任务 =====

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

if (process.listenerCount("unhandledRejection") === 0) {
  process.on("unhandledRejection", (r) => logger.error("[Cron] unhandledRejection", r as Error));
}
if (process.listenerCount("uncaughtException") === 0) {
  process.on("uncaughtException", (e) => logger.error("[Cron] uncaughtException", e));
}

// 立即执行一次
healthCheckTask().catch((e) => logger.warn("[Cron] initial healthCheck failed", { error: e instanceof Error ? e.message : String(e) }));

export { healthCheckTask, heartbeatTask, cleanupTask, discoverFreeModelsTask };
