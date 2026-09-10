// 回归测试：DuckDuckGo / Bing 的 site 限定正确拼入查询（FIX E）
//
// 缺陷：Bing 曾把 site 写成字面量参数名 "site:"（set("site:", ...)），
// DDG 曾写成 "sites" 参数 —— 二者均非真实参数，site 限定静默失效。
// 修复后统一在 q 中拼接 "site:" 运算符（与正常工作的 SearXNG 一致）。
import { test, expect } from "bun:test";
import { DuckDuckGoEngine, BingEngine, type SearchFetch } from "../src/crawl/search-engines.ts";

function captureFetch() {
  let captured = "";
  const fetchImpl: SearchFetch = async (url: string) => {
    captured = url;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      url,
      text: async () => "<html></html>",
      json: async () => ({}),
      buffer: async () => Buffer.from(""),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetchImpl, getCaptured: () => captured };
}

test("DuckDuckGo 将 site 限定拼入查询 (site:)", async () => {
  const { fetchImpl, getCaptured } = captureFetch();
  const eng = new DuckDuckGoEngine(fetchImpl);
  await eng.search({ query: "climate", site: "nasa.gov" });

  const raw = getCaptured();
  const decoded = decodeURIComponent(raw);
  expect(decoded).toContain("site:nasa.gov");
  // 旧的无效 "sites" 参数不应再出现
  expect(raw).not.toContain("sites=");
});

test("Bing 将 site 限定拼入查询 (site:)，而非名为 site: 的孤立参数", async () => {
  process.env.BING_API_KEY = "dummy-test-key";
  const { fetchImpl, getCaptured } = captureFetch();
  const eng = new BingEngine(fetchImpl);
  await eng.search({ query: "climate", site: "nasa.gov" });

  const raw = getCaptured();
  const decoded = decodeURIComponent(raw);
  expect(decoded).toContain("site:nasa.gov");
  // 旧 bug：set("site:", opts.site) 产生孤立参数 "site%3A=nasa.gov"
  expect(raw).not.toContain("site%3A=");
});
