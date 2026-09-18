/**
 * 审计 P1-4（2026-08-29）：thompson-router 观测有界 + 空 arms 确定性降级。
 * 证据：docs/reviews/2026-08-29-joint-verification-audit.md §4 B2-M4——
 * src/router/thompson-router.ts reportFeedback 观测无限 push（内存与 SQLite
 * thompson_observations 只增不删），getEffectiveParams 每次 route 全量遍历线性变慢；
 * main.ts:229 以 arms:[] 构造时 route() 抛 "TS selected no arm"。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ThompsonRouter, createThompsonRouter, MAX_OBSERVATIONS_PER_ARM, type RouterArm } from "../src/router/thompson-router.js";

const arm = (id: string): RouterArm => ({ id, model: id, provider: "p", alpha: 1, beta: 1, metadata: {} });

describe("[P1-4] thompson 观测有界", () => {
  test(`1001 次 reportFeedback 后内存观测 ≤ ${500} 且最旧被裁`, () => {
    const r = new ThompsonRouter({ arms: [arm("a1")], minSamples: 0, decayFactor: 1, inMemory: true });
    expect(MAX_OBSERVATIONS_PER_ARM).toBe(500);
    for (let i = 0; i < 1001; i++) r.reportFeedback("a1", true);
    expect(r.getObservationCount("a1")).toBe(500);
    // 行为证明"最旧被裁"：1001 次全成功后 arm.alpha=1002，而 getArmStats 经
    // getEffectiveParams 由裁剪后的观测推导 → 1 + 500 = 501（未裁剪应为 1002）
    const stats = r.getArmStats().find((s) => s.id === "a1");
    expect(stats?.alpha).toBe(501);
    r.close();
  });

  test("DB 模式：thompson_observations 每 arm 行数被增量裁剪至 ≤500", () => {
    const dbPath = path.resolve(process.cwd(), ".tmp", `test-thompson-obs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const r = new ThompsonRouter({ arms: [arm("a1")], minSamples: 0, decayFactor: 1, dbPath });
    for (let i = 0; i < 520; i++) r.reportFeedback("a1", true);
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT COUNT(*) AS n FROM thompson_observations WHERE arm_id = 'a1'").get() as { n: number };
    expect(row.n).toBe(500);
    db.close();
    r.close();
    fs.rmSync(dbPath, { force: true });
  });
});

describe("[P1-4] 空 arms 确定性降级", () => {
  test("route() 不抛错，返回空 arm 标记的降级 RoutingDecision（对齐 main.ts arms:[] 形态）", async () => {
    const r = createThompsonRouter({ arms: [], minSamples: 5, inMemory: true });
    const d = await r.route({ taskType: "chat", inputLength: 1 });
    expect(d.arm.id).toBe("");
    expect(d.samples.length).toBe(0);
    expect(d.confidence).toBe(0);
    expect(d.reason).toContain("degraded");
    r.close();
  });
});
