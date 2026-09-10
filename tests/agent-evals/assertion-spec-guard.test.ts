/**
 * S4 红队测试 — 对抗性边界挑战 src/agent-evals/verify.ts 主线程实现。
 *
 * 立场：本文件只断言 verify.ts 的现有行为，**不改实现**。发现实现 bug 时用
 * `// TODO(主线程修): ...` 标注用例（不跳过、不放宽），在回报里单独列出。
 * 输入一律由本文件自行设计；期望值来自对实现的实际探针观测。
 *
 * 覆盖：
 *  1. extractLastNumber 边界（正则 /-?\d+(?:\.\d+)?/ 的已知拆分限制）
 *  2. mustReturnNumber 边界（精确零区间 / positive:false 不过滤 / 小数界文案 / 巨大数）
 *  3. outputLength 边界（min=max 精确长度 / 单界 / trim 语义 / min=0 / 大上限）
 *  4. compileAssertion 边界（8 字段齐发 AND 与短路顺序 / 单字段 / 多正则 / 分组交互 / fail-closed）
 *  5. assertSpecErrors 边界（null/undefined/数组穿入 / 0 与 false 不误报 / 嵌套未知字段 / min=max / 空前缀正则）
 *  6. ASSERTION_SPEC_KEYS 与 AssertionSpec 接口字段一一对应
 *  7. 幂等性与 fail-closed 桩的全输入失败保证
 */
import { describe, expect, it } from "bun:test";
import {
  ASSERTION_SPEC_KEYS,
  assertSpecErrors,
  compileAssertion,
  extractLastNumber,
  mustReturnNumber,
  outputLength,
} from "../../src/agent-evals/verify.js";
import {
  ASSERTION_SPEC_KEYS as INDEX_KEYS,
  assertSpecErrors as INDEX_ASSERT_SPEC_ERRORS,
  compileAssertion as INDEX_COMPILE,
} from "../../src/agent-evals/index.js";

// 辅助：断言 reason 前缀，避免与具体文案漂移而误伤（仅对稳定前缀使用）
const hasPrefix = (r: { passed: boolean; reason?: string }, p: string) => r.passed === false && r.reason?.startsWith(p);

// ===== 1. extractLastNumber =====
describe("extractLastNumber 边界", () => {
  it("只有 + 号数字：`+` 不是数字字符，按正整数提取", () => {
    // 正则不含可选 `+`，故 "+5" → "5"
    expect(extractLastNumber("答案 +5 元")).toBe(5);
  });

  it("多数字取末尾数字", () => {
    expect(extractLastNumber("2 4 6")).toBe(6);
  });

  it("科学计数法 1e5 → 5（已知限制：正则不支持 e 记数，1e5 被拆成 1 与 5，取末=5）", () => {
    expect(extractLastNumber("1e5")).toBe(5);
  });

  it("NaN 文本 → null（无数字字符）", () => {
    expect(extractLastNumber("NaN")).toBeNull();
  });

  it("Infinity 文本 → null（无数字字符）", () => {
    expect(extractLastNumber("Infinity")).toBeNull();
  });

  it("纯 0 → 0（返回 0 而非 null）", () => {
    expect(extractLastNumber("0")).toBe(0);
  });

  it("纯小数 .5 → 5（已知限制：正则不认前导小数点，`.5` 只匹配到 `5`，小数点被丢弃）", () => {
    expect(extractLastNumber(".5")).toBe(5);
  });

  it("千分位 4,096 → 96（已知限制：逗号分隔成 `4` 与 `096`，取末=96；语义错误但可复现）", () => {
    expect(extractLastNumber("4,096")).toBe(96);
  });

  it("空串 → null", () => {
    expect(extractLastNumber("")).toBeNull();
  });

  it("仅负号 `-` → null（无后继数字，负号单独不匹配）", () => {
    expect(extractLastNumber("-")).toBeNull();
  });

  it("负号紧贴数字 → 保留符号（`-5` 完整匹配）", () => {
    expect(extractLastNumber("-5")).toBe(-5);
  });

  it("十六进制 0x10 → 10（已知限制：`0x` 被吞掉，只取 `10`）", () => {
    expect(extractLastNumber("abc 0x10")).toBe(10);
  });

  it("带空白包裹的数字仍能提取", () => {
    expect(extractLastNumber(" 42 ")).toBe(42);
  });

  it("下划线分隔 1_000 → 0（已知限制：`1_000` 被拆成 `1` 与 `000`，取末=0）", () => {
    expect(extractLastNumber("1_000")).toBe(0);
  });
});

