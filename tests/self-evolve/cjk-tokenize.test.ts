import { describe, expect, it } from "bun:test";
import { tokenize } from "../../src/self-evolve/engine.js";

describe("CJK bigram tokenization (Chinese induction support)", () => {
  it("splits Chinese segments into bigrams", () => {
    const tokens = tokenize("如何优化 SQL 查询");
    expect(tokens).toContain("如何");
    expect(tokens).toContain("何优");
    expect(tokens).toContain("优化");
    expect(tokens).toContain("查询");
    expect(tokens).toContain("sql");
  });

  it("bigrams CJK segment with single-char folded into bigrams", () => {
    const tokens = tokenize("先处理 bug");
    expect(tokens).toContain("先处");
    expect(tokens).toContain("处理");
    expect(tokens).toContain("bug");
  });

  it("produces shared bigrams across similar Chinese traces (induction can fire)", () => {
    const t1 = tokenize("调用 API 遇到 429 限流");
    const t2 = tokenize("调用 API 超时导致失败");
    const common = t1.filter((t) => t2.includes(t));
    expect(common.length).toBeGreaterThan(0);
  });
});
