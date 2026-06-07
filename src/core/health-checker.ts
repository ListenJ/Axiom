/**
 * 架构自检系统 (Architecture Health Checker)
 *
 * 启动时自动检查所有组件健康状态，给出优化建议和一键修复。
 *
 * 检查项:
 *   - 环境变量完整性
 *   - API Key 有效性 (通过 provider 健康检查 API)
 *   - 数据库连接
 *   - Vault 可访问性
 *   - CodeGraph 索引状态
 *   - Redis 连接 (可选)
 *   - 磁盘空间
 *   - 网络连通性
 */

import fs from "fs";
import { logger } from "../utils/logger.js";
import { getConfigCenter } from "./config-center.js";

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

export interface HealthCheckResult {
  component: string;
  status: "ok" | "warning" | "error" | "skipped";
  message: string;
  latencyMs?: number;
  fix?: string;
  autoFixable?: boolean;
}

export interface SystemReport {
  overall: "healthy" | "degraded" | "critical";
  checks: HealthCheckResult[];
  summary: {
    ok: number;
    warning: number;
    error: number;
    skipped: number;
  };
  recommendations: string[];
}

// ═══════════════════════════════════════════════════════════════
// 自检引擎
// ═══════════════════════════════════════════════════════════════

export class HealthChecker {
  private results: HealthCheckResult[] = [];

  async runFullCheck(): Promise<SystemReport> {
    this.results = [];
    const startTime = Date.now();

    // 并行执行所有检查
    await Promise.all([
      this.checkApiKeys(),
      this.checkDatabase(),
      this.checkVault(),
      this.checkCodeGraph(),
      this.checkRedis(),
      this.checkDiskSpace(),
      this.checkNetwork(),
      this.checkConfig(),
    ]);

    // 排序: error → warning → ok
    this.results.sort((a, b) => {
      const order = { error: 0, warning: 1, ok: 2, skipped: 3 };
      return order[a.status] - order[b.status];
    });

    const summary = {
      ok: this.results.filter((r) => r.status === "ok").length,
      warning: this.results.filter((r) => r.status === "warning").length,
      error: this.results.filter((r) => r.status === "error").length,
      skipped: this.results.filter((r) => r.status === "skipped").length,
    };

    const overall = summary.error > 0 ? "critical" : summary.warning > 2 ? "degraded" : "healthy";

    const recommendations = this.generateRecommendations();

    logger.info("[HealthChecker] Full check completed", {
      overall,
      duration: Date.now() - startTime,
      ...summary,
    });

    return { overall, checks: this.results, summary, recommendations };
  }

  // ---------------------------------------------------------------------------
  // 具体检查项
  // ---------------------------------------------------------------------------