// ===== 2. mustReturnNumber =====
describe("mustReturnNumber 边界", () => {
  it("{ min: 0, max: 0 } 精确零区间：值 0 通过", () => {
    expect(mustReturnNumber("结果是 0", { min: 0, max: 0 })).toEqual({ passed: true });
  });

  it("{ min: 0, max: 0 } 精确零区间：值 5 越界", () => {
    expect(mustReturnNumber("结果是 5", { min: 0, max: 0 }).passed).toBe(false);
  });

  it("positive: false 不过滤：负数与正数均通过", () => {
    expect(mustReturnNumber("成本是 -3 元", { positive: false }).passed).toBe(true);
    expect(mustReturnNumber("成本是 5 元", { positive: false }).passed).toBe(true);
  });

  it("positive: false 时仍会因提取不到数字而失败", () => {
    expect(hasPrefix(mustReturnNumber("完全没有数字", { positive: false }), "未找到数字")).toBe(true);
  });

  it("min/max 均缺 + positive: true：仅约束正性，大值通过", () => {
    expect(mustReturnNumber("结果是 1000000", { positive: true }).passed).toBe(true);
  });

  it("min/max 均缺 + positive: true：0 判为非正（应 > 0）", () => {
    const r = mustReturnNumber("结果是 0", { positive: true });
    expect(hasPrefix(r, "数值非正")).toBe(true);
    expect(r.reason).toContain("应 > 0");
  });

  it("min/max 均缺 + positive: false：退化为仅要求存在数字", () => {
    expect(mustReturnNumber("结果是 -100", { positive: false })).toEqual({ passed: true });
  });

  it("小数下界越界文案保留小数点与 -∞ 占位", () => {
    const r = mustReturnNumber("结果是 7", { max: 0.5 });
    expect(hasPrefix(r, "数值越界")).toBe(true);
    expect(r.reason).toContain("不在 [-∞, 0.5] 区间内");
  });

  it("小数上界命中不越界（含边界）", () => {
    expect(mustReturnNumber("结果是 7", { min: 0.5 })).toEqual({ passed: true });
  });

  it("提取到巨大数 9999999999999999 仍在有限区间内通过", () => {
    expect(mustReturnNumber("9999999999999999", { min: 0, max: 1e16 })).toEqual({ passed: true });
  });

  it("空 opts（{}）仍可调用：仅有数字即通过（编译期才拦截空约束）", () => {
    expect(mustReturnNumber("答案是 5", {})).toEqual({ passed: true });
  });
});

