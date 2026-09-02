import { describe, expect, it } from "bun:test";
import { tokenize } from "../../src/self-evolve/engine.js";

describe("CJK whole-chunk tokenization (Chinese induction support)", () => {
  it("keeps CJK segments as whole chunks (no self-invented bigram pseudo-terms)", () => {
    const tokens = tokenize("如何优化 SQL 查询");
    expect(tokens).toContain("如何优化");
    expect(tokens).toContain("查询");
    expect(tokens).toContain("sql");
    expect(tokens).not.toContain("何优");
    expect(tokens).not.toContain("优化");
  });

  it("keeps CJK segment with single-char as whole chunk", () => {
    const tokens = tokenize("先处理 bug");
    expect(tokens).toContain("先处理");
    expect(tokens).toContain("bug");
    expect(tokens).not.toContain("先处");
    expect(tokens).not.toContain("处理");
  });

  it("produces shared chunks across similar Chinese traces (induction can fire)", () => {
    const t1 = tokenize("调用 API 遇到 429 限流");
    const t2 = tokenize("调用 API 超时导致失败");
    const common = t1.filter((t) => t2.includes(t));
    expect(common).toContain("调用");
  });

  it("keeps Latin runs intact in mixed CJK segments (no latin bigram fragmentation)", () => {
    // "redis缓存命中率" 按连续脚本切块：拉丁 "redis" 整词 + CJK "缓存命中率" 整块
    const tokens = tokenize("redis缓存命中率");
    expect(tokens).toContain("redis");
    expect(tokens).toContain("缓存命中率");
    expect(tokens).not.toContain("re");
    expect(tokens).not.toContain("s缓");
    expect(tokens).not.toContain("命中");
  });

  it("keeps leading latin and trailing CJK whole in a mixed segment", () => {
    const tokens = tokenize("sqlite查询次数超限");
    expect(tokens).toContain("sqlite");
    expect(tokens).toContain("查询次数超限");
    expect(tokens).not.toContain("q查");
    expect(tokens).not.toContain("次数");
  });
});
