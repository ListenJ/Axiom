import { describe, it, expect } from "bun:test";
import { handleVaultSearch, handleWebSearch } from "../../src/routes/search.js";
import { handleApiKeys } from "../../src/routes/api-keys.js";

function makeCtx(urlStr: string, headers: Record<string, string> = {}, vault: unknown = null) {
  const req = new Request(urlStr, { headers });
  return {
    url: new URL(urlStr), req, vault, db: null, pipeline: null, healthMonitor: null, fileWatcher: null,
    startupTime: Date.now(), baseHeaders: {},
    jsonResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  } as any;
}

describe("handleVaultSearch 路由修复（/search 双角色）", () => {
  it("浏览器导航（无 q + Accept text/html）→ null（走 SPA 回退）", async () => {
    const res = await handleVaultSearch(makeCtx("http://x/search", { accept: "text/html,application/xhtml+xml" }));
    expect(res).toBeNull();
  });
  it("API 无 q 且非浏览器 → 400 JSON", async () => {
    const res = (await handleVaultSearch(makeCtx("http://x/search"))) as Response;
    expect(res.status).toBe(400);
  });
  it("带 q → 200 JSON（命中 vault.search 结果）", async () => {
    const vault = { search: (q: string) => [{ note: { title: q, path: "/kb/x.md", content: "c" }, score: 1, reasons: [], excerpt: "e" }] };
    const res = (await handleVaultSearch(makeCtx("http://x/search?q=FlashInfer", {}, vault))) as Response;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results[0].note.title).toBe("FlashInfer");
  });
});

describe("handleApiKeys 二次认证守卫（路由修复）", () => {
  it("非 /api-keys 路径 → null（放行，不再无条件 401）", async () => {
    const res = await handleApiKeys(makeCtx("http://x/search"));
    expect(res).toBeNull();
  });
  it("/api-keys 路径无 token → 401/503（拒绝）", async () => {
    const res = (await handleApiKeys(makeCtx("http://x/api-keys/test"))) as Response;
    expect(res).not.toBeNull();
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});

describe("handleWebSearch", () => {
  it("缺 q → 400", async () => {
    const res = (await handleWebSearch(makeCtx("http://x/web-search"))) as Response;
    expect(res.status).toBe(400);
  });
});

describe("审计整改 O5: web-search 路由钳制消毒", () => {
  function makeFullCtx(urlStr: string, pipelineResults: unknown[]) {
    const req = new Request(urlStr);
    return {
      url: new URL(urlStr),
      req,
      vault: null,
      db: { run: () => {} },
      pipeline: { searchMulti: async () => pipelineResults },
      healthMonitor: null,
      fileWatcher: null,
      startupTime: Date.now(),
      baseHeaders: {},
      jsonResponse: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    } as any;
  }

  it("num=9999 → 返回条数 ≤30 且 title/snippet 受 sanitize 常量约束", async () => {
    const big = Array.from({ length: 9999 }, (_, i) => ({
      position: i + 1,
      title: `t${i}-${"x".repeat(500)}`,
      link: `http://link/${i}`,
      displayedUrl: "",
      snippet: "s".repeat(2000),
      source: "ddg",
      engine: "ddg",
    }));
    const ctx = makeFullCtx("http://x/web-search?q=o5probe&num=9999", big);
    const res = (await handleWebSearch(ctx)) as Response;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results.length).toBeLessThanOrEqual(30);
    for (const r of data.results) {
      expect(r.title.length).toBeLessThanOrEqual(200);
      expect(r.snippet.length).toBeLessThanOrEqual(300);
    }
  });

  it("vault limit=10000 → 实际传给 vault.search 的 limit ≤100", async () => {
    let capturedLimit = -1;
    const vault = {
      search: (_q: string, opts: { limit: number }) => {
        capturedLimit = opts.limit;
        return [];
      },
    };
    const res = (await handleVaultSearch(makeCtx("http://x/search?q=o5vault&limit=10000", {}, vault))) as Response;
    expect(res.status).toBe(200);
    expect(capturedLimit).toBeGreaterThanOrEqual(0);
    expect(capturedLimit).toBeLessThanOrEqual(100);
  });
});
