/**
 * 审计 D-1 / 整改 R3 Task 3.6 —— 搜索出口统一清洗收口
 *
 * 修复前：sanitizeSearchResultsForContext 仅在 web_search/chat 两个工具边界
 * 调用；unifiedSearch.search / concurrentSearch 返回路径无条数与长度钳制，
 * 未来消费方直连上下文即失去保护。
 *
 * 修复后契约：unifiedSearch.search 返回前统一过钳制
 * （≤SEARCH_RESULT_MAX_ITEMS 条、title/snippet 截断），concurrentSearch 经由
 * 同一出口自动继承。
 */
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { unifiedSearch } from "../../src/crawl/unified-search.js";
import {
  searchAggregator,
  SEARCH_RESULT_SNIPPET_MAX,
  SEARCH_RESULT_TITLE_MAX,
  SEARCH_RESULT_MAX_ITEMS,
} from "../../src/crawl/search-engines.js";

const restoreFns: Array<() => void> = [];
afterEach(() => {
  while (restoreFns.length) restoreFns.pop()!();
});

describe("unifiedSearch 出口钳制（D-1）", () => {
  test("超长/超额结果被截断到安全边界", async () => {
    const oversized = Array.from({ length: 40 }, (_, i) => ({
      title: `${"T".repeat(500)}-${i}`,
      link: `https://example.com/${i}`,
      displayedUrl: "",
      snippet: "S".repeat(2000),
      date: "",
      source: "mock",
      engine: "mock",
      richSnippets: undefined,
    }));

    const spy = spyOn(searchAggregator, "searchMulti").mockResolvedValue(oversized as any);
    restoreFns.push(() => spy.mockRestore());

    const out = await unifiedSearch.search({
      query: "clamp-test",
      engines: ["mock"],
      useCache: false,
      recordHistory: false,
      dedup: false,
      rerank: false,
    });

    expect(out.length).toBeLessThanOrEqual(SEARCH_RESULT_MAX_ITEMS);
    for (const r of out) {
      expect(r.title.length).toBeLessThanOrEqual(SEARCH_RESULT_TITLE_MAX);
      expect(r.snippet.length).toBeLessThanOrEqual(SEARCH_RESULT_SNIPPET_MAX);
    }
  });
});
