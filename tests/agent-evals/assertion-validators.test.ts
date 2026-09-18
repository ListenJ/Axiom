/**
 * S4 断言验证器 — 测试先行（红）。
 * 覆盖：
 *  1. extractLastNumber 末数字/小数/负数/无数字解析
 *  2. mustReturnNumber 无数字 / positive 违反 / 越界 / 区间通过
 *  3. outputLength min/max/双界（对齐 minLength 同口径）
 *  4. compileAssertion 合法编译 / 畸形 fail-closed 桩 / AND 短路顺序 / 空 spec
 *  5. assertSpecErrors 良构校验（未知字段/空数组/非法范围/正则可编译）
 */
import { describe, expect, it } from "bun:test";
import {
  assertSpecErrors,
  compileAssertion,
  extractLastNumber,
  mustReturnNumber,
  outputLength,
} from "../../src/agent-evals/verify.js";

// ===== extractLastNumber =====
describe("extractLastNumber", () => {
  it("提取末尾整数", () => {
    expect(extractLastNumber("因此结果是 3")).toBe(3);
  });
  it("提取末尾小数", () => {
    expect(extractLastNumber("0.1 + 0.2 = 0.30000000000000004")).toBe(0.30000000000000004);
  });
  it("提取负数", () => {
    expect(extractLastNumber("温度是 -1.2 度")).toBe(-1.2);
  });
  it("无数字返回 null", () => {
    expect(extractLastNumber("没有数字内容")).toBeNull();
  });
  it("多数字时取最后一个", () => {
    expect(extractLastNumber("推理用了 2 个步骤，答案是 42")).toBe(42);
  });
});

// ===== mustReturnNumber =====
describe("mustReturnNumber", () => {
  it("无数字时失败，reason 不含 [ERROR] 前缀", () => {
    const r = mustReturnNumber("我不知道", { positive: true });
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.reason!.startsWith("[ERROR] ")).toBe(false);
  });
  it("positive 违反时失败", () => {
    expect(mustReturnNumber("成本是 -5 元", { positive: true }).passed).toBe(false);
  });
  it("越界失败", () => {
    expect(mustReturnNumber("结果是 7", { min: 1, max: 5 }).passed).toBe(false);
  });
  it("区间内通过", () => {
    expect(mustReturnNumber("结果是 3.5", { min: 2, max: 4 }).passed).toBe(true);
  });
  it("下界命中通过（含边界）", () => {
    expect(mustReturnNumber("结果是 5", { min: 5 }).passed).toBe(true);
  });
});

// ===== outputLength =====
describe("outputLength", () => {
  it("min 越界失败（文案与 minLength 一致）", () => {
    expect(outputLength("  短  ", { min: 10 }).passed).toBe(false);
  });
  it("max 越界失败", () => {
    expect(outputLength("这句话太长了不适合限制", { max: 5 }).passed).toBe(false);
  });
  it("双界内通过", () => {
    const text = "长度合适的一句话";
    expect(outputLength(text, { min: 3, max: 20 }).passed).toBe(true);
  });
  it("trim 后长度与 minLength 同口径", () => {
    expect(outputLength("hello", { min: 5 }).passed).toBe(true);
    expect(outputLength("  ", { min: 5 }).passed).toBe(false);
  });
});

// ===== compileAssertion =====
describe("compileAssertion", () => {
  it("legal spec 编译出通过的闭包", () => {
    const v = compileAssertion({ containsAll: ["hello"], mustReturnNumber: { positive: true } });
    expect(v("答案是 3 hello world").passed).toBe(true);
  });
  it("AND 组合：任一字段失败即失败", () => {
    const v = compileAssertion({ containsAll: ["hello"], mustReturnNumber: { positive: true } });
    expect(v("答案是 3 无关键词").passed).toBe(false);
    expect(v("hello 但没有数字").passed).toBe(false);
  });
  it("畸形 spec（未知字段）→ fail-closed 桩，不 throw", () => {
    const v = compileAssertion({ bogus: true } as never);
    const r = v("any");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("断言配置非法");
  });
  it("空 spec → fail-closed 桩", () => {
    const v = compileAssertion({});
    expect(v("any").passed).toBe(false);
  });
  it("matchesAll 字符串编译为正则（不带 g flag）", () => {
    const v = compileAssertion({ matchesAll: ["^\\d+\\.\\s+"] });
    expect(v("1. 第一步\n2. 第二步").passed).toBe(true);
    expect(v("第一步\n第二步").passed).toBe(false);
  });
  it("短路顺序：mustReturnNumber 先于 containsAllAny", () => {
    const v = compileAssertion({ containsAllAny: [["x"]], mustReturnNumber: { max: 1 } });
    // 无数字 → 应报未找到数字（mustReturnNumber 优先）
    const r = v("x 但无数字");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("数字");
  });
});

// ===== assertSpecErrors =====
describe("assertSpecErrors", () => {
  it("合法 spec 返回空数组", () => {
    expect(assertSpecErrors({ containsAll: ["a"], mustReturnNumber: { min: 1 } })).toEqual([]);
  });
  it("未知顶层字段拒绝", () => {
    const errs = assertSpecErrors({ nope: [1] } as never);
    expect(errs.some((e) => e.includes("未知字段"))).toBe(true);
  });
  it("关键字空数组拒绝", () => {
    const errs = assertSpecErrors({ containsAll: [] });
    expect(errs.length).toBeGreaterThan(0);
  });
  it("min > max 拒绝", () => {
    const errs = assertSpecErrors({ mustReturnNumber: { min: 5, max: 1 } });
    expect(errs.some((e) => e.includes("min") || e.includes("max"))).toBe(true);
  });
  it("outputLength.min 负值拒绝", () => {
    const errs = assertSpecErrors({ outputLength: { min: -1 } });
    expect(errs.length).toBeGreaterThan(0);
  });
  it("outputLength 至少一个界", () => {
    const errs = assertSpecErrors({ outputLength: {} });
    expect(errs.length).toBeGreaterThan(0);
  });
  it("mustReturnNumber 至少一个约束", () => {
    const errs = assertSpecErrors({ mustReturnNumber: {} });
    expect(errs.length).toBeGreaterThan(0);
  });
  it("非法正则源码拒绝", () => {
    const errs = assertSpecErrors({ matchesAll: ["("] });
    expect(errs.some((e) => e.includes("无法编译") || e.includes("正则"))).toBe(true);
  });
  it("合理正则源码通过", () => {
    expect(assertSpecErrors({ matchesAll: ["^\\d+\\."] })).toEqual([]);
  });
});