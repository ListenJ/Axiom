/**
 * 金融采集的**源分级与拒绝表**（2026-10-07）
 *
 * 纯函数测试，零网络。锁住两条实测教训：
 * ① 聚合/跳转壳域名（news.google.com、bing.com/ck/a、文档分享站）绝不作为落库源
 *    —— 实测"中国货币政策执行报告"曾落到 Google News 跳转页，正文仅 517 字符；
 * ② 档位必须一手 > 二手 > 兜底，且同 URL 去重。
 */
import { describe, it, expect } from "bun:test";
import { rankCandidates, DENY_HOSTS } from "../../scripts/collect-finance-knowledge.js";

const r = (link: string) => ({ link });

describe("金融采集 · 源候选排序", () => {
  it("一手优先于二手、二手优先于兜底", () => {
    const out = rankCandidates(
      [r("https://random.example.com/a"), r("https://finance.eastmoney.com/b"), r("https://www.pbc.gov.cn/c")],
      ["pbc.gov.cn"],
      ["eastmoney.com"],
    );
    expect(out.map((c) => c.tier)).toEqual(["primary", "secondary", "fallback"]);
    expect(out[0].link).toContain("pbc.gov.cn");
  });

  it("聚合/跳转壳域名一律剔除", () => {
    const out = rankCandidates(
      [r("https://news.google.com/rss/articles/ABC"), r("https://www.bing.com/ck/a?x=1"), r("https://www.doc88.com/p-1.html"), r("https://www.pbc.gov.cn/ok")],
      ["pbc.gov.cn"],
      [],
    );
    expect(out.map((c) => c.link)).toEqual(["https://www.pbc.gov.cn/ok"]);
    for (const d of ["news.google.com", "bing.com", "doc88.com"]) expect(DENY_HOSTS).toContain(d);
  });

  it("同 URL 只出现一次（跨档位去重）", () => {
    const out = rankCandidates([r("https://www.pbc.gov.cn/x")], ["pbc.gov.cn"], ["pbc.gov.cn"]);
    expect(out.length).toBe(1);
    expect(out[0].tier).toBe("primary");
  });

  it("无效 URL 不抛错，落得下候选", () => {
    expect(() => rankCandidates([r("not-a-url"), r("https://ok.example.com/x")], [], [])).not.toThrow();
    expect(rankCandidates([r("not-a-url")], [], []).length).toBe(0);
  });
});
