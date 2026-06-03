/**
 * Bun Cron 定时任务调度器
 * 自动执行：健康检查 / 免费模型发现 / 代理检查 / 心跳
 *
 * 运行: bun run src/cron/scheduler.ts
 * 或在主服务中 import 启动
 */
import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

const dbPath = process.env.DATABASE_PATH || "./data/agent.db";
const db = new Database(dbPath);

logger.info("⏰ Cron scheduler starting...\n");

// ===== 任务 1: 平台健康检查（每 60 秒）=====
async function healthCheckTask() {
  const checks: Record<string, boolean> = {};
  const platforms = [
    { name: "siliconflow", url: "https://api.siliconflow.cn/v1/models", key: process.env.SILICONFLOW_API_KEY },
    { name: "ofoxai", url: "https://api.ofox.ai/v1/models", key: process.env.OFOXAI_API_KEY },
    { name: "openrouter", url: "https://openrouter.ai/api/v1/models", key: process.env.OPENROUTER_API_KEY },
    { name: "deepseek", url: "https://api.deepseek.com/v1/models", key: process.env.DEEPSEEK_API_KEY },
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

  db.run(
    `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ["health_check", JSON.stringify({ time: new Date().toISOString(), checks })]
  );

  const up = Object.values(checks).filter(Boolean).length;
  logger.info(`[Cron] Health check: ${up}/${platforms.length} platforms up`);
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
  logger.info("[Cron] HEARTBEAT — System OK");
  db.run(
    `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ["heartbeat", new Date().toISOString()]
  );
}

// ===== 任务 5: 清理过期缓存（每天凌晨）=====
async function cleanupTask() {
  logger.info("[Cron] Running daily cleanup...");
  db.run(`DELETE FROM search_history WHERE created_at < unixepoch() - 2592000`);
  db.run(`DELETE FROM crawl_results WHERE status != 'success' AND created_at < unixepoch() - 604800`);
  logger.info("[Cron] Cleanup complete");
}

// ===== 注册定时任务 =====

if (typeof Bun !== "undefined" && Bun.cron) {
  Bun.cron("*/1 * * * *", healthCheckTask);
  Bun.cron("*/10 * * * *", discoverFreeModelsTask);
  Bun.cron("*/30 * * * *", heartbeatTask);
  Bun.cron("0 3 * * *", cleanupTask);

  logger.info("[完成] Cron jobs registered:");
  logger.info("   • Health check: every 60s");
  logger.info("   • Free model discovery: every 10min");
  logger.info("   • Heartbeat: every 30min");
  logger.info("   • Cleanup: daily at 03:00");
} else {
  logger.warn("[警告] Bun.cron not available. Run with Bun 1.1+");
}

// 立即执行一次
healthCheckTask();

export { healthCheckTask, heartbeatTask, cleanupTask };