// ===== 3. outputLength =====
describe("outputLength 边界", () => {
  it("min 与 max 相等 = 精确长度：命中通过", () => {
    expect(outputLength("hello", { min: 5, max: 5 })).toEqual({ passed: true });
  });

  it("min 与 max 相等 = 精确长度：偏长时报「响应过长」", () => {
    const r = outputLength("hello", { min: 4, max: 4 });
    expect(hasPrefix(r, "响应过长")).toBe(true);
    expect(r.reason).toContain("5 > 4");
  });

  it("min 与 max 相等 = 精确长度：偏短时报「响应过短」", () => {
    const r = outputLength("he", { min: 5, max: 5 });
    expect(hasPrefix(r, "响应过短")).toBe(true);
    expect(r.reason).toContain("2 < 5");
  });

  it("只给 max：未超长通过", () => {
    expect(outputLength("hi", { max: 3 })).toEqual({ passed: true });
  });

  it("只给 max：超长失败", () => {
    expect(hasPrefix(outputLength("toolong", { max: 3 }), "响应过长")).toBe(true);
  });

  it("trim 语义：首尾空白不计入长度", () => {
    expect(outputLength("  hello  ", { min: 5, max: 5 })).toEqual({ passed: true });
  });

  it("trim 语义：中间空白计入长度", () => {
    expect(outputLength("a b", { min: 3, max: 3 })).toEqual({ passed: true });
  });

  it("trim 语义：换行计入长度", () => {
    expect(outputLength("a\nb", { min: 3, max: 3 })).toEqual({ passed: true });
  });

  it("trim 语义：纯空白经 trim 后长度为 0", () => {
    const r = outputLength("   \n\t  ", { min: 1 });
    expect(hasPrefix(r, "响应过短")).toBe(true);
    expect(r.reason).toContain("0 < 1");
  });

  it("min: 0 合法：空白串（trim 后 0）通过", () => {
    expect(outputLength("   ", { min: 0 })).toEqual({ passed: true });
  });

  it("大上限（1_000_000）不触发溢出与误判", () => {
    expect(outputLength("hi", { max: 1_000_000 })).toEqual({ passed: true });
  });

  it("只给 min：足够长通过", () => {
    expect(outputLength("this is long enough", { min: 3 })).toEqual({ passed: true });
  });
});