  private async checkApiKeys(): Promise<void> {
    const center = getConfigCenter();
    const providers = [
      { name: "SiliconFlow", key: "model.siliconflow_key", url: "https://api.siliconflow.cn/v1/models" },
      { name: "OpenRouter", key: "model.openrouter_key", url: "https://openrouter.ai/api/v1/models" },
      { name: "DeepSeek", key: "model.deepseek_key", url: "https://api.deepseek.com/v1/models" },
    ];

    for (const { name, key, url } of providers) {
      const apiKey = center.getString(key);
      if (!apiKey) {
        this.results.push({ component: `${name} API`, status: "skipped", message: "API Key 未配置" });
        continue;
      }

      const start = Date.now();
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        const latency = Date.now() - start;

        if (res.ok) {
          this.results.push({ component: `${name} API`, status: "ok", message: "API Key 有效", latencyMs: latency });
        } else {
          this.results.push({
            component: `${name} API`, status: "warning", message: `API 返回 ${res.status}`, latencyMs: latency,
            fix: "检查 API Key 是否正确或已过期",
          });
        }
      } catch (e) {
        this.results.push({
          component: `${name} API`, status: "warning", message: `连接失败: ${(e as Error).message}`,
          fix: "检查网络连接或代理设置",
        });
      }
    }
  }

  private async checkDatabase(): Promise<void> {
    const dbPath = getConfigCenter().getString("memory.database_path");
    const dir = dbPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");

    if (!fs.existsSync(dir)) {
      this.results.push({
        component: "SQLite 数据库", status: "error", message: `数据库目录不存在: ${dir}`,
        fix: `mkdir -p ${dir}`, autoFixable: true,
      });
      return;
    }

    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath);
      db.query("SELECT 1").get();
      db.close();
      this.results.push({ component: "SQLite 数据库", status: "ok", message: "数据库连接正常" });
    } catch (e) {
      this.results.push({
        component: "SQLite 数据库", status: "error", message: `数据库连接失败: ${(e as Error).message}`,
        fix: "检查数据库文件权限",
      });
    }
  }

  private async checkVault(): Promise<void> {
    const vaultPath = getConfigCenter().getString("memory.vault_path");

    if (!fs.existsSync(vaultPath)) {
      this.results.push({
        component: "Vault 记忆库", status: "warning", message: `Vault 路径不存在: ${vaultPath}`,
        fix: `mkdir -p ${vaultPath}`, autoFixable: true,
      });
      return;
    }

    try {
      const entries = fs.readdirSync(vaultPath);
      const mdCount = entries.filter((e) => e.endsWith(".md")).length;
      this.results.push({
        component: "Vault 记忆库", status: "ok",
        message: `Vault 就绪，包含 ${mdCount} 个 .md 文件`,
      });
    } catch (e) {
      this.results.push({
        component: "Vault 记忆库", status: "error", message: `无法读取 Vault: ${(e as Error).message}`,
        fix: "检查目录权限",
      });
    }
  }

  private async checkCodeGraph(): Promise<void> {
    const dbPath = "./.codegraph/codegraph.db";
    if (fs.existsSync(dbPath)) {
      const stats = fs.statSync(dbPath);
      const sizeMB = Math.round(stats.size / 1024 / 1024);
      this.results.push({
        component: "CodeGraph", status: "ok",
        message: `CodeGraph 已索引 (${sizeMB}MB)`,
      });
    } else {
      this.results.push({
        component: "CodeGraph", status: "warning", message: "CodeGraph 未初始化",
        fix: "运行: npx codegraph init -i", autoFixable: false,
      });
    }
  }

  private async checkRedis(): Promise<void> {
    const redisUrl = getConfigCenter().getString("memory.redis_url");
    if (!redisUrl) {
      this.results.push({ component: "Redis", status: "skipped", message: "未配置 REDIS_URL" });
      return;
    }

    try {
      const { getRedisClient } = await import("../utils/redis-client.js");
      const client = await getRedisClient();
      if (client?.isConnected()) {
        const pong = await client.ping();
        this.results.push({ component: "Redis", status: "ok", message: `Redis 连接正常 (${pong})` });
      } else {
        this.results.push({ component: "Redis", status: "warning", message: "Redis 连接失败，已回退到本地缓存" });
      }
    } catch (e) {
      this.results.push({ component: "Redis", status: "warning", message: `Redis 检查失败: ${(e as Error).message}` });
    }
  }

  private async checkDiskSpace(): Promise<void> {
    try {
      const { statfsSync } = await import("fs");
      const stats = statfsSync(".");
      const freeGB = Math.round((stats.bavail * stats.bsize) / 1024 / 1024 / 1024);
      const totalGB = Math.round((stats.blocks * stats.bsize) / 1024 / 1024 / 1024);
      const usedPercent = Math.round(((totalGB - freeGB) / totalGB) * 100);

      const status = usedPercent > 90 ? "error" : usedPercent > 80 ? "warning" : "ok";
      this.results.push({
        component: "磁盘空间", status,
        message: `已用 ${usedPercent}% (${freeGB}GB 可用 / ${totalGB}GB 总计)`,
        fix: usedPercent > 80 ? "清理日志和缓存文件" : undefined,
      });
    } catch {
      this.results.push({ component: "磁盘空间", status: "skipped", message: "无法获取磁盘信息" });
    }
  }

  private async checkNetwork(): Promise<void> {
    const hosts = [
      { name: "GitHub", url: "https://github.com" },
      { name: "NPM Registry", url: "https://registry.npmjs.org" },
    ];

    for (const { name, url } of hosts) {
      try {
        const start = Date.now();
        await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
        this.results.push({ component: `网络: ${name}`, status: "ok", message: "连通", latencyMs: Date.now() - start });
      } catch {
        this.results.push({ component: `网络: ${name}`, status: "warning", message: "连接超时" });
      }
    }
  }

  private async checkConfig(): Promise<void> {
    const center = getConfigCenter();
    const validation = center.validate();

    if (validation.missing.length > 0) {
      for (const m of validation.missing) {
        this.results.push({
          component: `配置: ${m.key}`, status: "error",
          message: `缺少必填配置: ${m.description}`,
          fix: `设置 ${m.envVar}`,
        });
      }
    }

    if (validation.errors.length > 0) {
      for (const e of validation.errors) {
        this.results.push({ component: `配置: ${e.key}`, status: "error", message: e.message, fix: e.suggestion });
      }
    }

    if (validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        this.results.push({ component: `配置: ${w.key}`, status: "warning", message: w.message, fix: w.suggestion });
      }
    }

    if (validation.valid && validation.errors.length === 0) {
      this.results.push({ component: "配置验证", status: "ok", message: "所有配置项有效" });
    }
  }

  // ---------------------------------------------------------------------------
  // 建议生成
  // ---------------------------------------------------------------------------

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];
    const errors = this.results.filter((r) => r.status === "error");
    const warnings = this.results.filter((r) => r.status === "warning");

    if (errors.some((r) => r.component.includes("API"))) {
      recommendations.push("💡 至少配置一个模型 API Key 才能使用 LLM 功能。推荐先配置 SILICONFLOW_API_KEY（免费额度充足）");
    }

    if (errors.some((r) => r.component === "安全")) {
      recommendations.push("🔒 设置 OPENCLAW_AUTH_TOKEN 以启用 API 鉴权。建议长度 >= 16 位的随机字符串");
    }

    if (warnings.some((r) => r.component === "CodeGraph")) {
      recommendations.push("📊 初始化 CodeGraph 索引可大幅提升代码检索速度: npx codegraph init -i");
    }

    if (warnings.some((r) => r.component === "Redis")) {
      recommendations.push("⚡ 启动 Redis 可加速跨进程缓存共享: docker run -d -p 6379:6379 redis:7-alpine");
    }

    if (this.results.some((r) => r.component === "磁盘空间" && r.status !== "ok")) {
      recommendations.push("🧹 磁盘空间不足，建议清理: rm -rf .tmp/* data/logs/*");
    }

    return recommendations;
  }
}

