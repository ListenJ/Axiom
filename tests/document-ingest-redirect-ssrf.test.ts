/**
 * document-ingest 重定向 SSRF 测试（B3-Medium，docs/reviews/2026-08-29-joint-verification-audit.md §4）
 *
 * 审计症状：document-ingest.ts:157 readSource 仅对初始 URL 过 isSafeUrl，却以
 * redirect:"follow" 请求 —— 301/302 跳转到内网/元数据地址时逐跳不校验（SSRF 残窗）。
 * 修复：改 redirect:"manual"，循环逐跳 isSafeUrl（上限 5 跳），非安全跳转中止。
 */
import { describe, it, expect } from "bun:test";
import { ingestDocument } from "../src/knowledge/document-ingest.js";

type FetchLike = typeof fetch;

/** 模拟"跟随重定向"的恶意服务：manual 模式下 301 到内网；follow 模式（修复前语义）直接返回内网内容 */
function maliciousRedirectFetch(redirectTarget: string, body = "<html><body>pwned</body></html>"): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.redirect === "manual") {
      return new Response(null, { status: 301, headers: { location: redirectTarget } });
    }
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as FetchLike;
}

describe("document-ingest 重定向逐跳 SSRF 校验（B3-Medium）", () => {
  it("301 跳转到回环地址被拒绝（修复前直接摄取内网内容）", async () => {
    const doc = await ingestDocument(
      { url: "https://example.com/page.html" },
      { fetchImpl: maliciousRedirectFetch("http://127.0.0.1:9222/json/version") },
    );
    expect(doc.error).toMatch(/SSRF guard/i);
    expect(doc.markdown).toBe("");
    expect(doc.markdown).not.toContain("pwned");
  });

  it("301 跳转到云元数据地址被拒绝", async () => {
    const doc = await ingestDocument(
      { url: "https://example.com/page.html" },
      { fetchImpl: maliciousRedirectFetch("http://169.254.169.254/latest/meta-data/") },
    );
    expect(doc.error).toMatch(/SSRF guard/i);
  });

  it("301 跳转到安全外域正常跟随（行为保持），source 为最终 URL", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (init?.redirect === "manual" && seen.length === 1) {
        return new Response(null, { status: 301, headers: { location: "https://safe.example/doc.html" } });
      }
      return new Response("<html><body>Safe</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as FetchLike;
    const doc = await ingestDocument({ url: "https://example.com/old.html" }, { fetchImpl });
    expect(seen).toContain("https://safe.example/doc.html");
    expect(doc.error).toBeUndefined();
    expect(doc.markdown).toContain("Safe");
    expect(doc.source).toBe("https://safe.example/doc.html");
  });

  it("超过 5 跳中止并报错", async () => {
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls++;
      return new Response(null, { status: 302, headers: { location: `https://example.com/r${calls}` } });
    }) as unknown as FetchLike;
    const doc = await ingestDocument({ url: "https://example.com/loop.html" }, { fetchImpl });
    expect(doc.error).toMatch(/too many redirects/i);
    expect(calls).toBe(6); // 1 次初始 + 5 次跳转，第 6 个 302 不再跟随
  });
});
