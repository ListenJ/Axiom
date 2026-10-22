/**
 * P4.2 / D5 第一步：外部搜索入口显式启用 SSRF 守卫（红→绿可证伪）
 *
 * 背景：`proxyFetch` 的 ssrfGuard 仍是 opt-in——仓库 33 处 `proxyFetch(` 里只有
 * `crawl/data-pipeline.ts` 1 处开启。P4 按用户 D5=A 只给**外部搜索入口**显式启用：
 *   - `SearchEngine.fetch`（web_search 的 DuckDuckGo/Bing/SearXNG 等外部引擎）
 *   - `SerpApiClient.search`（固定官方 host，防御式）
 * 而**本地自建 SearXNG / loopback 适配器**按既有设计保持直连（proxy:null），不接守卫。
 *
 * 断言方式：mock 掉 proxy-fetch 模块，走真实调用路径（engine.search / client.search），
 * 检查实际传给 proxyFetch 的 options —— 不是读源码字符串。
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface CapturedCall {
  url: string;
  opts: Record<string, unknown>;
}

const calls: CapturedCall[] = [];

mock.module("../../src/utils/proxy-fetch.js", () => ({
  proxyFetch: async (url: string, opts: Record<string, unknown> = {}) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: async () => "",
      json: async () => ({ results: [] }),
    };
  },
}));

const engines = await import("../../src/crawl/search-engines.js");
const serpapi = await import("../../src/crawl/serpapi-client.js");

const savedConfig = process.env.AXIOM_WEB_SEARCH_CONFIG;
/** 清空代理 env：否则 SearchEngine.fetch 会先走真实 curl.exe 代理分支（测试应只走 proxyFetch 断言） */
const PROXY_ENV_KEYS = ["SEARCH_PROXY", "PROXY_URL", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"];
const savedProxyEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  calls.length = 0;
  for (const key of PROXY_ENV_KEYS) {
    savedProxyEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  if (savedConfig === undefined) delete process.env.AXIOM_WEB_SEARCH_CONFIG;
  else process.env.AXIOM_WEB_SEARCH_CONFIG = savedConfig;
  for (const key of PROXY_ENV_KEYS) {
    const value = savedProxyEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("P4.2 外部搜索入口 SSRF 守卫（D5 第一步）", () => {
  it("公网搜索引擎（DuckDuckGo）→ proxyFetch 显式携带 ssrfGuard:true", async () => {
    const engine = new engines.DuckDuckGoEngine();
    await engine.search({ query: "p4 ssrf guard", num: 1 });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].url).toContain("duckduckgo");
    expect(calls[0].opts.ssrfGuard).toBe(true);
  });

  it("本地自建 SearXNG（loopback）→ 保持直连 proxy:null，不接守卫（设计边界）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-searxng-"));
    const configPath = path.join(dir, "web-search.yaml");
    fs.writeFileSync(configPath, "searxng:\n  base_url: http://127.0.0.1:8080\n", "utf-8");
    process.env.AXIOM_WEB_SEARCH_CONFIG = configPath;
    try {
      await engines.searchAggregator.search("searxng", { query: "local self-hosted", num: 1 });
      expect(calls.length).toBe(1);
      expect(calls[0].url).toContain("127.0.0.1:8080");
      expect(calls[0].opts.proxy).toBeNull();
      expect(calls[0].opts.ssrfGuard).not.toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SerpAPI（固定官方 host）→ proxyFetch 显式携带 ssrfGuard:true", async () => {
    const client = new serpapi.SerpApiClient("test-key");
    await client.search({ q: "p4 serpapi" });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("serpapi.com");
    expect(calls[0].opts.ssrfGuard).toBe(true);
  });
});