// ===== 4. compileAssertion =====
describe("compileAssertion 边界", () => {
  it("8 字段齐发（AND）：任一字段命中即整体通过", () => {
    const v = compileAssertion({
      containsAll: ["ok"],
      containsAny: ["ok"],
      containsAllAny: [["ok"]],
      notContains: ["zzz"],
      matchesAll: ["ok"],
      hasJSONKeys: ["ok"],
      outputLength: { min: 1, max: 40 },
      mustReturnNumber: { positive: true },
    });
    expect(v('{"ok": 1}')).toEqual({ passed: true });
  });

  it("8 字段齐发（AND）：mustReturnNumber 排第一，无数字时短路于它", () => {
    const v = compileAssertion({
      containsAll: ["zzz"],
      containsAny: ["zzz"],
      containsAllAny: [["zzz"]],
      notContains: ["ok"],
      matchesAll: ["zzz"],
      hasJSONKeys: ["zzz"],
      outputLength: { min: 100 },
      mustReturnNumber: { positive: true },
    });
    expect(hasPrefix(v("ok"), "未找到数字")).toBe(true);
  });

  it("短路顺序：mustReturnNumber → containsAllAny → containsAll → containsAny → notContains → matchesAll → hasJSONKeys → outputLength", () => {
    const v = compileAssertion({
      containsAll: ["zzz"],
      containsAllAny: [["zzz"]],
      mustReturnNumber: { max: 1 },
    });
    // 无数字 → 先于 containsAllAny 报未找到数字
    expect(hasPrefix(v("无数字"), "未找到数字")).toBe(true);
  });

  it("短路顺序：containsAllAny 先于 containsAll", () => {
    const v = compileAssertion({ containsAll: ["zzz"], containsAllAny: [["zzz"]] });
    const r = v("无关键词");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });

  it("短路顺序：containsAll 先于 containsAny", () => {
    const v = compileAssertion({ containsAll: ["zzz"], containsAny: ["zzz"] });
    const r = v("无关键词");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少关键内容");
  });

  it("短路顺序：notContains 先于 matchesAll", () => {
    const v = compileAssertion({ notContains: ["危险"], matchesAll: ["zzz"] });
    const r = v("这里有危险指令");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("不应出现");
  });

  it("短路顺序：hasJSONKeys 先于 outputLength", () => {
    const v = compileAssertion({ hasJSONKeys: ["zzz"], outputLength: { min: 1000 } });
    const r = v("{}");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("JSON 缺少键");
  });

  it("短路顺序：matchesAll 先于 hasJSONKeys", () => {
    const v = compileAssertion({ matchesAll: ["zzz"], hasJSONKeys: ["zzz"] });
    const r = v("{}", );
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未匹配模式");
  });

  it("matchesAll 多正则：全部匹配才通过", () => {
    const v = compileAssertion({ matchesAll: ["^hello", "world$"] });
    expect(v("hello world").passed).toBe(true);
  });

  it("matchesAll 多正则：失败 reason 列出所有未命中模式", () => {
    const r = compileAssertion({ matchesAll: ["^hello", "world$"] })("goodbye");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("/^hello/");
    expect(r.reason).toContain("/world$/");
  });

  it("matchesAll 多正则：失败 reason 只列未命中项（已命中项不复述）", () => {
    const r = compileAssertion({ matchesAll: ["^a", "^z"] })("a");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("/^z/");
    expect((r.reason ?? "").includes("/^a/")).toBe(false);
  });

  it("containsAllAny 多组：每组任一命中即通过", () => {
    const v = compileAssertion({ containsAllAny: [["foo", "bar"], ["x", "y"]] });
    expect(v("foo y").passed).toBe(true);
  });

  it("containsAllAny 多组：仅一组未命中即失败，reason 只点出该组", () => {
    const r = compileAssertion({ containsAllAny: [["foo", "bar"], ["x", "y"]] })("foo");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("x/y");
    expect((r.reason ?? "").includes("foo/bar")).toBe(false);
  });

  it("containsAllAny 与 containsAll 大小写不敏感", () => {
    const v = compileAssertion({ containsAll: ["Hello"], containsAllAny: [["WORLD"]] });
    expect(v("hello world").passed).toBe(true);
  });

  it("notContains 命中即失败（大小写不敏感匹配，reason 回显配置原值）", () => {
    const r = compileAssertion({ notContains: ["SECRET"] })("包含 secret 泄露");
    expect(r.passed).toBe(false);
    // 匹配走 toLowerCase 比对，但 reason 回显 banned 配置原样（含大写）——现状记录
    expect(r.reason).toContain("SECRET");
    // 反向验证大小写不敏感：banned 配置为小写，命中文本中的大写
    expect(compileAssertion({ notContains: ["secret"] })("包含 SECRET 泄露").passed).toBe(false);
  });

  it("only mustReturnNumber 单字段：合法编译且行为正确", () => {
    const v = compileAssertion({ mustReturnNumber: { min: 1, max: 9 } });
    expect(v("结果是 5").passed).toBe(true);
    expect(v("结果是 50").passed).toBe(false);
    expect(v("无数字").passed).toBe(false);
  });

  it("only outputLength 单字段：合法编译且行为正确", () => {
    const v = compileAssertion({ outputLength: { min: 3, max: 3 } });
    expect(v("abc").passed).toBe(true);
    expect(v("ab").passed).toBe(false);
  });

  it("畸形 spec（未知顶层字段）→ fail-closed 桩，reason 以「断言配置非法」开头且不 throw", () => {
    const v = compileAssertion({ bogus: true } as never);
    const r = v("any input");
    expect(r.passed).toBe(false);
    expect(r.reason?.startsWith("断言配置非法")).toBe(true);
  });

  it("畸形 spec（min > max）→ fail-closed 桩，reason 带上限比较错误", () => {
    const r = compileAssertion({ mustReturnNumber: { min: 5, max: 1 } })("3");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("断言配置非法");
    expect(r.reason).toContain("min(5) > max(1)");
  });

  it("空 spec → fail-closed 桩", () => {
    const r = compileAssertion({})("x");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("assert 为空");
  });

  it("fail-closed 桩对任何输入都失败（含空串与 undefined）", () => {
    const v = compileAssertion({ bogus: true } as never);
    for (const input of ["", "hello", undefined]) {
      const r = v(input as string);
      expect(r.passed).toBe(false);
      expect(r.reason).toContain("断言配置非法");
    }
  });

  it("matchesAll 字符串编译为无 flag 正则：`g` 状态不泄漏到跨调用", () => {
    const v = compileAssertion({ matchesAll: ["^\\d+"] });
    expect(v("1. 第一步").passed).toBe(true);
    expect(v("1. 第二步").passed).toBe(true);
    expect(v("第一步").passed).toBe(false);
  });
});

