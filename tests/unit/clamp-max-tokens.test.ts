/**
 * 审计 H-3 / 整改 R3 Task 3.5 —— maxTokens 预算钳制
 *
 * 修复前：recommendedMaxTokens 仅写入日志（engine.ts:327,335），各调用方
 * 自传硬编码 maxTokens（engine=256 / edge-client=512），请求可超 llama.cpp
 * --ctx-size，行为取决于外部截断策略。
 *
 * 修复后契约（clampMaxTokens 纯函数）：
 *   - recommended 有效（>0）→ min(requested, recommended)，下限 1
 *   - recommended 缺失/非法 → 原样返回（不臆造上限）
 */
import { describe, test, expect } from "bun:test";
import { clampMaxTokens } from "../../src/dre/system-resource.js";

describe("clampMaxTokens（H-3）", () => {
  test("预算低于请求时钳制到预算", () => {
    expect(clampMaxTokens(256, 100)).toBe(100);
  });

  test("预算高于请求时保持请求值", () => {
    expect(clampMaxTokens(256, 4096)).toBe(256);
  });

  test("预算缺失/0/负数 → 原样返回", () => {
    expect(clampMaxTokens(256, undefined)).toBe(256);
    expect(clampMaxTokens(256, 0)).toBe(256);
    expect(clampMaxTokens(512, -5)).toBe(512);
  });

  test("结果下限为 1", () => {
    expect(clampMaxTokens(10, 1)).toBe(1);
  });
});
