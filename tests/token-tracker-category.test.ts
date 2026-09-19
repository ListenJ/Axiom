/**
 * TokenTracker 显式分类字段（category）—— 用量按分类聚合
 *
 * 背景（计划切片 A / 决策 Q3）：用户要求"消耗了多少 token 按对应的分类显示"。
 * 现网 record 只有 role/taskType，语义不同且不表达"这笔消耗属于谁"（主模型/子代理/词嵌入/工具）。
 * 本测试锁定：①显式 category 可落库并按分类聚合；②recent usage 可读回；
 * ③老库（无 category 列）经迁移后可正常写入与读取。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import { TokenTracker } from "../src/router/token-tracker.js";

const DB = ".tmp/token-category.db";
const DB_LEGACY = ".tmp/token-category-legacy.db";

function cleanup() {
  for (const p of [DB, DB_LEGACY]) {
    if (fs.existsSync(p)) {
      try { fs.rmSync(p); } catch { /* ignore */ }
    }
  }
}

afterEach(cleanup);

function rec(over: Record<string, unknown>) {
  return {
    timestamp: Date.now(),
    model: "m",
    provider: "p",
    latencyMs: 1,
    contentLength: 1,
    success: true,
    fallbackUsed: false,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    ...over,
  } as never;
}

describe("TokenTracker 显式分类", () => {
  it("按 category 聚合：embedding 与 subagent 分别计数与求和", async () => {
    const tracker = new TokenTracker(DB);
    try {
      tracker.record(rec({ category: "embedding", totalTokens: 300, promptTokens: 300 }));
      tracker.record(rec({ category: "embedding", totalTokens: 100, promptTokens: 100 }));
      tracker.record(rec({ category: "subagent", totalTokens: 1000, promptTokens: 700, completionTokens: 300 }));
      await tracker.flush();

      const byCat = tracker.getStatsByCategory();
      const embedding = byCat.find((r) => r.category === "embedding");
      const subagent = byCat.find((r) => r.category === "subagent");

      expect(embedding?.totalCalls).toBe(2);
      expect(embedding?.totalTokens).toBe(400);
      expect(subagent?.totalCalls).toBe(1);
      expect(subagent?.totalTokens).toBe(1000);
    } finally {
      await tracker.close();
    }
  });

  it("未标注 category 的记录归入 unknown，不与已分类的混淆", async () => {
    const tracker = new TokenTracker(DB);
    try {
      tracker.record(rec({ category: "main", totalTokens: 10 }));
      tracker.record(rec({ totalTokens: 20 }));
      await tracker.flush();

      const byCat = tracker.getStatsByCategory();
      expect(byCat.find((r) => r.category === "main")?.totalTokens).toBe(10);
      expect(byCat.find((r) => r.category === "unknown")?.totalTokens).toBe(20);
    } finally {
      await tracker.close();
    }
  });

  it("getRecentUsage 读回 category", async () => {
    const tracker = new TokenTracker(DB);
    try {
      tracker.record(rec({ category: "tool", totalTokens: 5 }));
      await tracker.flush();
      expect(tracker.getRecentUsage(1)[0]?.category).toBe("tool");
    } finally {
      await tracker.close();
    }
  });

  it("老库无 category 列时经迁移可写入并读回（历史行归 unknown）", async () => {
    const db = new Database(DB_LEGACY);
    db.run(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        role TEXT,
        task_type TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        latency_ms INTEGER DEFAULT 0,
        content_length INTEGER DEFAULT 0,
        success INTEGER DEFAULT 1,
        fallback_used INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0
      )
    `);
    db.run(
      `INSERT INTO token_usage (timestamp, model, provider, prompt_tokens, completion_tokens, total_tokens, latency_ms, content_length, success, fallback_used, cost_usd)
       VALUES (?, 'legacy', 'p', 1, 1, 2, 1, 1, 1, 0, 0)`,
      [Date.now()],
    );
    db.close();

    const tracker = new TokenTracker(DB_LEGACY);
    try {
      tracker.record(rec({ category: "embedding", totalTokens: 7 }));
      await tracker.flush();

      const byCat = tracker.getStatsByCategory();
      expect(byCat.find((r) => r.category === "embedding")?.totalTokens).toBe(7);
      expect(byCat.find((r) => r.category === "unknown")?.totalTokens).toBe(2);
    } finally {
      await tracker.close();
    }
  });
});
