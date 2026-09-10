import { describe, it, expect } from "bun:test";
import { DuckDuckGoEngine, BingHtmlEngine, SearchAggregator, type SearchEngineResult } from "../../src/crawl/search-engines.js";

describe("DuckDuckGoEngine.parseHtml", () => {
  const e = new DuckDuckGoEngine();
  it("解析真实 DDG 结果块（title/href/snippet，uddg 解码）", () => {
    const html = `<div class="result results_links results_links_deep web-result">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example Page Title</a></h2>
      <a class="result__snippet" href="x">snippet text here</a>
      <a class="result__url" href="x">example.com/page</a>
    </div></div>`;
    const r = e.parseHtml(html, 5);
    expect(r.length).toBe(1);
    expect(r[0].title).toBe("Example Page Title");
    expect(r[0].link).toBe("https://example.com/page");
    expect(r[0].snippet).toContain("snippet text");
    expect(r[0].engine).toBe("duckduckgo");
  });
  it("limit 截断（多个块只取前 N）", () => {
    const block = `<div class="result results_links results_links_deep"><a class="result__a" href="https://a.com/1">A1</a><a class="result__url" href="x">a.com</a></div></div>`;
    const r = e.parseHtml(block + block + block, 2);
    expect(r.length).toBe(2);
  });
  it("无结果块返回空数组", () => {
    expect(e.parseHtml("<html><body>no results</body></html>", 5)).toEqual([]);
  });
});

describe("BingHtmlEngine.parseHtml", () => {
  const e = new BingHtmlEngine();
  it("解析真实 Bing 标记（<h2 class><a target=_blank>）", () => {
    const html = `<ol id="b_results"><li class="b_algo" data-id iid=SERP.1><h2 class=""><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;mkt=zh">Bing Result Title</a></h2><p>bing snippet text</p><cite>example.com</cite></li></ol>`;
    const r = e.parseHtml(html, 5);
    expect(r.length).toBe(1);
    expect(r[0].title).toBe("Bing Result Title");
    expect(r[0].link).toContain("bing.com/ck/a");
    expect(r[0].snippet).toContain("bing snippet");
    expect(r[0].engine).toBe("bing-html");
  });
  it("空页/无 b_algo 返回空数组", () => {
    expect(e.parseHtml("<html><body>challenge</body></html>", 5)).toEqual([]);
  });
});

describe("SearchAggregator.mergeAndDeduplicate", () => {
  const a = new SearchAggregator();
  const base: SearchEngineResult = { position: 1, title: "T", link: "https://example.com/a?utm_source=x#frag", displayedUrl: "example.com", snippet: "short", source: "example.com", engine: "duckduckgo" };
  it("按规范化 URL 去重（去 utm/hash），保留更长 snippet + 合并引擎", () => {
    const dup: SearchEngineResult = { ...base, link: "https://example.com/a?utm_campaign=y", snippet: "much longer snippet content", engine: "bing-html" };
    const merged = a.mergeAndDeduplicate([base, dup]);
    expect(merged.length).toBe(1);
    expect(merged[0].snippet).toBe("much longer snippet content");
    expect(merged[0].engine).toContain("bing-html");
  });
  it("不同 URL 不去重", () => {
    const r = a.mergeAndDeduplicate([base, { ...base, link: "https://other.com/b" }]);
    expect(r.length).toBe(2);
  });
});

describe("SearchAggregator.listEngines", () => {
  it("bing-html 标记可用（无 key 回退引擎）", () => {
    const engines = new SearchAggregator().listEngines();
    const bh = engines.find((x) => x.name === "bing-html");
    expect(bh?.available).toBe(true);
    expect(engines.some((x) => x.name === "duckduckgo")).toBe(true);
  });
});