// ===== 5. assertSpecErrors =====
describe("assertSpecErrors 边界", () => {
  it("null 穿入 → 友好报错（不 throw）", () => {
    expect(assertSpecErrors(null as never)).toEqual(["assert 必须是对象"]);
  });

  it("undefined 穿入 → 友好报错（不 throw）", () => {
    expect(assertSpecErrors(undefined as never)).toEqual(["assert 必须是对象"]);
  });

  it("数组穿入 → 友好报错（不 throw）", () => {
    expect(assertSpecErrors([1, 2] as never)).toEqual(["assert 必须是对象"]);
  });

  it("字符串穿入 → 友好报错（不 throw）", () => {
    expect(assertSpecErrors("containsAll" as never)).toEqual(["assert 必须是对象"]);
  });

  it("布尔穿入 → 友好报错（不 throw）", () => {
    expect(assertSpecErrors(true as never)).toEqual(["assert 必须是对象"]);
  });

  it("字段值 0 不被当作空值误报（0 不是非空数组，仍按类型校验报错而非崩溃）", () => {
    const errs = assertSpecErrors({ containsAll: 0 as never });
    expect(errs).toEqual(["assert.containsAll 必须是非空数组"]);
  });

  it("字段值 false 不被当作空值误报（布尔不是数组，按类型校验）", () => {
    const errs = assertSpecErrors({ containsAny: false as never });
    expect(errs).toEqual(["assert.containsAny 必须是非空数组"]);
  });

  it("字段值为 0 的嵌套数字：outputLength.min = 0 合法（0 不是负）", () => {
    expect(assertSpecErrors({ outputLength: { min: 0 } })).toEqual([]);
  });

  it("outputLength.min = 0 且 max = 0 合法", () => {
    expect(assertSpecErrors({ outputLength: { min: 0, max: 0 } })).toEqual([]);
  });

  it("mustReturnNumber.positive = false 合法（false 也是显式约束，非空对象）", () => {
    expect(assertSpecErrors({ mustReturnNumber: { positive: false } })).toEqual([]);
  });

  it("mustReturnNumber 仅 positive 且为 true 合法", () => {
    expect(assertSpecErrors({ mustReturnNumber: { positive: true } })).toEqual([]);
  });

  it("嵌套对象 outputLength 未知字段报错", () => {
    expect(assertSpecErrors({ outputLength: { min: 1, weird: 2 } as never })).toEqual([
      "assert.outputLength 含未知字段: weird",
    ]);
  });

  it("嵌套对象 mustReturnNumber 未知字段报错", () => {
    expect(assertSpecErrors({ mustReturnNumber: { min: 1, weird: 2 } as never })).toEqual([
      "assert.mustReturnNumber 含未知字段: weird",
    ]);
  });

  it("min = max 合法（不是 min > max）", () => {
    expect(assertSpecErrors({ mustReturnNumber: { min: 5, max: 5 } })).toEqual([]);
    expect(assertSpecErrors({ outputLength: { min: 5, max: 5 } })).toEqual([]);
  });

  it("min > max 非法：精确报错含两侧数值", () => {
    expect(assertSpecErrors({ mustReturnNumber: { min: 0, max: -1 } })).toEqual([
      "assert.mustReturnNumber min(0) > max(-1)",
    ]);
  });

  it("min > max 非法：outputLength 只报 min>max 一条（max 负值本身不单独报错，与 minLength 同口径）", () => {
    const errs = assertSpecErrors({ outputLength: { min: 5, max: -1 } });
    expect(errs).toEqual(["assert.outputLength min(5) > max(-1)"]);
  });

  it("matchesAll: [''] → 正则 `''` 可编译，但被「非空关键字」规则拒绝（fail-closed 而非崩溃）", () => {
    // strArr 的非空检查先于正则编译检查，故空 pattern 永远进不到运行时；
    // 这里锁定该优先级与 fail-closed 表现，避免日后误改成正则层拦截。
    expect(assertSpecErrors({ matchesAll: [""] })).toEqual(["assert.matchesAll 含空关键字"]);
    const r = compileAssertion({ matchesAll: [""] })("任何文本");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("断言配置非法");
  });

  it("matchesAll 中的 `]` 可单独编译（单右方括号不是非法正则）", () => {
    expect(assertSpecErrors({ matchesAll: ["]"] })).toEqual([]);
    expect(compileAssertion({ matchesAll: ["]"] })("x]y")).toEqual({ passed: true });
  });

  it("containsAllAny 非数组 → 报错", () => {
    expect(assertSpecErrors({ containsAllAny: "x" as never })).toEqual([
      "assert.containsAllAny 必须是非空分组数组",
    ]);
  });

  it("containsAllAny 空分组 → 报错", () => {
    expect(assertSpecErrors({ containsAllAny: [[]] })).toEqual(["assert.containsAllAny 含空分组"]);
  });

  it("containsAllAny 组内空串 → 报错", () => {
    expect(assertSpecErrors({ containsAllAny: [[""]] })).toEqual(["assert.containsAllAny 含空分组"]);
  });

  it("空 spec 对象 → 报错且为唯一错误", () => {
    expect(assertSpecErrors({})).toEqual(["assert 为空（至少设置一个断言字段）"]);
  });

  it("多个未知顶层字段各自成一条错误（按 Object.keys 顺序）", () => {
    expect(assertSpecErrors({ a: 1, b: 2 } as never)).toEqual([
      "assert 包含未知字段: a",
      "assert 包含未知字段: b",
    ]);
  });

  it("多个空数组字段各自成一条错误（累积而非短路）", () => {
    expect(assertSpecErrors({ containsAll: [], containsAny: [] })).toEqual([
      "assert.containsAll 必须是非空数组",
      "assert.containsAny 必须是非空数组",
    ]);
  });

  it("mustReturnNumber.positive 非布尔 → 报错", () => {
    expect(assertSpecErrors({ mustReturnNumber: { positive: "yes" as never } })).toEqual([
      "assert.mustReturnNumber.positive 必须是布尔",
    ]);
  });

  it("outputLength.min 为 NaN → 报「必须是有限数字」", () => {
    expect(assertSpecErrors({ outputLength: { min: NaN } })).toEqual([
      "assert.outputLength.min 必须是有限数字",
    ]);
  });

  it("outputLength 为数组 → 报「必须是对象」", () => {
    expect(assertSpecErrors({ outputLength: [1] as never })).toEqual(["assert.outputLength 必须是对象"]);
  });

  it("mustReturnNumber 为 null → 实现按类型守卫走「必须是对象」分支，不崩溃", () => {
    // null 的 typeof 是 "object" 且非数组，会落进对象分支；此处仅记录现状。
    // TODO(主线程修): assertSpecErrors({ mustReturnNumber: null }) 在 verify.ts:216 抛
    // `TypeError: null is not an object (evaluating 'Object.keys(spec.mustReturnNumber)')`。
    // 期望与 outputLength 对称地返回 ["assert.mustReturnNumber 必须是对象"]（outputLength 分支
    // 对 null 是安全的，mustReturnNumber 分支缺一个 null 守卫）。当前以本断言捕获崩溃，
    // 实现修复（加入 null 检查）后即自动转绿；不要为此放宽或 skip 本用例。
    expect(assertSpecErrors({ mustReturnNumber: null as never })).toEqual([
      "assert.mustReturnNumber 必须是对象",
    ]);
  });
});

