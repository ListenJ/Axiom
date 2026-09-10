/**
 * P0-A 缓存命中度量 — 测试先行（红）。
 * 字段形态依据 docs/knowledge/prefix-cache-provider-api-2026-09-06.md（官方文档核查）：
 *  - deepseek 系: usage.prompt_cache_hit_tokens（hit + miss = prompt_tokens）
 *  - OpenAI 兼容系: usage.prompt_tokens_details.cached_tokens（部分 provider 顶层 usage.cached_tokens）
 * 全部防御性解析：缺省/非法值不产出 cacheHitTokens、绝不报错。
 */
import { describe, expect, it } from "bun:test";
import { parseProviderUsage } from "../../src/agent-evals/runner.js";
import { summarize, type TaskResult } from "../../src/agent-evals/metrics.js";
import { toMarkdown } from "../../src/agent-evals/report.js";
import { openRegistry } from "../../src/agent-evals/registry.js";
import type { RunSummarySnapshot, StoredTaskResult } from "../../src/agent-evals/metrics-types.js";

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return { taskId: "T-01", family: "coding", split: "held-out", passed: true, latencyMs: 100, outputLength: 50, ...overrides };
}

describe("summarize 缓存命中聚合（P0-A：仅统计有数据样本，全缺为 null）", () => {
  it("有 cacheHitTokens 样本 → total/avg 聚合", () => {
    const s = summarize([
      result({ taskId: "T-1", tokenUsage: { promptTokens: 100, cacheHitTokens: 64 } }),
      result({ taskId: "T-2", tokenUsage: { promptTokens: 100, cacheHitTokens: 36 } }),
      result({ taskId: "T-3", tokenUsage: { promptTokens: 100 } }),
    ]);
    expect(s.totalCacheHitTokens).toBe(100);
    expect(s.avgCacheHitTokens).toBe(50);
  });

  it("全部样本无缓存字段 → null（不阻断旧调用方）", () => {
    const s = summarize([result({ tokenUsage: { promptTokens: 10 } }), result({})]);
    expect(s.totalCacheHitTokens).toBeNull();
    expect(s.avgCacheHitTokens).toBeNull();
  });
});

describe("toMarkdown 缓存命中展示（P0-A：有数据才出现该行）", () => {
  it("有缓存数据 → 报告含缓存命中行", () => {
    const s = summarize([result({ tokenUsage: { promptTokens: 100, cacheHitTokens: 64 } })]);
    expect(toMarkdown(s, [])).toContain("缓存命中");
  });

  it("无缓存数据 → 报告不含缓存命中行（保持既有输出形态）", () => {
    const s = summarize([result({})]);
    expect(toMarkdown(s, [])).not.toContain("缓存命中");
  });
});

describe("registry 缓存命中列（P0-A：summary 快照落库 + 查询回读）", () => {
  it("insertRun 带 avgCacheHitTokens/totalCacheHitTokens → getRun 回读一致", () => {
    const reg = openRegistry(":memory:");
    try {
      const id = reg.insertRun(
        { runTag: "cache-hit-run" },
        {
          total: 2,
          passed: 2,
          passRate: 100,
          byFamily: {},
          trainRate: 100,
          heldOutRate: 100,
          generalizationRatio: 1,
          avgLatencyMs: 10,
          avgOutputLength: 5,
          avgCacheHitTokens: 50,
          totalCacheHitTokens: 100,
        },
      );
      const row = reg.getRun(id);
      expect(row?.summaryAvgCacheHitTokens).toBe(50);
      expect(row?.summaryTotalCacheHitTokens).toBe(100);
    } finally {
      reg.close();
    }
  });

  it("老快照无缓存字段 → 列为 null（迁移兼容）", () => {
    const reg = openRegistry(":memory:");
    try {
      const id = reg.insertRun(
        { runTag: "legacy-run" },
        {
          total: 1,
          passed: 1,
          passRate: 100,
          byFamily: {},
          trainRate: 100,
          heldOutRate: 100,
          generalizationRatio: 1,
          avgLatencyMs: 10,
          avgOutputLength: 5,
        },
      );
      const row = reg.getRun(id);
      expect(row?.summaryAvgCacheHitTokens).toBeNull();
      expect(row?.summaryTotalCacheHitTokens).toBeNull();
    } finally {
      reg.close();
    }
  });
});

describe("parseProviderUsage 缓存命中字段（多形态防御解析）", () => {
  it("deepseek 系: usage.prompt_cache_hit_tokens → cacheHitTokens", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 64,
        prompt_cache_miss_tokens: 36,
      },
    });
    expect(parseProviderUsage(body)).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheHitTokens: 64,
    });
  });

  it("OpenAI 兼容系: usage.prompt_tokens_details.cached_tokens → cacheHitTokens", () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 64, audio_tokens: 0 },
      },
    });
    expect(parseProviderUsage(body)).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheHitTokens: 64,
    });
  });

  it("部分 provider 顶层 usage.cached_tokens → cacheHitTokens", () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 64 },
    });
    expect(parseProviderUsage(body)).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      cacheHitTokens: 64,
    });
  });

  it("无缓存字段时不产出 cacheHitTokens（保持既有形态）", () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 10 } });
    expect(parseProviderUsage(body)).toEqual({ promptTokens: 10 });
  });

  it("缓存字段为非法值（字符串/null/对象）时不产出、不报错，保留可用字段", () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 10,
        prompt_cache_hit_tokens: "64",
        prompt_tokens_details: { cached_tokens: null },
        cached_tokens: { value: 1 },
      },
    });
    expect(parseProviderUsage(body)).toEqual({ promptTokens: 10 });
  });
});

