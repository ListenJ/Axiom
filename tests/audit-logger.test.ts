/**
 * audit-logger 单元测试
 *
 * 覆盖：
 *   - JSON Lines 写入格式（可 parse、字段完整）
 *   - metrics 计数器递增（audit_event_total / security_alert_total）
 *   - 文件轮转触发（超 maxSize rename + 旧文件清理）
 *   - 单例导出正确性
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { AuditLogger, auditLogger } from "../src/utils/audit-logger.js";
import { metrics } from "../src/utils/metrics.js";

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  logPath = path.join(tmpDir, "audit.log");
});

afterEach(() => {
  // 清理临时目录
  try {
    const entries = fs.readdirSync(tmpDir);
    for (const e of entries) {
      fs.unlinkSync(path.join(tmpDir, e));
    }
    fs.rmdirSync(tmpDir);
  } catch {
    // ignore
  }
});

describe("AuditLogger", () => {
  it("写入 JSON Lines 格式且字段完整", () => {
    const logger = new AuditLogger({ filePath: logPath });
    logger.log({
      event: "auth.success",
      actor: "127.0.0.1",
      outcome: "success",
      resource: "/api-keys",
      reason: "valid token",
      metadata: { latency: 42 },
    });

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.timestamp).toBeTruthy();
    expect(entry.event).toBe("auth.success");
    expect(entry.actor).toBe("127.0.0.1");
    expect(entry.outcome).toBe("success");
    expect(entry.resource).toBe("/api-keys");
    expect(entry.reason).toBe("valid token");
    expect(entry.metadata).toEqual({ latency: 42 });
  });

  it("连续写入多条日志为独立行", () => {
    const logger = new AuditLogger({ filePath: logPath });
    logger.log({ event: "apikey.set", actor: "u1", outcome: "success" });
    logger.log({ event: "apikey.delete", actor: "u2", outcome: "success" });
    logger.log({ event: "auth.failure", actor: "u3", outcome: "denied" });

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);

    const events = lines.map((l) => JSON.parse(l).event);
    expect(events).toEqual(["apikey.set", "apikey.delete", "auth.failure"]);
  });

  it("递增 audit_event_total metrics 计数器", () => {
    const logger = new AuditLogger({ filePath: logPath });
    logger.log({ event: "apikey.set", actor: "u1", outcome: "success" });
    logger.log({ event: "apikey.set", actor: "u2", outcome: "success" });
    logger.log({ event: "auth.failure", actor: "u3", outcome: "denied" });

    // 通过 metrics.getJSON() 验证计数
    const json = metrics.getJSON();
    const metric = json.audit_event_total as { values: Array<{ value: number; labels?: Record<string, string> }> };
    expect(metric).toBeTruthy();

    const setSuccess = metric.values.filter(
      (v) => v.labels?.event === "apikey.set" && v.labels?.outcome === "success"
    );
    expect(setSuccess.length).toBeGreaterThanOrEqual(2);

    const authDenied = metric.values.filter(
      (v) => v.labels?.event === "auth.failure" && v.labels?.outcome === "denied"
    );
    expect(authDenied.length).toBeGreaterThanOrEqual(1);
  });

  it("security.alert 事件同时递增 security_alert_total", () => {
    const logger = new AuditLogger({ filePath: logPath });
    logger.log({
      event: "security.alert",
      actor: "system",
      outcome: "failure",
      metadata: { severity: "high", category: "auth" },
    });

    const json = metrics.getJSON();
    const alertMetric = json.security_alert_total as { values: Array<{ value: number; labels?: Record<string, string> }> };
    expect(alertMetric).toBeTruthy();

    const highAuth = alertMetric.values.filter(
      (v) => v.labels?.severity === "high" && v.labels?.category === "auth"
    );
    expect(highAuth.length).toBeGreaterThanOrEqual(1);
  });

  it("文件超 maxSize 时触发轮转", () => {
    // 设 maxSize=512，写足够多内容触发轮转
    const logger = new AuditLogger({ filePath: logPath, maxSize: 512, maxFiles: 3 });
    // 每条约 150 字节，写 5 条应超过 512 触发轮转
    for (let i = 0; i < 5; i++) {
      logger.log({
        event: "config.change",
        actor: `user-${i}`,
        outcome: "success",
        resource: `/config/item-${i}`,
        metadata: { index: i, padding: "x".repeat(50) },
      });
    }

    // 当前文件应已重置（轮转后新文件）
    const currentSize = logger.size;
    expect(currentSize).toBeLessThan(512);

    // 临时目录应存在轮转文件（以 audit.log. 开头）
    const entries = fs.readdirSync(tmpDir);
    const rotated = entries.filter((e) => e.startsWith("audit.log."));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
  });

  it("轮转文件数超 maxFiles 时清理旧文件", () => {
    const logger = new AuditLogger({ filePath: logPath, maxSize: 200, maxFiles: 2 });
    // 写大量日志触发多次轮转
    for (let i = 0; i < 20; i++) {
      logger.log({
        event: "config.change",
        actor: `user-${i}`,
        outcome: "success",
        metadata: { padding: "x".repeat(80) },
      });
    }

    const entries = fs.readdirSync(tmpDir);
    const rotated = entries.filter((e) => e.startsWith("audit.log."));
    // 旧文件被清理，最多保留 maxFiles 个
    expect(rotated.length).toBeLessThanOrEqual(2);
  });

  it("readAll 返回当前日志文件全部内容", () => {
    const logger = new AuditLogger({ filePath: logPath });
    logger.log({ event: "apikey.set", actor: "u1", outcome: "success" });
    logger.log({ event: "apikey.delete", actor: "u2", outcome: "success" });

    const content = logger.readAll();
    expect(content).toContain("apikey.set");
    expect(content).toContain("apikey.delete");
  });

  it("文件不存在时 readAll 返回空串", () => {
    const logger = new AuditLogger({ filePath: path.join(tmpDir, "nonexistent.log") });
    expect(logger.readAll()).toBe("");
  });

  it("auditLogger 是 AuditLogger 单例实例", () => {
    expect(auditLogger).toBeInstanceOf(AuditLogger);
  });

  it("metadata 可选且不破坏格式", () => {
    const logger = new AuditLogger({ filePath: logPath });
    logger.log({ event: "vault.write", actor: "127.0.0.1", outcome: "success" });

    const content = fs.readFileSync(logPath, "utf8");
    const entry = JSON.parse(content.trim());
    expect(entry.event).toBe("vault.write");
    expect(entry.metadata).toBeUndefined();
  });

  it("reason 可选且不破坏格式", () => {
    const logger = new AuditLogger({ filePath: logPath });
    logger.log({ event: "sandbox.execute", actor: "127.0.0.1", outcome: "success", resource: "/sandbox/execute" });

    const content = fs.readFileSync(logPath, "utf8");
    const entry = JSON.parse(content.trim());
    expect(entry.reason).toBeUndefined();
    expect(entry.resource).toBe("/sandbox/execute");
  });

  it("security.alert 缺失 metadata.severity/category 时使用默认值 medium/unknown", () => {
    const logger = new AuditLogger({ filePath: logPath });
    logger.log({
      event: "security.alert",
      actor: "system",
      outcome: "failure",
      // 故意不传 metadata.severity / metadata.category
    });

    const json = metrics.getJSON();
    const alertMetric = json.security_alert_total as { values: Array<{ value: number; labels?: Record<string, string> }> };
    expect(alertMetric).toBeTruthy();

    // 应命中 ?? "medium" 与 ?? "unknown" 默认分支
    const defaultLabels = alertMetric.values.filter(
      (v) => v.labels?.severity === "medium" && v.labels?.category === "unknown"
    );
    expect(defaultLabels.length).toBeGreaterThanOrEqual(1);
  });

  it("轮转后 readAll 只返回新文件内容（旧内容已移走）", () => {
    const logger = new AuditLogger({ filePath: logPath, maxSize: 200, maxFiles: 3 });
    // 第一阶段：写入足够触发轮转的内容
    for (let i = 0; i < 4; i++) {
      logger.log({
        event: "config.change",
        actor: `user-${i}`,
        outcome: "success",
        metadata: { padding: "x".repeat(50) },
      });
    }
    // 此时旧内容应已轮转到带时间戳的文件，当前文件为轮转后新写入的内容
    const afterRotation = logger.readAll();
    // 当前文件不应包含最早的 user-0（已轮转走）
    expect(afterRotation).not.toContain("user-0");

    // 第二阶段：再写一条，应只出现在当前文件
    logger.log({ event: "apikey.set", actor: "post-rotation", outcome: "success" });
    const final = logger.readAll();
    expect(final).toContain("post-rotation");
    // 仍不应包含已轮转走的 user-0
    expect(final).not.toContain("user-0");
  });

  it("size 正确反映多字节 UTF-8 内容字节数（非 string.length）", () => {
    const logger = new AuditLogger({ filePath: logPath });
    // 中文每字符在 UTF-8 下占 3 字节
    logger.log({
      event: "vault.write",
      actor: "测试者",
      outcome: "success",
      resource: "/vault/中文路径",
      metadata: { 备注: "这是一段中文备注" },
    });

    const content = fs.readFileSync(logPath, "utf8");
    const expectedBytes = Buffer.byteLength(content, "utf8");
    // logger.size 应等于文件实际字节数（多字节字符正确计数）
    expect(logger.size).toBe(expectedBytes);
    // 且应大于 string.length（验证确实在用 byteLength 而非 length）
    expect(logger.size).toBeGreaterThan(content.length);
  });
});
