import { describe, it, expect } from "bun:test";
import { tokenize, scoreMatch } from "../../src/dre/runtime/text-rank.js";

describe("text-rank 分词（步骤 1.2 切片 1）", () => {
  it("拉丁文本按非字母数字切分并小写化", () => {
    expect(tokenize("Deterministic Search")).toEqual(["deterministic", "search"]);
    expect(tokenize("foo-bar_baz.qux")).toEqual(["foo", "bar", "baz", "qux"]);
  });

  it("中文生成二元组（CJK 无空格可分，单字切分召回过低）", () => {
    expect(tokenize("确定性检索")).toEqual(["确定", "定性", "性检", "检索"]);
  });

  it("中英混排：两侧各自处理", () => {
    expect(tokenize("确定性 search 引擎")).toEqual([
      "确定", "定性", "search", "引擎",
    ]);
  });

  it("单个中文字符退化为其自身（避免完全丢失）", () => {
    expect(tokenize("好")).toEqual(["好"]);
  });

  it("空串 / 纯标点 / 空白 → 空数组", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("!!!，。、")).toEqual([]);
  });

  it("同一输入两次调用结果完全一致（确定性底线）", () => {
    const a = tokenize("确定性检索 deterministic search");
    const b = tokenize("确定性检索 deterministic search");
    expect(a).toEqual(b);
  });
});

describe("text-rank 打分（步骤 1.2 切片 2）", () => {
  const doc = "确定性检索引擎：Deterministic Search Engine";

  it("空格分隔的中文查询能命中连写内容（修复原 includes 的致命缺陷）", () => {
    // 原实现：content.includes("确定性 检索") === false → 0 结果
    expect(scoreMatch("确定性 检索", [doc])).toBeGreaterThan(0);
  });

  it("完全无关的查询得 0 分", () => {
    expect(scoreMatch("quantum chromodynamics", [doc])).toBe(0);
  });

  it("命中词更多 ⇒ 分数更高（有排序，而非插入顺序）", () => {
    const strong = scoreMatch("确定性检索", [doc]);
    const weak = scoreMatch("确定性", [doc]);
    expect(strong).toBeGreaterThan(weak);
  });

  it("多字段：命中更靠前的字段得分更高（字段权重）", () => {
    const inName = scoreMatch("检索", ["检索", "无关正文"]);
    const inBody = scoreMatch("检索", ["无关标题", "检索"]);
    expect(inName).toBeGreaterThan(inBody);
  });

  it("整串短语命中获得额外加权", () => {
    const phrase = scoreMatch("确定性检索", [doc]);
    const scattered = scoreMatch("确定性 引擎", [doc]);
    expect(phrase).toBeGreaterThan(scattered);
  });

  it("打分确定性：同输入同输出", () => {
    expect(scoreMatch("确定性 检索", [doc])).toBe(scoreMatch("确定性 检索", [doc]));
  });

  it("空查询或空文档 → 0 分（不抛错）", () => {
    expect(scoreMatch("", [doc])).toBe(0);
    expect(scoreMatch("x", [])).toBe(0);
    expect(scoreMatch("x", [""])).toBe(0);
  });
});
