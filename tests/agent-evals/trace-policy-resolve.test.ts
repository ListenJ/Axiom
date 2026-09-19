/**
 * 轨迹保留策略的**场景自适应推导**（切片 A3d）
 *
 * 用户裁定：默认值不做静态偏好，**按场景在使用中动态调整**。
 *
 * ⚠️ 与"确定性"的张力必须显式处理：
 *   自适应若读系统状态（磁盘/时钟），则"何时跑"会影响"保留哪些记录"。
 *   本模块的处理方式是**切分纯函数边界**：
 *     - `resolvePolicy(signals)` 是**纯函数**：同 signals 必得同 policy；
 *     - 读 `statfs`/文件大小等**副作用留在调用方**，且调用方须记录 signals 以便复现；
 *     - `selectRetained(records, policy, now)` 保持纯函数（见 trace-retention.ts）。
 *   这样"决策可复现"与"参数随场景自适应"可以并存。
 */
import { describe, it, expect } from "bun:test";
import {
  resolvePolicy,
  POLICY_BOUNDS,
  type RetentionSignals,
} from "../../src/agent-evals/trace-retention.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DAY = 24 * 60 * 60 * 1000;

function sig(over: Partial<RetentionSignals> = {}): RetentionSignals {
  return { fileBytes: 1000, recordCount: 10, sessionCount: 2, freeDiskBytes: 50 * GIB, ...over };
}

describe("保留策略的场景自适应推导", () => {
  it("磁盘压力分档：充足/紧张/临界 → 保留窗口依次收紧（单调）", () => {
    const normal = resolvePolicy(sig({ freeDiskBytes: 50 * GIB }));
    const tight = resolvePolicy(sig({ freeDiskBytes: 5 * GIB }));
    const critical = resolvePolicy(sig({ freeDiskBytes: 1 * GIB }));

    expect(normal.retentionMs).toBeGreaterThan(tight.retentionMs);
    expect(tight.retentionMs).toBeGreaterThan(critical.retentionMs);
  });

  it("体积上限随可用空间缩放，且始终夹在 [4 MiB, 256 MiB]", () => {
    const huge = resolvePolicy(sig({ freeDiskBytes: 4 * 1024 * GIB }));
    const tiny = resolvePolicy(sig({ freeDiskBytes: 10 * MIB }));
    expect(huge.maxBytes).toBeLessThanOrEqual(POLICY_BOUNDS.maxBytesCeiling);
    expect(tiny.maxBytes).toBeGreaterThanOrEqual(POLICY_BOUNDS.maxBytesFloor);
    expect(huge.maxBytes).toBeGreaterThan(tiny.maxBytes);
  });

  it("minKeepRecords 随会话数增长，且夹在 [50, 2000]", () => {
    const few = resolvePolicy(sig({ sessionCount: 1 }));
    const many = resolvePolicy(sig({ sessionCount: 500 }));
    expect(few.minKeepRecords).toBeGreaterThanOrEqual(POLICY_BOUNDS.minKeepFloor);
    expect(many.minKeepRecords).toBeLessThanOrEqual(POLICY_BOUNDS.minKeepCeiling);
    expect(many.minKeepRecords).toBeGreaterThan(few.minKeepRecords);
  });

  it("活跃豁免窗口随记录密度调整：高频会话收窄到 12h，常规 24h", () => {
    const sparse = resolvePolicy(sig({ recordCount: 10, sessionCount: 10 })); // 1 条/会话
    const dense = resolvePolicy(sig({ recordCount: 5000, sessionCount: 10 })); // 500 条/会话
    expect(sparse.activeWindowMs).toBe(24 * 60 * 60 * 1000);
    expect(dense.activeWindowMs).toBe(12 * 60 * 60 * 1000);
  });

  it("确定性：同一 signals 多次推导结果完全一致", () => {
    const s = sig({ freeDiskBytes: 3 * GIB, sessionCount: 7, recordCount: 700 });
    const runs = Array.from({ length: 5 }, () => resolvePolicy(s));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it("边界输入不产出非法策略（0 磁盘 / 0 会话 / 0 记录）", () => {
    const p = resolvePolicy({ fileBytes: 0, recordCount: 0, sessionCount: 0, freeDiskBytes: 0 });
    expect(p.maxBytes).toBeGreaterThan(0);
    expect(p.retentionMs).toBeGreaterThan(0);
    expect(p.activeWindowMs).toBeGreaterThan(0);
    expect(p.minKeepRecords).toBeGreaterThan(0);
    expect(Number.isInteger(p.maxBytes)).toBe(true);
    expect(Number.isInteger(p.minKeepRecords)).toBe(true);
  });

  it("推导出的策略可直接喂给 selectRetained（接口兼容）", () => {
    const policy = resolvePolicy(sig());
    expect(typeof policy.maxBytes).toBe("number");
    expect(policy.retentionMs % DAY).toBe(0); // 窗口以整天为粒度，避免半日漂移
  });
});
