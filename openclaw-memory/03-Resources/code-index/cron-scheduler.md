---
id: code-cron.scheduler
type: code-index
source: cron\scheduler.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 450
tags: [code, auto-indexed]
exports: ["healthCheckT", "proxyHealthT", "heartbeatT", "cleanupT"]
imports: ["bun:sqlite", "crawl-proxy-manager.js"]
---

# cron.scheduler

## 元信息

- **源文件**: `cron\scheduler.ts`
- **模块**: `cron.scheduler`
- **行数**: 111
- **索引时间**: 2026-05-25T05:11:12.530Z

## 依赖

- [[bun:sqlite]]
- [[crawl-proxy-manager.js]]

## 导出清单

| 类型 | 名称 | 行号 |
|------|------|------|
| named | `healthCheckT` | 110 |
| named | `proxyHealthT` | 110 |
| named | `heartbeatT` | 110 |
| named | `cleanupT` | 110 |

## 代码

```typescript
/**
 * Bun Cron 定时任务调度器
 * 自动执行：健康检查 / 免费模型发现 / 代理检查 / 心跳
 *
 * 运行: bun run src/cron/scheduler.ts
 * 或在主服务中 import 启动
 */
import { Database } from "bun:sqlite";
import { proxyManager } from "../crawl/proxy-manager.js";

const dbPath = process.env.DATABASE_PATH || "./data/agent.db";
const db = new Database(dbPath);

console.log("⏰ Cron scheduler starting...\n");

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
  console.log(`[Cron] Health check: ${up}/${platforms.length} platforms up`);
}

// ===== 任务 2: 免费模型发现（每 10 分钟）=====
async function discoverFreeModelsTask() {
  console.log("[Cron] Discovering free models...");
  try {
    // 触发免费模型发现脚本的逻辑
    // 这里简化处理，实际可调用 scripts/discover-free-models.ts
    const freeCount = db.query("SELECT COUNT(*) as c FROM free_models WHERE is_available = 1").get() as any;
    console.log(`[Cron] Current free models: ${freeCount?.c || 0}`);
  } catch (e: any) {
    console.warn("[Cron] Free model discovery failed:", e.message);
  }
}

// ===== 任务 3: 代理健康检查（每 5 分钟）=====
async function proxyHealthTask() {
  if (proxyManager.getHealthyCount() === 0) {
    console.log("[Cron] No proxies configured, skipping proxy health check");
    return;
  }
  console.log("[Cron] Checking proxy health...");
  await proxyManager.healthCheck("https://httpbin.org/ip");
}

// ===== 任务 4: 心跳（每 30 分钟）=====
async function heartbeatTask() {
  console.log("[Cron] HEARTBEAT — System OK");
  db.run(
    `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ["heartbeat", new Date().toISOString()]
  );
}

// ===== 任务 5: 清理过期缓存（每天凌晨）=====
async function cleanupTask() {
  console.log("[Cron] Running daily cleanup...");
  db.run(`DELETE FROM search_history WHERE created_at < unixepoch() - 2592000`);
  db.run(`DELETE FROM crawl_results WHERE status != 'success' AND created_at < unixepoch() - 604800`);
  console.log("[Cron] Cleanup complete");
}

// ===== 注册定时任务 =====

if (typeof Bun !== "undefined" && Bun.cron) {
  Bun.cron("*/1 * * * *", healthCheckTask);
  Bun.cron("*/5 * * * *", proxyHealthTask);
  Bun.cron("*/10 * * * *", discoverFreeModelsTask);
  Bun.cron("*/30 * * * *", heartbeatTask);
  Bun.cron("0 3 * * *", cleanupTask);

  console.log("✅ Cron jobs registered:");
  console.log("   • Health check: every 60s");
  console.log("   • Proxy check: every 5min");
  console.log("   • Free model discovery: every 10min");
  console.log("   • Heartbeat: every 30min");
  console.log("   • Cleanup: daily at 03:00");
} else {
  console.warn("⚠️ Bun.cron not available. Run with Bun 1.1+");
}

// 立即执行一次
healthCheckTask();

export { healthCheckTask, proxyHealthTask, heartbeatTask, cleanupTask };

```