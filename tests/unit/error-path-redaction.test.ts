/**
 * P2.3 错误路径日志脱敏断言（2026-10-22）
 *
 * 目标：三条真实错误路径 —— SSRF 被拒、api-key 连通性失败、第二因子 403 ——
 * 对外错误体与**真实日志输出**都不得出现 key/token/secret 原文。
 *
 * 断言方式（不读源码字符串）：
 *   1. 捕获全局 logger 写入的真实日志文件 `data/logs/agent.log` 的新增字节，断言不含敏感值；
 *   2. 正控制：先用同一 logger 打一条含 sk- 密钥的 error，证明「文件确实会增长 + value 脱敏生效 +
 *      本测试的扫描机制不是空转」；
 *   3. 对外响应/错误文案本身也不得含敏感值。
 */
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spyOn } from "bun:test";
import { testProviderConnection } from "../../src/utils/api-key-store.js";
import { assertSafeOutboundUrl } from "../../src/utils/url-safety.js";
import { handlePermissionMode } from "../../src/routes/health.js";
import { auditLogger } from "../../src/utils/audit-logger.js";
import { logger } from "../../src/utils/logger.js";
import type { RouteContext } from "../../src/routes/types.js";

const LOG_PATH = path.resolve(import.meta.dir, "../../data/logs/agent.log");
/** 匹配 logger 的 value-based 脱敏规则（sk- 前缀 ≥8 位） */
const SECRET = "sk-ERRORPATHLEAK0123456789abcdef";
const PROVIDED_SECRET = "sk-PROVIDEDLEAK0123456789abcdef";

function logOffset(): number {
  try {
    return fs.statSync(LOG_PATH).size;
  } catch {
    return 0;
  }
}

/** 等待日志文件增长（最多 2s），返回自 offset 起的新增文本。 */
async function logSince(offset: number, waitMs = 2000): Promise<string> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const size = fs.statSync(LOG_PATH).size;
      if (size > offset) {
        const fd = fs.openSync(LOG_PATH, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          return buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      /* 文件尚未创建：继续等 */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return "";
}

function assertNoSecret(text: string, secrets: string[], where: string): void {
  for (const secret of secrets) {
    expect(text.includes(secret), `${where} 泄漏了敏感值 ${secret.slice(0, 6)}…`).toBe(false);
  }
}

function makeCtx(
  pathname: string,
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): RouteContext {
  const req = new Request("https://example.com" + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    url: new URL(req.url),
    req,
    vault: null,
    db: {} as never,
    pipeline: {} as never,
    healthMonitor: { checkAll: async () => [] } as never,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200, extra?: Record<string, string>) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...(extra ?? {}) },
      }),
  } as unknown as RouteContext;
}

const savedSecond = process.env.AXIOM_SECOND_FACTOR_TOKEN;

beforeAll(() => {
  // data/logs 由全局 logger 初始化时创建；若不存在（极简环境），此处补建以免正控制无法落盘。
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
});

beforeEach(() => {
  if (savedSecond === undefined) delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
  else process.env.AXIOM_SECOND_FACTOR_TOKEN = savedSecond;
});

describe("P2.3 错误路径不泄露 key/token/secret", () => {
  test("正控制：日志文件确实增长且 value-based 脱敏生效（防假绿）", async () => {
    const offset = logOffset();
    logger.error("[p23-redaction-control] synthetic error carries secret", new Error(`token=${SECRET}`));
    const fresh = await logSince(offset);
    expect(fresh.length, "正控制要求日志文件出现新增内容（否则后续断言是空转）").toBeGreaterThan(0);
    assertNoSecret(fresh, [SECRET], "正控制日志");
    expect(fresh).toContain("[REDACTED]");
  });

  test("路径 1：SSRF 被拒 —— 错误体与日志不泄露 apiKey", async () => {
    const offset = logOffset();

    // (a) 直接守卫：gemini 风格 URL（key 在 query）被 loopback 策略拒绝
    let blockedText = "";
    try {
      await assertSafeOutboundUrl(`http://127.0.0.1:11434/v1beta/models?key=${SECRET}`);
    } catch (e) {
      blockedText = JSON.stringify({
        message: (e as Error).message,
        recovery: (e as { recovery?: string }).recovery,
      });
    }
    expect(blockedText).toContain("AXIOM_SSRF_ALLOWLIST");
    assertNoSecret(blockedText, [SECRET], "SSRF 错误体");

    // (b) BYOK 连通性测试走同一守卫：被拒返回体不得含 key
    const result = await testProviderConnection(SECRET, "http://127.0.0.1:11434/v1", "openai");
    expect(result.ok).toBe(false);
    assertNoSecret(JSON.stringify(result), [SECRET], "SSRF 被拒的连通性测试返回体");

    assertNoSecret(await logSince(offset, 300), [SECRET], "SSRF 路径日志");
  });

  test("路径 2：api-key 连通性失败 —— 上游/网络错误里的 key 必须脱敏", async () => {
    const offset = logOffset();
    // 模拟 gemini 适配器：key 在 query 中；网络错误把整条 URL 带进错误消息（真实运行时会这样）
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      throw new Error(`connect failed for ${String(input)}`);
    }) as unknown as typeof fetch);
    try {
      const result = await testProviderConnection(SECRET, "https://198.51.100.10/v1", "gemini");
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toContain("connect failed"); // 确认走的是失败分支而不是守卫
      assertNoSecret(JSON.stringify(result), [SECRET], "连通性失败返回体");
    } finally {
      fetchSpy.mockRestore();
    }
    assertNoSecret(await logSince(offset, 300), [SECRET], "连通性失败路径日志");
  });

  test("路径 3：第二因子 403 —— 响应体与审计日志都不记录 token/凭证原文", async () => {
    process.env.AXIOM_SECOND_FACTOR_TOKEN = SECRET;
    const offset = logOffset();
    const res = (await handlePermissionMode(
      makeCtx("/permissions/mode", "POST", { "x-api-key": PROVIDED_SECRET }, { autoAccept: false }),
    )) as Response;
    expect(res.status).toBe(403);

    const bodyText = await res.text();
    expect(bodyText).toContain("invalid-second-factor"); // 确认走的是第二因子拒绝分支
    assertNoSecret(bodyText, [SECRET, PROVIDED_SECRET], "第二因子 403 响应体");

    // 审计日志（真实文件）也不得出现 token/凭证原文
    const auditText = auditLogger.readAll();
    expect(auditText).toContain("invalid-second-factor");
    assertNoSecret(auditText, [SECRET, PROVIDED_SECRET], "审计日志");

    assertNoSecret(await logSince(offset, 300), [SECRET, PROVIDED_SECRET], "第二因子路径日志");
  });
});
