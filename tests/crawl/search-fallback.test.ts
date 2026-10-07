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
  // SearXNG 地址现由 config/web-search.yaml 的 searxng.base_url 驱动（自建优先），
  // 因此本地/内网地址也要识别；原实现只认公共实例 sapti.me，
  // 在"已部署自建实例"的机器上会误报 unexpected host。
  if (u.hostname.includes("sapti.me") || u.hostname === "127.0.0.1" || u.hostname === "localhost") {
    return resp(SEARX_RESULTS);
  }
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

  it("其他引擎**有结果**时不追加 bing-html（防无关结果污染）★2026-10-07 契约变更", async () => {
    // 旧实现无条件并行追加 bing-html。实测 Bing CN 对长查询只按首词匹配，其无关结果
    // 会挤掉正确来源（SearXNG 已给出人民银行官网，却被百度百科条目抢占前列）。
    // 现契约：bing-html 仅在**其他引擎全部无结果**时兜底。
    const agg = new SearchAggregator(topologyFetch);
    const r = await agg.searchMulti({ query: "test", num: 5 }, ["searxng", "duckduckgo"]);
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => x.engine.includes("bing-html"))).toBe(false);
    expect(r.some((x) => x.engine.includes("searxng"))).toBe(true);
  });

  it("全部引擎失败 → 返回空数组（不抛异常）", async () => {
    const failing: SearchFetch = async () => { throw new Error("network down"); };
    const agg = new SearchAggregator(failing);
    const r = await agg.searchMulti({ query: "x" }, ["duckduckgo"]);
    expect(r).toEqual([]);
  });

  it("默认调用有结果时同样不含 bing-html（它只在空结果时兜底）", async () => {
    const agg = new SearchAggregator(topologyFetch);
    const r = await agg.searchMulti({ query: "test", num: 5 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => x.engine.includes("bing-html"))).toBe(false);
  });
});
