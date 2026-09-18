/**
 * Agent 评测任务校验器测试 — CODING-01 防抖：箭头函数/展开符写法不应被误杀
 */
import { describe, it, expect } from "bun:test";
import { ALL_AGENT_TASKS } from "../../src/agent-evals/tasks.js";

describe("CODING-01 防抖校验器", () => {
  const task = ALL_AGENT_TASKS.find((t) => t.id === "CODING-01")!;
  expect(task).toBeDefined();

  it("函数声明式写法通过", async () => {
    const ans = `function debounce(fn, delay, immediate = false) {
      let timer;
      return function (...args) {
        const callNow = immediate && !timer;
        clearTimeout(timer);
        timer = setTimeout(() => { timer = null; if (!immediate) fn.apply(this, args); }, delay);
        if (callNow) fn.apply(this, args);
      };
    }`;
    expect((await task.verify(ans)).passed).toBe(true);
  });

  it("箭头函数 + 展开符写法通过（修复后不再误杀）", async () => {
    const ans = `const debounce = (fn, delay, immediate = false) => {
      let t;
      return (...args) => {
        const later = () => { t = null; if (!immediate) fn(...args); };
        clearTimeout(t);
        t = setTimeout(later, delay);
        if (immediate && !t) fn(...args);
      };
    };`;
    expect((await task.verify(ans)).passed).toBe(true);
  });

  it("缺 setTimeout/clearTimeout 仍失败（防作弊）", async () => {
    const ans = `function debounce(fn, delay) { return fn; }`;
    expect((await task.verify(ans)).passed).toBe(false);
  });
});

describe("CODING-04 复杂度校验器（中文答案不被误杀）", () => {
  const task = ALL_AGENT_TASKS.find((x) => x.id === "CODING-04")!;
  expect(task).toBeDefined();

  it("中文『哈希集合/Set』O(n) 答案通过（哈希≠hash 的字面误杀已修复）", async () => {
    const ans = `原函数是双重循环，时间复杂度为 O(n²)。
优化实现：
function findDup(arr) {
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    if (seen.has(arr[i])) return arr[i];
    seen.add(arr[i]);
  }
  return null;
}
用哈希集合记录已见元素，时间复杂度 O(n)，空间复杂度 O(n)。`;
    expect((await task.verify(ans)).passed).toBe(true);
  });

  it("缺复杂度说明仍失败", async () => {
    const ans = "function findDup(arr) { return null; }";
    expect((await task.verify(ans)).passed).toBe(false);
  });
});
