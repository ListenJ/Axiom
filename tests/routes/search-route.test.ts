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
