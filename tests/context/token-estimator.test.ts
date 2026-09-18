import { describe, it, expect } from "bun:test";
import { estimateTokens, estimateMessageTokens } from "../../src/context/token-estimator.js";

// 审计整改 R1（2026-08-24）：原文件仅 1 行 import、零用例（空壳）。
// 现按公共接口补齐真实行为测试。
describe("estimateTokens", () => {
  it("空字符串返回 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("CJK 按 1.5 字符/token 计", () => {
    expect(estimateTokens("一二三四五六")).toBe(4); // 6/1.5
  });

  it("拉丁按 4 字符/token 计", () => {
    expect(estimateTokens("abcdefgh")).toBe(2); // 8/4
  });

  it("混合文本分段累计并向上取整", () => {
    // 3 CJK → ceil(2)=2；4 latin → 1；合计 3
    expect(estimateTokens("一二三abcd")).toBe(3);
  });

  it("非整除时向上取整", () => {
    // 2/1.5 ≈ 1.33 → ceil = 2
    expect(estimateTokens("一二")).toBe(2);
  });
});

describe("estimateMessageTokens", () => {
  it("在内容 token 之上加 4 的消息开销", () => {
    const content = "abcdefgh"; // 2 tokens
    expect(estimateMessageTokens({ content })).toBe(6);
  });

  it("空消息仍计 4 开销", () => {
    expect(estimateMessageTokens({ content: "" })).toBe(4);
  });
});
