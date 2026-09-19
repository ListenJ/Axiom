/**
 * 轨迹保留策略：体积 × 时间 × 会话（联合会话处理）
 *
 * 背景：方案 C 要给轨迹做磁盘持久化，而 `real-usage` 的 JSONL 是**纯追加、无上限**。
 * 若不加上限，等于把 B3-Medium 修掉的"内存无界增长"搬到磁盘上复发。
 *
 * 联合语义（用户裁定：体积 + 时间 + 会话，精细化）：
 *   1. 会话原子 —— 同一 sessionId 的记录**整组进出**，绝不拆散（避免回看时半截）。
 *   2. 时间维度 —— 最后活动时间早于 (now - retentionMs) 的会话整组淘汰。
 *   3. 体积维度 —— 仍超 maxBytes 时，按会话最后活动时间**从旧到新**整组淘汰。
 *   4. 会话豁免 —— 活跃窗口内的会话（最后活动 >= now - activeWindowMs）**不被体积规则淘汰**。
 *   5. 硬下限  —— 任何情况下不得把记录数压到 minKeepRecords 以下。
 *   6. 确定性  —— 同一输入多次调用结果完全一致；同 lastActivity 时按 unitKey 升序 tie-break
 *               （用码元比较，不用 localeCompare，避免 locale 依赖）。
 */
import { describe, it, expect } from "bun:test";
import { selectRetained, type RetentionPolicy, type RetentionRecord } from "../../src/agent-evals/trace-retention.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function rec(id: string, sessionId: string | undefined, ts: number, pad = ""): RetentionRecord {
  return sessionId === undefined ? { id, timestamp: ts, pad } : { id, sessionId, timestamp: ts, pad };
}

const POLICY: RetentionPolicy = {
  maxBytes: 10_000,
  retentionMs: 30 * DAY,
  activeWindowMs: DAY,
  minKeepRecords: 2,
};

describe("轨迹保留策略", () => {
  it("时间维度：超期会话整组淘汰，窗口内的保留", () => {
    const records = [
      rec("a1", "old", NOW - 40 * DAY),
      rec("a2", "old", NOW - 39 * DAY),
      rec("b1", "fresh", NOW - 1 * DAY),
    ];
    const out = selectRetained(records, POLICY, NOW);
    expect(out.keep.map((r) => r.id)).toEqual(["b1"]);
    expect(out.drop.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
  });

  it("会话原子：同会话记录整组保留或整组淘汰，不拆散", () => {
    const records = [
      rec("old-1", "s-old", NOW - 40 * DAY),
      rec("old-2", "s-old", NOW - 40 * DAY + 1000),
      rec("new-1", "s-new", NOW - 1000),
    ];
    const out = selectRetained(records, POLICY, NOW);
    const keptSessions = new Set(out.keep.map((r) => r.sessionId));
    const droppedSessions = new Set(out.drop.map((r) => r.sessionId));
    // 同一会话不得同时出现在 keep 与 drop
    for (const s of keptSessions) expect(droppedSessions.has(s)).toBe(false);
    expect(out.keep.length).toBe(1);
    expect(out.drop.length).toBe(2);
  });

  it("体积维度：超限时按会话最后活动时间从旧到新淘汰", () => {
    const big = "x".repeat(400);
    const records = [
      rec("s1-r1", "s1", NOW - 5 * DAY, big),
      rec("s2-r1", "s2", NOW - 4 * DAY, big),
      rec("s3-r1", "s3", NOW - 3 * DAY, big),
      rec("s4-r1", "s4", NOW - 2 * DAY, big),
    ];
    const tight: RetentionPolicy = { ...POLICY, maxBytes: 900, activeWindowMs: 0, minKeepRecords: 1 };
    const out = selectRetained(records, tight, NOW);
    expect(out.keep.map((r) => r.id)).toEqual(["s4-r1"]); // 最旧的先出，直到回到限内
    expect(out.drop.map((r) => r.id)).toEqual(["s1-r1", "s2-r1", "s3-r1"]);
  });

  it("会话豁免：活跃窗口内的会话不被体积规则淘汰", () => {
    const big = "x".repeat(400);
    const records = [
      rec("hot-r1", "hot", NOW - 1000, big),       // 活跃会话（很新）
      rec("cold-r1", "cold", NOW - 10 * DAY, big), // 旧会话
    ];
    // maxBytes 小到只能容一条：体积规则应淘汰 cold，而不是 hot
    const tight: RetentionPolicy = { ...POLICY, maxBytes: 500, activeWindowMs: 1 * DAY, minKeepRecords: 1 };
    const out = selectRetained(records, tight, NOW);
    expect(out.keep.map((r) => r.id)).toEqual(["hot-r1"]);
    expect(out.drop.map((r) => r.id)).toEqual(["cold-r1"]);
  });

  it("活跃会话豁免优先于体积下限：全为活跃且超限时不再淘汰", () => {
    const big = "x".repeat(400);
    const records = [
      rec("h1", "h1", NOW - 1000, big),
      rec("h2", "h2", NOW - 2000, big),
    ];
    const tight: RetentionPolicy = { ...POLICY, maxBytes: 100, activeWindowMs: 1 * DAY, minKeepRecords: 1 };
    const out = selectRetained(records, tight, NOW);
    expect(out.keep.length).toBe(2); // 全部豁免 —— 宁可超限也不动活跃会话
    expect(out.drop.length).toBe(0);
  });

  it("硬下限：体积规则不得把记录数压到 minKeepRecords 以下", () => {
    const big = "x".repeat(400);
    const records = [
      rec("s1", "s1", NOW - 3 * DAY, big),
      rec("s2", "s2", NOW - 2 * DAY, big),
      rec("s3", "s3", NOW - 1 * DAY, big),
    ];
    const tight: RetentionPolicy = { ...POLICY, maxBytes: 1, activeWindowMs: 0, minKeepRecords: 2 };
    const out = selectRetained(records, tight, NOW);
    expect(out.keep.length).toBe(2);
    expect(out.drop.map((r) => r.id)).toEqual(["s1"]);
  });

  it("无 sessionId 的记录作为独立单元参与（按 id 归组，逐条处理）", () => {
    const records = [
      rec("o1", undefined, NOW - 40 * DAY),
      rec("o2", undefined, NOW - 1000),
    ];
    const out = selectRetained(records, POLICY, NOW);
    expect(out.keep.map((r) => r.id)).toEqual(["o2"]);
  });

  it("确定性：同 lastActivity 时按 unitKey 码元升序 tie-break，多次调用结果一致", () => {
    const big = "x".repeat(400);
    const records = [
      rec("b1", "beta", NOW - 2 * DAY, big),
      rec("a1", "alpha", NOW - 2 * DAY, big), // 同 lastActivity
    ];
    const tight: RetentionPolicy = { ...POLICY, maxBytes: 500, activeWindowMs: 0, minKeepRecords: 1 };
    const runs = Array.from({ length: 5 }, () => selectRetained(records, tight, NOW).keep.map((r) => r.id));
    // 注意：记录 id 是 b1/a1，"beta"/"alpha" 是 sessionId —— 这里断言的是保留记录的 **id**。
    // alpha 会话（unitKey "s:alpha" < "s:beta"）先被淘汰，故留下的是 b1。
    for (const run of runs) expect(run).toEqual(["b1"]);
  });
});