// ===== 6. ASSERTION_SPEC_KEYS 完整性 =====
describe("ASSERTION_SPEC_KEYS 完整性", () => {
  const EXPECTED_KEYS = [
    "containsAll",
    "containsAny",
    "containsAllAny",
    "notContains",
    "matchesAll",
    "hasJSONKeys",
    "outputLength",
    "mustReturnNumber",
  ];

  it("数组内容等于 AssertionSpec 接口字段的期望字面量（顺序敏感，与短路线性一致）", () => {
    expect([...ASSERTION_SPEC_KEYS]).toEqual(EXPECTED_KEYS);
  });

  it("长度 = 8，与 AssertionSpec 的 8 个可选字段一一对应", () => {
    expect(ASSERTION_SPEC_KEYS.length).toBe(8);
    expect(EXPECTED_KEYS.length).toBe(8);
  });

  it("无重复项（每个合法字段只出现一次）", () => {
    expect(new Set(ASSERTION_SPEC_KEYS).size).toBe(ASSERTION_SPEC_KEYS.length);
  });

  it("index.ts 再导出的集合与 verify.ts 完全一致（同一引用，不产生漂移）", () => {
    expect(INDEX_KEYS).toBe(ASSERTION_SPEC_KEYS);
    expect([...INDEX_KEYS]).toEqual(EXPECTED_KEYS);
  });

  it("每个 key 都是断言配置非空时的合法字段（单字段 spec 零错误）", () => {
    const LEGAL_VALUES: Record<string, unknown> = {
      containsAll: ["a"],
      containsAny: ["a"],
      containsAllAny: [["a"]],
      notContains: ["a"],
      matchesAll: ["a"],
      hasJSONKeys: ["a"],
      outputLength: { min: 1 },
      mustReturnNumber: { min: 1 },
    };
    for (const k of ASSERTION_SPEC_KEYS) {
      expect(assertSpecErrors({ [k]: LEGAL_VALUES[k] } as never), k).toEqual([]);
    }
  });

  it("每个 key 之外都报未知字段（正交性）", () => {
    for (const k of EXPECTED_KEYS) {
      const probe = `_${k}`;
      const errs = assertSpecErrors({ [probe]: [] } as never);
      expect(errs.some((e) => e.includes(probe)), probe).toBe(true);
    }
  });

  it("index.ts 与 verify.ts 的函数行为一致（compileAssertion 同一实现）", () => {
    const a = INDEX_COMPILE({ containsAll: ["hi"], mustReturnNumber: { positive: true } })("hi 3");
    const b = compileAssertion({ containsAll: ["hi"], mustReturnNumber: { positive: true } })("hi 3");
    expect(a).toEqual(b);
    expect(INDEX_ASSERT_SPEC_ERRORS({ bogus: 1 } as never)).toEqual(assertSpecErrors({ bogus: 1 } as never));
  });
});

