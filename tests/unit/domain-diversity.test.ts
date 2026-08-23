/**
 * 搜索域名多样性回归测试（审计 L12b）
 *
 * 行为规格：
 * 1. 单域最多保留 maxPerDomain 条（按输入顺序保序），其余被裁剪。
 * 2. max<=0 或空数组直通；解析失败的主机名计入独立桶不误伤。
 * 3. 主机名大小写归一。
 */
import { describe, test, expect } from "bun:test";
import { enforceDomainDiversity } from "../../src/crawl/search-engines.js";

const mk = (i: number, host: string) => ({
  position: i,
  title: `t${i}`,
  link: `https://${host}/p/${i}`,
  displayedUrl: "",
  snippet: "s",
  source: host,
  engine: "ddg",
});

describe("enforceDomainDiversity（L12b 回归）", () => {
  test("单域最多保留 maxPerDomain 条", () => {
    const input = [
      ...Array.from({ length: 5 }, (_, i) => mk(i, "a.com")),
      mk(5, "b.com"),
      mk(6, "c.com"),
    ];
    const out = enforceDomainDiversity(input, 2);
    expect(out.map((r) => new URL(r.link).hostname)).toEqual(["a.com", "a.com", "b.com", "c.com"]);
  });

  test("max<=0 或空数组直通", () => {
    expect(enforceDomainDiversity([], 3)).toEqual([]);
    const one = [mk(0, "x.io")];
    expect(enforceDomainDiversity(one, 0)).toEqual(one);
  });

  test("主机名大小写归一；解析失败链接不崩溃", () => {
    const input = [
      { ...mk(0, ""), link: "HTTP://Shop.Example.COM/a" },
      mk(1, "shop.example.com"),
      { ...mk(2, ""), link: "::not-a-url::" },
    ];
    const out = enforceDomainDiversity(input, 1);
    // 大小写归一后第二条被裁；无法解析的进入 "" 独立桶保留
    expect(out).toHaveLength(2);
    expect(out.some((r) => r.link.includes("Example.COM"))).toBe(true);
    expect(out.some((r) => r.link.startsWith("::not-a-url"))).toBe(true);
  });
});
