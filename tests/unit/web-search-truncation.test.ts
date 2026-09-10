/**
 * web_search 结果上下文清洗回归测试（审计 M6）
 *
 * 行为规格：
 * 1. 清洗函数：单条 snippet ≤300 字符、title ≤200、总条数 ≤30。
 * 2. chat 工具面 web_search handler：模型可控的 num/engines 不能击穿上下文预算。
 */
import { describe, test, expect } from "bun:test";
import {
  sanitizeSearchResultsForContext,
  SEARCH_RESULT_SNIPPET_MAX,
  SEARCH_RESULT_MAX_ITEMS,
} from "../../src/crawl/search-engines.js";
import { buildWebToolSurfaces } from "../../src/routes/chat.js";
import type { DataPipeline } from "../../src/crawl/data-pipeline.js";

function makeResults(n: number, snippetLen: number) {
  return Array.from({ length: n }, (_, i) => ({
    engine: "duckduckgo",
    title: `t${i}`.repeat(120),
    link: `https://example.com/${i}`,
    snippet: "x".repeat(snippetLen),
  }));
}

describe("sanitizeSearchResultsForContext（M6 回归）", () => {
  test("截断单条 snippet 与总条数", () => {
    const out = sanitizeSearchResultsForContext(makeResults(100, 5000));
    expect(out.length).toBeLessThanOrEqual(SEARCH_RESULT_MAX_ITEMS);
    for (const r of out) {
      expect(r.snippet.length).toBeLessThanOrEqual(SEARCH_RESULT_SNIPPET_MAX);
      expect(r.title.length).toBeLessThanOrEqual(200);
    }
  });

  test("空数组与正常小结果原样通过", () => {
    expect(sanitizeSearchResultsForContext([])).toEqual([]);
    const small = makeResults(2, 50);
    expect(sanitizeSearchResultsForContext(small)).toHaveLength(2);
  });
});

describe("chat web_search handler 上下文防护（M6 行为级）", () => {
  test("多引擎大结果被钳制在安全预算内", async () => {
    const fakePipeline = {
      searchMulti: async () => makeResults(90, 8000),
      crawlStructured: async () => null,
    } as unknown as DataPipeline;

    const tools = buildWebToolSurfaces(fakePipeline);
    const ws = tools.find((t) => t.name === "web_search");
    expect(ws).toBeDefined();

    const out = (await ws!.handler({ query: "stress", engines: ["a", "b", "c"], num: 50 })) as Array<{
      snippet: string;
      title: string;
    }>;
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(SEARCH_RESULT_MAX_ITEMS);
    for (const r of out) expect(r.snippet.length).toBeLessThanOrEqual(SEARCH_RESULT_SNIPPET_MAX);
  });
});