// ===== 7. 幂等性 =====
describe("幂等性", () => {
  it("合法 spec 编译后多次调用同输入结果完全一致", () => {
    const v = compileAssertion({ containsAll: ["hi"], outputLength: { min: 1, max: 20 } });
    const r1 = v("hi there");
    const r2 = v("hi there");
    const r3 = v("hi there");
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
    expect(r1.passed).toBe(true);
  });

  it("合法 spec 对不同输入给出稳定区分（不是无差别通过/失败）", () => {
    const v = compileAssertion({ containsAll: ["hi"], outputLength: { min: 1 } });
    expect(v("hi there").passed).toBe(true);
    expect(v("zzz").passed).toBe(false);
    expect(v("hi there").reason).toBeUndefined();
  });

  it("同一合法 spec 多次编译得到行为等价的新闭包（无共享可变状态）", () => {
    const a = compileAssertion({ mustReturnNumber: { min: 1, max: 9 } });
    const b = compileAssertion({ mustReturnNumber: { min: 1, max: 9 } });
    for (const input of ["5", "50", "无数字"]) {
      expect(a(input)).toEqual(b(input));
    }
  });

  it("fail-closed 桩对任何输入恒为同一 reason（幂等且与输入无关）", () => {
    const v = compileAssertion({ nope: 1 } as never);
    const baseline = v("");
    for (const input of ["hello", "中文输入", "{}", "999999", undefined]) {
      const r = v(input as string);
      expect(r.passed).toBe(false);
      expect(r.reason).toBe(baseline.reason);
    }
  });

  it("fail-closed 桩不产生副作用：重复调用不改变后续合法闭包的行为", () => {
    const bad = compileAssertion({ nope: 1 } as never);
    const good = compileAssertion({ containsAll: ["ok"] });
    for (let i = 0; i < 3; i++) {
      bad(`input-${i}`);
    }
    expect(good("ok message").passed).toBe(true);
    expect(good("no").passed).toBe(false);
  });
});
