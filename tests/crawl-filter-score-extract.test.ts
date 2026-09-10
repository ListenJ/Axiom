/**
 * Phase 2 检索优化 — filter/score/extract 单元测试
 *
 * 三部分：
 *   1. result-filter: 黑名单、启发式、去重
 *   2. result-scorer: 4 维度打分
 *   3. data-extractor: 三元组抽取 + zod 校验
 */
import { describe, it, expect } from "bun:test";
import { filterResults } from "../src/crawl/result-filter.js";
import { scoreResult } from "../src/crawl/result-scorer.js";
import { extractFacts, ExtractedFactSchema } from "../src/crawl/data-extractor.js";
import type { SearchEngineResult } from "../src/crawl/search-engines.js";

function makeResult(overrides: Partial<SearchEngineResult> = {}): SearchEngineResult {
  return {
    position: 1,
    title: "TypeScript Programming Guide",
    link: "https://www.typescriptlang.org/docs/",
    displayedUrl: "typescriptlang.org",
    snippet: "A comprehensive guide to TypeScript programming language features.",
    date: "2024-06-15",
    source: "test",
    engine: "ddg",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// Part 1: result-filter
// ═══════════════════════════════════════════════════════════════

describe("filterResults", () => {
  it("过滤黑名单域名（赌博）", () => {
    const results = [
      makeResult({ position: 1, link: "https://www.casino-gambling.com/page" }),
      makeResult({ position: 2, link: "https://www.typescriptlang.org/docs/" }),
    ];
    const filtered = filterResults(results);
    expect(filtered.length).toBe(1);
    expect(filtered[0].link).toContain("typescriptlang");
  });

  it("过滤黑名单域名（色情）", () => {
    const results = [
      makeResult({ position: 1, link: "https://porn-adult-content.xxx/page" }),
      makeResult({ position: 2, link: "https://example.edu/guide" }),
    ];
    const filtered = filterResults(results);
    expect(filtered.length).toBe(1);
    expect(filtered[0].link).toContain("example.edu");
  });

  it("过滤标题过短（<10 字符）", () => {
    const results = [
      makeResult({ position: 1, title: "Hi" }),
      makeResult({ position: 2, title: "Proper Title Here" }),
    ];
    const filtered = filterResults(results);
    expect(filtered.length).toBe(1);
    expect(filtered[0].title).toBe("Proper Title Here");
  });

  it("过滤 snippet 过短（<20 字符）", () => {
    const results = [
      makeResult({ position: 1, snippet: "Short" }),
      makeResult({ position: 2, snippet: "This is a longer snippet with enough content." }),
    ];
    const filtered = filterResults(results);
    expect(filtered.length).toBe(1);
    expect(filtered[0].snippet).toContain("longer snippet");
  });

  it("过滤纯广告 snippet", () => {
    const results = [
      makeResult({ position: 1, snippet: "Buy now! Free shipping! Discount 50% off!" }),
      makeResult({ position: 2, snippet: "Technical documentation about the topic." }),
    ];
    const filtered = filterResults(results);
    expect(filtered.length).toBe(1);
    expect(filtered[0].snippet).toContain("Technical");
  });

  it("按 link 去重，保留 position 最小者", () => {
    const results = [
      makeResult({ position: 5, link: "https://example.com/page", title: "Position Five Title" }),
      makeResult({ position: 2, link: "https://example.com/page", title: "Position Two Title" }),
      makeResult({ position: 8, link: "https://example.com/page", title: "Position Eight Title" }),
    ];
    const filtered = filterResults(results);
    expect(filtered.length).toBe(1);
    expect(filtered[0].title).toBe("Position Two Title");
  });

  it("link 带 query/hash 时归一化去重", () => {
    const results = [
      makeResult({ position: 1, link: "https://example.com/page?utm=1" }),
      makeResult({ position: 2, link: "https://example.com/page#section" }),
    ];
    const filtered = filterResults(results);
    expect(filtered.length).toBe(1);
  });

  it("结果按 position 升序排列", () => {
    const results = [
      makeResult({ position: 5, link: "https://a.com/" }),
      makeResult({ position: 1, link: "https://b.com/" }),
      makeResult({ position: 3, link: "https://c.com/" }),
    ];
    const filtered = filterResults(results);
    expect(filtered.map((r) => r.position)).toEqual([1, 3, 5]);
  });

  it("空数组输入返回空数组", () => {
    expect(filterResults([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 2: result-scorer
// ═══════════════════════════════════════════════════════════════

describe("scoreResult", () => {
  it("返回 4 个维度分项 + total（0-100）", () => {
    const result = makeResult();
    const score = scoreResult(result, "typescript programming");
    expect(score).toHaveProperty("sourceCredibility");
    expect(score).toHaveProperty("contentRelevance");
    expect(score).toHaveProperty("timeliness");
    expect(score).toHaveProperty("factualAccuracy");
    expect(score).toHaveProperty("total");
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
  });

  it(".edu/.gov 域名 sourceCredibility 高", () => {
    const gov = scoreResult(makeResult({ link: "https://nasa.gov/page" }), "space");
    const xyz = scoreResult(makeResult({ link: "https://spam.xyz/page" }), "space");
    expect(gov.sourceCredibility).toBeGreaterThan(xyz.sourceCredibility);
    expect(gov.sourceCredibility).toBeGreaterThanOrEqual(0.95);
    expect(xyz.sourceCredibility).toBeLessThanOrEqual(0.25);
  });

  it("title 与 query 相关性高时 contentRelevance 高", () => {
    const relevant = scoreResult(
      makeResult({ title: "TypeScript Tutorial", snippet: "TypeScript programming basics" }),
      "typescript tutorial",
    );
    const irrelevant = scoreResult(
      makeResult({ title: "Cooking Recipe", snippet: "How to bake a cake" }),
      "typescript tutorial",
    );
    expect(relevant.contentRelevance).toBeGreaterThan(irrelevant.contentRelevance);
  });

  it("近期日期 timeliness 高", () => {
    const recent = scoreResult(makeResult({ date: new Date().toISOString().slice(0, 10) }), "q");
    const old = scoreResult(makeResult({ date: "2010-01-01" }), "q");
    expect(recent.timeliness).toBeGreaterThan(old.timeliness);
    expect(recent.timeliness).toBeGreaterThanOrEqual(0.9);
  });

  it("无日期时 timeliness 给中位分", () => {
    const score = scoreResult(makeResult({ date: undefined }), "q");
    expect(score.timeliness).toBe(0.5);
  });

  it("所有维度都在 [0, 1] 范围内", () => {
    const score = scoreResult(makeResult(), "test query");
    expect(score.sourceCredibility).toBeGreaterThanOrEqual(0);
    expect(score.sourceCredibility).toBeLessThanOrEqual(1);
    expect(score.contentRelevance).toBeGreaterThanOrEqual(0);
    expect(score.contentRelevance).toBeLessThanOrEqual(1);
    expect(score.timeliness).toBeGreaterThanOrEqual(0);
    expect(score.timeliness).toBeLessThanOrEqual(1);
    expect(score.factualAccuracy).toBeGreaterThanOrEqual(0);
    expect(score.factualAccuracy).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 3: data-extractor
// ═══════════════════════════════════════════════════════════════

describe("extractFacts", () => {
  it("抽取 'X 是 Y' 三元组", () => {
    const md = "TypeScript 是一种强类型的编程语言。";
    const facts = extractFacts(md, "https://example.com");
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].subject).toContain("TypeScript");
    expect(facts[0].object).toContain("编程语言");
    expect(facts[0].predicate).toBe("是");
    expect(facts[0].source).toBe("https://example.com");
    expect(facts[0].confidence).toBeGreaterThan(0);
  });

  it("抽取 'X is defined as Y' 三元组", () => {
    const md = "React is defined as a JavaScript library for building UIs.";
    const facts = extractFacts(md, "https://react.dev");
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].predicate).toBe("定义为");
    expect(facts[0].confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("抽取 markdown 链接 [text](url) 中的 text 作为内容", () => {
    const md = "[TypeScript](https://ts.lang) 是一种编程语言。";
    const facts = extractFacts(md, "https://example.com");
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].subject).toBe("TypeScript");
    expect(facts[0].subject).not.toContain("https");
  });

  it("抽取列表项 '- X: Y'", () => {
    const md = "- React: A UI library\n- Vue: Another framework";
    const facts = extractFacts(md, "https://example.com");
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts.some((f) => f.subject === "React")).toBe(true);
  });

  it("去重相同三元组", () => {
    const md = "TypeScript 是编程语言。TypeScript 是编程语言。TypeScript 是编程语言。";
    const facts = extractFacts(md, "https://example.com");
    expect(facts.length).toBe(1);
  });

  it("空 markdown 返回空数组", () => {
    expect(extractFacts("", "https://example.com")).toEqual([]);
    expect(extractFacts(null as never, "https://example.com")).toEqual([]);
  });

  it("空 source 返回空数组", () => {
    expect(extractFacts("Some content", "")).toEqual([]);
  });

  it("所有抽取结果通过 zod schema 校验", () => {
    const md = "TypeScript 是编程语言。React is defined as a UI library. - Vue: Progressive framework.";
    const facts = extractFacts(md, "https://example.com");
    for (const f of facts) {
      const parsed = ExtractedFactSchema.safeParse(f);
      expect(parsed.success).toBe(true);
    }
  });

  it("单文档最多抽取 30 条", () => {
    let md = "";
    for (let i = 0; i < 50; i++) {
      md += `Subject${i} is defined as object number ${i}.\n`;
    }
    const facts = extractFacts(md, "https://example.com");
    expect(facts.length).toBeLessThanOrEqual(30);
  });

  it("跳过过短句子（<5 字符）", () => {
    const md = "Hi. TypeScript 是编程语言。";
    const facts = extractFacts(md, "https://example.com");
    expect(facts.length).toBe(1);
    expect(facts[0].subject).toContain("TypeScript");
  });
});
