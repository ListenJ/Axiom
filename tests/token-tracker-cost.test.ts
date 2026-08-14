/**
 * token-tracker cost_usd 落库 + DeepSeek 峰谷计价/历史回算测试
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import { TokenTracker } from "../src/router/token-tracker.js";

const DB_RECORD = ".tmp/token-cost-record.db";
const DB_BACKFILL = ".tmp/token-cost-backfill.db";

function peakMs(hour: number): number {
  return new Date(`2026-08-14T${String(hour).padStart(2, "0")}:00:00Z`).getTime();
}

function cleanup() {
  for (const p of [DB_RECORD, DB_BACKFILL]) {
    if (fs.existsSync(p)) {
      try { fs.rmSync(p); } catch { /* ignore */ }
    }
  }
}

afterEach(cleanup);

describe("TokenTracker cost_usd", () => {
  it("DeepSeek 记录按峰时官方价计算 costUsd 并聚合", async () => {
    const tracker = new TokenTracker(DB_RECORD);
    try {
      tracker.record({
        timestamp: peakMs(2), // 高峰
        model: "deepseek-v4-flash",
        provider: "deepseek",
        role: "general-chat",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        totalTokens: 2_000_000,
        latencyMs: 100,
        contentLength: 10,
        success: true,
        fallbackUsed: false,
      });
      await tracker.flush();

      const byModel = tracker.getStatsByModel();
      expect(byModel.length).toBe(1);
      expect(byModel[0]?.costUsd).toBeCloseTo(1.76, 5); // 0.44 + 1.32
      expect(tracker.getOverallStats().costUsd).toBeCloseTo(1.76, 5);
      expect(tracker.getRecentUsage(1)[0]?.costUsd).toBeCloseTo(1.76, 5);
    } finally {
      await tracker.close();
    }
  });

  it("非 DeepSeek 模型 costUsd 为 0", async () => {
    const tracker = new TokenTracker(DB_RECORD);
    try {
      tracker.record({
        timestamp: peakMs(2),
        model: "glm-5",
        provider: "zhipu",
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        latencyMs: 50,
        contentLength: 5,
        success: true,
        fallbackUsed: false,
      });
      await tracker.flush();
      expect(tracker.getOverallStats().costUsd).toBe(0);
    } finally {
      await tracker.close();
    }
  });

  it("构造时按历史 timestamp 峰谷回算 cost_usd（幂等）", async () => {
    // 预置一条 cost_usd=0 的 DeepSeek 高峰历史行
    const db = new Database(DB_BACKFILL);
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
      `INSERT INTO token_usage (timestamp, model, provider, role, task_type, prompt_tokens, completion_tokens, total_tokens, latency_ms, content_length, success, fallback_used, cost_usd)
       VALUES (?, 'deepseek-v4-pro', 'deepseek', NULL, NULL, 1000000, 1000000, 2000000, 1, 0, 1, 0, 0)`,
      [peakMs(2)],
    );
    db.close();

    const tracker = new TokenTracker(DB_BACKFILL);
    try {
      const byModel = tracker.getStatsByModel();
      expect(byModel.length).toBe(1);
      expect(byModel[0]?.costUsd).toBeCloseTo(5.28, 5); // 1.32 + 3.96 峰价 pro
    } finally {
      await tracker.close();
    }
  });
});

describe("TokenTracker 多供应商直连价", () => {
  it("Kimi K2.6 记录按直连价计算 costUsd", async () => {
    const tracker = new TokenTracker(DB_RECORD);
    try {
      tracker.record({
        timestamp: peakMs(2),
        model: "kimi-k2.6",
        provider: "kimi",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        totalTokens: 2_000_000,
        latencyMs: 100,
        contentLength: 10,
        success: true,
        fallbackUsed: false,
      });
      await tracker.flush();
      expect(tracker.getOverallStats().costUsd).toBeCloseTo((6.5 + 27) / 7.2, 4);
    } finally {
      await tracker.close();
    }
  });
});
