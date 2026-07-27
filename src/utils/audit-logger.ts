/**
 * 审计日志模块 (Audit Logger)
 *
 * 记录敏感操作的不可篡改审计轨迹，写入 JSON Lines 格式。
 * 与普通 logger 区分：audit-logger 专注于安全事件留痕，每条记录同步落盘。
 *
 * 设计要点：
 *   - 模块加载时立即注册 metrics（audit_event_total + security_alert_total），
 *     避免 increment 被 warn 丢弃（见 metrics.ts:31-35）。
 *   - 同步追加写入（fs.appendFileSync），保证崩溃前审计记录已落盘。
 *   - 文件轮转：超 maxSize rename 加时间戳，保留 maxFiles 个旧文件。
 *   - 单例 auditLogger 默认写 data/logs/audit.log。
 */

import fs from "fs";
import path from "path";
import { metrics } from "./metrics.js";
import { logger } from "./logger.js";

// ═══════════════════════════════════════════════════════════════
// metrics 注册（模块加载时立即执行，幂等）
// ═══════════════════════════════════════════════════════════════
metrics.register({
  name: "audit_event_total",
  help: "Audit events by type and outcome",
  type: "counter",
});
metrics.register({
  name: "security_alert_total",
  help: "Security alerts by severity",
  type: "counter",
});

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export type AuditEvent =
  | "auth.success" | "auth.failure"
  | "vault.write" | "sandbox.execute" | "plugin.install" | "plugin.uninstall"
  | "plugin.enable" | "plugin.disable" | "plugin.configure"
  | "apikey.set" | "apikey.delete" | "apikey.test"
  | "rate_limit.exceeded" | "config.change" | "ws_flood" | "security.alert"
  | "traffic.malicious" | "traffic.suspicious";

export type AuditOutcome = "success" | "failure" | "denied" | "allowed";

export interface AuditEntry {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 事件类型 */
  event: AuditEvent;
  /** 操作发起者（IP 或 "unknown" / "system"） */
  actor: string;
  /** 受影响的资源路径或 ID */
  resource?: string;
  /** 操作结果 */
  outcome: AuditOutcome;
  /** 失败/拒绝原因 */
  reason?: string;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  /** 审计日志文件路径，默认 data/logs/audit.log */
  filePath?: string;
  /** 单文件最大字节数，超过则轮转，默认 10MB */
  maxSize?: number;
  /** 保留的轮转文件数，默认 5 */
  maxFiles?: number;
}

// ═══════════════════════════════════════════════════════════════
// AuditLogger 实现
// ═══════════════════════════════════════════════════════════════

export class AuditLogger {
  private readonly filePath: string;
  private readonly maxSize: number;
  private readonly maxFiles: number;
  private currentSize = 0;

  constructor(opts: AuditLoggerOptions = {}) {
    this.filePath = opts.filePath ?? path.join("data", "logs", "audit.log");
    this.maxSize = opts.maxSize ?? 10 * 1024 * 1024; // 10MB
    this.maxFiles = opts.maxFiles ?? 5;
    this.ensureDir();
    this.initCurrentSize();
  }

  /** 确保日志目录存在 */
  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // 目录创建失败不阻塞（可能权限问题，写时会再报错）
      }
    }
  }

  /** 初始化当前文件大小（用于轮转判断） */
  private initCurrentSize(): void {
    try {
      const stats = fs.statSync(this.filePath);
      this.currentSize = stats.size;
    } catch {
      this.currentSize = 0;
    }
  }

  /**
   * 写入一条审计日志。
   * 同步追加 JSON Lines + 递增 metrics 计数器。
   * @param entry 不含 timestamp 的审计条目（timestamp 自动填充）
   */
  log(entry: Omit<AuditEntry, "timestamp">): void {
    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    try {
      this.rotateIfNeeded();
      const line = JSON.stringify(full) + "\n";
      fs.appendFileSync(this.filePath, line);
      this.currentSize += Buffer.byteLength(line, "utf8");
    } catch (err) {
      // 审计日志写入失败不应阻塞业务，降级到普通 logger
      logger.error("[AuditLogger] Failed to write audit entry", err instanceof Error ? err : new Error(String(err)));
    }

    // metrics 计数（即使文件写入失败也计数，保证可观测性）
    try {
      metrics.increment("audit_event_total", 1, {
        event: entry.event,
        outcome: entry.outcome,
      });
      if (entry.event === "security.alert") {
        metrics.increment("security_alert_total", 1, {
          severity: String(entry.metadata?.severity ?? "medium"),
          category: String(entry.metadata?.category ?? "unknown"),
        });
      }
    } catch {
      // metrics 失败不影响审计主流程
    }
  }

  /** 文件大小超限时轮转 */
  private rotateIfNeeded(): void {
    if (this.currentSize < this.maxSize) return;

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rotatedPath = `${this.filePath}.${timestamp}`;
      fs.renameSync(this.filePath, rotatedPath);
      this.currentSize = 0;
      this.cleanupOldRotatedFiles();
    } catch (err) {
      logger.warn("[AuditLogger] Rotation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 清理超出 maxFiles 的旧轮转文件 */
  private cleanupOldRotatedFiles(): void {
    const dir = path.dirname(this.filePath);
    const baseName = path.basename(this.filePath);

    try {
      const entries = fs.readdirSync(dir);
      const rotated = entries
        .filter((e) => e.startsWith(baseName + "."))
        .map((e) => ({
          name: e,
          fullPath: path.join(dir, e),
          mtime: fs.statSync(path.join(dir, e)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime); // 新的在前

      // 删除超出 maxFiles 的旧文件
      if (rotated.length > this.maxFiles) {
        for (const file of rotated.slice(this.maxFiles)) {
          try {
            fs.unlinkSync(file.fullPath);
          } catch {
            // 删除失败忽略
          }
        }
      }
    } catch {
      // 清理失败忽略
    }
  }

  /** 读取当前审计日志全部内容（用于测试与诊断） */
  readAll(): string {
    try {
      return fs.readFileSync(this.filePath, "utf8");
    } catch {
      return "";
    }
  }

  /** 获取当前文件大小（字节） */
  get size(): number {
    return this.currentSize;
  }
}

// ═══════════════════════════════════════════════════════════════
// 默认单例
// ═══════════════════════════════════════════════════════════════

export const auditLogger: AuditLogger = new AuditLogger();