// ═══════════════════════════════════════════════════════════════
// 便捷函数
// ═══════════════════════════════════════════════════════════════

export async function runHealthCheck(): Promise<SystemReport> {
  const checker = new HealthChecker();
  return checker.runFullCheck();
}

/** 打印友好的健康报告 */
export function printHealthReport(report: SystemReport): void {
  const icons = { ok: "✅", warning: "⚠️", error: "❌", skipped: "⏭️" };
  const colors = { ok: "\x1b[32m", warning: "\x1b[33m", error: "\x1b[31m", skipped: "\x1b[90m", reset: "\x1b[0m" };

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  系统健康检查 — ${report.overall === "healthy" ? "🟢 健康" : report.overall === "degraded" ? "🟡 降级" : "🔴 严重"}`.padEnd(63) + "║");
  console.log("╠══════════════════════════════════════════════════════════════╣");

  for (const check of report.checks) {
    const icon = icons[check.status];
    const color = colors[check.status];
    const latency = check.latencyMs ? ` (${check.latencyMs}ms)` : "";
    const line = `║  ${icon} ${check.component.padEnd(20)} ${color}${check.status.toUpperCase().padEnd(7)}${colors.reset} ${check.message.slice(0, 30)}${latency}`.slice(0, 62);
    console.log(line.padEnd(63) + "║");
  }

  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  总计: ✅ ${report.summary.ok}  ⚠️ ${report.summary.warning}  ❌ ${report.summary.error}  ⏭️ ${report.summary.skipped}`.padEnd(63) + "║");

  if (report.recommendations.length > 0) {
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  优化建议:".padEnd(63) + "║");
    for (const rec of report.recommendations) {
      const line = `║    ${rec.slice(0, 58)}`;
      console.log(line.padEnd(63) + "║");
    }
  }

  console.log("╚══════════════════════════════════════════════════════════════╝\n");
}
