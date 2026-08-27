/**
 * Logger 密钥脱敏单元测试
 *
 * 覆盖：
 *   - key-based 脱敏（password/token/secret/api_key 等字段名，复用 sanitizeRequestBody）
 *   - value-based 脱敏（sk-xxx / Bearer xxx / AKIA / ghp_ / glpat- / xoxb- 密钥模式）
 *   - 嵌套对象脱敏
 *   - URL 中嵌入的密钥
 *   - 非字符串值不受影响
 *   - error 对象的 message / stack 中的密钥
 *
 * 注意：logger.ts 的 writeFile 是异步的（fileStream.write），但 log() 不 await。
 * 测试需显式 flush 后再读取文件。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { Logger } from "../src/utils/logger.js";

let tmpDir: string;
let logPath: string;
let logger: Logger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-redact-"));
  logPath = path.join(tmpDir, "test.log");
  logger = new Logger({
    minLevel: "debug",
    outputs: [{ type: "file", path: logPath }],
    format: "json",
  });
});

afterEach(async () => {
  logger.close();
  // writeStream.end() 是异步落盘；给一拍时间避免 unlink/rmdir 与在途写入竞态
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const entries = fs.readdirSync(tmpDir);
    for (const e of entries) fs.unlinkSync(path.join(tmpDir, e));
    fs.rmdirSync(tmpDir);
  } catch {
    // ignore
  }
});

/** 等待 fileStream 写入完成（writeFile 是异步的） */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/** 读取日志文件的最后一行并 parse 为对象 */
async function readLastEntry(): Promise<Record<string, unknown>> {
  await flush();
  const content = fs.readFileSync(logPath, "utf8").trim();
  const lines = content.split("\n");
  const last = lines[lines.length - 1];
  return JSON.parse(last);
}

