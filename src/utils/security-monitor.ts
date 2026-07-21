/**
 * Task 4.4 — 安全监控器 (Security Monitor)
 *
 * 聚合 auditLogger 的审计事件，按阈值检测异常并触发安全告警。
 *
 * 检测项：
 *   - checkRateLimitAnomaly(): 限流异常 — 5 分钟内 rate_limit.exceeded > 50 次
 *   - checkAuthFailureBurst(): 认证失败爆发 — 5 分钟内 auth.failure > 10 次
 *
 * 告警通过 auditLogger.log({ event: "security.alert", ... }) 写入审计日志，
 * 同时递增 security_alert_total metrics（由 auditLogger 自动处理）。
 *
 * health-checker 的 checkSecurity() 调用 getSecurityReport() 获取当前安全状态。
 */

import { auditLogger, type AuditLogger, type AuditEntry } from "./audit-logger.js";

export interface SecurityAlert {
  /** 告警类别 */
  category: "rate_limit_anomaly" | "auth_failure_burst";
  /** 严重程度 */
  severity: "low" | "medium" | "high";
  /** 触发时观察到的事件数 */
  count: number;
  /** 阈值 */
  threshold: number;
  /** 检测窗口（ms） */
  windowMs: number;
  /** 检测时间（ISO 8601） */
  detectedAt: string;
  /** 详情 */
  message: string;
}

export interface SecurityReport {
  /** 无活跃告警 = true */
  healthy: boolean;
  /** 当前活跃告警列表 */
  alerts: SecurityAlert[];
  /** 最近一次告警时间（无则 null） */
  lastIncident: string | null;
}

/** 默认阈值 */
const DEFAULT_THRESHOLDS = {
  rateLimitWindowMs: 5 * 60 * 1000,    // 5 分钟
  rateLimitThreshold: 50,               // 50 次 rate_limit.exceeded
  authFailureWindowMs: 5 * 60 * 1000,   // 5 分钟
  authFailureThreshold: 10,             // 10 次 auth.failure
};

export class SecurityMonitor {
  private alerts: SecurityAlert[] = [];
  private lastIncident: string | null = null;
  private thresholds = DEFAULT_THRESHOLDS;
  /** 可注入的 audit logger（默认用单例，测试可传临时实例） */
  private logger: AuditLogger;

  constructor(logger?: AuditLogger) {
    this.logger = logger ?? auditLogger;
  }

  /** 解析 audit.log，返回最近 windowMs 内匹配 event 的条目数 */
  private countRecentEvents(event: string, windowMs: number): { count: number; entries: AuditEntry[] } {
    const content = this.logger.readAll();
    if (!content) return { count: 0, entries: [] };
    const now = Date.now();
    const cutoff = now - windowMs;
    const entries: AuditEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.event !== event) continue;
        const ts = Date.parse(entry.timestamp);
        if (Number.isNaN(ts)) continue;
        if (ts >= cutoff) entries.push(entry);
      } catch {
        // 跳过损坏行
      }
    }
    return { count: entries.length, entries };
  }

  /**
   * 检测限流异常：5 分钟内 rate_limit.exceeded 超阈值。
   * 触发时写入 security.alert 审计日志。
   */
  checkRateLimitAnomaly(): SecurityAlert | null {
    const { count, entries } = this.countRecentEvents(
      "rate_limit.exceeded",
      this.thresholds.rateLimitWindowMs,
    );
    if (count <= this.thresholds.rateLimitThreshold) return null;

    const alert: SecurityAlert = {
      category: "rate_limit_anomaly",
      severity: count > this.thresholds.rateLimitThreshold * 2 ? "high" : "medium",
      count,
      threshold: this.thresholds.rateLimitThreshold,
      windowMs: this.thresholds.rateLimitWindowMs,
      detectedAt: new Date().toISOString(),
      message: `限流异常：${count} 次 rate_limit.exceeded 在 ${this.thresholds.rateLimitWindowMs / 1000}s 内（阈值 ${this.thresholds.rateLimitThreshold}）`,
    };

    this.logger.log({
      event: "security.alert",
      actor: "system",
      outcome: "failure",
      reason: alert.message,
      resource: "rate-limiter",
      metadata: {
        severity: alert.severity,
        category: alert.category,
        count: alert.count,
        threshold: alert.threshold,
        sampleActors: Array.from(new Set(entries.slice(0, 20).map((e) => e.actor))).slice(0, 5),
      },
    });

    return alert;
  }

  /**
   * 检测认证失败爆发：5 分钟内 auth.failure > 10 次。
   * 触发时写入 security.alert 审计日志。
   */
  checkAuthFailureBurst(): SecurityAlert | null {
    const { count, entries } = this.countRecentEvents(
      "auth.failure",
      this.thresholds.authFailureWindowMs,
    );
    if (count <= this.thresholds.authFailureThreshold) return null;

    const alert: SecurityAlert = {
      category: "auth_failure_burst",
      severity: count > this.thresholds.authFailureThreshold * 2 ? "high" : "medium",
      count,
      threshold: this.thresholds.authFailureThreshold,
      windowMs: this.thresholds.authFailureWindowMs,
      detectedAt: new Date().toISOString(),
      message: `认证失败爆发：${count} 次 auth.failure 在 ${this.thresholds.authFailureWindowMs / 1000}s 内（阈值 ${this.thresholds.authFailureThreshold}）`,
    };

    this.logger.log({
      event: "security.alert",
      actor: "system",
      outcome: "failure",
      reason: alert.message,
      resource: "auth",
      metadata: {
        severity: alert.severity,
        category: alert.category,
        count: alert.count,
        threshold: alert.threshold,
        sampleActors: Array.from(new Set(entries.slice(0, 20).map((e) => e.actor))).slice(0, 5),
      },
    });

    return alert;
  }

  /**
   * 执行全部检测并刷新告警列表。
   * 每次 health check 调用一次。
   */
  refresh(): SecurityAlert[] {
    const newAlerts: SecurityAlert[] = [];
    const rateLimitAlert = this.checkRateLimitAnomaly();
    if (rateLimitAlert) newAlerts.push(rateLimitAlert);
    const authAlert = this.checkAuthFailureBurst();
    if (authAlert) newAlerts.push(authAlert);

    // 合并到当前告警列表（保留未恢复的旧告警，追加新告警）
    // 简化策略：每次 refresh 重置为最新检测到的告警
    this.alerts = newAlerts;
    if (newAlerts.length > 0) {
      this.lastIncident = newAlerts[newAlerts.length - 1].detectedAt;
    }
    return newAlerts;
  }

  /**
   * 获取当前安全报告（不触发新的检测，仅返回上次 refresh 的结果）。
   */
  getSecurityReport(): SecurityReport {
    return {
      healthy: this.alerts.length === 0,
      alerts: [...this.alerts],
      lastIncident: this.lastIncident,
    };
  }

  /** 清空告警状态（用于测试） */
  reset(): void {
    this.alerts = [];
    this.lastIncident = null;
  }
}

/** 全局安全监控器单例 */
let securityMonitorInstance: SecurityMonitor | null = null;

export function getSecurityMonitor(): SecurityMonitor {
  if (!securityMonitorInstance) {
    securityMonitorInstance = new SecurityMonitor();
  }
  return securityMonitorInstance;
}

/** 仅用于测试：重置单例 */
export function resetSecurityMonitorInstance(): void {
  securityMonitorInstance = null;
}
