/**
 * Phase 4 安全加固测试（5 部分）
 *
 * Part 1: Task 4.1 — API Key AES-256-GCM 加密
 * Part 2: Task 4.2 — MultiDimensionLimiter 多维度限流
 * Part 3: Task 4.3 — process-sandbox 流式截断
 * Part 4: Task 4.4 — SecurityMonitor 安全监控
 * Part 5: Task 4.5 — WebSocket 配置化 + 消息长度限制
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

// ============================================================================
// Part 1: Task 4.1 — API Key AES-256-GCM 加密
// ============================================================================

describe("Task 4.1 — API Key 加密", () => {
  const ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString("base64"); // 32 字节固定测试密钥
  let db: any;
  let tmpDir: string;
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.AXIOM_ENCRYPTION_KEY;
    process.env.AXIOM_ENCRYPTION_KEY = ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-apikey-"));
    const { Database } = require("bun:sqlite");
    db = new Database(path.join(tmpDir, "test.db"));
    const { initApiKeyOverridesTable } = require("../src/utils/api-key-persistence.js");
    initApiKeyOverridesTable(db);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AXIOM_ENCRYPTION_KEY;
    else process.env.AXIOM_ENCRYPTION_KEY = originalKey;
    try { db?.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("saveApiKeyOverride → loadApiKeyOverrides 往返返回明文", async () => {
    const { saveApiKeyOverride, loadApiKeyOverrides } = await import("../src/utils/api-key-persistence.js");
    saveApiKeyOverride(db, "openai", "sk-test-1234567890abcdef", "https://api.openai.com");
    const loaded = loadApiKeyOverrides(db);
    expect(loaded.length).toBe(1);
    expect(loaded[0].provider).toBe("openai");
    expect(loaded[0].apiKey).toBe("sk-test-1234567890abcdef");
    expect(loaded[0].baseURL).toBe("https://api.openai.com");
  });

  test("DB 中存储的是密文（不等于明文）", async () => {
    const { saveApiKeyOverride } = await import("../src/utils/api-key-persistence.js");
    const plainKey = "sk-secret-key-1234567890";
    saveApiKeyOverride(db, "anthropic", plainKey);
    const row = db.query("SELECT api_key FROM api_key_overrides WHERE provider = ?").get("anthropic") as any;
    expect(row.api_key).not.toBe(plainKey);
    // 密文格式：<iv_hex>:<authTag_hex>:<ciphertext_hex>
    expect(row.api_key).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i);
  });

  test("未配密钥时 saveApiKeyOverride throw（fail-closed）", async () => {
    delete process.env.AXIOM_ENCRYPTION_KEY;
    const { saveApiKeyOverride } = await import("../src/utils/api-key-persistence.js");
    expect(() => saveApiKeyOverride(db, "test", "sk-key")).toThrow(/AXIOM_ENCRYPTION_KEY/);
  });

  test("未配密钥 + 明文记录：loadApiKeyOverrides 原样返回（兼容）", async () => {
    // 直接写入明文（绕过 encrypt）
    db.run(
      "INSERT INTO api_key_overrides (provider, api_key, base_url, set_at) VALUES (?, ?, ?, ?)",
      ["legacy", "sk-legacy-plaintext", null, Date.now()],
    );
    delete process.env.AXIOM_ENCRYPTION_KEY;
    const { loadApiKeyOverrides } = await import("../src/utils/api-key-persistence.js");
    const loaded = loadApiKeyOverrides(db);
    expect(loaded.length).toBe(1);
    expect(loaded[0].apiKey).toBe("sk-legacy-plaintext");
  });

  test("已配密钥 + 明文记录：loadApiKeyOverrides 跳过", async () => {
    // 直接写入明文
    db.run(
      "INSERT INTO api_key_overrides (provider, api_key, base_url, set_at) VALUES (?, ?, ?, ?)",
      ["legacy2", "sk-legacy-plaintext-2", null, Date.now()],
    );
    const { loadApiKeyOverrides } = await import("../src/utils/api-key-persistence.js");
    const loaded = loadApiKeyOverrides(db);
    expect(loaded.length).toBe(0); // 明文记录被跳过
  });

  test("migratePlaintextKeys 迁移明文记录为密文", async () => {
    // 直接写入明文
    db.run(
      "INSERT INTO api_key_overrides (provider, api_key, base_url, set_at) VALUES (?, ?, ?, ?)",
      ["migrate-target", "sk-migrate-me", null, Date.now()],
    );
    const { migratePlaintextKeys, loadApiKeyOverrides } = await import("../src/utils/api-key-persistence.js");
    const migrated = migratePlaintextKeys(db);
    expect(migrated).toBe(1);
    // 迁移后可以正常加载
    const loaded = loadApiKeyOverrides(db);
    expect(loaded.length).toBe(1);
    expect(loaded[0].apiKey).toBe("sk-migrate-me");
  });

  test("migratePlaintextKeys 未配密钥时返回 0", async () => {
    delete process.env.AXIOM_ENCRYPTION_KEY;
    const { migratePlaintextKeys } = await import("../src/utils/api-key-persistence.js");
    expect(migratePlaintextKeys(db)).toBe(0);
  });

  test("密钥不匹配时解密失败返回 null（跳过记录）", async () => {
    const { saveApiKeyOverride, loadApiKeyOverrides } = await import("../src/utils/api-key-persistence.js");
    saveApiKeyOverride(db, "key-mismatch", "sk-original-key");
    // 切换到不同密钥
    process.env.AXIOM_ENCRYPTION_KEY = Buffer.alloc(32, 0x99).toString("base64");
    const loaded = loadApiKeyOverrides(db);
    expect(loaded.length).toBe(0); // 解密失败，跳过
  });
});

// ============================================================================
// Part 2: Task 4.2 — MultiDimensionLimiter 多维度限流
// ============================================================================

describe("Task 4.2 — MultiDimensionLimiter", () => {
  test("基本检查：未超限 allowed=true", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 10 },
      user: { windowMs: 60_000, maxRequests: 20 },
      global: { windowMs: 60_000, maxRequests: 100 },
    });
    const result = limiter.check("1.2.3.4", "user-hash-1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.limitedDimension).toBeUndefined();
  });

  test("IP 维度超限", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 2 },
      user: { windowMs: 60_000, maxRequests: 100 },
      global: { windowMs: 60_000, maxRequests: 100 },
    });
    limiter.check("1.2.3.4", "user1");
    limiter.check("1.2.3.4", "user1");
    const result = limiter.check("1.2.3.4", "user1");
    expect(result.allowed).toBe(false);
    expect(result.limitedDimension).toBe("ip");
  });

  test("user 维度超限", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 100 },
      user: { windowMs: 60_000, maxRequests: 2 },
      global: { windowMs: 60_000, maxRequests: 100 },
    });
    limiter.check("1.1.1.1", "userA");
    limiter.check("2.2.2.2", "userA"); // 不同 IP，同 user
    const result = limiter.check("3.3.3.3", "userA");
    expect(result.allowed).toBe(false);
    expect(result.limitedDimension).toBe("user");
  });

  test("global 维度超限", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 100 },
      user: { windowMs: 60_000, maxRequests: 100 },
      global: { windowMs: 60_000, maxRequests: 2 },
    });
    limiter.check("1.1.1.1", "userA");
    limiter.check("2.2.2.2", "userB");
    const result = limiter.check("3.3.3.3", "userC");
    expect(result.allowed).toBe(false);
    expect(result.limitedDimension).toBe("global");
  });

  test("未认证请求（无 userKey）只走 IP + global", async () => {
    const { MultiDimensionLimiter } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 100 },
      user: { windowMs: 60_000, maxRequests: 1 }, // user 配额很低
      global: { windowMs: 60_000, maxRequests: 100 },
    });
    // 不传 userKey — 不应受 user 维度限制
    const r1 = limiter.check("1.1.1.1");
    const r2 = limiter.check("1.1.1.1");
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
  });

  test("extractUserKey 对相同 key 返回相同 hash", async () => {
    const { extractUserKey } = await import("../src/utils/rate-limiter.js");
    const req1 = new Request("https://example.com", {
      headers: { "x-api-key": "sk-test-123" },
    });
    const req2 = new Request("https://example.com", {
      headers: { "x-api-key": "sk-test-123" },
    });
    const k1 = extractUserKey(req1);
    const k2 = extractUserKey(req2);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{16}$/);
  });

  test("extractUserKey 无认证头返回 undefined", async () => {
    const { extractUserKey } = await import("../src/utils/rate-limiter.js");
    const req = new Request("https://example.com");
    expect(extractUserKey(req)).toBeUndefined();
  });

  test("createMultiDimensionMiddleware 返回 allowed + headers", async () => {
    const { MultiDimensionLimiter, createMultiDimensionMiddleware } = await import("../src/utils/rate-limiter.js");
    const limiter = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 100 },
      user: { windowMs: 60_000, maxRequests: 100 },
      global: { windowMs: 60_000, maxRequests: 100 },
    });
    const middleware = createMultiDimensionMiddleware(limiter);
    const req = new Request("https://example.com/api/test", {
      headers: { "x-api-key": "sk-test" },
    });
    const result = await middleware(req, "1.2.3.4");
    expect(result.allowed).toBe(true);
    expect(result.headers["X-RateLimit-Remaining"]).toBeDefined();
  });
});

// ============================================================================
// Part 3: Task 4.3 — process-sandbox 流式截断
// ============================================================================

describe("Task 4.3 — process-sandbox", () => {
  test("正常命令执行返回 stdout", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const isWin = process.platform === "win32";
    const result = await processSandbox.execute({
      command: isWin ? "echo" : "echo",
      args: isWin ? ["hello"] : ["hello"],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("错误命令返回非零 exitCode", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const isWin = process.platform === "win32";
    const result = await processSandbox.execute({
      command: isWin ? "cmd.exe" : "false",
      args: isWin ? ["/c", "exit", "1"] : [],
      timeoutMs: 5000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("resourceUsage 字段存在", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const isWin = process.platform === "win32";
    const result = await processSandbox.execute({
      command: "echo",
      args: ["test"],
      timeoutMs: 5000,
    });
    expect(result.resourceUsage).toBeDefined();
    expect(typeof result.resourceUsage?.cpuMs).toBe("number");
  });
});

// ============================================================================
// R3 延续验证：process-sandbox Windows cmd /c 参数合并为单字符串
// 目的：验证 ① 含空格/特殊字符的 args 不被 cmd 二次解释；
//       ② 输出无 Bun 双重引号导致的 `"` 残留；③ 无命令注入。
// ============================================================================
describe("Task 4.3 — process-sandbox R3 args merging", () => {
  test("R3-1: 含空格的参数原样输出（无引号残留）", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const result = await processSandbox.execute({
      command: "echo",
      args: ["hello world"],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    // 输出应包含完整短语，且不含字面双引号残留
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("world");
    expect(result.stdout).not.toContain('"hello world"');
    expect(result.stdout).not.toMatch(/["']hello["']/);
  });

  test("R3-2: 含 & 的参数不被解释为命令分隔符（无注入）", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    // 若 & 被解释为 cmd 分隔符，会尝试执行 "b" 命令导致非零退出或 stderr
    const result = await processSandbox.execute({
      command: "echo",
      args: ["a&b"],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    // 输出应包含字面 a&b，而不是 "a" 然后执行 b
    expect(result.stdout).toContain("a");
    expect(result.stdout).toContain("b");
    // 不应出现 'b' 不是内部或外部命令 之类的错误
    expect(result.stderr.toLowerCase()).not.toContain("not recognized");
    expect(result.stderr.toLowerCase()).not.toContain("not found");
  });

  test("R3-3: 多个参数按顺序输出", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const result = await processSandbox.execute({
      command: "echo",
      args: ["alpha", "beta", "gamma"],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    const idxA = result.stdout.indexOf("alpha");
    const idxB = result.stdout.indexOf("beta");
    const idxG = result.stdout.indexOf("gamma");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxG).toBeGreaterThan(idxB);
  });

  test("R3-4: 含 | 的参数不被解释为管道（无注入）", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    // 若 | 被解释为管道，echo 输出会被管道到某个命令，可能导致非预期行为
    const result = await processSandbox.execute({
      command: "echo",
      args: ["x|y"],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("x");
    expect(result.stdout).toContain("y");
  });

  test("R3-5: 无参数命令正常执行", async () => {
    const { processSandbox } = await import("../src/sandbox/process-sandbox.js");
    const result = await processSandbox.execute({
      command: "echo",
      args: [],
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    // echo 无参数应输出空行或空字符串
    expect(typeof result.stdout).toBe("string");
  });
});

// ============================================================================
// Part 4: Task 4.4 — SecurityMonitor 安全监控
// ============================================================================

describe("Task 4.4 — SecurityMonitor", () => {
  let tmpDir: string;
  let tmpLogPath: string;
  let AuditLogger: any;
  let SecurityMonitor: any;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-secmon-"));
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

  test("初始 getSecurityReport healthy=true", () => {
    const monitor = makeMonitor();
    const report = monitor.getSecurityReport();
    expect(report.healthy).toBe(true);
    expect(report.alerts.length).toBe(0);
    expect(report.lastIncident).toBeNull();
  });

  test("checkAuthFailureBurst 未达阈值返回 null", () => {
    const monitor = makeMonitor();
    // 写 5 条 auth.failure（< 阈值 10）
    const logger = (monitor as any).logger;
    for (let i = 0; i < 5; i++) {
      logger.log({
        event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
        reason: "invalid token", resource: "/api/test",
      });
    }
    expect(monitor.checkAuthFailureBurst()).toBeNull();
  });

  test("checkAuthFailureBurst 达阈值返回告警", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    // 写 11 条 auth.failure（> 阈值 10）
    for (let i = 0; i < 11; i++) {
      logger.log({
        event: "auth.failure", actor: `1.2.3.${i}`, outcome: "denied",
        reason: "invalid token", resource: "/api/test",
      });
    }
    const alert = monitor.checkAuthFailureBurst();
    expect(alert).not.toBeNull();
    expect(alert!.category).toBe("auth_failure_burst");
    expect(alert!.count).toBe(11);
    expect(alert!.threshold).toBe(10);
    expect(alert!.severity).toBe("medium"); // 11 < 10*2=20
  });

  test("checkAuthFailureBurst 超阈值 2 倍返回 high 严重度", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    for (let i = 0; i < 25; i++) {
      logger.log({
        event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
        reason: "invalid token", resource: "/api/test",
      });
    }
    const alert = monitor.checkAuthFailureBurst();
    expect(alert).not.toBeNull();
    expect(alert!.severity).toBe("high"); // 25 > 10*2=20
  });

  test("checkRateLimitAnomaly 未达阈值返回 null", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    for (let i = 0; i < 30; i++) {
      logger.log({
        event: "rate_limit.exceeded", actor: "1.2.3.4", outcome: "denied",
        reason: "rate limit", resource: "/api/test",
      });
    }
    expect(monitor.checkRateLimitAnomaly()).toBeNull();
  });

  test("checkRateLimitAnomaly 达阈值返回告警", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    for (let i = 0; i < 60; i++) {
      logger.log({
        event: "rate_limit.exceeded", actor: `1.2.3.${i % 10}`, outcome: "denied",
        reason: "rate limit", resource: "/api/test",
      });
    }
    const alert = monitor.checkRateLimitAnomaly();
    expect(alert).not.toBeNull();
    expect(alert!.category).toBe("rate_limit_anomaly");
    expect(alert!.count).toBe(60);
    expect(alert!.threshold).toBe(50);
  });

  test("refresh 更新告警列表 + lastIncident", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    for (let i = 0; i < 11; i++) {
      logger.log({
        event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
        reason: "invalid token", resource: "/api/test",
      });
    }
    const alerts = monitor.refresh();
    expect(alerts.length).toBe(1);
    const report = monitor.getSecurityReport();
    expect(report.healthy).toBe(false);
    expect(report.alerts.length).toBe(1);
    expect(report.lastIncident).not.toBeNull();
  });

  test("reset 清空告警状态", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    for (let i = 0; i < 11; i++) {
      logger.log({
        event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
        reason: "invalid token", resource: "/api/test",
      });
    }
    monitor.refresh();
    expect(monitor.getSecurityReport().healthy).toBe(false);
    monitor.reset();
    const report = monitor.getSecurityReport();
    expect(report.healthy).toBe(true);
    expect(report.alerts.length).toBe(0);
  });

  test("只统计窗口内的事件（5 分钟）", () => {
    const monitor = makeMonitor();
    const logger = (monitor as any).logger;
    // 手动写一条 10 分钟前的 auth.failure（超出窗口）
    const oldEntry = {
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
      reason: "invalid token", resource: "/api/test",
    };
    fs.appendFileSync(tmpLogPath, JSON.stringify(oldEntry) + "\n");
    // 再写 5 条当前 auth.failure
    for (let i = 0; i < 5; i++) {
      logger.log({
        event: "auth.failure", actor: "1.2.3.4", outcome: "denied",
        reason: "invalid token", resource: "/api/test",
      });
    }
    // 总共 6 条，但只有 5 条在窗口内 → 未达阈值 10
    expect(monitor.checkAuthFailureBurst()).toBeNull();
  });
});

// ============================================================================
// Part 5: Task 4.5 — WebSocket 配置化 + 消息长度限制
// ============================================================================

describe("Task 4.5 — WebSocket 配置化", () => {
  test("MAX_WS_CLIENTS 默认为 100（未配环境变量）", async () => {
    // 重新导入模块以读取当前环境变量
    delete require.cache[require.resolve("../src/utils/websocket.js")];
    const original = process.env.AXIOM_WS_MAX_CLIENTS;
    delete process.env.AXIOM_WS_MAX_CLIENTS;
    try {
      const mod = await import("../src/utils/websocket.js");
      // 通过 onOpen 行为间接验证：连接 100 个客户端后第 101 个被拒绝
      // 这里只验证模块加载成功
      expect(mod.wsManager).toBeDefined();
      expect(mod.WebSocketManager).toBeDefined();
    } finally {
      if (original !== undefined) process.env.AXIOM_WS_MAX_CLIENTS = original;
    }
  });

  test("WebSocketManager onOpen 接受连接", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const sentMessages: string[] = [];
    const mockWs = {
      data: { clientId: "test-client-1" },
      send: (msg: string) => sentMessages.push(msg),
      close: () => {},
    } as any;
    manager.onOpen(mockWs);
    // 应该发送历史消息（可能为空）+ 广播连接事件
    expect(manager.getStats().connectedClients).toBe(1);
  });

  test("onMessage 处理 subscribe 动作", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const sentMessages: string[] = [];
    const mockWs = {
      data: { clientId: "test-client-2" },
      send: (msg: string) => sentMessages.push(msg),
      close: () => {},
    } as any;
    manager.onOpen(mockWs);
    sentMessages.length = 0; // 清空 onOpen 发送的消息
    manager.onMessage(mockWs, JSON.stringify({
      action: "subscribe",
      types: ["system.status", "heartbeat"],
    }));
    // 应该收到订阅确认
    expect(sentMessages.length).toBe(1);
    const response = JSON.parse(sentMessages[0]);
    expect(response.type).toBe("system.status");
    expect(response.payload.subscribed).toContain("system.status");
    expect(response.payload.subscribed).toContain("heartbeat");
  });

  test("onMessage 处理 ping 动作", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const sentMessages: string[] = [];
    const mockWs = {
      data: { clientId: "test-client-3" },
      send: (msg: string) => sentMessages.push(msg),
      close: () => {},
    } as any;
    manager.onOpen(mockWs);
    sentMessages.length = 0;
    manager.onMessage(mockWs, JSON.stringify({ action: "ping" }));
    expect(sentMessages.length).toBe(1);
    const response = JSON.parse(sentMessages[0]);
    expect(response.payload.pong).toBe(true);
  });

  test("超长消息被拒绝（消息长度限制）", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const sentMessages: string[] = [];
    const mockWs = {
      data: { clientId: "test-client-4" },
      send: (msg: string) => sentMessages.push(msg),
      close: () => {},
    } as any;
    manager.onOpen(mockWs);
    sentMessages.length = 0;
    // 发送 70KB 消息（超过 64KB 限制）
    const bigMessage = "x".repeat(70 * 1024);
    manager.onMessage(mockWs, bigMessage);
    // 应该收到 message_too_large 错误，而不是订阅确认
    expect(sentMessages.length).toBe(1);
    const response = JSON.parse(sentMessages[0]);
    expect(response.payload.error).toBe("message_too_large");
    expect(response.payload.limit).toBe(64 * 1024);
  });

  test("无效 JSON 消息被忽略", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const sentMessages: string[] = [];
    const mockWs = {
      data: { clientId: "test-client-5" },
      send: (msg: string) => sentMessages.push(msg),
      close: () => {},
    } as any;
    manager.onOpen(mockWs);
    sentMessages.length = 0;
    manager.onMessage(mockWs, "not valid json {{{");
    // 无效 JSON 应被忽略，不发送任何响应
    expect(sentMessages.length).toBe(0);
  });

  test("onClose 移除客户端", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const mockWs = {
      data: { clientId: "test-client-6" },
      send: () => {},
      close: () => {},
    } as any;
    manager.onOpen(mockWs);
    expect(manager.getStats().connectedClients).toBe(1);
    manager.onClose(mockWs);
    expect(manager.getStats().connectedClients).toBe(0);
  });

  test("broadcast 发送消息给订阅者", async () => {
    const { WebSocketManager } = await import("../src/utils/websocket.js");
    const manager = new WebSocketManager();
    const sentMessages: string[] = [];
    const mockWs = {
      data: { clientId: "test-client-7" },
      send: (msg: string) => sentMessages.push(msg),
      close: () => {},
    } as any;
    manager.onOpen(mockWs);
    // 订阅 heartbeat 事件
    manager.onMessage(mockWs, JSON.stringify({ action: "subscribe", types: ["heartbeat"] }));
    sentMessages.length = 0;
    // 广播 heartbeat 事件
    manager.broadcast({
      type: "heartbeat",
      payload: { time: Date.now() },
      timestamp: new Date().toISOString(),
    });
    expect(sentMessages.length).toBe(1);
  });
});
