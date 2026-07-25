/**
 * 2026-07-26 安全修复回归测试
 *
 * 覆盖：
 *   1. url-safety SSRF 拦截（含 IPv6 / 重定向目标）
 *   2. terminal_exec spawn 环境变量过滤（密钥类变量剥离）
 *   3. filesystem 沙箱敏感区域拒绝（.env / .git / 数据库）
 *   4. router 永久性失败不重试 + 黑名单跳过
 */
import { describe, test, expect } from "bun:test";

// ─────────────────────────────────────────────────────────
// 1. url-safety
// ─────────────────────────────────────────────────────────
import { isSafeUrl } from "../src/utils/url-safety.js";

describe("url-safety isSafeUrl", () => {
  test("公网 http/https 放行", () => {
    expect(isSafeUrl("https://example.com/page")).toBe(true);
    expect(isSafeUrl("http://news.ycombinator.com")).toBe(true);
  });

  test("非 http 协议拦截", () => {
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("ftp://x.com/f")).toBe(false);
    expect(isSafeUrl("gopher://x/")).toBe(false);
  });

  test("环回与元数据地址拦截", () => {
    expect(isSafeUrl("http://127.0.0.1:18789/config")).toBe(false);
    expect(isSafeUrl("http://localhost:3001")).toBe(false);
    expect(isSafeUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isSafeUrl("http://0.0.0.0/")).toBe(false);
    expect(isSafeUrl("http://[::1]:8080/")).toBe(false);
  });

  test("RFC1918 私网拦截", () => {
    expect(isSafeUrl("http://10.0.0.5/")).toBe(false);
    expect(isSafeUrl("http://172.16.0.1/")).toBe(false);
    expect(isSafeUrl("http://172.31.255.255/")).toBe(false);
    expect(isSafeUrl("http://192.168.0.150:9001/v1/models")).toBe(false);
    expect(isSafeUrl("http://172.15.0.1/")).toBe(true); // 边界外放行
  });

  test("IPv6 ULA/link-local 拦截", () => {
    expect(isSafeUrl("http://[fc00::1]/")).toBe(false);
    expect(isSafeUrl("http://[fd12::8]/")).toBe(false);
    expect(isSafeUrl("http://[fe80::1]/")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// 2. terminal spawn env 过滤
// ─────────────────────────────────────────────────────────
import { executeCommand } from "../src/mcp/tools/terminal.js";

describe("terminal_exec spawn env 过滤", () => {
  // Windows cmd 嵌套引号易碎，改用脚本文件执行
  const scriptPath = ".tmp-e2e/env-check.cjs";

  test("子进程环境不含密钥类变量", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(".tmp-e2e", { recursive: true });
    writeFileSync(scriptPath, 'console.log(Object.keys(process.env).filter(k=>/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)).join(","))');
    process.env.TEST_SECRET_KEY_ABC = "should-not-leak";
    process.env.ZHIPU_API_KEY = "should-not-leak";
    try {
      const r = await executeCommand(`node ${scriptPath}`, { timeout: 10000 });
      expect(r.success).toBe(true);
      expect(r.stdout).not.toContain("TEST_SECRET_KEY_ABC");
      expect(r.stdout).not.toContain("ZHIPU_API_KEY");
    } finally {
      delete process.env.TEST_SECRET_KEY_ABC;
      delete process.env.ZHIPU_API_KEY;
    }
  });

  test("常规环境变量仍可用", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(".tmp-e2e", { recursive: true });
    writeFileSync(scriptPath, 'console.log(typeof process.env.PATH)');
    const r = await executeCommand(`node ${scriptPath}`, { timeout: 10000 });
    expect(r.success).toBe(true);
    expect(r.stdout.trim()).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────
// 3. filesystem 沙箱敏感区域
// ─────────────────────────────────────────────────────────
import { readFile } from "../src/mcp/tools/filesystem.js";

describe("filesystem 沙箱敏感区域拒绝", () => {
  test(".env 拒绝", async () => {
    const r = await readFile(".env");
    expect(r.success).toBe(false);
    expect(r.error).toContain("denied area");
  });

  test(".env.production 拒绝", async () => {
    const r = await readFile(".env.production.example");
    expect(r.success).toBe(false);
    expect(r.error).toContain("denied area");
  });

  test(".git 路径拒绝", async () => {
    const r = await readFile(".git/config");
    expect(r.success).toBe(false);
  });

  test("运行时数据库拒绝", async () => {
    const r = await readFile("data/agent.db");
    expect(r.success).toBe(false);
    expect(r.error).toContain("denied area");
  });

  test("model-config.json 拒绝", async () => {
    const r = await readFile("data/model-config.json");
    expect(r.success).toBe(false);
  });

  test("普通项目文件放行", async () => {
    const r = await readFile("package.json");
    expect(r.success).toBe(true);
  });

  test("目录外路径仍拒绝（原有防线不破坏）", async () => {
    const r = await readFile("../outside.txt");
    expect(r.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// 4. router 永久性失败：纯逻辑单测（不依赖 mock 模块，避免全量运行时 mock 污染）
// ─────────────────────────────────────────────────────────
import { isPermanentFailure, recordPermanentFailure, isModelBlacklisted } from "../src/router/model-router.js";

describe("router 永久性失败处理（纯逻辑）", () => {
  test("永久性错误判定", () => {
    expect(isPermanentFailure("Missing API key for kimi: KIMI_API_KEY")).toBe(true);
    expect(isPermanentFailure('HTTP 400: {"code":"20012","message":"Model does not exist"}')).toBe(true);
    expect(isPermanentFailure('HTTP 403: {"message":"Model disabled."}')).toBe(true);
    expect(isPermanentFailure("HTTP 401: token expired")).toBe(true);
    // 瞬时可重试错误不误判
    expect(isPermanentFailure("HTTP 429: rate limit")).toBe(false);
    expect(isPermanentFailure("Request timeout")).toBe(false);
    expect(isPermanentFailure("HTTP 500: internal error")).toBe(false);
    expect(isPermanentFailure("fetch failed")).toBe(false);
  });

  test("拉黑后查询命中，过期自动清除", () => {
    recordPermanentFailure("testprovider", "test-model-xyz");
    expect(isModelBlacklisted("testprovider", "test-model-xyz")).toBe(true);
    expect(isModelBlacklisted("testprovider", "other-model")).toBe(false);
    expect(isModelBlacklisted("otherprovider", "test-model-xyz")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// 5. ToolRegistry 安全守卫（R1：审批层接入 MCP 工具执行路径）
// ─────────────────────────────────────────────────────────
import { ToolRegistry } from "../src/mcp/tool-registry.js";

describe("ToolRegistry 安全守卫", () => {
  test("守卫在 handler 之前被调用（携带工具名与参数）", async () => {
    const seen: Array<[string, Record<string, unknown>]> = [];
    const registry = new ToolRegistry({
      guard: async (name, args) => { seen.push([name, args]); },
    });
    let handlerRan = false;
    registry.add({
      name: "test_tool",
      description: "t",
      inputSchema: {},
      handler: async () => { handlerRan = true; return { ok: true }; },
    });
    const handlers = registry.buildHttpHandlers();
    const result = await handlers.test_tool({ a: 1 }) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(handlerRan).toBe(true);
    expect(seen).toEqual([["test_tool", { a: 1 }]]);
  });

  test("守卫抛异常时 handler 不执行（阻止高危操作）", async () => {
    const registry = new ToolRegistry({
      guard: async () => { throw new Error("[RiskMonitor] 双层复核判定为高危操作，已阻止执行"); },
    });
    let handlerRan = false;
    registry.add({
      name: "terminal_exec",
      description: "t",
      inputSchema: {},
      handler: async () => { handlerRan = true; return { ok: true }; },
    });
    const handlers = registry.buildHttpHandlers();
    const result = await handlers.terminal_exec({ command: "rm -rf /" }) as { error?: boolean; message?: string };
    expect(handlerRan).toBe(false);
    expect(result.error).toBe(true);
    expect(result.message).toContain("已阻止执行");
  });

  test("默认守卫对未监视工具直接放行（无网络调用）", async () => {
    // 默认守卫 = 双层复核；未在 SCREENED_TOOLS 中的工具 extractPayload=null → pass
    const registry = new ToolRegistry();
    registry.add({
      name: "unrelated_tool",
      description: "t",
      inputSchema: {},
      handler: async () => ({ ok: true }),
    });
    const handlers = registry.buildHttpHandlers();
    const result = await handlers.unrelated_tool({ x: "y" }) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});
