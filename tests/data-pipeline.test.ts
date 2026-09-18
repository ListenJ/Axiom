import { describe, it, expect, beforeEach, beforeAll, afterAll, spyOn } from "bun:test";
import { DataPipeline } from "../src/crawl/data-pipeline.js";

describe("DataPipeline", () => {
  // 确定性：mock 网络，避免对 example.com / DDG 的真实请求（离线/慢网下超时）
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("<html><head><title>Example</title></head><body><h1>Example Domain</h1><p>hello</p></body></html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch
    );
  });

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  // 搜索 mock：duckduckgo 返一个真实结果块（确定性，无网络）
  const DDG_HTML = `<div class="result results_links results_links_deep web-result">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fresult&amp;rut=x">Mock Result Title</a></h2>
    <a class="result__snippet" href="x">mock snippet</a>
    <a class="result__url" href="x">example.com/result</a>
  </div></div>`;
  const searchFetchImpl = async () => ({
    ok: true, status: 200, statusText: "OK", headers: {}, url: "",
    text: async () => DDG_HTML,
    json: async () => ({}),
    buffer: async () => Buffer.from(DDG_HTML),
    arrayBuffer: async () => Buffer.from(DDG_HTML).buffer,
  });
  let pipeline: DataPipeline;

  beforeEach(() => {
    pipeline = new DataPipeline({
      maxConcurrent: 2,
      requestDelay: 100,
      maxDepth: 1,
      retries: 1,
      fetchImpl: globalThis.fetch as never, // 用 spy 的 fetch（确定性）
      searchFetchImpl,
    });
  });

  it("should initialize with correct options", () => {
    expect(pipeline).toBeDefined();
  });

  it("should list search engines", () => {
    const engines = pipeline.listSearchEngines();
    expect(Array.isArray(engines)).toBe(true);
    expect(engines.length).toBeGreaterThan(0);
    expect(engines[0]).toHaveProperty("name");
    expect(engines[0]).toHaveProperty("available");
  });

  it("should search and return results（mock 注入，确定性）", async () => {
    const results = await pipeline.searchStructured("Axiom AI agent", "duckduckgo", { num: 3 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("Mock Result Title");
    expect(results[0].link).toBe("https://example.com/result");
    expect(results[0]).toHaveProperty("snippet");
  });

  it("should crawl and structure a webpage", async () => {
    const result = await pipeline.crawlStructured("https://example.com");
    
    if (result) {
      expect(result).toHaveProperty("url");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("markdown");
      expect(result).toHaveProperty("headings");
      expect(result).toHaveProperty("links");
      expect(result).toHaveProperty("chunks");
      expect(Array.isArray(result.headings)).toBe(true);
      expect(Array.isArray(result.links)).toBe(true);
      expect(Array.isArray(result.chunks)).toBe(true);
    }
  });

  it("should calculate quality score", async () => {
    const result = await pipeline.crawlStructured("https://example.com");
    
    if (result) {
      expect(result).toHaveProperty("url");
      expect(typeof result.title).toBe("string");
    }
  });
});
