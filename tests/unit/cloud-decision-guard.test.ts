/**
 * 云降级输出守卫回归测试（审计 M11）
 *
 * 行为规格：
 * 云端 LLM 输出必须与本地同级严格校验 —— 非 JSON 或不符合 DRE 决策 schema 时
 * 必须抛错（由 engine 降级链继续走 L3 规则推理），而非静默合成 observe(0.5)。
 */
import { describe, test, expect } from "bun:test";
import {
  parseCloudDecisionOrThrow,
  CloudDecisionInvalidError,
} from "../../src/dre/constraints.js";

describe("parseCloudDecisionOrThrow（M11 回归）", () => {
  test("合法决策 JSON 原样解析返回", () => {
    const d = parseCloudDecisionOrThrow('{"action":"act","content":"执行","confidence":0.9}');
    expect(d).toEqual({ action: "act", content: "执行", confidence: 0.9 });
  });

  test("非 JSON 输出抛 CloudDecisionInvalidError", () => {
    expect(() => parseCloudDecisionOrThrow("抱歉，我无法以 JSON 回答……"))
      .toThrow(CloudDecisionInvalidError);
  });

  test("空内容抛错（不再合成 observe 假成功）", () => {
    expect(() => parseCloudDecisionOrThrow("")).toThrow(CloudDecisionInvalidError);
    expect(() => parseCloudDecisionOrThrow(undefined as never)).toThrow(CloudDecisionInvalidError);
  });

  test("schema 不符（缺字段/越界 confidence/非法 action）抛错", () => {
    expect(() => parseCloudDecisionOrThrow('{"action":"observe","content":"x"}'))
      .toThrow(CloudDecisionInvalidError);
    expect(() => parseCloudDecisionOrThrow('{"action":"observe","content":"x","confidence":1.5}'))
      .toThrow(CloudDecisionInvalidError);
    expect(() => parseCloudDecisionOrThrow('{"action":"explode","content":"x","confidence":0.5}'))
      .toThrow(CloudDecisionInvalidError);
  });
});
