/**
 * selfInduce 特异性过滤（2026-09-01）：
 *   - 根因：selfInduce 仅按 support≥2 && successRate≥0.6 归纳，通用会话词（CJK 功能 bigram +
 *     泛化技术词）也被提升为 auto-induce-* skill，污染技能库（34 个历史污染项即由此产生）。
 *   - contract：通用词不进 result；有语义术语不误杀；纯术语样本回归不破。
 */
import { describe, test, expect } from "bun:test";
import { SelfEvolveEngine } from "../../src/self-evolve/engine.js";
import type { TaskTrace } from "../../src/self-evolve/types.js";

const deps = {
  think: async () => '{"goal":"g","assumptions":[],"plan":["p"],"risks":[]}',
  store: { write: async () => {}, list: async () => [] },
};

/** 同任务出现 n 次（success 全 true），使候选词 support 达标。 */
function repeat(task: string, n = 2, idPrefix = "t"): TaskTrace[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${idPrefix}-${i}`, task, success: true }));
}

describe("selfInduce 特异性过滤", () => {
  test("通用会话词不进归纳结果，有语义术语保留（不误杀）", () => {
    // 真实形态样本：自然语言请求混有语义术语。support≥2 全部达标。
    const traces: TaskTrace[] = [
      ...repeat("写一个 json 处理函数"),
      ...repeat("用 node 写一个 api"),
      ...repeat("调用 mcp 超时处理"),
      ...repeat("优化 redis 缓存命中率"),
    ];
    const engine = new SelfEvolveEngine(deps);
    const result = engine.selfInduce(traces, 20);
    const patterns = result.map((i) => i.pattern);

    // 有语义术语必须在（不误杀）
    for (const term of ["mcp", "redis", "超时", "缓存"]) {
      expect(patterns).toContain(term);
    }
    // 通用会话词必须不在（特异性过滤生效）
    for (const junk of ["json", "api", "node", "写一", "一个", "函数", "用", "处理", "优化"]) {
      expect(patterns).not.toContain(junk);
    }
  });

  test("纯术语样本回归：mcp/redis 仍被归纳（不过滤）", () => {
    const traces: TaskTrace[] = [...repeat("debug mcp timeout"), ...repeat("tune redis cache")];
    const engine = new SelfEvolveEngine(deps);
    const patterns = engine.selfInduce(traces, 20).map((i) => i.pattern);
    expect(patterns).toContain("mcp");
    expect(patterns).toContain("redis");
  });
});