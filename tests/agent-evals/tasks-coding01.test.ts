/**
 * Agent 评测任务校验器测试 — CODING-01 防抖：箭头函数/展开符写法不应被误杀
 */
import { describe, it, expect } from "bun:test";
import { ALL_AGENT_TASKS } from "../../src/agent-evals/tasks.js";

describe("CODING-01 防抖校验器", () => {
  const task = ALL_AGENT_TASKS.find((t) => t.id === "CODING-01")!;
  expect(task).toBeDefined();

  it("函数声明式写法通过", () => {
    const ans = `function debounce(fn, delay, immediate = false) {
      let timer;
      return function (...args) {
        const callNow = immediate && !timer;
        clearTimeout(timer);
        timer = setTimeout(() => { timer = null; if (!immediate) fn.apply(this, args); }, delay);
        if (callNow) fn.apply(this, args);
      };
    }`;
    expect(task.verify(ans).passed).toBe(true);
  });

  it("箭头函数 + 展开符写法通过（修复后不再误杀）", () => {
    const ans = `const debounce = (fn, delay, immediate = false) => {
      let t;
      return (...args) => {
        const later = () => { t = null; if (!immediate) fn(...args); };
        clearTimeout(t);
        t = setTimeout(later, delay);
        if (immediate && !t) fn(...args);
      };
    };`;
    expect(task.verify(ans).passed).toBe(true);
  });

  it("缺 setTimeout/clearTimeout 仍失败（防作弊）", () => {
    const ans = `function debounce(fn, delay) { return fn; }`;
    expect(task.verify(ans).passed).toBe(false);
  });
});
