import { describe, it, expect } from "bun:test";
import { SearchAggregator, type SearchFetch } from "../../src/crawl/search-engines.js";
import type { ProxyFetchResponse } from "../../src/utils/proxy-fetch.js";

const DDG_CHALLENGE = "<html><body>anomaly challenge page</body></html>";
const BING_HTML = `<ol id="b_results"><li class="b_algo" data-id iid=SERP.1><h2 class=""><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=abc">Bing Fallback Result</a></h2><p>bing snippet</p><cite>example.com</cite></li></ol>`;
const SEARX_RESULTS = { results: [{ title: "Searx Result", url: "https://sx.example.com", content: "sx snippet", engine: "google" }] };

function resp(body: string | object, ok = true): ProxyFetchResponse {
  return {
    ok, status: ok ? 200 : 502, statusText: ok ? "OK" : "ERR", headers: {}, url: "",
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "object" ? body : {}),
    buffer: async () => Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).buffer,
  };
}

/** 模拟真实搜索拓扑：duckduckgo 返挑战页（空），bing-html 返结果，searxng 返结果 */
const topologyFetch: SearchFetch = async (url: string) => {
  const u = new URL(url);
  if (u.hostname.includes("duckduckgo")) return resp(DDG_CHALLENGE);
  if (u.hostname.includes("bing.com")) return resp(BING_HTML);
  if (u.hostname.includes("sapti.me")) return resp(SEARX_RESULTS);
  throw new Error("unexpected host: " + u.hostname);
};

describe("搜索回退集成（mock fetch 注入）", () => {
  it("duckduckgo 反爬空结果 → 自动回退 bing-html 并返回真实结果", async () => {
    const agg = new SearchAggregator(topologyFetch);
    const r = await agg.searchMulti({ query: "test", num: 5 }, ["duckduckgo"]);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].engine).toContain("bing-html");
    expect(r[0].title).toContain("Bing Fallback Result");
  });

  it("显式引擎列表也会追加 bing-html 兜底（多引擎聚合）", async () => {
    const agg = new SearchAggregator(topologyFetch);
    const r = await agg.searchMulti({ query: "test", num: 5 }, ["searxng", "duckduckgo"]);
    expect(r.length).toBeGreaterThan(1);
    expect(r.some((x) => x.engine.includes("bing-html"))).toBe(true);
    expect(r.some((x) => x.engine.includes("searxng"))).toBe(true);
  });

  it("全部引擎失败 → 返回空数组（不抛异常）", async () => {
    const failing: SearchFetch = async () => { throw new Error("network down"); };
    const agg = new SearchAggregator(failing);
    const r = await agg.searchMulti({ query: "x" }, ["duckduckgo"]);
    expect(r).toEqual([]);
  });

  it("默认引擎含 bing-html（无参数调用也走回退）", async () => {
    const agg = new SearchAggregator(topologyFetch);
    const r = await agg.searchMulti({ query: "test", num: 5 });
    expect(r.some((x) => x.engine.includes("bing-html"))).toBe(true);
  });
});
