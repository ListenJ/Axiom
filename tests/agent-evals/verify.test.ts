import { describe, expect, it } from "bun:test";
import {
  ASSERTION_SPEC_KEYS,
  assertSpecErrors,
  compileAssertion,
  containsAll,
  containsAllAny,
  containsAny,
  extractJSON,
  extractLastNumber,
  hasJSONKeys,
  matchesAll,
  minLength,
  mustReturnNumber,
  notContains,
  outputLength,
} from "../../src/agent-evals/verify.js";

describe("verify helpers", () => {
  it("containsAll passes when all needles present", () => {
    expect(containsAll("Hello World Foo", ["hello", "world"]).passed).toBe(true);
    expect(containsAll("Hello World", ["foo"]).passed).toBe(false);
  });

  it("containsAny passes when at least one needle present", () => {
    expect(containsAny("a b", ["a", "z"]).passed).toBe(true);
    expect(containsAny("a b", ["x", "z"]).passed).toBe(false);
  });

  it("matchesAll applies regexes", () => {
    expect(matchesAll("fetch(url)", [/fetch/, /\(/]).passed).toBe(true);
    expect(matchesAll("fetch url", [/fetch/, /\(/]).passed).toBe(false);
  });

  it("notContains rejects banned text", () => {
    expect(notContains("safe answer", ["danger"]).passed).toBe(true);
    expect(notContains("this is danger", ["danger"]).passed).toBe(false);
  });

  it("extracts JSON from fenced code blocks", () => {
    const obj = extractJSON('\`\`\`json\n{"a": 1}\n\`\`\`');
    expect(obj).toEqual({ a: 1 });
  });

  it("hasJSONKeys checks required keys", () => {
    expect(hasJSONKeys('{"name":"x","age":1}', ["name", "age"]).passed).toBe(true);
    expect(hasJSONKeys('{"name":"x"}', ["age"]).passed).toBe(false);
    expect(hasJSONKeys("no json here", ["age"]).passed).toBe(false);
  });

  it("minLength rejects empty answers", () => {
    expect(minLength("   ", 5).passed).toBe(false);
    expect(minLength("hello world", 5).passed).toBe(true);
  });
});

/**
 * S5 验证器直测补齐 — 直测 S4 新增的 7 个导出。
 * 定位：与 assertion-validators（对抗性边界细节归属处）/ assertion-spec-guard
 * （index.ts 身份断言归属处）分层互补，此处每导出只测一个不同的语义支点。
 */
describe("S4 assertion layer (direct)", () => {
  it("containsAllAny: 每组任一命中即通过；有一组全不中即失败；大小写不敏感", () => {
    // 组内任一命中（首/末组各命中一个）
    expect(containsAllAny("先说 Hello 再做 World", [["HELLO"], ["WORLD"]]).passed).toBe(true);
    // 同义词组：每组任一命中即通过
    expect(containsAllAny("方案 A 可行", [["A", "B"], ["可行", "不可行"]]).passed).toBe(true);
    // 有一组全不中 → 失败
    const r = containsAllAny("只说了一个概念", [["甲", "乙"], ["丙", "丁"]]);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
    // 大小写不敏感
    expect(containsAllAny("Hello World", [["hello"], ["WORLD"]]).passed).toBe(true);
  });

  it("extractLastNumber: 取最后一个数字；无数字 → null；前导小数点边缘", () => {
    expect(extractLastNumber("先 3 步，后 5 步")).toBe(5);
    expect(extractLastNumber("全是文字")).toBeNull();
    // "0.5.5" → 两个 token "0.5" 与 ".5"? 按正则 /-?\d+(?:\.\d+)?/g 命中 "0.5"、"5"，取末 → 5
    expect(extractLastNumber("版本 0.5.5")).toBe(5);
  });

  it("mustReturnNumber: 无数字 fail；positive 时 0 判负 fail；区间含边界 pass", () => {
    expect(mustReturnNumber("无数字", { positive: true }).passed).toBe(false);
    const zero = mustReturnNumber("数值 0", { positive: true });
    expect(zero.passed).toBe(false);
    expect(zero.reason).toContain("非正");
    // 下界/上界含边界
    expect(mustReturnNumber("答案是 5", { min: 5, max: 5 }).passed).toBe(true);
    expect(mustReturnNumber("答案是 5", { min: 1, max: 10 }).passed).toBe(true);
  });

  it("outputLength: 只给 max 单界；min=max 精确长度；缺省侧不校验", () => {
    // 只给 max：无 min，过短不拦截
    expect(outputLength("短", { max: 100 }).passed).toBe(true);
    expect(outputLength("这段文字确实有点长超出了上限", { max: 5 }).passed).toBe(false);
    // min=max 精确长度
    expect(outputLength("12345", { min: 5, max: 5 }).passed).toBe(true);
    expect(outputLength("1234", { min: 5, max: 5 }).passed).toBe(false);
    // 缺省侧不校验（trim 后口径）
    expect(outputLength("   ", { max: 10 }).passed).toBe(true);
  });

  it("compileAssertion: 合法 spec → 通过闭包；畸形 spec → fail-closed 桩不 throw；短路顺序首败 reason", () => {
    const ok = compileAssertion({ containsAll: ["hello"], mustReturnNumber: { positive: true } });
    expect(ok("hello 答案是 3").passed).toBe(true);
    // 畸形（未知字段）→ 桩，不 throw
    const bad = compileAssertion({ bogus: true } as never);
    const badR = bad("任意输入");
    expect(badR.passed).toBe(false);
    expect(badR.reason).toContain("断言配置非法");
    // 短路顺序：mustReturnNumber 先于 containsAllAny（数值断言先行）
    const sc = compileAssertion({ containsAllAny: [["x"]], mustReturnNumber: { max: 1 } });
    // 无数字 → 应报 mustReturnNumber 侧而非 containsAllAny 侧
    const scR = sc("x 但没有数字");
    expect(scR.passed).toBe(false);
    expect(scR.reason).toContain("数字");
  });

  it("assertSpecErrors: 合法空数组；null/数组输入报错；min=max 允许", () => {
    expect(assertSpecErrors({ containsAll: ["a"], mustReturnNumber: { min: 1 } })).toEqual([]);
    // null 视为非法（S4 红队修复：不抛 TypeError）
    expect(assertSpecErrors({ mustReturnNumber: null } as never).length).toBeGreaterThan(0);
    expect(assertSpecErrors({ containsAll: [] }).length).toBeGreaterThan(0);
    // min=max 是合法 spec
    expect(assertSpecErrors({ outputLength: { min: 5, max: 5 } })).toEqual([]);
  });

  it("ASSERTION_SPEC_KEYS: 与断言接口字段一一对应", () => {
    expect(ASSERTION_SPEC_KEYS).toContain("containsAll");
    expect(ASSERTION_SPEC_KEYS).toContain("containsAny");
    expect(ASSERTION_SPEC_KEYS).toContain("containsAllAny");
    expect(ASSERTION_SPEC_KEYS).toContain("notContains");
    expect(ASSERTION_SPEC_KEYS).toContain("matchesAll");
    expect(ASSERTION_SPEC_KEYS).toContain("hasJSONKeys");
    expect(ASSERTION_SPEC_KEYS).toContain("outputLength");
    expect(ASSERTION_SPEC_KEYS).toContain("mustReturnNumber");
    // 长度 8，无额外键
    expect(ASSERTION_SPEC_KEYS).toHaveLength(8);
  });
});