describe("Logger redactContext", () => {
  it("key-based 脱敏：api_key 字段值替换为 [REDACTED]", async () => {
    logger.info("test", { api_key: "sk-abcd1234efgh5678" });
    const entry = await readLastEntry();
    const ctx = entry.context as Record<string, unknown>;
    expect(ctx.api_key).toBe("[REDACTED]");
    const raw = fs.readFileSync(logPath, "utf8");
    expect(raw).not.toContain("sk-abcd1234efgh5678");
  });

  it("key-based 脱敏：password 字段", async () => {
    logger.info("test", { password: "mySecret123" });
    const entry = await readLastEntry();
    const ctx = entry.context as Record<string, unknown>;
    expect(ctx.password).toBe("[REDACTED]");
  });

  it("value-based 脱敏：Bearer token 字符串", async () => {
    logger.info("test", { token: "Bearer abc123-xyz" });
    const entry = await readLastEntry();
    const ctx = entry.context as Record<string, unknown>;
    expect(ctx.token).toBe("[REDACTED]");
  });

  it("value-based 脱敏：AWS AKIA key", async () => {
    logger.info("test", { description: "Using AKIAIOSFODNN7EXAMPLE to access S3" });
    const entry = await readLastEntry();
    const ctx = entry.context as Record<string, unknown>;
    // 正则只替换密钥部分，保留周围文本
    expect(String(ctx.description)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(String(ctx.description)).toContain("[REDACTED]");
    expect(String(ctx.description)).toContain("Using");
    expect(String(ctx.description)).toContain("S3");
  });

  it("value-based 脱敏：GitHub PAT (ghp_)", async () => {
    const pat = "ghp_" + "a".repeat(36);
    logger.info("test", { config: `token=${pat}` });
    const entry = await readLastEntry();
    const ctx = entry.context as Record<string, unknown>;
    // 正则只替换密钥部分，保留 "token=" 前缀
    expect(String(ctx.config)).not.toContain(pat);
    expect(String(ctx.config)).toContain("[REDACTED]");
    expect(String(ctx.config)).toContain("token=");
  });

  it("嵌套对象脱敏：normal 保留，nested.password 替换", async () => {
    logger.info("test", { normal: "hello", nested: { password: "pw" } });
    const entry = await readLastEntry();
    const ctx = entry.context as Record<string, unknown>;
    expect(ctx.normal).toBe("hello");
    const nested = ctx.nested as Record<string, unknown>;
    expect(nested.password).toBe("[REDACTED]");
  });

  it("URL 中嵌入的密钥被替换", async () => {
    logger.info("test", { url: "https://api.com?token=sk-abcd1234efgh5678" });
    const entry = await readLastEntry();
    const ctx = entry.context as Record<string, unknown>;
    expect(String(ctx.url)).not.toContain("sk-abcd1234efgh5678");
    expect(String(ctx.url)).toContain("[REDACTED]");
  });

  it("非字符串值不受影响（number / boolean）", async () => {
    // 注意：sanitizeRequestBody 用 spread {...body} 会把数组转成对象（索引作键），
    // 因此此处只验证 number 和 boolean，不验证数组（数组脱敏由 sanitizeRequestBody 行为决定）。
    logger.info("test", { count: 42, flag: true });
    const entry = await readLastEntry();
    const ctx = entry.context as Record<string, unknown>;
    expect(ctx.count).toBe(42);
    expect(ctx.flag).toBe(true);
  });

  it("error 对象的 message 中密钥被替换", async () => {
    const err = new Error("Auth failed for sk-abcd1234efgh5678");
    logger.error("auth-error", err);
    const entry = await readLastEntry();
    const errObj = entry.error as Record<string, unknown>;
    expect(String(errObj.message)).not.toContain("sk-abcd1234efgh5678");
    expect(String(errObj.message)).toContain("[REDACTED]");
  });

  it("error 对象的 stack 中密钥被替换", async () => {
    const err = new Error("Bearer abc123 failed");
    err.stack = "Error: Bearer abc123 failed\n    at sk-abcd1234efgh5678";
    logger.error("stack-error", err);
    const entry = await readLastEntry();
    const errObj = entry.error as Record<string, unknown>;
    const stack = String(errObj.stack);
    expect(stack).not.toContain("Bearer abc123");
    expect(stack).not.toContain("sk-abcd1234efgh5678");
    expect(stack).toContain("[REDACTED]");
  });

  it("无 context 的日志正常输出", async () => {
    logger.info("no-context");
    const entry = await readLastEntry();
    expect(entry.message).toBe("no-context");
    expect(entry.context).toBeUndefined();
  });

  it("混合场景：敏感与正常字段共存", async () => {
    logger.info("mixed", {
      user: "alice",
      api_key: "sk-realkey123456",
      action: "login",
      token: "Bearer xyz789",
      metadata: { ip: "127.0.0.1", session: "abc" },
    });
    const entry = await readLastEntry();
    const ctx = entry.context as Record<string, unknown>;
    expect(ctx.user).toBe("alice");
    expect(ctx.api_key).toBe("[REDACTED]");
    expect(ctx.action).toBe("login");
    expect(ctx.token).toBe("[REDACTED]");
    const meta = ctx.metadata as Record<string, unknown>;
    expect(meta.ip).toBe("127.0.0.1");
    expect(meta.session).toBe("abc");
  });
});

describe("Logger text 路径脱敏（整改 D4）", () => {
  it("text 格式 console 输出：context 中的密钥值替换为 [REDACTED]", () => {
    const origLog = console.log;
    let captured = "";
    console.log = (msg?: unknown) => {
      captured += String(msg);
    };
    try {
      const textLogger = new Logger({
        minLevel: "debug",
        outputs: [{ type: "console" }],
        format: "text",
        enableColors: false,
      });
      textLogger.info("text-path", {
        note: "the key is sk-abcd1234efgh5678 please rotate",
        api_key: "sk-zzzz9999aaaa8888",
      });
    } finally {
      console.log = origLog;
    }
    expect(captured).toContain("[REDACTED]");
    expect(captured).not.toContain("sk-abcd1234efgh5678");
    expect(captured).not.toContain("sk-zzzz9999aaaa8888");
  });

  it("text 格式无敏感字段时输出保持原样", () => {
    const origLog = console.log;
    let captured = "";
    console.log = (msg?: unknown) => {
      captured += String(msg);
    };
    try {
      const textLogger = new Logger({
        minLevel: "debug",
        outputs: [{ type: "console" }],
        format: "text",
        enableColors: false,
      });
      textLogger.info("plain-text-path", { userId: 42, action: "ping" });
    } finally {
      console.log = origLog;
    }
    expect(captured).toContain("plain-text-path");
    expect(captured).toContain("42");
    expect(captured).not.toContain("[REDACTED]");
  });
});
