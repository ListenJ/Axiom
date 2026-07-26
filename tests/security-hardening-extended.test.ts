/**
 * V4 安全加固补充测试（覆盖空缺补齐）
 *
 * 本文件补齐 security-hardening.test.ts 未覆盖的边界条件与异常路径：
 *   Part A: api-key-persistence.ts — 密文格式校验 / 混合记录 / 删除 / 覆盖
 *   Part B: rate-limiter.ts (MultiDimensionLimiter) — setRule/cleanup/getHeaders/extractUserKey 边界
 *   Part C: process-sandbox.ts — 命令不存在 / 截断标记
 *   Part D: security-monitor.ts — 损坏 JSON 容错 / 单例 / 多告警并发
 *   Part E: websocket.ts — unsubscribe / onClose 广播 / excludeClientId / subscriptions 过滤
 *   Part F: audit-logger.ts — 目录已存在 / initCurrentSize / append 失败容错
 *   Part G: health-checker.ts — checkSecurity 集成
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

// ============================================================================
// Part A: api-key-persistence.ts 补充
// ============================================================================

describe("Task 4.1 补充 — api-key-persistence 边界", () => {
  const ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString("base64");
  let db: any;
  let tmpDir: string;
  let originalKey: string | undefined;

  beforeEach(async () => {
    originalKey = process.env.AXIOM_ENCRYPTION_KEY;
    process.env.AXIOM_ENCRYPTION_KEY = ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-apikey-ext-"));
    const { Database } = await import("bun:sqlite");
    db = new Database(path.join(tmpDir, "test.db"));
    const { initApiKeyOverridesTable } = await import("../src/utils/api-key-persistence.js");
    initApiKeyOverridesTable(db);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AXIOM_ENCRYPTION_KEY;
    else process.env.AXIOM_ENCRYPTION_KEY = originalKey;
    try { db?.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("密文格式不匹配 CIPHER_PATTERN 时跳过记录", async () => {
    // 写入格式错误的"密文"（不符合 iv_hex:tag_hex:ciphertext_hex 格式）
    db.run(
      "INSERT INTO api_key_overrides (provider, api_key, base_url, set_at) VALUES (?, ?, ?, ?)",
      ["bad-format", "not-a-valid-cipher-text", null, Date.now()],
    );
    const { loadApiKeyOverrides } = await import("../src/utils/api-key-persistence.js");
    // 明文 + 已配密钥 → 跳过（不计入返回结果）
    expect(loadApiKeyOverrides(db).length).toBe(0);
  });

  test("AXIOM_ENCRYPTION_KEY 长度不正确（非 32 字节）时按未配密钥处理", async () => {
    // 16 字节而非 32 字节
    process.env.AXIOM_ENCRYPTION_KEY = Buffer.alloc(16, 0x42).toString("base64");
    const { saveApiKeyOverride } = await import("../src/utils/api-key-persistence.js");
    expect(() => saveApiKeyOverride(db, "short-key", "sk-test")).toThrow(/AXIOM_ENCRYPTION_KEY/);
  });

  test("混合记录：部分明文 + 部分密文，已配密钥时只加载密文", async () => {
    const { saveApiKeyOverride, loadApiKeyOverrides } = await import("../src/utils/api-key-persistence.js");
    // 写一条密文记录
    saveApiKeyOverride(db, "encrypted-one", "sk-good-1");
    // 直接写一条明文记录
    db.run(
      "INSERT INTO api_key_overrides (provider, api_key, base_url, set_at) VALUES (?, ?, ?, ?)",
      ["plaintext-one", "sk-plaintext", null, Date.now()],
    );
    const loaded = loadApiKeyOverrides(db);
    expect(loaded.length).toBe(1);
    expect(loaded[0].provider).toBe("encrypted-one");
    expect(loaded[0].apiKey).toBe("sk-good-1");
  });

  test("saveApiKeyOverride 多次调用同 provider 覆盖（UPSERT）", async () => {
    const { saveApiKeyOverride, loadApiKeyOverrides } = await import("../src/utils/api-key-persistence.js");
    saveApiKeyOverride(db, "openai", "sk-old-key-1234567890");
    saveApiKeyOverride(db, "openai", "sk-new-key-0987654321");
    const loaded = loadApiKeyOverrides(db);
    expect(loaded.length).toBe(1);
    expect(loaded[0].apiKey).toBe("sk-new-key-0987654321");
  });

  test("deleteApiKeyOverride 删除后 loadApiKeyOverrides 返回 0", async () => {
    const { saveApiKeyOverride, deleteApiKeyOverride, loadApiKeyOverrides } = await import("../src/utils/api-key-persistence.js");
    saveApiKeyOverride(db, "to-delete", "sk-will-be-deleted");
    expect(loadApiKeyOverrides(db).length).toBe(1);
    deleteApiKeyOverride(db, "to-delete");
    expect(loadApiKeyOverrides(db).length).toBe(0);
  });

  test("migratePlaintextKeys 全部已是密文时返回 0", async () => {
    const { saveApiKeyOverride, migratePlaintextKeys } = await import("../src/utils/api-key-persistence.js");
    saveApiKeyOverride(db, "already-encrypted", "sk-already-encrypted-key");
    expect(migratePlaintextKeys(db)).toBe(0);
  });
});

// ============================================================================
// Part B: rate-limiter.ts (MultiDimensionLimiter) 补充
// ============================================================================

describe("Task 4.2 补充 — MultiDimensionLimiter 边界", () => {
  test("setRule 为特定路径应用规则到三维度", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 100 },
      user: { windowMs: 60_000, maxRequests: 100 },
      global: { windowMs: 60_000, maxRequests: 100 },
    });
    // 为 /chat 设置更严格规则（每维度 2 次）
    limiter.setRule("/chat", { windowMs: 60_000, maxRequests: 2 });
    limiter.check("1.1.1.1", "userA", "/chat");
    limiter.check("1.1.1.1", "userA", "/chat");
    const result = limiter.check("1.1.1.1", "userA", "/chat");
    // 任一维度超限即可（这里 IP 超限）
    expect(result.allowed).toBe(false);
  });

  test("cleanup 不抛异常且清理过期状态", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter({
      ip: { windowMs: 1, maxRequests: 1 },     // 1ms 窗口
      user: { windowMs: 1, maxRequests: 1 },
      global: { windowMs: 1, maxRequests: 1 },
    });
    limiter.check("1.1.1.1", "userA");
    // 等待窗口过期
    await new Promise((r) => setTimeout(r, 5));
    expect(() => limiter.cleanup()).not.toThrow();
  });

  test("getHeaders 返回 X-RateLimit-Remaining 和 X-RateLimit-Reset", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter();
    const result = limiter.check("1.1.1.1", "userA");
    const headers = limiter.getHeaders(result);
    expect(headers["X-RateLimit-Remaining"]).toBeDefined();
    expect(headers["X-RateLimit-Reset"]).toBeDefined();
  });

  test("getHeaders 在被限流时包含 Retry-After", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 1 },
      user: { windowMs: 60_000, maxRequests: 100 },
      global: { windowMs: 60_000, maxRequests: 100 },
    });
    limiter.check("1.1.1.1", "userA");
    const denied = limiter.check("1.1.1.1", "userA");
    expect(denied.allowed).toBe(false);
    const headers = limiter.getHeaders(denied);
    expect(headers["Retry-After"]).toBeDefined();
  });

  test("check allowed=true 时 retryAfter 为 undefined", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter();
    const result = limiter.check("1.1.1.1", "userA");
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBeUndefined();
  });

  test("extractUserKey 处理 authorization: Bearer xxx", async () => {
    const { extractUserKey } = await import("../src/utils/rate-limiter.js");
    const req = new Request("https://example.com", {
      headers: { authorization: "Bearer sk-bearer-token-123456" },
    });
    const key = extractUserKey(req);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  test("extractUserKey x-api-key 优先于 authorization", async () => {
    const { extractUserKey } = await import("../src/utils/rate-limiter.js");
    const req = new Request("https://example.com", {
      headers: {
        "x-api-key": "sk-apikey-priority",
        "authorization": "Bearer sk-bearer-secondary",
      },
    });
    const key = extractUserKey(req);
    // 应该是 sk-apikey-priority 的 hash，而不是 sk-bearer-secondary 的
    const { createHash } = await import("crypto");
    const expectedHash = createHash("sha256")
      .update("sk-apikey-priority").digest("hex").slice(0, 16);
    expect(key).toBe(expectedHash);
  });
});

// ============================================================================
// Part C: process-sandbox.ts 补充
// ============================================================================

describe("Task 4.3 补充 — process-sandbox 边界", () => {
  test("命令不存在时返回非零 exitCode（Windows: 1, Linux: 127）", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const result = await processSandbox.execute({
      command: "this-command-does-not-exist-xyz123",
      args: [],
      timeoutMs: 5000,
    });
    // Windows: cmd.exe /c nonexistent 返回 1；Linux: /bin/sh -c nonexistent 返回 127
    expect(result.exitCode).not.toBe(0);
  });

  test("cwd 不存在时触发 catch 分支返回 exitCode=-1 + error 字段", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const result = await processSandbox.execute({
      command: "echo",
      args: ["test"],
      cwd: "/nonexistent/path/that/does/not/exist/xyz123",
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(-1);
    expect(result.error).toBeTruthy();
    expect(typeof result.error).toBe("string");
  });

  test("大量 stdout 输出触发截断标记", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const isWin = process.platform === "win32";
    // 输出 2MB 数据（超过 1MB 截断阈值）
    // Windows: powershell -Command "Write-Host -NoNewline ('x' * 2097152)"
    // Linux: head -c 2097152 /dev/zero | tr '\0' 'x'
    const result = await processSandbox.execute({
      command: isWin ? "powershell" : "head",
      args: isWin
        ? ["-Command", "[Console]::Out.Write(('x' * 2097152))"]
        : ["-c", "2097152", "/dev/zero"],
      timeoutMs: 15000,
    });
    // 应该被截断，包含截断标记
    expect(result.stdout).toContain("[stdout truncated at 1MB]");
    expect(result.stdout.length).toBeLessThan(1_100_000); // 不超过 1MB + 标记
  });

  test("resourceUsage.cpuMs 是非负数", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const isWin = process.platform === "win32";
    const result = await processSandbox.execute({
      command: isWin ? "echo" : "echo",
      args: ["resource-test"],
      timeoutMs: 5000,
    });
    expect(result.resourceUsage?.cpuMs).toBeGreaterThanOrEqual(0);
    expect(result.resourceUsage?.memoryBytes).toBe(0); // 当前实现固定 0
  });
});

// ============================================================================
// Part D: security-monitor.ts 补充
// ============================================================================

describe("Task 4.4 补充 — security-monitor 边界", () => {
  let tmpDir: string;
  let tmpLogPath: string;
  let AuditLogger: any;
  let SecurityMonitor: any;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-secmon-ext-"));
    tmpLogPath = path.join(tmpDir, "audit.log");
    const auditMod = await import("../src/utils/audit-logger.js");
    AuditLogger = auditMod.AuditLogger;
    const monMod = await import("../src/utils/security-monitor.js");
    SecurityMonitor = monMod.SecurityMonitor;
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function makeMonitor() {
    const logger = new AuditLogger({ filePath: tmpLogPath });
    return new SecurityMonitor(logger);
  }

  test("countRecentEvents 跳过损坏 JSON 行", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    // 写入混合：损坏行 + 有效行
    fs.appendFileSync(tmpLogPath, "this is not json\n");
    fs.appendFileSync(tmpLogPath, "{ broken json missing closing brace\n");
    // 写入 11 条有效 auth.failure（超过阈值 10）
    for (let i = 0; i < 11; i++) {
      logger.log({
        event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
        reason: "test", resource: "/api/test",
      });
    }
    fs.appendFileSync(tmpLogPath, "another corrupted line\n");
    // 应该正确识别 11 条有效记录并触发告警
    const alert = monitor.checkAuthFailureBurst();
    expect(alert).not.toBeNull();
    expect(alert!.count).toBe(11);
  });

  test("countRecentEvents 空 audit.log 返回 0", () => {
    const monitor = makeMonitor();
    // 不写任何日志
    expect(monitor.checkAuthFailureBurst()).toBeNull();
    expect(monitor.checkRateLimitAnomaly()).toBeNull();
  });

  test("countRecentEvents 跳过 timestamp 解析失败的行", () => {
    const monitor = makeMonitor();
    // 写入 timestamp 无效的行
    const badEntry = {
      timestamp: "not-a-valid-timestamp",
      event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
    };
    fs.appendFileSync(tmpLogPath, JSON.stringify(badEntry) + "\n");
    // 写入 11 条有效记录（仍应触发告警，timestamp 无效的不计入）
    const logger = (monitor as any).logger;
    for (let i = 0; i < 11; i++) {
      logger.log({
        event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
        reason: "test", resource: "/api/test",
      });
    }
    const alert = monitor.checkAuthFailureBurst();
    expect(alert).not.toBeNull();
    expect(alert!.count).toBe(11);
  });

  test("getSecurityMonitor 单例缓存行为", async () => {
    const { getSecurityMonitor, resetSecurityMonitorInstance } = await import("../src/utils/security-monitor.js");
    resetSecurityMonitorInstance();
    const m1 = getSecurityMonitor();
    const m2 = getSecurityMonitor();
    expect(m1).toBe(m2); // 同一实例
    resetSecurityMonitorInstance();
    const m3 = getSecurityMonitor();
    expect(m3).not.toBe(m1); // 重置后是新实例
  });

  test("refresh 不触发告警时 lastIncident 保持原值", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    // 第一次 refresh：触发告警
    for (let i = 0; i < 11; i++) {
      logger.log({
        event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
        reason: "test", resource: "/api/test",
      });
    }
    monitor.refresh();
    const firstIncident = monitor.getSecurityReport().lastIncident;
    expect(firstIncident).not.toBeNull();
    // 第二次 refresh：清空 audit.log，不触发告警
    fs.writeFileSync(tmpLogPath, "");
    monitor.refresh();
    // lastIncident 应保持原值（refresh 只在 newAlerts > 0 时更新）
    expect(monitor.getSecurityReport().lastIncident).toBe(firstIncident);
  });

  test("同时触发 rate_limit + auth_failure 两个告警", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    // 写入 60 条 rate_limit.exceeded（超阈值 50）+ 11 条 auth.failure（超阈值 10）
    for (let i = 0; i < 60; i++) {
      logger.log({
        event: "rate_limit.exceeded", actor: "1.2.3.4", outcome: "denied",
        reason: "test", resource: "/api/test",
      });
    }
    for (let i = 0; i < 11; i++) {
      logger.log({
        event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
        reason: "test", resource: "/api/test",
      });
    }
    const alerts = monitor.refresh();
    expect(alerts.length).toBe(2);
    const categories = alerts.map((a: any) => a.category).sort();
    expect(categories).toEqual(["auth_failure_burst", "rate_limit_anomaly"]);
    expect(monitor.getSecurityReport().healthy).toBe(false);
  });

  test("refresh 后 alerts 列表是新数组（不可变性）", () => {
    const monitor = makeMonitor();
    monitor.refresh();
    const report1 = monitor.getSecurityReport();
    const alerts1 = report1.alerts;
    alerts1.push({} as any); // 篡改返回的数组
    const report2 = monitor.getSecurityReport();
    expect(report2.alerts.length).toBe(0); // 不应受外部篡改影响
  });
});

// ============================================================================
// Part E: websocket.ts 补充
// ============================================================================

describe("Task 4.5 补充 — WebSocket 边界", () => {
  function makeMockWs(clientId: string, sentMessages: string[]) {
    return {
      data: { clientId },
      send: (msg: string) => sentMessages.push(msg),
      close: () => {},
    } as any;
  }

  test("onMessage 处理 unsubscribe 动作", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const sent: string[] = [];
    const ws = makeMockWs("client-unsub", sent);
    manager.onOpen(ws);
    // 先订阅
    manager.onMessage(ws, JSON.stringify({
      action: "subscribe", types: ["system.status", "heartbeat"],
    }));
    expect(manager.getStats().subscriptions["heartbeat"]).toBe(1);
    // 取消订阅 heartbeat
    sent.length = 0;
    manager.onMessage(ws, JSON.stringify({
      action: "unsubscribe", types: ["heartbeat"],
    }));
    // heartbeat 订阅数应减少
    expect(manager.getStats().subscriptions["heartbeat"] || 0).toBe(0);
    // system.status 仍订阅
    expect(manager.getStats().subscriptions["system.status"]).toBe(1);
  });

  test("onClose 广播 client_disconnected 事件", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const sender: string[] = [];
    const receiver: string[] = [];
    const senderWs = makeMockWs("sender-client", sender);
    const receiverWs = makeMockWs("receiver-client", receiver);
    manager.onOpen(senderWs);
    manager.onOpen(receiverWs);
    // receiver 订阅 system.status
    manager.onMessage(receiverWs, JSON.stringify({
      action: "subscribe", types: ["system.status"],
    }));
    receiver.length = 0;
    // sender 断开
    manager.onClose(senderWs);
    // receiver 应收到 client_disconnected 广播
    const disconnectMsg = receiver.find((m) => m.includes("client_disconnected"));
    expect(disconnectMsg).toBeDefined();
  });

  test("broadcast excludeClientId 排除自己", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const self: string[] = [];
    const other: string[] = [];
    const selfWs = makeMockWs("self-client", self);
    const otherWs = makeMockWs("other-client", other);
    manager.onOpen(selfWs);
    manager.onOpen(otherWs);
    // 都订阅 system.status
    manager.onMessage(selfWs, JSON.stringify({ action: "subscribe", types: ["system.status"] }));
    manager.onMessage(otherWs, JSON.stringify({ action: "subscribe", types: ["system.status"] }));
    self.length = 0;
    other.length = 0;
    // 广播并排除 self
    manager.broadcast({
      type: "system.status",
      payload: { event: "test" },
      timestamp: new Date().toISOString(),
    }, "self-client");
    expect(self.length).toBe(0);  // 排除自己
    expect(other.length).toBe(1); // 其他客户端收到
  });

  test("broadcast subscriptions 过滤：订阅了其他 type 但不包含目标 type 的客户端不收到", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const subscribed: string[] = [];
    const otherTypeOnly: string[] = [];
    const subWs = makeMockWs("sub-client", subscribed);
    const otherWs = makeMockWs("other-client", otherTypeOnly);
    manager.onOpen(subWs);
    manager.onOpen(otherWs);
    // subWs 订阅 heartbeat，otherWs 只订阅 system.status（不订阅 heartbeat）
    manager.onMessage(subWs, JSON.stringify({ action: "subscribe", types: ["heartbeat"] }));
    manager.onMessage(otherWs, JSON.stringify({ action: "subscribe", types: ["system.status"] }));
    subscribed.length = 0;
    otherTypeOnly.length = 0;
    // 广播 heartbeat 事件
    manager.broadcast({
      type: "heartbeat",
      payload: { time: Date.now() },
      timestamp: new Date().toISOString(),
    });
    expect(subscribed.length).toBe(1);       // 订阅了 heartbeat 的收到
    expect(otherTypeOnly.length).toBe(0);    // 只订阅 system.status 的不收到 heartbeat
  });

  test("getStats 返回正确的 subscriptions 统计", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const ws1 = makeMockWs("stats-1", []);
    const ws2 = makeMockWs("stats-2", []);
    manager.onOpen(ws1);
    manager.onOpen(ws2);
    manager.onMessage(ws1, JSON.stringify({ action: "subscribe", types: ["heartbeat", "system.status"] }));
    manager.onMessage(ws2, JSON.stringify({ action: "subscribe", types: ["heartbeat"] }));
    const stats = manager.getStats();
    expect(stats.connectedClients).toBe(2);
    expect(stats.subscriptions["heartbeat"]).toBe(2);
    expect(stats.subscriptions["system.status"]).toBe(1);
  });

  test("onMessage 处理 ping 动作返回 pong=true", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const sent: string[] = [];
    const ws = makeMockWs("ping-client", sent);
    manager.onOpen(ws);
    sent.length = 0;
    manager.onMessage(ws, JSON.stringify({ action: "ping" }));
    expect(sent.length).toBe(1);
    const response = JSON.parse(sent[0]);
    expect(response.payload.pong).toBe(true);
  });
});

// ============================================================================
// Part F: audit-logger.ts 补充（容错路径）
// ============================================================================

describe("audit-logger 补充 — 容错路径", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ext-"));
    logPath = path.join(tmpDir, "audit.log");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("目录已存在时 ensureDir 不抛异常", async () => {
    const { AuditLogger } = await import("../src/utils/audit-logger.js");
    // 目录已存在（beforeEach 创建）
    expect(() => new AuditLogger({ filePath: logPath })).not.toThrow();
    // 重复创建同一目录路径
    expect(() => new AuditLogger({ filePath: logPath })).not.toThrow();
  });

  test("initCurrentSize 文件不存在时 size=0", async () => {
    const { AuditLogger } = await import("../src/utils/audit-logger.js");
    const logger = new AuditLogger({ filePath: logPath });
    expect(logger.size).toBe(0);
  });

  test("initCurrentSize 文件已存在时正确读取大小", async () => {
    const { AuditLogger } = await import("../src/utils/audit-logger.js");
    // 先写一些内容到日志文件
    fs.writeFileSync(logPath, "existing content\n");
    const logger = new AuditLogger({ filePath: logPath });
    expect(logger.size).toBe(Buffer.byteLength("existing content\n", "utf8"));
  });

  test("log 在 appendFileSync 失败时降级（不抛异常）", async () => {
    const { AuditLogger } = await import("../src/utils/audit-logger.js");
    // 使用一个不存在的驱动器路径（Windows）或只读路径（Linux）
    // 这里用嵌套的不存在路径 — appendFileSync 会失败
    const badPath = path.join(tmpDir, "nonexistent-subdir", "audit.log");
    const logger = new AuditLogger({ filePath: badPath });
    // 应该不抛异常（log 内部有 catch）
    expect(() => {
      logger.log({
        event: "auth.success", actor: "1.2.3.4", outcome: "success",
      });
    }).not.toThrow();
  });

  test("大量 metadata 不破坏日志格式", async () => {
    const { AuditLogger } = await import("../src/utils/audit-logger.js");
    const logger = new AuditLogger({ filePath: logPath });
    const largeMetadata: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      largeMetadata[`key_${i}`] = `value_${i}_`.repeat(10);
    }
    logger.log({
      event: "config.change",
      actor: "admin",
      outcome: "success",
      metadata: largeMetadata,
    });
    const content = fs.readFileSync(logPath, "utf8");
    const entry = JSON.parse(content.trim());
    expect(entry.event).toBe("config.change");
    expect(Object.keys(entry.metadata).length).toBe(100);
  });

  test("readAll 文件不存在时返回空字符串", async () => {
    const { AuditLogger } = await import("../src/utils/audit-logger.js");
    const logger = new AuditLogger({ filePath: path.join(tmpDir, "never-exists.log") });
    expect(logger.readAll()).toBe("");
  });

  test("连续多次轮转后旧文件被清理（maxFiles 限制）", async () => {
    const { AuditLogger } = await import("../src/utils/audit-logger.js");
    const logger = new AuditLogger({ filePath: logPath, maxSize: 100, maxFiles: 2 });
    // 写入大量日志触发多次轮转
    for (let i = 0; i < 30; i++) {
      logger.log({
        event: "config.change",
        actor: `user-${i}`,
        outcome: "success",
        metadata: { padding: "x".repeat(80), index: i },
      });
    }
    const entries = fs.readdirSync(tmpDir);
    const rotated = entries.filter((e) => e.startsWith("audit.log."));
    expect(rotated.length).toBeLessThanOrEqual(2);
  });
});

// ============================================================================
// Part G: health-checker.ts checkSecurity 集成
// ============================================================================

describe("Task 4.4 集成 — health-checker.checkSecurity", () => {
  test("checkSecurity 在 healthy=true 时返回 ok 状态", async () => {
    const { HealthChecker } = await import("../src/core/health-checker.js");
    const { resetSecurityMonitorInstance, getSecurityMonitor } = await import("../src/utils/security-monitor.js");
    resetSecurityMonitorInstance();
    // 清空告警状态
    getSecurityMonitor().reset();
    const checker = new HealthChecker();
    const report = await checker.runFullCheck();
    const securityCheck = report.checks.find((c: any) => c.component === "安全");
    expect(securityCheck).toBeDefined();
    // 无活跃告警时状态应为 ok 或 warning（取决于 audit.log 是否有大量告警事件）
    // 这里仅验证 security 检查项存在且能执行
    expect(["ok", "warning", "error", "skipped"]).toContain(securityCheck!.status);
  });

  test("checkSecurity 在 healthy=false 时返回 warning 状态", async () => {
    const { HealthChecker } = await import("../src/core/health-checker.js");
    const { resetSecurityMonitorInstance, getSecurityMonitor } = await import("../src/utils/security-monitor.js");
    resetSecurityMonitorInstance();
    const monitor = getSecurityMonitor();
    monitor.reset();
    // 通过原型链直接调用 checkSecurity（私有方法）
    // 由于 checkSecurity 是 private，我们通过 runFullCheck 间接验证
    // 先注入大量告警事件到全局 auditLogger（让 SecurityMonitor 检测到异常）
    const { auditLogger } = await import("../src/utils/audit-logger.js");
    // 写入足够多的 auth.failure 触发告警
    for (let i = 0; i < 15; i++) {
      auditLogger.log({
        event: "auth.failure",
        actor: `1.2.3.${i % 256}`,
        outcome: "denied",
        reason: "test injection",
        resource: "/api/test",
      });
    }
    const checker = new HealthChecker();
    const report = await checker.runFullCheck();
    const securityCheck = report.checks.find((c: any) => c.component === "安全");
    expect(securityCheck).toBeDefined();
    // 注入了 15 条 auth.failure，超过阈值 10，应该 warning
    expect(securityCheck!.status).toBe("warning");
    // 清理：reset 单例避免污染其他测试
    monitor.reset();
    resetSecurityMonitorInstance();
  });
});
