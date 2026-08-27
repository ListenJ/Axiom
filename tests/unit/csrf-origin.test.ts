/**
 * 审计 J-2 / 整改 R2 Task 2.6 —— 本机免认证通道的 CSRF 防线
 *
 * 修复前：checkApiKey 对 isLocal 一律放行，恶意网页可用 no-cors POST
 * 打本机 /terminal/session、/sandbox/execute、/vault/write 等写端点。
 *
 * 修复后契约（仅作用于本机免认证通道）：
 *   - Task2 DNS重绑定修复：Host 去信任，仅 Origin 白名单放行（本地回环）
 *   - 写方法（非 GET/HEAD/OPTIONS）携带 Origin 且不在白名单 → 需有效凭证否则拒绝
 *   - 无 Origin（curl/本地工具）或白名单内 Origin（127.0.0.1/localhost/::1 含端口/裸 host）→ 放行
 */
import { describe, test, expect } from "bun:test";
import { checkApiKey } from "../../src/utils/auth-check.js";

function makeReq(method: string, url: string, origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin) headers["origin"] = origin;
  return new Request(url, { method, headers });
}

describe("本机写请求 CSRF Origin 校验（J-2）", () => {
  const TOKEN = "test-token-j2-abcdef";
  const LOCAL_URL = "http://127.0.0.1:18789/sandbox/execute";

  test("跨站 Origin 的 POST 被拒绝", () => {
    expect(checkApiKey(makeReq("POST", LOCAL_URL, "http://evil.example"), true, TOKEN)).toBe(false);
    expect(checkApiKey(makeReq("DELETE", LOCAL_URL, "https://evil.example"), true, TOKEN)).toBe(false);
  });

  test("同源 Origin（Dashboard 自身）放行", () => {
    expect(checkApiKey(makeReq("POST", LOCAL_URL, "http://127.0.0.1:18789"), true, TOKEN)).toBe(true);
    // Task2 白名单化：localhost 与 127.0.0.1 均属本地，Host 去信任后同放行
    expect(checkApiKey(makeReq("POST", LOCAL_URL, "http://localhost:18789"), true, TOKEN)).toBe(true);
  });

  test("无 Origin 的本地工具调用放行（curl / CLI）", () => {
    expect(checkApiKey(makeReq("POST", LOCAL_URL), true, TOKEN)).toBe(true);
  });

  test("读方法不受影响", () => {
    expect(checkApiKey(makeReq("GET", LOCAL_URL, "http://evil.example"), true, TOKEN)).toBe(true);
    expect(checkApiKey(makeReq("HEAD", LOCAL_URL, "http://evil.example"), true, TOKEN)).toBe(true);
    expect(checkApiKey(makeReq("OPTIONS", LOCAL_URL, "http://evil.example"), true, TOKEN)).toBe(true);
  });

  test("远程通道行为不变（带正确 token 仍放行）", () => {
    const remoteReq = new Request("https://api.example.com/sandbox/execute", {
      method: "POST",
      headers: { "x-api-key": TOKEN },
    });
    expect(checkApiKey(remoteReq, false, TOKEN, "/sandbox/execute")).toBe(true);
  });
});
